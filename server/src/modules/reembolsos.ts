import { z } from 'zod';
import type { Database } from '../db/index.js';
import { config } from '../config.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { cop, isUuid, uuidv7 } from '../lib/util.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { responsableLegal, sumarDiasHabiles } from '../legal/index.js';
import { hashIp } from './otp.js';
import { exigir, auditar, type Operador } from './operador.js';

/**
 * Reembolsos y retracto de los pagos a la plataforma.
 *
 * Reglas (Ley 1480 de 2011 y Ley 2439 de 2024):
 *  - Retracto: 5 días hábiles desde la celebración del contrato de servicios, mientras la prestación no haya comenzado
 *    con el acuerdo del consumidor (art. 47). En Omnegia el servicio comienza al crear el espacio.
 *  - Falta de activación: si el servicio no se presta, se devuelve todo lo pagado (art. 50, literal h).
 *  - La devolución no excede de 15 días calendario desde que se ejerce el derecho, se hace sin descuentos ni retenciones
 *    y por el medio de pago que prefiera el consumidor (arts. 3 y 5 de la Ley 2439).
 *  - Reversión del pago por fraude u operación no solicitada (art. 51): se tramita aquí y con quien emitió el medio de pago.
 *
 * El retracto en plazo, la falta de activación comprobada y el cobro duplicado se aprueban solos: son derechos, no favores.
 * Todo lo demás pasa a una persona. Un rechazo nunca es automático.
 */
export const MOTIVOS = ['RETRACTO', 'NO_ACTIVACION', 'COBRO_DUPLICADO', 'COBRO_NO_RECONOCIDO', 'OTRO'] as const;
export type Motivo = (typeof MOTIVOS)[number];
export const NOMBRE_MOTIVO: Record<Motivo, string> = {
  RETRACTO: 'Retracto (me arrepentí de la compra)', NO_ACTIVACION: 'El servicio no se activó', COBRO_DUPLICADO: 'Me cobraron dos veces',
  COBRO_NO_RECONOCIDO: 'No reconozco este cobro', OTRO: 'Otro motivo',
};
export const NOMBRE_MEDIO: Record<string, string> = { MISMO_MEDIO: 'El mismo medio de pago con el que pagué', TRANSFERENCIA: 'Transferencia bancaria (coordinamos los datos por correo)' };
export const DIAS_DEVOLUCION = 15;
const DIAS_RETRACTO = 5;
const DIAS_ACTIVACION = 30;

const Solicitud = z.object({
  referencia: z.string({ error: 'Escribe la referencia de tu pago.' }).trim().min(6, 'Escribe la referencia de tu pago.').max(60),
  email: z.email('Escribe el correo con el que contrataste.').max(254).transform((s) => s.toLowerCase()),
  nombre: z.string({ error: 'Escribe tu nombre.' }).trim().min(2, 'Escribe tu nombre.').max(120),
  motivo: z.enum(MOTIVOS, { error: 'Elige el motivo de tu solicitud.' }),
  medio: z.enum(['MISMO_MEDIO', 'TRANSFERENCIA']).default('MISMO_MEDIO'),
  detalle: z.string({ error: 'Cuéntanos qué pasó.' }).trim().min(10, 'Cuéntanos con un poco más de detalle qué pasó (al menos 10 caracteres).').max(2000),
});

interface Evaluacion { elegible: boolean; regla: string; razon: string }

/** ¿El servicio ya comenzó? Comienza cuando se crea el espacio (o mientras se crea). */
const servicioIniciado = (p: any) => p.draft_estado === 'APROVISIONADO' || !!p.tenant_id_real || ['en_cola', 'analizando', 'aplicando'].includes(p.creacion?.estado);

