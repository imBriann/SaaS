import { randomBytes } from 'node:crypto';
import type { Database, Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable, systemCtx } from '../core/context.js';
import { audit, auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { config } from '../config.js';
import { checkoutUrl, consultarTransaccionWompi, cuentaPlataforma, type CuentaPasarela, type EventoPago } from '../adapters/payments.js';
import { aceptacionWompi, crearTransaccionWompi } from '../adapters/wompiDirecto.js';
import { confirmarPedidoPagado, pedidoDelCliente, totales } from './pedidos.js';
import { enLineaDisponible, mediosHabilitados, NOMBRE_TIPO, vistaCuenta } from './metodos.js';
import { registrarMovimiento } from './ledger.js';
import { pesos } from './precios.js';

/**
 * CommercePaymentsService (docs/pagos-whatsapp.md). Separado por completo de las suscripciones (modules/billing.ts):
 * otras referencias (CP-…), otras tablas y otro procesador de eventos. Reglas:
 *  - el importe se calcula y CONGELA en el servidor al crear el intento (commerce_payment); no se modifica después;
 *  - una confirmación solo llega de Wompi (consultada servidor a servidor) o de una persona del negocio (pago manual);
 *  - un importe, moneda o referencia que no coinciden deja el cobro EN_REVISION, nunca lo aprueba;
 *  - las pruebas inyectan el cliente HTTP: la suite nunca hace transacciones reales.
 */
type Fetch = typeof fetch;
let http: Fetch = (...a) => fetch(...a);
/** Solo pruebas: reemplaza el cliente HTTP hacia Wompi. */
export const setHttpComercio = (h: Fetch | null) => { http = h ?? ((...a) => fetch(...a)); };

const ABIERTOS = ['PENDIENTE_PAGO', 'PROCESANDO', 'PENDIENTE_CONFIRMACION'];
const nuevaReferencia = (numero: number) => `CP-${numero}-${randomBytes(5).toString('hex').toUpperCase()}`;
const SISTEMA = { tipo: 'SISTEMA' as const, id: null, nombre: 'Pagos de comercio' };

/** Cuenta de Wompi del proyecto para cobros REALES: solo con PAYMENTS_LIVE_ENABLED y en producción. */
function cuentaReal(): CuentaPasarela {
  const d = enLineaDisponible();
  if (!d.ok) throw new AppError('CONFLICT', d.motivo ?? 'El pago en línea no está disponible.');
  return cuentaPlataforma()!;
}

export function vistaPago(r: any) {
  return {
    id: r.id, referencia: r.referencia, order_id: r.order_id, modalidad: r.modalidad, metodo: r.metodo, estado: r.estado, modo_precios: r.modo_precios,
    total_oficial: Number(r.total_oficial_centavos) / 100, cobro: Number(r.monto_cobro_centavos) / 100,
    monto_reportado: r.monto_reportado_centavos == null ? null : Number(r.monto_reportado_centavos) / 100,
    comision: r.comision_centavos == null ? null : Number(r.comision_centavos) / 100, neto: r.neto_centavos == null ? null : Number(r.neto_centavos) / 100,
    celular_final: r.celular_final, enlace_pago: r.enlace_pago, motivo: r.motivo, comprobante_nota: r.comprobante_nota, revisado_por: r.revisado_por, revisado_en: r.revisado_en,
    entorno: r.entorno, creado_en: r.creado_en, actualizado_en: r.actualizado_en,
  };
}

// ---------------------------------------------------------------------------
// Generar el cobro (lo pide la IA tras la confirmación del cliente con el importe exacto)
// ---------------------------------------------------------------------------
export interface GenerarCobro { orderId: string; customerId: string; celularNequi?: string | null; correo?: string | null }

export async function generarCobro(tx: Tx, ctx: Ctx, d: GenerarCobro) {
  requirePerm(ctx, 'payment:link');
  requireWritable(ctx);
  const o = await pedidoDelCliente(tx, d.orderId, d.customerId);
  await tx.query(`SELECT id FROM "order" WHERE id=$1 FOR UPDATE`, [o.id]);
  if (o.estado !== 'BORRADOR' || !['ABIERTO', 'RECHAZADO', 'ERROR'].includes(o.pedido_estado)) {
    const abierto = (await tx.query(`SELECT * FROM commerce_payment WHERE order_id=$1 AND estado = ANY($2) ORDER BY creado_en DESC LIMIT 1`, [o.id, ABIERTOS])).rows[0];
    if (abierto) return { ya_existia: true, ...instrucciones(abierto, null) };
    throw new AppError('CONFLICT', 'Este pedido ya no admite un cobro nuevo.');
  }
  if (Number(o.total) <= 0) throw invalid('El pedido no tiene productos.');
  if (!o.entrega) throw invalid('Falta saber si el cliente recoge el pedido o lo recibe a domicilio.');
  const medio = o.medio_pago as string | null;
  const { medios } = await mediosHabilitados(tx);
  const elegido = medios.find((m) => m.clave === medio);
  if (!medio || !elegido) throw invalid('El cliente aún no eligió un medio de pago habilitado.');
  const t = totales(o);
  const cliente = (await tx.query(`SELECT nombre, email, telefono FROM customer WHERE id=$1`, [d.customerId])).rows[0];
  const id = uuidv7();
  const referencia = nuevaReferencia(o.numero);
  const base = [id, ctx.tenantId, o.id, referencia, t.total_oficial_centavos, t.cobro_centavos, t.modo, t.cargo_fijo_centavos];

  if (elegido.modalidad === 'MANUAL') {
    await tx.query(
      `INSERT INTO commerce_payment (id, tenant_id, order_id, referencia, total_oficial_centavos, monto_cobro_centavos, modo_precios, cargo_fijo_centavos, modalidad, metodo, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MANUAL',$9,'PENDIENTE_CONFIRMACION')`, [...base, medio]);
    await tx.query(`UPDATE "order" SET pedido_estado='PENDIENTE_CONFIRMACION' WHERE id=$1`, [o.id]);
    await audit(tx, ctx, { accion: 'cobro.manual.crear', recurso: 'commerce_payment', recursoId: id, resultado: 'EXITO', detalle: { referencia, metodo: medio, cobro_centavos: t.cobro_centavos, modo: t.modo } });
    const cuenta = (await tx.query(`SELECT * FROM merchant_payment_account WHERE tipo=$1 AND activo ORDER BY creado_en LIMIT 1`, [medio])).rows[0];
    return instrucciones((await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [id])).rows[0], cuenta ? vistaCuenta(cuenta) : null);
  }

  // En línea (Wompi): solo con pagos reales habilitados y la cuenta de producción del proyecto.
  const cuenta = cuentaReal();
  if (medio === 'NEQUI') {
    const cel = (d.celularNequi ?? '').replace(/\D/g, '').replace(/^57(?=3\d{9}$)/, '');
    if (!/^3\d{9}$/.test(cel)) throw invalid('Falta el celular registrado en Nequi del cliente (10 dígitos, empieza por 3).');
    const correo = (d.correo ?? cliente?.email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) throw invalid('Wompi pide un correo del cliente para enviarle el comprobante. Pídeselo.');
    await tx.query(
      `INSERT INTO commerce_payment (id, tenant_id, order_id, referencia, total_oficial_centavos, monto_cobro_centavos, modo_precios, cargo_fijo_centavos, modalidad, metodo, estado, entorno, celular_final)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MANAGED','NEQUI','PENDIENTE_PAGO',$9,$10)`, [...base, cuenta.entorno, cel.slice(-4)]);
    await tx.query(`UPDATE "order" SET pedido_estado='PENDIENTE_PAGO' WHERE id=$1`, [o.id]);
    // La transacción se crea en la cola (fuera de esta transacción de base de datos), con reintentos si Wompi falla.
    await enqueue(tx, ctx.tenantId, 'cobro_comercio_crear', { pago_id: id, celular: cel, correo, nombre: cliente?.nombre ?? 'Cliente', telefono: (cliente?.telefono ?? '').replace(/^\+57/, '').replace(/\D/g, '') || cel }, { maxIntentos: 4 });
    await audit(tx, ctx, { accion: 'cobro.nequi.crear', recurso: 'commerce_payment', recursoId: id, resultado: 'EXITO', detalle: { referencia, cobro_centavos: t.cobro_centavos, modo: t.modo, celular: `···${cel.slice(-4)}` } });
    return instrucciones((await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [id])).rows[0], null);
  }
  // Tarjeta, PSE o Bancolombia: checkout web firmado de Wompi (el cliente acepta allí los términos de Wompi).
  const enlace = checkoutUrl(cuenta, {
    referencia, montoCentavos: t.cobro_centavos, redirectUrl: `${config.publicUrl}/pago/resultado`, expiraEn: new Date(Date.now() + 24 * 3600_000),
    concepto: `Pedido #${o.numero}`, cliente: { email: cliente?.email ?? null, nombre: cliente?.nombre ?? null, telefono: cliente?.telefono ?? null },
  });
  await tx.query(
    `INSERT INTO commerce_payment (id, tenant_id, order_id, referencia, total_oficial_centavos, monto_cobro_centavos, modo_precios, cargo_fijo_centavos, modalidad, metodo, estado, entorno, enlace_pago)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MANAGED','CHECKOUT','PENDIENTE_PAGO',$9,$10)`, [...base, cuenta.entorno, enlace]);
  await tx.query(`UPDATE "order" SET pedido_estado='PENDIENTE_PAGO' WHERE id=$1`, [o.id]);
  await audit(tx, ctx, { accion: 'cobro.checkout.crear', recurso: 'commerce_payment', recursoId: id, resultado: 'EXITO', detalle: { referencia, cobro_centavos: t.cobro_centavos, modo: t.modo } });
  return instrucciones((await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [id])).rows[0], null);
}

