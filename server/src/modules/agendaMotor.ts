import type { Tx } from '../db/index.js';
import { zonaDe } from '../core/tenant.js';
import { invalid, notFound } from '../lib/errors.js';
import { isUuid } from '../lib/util.js';
import { addDays, hhmmToMin, localToUtc, minToHhmm, rangoDia, todayLocal, utcToLocal } from '../lib/time.js';
import { festivoDe } from '../lib/festivos.js';

/**
 * Motor de disponibilidad de la agenda. UNA sola función calcula los huecos reales y la usan la IA, el panel
 * y las automatizaciones (lista de espera, recurrencias):
 *
 *   horario del recurso − descanso − excepciones (vacaciones, bloqueos) − festivos − citas vivas con sus
 *   buffers − anticipación mínima, dentro del horizonte, en la zona horaria del negocio.
 *
 * Un servicio puede exigir a la vez un segundo recurso (groomer + mesa): solo se ofrece si los dos están
 * libres. La elección del recurso cuando el cliente no pide a nadie sigue la regla de la empresa.
 */
export interface AjustesAgenda {
  anticipacion_min: number; horizonte_dias: number; horas_cancelacion: number;
  confirmacion: 'AL_CREAR' | 'CLIENTE'; asignacion: 'PRIMERO_LIBRE' | 'REPARTIR' | 'PREFERIDO';
  usar_festivos: boolean; inasistencia_min: number; inasistencia_accion: 'MARCAR' | 'PREGUNTAR'; espera_oferta_min: number;
}
export const AJUSTES_AGENDA_DEFECTO: AjustesAgenda = {
  anticipacion_min: 15, horizonte_dias: 60, horas_cancelacion: 2, confirmacion: 'CLIENTE', asignacion: 'PRIMERO_LIBRE',
  usar_festivos: true, inasistencia_min: 30, inasistencia_accion: 'MARCAR', espera_oferta_min: 30,
};

export async function ajustesAgenda(tx: Tx): Promise<AjustesAgenda> {
  const r = (await tx.query(`SELECT * FROM agenda_ajustes LIMIT 1`)).rows[0];
  if (!r) return { ...AJUSTES_AGENDA_DEFECTO };
  const { tenant_id: _t, actualizado_en: _a, actualizado_por: _p, ...resto } = r;
  return { ...AJUSTES_AGENDA_DEFECTO, ...resto };
}

export interface Slot {
  recurso_id: string; recurso: string; inicio: string; hora: string; fecha?: string;
  recurso_secundario_id?: string | null; recurso_secundario?: string | null;
}

interface Intervalo { a: number; b: number; recurso: string; motivo?: string }
const solapa = (a1: number, b1: number, a2: number, b2: number) => a1 < b2 && a2 < b1;

export interface OpcionesHuecos {
  productId: string;
  fecha: string;
  resourceId?: string | null;
  limite?: number;
  desdeHora?: string | null;
  excluirCita?: string | null;
  /** El panel agenda sin la anticipación mínima (atención en el mostrador); nunca en el pasado. */
  sinAnticipacion?: boolean;
  /** Duración distinta de la del servicio (estirar una cita en el calendario). */
  duracionMin?: number;
  /** El panel coloca citas cada 15 minutos (arrastrar y soltar); la IA ofrece cada 30 en servicios largos. */
  paso15?: boolean;
}

/** Recursos que prestan el servicio (principales) y los que debe ocupar a la vez (secundarios). */
async function recursosDelServicio(tx: Tx, p: any, resourceId?: string | null) {
  const activos = (await tx.query(`SELECT id, nombre, horario, descanso, tipo FROM resource WHERE activo ORDER BY nombre`)).rows;
  const secundarios: string[] = p.recursos_secundarios ?? [];
  let principales = p.recursos_permitidos?.length
    ? activos.filter((r: any) => p.recursos_permitidos.includes(r.id))
    : activos.filter((r: any) => r.tipo !== 'ESPACIO' && !secundarios.includes(r.id));
  if (resourceId) principales = principales.filter((r: any) => r.id === resourceId);
  return { principales, secundarios: activos.filter((r: any) => secundarios.includes(r.id)), todos: activos };
}