/** Evalúa la solicitud con hechos verificables del sistema. Nunca rechaza: lo que no es automático lo decide una persona. */
export function evaluar(p: any, motivo: Motivo, ahora: Date, duplicadoPosterior: boolean): Evaluacion {
  const pagado = new Date(p.verificado_en ?? p.creado_en);
  if (motivo === 'RETRACTO') {
    if (!p.draft_token) return { elegible: false, regla: 'retracto_renovacion', razon: 'Es el pago de una renovación de un servicio ya en uso: una persona del equipo lo revisa.' };
    if (servicioIniciado(p)) return { elegible: false, regla: 'servicio_iniciado', razon: 'Tu espacio ya fue creado, así que el servicio comenzó con tu acuerdo (Ley 1480 de 2011, art. 47, numeral 1). Una persona del equipo revisa tu caso por si aplica otro derecho.' };
    const fin = sumarDiasHabiles(pagado, DIAS_RETRACTO);
    fin.setUTCHours(23, 59, 59, 999);
    if (ahora > fin) return { elegible: false, regla: 'fuera_de_plazo', razon: 'Pasaron más de 5 días hábiles desde el pago. Una persona del equipo revisa tu caso.' };
    return { elegible: true, regla: 'retracto_en_plazo', razon: 'Estás dentro de los 5 días hábiles y tu espacio aún no se creó: procede el retracto.' };
  }
  if (motivo === 'NO_ACTIVACION') {
    if (!p.draft_token) return { elegible: false, regla: 'revision', razon: 'Una persona del equipo revisa tu caso.' };
    if (servicioIniciado(p)) return { elegible: false, regla: 'servicio_prestado', razon: 'Tu espacio ya fue creado. Una persona del equipo revisa tu caso.' };
    const fallo = p.creacion?.estado === 'error' || !!p.error_aprovisionamiento;
    const vencido = ahora.getTime() - pagado.getTime() > DIAS_ACTIVACION * 86_400_000;
    if (fallo || vencido) return { elegible: true, regla: fallo ? 'activacion_fallida' : 'activacion_vencida', razon: fallo ? 'La creación de tu espacio falló: procede la devolución de lo pagado.' : 'Pasaron más de 30 días sin que se activara el servicio: procede la devolución de lo pagado.' };
    return { elegible: false, regla: 'aun_en_plazo', razon: 'Tu pago está aprobado y tu espacio aún no se crea, pero todavía puedes crearlo. Si prefieres devolver el pago dentro de los 5 días hábiles, elige «Retracto». Una persona del equipo revisa tu caso.' };
  }
  if (motivo === 'COBRO_DUPLICADO') {
    return duplicadoPosterior
      ? { elegible: true, regla: 'cobro_duplicado', razon: 'Encontramos otro pago aprobado para la misma alta, hecho antes: procede la devolución de este.' }
      : { elegible: false, regla: 'duplicado_no_verificado', razon: 'No encontramos otro pago anterior para la misma alta. Una persona del equipo lo revisa.' };
  }
  return { elegible: false, regla: 'revision', razon: 'Una persona del equipo revisa tu caso, con el detalle que nos diste.' };
}

const NO_ENCONTRADO = 'No encontramos un pago aprobado con esa referencia y ese correo. Revisa la referencia en el correo de confirmación (empieza por SUB-) y escribe el correo con el que contrataste.';

