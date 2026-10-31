import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { zonaDe } from '../core/tenant.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { cop, isUuid, token, uuidv7 } from '../lib/util.js';
import { rangoDia, utcToLocal } from '../lib/time.js';
import { config } from '../config.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { generarPdfVenta, LEYENDA_COMPROBANTE, logoDeDataUrl, type DatosComprobanteVenta } from '../documentos/comprobanteVenta.js';
import { addMessage, ventanaAbierta } from './conversations.js';
import { csv } from './exports.js';
import { ETIQUETA_METODO, type MetodoPago } from './pagosVentas.js';
import { MOTIVO_DIAN_PROXIMAMENTE } from './fiscal.js';

/**
 * Comprobantes de venta internos (migración 027).
 *
 * Documento que la empresa le entrega a su cliente y conserva como registro propio de una venta
 * confirmada. NO es una factura electrónica ni tiene validez fiscal: se llama siempre «Comprobante de
 * venta» y el PDF, el correo y el WhatsApp llevan LEYENDA_COMPROBANTE. La factura DIAN está apagada
 * (FACTURACION_DIAN_HABILITADA=0) y la interfaz la presenta como «Próximamente».
 *
 *  - Consecutivo sin huecos por empresa (comprobante_consecutivo, UPDATE … RETURNING en la misma transacción).
 *  - Idempotente por venta: pedirlo dos veces devuelve el mismo comprobante emitido.
 *  - Cliente, líneas, totales y emisor se congelan al emitir.
 *  - Anular no borra: queda motivo, quién y cuándo; se sigue viendo y descargando con la marca «ANULADO».
 *  - Emitir y anular son de una persona (comprobante:issue / comprobante:void, prohibidos a los agentes de IA).
 */

export const REGIMENES = ['RESPONSABLE', 'NO_RESPONSABLE', 'PENDIENTE'] as const;
const PREFIJO_POR_DEFECTO = 'CV';
const ACTOR = (ctx: Ctx) => `${ctx.actor.tipo}:${ctx.actor.nombre}`.slice(0, 160);

export const enlacePublico = (tokenPublico: string) => `${config.apiPublicUrl}/api/publico/comprobantes/${tokenPublico}`;

const num = (v: unknown) => Number(v ?? 0);
function fila(r: any) {
  return {
    id: r.id, order_id: r.order_id, numero: r.numero, estado: r.estado, venta: r.venta ?? null,
    cliente: { nombre: r.cliente_nombre, documento: r.cliente_documento, telefono: r.cliente_telefono, correo: r.cliente_correo },
    subtotal: num(r.subtotal), descuento: num(r.descuento), impuestos: num(r.impuestos), total: num(r.total), moneda: r.moneda,
    regimen_iva: r.regimen_iva, medio_pago: r.medio_pago, notas: r.notas, emitido_por: String(r.emitido_por ?? '').replace(/^[A-Z]+:/, ''),
    emitido_en: r.emitido_en, anulado_en: r.anulado_en, anulado_por: r.anulado_por ? String(r.anulado_por).replace(/^[A-Z]+:/, '') : null,
    motivo_anulacion: r.motivo_anulacion, entregas: r.entregas ?? [],
  };
}