/** Qué decirle al cliente después de generar el cobro (sin afirmar que algo ya se pagó). */
function instrucciones(p: any, cuenta: ReturnType<typeof vistaCuenta> | null) {
  const cobro = pesos(Number(p.monto_cobro_centavos));
  const base = { referencia: p.referencia, estado: p.estado, cobro_texto: cobro, total_oficial_texto: pesos(Number(p.total_oficial_centavos)) };
  if (p.modalidad === 'MANUAL') {
    return { ...base, para_el_cliente: cuenta
      ? `Paga ${cobro} por ${cuenta.tipo_nombre} a ${cuenta.titular}: ${cuenta.valor}${cuenta.banco ? ` (${cuenta.banco}${cuenta.tipo_cuenta ? `, ${cuenta.tipo_cuenta.toLowerCase()}` : ''})` : ''}. ${cuenta.instrucciones ?? ''} Usa la referencia ${p.referencia}. El negocio revisará el pago y te confirmará por aquí; enviar un comprobante no confirma el pago por sí solo.`.replace(/\s+/g, ' ').trim()
      : `Paga ${cobro} con ${NOMBRE_TIPO[p.metodo as keyof typeof NOMBRE_TIPO] ?? p.metodo} y usa la referencia ${p.referencia}. El negocio te confirmará el pago por aquí.` };
  }
  if (p.metodo === 'NEQUI') return { ...base, para_el_cliente: `Te enviamos una solicitud de pago por ${cobro} a tu Nequi terminado en ${p.celular_final}. Ábrela en la app de Nequi y apruébala. Te confirmaremos por aquí cuando Nequi nos responda.` };
  return { ...base, enlace: p.enlace_pago, para_el_cliente: `Paga ${cobro} en el sitio seguro de Wompi (tarjeta, PSE o Bancolombia): ${p.enlace_pago} — te confirmaremos por aquí cuando Wompi apruebe el pago.` };
}

