import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ZodError } from 'zod';
import type { Database, Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { audit } from '../core/audit.js';
import { AppError } from '../lib/errors.js';
import { config } from '../config.js';
import { newCorrelation, loadUser } from './context.js';
import { registerPublicRoutes } from './routes/public.js';
import { registerTenantRoutes } from './routes/tenant.js';

export type Handler<T = unknown> = (tx: Tx, ctx: Ctx, req: FastifyRequest<any>, reply: FastifyReply) => Promise<T>;

export async function buildApp(db: Database, opts: { logger?: boolean; webDir?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false, bodyLimit: 2 * 1024 * 1024, trustProxy: true });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  // Cuerpo crudo disponible para verificar firmas de webhooks (HMAC sobre los bytes recibidos).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(new AppError('VALIDATION', 'JSON inválido'), undefined); }
  });

  app.addHook('onRequest', async (req, reply) => {
    req.correlacion = String(req.headers['x-correlation-id'] ?? '') || newCorrelation();
    reply.header('x-correlation-id', req.correlacion);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
  });

  app.setErrorHandler(async (err: any, req, reply) => {
    if (err instanceof AppError) {
      // Denegación de permiso: la evidencia se registra en una transacción aparte.
      const a = (err.details as any)?.audit;
      if (a && req.ctx) {
        await db.withTenant(req.ctx.tenantId, (tx) => audit(tx, req.ctx!, { accion: a.accion, recurso: a.recurso, resultado: 'DENEGADO', detalle: { motivo: a.motivo, ruta: req.url, metodo: req.method } })).catch(() => {});
      }
      if (err.code === 'NOT_FOUND' && req.ctx && req.method !== 'GET') {
        await db.withTenant(req.ctx.tenantId, (tx) => audit(tx, req.ctx!, { accion: 'recurso.no_encontrado', resultado: 'NO_ENCONTRADO', detalle: { ruta: req.url, metodo: req.method } })).catch(() => {});
      }
      const details = a ? undefined : err.details;
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'Revisa los datos enviados.', details: err.issues.map((i) => ({ campo: i.path.join('.'), mensaje: i.message })) } });
    }
    if (err?.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'VALIDATION', message: err.message } });
    }
    req.log.error(err);
    if (process.env.NODE_ENV !== 'test') console.error(`[${req.correlacion}]`, err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Algo falló de nuestro lado. Intenta de nuevo.', correlacion: req.correlacion } });
  });

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (req) => {
    if (req.url.startsWith('/api/')) req.user = await loadUser(db, req);
  });

  app.get('/api/salud', async () => ({ ok: true, llm: config.llm.provider, hora: new Date().toISOString() }));

  await registerPublicRoutes(app, db);
  await registerTenantRoutes(app, db);

  // Panel compilado (producción): SPA servida por el mismo proceso.
  const webDir = opts.webDir ?? resolve(process.cwd(), '../web/dist');
  if (existsSync(join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No encontramos eso.' } });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
