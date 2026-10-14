/**
 * Utilidades de tiempo. Se almacena en UTC (timestamptz) y el horario del negocio
 * se resuelve con su zona horaria IANA (tenant.zona_horaria). La conversión usa
 * Intl, así que respeta zonas con horario de verano aunque Colombia no lo tenga.
 */
export const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'] as const;
export const ZONA_POR_DEFECTO = 'America/Bogota';

const formatos = new Map<string, Intl.DateTimeFormat>();
function formato(tz: string): Intl.DateTimeFormat {
  let f = formatos.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatos.set(tz, f);
  }
  return f;
}

/** Zona válida o la de por defecto (una zona mal escrita no debe tumbar la agenda). */
export function zonaValida(tz: string | null | undefined): string {
  if (!tz) return ZONA_POR_DEFECTO;
  try { formato(tz); return tz; } catch { return ZONA_POR_DEFECTO; }
}

function partes(d: Date, tz: string) {
  const p = Object.fromEntries(formato(zonaValida(tz)).formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** Desfase de la zona respecto a UTC en minutos para un instante dado. */
export function offsetMinutes(d: Date, tz: string): number {
  const p = partes(d, tz);
  const comoUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((comoUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** Instante UTC a partir de fecha y hora locales del negocio. */
export function localToUtc(fecha: string, hhmm: string, tz = ZONA_POR_DEFECTO): Date {
  const [y, m, d] = fecha.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const ingenuo = Date.UTC(y, m - 1, d, h, mi);
  // Dos pasadas: la segunda corrige si el desfase cambia entre la estimación y el resultado.
  let t = ingenuo - offsetMinutes(new Date(ingenuo), tz) * 60000;
  t = ingenuo - offsetMinutes(new Date(t), tz) * 60000;
  return new Date(t);
}

/** Partes locales de un instante UTC. */
export function utcToLocal(d: Date, tz = ZONA_POR_DEFECTO) {
  const p = partes(d, tz);
  const fecha = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const hora = `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  const dia = DIAS[new Date(`${fecha}T12:00:00Z`).getUTCDay()];
  return { fecha, hora, dia };
}

export function todayLocal(tz = ZONA_POR_DEFECTO): string {
  return utcToLocal(new Date(), tz).fecha;
}

/** Inicio y fin (UTC) del día local indicado. */
export function rangoDia(fecha: string, tz = ZONA_POR_DEFECTO): { desde: Date; hasta: Date } {
  return { desde: localToUtc(fecha, '00:00', tz), hasta: localToUtc(addDays(fecha, 1), '00:00', tz) };
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
