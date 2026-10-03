import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database, Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, MSG_NO_ENCONTRADO } from '../lib/errors.js';
import { sha256, token, uuidv7, verifyPassword } from '../lib/util.js';
import { config } from '../config.js';

/**
 * Identidad y resolución de tenant del panel (PRO-SW-001 §11.2, PRO-SW-002 fig. 04).
 *
 * El subdominio (o la cabecera X-Tenant-Slug en desarrollo) RESUELVE el tenant;
 * no lo AUTORIZA. La autorización exige que la sesión tenga pertenencia activa en
 * ese tenant; un conflicto termina en rechazo explícito («no encontramos eso»)
 * y en un evento de auditoría en el tenant atacado, nunca en reinterpretación.
 */

export interface SessionUser { id: string; email: string; nombre: string; es_admin_plataforma: boolean }

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    correlacion: string;
    user?: SessionUser | null;
    ctx?: Ctx;
  }
}

export const SESSION_COOKIE = 'sid';

export async function createSession(db: Database, email: string, password: string) {
  const u = await db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM users WHERE email=$1`, [email.trim().toLowerCase()])).rows[0]);
  // Mismo tiempo de respuesta y mismo mensaje exista o no el usuario.
  const ok = verifyPassword(password ?? '', u?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  if (!u || !ok) throw new AppError('UNAUTHENTICATED', 'Correo o contraseña incorrectos.');
  const t = token(32);
  await db.withPlatform((tx) => tx.query(`INSERT INTO session (id, user_id, expira_en) VALUES ($1,$2, now() + ($3 || ' days')::interval)`, [sha256(t), u.id, String(config.sessionDays)]));
  return { token: t, user: u };
}

export async function destroySession(db: Database, t: string | undefined) {
  if (t) await db.withPlatform((tx) => tx.query(`DELETE FROM session WHERE id=$1`, [sha256(t)]));
}

export async function loadUser(db: Database, req: FastifyRequest): Promise<SessionUser | null> {
  const t = req.cookies?.[SESSION_COOKIE] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
  if (!t) return null;
  return db.withPlatform(async (tx) =>
    (await tx.query(
      `SELECT u.id, u.email, u.nombre, u.es_admin_plataforma FROM session s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expira_en > now()`,
      [sha256(t)],
    )).rows[0] ?? null,
  );
}

export function slugFromRequest(req: FastifyRequest): string | null {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(':')[0].toLowerCase();
  const base = config.baseDomain.toLowerCase();
  if (host.endsWith('.' + base)) {
    const sub = host.slice(0, -(base.length + 1));
    if (sub && !['www', 'app', 'api'].includes(sub) && /^[a-z0-9-]+$/.test(sub)) return sub;
  }
  const h = req.headers['x-tenant-slug'];
  return typeof h === 'string' && /^[a-z0-9-]{1,40}$/.test(h) ? h : null;
}

export async function memberships(tx: Tx, userId: string) {
  return (await tx.query(
    `SELECT t.id, t.slug, t.nombre, t.tema, r.nombre AS rol FROM user_tenant ut JOIN tenant t ON t.id=ut.tenant_id JOIN role r ON r.id=ut.role_id
     WHERE ut.user_id=$1 AND ut.activo ORDER BY t.nombre`,
    [userId],
  )).rows;
}

/** preHandler: exige sesión + tenant resuelto + pertenencia. Construye el Ctx validado. */
export function tenantGuard(db: Database) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const user = req.user ?? (await loadUser(db, req));
    if (!user) throw new AppError('UNAUTHENTICATED', 'Inicia sesión para continuar.');
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
