import { useSyncExternalStore } from 'react';

/**
 * Sonidos de Omnegia: se sintetizan en el navegador con Web Audio (sin archivos ni librerías), así pesan cero
 * y suenan igual en todas partes. Son cortos y suaves, y se pueden apagar desde la barra del panel o el chat
 * (la preferencia se guarda en este navegador).
 *
 * El navegador no deja sonar nada hasta el primer toque o tecla de la persona: los sonidos anteriores se
 * omiten (no se acumulan). Tampoco suenan con la pestaña oculta.
 */
export type Sonido =
  | 'tap' | 'pop' | 'abrir' | 'cerrar' | 'enviar' | 'recibir' | 'pensar' | 'error' | 'ok' | 'exito' | 'notificacion'
  | 'magia' | 'burbuja' | 'swoosh' | 'impresora' | 'sello' | 'confeti' | 'tick' | 'moneda' | 'guia' | 'construir';

const CLAVE = 'omnegia_sonido';
let ctx: AudioContext | null = null;
let salida: GainNode | null = null;
let ultimo: Partial<Record<Sonido, number>> = {};
const oyentes = new Set<() => void>();

function leerPreferencia(): boolean {
  try { return localStorage.getItem(CLAVE) !== 'off'; } catch { return true; }
}
let activo = typeof window !== 'undefined' ? leerPreferencia() : false;

export function sonidoActivo() { return activo; }
export function activarSonido(v: boolean) {
  activo = v;
  try { localStorage.setItem(CLAVE, v ? 'on' : 'off'); } catch { /* sin almacenamiento */ }
  oyentes.forEach((f) => f());
  if (v) { desbloquear(); window.setTimeout(() => sonar('ok'), 60); }
}
/** Estado del interruptor para React. */
export function useSonido(): [boolean, (v: boolean) => void] {
  const v = useSyncExternalStore((f) => { oyentes.add(f); return () => oyentes.delete(f); }, () => activo, () => false);
  return [v, activarSonido];
}

function contexto(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    salida = ctx.createGain();
    salida.gain.value = 0.55;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 6;
    salida.connect(comp); comp.connect(ctx.destination);
  }
  return ctx;
}

function desbloquear() {
  const c = contexto();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}
/** El audio se habilita con el primer gesto de la persona (regla de los navegadores). */
if (typeof window !== 'undefined') {
  const f = () => { desbloquear(); window.removeEventListener('pointerdown', f, true); window.removeEventListener('keydown', f, true); };
  window.addEventListener('pointerdown', f, true);
  window.addEventListener('keydown', f, true);
}

interface Tono { f: number; t?: number; d?: number; v?: number; tipo?: OscillatorType; hasta?: number; ataque?: number; filtro?: number }
function tono(c: AudioContext, o: Tono) {
  const t0 = c.currentTime + (o.t ?? 0), d = o.d ?? 0.12, v = o.v ?? 0.2;
  const osc = c.createOscillator(); const g = c.createGain();
  osc.type = o.tipo ?? 'sine';
  osc.frequency.setValueAtTime(o.f, t0);
  if (o.hasta) osc.frequency.exponentialRampToValueAtTime(o.hasta, t0 + d);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(v, t0 + (o.ataque ?? 0.006));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  let nodo: AudioNode = g;
  if (o.filtro) { const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.filtro; g.connect(lp); nodo = lp; }
  osc.connect(g); nodo.connect(salida!);
  osc.start(t0); osc.stop(t0 + d + 0.05);
}
function ruido(c: AudioContext, o: { t?: number; d?: number; v?: number; frec?: number; q?: number; tipo?: BiquadFilterType; hasta?: number }) {
  const t0 = c.currentTime + (o.t ?? 0), d = o.d ?? 0.1;
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * d)), c.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = o.tipo ?? 'bandpass'; f.frequency.setValueAtTime(o.frec ?? 2000, t0); f.Q.value = o.q ?? 1;
  if (o.hasta) f.frequency.exponentialRampToValueAtTime(o.hasta, t0 + d);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(o.v ?? 0.15, t0 + Math.min(0.02, d / 3)); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
  src.connect(f); f.connect(g); g.connect(salida!);
  src.start(t0); src.stop(t0 + d + 0.02);
}

