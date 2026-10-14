import type { Database } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { systemCtx } from '../core/context.js';
import { AppError, notFound } from '../lib/errors.js';
import { cop, token, uuidv7 } from '../lib/util.js';
import { aCentavos } from '../lib/money.js';
import { config } from '../config.js';
import { checkoutUrl, consultarTransaccionWompi, cuentaPlataforma, type CuentaPasarela, type EventoPago } from '../adapters/payments.js';
import { provisionDraft } from '../onboarding/provisioning.js';
import { cuentaComercio, reconcilePaymentLink } from './payments.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';

/**
 * Pagos de la plataforma (alta de empresas y renovación de suscripciones) y
 * despacho de eventos de pago. Las dos clases de cobro no se mezclan:
 *   SUB-…  pago de una empresa a la plataforma (cuenta de la plataforma);
 *   PL-…   cobro del comercio a su cliente (cuenta propia del comercio).
 *
 * El evento se registra una sola vez (provisioning_event.event_id) y el estado del
 * pago se confirma en una transacción; el aprovisionamiento corre en otra. Si
 * falla, el pago queda aprobado y el alta se reintenta sin volver a cobrar.
 */
export type ResultadoEvento = { ok: boolean; duplicado?: boolean; ignorado?: string; estado?: string; tenant_id?: string };