/** Texto de confirmación para el cliente (resumen de la herramienta confirmable): importe exacto y términos de Wompi. */
export async function resumenCobro(tx: Tx, d: GenerarCobro): Promise<string> {
  const o = await pedidoDelCliente(tx, d.orderId, d.customerId);
  const t = totales(o);
  const partes = [t.texto, `Se va a generar un cobro por exactamente ${pesos(t.cobro_centavos)} COP (pedido #${o.numero}).`];
  if (o.medio_pago === 'NEQUI') {
    const ac = enLineaDisponible().ok ? await aceptacionWompi(cuentaPlataforma()!, http).catch(() => null) : null;
    partes.push(`Llegará una solicitud de pago a tu Nequi terminado en ${(d.celularNequi ?? '').replace(/\D/g, '').slice(-4)}.`);
    partes.push(ac ? `Al responder SÍ aceptas los términos de Wompi (${ac.terminos.permalink}) y autorizas el tratamiento de tus datos personales (${ac.datos.permalink}).` : 'Al responder SÍ aceptas los términos de uso y la autorización de datos personales de Wompi.');
  }
  return partes.join(' ');
}

// ---------------------------------------------------------------------------
// Trabajo de la cola: crear la transacción Nequi en Wompi (con reintentos)
// ---------------------------------------------------------------------------
export async function crearTransaccionCola(db: Database, tenantId: string, p: { pago_id: string; celular: string; correo: string; nombre: string; telefono: string }, ultimo = false): Promise<void | 'reintentar'> {
  // Agotados los reintentos, el cobro queda en ERROR (visible para el cliente y el negocio), nunca colgado.
  const reintentar = async (motivo: string): Promise<void | 'reintentar'> => {
    if (!ultimo) return 'reintentar';
    const pg = await db.withTenant(tenantId, async (tx) => (await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [p.pago_id])).rows[0]);
    if (pg) await fallarCreacion(db, tenantId, pg, motivo);
  };
  const pago = await db.withTenant(tenantId, async (tx) => (await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [p.pago_id])).rows[0]);
  if (!pago || pago.transaccion_id || pago.estado !== 'PENDIENTE_PAGO') return;
  let cuenta: CuentaPasarela;
  try { cuenta = cuentaReal(); } catch (e) { await fallarCreacion(db, tenantId, pago, (e as Error).message); return; }
  const aceptacion = await aceptacionWompi(cuenta, http);
  if (!aceptacion) return reintentar('Wompi no respondió al pedir los términos de aceptación.');
  const r = await crearTransaccionWompi(cuenta, {
    referencia: pago.referencia, montoCentavos: Number(pago.monto_cobro_centavos), descripcion: `Pedido ${pago.referencia}`, redirectUrl: `${config.publicUrl}/pago/resultado`,
    cliente: { email: p.correo, nombre: p.nombre, telefono: p.telefono }, datos: { metodo: 'NEQUI', celular: p.celular }, aceptacion,
  }, http, { llavePrivada: true });
  if (!r.ok) {
    if (r.reintentable) return reintentar(r.mensaje);
    await fallarCreacion(db, tenantId, pago, r.mensaje);
    return;
  }
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(`UPDATE commerce_payment SET transaccion_id=$2, estado='PROCESANDO', estado_proveedor=$3, actualizado_en=now() WHERE id=$1 AND transaccion_id IS NULL`, [pago.id, r.transaccion.id, r.transaccion.estado]);
    await tx.query(`UPDATE "order" SET pedido_estado='PROCESANDO' WHERE id=$1 AND pedido_estado='PENDIENTE_PAGO'`, [pago.order_id]);
    await audit(tx, systemCtx(tenantId, pago.id, 'Pagos de comercio'), { accion: 'cobro.nequi.transaccion', recurso: 'commerce_payment', recursoId: pago.id, resultado: 'EXITO', detalle: { referencia: pago.referencia, estado: r.transaccion.estado } });
    await enqueue(tx, tenantId, 'aviso_pago_comercio', { pago_id: pago.id, tipo: 'PAGO_EN_ESPERA' }, { claveUnica: `aviso-pago:${pago.id}:espera` });
  });
}