// ---------------------------------------------------------------------------
// Ajustes (prefijo, régimen de IVA, datos del emisor, pie)
// ---------------------------------------------------------------------------
export async function ajustes(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'comprobante:read');
  const a = (await tx.query(`SELECT * FROM comprobante_ajustes`)).rows[0];
  const k = (await tx.query(`SELECT prefijo, siguiente FROM comprobante_consecutivo`)).rows[0];
  const t = (await tx.query(`SELECT nombre, nit, telefono, email_contacto FROM tenant LIMIT 1`)).rows[0];
  return {
    prefijo: k?.prefijo ?? PREFIJO_POR_DEFECTO, siguiente: Number(k?.siguiente ?? 1),
    regimen_iva: a?.regimen_iva ?? 'PENDIENTE',
    nombre_comercial: a?.nombre_comercial ?? null, documento: a?.documento ?? null, direccion: a?.direccion ?? null,
    telefono: a?.telefono ?? null, correo: a?.correo ?? null, pie: a?.pie ?? null, auto_al_vender: !!a?.auto_al_vender,
    // Lo que sale en el PDF si un campo queda vacío.
    sugerido: { nombre_comercial: t?.nombre ?? null, documento: t?.nit ?? null, telefono: t?.telefono ?? null, correo: t?.email_contacto ?? null },
    leyenda: LEYENDA_COMPROBANTE,
    factura_dian: { habilitada: config.fiscal.dianHabilitada, motivo: config.fiscal.dianHabilitada ? null : MOTIVO_DIAN_PROXIMAMENTE },
  };
}

const opcional = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();
const AjustesInput = z.object({
  prefijo: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,6}$/, 'El prefijo lleva de 1 a 6 letras o números, sin espacios (por ejemplo, CV).').optional(),
  regimen_iva: z.enum(REGIMENES).optional(),
  nombre_comercial: opcional(120),
  documento: opcional(40),
  direccion: opcional(160),
  telefono: opcional(40),
  correo: z.union([z.literal(''), z.email('Revisa el correo.')]).transform((s) => s || null).nullable().optional(),
  pie: opcional(600),
  auto_al_vender: z.boolean().optional(),
}).strict();

