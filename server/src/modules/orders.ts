import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { aPesos, calcularLinea, sumarLineas } from '../lib/money.js';
import { registerMovement } from './catalog.js';
import { createCreditNote } from './fiscal.js';

export const OrderInput = z.object({
  customer_id: z.uuid(),
  items: z.array(z.object({
    product_id: z.uuid(),
    cantidad: z.number().positive('La cantidad debe ser mayor que cero.').max(1000),
    descuento_pct: z.number().min(0).max(100, 'El descuento no puede superar el 100 %.').optional(),
  })).min(1, 'Agrega al menos un producto o servicio.').max(50),
  appointment_id: z.uuid().optional().nullable(),
});

/**
 * Registra una venta confirmada. Los precios del catálogo incluyen IVA
 * (convención habitual del micronegocio); la base y el impuesto se derivan.
 * Los importes los calcula SIEMPRE el servidor, en centavos enteros, a partir del
 * catálogo: el navegador solo envía producto, cantidad y descuento.
 * Política de existencias: una venta que dejaría el inventario en negativo se rechaza.
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
  const lineas = d.items.map((i) => {
    const p: any = byId.get(i.product_id);
    if (p.tipo === 'SERVICIO' && !Number.isInteger(i.cantidad)) throw invalid(`La cantidad de «${p.nombre}» debe ser un número entero.`);
    const c = calcularLinea({ precioUnitario: Number(p.precio), cantidad: i.cantidad, ivaPct: Number(p.iva_pct), descuentoPct: i.descuento_pct ?? 0 });
    return { p, cantidad: i.cantidad, descuentoPct: i.descuento_pct ?? 0, c };
  });
  const tot = sumarLineas(lineas.map((l) => l.c));
  if (tot.total <= 0) throw invalid('El total de la venta debe ser mayor que cero.');
  await tx.query(
    `INSERT INTO "order" (id, tenant_id, numero, customer_id, estado, origen, subtotal, impuestos, total, descuento, conversation_id, appointment_id, creado_por)
     VALUES ($1,$2,$3,$4,'CONFIRMADA',$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, ctx.tenantId, numero, d.customer_id, meta.origen, aPesos(tot.base), aPesos(tot.impuesto), aPesos(tot.total), aPesos(tot.descuento), meta.conversation_id ?? null, d.appointment_id ?? null, `${ctx.actor.tipo}:${ctx.actor.nombre}`],
  );
  for (const l of lineas) {
    await tx.query(
      `INSERT INTO order_item (id, tenant_id, order_id, product_id, descripcion, cantidad, precio_unit, iva_pct, total, descuento_pct, descuento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv7(), ctx.tenantId, id, l.p.id, l.p.nombre, l.cantidad, Number(l.p.precio), Number(l.p.iva_pct), aPesos(l.c.total), l.descuentoPct, aPesos(l.c.descuento)],
    );
    if (l.p.controla_stock) {
      await registerMovement(tx, ctx, { product_id: l.p.id, tipo: 'SALIDA', cantidad: l.cantidad, motivo: `Venta #${numero}`, order_id: id }, { skipPerm: true });
    }
  }
  await publish(tx, ctx, 'venta_registrada', { order_id: id, numero, total: aPesos(tot.total) });
  return { id, numero, total: aPesos(tot.total), descuento: aPesos(tot.descuento), cliente: c.nombre, items: lineas.map((l) => ({ nombre: l.p.nombre, cantidad: l.cantidad, total: aPesos(l.c.total) })) };
}

export async function createOrder(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'order:create');
  requireWritable(ctx);
  const r = await insertOrder(tx, ctx, OrderInput.parse(input), { origen: 'PANEL' });
  await audit(tx, ctx, { accion: 'venta.registrar', recurso: 'order', recursoId: r.id, resultado: 'EXITO', detalle: { numero: r.numero, total: r.total } });
  return r;
}

const ESTADOS_FISCALES = ['PENDIENTE', 'ENVIADO', 'VALIDADO', 'RECHAZADO', 'ENTREGADO', 'SIN_FACTURA'];

export async function listOrders(tx: Tx, ctx: Ctx, filtros: { estado_fiscal?: string; q?: string; pagina?: number; por_pagina?: number; pago?: string } = {}) {
  requirePerm(ctx, 'order:read');
  const where = ['o.eliminado_en IS NULL'];
  const params: unknown[] = [];
  if (filtros.estado_fiscal && ESTADOS_FISCALES.includes(filtros.estado_fiscal)) {
    if (filtros.estado_fiscal === 'SIN_FACTURA') where.push('f.estado IS NULL');
    else if (filtros.estado_fiscal === 'PENDIENTE') where.push(`f.estado IN ('PENDIENTE','ENVIADO')`);
    else if (filtros.estado_fiscal === 'ENTREGADO') where.push(`f.estado IN ('VALIDADO','ENTREGADO')`);
    else { params.push(filtros.estado_fiscal); where.push(`f.estado = $${params.length}`); }
  }
  if (filtros.pago === 'PENDIENTE') where.push(`o.estado='CONFIRMADA' AND o.estado_pago <> 'PAGADA'`);
  if (filtros.pago === 'PAGADA') where.push(`o.estado_pago='PAGADA'`);
  const q = (filtros.q ?? '').trim().slice(0, 80);
  if (q) {
    params.push(`%${q.replace(/^#/, '')}%`);
    where.push(`(c.nombre ILIKE $${params.length} OR o.numero::text ILIKE $${params.length} OR f.numero ILIKE $${params.length})`);
  }
  const porPagina = Math.min(Math.max(Number(filtros.por_pagina) || 50, 10), 200);
  const pagina = Math.max(Number(filtros.pagina) || 1, 1);
  const base = `FROM "order" o JOIN customer c ON c.id=o.customer_id
     LEFT JOIN LATERAL (SELECT estado, numero, proveedor_fiscal FROM fiscal_document fd WHERE fd.order_id=o.id AND fd.tipo='FACTURA' ORDER BY creado_en DESC LIMIT 1) f ON true
     WHERE ${where.join(' AND ')}`;
  const total = (await tx.query(`SELECT count(*)::int AS n ${base}`, params)).rows[0].n;
  const rows = (await tx.query(
    `SELECT o.id, o.numero, o.estado, o.origen, o.total, o.descuento, o.estado_pago, o.creado_en, c.nombre AS cliente,
            f.estado AS estado_fiscal, f.numero AS documento, f.proveedor_fiscal,
            (SELECT string_agg(descripcion, ', ') FROM order_item i WHERE i.order_id=o.id) AS detalle
     ${base} ORDER BY o.creado_en DESC LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`,
    params,
  )).rows;
  return { ventas: rows.map((r) => ({ ...r, total: Number(r.total), descuento: Number(r.descuento) })), total, pagina, por_pagina: porPagina };
}

export async function getOrderDetail(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'order:read');
  if (!isUuid(id)) throw notFound();
  const o = (await tx.query(
    `SELECT o.*, c.nombre AS cliente, c.telefono, c.email, c.tipo_documento, c.numero_documento
     FROM "order" o JOIN customer c ON c.id=o.customer_id WHERE o.id=$1 AND o.eliminado_en IS NULL`, [id])).rows[0];
  if (!o) throw notFound();
  const items = (await tx.query(`SELECT descripcion, cantidad, precio_unit, iva_pct, total, descuento_pct, descuento FROM order_item WHERE order_id=$1`, [id])).rows
    .map((i) => ({ ...i, cantidad: Number(i.cantidad), precio_unit: Number(i.precio_unit), iva_pct: Number(i.iva_pct), total: Number(i.total), descuento_pct: Number(i.descuento_pct), descuento: Number(i.descuento) }));
  const documentos = (await tx.query(
    `SELECT id, tipo, numero, estado, cufe, motivo_rechazo, total, entrega_whatsapp, entrega_email, token_publico, intentos, creado_en, validado_en, proveedor_fiscal
     FROM fiscal_document WHERE order_id=$1 ORDER BY creado_en`, [id])).rows.map((d) => ({ ...d, total: Number(d.total) }));
  const recibos = (await tx.query(
    `SELECT * FROM ai_execution WHERE resultado->>'order_id' = $1 OR (conversation_id IS NOT NULL AND conversation_id = $2 AND herramienta='registrar_venta') ORDER BY creado_en`,
    [id, o.conversation_id],
  )).rows;
  const docIds = documentos.map((d) => d.id);
  const traza = (await tx.query(
    `SELECT id, actor_tipo, actor_nombre, accion, resultado, origen, creado_en, detalle FROM audit_event
     WHERE recurso_id = $1 OR recurso_id = ANY($2::text[]) ORDER BY creado_en`, [id, docIds])).rows;
  const enlaces = (await tx.query(`SELECT id, referencia, url, estado, proveedor, expira_en, ultimo_estado_proveedor, creado_en FROM payment_link WHERE order_id=$1 ORDER BY creado_en DESC`, [id])).rows
    .map((l) => ({ ...l, estado: l.estado === 'ABIERTO' && l.expira_en && new Date(l.expira_en) < new Date() ? 'EXPIRADO' : l.estado }));
  return {
    ...o, subtotal: Number(o.subtotal), impuestos: Number(o.impuestos), total: Number(o.total), descuento: Number(o.descuento),
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
  await tx.query(`UPDATE "order" SET estado='ANULADA', motivo_anulacion=$2 WHERE id=$1`, [id, motivo.trim().slice(0, 300)]);
  await tx.query(`UPDATE payment_link SET estado='EXPIRADO' WHERE order_id=$1 AND estado='ABIERTO'`, [id]);
  const items = (await tx.query(`SELECT i.product_id, i.cantidad, p.controla_stock FROM order_item i JOIN product p ON p.id=i.product_id WHERE i.order_id=$1`, [id])).rows;
  for (const i of items) {
    if (i.controla_stock) await registerMovement(tx, ctx, { product_id: i.product_id, tipo: 'ENTRADA', cantidad: Number(i.cantidad), motivo: `Anulación venta #${o.numero}`, order_id: id }, { skipPerm: true });
  }
  await publish(tx, ctx, 'venta_anulada', { order_id: id });
  await audit(tx, ctx, { accion: 'venta.anular', recurso: 'order', recursoId: id, resultado: 'EXITO', detalle: { motivo, nota_credito: notaCredito } });
  return { id, estado: 'ANULADA', nota_credito: notaCredito };
}