async function fallarCreacion(db: Database, tenantId: string, pago: any, motivo: string) {
  await db.withTenant(tenantId, async (tx) => {
    await tx.query(`UPDATE commerce_payment SET estado='ERROR', motivo=$2, actualizado_en=now() WHERE id=$1 AND estado='PENDIENTE_PAGO'`, [pago.id, motivo.slice(0, 500)]);
    await tx.query(`UPDATE "order" SET pedido_estado='ERROR' WHERE id=$1`, [pago.order_id]);
    await audit(tx, systemCtx(tenantId, pago.id, 'Pagos de comercio'), { accion: 'cobro.nequi.transaccion', recurso: 'commerce_payment', recursoId: pago.id, resultado: 'ERROR', detalle: { referencia: pago.referencia, motivo: motivo.slice(0, 200) } });
    await enqueue(tx, tenantId, 'aviso_pago_comercio', { pago_id: pago.id, tipo: 'PAGO_RECHAZADO' }, { claveUnica: `aviso-pago:${pago.id}:rechazo` });
  });
}

// ---------------------------------------------------------------------------
// Confirmación: webhook, retorno del checkout, revisión periódica y botón «Verificar» del panel
// ---------------------------------------------------------------------------
export type ResultadoConciliacion = { ok: boolean; duplicado?: boolean; ignorado?: string; estado?: string; reintentar?: boolean };

/**
 * Evento de Wompi ya verificado (firma con el secreto de eventos del proyecto). No se confía en su contenido: se busca el
 * cobro por referencia en Omnegia (de ahí sale la empresa) y se CONSULTA la transacción a Wompi antes de cambiar nada.
 */
