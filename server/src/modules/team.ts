import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit, auditPlatform } from '../core/audit.js';
import { encolarCorreo } from '../email/servicio.js';
import { correoReal } from '../email/proveedores.js';
import * as plantillas from '../email/plantillas.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { hashPassword, isUuid, sha256, token, uuidv7, verifyPassword } from '../lib/util.js';
import { config } from '../config.js';
import { validarContrasena } from './auth.js';

/**
 * Equipo: invitaciones con token de un solo uso, vencimiento y revocación. Una
 * misma identidad puede pertenecer a varias empresas (user_tenant).
 */
export const DIAS_INVITACION = 7;

const InvitacionInput = z.object({ email: z.email('Correo no válido.'), nombre: z.string().trim().min(2, 'Escribe el nombre.').max(80), rol: z.string().min(1) });

async function cupos(tx: Tx, ctx: Ctx) {
  const plan = (await tx.query(`SELECT p.max_usuarios FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo WHERE t.id=$1`, [ctx.tenantId])).rows[0];
  const usados = (await tx.query(
    `SELECT (SELECT count(*)::int FROM user_tenant WHERE activo) + (SELECT count(*)::int FROM invitation WHERE estado='PENDIENTE' AND expira_en > now()) AS n`)).rows[0].n;
  return { max: Number(plan.max_usuarios), usados: Number(usados) };
}

async function enviarInvitacion(tx: Tx, ctx: Ctx, inv: { email: string; nombre: string }, rolNombre: string, t: string) {
  const empresa = (await tx.query(`SELECT nombre FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0].nombre;
  const url = `${config.publicUrl}/invitacion?token=${t}`;
  await encolarCorreo(tx, {
    tenantId: ctx.tenantId, para: inv.email, sensible: true, caducaEn: new Date(Date.now() + DIAS_INVITACION * 86_400_000),
    correo: plantillas.invitacion({ nombre: inv.nombre, invitador: ctx.actor.nombre, empresa, rol: rolNombre, url, dias: DIAS_INVITACION }),
  });
  return url;
}

export async function invite(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'user:manage');
  requireWritable(ctx);
  const d = InvitacionInput.parse(body);
  const email = d.email.toLowerCase();
  // Solo quien confirmó su correo puede invitar (evita usar la plataforma para enviar correos a terceros).
  const yo = (await tx.query(`SELECT email_verificado_en FROM users WHERE id=$1`, [ctx.actor.id])).rows[0];
  if (!yo?.email_verificado_en) throw new AppError('CONFLICT', 'Confirma tu correo antes de invitar a otras personas. Te enviamos un código desde el aviso del panel.');
  const rol = (await tx.query(`SELECT id, nombre, es_agente FROM role WHERE clave=$1`, [d.rol])).rows[0];
  if (!rol || rol.es_agente) throw invalid('Rol no válido para una persona.');
  const miembro = (await tx.query(`SELECT ut.activo FROM user_tenant ut JOIN users u ON u.id=ut.user_id WHERE u.email=$1`, [email])).rows[0];
  if (miembro?.activo) throw new AppError('CONFLICT', 'Esa persona ya tiene acceso a esta empresa.');
  // Una invitación pendiente al mismo correo se reemplaza (la anterior deja de servir).
  await tx.query(`UPDATE invitation SET estado='REVOCADA' WHERE lower(email)=$1 AND estado='PENDIENTE'`, [email]);
  const c = await cupos(tx, ctx);
  if (c.usados >= c.max) throw new AppError('CONFLICT', `Tu plan permite ${c.max} personas (incluye invitaciones pendientes). Cambia de plan o retira el acceso a alguien.`);
  const t = token(24);
  const id = uuidv7();
  await tx.query(
    `INSERT INTO invitation (id, tenant_id, email, nombre, role_id, token_hash, expira_en, invitado_por) VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval, $8)`,
    [id, ctx.tenantId, email, d.nombre, rol.id, sha256(t), String(DIAS_INVITACION), ctx.actor.id],
  );
  const url = await enviarInvitacion(tx, ctx, { email, nombre: d.nombre }, rol.nombre, t);
  await audit(tx, ctx, { accion: 'usuario.invitar', recurso: 'invitation', recursoId: id, resultado: 'EXITO', detalle: { rol: d.rol } });
  // Sin correo conectado, quien invita recibe el enlace para compartirlo por un canal seguro.
  return { id, enlace: correoReal() ? null : url, correo_enviado: correoReal() };
}

export async function listInvitations(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'user:manage');
  return (await tx.query(
    `SELECT i.id, i.email, i.nombre, r.nombre AS rol, i.creado_en, i.expira_en, i.aceptada_en,
            CASE WHEN i.estado='PENDIENTE' AND i.expira_en <= now() THEN 'EXPIRADA' ELSE i.estado END AS estado
     FROM invitation i JOIN role r ON r.id=i.role_id ORDER BY i.creado_en DESC LIMIT 50`)).rows;
}

export async function revokeInvitation(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'user:manage');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const r = await tx.query(`UPDATE invitation SET estado='REVOCADA' WHERE id=$1 AND estado='PENDIENTE' RETURNING id`, [id]);
  if (!r.rows[0]) throw new AppError('CONFLICT', 'La invitación ya no está pendiente.');
  await audit(tx, ctx, { accion: 'usuario.invitacion_revocada', recurso: 'invitation', recursoId: id, resultado: 'EXITO' });
  return { ok: true };
}

export async function resendInvitation(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'user:manage');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const inv = (await tx.query(`SELECT i.*, r.nombre AS rol FROM invitation i JOIN role r ON r.id=i.role_id WHERE i.id=$1 FOR UPDATE OF i`, [id])).rows[0];
  if (!inv) throw notFound();
  if (inv.estado !== 'PENDIENTE') throw new AppError('CONFLICT', 'Solo se reenvía una invitación pendiente o vencida.');
  const t = token(24);
  await tx.query(`UPDATE invitation SET token_hash=$2, expira_en=now() + ($3 || ' days')::interval WHERE id=$1`, [id, sha256(t), String(DIAS_INVITACION)]);
  const url = await enviarInvitacion(tx, ctx, inv, inv.rol, t);
  await audit(tx, ctx, { accion: 'usuario.invitacion_reenviada', recurso: 'invitation', recursoId: id, resultado: 'EXITO' });
  return { ok: true, enlace: correoReal() ? null : url };
}

async function cargarInvitacion(db: Database, t: string) {
  if (!t || t.length < 20) throw notFound();
  const inv = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT i.*, r.nombre AS rol, te.nombre AS empresa, te.slug, u.id AS user_id, (u.password_hash IS NOT NULL) AS tiene_contrasena
     FROM invitation i JOIN role r ON r.id=i.role_id JOIN tenant te ON te.id=i.tenant_id LEFT JOIN users u ON u.email=lower(i.email)
     WHERE i.token_hash=$1`, [sha256(t)])).rows[0]);
  if (!inv) throw notFound();
  return inv;
}

