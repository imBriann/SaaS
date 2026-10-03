import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { hhmmToMin, localToUtc, minToHhmm, utcToLocal } from '../lib/time.js';

export async function listResources(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'appointment:read');
  return (await tx.query(`SELECT id, nombre, horario, activo, user_id FROM resource ORDER BY nombre`)).rows;
}

export async function createResource(tx: Tx, ctx: Ctx, input: { nombre: string; horario: Record<string, [string, string]> }) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const id = uuidv7();
  await tx.query(`INSERT INTO resource (id, tenant_id, nombre, horario) VALUES ($1,$2,$3,$4)`, [id, ctx.tenantId, input.nombre, JSON.stringify(input.horario)]);
  await audit(tx, ctx, { accion: 'agenda.recurso.crear', recurso: 'resource', recursoId: id, resultado: 'EXITO' });
  return { id };
}

async function tz(tx: Tx): Promise<string> {
  return (await tx.query(`SELECT zona_horaria FROM tenant LIMIT 1`)).rows[0]?.zona_horaria ?? 'America/Bogota';
}

export interface Slot { recurso_id: string; recurso: string; inicio: string; hora: string }

/**
 * Disponibilidad: franjas libres de un servicio en una fecha local, por recurso.
 * Excluye citas no canceladas que se solapen y horas ya pasadas.
 */
export async function availability(tx: Tx, productId: string, fecha: string, resourceId?: string | null, limite = 12, desdeHora?: string | null): Promise<Slot[]> {
  if (!isUuid(productId)) throw notFound();
  const p = (await tx.query(`SELECT id, duracion_min, tipo FROM product WHERE id=$1 AND eliminado_en IS NULL AND activo`, [productId])).rows[0];
  if (!p) throw notFound();
  if (p.tipo !== 'SERVICIO' || !p.duracion_min) throw invalid('Ese ítem no se agenda.');
  const zona = await tz(tx);
  const recursos = (await tx.query(
    `SELECT id, nombre, horario FROM resource WHERE activo ${resourceId ? 'AND id=$1' : ''} ORDER BY nombre`,
    resourceId ? [resourceId] : [],
  )).rows;
  if (resourceId && !recursos.length) throw notFound();
  const dia = utcToLocal(localToUtc(fecha, '12:00', zona), zona).dia;
  const desde = localToUtc(fecha, '00:00', zona);
  const hasta = new Date(desde.getTime() + 86400000);
  const citas = (await tx.query(
    `SELECT resource_id, inicio, fin FROM appointment WHERE estado NOT IN ('CANCELADA') AND inicio < $2 AND fin > $1`,
    [desde.toISOString(), hasta.toISOString()],
  )).rows;
  const ahora = Date.now() + 15 * 60000;
  const dur = Number(p.duracion_min);
  const out: Slot[] = [];
  for (const r of recursos) {
    const h = r.horario?.[dia] as [string, string] | undefined;
    if (!h) continue;
    for (let m = hhmmToMin(h[0]); m + dur <= hhmmToMin(h[1]); m += 30) {
      const ini = localToUtc(fecha, minToHhmm(m), zona);
      const fin = new Date(ini.getTime() + dur * 60000);
      if (ini.getTime() < ahora) continue;
      if (desdeHora && m < hhmmToMin(desdeHora)) continue;
      const ocupado = citas.some(
        (c: any) => c.resource_id === r.id && new Date(c.inicio) < fin && new Date(c.fin) > ini,
      );
      if (!ocupado) out.push({ recurso_id: r.id, recurso: r.nombre, inicio: ini.toISOString(), hora: minToHhmm(m) });
    }
  }
  out.sort((a, b) => a.inicio.localeCompare(b.inicio));
  return out.slice(0, limite);
}

export const AppointmentInput = z.object({
  customer_id: z.uuid(),
  product_id: z.uuid(),
  resource_id: z.uuid().optional().nullable(),
  inicio: z.iso.datetime({ offset: true }),
  notas: z.string().max(500).optional().nullable(),
});

/**
 * Crea una cita verificando que la franja esté libre. Las FK compuestas impiden
 * que cliente, servicio o recurso pertenezcan a otro tenant.
 */
