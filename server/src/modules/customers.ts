import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { AppError, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';

/** «300 123 4567», «(300) 123-4567» → +573001234567. Otros países deben venir con indicativo. */
export function normalizarTelefono(t: string | null | undefined): string | null {
  if (!t) return null;
  const limpio = t.replace(/[\s().-]/g, '');
  if (/^3\d{9}$/.test(limpio)) return `+57${limpio}`;
  if (/^57\d{10}$/.test(limpio)) return `+${limpio}`;
  return limpio.startsWith('+') ? limpio : `+${limpio}`;
}

export const CustomerInput = z.object({
  nombre: z.string().trim().min(1, 'Escribe el nombre.').max(120),
  telefono: z.string().trim().transform((v) => (v ? normalizarTelefono(v) : null)).pipe(z.string().regex(/^\+\d{7,15}$/, 'Teléfono no válido: usa el indicativo, por ejemplo +573001234567.').nullable()).optional().nullable(),
  email: z.email('Correo no válido.').optional().nullable(),
  tipo_documento: z.enum(['CC', 'NIT', 'CE', 'PP']).optional().nullable(),
  numero_documento: z.string().trim().max(20).optional().nullable(),
  notas: z.string().max(2000).optional().nullable(),
});

const COLS = `id, nombre, telefono, email, tipo_documento, numero_documento, consentimiento_en, consentimiento_via, notas, creado_en`;

export async function listCustomers(tx: Tx, ctx: Ctx, f: { q?: string; pagina?: number; por_pagina?: number } = {}) {
  requirePerm(ctx, 'customer:read');
  const params: unknown[] = [];
  let where = 'eliminado_en IS NULL';
  const q = (f.q ?? '').trim().slice(0, 80);
  if (q) {
    params.push(`%${q}%`);
    const digitos = q.replace(/\D/g, '');
    where += ` AND (nombre ILIKE $1 OR email ILIKE $1 OR numero_documento ILIKE $1 OR telefono ILIKE $1${digitos.length >= 4 ? ` OR telefono LIKE '%${digitos}%'` : ''})`;
  }
  const porPagina = Math.min(Math.max(Number(f.por_pagina) || 50, 10), 500);
  const pagina = Math.max(Number(f.pagina) || 1, 1);
  const total = (await tx.query(`SELECT count(*)::int AS n FROM customer c WHERE ${where}`, params)).rows[0].n;
  const { rows } = await tx.query(
    `SELECT ${COLS},
       (SELECT count(*)::int FROM "order" o WHERE o.customer_id = c.id AND o.estado='CONFIRMADA') AS compras,
       (SELECT coalesce(sum(total),0) FROM "order" o WHERE o.customer_id = c.id AND o.estado='CONFIRMADA') AS total_compras,
       (SELECT max(inicio) FROM appointment a WHERE a.customer_id = c.id AND a.estado <> 'CANCELADA') AS ultima_cita
     FROM customer c WHERE ${where} ORDER BY nombre LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`,
    params,
  );
  return { clientes: rows.map((r) => ({ ...r, total_compras: Number(r.total_compras) })), total, pagina, por_pagina: porPagina };
}

/** Comprobación de duplicados antes de guardar: mismo teléfono (bloquea) o mismo documento (bloquea). */
async function verificarDuplicados(tx: Tx, d: { telefono?: string | null; numero_documento?: string | null; tipo_documento?: string | null }, excluir?: string) {
  if (d.telefono) {
    const r = (await tx.query(`SELECT nombre FROM customer WHERE telefono=$1 AND eliminado_en IS NULL ${excluir ? 'AND id <> $2' : ''}`, excluir ? [d.telefono, excluir] : [d.telefono])).rows[0];
    if (r) throw new AppError('CONFLICT', `Ya existe un cliente con ese teléfono: ${r.nombre}.`, { duplicado: 'telefono' });
  }
  if (d.numero_documento) {
    const r = (await tx.query(
      `SELECT nombre FROM customer WHERE numero_documento=$1 AND coalesce(tipo_documento,'')=coalesce($2,'') AND eliminado_en IS NULL ${excluir ? 'AND id <> $3' : ''}`,
      excluir ? [d.numero_documento, d.tipo_documento ?? null, excluir] : [d.numero_documento, d.tipo_documento ?? null])).rows[0];
    if (r) throw new AppError('CONFLICT', `Ya existe un cliente con ese documento: ${r.nombre}.`, { duplicado: 'documento' });
  }
}

export async function getCustomer(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'customer:read');
  if (!isUuid(id)) throw notFound();
  const c = (await tx.query(`SELECT ${COLS} FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [id])).rows[0];
  if (!c) throw notFound();
  const orders = (await tx.query(
    `SELECT o.id, o.numero, o.total, o.estado, o.origen, o.creado_en, f.estado AS estado_fiscal, f.numero AS documento
     FROM "order" o LEFT JOIN fiscal_document f ON f.order_id = o.id AND f.tipo='FACTURA'
     WHERE o.customer_id=$1 ORDER BY o.creado_en DESC LIMIT 50`, [id])).rows;
  const citas = (await tx.query(
    `SELECT a.id, a.inicio, a.estado, a.origen, p.nombre AS servicio, r.nombre AS recurso
     FROM appointment a JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     WHERE a.customer_id=$1 ORDER BY a.inicio DESC LIMIT 50`, [id])).rows;
  const conversaciones = (await tx.query(
    `SELECT id, canal, estado, actualizado_en FROM conversation WHERE customer_id=$1 ORDER BY actualizado_en DESC LIMIT 20`, [id])).rows;
  return { ...c, orders: orders.map((o) => ({ ...o, total: Number(o.total) })), citas, conversaciones };
}

export async function createCustomer(tx: Tx, ctx: Ctx, input: z.infer<typeof CustomerInput>) {
  requirePerm(ctx, 'customer:write');
  requireWritable(ctx);
  const d = CustomerInput.parse(input);
  await verificarDuplicados(tx, d);
  const id = uuidv7();
  await tx.query(
    `INSERT INTO customer (id, tenant_id, nombre, telefono, email, tipo_documento, numero_documento, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, ctx.tenantId, d.nombre, d.telefono ?? null, d.email ?? null, d.tipo_documento ?? null, d.numero_documento ?? null, d.notas ?? null],
  );
  await audit(tx, ctx, { accion: 'cliente.crear', recurso: 'customer', recursoId: id, resultado: 'EXITO' });
  await publish(tx, ctx, 'cliente_creado', { customer_id: id });
  return { id };
}

export async function updateCustomer(tx: Tx, ctx: Ctx, id: string, input: Partial<z.infer<typeof CustomerInput>>) {
  requirePerm(ctx, 'customer:write');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const d = CustomerInput.partial().parse(input);
  await verificarDuplicados(tx, d, id);
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(d)) {
    params.push(v ?? null);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return { id };
  const r = await tx.query(`UPDATE customer SET ${sets.join(', ')} WHERE id=$1 AND eliminado_en IS NULL RETURNING id`, params);
  if (!r.rows[0]) throw notFound();
  await audit(tx, ctx, { accion: 'cliente.editar', recurso: 'customer', recursoId: id, resultado: 'EXITO', detalle: { campos: Object.keys(d) } });
  return { id };
}

/** Identificación del remitente de un canal. No requiere permiso de usuario: la ejecuta el sistema. */
export async function findOrCreateByPhone(tx: Tx, ctx: Ctx, telefono: string, nombre: string) {
  const found = (await tx.query(`SELECT id, nombre, consentimiento_en FROM customer WHERE telefono=$1 AND eliminado_en IS NULL`, [telefono])).rows[0];
  if (found) return { ...found, nuevo: false };
  const id = uuidv7();
  await tx.query(`INSERT INTO customer (id, tenant_id, nombre, telefono) VALUES ($1,$2,$3,$4)`, [id, ctx.tenantId, nombre || telefono, telefono]);
  await publish(tx, ctx, 'cliente_creado', { customer_id: id, via: 'canal' });
  return { id, nombre: nombre || telefono, consentimiento_en: null, nuevo: true };
}

export async function recordConsent(tx: Tx, ctx: Ctx, customerId: string, via: string) {
  await tx.query(`UPDATE customer SET consentimiento_en = now(), consentimiento_via = $2 WHERE id=$1 AND consentimiento_en IS NULL`, [customerId, via]);
  await audit(tx, ctx, { accion: 'cliente.consentimiento', recurso: 'customer', recursoId: customerId, resultado: 'EXITO', detalle: { via } });
}

/** Exportación de los datos de un titular (consultas y reclamos, PRO-SW-001 §22.1). */
export async function exportCustomer(tx: Tx, ctx: Ctx, id: string) {
  const c = await getCustomer(tx, ctx, id);
  const mensajes = (await tx.query(
    `SELECT m.creado_en, m.remitente, m.contenido FROM message m JOIN conversation v ON v.id=m.conversation_id
     WHERE v.customer_id=$1 AND m.tipo <> 'NOTA_INTERNA' ORDER BY m.creado_en`, [id])).rows;
  await audit(tx, ctx, { accion: 'cliente.exportar', recurso: 'customer', recursoId: id, resultado: 'EXITO' });
  return { ...c, mensajes };
}
