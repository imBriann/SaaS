import type { Database, Tx } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { systemCtx } from '../core/context.js';
import { registrarIncidente } from '../core/incidentes.js';
import { AppError, notFound } from '../lib/errors.js';
import { cop, token, uuidv7 } from '../lib/util.js';
import { aCentavos } from '../lib/money.js';
import { config, institucionalDisponible } from '../config.js';
import { checkoutUrl, consultarPorReferenciaWompi, consultarTransaccionWompi, cuentaPlataforma, type CuentaPasarela, type EventoPago } from '../adapters/payments.js';
import { condicionesPeriodo, provisionDraft } from '../onboarding/provisioning.js';
import { conceptoInstitucional, type Modalidad } from '../onboarding/oferta.js';
import { cuentaComercio, reconcilePaymentLink } from './payments.js';
import { encolarDocumentos, recuperarDocumentos } from '../documentos/servicio.js';

/**
 * Pagos de la plataforma (alta de empresas y renovación de suscripciones) y
 * despacho de eventos de pago. Las dos clases de cobro no se mezclan:
 *   SUB-…  pago de una empresa a la plataforma (cuenta de la plataforma);
 *   PL-…   cobro del comercio a su cliente (cuenta propia del comercio).
 *
 * El evento se registra una sola vez (provisioning_event.event_id) y el estado del
 * pago se confirma en una transacción; el aprovisionamiento corre en otra. Si
 * falla, el pago queda aprobado y el alta se reintenta sin volver a cobrar.
 *
 * Un pago solo se aprueba si el evento viene de la misma pasarela con la que se creó,
 * por el monto exacto en centavos y en la moneda registrados. Los términos (monto,
 * modalidad, vigencia, plan) se congelan al crear el checkout y nunca vienen del navegador.
 */
export type ResultadoEvento = { ok: boolean; duplicado?: boolean; ignorado?: string; estado?: string; tenant_id?: string };

const PASARELA = { tipo: 'SISTEMA' as const, id: null, nombre: 'Pasarela' };
/** Vigencia de un checkout de la plataforma: pasado este tiempo Wompi rechaza el pago y se genera otro. */
export const MINUTOS_CHECKOUT = 60;

async function incidentePago(tx: Tx, tenantId: string | null, motivo: string, correlacion: string) {
  await registrarIncidente(tx, { codigo: 'PAGO_REQUIERE_REVISION', servicio: 'pagos', tenantId, correlacion, detalle: { tipo_trabajo: motivo, proveedor: 'plataforma' } });
}

