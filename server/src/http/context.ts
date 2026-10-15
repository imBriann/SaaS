import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database, Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, MSG_NO_ENCONTRADO } from '../lib/errors.js';
import { uuidv7 } from '../lib/util.js';
import { config } from '../config.js';
import { loadUserByToken, type SessionUser } from '../modules/auth.js';

/**
 * Identidad y resolución de tenant del panel.
 *
 * El subdominio (o la cabecera X-Tenant-Slug cuando el panel corre sin subdominio)
 * RESUELVE el tenant; no lo AUTORIZA. La autorización exige una sesión con
 * pertenencia activa en ese tenant; un conflicto termina en «no encontramos eso»
 * y en un evento de auditoría en el tenant atacado, nunca en reinterpretación.
 */
export type { SessionUser };

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    correlacion: string;
    user?: SessionUser | null;
    ctx?: Ctx;
  }
}

export const SESSION_COOKIE = 'sid';

export function sessionToken(req: FastifyRequest): string | undefined {
  return req.cookies?.[SESSION_COOKIE] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
}

export async function loadUser(db: Database, req: FastifyRequest): Promise<SessionUser | null> {
  const t = sessionToken(req);
  if (!t || t.length > 200) return null;
  return loadUserByToken(db, t);
}

export function cookieSesion() {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.cookieSegura, maxAge: config.sesion.dias * 86400, ...(config.cookieDominio ? { domain: config.cookieDominio } : {}) };
}

/** Opciones para borrar la cookie: deben coincidir en ruta y dominio con las de creación. */
export function cookieBorrar() {
  return { path: '/', ...(config.cookieDominio ? { domain: config.cookieDominio } : {}) };
}

export function slugFromRequest(req: FastifyRequest): string | null {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim().split(':')[0].toLowerCase();
  const base = config.baseDomain;
  if (host.endsWith('.' + base)) {
    const sub = host.slice(0, -(base.length + 1));
    if (sub && !['www', 'app', 'api'].includes(sub) && /^[a-z0-9-]+$/.test(sub)) return sub;
  }
  const h = req.headers['x-tenant-slug'];
  return typeof h === 'string' && /^[a-z0-9-]{1,40}$/.test(h) ? h : null;
}

export async function memberships(tx: Tx, userId: string) {
  return (await tx.query(
    `SELECT t.id, t.slug, t.nombre, t.tema, r.nombre AS rol, s.estado AS suscripcion FROM user_tenant ut JOIN tenant t ON t.id=ut.tenant_id JOIN role r ON r.id=ut.role_id
     LEFT JOIN subscription s ON s.tenant_id=t.id
     WHERE ut.user_id=$1 AND ut.activo ORDER BY t.nombre`,
    [userId],
  )).rows;
}

/** preHandler: exige sesión + tenant resuelto + pertenencia. Construye el Ctx validado. */
export function tenantGuard(db: Database) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user ?? (await loadUser(db, req));
    if (!user) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
    const slug = slugFromRequest(req);
    if (!slug) throw new AppError('NOT_FOUND', MSG_NO_ENCONTRADO);
    const data = await db.withPlatform(async (tx) => {
      const t = (await tx.query(`SELECT t.id, s.estado FROM tenant t LEFT JOIN subscription s ON s.tenant_id=t.id WHERE t.slug=$1`, [slug])).rows[0];
      if (!t) return { t: null };
      const m = (await tx.query(
        `SELECT r.clave, coalesce(array_agg(rp.permiso) FILTER (WHERE rp.permiso IS NOT NULL), '{}') AS permisos
         FROM user_tenant ut JOIN role r ON r.id=ut.role_id LEFT JOIN role_permission rp ON rp.role_id=r.id
         WHERE ut.user_id=$1 AND ut.tenant_id=$2 AND ut.activo AND NOT r.es_agente GROUP BY r.clave`,
        [user.id, t.id],
      )).rows[0];
      if (!m) {
        await auditPlatform(tx, t.id, { tipo: 'USUARIO', id: user.id, nombre: user.email }, 'PANEL', req.correlacion, {
          accion: 'acceso.cruzado', recurso: 'tenant', recursoId: t.id, resultado: 'NO_ENCONTRADO',
          detalle: { ruta: req.routeOptions?.url ?? req.url, metodo: req.method, motivo: 'sin_pertenencia' },
        });
      }
      return { t, m };
    });
    if (!data.t || !data.m) throw new AppError('NOT_FOUND', MSG_NO_ENCONTRADO);
    if (data.t.estado === 'CANCELADA') throw new AppError('SUSPENDED', 'La suscripción de esta empresa fue cancelada.');
    req.user = user;
    req.ctx = {
      tenantId: data.t.id,
      actor: { tipo: 'USUARIO', id: user.id, nombre: user.nombre },
      roleKey: data.m.clave,
      permisos: new Set<string>(data.m.permisos),
      origen: 'PANEL',
      correlacion: req.correlacion,
      soloLectura: data.t.estado === 'SUSPENDIDA',
    };
    void reply;
  };
}

export const newCorrelation = () => uuidv7();
