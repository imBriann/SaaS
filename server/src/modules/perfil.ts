import type { Database, Tx } from '../db/index.js';
import { type Ctx, requireWritable } from '../core/context.js';
import { audit, auditPlatform } from '../core/audit.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { AppError, invalid } from '../lib/errors.js';
import { sha256, verifyPassword } from '../lib/util.js';
import { config } from '../config.js';
import { emitirOtp, verificarOtp } from './otp.js';
import { enmascararCorreo, fechaLegible, urlRecuperar, type SessionUser } from './auth.js';

/**
 * Perfil de la persona: sus datos propios (no los de una empresa), su correo de acceso,
 * sus sesiones abiertas y la actividad de seguridad de su cuenta.
 *  - El correo solo cambia con la contraseña actual y un código enviado al correo nuevo;
 *    el correo anterior recibe un aviso.
 *  - Cada sesión se identifica ante la persona por un prefijo del hash del token: nunca
 *    se expone un valor que sirva para entrar.
 */
const SIN_SESION = 'Tu sesión terminó. Inicia sesión de nuevo.';
const ID_SESION = 12;
const FOTO = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;
const FOTO_MAX = 200_000;

/** Acciones que la persona ve como «actividad de tu cuenta». */
const ACTIVIDAD = ['sesion.contrasena_cambiada', 'sesion.contrasena_restablecida', 'sesion.recuperacion_solicitada', 'sesion.bloqueada',
  'sesion.segundo_factor_completado', 'sesion.segundo_factor_fallido', 'sesion.cerrada', 'sesion.cerradas_otras', 'usuario.correo_verificado',
  'perfil.actualizado', 'perfil.correo_solicitado', 'perfil.correo_cambiado'];

const actor = (u: SessionUser) => ({ tipo: 'USUARIO' as const, id: u.id, nombre: u.email });

export function normalizarTelefono(v: unknown): string | null {
  const t = String(v ?? '').replace(/[\s().-]/g, '');
  if (!t) return null;
  if (!/^\+?\d{7,15}$/.test(t)) throw invalid('Escribe un teléfono válido (solo números, con indicativo si es de otro país).');
  return t;
}

export async function perfil(db: Database, user: SessionUser, tokenActual: string | undefined) {
  return db.withPlatform(async (tx) => {
    const u = (await tx.query(
      `SELECT nombre, email, telefono, foto_data_url, correo_pendiente, email_verificado_en, contrasena_cambiada_en, creado_en, actualizado_en,
              (password_hash IS NOT NULL) AS tiene_contrasena
       FROM users WHERE id=$1`, [user.id])).rows[0];
    if (!u) throw new AppError('UNAUTHENTICATED', SIN_SESION);
    const actual = tokenActual ? sha256(tokenActual) : '';
    const sesiones = (await tx.query(
      `SELECT left(id, ${ID_SESION}) AS id, agente, creado_en, ultimo_uso, segundo_factor, (id = $2) AS actual
       FROM session WHERE user_id=$1 AND expira_en > now() AND ultimo_uso > now() - ($3 || ' hours')::interval
       ORDER BY (id = $2) DESC, ultimo_uso DESC LIMIT 30`,
      [user.id, actual, String(config.sesion.inactividadHoras)])).rows;
    const actividad = (await tx.query(
      `SELECT accion, resultado, creado_en FROM audit_event
       WHERE actor_id=$1 AND tenant_id IS NULL AND accion = ANY($2) ORDER BY creado_en DESC LIMIT 12`,
      [user.id, ACTIVIDAD])).rows;
    const empresas = (await tx.query(
      `SELECT t.slug, t.nombre, t.tema, r.nombre AS rol, (t.propietario_id = ut.user_id) AS propietario, ut.nombre_visible, ut.disponible, ut.creado_en AS desde
       FROM user_tenant ut JOIN tenant t ON t.id=ut.tenant_id JOIN role r ON r.id=ut.role_id
       WHERE ut.user_id=$1 AND ut.activo ORDER BY t.nombre`, [user.id])).rows;
    return {
      nombre: u.nombre, email: u.email, telefono: u.telefono, foto: u.foto_data_url,
      correo_verificado: !!u.email_verificado_en, correo_pendiente: u.correo_pendiente,
      tiene_contrasena: !!u.tiene_contrasena, contrasena_cambiada_en: u.contrasena_cambiada_en,
      creado_en: u.creado_en, actualizado_en: u.actualizado_en, segundo_factor: !!user.segundo_factor,
      sesiones, actividad, empresas,
    };
  });
}