export async function huecos(tx: Tx, o: OpcionesHuecos): Promise<Slot[]> {
  if (!isUuid(o.productId)) throw notFound();
  if (o.resourceId && !isUuid(o.resourceId)) throw notFound();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.fecha)) throw invalid('Fecha no válida.');
  const p = (await tx.query(
    `SELECT id, duracion_min, tipo, buffer_antes_min, buffer_despues_min, recursos_permitidos, recursos_secundarios FROM product WHERE id=$1 AND eliminado_en IS NULL AND activo`, [o.productId])).rows[0];
  if (!p) throw notFound();
  if (p.tipo !== 'SERVICIO' || !p.duracion_min) throw invalid('Ese ítem no se agenda.');
  const zona = await zonaDe(tx);
  const aj = await ajustesAgenda(tx);
  const hoy = todayLocal(zona);
  if (o.fecha > addDays(hoy, aj.horizonte_dias)) return [];
  if (aj.usar_festivos && festivoDe(o.fecha)) return [];
  const { principales, secundarios } = await recursosDelServicio(tx, p, o.resourceId);
  if (o.resourceId && !principales.length) {
    const existe = (await tx.query(`SELECT 1 FROM resource WHERE id=$1`, [o.resourceId])).rows[0];
    if (!existe) throw notFound();
    return [];
  }
  const necesitaSecundario = (p.recursos_secundarios ?? []).length > 0;
  if (necesitaSecundario && !secundarios.length) return [];

  const dia = utcToLocal(localToUtc(o.fecha, '12:00', zona), zona).dia;
  const { desde, hasta } = rangoDia(o.fecha, zona);
  // Ventana amplia para atrapar buffers que crucen la medianoche.
  const d0 = new Date(desde.getTime() - 6 * 3600_000).toISOString();
  const d1 = new Date(hasta.getTime() + 6 * 3600_000).toISOString();
  const ocupados: Intervalo[] = [];
  for (const c of (await tx.query(
    `SELECT a.resource_id, a.recurso_secundario_id, a.inicio, a.fin, p.buffer_antes_min, p.buffer_despues_min
     FROM appointment a JOIN product p ON p.id=a.product_id
     WHERE a.estado IN ('RESERVADA','CONFIRMADA','ATENDIDA') AND a.inicio < $2 AND a.fin > $1 ${o.excluirCita ? 'AND a.id <> $3' : ''}`,
    o.excluirCita ? [d0, d1, o.excluirCita] : [d0, d1])).rows) {
    const a = new Date(c.inicio).getTime() - Number(c.buffer_antes_min ?? 0) * 60_000;
    const b = new Date(c.fin).getTime() + Number(c.buffer_despues_min ?? 0) * 60_000;
    ocupados.push({ a, b, recurso: c.resource_id });
    if (c.recurso_secundario_id) ocupados.push({ a, b, recurso: c.recurso_secundario_id });
  }
  const excepciones = (await tx.query(`SELECT resource_id, desde, hasta, motivo FROM resource_excepcion WHERE desde < $2 AND hasta > $1`, [d0, d1])).rows
    .map((e: any) => ({ a: new Date(e.desde).getTime(), b: new Date(e.hasta).getTime(), recurso: e.resource_id as string | null }));

  const libre = (r: any, a: number, b: number, conBuffers: { a: number; b: number }) => {
    const h = r.horario?.[dia] as [string, string] | undefined;
    if (!h) return false;
    const abre = localToUtc(o.fecha, h[0], zona).getTime();
    const cierra = localToUtc(o.fecha, h[1], zona).getTime();
    if (a < abre || b > cierra) return false;
    if (r.descanso?.inicio && r.descanso?.fin) {
      const da = localToUtc(o.fecha, r.descanso.inicio, zona).getTime();
      const db = localToUtc(o.fecha, r.descanso.fin, zona).getTime();
      if (solapa(a, b, da, db)) return false;
    }
    if (excepciones.some((e) => (e.recurso === null || e.recurso === r.id) && solapa(a, b, e.a, e.b))) return false;
    return !ocupados.some((x) => x.recurso === r.id && solapa(conBuffers.a, conBuffers.b, x.a, x.b));
  };

  const dur = o.duracionMin ?? Number(p.duracion_min);
  const bufA = Number(p.buffer_antes_min ?? 0) * 60_000;
  const bufD = Number(p.buffer_despues_min ?? 0) * 60_000;
  const minimo = Date.now() + (o.sinAnticipacion ? 0 : aj.anticipacion_min) * 60_000;
  const paso = o.paso15 || dur < 30 ? 15 : 30;
  const out: Slot[] = [];
  for (const r of principales) {
    const h = r.horario?.[dia] as [string, string] | undefined;
    if (!h) continue;
    for (let m = hhmmToMin(h[0]); m + dur <= hhmmToMin(h[1]); m += 15) {
      if (m % paso !== 0) continue;
      if (o.desdeHora && m < hhmmToMin(o.desdeHora)) continue;
      const ini = localToUtc(o.fecha, minToHhmm(m), zona).getTime();
      if (ini < minimo) continue;
      const fin = ini + dur * 60_000;
      const conBuffers = { a: ini - bufA, b: fin + bufD };
      if (!libre(r, ini, fin, conBuffers)) continue;
      let sec: any = null;
      if (necesitaSecundario) {
        sec = secundarios.find((s: any) => s.id !== r.id && libre(s, ini, fin, conBuffers));
        if (!sec) continue;
      }
      out.push({ recurso_id: r.id, recurso: r.nombre, inicio: new Date(ini).toISOString(), hora: minToHhmm(m), fecha: o.fecha, recurso_secundario_id: sec?.id ?? null, recurso_secundario: sec?.nombre ?? null });
    }
  }
  out.sort((a, b) => a.inicio.localeCompare(b.inicio) || a.recurso.localeCompare(b.recurso));
  return out.slice(0, o.limite ?? 12);
}