export async function guardarAjustes(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const p = AjustesInput.safeParse(body ?? {});
  if (!p.success) throw invalid(p.error.issues[0]?.message ?? 'Revisa los datos.');
  const d = p.data;
  if (d.prefijo) {
    await tx.query(`INSERT INTO comprobante_consecutivo (tenant_id, prefijo) VALUES ($1,$2) ON CONFLICT (tenant_id) DO UPDATE SET prefijo=EXCLUDED.prefijo`, [ctx.tenantId, d.prefijo]);
  }
  const campos = (['regimen_iva', 'nombre_comercial', 'documento', 'direccion', 'telefono', 'correo', 'pie', 'auto_al_vender'] as const).filter((k) => d[k] !== undefined);
  if (campos.length) {
    await tx.query(`INSERT INTO comprobante_ajustes (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [ctx.tenantId]);
    await tx.query(`UPDATE comprobante_ajustes SET ${campos.map((k, i) => `${k}=$${i + 2}`).join(', ')}, actualizado_en=now(), actualizado_por=$${campos.length + 2} WHERE tenant_id=$1`,
      [ctx.tenantId, ...campos.map((k) => d[k] ?? null), ACTOR(ctx)]);
  }
  await audit(tx, ctx, { accion: 'comprobante.ajustes', recurso: 'comprobante_ajustes', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { campos: [...(d.prefijo ? ['prefijo'] : []), ...campos] } });
  return ajustes(tx, ctx);
}

// ---------------------------------------------------------------------------
// Emitir
// ---------------------------------------------------------------------------
const EmitirInput = z.object({ notas: opcional(500) }).strict();

/** Siguiente número del consecutivo, en la misma transacción que crea el comprobante (sin huecos). */
async function siguienteNumero(tx: Tx, tenantId: string): Promise<string> {
  await tx.query(`INSERT INTO comprobante_consecutivo (tenant_id, prefijo, siguiente) VALUES ($1,$2,1) ON CONFLICT (tenant_id) DO NOTHING`, [tenantId, PREFIJO_POR_DEFECTO]);
  const r = (await tx.query(`UPDATE comprobante_consecutivo SET siguiente = siguiente + 1 WHERE tenant_id=$1 RETURNING prefijo, siguiente - 1 AS n`, [tenantId])).rows[0];
  return `${r.prefijo}-${String(r.n).padStart(6, '0')}`;
}

export async function emitir(tx: Tx, ctx: Ctx, orderId: string, body: unknown = {}) {
  requirePerm(ctx, 'comprobante:issue');
  requireWritable(ctx);
  const b = EmitirInput.safeParse(body ?? {});
  if (!b.success) throw invalid(b.error.issues[0]?.message ?? 'Revisa los datos.');
  if (!isUuid(orderId)) throw notFound();
  // El bloqueo de la venta serializa dos pedidos simultáneos del comprobante de la misma venta.
  const o = (await tx.query(`SELECT * FROM "order" WHERE id=$1 AND eliminado_en IS NULL FOR UPDATE`, [orderId])).rows[0];
  if (!o) throw notFound();
  const existente = (await tx.query(`SELECT c.*, o.numero AS venta FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id WHERE c.order_id=$1 AND c.estado='EMITIDO'`, [orderId])).rows[0];
  if (existente) return { ...fila(existente), existente: true };
  if (o.estado !== 'CONFIRMADA') throw new AppError('CONFLICT', 'Solo se genera el comprobante de una venta confirmada.');

  const c = (await tx.query(`SELECT nombre, tipo_documento, numero_documento, telefono, email FROM customer WHERE id=$1`, [o.customer_id])).rows[0];
  const items = (await tx.query(`SELECT descripcion, cantidad, precio_unit, iva_pct, total, descuento FROM order_item WHERE order_id=$1 ORDER BY descripcion`, [orderId])).rows;
  const pago = (await tx.query(`SELECT metodo FROM order_payment WHERE order_id=$1 AND estado='REGISTRADO' ORDER BY creado_en LIMIT 1`, [orderId])).rows[0];
  const aj = (await tx.query(`SELECT * FROM comprobante_ajustes`)).rows[0];
  const t = (await tx.query(`SELECT nombre, nit, telefono, email_contacto FROM tenant LIMIT 1`)).rows[0];
  const emisor = {
    nombre_comercial: aj?.nombre_comercial ?? t?.nombre ?? null, documento: aj?.documento ?? null, direccion: aj?.direccion ?? null,
    telefono: aj?.telefono ?? t?.telefono ?? null, correo: aj?.correo ?? t?.email_contacto ?? null, pie: aj?.pie ?? null,
  };
  const lineas = items.map((i: any) => ({
    descripcion: i.descripcion, cantidad: Number(i.cantidad), precio_unitario: Number(i.precio_unit),
    descuento: Number(i.descuento ?? 0), subtotal: Number(i.total), iva_pct: Number(i.iva_pct ?? 0),
  }));
  const id = uuidv7();
  const numero = await siguienteNumero(tx, ctx.tenantId);
  const documento = c?.numero_documento ? `${c.tipo_documento ?? 'Doc.'} ${c.numero_documento}` : null;
  await tx.query(
    `INSERT INTO comprobante_venta (id, tenant_id, order_id, numero, estado, cliente_nombre, cliente_documento, cliente_telefono, cliente_correo, lineas,
       subtotal, descuento, impuestos, total, moneda, regimen_iva, emisor, notas, medio_pago, emitido_por, emitido_por_id, token_publico)
     VALUES ($1,$2,$3,$4,'EMITIDO',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
    [id, ctx.tenantId, orderId, numero, c?.nombre ?? 'Cliente', documento, c?.telefono ?? null, c?.email ?? null, JSON.stringify(lineas),
      Number(o.subtotal), Number(o.descuento ?? 0), Number(o.impuestos), Number(o.total), o.moneda ?? 'COP', aj?.regimen_iva ?? 'PENDIENTE', JSON.stringify(emisor),
      b.data.notas ?? null, pago ? ETIQUETA_METODO[pago.metodo as MetodoPago] ?? pago.metodo : null, ACTOR(ctx), ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null, token(24)],
  );
  await audit(tx, ctx, { accion: 'comprobante.emitir', recurso: 'comprobante_venta', recursoId: id, resultado: 'EXITO', detalle: { numero, order_id: orderId, total: Number(o.total) } });
  return { ...(await ver(tx, ctx, id, { sinPermiso: true })), existente: false };
}

// ---------------------------------------------------------------------------
// Consultar
// ---------------------------------------------------------------------------
export async function ver(tx: Tx, ctx: Ctx, id: string, o: { sinPermiso?: boolean } = {}) {
  if (!o.sinPermiso) requirePerm(ctx, 'comprobante:read');
  if (!isUuid(id)) throw notFound();
  // La RLS limita la consulta a la empresa de la sesión: el id de otra empresa responde «no encontrado».
  const r = (await tx.query(`SELECT c.*, o.numero AS venta FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id WHERE c.id=$1`, [id])).rows[0];
  if (!r) throw notFound();
  return { ...fila(r), lineas: r.lineas, emisor: r.emisor, enlace: enlacePublico(r.token_publico), leyenda: LEYENDA_COMPROBANTE };
}

/** Comprobante vigente (o el último anulado) de una venta, para el detalle de la venta. */
export async function deVenta(tx: Tx, orderId: string) {
  const r = (await tx.query(`SELECT id, numero, estado, emitido_en, anulado_en FROM comprobante_venta WHERE order_id=$1 ORDER BY (estado='EMITIDO') DESC, emitido_en DESC LIMIT 1`, [orderId])).rows[0];
  return r ?? null;
}

const ESTADOS = ['EMITIDO', 'ANULADO'];
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

async function filtrar(tx: Tx, f: { desde?: string; hasta?: string; q?: string; estado?: string; numero?: string }) {
  const params: unknown[] = [];
  const where: string[] = [];
  const zona = await zonaDe(tx);
  if (f.desde && FECHA.test(f.desde)) { params.push(rangoDia(f.desde, zona).desde.toISOString()); where.push(`c.emitido_en >= $${params.length}`); }
  if (f.hasta && FECHA.test(f.hasta)) { params.push(rangoDia(f.hasta, zona).hasta.toISOString()); where.push(`c.emitido_en < $${params.length}`); }
  if (f.estado && ESTADOS.includes(f.estado)) { params.push(f.estado); where.push(`c.estado = $${params.length}`); }
  const numero = String(f.numero ?? '').trim().slice(0, 30);
  if (numero) { params.push(`%${numero}%`); where.push(`c.numero ILIKE $${params.length}`); }
  const q = String(f.q ?? '').trim().slice(0, 80);
  if (q) { params.push(`%${q.replace(/^#/, '')}%`); where.push(`(c.cliente_nombre ILIKE $${params.length} OR c.numero ILIKE $${params.length} OR c.cliente_documento ILIKE $${params.length} OR o.numero::text ILIKE $${params.length})`); }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', params, zona };
}

export async function listar(tx: Tx, ctx: Ctx, f: { desde?: string; hasta?: string; q?: string; estado?: string; numero?: string; pagina?: number; por_pagina?: number } = {}) {
  requirePerm(ctx, 'comprobante:read');
  const { where, params } = await filtrar(tx, f);
  const porPagina = Math.min(Math.max(Number(f.por_pagina) || 50, 10), 200);
  const pagina = Math.max(Number(f.pagina) || 1, 1);
  const base = `FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id ${where}`;
  const total = (await tx.query(`SELECT count(*)::int AS n ${base}`, params)).rows[0].n;
  const rows = (await tx.query(`SELECT c.*, o.numero AS venta ${base} ORDER BY c.emitido_en DESC LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`, params)).rows;
  const resumen = (await tx.query(`SELECT count(*) FILTER (WHERE c.estado='EMITIDO')::int AS emitidos, count(*) FILTER (WHERE c.estado='ANULADO')::int AS anulados,
     coalesce(sum(c.total) FILTER (WHERE c.estado='EMITIDO'), 0) AS total ${base}`, params)).rows[0];
  return {
    comprobantes: rows.map(fila), total, pagina, por_pagina: porPagina,
    resumen: { emitidos: resumen.emitidos, anulados: resumen.anulados, total: num(resumen.total) },
    leyenda: LEYENDA_COMPROBANTE,
    factura_dian: { habilitada: config.fiscal.dianHabilitada, motivo: config.fiscal.dianHabilitada ? null : MOTIVO_DIAN_PROXIMAMENTE },
  };
}

/** Libro de ventas interno (CSV con «;» y BOM, como las demás exportaciones). */
export async function exportar(tx: Tx, ctx: Ctx, f: { desde?: string; hasta?: string; q?: string; estado?: string; numero?: string } = {}) {
  requirePerm(ctx, 'comprobante:read');
  if ((f.desde && !FECHA.test(f.desde)) || (f.hasta && !FECHA.test(f.hasta))) throw invalid('Fechas en formato AAAA-MM-DD.');
  const { where, params, zona } = await filtrar(tx, f);
  const filas = (await tx.query(`SELECT c.*, o.numero AS venta FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id ${where} ORDER BY c.emitido_en`, params)).rows
    .map((r) => {
      const l = utcToLocal(new Date(r.emitido_en), zona);
      const a = r.anulado_en ? utcToLocal(new Date(r.anulado_en), zona) : null;
      return { ...r, emitido_en: `${l.fecha} ${l.hora}`, anulado_en: a ? `${a.fecha} ${a.hora}` : '', estado: r.estado === 'ANULADO' ? 'Anulado' : 'Emitido' };
    });
  await audit(tx, ctx, { accion: 'comprobantes.exportar', resultado: 'EXITO', detalle: { filas: filas.length, desde: f.desde, hasta: f.hasta } });
  return csv([['numero', 'Comprobante'], ['emitido_en', 'Fecha'], ['venta', 'Venta'], ['cliente_nombre', 'Cliente'], ['cliente_documento', 'Documento'],
    ['estado', 'Estado'], ['subtotal', 'Base'], ['impuestos', 'IVA'], ['descuento', 'Descuento'], ['total', 'Total'], ['medio_pago', 'Medio de pago'],
    ['anulado_en', 'Anulado el'], ['motivo_anulacion', 'Motivo de anulación']], filas);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
async function datosPdf(tx: Tx, r: any): Promise<DatosComprobanteVenta> {
  const t = (await tx.query(`SELECT nombre, tema, logo_data_url FROM tenant WHERE id=$1`, [r.tenant_id])).rows[0];
  const e = r.emisor ?? {};
  return {
    numero: r.numero, estado: r.estado, emitidoEn: new Date(r.emitido_en), anuladoEn: r.anulado_en ? new Date(r.anulado_en) : null, motivoAnulacion: r.motivo_anulacion,
    venta: Number(r.venta),
    empresa: { nombre: e.nombre_comercial || t?.nombre || 'Empresa', documento: e.documento, direccion: e.direccion, telefono: e.telefono, correo: e.correo, logo: logoDeDataUrl(t?.logo_data_url), color: t?.tema?.acento ?? null },
    cliente: { nombre: r.cliente_nombre, documento: r.cliente_documento, telefono: r.cliente_telefono, correo: r.cliente_correo },
    lineas: (r.lineas ?? []).map((l: any) => ({ descripcion: String(l.descripcion), cantidad: Number(l.cantidad), precio_unitario: Number(l.precio_unitario), descuento: Number(l.descuento ?? 0), subtotal: Number(l.subtotal) })),
    subtotal: num(r.subtotal), descuento: num(r.descuento), impuestos: num(r.impuestos), total: num(r.total), regimen: r.regimen_iva,
    medioPago: r.medio_pago, notas: r.notas, pie: e.pie ?? null, urlVerificacion: enlacePublico(r.token_publico),
  };
}

export async function pdf(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'comprobante:read');
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`SELECT c.*, o.numero AS venta FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id WHERE c.id=$1`, [id])).rows[0];
  if (!r) throw notFound();
  const archivo = await generarPdfVenta(await datosPdf(tx, r));
  await registrarEntrega(tx, r.id, { canal: 'DESCARGA', destino: null, estado: 'DESCARGADO' });
  return { archivo, nombre: `comprobante-${r.numero}.pdf` };
}

