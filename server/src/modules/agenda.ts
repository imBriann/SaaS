import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { enqueue, publish } from '../core/events.js';
import { zonaDe } from '../core/tenant.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { addDays, formatFechaLarga, hhmmToMin, localToUtc, minToHhmm, rangoDia, todayLocal, utcToLocal } from '../lib/time.js';
import { festivosEntre } from '../lib/festivos.js';
import { AJUSTES_AGENDA_DEFECTO, ajustesAgenda, elegirRecurso, huecos, sugerencias, type Slot } from './agendaMotor.js';

export type { Slot };

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM.');
const DIAS_SEMANA = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;
export const HorarioSchema = z.partialRecord(z.enum(DIAS_SEMANA), z.tuple([hhmm, hhmm]))
  .refine((h) => Object.values(h).every((r) => r && hhmmToMin(r[0]) < hhmmToMin(r[1])), 'En cada día, la hora de apertura debe ser anterior a la de cierre.');

const RecursoInput = z.object({
  nombre: z.string().trim().min(2, 'Escribe el nombre.').max(40),
  horario: HorarioSchema,
  activo: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color no válido.').nullable().optional(),
  tipo: z.enum(['PROFESIONAL', 'ESPACIO']).optional(),
  descanso: z.object({ inicio: hhmm, fin: hhmm }).refine((d) => hhmmToMin(d.inicio) < hhmmToMin(d.fin), 'El descanso debe empezar antes de terminar.').nullable().optional(),
});

export async function listResources(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'appointment:read');
  return (await tx.query(`SELECT id, nombre, horario, activo, user_id, color, tipo, descanso FROM resource ORDER BY activo DESC, nombre`)).rows;
}

export async function createResource(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = RecursoInput.parse(input);
  const id = uuidv7();
  await tx.query(`INSERT INTO resource (id, tenant_id, nombre, horario, activo, color, tipo, descanso) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, ctx.tenantId, d.nombre, JSON.stringify(d.horario), d.activo ?? true, d.color ?? null, d.tipo ?? 'PROFESIONAL', d.descanso ? JSON.stringify(d.descanso) : null]);
  await audit(tx, ctx, { accion: 'agenda.recurso.crear', recurso: 'resource', recursoId: id, resultado: 'EXITO', detalle: { nombre: d.nombre } });
  return { id };
}

export async function updateResource(tx: Tx, ctx: Ctx, id: string, input: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const d = RecursoInput.partial().parse(input);
  const r = (await tx.query(`SELECT id FROM resource WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!r) throw notFound();
  if (d.activo === false) {
    const futuras = (await tx.query(`SELECT count(*)::int AS n FROM appointment WHERE resource_id=$1 AND inicio > now() AND estado IN ('RESERVADA','CONFIRMADA')`, [id])).rows[0].n;
    if (futuras) throw new AppError('CONFLICT', `Tiene ${futuras} cita(s) próximas. Reprográmalas o cancélalas antes de desactivarlo.`);
  }
  await tx.query(
    `UPDATE resource SET nombre=coalesce($2,nombre), horario=coalesce($3::jsonb,horario), activo=coalesce($4,activo),
       color=CASE WHEN $5 THEN $6 ELSE color END, tipo=coalesce($7,tipo), descanso=CASE WHEN $8 THEN $9::jsonb ELSE descanso END WHERE id=$1`,
    [id, d.nombre ?? null, d.horario ? JSON.stringify(d.horario) : null, d.activo ?? null, 'color' in d, d.color ?? null, d.tipo ?? null, 'descanso' in d, d.descanso ? JSON.stringify(d.descanso) : null],
  );
  await audit(tx, ctx, { accion: 'agenda.recurso.editar', recurso: 'resource', recursoId: id, resultado: 'EXITO', detalle: { campos: Object.keys(d) } });
  return { id };
}

/**
 * Disponibilidad de un servicio en una fecha local. Delega en el motor único (agendaMotor.huecos): horario,
 * descanso, excepciones, festivos, citas con buffers y anticipación mínima.
 */
export async function availability(tx: Tx, productId: string, fecha: string, resourceId?: string | null, limite = 12, desdeHora?: string | null, excluirCita?: string | null, sinAnticipacion = false): Promise<Slot[]> {
  return huecos(tx, { productId, fecha, resourceId, limite, desdeHora, excluirCita, sinAnticipacion });
}

