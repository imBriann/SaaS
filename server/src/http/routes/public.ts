import { MODULE_CATALOG, quoteModules } from '../../onboarding/pricing.js';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/index.js';
import { AppError, invalid } from '../../lib/errors.js';
import { cop, token } from '../../lib/util.js';
import { config } from '../../config.js';
import { createSession, destroySession, memberships, SESSION_COOKIE } from '../context.js';
import * as onboarding from '../../onboarding/service.js';
import { catalogTemplate } from '../../onboarding/importer.js';
import { signWebhook } from '../../adapters/payments.js';
import { parseWhatsAppWebhook, verifyMetaSignature } from '../../adapters/channel.js';
import { receiveChannelMessages } from '../../modules/channelInbound.js';
import { publicDocumentData } from '../../modules/fiscal.js';
import { auditPlatform } from '../../core/audit.js';
import { loadTemplates } from '../../templates/index.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function registerPublicRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/publico/modulos', async () => ({ modulos: MODULE_CATALOG, demostracion: true }));
  app.post('/api/publico/cotizacion', async (req) => quoteModules(req.body));
  // ------------------------------------------------------------------ sesión
  app.post('/api/auth/login', async (req: any, reply) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) throw invalid('Escribe tu correo y contraseña.');
    const s = await createSession(db, String(email), String(password));
    reply.setCookie(SESSION_COOKIE, s.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: !config.dev, maxAge: config.sessionDays * 86400 });
    const empresas = await db.withPlatform((tx) => memberships(tx, s.user.id));
    return { usuario: { id: s.user.id, nombre: s.user.nombre, email: s.user.email, es_admin_plataforma: s.user.es_admin_plataforma }, empresas };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/sesion', async (req) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sin sesión.');
    const empresas = await db.withPlatform((tx) => memberships(tx, req.user!.id));
    return { usuario: req.user, empresas };
  });

  // ------------------------------------------------------------------ catálogo público
  app.get('/api/publico/planes', async () =>
    db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM plan WHERE codigo IN ('esencial','negocio','pro') ORDER BY orden`)).rows.map((p) => ({ ...p, precio_mensual: Number(p.precio_mensual), precio_excedente_1k_tokens: Number(p.precio_excedente_1k_tokens) }))),
  );
  app.get('/api/publico/sectores', async () => loadTemplates().map((t) => ({ sector: t.sector, version: t.version, nombre: t.nombre, descripcion: t.descripcion, modulos: t.modulos })));

  // ------------------------------------------------------------------ onboarding (UF-01)
  app.post('/api/onboarding/borradores', async (req: any) => onboarding.createDraft(db, req.body?.descripcion));
  app.get('/api/onboarding/borradores/:tk', async (req: any) => onboarding.getDraft(db, req.params.tk));
  app.patch('/api/onboarding/borradores/:tk', async (req: any) => onboarding.updateDraft(db, req.params.tk, req.body));
  app.post('/api/onboarding/borradores/:tk/catalogo/archivo', async (req: any) => {
    const f = await req.file();
    if (!f) throw invalid('Adjunta un archivo .xlsx o .csv.');
    return onboarding.uploadCatalog(db, req.params.tk, await f.toBuffer(), f.filename);
  });
  app.post('/api/onboarding/borradores/:tk/catalogo/vista-previa', async (req: any) => onboarding.previewCatalog(db, req.params.tk, req.body?.mapeo));
  app.post('/api/onboarding/borradores/:tk/catalogo/confirmar', async (req: any) => onboarding.confirmCatalog(db, req.params.tk, req.body));
  app.post('/api/onboarding/borradores/:tk/pago', async (req: any) => onboarding.startCheckout(db, req.params.tk));
  app.get('/api/onboarding/borradores/:tk/estado', async (req: any) => onboarding.draftStatus(db, req.params.tk));
  app.post('/api/onboarding/borradores/:tk/contrasena', async (req: any) => onboarding.setInitialPassword(db, req.params.tk, req.body?.password));
  app.get('/api/onboarding/plantilla-catalogo.xlsx', async (_req, reply) => {
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', 'attachment; filename="plantilla-catalogo.xlsx"');
    return reply.send(await catalogTemplate());
  });

  // ------------------------------------------------------------------ pasarela simulada
  // Simula el servidor de la pasarela: construye el evento, lo FIRMA con el secreto
  // compartido y lo entrega por HTTP al webhook, igual que haría una pasarela real.
  app.post('/api/pasarela/simular', async (req: any) => {
    if (!config.dev) throw new AppError('NOT_FOUND', 'No encontramos eso.');
    const { ref, resultado = 'aprobado', monto, entregas = 1, firma_invalida = false } = req.body ?? {};
    if (!ref) throw invalid('Falta la referencia.');
    const montoReal = monto ?? (await db.withPlatform(async (tx) => {
      const p = (await tx.query(`SELECT monto FROM payment WHERE referencia=$1`, [ref])).rows[0];
      if (p) return Number(p.monto);
      const l = (await tx.query(`SELECT o.total FROM payment_link l JOIN "order" o ON o.id=l.order_id WHERE l.referencia=$1`, [ref])).rows[0];
      return l ? Number(l.total) : 0;
    }));
    const body = JSON.stringify({ id: `evt_${token(12)}`, tipo: resultado === 'aprobado' ? 'pago.aprobado' : 'pago.rechazado', referencia: ref, monto: montoReal, moneda: 'COP', creado: new Date().toISOString() });
    const firma = firma_invalida ? 't=1,v1=00' : signWebhook(body);
    const respuestas = [];
    for (let i = 0; i < Math.min(Number(entregas) || 1, 5); i++) {
      const r = await app.inject({ method: 'POST', url: '/api/webhooks/pagos', payload: body, headers: { 'content-type': 'application/json', 'x-pasarela-firma': firma } });
      respuestas.push({ status: r.statusCode, body: r.json() });
    }
    return { entregas: respuestas };
  });

  // ------------------------------------------------------------------ webhooks
  app.post('/api/webhooks/pagos', async (req: any) => onboarding.handlePaymentWebhook(db, req.rawBody ?? '', req.headers['x-pasarela-firma'], req.correlacion));

  app.get('/api/webhooks/whatsapp', async (req: any, reply) => {
    const q = req.query ?? {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.whatsapp.verifyToken) return reply.type('text/plain').send(q['hub.challenge']);
    return reply.status(403).send('forbidden');
  });

  app.post('/api/webhooks/whatsapp', async (req: any, reply) => {
    if (!verifyMetaSignature(req.rawBody ?? '', req.headers['x-hub-signature-256'])) {
      await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'webhook' }, 'WEBHOOK', req.correlacion, { accion: 'webhook.whatsapp.firma_invalida', resultado: 'DENEGADO' }));
      return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'Firma inválida' } });
    }
    const msgs = parseWhatsAppWebhook(req.body);
    const r = await receiveChannelMessages(db, msgs, 'WHATSAPP', req.correlacion);
    return { recibidos: r };
  });

  // ------------------------------------------------------------------ documento fiscal público
  app.get('/api/publico/documentos/:tk', async (req: any, reply) => {
    const data = await db.withPlatform((tx) => publicDocumentData(tx, String(req.params.tk)));
    if (!data) return reply.status(404).type('text/html').send('<p>No encontramos ese documento.</p>');
    const { d, t, o, items } = data;
    const acento = t.tema?.acento ?? '#0E6B5E';
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.tipo === 'FACTURA' ? 'Factura' : 'Nota crédito')} ${esc(d.numero)}</title>
<style>body{font-family:system-ui,sans-serif;background:#F1F3F6;margin:0;padding:24px;color:#14171C}main{max-width:720px;margin:auto;background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:28px}
h1{font-size:20px;margin:0 0 4px;color:${esc(acento)}}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #eee;text-align:left}td.n,th.n{text-align:right}
code{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;background:#f5f6f8;padding:6px;display:block;border-radius:6px}.est{display:inline-block;padding:2px 8px;border-radius:99px;background:#E4F2EE;color:#13715E;font-size:12px;font-weight:600}</style></head>
<body><main><h1>${esc(t.nombre)}</h1><div>NIT ${esc(t.nit)} · ${esc(t.ciudad)}</div>
<p><b>${d.tipo === 'FACTURA' ? 'Factura electrónica de venta' : 'Nota crédito electrónica'} ${esc(d.numero)}</b> · <span class="est">${d.estado === 'RECHAZADO' ? 'Rechazada' : d.cufe ? 'Validada por la DIAN' : 'En trámite'}</span></p>
<p>Adquirente: ${esc(o.nombre)} ${o.numero_documento ? `· ${esc(o.tipo_documento)} ${esc(o.numero_documento)}` : '· Consumidor final'}<br>Venta #${esc(o.numero)} · ${new Date(o.creado_en).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}</p>
<table><tr><th>Descripción</th><th class="n">Cant.</th><th class="n">Valor unit.</th><th class="n">Total</th></tr>
${items.map((i: any) => `<tr><td>${esc(i.descripcion)}</td><td class="n">${Number(i.cantidad)}</td><td class="n">${cop(Number(i.precio_unit))}</td><td class="n">${cop(Number(i.total))}</td></tr>`).join('')}
<tr><td colspan="3" class="n">Base</td><td class="n">${cop(Number(o.subtotal))}</td></tr><tr><td colspan="3" class="n">IVA</td><td class="n">${cop(Number(o.impuestos))}</td></tr>
<tr><td colspan="3" class="n"><b>Total</b></td><td class="n"><b>${cop(Number(o.total))}</b></td></tr></table>
${d.cufe ? `<div>CUFE</div><code>${esc(d.cufe)}</code>` : ''}
<p style="font-size:12px;color:#5b6472">Documento emitido a través de proveedor tecnológico habilitado. Entorno de pruebas del piloto.</p></main></body></html>`;
  });
}