/** Enlace público (QR y botón del correo): la plataforma lo resuelve por token, sin sesión. */
export async function pdfPublico(tx: Tx, tokenPublico: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(tokenPublico)) return null;
  const r = (await tx.query(`SELECT c.*, o.numero AS venta FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id WHERE c.token_publico=$1`, [tokenPublico])).rows[0];
  if (!r) return null;
  return { archivo: await generarPdfVenta(await datosPdf(tx, r)), nombre: `comprobante-${r.numero}.pdf` };
}

async function registrarEntrega(tx: Tx, id: string, e: { canal: 'CORREO' | 'WHATSAPP' | 'DESCARGA'; destino: string | null; estado: string; mensaje_id?: string | null }) {
  await tx.query(`UPDATE comprobante_venta SET entregas = (entregas || $2::jsonb) WHERE id=$1`, [id, JSON.stringify([{ ...e, en: new Date().toISOString() }])]);
}

// ---------------------------------------------------------------------------
// Reenviar (correo o WhatsApp)
// ---------------------------------------------------------------------------
const ReenviarInput = z.object({
  canal: z.enum(['CORREO', 'WHATSAPP']),
  correo: z.email('Revisa el correo.').optional(),
}).strict();

export const MOTIVO_FUERA_DE_VENTANA = 'No se puede enviar por WhatsApp: pasaron más de 24 horas desde el último mensaje del cliente y WhatsApp solo permite escribirle con plantillas aprobadas. Pídele que te escriba (un «hola» basta) y vuelve a intentarlo, o envíalo por correo.';

