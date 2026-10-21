import type { Database, Tx } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { AppError, invalid } from '../lib/errors.js';
import { hashPassword, sha256, token, verifyPassword } from '../lib/util.js';
import { config } from '../config.js';
import { emitirOtp, hashDesafio, verificarOtp } from './otp.js';

/**
 * Identidad: inicio y cierre de sesión, segundo factor del operador, verificación
 * del correo, recuperación y cambio de contraseña. El token de sesión es opaco; en
 * la base solo se guarda su hash.
 */
export type RolPlataforma = 'ADMIN' | 'SOPORTE';
export interface SessionUser {
  id: string;
  email: string;
  nombre: string;
  /** Compatibilidad: true si la persona tiene un rol de plataforma. */
  es_admin_plataforma: boolean;
  rol_plataforma: RolPlataforma | null;
  correo_verificado: boolean;
  /** La sesión se abrió con segundo factor (obligatorio para el panel del operador). */
  segundo_factor: boolean;
}

export const CONTRASENA_MIN = 10;
const HASH_FICTICIO = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const RESET_MINUTOS = 60;
/** Tiempo que vive un desafío de segundo factor (se pueden pedir códigos nuevos dentro de él). */
const DESAFIO_MINUTOS = 15;

export function validarContrasena(pw: unknown): string {
  const s = String(pw ?? '');
  if (s.length < CONTRASENA_MIN) throw invalid(`La contraseña debe tener al menos ${CONTRASENA_MIN} caracteres.`);
  if (s.length > 200) throw invalid('La contraseña es demasiado larga.');
  if (/^(.)\1+$/.test(s)) throw invalid('Usa una contraseña menos predecible.');
  return s;
}

const claveCorreo = (email: string) => `correo:${sha256(email.trim().toLowerCase()).slice(0, 32)}`;
const claveIp = (ip: string) => `ip:${sha256(ip).slice(0, 32)}`;
export const enmascararCorreo = (c: string) => c.replace(/^(.)(.*?)(.)?@/, (_m, a, _b, z) => `${a}${'•'.repeat(3)}${z ?? ''}@`);
const urlRecuperar = () => `${config.publicUrl}/recuperar`;

const aSesion = (u: any, segundoFactor: boolean): SessionUser => ({
  id: u.id, email: u.email, nombre: u.nombre,
  es_admin_plataforma: !!u.rol_plataforma, rol_plataforma: u.rol_plataforma ?? null,
  correo_verificado: !!u.email_verificado_en, segundo_factor: segundoFactor,
});

async function crearSesion(tx: Tx, userId: string, agente: string | undefined, segundoFactor: boolean) {
  const t = token(32);
  await tx.query(`INSERT INTO session (id, user_id, expira_en, agente, segundo_factor) VALUES ($1,$2, now() + ($3 || ' days')::interval, $4, $5)`,
    [sha256(t), userId, String(config.sesion.dias), (agente ?? '').slice(0, 200), segundoFactor]);
  await tx.query(`DELETE FROM session WHERE expira_en < now() - interval '1 day'`);
  await tx.query(`DELETE FROM login_attempt WHERE creado_en < now() - interval '2 days'`);
  return t;
}

export type ResultadoLogin =
  | { tipo: 'sesion'; token: string; user: SessionUser }
  | { tipo: 'segundo_factor'; desafio: string; destino: string; minutos: number };