/** Los huecos más cercanos a la hora pedida (por defecto 3: no una lista larga). */
export async function alternatives(tx: Tx, productId: string, inicioPedido: Date, resourceId: string | null, cuantas = 3, excluirCita?: string | null): Promise<Slot[]> {
  const zona = await zonaDe(tx);
  return (await sugerencias(tx, { productId, inicio: inicioPedido, resourceId, excluirCita, cuantas })).map((s) => ({ ...s, fecha: s.fecha ?? utcToLocal(new Date(s.inicio), zona).fecha }));
}

export const AppointmentInput = z.object({
  customer_id: z.uuid('Elige un cliente.'),
  product_id: z.uuid('Elige un servicio.'),
  resource_id: z.uuid().optional().nullable(),
  inicio: z.iso.datetime({ offset: true }),
  notas: z.string().max(500).optional().nullable(),
});

/**
 * Serializa las reservas de la agenda del tenant: dos solicitudes simultáneas para la misma franja no pueden
 * pasar ambas la comprobación de disponibilidad. La restricción de exclusión de la base (029) es la segunda
 * barrera: aunque el código fallara, dos citas vivas no se solapan en un mismo recurso.
 */
async function bloquearAgenda(tx: Tx, ctx: Ctx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`agenda:${ctx.tenantId}`]);
}

async function conflicto(tx: Tx, productId: string, ini: Date, resourceId: string | null, excluir?: string | null): Promise<never> {
  const alt = await alternatives(tx, productId, ini, resourceId, 3, excluir);
  throw new AppError('CONFLICT', alt.length ? 'Esa franja ya no está disponible. Te proponemos otras cercanas.' : 'Esa franja ya no está disponible y no hay espacios en los próximos días.', { alternativas: alt });
}

/** Ejecuta un cambio de la cita en un savepoint: si la restricción de exclusión salta, responde con alternativas. */
async function conExclusion<T>(tx: Tx, f: () => Promise<T>, alConflicto: () => Promise<never>): Promise<T> {
  await tx.query('SAVEPOINT cita');
  try {
    const r = await f();
    await tx.query('RELEASE SAVEPOINT cita');
    return r;
  } catch (e: any) {
    await tx.query('ROLLBACK TO SAVEPOINT cita');
    if (e?.code === '23P01') return alConflicto();
    throw e;
  }
}

export type OrigenCita = 'AGENTE' | 'PANEL' | 'AUTOMATIZACION';

/**
 * Crea una cita verificando con el motor que la franja esté libre. Si el cliente no pidió un recurso, se
 * elige según la regla de la empresa. Las FK compuestas impiden usar cliente, servicio o recurso de otro tenant.
 */
export async function insertAppointment(tx: Tx, ctx: Ctx, d: z.infer<typeof AppointmentInput>, origen: OrigenCita, o: { serieId?: string | null } = {}) {
  const p = (await tx.query(`SELECT id, nombre, duracion_min FROM product WHERE id=$1 AND eliminado_en IS NULL AND activo AND tipo='SERVICIO'`, [d.product_id])).rows[0];
  if (!p || !p.duracion_min) throw notFound();
  const c = (await tx.query(`SELECT id, nombre FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [d.customer_id])).rows[0];
  if (!c) throw notFound();
  await bloquearAgenda(tx, ctx);
  const ini = new Date(d.inicio);
  const fin = new Date(ini.getTime() + Number(p.duracion_min) * 60000);
  const zona = await zonaDe(tx);
  const fecha = utcToLocal(ini, zona).fecha;
  const libres = await huecos(tx, { productId: d.product_id, fecha, resourceId: d.resource_id ?? null, limite: 1000, sinAnticipacion: origen === 'PANEL', paso15: origen === 'PANEL' });
  const mismos = libres.filter((s) => new Date(s.inicio).getTime() === ini.getTime());
  if (!mismos.length) return conflicto(tx, d.product_id, ini, d.resource_id ?? null);
  const slot = d.resource_id ? mismos[0] : await elegirRecurso(tx, mismos, { customerId: d.customer_id, fecha });
  const aj = await ajustesAgenda(tx);
  const confirmada = aj.confirmacion === 'AL_CREAR';
  const id = uuidv7();
  await conExclusion(tx, () => tx.query(
    `INSERT INTO appointment (id, tenant_id, customer_id, product_id, resource_id, recurso_secundario_id, inicio, fin, estado, origen, notas, serie_id, confirmada_en, canal_confirmacion)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, ctx.tenantId, d.customer_id, d.product_id, slot.recurso_id, slot.recurso_secundario_id ?? null, ini.toISOString(), fin.toISOString(),
      confirmada ? 'CONFIRMADA' : 'RESERVADA', origen, d.notas ?? null, o.serieId ?? null, confirmada ? new Date().toISOString() : null, confirmada ? 'AUTOMATICA' : null],
  ), () => conflicto(tx, d.product_id, ini, d.resource_id ?? null));
  await publish(tx, ctx, 'cita_creada', { appointment_id: id, customer_id: d.customer_id, origen });
  return {
    id, servicio: p.nombre, cliente: c.nombre, recurso: slot.recurso, recurso_secundario: slot.recurso_secundario ?? null, inicio: ini.toISOString(), hora: slot.hora,
    fecha_texto: formatFechaLarga(fecha), estado: confirmada ? 'CONFIRMADA' : 'RESERVADA',
  };
}

