import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, round2, uuidv7 } from '../lib/util.js';
import { registerMovement } from './catalog.js';
import { createCreditNote } from './fiscal.js';

export const OrderInput = z.object({
  customer_id: z.uuid(),
  items: z.array(z.object({ product_id: z.uuid(), cantidad: z.number().positive().max(1000) })).min(1).max(50),
  appointment_id: z.uuid().optional().nullable(),
});

/**
 * Registra una venta confirmada. Los precios del catálogo incluyen IVA
 * (convención habitual del micronegocio); la base y el impuesto se derivan.
 */
export async function insertOrder(
  tx: Tx,
  ctx: Ctx,
  d: z.infer<typeof OrderInput>,
  meta: { origen: 'AGENTE' | 'PANEL'; conversation_id?: string | null },
) {
  const c = (await tx.query(`SELECT id, nombre FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [d.customer_id])).rows[0];
  if (!c) throw notFound();
  const ids = [...new Set(d.items.map((i) => i.product_id))];
  const prods = (await tx.query(`SELECT id, nombre, tipo, precio, iva_pct, controla_stock, stock FROM product WHERE id = ANY($1::uuid[]) AND eliminado_en IS NULL AND activo`, [ids])).rows;
  if (prods.length !== ids.length) throw notFound();
  const byId = new Map(prods.map((p: any) => [p.id, p]));

  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`order:${ctx.tenantId}`]);
  const numero = Number((await tx.query(`SELECT coalesce(max(numero), 1000) + 1 AS n FROM "order"`)).rows[0].n);
  const id = uuidv7();
  let subtotal = 0, impuestos = 0, total = 0;
  const lineas = d.items.map((i) => {
    const p: any = byId.get(i.product_id);
    const lineTotal = round2(Number(p.precio) * i.cantidad);
    const base = round2(lineTotal / (1 + Number(p.iva_pct) / 100));
    subtotal += base; impuestos += lineTotal - base; total += lineTotal;
    return { p, cantidad: i.cantidad, lineTotal };
  });
  await tx.query(
    `INSERT INTO "order" (id, tenant_id, numero, customer_id, estado, origen, subtotal, impuestos, total, conversation_id, appointment_id, creado_por)
     VALUES ($1,$2,$3,$4,'CONFIRMADA',$5,$6,$7,$8,$9,$10,$11)`,
    [id, ctx.tenantId, numero, d.customer_id, meta.origen, round2(subtotal), round2(impuestos), round2(total), meta.conversation_id ?? null, d.appointment_id ?? null, `${ctx.actor.tipo}:${ctx.actor.nombre}`],
  );
  for (const l of lineas) {
    await tx.query(
      `INSERT INTO order_item (id, tenant_id, order_id, product_id, descripcion, cantidad, precio_unit, iva_pct, total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [uuidv7(), ctx.tenantId, id, l.p.id, l.p.nombre, l.cantidad, Number(l.p.precio), Number(l.p.iva_pct), l.lineTotal],
    );
    if (l.p.controla_stock) {
      await registerMovement(tx, ctx, { product_id: l.p.id, tipo: 'SALIDA', cantidad: l.cantidad, motivo: `Venta #${numero}`, order_id: id }, { skipPerm: true });
    }
  }
  await publish(tx, ctx, 'venta_registrada', { order_id: id, numero, total: round2(total) });
  return { id, numero, total: round2(total), cliente: c.nombre, items: lineas.map((l) => ({ nombre: l.p.nombre, cantidad: l.cantidad, total: l.lineTotal })) };
}

export async function createOrder(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'order:create');
  requireWritable(ctx);
  const r = await insertOrder(tx, ctx, OrderInput.parse(input), { origen: 'PANEL' });
  await audit(tx, ctx, { accion: 'venta.registrar', recurso: 'order', recursoId: r.id, resultado: 'EXITO', detalle: { numero: r.numero, total: r.total } });
  return r;
}

export async function listOrders(tx: Tx, ctx: Ctx, filtros: { estado_fiscal?: string } = {}) {
  requirePerm(ctx, 'order:read');
  const rows = (await tx.query(
    `SELECT o.id, o.numero, o.estado, o.origen, o.total, o.estado_pago, o.creado_en, c.nombre AS cliente,
            f.estado AS estado_fiscal, f.numero AS documento,
            (SELECT string_agg(descripcion, ', ') FROM order_item i WHERE i.order_id=o.id) AS detalle
     FROM "order" o JOIN customer c ON c.id=o.customer_id
     LEFT JOIN LATERAL (SELECT estado, numero FROM fiscal_document fd WHERE fd.order_id=o.id AND fd.tipo='FACTURA' ORDER BY creado_en DESC LIMIT 1) f ON true
     WHERE o.eliminado_en IS NULL ${filtros.estado_fiscal ? 'AND f.estado = $1' : ''}
     ORDER BY o.creado_en DESC LIMIT 300`,
    filtros.estado_fiscal ? [filtros.estado_fiscal] : [],
  )).rows;
  return rows.map((r) => ({ ...r, total: Number(r.total) }));
}

