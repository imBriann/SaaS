import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { decrypt, encrypt, isUuid, token, uuidv7 } from '../lib/util.js';
import { aCentavos } from '../lib/money.js';
import { config } from '../config.js';
import { checkoutUrl, type CuentaPasarela, type EventoPago } from '../adapters/payments.js';

/**
 * Cobros del comercio a sus clientes. El dinero NO transita por cuentas de la
 * plataforma: el comercio vincula su propia cuenta de Wompi y la plataforma solo
 * genera el enlace firmado y concilia el resultado con el evento verificado.
 */
export const HORAS_VIGENCIA_ENLACE = 24;

const CuentaInput = z.discriminatedUnion('proveedor', [
  z.object({
    proveedor: z.literal('wompi'),
    entorno: z.enum(['sandbox', 'produccion']),
    llave_publica: z.string().trim().regex(/^pub_(test|prod)_[A-Za-z0-9]+$/, 'La llave pública de Wompi empieza por pub_test_ o pub_prod_.'),
    secreto_integridad: z.string().trim().min(10).max(200),
    secreto_eventos: z.string().trim().min(10).max(200),
  }),
  z.object({ proveedor: z.literal('simulada'), cuenta_id: z.string().trim().min(2).max(60) }),
]);

export async function linkGatewayAccount(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'subscription:manage');
  requireWritable(ctx);
  const d = CuentaInput.parse(input);
  if (d.proveedor === 'simulada' && !config.simuladores) throw invalid('La pasarela simulada solo existe en el entorno de demostración.');
  if (d.proveedor === 'wompi' && (d.entorno === 'produccion') !== d.llave_publica.startsWith('pub_prod_')) {
    throw invalid(d.entorno === 'produccion' ? 'Para producción usa la llave pública que empieza por pub_prod_.' : 'Para pruebas usa la llave pública que empieza por pub_test_.');
  }
  const previo = (await tx.query(`SELECT webhook_token FROM merchant_gateway_account WHERE tenant_id=$1`, [ctx.tenantId])).rows[0];
  const webhookToken = previo?.webhook_token ?? token(24);
  const cuentaId = d.proveedor === 'wompi' ? d.llave_publica : d.cuenta_id;
  await tx.query(
    `INSERT INTO merchant_gateway_account (tenant_id, proveedor, cuenta_id, llave_cifrada, llave_publica, secreto_integridad_cifrado, secreto_eventos_cifrado, webhook_token, entorno)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id) DO UPDATE SET proveedor=EXCLUDED.proveedor, cuenta_id=EXCLUDED.cuenta_id, llave_cifrada=EXCLUDED.llave_cifrada, llave_publica=EXCLUDED.llave_publica,
       secreto_integridad_cifrado=EXCLUDED.secreto_integridad_cifrado, secreto_eventos_cifrado=EXCLUDED.secreto_eventos_cifrado, entorno=EXCLUDED.entorno, vinculado_en=now()`,
    [
      ctx.tenantId, d.proveedor, cuentaId, encrypt(config.appKey, '-'),
      d.proveedor === 'wompi' ? d.llave_publica : null,
      d.proveedor === 'wompi' ? encrypt(config.appKey, d.secreto_integridad) : null,
      d.proveedor === 'wompi' ? encrypt(config.appKey, d.secreto_eventos) : null,
      webhookToken, d.proveedor === 'wompi' ? d.entorno : 'sandbox',
    ],
  );
  await audit(tx, ctx, { accion: 'pasarela.vincular', recurso: 'merchant_gateway_account', resultado: 'EXITO', detalle: { proveedor: d.proveedor, entorno: d.proveedor === 'wompi' ? d.entorno : 'sandbox' } });
  return { ok: true, webhook_url: urlWebhookComercio(webhookToken) };
}

export const urlWebhookComercio = (t: string) => `${config.apiPublicUrl}/api/webhooks/wompi/comercio/${t}`;

/** Datos públicos de la cuenta vinculada (sin secretos). */
export async function gatewayAccount(tx: Tx, ctx: Ctx) {
  const r = (await tx.query(`SELECT proveedor, cuenta_id, entorno, vinculado_en, webhook_token FROM merchant_gateway_account WHERE tenant_id=$1`, [ctx.tenantId])).rows[0];
  if (!r) return null;
  return { proveedor: r.proveedor, cuenta_id: r.proveedor === 'wompi' ? `${String(r.cuenta_id).slice(0, 12)}…` : r.cuenta_id, entorno: r.entorno, vinculado_en: r.vinculado_en, webhook_url: r.webhook_token ? urlWebhookComercio(r.webhook_token) : null };
}

/** Cuenta con secretos descifrados: solo para firmar y verificar dentro del servidor. */
export async function cuentaComercio(tx: Tx): Promise<CuentaPasarela | null> {
  const r = (await tx.query(`SELECT * FROM merchant_gateway_account LIMIT 1`)).rows[0];
  if (!r) return null;
  if (r.proveedor === 'simulada') return config.simuladores ? { proveedor: 'simulada', entorno: 'sandbox' } : null;
  return {
    proveedor: 'wompi', entorno: r.entorno, llavePublica: r.llave_publica,
    secretoIntegridad: r.secreto_integridad_cifrado ? decrypt(config.appKey, r.secreto_integridad_cifrado) : undefined,
    secretoEventos: r.secreto_eventos_cifrado ? decrypt(config.appKey, r.secreto_eventos_cifrado) : undefined,
  };
}