export async function createAppointment(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'appointment:create');
  requireWritable(ctx);
  const d = AppointmentInput.parse(input);
  const r = await insertAppointment(tx, ctx, d, 'PANEL');
  await audit(tx, ctx, { accion: 'agenda.cita.crear', recurso: 'appointment', recursoId: r.id, resultado: 'EXITO' });
  return r;
}

/** Política de la empresa: horas mínimas antes de la cita para que el cliente cancele o reprograme por el chat. */
export async function exigirPoliticaCliente(tx: Tx, inicio: Date, accion: 'cancelar' | 'reprogramar') {
  const aj = await ajustesAgenda(tx);
  if (inicio.getTime() - Date.now() < aj.horas_cancelacion * 3_600_000) {
    throw new AppError('CONFLICT', `Faltan menos de ${aj.horas_cancelacion} ${aj.horas_cancelacion === 1 ? 'hora' : 'horas'} para la cita: por la política del negocio ya no se puede ${accion} por este chat. Si es necesario, el equipo te ayuda.`, { motivo: 'POLITICA_HORAS' });
  }
}

const MoverInput = z.object({
  inicio: z.iso.datetime({ offset: true }),
  resource_id: z.uuid().optional().nullable(),
  duracion_min: z.number().int().min(5).max(720).optional(),
  avisar: z.boolean().optional(),
});

/**
 * Reprogramar o mover una cita (también arrastrarla o estirarla en el calendario). Pasa por el mismo motor:
 * si choca, no se mueve y se proponen alternativas. Con `soloCliente`, solo una cita del propio cliente y
 * respetando la política de horas.
 */
export async function moverCita(tx: Tx, ctx: Ctx, id: string, input: unknown, o: { soloCliente?: string; origen?: OrigenCita } = {}) {
  if (!isUuid(id)) throw notFound();
  const d = MoverInput.parse(input);
  await bloquearAgenda(tx, ctx);
  const a = (await tx.query(
    `SELECT a.*, p.duracion_min, p.nombre AS servicio FROM appointment a JOIN product p ON p.id=a.product_id WHERE a.id=$1 ${o.soloCliente ? 'AND a.customer_id=$2' : ''} FOR UPDATE OF a`,
    o.soloCliente ? [id, o.soloCliente] : [id])).rows[0];
  if (!a) throw notFound();
  if (!['RESERVADA', 'CONFIRMADA'].includes(a.estado)) throw new AppError('CONFLICT', 'Solo se reprograman citas reservadas o confirmadas.');
  if (o.soloCliente) await exigirPoliticaCliente(tx, new Date(a.inicio), 'reprogramar');
  const ini = new Date(d.inicio);
  const dur = d.duracion_min ?? Math.round((new Date(a.fin).getTime() - new Date(a.inicio).getTime()) / 60000) ?? Number(a.duracion_min);
  const zona = await zonaDe(tx);
  const fecha = utcToLocal(ini, zona).fecha;
  // En el panel la cita conserva su recurso salvo que se suelte en otra columna; el cliente (chat) acepta cualquiera.
  const objetivo = d.resource_id ?? (o.soloCliente ? null : a.resource_id);
  const libres = await huecos(tx, { productId: a.product_id, fecha, resourceId: objetivo, limite: 2000, excluirCita: id, sinAnticipacion: !o.soloCliente, paso15: !o.soloCliente, duracionMin: dur });
  const mismos = libres.filter((s) => new Date(s.inicio).getTime() === ini.getTime());
  const slot = mismos.find((s) => s.recurso_id === a.resource_id) ?? mismos[0];
  if (!slot) return conflicto(tx, a.product_id, ini, objetivo, id);
  const fin = new Date(ini.getTime() + dur * 60000);
  await conExclusion(tx, () => tx.query(
    `UPDATE appointment SET inicio=$2, fin=$3, resource_id=$4, recurso_secundario_id=$5, reprogramada_desde=coalesce(reprogramada_desde, $6), recordatorios='{}'::jsonb WHERE id=$1`,
    [id, ini.toISOString(), fin.toISOString(), slot.recurso_id, slot.recurso_secundario_id ?? a.recurso_secundario_id ?? null, a.inicio]),
  () => conflicto(tx, a.product_id, ini, d.resource_id ?? null, id));
  await audit(tx, ctx, { accion: 'agenda.cita.reprogramar', recurso: 'appointment', recursoId: id, resultado: 'EXITO', detalle: { antes: a.inicio, despues: ini.toISOString(), recurso: slot.recurso, duracion: dur } });
  await publish(tx, ctx, 'cita_reprogramada', { appointment_id: id, customer_id: a.customer_id, avisar: d.avisar !== false });
  // El cupo anterior queda libre: se ofrece a la lista de espera.
  await enqueue(tx, ctx.tenantId, 'ofrecer_cupo', { inicio: a.inicio, product_id: a.product_id, resource_id: a.resource_id }, { claveUnica: `cupo:${id}:${new Date(a.inicio).getTime()}` });
  const l = utcToLocal(ini, zona);
  return { id, inicio: ini.toISOString(), hora: l.hora, fecha: formatFechaLarga(l.fecha), recurso: slot.recurso, servicio: a.servicio, avisar: d.avisar !== false };
}

