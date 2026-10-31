import type { Tx } from '../db/index.js';
import { zonaDe } from '../core/tenant.js';
import { normalizeText } from '../lib/util.js';
import { addDays, todayLocal, utcToLocal } from '../lib/time.js';
import type { NivelRiesgo } from './registry.js';

/**
 * Política de autonomía de la IA por empresa (029 · ia_ajustes). La IA propone, el código decide: el nivel
 * de autonomía cambia el riesgo EFECTIVO de algunas acciones en el Gateway, nunca los permisos.
 *
 *  - AUTOMATICO (por defecto): la IA ejecuta sola lo permitido. Crear o reprogramar una cita con todos los
 *    datos dichos por el cliente (servicio, día y hora) se hace de una vez; si falta algo, se pide «SÍ».
 *    Compras y cancelaciones se confirman siempre con el cliente.
 *  - SUPERVISADO: igual, pero las ventas desde el monto configurado esperan la aprobación del negocio.
 *  - ASESOR: el comportamiento anterior (toda acción confirmable pide «SÍ»).
 *
 * Lo prohibido a los agentes (pagos, reembolsos, anulaciones, configuración) sigue prohibido en cualquier nivel.
 */
export type Autonomia = 'AUTOMATICO' | 'SUPERVISADO' | 'ASESOR';
export type ReglaEscalamiento = 'PIDE_PERSONA' | 'QUEJA' | 'PAGOS' | 'URGENCIA' | 'SIN_SOLUCION' | 'MONTO';

export interface AjustesIA {
  autonomia: Autonomia;
  aprobacion_monto_min: number | null;
  aprobacion_espera_min: number;
  aprobacion_sin_respuesta: 'APROBAR' | 'AVISAR';
  reglas_escalamiento: ReglaEscalamiento[];
  palabras_urgencia: string[];
  contacto_urgencias: string | null;
  recordatorios_horas: number[];
  seguimiento_horas: number;
  recordar_pago: boolean;
}

export const AJUSTES_IA_DEFECTO: AjustesIA = {
  autonomia: 'AUTOMATICO', aprobacion_monto_min: null, aprobacion_espera_min: 30, aprobacion_sin_respuesta: 'AVISAR',
  reglas_escalamiento: ['PIDE_PERSONA', 'QUEJA', 'PAGOS', 'URGENCIA', 'SIN_SOLUCION', 'MONTO'], palabras_urgencia: [], contacto_urgencias: null,
  recordatorios_horas: [24, 2], seguimiento_horas: 3, recordar_pago: true,
};

/** Reglas que la empresa no puede apagar: la IA no puede resolver pagos ni urgencias por diseño. */
export const REGLAS_OBLIGATORIAS: ReglaEscalamiento[] = ['PAGOS', 'URGENCIA'];

export async function ajustesIA(tx: Tx): Promise<AjustesIA> {
  const r = (await tx.query(`SELECT * FROM ia_ajustes LIMIT 1`)).rows[0];
  if (!r) return { ...AJUSTES_IA_DEFECTO };
  return {
    autonomia: r.autonomia, aprobacion_monto_min: r.aprobacion_monto_min == null ? null : Number(r.aprobacion_monto_min),
    aprobacion_espera_min: r.aprobacion_espera_min, aprobacion_sin_respuesta: r.aprobacion_sin_respuesta,
    reglas_escalamiento: [...new Set([...(r.reglas_escalamiento ?? []), ...REGLAS_OBLIGATORIAS])] as ReglaEscalamiento[],
    palabras_urgencia: r.palabras_urgencia ?? [], contacto_urgencias: r.contacto_urgencias, recordatorios_horas: r.recordatorios_horas ?? [24, 2],
    seguimiento_horas: r.seguimiento_horas, recordar_pago: r.recordar_pago,
  };
}

// ---------------------------------------------------------------------------
// ¿El cliente dijo el día y la hora exactos?
// ---------------------------------------------------------------------------
const DIAS: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
const MESES: Record<string, number> = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

/** Horas mencionadas (0–23). Solo cuenta lo que es claramente una hora: «a las 3», «3 pm», «15:30». */
export function horasMencionadas(texto: string): { h: number; m: number; meridiano: 'am' | 'pm' | null }[] {
  const t = normalizeText(texto).replace(/\./g, '');
  const SUF = '(am|pm|a m|p m|de la manana|de la tarde|de la noche|del mediodia|hrs?|horas)';
  const meridiano = (s?: string): 'am' | 'pm' | null => (!s ? null : /pm|p m|tarde|noche|mediodia/.test(s) ? 'pm' : /am|a m|manana/.test(s) ? 'am' : null);
  const out: { h: number; m: number; meridiano: 'am' | 'pm' | null }[] = [];
  const agregar = (h: string, m: string | undefined, s: string | undefined) => {
    const hh = Number(h), mm = m ? Number(m) : 0;
    if (hh <= 23 && mm <= 59) out.push({ h: hh, m: mm, meridiano: meridiano(s) });
  };
  for (const x of t.matchAll(new RegExp(String.raw`\b(\d{1,2}):(\d{2})\s*${SUF}?`, 'g'))) agregar(x[1], x[2], x[3]);
  for (const x of t.matchAll(new RegExp(String.raw`\b(\d{1,2})\s*${SUF}\b`, 'g'))) agregar(x[1], undefined, x[2]);
  for (const x of t.matchAll(new RegExp(String.raw`\b(?:a las|a la|tipo|sobre las|como a las|para las)\s+(\d{1,2})(?![:\d])(?:\s*${SUF})?`, 'g'))) agregar(x[1], undefined, x[2]);
  return out;
}