/** Solicitud pública: se identifica con la referencia del pago y el correo del contratante. */
export async function solicitarReembolso(db: Database, body: unknown, ip: string) {
  const p = Solicitud.safeParse(body);
  if (!p.success) throw invalid(p.error.issues[0]?.message ?? 'Revisa los datos de la solicitud.');
  const s = p.data;
  const huella = hashIp(ip);
  return db.withPlatform(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rb:${huella}`]);
    const uso = (await tx.query(
      `SELECT count(*) FILTER (WHERE ip_hash=$1 AND creado_en > now() - interval '1 hour')::int AS ip,
              count(*) FILTER (WHERE lower(solicitante_email)=$2 AND creado_en > now() - interval '1 day')::int AS correo FROM reembolso`, [huella, s.email])).rows[0];
    if (uso.ip >= 5 || uso.correo >= 5) throw new AppError('QUOTA', 'Ya registraste varias solicitudes. Escríbenos al correo de soporte y te ayudamos.');
    const pago = (await tx.query(
      `SELECT p.*, d.estado AS draft_estado, d.creacion, d.error_aprovisionamiento, d.negocio->>'email' AS email_alta, d.tenant_id AS tenant_id_real, t.email_contacto, t.id AS tenant_real
         FROM payment p LEFT JOIN onboarding_draft d ON d.token = p.draft_token LEFT JOIN tenant t ON t.id = p.tenant_id
        WHERE p.referencia=$1 OR lower(p.referencia)=lower($1) ORDER BY (p.referencia=$1) DESC LIMIT 1 FOR UPDATE OF p`, [s.referencia])).rows[0];
    const correos = pago ? [pago.email_alta, pago.email_contacto].filter(Boolean).map((e: string) => e.toLowerCase()) : [];
    // Misma respuesta si la referencia no existe, si el correo no es el del contratante o si el pago no está aprobado.
    if (!pago || !correos.includes(s.email) || pago.estado !== 'APROBADO') throw new AppError('NOT_FOUND', NO_ENCONTRADO);
    const vivo = (await tx.query(`SELECT radicado, estado FROM reembolso WHERE payment_id=$1 AND estado IN ('EN_REVISION','APROBADO','REEMBOLSADO')`, [pago.id])).rows[0];
    if (vivo) throw new AppError('CONFLICT', `Este pago ya tiene la solicitud ${vivo.radicado}. Puedes consultar su estado con ese radicado.`, { radicado: vivo.radicado });
    const duplicado = pago.draft_token
      ? (await tx.query(`SELECT 1 FROM payment WHERE draft_token=$1 AND estado IN ('APROBADO','REEMBOLSADO') AND id<>$2 AND coalesce(verificado_en, creado_en) < $3`, [pago.draft_token, pago.id, pago.verificado_en ?? pago.creado_en])).rows.length > 0
      : false;
    const ahora = new Date();
    const ev = evaluar(pago, s.motivo, ahora, duplicado);
    const n = (await tx.query(`SELECT nextval('reembolso_num')::int AS n`)).rows[0].n as number;
    const radicado = `RB-${ahora.getUTCFullYear()}-${String(n).padStart(6, '0')}`;
    const id = uuidv7();
    const vence = new Date(ahora.getTime() + DIAS_DEVOLUCION * 86_400_000);
    const estado = ev.elegible ? 'APROBADO' : 'EN_REVISION';
    await tx.query(
      `INSERT INTO reembolso (id, radicado, payment_id, draft_token, tenant_id, motivo, estado, solicitante_nombre, solicitante_email, medio_preferido, detalle, monto, moneda, evaluacion,
                              decidido_en, decidido_por, decision_motivo, vence_en, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [id, radicado, pago.id, pago.draft_token ?? null, pago.tenant_id ?? null, s.motivo, estado, s.nombre, s.email, s.medio, s.detalle, pago.monto, pago.moneda, JSON.stringify(ev),
        ev.elegible ? ahora : null, ev.elegible ? 'sistema' : null, ev.elegible ? ev.razon : null, vence, huella]);
    await auditPlatform(tx, pago.tenant_id ?? null, { tipo: 'ANONIMO', id: null, nombre: 'cliente' }, 'PUBLICO', radicado, {
      accion: 'reembolso.solicitado', recurso: 'reembolso', recursoId: id, resultado: 'EXITO', detalle: { motivo: s.motivo, estado, regla: ev.regla, monto: Number(pago.monto) } });
    const monto = cop(Number(pago.monto));
    await encolarCorreo(tx, { tenantId: null, para: s.email, clave: `rb:${id}:recibida`,
      correo: plantillas.reembolsoRecibido({ nombre: s.nombre, radicado, motivo: NOMBRE_MOTIVO[s.motivo], aprobado: ev.elegible, razon: ev.razon, monto, vence: vence.toISOString().slice(0, 10), medio: NOMBRE_MEDIO[s.medio] }) });
    const destino = responsableLegal().correo;
    if (destino) await encolarCorreo(tx, { tenantId: null, para: destino, responderA: s.email, clave: `rb:${id}:interna`,
      correo: plantillas.reembolsoInterno({ radicado, motivo: NOMBRE_MOTIVO[s.motivo], estado, razon: ev.razon, referencia: pago.referencia, monto, nombre: s.nombre, email: s.email, medio: NOMBRE_MEDIO[s.medio], detalle: s.detalle, vence: vence.toISOString().slice(0, 10), urlOperador: `${config.publicUrl}/operador/reembolsos` }) });
    return { ok: true, radicado, estado, aprobado_automatico: ev.elegible, explicacion: ev.razon, monto: Number(pago.monto), vence_en: vence.toISOString().slice(0, 10), dias_calendario: DIAS_DEVOLUCION };
  });
}