export async function reenviar(tx: Tx, ctx: Ctx, id: string, body: unknown, o: { soloCliente?: string | null } = {}) {
  requirePerm(ctx, 'comprobante:send');
  requireWritable(ctx);
  const b = ReenviarInput.safeParse(body ?? {});
  if (!b.success) throw invalid(b.error.issues[0]?.message ?? 'Elige cómo enviarlo.');
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`SELECT c.*, o.customer_id, o.conversation_id FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id WHERE c.id=$1`, [id])).rows[0];
  // La IA solo reenvía comprobantes del cliente con el que conversa.
  if (!r || (o.soloCliente !== undefined && r.customer_id !== o.soloCliente)) throw notFound();
  const t = (await tx.query(`SELECT nombre FROM tenant LIMIT 1`)).rows[0];
  const empresa = (r.emisor?.nombre_comercial as string) || t?.nombre || 'La empresa';
  const enlace = enlacePublico(r.token_publico);
  let resultado: Record<string, unknown>;
  if (b.data.canal === 'CORREO') {
    const para = b.data.correo ?? r.cliente_correo;
    if (!para) throw invalid('El cliente no tiene correo registrado. Escribe a qué correo enviarlo.');
    await encolarCorreo(tx, {
      tenantId: ctx.tenantId, para, conversationId: r.conversation_id ?? null,
      correo: plantillas.comprobanteVenta({ cliente: r.cliente_nombre, empresa, numero: r.numero, total: cop(num(r.total)), anulado: r.estado === 'ANULADO', url: enlace, leyenda: LEYENDA_COMPROBANTE }),
    });
    await registrarEntrega(tx, r.id, { canal: 'CORREO', destino: para, estado: 'PENDIENTE' });
    resultado = { canal: 'CORREO', destino: para, estado: 'PENDIENTE' };
  } else {
    const conv = (await tx.query(`SELECT id, ultimo_mensaje_cliente_en FROM conversation WHERE customer_id=$1 AND canal='WHATSAPP' ORDER BY actualizado_en DESC LIMIT 1`, [r.customer_id])).rows[0];
    if (!r.cliente_telefono && !conv) throw invalid('El cliente no tiene teléfono registrado.');
    // Sin plantillas aprobadas, fuera de la ventana de 24 horas no se envía nada (y el panel lo explica).
    if (!conv || !ventanaAbierta(conv.ultimo_mensaje_cliente_en)) throw new AppError('CONFLICT', MOTIVO_FUERA_DE_VENTANA, { motivo: 'FUERA_DE_VENTANA' });
    const m = await addMessage(tx, ctx, {
      conversation_id: conv.id, remitente: ctx.actor.tipo === 'AGENTE' ? 'AI' : 'HUMAN', tipo: 'DOCUMENTO',
      contenido: `Comprobante de venta ${r.numero} de ${empresa} por ${cop(num(r.total))}. ${LEYENDA_COMPROBANTE}`,
      metadatos: { comprobante: r.id, enlace, archivo: `comprobante-${r.numero}.pdf` },
      autor_user_id: ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null,
    });
    await registrarEntrega(tx, r.id, { canal: 'WHATSAPP', destino: r.cliente_telefono ? `···${String(r.cliente_telefono).slice(-4)}` : null, estado: 'PENDIENTE', mensaje_id: m.id });
    resultado = { canal: 'WHATSAPP', estado: 'PENDIENTE', mensaje_id: m.id };
  }
  await audit(tx, ctx, { accion: 'comprobante.reenviar', recurso: 'comprobante_venta', recursoId: r.id, resultado: 'EXITO', detalle: { numero: r.numero, canal: b.data.canal } });
  return { ...resultado, ok: true, numero: r.numero as string, canal: b.data.canal };
}

