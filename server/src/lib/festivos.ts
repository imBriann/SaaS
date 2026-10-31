/**
 * Festivos de Colombia (Ley 51 de 1983, «ley Emiliani»).
 *
 *  - Fijos: 1 ene, 1 may, 20 jul, 7 ago, 8 dic, 25 dic.
 *  - Se trasladan al lunes siguiente si no caen en lunes: 6 ene (Reyes), 19 mar (San José), 29 jun (San Pedro
 *    y San Pablo), 15 ago (Asunción), 12 oct (Día de la Raza), 1 nov (Todos los Santos), 11 nov (Independencia
 *    de Cartagena).
 *  - Según la Pascua: Jueves y Viernes Santo (no se trasladan); Ascensión (+39 días), Corpus Christi (+60) y
 *    Sagrado Corazón (+68), trasladados al lunes siguiente (quedan en +43, +64 y +71).
 *
 * Las fechas son locales (AAAA-MM-DD), sin hora: la agenda las compara con la fecha del negocio.
 */
export interface Festivo { fecha: string; nombre: string }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (a: number, m: number, d: number) => new Date(Date.UTC(a, m - 1, d));
const masDias = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
/** Lunes siguiente (o el mismo día si ya es lunes). */
const alLunes = (d: Date) => masDias(d, (8 - d.getUTCDay()) % 7);

/** Domingo de Pascua (algoritmo anónimo gregoriano, Meeus/Jones/Butcher). */
export function pascua(anio: number): Date {
  const a = anio % 19, b = Math.floor(anio / 100), c = anio % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(anio, mes, dia);
}

const cache = new Map<number, Festivo[]>();

export function festivosColombia(anio: number): Festivo[] {
  const hit = cache.get(anio);
  if (hit) return hit;
  const p = pascua(anio);
  const lista: Festivo[] = [
    { fecha: iso(utc(anio, 1, 1)), nombre: 'Año Nuevo' },
    { fecha: iso(alLunes(utc(anio, 1, 6))), nombre: 'Día de los Reyes Magos' },
    { fecha: iso(alLunes(utc(anio, 3, 19))), nombre: 'Día de San José' },
    { fecha: iso(masDias(p, -3)), nombre: 'Jueves Santo' },
    { fecha: iso(masDias(p, -2)), nombre: 'Viernes Santo' },
    { fecha: iso(utc(anio, 5, 1)), nombre: 'Día del Trabajo' },
    { fecha: iso(masDias(p, 43)), nombre: 'Ascensión del Señor' },
    { fecha: iso(masDias(p, 64)), nombre: 'Corpus Christi' },
    { fecha: iso(masDias(p, 71)), nombre: 'Sagrado Corazón' },
    { fecha: iso(alLunes(utc(anio, 6, 29))), nombre: 'San Pedro y San Pablo' },
    { fecha: iso(utc(anio, 7, 20)), nombre: 'Día de la Independencia' },
    { fecha: iso(utc(anio, 8, 7)), nombre: 'Batalla de Boyacá' },
    { fecha: iso(alLunes(utc(anio, 8, 15))), nombre: 'La Asunción de la Virgen' },
    { fecha: iso(alLunes(utc(anio, 10, 12))), nombre: 'Día de la Raza' },
    { fecha: iso(alLunes(utc(anio, 11, 1))), nombre: 'Todos los Santos' },
    { fecha: iso(alLunes(utc(anio, 11, 11))), nombre: 'Independencia de Cartagena' },
    { fecha: iso(utc(anio, 12, 8)), nombre: 'Inmaculada Concepción' },
    { fecha: iso(utc(anio, 12, 25)), nombre: 'Navidad' },
  ].sort((x, y) => x.fecha.localeCompare(y.fecha));
  cache.set(anio, lista);
  return lista;
}

/** Festivo de una fecha local (AAAA-MM-DD), o null. */
export function festivoDe(fecha: string): Festivo | null {
  return festivosColombia(Number(fecha.slice(0, 4))).find((f) => f.fecha === fecha) ?? null;
}

/** Festivos entre dos fechas locales (inclusive). */
export function festivosEntre(desde: string, hasta: string): Festivo[] {
  const out: Festivo[] = [];
  for (let a = Number(desde.slice(0, 4)); a <= Number(hasta.slice(0, 4)); a++) out.push(...festivosColombia(a).filter((f) => f.fecha >= desde && f.fecha <= hasta));
  return out;
}
