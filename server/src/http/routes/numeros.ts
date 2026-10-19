import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../../db/index.js';
import type { Ctx } from '../../core/context.js';
import { auditPlatform } from '../../core/audit.js';
import { config } from '../../config.js';
import { tenantGuard } from '../context.js';
import { verificarRetorno } from '../../modules/billing.js';
import * as numeros from '../../numeros/servicio.js';
import { texmlLlamada, verificarFirmaTelnyx } from '../../numeros/telnyx.js';

type Req = FastifyRequest & { params: any; query: any; body: any };

/**
 * Números de WhatsApp contratados desde Omnegia.
 *  - /api/t/numeros/…              panel de la empresa (sesión + permisos; la RLS limita al tenant)
 *  - /api/webhooks/telnyx          eventos de órdenes (firma Ed25519)
 *  - /api/webhooks/telnyx/voz      llamada entrante (TeXML): la verificación de Meta
 *  - /api/webhooks/telnyx/transcripcion   transcripción de esa llamada (firma + enlace firmado)
 */
export async function registerNumerosRoutes(app: FastifyInstance, db: Database) {
  const guard = tenantGuard(db);
  const rx = (method: 'get' | 'post', path: string, h: (ctx: Ctx, req: Req, reply: FastifyReply) => Promise<unknown>, opts: { bodyLimit?: number } = {}) =>
    app.route({ method: method.toUpperCase() as any, url: `/api/t/numeros${path}`, preHandler: guard, ...opts, handler: (req, reply) => h(req.ctx!, req as Req, reply) });

  rx('get', '/opciones', (ctx) => numeros.opciones(db, ctx));
  rx('get', '/disponibles', (ctx, req) => numeros.buscar(db, ctx, req.query ?? {}));
  rx('get', '/contratacion', (ctx) => numeros.estado(db, ctx));
  rx('post', '/contrataciones', (ctx, req) => numeros.seleccionar(db, ctx, req.body));
  // Los documentos regulatorios viajan en base64 (hasta 4 MB cada uno).
  rx('post', '/contrataciones/:id/requisitos', (ctx, req) => numeros.enviarRequisitos(db, ctx, req.params.id, req.body), { bodyLimit: 14 * 1024 * 1024 });
  rx('post', '/contrataciones/:id/confirmar', (ctx, req) => numeros.confirmar(db, ctx, req.params.id, req.body));
  rx('post', '/contrataciones/:id/meta', (ctx, req) => numeros.vincularMeta(db, ctx, req.params.id, req.body));
  rx('post', '/contrataciones/:id/verificacion/llamada', (ctx, req) => numeros.pedirOtraLlamada(db, ctx, req.params.id, req.body));
  rx('post', '/contrataciones/:id/verificacion/codigo', (ctx, req) => numeros.codigoManual(db, ctx, req.params.id, req.body));
  rx('post', '/contrataciones/:id/reintentar', (ctx, req) => numeros.reintentarConexion(db, ctx, req.params.id));
  rx('post', '/contrataciones/:id/otro-numero', (ctx, req) => numeros.elegirOtro(db, ctx, req.params.id, req.body));
  rx('post', '/contrataciones/:id/renovar', (ctx, req) => numeros.renovar(db, ctx, req.params.id));
  rx('post', '/contrataciones/:id/cancelar', (ctx, req) => numeros.cancelar(db, ctx, req.params.id, req.body));
  // Vuelta del checkout: el servidor consulta la transacción a Wompi (nunca confía en la URL).
  rx('post', '/pago/verificar', (ctx, req) => numeros.verificarPagoRetorno(db, ctx, String(req.body?.id ?? ''), (id) => verificarRetorno(db, id, req.correlacion)));

  const firmaInvalida = async (req: Req, reply: FastifyReply, ruta: string) => {
    await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'webhook' }, 'WEBHOOK', req.correlacion, { accion: `webhook.telnyx.${ruta}.firma_invalida`, resultado: 'DENEGADO' }));
    return reply.status(401).send({ error: { code: 'BAD_SIGNATURE', message: 'Firma inválida' } });
  };
  /** En producción la firma es obligatoria; en simulación se acepta sin llave configurada. */
  const firmaOk = (req: Req) => {
    if (!config.numeros.telnyx.llavePublica) return config.simuladores && config.numeros.proveedor !== 'telnyx';
    return verificarFirmaTelnyx(req.rawBody ?? '', String(req.headers['telnyx-signature-ed25519'] ?? ''), String(req.headers['telnyx-timestamp'] ?? ''));
  };

  app.post('/api/webhooks/telnyx', async (req: any, reply) => {
    if (!firmaOk(req)) return firmaInvalida(req, reply, 'eventos');
    const d = req.body?.data ?? {};
    const pl = d.payload ?? {};
    if (typeof d.id !== 'string' || typeof d.event_type !== 'string') return { ok: true, ignorado: 'sin evento' };
    if (!/number_order/.test(d.event_type) && pl.record_type !== 'number_order') return { ok: true, ignorado: 'evento no relacionado' };
    return numeros.eventoProveedor(db, { id: d.id.slice(0, 80), tipo: d.event_type, ordenId: typeof pl.id === 'string' ? pl.id : null, referencia: typeof pl.customer_reference === 'string' ? pl.customer_reference : null }, req.correlacion);
  });

  // TeXML llega como formulario: el analizador vive solo en este ámbito (no abre formularios en el resto de la API).
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest).rawBody = body as string;
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    sub.post('/api/webhooks/telnyx/voz', async (req: any, reply) => {
      if (!firmaOk(req)) return firmaInvalida(req, reply, 'voz');
      const para = String(req.body?.To ?? req.body?.to ?? '');
      const c = await numeros.llamadaEntrante(db, para);
      reply.type('application/xml');
      // Solo se atienden llamadas mientras Meta verifica el número; el resto se rechaza.
      if (!c) return texmlLlamada({});
      const url = `${config.apiPublicUrl}/api/webhooks/telnyx/transcripcion?c=${c.id}&k=${numeros.firmaVoz(c.id)}`;
      return texmlLlamada({ transcripcion: url, reenviarA: c.reenviarA });
    });

    sub.post('/api/webhooks/telnyx/transcripcion', async (req: any, reply) => {
      if (!firmaOk(req)) return firmaInvalida(req, reply, 'transcripcion');
      const id = String(req.query?.c ?? '');
      if (!numeros.firmaVozValida(id, String(req.query?.k ?? ''))) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No encontramos eso.' } });
      const texto = String(req.body?.Transcript ?? req.body?.transcript ?? '').slice(0, 2000);
      const final = String(req.body?.IsFinal ?? req.body?.is_final ?? 'true') !== 'false';
      if (!texto || !final) return { ok: true };
      const r = await numeros.capturarCodigo(db, id, texto);
      return { ok: true, codigo: r.ok };
    });
  });
}