export async function createPaymentLink(tx: Tx, ctx: Ctx, orderId: string, opts: { skipPerm?: boolean } = {}) {
  if (!opts.skipPerm) { requirePerm(ctx, 'payment:link'); requireWritable(ctx); }
  if (!isUuid(orderId)) throw notFound();
  const cuenta = await cuentaComercio(tx);
  if (!cuenta) return { error: 'El negocio no ha vinculado su cuenta de pagos. Hazlo en Configuración › Cobros.' };
  const o = (await tx.query(
    `SELECT o.id, o.numero, o.total, o.estado, o.estado_pago, c.email, c.nombre, c.telefono FROM "order" o JOIN customer c ON c.id=o.customer_id WHERE o.id=$1 FOR UPDATE OF o`, [orderId])).rows[0];
  if (!o) throw notFound();
  if (o.estado !== 'CONFIRMADA') throw new AppError('CONFLICT', 'Solo se cobran ventas confirmadas.');
  if (o.estado_pago === 'PAGADA') return { pagada: true };
  // Idempotencia: un enlace vigente por venta y monto; repetir la acción devuelve el mismo.
  const vigente = (await tx.query(
    `SELECT referencia, url FROM payment_link WHERE order_id=$1 AND estado='ABIERTO' AND monto=$2 AND (expira_en IS NULL OR expira_en > now() + interval '10 minutes') ORDER BY creado_en DESC LIMIT 1`,
    [orderId, Number(o.total)])).rows[0];
  if (vigente) return { enlace: vigente.url, referencia: vigente.referencia, reutilizado: true };
  const referencia = `PL-${o.numero}-${token(6)}`;
  const expira = new Date(Date.now() + HORAS_VIGENCIA_ENLACE * 3600_000);
  const url = checkoutUrl(cuenta, {
    referencia, montoCentavos: aCentavos(o.total), redirectUrl: `${config.publicUrl}/pago/resultado`, expiraEn: expira,
    concepto: `Venta #${o.numero}`, cliente: { email: o.email, nombre: o.nombre, telefono: o.telefono },
  });
  await tx.query(
    `INSERT INTO payment_link (id, tenant_id, order_id, referencia, url, estado, proveedor, monto, expira_en) VALUES ($1,$2,$3,$4,$5,'ABIERTO',$6,$7,$8)`,
    [uuidv7(), ctx.tenantId, orderId, referencia, url, cuenta.proveedor, Number(o.total), expira.toISOString()],
  );
  await audit(tx, ctx, { accion: 'cobro.enlace', recurso: 'order', recursoId: orderId, resultado: 'EXITO', detalle: { referencia, proveedor: cuenta.proveedor } });
  return { enlace: url, referencia, expira_en: expira.toISOString() };
}

/**
 * Conciliación con un evento ya verificado (firma o consulta servidor a servidor).
 * Comprueba el monto: un pago aprobado por otro valor no marca la venta como pagada.
 */
export async function reconcilePaymentLink(tx: Tx, ctx: Ctx, ev: EventoPago) {
  const l = (await tx.query(`SELECT id, order_id, estado, monto, expira_en FROM payment_link WHERE referencia=$1 FOR UPDATE`, [ev.referencia])).rows[0];
  if (!l) throw notFound();
  await tx.query(`UPDATE payment_link SET ultimo_estado_proveedor=$2, transaccion_id=coalesce($3, transaccion_id), actualizado_en=now() WHERE id=$1`, [l.id, ev.estado, ev.transaccionId ?? null]);
  if (ev.estado !== 'APROBADO') {
    await audit(tx, ctx, { accion: 'cobro.intento', recurso: 'order', recursoId: l.order_id, resultado: 'EXITO', detalle: { referencia: ev.referencia, estado: ev.estado } });
    return { cambios: false, estado: ev.estado };
  }
  if (l.estado === 'PAGADO') return { cambios: false, estado: 'PAGADO' };
  if (ev.montoCentavos !== aCentavos(l.monto)) {
    await audit(tx, ctx, { accion: 'cobro.monto_no_coincide', recurso: 'order', recursoId: l.order_id, resultado: 'ERROR', detalle: { referencia: ev.referencia, esperado: aCentavos(l.monto), recibido: ev.montoCentavos } });
    return { cambios: false, estado: 'MONTO_NO_COINCIDE' };
  }
  const tardio = l.estado === 'EXPIRADO' || (l.expira_en && new Date(l.expira_en) < new Date());
  await tx.query(`UPDATE payment_link SET estado='PAGADO' WHERE id=$1`, [l.id]);
  await tx.query(`UPDATE "order" SET estado_pago='PAGADA' WHERE id=$1`, [l.order_id]);
  await audit(tx, ctx, { accion: 'cobro.conciliado', recurso: 'order', recursoId: l.order_id, resultado: 'EXITO', detalle: { referencia: ev.referencia, transaccion: ev.transaccionId, pago_tras_vencimiento: !!tardio } });
  return { cambios: true, estado: 'PAGADO' };
}
