import { normalizeText } from '../lib/util.js';
import type { ReglaEscalamiento } from './politica.js';

/**
 * Reglas explícitas de escalamiento. La persona del negocio solo interviene en casos extremos, y quien decide
 * es el CÓDIGO (el modelo puede sugerir con escalar_a_humano, pero la regla manda):
 *
 *   PIDE_PERSONA  el cliente pide hablar con una persona («asesor», «humano», «el gerente»…).
 *   QUEJA         enojo fuerte o amenaza de reclamo, con puntaje ≥ umbral y la evidencia guardada.
 *   PAGOS         reembolsos, devoluciones, cobros dobles o disputas (la IA no los resuelve por diseño).
 *   URGENCIA      urgencias del sector («convulsiona», «no respira»…): contacto de urgencias de inmediato.
 *   SIN_SOLUCION  la misma intención falla 3 veces, el cliente dice que no lo ayudan o no hay herramienta.
 *   MONTO         ventas desde el monto configurado (solo SUPERVISADO): bandeja de aprobación.
 *
 * Fuera de estos casos la IA NO escala: dice lo que no sabe, ofrece lo que sí puede hacer y anota el pendiente.
 */
export interface Escalamiento { regla: ReglaEscalamiento; prioridad: 'MEDIA' | 'ALTA' | 'URGENTE'; motivo: string; evidencia: string[]; puntaje?: number }

const QUIERO = String.raw`(quiero|quisiera|necesito|me (pasas|pasan|comunicas|comunican|atiende|puede atender)|pasame|pasenme|comunicame|comuniquenme|hablar|habla|llamar|que me (llame|escriba|atienda)|pongame|ponme)`;
const PERSONA = String.raw`(asesor[a]?|humano|una persona|persona real|alguien (real|del equipo|de verdad)|gerente|administrador[a]?|encargad[oa]|supervisor[a]?|el dueno|la duena|un agente|agente humano)`;

/** ¿Pide hablar con una persona? Sin verbo de intención solo cuenta si el mensaje es casi solo eso («asesor»). */
export function pideUnaPersona(t: string): string | null {
  if (new RegExp(String.raw`\bno\s+(quiero|necesito)\b.{0,25}\b${PERSONA}\b`).test(t)) return null;
  const objetivo = new RegExp(String.raw`\b${PERSONA}\b`).exec(t);
  if (!objetivo) return null;
  const palabras = t.split(/\s+/).filter(Boolean).length;
  if (palabras <= 3 || new RegExp(String.raw`\b${QUIERO}\b.{0,40}\b${PERSONA}\b`).test(t) || /\bcon (un|una|el|la)?\s*(asesor|humano|persona|gerente)\b/.test(t)) return objetivo[0];
  return null;
}

const QUEJA_FUERTE = ['estafa', 'estafadores', 'ladrones', 'demanda', 'demandar', 'denuncia', 'denunciar', 'abogado', 'superintendencia', 'superindustria', 'reclamo', 'queja formal', 'poner una queja', 'pqr', 'robo', 'me robaron', 'fraude'];
const QUEJA_MEDIA = ['pesimo', 'pesima', 'terrible', 'horrible', 'furioso', 'furiosa', 'indignado', 'indignada', 'inaceptable', 'verguenza', 'una porqueria', 'nunca mas', 'harto', 'harta', 'molesto', 'molesta', 'decepcionado', 'decepcionada', 'mal servicio', 'mala atencion', 'queja'];

/** Puntaje de enojo o reclamo: palabras fuertes 2, medias 1, MAYÚSCULAS sostenidas 1, «!!» 1. Umbral 2. */
export function puntajeQueja(original: string): { puntaje: number; evidencia: string[] } {
  const t = normalizeText(original);
  const evidencia: string[] = [];
  let puntaje = 0;
  for (const p of QUEJA_FUERTE) if (new RegExp(String.raw`\b${p}\b`).test(t)) { puntaje += 2; evidencia.push(p); }
  for (const p of QUEJA_MEDIA) if (new RegExp(String.raw`\b${p}\b`).test(t) && !evidencia.some((e) => e.includes(p) || p.includes(e))) { puntaje += 1; evidencia.push(p); }
  const letras = original.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
  if (letras.length >= 12 && letras.replace(/[^A-ZÁÉÍÓÚÑ]/g, '').length / letras.length > 0.7) { puntaje += 1; evidencia.push('mayúsculas sostenidas'); }
  if (/!{2,}/.test(original)) { puntaje += 1; evidencia.push('«!!»'); }
  return { puntaje, evidencia };
}
export const UMBRAL_QUEJA = 2;