/** Estado de una solicitud con radicado y correo. Cualquier otra combinación responde igual. */
export async function consultarReembolso(db: Database, radicado: unknown, email: unknown) {
  const r = String(radicado ?? '').trim().toUpperCase();
  const e = String(email ?? '').trim().toLowerCase();
  const f = r && e ? (await db.withPlatform((tx) => tx.query(
    `SELECT radicado, motivo, estado, monto, vence_en, decision_motivo, referencia_devolucion, reembolsado_en, creado_en FROM reembolso WHERE radicado=$1 AND lower(solicitante_email)=$2`, [r, e]))).rows[0] : null;
  if (!f) throw notFound();
  return { radicado: f.radicado, motivo: f.motivo, estado: f.estado, monto: Number(f.monto), vence_en: new Date(f.vence_en).toISOString().slice(0, 10), explicacion: f.decision_motivo, referencia_devolucion: f.referencia_devolucion, reembolsado_en: f.reembolsado_en, creado_en: f.creado_en };
}

// ------------------------------------------------------------------ lado del operador

const fila = (x: any) => ({
  id: x.id, radicado: x.radicado, referencia: x.referencia, empresa: x.empresa ?? null, motivo: x.motivo, motivo_nombre: NOMBRE_MOTIVO[x.motivo as Motivo], estado: x.estado,
  solicitante: x.solicitante_nombre, solicitante_email: x.solicitante_email, medio: NOMBRE_MEDIO[x.medio_preferido], monto: Number(x.monto), moneda: x.moneda,
  detalle: x.detalle, evaluacion: x.evaluacion, decidido_en: x.decidido_en, decidido_por: x.decidido_por, decision_motivo: x.decision_motivo,
  referencia_devolucion: x.referencia_devolucion, reembolsado_en: x.reembolsado_en, vence_en: x.vence_en, creado_en: x.creado_en,
  dias_restantes: Math.ceil((new Date(x.vence_en).getTime() - Date.now()) / 86_400_000),
  vencido: ['EN_REVISION', 'APROBADO'].includes(x.estado) && new Date(x.vence_en).getTime() < Date.now(),
});

export async function listarReembolsos(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const estado = String(q?.estado ?? '');
  return db.withOperador(async (tx) => ({
    reembolsos: (await tx.query(
      `SELECT r.id, r.radicado, r.motivo, r.estado, r.solicitante_nombre, r.solicitante_email, r.medio_preferido, r.detalle, r.monto, r.moneda, r.evaluacion,
              r.decidido_en, r.decidido_por, r.decision_motivo, r.referencia_devolucion, r.reembolsado_en, r.vence_en, r.creado_en, p.referencia, t.nombre AS empresa FROM reembolso r JOIN payment p ON p.id=r.payment_id LEFT JOIN tenant t ON t.id=r.tenant_id
        WHERE ($1='' OR r.estado=$1)
        ORDER BY (r.estado IN ('REEMBOLSADO','RECHAZADO')), r.vence_en ASC LIMIT 200`, [estado])).rows.map(fila),
  }));
}

const ReferenciaDevolucion = /^[A-Za-z0-9][A-Za-z0-9 ._\-/]{2,79}$/;