export async function procesarEventoPago(db: Database, ev: EventoPago, correlacion: string, origen: string): Promise<ResultadoEvento> {
  if (ev.referencia.startsWith('PL-')) return procesarCobroComercio(db, ev, correlacion);

  const r = await db.withPlatform(async (tx) => {
    const ins = await tx.query(
      `INSERT INTO provisioning_event (event_id, tipo, referencia, payload, resultado) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING event_id`,
      [ev.id, ev.estado, ev.referencia, JSON.stringify(ev), origen],
    );
    const pago = (await tx.query(`SELECT * FROM payment WHERE referencia=$1 FOR UPDATE`, [ev.referencia])).rows[0];
    if (!ins.rows[0]) return { duplicado: true, pago };
    const auditar = (accion: string, resultado: 'EXITO' | 'ERROR' | 'DENEGADO', detalle: Record<string, unknown> = {}) =>
      auditPlatform(tx, pago?.tenant_id ?? null, PASARELA, 'WEBHOOK', correlacion, { accion, resultado, detalle: { referencia: ev.referencia, estado: ev.estado, origen, ...detalle } });
    if (!pago) {
      await auditar('pago.referencia_desconocida', 'DENEGADO');
      return { ignorado: 'referencia desconocida' };
    }
    // Una pasarela no puede confirmar pagos creados con otra (p. ej. la simulada sobre un cobro real).
    if (pago.proveedor !== ev.proveedor) {
      await auditar('pago.pasarela_no_coincide', 'DENEGADO', { esperada: pago.proveedor, recibida: ev.proveedor });
      return { ignorado: 'pasarela no coincide', pago };
    }
    if (pago.estado === 'APROBADO') {
      // Anulación posterior (solo tarjetas): se registra y se escala; no se borra nada automáticamente.
      if (ev.estado === 'ANULADO' && (!pago.transaccion_id || pago.transaccion_id === ev.transaccionId)) {
        await tx.query(`UPDATE payment SET estado='ANULADO', estado_proveedor='ANULADO', actualizado_en=now() WHERE id=$1`, [pago.id]);
        await auditar('pago.anulado_tras_aprobacion', 'ERROR', { transaccion: ev.transaccionId });
        await incidentePago(tx, pago.tenant_id ?? null, 'pago.anulado_tras_aprobacion', correlacion);
        return { estado: 'ANULADO', pago };
      }
      if (ev.estado === 'APROBADO' && ev.transaccionId && pago.transaccion_id && ev.transaccionId !== pago.transaccion_id) {
        await auditar('pago.transaccion_adicional', 'ERROR', { transaccion: ev.transaccionId });
        await incidentePago(tx, pago.tenant_id ?? null, 'pago.transaccion_adicional', correlacion);
      }
      return { duplicado: true, pago };
    }
    if (pago.estado === 'ANULADO') return { ignorado: 'pago anulado', pago };
    if (ev.estado === 'PENDIENTE') {
      await tx.query(`UPDATE payment SET estado_proveedor='PENDIENTE', transaccion_id=coalesce(transaccion_id, $2), actualizado_en=now() WHERE id=$1`, [pago.id, ev.transaccionId ?? null]);
      return { estado: 'PENDIENTE', pago };
    }
    if (ev.estado !== 'APROBADO') {
      const estado = ev.estado === 'ANULADO' ? 'ANULADO' : 'RECHAZADO';
      // Un rechazo no reserva la transacción: Wompi permite reintentar la misma referencia.
      await tx.query(`UPDATE payment SET estado=$2, estado_proveedor=$3, actualizado_en=now() WHERE id=$1`, [pago.id, estado, ev.estado]);
      if (pago.draft_token) {
        // El borrador vuelve a ser editable solo si no queda otro checkout en curso.
        await tx.query(
          `UPDATE onboarding_draft SET estado='BORRADOR' WHERE token=$1 AND estado='PAGO_INICIADO'
             AND NOT EXISTS (SELECT 1 FROM payment WHERE draft_token=$1 AND estado IN ('PENDIENTE','APROBADO'))`, [pago.draft_token]);
      }
      await auditar(pago.tenant_id && !pago.draft_token ? 'suscripcion.pago_rechazado' : 'pago.rechazado', 'ERROR');
      return { estado, pago };
    }
    // APROBADO: monto exacto en centavos, misma moneda y transacción identificada.
    const esperado = aCentavos(pago.monto);
    if (ev.montoCentavos !== esperado || ev.moneda !== pago.moneda || (ev.proveedor === 'wompi' && !ev.transaccionId)) {
      await tx.query(`UPDATE payment SET estado_proveedor='MONTO_NO_COINCIDE', actualizado_en=now() WHERE id=$1`, [pago.id]);
      await auditar('pago.monto_no_coincide', 'ERROR', { esperado, recibido: ev.montoCentavos, moneda: ev.moneda });
      await incidentePago(tx, pago.tenant_id ?? null, 'pago.monto_no_coincide', correlacion);
      return { ignorado: 'monto no coincide', pago };
    }
    const otroAprobado = pago.draft_token
      ? (await tx.query(`SELECT referencia FROM payment WHERE draft_token=$1 AND estado='APROBADO' AND id<>$2 LIMIT 1`, [pago.draft_token, pago.id])).rows[0]
      : null;
    await tx.query(
      `UPDATE payment SET estado='APROBADO', transaccion_id=$2, estado_proveedor='APROBADO', verificado_en=now(), actualizado_en=now() WHERE id=$1`,
      [pago.id, ev.transaccionId ?? null]);
    await auditar('pago.aprobado', 'EXITO', { modalidad: pago.modalidad, monto: Number(pago.monto), monto_referencia: pago.monto_referencia == null ? null : Number(pago.monto_referencia), transaccion: ev.transaccionId ?? null, reemplazado: pago.estado === 'REEMPLAZADO' });
    if (otroAprobado) {
      // El dinero se recibió dos veces para la misma alta: queda registrado y se escala para reembolso.
      await auditar('pago.duplicado_requiere_reembolso', 'ERROR', { otra_referencia: otroAprobado.referencia });
      await incidentePago(tx, pago.tenant_id ?? null, 'pago.duplicado', correlacion);
    }
    if (pago.tenant_id && !pago.draft_token) await aplicarRenovacion(tx, pago, correlacion);
    return { estado: 'APROBADO', pago };
  });

  if ('ignorado' in r && r.ignorado) return { ok: true, ignorado: r.ignorado };
  const pago = (r as any).pago;
  // Alta: se aprovisiona tras confirmar el pago. Un evento repetido también reintenta un alta pendiente.
  if (pago?.draft_token && (r.estado === 'APROBADO' || ((r as any).duplicado && pago.estado === 'APROBADO'))) {
    const diferido = await db.withPlatform(async tx => {
      const d = (await tx.query('SELECT creacion_diferida FROM onboarding_draft WHERE token=$1', [pago.draft_token])).rows[0];
      if (d?.creacion_diferida) await encolarDocumentos(tx, pago.id);
      return !!d?.creacion_diferida;
    });
    if (diferido) return { ok: true, duplicado: !!(r as any).duplicado, estado: 'APROBADO' };
    const p = await aprovisionarConReintento(db, pago.draft_token, correlacion);
    return { ok: true, duplicado: !!(r as any).duplicado, estado: 'APROBADO', tenant_id: p.tenantId ?? undefined };
  }
  if ((r as any).duplicado) return { ok: true, duplicado: true };
  return { ok: true, estado: r.estado };
}

