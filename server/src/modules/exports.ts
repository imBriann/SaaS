import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm } from '../core/context.js';
import { audit } from '../core/audit.js';
import { zonaDe } from '../core/tenant.js';
import { invalid } from '../lib/errors.js';
import { rangoDia, utcToLocal } from '../lib/time.js';

/** CSV con separador «;» y BOM: se abre bien en Excel configurado en español. */
export function csv(columnas: [string, string][], filas: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    // Evita inyección de fórmulas al abrir el archivo en una hoja de cálculo.
    const seguro = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
  };
  return '﻿' + [columnas.map(([, t]) => t).join(';'), ...filas.map((f) => columnas.map(([k]) => esc(f[k])).join(';'))].join('\r\n');
}

export async function exportCustomers(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'customer:read');
  const filas = (await tx.query(
    `SELECT nombre, telefono, email, tipo_documento, numero_documento, consentimiento_en, creado_en,
            (SELECT count(*)::int FROM "order" o WHERE o.customer_id=c.id AND o.estado='CONFIRMADA') AS compras
     FROM customer c WHERE eliminado_en IS NULL ORDER BY nombre`)).rows;
  await audit(tx, ctx, { accion: 'clientes.exportar', resultado: 'EXITO', detalle: { filas: filas.length } });
  return csv([['nombre', 'Nombre'], ['telefono', 'Teléfono'], ['email', 'Correo'], ['tipo_documento', 'Tipo de documento'], ['numero_documento', 'Documento'], ['compras', 'Compras'], ['consentimiento_en', 'Autorizó datos'], ['creado_en', 'Creado']], filas);
}

export async function exportOrders(tx: Tx, ctx: Ctx, desde?: string, hasta?: string) {
  requirePerm(ctx, 'order:read');
  const fecha = /^\d{4}-\d{2}-\d{2}$/;
  if ((desde && !fecha.test(desde)) || (hasta && !fecha.test(hasta))) throw invalid('Fechas en formato AAAA-MM-DD.');
  const zona = await zonaDe(tx);
  const params: unknown[] = [];
  const where = ['o.eliminado_en IS NULL'];
  if (desde) { params.push(rangoDia(desde, zona).desde.toISOString()); where.push(`o.creado_en >= $${params.length}`); }
  if (hasta) { params.push(rangoDia(hasta, zona).hasta.toISOString()); where.push(`o.creado_en < $${params.length}`); }
  const filas = (await tx.query(
    `SELECT o.numero, o.creado_en, c.nombre AS cliente, o.estado, o.origen, o.subtotal, o.impuestos, o.descuento, o.total, o.estado_pago,
            f.numero AS factura, f.estado AS estado_fiscal
     FROM "order" o JOIN customer c ON c.id=o.customer_id
     LEFT JOIN LATERAL (SELECT numero, estado FROM fiscal_document fd WHERE fd.order_id=o.id AND fd.tipo='FACTURA' ORDER BY creado_en DESC LIMIT 1) f ON true
     WHERE ${where.join(' AND ')} ORDER BY o.creado_en`, params)).rows
    .map((r) => { const l = utcToLocal(new Date(r.creado_en), zona); return { ...r, creado_en: `${l.fecha} ${l.hora}` }; });
  await audit(tx, ctx, { accion: 'ventas.exportar', resultado: 'EXITO', detalle: { filas: filas.length, desde, hasta } });
  return csv([['numero', 'Venta'], ['creado_en', 'Fecha'], ['cliente', 'Cliente'], ['estado', 'Estado'], ['origen', 'Origen'], ['subtotal', 'Base'], ['impuestos', 'IVA'], ['descuento', 'Descuento'], ['total', 'Total'], ['estado_pago', 'Pago'], ['factura', 'Factura'], ['estado_fiscal', 'Estado fiscal']], filas);
}