export async function login(db: Database, email: string, password: string, meta: { ip: string; agente?: string; correlacion: string }): Promise<ResultadoLogin> {
  const correo = String(email ?? '').trim().toLowerCase();
  const claves = [claveCorreo(correo), claveIp(meta.ip)];
  const fallos = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT clave, count(*)::int AS n FROM login_attempt WHERE clave = ANY($1) AND NOT exito AND creado_en > now() - ($2 || ' minutes')::interval GROUP BY clave`,
    [claves, String(config.login.ventanaMin)])).rows);
  // La IP comparte cupo entre varias cuentas: se le permite el triple antes de bloquear.
  const bloqueado = fallos.some((f: any) => f.n >= (f.clave.startsWith('ip:') ? config.login.maxIntentos * 3 : config.login.maxIntentos));
  if (bloqueado) {
    await db.withPlatform(async (tx) => {
      await auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'login' }, 'PANEL', meta.correlacion, { accion: 'sesion.bloqueada', resultado: 'DENEGADO', detalle: { motivo: 'demasiados_intentos' } });
      // Aviso al titular (una vez por ventana). La respuesta HTTP es la misma exista o no la cuenta.
      const u = (await tx.query(`SELECT id, nombre, email FROM users WHERE email=$1`, [correo])).rows[0];
      if (u) {
        const ventana = Math.floor(Date.now() / (config.login.ventanaMin * 60_000));
        await encolarCorreo(tx, { tenantId: null, userId: u.id, para: u.email, clave: `bloqueo:${u.id}:${ventana}`,
          correo: plantillas.avisoSeguridad({ nombre: u.nombre, motivo: 'intentos_fallidos', minutos: config.login.ventanaMin, urlRecuperar: urlRecuperar() }) });
      }
    });
    throw new AppError('QUOTA', `Demasiados intentos fallidos. Espera ${config.login.ventanaMin} minutos o recupera tu contraseña.`);
  }
  const u = await db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM users WHERE email=$1`, [correo])).rows[0]);
  // Mismo trabajo y mismo mensaje exista o no el usuario.
  const ok = verifyPassword(String(password ?? ''), u?.password_hash ?? HASH_FICTICIO) && !!u?.password_hash;
  await db.withPlatform((tx) => tx.query(`INSERT INTO login_attempt (clave, exito) SELECT unnest($1::text[]), $2`, [claves, ok]));
  if (!u || !ok) throw new AppError('UNAUTHENTICATED', 'Correo o contraseña incorrectos.');

  // Operador de la plataforma: la contraseña no basta. Se envía un código al correo.
  if (u.rol_plataforma) {
    const desafio = token(32);
    const emitido = await db.withPlatform(async (tx) => {
      const otp = await emitirOtp(tx, { userId: u.id, proposito: 'ACCESO_PLATAFORMA', ip: meta.ip, desafioHash: hashDesafio(desafio) });
      await encolarCorreo(tx, { tenantId: null, userId: u.id, para: u.email, sensible: true, caducaEn: new Date(Date.now() + otp.minutos * 60_000),
        correo: plantillas.codigoAcceso({ nombre: u.nombre, codigo: otp.codigo, minutos: otp.minutos }) });
      await auditPlatform(tx, null, { tipo: 'USUARIO', id: u.id, nombre: u.email }, 'PANEL', meta.correlacion, { accion: 'sesion.segundo_factor_enviado', resultado: 'EXITO' });
      return otp;
    });
    return { tipo: 'segundo_factor', desafio, destino: enmascararCorreo(u.email), minutos: emitido.minutos };
  }
  const t = await db.withPlatform((tx) => crearSesion(tx, u.id, meta.agente, false));
  return { tipo: 'sesion', token: t, user: aSesion(u, false) };
}

/** Segundo paso del operador: código correcto → sesión con segundo factor. */
export async function completarSegundoFactor(db: Database, desafio: string, codigo: unknown, meta: { agente?: string; correlacion: string }) {
  if (!desafio || desafio.length < 20 || desafio.length > 100) throw new AppError('CONFLICT', 'El código venció o ya no es válido. Vuelve a iniciar sesión.');
  let userId: string;
  try {
    userId = await verificarOtp(db, { proposito: 'ACCESO_PLATAFORMA', codigo, desafioHash: hashDesafio(desafio) });
  } catch (e) {
    await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'segundo factor' }, 'PANEL', meta.correlacion, { accion: 'sesion.segundo_factor_fallido', resultado: 'DENEGADO' }));
    throw e;
  }
  return db.withPlatform(async (tx) => {
    const u = (await tx.query(`SELECT * FROM users WHERE id=$1`, [userId])).rows[0];
    if (!u?.rol_plataforma) throw new AppError('CONFLICT', 'El código venció o ya no es válido. Vuelve a iniciar sesión.');
    const t = await crearSesion(tx, u.id, meta.agente, true);
    await auditPlatform(tx, null, { tipo: 'USUARIO', id: u.id, nombre: u.email }, 'PANEL', meta.correlacion, { accion: 'sesion.segundo_factor_completado', resultado: 'EXITO' });
    return { token: t, user: aSesion(u, true) };
  });
}

