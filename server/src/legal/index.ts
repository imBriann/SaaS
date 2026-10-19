import { z } from 'zod';
import type { Database } from '../db/index.js';
import { config } from '../config.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { uuidv7 } from '../lib/util.js';
import { hashIp } from '../modules/otp.js';
import { encolarCorreo } from '../email/servicio.js';
import { solicitudDatosInterna, solicitudDatosRecibida } from '../email/plantillas.js';

/**
 * Zona legal. Cada cambio de fondo en los textos sube `version`: la aceptación guardada en un alta
 * solo vale para la versión que la persona vio, y el pago exige la vigente.
 */
export const LEGAL = { version: '2026-10-18', vigenteDesde: '2026-10-18' } as const;

/**
 * Identificación del responsable del tratamiento y del proveedor del servicio (Decreto 1377 de 2013 art. 13;
 * Ley 1480 de 2011 art. 50 literal a). Sale de la configuración del operador: nunca se inventan datos.
 */
export function responsableLegal() {
  const e = config.documentos.emisor;
  const r = {
    razon_social: e.razonSocial ?? null,
    documento: e.numeroDocumento ? `${e.tipoDocumento ?? 'NIT'} ${e.numeroDocumento}` : null,
    direccion: e.direccion ?? null,
    ciudad: e.ciudad ?? null,
    correo: e.correo ?? config.correo.buzonSoporte ?? null,
    telefono: e.telefono ?? null,
  };
  const faltan = (Object.entries(r) as [string, string | null][]).filter(([, v]) => !v).map(([k]) => k);
  return { ...r, completo: faltan.length === 0, faltan };
}

export function infoLegal() {
  return { version: LEGAL.version, vigente_desde: LEGAL.vigenteDesde, responsable: responsableLegal() };
}

/** Prueba de aceptación: qué versión, cuándo y desde dónde (la IP se guarda como huella, no en claro). */
export async function registrarAceptacion(db: Database, tk: string, ctx: { ip: string; agente: string }, body: any) {
  if (body?.terminos !== true || body?.privacidad !== true || body?.inicio_servicio !== true) throw invalid('Para continuar debes aceptar los Términos y condiciones, la Política de tratamiento de datos y el inicio del servicio.');
  return db.withPlatform(async (tx) => {
    const d = (await tx.query(`SELECT estado FROM onboarding_draft WHERE token=$1 FOR UPDATE`, [tk])).rows[0];
    if (!d) throw notFound();
    if (d.estado !== 'BORRADOR') throw new AppError('CONFLICT', 'Este borrador ya no se puede modificar.');
    const prueba = { version: LEGAL.version, aceptado_en: new Date().toISOString(), documentos: ['terminos', 'privacidad'], inicio_servicio: true, ip_hash: hashIp(ctx.ip), agente: ctx.agente.slice(0, 200) };
    await tx.query(`UPDATE onboarding_draft SET aceptacion_legal=$2, actualizado_en=now() WHERE token=$1`, [tk, JSON.stringify(prueba)]);
    return { ok: true, version: prueba.version, aceptado_en: prueba.aceptado_en };
  });
}
export const aceptacionVigente = (a: any) => !!a && a.version === LEGAL.version;

// ------------------------------------------------------------------ solicitudes de los titulares

const SolicitudSchema = z.object({
  tipo: z.enum(['SUPRESION', 'CONSULTA', 'RECTIFICACION', 'REVOCATORIA', 'PQR']),
  calidad: z.enum(['USUARIO_PLATAFORMA', 'CLIENTE_DE_COMERCIO', 'OTRA']),
  nombre: z.string({ error: 'Escribe tu nombre.' }).trim().min(2, 'Escribe tu nombre.').max(120),
  email: z.email('Escribe un correo válido.').max(254).transform((s) => s.toLowerCase()),
  telefono: z.string().trim().max(25).optional(),
  comercio: z.string().trim().max(120).optional(),
  detalle: z.string({ error: 'Cuéntanos qué necesitas.' }).trim().min(10, 'Cuéntanos con un poco más de detalle qué necesitas (al menos 10 caracteres).').max(2000),
});

export const NOMBRE_TIPO: Record<string, string> = { SUPRESION: 'Supresión de datos', CONSULTA: 'Consulta de datos', RECTIFICACION: 'Actualización o rectificación', REVOCATORIA: 'Revocatoria de la autorización', PQR: 'Petición, queja o reclamo' };
export const NOMBRE_CALIDAD: Record<string, string> = { USUARIO_PLATAFORMA: 'Administro o trabajo en una empresa de Omnegia', CLIENTE_DE_COMERCIO: 'Soy cliente de un comercio que usa Omnegia', OTRA: 'Otra situación' };