// ---------------------------------------------------------------------------
// Anular (no borra)
// ---------------------------------------------------------------------------
export async function anular(tx: Tx, ctx: Ctx, id: string, motivo: string) {
  requirePerm(ctx, 'comprobante:void');
  requireWritable(ctx);
  const m = String(motivo ?? '').trim();
  if (m.length < 5) throw invalid('Escribe el motivo de la anulación (al menos 5 caracteres).');
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`SELECT id, numero, estado FROM comprobante_venta WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!r) throw notFound();
  if (r.estado === 'ANULADO') throw new AppError('CONFLICT', 'Este comprobante ya está anulado.');
  await tx.query(`UPDATE comprobante_venta SET estado='ANULADO', anulado_en=now(), anulado_por=$2, motivo_anulacion=$3 WHERE id=$1`, [id, ACTOR(ctx), m.slice(0, 300)]);
  await audit(tx, ctx, { accion: 'comprobante.anular', recurso: 'comprobante_venta', recursoId: id, resultado: 'EXITO', detalle: { numero: r.numero, motivo: m.slice(0, 300) } });
  return ver(tx, ctx, id, { sinPermiso: true });
}

// ---------------------------------------------------------------------------
// Atención por WhatsApp (herramientas de la IA): solo lectura y reenvío al cliente de la conversación
// ---------------------------------------------------------------------------
export async function delCliente(tx: Tx, customerId: string) {
  return (await tx.query(
    `SELECT c.id, c.numero, c.estado, c.total, c.emitido_en, o.numero AS venta FROM comprobante_venta c JOIN "order" o ON o.id=c.order_id
     WHERE o.customer_id=$1 ORDER BY c.emitido_en DESC LIMIT 5`, [customerId])).rows
    .map((r: any) => ({ comprobante_id: r.id, numero: r.numero, estado: r.estado === 'ANULADO' ? 'anulado' : 'vigente', venta: r.venta, total_texto: cop(num(r.total)) }));
}