/** Datos personales: nombre, teléfono y foto. El correo tiene su propio flujo con código. */
export async function actualizarPerfil(db: Database, user: SessionUser, body: Record<string, unknown>, correlacion: string) {
  const cambios: Record<string, unknown> = {};
  if (body.nombre !== undefined) {
    const nombre = String(body.nombre ?? '').replace(/\s+/g, ' ').trim();
    if (nombre.length < 2 || nombre.length > 80) throw invalid('Escribe tu nombre (entre 2 y 80 caracteres).');
    if (/[<>{}]/.test(nombre)) throw invalid('El nombre no puede tener los caracteres < > { }.');
    cambios.nombre = nombre;
  }
  if (body.telefono !== undefined) cambios.telefono = normalizarTelefono(body.telefono);
  if (body.foto !== undefined) {
    if (body.foto === null || body.foto === '') cambios.foto_data_url = null;
    else {
      const f = String(body.foto);
      if (f.length > FOTO_MAX) throw invalid('La foto es muy pesada. Usa una imagen más pequeña.');
      if (!FOTO.test(f)) throw invalid('La foto debe ser una imagen PNG, JPG o WebP.');
      cambios.foto_data_url = f;
    }
  }
  const campos = Object.keys(cambios);
  if (!campos.length) throw invalid('No hay cambios para guardar.');
  return db.withPlatform(async (tx) => {
    await tx.query(`UPDATE users SET ${campos.map((c, i) => `${c}=$${i + 2}`).join(', ')}, actualizado_en=now() WHERE id=$1`, [user.id, ...campos.map((c) => cambios[c])]);
    await auditPlatform(tx, null, actor(user), 'PANEL', correlacion, { accion: 'perfil.actualizado', resultado: 'EXITO', detalle: { campos: campos.map((c) => (c === 'foto_data_url' ? 'foto' : c)) } });
    return { ok: true };
  });
}

// ------------------------------------------------------------------ cambio de correo
export async function solicitarCambioCorreo(db: Database, user: SessionUser, body: Record<string, unknown>, ip: string, correlacion: string) {
  const nuevo = String(body.nuevo ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(nuevo) || nuevo.length > 254) throw invalid('Escribe un correo válido.');
  if (nuevo === user.email) throw invalid('Ese ya es el correo de tu cuenta.');
  return db.withPlatform(async (tx) => {
    const u = (await tx.query(`SELECT nombre, password_hash FROM users WHERE id=$1`, [user.id])).rows[0];
    if (!u) throw new AppError('UNAUTHENTICATED', SIN_SESION);
    if (!u.password_hash) throw new AppError('CONFLICT', 'Primero crea una contraseña para tu cuenta.');
    if (!verifyPassword(String(body.contrasena ?? ''), u.password_hash)) throw invalid('La contraseña actual no es correcta.');
    const ocupado = (await tx.query(`SELECT 1 FROM users WHERE email=$1`, [nuevo])).rows.length > 0;
    if (ocupado) throw new AppError('CONFLICT', 'Ese correo no está disponible para tu cuenta.');
    const otp = await emitirOtp(tx, { userId: user.id, proposito: 'CAMBIAR_CORREO', ip });
    await tx.query(`UPDATE users SET correo_pendiente=$2 WHERE id=$1`, [user.id, nuevo]);
    await encolarCorreo(tx, { tenantId: null, userId: user.id, para: nuevo, sensible: true, caducaEn: new Date(Date.now() + otp.minutos * 60_000),
      correo: plantillas.codigoCambioCorreo({ nombre: u.nombre, codigo: otp.codigo, minutos: otp.minutos }) });
    await auditPlatform(tx, null, actor(user), 'PANEL', correlacion, { accion: 'perfil.correo_solicitado', resultado: 'EXITO', detalle: { destino: enmascararCorreo(nuevo) } });
    return { ok: true, destino: nuevo, minutos: otp.minutos };
  });
}

export async function confirmarCambioCorreo(db: Database, user: SessionUser, codigo: unknown, correlacion: string) {
  const pendiente = await db.withPlatform(async (tx) => (await tx.query(`SELECT correo_pendiente FROM users WHERE id=$1`, [user.id])).rows[0]?.correo_pendiente as string | null);
  if (!pendiente) throw new AppError('CONFLICT', 'No hay un cambio de correo en curso.');
  await verificarOtp(db, { proposito: 'CAMBIAR_CORREO', codigo, userId: user.id });
  return db.withPlatform(async (tx) => {
    const u = (await tx.query(`SELECT nombre, email, correo_pendiente FROM users WHERE id=$1 FOR UPDATE`, [user.id])).rows[0];
    if (!u?.correo_pendiente || u.correo_pendiente !== pendiente) throw new AppError('CONFLICT', 'El cambio de correo ya no está vigente. Pídelo de nuevo.');
    if ((await tx.query(`SELECT 1 FROM users WHERE email=$1 AND id <> $2`, [pendiente, user.id])).rows.length) throw new AppError('CONFLICT', 'Ese correo no está disponible para tu cuenta.');
    await tx.query(`UPDATE users SET email=$2, email_verificado_en=now(), correo_pendiente=NULL, actualizado_en=now() WHERE id=$1`, [user.id, pendiente]);
    await encolarCorreo(tx, { tenantId: null, userId: user.id, para: u.email,
      correo: plantillas.correoCambiado({ nombre: u.nombre, nuevo: pendiente, cuando: `${fechaLegible()} (hora de Colombia)`, urlRecuperar: urlRecuperar() }) });
    await auditPlatform(tx, null, actor(user), 'PANEL', correlacion, { accion: 'perfil.correo_cambiado', resultado: 'EXITO', detalle: { anterior: enmascararCorreo(u.email), nuevo: enmascararCorreo(pendiente) } });
    return { ok: true, email: pendiente };
  });
}