/** Datos mínimos para la pantalla de aceptación (el token es la única credencial). */
export async function invitationInfo(db: Database, t: string) {
  const inv = await cargarInvitacion(db, t);
  const estado = inv.estado === 'PENDIENTE' && new Date(inv.expira_en) <= new Date() ? 'EXPIRADA' : inv.estado;
  return { estado, empresa: inv.empresa, slug: inv.slug, email: inv.email, nombre: inv.nombre, rol: inv.rol, cuenta_existente: !!inv.tiene_contrasena };
}

export async function acceptInvitation(db: Database, t: string, body: { password?: string }, correlacion: string) {
  const inv = await cargarInvitacion(db, t);
  if (inv.estado === 'REVOCADA') throw new AppError('CONFLICT', 'Esta invitación fue retirada. Pide una nueva a quien te invitó.');
  if (inv.estado === 'ACEPTADA') throw new AppError('CONFLICT', 'Esta invitación ya se usó. Inicia sesión.');
  if (new Date(inv.expira_en) <= new Date()) throw new AppError('CONFLICT', 'La invitación venció. Pide a quien te invitó que la reenvíe.');
  return db.withPlatform(async (tx) => {
    const fila = (await tx.query(`SELECT estado FROM invitation WHERE id=$1 FOR UPDATE`, [inv.id])).rows[0];
    if (fila.estado !== 'PENDIENTE') throw new AppError('CONFLICT', 'Esta invitación ya se usó. Inicia sesión.');
    let userId: string = inv.user_id;
    if (userId && inv.tiene_contrasena) {
      // Cuenta existente: se confirma con su contraseña actual (no se cambia).
      const u = (await tx.query(`SELECT password_hash FROM users WHERE id=$1`, [userId])).rows[0];
      if (!verifyPassword(String(body.password ?? ''), u.password_hash)) throw new AppError('VALIDATION', 'La contraseña no coincide con tu cuenta existente.');
    } else {
      const pw = validarContrasena(body.password);
      // El token llegó por correo: aceptarlo prueba que el correo es de la persona.
      if (userId) await tx.query(`UPDATE users SET password_hash=$2, email_verificado_en=coalesce(email_verificado_en, now()) WHERE id=$1`, [userId, hashPassword(pw)]);
      else {
        userId = uuidv7();
        await tx.query(`INSERT INTO users (id, email, nombre, password_hash, email_verificado_en) VALUES ($1,$2,$3,$4, now())`, [userId, inv.email.toLowerCase(), inv.nombre, hashPassword(pw)]);
      }
    }
    await tx.query(
      `INSERT INTO user_tenant (user_id, tenant_id, role_id) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role_id=EXCLUDED.role_id, activo=true`, [userId, inv.tenant_id, inv.role_id]);
    await tx.query(`UPDATE invitation SET estado='ACEPTADA', aceptada_en=now() WHERE id=$1`, [inv.id]);
    await auditPlatform(tx, inv.tenant_id, { tipo: 'USUARIO', id: userId, nombre: inv.email }, 'PANEL', correlacion, { accion: 'usuario.invitacion_aceptada', recurso: 'invitation', recursoId: inv.id, resultado: 'EXITO' });
    // Aviso de incorporación a quien invitó.
    const quien = inv.invitado_por ? (await tx.query(`SELECT id, nombre, email FROM users WHERE id=$1`, [inv.invitado_por])).rows[0] : null;
    if (quien) {
      await encolarCorreo(tx, { tenantId: inv.tenant_id, userId: quien.id, para: quien.email,
        correo: plantillas.incorporacion({ nombre: quien.nombre, miembro: inv.nombre, empresa: inv.empresa, rol: inv.rol, urlEquipo: `${config.publicUrl}/configuracion` }) });
    }
    return { ok: true, email: inv.email, slug: inv.slug };
  });
}