/** Días mencionados como fecha local AAAA-MM-DD posible (o día de la semana 0–6). */
export function diasMencionados(texto: string, hoy: string): { fechas: string[]; semana: number[] } {
  const t = normalizeText(texto);
  const fechas: string[] = [];
  const semana: number[] = [];
  if (/\bpasado manana\b/.test(t)) fechas.push(addDays(hoy, 2));
  // «mañana» como día, no como franja («de la mañana», «en la mañana»).
  else if (/\bmanana\b/.test(t.replace(/\b(de|en|por|esta) la manana\b/g, ' '))) fechas.push(addDays(hoy, 1));
  if (/\bhoy\b/.test(t)) fechas.push(hoy);
  for (const [n, d] of Object.entries(DIAS)) if (new RegExp(`\\b${n}\\b`).test(t)) semana.push(d);
  const anio = Number(hoy.slice(0, 4));
  for (const x of t.matchAll(/\b(\d{1,2})\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/g)) {
    const f = `${anio}-${String(MESES[x[2]]).padStart(2, '0')}-${String(Number(x[1])).padStart(2, '0')}`;
    fechas.push(f < hoy ? `${anio + 1}${f.slice(4)}` : f);
  }
  for (const x of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) fechas.push(`${anio}-${String(Number(x[2])).padStart(2, '0')}-${String(Number(x[1])).padStart(2, '0')}`);
  for (const x of t.matchAll(/\bel\s+(\d{1,2})\b(?!\s*(?:de\s+)?[a-z]*\s*(?:am|pm))/g)) {
    const dia = Number(x[1]);
    if (dia >= 1 && dia <= 31) {
      const mes = hoy.slice(0, 7);
      const f = `${mes}-${String(dia).padStart(2, '0')}`;
      fechas.push(f < hoy ? addDays(`${mes}-01`, 32).slice(0, 8) + String(dia).padStart(2, '0') : f);
    }
  }
  return { fechas, semana };
}

/**
 * Datos explícitos para agendar sin confirmación: en los últimos mensajes del cliente aparecen un día y una
 * hora que coinciden con el inicio propuesto (en la zona del negocio). «La otra semana en la tarde» no basta.
 */
export function coincideConLoDicho(textos: string[], inicio: Date, zona: string): boolean {
  const hoy = todayLocal(zona);
  const l = utcToLocal(inicio, zona);
  const [hh, mm] = l.hora.split(':').map(Number);
  const texto = textos.join(' \n ');
  const horas = horasMencionadas(texto);
  const horaOk = horas.some((x) => {
    if (x.m !== mm) return false;
    if (x.meridiano === 'pm') return (x.h % 12) + 12 === hh;
    if (x.meridiano === 'am') return x.h % 12 === hh;
    // Sin AM/PM: «a las 3» en un negocio es de la tarde; «a las 10», de la mañana.
    return x.h === hh || (x.h >= 1 && x.h <= 7 && x.h + 12 === hh);
  });
  if (!horaOk) return false;
  const d = diasMencionados(texto, hoy);
  const dow = new Date(`${l.fecha}T12:00:00Z`).getUTCDay();
  // Día de la semana: dentro de los próximos 7 días.
  const semanaOk = d.semana.includes(dow) && l.fecha >= hoy && l.fecha <= addDays(hoy, 7);
  return semanaOk || d.fechas.includes(l.fecha);
}

export async function datosExplicitos(tx: Tx, conversationId: string | null, inicio: string | undefined): Promise<boolean> {
  if (!conversationId || !inicio) return false;
  const textos = (await tx.query(
    `SELECT contenido FROM message WHERE conversation_id=$1 AND remitente='CUSTOMER' AND tipo='TEXTO' ORDER BY coalesce(ocurrido_en, creado_en) DESC LIMIT 4`, [conversationId])).rows.map((r: any) => String(r.contenido));
  if (!textos.length) return false;
  return coincideConLoDicho(textos.reverse(), new Date(inicio), await zonaDe(tx));
}

/** Acciones que la autonomía puede ejecutar sin «SÍ» cuando el cliente dio todos los datos. */
const DIRECTAS_CON_DATOS = ['crear_cita', 'reprogramar_cita'];

export interface RiesgoDecidido { riesgo: NivelRiesgo; politica: string; aprobacionNegocio?: boolean }

/**
 * Riesgo efectivo según la autonomía y los argumentos. Solo rebaja «confirmable» a «reversible» para citas con
 * datos explícitos; la plantilla de sector puede endurecer, nunca habilitar lo prohibido.
 */
export async function decidirRiesgo(tx: Tx, nombre: string, base: NivelRiesgo, args: any, conversationId: string | null, total?: number | null): Promise<RiesgoDecidido> {
  const aj = await ajustesIA(tx);
  if (base !== 'confirmable') return { riesgo: base, politica: `${aj.autonomia}:base` };
  if (aj.autonomia === 'ASESOR') return { riesgo: base, politica: 'ASESOR:confirma_cliente' };
  if (DIRECTAS_CON_DATOS.includes(nombre)) {
    return (await datosExplicitos(tx, conversationId, args?.inicio))
      ? { riesgo: 'reversible', politica: `${aj.autonomia}:datos_explicitos` }
      : { riesgo: base, politica: `${aj.autonomia}:faltan_datos` };
  }
  if (nombre === 'registrar_venta' && aj.autonomia === 'SUPERVISADO' && aj.aprobacion_monto_min != null && total != null && total >= aj.aprobacion_monto_min) {
    return { riesgo: base, politica: 'SUPERVISADO:aprobacion_negocio', aprobacionNegocio: true };
  }
  return { riesgo: base, politica: `${aj.autonomia}:confirma_cliente` };
}