export async function procesarEventoCobro(db: Database, ev: EventoPago, correlacion: string): Promise<ResultadoConciliacion> {
  const pago = await db.withPlatform(async (tx) => (await tx.query(`SELECT id, tenant_id FROM commerce_payment WHERE referencia=$1`, [ev.referencia])).rows[0]);
  if (!pago) {
    await db.withPlatform((tx) => auditPlatform(tx, null, SISTEMA, 'WEBHOOK', correlacion, { accion: 'cobro.referencia_desconocida', resultado: 'DENEGADO', detalle: { referencia: ev.referencia.slice(0, 80) } }));
    return { ok: true, ignorado: 'referencia desconocida' };
  }
  return conciliarCobro(db, pago.tenant_id, pago.id, correlacion, { eventoId: ev.id, transaccionId: ev.transaccionId ?? null });
}

/** Consulta la transacción a Wompi (fuente de verdad) y aplica el resultado de forma idempotente. */
export async function conciliarCobro(db: Database, tenantId: string, pagoId: string, correlacion: string, o: { eventoId?: string; transaccionId?: string | null } = {}): Promise<ResultadoConciliacion> {
  const pago = await db.withTenant(tenantId, async (tx) => (await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [pagoId])).rows[0]);
  if (!pago) return { ok: true, ignorado: 'cobro desconocido' };
  if (pago.modalidad !== 'MANAGED') return { ok: true, ignorado: 'cobro manual' };
  const cuenta = cuentaPlataforma();
  if (cuenta?.proveedor !== 'wompi') return { ok: false, reintentar: true };
  const txId = pago.transaccion_id ?? o.transaccionId;
  if (!txId) return { ok: true, ignorado: 'sin transacción todavía' };
  const real = await consultarTransaccionWompi(cuenta, txId, http);
  if (!real) return { ok: false, reintentar: true };
  // La idempotencia se basa en el estado CONSULTADO a Wompi, no en el del evento: si un evento «APPROVED» llega antes de
  // que la API lo refleje, no queda consumido y el siguiente aviso (o la revisión periódica) lo aplica.
  return db.withTenant(tenantId, (tx) => aplicarResultado(tx, tenantId, pagoId, real, correlacion, `wompi:${real.transaccionId}:${real.estado}`));
}

const ESTADO_FINAL = ['PAGADO', 'RECHAZADO', 'ERROR', 'EN_REVISION', 'ANULADO'];