/** Reprogramar desde el panel (permiso de crear citas). */
export async function rescheduleAppointment(tx: Tx, ctx: Ctx, id: string, input: unknown) {
  requirePerm(ctx, 'appointment:create');
  requireWritable(ctx);
  return moverCita(tx, ctx, id, input, { origen: 'PANEL' });
}

export async function cancelAppointmentCore(tx: Tx, ctx: Ctx, id: string, customerId?: string, motivo?: string) {
  if (!isUuid(id)) throw notFound();
  const a = (await tx.query(
    `SELECT id, estado, customer_id, inicio, product_id, resource_id FROM appointment WHERE id=$1 ${customerId ? 'AND customer_id=$2' : ''} FOR UPDATE`,
    customerId ? [id, customerId] : [id],
  )).rows[0];
  if (!a) throw notFound();
  if (a.estado === 'CANCELADA') return { id, estado: 'CANCELADA' };
  if (!['RESERVADA', 'CONFIRMADA'].includes(a.estado)) throw new AppError('CONFLICT', 'Esa cita ya fue atendida o marcada; no se puede cancelar.');
  if (customerId) await exigirPoliticaCliente(tx, new Date(a.inicio), 'cancelar');
  await tx.query(`UPDATE appointment SET estado='CANCELADA', motivo_cancelacion=$2 WHERE id=$1`, [id, (motivo ?? (customerId ? 'Cancelada por el cliente' : null))?.slice(0, 300) ?? null]);
  await publish(tx, ctx, 'cita_cancelada', { appointment_id: id });
  if (new Date(a.inicio).getTime() > Date.now()) {
    await enqueue(tx, ctx.tenantId, 'ofrecer_cupo', { inicio: a.inicio, product_id: a.product_id, resource_id: a.resource_id }, { claveUnica: `cupo:${id}:${new Date(a.inicio).getTime()}` });
  }
  return { id, estado: 'CANCELADA' };
}

const TRANSICIONES_CITA: Record<string, string[]> = {
  RESERVADA: ['CONFIRMADA', 'CANCELADA', 'ATENDIDA', 'NO_ASISTIO'],
  CONFIRMADA: ['CANCELADA', 'ATENDIDA', 'NO_ASISTIO'],
  ATENDIDA: [], NO_ASISTIO: ['ATENDIDA'], CANCELADA: [],
};