export async function getOrderDetail(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'order:read');
  if (!isUuid(id)) throw notFound();
  const o = (await tx.query(
    `SELECT o.*, c.nombre AS cliente, c.telefono, c.email, c.tipo_documento, c.numero_documento
     FROM "order" o JOIN customer c ON c.id=o.customer_id WHERE o.id=$1 AND o.eliminado_en IS NULL`, [id])).rows[0];
  if (!o) throw notFound();
  const items = (await tx.query(`SELECT descripcion, cantidad, precio_unit, iva_pct, total FROM order_item WHERE order_id=$1`, [id])).rows
    .map((i) => ({ ...i, cantidad: Number(i.cantidad), precio_unit: Number(i.precio_unit), iva_pct: Number(i.iva_pct), total: Number(i.total) }));
  const documentos = (await tx.query(
    `SELECT id, tipo, numero, estado, cufe, motivo_rechazo, total, entrega_whatsapp, entrega_email, token_publico, intentos, creado_en, validado_en
     FROM fiscal_document WHERE order_id=$1 ORDER BY creado_en`, [id])).rows.map((d) => ({ ...d, total: Number(d.total) }));
  const recibos = (await tx.query(
    `SELECT * FROM ai_execution WHERE resultado->>'order_id' = $1 OR (conversation_id IS NOT NULL AND conversation_id = $2 AND herramienta='registrar_venta') ORDER BY creado_en`,
    [id, o.conversation_id],
  )).rows;
  const docIds = documentos.map((d) => d.id);
  const traza = (await tx.query(
    `SELECT id, actor_tipo, actor_nombre, accion, resultado, origen, creado_en, detalle FROM audit_event
     WHERE recurso_id = $1 OR recurso_id = ANY($2::text[]) ORDER BY creado_en`, [id, docIds])).rows;
  const enlaces = (await tx.query(`SELECT id, referencia, url, estado, creado_en FROM payment_link WHERE order_id=$1 ORDER BY creado_en DESC`, [id])).rows;
  return {
    ...o, subtotal: Number(o.subtotal), impuestos: Number(o.impuestos), total: Number(o.total),
    items, documentos, recibos, traza, enlaces,
  };
}

/** Anular una venta. Si ya existe factura validada, se emite nota crédito: nunca se borra un documento. */
export async function voidOrder(tx: Tx, ctx: Ctx, id: string, motivo: string) {
  requirePerm(ctx, 'order:void');
  requireWritable(ctx);
  if (!motivo || motivo.trim().length < 5) throw invalid('Indica el motivo de la anulación.');
  if (!isUuid(id)) throw notFound();
  const o = (await tx.query(`SELECT id, numero, estado FROM "order" WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!o) throw notFound();
  if (o.estado === 'ANULADA') throw new AppError('CONFLICT', 'La venta ya está anulada.');
  const factura = (await tx.query(`SELECT id, estado FROM fiscal_document WHERE order_id=$1 AND tipo='FACTURA' ORDER BY creado_en DESC LIMIT 1`, [id])).rows[0];
  let notaCredito: string | null = null;
  if (factura && ['VALIDADO', 'ENTREGADO'].includes(factura.estado)) {
    requirePerm(ctx, 'invoice:void');
    notaCredito = (await createCreditNote(tx, ctx, factura.id, motivo)).id;
  } else if (factura && ['PENDIENTE', 'ENVIADO', 'RECHAZADO'].includes(factura.estado)) {
    throw new AppError('CONFLICT', 'La factura de esta venta está en trámite. Espera la respuesta de la DIAN antes de anular.');
  }
  await tx.query(`UPDATE "order" SET estado='ANULADA' WHERE id=$1`, [id]);
  const items = (await tx.query(`SELECT i.product_id, i.cantidad, p.controla_stock FROM order_item i JOIN product p ON p.id=i.product_id WHERE i.order_id=$1`, [id])).rows;
  for (const i of items) {
    if (i.controla_stock) await registerMovement(tx, ctx, { product_id: i.product_id, tipo: 'ENTRADA', cantidad: Number(i.cantidad), motivo: `Anulación venta #${o.numero}`, order_id: id }, { skipPerm: true });
  }
  await publish(tx, ctx, 'venta_anulada', { order_id: id });
  await audit(tx, ctx, { accion: 'venta.anular', recurso: 'order', recursoId: id, resultado: 'EXITO', detalle: { motivo, nota_credito: notaCredito } });
  return { id, estado: 'ANULADA', nota_credito: notaCredito };
}