/**
 * Días hábiles que fija la ley para responder: 10 para consultas (art. 14) y 15 para reclamos (art. 15 de la Ley 1581 de 2012).
 * Aquí solo se descuentan sábados y domingos: es una fecha objetivo interna, nunca más tardía que la legal.
 */
export function sumarDiasHabiles(desde: Date, dias: number): Date {
  const f = new Date(desde);
  while (dias > 0) { f.setUTCDate(f.getUTCDate() + 1); if (f.getUTCDay() !== 0 && f.getUTCDay() !== 6) dias--; }
  return f;
}
export const DIAS_RESPUESTA = { CONSULTA: 10, RECLAMO: 15 } as const;

export async function crearSolicitudDatos(db: Database, body: unknown, ip: string) {
  const p = SolicitudSchema.safeParse(body);
  if (!p.success) throw invalid(p.error.issues[0]?.message ?? 'Revisa los datos de la solicitud.');
  const s = p.data;
  // Consultas: 10 días hábiles (art. 14); reclamos sobre datos: 15 (art. 15). Para una PQR de consumo se usa la misma meta de 15.
  const dias = s.tipo === 'CONSULTA' ? DIAS_RESPUESTA.CONSULTA : DIAS_RESPUESTA.RECLAMO;
  const vence = sumarDiasHabiles(new Date(), dias).toISOString().slice(0, 10);
  const huella = hashIp(ip);
  return db.withPlatform(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`sd:${huella}`]);
    const uso = (await tx.query(
      `SELECT count(*) FILTER (WHERE ip_hash=$1 AND creado_en > now() - interval '1 hour')::int AS ip,
              count(*) FILTER (WHERE lower(email)=$2 AND creado_en > now() - interval '1 day')::int AS correo FROM solicitud_datos`, [huella, s.email])).rows[0];
    if (uso.ip >= 5 || uso.correo >= 5) throw new AppError('QUOTA', 'Ya registraste varias solicitudes. Espera un momento o escríbenos al correo de datos personales.');
    const n = (await tx.query(`SELECT nextval('solicitud_datos_num')::int AS n`)).rows[0].n as number;
    const radicado = `${s.tipo === 'PQR' ? 'PQ' : 'SD'}-${new Date().getUTCFullYear()}-${String(n).padStart(6, '0')}`;
    const id = uuidv7();
    await tx.query(
      `INSERT INTO solicitud_datos (id, radicado, tipo, calidad, nombre, email, telefono, comercio, detalle, ip_hash, vence_en) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, radicado, s.tipo, s.calidad, s.nombre, s.email, s.telefono || null, s.comercio || null, s.detalle, huella, vence]);
    const destino = responsableLegal().correo;
    await encolarCorreo(tx, { tenantId: null, para: s.email, clave: `sd:${id}:recibida`, correo: solicitudDatosRecibida({ nombre: s.nombre, radicado, tipo: NOMBRE_TIPO[s.tipo], dias, vence }) });
    if (destino) await encolarCorreo(tx, { tenantId: null, para: destino, responderA: s.email, clave: `sd:${id}:interna`,
      correo: solicitudDatosInterna({ radicado, tipo: NOMBRE_TIPO[s.tipo], calidad: NOMBRE_CALIDAD[s.calidad], nombre: s.nombre, email: s.email, telefono: s.telefono, comercio: s.comercio, detalle: s.detalle, vence }) });
    return { ok: true, radicado, tipo: s.tipo, estado: 'RECIBIDA', dias_habiles: dias, vence_en: vence };
  });
}

/** Estado de una solicitud: solo con el radicado y el correo con que se registró. Cualquier otra combinación responde igual. */
export async function consultarSolicitudDatos(db: Database, radicado: unknown, email: unknown) {
  const r = String(radicado ?? '').trim().toUpperCase();
  const e = String(email ?? '').trim().toLowerCase();
  const fila = r && e ? (await db.withPlatform((tx) => tx.query(`SELECT radicado, tipo, estado, creado_en, vence_en FROM solicitud_datos WHERE radicado=$1 AND lower(email)=$2`, [r, e]))).rows[0] : null;
  if (!fila) throw notFound();
  return { radicado: fila.radicado, tipo: fila.tipo, estado: fila.estado, creado_en: fila.creado_en, vence_en: String(fila.vence_en).slice(0, 10) };
}