export async function decidirReembolso(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'reembolsos:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ decision: z.enum(['APROBAR', 'RECHAZAR']), motivo: z.string().trim().max(1000).optional() }).parse(body);
  if (d.decision === 'RECHAZAR' && (d.motivo?.length ?? 0) < 10) throw invalid('Para rechazar explica el motivo (al menos 10 caracteres): la persona lo recibirá y puede acudir a la Superintendencia de Industria y Comercio.');
  const r = await db.withPlatform(async (tx) => {
    const x = (await tx.query(`SELECT r.*, p.referencia FROM reembolso r JOIN payment p ON p.id=r.payment_id WHERE r.id=$1 FOR UPDATE OF r`, [id])).rows[0];
    if (!x) throw notFound();
    if (x.estado !== 'EN_REVISION') throw new AppError('CONFLICT', 'Esta solicitud ya fue decidida.');
    const estado = d.decision === 'APROBAR' ? 'APROBADO' : 'RECHAZADO';
    const motivo = d.motivo || (d.decision === 'APROBAR' ? 'Aprobado tras revisión.' : '');
    await tx.query(`UPDATE reembolso SET estado=$2, decidido_en=now(), decidido_por=$3, decision_motivo=$4, actualizado_en=now() WHERE id=$1`, [id, estado, op.user.email, motivo]);
    await auditar(tx, op, { accion: `reembolso.${d.decision === 'APROBAR' ? 'aprobar' : 'rechazar'}`, recurso: 'reembolso', recursoId: id, tenantId: x.tenant_id, motivo, resultado: 'EXITO', detalle: { radicado: x.radicado, monto: Number(x.monto) } });
    await encolarCorreo(tx, { tenantId: null, para: x.solicitante_email, clave: `rb:${id}:decision`,
      correo: plantillas.reembolsoDecision({ nombre: x.solicitante_nombre, radicado: x.radicado, aprobado: d.decision === 'APROBAR', motivo, monto: cop(Number(x.monto)), vence: new Date(x.vence_en).toISOString().slice(0, 10), medio: NOMBRE_MEDIO[x.medio_preferido] }) });
    return { ok: true, estado };
  });
  return r;
}

/** Registra que el dinero ya se devolvió (en Wompi o por transferencia): cierra la solicitud y marca el pago. */
export async function registrarDevolucion(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'reembolsos:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ referencia: z.string().trim() }).parse(body);
  if (!ReferenciaDevolucion.test(d.referencia)) throw invalid('Escribe la referencia de la devolución (el comprobante de Wompi o de la transferencia), de 3 a 80 caracteres.');
  return db.withPlatform(async (tx) => {
    const x = (await tx.query(`SELECT * FROM reembolso WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!x) throw notFound();
    if (x.estado !== 'APROBADO') throw new AppError('CONFLICT', x.estado === 'REEMBOLSADO' ? 'Esta devolución ya está registrada.' : 'Solo se registra la devolución de una solicitud aprobada.');
    await tx.query(`UPDATE reembolso SET estado='REEMBOLSADO', referencia_devolucion=$2, reembolsado_en=now(), actualizado_en=now() WHERE id=$1`, [id, d.referencia]);
    await tx.query(`UPDATE payment SET estado='REEMBOLSADO', actualizado_en=now() WHERE id=$1 AND estado='APROBADO'`, [x.payment_id]);
    await auditar(tx, op, { accion: 'reembolso.devuelto', recurso: 'reembolso', recursoId: id, tenantId: x.tenant_id, resultado: 'EXITO', detalle: { radicado: x.radicado, monto: Number(x.monto), tarde: new Date(x.vence_en).getTime() < Date.now() } });
    await encolarCorreo(tx, { tenantId: null, para: x.solicitante_email, clave: `rb:${id}:devuelto`,
      correo: plantillas.reembolsoDevuelto({ nombre: x.solicitante_nombre, radicado: x.radicado, monto: cop(Number(x.monto)), referencia: d.referencia, medio: NOMBRE_MEDIO[x.medio_preferido] }) });
    return { ok: true, estado: 'REEMBOLSADO' };
  });
}
