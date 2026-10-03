import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { enqueue, publish } from '../core/events.js';
import { addUsage } from '../core/usage.js';
import { AppError, notFound } from '../lib/errors.js';
import { isUuid, token, uuidv7 } from '../lib/util.js';
import { fiscalProvider, type DocumentoFiscalSolicitud } from '../adapters/fiscal.js';

/**
 * Documentos fiscales: entidad con estado propio (PENDIENTE → ENVIADO → VALIDADO →
 * ENTREGADO, con rama RECHAZADO). La emisión es asíncrona y con reintentos: la
 * venta no queda bloqueada esperando al proveedor (PRO-SW-002 fig. 09).
 */

async function nextNumber(tx: Tx, tenantId: string): Promise<string> {
  const r = (await tx.query(
    `UPDATE fiscal_resolution SET siguiente = siguiente + 1 WHERE tenant_id=$1 RETURNING prefijo, siguiente - 1 AS n, numero_hasta`,
    [tenantId],
  )).rows[0];
  if (!r) throw new AppError('CONFLICT', 'La empresa no tiene una resolución de facturación configurada.');
  if (Number(r.n) > Number(r.numero_hasta)) throw new AppError('CONFLICT', 'Se agotó el rango de numeración autorizado por la DIAN.');
  return `${r.prefijo}-${r.n}`;
}

/** Crea la factura de una venta y encola su emisión. Idempotente por venta. */
export async function createInvoiceForOrder(tx: Tx, ctx: Ctx, orderId: string) {
  requirePerm(ctx, 'invoice:issue');
  requireWritable(ctx);
  const o = (await tx.query(`SELECT id, total, estado FROM "order" WHERE id=$1`, [orderId])).rows[0];
  if (!o) throw notFound();
  if (o.estado !== 'CONFIRMADA') throw new AppError('CONFLICT', 'Solo se facturan ventas confirmadas.');
  const existente = (await tx.query(`SELECT id FROM fiscal_document WHERE order_id=$1 AND tipo='FACTURA'`, [orderId])).rows[0];
  if (existente) return { id: existente.id, existente: true };
  const id = uuidv7();
  const numero = await nextNumber(tx, ctx.tenantId);
  await tx.query(
    `INSERT INTO fiscal_document (id, tenant_id, tipo, numero, order_id, estado, total, token_publico) VALUES ($1,$2,'FACTURA',$3,$4,'PENDIENTE',$5,$6)`,
    [id, ctx.tenantId, numero, orderId, Number(o.total), token(18)],
  );
  await enqueue(tx, ctx.tenantId, 'emitir_documento', { fiscal_document_id: id }, { claveUnica: `emitir:${id}:0` });
  await audit(tx, ctx, { accion: 'factura.solicitar', recurso: 'fiscal_document', recursoId: id, resultado: 'EXITO', detalle: { numero, order_id: orderId } });
  return { id, numero, existente: false };
}

/** Nota crédito sobre una factura validada: acción CRÍTICA, nunca disponible para agentes. */
export async function createCreditNote(tx: Tx, ctx: Ctx, facturaId: string, motivo: string) {
  requirePerm(ctx, 'invoice:void');
  requireWritable(ctx);
  if (!isUuid(facturaId)) throw notFound();
  const f = (await tx.query(`SELECT id, order_id, estado, total FROM fiscal_document WHERE id=$1 AND tipo='FACTURA'`, [facturaId])).rows[0];
  if (!f) throw notFound();
  if (!['VALIDADO', 'ENTREGADO'].includes(f.estado)) throw new AppError('CONFLICT', 'Solo se emite nota crédito sobre una factura validada.');
  const ya = (await tx.query(`SELECT id FROM fiscal_document WHERE documento_ref_id=$1 AND tipo='NOTA_CREDITO'`, [facturaId])).rows[0];
  if (ya) throw new AppError('CONFLICT', 'Esta factura ya tiene una nota crédito.');
  const id = uuidv7();
  const numero = await nextNumber(tx, ctx.tenantId);
  await tx.query(
    `INSERT INTO fiscal_document (id, tenant_id, tipo, numero, order_id, documento_ref_id, estado, total, token_publico, motivo_rechazo)
     VALUES ($1,$2,'NOTA_CREDITO',$3,$4,$5,'PENDIENTE',$6,$7,NULL)`,
    [id, ctx.tenantId, numero, f.order_id, facturaId, Number(f.total), token(18)],
  );
  await enqueue(tx, ctx.tenantId, 'emitir_documento', { fiscal_document_id: id, motivo }, { claveUnica: `emitir:${id}:0` });
  await audit(tx, ctx, { accion: 'nota_credito.solicitar', recurso: 'fiscal_document', recursoId: id, resultado: 'EXITO', detalle: { factura: facturaId, motivo } });
  return { id, numero };
}