async function aplicarResultado(tx: Tx, tenantId: string, pagoId: string, real: EventoPago, correlacion: string, eventoId: string): Promise<ResultadoConciliacion> {
  const pago = (await tx.query(`SELECT * FROM commerce_payment WHERE id=$1 FOR UPDATE`, [pagoId])).rows[0];
  const ctx = systemCtx(tenantId, correlacion, 'Pagos de comercio');
  const ins = await tx.query(`INSERT INTO payment_event (event_id, tenant_id, referencia, estado, resultado) VALUES ($1,$2,$3,$4,'aplicado') ON CONFLICT DO NOTHING RETURNING event_id`,
    [eventoId.slice(0, 200), tenantId, real.referencia.slice(0, 80), real.estado]);
  if (!ins.rows[0]) return { ok: true, duplicado: true, estado: pago.estado };
  const revisar = async (tipo: 'MONTO' | 'MONEDA' | 'REFERENCIA', esperado: string, recibido: string) => {
    await tx.query(`INSERT INTO payment_reconciliation (id, tenant_id, commerce_payment_id, tipo, esperado, recibido, detalle) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), tenantId, pago.id, tipo, esperado, recibido, `Wompi reportó ${real.estado} para ${real.referencia}`]);
    await tx.query(`UPDATE commerce_payment SET estado='EN_REVISION', estado_proveedor=$2, monto_reportado_centavos=$3, motivo=$4, transaccion_id=coalesce(transaccion_id, $5), actualizado_en=now() WHERE id=$1`,
      [pago.id, real.estado, real.montoCentavos, `No coincide ${tipo.toLowerCase()}: se esperaba ${esperado} y llegó ${recibido}.`, real.transaccionId ?? null]);
    await tx.query(`UPDATE "order" SET pedido_estado='EN_REVISION' WHERE id=$1`, [pago.order_id]);
    await audit(tx, ctx, { accion: 'cobro.discrepancia', recurso: 'commerce_payment', recursoId: pago.id, resultado: 'DENEGADO', detalle: { tipo, esperado, recibido, estado: real.estado } });
    await enqueue(tx, tenantId, 'aviso_pago_comercio', { pago_id: pago.id, tipo: 'PAGO_NEGOCIO' }, { claveUnica: `aviso-pago:${pago.id}:revision` });
    return { ok: true, estado: 'EN_REVISION' };
  };
  // La respuesta de Wompi debe corresponder a ESTE cobro: referencia, transacción, moneda e importe congelado.
  if (real.referencia !== pago.referencia) return revisar('REFERENCIA', pago.referencia, real.referencia.slice(0, 80));
  if (pago.transaccion_id && real.transaccionId && real.transaccionId !== pago.transaccion_id) return revisar('REFERENCIA', pago.transaccion_id, real.transaccionId);
  if (real.moneda !== 'COP') return revisar('MONEDA', 'COP', real.moneda.slice(0, 10));
  if (real.montoCentavos !== Number(pago.monto_cobro_centavos)) return revisar('MONTO', String(pago.monto_cobro_centavos), String(real.montoCentavos));

  if (real.estado === 'APROBADO') {
    if (pago.estado === 'PAGADO') return { ok: true, duplicado: true, estado: 'PAGADO' };
    if (ESTADO_FINAL.includes(pago.estado) && pago.estado !== 'RECHAZADO' && pago.estado !== 'ERROR') return { ok: true, ignorado: `cobro en ${pago.estado}` };
    await tx.query(`UPDATE commerce_payment SET estado='PAGADO', estado_proveedor='APPROVED', monto_reportado_centavos=$2, transaccion_id=coalesce(transaccion_id, $3), motivo=NULL, actualizado_en=now() WHERE id=$1`,
      [pago.id, real.montoCentavos, real.transaccionId ?? null]);
    const final = await confirmarPedidoPagado(tx, ctx, pago.order_id);
    // La comisión real no viene en la transacción: queda pendiente hasta la conciliación con el reporte de Wompi.
    await registrarMovimiento(tx, tenantId, { orderId: pago.order_id, pagoId: pago.id, tipo: 'RECAUDO', brutoCentavos: real.montoCentavos, comisionCentavos: null, transaccionId: real.transaccionId ?? null });
    await audit(tx, ctx, { accion: 'cobro.aprobado', recurso: 'commerce_payment', recursoId: pago.id, resultado: 'EXITO', detalle: { referencia: pago.referencia, monto_centavos: real.montoCentavos, metodo: real.metodo ?? pago.metodo, pedido: final } });
    await enqueue(tx, tenantId, 'aviso_pago_comercio', { pago_id: pago.id, tipo: 'PAGO_CONFIRMADO' }, { claveUnica: `aviso-pago:${pago.id}:confirmado` });
    return { ok: true, estado: 'PAGADO' };
  }
  if (real.estado === 'RECHAZADO' || real.estado === 'ERROR') {
    if (ESTADO_FINAL.includes(pago.estado)) return { ok: true, ignorado: `cobro en ${pago.estado}` };
    const estado = real.estado === 'RECHAZADO' ? 'RECHAZADO' : 'ERROR';
    await tx.query(`UPDATE commerce_payment SET estado=$2, estado_proveedor=$3, transaccion_id=coalesce(transaccion_id, $4), actualizado_en=now() WHERE id=$1`, [pago.id, estado, real.estado, real.transaccionId ?? null]);
    await tx.query(`UPDATE "order" SET pedido_estado=$2 WHERE id=$1`, [pago.order_id, estado]);
    await audit(tx, ctx, { accion: 'cobro.rechazado', recurso: 'commerce_payment', recursoId: pago.id, resultado: 'ERROR', detalle: { referencia: pago.referencia, estado: real.estado } });
    await enqueue(tx, tenantId, 'aviso_pago_comercio', { pago_id: pago.id, tipo: 'PAGO_RECHAZADO' }, { claveUnica: `aviso-pago:${pago.id}:rechazo` });
    return { ok: true, estado };
  }
  if (real.estado === 'ANULADO' && pago.estado === 'PAGADO') {
    await tx.query(`UPDATE commerce_payment SET estado='EN_REVISION', estado_proveedor='VOIDED', motivo='Wompi anuló el pago después de aprobarlo.', actualizado_en=now() WHERE id=$1`, [pago.id]);
    await tx.query(`UPDATE "order" SET pedido_estado='EN_REVISION' WHERE id=$1`, [pago.order_id]);
    await registrarMovimiento(tx, tenantId, { orderId: pago.order_id, pagoId: pago.id, tipo: 'REVERSO', brutoCentavos: Number(pago.monto_reportado_centavos ?? real.montoCentavos), comisionCentavos: null, transaccionId: real.transaccionId ?? null });
    await audit(tx, ctx, { accion: 'cobro.anulado_tras_aprobacion', recurso: 'commerce_payment', recursoId: pago.id, resultado: 'ERROR', detalle: { referencia: pago.referencia } });
    await enqueue(tx, tenantId, 'aviso_pago_comercio', { pago_id: pago.id, tipo: 'PAGO_NEGOCIO' }, { claveUnica: `aviso-pago:${pago.id}:anulado` });
    return { ok: true, estado: 'EN_REVISION' };
  }
  // PENDIENTE: la entidad aún procesa.
  if (pago.estado === 'PENDIENTE_PAGO') {
    await tx.query(`UPDATE commerce_payment SET estado='PROCESANDO', estado_proveedor='PENDING', transaccion_id=coalesce(transaccion_id, $2), actualizado_en=now() WHERE id=$1`, [pago.id, real.transaccionId ?? null]);
    await tx.query(`UPDATE "order" SET pedido_estado='PROCESANDO' WHERE id=$1 AND pedido_estado='PENDIENTE_PAGO'`, [pago.order_id]);
  }
  return { ok: true, estado: 'PROCESANDO' };
}

/** Revisión periódica: cobros en línea abiertos hace más de 2 minutos se consultan a Wompi (el webhook pudo perderse). */
export async function revisarCobrosAbiertos(db: Database, correlacion: string) {
  const filas = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT id, tenant_id FROM commerce_payment WHERE modalidad='MANAGED' AND estado IN ('PENDIENTE_PAGO','PROCESANDO') AND transaccion_id IS NOT NULL
       AND actualizado_en < now() - interval '2 minutes' AND creado_en > now() - interval '3 days' ORDER BY actualizado_en LIMIT 30`)).rows);
  let revisados = 0;
  for (const f of filas) { await conciliarCobro(db, f.tenant_id, f.id, correlacion).catch(() => undefined); revisados++; }
  return { revisados };
}

