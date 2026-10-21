import { useSyncExternalStore } from 'react';
import { sonidoActivo } from './sonido';

/**
 * Voz de Omnegia IA con la síntesis de voz del navegador (Web Speech API): no usa servicios externos ni
 * envía el texto a ningún lado. Elige la mejor voz en español disponible (primero de Colombia y Latinoamérica).
 * Respeta el interruptor de sonido. Los navegadores no dejan hablar sin un gesto previo de la persona:
 * en ese caso `hablar` responde «bloqueado» y la interfaz ofrece un botón para escuchar.
 */
export type ResultadoVoz = 'ok' | 'bloqueado' | 'sin_voz' | 'cancelado' | 'silenciado';

/** Preferencia de este dispositivo: la IA puede hablar (con el sonido activo) o solo escribir. */
const CLAVE_VOZ = 'omnegia-voz';
const oyentesVoz = new Set<() => void>();
let vozActivaPref = (() => { try { return localStorage.getItem(CLAVE_VOZ) !== 'off'; } catch { return true; } })();
export const vozActiva = () => vozActivaPref;
export function activarVoz(v: boolean) {
  vozActivaPref = v;
  try { localStorage.setItem(CLAVE_VOZ, v ? 'on' : 'off'); } catch { /* sin almacenamiento */ }
  if (!v) callar();
  oyentesVoz.forEach((f) => f());
}
export function useVoz(): [boolean, (v: boolean) => void] {
  const v = useSyncExternalStore((f) => { oyentesVoz.add(f); return () => oyentesVoz.delete(f); }, () => vozActivaPref, () => true);
  return [v, activarVoz];
}

const PREFERIDAS = [/dalia|salome|gonzalo/i, /paulina|google espa[ñn]ol de estados unidos|sabina|jorge|natural|online/i, /google/i];
let voces: SpeechSynthesisVoice[] = [];

export const vozDisponible = () => typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

function cargarVoces() {
  if (!vozDisponible()) return;
  voces = window.speechSynthesis.getVoices();
}
if (vozDisponible()) {
  cargarVoces();
  window.speechSynthesis.addEventListener?.('voiceschanged', cargarVoces);
}

function elegirVoz(): SpeechSynthesisVoice | null {
  if (!voces.length) cargarVoces();
  const es = voces.filter((v) => /^es([-_]|$)/i.test(v.lang));
  if (!es.length) return null;
  const region = (v: SpeechSynthesisVoice) => (/CO/i.test(v.lang) ? 0 : /(419|MX|US|AR|CL|PE)/i.test(v.lang) ? 1 : 2);
  const nombre = (v: SpeechSynthesisVoice) => { const i = PREFERIDAS.findIndex((re) => re.test(v.name)); return i < 0 ? PREFERIDAS.length : i; };
  return [...es].sort((a, b) => region(a) - region(b) || nombre(a) - nombre(b))[0];
}

/** Texto apto para leer en voz alta: sin marcas de formato ni emojis. */
export function textoHablado(t: string) {
  return t.replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^[-•]\s*/gm, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2728}]/gu, '').replace(/\s+/g, ' ').trim();
}

export function callar() {
  if (vozDisponible()) window.speechSynthesis.cancel();
}

/**
 * Lee un texto. `alHablar` recibe cada palabra (para animar la boca); la promesa se resuelve al terminar.
 * Si en 1,5 s no empezó (navegador sin permiso o sin motor de voz), se cancela y devuelve «bloqueado».
 */
export function hablar(texto: string, o: { alEmpezar?: () => void; alPalabra?: () => void } = {}): Promise<ResultadoVoz> {
  if (!sonidoActivo() || !vozActivaPref) return Promise.resolve('silenciado');
  if (!vozDisponible()) return Promise.resolve('sin_voz');
  const limpio = textoHablado(texto);
  if (!limpio) return Promise.resolve('ok');
  const voz = elegirVoz();
  return new Promise((resolve) => {
    const s = window.speechSynthesis;
    s.cancel();
    const u = new SpeechSynthesisUtterance(limpio);
    u.lang = voz?.lang ?? 'es-CO';
    if (voz) u.voice = voz;
    u.rate = 1.04; u.pitch = 1.18; u.volume = 1;
    let empezo = false;
    let listo = false;
    const fin = (r: ResultadoVoz) => { if (listo) return; listo = true; window.clearTimeout(espera); resolve(r); };
    const espera = window.setTimeout(() => { if (!empezo) { s.cancel(); fin('bloqueado'); } }, 1500);
    u.onstart = () => { empezo = true; o.alEmpezar?.(); };
    u.onboundary = (e) => { if (e.name === 'word' || e.name === undefined) o.alPalabra?.(); };
    u.onend = () => fin(empezo ? 'ok' : 'bloqueado');
    u.onerror = (e) => fin(e.error === 'not-allowed' ? 'bloqueado' : e.error === 'interrupted' || e.error === 'canceled' ? 'cancelado' : 'bloqueado');
    s.speak(u);
  });
}