export async function insertAppointment(
  tx: Tx,
  ctx: Ctx,
  d: z.infer<typeof AppointmentInput>,
  origen: 'AGENTE' | 'PANEL',
) {
  const p = (await tx.query(`SELECT id, nombre, duracion_min FROM product WHERE id=$1 AND eliminado_en IS NULL AND activo AND tipo='SERVICIO'`, [d.product_id])).rows[0];
  if (!p || !p.duracion_min) throw notFound();
  const c = (await tx.query(`SELECT id, nombre FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [d.customer_id])).rows[0];
  if (!c) throw notFound();
  const ini = new Date(d.inicio);
  const fin = new Date(ini.getTime() + Number(p.duracion_min) * 60000);
  const libres = await availability(tx, d.product_id, utcToLocal(ini, await tz(tx)).fecha, d.resource_id ?? null, 500);
  const slot = libres.find((s) => new Date(s.inicio).getTime() === ini.getTime());
  if (!slot) throw new AppError('CONFLICT', 'Esa franja ya no está disponible.');
  const id = uuidv7();
  await tx.query(
    `INSERT INTO appointment (id, tenant_id, customer_id, product_id, resource_id, inicio, fin, estado, origen, notas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'RESERVADA',$8,$9)`,
    [id, ctx.tenantId, d.customer_id, d.product_id, slot.recurso_id, ini.toISOString(), fin.toISOString(), origen, d.notas ?? null],
  );
  await publish(tx, ctx, 'cita_creada', { appointment_id: id, customer_id: d.customer_id, origen });
  return { id, servicio: p.nombre, cliente: c.nombre, recurso: slot.recurso, inicio: ini.toISOString(), hora: slot.hora };
}

export async function createAppointment(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'appointment:create');
  requireWritable(ctx);
  const d = AppointmentInput.parse(input);
  const r = await insertAppointment(tx, ctx, d, 'PANEL');
  await audit(tx, ctx, { accion: 'agenda.cita.crear', recurso: 'appointment', recursoId: r.id, resultado: 'EXITO' });
  return r;
}

export async function cancelAppointmentCore(tx: Tx, ctx: Ctx, id: string, customerId?: string) {
  if (!isUuid(id)) throw notFound();
  const a = (await tx.query(
    `SELECT id, estado, customer_id FROM appointment WHERE id=$1 ${customerId ? 'AND customer_id=$2' : ''} FOR UPDATE`,
    customerId ? [id, customerId] : [id],
  )).rows[0];
  if (!a) throw notFound();
  if (a.estado === 'CANCELADA') return { id, estado: 'CANCELADA' };
  await tx.query(`UPDATE appointment SET estado='CANCELADA' WHERE id=$1`, [id]);
  await publish(tx, ctx, 'cita_cancelada', { appointment_id: id });
  return { id, estado: 'CANCELADA' };
}

export async function updateAppointmentState(tx: Tx, ctx: Ctx, id: string, estado: string) {
  const allowed = ['CONFIRMADA', 'CANCELADA', 'ATENDIDA', 'NO_ASISTIO'];
  if (!allowed.includes(estado)) throw invalid('Estado no válido.');
  requirePerm(ctx, estado === 'CANCELADA' ? 'appointment:cancel' : 'appointment:create');
  requireWritable(ctx);
  if (estado === 'CANCELADA') {
    const r = await cancelAppointmentCore(tx, ctx, id);
    await audit(tx, ctx, { accion: 'agenda.cita.cancelar', recurso: 'appointment', recursoId: id, resultado: 'EXITO' });
    return r;
  }
  if (!isUuid(id)) throw notFound();
  const r = await tx.query(`UPDATE appointment SET estado=$2 WHERE id=$1 RETURNING id`, [id, estado]);
  if (!r.rows[0]) throw notFound();
  await audit(tx, ctx, { accion: `agenda.cita.${estado.toLowerCase()}`, recurso: 'appointment', recursoId: id, resultado: 'EXITO' });
  return { id, estado };
}

export async function listDay(tx: Tx, ctx: Ctx, fecha: string) {
  requirePerm(ctx, 'appointment:read');
  const zona = await tz(tx);
  const desde = localToUtc(fecha, '00:00', zona);
  const hasta = new Date(desde.getTime() + 86400000);
  const citas = (await tx.query(
    `SELECT a.id, a.inicio, a.fin, a.estado, a.origen, a.resource_id, a.notas, c.id AS customer_id, c.nombre AS cliente, c.telefono,
            p.nombre AS servicio, p.precio, r.nombre AS recurso
     FROM appointment a JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     WHERE a.inicio >= $1 AND a.inicio < $2 ORDER BY a.inicio`,
    [desde.toISOString(), hasta.toISOString()],
  )).rows.map((r) => ({ ...r, precio: Number(r.precio), hora: utcToLocal(new Date(r.inicio), zona).hora, hora_fin: utcToLocal(new Date(r.fin), zona).hora }));
  const recursos = (await tx.query(`SELECT id, nombre, horario FROM resource WHERE activo ORDER BY nombre`)).rows;
  return { fecha, recursos, citas };
}

export async function customerAppointments(tx: Tx, customerId: string) {
  const zona = await tz(tx);
  return (await tx.query(
    `SELECT a.id, a.inicio, a.estado, p.nombre AS servicio, r.nombre AS recurso FROM appointment a
     JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     WHERE a.customer_id=$1 AND a.inicio > now() AND a.estado IN ('RESERVADA','CONFIRMADA') ORDER BY a.inicio`,
    [customerId],
  )).rows.map((r) => ({ ...r, ...utcToLocal(new Date(r.inicio), zona) }));
}
