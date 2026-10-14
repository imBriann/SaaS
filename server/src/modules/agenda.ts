import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { zonaDe } from '../core/tenant.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { addDays, formatFechaLarga, hhmmToMin, localToUtc, minToHhmm, rangoDia, utcToLocal } from '../lib/time.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora en formato HH:MM.');
const DIAS_SEMANA = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;
export const HorarioSchema = z.partialRecord(z.enum(DIAS_SEMANA), z.tuple([hhmm, hhmm]))
  .refine((h) => Object.values(h).every((r) => r && hhmmToMin(r[0]) < hhmmToMin(r[1])), 'En cada día, la hora de apertura debe ser anterior a la de cierre.');

const RecursoInput = z.object({ nombre: z.string().trim().min(2, 'Escribe el nombre.').max(40), horario: HorarioSchema, activo: z.boolean().optional() });

export async function listResources(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'appointment:read');
  return (await tx.query(`SELECT id, nombre, horario, activo, user_id FROM resource ORDER BY activo DESC, nombre`)).rows;
}

export async function createResource(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = RecursoInput.parse(input);
  const id = uuidv7();
  await tx.query(`INSERT INTO resource (id, tenant_id, nombre, horario, activo) VALUES ($1,$2,$3,$4,$5)`, [id, ctx.tenantId, d.nombre, JSON.stringify(d.horario), d.activo ?? true]);
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
    `UPDATE resource SET nombre=coalesce($2,nombre), horario=coalesce($3::jsonb,horario), activo=coalesce($4,activo) WHERE id=$1`,
    [id, d.nombre ?? null, d.horario ? JSON.stringify(d.horario) : null, d.activo ?? null],
  );
  await audit(tx, ctx, { accion: 'agenda.recurso.editar', recurso: 'resource', recursoId: id, resultado: 'EXITO', detalle: { campos: Object.keys(d) } });
  return { id };
}

export interface Slot { recurso_id: string; recurso: string; inicio: string; hora: string; fecha?: string }

/**
 * Disponibilidad: franjas libres de un servicio en una fecha local, por recurso.
 * Excluye citas no canceladas que se solapen, horas ya pasadas y días sin horario.
 */
export async function availability(tx: Tx, productId: string, fecha: string, resourceId?: string | null, limite = 12, desdeHora?: string | null, excluirCita?: string | null): Promise<Slot[]> {
  if (!isUuid(productId)) throw notFound();
  if (resourceId && !isUuid(resourceId)) throw notFound();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw invalid('Fecha no válida.');
  const p = (await tx.query(`SELECT id, duracion_min, tipo FROM product WHERE id=$1 AND eliminado_en IS NULL AND activo`, [productId])).rows[0];
  if (!p) throw notFound();
  if (p.tipo !== 'SERVICIO' || !p.duracion_min) throw invalid('Ese ítem no se agenda.');
  const zona = await zonaDe(tx);
  const recursos = (await tx.query(
    `SELECT id, nombre, horario FROM resource WHERE activo ${resourceId ? 'AND id=$1' : ''} ORDER BY nombre`,
    resourceId ? [resourceId] : [],
  )).rows;
  if (resourceId && !recursos.length) throw notFound();
  const dia = utcToLocal(localToUtc(fecha, '12:00', zona), zona).dia;
  const { desde, hasta } = rangoDia(fecha, zona);
  const citas = (await tx.query(
    `SELECT resource_id, inicio, fin FROM appointment WHERE estado IN ('RESERVADA','CONFIRMADA','ATENDIDA') AND inicio < $2 AND fin > $1 ${excluirCita ? 'AND id <> $3' : ''}`,
    excluirCita ? [desde.toISOString(), hasta.toISOString(), excluirCita] : [desde.toISOString(), hasta.toISOString()],
  )).rows;
  const ahora = Date.now() + 15 * 60000;
  const dur = Number(p.duracion_min);
  const out: Slot[] = [];
  for (const r of recursos) {
    const h = r.horario?.[dia] as [string, string] | undefined;
    if (!h) continue;
    for (let m = hhmmToMin(h[0]); m + dur <= hhmmToMin(h[1]); m += 15) {
      if (m % 30 !== 0 && dur >= 30) continue; // servicios largos: cada media hora; cortos: cada 15 min
      const ini = localToUtc(fecha, minToHhmm(m), zona);
      const fin = new Date(ini.getTime() + dur * 60000);
      if (ini.getTime() < ahora) continue;
      if (desdeHora && m < hhmmToMin(desdeHora)) continue;
      const ocupado = citas.some((c: any) => c.resource_id === r.id && new Date(c.inicio) < fin && new Date(c.fin) > ini);
      if (!ocupado) out.push({ recurso_id: r.id, recurso: r.nombre, inicio: ini.toISOString(), hora: minToHhmm(m), fecha });
    }
  }
  out.sort((a, b) => a.inicio.localeCompare(b.inicio) || a.recurso.localeCompare(b.recurso));
  return out.slice(0, limite);
}