/** Renovación o reactivación pagada: extiende desde el fin del periodo vigente (o desde hoy si ya venció). */
async function aplicarRenovacion(tx: Tx, pago: any, correlacion: string) {
  const s = (await tx.query(`SELECT * FROM subscription WHERE tenant_id=$1 FOR UPDATE`, [pago.tenant_id])).rows[0];
  if (!s) return;
  const modalidad: Modalidad = pago.modalidad;
  const terminos = { modalidad, accesoDias: pago.acceso_dias ?? null, precioPagado: Number(pago.monto), montoReferencia: pago.monto_referencia == null ? null : Number(pago.monto_referencia) };
  // Pasar de institucional a comercial solo ocurre con un pago que el cliente aceptó expresamente.
  const condiciones = condicionesPeriodo(terminos, s.modalidad !== modalidad ? { cambio_modalidad: { de: s.modalidad, a: modalidad, aceptado_con_pago: pago.referencia } } : {});
  const p = (await tx.query(
    `UPDATE subscription SET estado='ACTIVA', gracia_hasta=NULL,
       periodo_inicio = CASE WHEN periodo_fin > now() THEN periodo_fin ELSE now() END,
       periodo_fin = (CASE WHEN periodo_fin > now() THEN periodo_fin ELSE now() END)
                     + CASE WHEN $2::int IS NULL THEN interval '1 month' ELSE $2::int * interval '1 day' END,
       modalidad=$3, precio_pagado=$4, condiciones=$5, actualizado_en=now()
     WHERE tenant_id=$1 RETURNING periodo_inicio, periodo_fin, plan_codigo`,
    [pago.tenant_id, terminos.accesoDias, modalidad, terminos.precioPagado, JSON.stringify(condiciones)])).rows[0];
  await tx.query(
    `INSERT INTO subscription_period (id, tenant_id, payment_id, modalidad, plan_codigo, monto_pagado, monto_referencia, periodo_inicio, periodo_fin, condiciones)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (payment_id) DO NOTHING`,
    [uuidv7(), pago.tenant_id, pago.id, modalidad, p.plan_codigo, terminos.precioPagado, terminos.montoReferencia, p.periodo_inicio, p.periodo_fin, JSON.stringify(condiciones)]);
  await auditPlatform(tx, pago.tenant_id, PASARELA, 'WEBHOOK', correlacion, { accion: 'suscripcion.renovada', resultado: 'EXITO', detalle: { referencia: pago.referencia, modalidad, monto: terminos.precioPagado, periodo_fin: p.periodo_fin } });
  // Comprobante, ZIP y correo de confirmación (una sola vez por pago).
  await encolarDocumentos(tx, pago.id);
}