/** Nuevo código para un desafío vigente (mismos límites de emisión). Respuesta uniforme. */
export async function reenviarSegundoFactor(db: Database, desafio: string, ip: string) {
  if (!desafio || desafio.length < 20 || desafio.length > 100) throw new AppError('CONFLICT', 'Vuelve a iniciar sesión para recibir un código.');
  return db.withPlatform(async (tx) => {
    const fila = (await tx.query(
      `SELECT o.user_id, u.email, u.nombre FROM otp_code o JOIN users u ON u.id=o.user_id
       WHERE o.desafio_hash=$1 AND o.proposito='ACCESO_PLATAFORMA' AND o.usado_en IS NULL AND o.creado_en > now() - ($2 || ' minutes')::interval
       ORDER BY o.creado_en ASC LIMIT 1`, [hashDesafio(desafio), String(DESAFIO_MINUTOS)])).rows[0];
    if (!fila) throw new AppError('CONFLICT', 'Vuelve a iniciar sesión para recibir un código.');
    const otp = await emitirOtp(tx, { userId: fila.user_id, proposito: 'ACCESO_PLATAFORMA', ip, desafioHash: hashDesafio(desafio) });
    await encolarCorreo(tx, { tenantId: null, userId: fila.user_id, para: fila.email, sensible: true, caducaEn: new Date(Date.now() + otp.minutos * 60_000),
      correo: plantillas.codigoAcceso({ nombre: fila.nombre, codigo: otp.codigo, minutos: otp.minutos }) });
    return { ok: true, destino: enmascararCorreo(fila.email), minutos: otp.minutos };
  });
}

export async function destroySession(db: Database, t: string | undefined) {
  if (t) await db.withPlatform((tx) => tx.query(`DELETE FROM session WHERE id=$1`, [sha256(t)]));
}

/** Sesión válida: no vencida y con actividad dentro de la ventana de inactividad. */
export async function loadUserByToken(db: Database, t: string): Promise<SessionUser | null> {
  return db.withPlatform(async (tx) => {
    const r = (await tx.query(
      `SELECT u.id, u.email, u.nombre, u.rol_plataforma, u.email_verificado_en, s.ultimo_uso, s.segundo_factor FROM session s JOIN users u ON u.id=s.user_id
       WHERE s.id=$1 AND s.expira_en > now() AND s.ultimo_uso > now() - ($2 || ' hours')::interval`,
      [sha256(t), String(config.sesion.inactividadHoras)])).rows[0];
    if (!r) return null;
    // Se renueva la marca de actividad como mucho cada 5 minutos (evita una escritura por petición).
    if (Date.now() - new Date(r.ultimo_uso).getTime() > 5 * 60_000) await tx.query(`UPDATE session SET ultimo_uso=now() WHERE id=$1`, [sha256(t)]);
    return aSesion(r, !!r.segundo_factor);
  });
}

// ------------------------------------------------------------------ verificación del correo
export async function enviarVerificacion(db: Database, user: SessionUser, ip: string) {
  return db.withPlatform(async (tx) => {
    const u = (await tx.query(`SELECT id, email, nombre, email_verificado_en FROM users WHERE id=$1`, [user.id])).rows[0];
    if (!u) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
    if (u.email_verificado_en) return { ok: true, ya_verificado: true };
    const otp = await emitirOtp(tx, { userId: u.id, proposito: 'VERIFICAR_CORREO', ip });
    await encolarCorreo(tx, { tenantId: null, userId: u.id, para: u.email, sensible: true, caducaEn: new Date(Date.now() + otp.minutos * 60_000),
      correo: plantillas.codigoVerificacion({ nombre: u.nombre, codigo: otp.codigo, minutos: otp.minutos }) });
    return { ok: true, ya_verificado: false, destino: enmascararCorreo(u.email), minutos: otp.minutos };
  });
}