/**
 * Elige el recurso para un mismo inicio cuando el cliente no pidió a nadie, según la regla de la empresa:
 * el primero libre (orden alfabético), repartir la carga del día o el preferido del cliente por su historial.
 */
export async function elegirRecurso(tx: Tx, candidatos: Slot[], o: { customerId?: string | null; fecha: string }): Promise<Slot> {
  if (candidatos.length <= 1) return candidatos[0];
  const aj = await ajustesAgenda(tx);
  if (aj.asignacion === 'REPARTIR') {
    const zona = await zonaDe(tx);
    const { desde, hasta } = rangoDia(o.fecha, zona);
    const carga = new Map((await tx.query(
      `SELECT resource_id, count(*)::int AS n FROM appointment WHERE estado IN ('RESERVADA','CONFIRMADA') AND inicio >= $1 AND inicio < $2 GROUP BY resource_id`,
      [desde.toISOString(), hasta.toISOString()])).rows.map((r: any) => [r.resource_id, r.n]));
    return [...candidatos].sort((a, b) => (carga.get(a.recurso_id) ?? 0) - (carga.get(b.recurso_id) ?? 0) || a.recurso.localeCompare(b.recurso))[0];
  }
  if (aj.asignacion === 'PREFERIDO' && o.customerId) {
    const pref = (await tx.query(
      `SELECT resource_id, count(*)::int AS n FROM appointment WHERE customer_id=$1 AND estado IN ('ATENDIDA','CONFIRMADA','RESERVADA') GROUP BY resource_id ORDER BY n DESC`, [o.customerId])).rows;
    for (const p of pref) { const s = candidatos.find((c) => c.recurso_id === p.resource_id); if (s) return s; }
  }
  return candidatos[0];
}

/** Los 3 huecos más cercanos al pedido (mismo día primero, luego los días siguientes). */
export async function sugerencias(tx: Tx, o: { productId: string; inicio: Date; resourceId?: string | null; excluirCita?: string | null; cuantas?: number; sinAnticipacion?: boolean }): Promise<Slot[]> {
  const zona = await zonaDe(tx);
  const cuantas = o.cuantas ?? 3;
  const local = utcToLocal(o.inicio, zona);
  const base = { productId: o.productId, resourceId: o.resourceId ?? null, excluirCita: o.excluirCita ?? null, limite: 500, sinAnticipacion: o.sinAnticipacion };
  const mismoDia = await huecos(tx, { ...base, fecha: local.fecha });
  // Un hueco por hora: no se ofrecen tres recursos distintos a la misma hora.
  const unicos = (l: Slot[]) => l.filter((s, i) => l.findIndex((x) => x.inicio === s.inicio) === i);
  const out = unicos(mismoDia).map((s) => ({ s, d: Math.abs(new Date(s.inicio).getTime() - o.inicio.getTime()) })).sort((a, b) => a.d - b.d).map((x) => x.s).slice(0, cuantas);
  for (let i = 1; i <= 14 && out.length < cuantas; i++) {
    out.push(...unicos(await huecos(tx, { ...base, fecha: addDays(local.fecha, i) })).slice(0, cuantas - out.length));
  }
  return out.sort((a, b) => a.inicio.localeCompare(b.inicio));
}