/** Aprovisiona el borrador pagado; ante un fallo, registra el error y programa un reintento. */
export async function aprovisionarConReintento(db: Database, draftToken: string, correlacion: string): Promise<{ tenantId: string | null; error?: string }> {
  try {
    const r = await db.withPlatform(async (tx) => {
      const draft = (await tx.query('SELECT creacion_diferida,personalizacion,creacion FROM onboarding_draft WHERE token=$1', [draftToken])).rows[0];
      if (draft?.creacion_diferida && (!draft.personalizacion || !['aplicando', 'completado'].includes(draft.creacion.estado))) return { tenantId: null };
      const pago = (await tx.query(`SELECT 1 FROM payment WHERE draft_token=$1 AND estado='APROBADO'`, [draftToken])).rows[0];
      if (!pago) throw new AppError('CONFLICT', 'El pago de esta alta no está aprobado.');
      return provisionDraft(tx, draftToken, correlacion);
    });
    return { tenantId: r.tenantId };
  } catch (e) {
    const msg = e instanceof AppError ? e.message : 'No pudimos terminar de crear el espacio del negocio.';
    if (!(e instanceof AppError) && !config.test) console.error(`[aprovisionamiento ${correlacion}] ${(e as Error)?.name ?? 'Error'}`);
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

/**
 * Recuperación cuando el evento de Wompi se retrasa o se perdió (caída del servidor,
 * reintentos agotados): consulta servidor a servidor las transacciones de la referencia
 * y las procesa como eventos. `minSegundos` limita la frecuencia de consulta por pago.
 */
export async function conciliarReferencia(db: Database, referencia: string, correlacion: string, minSegundos = 15): Promise<ResultadoEvento | null> {
  const cuenta = cuentaPlataforma();
  if (cuenta?.proveedor !== 'wompi' || !cuenta.llavePrivada) return null;
  const reclamado = await db.withPlatform(async (tx) => (await tx.query(
    `UPDATE payment SET consultado_en=now() WHERE referencia=$1 AND proveedor='wompi' AND estado IN ('PENDIENTE','REEMPLAZADO')
       AND (consultado_en IS NULL OR consultado_en < now() - ($2 || ' seconds')::interval)
     RETURNING entorno`, [referencia, String(minSegundos)])).rows[0]);
  // Las llaves de un ambiente no consultan transacciones del otro.
  if (!reclamado || (reclamado.entorno && reclamado.entorno !== cuenta.entorno)) return null;
  const transacciones = await consultarPorReferenciaWompi(cuenta, referencia);
  if (!transacciones?.length) return null;
  const aprobada = transacciones.find((t) => t.estado === 'APROBADO');
  if (aprobada) return procesarEventoPago(db, aprobada, correlacion, 'conciliacion');
  let ultimo: ResultadoEvento | null = null;
  for (const t of transacciones.filter((x) => x.estado !== 'PENDIENTE')) ultimo = await procesarEventoPago(db, t, correlacion, 'conciliacion');
  return ultimo;
}

/** Trabajo periódico: concilia checkouts sin respuesta y reanuda altas pagadas que no terminaron. */
export async function conciliarPagosPendientes(db: Database, correlacion: string) {
  const { referencias, borradores } = await db.withPlatform(async (tx) => ({
    referencias: (await tx.query(
      `SELECT referencia FROM payment WHERE proveedor='wompi' AND estado IN ('PENDIENTE','REEMPLAZADO')
         AND creado_en < now() - interval '2 minutes' AND creado_en > now() - interval '3 days'
         AND (consultado_en IS NULL OR consultado_en < now() - interval '4 minutes')
       ORDER BY creado_en LIMIT 25`)).rows.map((x: any) => x.referencia as string),
    // Pago aprobado y alta sin terminar (p. ej. el proceso cayó entre las dos transacciones).
    borradores: (await tx.query(
      `SELECT DISTINCT p.draft_token FROM payment p JOIN onboarding_draft d ON d.token=p.draft_token
       WHERE p.estado='APROBADO' AND d.estado <> 'APROVISIONADO' AND d.intentos_aprovisionamiento < 5 AND p.actualizado_en < now() - interval '1 minute'
         AND (NOT d.creacion_diferida OR (d.personalizacion IS NOT NULL AND d.creacion->>'estado'='aplicando'))
       LIMIT 25`)).rows.map((x: any) => x.draft_token as string),
  }));
  for (const ref of referencias) await conciliarReferencia(db, ref, correlacion, 240);
  for (const tk of borradores) await aprovisionarConReintento(db, tk, correlacion);
  // Documentos que no se generaron (caída, fallo) y facturas pendientes si la facturación ya está habilitada.
  const documentos = await recuperarDocumentos(db);
  return { referencias: referencias.length, borradores: borradores.length, ...documentos };
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
      if (ev && !ev.referencia.startsWith('PL-')) ev = null;
      if (ev) break;
    }
  }
  if (!ev) return { estado: 'DESCONOCIDO' as const, mensaje: 'No pudimos confirmar el pago con la pasarela todavía. Si ya pagaste, la confirmación llegará en unos minutos.' };
  const r = await procesarEventoPago(db, ev, correlacion, 'retorno');
  return { estado: ev.estado, referencia: ev.referencia, resultado: r };
}

