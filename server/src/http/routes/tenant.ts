import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Tx } from '../../db/index.js';
import { type Ctx, can, requirePerm, requireWritable } from '../../core/context.js';
import { audit } from '../../core/audit.js';
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
import { askAssistant, suggestReply } from '../../ai/runtime.js';
import { signMeta } from '../../adapters/channel.js';
import { checkoutUrl } from '../../adapters/payments.js';
import { uuidv7 } from '../../lib/util.js';

// params, query y body se validan en cada servicio (zod o comprobaciones explícitas).
type Req = FastifyRequest & { params: any; query: any; body: any };
type H = (tx: Tx, ctx: Ctx, req: Req, reply: FastifyReply) => Promise<unknown>;

export async function registerTenantRoutes(app: FastifyInstance, db: Database) {
  const guard = tenantGuard(db);
  const T = (h: H) => async (req: FastifyRequest, reply: FastifyReply) => db.withTenant(req.ctx!.tenantId, (tx) => h(tx, req.ctx!, req as Req, reply));
  const r = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, h: H) =>
    app.route({ method: method.toUpperCase() as any, url: `/api/t${path}`, preHandler: guard, handler: T(h) });
  /** Variante sin transacción envolvente (operaciones que llaman al modelo o mezclan plataforma). */
  const rx = (method: 'get' | 'post' | 'patch', path: string, h: (ctx: Ctx, req: Req, reply: FastifyReply) => Promise<unknown>) =>
    app.route({ method: method.toUpperCase() as any, url: `/api/t${path}`, preHandler: guard, handler: (req, reply) => h(req.ctx!, req as Req, reply) });

  // --- Sesión y panel
  r('get', '/yo', (tx, ctx) => admin.me(tx, ctx));
  r('get', '/inicio', (tx, ctx) => admin.dashboard(tx, ctx));

  // --- Clientes
  r('get', '/clientes', (tx, ctx, req) => customers.listCustomers(tx, ctx, req.query?.q));
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
  r('get', '/inventario/movimientos', (tx, ctx) => catalog.listMovements(tx, ctx));
  r('post', '/inventario/movimientos', (tx, ctx, req) => catalog.registerMovement(tx, ctx, z.object({
    product_id: z.string(), tipo: z.enum(['ENTRADA', 'SALIDA', 'AJUSTE']), cantidad: z.number(), motivo: z.string().min(3).max(200),
  }).parse(req.body)));

  // --- Agenda
  r('get', '/agenda', (tx, ctx, req) => agenda.listDay(tx, ctx, /^\d{4}-\d{2}-\d{2}$/.test(req.query?.fecha ?? '') ? req.query.fecha : todayLocal()));
  r('get', '/agenda/recursos', (tx, ctx) => agenda.listResources(tx, ctx));
  r('post', '/agenda/recursos', (tx, ctx, req) => agenda.createResource(tx, ctx, z.object({ nombre: z.string().min(2).max(40), horario: z.record(z.string(), z.tuple([z.string(), z.string()])) }).parse(req.body) as any));
  r('get', '/agenda/disponibilidad', async (tx, ctx, req) => {
    requirePerm(ctx, 'appointment:read');
    return agenda.availability(tx, String(req.query?.servicio_id), String(req.query?.fecha ?? todayLocal()), req.query?.recurso_id || null, 40);
  });
  r('post', '/agenda/citas', (tx, ctx, req) => agenda.createAppointment(tx, ctx, req.body));
  r('patch', '/agenda/citas/:id', (tx, ctx, req) => agenda.updateAppointmentState(tx, ctx, req.params.id, String(req.body?.estado)));

  // --- Ventas
  r('get', '/ventas', (tx, ctx, req) => orders.listOrders(tx, ctx, { estado_fiscal: req.query?.estado_fiscal }));
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
  r('get', '/conversaciones', (tx, ctx, req) => conv.listInbox(tx, ctx, req.query?.filtro));
  r('get', '/conversaciones/:id', (tx, ctx, req) => conv.conversationDetail(tx, ctx, req.params.id));
  r('post', '/conversaciones/:id/responder', (tx, ctx, req) => conv.humanReply(tx, ctx, req.params.id, String(req.body?.texto ?? ''), false));
  r('post', '/conversaciones/:id/nota', (tx, ctx, req) => conv.humanReply(tx, ctx, req.params.id, String(req.body?.texto ?? ''), true));
  r('post', '/conversaciones/:id/escalar', async (tx, ctx, req) => {
    requireWritable(ctx);
    if (!isUuid(req.params.id)) throw notFound();
    return conv.escalate(tx, ctx, req.params.id, String(req.body?.motivo ?? 'Escalado manualmente'), req.body?.prioridad ?? 'MEDIA');
  });
  r('post', '/conversaciones/:id/cerrar', (tx, ctx, req) => conv.closeCase(tx, ctx, req.params.id, String(req.body?.motivo ?? '')));
  r('post', '/conversaciones/:id/devolver-ia', (tx, ctx, req) => conv.returnToAi(tx, ctx, req.params.id));
  r('post', '/casos/:id/tomar', (tx, ctx, req) => conv.takeCase(tx, ctx, req.params.id));
  r('post', '/casos/:id/reasignar', (tx, ctx, req) => conv.reassignCase(tx, ctx, req.params.id, String(req.body?.user_id)));
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
    const historial = Array.isArray(req.body?.historial) ? req.body.historial.filter((h: any) => ['user', 'assistant'].includes(h?.role) && typeof h?.text === 'string').slice(-8) : [];
    return askAssistant(db, ctx, pregunta, historial);
  });

  // --- Configuración
  r('get', '/configuracion', (tx, ctx) => admin.settings(tx, ctx));
  r('patch', '/configuracion/modulos/:modulo', (tx, ctx, req) => admin.toggleModule(tx, ctx, req.params.modulo, !!req.body?.activo));
  r('patch', '/configuracion/personas/:id', (tx, ctx, req) => admin.updateMember(tx, ctx, req.params.id, req.body));
  rx('post', '/configuracion/personas', async (ctx, req) => {
    const { d, roleId } = await db.withTenant(ctx.tenantId, (tx) => admin.inviteUser(tx, ctx, req.body));
    const u = await db.withPlatform((tx) => admin.createOrGetUser(tx, d.email, d.nombre));
    await db.withTenant(ctx.tenantId, (tx) => admin.addMembership(tx, ctx, u.id, roleId));
    // En el piloto la contraseña temporal se entrega al administrador; en producción va por correo.
    return { ok: true, contrasena_temporal: u.temporal };
  });
  rx('patch', '/configuracion/empresa', async (ctx, req) => {
    const { d } = await db.withTenant(ctx.tenantId, (tx) => admin.updateTenantInfo(tx, ctx, req.body));
    const sets: string[] = [];
    const params: unknown[] = [ctx.tenantId];
    for (const [k, v] of Object.entries(d)) { params.push(v ?? null); sets.push(`${k}=$${params.length}`); }
    if (sets.length) {
      try {
        await db.withPlatform((tx) => tx.query(`UPDATE tenant SET ${sets.join(', ')} WHERE id=$1`, params));
      } catch (e: any) {
        if (String(e?.message).includes('whatsapp_phone_number_id')) throw new AppError('CONFLICT', 'Ese número ya está vinculado a otra empresa.');
        throw e;
      }
    }
    await db.withTenant(ctx.tenantId, (tx) => audit(tx, ctx, { accion: 'tenant.editar', recurso: 'tenant', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { campos: Object.keys(d) } }));
    return { ok: true };
  });
  rx('post', '/configuracion/tema', async (ctx, req) => {
    const colores = Array.isArray(req.body?.colores) ? req.body.colores.slice(0, 12) : [];
    const logo = req.body?.logo_data_url;
    if (logo && (typeof logo !== 'string' || logo.length > 300_000 || !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(logo))) throw invalid('Logotipo no válido (PNG, JPG, WEBP o SVG de hasta 200 KB).');
    const tema = await db.withTenant(ctx.tenantId, (tx) => admin.updateTheme(tx, ctx, colores, logo));
    await db.withPlatform((tx) => tx.query(`UPDATE tenant SET tema=$2 ${logo !== undefined ? ', logo_data_url=$3' : ''} WHERE id=$1`, logo !== undefined ? [ctx.tenantId, JSON.stringify(tema), logo] : [ctx.tenantId, JSON.stringify(tema)]));
    await db.withTenant(ctx.tenantId, (tx) => audit(tx, ctx, { accion: 'tenant.tema', recurso: 'tenant', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { acento: tema.acento, ajustado: tema.ajustado, contraste: tema.contraste } }));
    return tema;
  });
  r('post', '/configuracion/pasarela', (tx, ctx, req) => payments.linkGatewayAccount(tx, ctx, req.body ?? {}));

  // --- Suscripción
  r('get', '/suscripcion', (tx, ctx) => admin.subscriptionInfo(tx, ctx));
  rx('post', '/suscripcion/pagar', async (ctx) => {
    await db.withTenant(ctx.tenantId, async (tx) => requirePerm(ctx, 'subscription:manage'));
    return db.withPlatform(async (tx) => {
      const p = (await tx.query(`SELECT p.nombre, p.precio_mensual FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo WHERE t.id=$1`, [ctx.tenantId])).rows[0];
      const referencia = `SUB-${token(9)}`;
      await tx.query(`INSERT INTO payment (id, tenant_id, referencia, concepto, monto, estado) VALUES ($1,$2,$3,$4,$5,'PENDIENTE')`, [uuidv7(), ctx.tenantId, referencia, `Renovación plan ${p.nombre}`, Number(p.precio_mensual)]);
      return { referencia, url: checkoutUrl(referencia, Number(p.precio_mensual), `Renovación plan ${p.nombre}`) };
    });
  });

  // --- Auditoría
  r('get', '/auditoria', (tx, ctx, req) => admin.auditLog(tx, ctx, { tipo: req.query?.tipo, resultado: req.query?.resultado, q: req.query?.q }));
  r('get', '/auditoria.csv', async (tx, ctx, req, reply) => {
    const rows = await admin.auditLog(tx, ctx, { tipo: req.query?.tipo, resultado: req.query?.resultado, q: req.query?.q, limite: 2000 });
    await audit(tx, ctx, { accion: 'auditoria.exportar', resultado: 'EXITO', detalle: { filas: rows.length } });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="auditoria.csv"');
    return '﻿' + admin.toCsv(rows);
  });

  // --- Simulador de cliente WhatsApp (herramienta del piloto)
  // Construye un webhook con el formato de Meta, lo firma con el secreto de la
  // app y lo entrega al MISMO endpoint que usa el canal real.
  rx('post', '/simulador/whatsapp', async (ctx, req) => {
    if (!config.dev && process.env.SIMULADOR !== '1') throw notFound();
    await db.withTenant(ctx.tenantId, async () => requirePerm(ctx, 'conversation:read'));
    const b = z.object({ telefono: z.string().regex(/^\+?\d{7,15}$/), nombre: z.string().max(60).default(''), texto: z.string().min(1).max(2000) }).parse(req.body);
    const t = await db.withPlatform(async (tx) => (await tx.query(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]);
    if (!t?.whatsapp_phone_number_id) throw new AppError('CONFLICT', 'Vincula primero un número de WhatsApp en Configuración (en el piloto puede ser sim-<algo>).');
    const from = b.telefono.replace('+', '');
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'sim', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp', metadata: { phone_number_id: t.whatsapp_phone_number_id, display_phone_number: 'sim' },
        contacts: [{ wa_id: from, profile: { name: b.nombre } }],
        messages: [{ id: `wamid.sim.${token(10)}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: b.texto } }],
      } }] }],
    });
    const res = await app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(body) } });
    return res.json();
  });
  r('get', '/simulador/whatsapp', async (tx, ctx, req) => {
    requirePerm(ctx, 'conversation:read');
    const tel = String(req.query?.telefono ?? '');
    const telefono = tel.startsWith('+') ? tel : `+${tel}`;
    const c = (await tx.query(`SELECT id FROM customer WHERE telefono=$1`, [telefono])).rows[0];
    if (!c) return { mensajes: [] };
    return {
      mensajes: (await tx.query(
        `SELECT m.id, m.remitente, m.contenido, m.creado_en, m.tipo FROM message m JOIN conversation v ON v.id=m.conversation_id
         WHERE v.customer_id=$1 AND v.canal='WHATSAPP' AND m.tipo <> 'NOTA_INTERNA' ORDER BY m.creado_en`, [c.id])).rows,
    };
  });

  // --- Plataforma (administrador del SaaS)
  app.get('/api/plataforma/tenants', async (req) => {
    if (!req.user?.es_admin_plataforma) throw notFound();
    return db.withPlatform(async (tx) => (await tx.query(
      `SELECT t.id, t.slug, t.nombre, t.sector, t.plan_codigo, t.creado_en, s.estado,
              (SELECT coalesce(sum(cantidad),0) FROM usage_record u WHERE u.tenant_id=t.id AND u.metrica='tokens_ia' AND u.periodo=to_char(now(),'YYYY-MM'))::bigint AS tokens_mes
       FROM tenant t LEFT JOIN subscription s ON s.tenant_id=t.id ORDER BY t.creado_en DESC`)).rows);
  });

  void can;
}