/**
 * Alternativas cuando la franja pedida no está libre: primero las más cercanas a la
 * hora pedida ese mismo día (antes y después), luego los próximos días.
 */
export async function alternatives(tx: Tx, productId: string, inicioPedido: Date, resourceId: string | null, cuantas = 4, excluirCita?: string | null): Promise<Slot[]> {
  const zona = await zonaDe(tx);
  const local = utcToLocal(inicioPedido, zona);
  const mismoDia = await availability(tx, productId, local.fecha, resourceId, 200, null, excluirCita);
  const cercanas = mismoDia
    .map((s) => ({ s, d: Math.abs(new Date(s.inicio).getTime() - inicioPedido.getTime()) }))
    .sort((a, b) => a.d - b.d).map((x) => x.s).slice(0, cuantas);
  const out = [...cercanas];
  for (let i = 1; i <= 7 && out.length < cuantas; i++) {
    const f = addDays(local.fecha, i);
    out.push(...(await availability(tx, productId, f, resourceId, cuantas - out.length, null, excluirCita)));
  }
  return out.sort((a, b) => a.inicio.localeCompare(b.inicio)).map((s) => ({ ...s, fecha: s.fecha ?? utcToLocal(new Date(s.inicio), zona).fecha }));
}

export const AppointmentInput = z.object({
  customer_id: z.uuid('Elige un cliente.'),
  product_id: z.uuid('Elige un servicio.'),
  resource_id: z.uuid().optional().nullable(),
  inicio: z.iso.datetime({ offset: true }),
  notas: z.string().max(500).optional().nullable(),
});

/**
 * Serializa las reservas de la agenda del tenant: dos solicitudes simultáneas para
 * la misma franja no pueden pasar ambas la comprobación de disponibilidad.
 */
async function bloquearAgenda(tx: Tx, ctx: Ctx) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`agenda:${ctx.tenantId}`]);
}

async function conflicto(tx: Tx, productId: string, ini: Date, resourceId: string | null, excluir?: string | null): Promise<never> {
  const alt = await alternatives(tx, productId, ini, resourceId, 4, excluir);
  throw new AppError('CONFLICT', alt.length ? 'Esa franja ya no está disponible. Te proponemos otras cercanas.' : 'Esa franja ya no está disponible y no hay espacios en los próximos 7 días.', { alternativas: alt });
}

/**
 * Crea una cita verificando que la franja esté libre. Las FK compuestas impiden
 * que cliente, servicio o recurso pertenezcan a otro tenant.
 */