export async function cancelarCambioCorreo(db: Database, user: SessionUser) {
  await db.withPlatform(async (tx) => {
    await tx.query(`UPDATE users SET correo_pendiente=NULL WHERE id=$1`, [user.id]);
    await tx.query(`UPDATE otp_code SET invalidado_en=now() WHERE user_id=$1 AND proposito='CAMBIAR_CORREO' AND usado_en IS NULL AND invalidado_en IS NULL`, [user.id]);
  });
  return { ok: true };
}

// ------------------------------------------------------------------ sesiones
/** Cierra una sesión propia por su identificador corto. La sesión actual se cierra con «Cerrar sesión». */
export async function cerrarSesion(db: Database, user: SessionUser, id: string, tokenActual: string | undefined, correlacion: string) {
  if (!new RegExp(`^[0-9a-f]{${ID_SESION}}$`).test(id)) throw invalid('Sesión no válida.');
  return db.withPlatform(async (tx) => {
    const actual = tokenActual ? sha256(tokenActual) : '';
    if (actual.startsWith(id)) throw new AppError('CONFLICT', 'Esta es la sesión que estás usando. Usa «Cerrar sesión».');
    const r = await tx.query(`DELETE FROM session WHERE user_id=$1 AND left(id, ${ID_SESION})=$2 AND id <> $3 RETURNING 1`, [user.id, id, actual]);
    if (!r.rows.length) throw new AppError('NOT_FOUND', 'Esa sesión ya no está abierta.');
    await auditPlatform(tx, null, actor(user), 'PANEL', correlacion, { accion: 'sesion.cerrada', resultado: 'EXITO' });
    return { ok: true };
  });
}

export async function cerrarOtrasSesiones(db: Database, user: SessionUser, tokenActual: string | undefined, correlacion: string) {
  return db.withPlatform(async (tx) => {
    const r = await tx.query(`DELETE FROM session WHERE user_id=$1 AND id <> $2 RETURNING 1`, [user.id, tokenActual ? sha256(tokenActual) : '']);
    await auditPlatform(tx, null, actor(user), 'PANEL', correlacion, { accion: 'sesion.cerradas_otras', resultado: 'EXITO', detalle: { cerradas: r.rows.length } });
    return { ok: true, cerradas: r.rows.length };
  });
}

/** Copia de los datos personales de la cuenta (derecho de acceso). Sin hashes ni tokens. */
export async function exportarDatos(db: Database, user: SessionUser, tokenActual: string | undefined) {
  const p = await perfil(db, user, tokenActual);
  return {
    generado_en: new Date().toISOString(),
    cuenta: { nombre: p.nombre, email: p.email, telefono: p.telefono, correo_verificado: p.correo_verificado, creado_en: p.creado_en, tiene_foto: !!p.foto },
    empresas: p.empresas.map((e: any) => ({ empresa: e.nombre, direccion: e.slug, rol: e.rol, propietario: e.propietario, nombre_en_la_empresa: e.nombre_visible, desde: e.desde })),
    sesiones_abiertas: p.sesiones.map((s: any) => ({ dispositivo: s.agente, abierta_en: s.creado_en, ultimo_uso: s.ultimo_uso })),
    actividad_reciente: p.actividad,
  };
}

// ------------------------------------------------------------------ en la empresa actual
/** Cómo ve a la persona esta empresa (nombre visible) y si está disponible para atender. */
export async function actualizarEnEmpresa(tx: Tx, ctx: Ctx, body: Record<string, unknown>) {
  requireWritable(ctx);
  const sets: string[] = [];
  const vals: unknown[] = [ctx.actor.id];
  const detalle: Record<string, unknown> = {};
  if (body.nombre_visible !== undefined) {
    const n = body.nombre_visible === null ? '' : String(body.nombre_visible).replace(/\s+/g, ' ').trim();
    if (n && (n.length < 2 || n.length > 80 || /[<>{}]/.test(n))) throw invalid('El nombre en la empresa debe tener entre 2 y 80 caracteres, sin < > { }.');
    vals.push(n || null); sets.push(`nombre_visible=$${vals.length}`); detalle.nombre_visible = n ? 'propio' : 'el de tu cuenta';
  }
  if (body.disponible !== undefined) { vals.push(!!body.disponible); sets.push(`disponible=$${vals.length}`); detalle.disponible = !!body.disponible; }
  if (!sets.length) throw invalid('No hay cambios para guardar.');
  await tx.query(`UPDATE user_tenant SET ${sets.join(', ')} WHERE user_id=$1`, vals);
  await audit(tx, ctx, { accion: 'usuario.perfil_empresa', recurso: 'user', recursoId: ctx.actor.id, resultado: 'EXITO', detalle });
  return { ok: true };
}