const NOTAS = { do5: 523.25, mi5: 659.25, sol5: 783.99, la5: 880, si5: 987.77, do6: 1046.5, mi6: 1318.5, sol6: 1568, re5: 587.33, fa5: 698.46, la4: 440, mi4: 329.63, sol4: 392 };

/** Recetas: cada una dura menos de un segundo y medio (salvo la impresora, que acompaña al papel). */
const RECETAS: Record<Sonido, (c: AudioContext) => void> = {
  tap: (c) => tono(c, { f: 1500, hasta: 900, d: 0.05, v: 0.07, tipo: 'triangle' }),
  pop: (c) => { tono(c, { f: 420, hasta: 980, d: 0.09, v: 0.16 }); tono(c, { f: 1960, d: 0.05, v: 0.04, t: 0.02 }); },
  abrir: (c) => { ruido(c, { d: 0.22, v: 0.06, frec: 600, hasta: 3200, q: 0.8 }); tono(c, { f: NOTAS.sol5, d: 0.16, v: 0.08, t: 0.04 }); tono(c, { f: NOTAS.do6, d: 0.22, v: 0.08, t: 0.1 }); },
  cerrar: (c) => { ruido(c, { d: 0.18, v: 0.05, frec: 2600, hasta: 500, q: 0.8 }); tono(c, { f: NOTAS.sol5, hasta: NOTAS.do5, d: 0.16, v: 0.06 }); },
  enviar: (c) => { tono(c, { f: 600, hasta: 1500, d: 0.11, v: 0.12, tipo: 'sine' }); ruido(c, { d: 0.08, v: 0.03, frec: 4000 }); },
  recibir: (c) => { tono(c, { f: NOTAS.mi5, d: 0.25, v: 0.11 }); tono(c, { f: NOTAS.si5, d: 0.4, v: 0.1, t: 0.09 }); tono(c, { f: NOTAS.mi6, d: 0.3, v: 0.03, t: 0.09 }); },
  pensar: (c) => { [0, 0.13, 0.26].forEach((t, i) => tono(c, { f: 700 + i * 140, d: 0.07, v: 0.035, t, tipo: 'sine' })); },
  error: (c) => { tono(c, { f: 330, d: 0.16, v: 0.12, tipo: 'triangle' }); tono(c, { f: 247, d: 0.28, v: 0.12, t: 0.13, tipo: 'triangle' }); },
  ok: (c) => { tono(c, { f: NOTAS.sol5, d: 0.14, v: 0.1 }); tono(c, { f: NOTAS.do6, d: 0.26, v: 0.1, t: 0.08 }); },
  exito: (c) => {
    [NOTAS.do5, NOTAS.mi5, NOTAS.sol5, NOTAS.do6].forEach((f, i) => tono(c, { f, d: 0.5 - i * 0.05, v: 0.12, t: i * 0.08, tipo: 'triangle', filtro: 4000 }));
    tono(c, { f: NOTAS.mi6, d: 0.6, v: 0.05, t: 0.32 }); tono(c, { f: NOTAS.sol6, d: 0.7, v: 0.04, t: 0.4 });
  },
  notificacion: (c) => { tono(c, { f: NOTAS.la5, d: 0.5, v: 0.12 }); tono(c, { f: NOTAS.mi6, d: 0.7, v: 0.07, t: 0.12 }); tono(c, { f: NOTAS.la5 * 3, d: 0.3, v: 0.02, t: 0.12 }); },
  magia: (c) => {
    // Glissando brillante y un acorde que se abre: la entrada de Omnegia IA.
    tono(c, { f: 220, hasta: 1760, d: 0.6, v: 0.06, tipo: 'sawtooth', filtro: 2400 });
    ruido(c, { d: 0.7, v: 0.05, frec: 3000, hasta: 9000, q: 2 });
    [NOTAS.do5, NOTAS.mi5, NOTAS.sol5, NOTAS.si5, NOTAS.mi6].forEach((f, i) => tono(c, { f, d: 1.1, v: 0.07, t: 0.35 + i * 0.07, ataque: 0.02 }));
    for (let i = 0; i < 8; i++) tono(c, { f: 2000 + Math.random() * 3000, d: 0.08, v: 0.03, t: 0.5 + i * 0.09 });
  },
  burbuja: (c) => { tono(c, { f: 500, hasta: 1100, d: 0.12, v: 0.09 }); tono(c, { f: 1300, hasta: 1700, d: 0.08, v: 0.04, t: 0.06 }); },
  swoosh: (c) => { ruido(c, { d: 0.55, v: 0.09, frec: 400, hasta: 5000, q: 1.2 }); tono(c, { f: 900, hasta: 300, d: 0.5, v: 0.04, t: 0.05 }); tono(c, { f: NOTAS.mi6, d: 0.2, v: 0.04, t: 0.5 }); },
  impresora: (c) => {
    // Cabezal térmico: ráfagas cortas de ruido agudo mientras sale el papel (~1,1 s).
    for (let i = 0; i < 18; i++) ruido(c, { t: i * 0.06, d: 0.035, v: 0.05 + (i % 3) * 0.01, frec: 5200 + (i % 4) * 400, q: 6 });
    tono(c, { f: 120, d: 1.1, v: 0.025, tipo: 'sawtooth', filtro: 300 });
  },
  sello: (c) => { tono(c, { f: 160, hasta: 60, d: 0.2, v: 0.28 }); ruido(c, { d: 0.09, v: 0.12, frec: 900, q: 0.7 }); },
  confeti: (c) => { for (let i = 0; i < 14; i++) tono(c, { f: 1800 + Math.random() * 3200, d: 0.07, v: 0.035, t: i * 0.045 + Math.random() * 0.03 }); ruido(c, { d: 0.5, v: 0.03, frec: 7000, q: 1 }); },
  tick: (c) => tono(c, { f: 2400, d: 0.025, v: 0.05, tipo: 'square', filtro: 3500 }),
  moneda: (c) => { tono(c, { f: 1975, d: 0.12, v: 0.08, tipo: 'square', filtro: 6000 }); tono(c, { f: 2637, d: 0.35, v: 0.08, t: 0.08, tipo: 'square', filtro: 6000 }); },
  guia: (c) => { tono(c, { f: NOTAS.re5, d: 0.12, v: 0.08 }); tono(c, { f: NOTAS.la5, d: 0.2, v: 0.08, t: 0.07 }); },
  construir: (c) => { [NOTAS.mi4, NOTAS.sol4, NOTAS.do5, NOTAS.mi5].forEach((f, i) => tono(c, { f, d: 0.22, v: 0.07, t: i * 0.11, tipo: 'triangle' })); },
};