const PAGOS = String.raw`(reembols\w*|devoluci[oó]n|devolucion|devuelv\w*|devolver (la|mi) (plata|dinero)|me cobraron (dos veces|doble|de mas|mal)|cobro (doble|duplicado|de mas|indebido)|doble cobro|cobraron dos veces|contracargo|disputa|no reconozco (el|un|este|ese) cobro|quiero mi (plata|dinero)|retracto|cancelar (el|mi) pago)`;

/** Palabras de urgencia por sector (además de las que configure la empresa). */
export const URGENCIAS_SECTOR: Record<string, string[]> = {
  veterinaria: ['convulsiona', 'convulsionando', 'convulsion', 'no respira', 'no puede respirar', 'se ahoga', 'atropellado', 'atropellada', 'lo atropellaron', 'la atropellaron', 'envenenado', 'envenenada', 'se enveneno', 'sangra mucho', 'sangrando mucho', 'desmayado', 'inconsciente', 'no reacciona'],
  mascotas: ['convulsiona', 'convulsionando', 'no respira', 'se ahoga', 'atropellado', 'atropellada', 'envenenado', 'envenenada', 'sangra mucho', 'no reacciona'],
  salud: ['no respira', 'dolor en el pecho', 'desmayo', 'inconsciente', 'sangrado abundante', 'convulsion', 'reaccion alergica grave'],
  odontologia: ['sangrado abundante', 'no para de sangrar', 'hinchazon en la cara', 'no puedo abrir la boca'],
  general: ['emergencia medica', 'es una emergencia', 'no respira', 'inconsciente'],
};

export interface ContextoEscalamiento { reglas: ReglaEscalamiento[]; sector: string; palabrasUrgencia: string[]; palabrasPlantilla?: string[] }

/** Evalúa un mensaje del cliente. Devuelve la primera regla que aplica (por gravedad) o null. */
export function evaluarMensaje(original: string, c: ContextoEscalamiento): Escalamiento | null {
  const t = normalizeText(original).replace(/[¡!¿?.,;:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  const activa = (r: ReglaEscalamiento) => c.reglas.includes(r);
  const urgencias = [...(URGENCIAS_SECTOR[c.sector] ?? []), ...URGENCIAS_SECTOR.general, ...c.palabrasUrgencia.map(normalizeText)];
  const urg = urgencias.find((p) => p && new RegExp(String.raw`\b${p}\b`).test(t));
  if (urg && activa('URGENCIA')) return { regla: 'URGENCIA', prioridad: 'URGENTE', motivo: `Posible urgencia: el cliente escribió «${urg}»`, evidencia: [urg] };
  const pago = new RegExp(String.raw`\b${PAGOS}`).exec(t);
  if (pago && activa('PAGOS')) return { regla: 'PAGOS', prioridad: 'ALTA', motivo: `Tema de pagos que la IA no puede resolver («${pago[0]}»)`, evidencia: [pago[0]] };
  const q = puntajeQueja(original);
  if (q.puntaje >= UMBRAL_QUEJA && activa('QUEJA')) return { regla: 'QUEJA', prioridad: 'ALTA', motivo: `Queja o enojo fuerte (puntaje ${q.puntaje}: ${q.evidencia.join(', ')})`, evidencia: q.evidencia, puntaje: q.puntaje };
  const persona = pideUnaPersona(t);
  if (persona && activa('PIDE_PERSONA')) return { regla: 'PIDE_PERSONA', prioridad: 'MEDIA', motivo: `El cliente pidió hablar con una persona («${persona}»)`, evidencia: [persona] };
  // Palabras clave de la plantilla de sector que no cayeron en ninguna regla: se tratan como queja.
  const plantilla = (c.palabrasPlantilla ?? []).map(normalizeText).find((p) => p && new RegExp(String.raw`\b${p}\b`).test(t));
  if (plantilla && activa('QUEJA')) return { regla: 'QUEJA', prioridad: 'ALTA', motivo: `El cliente mencionó «${plantilla}»`, evidencia: [plantilla] };
  return null;
}

export const NOMBRE_REGLA: Record<ReglaEscalamiento, string> = {
  PIDE_PERSONA: 'Pidió hablar con una persona', QUEJA: 'Queja o enojo fuerte', PAGOS: 'Pagos, reembolsos o devoluciones',
  URGENCIA: 'Urgencia', SIN_SOLUCION: 'La IA no pudo resolverlo', MONTO: 'Venta por encima del monto',
};
