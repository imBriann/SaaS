import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { notFound, invalid } from '../lib/errors.js';
import { isUuid, normalizeText, uuidv7 } from '../lib/util.js';

export const ProductInput = z.object({
  tipo: z.enum(['PRODUCTO', 'SERVICIO']),
  nombre: z.string().trim().min(1).max(120),
  categoria: z.string().trim().max(60).optional().nullable(),
  precio: z.number().nonnegative().max(999_999_999),
  iva_pct: z.number().min(0).max(19).default(0),
  duracion_min: z.number().int().positive().max(600).optional().nullable(),
  controla_stock: z.boolean().default(false),
  stock: z.number().min(0).default(0),
  stock_minimo: z.number().min(0).default(0),
  sku: z.string().max(40).optional().nullable(),
  activo: z.boolean().default(true),
});
export type ProductData = z.infer<typeof ProductInput>;

const mapP = (r: any) => ({ ...r, precio: Number(r.precio), iva_pct: Number(r.iva_pct), stock: Number(r.stock), stock_minimo: Number(r.stock_minimo) });

export async function listProducts(tx: Tx, ctx: Ctx, opts: { soloActivos?: boolean } = {}) {
  requirePerm(ctx, 'catalog:read');
  const { rows } = await tx.query(
    `SELECT id, tipo, nombre, categoria, precio, moneda, iva_pct, duracion_min, controla_stock, stock, stock_minimo, sku, activo
     FROM product WHERE eliminado_en IS NULL ${opts.soloActivos ? 'AND activo' : ''} ORDER BY categoria NULLS LAST, nombre`,
  );
  return rows.map(mapP);
}

export async function getProduct(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'catalog:read');
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`SELECT * FROM product WHERE id=$1 AND eliminado_en IS NULL`, [id])).rows[0];
  if (!r) throw notFound();
  return mapP(r);
}

/** Búsqueda aproximada por nombre (normalizada, sin tildes). */
export async function findProductsByName(tx: Tx, texto: string) {
  const all = (await tx.query(`SELECT id, tipo, nombre, categoria, precio, iva_pct, duracion_min, controla_stock, stock, stock_minimo FROM product WHERE eliminado_en IS NULL AND activo`)).rows.map(mapP);
  const t = normalizeText(texto);
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  return all
    .map((p) => {
      const n = normalizeText(p.nombre);
      let score = n === t ? 100 : n.includes(t) || t.includes(n) ? 50 : 0;
      for (const w of words) if (n.includes(w)) score += 10;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}

export async function insertProduct(tx: Tx, ctx: Ctx, d: ProductData) {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO product (id, tenant_id, tipo, nombre, categoria, precio, iva_pct, duracion_min, controla_stock, stock, stock_minimo, sku, activo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, ctx.tenantId, d.tipo, d.nombre, d.categoria ?? null, d.precio, d.iva_pct, d.duracion_min ?? null, d.controla_stock, d.stock, d.stock_minimo, d.sku ?? null, d.activo],
  );
  return id;
}

export async function createProduct(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'catalog:write');
  requireWritable(ctx);
  const d = ProductInput.parse(input);
  if (d.tipo === 'SERVICIO' && d.controla_stock) throw invalid('Un servicio no controla existencias.');
  const id = await insertProduct(tx, ctx, d);
  await audit(tx, ctx, { accion: 'catalogo.crear', recurso: 'product', recursoId: id, resultado: 'EXITO', detalle: { nombre: d.nombre, precio: d.precio } });
  return { id };
}

export async function updateProduct(tx: Tx, ctx: Ctx, id: string, input: unknown) {
  requirePerm(ctx, 'catalog:write');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const d = ProductInput.partial().omit({ stock: true }).parse(input);
  const before = (await tx.query(`SELECT precio FROM product WHERE id=$1 AND eliminado_en IS NULL`, [id])).rows[0];
  if (!before) throw notFound();
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(d)) {
    params.push(v ?? null);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length) await tx.query(`UPDATE product SET ${sets.join(', ')} WHERE id=$1`, params);
  await audit(tx, ctx, {
    accion: 'catalogo.editar', recurso: 'product', recursoId: id, resultado: 'EXITO',
    detalle: { campos: Object.keys(d), precio_anterior: Number(before.precio), precio_nuevo: d.precio },
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Inventario
// ---------------------------------------------------------------------------
export async function registerMovement(
  tx: Tx,
  ctx: Ctx,
  input: { product_id: string; tipo: 'ENTRADA' | 'SALIDA' | 'AJUSTE'; cantidad: number; motivo: string; order_id?: string | null },
  opts: { skipPerm?: boolean } = {},
) {
  if (!opts.skipPerm) {
    requirePerm(ctx, 'inventory:write');
    requireWritable(ctx);
  }
  if (!isUuid(input.product_id)) throw notFound();
  const p = (await tx.query(`SELECT id, nombre, controla_stock, stock, stock_minimo FROM product WHERE id=$1 AND eliminado_en IS NULL FOR UPDATE`, [input.product_id])).rows[0];
  if (!p) throw notFound();
  if (!p.controla_stock) throw invalid('Este ítem no controla existencias.');
  if (!(input.cantidad > 0) && input.tipo !== 'AJUSTE') throw invalid('La cantidad debe ser positiva.');
  const actual = Number(p.stock);
  const nuevo = input.tipo === 'ENTRADA' ? actual + input.cantidad : input.tipo === 'SALIDA' ? actual - input.cantidad : input.cantidad;
  if (nuevo < 0) throw invalid(`No hay existencias suficientes de ${p.nombre} (quedan ${actual}).`);
  await tx.query(`UPDATE product SET stock=$2 WHERE id=$1`, [p.id, nuevo]);
  await tx.query(
    `INSERT INTO stock_movement (id, tenant_id, product_id, tipo, cantidad, motivo, order_id, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv7(), ctx.tenantId, p.id, input.tipo, input.tipo === 'AJUSTE' ? nuevo - actual : input.cantidad, input.motivo, input.order_id ?? null, `${ctx.actor.tipo}:${ctx.actor.nombre}`],
  );
  if (nuevo <= Number(p.stock_minimo) && actual > Number(p.stock_minimo)) {
    await publish(tx, ctx, 'stock_bajo_minimo', { product_id: p.id, nombre: p.nombre, stock: nuevo, minimo: Number(p.stock_minimo) });
  }
  if (!opts.skipPerm) {
    await audit(tx, ctx, { accion: 'inventario.movimiento', recurso: 'product', recursoId: p.id, resultado: 'EXITO', detalle: { tipo: input.tipo, cantidad: input.cantidad, stock: nuevo } });
  }
  return { stock: nuevo };
}

export async function lowStock(tx: Tx) {
  return (await tx.query(
    `SELECT id, nombre, stock, stock_minimo FROM product WHERE controla_stock AND eliminado_en IS NULL AND stock <= stock_minimo ORDER BY nombre`,
  )).rows.map(mapP);
}

export async function listMovements(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'inventory:read');
  return (await tx.query(
    `SELECT m.id, m.tipo, m.cantidad, m.motivo, m.actor, m.creado_en, p.nombre AS producto
     FROM stock_movement m JOIN product p ON p.id=m.product_id ORDER BY m.creado_en DESC LIMIT 100`,
  )).rows.map((r) => ({ ...r, cantidad: Number(r.cantidad) }));
}