export async function confirmarVerificacion(db: Database, user: SessionUser, codigo: unknown, correlacion: string) {
  if (user.correo_verificado) return { ok: true };
  await verificarOtp(db, { proposito: 'VERIFICAR_CORREO', codigo, userId: user.id });
  await db.withPlatform(async (tx) => {
    await tx.query(`UPDATE users SET email_verificado_en=now() WHERE id=$1 AND email_verificado_en IS NULL`, [user.id]);
    await auditPlatform(tx, null, { tipo: 'USUARIO', id: user.id, nombre: user.email }, 'PANEL', correlacion, { accion: 'usuario.correo_verificado', resultado: 'EXITO' });
  });
  return { ok: true };
}

// ------------------------------------------------------------------ recuperación y cambio de contraseña
/** Recuperación de acceso: la respuesta es idéntica exista o no la cuenta. */
export async function requestPasswordReset(db: Database, email: string, correlacion: string) {
  const correo = String(email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) throw invalid('Escribe un correo válido.');
  await db.withPlatform(async (tx) => {
    const u = (await tx.query(`SELECT id, nombre, email FROM users WHERE email=$1`, [correo])).rows[0];
    if (!u) return;
    const recientes = (await tx.query(`SELECT count(*)::int AS n FROM password_reset WHERE user_id=$1 AND creado_en > now() - interval '1 hour'`, [u.id])).rows[0].n;
    if (recientes >= 3) return;
    await tx.query(`UPDATE password_reset SET usado_en=now() WHERE user_id=$1 AND usado_en IS NULL`, [u.id]);
    const t = token(32);
    await tx.query(`INSERT INTO password_reset (token_hash, user_id, expira_en) VALUES ($1,$2, now() + ($3 || ' minutes')::interval)`, [sha256(t), u.id, String(RESET_MINUTOS)]);
    await encolarCorreo(tx, { tenantId: null, userId: u.id, para: u.email, sensible: true, caducaEn: new Date(Date.now() + RESET_MINUTOS * 60_000),
      correo: plantillas.recuperarContrasena({ nombre: u.nombre, url: `${config.publicUrl}/restablecer?token=${t}`, minutos: RESET_MINUTOS }) });
    await auditPlatform(tx, null, { tipo: 'USUARIO', id: u.id, nombre: correo }, 'PANEL', correlacion, { accion: 'sesion.recuperacion_solicitada', resultado: 'EXITO' });
  });
  return { ok: true };
}

const fechaLegible = () => new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Bogota' }).format(new Date());

async function avisarCambioContrasena(tx: Tx, userId: string) {
  const u = (await tx.query(`SELECT id, nombre, email FROM users WHERE id=$1`, [userId])).rows[0];
  if (u) await encolarCorreo(tx, { tenantId: null, userId: u.id, para: u.email, correo: plantillas.contrasenaCambiada({ nombre: u.nombre, urlRecuperar: urlRecuperar(), cuando: `${fechaLegible()} (hora de Colombia)` }) });
}

export async function resetPassword(db: Database, t: string, password: string, correlacion: string) {
  const pw = validarContrasena(password);
  if (!t || t.length < 20) throw new AppError('CONFLICT', 'El enlace no es válido. Pide uno nuevo.');
  return db.withPlatform(async (tx) => {
    const r = (await tx.query(`SELECT * FROM password_reset WHERE token_hash=$1 FOR UPDATE`, [sha256(t)])).rows[0];
    if (!r || r.usado_en) throw new AppError('CONFLICT', 'Este enlace ya se usó o no es válido. Pide uno nuevo.');
    if (new Date(r.expira_en) < new Date()) throw new AppError('CONFLICT', 'El enlace venció. Pide uno nuevo.');
    // Usar el enlace prueba que el correo es de la persona: queda verificado.
    await tx.query(`UPDATE users SET password_hash=$2, contrasena_cambiada_en=now(), email_verificado_en=coalesce(email_verificado_en, now()) WHERE id=$1`, [r.user_id, hashPassword(pw)]);
    await tx.query(`UPDATE password_reset SET usado_en=now() WHERE token_hash=$1`, [sha256(t)]);
    // Cambiar la contraseña cierra todas las sesiones abiertas.
    await tx.query(`DELETE FROM session WHERE user_id=$1`, [r.user_id]);
    await avisarCambioContrasena(tx, r.user_id);
    await auditPlatform(tx, null, { tipo: 'USUARIO', id: r.user_id, nombre: 'recuperación' }, 'PANEL', correlacion, { accion: 'sesion.contrasena_restablecida', resultado: 'EXITO' });
    return { ok: true };
  });
}