/** Reintento manual tras corregir los datos que causaron el rechazo. */
export async function retryDocument(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'invoice:issue');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const d = (await tx.query(`SELECT id, estado, intentos FROM fiscal_document WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!d) throw notFound();
  if (d.estado !== 'RECHAZADO') throw new AppError('CONFLICT', 'Solo se reintenta un documento rechazado.');
  await tx.query(`UPDATE fiscal_document SET estado='PENDIENTE', motivo_rechazo=NULL WHERE id=$1`, [id]);
  await enqueue(tx, ctx.tenantId, 'emitir_documento', { fiscal_document_id: id }, { claveUnica: `emitir:${id}:${d.intentos}` });
  await audit(tx, ctx, { accion: 'factura.reintentar', recurso: 'fiscal_document', recursoId: id, resultado: 'EXITO' });
  return { id, estado: 'PENDIENTE' };
}

/**
 * Emisión ante el proveedor (la ejecuta el trabajador). Los datos fiscales del
 * emisor salen SIEMPRE del contexto del tenant, nunca de argumentos (amenaza T7).
 */
export async function emitDocument(tx: Tx, ctx: Ctx, id: string, motivo?: string): Promise<'VALIDADO' | 'RECHAZADO' | 'REINTENTAR'> {
  const d = (await tx.query(`SELECT * FROM fiscal_document WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!d || !['PENDIENTE', 'ENVIADO'].includes(d.estado)) return 'VALIDADO';
  const t = (await tx.query(`SELECT nit, nombre, ciudad FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0];
  const o = (await tx.query(
    `SELECT o.*, c.nombre, c.tipo_documento, c.numero_documento, c.email FROM "order" o JOIN customer c ON c.id=o.customer_id WHERE o.id=$1`,
    [d.order_id],
  )).rows[0];
  const items = (await tx.query(`SELECT descripcion, cantidad, precio_unit, iva_pct, total FROM order_item WHERE order_id=$1`, [d.order_id])).rows;
  let ref: DocumentoFiscalSolicitud['documentoReferencia'];
  if (d.tipo === 'NOTA_CREDITO') {
    const f = (await tx.query(`SELECT numero, cufe FROM fiscal_document WHERE id=$1`, [d.documento_ref_id])).rows[0];
    ref = { numero: f.numero, cufe: f.cufe, motivo: motivo ?? 'Anulación de la venta' };
  }
  const solicitud: DocumentoFiscalSolicitud = {
    tipo: d.tipo, numero: d.numero, fecha: new Date().toISOString(),
    emisor: { nit: t.nit ?? '', razonSocial: t.nombre, ciudad: t.ciudad },
    adquirente: { nombre: o.nombre, tipoDocumento: o.tipo_documento, numeroDocumento: o.numero_documento, email: o.email },
    items: items.map((i: any) => ({ descripcion: i.descripcion, cantidad: Number(i.cantidad), precioUnitario: Number(i.precio_unit), ivaPct: Number(i.iva_pct), total: Number(i.total) })),
    subtotal: Number(o.subtotal), impuestos: Number(o.impuestos), total: Number(o.total), moneda: o.moneda,
    documentoReferencia: ref,
  };
  await tx.query(`UPDATE fiscal_document SET estado='ENVIADO', intentos = intentos + 1 WHERE id=$1`, [id]);
  const resp = await fiscalProvider().emitir(solicitud);
  await tx.query(
    `INSERT INTO provider_transaction (id, tenant_id, fiscal_document_id, operacion, solicitud, respuesta, exito) VALUES ($1,$2,$3,'emitir',$4,$5,$6)`,
    [uuidv7(), ctx.tenantId, id, JSON.stringify(solicitud), JSON.stringify(resp), resp.ok],
  );
  if (resp.ok) {
    await tx.query(`UPDATE fiscal_document SET estado='VALIDADO', cufe=$2, validado_en=now(), motivo_rechazo=NULL WHERE id=$1`, [id, resp.cufe]);
    await addUsage(tx, ctx.tenantId, 'documentos', 1);
    await audit(tx, ctx, { accion: `${d.tipo === 'FACTURA' ? 'factura' : 'nota_credito'}.validada`, recurso: 'fiscal_document', recursoId: id, resultado: 'EXITO', detalle: { numero: d.numero, cufe: resp.cufe } });
    await publish(tx, ctx, 'documento_emitido', { fiscal_document_id: id, numero: d.numero });
    await enqueue(tx, ctx.tenantId, 'entregar_documento', { fiscal_document_id: id }, { claveUnica: `entregar:${id}` });
    return 'VALIDADO';
  }
  if (resp.reintentable) {
    await tx.query(`UPDATE fiscal_document SET estado='PENDIENTE', motivo_rechazo=$2 WHERE id=$1`, [id, resp.mensaje]);
    return 'REINTENTAR';
  }
  await tx.query(`UPDATE fiscal_document SET estado='RECHAZADO', motivo_rechazo=$2 WHERE id=$1`, [id, `${resp.codigo}: ${resp.mensaje}`]);
  await audit(tx, ctx, { accion: 'factura.rechazada', recurso: 'fiscal_document', recursoId: id, resultado: 'ERROR', detalle: { codigo: resp.codigo, mensaje: resp.mensaje } });
  await publish(tx, ctx, 'documento_rechazado', { fiscal_document_id: id, numero: d.numero, motivo: resp.mensaje });
  return 'RECHAZADO';
}

export async function listDocuments(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'invoice:read');
  const rows = (await tx.query(
    `SELECT f.id, f.tipo, f.numero, f.estado, f.cufe, f.motivo_rechazo, f.total, f.entrega_whatsapp, f.entrega_email,
            f.creado_en, f.validado_en, f.token_publico, o.id AS order_id, o.numero AS orden, c.nombre AS cliente
     FROM fiscal_document f JOIN "order" o ON o.id=f.order_id JOIN customer c ON c.id=o.customer_id
     ORDER BY f.creado_en DESC LIMIT 300`,
  )).rows.map((r) => ({ ...r, total: Number(r.total) }));
  const resumen = (await tx.query(`SELECT estado, count(*)::int AS n FROM fiscal_document GROUP BY estado`)).rows;
  const resolucion = (await tx.query(`SELECT prefijo, numero_desde, numero_hasta, siguiente, resolucion FROM fiscal_resolution`)).rows[0] ?? null;
  return { documentos: rows, resumen, resolucion };
}

/** Vista pública de un documento por token (enlace enviado por WhatsApp y correo). */
export async function publicDocumentData(tx: Tx, tokenPublico: string) {
  const d = (await tx.query(`SELECT * FROM fiscal_document WHERE token_publico=$1`, [tokenPublico])).rows[0];
  if (!d) return null;
  const t = (await tx.query(`SELECT nombre, nit, ciudad, tema FROM tenant WHERE id=$1`, [d.tenant_id])).rows[0];
  const o = (await tx.query(
    `SELECT o.numero, o.subtotal, o.impuestos, o.total, o.creado_en, c.nombre, c.tipo_documento, c.numero_documento
     FROM "order" o JOIN customer c ON c.id=o.customer_id WHERE o.id=$1`, [d.order_id])).rows[0];
  const items = (await tx.query(`SELECT descripcion, cantidad, precio_unit, total FROM order_item WHERE order_id=$1`, [d.order_id])).rows;
  return { d, t, o, items };
}
