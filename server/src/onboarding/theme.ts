/**
 * Tema del tenant derivado del logotipo (D-07, RF-020, PRO-SW-003 §7.1).
 * El navegador extrae los colores dominantes del logotipo; este módulo elige el
 * acento, AJUSTA la luminosidad hasta cumplir contraste WCAG AA y guarda tokens.
 * Sin logotipo se genera un monograma con un tono derivado del nombre.
 */
/** Lienzo y superficie más clara del tema oscuro (DESIGN.md): el acento debe leerse sobre ambas. */
const LIENZO = '#171721';
const SUPERFICIE_CLARA = '#272735';
const BLANCO = '#FFFFFF';

type RGB = [number, number, number];
const hexRe = /^#?[0-9a-f]{6}$/i;

export function hexToRgb(h: string): RGB {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)) as RGB;
}
export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s, l];
}
function hslToRgb(h: number, s: number, l: number): RGB {
  h /= 360;
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255];
}
function luminance([r, g, b]: RGB): number {
  const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Mueve la luminosidad en pasos hasta alcanzar el contraste mínimo contra el fondo dado. */
function adjust(hex: string, contra: string, minimo: number, direccion: 'oscurecer' | 'aclarar'): string {
  const [h, s, l0] = rgbToHsl(hexToRgb(hex));
  let l = l0;
  for (let i = 0; i < 100 && contrast(rgbToHex(hslToRgb(h, s, l)), contra) < minimo; i++) {
    l = direccion === 'oscurecer' ? Math.max(0, l - 0.01) : Math.min(1, l + 0.01);
  }
  return rgbToHex(hslToRgb(h, s, l));
}

export interface TemaTenant {
  acento: string;
  acento_sobre_oscuro: string;
  acento_suave: string;
  texto_sobre_acento: string;
  lienzo: string;
  origen: 'logotipo' | 'monograma';
  ajustado: boolean;
  contraste: { acento_blanco: number; oscuro_superficie: number; oscuro_lienzo: number };
  monograma?: string;
}

export function deriveTheme(candidatos: string[] | null | undefined, nombre: string): TemaTenant {
  const validos = (candidatos ?? []).filter((c) => hexRe.test(c)).map((c) => (c.startsWith('#') ? c : '#' + c).toUpperCase());
  // Elegir el más saturado que no sea casi blanco ni casi negro.
  const util = validos
    .map((c) => ({ c, hsl: rgbToHsl(hexToRgb(c)) }))
    .filter(({ hsl }) => hsl[2] > 0.08 && hsl[2] < 0.93 && hsl[1] > 0.18)
    .sort((a, b) => b.hsl[1] - a.hsl[1]);
  let base: string;
  let origen: TemaTenant['origen'] = 'logotipo';
  if (util.length) base = util[0].c;
  else {
    origen = 'monograma';
    let hash = 0;
    for (const ch of nombre) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    base = rgbToHex(hslToRgb(hash % 360, 0.55, 0.38));
  }
  // Relleno de la acción principal: texto blanco encima con contraste AA (4.5:1).
  const acento = adjust(base, BLANCO, 4.5, 'oscurecer');
  // El mismo tono, aclarado hasta leerse como texto sobre la superficie oscura más clara.
  const oscuro = adjust(base, SUPERFICIE_CLARA, 4.5, 'aclarar');
  const [h, s] = rgbToHsl(hexToRgb(acento));
  const suave = rgbToHex(hslToRgb(h, Math.min(s, 0.6), 0.94));
  const iniciales = nombre.split(/\s+/).filter((w) => w.length > 2 || /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || nombre.slice(0, 2).toUpperCase();
  return {
    acento, acento_sobre_oscuro: oscuro, acento_suave: suave, texto_sobre_acento: BLANCO, lienzo: LIENZO, origen,
    ajustado: acento !== base.toUpperCase(),
    contraste: {
      acento_blanco: Math.round(contrast(acento, BLANCO) * 100) / 100,
      oscuro_superficie: Math.round(contrast(oscuro, SUPERFICIE_CLARA) * 100) / 100,
      oscuro_lienzo: Math.round(contrast(oscuro, LIENZO) * 100) / 100,
    },
    monograma: iniciales,
  };
}
