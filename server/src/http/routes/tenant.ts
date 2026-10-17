import * as commissions from '../../modules/commissions.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Tx } from '../../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../../core/context.js';
import { audit, auditPlatform } from '../../core/audit.js';
import { enqueue } from '../../core/events.js';
import { zonaDe } from '../../core/tenant.js';
import { AppError, invalid, notFound } from '../../lib/errors.js';
import { isUuid, token } from '../../lib/util.js';
import { todayLocal } from '../../lib/time.js';
import { config } from '../../config.js';
import { tenantGuard } from '../context.js';
import * as customers from '../../modules/customers.js';
import * as catalog from '../../modules/catalog.js';
import * as agenda from '../../modules/agenda.js';
import * as orders from '../../modules/orders.js';
import * as fiscal from '../../modules/fiscal.js';
import * as conv from '../../modules/conversations.js';
import * as payments from '../../modules/payments.js';
import * as admin from '../../modules/admin.js';
import * as team from '../../modules/team.js';
import * as soporte from '../../modules/soporte.js';
import * as exportsMod from '../../modules/exports.js';
import { iniciarPagoSuscripcion } from '../../modules/billing.js';
import { documentosTenant, enlaceDocumentosTenant } from '../../documentos/servicio.js';
import { verificarWhatsapp } from '../../modules/channelStatus.js';
import { askAssistant, suggestReply } from '../../ai/runtime.js';
import { signMeta, whatsapp } from '../../adapters/channel.js';
import { applyMapping, inferMapping, readSheet } from '../../onboarding/importer.js';

// params, query y body se validan en cada servicio (zod o comprobaciones explícitas).
type Req = FastifyRequest & { params: any; query: any; body: any };
type H = (tx: Tx, ctx: Ctx, req: Req, reply: FastifyReply) => Promise<unknown>;

