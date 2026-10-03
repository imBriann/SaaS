import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { AppError, notFound } from '../lib/errors.js';
import { encrypt, isUuid, token, uuidv7 } from '../lib/util.js';
import { config } from '../config.js';

/**
 * Cobros del comercio a sus clientes (RF-024, ADR-09).
 * El dinero NO transita por cuentas de la plataforma: el comercio vincula su
 * propia cuenta de pasarela y la plataforma solo genera el enlace y concilia.
 */
export async function linkGatewayAccount(tx: Tx, ctx: Ctx, input: { proveedor: string; cuenta_id: string; llave_privada: string }) {
  requirePerm(ctx, 'subscription:manage');
  requireWritable(ctx);
  if (!input.cuenta_id?.trim() || !input.llave_privada?.trim()) throw new AppError('VALIDATION', 'Indica la cuenta y la llave de tu pasarela.');
  await tx.query(
    `INSERT INTO merchant_gateway_account (tenant_id, proveedor, cuenta_id, llave_cifrada) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id) DO UPDATE SET proveedor=EXCLUDED.proveedor, cuenta_id=EXCLUDED.cuenta_id, llave_cifrada=EXCLUDED.llave_cifrada, vinculado_en=now()`,
    [ctx.tenantId, input.proveedor, input.cuenta_id.trim(), encrypt(config.appKey, input.llave_privada.trim())],
  );
  await audit(tx, ctx, { accion: 'pasarela.vincular', recurso: 'merchant_gateway_account', resultado: 'EXITO', detalle: { proveedor: input.proveedor, cuenta_id: input.cuenta_id } });
  return { ok: true };
}

export async function gatewayAccount(tx: Tx, ctx: Ctx) {
  const r = (await tx.query(`SELECT proveedor, cuenta_id, vinculado_en FROM merchant_gateway_account WHERE tenant_id=$1`, [ctx.tenantId])).rows[0];
  return r ?? null;
}

export async function createPaymentLink(tx: Tx, ctx: Ctx, orderId: string, opts: { skipPerm?: boolean } = {}) {
  if (!opts.skipPerm) { requirePerm(ctx, 'payment:link'); requireWritable(ctx); }
  if (!isUuid(orderId)) throw notFound();
  const acc = await gatewayAccount(tx, ctx);
  if (!acc) return { error: 'El negocio no ha vinculado su cuenta de pasarela.' };
  const o = (await tx.query(`SELECT id, numero, total, estado, estado_pago FROM "order" WHERE id=$1`, [orderId])).rows[0];
  if (!o) throw notFound();
  if (o.estado !== 'CONFIRMADA') throw new AppError('CONFLICT', 'Solo se cobran ventas confirmadas.');
  if (o.estado_pago === 'PAGADA') return { pagada: true };
  const referencia = `PL-${o.numero}-${token(6)}`;
  // Pasarela simulada: el checkout vive en la pasarela del comercio (cuenta_id), no en la plataforma.
  const url = `${config.publicUrl}/pasarela/checkout?cuenta=${encodeURIComponent(acc.cuenta_id)}&ref=${referencia}&monto=${Number(o.total)}`;
  const id = uuidv7();
  await tx.query(`INSERT INTO payment_link (id, tenant_id, order_id, referencia, url, estado) VALUES ($1,$2,$3,$4,$5,'ABIERTO')`, [id, ctx.tenantId, orderId, referencia, url]);
  await audit(tx, ctx, { accion: 'cobro.enlace', recurso: 'order', recursoId: orderId, resultado: 'EXITO', detalle: { referencia } });
  return { enlace: url, referencia };
}

/** Conciliación desde el webhook de la pasarela del comercio (firma ya verificada). */
export async function reconcilePaymentLink(tx: Tx, ctx: Ctx, referencia: string, aprobado: boolean) {
  const l = (await tx.query(`SELECT id, order_id, estado FROM payment_link WHERE referencia=$1`, [referencia])).rows[0];
  if (!l) throw notFound();
  if (l.estado === 'PAGADO' || !aprobado) return { cambios: false };
  await tx.query(`UPDATE payment_link SET estado='PAGADO' WHERE id=$1`, [l.id]);
  await tx.query(`UPDATE "order" SET estado_pago='PAGADA' WHERE id=$1`, [l.order_id]);
  await audit(tx, ctx, { accion: 'cobro.conciliado', recurso: 'order', recursoId: l.order_id, resultado: 'EXITO', detalle: { referencia } });
  return { cambios: true };
}