export async function updateAppointmentState(tx: Tx, ctx: Ctx, id: string, estado: string, motivo?: string) {
  const allowed = ['CONFIRMADA', 'CANCELADA', 'ATENDIDA', 'NO_ASISTIO'];
  if (!allowed.includes(estado)) throw invalid('Estado no válido.');
  requirePerm(ctx, estado === 'CANCELADA' ? 'appointment:cancel' : 'appointment:create');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  if (estado === 'CANCELADA') {
    const r = await cancelAppointmentCore(tx, ctx, id, undefined, motivo);
    await audit(tx, ctx, { accion: 'agenda.cita.cancelar', recurso: 'appointment', recursoId: id, resultado: 'EXITO', detalle: motivo ? { motivo } : {} });
    return r;
  }
  return cambiarEstadoCita(tx, ctx, id, estado, ctx.origen === 'WHATSAPP' ? 'WHATSAPP' : 'PANEL');
}

/** Transición de estado sin permiso de rol (la usan el panel tras comprobarlo y las automatizaciones). */
export async function cambiarEstadoCita(tx: Tx, ctx: Ctx, id: string, estado: string, canal: 'WHATSAPP' | 'PANEL' | 'AUTOMATICA' = 'PANEL') {
  const a = (await tx.query(`SELECT estado, inicio FROM appointment WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!a) throw notFound();
  if (a.estado === estado) return { id, estado };
  if (!TRANSICIONES_CITA[a.estado]?.includes(estado)) throw new AppError('CONFLICT', 'La cita ya no admite ese cambio.');
  if (['ATENDIDA', 'NO_ASISTIO'].includes(estado) && new Date(a.inicio).getTime() > Date.now() + 60 * 60000) throw new AppError('CONFLICT', 'Todavía no es la hora de la cita.');
  await tx.query(`UPDATE appointment SET estado=$2, confirmada_en=CASE WHEN $2='CONFIRMADA' THEN now() ELSE confirmada_en END,
                    canal_confirmacion=CASE WHEN $2='CONFIRMADA' THEN $3 ELSE canal_confirmacion END WHERE id=$1`, [id, estado, canal]);
  await audit(tx, ctx, { accion: `agenda.cita.${estado.toLowerCase()}`, recurso: 'appointment', recursoId: id, resultado: 'EXITO', detalle: { canal } });
  return { id, estado };
}

const SELECT_CITAS = `SELECT a.id, a.inicio, a.fin, a.estado, a.origen, a.resource_id, a.recurso_secundario_id, a.product_id, a.notas, a.serie_id, a.confirmada_en,
            a.recordatorios, a.reprogramada_desde, c.id AS customer_id, c.nombre AS cliente, c.telefono, p.nombre AS servicio, p.precio, r.nombre AS recurso, r.color AS color_recurso
     FROM appointment a JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id`;

export async function listDay(tx: Tx, ctx: Ctx, fecha: string) {
  requirePerm(ctx, 'appointment:read');
  const zona = await zonaDe(tx);
  const { desde, hasta } = rangoDia(fecha, zona);
  const citas = (await tx.query(`${SELECT_CITAS} WHERE a.inicio >= $1 AND a.inicio < $2 ORDER BY a.inicio`, [desde.toISOString(), hasta.toISOString()])).rows
    .map((r) => ({ ...r, precio: Number(r.precio), hora: utcToLocal(new Date(r.inicio), zona).hora, hora_fin: utcToLocal(new Date(r.fin), zona).hora }));
  const recursos = (await tx.query(`SELECT id, nombre, horario, color, tipo, descanso FROM resource WHERE activo ORDER BY nombre`)).rows;
  const dia = utcToLocal(localToUtc(fecha, '12:00', zona), zona).dia;
  const rangos = recursos.map((r: any) => r.horario?.[dia]).filter(Boolean) as [string, string][];
  const abre = rangos.length ? Math.min(...rangos.map((x) => hhmmToMin(x[0]))) : 7 * 60;
  const cierra = rangos.length ? Math.max(...rangos.map((x) => hhmmToMin(x[1]))) : 20 * 60;
  return { fecha, zona, dia, abre: minToHhmm(Math.floor(abre / 60) * 60), cierra: minToHhmm(Math.ceil(cierra / 60) * 60), recursos, citas };
}

/**
 * Calendario: citas, recursos, bloqueos y festivos de un rango de fechas locales (día, semana o mes).
 * Máximo 42 días (una cuadrícula de mes).
 */
export async function listarRango(tx: Tx, ctx: Ctx, q: { desde?: string; hasta?: string }) {
  requirePerm(ctx, 'appointment:read');
  const zona = await zonaDe(tx);
  const f = /^\d{4}-\d{2}-\d{2}$/;
  const desde = f.test(q.desde ?? '') ? q.desde! : todayLocal(zona);
  const hasta = f.test(q.hasta ?? '') ? q.hasta! : addDays(desde, 6);
  if (hasta < desde || addDays(desde, 42) < hasta) throw invalid('El rango debe tener entre 1 y 42 días.');
  const a = rangoDia(desde, zona).desde.toISOString();
  const b = rangoDia(hasta, zona).hasta.toISOString();
  const citas = (await tx.query(`${SELECT_CITAS} WHERE a.inicio >= $1 AND a.inicio < $2 ORDER BY a.inicio`, [a, b])).rows.map((r) => {
    const li = utcToLocal(new Date(r.inicio), zona);
    return { ...r, precio: Number(r.precio), fecha: li.fecha, hora: li.hora, hora_fin: utcToLocal(new Date(r.fin), zona).hora };
  });
  const recursos = (await tx.query(`SELECT id, nombre, horario, color, tipo, descanso FROM resource WHERE activo ORDER BY nombre`)).rows;
  const bloqueos = (await tx.query(`SELECT e.id, e.resource_id, e.desde, e.hasta, e.motivo, r.nombre AS recurso FROM resource_excepcion e LEFT JOIN resource r ON r.id=e.resource_id WHERE e.desde < $2 AND e.hasta > $1 ORDER BY e.desde`, [a, b])).rows;
  const aj = await ajustesAgenda(tx);
  const servicios = (await tx.query(`SELECT id, nombre, duracion_min, precio, buffer_antes_min, buffer_despues_min, recursos_permitidos, recursos_secundarios FROM product WHERE tipo='SERVICIO' AND activo AND eliminado_en IS NULL AND duracion_min IS NOT NULL ORDER BY nombre`)).rows
    .map((p: any) => ({ ...p, precio: Number(p.precio) }));
  return { desde, hasta, zona, hoy: todayLocal(zona), recursos, citas, bloqueos, festivos: aj.usar_festivos ? festivosEntre(desde, hasta) : [], servicios, ajustes: aj };
}

/** Detalle de una cita para el panel lateral: cliente, historial, conversación y recordatorios. */
export async function detalleCita(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'appointment:read');
  if (!isUuid(id)) throw notFound();
  const zona = await zonaDe(tx);
  const c = (await tx.query(`${SELECT_CITAS} WHERE a.id=$1`, [id])).rows[0];
  if (!c) throw notFound();
  const historial = (await tx.query(
    `SELECT a.id, a.inicio, a.estado, p.nombre AS servicio FROM appointment a JOIN product p ON p.id=a.product_id WHERE a.customer_id=$1 AND a.id<>$2 ORDER BY a.inicio DESC LIMIT 8`,
    [c.customer_id, id])).rows;
  const conversacion = (await tx.query(`SELECT id FROM conversation WHERE customer_id=$1 ORDER BY actualizado_en DESC LIMIT 1`, [c.customer_id])).rows[0]?.id ?? null;
  const avisos = (await tx.query(`SELECT tipo, canal, estado, motivo, creado_en FROM aviso_proactivo WHERE appointment_id=$1 ORDER BY creado_en`, [id])).rows;
  const secundario = c.recurso_secundario_id ? (await tx.query(`SELECT nombre FROM resource WHERE id=$1`, [c.recurso_secundario_id])).rows[0]?.nombre ?? null : null;
  const li = utcToLocal(new Date(c.inicio), zona);
  return { ...c, precio: Number(c.precio), fecha: li.fecha, hora: li.hora, hora_fin: utcToLocal(new Date(c.fin), zona).hora, recurso_secundario: secundario, historial, conversacion_id: conversacion, avisos };
}

// ---------------------------------------------------------------------------
// Bloqueos y excepciones de horario
// ---------------------------------------------------------------------------
const BloqueoInput = z.object({
  resource_id: z.uuid().nullable().optional(),
  desde: z.iso.datetime({ offset: true }),
  hasta: z.iso.datetime({ offset: true }),
  motivo: z.string().trim().min(2, 'Escribe el motivo (por ejemplo, «vacaciones»).').max(160),
}).refine((b) => new Date(b.hasta) > new Date(b.desde), 'El bloqueo debe terminar después de empezar.');

export async function crearBloqueo(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = BloqueoInput.parse(input);
  if (d.resource_id) { const r = (await tx.query(`SELECT 1 FROM resource WHERE id=$1`, [d.resource_id])).rows[0]; if (!r) throw notFound(); }
  const choques = (await tx.query(
    `SELECT count(*)::int AS n FROM appointment WHERE estado IN ('RESERVADA','CONFIRMADA') AND inicio < $2 AND fin > $1 ${d.resource_id ? 'AND resource_id=$3' : ''}`,
    d.resource_id ? [d.desde, d.hasta, d.resource_id] : [d.desde, d.hasta])).rows[0].n;
  const id = uuidv7();
  await tx.query(`INSERT INTO resource_excepcion (id, tenant_id, resource_id, desde, hasta, motivo, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, ctx.tenantId, d.resource_id ?? null, d.desde, d.hasta, d.motivo, `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  await audit(tx, ctx, { accion: 'agenda.bloqueo.crear', recurso: 'resource_excepcion', recursoId: id, resultado: 'EXITO', detalle: { motivo: d.motivo, citas_en_el_bloqueo: choques } });
  return { id, citas_en_el_bloqueo: choques };
}

export async function quitarBloqueo(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`DELETE FROM resource_excepcion WHERE id=$1 RETURNING motivo`, [id])).rows[0];
  if (!r) throw notFound();
  await audit(tx, ctx, { accion: 'agenda.bloqueo.quitar', recurso: 'resource_excepcion', recursoId: id, resultado: 'EXITO', detalle: { motivo: r.motivo } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Citas recurrentes
// ---------------------------------------------------------------------------
const SerieInput = z.object({
  customer_id: z.uuid('Elige un cliente.'),
  product_id: z.uuid('Elige un servicio.'),
  resource_id: z.uuid().nullable().optional(),
  inicio: z.iso.datetime({ offset: true }),
  cada_semanas: z.number().int().min(1).max(52),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  max_citas: z.number().int().min(2).max(52).nullable().optional(),
}).refine((s) => s.hasta || s.max_citas, 'Indica hasta qué fecha o cuántas citas.');

/** «Cada 4 semanas»: crea todas las citas de la serie que encuentren cupo; las que choquen se informan. */
export async function crearSerie(tx: Tx, ctx: Ctx, input: unknown, origen: OrigenCita = 'PANEL') {
  requirePerm(ctx, 'appointment:create');
  requireWritable(ctx);
  const d = SerieInput.parse(input);
  const zona = await zonaDe(tx);
  const id = uuidv7();
  await tx.query(`INSERT INTO appointment_serie (id, tenant_id, customer_id, product_id, resource_id, cada_semanas, hasta, max_citas, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.tenantId, d.customer_id, d.product_id, d.resource_id ?? null, d.cada_semanas, d.hasta ?? null, d.max_citas ?? null, `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  const max = Math.min(d.max_citas ?? 52, 52);
  const creadas: any[] = [];
  const sinCupo: string[] = [];
  for (let i = 0; i < max; i++) {
    const ini = new Date(new Date(d.inicio).getTime() + i * d.cada_semanas * 7 * 86_400_000);
    const fecha = utcToLocal(ini, zona).fecha;
    if (d.hasta && fecha > d.hasta) break;
    await tx.query('SAVEPOINT serie');
    try {
      creadas.push(await insertAppointment(tx, ctx, { customer_id: d.customer_id, product_id: d.product_id, resource_id: d.resource_id ?? null, inicio: ini.toISOString() }, i === 0 ? origen : 'AUTOMATIZACION', { serieId: id }));
      await tx.query('RELEASE SAVEPOINT serie');
    } catch (e) {
      await tx.query('ROLLBACK TO SAVEPOINT serie');
      if (!(e instanceof AppError) || e.code !== 'CONFLICT') throw e;
      sinCupo.push(formatFechaLarga(fecha));
    }
  }
  if (!creadas.length) throw new AppError('CONFLICT', 'Ninguna fecha de la serie tiene ese horario libre. Prueba otra hora.');
  await audit(tx, ctx, { accion: 'agenda.serie.crear', recurso: 'appointment_serie', recursoId: id, resultado: 'EXITO', detalle: { citas: creadas.length, sin_cupo: sinCupo.length } });
  return { serie_id: id, creadas: creadas.length, sin_cupo: sinCupo };
}

// ---------------------------------------------------------------------------
// Lista de espera
// ---------------------------------------------------------------------------
export const ListaEsperaInput = z.object({
  customer_id: z.uuid(),
  product_id: z.uuid(),
  resource_id: z.uuid().nullable().optional(),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  franjas: z.array(z.enum(['MANANA', 'TARDE', 'NOCHE'])).min(1).max(3).optional(),
}).refine((l) => l.hasta >= l.desde, 'La fecha final debe ser igual o posterior a la inicial.');

export async function unirseListaEspera(tx: Tx, ctx: Ctx, d: z.infer<typeof ListaEsperaInput>) {
  const p = (await tx.query(`SELECT nombre FROM product WHERE id=$1 AND tipo='SERVICIO' AND activo AND eliminado_en IS NULL`, [d.product_id])).rows[0];
  if (!p) throw notFound();
  const c = (await tx.query(`SELECT 1 FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [d.customer_id])).rows[0];
  if (!c) throw notFound();
  const ya = (await tx.query(`SELECT id FROM lista_espera WHERE customer_id=$1 AND product_id=$2 AND estado IN ('ESPERANDO','OFRECIDA')`, [d.customer_id, d.product_id])).rows[0];
  if (ya) return { id: ya.id, existente: true, servicio: p.nombre };
  const id = uuidv7();
  await tx.query(`INSERT INTO lista_espera (id, tenant_id, customer_id, product_id, resource_id, desde, hasta, franjas, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.tenantId, d.customer_id, d.product_id, d.resource_id ?? null, d.desde, d.hasta, d.franjas ?? ['MANANA', 'TARDE', 'NOCHE'], `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  await audit(tx, ctx, { accion: 'agenda.lista_espera.unirse', recurso: 'lista_espera', recursoId: id, resultado: 'EXITO' });
  return { id, existente: false, servicio: p.nombre };
}

export async function listarListaEspera(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'appointment:read');
  return (await tx.query(
    `SELECT l.id, l.desde, l.hasta, l.franjas, l.estado, l.oferta, l.creado_en, c.nombre AS cliente, p.nombre AS servicio
     FROM lista_espera l JOIN customer c ON c.id=l.customer_id JOIN product p ON p.id=l.product_id
     WHERE l.estado IN ('ESPERANDO','OFRECIDA') ORDER BY l.creado_en`)).rows;
}

// ---------------------------------------------------------------------------
// Ajustes de la agenda
// ---------------------------------------------------------------------------
const AjustesInput = z.object({
  anticipacion_min: z.number().int().min(0).max(10080),
  horizonte_dias: z.number().int().min(1).max(365),
  horas_cancelacion: z.number().int().min(0).max(168),
  confirmacion: z.enum(['AL_CREAR', 'CLIENTE']),
  asignacion: z.enum(['PRIMERO_LIBRE', 'REPARTIR', 'PREFERIDO']),
  usar_festivos: z.boolean(),
  inasistencia_min: z.number().int().min(5).max(1440),
  inasistencia_accion: z.enum(['MARCAR', 'PREGUNTAR']),
  espera_oferta_min: z.number().int().min(5).max(1440),
}).partial().strict();

export async function obtenerAjustesAgenda(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'appointment:read');
  return { ...(await ajustesAgenda(tx)), defecto: AJUSTES_AGENDA_DEFECTO };
}

export async function guardarAjustesAgenda(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = AjustesInput.parse(body ?? {});
  const k = Object.keys(d) as (keyof typeof d)[];
  await tx.query(`INSERT INTO agenda_ajustes (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.tenantId]);
  if (k.length) await tx.query(`UPDATE agenda_ajustes SET ${k.map((x, i) => `${x}=$${i + 2}`).join(', ')}, actualizado_en=now(), actualizado_por=$${k.length + 2} WHERE tenant_id=$1`,
    [ctx.tenantId, ...k.map((x) => d[x]), `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  await audit(tx, ctx, { accion: 'agenda.ajustes', recurso: 'agenda_ajustes', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { campos: k } });
  return ajustesAgenda(tx);
}

export async function customerAppointments(tx: Tx, customerId: string) {
  const zona = await zonaDe(tx);
  return (await tx.query(
    `SELECT a.id, a.inicio, a.estado, p.nombre AS servicio, r.nombre AS recurso FROM appointment a
     JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     WHERE a.customer_id=$1 AND a.inicio > now() AND a.estado IN ('RESERVADA','CONFIRMADA') ORDER BY a.inicio`,
    [customerId],
  )).rows.map((r) => {
    const l = utcToLocal(new Date(r.inicio), zona);
    return { ...r, ...l, fecha: formatFechaLarga(l.fecha) };
  });
}