export async function procesarEventoPago(db: Database, ev: EventoPago, correlacion: string, origen: string): Promise<ResultadoEvento> {
  if (ev.referencia.startsWith('PL-')) return procesarCobroComercio(db, ev, correlacion);

  const r = await db.withPlatform(async (tx) => {
    const ins = await tx.query(
      `INSERT INTO provisioning_event (event_id, tipo, referencia, payload, resultado) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,
      [ev.id, ev.estado, ev.referencia, JSON.stringify(ev), origen],
    );
    const pago = (await tx.query(`SELECT * FROM payment WHERE referencia=$1 FOR UPDATE`, [ev.referencia])).rows[0];
    if (!ins.rows[0]) return { duplicado: true, pago };
    if (!pago) return { ignorado: 'referencia desconocida' };
    if (pago.estado === 'APROBADO') return { duplicado: true, pago };
    if (ev.estado === 'PENDIENTE') return { estado: 'PENDIENTE', pago };
    if (ev.estado !== 'APROBADO') {
      await tx.query(`UPDATE payment SET estado='RECHAZADO', transaccion_id=coalesce($2, transaccion_id), actualizado_en=now() WHERE id=$1`, [pago.id, ev.transaccionId ?? null]);
      if (pago.draft_token) await tx.query(`UPDATE onboarding_draft SET estado='BORRADOR' WHERE token=$1 AND estado='PAGO_INICIADO'`, [pago.draft_token]);
      if (pago.tenant_id) await auditPlatform(tx, pago.tenant_id, { tipo: 'SISTEMA', id: null, nombre: 'Pasarela' }, 'WEBHOOK', correlacion, { accion: 'suscripcion.pago_rechazado', resultado: 'ERROR', detalle: { referencia: ev.referencia, estado: ev.estado } });
      return { estado: 'RECHAZADO', pago };
    }
    if (ev.montoCentavos !== aCentavos(pago.monto) || ev.moneda !== pago.moneda) {
      await auditPlatform(tx, pago.tenant_id ?? null, { tipo: 'SISTEMA', id: null, nombre: 'Pasarela' }, 'WEBHOOK', correlacion, { accion: 'pago.monto_no_coincide', resultado: 'ERROR', detalle: { referencia: ev.referencia, esperado: aCentavos(pago.monto), recibido: ev.montoCentavos } });
      return { ignorado: 'monto no coincide', pago };
    }
    await tx.query(`UPDATE payment SET estado='APROBADO', transaccion_id=$2, actualizado_en=now() WHERE id=$1`, [pago.id, ev.transaccionId ?? null]);
    if (pago.tenant_id && !pago.draft_token) {
      // Renovación o reactivación: extiende desde el fin del periodo vigente (o desde hoy si ya venció).
      await tx.query(
        `UPDATE subscription SET estado='ACTIVA', gracia_hasta=NULL,
           periodo_inicio = CASE WHEN periodo_fin > now() THEN periodo_fin ELSE now() END,
           periodo_fin = (CASE WHEN periodo_fin > now() THEN periodo_fin ELSE now() END) + interval '1 month', actualizado_en=now()
         WHERE tenant_id=$1`, [pago.tenant_id]);
      await auditPlatform(tx, pago.tenant_id, { tipo: 'SISTEMA', id: null, nombre: 'Pasarela' }, 'WEBHOOK', correlacion, { accion: 'suscripcion.renovada', resultado: 'EXITO', detalle: { referencia: ev.referencia } });      // Comprobante de pago al contacto administrativo (evento real de facturación de la plataforma).
      const t = (await tx.query(`SELECT t.nombre, t.email_contacto, s.periodo_fin FROM tenant t JOIN subscription s ON s.tenant_id=t.id WHERE t.id=$1`, [pago.tenant_id])).rows[0];
      if (t?.email_contacto) {
        await encolarCorreo(tx, { tenantId: null, para: t.email_contacto, clave: `pago:${pago.id}`,
          correo: plantillas.pagoRecibido({ empresa: t.nombre, monto: cop(Number(pago.monto)), referencia: pago.referencia, periodoFin: new Date(t.periodo_fin).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }), url: `${config.publicUrl}/suscripcion` }) });
      }
    }
    return { estado: 'APROBADO', pago };
  });

  if ('ignorado' in r && r.ignorado) return { ok: true, ignorado: r.ignorado };
  const pago = (r as any).pago;
  // Alta: se aprovisiona tras confirmar el pago. Un evento repetido también reintenta un alta pendiente.
  if (pago?.draft_token && (r.estado === 'APROBADO' || ((r as any).duplicado && pago.estado === 'APROBADO'))) {
    const p = await aprovisionarConReintento(db, pago.draft_token, correlacion);
    return { ok: true, duplicado: !!(r as any).duplicado, estado: 'APROBADO', tenant_id: p.tenantId ?? undefined };
  }
  if ((r as any).duplicado) return { ok: true, duplicado: true };
  return { ok: true, estado: r.estado };
}

/** Aprovisiona el borrador pagado; ante un fallo, registra el error y programa un reintento. */
export async function aprovisionarConReintento(db: Database, draftToken: string, correlacion: string): Promise<{ tenantId: string | null; error?: string }> {
  try {
    const r = await db.withPlatform(async (tx) => {
      const pago = (await tx.query(`SELECT 1 FROM payment WHERE draft_token=$1 AND estado='APROBADO'`, [draftToken])).rows[0];
      if (!pago) throw new AppError('CONFLICT', 'El pago de esta alta no está aprobado.');
      return provisionDraft(tx, draftToken, correlacion);
    });
    return { tenantId: r.tenantId };
  } catch (e) {
    const msg = e instanceof AppError ? e.message : 'No pudimos terminar de crear el espacio del negocio.';
    if (!(e instanceof AppError) && !config.test) console.error(`[aprovisionamiento ${correlacion}]`, e);
    await db.withPlatform(async (tx) => {
      const d = (await tx.query(
        `UPDATE onboarding_draft SET error_aprovisionamiento=$2, intentos_aprovisionamiento=intentos_aprovisionamiento+1, actualizado_en=now()
         WHERE token=$1 AND estado <> 'APROVISIONADO' RETURNING intentos_aprovisionamiento`, [draftToken, msg])).rows[0];
      if (d && d.intentos_aprovisionamiento < 5 && !(e instanceof AppError)) {
        await enqueue(tx, null, 'reintentar_aprovisionamiento', { draft_token: draftToken }, { claveUnica: `aprov:${draftToken}:${d.intentos_aprovisionamiento}`, ejecutarEn: new Date(Date.now() + 30_000 * d.intentos_aprovisionamiento), maxIntentos: 1 });
      }
    });
    return { tenantId: null, error: msg };
  }
}

async function procesarCobroComercio(db: Database, ev: EventoPago, correlacion: string, cuentaEsperada?: string): Promise<ResultadoEvento> {
  const tenantId = await db.withPlatform(async (tx) => {
    const ins = await tx.query(`INSERT INTO provisioning_event (event_id, tipo, referencia, payload, resultado) VALUES ($1,$2,$3,$4,'conciliacion') ON CONFLICT DO NOTHING RETURNING event_id`, [ev.id, ev.estado, ev.referencia, JSON.stringify(ev)]);
    if (!ins.rows[0]) return null;
    return (await tx.query(`SELECT tenant_id FROM payment_link WHERE referencia=$1`, [ev.referencia])).rows[0]?.tenant_id ?? 'desconocido';
  });
  if (!tenantId) return { ok: true, duplicado: true };
  if (tenantId === 'desconocido') return { ok: true, ignorado: 'referencia desconocida' };
  if (cuentaEsperada && cuentaEsperada !== tenantId) return { ok: true, ignorado: 'referencia de otra empresa' };
  const r = await db.withTenant(tenantId, (tx) => reconcilePaymentLink(tx, systemCtx(tenantId, correlacion, 'Pasarela del comercio'), ev));
  return { ok: true, estado: r.estado };
}

/** Evento de Wompi recibido en la URL propia de un comercio (resuelve el tenant por el token de la URL). */
export async function procesarEventoComercio(db: Database, webhookToken: string, verificar: (c: CuentaPasarela) => EventoPago | null, correlacion: string): Promise<ResultadoEvento & { firmaInvalida?: boolean }> {
  const tenantId = await db.withPlatform(async (tx) => (await tx.query(`SELECT tenant_id FROM merchant_gateway_account WHERE webhook_token=$1`, [webhookToken])).rows[0]?.tenant_id);
  if (!tenantId) throw notFound();
  const cuenta = await db.withTenant(tenantId, (tx) => cuentaComercio(tx));
  const ev = cuenta ? verificar(cuenta) : null;
  if (!ev) {
    await db.withPlatform((tx) => auditPlatform(tx, tenantId, { tipo: 'ANONIMO', id: null, nombre: 'webhook' }, 'WEBHOOK', correlacion, { accion: 'webhook.cobro.firma_invalida', resultado: 'DENEGADO' }));
    return { ok: false, firmaInvalida: true };
  }
  if (!ev.referencia.startsWith('PL-')) return { ok: true, ignorado: 'no es un cobro de la plataforma' };
  return procesarCobroComercio(db, ev, correlacion, tenantId);
}

/**
 * Retorno del checkout (/pago/resultado?id=…): el navegador solo aporta el id; el
 * servidor consulta la transacción a Wompi y procesa el resultado como un evento.
 */
export async function verificarRetorno(db: Database, transaccionId: string, correlacion: string) {
  const plataforma = cuentaPlataforma();
  let ev = plataforma?.proveedor === 'wompi' ? await consultarTransaccionWompi(plataforma, transaccionId) : null;
  if (ev && !ev.referencia.startsWith('SUB-')) ev = null;
  if (!ev) {
    // Puede ser un cobro de un comercio: se consulta con el entorno de la cuenta dueña de la referencia.
    const candidatos = await db.withPlatform(async (tx) => (await tx.query(`SELECT DISTINCT entorno FROM merchant_gateway_account WHERE proveedor='wompi'`)).rows.map((r: any) => r.entorno as 'sandbox' | 'produccion'));
    for (const entorno of candidatos) {
      ev = await consultarTransaccionWompi({ proveedor: 'wompi', entorno }, transaccionId);
      if (ev) break;
    }
  }
  if (!ev) return { estado: 'DESCONOCIDO' as const, mensaje: 'No pudimos confirmar el pago con la pasarela todavía. Si ya pagaste, la confirmación llegará en unos minutos.' };
  const r = await procesarEventoPago(db, ev, correlacion, 'retorno');
  return { estado: ev.estado, referencia: ev.referencia, resultado: r };
}

/** Pago de renovación o reactivación de la suscripción (cuenta de la plataforma). */
export async function iniciarPagoSuscripcion(db: Database, tenantId: string) {
  const cuenta = cuentaPlataforma();
  if (!cuenta) throw new AppError('CONFLICT', 'Los pagos en línea están pendientes de conectar. Escribe a soporte para renovar.');
  return db.withPlatform(async (tx) => {
    const p = (await tx.query(
      `SELECT p.nombre, p.precio_mensual, t.email_contacto, t.nombre AS negocio FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo WHERE t.id=$1`, [tenantId])).rows[0];
    const monto = Number(p.precio_mensual);
    const previo = (await tx.query(`SELECT referencia FROM payment WHERE tenant_id=$1 AND draft_token IS NULL AND estado='PENDIENTE' AND monto=$2 AND creado_en > now() - interval '1 hour' ORDER BY creado_en DESC LIMIT 1`, [tenantId, monto])).rows[0];
    const referencia = previo?.referencia ?? `SUB-${token(9)}`;
    if (!previo) {
      await tx.query(`INSERT INTO payment (id, tenant_id, referencia, concepto, monto, estado, proveedor) VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6)`,
        [uuidv7(), tenantId, referencia, `Renovación plan ${p.nombre}`, monto, cuenta.proveedor]);
    }
    const url = checkoutUrl(cuenta, { referencia, montoCentavos: aCentavos(monto), redirectUrl: `${config.publicUrl}/pago/resultado`, concepto: `Renovación plan ${p.nombre}`, cliente: { email: p.email_contacto, nombre: p.negocio } });
    return { referencia, monto, url, proveedor: cuenta.proveedor };
  });
}
