import type { Database } from '../db/index.js';
import { AppError, notFound } from '../lib/errors.js';
import { hashPassword } from '../lib/util.js';
import { enqueue } from '../core/events.js';
import { login, validarContrasena, type SessionUser } from '../modules/auth.js';
import { aprovisionarConReintento } from '../modules/billing.js';
import { personalizarEspacio } from './personalization.js';
import { reembolsoBloqueaServicio } from '../modules/reembolsoBloqueo.js';

/** La autorización precede la creación; una llave de borrador nunca abre una cuenta existente. */
export async function solicitarCreacion(db: Database, tk: string, password: unknown, meta: { ip: string; agente?: string; correlacion: string; usuario?: SessionUser | null }) {
  const d = await db.withPlatform(async tx => (await tx.query('SELECT * FROM onboarding_draft WHERE token=$1', [tk])).rows[0]);
  if (!d) throw notFound();
  if (!d.creacion_diferida) throw new AppError('CONFLICT', 'Esta alta usa el registro anterior. Continúa desde su estado actual.');
  const pagado = await db.withPlatform(async tx => (await tx.query("SELECT 1 FROM payment WHERE draft_token=$1 AND estado='APROBADO'", [tk])).rows.length > 0);
  if (!pagado || !d.email_verificado_en || d.email_verificado !== d.negocio.email) throw new AppError('CONFLICT', 'Necesitas el correo verificado y el pago aprobado para crear tu espacio.');
  if (await db.withPlatform(tx => reembolsoBloqueaServicio(tx, tk))) throw new AppError('CONFLICT', 'Este pago se devuelve por tu solicitud de retracto o reembolso, así que el espacio ya no se puede crear.');
  const existente = await db.withPlatform(async tx => (await tx.query('SELECT id FROM users WHERE email=$1', [d.negocio.email])).rows[0]);
  let sesion: Awaited<ReturnType<typeof login>> | null = null;
  let hash: string | null = null;
  if (existente) {
    const autorizada = meta.usuario?.id === existente.id && (!meta.usuario?.rol_plataforma || meta.usuario?.segundo_factor);
    if (!autorizada) {
      sesion = await login(db, d.negocio.email, String(password ?? ''), meta);
      if (sesion.tipo === 'segundo_factor') return { segundo_factor: true as const, ...sesion };
    }
  } else {
    hash = hashPassword(validarContrasena(password));
  }
  const creacion = await db.withPlatform(async tx => {
    const actual = (await tx.query('SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE', [tk])).rows[0];
    if (actual.estado === 'APROVISIONADO' || ['en_cola', 'analizando', 'aplicando'].includes(actual.creacion.estado)) return actual.creacion;
    const intento = Number(actual.creacion.intento ?? 0) + 1;
    const estado = { estado: 'en_cola', intento, iniciado_en: new Date().toISOString(), error: null };
    await tx.query('UPDATE onboarding_draft SET creacion=$2,password_hash_inicial=$3,error_aprovisionamiento=NULL,actualizado_en=now() WHERE token=$1', [tk, JSON.stringify(estado), hash]);
    await enqueue(tx, null, 'crear_espacio_ia', { draft_token: tk, intento }, { claveUnica: `crear-ia:${tk}:${intento}`, maxIntentos: 1 });
    return estado;
  });
  return { ok: true as const, creacion, sesion };
}

/** Trabajo durable: la salida real se guarda antes de materializar el espacio de forma atómica. */
export async function crearEspacio(db: Database, tk: string, intento: number, correlacion: string) {
  const d = await db.withPlatform(async tx => {
    const draft = (await tx.query('SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE', [tk])).rows[0];
    if (!draft || draft.estado === 'APROVISIONADO' || Number(draft.creacion.intento) !== intento) return null;
    const pago = (await tx.query("SELECT plan_codigo FROM payment WHERE draft_token=$1 AND estado='APROBADO' ORDER BY verificado_en LIMIT 1", [tk])).rows[0];
    if (!pago) throw new AppError('CONFLICT', 'El pago de esta alta no está aprobado.');
    const modulos = (await tx.query('SELECT modulos FROM plan WHERE codigo=$1', [pago.plan_codigo])).rows[0]?.modulos ?? [];
    await tx.query("UPDATE onboarding_draft SET creacion=creacion || $2::jsonb,actualizado_en=now() WHERE token=$1", [tk, JSON.stringify({ estado: draft.personalizacion ? 'aplicando' : 'analizando', error: null })]);
    return { ...draft, modulos };
  });
  if (!d) return;
  try {
    const personalizacion = d.personalizacion ?? await personalizarEspacio(d, d.modulos);
    await db.withPlatform(tx => tx.query('UPDATE onboarding_draft SET personalizacion=$2,creacion=creacion || $3::jsonb,actualizado_en=now() WHERE token=$1', [tk, JSON.stringify(personalizacion), JSON.stringify({ estado: 'aplicando', motor: personalizacion.motor })]));
    const r = await aprovisionarConReintento(db, tk, correlacion);
    if (!r.tenantId) throw new AppError('CONFLICT', r.error ?? 'No pudimos terminar de crear el espacio.');
  } catch (e) {
    // No se publica el error crudo del proveedor (puede contener información sensible).
    const mensaje = e instanceof AppError ? e.message : 'La IA no pudo terminar la creación. Tu pago está guardado; puedes volver a intentarlo.';
    await db.withPlatform(tx => tx.query("UPDATE onboarding_draft SET creacion=creacion || $2::jsonb,actualizado_en=now() WHERE token=$1 AND estado <> 'APROVISIONADO'", [tk, JSON.stringify({ estado: 'error', error: mensaje })]));
  }
}
