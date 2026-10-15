import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Protección de los documentos entregados al contratante.
 *
 *  - La contraseña de cada archivo es su número de documento normalizado. Es predecible,
 *    así que no es la única barrera: la descarga exige autorización, el ZIP vive en
 *    almacenamiento privado (la base) y los enlaces caducan en minutos.
 *  - La contraseña nunca se guarda como tal: el número de documento se conserva cifrado
 *    (dato de facturación) y solo se usa en memoria para proteger los archivos.
 */

/** Número de documento sin puntos, espacios, guiones ni otros separadores (mayúsculas para pasaportes). */
export function normalizarDocumento(numero: string): string {
  return String(numero ?? '').normalize('NFKC').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

/**
 * Cifrado individual recuperable para archivos que no admiten contraseña propia (p. ej. el
 * XML de una factura electrónica). No modifica el archivo original: lo envuelve, así que al
 * descifrarlo se recupera byte a byte (firma digital intacta).
 *
 * Formato compatible con OpenSSL («Salted__» + sal, PBKDF2-SHA256, AES-256-CBC), para que
 * cualquiera pueda descifrarlo sin software de Omnegia:
 *   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in archivo.enc -out archivo
 */
export const ITERACIONES_CIFRADO = 600_000;

export function cifrarRecuperable(contenido: Buffer, contrasena: string, iteraciones = ITERACIONES_CIFRADO): Buffer {
  if (!contrasena) throw new Error('Falta la contraseña de protección');
  const sal = randomBytes(8);
  const material = pbkdf2Sync(contrasena, sal, iteraciones, 48, 'sha256');
  const cifrador = createCipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([Buffer.from('Salted__'), sal, cifrador.update(contenido), cifrador.final()]);
}

export function descifrarRecuperable(cifrado: Buffer, contrasena: string, iteraciones = ITERACIONES_CIFRADO): Buffer {
  if (cifrado.subarray(0, 8).toString() !== 'Salted__') throw new Error('Formato no reconocido');
  const material = pbkdf2Sync(contrasena, cifrado.subarray(8, 16), iteraciones, 48, 'sha256');
  const d = createDecipheriv('aes-256-cbc', material.subarray(0, 32), material.subarray(32, 48));
  return Buffer.concat([d.update(cifrado.subarray(16)), d.final()]);
}

export const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// ---------------------------------------------------------------- enlaces de descarga temporales
/** Vigencia de un enlace de descarga. Corta a propósito: se emite uno nuevo en cada clic. */
export const MINUTOS_ENLACE = 10;

const clave = () => createHmac('sha256', config.appKey).update('enlace-documentos-v1').digest();

/** Enlace firmado con el documento y su versión; no lleva la contraseña ni datos personales. */
export function firmarEnlace(documentoId: string, version: number, ahora = Date.now()): { token: string; expiraEn: Date } {
  const expiraEn = new Date(ahora + MINUTOS_ENLACE * 60_000);
  const cuerpo = Buffer.from(JSON.stringify({ d: documentoId, v: version, e: Math.floor(expiraEn.getTime() / 1000) })).toString('base64url');
  const firma = createHmac('sha256', clave()).update(cuerpo).digest('base64url');
  return { token: `${cuerpo}.${firma}`, expiraEn };
}

export function verificarEnlace(token: string, ahora = Date.now()): { documentoId: string; version: number } | null {
  const [cuerpo, firma] = String(token ?? '').split('.');
  if (!cuerpo || !firma || cuerpo.length > 400) return null;
  const esperada = createHmac('sha256', clave()).update(cuerpo).digest();
  const recibida = Buffer.from(firma, 'base64url');
  if (recibida.length !== esperada.length || !timingSafeEqual(recibida, esperada)) return null;
  try {
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString());
    if (typeof p.d !== 'string' || !Number.isInteger(p.v) || !Number.isInteger(p.e) || p.e * 1000 < ahora) return null;
    return { documentoId: p.d, version: p.v };
  } catch {
    return null;
  }
}