// ---------------------------------------------------------------------------
// Renovación
// ---------------------------------------------------------------------------
export interface OfertaRenovacion {
  disponible: boolean;
  modalidad: Modalidad;
  monto: number;
  acceso_dias: number | null;
  monto_referencia: number;
  /** Cambia la modalidad vigente (institucional → comercial): exige aceptación expresa. */
  requiere_aceptacion: boolean;
  /** Hay que confirmar monto y modalidad mostrados antes de generar el pago. */
  requiere_confirmacion: boolean;
  mensaje: string;
}

/**
 * Cómo puede continuar una empresa. Nunca cobra el precio comercial a quien está en la
 * modalidad institucional sin su aceptación, ni renueva nada de forma automática.
 */
export function ofertaRenovacion(s: { modalidad?: string | null; precio_mensual: number | string }): OfertaRenovacion {
  const referencia = Number(s.precio_mensual);
  const cuenta = cuentaPlataforma();
  if (s.modalidad === 'INSTITUCIONAL') {
    if (config.institucional.activo) {
      const { precioCop, dias } = config.institucional;
      return { disponible: institucionalDisponible().ok, modalidad: 'INSTITUCIONAL', monto: precioCop, acceso_dias: dias, monto_referencia: referencia, requiere_aceptacion: false, requiere_confirmacion: true,
        mensaje: `Renovación manual: ${dias} días más por ${cop(precioCop)} (precio institucional vigente), cobro real y único con Wompi. No hay cobros automáticos.` };
    }
    return { disponible: !!cuenta && (config.simuladores || config.pagos.tarifasConfirmadas), modalidad: 'COMERCIAL', monto: referencia, acceso_dias: null, monto_referencia: referencia, requiere_aceptacion: true, requiere_confirmacion: true,
      mensaje: `La modalidad institucional terminó. Para continuar puedes aceptar el plan comercial de ${cop(referencia)} al mes. No se cobra nada sin tu aceptación expresa.` };
  }
  return { disponible: !!cuenta, modalidad: 'COMERCIAL', monto: referencia, acceso_dias: null, monto_referencia: referencia, requiere_aceptacion: false, requiere_confirmacion: false, mensaje: `Plan mensual de ${cop(referencia)}.` };
}