export async function changePassword(db: Database, user: SessionUser, actual: string, nueva: string, sesionActual: string | undefined, correlacion: string) {
  const pw = validarContrasena(nueva);
  return db.withPlatform(async (tx) => {
    const u = (await tx.query(`SELECT password_hash FROM users WHERE id=$1`, [user.id])).rows[0];
    if (!verifyPassword(String(actual ?? ''), u?.password_hash ?? HASH_FICTICIO)) throw new AppError('VALIDATION', 'La contraseña actual no es correcta.');
    await tx.query(`UPDATE users SET password_hash=$2, contrasena_cambiada_en=now() WHERE id=$1`, [user.id, hashPassword(pw)]);
    // Las demás sesiones se cierran; la actual sigue abierta.
    await tx.query(`DELETE FROM session WHERE user_id=$1 AND id <> $2`, [user.id, sesionActual ? sha256(sesionActual) : '']);
    await avisarCambioContrasena(tx, user.id);
    await auditPlatform(tx, null, { tipo: 'USUARIO', id: user.id, nombre: user.email }, 'PANEL', correlacion, { accion: 'sesion.contrasena_cambiada', resultado: 'EXITO' });
    return { ok: true };
  });
}

/** Perfil de la cuenta: datos propios (no los de una empresa) y cuántas sesiones tiene abiertas. */
export async function perfil(db: Database, user: SessionUser) {
  return db.withPlatform(async (tx) => {
    const u = (await tx.query(
      `SELECT u.nombre, u.email, u.email_verificado_en, u.contrasena_cambiada_en, u.creado_en,
              (SELECT count(*)::int FROM session s WHERE s.user_id=u.id AND s.expira_en > now()) AS sesiones
       FROM users u WHERE u.id=$1`, [user.id])).rows[0];
    if (!u) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
    return { nombre: u.nombre, email: u.email, correo_verificado: !!u.email_verificado_en, contrasena_cambiada_en: u.contrasena_cambiada_en,
      creado_en: u.creado_en, sesiones: u.sesiones };
  });
}

/** Cambia el nombre de la persona. El correo no se cambia aquí: identifica la cuenta. */
export async function actualizarPerfil(db: Database, user: SessionUser, body: { nombre?: unknown }, correlacion: string) {
  const nombre = String(body?.nombre ?? '').replace(/\s+/g, ' ').trim();
  if (nombre.length < 2 || nombre.length > 80) throw invalid('Escribe tu nombre (entre 2 y 80 caracteres).');
  if (/[<>]/.test(nombre)) throw invalid('El nombre no puede tener los caracteres < o >.');
  return db.withPlatform(async (tx) => {
    await tx.query(`UPDATE users SET nombre=$2 WHERE id=$1`, [user.id, nombre]);
    await auditPlatform(tx, null, { tipo: 'USUARIO', id: user.id, nombre: user.email }, 'PANEL', correlacion, { accion: 'perfil.actualizado', resultado: 'EXITO' });
    return { ok: true, nombre };
  });
}

export async function logoutEverywhere(db: Database, user: SessionUser) {
  await db.withPlatform(async (tx) => {
    await tx.query(`DELETE FROM session WHERE user_id=$1`, [user.id]);
    await encolarCorreo(tx, { tenantId: null, userId: user.id, para: user.email, correo: plantillas.avisoSeguridad({ nombre: user.nombre, motivo: 'sesiones_cerradas', urlRecuperar: urlRecuperar() }) });
  });
  return { ok: true };
}
