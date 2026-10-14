import { randomInt } from 'node:crypto';
import type { Database, Tx } from '../db/index.js';
import { AppError } from '../lib/errors.js';
import { hmacHex, safeEqual, sha256, uuidv7 } from '../lib/util.js';
import { config } from '../config.js';

/**
 * Códigos de un solo uso (OTP) de seis dígitos.
 *  - Generación criptográfica (crypto.randomInt).
 *  - En la base solo queda un HMAC-SHA256 con APP_KEY: el código no se puede
 *    recuperar ni probar por fuerza bruta sin la clave del servidor.
 *  - Vence en EMAIL_OTP_EXPIRY_MINUTES (10 por defecto), sirve una vez y admite
 *    5 intentos; emitir uno nuevo invalida el anterior.
 *  - Límite de emisión por usuario y propósito (1 por minuto, 5 por hora) y por IP
 *    (20 por hora).
 *  - El código nunca se devuelve en una respuesta de la API ni se registra.
 */
export type Proposito = 'VERIFICAR_CORREO' | 'ACCESO_PLATAFORMA';

export const LIMITES_OTP = { esperaSegundos: 60, porHoraUsuario: 5, porHoraIp: 20, maxIntentos: 5 };

const hashCodigo = (id: string, codigo: string) => hmacHex(config.appKey, `otp:${id}:${codigo}`);
export const hashIp = (ip: string) => sha256(`${config.appKey}:ip:${ip}`).slice(0, 40);
export const hashDesafio = (d: string) => sha256(`desafio:${d}`);

export interface OtpEmitido { id: string; codigo: string; minutos: number }

/** Emite un código nuevo dentro de la transacción del llamador (que encola el correo). */
export async function emitirOtp(tx: Tx, o: { userId: string; proposito: Proposito; ip: string; desafioHash?: string | null }): Promise<OtpEmitido> {
  const ip = hashIp(o.ip);
  const uso = (await tx.query(
    `SELECT
       (SELECT max(creado_en) FROM otp_code WHERE user_id=$1 AND proposito=$2) AS ultimo,
       (SELECT count(*)::int FROM otp_code WHERE user_id=$1 AND proposito=$2 AND creado_en > now() - interval '1 hour') AS hora_usuario,
       (SELECT count(*)::int FROM otp_code WHERE ip_hash=$3 AND creado_en > now() - interval '1 hour') AS hora_ip`,
    [o.userId, o.proposito, ip])).rows[0];
  if (uso.ultimo) {
    const faltan = LIMITES_OTP.esperaSegundos - Math.floor((Date.now() - new Date(uso.ultimo).getTime()) / 1000);
    if (faltan > 0) throw new AppError('QUOTA', `Espera ${faltan} segundos para pedir otro código.`, { espera_segundos: faltan });
  }
  if (uso.hora_usuario >= LIMITES_OTP.porHoraUsuario || uso.hora_ip >= LIMITES_OTP.porHoraIp) {
    throw new AppError('QUOTA', 'Pediste demasiados códigos. Intenta de nuevo en una hora.');
  }
  await tx.query(`UPDATE otp_code SET invalidado_en=now() WHERE user_id=$1 AND proposito=$2 AND usado_en IS NULL AND invalidado_en IS NULL`, [o.userId, o.proposito]);
  const id = uuidv7();
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const minutos = config.correo.otpMinutos;
  await tx.query(
    `INSERT INTO otp_code (id, user_id, proposito, codigo_hash, desafio_hash, ip_hash, max_intentos, expira_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval)`,
    [id, o.userId, o.proposito, hashCodigo(id, codigo), o.desafioHash ?? null, ip, LIMITES_OTP.maxIntentos, String(minutos)]);
  return { id, codigo, minutos };
}

type Verificacion = { ok: true; userId: string } | { ok: false; error: AppError };

/**
 * Verifica un código. Corre en su propia transacción para que un intento fallido
 * quede contado aunque la petición termine en error.
 */
export async function verificarOtp(db: Database, o: { proposito: Proposito; codigo: unknown; userId?: string; desafioHash?: string }): Promise<string> {
  const codigo = String(o.codigo ?? '').replace(/\D/g, '');
  if (codigo.length !== 6) throw new AppError('VALIDATION', 'Escribe los 6 dígitos del código.');
  if (!o.userId && !o.desafioHash) throw new AppError('CONFLICT', 'El código venció o ya no es válido. Pide uno nuevo.');
  const r: Verificacion = await db.withPlatform(async (tx) => {
    const fila = (await tx.query(
      `SELECT * FROM otp_code WHERE proposito=$1 AND usado_en IS NULL AND invalidado_en IS NULL
         AND ${o.userId ? 'user_id=$2' : 'desafio_hash=$2'} ORDER BY creado_en DESC LIMIT 1 FOR UPDATE`,
      [o.proposito, o.userId ?? o.desafioHash])).rows[0];
    if (!fila || new Date(fila.expira_en) <= new Date()) return { ok: false, error: new AppError('CONFLICT', 'El código venció o ya no es válido. Pide uno nuevo.') };
    if (!safeEqual(hashCodigo(fila.id, codigo), fila.codigo_hash)) {
      const intentos = fila.intentos + 1;
      const agotado = intentos >= fila.max_intentos;
      await tx.query(`UPDATE otp_code SET intentos=$2, invalidado_en=CASE WHEN $3 THEN now() ELSE invalidado_en END WHERE id=$1`, [fila.id, intentos, agotado]);
      return {
        ok: false,
        error: agotado
          ? new AppError('CONFLICT', 'Demasiados intentos con este código. Pide uno nuevo.')
          : new AppError('VALIDATION', `El código no es correcto. Te quedan ${fila.max_intentos - intentos} intentos.`),
      };
    }
    await tx.query(`UPDATE otp_code SET usado_en=now() WHERE id=$1`, [fila.id]);
    return { ok: true, userId: fila.user_id };
  });
  if (!r.ok) throw r.error;
  return r.userId;
}