/** Distancia mínima entre dos sonidos iguales (evita metralletas al repetir una acción). */
const PAUSA: Partial<Record<Sonido, number>> = { tap: 60, tick: 30, pensar: 900, notificacion: 1500 };

export function sonar(s: Sonido) {
  if (!activo || typeof document === 'undefined' || document.hidden) return;
  const c = contexto();
  if (!c || !salida) return;
  const ahora = performance.now();
  if (ahora - (ultimo[s] ?? 0) < (PAUSA[s] ?? 40)) return;
  ultimo = { ...ultimo, [s]: ahora };
  const tocar = () => { try { RECETAS[s](c); } catch { /* el audio nunca rompe la interfaz */ } };
  if (c.state === 'running') { tocar(); return; }
  // Suspendido: solo se reanuda si el navegador lo permite (gesto reciente); si tarda, el sonido ya no tiene sentido.
  c.resume().then(() => { if (performance.now() - ahora < 400) tocar(); }).catch(() => {});
}

/**
 * Clics de la interfaz: un «tap» suave en botones, pestañas y opciones, y un «pop» en las acciones principales.
 * Un elemento con data-sin-tap (o dentro de uno) suena por su cuenta o no suena.
 */
export function instalarSonidosUI() {
  if (typeof window === 'undefined' || (window as any).__sonidosUI) return;
  (window as any).__sonidosUI = true;
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('button, a.btn, a.nav-item, [role="tab"], [role="radio"], [role="menuitem"], [role="menuitemradio"], summary, .plan-tarjeta, .plan-barra');
    if (!el || el.closest('[data-sin-tap]') || (el as HTMLButtonElement).disabled) return;
    const principal = el.matches('.btn.primario, .apub-btn.primario, .btn-plan, .btn-ambar, .btn-negro, .plan-tarjeta, .plan-barra');
    sonar(principal ? 'pop' : 'tap');
  }, true);
}