export async function registerTenantRoutes(app: FastifyInstance, db: Database) {
  const guard = tenantGuard(db);
  const T = (h: H) => async (req: FastifyRequest, reply: FastifyReply) => db.withTenant(req.ctx!.tenantId, (tx) => h(tx, req.ctx!, req as Req, reply));
  const r = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, h: H) =>
    app.route({ method: method.toUpperCase() as any, url: `/api/t${path}`, preHandler: guard, handler: T(h) });
  /** Variante sin transacción envolvente (operaciones que llaman a terceros o mezclan plataforma). */
  const rx = (method: 'get' | 'post' | 'patch', path: string, h: (ctx: Ctx, req: Req, reply: FastifyReply) => Promise<unknown>) =>
    app.route({ method: method.toUpperCase() as any, url: `/api/t${path}`, preHandler: guard, handler: (req, reply) => h(req.ctx!, req as Req, reply) });
  const descarga = (reply: FastifyReply, nombre: string, tipo = 'text/csv; charset=utf-8') => reply.header('content-type', tipo).header('content-disposition', `attachment; filename="${nombre}"`);

  // --- Sesión y panel
  r('get', '/yo', (tx, ctx) => admin.me(tx, ctx));
  r('get', '/inicio', (tx, ctx) => admin.dashboard(tx, ctx));

  // --- Clientes
  r('get', '/clientes', (tx, ctx, req) => customers.listCustomers(tx, ctx, { q: req.query?.q, pagina: req.query?.pagina, por_pagina: req.query?.por_pagina }));
  r('get', '/clientes.csv', async (tx, ctx, _req, reply) => { descarga(reply, 'clientes.csv'); return exportsMod.exportCustomers(tx, ctx); });
  r('post', '/clientes', (tx, ctx, req) => customers.createCustomer(tx, ctx, req.body));
  r('get', '/clientes/:id', (tx, ctx, req) => customers.getCustomer(tx, ctx, req.params.id));
  r('patch', '/clientes/:id', (tx, ctx, req) => customers.updateCustomer(tx, ctx, req.params.id, req.body));
  r('get', '/clientes/:id/exportar', async (tx, ctx, req, reply) => {
    const data = await customers.exportCustomer(tx, ctx, req.params.id);
    reply.header('content-disposition', `attachment; filename="titular-${req.params.id}.json"`);
    return data;
  });
  r('post', '/clientes/:id/consentimiento', async (tx, ctx, req) => {
    requirePerm(ctx, 'customer:write');
    requireWritable(ctx);
    if (!isUuid(req.params.id)) throw notFound();
    const c = (await tx.query(`SELECT id FROM customer WHERE id=$1`, [req.params.id])).rows[0];
    if (!c) throw notFound();
    await customers.recordConsent(tx, ctx, c.id, 'PANEL');
    return { ok: true };
  });

  // --- Catálogo e inventario
  r('get', '/productos', (tx, ctx) => catalog.listProducts(tx, ctx));
  r('post', '/productos', (tx, ctx, req) => catalog.createProduct(tx, ctx, req.body));
  r('patch', '/productos/:id', (tx, ctx, req) => catalog.updateProduct(tx, ctx, req.params.id, req.body));
  rx('post', '/productos/importar/archivo', async (ctx, req) => {
    await db.withTenant(ctx.tenantId, async () => { requirePerm(ctx, 'catalog:write'); requireWritable(ctx); });
    const f = await req.file();
    if (!f) throw invalid('Adjunta un archivo .xlsx o .csv.');
    const hoja = await readSheet(await f.toBuffer(), f.filename, req.query?.hoja);
    const { mapeo } = await inferMapping(hoja);
    let filas: ReturnType<typeof applyMapping> = [];
    let error: string | null = null;
    try { filas = applyMapping(hoja, mapeo, 'SERVICIO'); } catch (e) { error = (e as Error).message; }
    const existentes = await db.withTenant(ctx.tenantId, (tx) => catalog.marcarDuplicados(tx, ctx, filas.map((x) => x.nombre)));
    return { archivo: f.filename, hoja: hoja.hoja, hojas: hoja.hojas, fila_encabezado: hoja.filaEncabezado, encabezados: hoja.encabezados, mapeo, error, total: hoja.filas.length, filas: filas.map((x, i) => ({ ...x, existente: existentes[i] })), datos: { encabezados: hoja.encabezados, filas: hoja.filas.slice(0, 2000), numeros: hoja.numeros, filaEncabezado: hoja.filaEncabezado, hoja: hoja.hoja } };
  });
  rx('post', '/productos/importar/vista-previa', async (ctx, req) => {
    const b = z.object({ datos: z.object({ encabezados: z.array(z.string()), filas: z.array(z.array(z.string())).max(2000), numeros: z.array(z.number()), filaEncabezado: z.number(), hoja: z.string() }), mapeo: z.array(z.object({ columna: z.string(), campo: z.string(), confianza: z.number().optional() })) }).parse(req.body);
    const filas = applyMapping(b.datos, b.mapeo.map((m) => ({ ...m, confianza: m.confianza ?? 1 })) as any, 'SERVICIO');
    const existentes = await db.withTenant(ctx.tenantId, (tx) => catalog.marcarDuplicados(tx, ctx, filas.map((x) => x.nombre)));
    return { filas: filas.map((x, i) => ({ ...x, existente: existentes[i] })) };
  });
  r('post', '/productos/importar/confirmar', (tx, ctx, req) => catalog.confirmImport(tx, ctx, req.body));
  r('get', '/inventario/movimientos', (tx, ctx) => catalog.listMovements(tx, ctx));
  r('post', '/inventario/movimientos', (tx, ctx, req) => catalog.registerMovement(tx, ctx, z.object({
    product_id: z.string(), tipo: z.enum(['ENTRADA', 'SALIDA', 'AJUSTE']), cantidad: z.number().min(0, 'La cantidad no puede ser negativa.').max(1_000_000), motivo: z.string().trim().min(3, 'Escribe el motivo.').max(200),
  }).parse(req.body)));

  // --- Agenda
  r('get', '/agenda', async (tx, ctx, req) => agenda.listDay(tx, ctx, /^\d{4}-\d{2}-\d{2}$/.test(req.query?.fecha ?? '') ? req.query.fecha : todayLocal(await zonaDe(tx))));
  r('get', '/agenda/recursos', (tx, ctx) => agenda.listResources(tx, ctx));
  r('post', '/agenda/recursos', (tx, ctx, req) => agenda.createResource(tx, ctx, req.body));
  r('patch', '/agenda/recursos/:id', (tx, ctx, req) => agenda.updateResource(tx, ctx, req.params.id, req.body));
  r('get', '/agenda/disponibilidad', async (tx, ctx, req) => {
    requirePerm(ctx, 'appointment:read');
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query?.fecha ?? '') ? req.query.fecha : todayLocal(await zonaDe(tx));
    const franjas = await agenda.availability(tx, String(req.query?.servicio_id), fecha, req.query?.recurso_id || null, 80, null, isUuid(req.query?.excluir) ? req.query.excluir : null);
    // Sin espacio ese día: se ofrecen los próximos días con espacio.
    const alternativas = franjas.length ? [] : await agenda.alternatives(tx, String(req.query?.servicio_id), new Date(`${fecha}T12:00:00Z`), req.query?.recurso_id || null, 6, isUuid(req.query?.excluir) ? req.query.excluir : null);
    return { fecha, franjas, alternativas };
  });
  r('post', '/agenda/citas', (tx, ctx, req) => agenda.createAppointment(tx, ctx, req.body));
  r('patch', '/agenda/citas/:id', (tx, ctx, req) => agenda.updateAppointmentState(tx, ctx, req.params.id, String(req.body?.estado)));
  r('post', '/agenda/citas/:id/reprogramar', (tx, ctx, req) => agenda.rescheduleAppointment(tx, ctx, req.params.id, req.body));

  r('get','/equipo/responsables',(tx,ctx)=>commissions.eligible(tx,ctx));
  r('get','/equipo/comisiones',(tx,ctx)=>commissions.settings(tx,ctx));
  r('patch','/equipo/comisiones',(tx,ctx,req)=>commissions.save(tx,ctx,req.body));
  r('get','/equipo/comisiones/informe',(tx,ctx,req)=>commissions.report(tx,ctx,req.query.fecha));
  // --- Ventas
  r('get', '/ventas', (tx, ctx, req) => orders.listOrders(tx, ctx, { estado_fiscal: req.query?.estado_fiscal, q: req.query?.q, pagina: req.query?.pagina, por_pagina: req.query?.por_pagina, pago: req.query?.pago }));
  r('get', '/ventas.csv', async (tx, ctx, req, reply) => { descarga(reply, 'ventas.csv'); return exportsMod.exportOrders(tx, ctx, req.query?.desde, req.query?.hasta); });
  r('post', '/ventas', (tx, ctx, req) => orders.createOrder(tx, ctx, req.body));
  r('get', '/ventas/:id', (tx, ctx, req) => orders.getOrderDetail(tx, ctx, req.params.id));
  r('post', '/ventas/:id/anular', (tx, ctx, req) => orders.voidOrder(tx, ctx, req.params.id, String(req.body?.motivo ?? '')));
  r('post', '/ventas/:id/enlace-pago', (tx, ctx, req) => payments.createPaymentLink(tx, ctx, req.params.id));
  r('post', '/ventas/:id/facturar', (tx, ctx, req) => fiscal.createInvoiceForOrder(tx, ctx, req.params.id));

  // --- Facturación
  r('get', '/facturacion', (tx, ctx) => fiscal.listDocuments(tx, ctx));
  r('post', '/facturacion/:id/reintentar', (tx, ctx, req) => fiscal.retryDocument(tx, ctx, req.params.id));
  r('post', '/facturacion/:id/nota-credito', (tx, ctx, req) => fiscal.createCreditNote(tx, ctx, req.params.id, String(req.body?.motivo ?? '')));

  // --- Conversaciones y radicados
  r('get', '/conversaciones', (tx, ctx, req) => conv.listInbox(tx, ctx, req.query?.filtro, req.query?.q));
  r('get', '/conversaciones/:id', (tx, ctx, req) => conv.conversationDetail(tx, ctx, req.params.id));
  r('post', '/conversaciones/:id/responder', (tx, ctx, req) => conv.humanReply(tx, ctx, req.params.id, String(req.body?.texto ?? ''), false));
  r('post', '/conversaciones/:id/nota', (tx, ctx, req) => conv.humanReply(tx, ctx, req.params.id, String(req.body?.texto ?? ''), true));
  r('post', '/conversaciones/:id/plantilla', (tx, ctx, req) => conv.sendTemplateFromPanel(tx, ctx, req.params.id, String(req.body?.clave ?? ''), req.body?.variables ?? {}));
  r('post', '/conversaciones/:id/escalar', async (tx, ctx, req) => {
    requireWritable(ctx);
    if (!isUuid(req.params.id)) throw notFound();
    return conv.escalate(tx, ctx, req.params.id, String(req.body?.motivo ?? 'Escalado manualmente').slice(0, 300), req.body?.prioridad ?? 'MEDIA');
  });
  r('post', '/conversaciones/:id/cerrar', (tx, ctx, req) => conv.closeCase(tx, ctx, req.params.id, String(req.body?.motivo ?? '')));
  r('post', '/conversaciones/:id/devolver-ia', (tx, ctx, req) => conv.returnToAi(tx, ctx, req.params.id));
  rx('get', '/conversaciones/:id/archivos/:mensaje', async (ctx, req, reply) => {
    // El archivo solo se entrega si el mensaje pertenece a una conversación visible para quien lo pide.
    const m = await db.withTenant(ctx.tenantId, async (tx) => {
      requirePerm(ctx, 'conversation:read');
      await conv.conversationDetail(tx, ctx, req.params.id);
      if (!isUuid(req.params.mensaje)) throw notFound();
      return (await tx.query(`SELECT metadatos FROM message WHERE id=$1 AND conversation_id=$2 AND tipo='MEDIA'`, [req.params.mensaje, req.params.id])).rows[0];
    });
    const media = m?.metadatos?.media;
    if (!media?.id) throw notFound();
    const d = await whatsapp.downloadMedia(String(media.id));
    if (!d.ok || !d.data) throw new AppError('CONFLICT', d.error ?? 'No se pudo descargar el archivo.');
    const nombre = String(media.nombreArchivo ?? `archivo-${String(req.params.mensaje).slice(-6)}`).replace(/[^\w.\- ]/g, '_');
    reply.header('content-type', d.mime ?? 'application/octet-stream').header('content-disposition', `attachment; filename="${nombre}"`).header('x-content-type-options', 'nosniff');
    return reply.send(d.data);
  });
  r('post', '/casos/:id/tomar', (tx, ctx, req) => conv.takeCase(tx, ctx, req.params.id));
  r('post', '/casos/:id/reasignar', (tx, ctx, req) => conv.reassignCase(tx, ctx, req.params.id, String(req.body?.user_id)));
  r('post', '/casos/:id/prioridad', (tx, ctx, req) => conv.changePriority(tx, ctx, req.params.id, String(req.body?.prioridad)));
  r('post', '/casos/:id/reabrir', (tx, ctx, req) => conv.reopenCase(tx, ctx, req.params.id, String(req.body?.motivo ?? '')));
  r('get', '/asesores', async (tx, ctx) => {
    requirePerm(ctx, 'case:supervise');
    return (await tx.query(
      `SELECT u.id, u.nombre, ut.disponible, (SELECT count(*)::int FROM support_case k WHERE k.asignado_a=u.id AND k.estado <> 'CERRADO') AS carga
       FROM user_tenant ut JOIN users u ON u.id=ut.user_id WHERE ut.activo AND EXISTS (SELECT 1 FROM role_permission rp WHERE rp.role_id=ut.role_id AND rp.permiso='case:manage') ORDER BY u.nombre`)).rows;
  });
  r('post', '/yo/disponibilidad', (tx, ctx, req) => admin.setMyAvailability(tx, ctx, !!req.body?.disponible));
  rx('post', '/conversaciones/:id/sugerencia', async (ctx, req) => {
    requirePerm(ctx, 'ai:assist');
    if (!isUuid(req.params.id)) throw notFound();
    return { sugerencia: await suggestReply(db, ctx, req.params.id) };
  });

  // --- Centro de IA y asistente
  r('get', '/ia', (tx, ctx) => admin.aiCenter(tx, ctx));
  r('get', '/ia/ejecuciones', (tx, ctx, req) => admin.aiExecutions(tx, ctx, { decision: req.query?.decision, herramienta: req.query?.herramienta }));
  r('patch', '/ia/herramientas/:nombre', (tx, ctx, req) => admin.toggleTool(tx, ctx, req.params.nombre, !!req.body?.habilitada));
  r('patch', '/ia/agentes/:configuracion', (tx, ctx, req) => admin.toggleAgent(tx, ctx, req.params.configuracion, !!req.body?.activo));
  rx('post', '/asistente', async (ctx, req) => {
    requirePerm(ctx, 'ai:assist');
    const pregunta = String(req.body?.pregunta ?? '').trim().slice(0, 1000);
    if (!pregunta) throw invalid('Escribe una pregunta.');
    const historial = Array.isArray(req.body?.historial) ? req.body.historial.filter((h: any) => ['user', 'assistant'].includes(h?.role) && typeof h?.text === 'string').slice(-8).map((h: any) => ({ role: h.role, text: String(h.text).slice(0, 2000) })) : [];
    return askAssistant(db, ctx, pregunta, historial);
  });

  // --- Configuración
  r('get', '/configuracion', (tx, ctx) => admin.settings(tx, ctx));
  r('patch', '/configuracion/modulos/:modulo', (tx, ctx, req) => admin.toggleModule(tx, ctx, req.params.modulo, !!req.body?.activo));
  r('patch', '/configuracion/personas/:id', (tx, ctx, req) => admin.updateMember(tx, ctx, req.params.id, req.body));
  r('get', '/configuracion/invitaciones', (tx, ctx) => team.listInvitations(tx, ctx));
  r('post', '/configuracion/invitaciones', (tx, ctx, req) => team.invite(tx, ctx, req.body));
  r('post', '/configuracion/invitaciones/:id/revocar', (tx, ctx, req) => team.revokeInvitation(tx, ctx, req.params.id));
  r('post', '/configuracion/invitaciones/:id/reenviar', (tx, ctx, req) => team.resendInvitation(tx, ctx, req.params.id));
  r('patch', '/configuracion/plantillas/:clave', (tx, ctx, req) => admin.updateTemplate(tx, ctx, req.params.clave, req.body));
  rx('patch', '/configuracion/empresa', async (ctx, req) => {
    const { d } = await db.withTenant(ctx.tenantId, (tx) => admin.updateTenantInfo(tx, ctx, req.body));
    const campos = Object.keys(d);
    if (!campos.length) return { ok: true };
    // El registro de tenants es de plataforma: el rol de ejecución no lo puede escribir.
    await db.withPlatform(async (tx) => {
      const sets: string[] = [];
      const params: unknown[] = [ctx.tenantId];
      for (const [k, v] of Object.entries(d)) { params.push(v ?? null); sets.push(`${k}=$${params.length}`); }
      if ('whatsapp_phone_number_id' in d) {
        const pid = d.whatsapp_phone_number_id;
        sets.push(`whatsapp_estado='${!pid ? 'SIN_CONFIGURAR' : pid.startsWith('sim-') ? 'SIMULADO' : 'PENDIENTE_VERIFICAR'}'`, 'whatsapp_numero_visible=NULL', 'whatsapp_diagnostico=NULL', 'whatsapp_verificado_en=NULL');
      }
      await tx.query(`UPDATE tenant SET ${sets.join(', ')} WHERE id=$1`, params);
      if (d.whatsapp_phone_number_id && !d.whatsapp_phone_number_id.startsWith('sim-')) {
        await enqueue(tx, ctx.tenantId, 'verificar_whatsapp', {}, { claveUnica: `wa:${ctx.tenantId}:${token(6)}`, maxIntentos: 2 });
      }
      await auditPlatform(tx, ctx.tenantId, ctx.actor, 'PANEL', ctx.correlacion, { accion: 'tenant.editar', recurso: 'tenant', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { campos } });
    });
    return { ok: true };
  });
  rx('post', '/configuracion/whatsapp/verificar', async (ctx) => {
    await db.withTenant(ctx.tenantId, async () => requirePerm(ctx, 'tenant:configure'));
    return verificarWhatsapp(db, ctx.tenantId, ctx.correlacion, ctx.actor);
  });
  rx('post', '/configuracion/tema', async (ctx, req) => {
    const colores = Array.isArray(req.body?.colores) ? req.body.colores.slice(0, 12) : [];
    const logo = req.body?.logo_data_url;
    if (logo && (typeof logo !== 'string' || logo.length > 300_000 || !/^data:image\/(png|jpeg|webp);base64,/.test(logo))) throw invalid('No pudimos usar este logotipo. Vuelve a subirlo: se ajusta solo al cargarlo.');
    const tema = await db.withTenant(ctx.tenantId, (tx) => admin.updateTheme(tx, ctx, colores, logo));
    await db.withPlatform((tx) => tx.query(`UPDATE tenant SET tema=$2 ${logo !== undefined ? ', logo_data_url=$3' : ''} WHERE id=$1`, logo !== undefined ? [ctx.tenantId, JSON.stringify(tema), logo] : [ctx.tenantId, JSON.stringify(tema)]));
    await db.withTenant(ctx.tenantId, (tx) => audit(tx, ctx, { accion: 'tenant.tema', recurso: 'tenant', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { acento: tema.acento, ajustado: tema.ajustado, contraste: tema.contraste } }));
    return tema;
  });
  r('post', '/configuracion/pasarela', (tx, ctx, req) => payments.linkGatewayAccount(tx, ctx, req.body ?? {}));

  // --- Suscripción
  r('get', '/suscripcion', (tx, ctx) => admin.subscriptionInfo(tx, ctx));
  rx('post', '/suscripcion/pagar', async (ctx, req) => {
    await db.withTenant(ctx.tenantId, async () => requirePerm(ctx, 'subscription:manage'));
    return iniciarPagoSuscripcion(db, ctx.tenantId, req.body ?? {});
  });

  // --- Documentos de los pagos a la plataforma (la RLS limita a los de esta empresa)
  r('get', '/suscripcion/documentos', async (tx, ctx) => { requirePerm(ctx, 'subscription:manage'); return documentosTenant(tx); });
  r('post', '/suscripcion/documentos/:id/enlace', async (tx, ctx, req) => {
    requirePerm(ctx, 'subscription:manage');
    if (!isUuid(req.params.id)) throw notFound();
    return enlaceDocumentosTenant(tx, req.params.id);
  });

  // --- Auditoría
  r('get', '/auditoria', (tx, ctx, req) => admin.auditLog(tx, ctx, { tipo: req.query?.tipo, resultado: req.query?.resultado, q: req.query?.q, pagina: req.query?.pagina }));
  r('get', '/auditoria.csv', async (tx, ctx, req, reply) => {
    const rows = await admin.auditLog(tx, ctx, { tipo: req.query?.tipo, resultado: req.query?.resultado, q: req.query?.q, limite: 5000 });
    await audit(tx, ctx, { accion: 'auditoria.exportar', resultado: 'EXITO', detalle: { filas: rows.length } });
    descarga(reply, 'auditoria.csv');
    return '﻿' + admin.toCsv(rows);
  });

  // --- Simulador de cliente WhatsApp (solo con simuladores: desarrollo o demostración)
  // Construye un webhook con el formato de Meta, lo firma con el secreto de la app y
  // lo entrega al MISMO endpoint que usa el canal real.
  rx('post', '/simulador/whatsapp', async (ctx, req) => {
    if (!config.simuladores) throw notFound();
    await db.withTenant(ctx.tenantId, async () => requirePerm(ctx, 'conversation:read'));
    const b = z.object({ telefono: z.string().regex(/^\+?\d{7,15}$/, 'Teléfono no válido.'), nombre: z.string().max(60).default(''), texto: z.string().min(1).max(2000), tipo: z.enum(['text', 'image', 'audio', 'document', 'unsupported']).default('text') }).parse(req.body);
    const t = await db.withPlatform(async (tx) => (await tx.query(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]);
    if (!t?.whatsapp_phone_number_id) throw new AppError('CONFLICT', 'Vincula primero un número en Configuración › WhatsApp (en demostración puede ser sim-<nombre>).');
    const from = b.telefono.replace('+', '');
    const id = `wamid.sim.${token(10)}`;
    const ts = String(Math.floor(Date.now() / 1000));
    const mensaje = b.tipo === 'text' ? { id, from, timestamp: ts, type: 'text', text: { body: b.texto } }
      : b.tipo === 'unsupported' ? { id, from, timestamp: ts, type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }] }
      : { id, from, timestamp: ts, type: b.tipo, [b.tipo]: { id: `media-sim-${token(6)}`, mime_type: b.tipo === 'image' ? 'image/jpeg' : b.tipo === 'audio' ? 'audio/ogg' : 'application/pdf', ...(b.tipo === 'document' ? { filename: 'documento.pdf' } : {}), ...(b.texto !== '-' && b.tipo !== 'audio' ? { caption: b.texto } : {}) } };
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'sim', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: t.whatsapp_phone_number_id, display_phone_number: 'sim' }, contacts: [{ wa_id: from, profile: { name: b.nombre } }], messages: [mensaje] } }] }],
    });
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(body) } });
    return res.json();
  });
  r('get', '/simulador/whatsapp', async (tx, ctx, req) => {
    if (!config.simuladores) throw notFound();
    requirePerm(ctx, 'conversation:read');
    const tel = String(req.query?.telefono ?? '');
    const telefono = tel.startsWith('+') ? tel : `+${tel}`;
    const c = (await tx.query(`SELECT id FROM customer WHERE telefono=$1`, [telefono])).rows[0];
    if (!c) return { mensajes: [] };
    return {
      mensajes: (await tx.query(
        `SELECT m.id, m.remitente, m.contenido, coalesce(m.ocurrido_en, m.creado_en) AS creado_en, m.tipo, m.estado_entrega FROM message m JOIN conversation v ON v.id=m.conversation_id
         WHERE v.customer_id=$1 AND v.canal='WHATSAPP' AND m.tipo <> 'NOTA_INTERNA' AND (m.remitente='CUSTOMER' OR m.estado_entrega NOT IN ('PENDIENTE','FALLIDO'))
         ORDER BY coalesce(m.ocurrido_en, m.creado_en)`, [c.id])).rows,
    };
  });

  // --- Soporte de la plataforma (la empresa escribe a Omnegia). Funciona aunque la suscripción esté suspendida.
  r('get', '/soporte', (tx, ctx) => soporte.listarTickets(tx, ctx));
  r('post', '/soporte', (tx, ctx, req) => soporte.crearTicket(tx, ctx, req.body));
  r('get', '/soporte/:id', (tx, ctx, req) => soporte.verTicket(tx, ctx, req.params.id));
  r('post', '/soporte/:id/mensajes', (tx, ctx, req) => soporte.responderTicket(tx, ctx, req.params.id, req.body));
}