// ---------------------------------------------------------------------------
// Pagos manuales: solo una persona autorizada del negocio confirma (nunca la IA ni el comprobante del cliente)
// ---------------------------------------------------------------------------
async function pagoManual(tx: Tx, id: string) {
  if (!isUuid(id)) throw notFound();
  const p = (await tx.query(`SELECT * FROM commerce_payment WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!p) throw notFound();
  if (p.modalidad !== 'MANUAL') throw new AppError('CONFLICT', 'Este cobro es en línea: lo confirma Wompi, no el panel.');
  return p;
}
const Motivo = (b: any, min = 5) => { const m = String(b?.motivo ?? b?.nota ?? '').trim(); if (m.length < min) throw invalid('Escribe un motivo u observación (al menos 5 letras).'); return m.slice(0, 500); };

export async function confirmarManual(tx: Tx, ctx: Ctx, id: string, body: unknown) {
  requirePerm(ctx, 'payment:register');
  requireWritable(ctx);
  const p = await pagoManual(tx, id);
  if (p.estado !== 'PENDIENTE_CONFIRMACION') throw new AppError('CONFLICT', 'Este cobro ya no espera confirmación.');
  const nota = Motivo(body);
  const quien = `${ctx.actor.tipo}:${ctx.actor.nombre}`;
  await tx.query(`UPDATE commerce_payment SET estado='PAGADO', comision_centavos=0, neto_centavos=monto_cobro_centavos, monto_reportado_centavos=monto_cobro_centavos, comprobante_nota=$2, revisado_por=$3, revisado_en=now(), actualizado_en=now() WHERE id=$1`, [p.id, nota, quien]);
  const final = await confirmarPedidoPagado(tx, ctx, p.order_id);
  await registrarMovimiento(tx, ctx.tenantId, { orderId: p.order_id, pagoId: p.id, tipo: 'RECAUDO', brutoCentavos: Number(p.monto_cobro_centavos), comisionCentavos: 0 });
  await audit(tx, ctx, { accion: 'cobro.manual.confirmar', recurso: 'commerce_payment', recursoId: p.id, resultado: 'EXITO', detalle: { referencia: p.referencia, nota, pedido: final } });
  await enqueue(tx, ctx.tenantId, 'aviso_pago_comercio', { pago_id: p.id, tipo: 'PAGO_CONFIRMADO' }, { claveUnica: `aviso-pago:${p.id}:confirmado` });
  return vistaPago((await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [p.id])).rows[0]);
}

export async function rechazarManual(tx: Tx, ctx: Ctx, id: string, body: unknown) {
  requirePerm(ctx, 'payment:register');
  requireWritable(ctx);
  const p = await pagoManual(tx, id);
  if (p.estado !== 'PENDIENTE_CONFIRMACION') throw new AppError('CONFLICT', 'Este cobro ya no espera confirmación.');
  const motivo = Motivo(body);
  await tx.query(`UPDATE commerce_payment SET estado='RECHAZADO', motivo=$2, revisado_por=$3, revisado_en=now(), actualizado_en=now() WHERE id=$1`, [p.id, motivo, `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  await tx.query(`UPDATE "order" SET pedido_estado='RECHAZADO' WHERE id=$1`, [p.order_id]);
  await audit(tx, ctx, { accion: 'cobro.manual.rechazar', recurso: 'commerce_payment', recursoId: p.id, resultado: 'EXITO', detalle: { referencia: p.referencia, motivo } });
  await enqueue(tx, ctx.tenantId, 'aviso_pago_comercio', { pago_id: p.id, tipo: 'PAGO_RECHAZADO' }, { claveUnica: `aviso-pago:${p.id}:rechazo` });
  return vistaPago((await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [p.id])).rows[0]);
}

/** Pedir otro comprobante o dejar una observación: el cobro sigue esperando; queda auditado. */
export async function observarManual(tx: Tx, ctx: Ctx, id: string, body: unknown) {
  requirePerm(ctx, 'payment:register');
  requireWritable(ctx);
  const p = await pagoManual(tx, id);
  const nota = Motivo(body);
  const pedir = !!(body as any)?.pedir_comprobante;
  if (pedir && p.estado !== 'PENDIENTE_CONFIRMACION') throw new AppError('CONFLICT', 'Este cobro ya no espera confirmación.');
  await tx.query(`UPDATE commerce_payment SET comprobante_nota=$2, revisado_por=$3, revisado_en=now(), actualizado_en=now() WHERE id=$1`, [p.id, nota, `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  await audit(tx, ctx, { accion: pedir ? 'cobro.manual.pedir_comprobante' : 'cobro.manual.observacion', recurso: 'commerce_payment', recursoId: p.id, resultado: 'EXITO', detalle: { referencia: p.referencia, nota } });
  if (pedir) await enqueue(tx, ctx.tenantId, 'aviso_pago_comercio', { pago_id: p.id, tipo: 'PAGO_PENDIENTE', texto: nota }, { claveUnica: `aviso-pago:${p.id}:comprobante:${Date.now()}` });
  return vistaPago((await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [p.id])).rows[0]);
}

// ---------------------------------------------------------------------------
// Panel: transacciones
// ---------------------------------------------------------------------------
export async function listarCobros(tx: Tx, ctx: Ctx, f: { estado?: string } = {}) {
  requirePerm(ctx, 'order:read');
  const params: unknown[] = [];
  let where = 'true';
  if (f.estado && /^[A-Z_]{3,30}$/.test(f.estado)) { params.push(f.estado); where = `cp.estado=$1`; }
  const rows = (await tx.query(`SELECT cp.*, o.numero, c.nombre AS cliente FROM commerce_payment cp JOIN "order" o ON o.id=cp.order_id JOIN customer c ON c.id=o.customer_id WHERE ${where} ORDER BY cp.creado_en DESC LIMIT 300`, params)).rows;
  const revisiones = (await tx.query(`SELECT * FROM payment_reconciliation WHERE resuelto_en IS NULL ORDER BY creado_en DESC LIMIT 100`)).rows;
  return { cobros: rows.map((r: any) => ({ ...vistaPago(r), numero: r.numero, cliente: r.cliente })), revisiones };
}

/** «Verificar ahora» desde el panel: vuelve a consultar a Wompi (nunca marca pagado desde el navegador). */
export async function verificarAhora(db: Database, ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const p = await db.withTenant(ctx.tenantId, async (tx) => { requirePerm(ctx, 'order:read'); return (await tx.query(`SELECT id, modalidad FROM commerce_payment WHERE id=$1`, [id])).rows[0]; });
  if (!p) throw notFound();
  if (p.modalidad !== 'MANAGED') throw new AppError('CONFLICT', 'Los pagos manuales los confirma una persona del negocio.');
  const r = await conciliarCobro(db, ctx.tenantId, id, ctx.correlacion);
  if (r.reintentar) throw new AppError('CONFLICT', 'No pudimos consultar a Wompi ahora. Intenta de nuevo en unos minutos.');
  return db.withTenant(ctx.tenantId, async (tx) => vistaPago((await tx.query(`SELECT * FROM commerce_payment WHERE id=$1`, [id])).rows[0]));
}
