/**
 * Utilidades de tiempo. Se almacena en UTC (timestamptz) y el horario del negocio
 * se resuelve en presentación (PRO-SW-002 §15). Colombia no aplica horario de
 * verano, por lo que America/Bogota es un desfase fijo de −05:00.
 */
const OFFSETS: Record<string, string> = { 'America/Bogota': '-05:00' };
export const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'] as const;

export function offsetOf(tz: string): string {
  return OFFSETS[tz] ?? '-05:00';
}

/** Instante UTC a partir de fecha y hora locales del negocio. */
export function localToUtc(fecha: string, hhmm: string, tz = 'America/Bogota'): Date {
  return new Date(`${fecha}T${hhmm}:00${offsetOf(tz)}`);
}

/** Partes locales de un instante UTC. */
export function utcToLocal(d: Date, tz = 'America/Bogota') {
  const [sign, hh, mm] = offsetOf(tz).match(/([+-])(\d{2}):(\d{2})/)!.slice(1);
  const offMin = (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm));
  const local = new Date(d.getTime() + offMin * 60000);
  const fecha = local.toISOString().slice(0, 10);
  const hora = local.toISOString().slice(11, 16);
  return { fecha, hora, dia: DIAS[local.getUTCDay()] };
}

export function todayLocal(tz = 'America/Bogota'): string {
  return utcToLocal(new Date(), tz).fecha;
}

export function addDays(fecha: string, n: number): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function formatFechaLarga(fecha: string): string {
  const d = new Date(`${fecha}T12:00:00Z`);
  return d.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
export function minToHhmm(n: number): string {
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