/** Pago de renovación o reactivación de la suscripción (cuenta de la plataforma). */
export async function iniciarPagoSuscripcion(db: Database, tenantId: string, cuerpo: unknown = {}) {
  const cuenta = cuentaPlataforma();
  if (!cuenta) throw new AppError('CONFLICT', 'Los pagos en línea están pendientes de conectar. Escribe a soporte para renovar.');
  const b = (cuerpo && typeof cuerpo === 'object' ? cuerpo : {}) as { modalidad?: unknown; monto?: unknown; acepto?: unknown };
  return db.withPlatform(async (tx) => {
    const p = (await tx.query(
      `SELECT p.nombre, p.precio_mensual, t.plan_codigo, t.email_contacto, t.nombre AS negocio, s.modalidad
       FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo JOIN subscription s ON s.tenant_id=t.id WHERE t.id=$1 FOR UPDATE OF s`, [tenantId])).rows[0];
    if (!p) throw notFound();
    const oferta = ofertaRenovacion(p);
    if (!oferta.disponible) throw new AppError('CONFLICT', 'La renovación en línea no está disponible en este momento. Escríbenos y te ayudamos.', { oferta });
    // Lo que se cobra debe ser exactamente lo que se mostró; un cambio de modalidad exige aceptación expresa.
    if (oferta.requiere_confirmacion && (b.modalidad !== oferta.modalidad || Number(b.monto) !== oferta.monto)) {
      throw new AppError('CONFLICT', `Confirma las condiciones antes de pagar: ${oferta.mensaje}`, { oferta });
    }
    if (oferta.requiere_aceptacion && b.acepto !== true) {
      throw new AppError('CONFLICT', `Para continuar debes aceptar expresamente el cambio de modalidad. ${oferta.mensaje}`, { oferta });
    }
    const concepto = oferta.modalidad === 'INSTITUCIONAL' ? conceptoInstitucional(oferta.acceso_dias ?? undefined) : `Renovación plan ${p.nombre}`;
    const entorno = cuenta.proveedor === 'wompi' ? cuenta.entorno : null;
    const previo = (await tx.query(
      `SELECT referencia, expira_en FROM payment WHERE tenant_id=$1 AND draft_token IS NULL AND estado='PENDIENTE' AND monto=$2 AND modalidad=$3 AND proveedor=$4
         AND entorno IS NOT DISTINCT FROM $5 AND acceso_dias IS NOT DISTINCT FROM $6
         AND creado_en > now() - interval '1 hour' AND (expira_en IS NULL OR expira_en > now() + interval '5 minutes')
       ORDER BY creado_en DESC LIMIT 1`, [tenantId, oferta.monto, oferta.modalidad, cuenta.proveedor, entorno, oferta.acceso_dias])).rows[0];
    let referencia = previo?.referencia as string | undefined;
    let expira = previo?.expira_en ? new Date(previo.expira_en) : undefined;
    if (!referencia) {
      // Checkouts anteriores con otras condiciones dejan de ofrecerse (si se pagan igual, se registran por su monto).
      await tx.query(`UPDATE payment SET estado='REEMPLAZADO', actualizado_en=now() WHERE tenant_id=$1 AND draft_token IS NULL AND estado='PENDIENTE'`, [tenantId]);
      referencia = `SUB-${token(9)}`;
      expira = new Date(Date.now() + MINUTOS_CHECKOUT * 60_000);
      // Los datos de facturación del contratante se toman del último pago de la empresa que los tenga.
      const fact = (await tx.query(`SELECT facturacion, documento_cifrado, facturacion_huella FROM payment WHERE tenant_id=$1 AND facturacion IS NOT NULL ORDER BY creado_en DESC LIMIT 1`, [tenantId])).rows[0];
      await tx.query(
        `INSERT INTO payment (id, tenant_id, referencia, concepto, monto, estado, proveedor, modalidad, monto_referencia, acceso_dias, plan_codigo, entorno, expira_en, facturacion, documento_cifrado, facturacion_huella)
         VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [uuidv7(), tenantId, referencia, concepto, oferta.monto, cuenta.proveedor, oferta.modalidad, oferta.monto_referencia, oferta.acceso_dias, p.plan_codigo, entorno, expira.toISOString(),
          fact?.facturacion ? JSON.stringify(fact.facturacion) : null, fact?.documento_cifrado ?? null, fact?.facturacion_huella ?? null]);
      await auditPlatform(tx, tenantId, PASARELA, 'API', referencia, {
        accion: oferta.requiere_aceptacion ? 'suscripcion.aceptacion_comercial' : 'suscripcion.checkout', resultado: 'EXITO',
        detalle: { referencia, modalidad: oferta.modalidad, monto: oferta.monto, acceso_dias: oferta.acceso_dias, aceptado: oferta.requiere_aceptacion ? true : undefined },
      });
    }
    const url = checkoutUrl(cuenta, { referencia, montoCentavos: aCentavos(oferta.monto), redirectUrl: `${config.publicUrl}/pago/resultado`, expiraEn: cuenta.proveedor === 'wompi' ? expira : undefined, concepto, cliente: { email: p.email_contacto, nombre: p.negocio } });
    return { referencia, monto: oferta.monto, modalidad: oferta.modalidad, acceso_dias: oferta.acceso_dias, url, proveedor: cuenta.proveedor };
  });
}
