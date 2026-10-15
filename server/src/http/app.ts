import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ZodError } from 'zod';
import type { Database, Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { audit } from '../core/audit.js';
import { AppError } from '../lib/errors.js';
import { config, integraciones } from '../config.js';
import { newCorrelation, loadUser } from './context.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerTenantRoutes } from './routes/tenant.js';
import { limitador } from './limits.js';
import { registerOperatorRoutes } from './routes/operador.js';
import { registrarPeticion } from '../core/metricas.js';
import { registrarIncidente } from '../core/incidentes.js';
import { depurar } from '../lib/depurar.js';

/** Servicio afectado a partir de la plantilla de ruta: /api/t/ventas/:id → t/ventas. */
export const servicioDeRuta = (ruta: string) => ruta.replace(/^\/api\//, '').split('/').filter((x) => x && !x.startsWith(':')).slice(0, 2).join('/') || 'api';

export type Handler<T = unknown> = (tx: Tx, ctx: Ctx, req: FastifyRequest<any>, reply: FastifyReply) => Promise<T>;

/** Mensajes en lenguaje del negocio para violaciones de restricciones conocidas. */
const RESTRICCIONES: Record<string, string> = {
  ux_customer_tenant_tel: 'Ya existe un cliente con ese teléfono.',
  tenant_slug_key: 'Ese subdominio ya está en uso.',
  tenant_whatsapp_phone_number_id_key: 'Ese número de WhatsApp ya está vinculado a otra empresa.',
  ux_invitation_pendiente: 'Ya hay una invitación pendiente para ese correo.',
  users_email_key: 'Ya existe una cuenta con ese correo.',
};

/** Rutas que reciben llamadas de terceros (sin cookie de sesión ni Origin del panel). */
const SIN_ORIGEN = /^\/api\/webhooks\//;

function origenPermitido(origin: string): boolean {
  try {
    const u = new URL(origin);
    const pub = new URL(config.publicUrl);
    if (u.host === pub.host) return true;
    return u.hostname === config.baseDomain || u.hostname.endsWith('.' + config.baseDomain);
  } catch {
    return false;
  }
}

export async function buildApp(db: Database, opts: { logger?: boolean; webDir?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false || config.logNivel === 'silent' ? false : {
      level: config.logNivel,
      // Nunca se registran cookies, tokens ni cuerpos de petición.
      redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-hub-signature-256"]', 'req.headers["x-pasarela-firma"]'], remove: true },
      serializers: { req: (r: any) => ({ method: r.method, url: String(r.url).replace(/token=[^&]+/g, 'token=***'), correlacion: r.correlacion }) },
    },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    genReqId: () => newCorrelation(),
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  // Cuerpo crudo disponible para verificar firmas de webhooks (HMAC sobre los bytes recibidos).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(new AppError('VALIDATION', 'JSON inválido'), undefined); }
  });

  app.addHook('onRequest', async (req, reply) => {
    const entrante = String(req.headers['x-correlation-id'] ?? '');
    req.correlacion = /^[\w-]{8,64}$/.test(entrante) ? entrante : req.id;
    reply.header('x-correlation-id', req.correlacion);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (config.cookieSegura) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    // Protección CSRF complementaria a SameSite=Lax: una escritura con Origin ajeno se rechaza.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/') && !SIN_ORIGEN.test(req.url)) {
      const origin = req.headers.origin;
      if (origin && !origenPermitido(origin)) throw new AppError('FORBIDDEN', 'Solicitud de un origen no permitido.');
    }
  });

  app.setErrorHandler(async (err: any, req, reply) => {
    if (err instanceof AppError) {
      // Denegación de permiso: la evidencia se registra en una transacción aparte.
      const a = (err.details as any)?.audit;
      if (a && req.ctx) {
        await db.withTenant(req.ctx.tenantId, (tx) => audit(tx, req.ctx!, { accion: a.accion, recurso: a.recurso, resultado: 'DENEGADO', detalle: { motivo: a.motivo, ruta: req.routeOptions?.url ?? req.url, metodo: req.method } })).catch(() => {});
      }
      if (err.code === 'NOT_FOUND' && req.ctx && req.method !== 'GET') {
        await db.withTenant(req.ctx.tenantId, (tx) => audit(tx, req.ctx!, { accion: 'recurso.no_encontrado', resultado: 'NO_ENCONTRADO', detalle: { ruta: req.routeOptions?.url ?? req.url, metodo: req.method } })).catch(() => {});
      }
      const details = a ? undefined : err.details;
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: err.issues[0]?.message && !/^(Invalid|Expected|Too)/.test(err.issues[0].message) ? err.issues[0].message : 'Revisa los datos enviados.', details: err.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })) } });
    }
    // Restricciones de la base: mensajes útiles en vez de un error interno.
    if (err?.code === '23505') {
      return reply.status(409).send({ error: { code: 'CONFLICT', message: RESTRICCIONES[err.constraint] ?? 'Ya existe un registro con esos datos.' } });
    }
    if (err?.code === '23503') return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No encontramos eso.' } });
    if (err?.code === '23514' || err?.code === '22P02' || err?.code === '22003') return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Revisa los datos enviados: hay un valor fuera de lo permitido.' } });
    if (err?.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.statusCode === 413 ? 'VALIDATION' : 'VALIDATION', message: err.statusCode === 413 ? 'El archivo o la petición es demasiado grande.' : 'Solicitud no válida.' } });
    }
    // El mensaje y la traza se depuran: una excepción puede arrastrar datos de un cliente o de un proveedor.
    req.log.error({ err: { message: depurar(err?.message), code: err?.code, stack: depurar(err?.stack, 2000) }, correlacion: req.correlacion }, 'error no controlado');
    const ruta = req.routeOptions?.url ?? 'sin-ruta';
    await db.withPlatform((tx) => registrarIncidente(tx, {
      codigo: 'HTTP_ERROR_INTERNO', servicio: servicioDeRuta(ruta), tenantId: req.ctx?.tenantId ?? null, correlacion: req.correlacion,
      detalle: { ruta, metodo: req.method, http_estado: 500 },
    })).catch(() => {});
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Algo falló de nuestro lado. Intenta de nuevo; si persiste, comparte este código con soporte.', correlacion: req.correlacion } });
  });

  // Métricas agregadas (plantilla de ruta, estado y duración; nada más).
  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    registrarPeticion(req.method, req.routeOptions?.url ?? '(sin ruta)', reply.statusCode, reply.elapsedTime);
  });

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/') && !SIN_ORIGEN.test(req.url)) req.user = await loadUser(db, req);
  });

  // Límite de abuso en endpoints públicos costosos (por IP, en memoria del proceso).
  limitador(app, [
    { prefijo: '/api/auth/', metodo: 'POST', max: 30, ventanaS: 60 },
    { prefijo: '/api/onboarding/borradores', metodo: 'POST', max: 20, ventanaS: 60 },
    { prefijo: '/api/publico/', metodo: 'POST', max: 60, ventanaS: 60 },
    { prefijo: '/api/invitaciones/', metodo: 'POST', max: 20, ventanaS: 60 },
    { prefijo: '/api/t/soporte', metodo: 'POST', max: 10, ventanaS: 60 },
  ]);

  // Vivo: el proceso responde. Listo: además la base responde y las migraciones están al día.
  app.get('/api/salud', async () => ({ ok: true, hora: new Date().toISOString() }));
  app.get('/api/salud/listo', async (_req, reply) => {
    const base = await db.ping();
    const migraciones = base ? await db.migrations().catch(() => []) : [];
    const cuerpo = { ok: base, base: base ? 'disponible' : 'sin conexión', migraciones, integraciones: integraciones().map(({ clave, estado }) => ({ clave, estado })) };
    return reply.status(base ? 200 : 503).send(cuerpo);
  });

  await registerPublicRoutes(app, db);
  await registerTenantRoutes(app, db);
  await registerOperatorRoutes(app, db);

  // Panel compilado (producción): SPA servida por el mismo proceso.
  const webDir = opts.webDir ?? resolve(process.cwd(), '../web/dist');
  if (existsSync(join(webDir, 'index.html'))) {
    // index.html con el dominio base en tiempo de ejecución: el panel detecta el subdominio de la
    // empresa sin depender de una variable de compilación.
    const meta = `<meta name="omnegia-dominio" content="${config.baseDomain.replace(/[^a-z0-9.-]/g, '')}">`;
    const indice = readFileSync(join(webDir, 'index.html'), 'utf8').replace('</head>', `${meta}</head>`);
    await app.register(fastifyStatic, {
      root: webDir, wildcard: false, index: false,
      setHeaders: (reply, path) => {
        if (/[\\/]assets[\\/]/.test(path)) reply.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No encontramos eso.' } });
      reply.header('cache-control', 'no-cache');
      return reply.type('text/html; charset=utf-8').send(indice);
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No encontramos eso.' } }));
  }
  return app;
}
