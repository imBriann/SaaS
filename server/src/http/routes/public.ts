import { SECTOR_CATALOG } from '../../onboarding/sectors.js';
import { countries, divisions, cities } from '../../onboarding/location.js';
import { availability, domainInfo } from '../../onboarding/subdomain.js';
import { sendDraftCode, verifyDraftCode } from '../../onboarding/verification.js';
import type { FastifyInstance } from 'fastify';
import { MODULE_CATALOG, quoteModules } from '../../onboarding/pricing.js';
import type { Database } from '../../db/index.js';
import { AppError, invalid, notFound } from '../../lib/errors.js';
import { cop, token } from '../../lib/util.js';
import { config, integraciones } from '../../config.js';
import { cookieBorrar, cookieSesion, memberships, SESSION_COOKIE, sessionToken } from '../context.js';
import * as onboarding from '../../onboarding/service.js';
import { catalogTemplate } from '../../onboarding/importer.js';
import { cuentaPlataforma, mediosPagoWompi, signWebhook, verificarEventoWompi } from '../../adapters/payments.js';
import * as documentos from '../../documentos/servicio.js';
import { parseWhatsAppWebhook, verifyMetaSignature } from '../../adapters/channel.js';
import { receiveChannelMessages, receiveDeliveryStatuses } from '../../modules/channelInbound.js';
import { publicDocumentData } from '../../modules/fiscal.js';
import { procesarEventoComercio, procesarEventoPago, verificarRetorno } from '../../modules/billing.js';
import { ofertaAlta, resumenModalidad } from '../../onboarding/oferta.js';
import * as auth from '../../modules/auth.js';
import * as team from '../../modules/team.js';
import { FirmaInvalida, webhookResend } from '../../email/servicio.js';
import { auditPlatform } from '../../core/audit.js';
import { loadTemplates } from '../../templates/index.js';
import { MARCA } from '../../brand.js';
import { estadoIaRegistro } from '../../onboarding/personalization.js';
import { solicitarCreacion } from '../../onboarding/creation.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export async function registerPublicRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/publico/modulos', async () => ({ modulos: MODULE_CATALOG, demostracion: true }));
  // La cotización comercial no cambia; con la modalidad institucional se añade lo que realmente se cobraría.
  app.post('/api/publico/cotizacion', async (req) => {
    const q = quoteModules(req.body);
    const o = ofertaAlta(q.total);
    return { ...q, oferta: { modalidad: o.modalidad, monto: o.monto, monto_referencia: o.montoReferencia, acceso_dias: o.accesoDias }, modalidad: resumenModalidad() };
  });
  app.get('/api/publico/planes', async () =>
    db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM plan WHERE codigo IN ('esencial','negocio','pro') ORDER BY orden`)).rows.map((p) => ({ ...p, precio_mensual: Number(p.precio_mensual), precio_excedente_1k_tokens: Number(p.precio_excedente_1k_tokens) }))),
  );
  app.get('/api/publico/sectores', async () => loadTemplates().map((t) => ({ sector: t.sector, version: t.version, nombre: t.nombre, descripcion: t.descripcion, modulos: t.modulos })));
  app.get('/api/publico/estado', async () => ({ contratacion: onboarding.puedeContratar(), modalidad: resumenModalidad(), simuladores: config.simuladores, integraciones: integraciones().map(({ clave, estado }) => ({ clave, estado })) }));

  // ------------------------------------------------------------------ sesión
  app.post('/api/auth/login', async (req: any, reply) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) throw invalid('Escribe tu correo y contraseña.');
    const s = await auth.login(db, String(email), String(password), { ip: req.ip, agente: String(req.headers['user-agent'] ?? ''), correlacion: req.correlacion });
    // Operador de la plataforma: sin cookie hasta completar el segundo factor.
    if (s.tipo === 'segundo_factor') return { segundo_factor: true, desafio: s.desafio, destino: s.destino, minutos: s.minutos };
    reply.setCookie(SESSION_COOKIE, s.token, cookieSesion());
    const empresas = await db.withPlatform((tx) => memberships(tx, s.user.id));
    return { usuario: s.user, empresas };
  });

  app.post('/api/auth/login/codigo', async (req: any, reply) => {
    const s = await auth.completarSegundoFactor(db, String(req.body?.desafio ?? ''), req.body?.codigo, { agente: String(req.headers['user-agent'] ?? ''), correlacion: req.correlacion });
    reply.setCookie(SESSION_COOKIE, s.token, cookieSesion());
    const empresas = await db.withPlatform((tx) => memberships(tx, s.user.id));
    return { usuario: s.user, empresas };
  });
  app.post('/api/auth/login/codigo/reenviar', async (req: any) => auth.reenviarSegundoFactor(db, String(req.body?.desafio ?? ''), req.ip));

  // Verificación del correo (código de seis dígitos).
  app.post('/api/auth/verificacion/enviar', async (req: any) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
    return auth.enviarVerificacion(db, req.user, req.ip);
  });
  app.post('/api/auth/verificacion/confirmar', async (req: any) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
    return auth.confirmarVerificacion(db, req.user, req.body?.codigo, req.correlacion);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await auth.destroySession(db, sessionToken(req));
    reply.clearCookie(SESSION_COOKIE, cookieBorrar());
    return { ok: true };
  });

  app.post('/api/auth/logout-todas', async (req, reply) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Sin sesión.');
    await auth.logoutEverywhere(db, req.user);
    reply.clearCookie(SESSION_COOKIE, cookieBorrar());
    return { ok: true };
  });

  app.get('/api/auth/sesion', async (req) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
    const empresas = await db.withPlatform((tx) => memberships(tx, req.user!.id));
    return { usuario: req.user, empresas };
  });

  app.post('/api/auth/recuperar', async (req: any) => auth.requestPasswordReset(db, String(req.body?.email ?? ''), req.correlacion));
  app.post('/api/auth/restablecer', async (req: any) => auth.resetPassword(db, String(req.body?.token ?? ''), String(req.body?.password ?? ''), req.correlacion));
  app.post('/api/auth/cambiar-contrasena', async (req: any) => {
    if (!req.user) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
    return auth.changePassword(db, req.user, String(req.body?.actual ?? ''), String(req.body?.nueva ?? ''), sessionToken(req), req.correlacion);
  });

  // ------------------------------------------------------------------ invitaciones
  app.get('/api/invitaciones/:tk', async (req: any) => team.invitationInfo(db, String(req.params.tk)));
  app.post('/api/invitaciones/:tk/aceptar', async (req: any) => team.acceptInvitation(db, String(req.params.tk), { password: req.body?.password }, req.correlacion));

  app.get('/api/onboarding/catalogos', async () => ({ sectores: SECTOR_CATALOG, paises: countries, dominio: domainInfo() }));
  app.get('/api/onboarding/ia/estado', async () => estadoIaRegistro());
  app.get('/api/onboarding/territorios', async (req:any) => req.query?.departamento ? cities(String(req.query.pais),String(req.query.departamento)) : divisions(String(req.query?.pais ?? 'CO')));
  app.get('/api/onboarding/subdominio', async (req:any) => availability(db,String(req.query?.slug ?? ''),String(req.query?.tk ?? '')));
  app.post('/api/onboarding/borradores/:tk/analizar', async (req:any) => onboarding.reanalyzeDraft(db,req.params.tk,req.body?.descripcion));
  app.post('/api/onboarding/borradores/:tk/correo/enviar', async (req:any) => sendDraftCode(db,req.params.tk,req.ip));
  app.post('/api/onboarding/borradores/:tk/correo/verificar', async (req:any) => verifyDraftCode(db,req.params.tk,req.body?.codigo));
  // ------------------------------------------------------------------ onboarding
  app.post('/api/onboarding/borradores', async (req: any) => onboarding.createDraft(db, req.body?.descripcion, req.body?.creacion_diferida === true));
  app.post('/api/onboarding/borradores/:tk/crear', async (req: any, reply) => {
    const r = await solicitarCreacion(db, req.params.tk, req.body?.password, { ip: req.ip, agente: String(req.headers['user-agent'] ?? ''), correlacion: req.correlacion, usuario: req.user });
    if ('segundo_factor' in r) return { segundo_factor: true, desafio: r.desafio, destino: r.destino, minutos: r.minutos };
    if (r.sesion?.tipo === 'sesion') reply.setCookie(SESSION_COOKIE, r.sesion.token, cookieSesion());
    return { ok: true, creacion: r.creacion };
  });
  app.get('/api/onboarding/borradores/:tk', async (req: any) => onboarding.getDraft(db, req.params.tk));
  app.patch('/api/onboarding/borradores/:tk', async (req: any) => onboarding.updateDraft(db, req.params.tk, req.body));
  app.post('/api/onboarding/borradores/:tk/catalogo/archivo', async (req: any) => {
    const f = await req.file();
    if (!f) throw invalid('Adjunta un archivo .xlsx o .csv.');
    return onboarding.uploadCatalog(db, req.params.tk, await f.toBuffer(), f.filename, req.query?.hoja);
  });
  app.post('/api/onboarding/borradores/:tk/catalogo/vista-previa', async (req: any) => onboarding.previewCatalog(db, req.params.tk, req.body?.mapeo));
  app.post('/api/onboarding/borradores/:tk/catalogo/confirmar', async (req: any) => onboarding.confirmCatalog(db, req.params.tk, req.body));
  app.post('/api/onboarding/borradores/:tk/pago', async (req: any) => onboarding.startCheckout(db, req.params.tk, req.correlacion, req.body?.retorno));
  app.get('/api/onboarding/borradores/:tk/estado', async (req: any) => onboarding.draftStatus(db, req.params.tk, req.correlacion));
  app.post('/api/onboarding/borradores/:tk/reintentar', async (req: any) => onboarding.retryProvisioning(db, req.params.tk, req.correlacion));
  // Documentos del pago: enlace temporal para quien pagó (portador del borrador) y reintento si fallaron.
  app.post('/api/onboarding/borradores/:tk/documentos/enlace', async (req: any) => documentos.enlaceDocumentosBorrador(db, String(req.params.tk ?? '')));
  app.post('/api/onboarding/borradores/:tk/documentos/reintentar', async (req: any) => documentos.reintentarDocumentosBorrador(db, String(req.params.tk ?? '')));
  // Descarga con un enlace firmado y vigente (en el cuerpo, no en la URL). Nunca revela dónde se guarda.
  app.post('/api/documentos/descarga', async (req: any, reply) => {
    const d = await documentos.descargarDocumentos(db, String(req.body?.token ?? ''));
    return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${d.nombre}"`)
      .header('cache-control', 'no-store, private').header('x-content-type-options', 'nosniff').send(d.contenido);
  });
  // Medios de pago que Wompi confirma para la cuenta de la plataforma (sin promesas si no los informa).
  app.get('/api/publico/medios-pago', async () => {
    const cuenta = cuentaPlataforma();
    if (!cuenta || cuenta.proveedor !== 'wompi') return { fuente: 'no_confirmado', medios: [], bre_b: false };
    return mediosPagoWompi(cuenta, config.institucional.activo ? config.institucional.precioCop : Number.MAX_SAFE_INTEGER);
  });
  // Vuelta de la pasarela sin la llave del borrador: confirma con Wompi y envía el enlace al correo verificado.
  app.post('/api/onboarding/retorno', async (req: any) => onboarding.recuperarRetorno(db, String(req.body?.id ?? ''), req.correlacion));
  app.post('/api/onboarding/borradores/:tk/contrasena', async (req: any) => onboarding.setInitialPassword(db, req.params.tk, req.body?.password, req.ip));
  app.get('/api/onboarding/plantilla-catalogo.xlsx', async (_req, reply) => {
    reply.header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('content-disposition', 'attachment; filename="plantilla-catalogo.xlsx"');
    return reply.send(await catalogTemplate());
  });

  // ------------------------------------------------------------------ pasarela simulada (desarrollo y demostración)
  // Representa al servidor de la pasarela: construye el evento, lo FIRMA con el secreto
  // compartido y lo entrega al webhook por HTTP, como haría una pasarela real.
  app.post('/api/pasarela/simular', async (req: any) => {
    if (!config.simuladores) throw notFound();
    const { ref, resultado = 'aprobado', monto, entregas = 1, firma_invalida = false } = req.body ?? {};
    if (!ref || typeof ref !== 'string') throw invalid('Falta la referencia.');
    const montoReal = monto ?? (await db.withPlatform(async (tx) => {
      const p = (await tx.query(`SELECT monto FROM payment WHERE referencia=$1`, [ref])).rows[0];
      if (p) return Number(p.monto);
      const l = (await tx.query(`SELECT monto FROM payment_link WHERE referencia=$1`, [ref])).rows[0];
      return l ? Number(l.monto) : 0;
    }));
    const body = JSON.stringify({ id: `evt_${token(12)}`, tipo: resultado === 'aprobado' ? 'pago.aprobado' : 'pago.rechazado', referencia: ref, monto: montoReal, moneda: 'COP', transaccion: `sim-${token(8)}`, creado: new Date().toISOString() });
    const firma = firma_invalida ? 't=1,v1=00' : signWebhook(body);
    const respuestas = [];
    for (let i = 0; i < Math.min(Number(entregas) || 1, 5); i++) {
      const r = await app.inject({ method: 'POST', url: '/api/webhooks/pagos', payload: body, headers: { 'content-type': 'application/json', 'x-pasarela-firma': firma } });
      respuestas.push({ status: r.statusCode, body: r.json() });
    }
    return { entregas: respuestas };
  });

  // ------------------------------------------------------------------ webhooks de pagos
  app.post('/api/webhooks/pagos', async (req: any) => onboarding.handlePaymentWebhook(db, req.rawBody ?? '', req.headers['x-pasarela-firma'], req.correlacion));

  // Wompi · cuenta de la plataforma (altas y renovaciones).
  app.post('/api/webhooks/wompi', async (req: any, reply) => {
    const cuenta = cuentaPlataforma();
    const checksum = typeof req.headers['x-event-checksum'] === 'string' ? req.headers['x-event-checksum'] : undefined;
    const ev = cuenta?.proveedor === 'wompi' ? verificarEventoWompi(cuenta, req.body, checksum) : null;
    if (!ev) {
      // Sin el cuerpo: solo la constancia del intento rechazado.
      await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'webhook' }, 'WEBHOOK', req.correlacion, { accion: 'webhook.wompi.firma_invalida', resultado: 'DENEGADO' }));
      return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'Firma inválida' } });
    }
    return procesarEventoPago(db, ev, req.correlacion, 'wompi');
  });

  // Wompi · cuenta propia de un comercio (la URL lleva el token que identifica la cuenta).
  app.post('/api/webhooks/wompi/comercio/:tk', async (req: any, reply) => {
    const tk = String(req.params.tk ?? '');
    if (!/^[\w-]{20,64}$/.test(tk)) throw notFound();
    const r = await procesarEventoComercio(db, tk, (c) => (c.proveedor === 'wompi' ? verificarEventoWompi(c, req.body) : null), req.correlacion);
    if (r.firmaInvalida) return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'Firma inválida' } });
    return r;
  });

  // Retorno del checkout: el navegador solo trae el id; el servidor consulta a la pasarela.
  app.get('/api/pagos/verificar', async (req: any) => {
    const id = String(req.query?.id ?? '');
    if (!/^[\w-]{3,80}$/.test(id)) throw invalid('Falta el identificador de la transacción.');
    return verificarRetorno(db, id, req.correlacion);
  });

  // ------------------------------------------------------------------ webhook de Resend (estados de entrega del correo)
  app.post('/api/webhooks/correo', async (req: any, reply) => {
    if (!config.correo.resendWebhookSecret) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Webhook de correo pendiente de configurar.' } });
    try {
      return await webhookResend(db, req.rawBody ?? '', req.headers);
    } catch (e) {
      if (e instanceof FirmaInvalida) {
        await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'webhook' }, 'WEBHOOK', req.correlacion, { accion: 'webhook.correo.firma_invalida', resultado: 'DENEGADO' }));
        return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'Firma inválida' } });
      }
      throw e;
    }
  });

  // ------------------------------------------------------------------ webhook de WhatsApp (Meta)
  app.get('/api/webhooks/whatsapp', async (req: any, reply) => {
    const q = req.query ?? {};
    if (config.whatsapp.verifyToken && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === config.whatsapp.verifyToken) return reply.type('text/plain').send(String(q['hub.challenge'] ?? ''));
    return reply.status(403).send('forbidden');
  });

  app.post('/api/webhooks/whatsapp', async (req: any, reply) => {
    if (!verifyMetaSignature(req.rawBody ?? '', req.headers['x-hub-signature-256'])) {
      await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'webhook' }, 'WEBHOOK', req.correlacion, { accion: 'webhook.whatsapp.firma_invalida', resultado: 'DENEGADO' }));
      return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'Firma inválida' } });
    }
    const { mensajes, estados } = parseWhatsAppWebhook(req.body);
    const recibidos = await receiveChannelMessages(db, mensajes, 'WHATSAPP', req.correlacion);
    const entregas = await receiveDeliveryStatuses(db, estados, req.correlacion);
    return { recibidos, estados: entregas };
  });

  // ------------------------------------------------------------------ documento fiscal público
  app.get('/api/publico/documentos/:tk', async (req: any, reply) => {
    const data = await db.withPlatform((tx) => publicDocumentData(tx, String(req.params.tk)));
    reply.header('x-robots-tag', 'noindex');
    if (!data) return reply.status(404).type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><p style="font-family:system-ui;padding:24px">No encontramos ese documento.</p>');
    const { d, t, o, items, zona } = data;
    const prueba = d.proveedor_fiscal === 'sandbox';
    const acento = t.tema?.acento ?? MARCA.colorPrimario;
    const estado = d.estado === 'RECHAZADO' ? 'Rechazado' : !d.cufe ? 'En trámite' : prueba ? 'Validado en entorno de pruebas' : 'Validado por la DIAN';
    reply.type('text/html; charset=utf-8');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(d.tipo === 'FACTURA' ? 'Factura' : 'Nota crédito')} ${esc(d.numero)} · ${esc(t.nombre)}</title>
<style>body{font-family:system-ui,sans-serif;background:#F1F3F6;margin:0;padding:24px;color:#14171C}main{max-width:720px;margin:auto;background:#fff;border:1px solid #dde1e7;border-radius:10px;padding:28px}
h1{font-size:20px;margin:0 0 4px;color:${esc(acento)}}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{padding:8px;border-bottom:1px solid #eee;text-align:left}td.n,th.n{text-align:right}
code{font-family:ui-monospace,monospace;font-size:11px;word-break:break-all;background:#f5f6f8;padding:6px;display:block;border-radius:6px}.est{display:inline-block;padding:2px 8px;border-radius:99px;background:#E4F2EE;color:#13715E;font-size:12px;font-weight:600}
.prueba{background:#FBF0D9;color:#7F5300;border:1px solid #E6C27A;border-radius:8px;padding:10px 12px;font-weight:600;margin:0 0 16px}@media print{body{background:#fff;padding:0}main{border:0}}</style></head>
<body><main>${prueba ? '<p class="prueba">Documento de prueba: SIN validez fiscal. Generado en el entorno de pruebas; no fue transmitido a la DIAN.</p>' : ''}<h1>${esc(t.nombre)}</h1><div>NIT ${esc(t.nit)} · ${esc(t.ciudad)}</div>
<p><b>${d.tipo === 'FACTURA' ? 'Factura electrónica de venta' : 'Nota crédito electrónica'} ${esc(d.numero)}</b> · <span class="est">${esc(estado)}</span></p>
<p>Adquirente: ${esc(o.nombre)} ${o.numero_documento ? `· ${esc(o.tipo_documento)} ${esc(o.numero_documento)}` : '· Consumidor final'}<br>Venta #${esc(o.numero)} · ${esc(new Date(o.creado_en).toLocaleString('es-CO', { timeZone: zona }))}</p>
<table><tr><th>Descripción</th><th class="n">Cant.</th><th class="n">Valor unit.</th><th class="n">Total</th></tr>
${items.map((i: any) => `<tr><td>${esc(i.descripcion)}</td><td class="n">${Number(i.cantidad)}</td><td class="n">${cop(Number(i.precio_unit))}</td><td class="n">${cop(Number(i.total))}</td></tr>`).join('')}
${Number(o.descuento) > 0 ? `<tr><td colspan="3" class="n">Descuentos</td><td class="n">−${cop(Number(o.descuento))}</td></tr>` : ''}
<tr><td colspan="3" class="n">Base</td><td class="n">${cop(Number(o.subtotal))}</td></tr><tr><td colspan="3" class="n">IVA</td><td class="n">${cop(Number(o.impuestos))}</td></tr>
<tr><td colspan="3" class="n"><b>Total</b></td><td class="n"><b>${cop(Number(o.total))}</b></td></tr></table>
${d.cufe ? `<div>${prueba ? 'Código de prueba (no es un CUFE válido)' : 'CUFE'}</div><code>${esc(d.cufe)}</code>` : ''}
<p style="font-size:12px;color:#5b6472">${prueba ? `Emitido con ${esc(MARCA.nombre)} en modo de pruebas.` : 'Documento emitido a través de proveedor tecnológico habilitado por la DIAN.'}</p></main></body></html>`;
  });
}