export async function insertAppointment(tx: Tx, ctx: Ctx, d: z.infer<typeof AppointmentInput>, origen: 'AGENTE' | 'PANEL') {
  const p = (await tx.query(`SELECT id, nombre, duracion_min FROM product WHERE id=$1 AND eliminado_en IS NULL AND activo AND tipo='SERVICIO'`, [d.product_id])).rows[0];
  if (!p || !p.duracion_min) throw notFound();
  const c = (await tx.query(`SELECT id, nombre FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [d.customer_id])).rows[0];
  if (!c) throw notFound();
  await bloquearAgenda(tx, ctx);
  const ini = new Date(d.inicio);
  const fin = new Date(ini.getTime() + Number(p.duracion_min) * 60000);
  const zona = await zonaDe(tx);
  const libres = await availability(tx, d.product_id, utcToLocal(ini, zona).fecha, d.resource_id ?? null, 1000);
  const slot = libres.find((s) => new Date(s.inicio).getTime() === ini.getTime());
  if (!slot) return conflicto(tx, d.product_id, ini, d.resource_id ?? null);
  const id = uuidv7();
  await tx.query(
    `INSERT INTO appointment (id, tenant_id, customer_id, product_id, resource_id, inicio, fin, estado, origen, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'RESERVADA',$8,$9)`,
    [id, ctx.tenantId, d.customer_id, d.product_id, slot.recurso_id, ini.toISOString(), fin.toISOString(), origen, d.notas ?? null],
  );
  await publish(tx, ctx, 'cita_creada', { appointment_id: id, customer_id: d.customer_id, origen });
  return { id, servicio: p.nombre, cliente: c.nombre, recurso: slot.recurso, inicio: ini.toISOString(), hora: slot.hora, fecha_texto: formatFechaLarga(utcToLocal(ini, zona).fecha) };
}

export async function createAppointment(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'appointment:create');
  requireWritable(ctx);
  const d = AppointmentInput.parse(input);
  const r = await insertAppointment(tx, ctx, d, 'PANEL');
  await audit(tx, ctx, { accion: 'agenda.cita.crear', recurso: 'appointment', recursoId: r.id, resultado: 'EXITO' });
  return r;
}

/** Reprogramar: misma cita, nueva franja (y opcionalmente otro recurso). */
export async function rescheduleAppointment(tx: Tx, ctx: Ctx, id: string, input: unknown) {
  requirePerm(ctx, 'appointment:create');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const d = z.object({ inicio: z.iso.datetime({ offset: true }), resource_id: z.uuid().optional().nullable() }).parse(input);
  await bloquearAgenda(tx, ctx);
  const a = (await tx.query(`SELECT a.*, p.duracion_min FROM appointment a JOIN product p ON p.id=a.product_id WHERE a.id=$1 FOR UPDATE OF a`, [id])).rows[0];
  if (!a) throw notFound();
  if (!['RESERVADA', 'CONFIRMADA'].includes(a.estado)) throw new AppError('CONFLICT', 'Solo se reprograman citas reservadas o confirmadas.');
  const ini = new Date(d.inicio);
  const zona = await zonaDe(tx);
  const libres = await availability(tx, a.product_id, utcToLocal(ini, zona).fecha, d.resource_id ?? null, 1000, null, id);
  const slot = libres.find((s) => new Date(s.inicio).getTime() === ini.getTime() && (!d.resource_id || s.recurso_id === d.resource_id));
  if (!slot) return conflicto(tx, a.product_id, ini, d.resource_id ?? null, id);
  const fin = new Date(ini.getTime() + Number(a.duracion_min) * 60000);
  await tx.query(`UPDATE appointment SET inicio=$2, fin=$3, resource_id=$4 WHERE id=$1`, [id, ini.toISOString(), fin.toISOString(), slot.recurso_id]);
  await audit(tx, ctx, { accion: 'agenda.cita.reprogramar', recurso: 'appointment', recursoId: id, resultado: 'EXITO', detalle: { antes: a.inicio, despues: ini.toISOString(), recurso: slot.recurso } });
  await publish(tx, ctx, 'cita_reprogramada', { appointment_id: id, customer_id: a.customer_id });
  return { id, inicio: ini.toISOString(), hora: slot.hora, recurso: slot.recurso };
}

export async function cancelAppointmentCore(tx: Tx, ctx: Ctx, id: string, customerId?: string) {
  if (!isUuid(id)) throw notFound();
  const a = (await tx.query(
    `SELECT id, estado, customer_id FROM appointment WHERE id=$1 ${customerId ? 'AND customer_id=$2' : ''} FOR UPDATE`,
    customerId ? [id, customerId] : [id],
  )).rows[0];
  if (!a) throw notFound();
  if (a.estado === 'CANCELADA') return { id, estado: 'CANCELADA' };
  if (!['RESERVADA', 'CONFIRMADA'].includes(a.estado)) throw new AppError('CONFLICT', 'Esa cita ya fue atendida o marcada; no se puede cancelar.');
  await tx.query(`UPDATE appointment SET estado='CANCELADA' WHERE id=$1`, [id]);
  await publish(tx, ctx, 'cita_cancelada', { appointment_id: id });
  return { id, estado: 'CANCELADA' };
}

const TRANSICIONES_CITA: Record<string, string[]> = {
  RESERVADA: ['CONFIRMADA', 'CANCELADA', 'ATENDIDA', 'NO_ASISTIO'],
  CONFIRMADA: ['CANCELADA', 'ATENDIDA', 'NO_ASISTIO'],
  ATENDIDA: [], NO_ASISTIO: ['ATENDIDA'], CANCELADA: [],
};

export async function updateAppointmentState(tx: Tx, ctx: Ctx, id: string, estado: string) {
  const allowed = ['CONFIRMADA', 'CANCELADA', 'ATENDIDA', 'NO_ASISTIO'];
  if (!allowed.includes(estado)) throw invalid('Estado no válido.');
  requirePerm(ctx, estado === 'CANCELADA' ? 'appointment:cancel' : 'appointment:create');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  if (estado === 'CANCELADA') {
    const r = await cancelAppointmentCore(tx, ctx, id);
    await audit(tx, ctx, { accion: 'agenda.cita.cancelar', recurso: 'appointment', recursoId: id, resultado: 'EXITO' });
    return r;
  }
  const a = (await tx.query(`SELECT estado, inicio FROM appointment WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!a) throw notFound();
  if (!TRANSICIONES_CITA[a.estado]?.includes(estado)) throw new AppError('CONFLICT', 'La cita ya no admite ese cambio.');
  if (['ATENDIDA', 'NO_ASISTIO'].includes(estado) && new Date(a.inicio).getTime() > Date.now() + 60 * 60000) throw new AppError('CONFLICT', 'Todavía no es la hora de la cita.');
  await tx.query(`UPDATE appointment SET estado=$2 WHERE id=$1`, [id, estado]);
  await audit(tx, ctx, { accion: `agenda.cita.${estado.toLowerCase()}`, recurso: 'appointment', recursoId: id, resultado: 'EXITO' });
  return { id, estado };
}

export async function listDay(tx: Tx, ctx: Ctx, fecha: string) {
  requirePerm(ctx, 'appointment:read');
  const zona = await zonaDe(tx);
  const { desde, hasta } = rangoDia(fecha, zona);
  const citas = (await tx.query(
    `SELECT a.id, a.inicio, a.fin, a.estado, a.origen, a.resource_id, a.product_id, a.notas, c.id AS customer_id, c.nombre AS cliente, c.telefono,
            p.nombre AS servicio, p.precio, r.nombre AS recurso
     FROM appointment a JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     WHERE a.inicio >= $1 AND a.inicio < $2 ORDER BY a.inicio`,
    [desde.toISOString(), hasta.toISOString()],
  )).rows.map((r) => ({ ...r, precio: Number(r.precio), hora: utcToLocal(new Date(r.inicio), zona).hora, hora_fin: utcToLocal(new Date(r.fin), zona).hora }));
  const recursos = (await tx.query(`SELECT id, nombre, horario FROM resource WHERE activo ORDER BY nombre`)).rows;
  const dia = utcToLocal(localToUtc(fecha, '12:00', zona), zona).dia;
  // Rango visible: del primer horario de apertura al último cierre del día (o 7–20 h).
  const rangos = recursos.map((r: any) => r.horario?.[dia]).filter(Boolean) as [string, string][];
  const abre = rangos.length ? Math.min(...rangos.map((x) => hhmmToMin(x[0]))) : 7 * 60;
  const cierra = rangos.length ? Math.max(...rangos.map((x) => hhmmToMin(x[1]))) : 20 * 60;
  return { fecha, zona, dia, abre: minToHhmm(Math.floor(abre / 60) * 60), cierra: minToHhmm(Math.ceil(cierra / 60) * 60), recursos, citas };
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
