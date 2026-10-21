import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useSesion } from './Layout';
import { Icon } from './icons';
import { MARCA } from '../brand';

/**
 * Gráficas e informes del asistente. El asistente no entrega código: entrega datos (bloques
 * ```grafica y ```informe validados en el servidor) y el panel los dibuja con la identidad de
 * Omnegia y los datos de la empresa. Todo se exporta sin servicios externos: la gráfica como PNG
 * (SVG → lienzo) y el informe como imagen (dibujado en lienzo) o PDF (impresión del navegador).
 */
export interface Serie { nombre: string; valores: number[] }
export interface GraficaSpec { tipo: 'barras' | 'lineas' | 'dona'; titulo: string; subtitulo?: string; unidad?: string; etiquetas: string[]; series: Serie[] }
export interface InformeSpec {
  titulo: string; periodo?: string; resumen?: string; notas?: string;
  cifras?: { etiqueta: string; valor: string; detalle?: string }[];
  secciones: { titulo: string; texto?: string; tabla?: { columnas: string[]; filas: (string | number)[][] }; grafica?: GraficaSpec }[];
}

// Paleta categórica de referencia (validada para daltonismo en este orden); una sola serie usa el acento de la empresa.
const CATEGORICA = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const TINTA = { fuerte: '#1b1b19', media: '#46453f', tenue: '#66655e', rejilla: '#e3e2dd', eje: '#a9a8a1', superficie: '#ffffff' };
const FUENTE = 'Outfit, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function formatoValor(v: number, unidad?: string) {
  const n = Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 100) / 100;
  const t = n.toLocaleString('es-CO').replace(/,/g, '.');
  if (unidad === 'COP') return `$${t}`;
  if (unidad === '%') return `${t} %`;
  return t;
}
const compacto = (v: number, unidad?: string) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `${(v / 1e6).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M` : a >= 1e4 ? `${(v / 1e3).toLocaleString('es-CO', { maximumFractionDigits: 0 })} mil` : formatoValor(v);
  return unidad === 'COP' && !s.startsWith('$') ? `$${s}` : s;
};
function techo(max: number) {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= max) ?? 10) * p;
}

/** SVG autocontenido de la gráfica (mismo dibujo para el panel, el PNG y el informe). */
export function svgGrafica(g: GraficaSpec, o: { ancho?: number; alto?: number; acento?: string } = {}): string {
  const W = o.ancho ?? 640;
  const H = o.alto ?? (g.tipo === 'dona' ? 260 : 280);
  const color = (i: number) => (g.series.length === 1 && g.tipo !== 'dona' ? o.acento || CATEGORICA[0] : CATEGORICA[i % CATEGORICA.length]);
  const texto = (x: number, y: number, t: string, a: Record<string, string | number> = {}) =>
    `<text x="${x}" y="${y}" font-family="${FUENTE}" font-size="${a.size ?? 12}" fill="${a.fill ?? TINTA.tenue}" text-anchor="${a.anchor ?? 'start'}"${a.weight ? ` font-weight="${a.weight}"` : ''}>${esc(t)}</text>`;
  const partes: string[] = [];
  const descripcion = `${g.titulo}. ${g.etiquetas.map((e, i) => `${e}: ${g.series.map((s) => `${g.series.length > 1 ? `${s.nombre} ` : ''}${formatoValor(s.valores[i], g.unidad)}`).join(', ')}`).join('; ')}`;

  if (g.tipo === 'dona') {
    const s = g.series[0];
    const total = s.valores.reduce((a, b) => a + b, 0) || 1;
    const cx = Math.min(W * 0.32, 150), cy = H / 2, R = Math.min(H / 2 - 16, 110), r = R * 0.62;
    let ang = -Math.PI / 2;
    s.valores.forEach((v, i) => {
      const a = (v / total) * Math.PI * 2;
      if (a <= 0) return;
      const fin = ang + Math.min(a, Math.PI * 2 - 0.0001);
      const p = (rad: number, ra: number) => `${cx + ra * Math.cos(rad)} ${cy + ra * Math.sin(rad)}`;
      const largo = fin - ang > Math.PI ? 1 : 0;
      partes.push(`<path d="M ${p(ang, R)} A ${R} ${R} 0 ${largo} 1 ${p(fin, R)} L ${p(fin, r)} A ${r} ${r} 0 ${largo} 0 ${p(ang, r)} Z" fill="${color(i)}" stroke="${TINTA.superficie}" stroke-width="2"><title>${esc(`${g.etiquetas[i]}: ${formatoValor(v, g.unidad)} (${Math.round((v / total) * 100)} %)`)}</title></path>`);
      ang = fin;
    });
    partes.push(texto(cx, cy - 2, compacto(total, g.unidad), { size: 20, fill: TINTA.fuerte, anchor: 'middle', weight: 600 }));
    partes.push(texto(cx, cy + 18, 'total', { anchor: 'middle' }));
    const lx = cx + R + 36;
    g.etiquetas.forEach((e, i) => {
      const y = cy - (g.etiquetas.length * 26) / 2 + i * 26 + 16;
      partes.push(`<rect x="${lx}" y="${y - 10}" width="12" height="12" rx="3" fill="${color(i)}"/>`);
      partes.push(texto(lx + 20, y, e, { size: 13, fill: TINTA.media }));
      partes.push(texto(W - 8, y, `${formatoValor(s.valores[i], g.unidad)} · ${Math.round((s.valores[i] / total) * 100)} %`, { size: 13, fill: TINTA.fuerte, anchor: 'end' }));
    });
  } else {
    const leyenda = g.series.length > 1;
    const top = leyenda ? 40 : 18, bottom = 34, right = 18;
    const maxV = techo(Math.max(0, ...g.series.flatMap((s) => s.valores)));
    const minV = Math.min(0, ...g.series.flatMap((s) => s.valores));
    const left = 14 + Math.max(...[0, 0.25, 0.5, 0.75, 1].map((f) => compacto(minV + (maxV - minV) * f, g.unidad).length)) * 7;
    const pw = W - left - right, ph = H - top - bottom;
    const y = (v: number) => top + ph - ((v - minV) / (maxV - minV || 1)) * ph;
    if (leyenda) {
      let x = left;
      g.series.forEach((s, i) => {
        partes.push(`<rect x="${x}" y="10" width="12" height="12" rx="3" fill="${color(i)}"/>`);
        partes.push(texto(x + 18, 20, s.nombre, { size: 12.5, fill: TINTA.media }));
        x += 34 + s.nombre.length * 7;
      });
    }
    [0, 0.25, 0.5, 0.75, 1].forEach((f) => {
      const v = minV + (maxV - minV) * f;
      partes.push(`<line x1="${left}" x2="${W - right}" y1="${y(v)}" y2="${y(v)}" stroke="${f === 0 && minV === 0 ? TINTA.eje : TINTA.rejilla}" stroke-width="1"/>`);
      partes.push(texto(left - 8, y(v) + 4, compacto(v, g.unidad), { anchor: 'end', size: 11.5 }));
    });
    const n = g.etiquetas.length;
    const paso = pw / n;
    const cada = Math.ceil(n / Math.max(1, Math.floor(pw / 56)));
    g.etiquetas.forEach((e, i) => { if (i % cada === 0) partes.push(texto(left + paso * i + paso / 2, H - 12, e.length > 12 ? `${e.slice(0, 11)}…` : e, { anchor: 'middle', size: 11.5 })); });
    if (g.tipo === 'barras') {
      const k = g.series.length;
      const bw = Math.min(42, (paso * 0.72 - (k - 1) * 2) / k);
      const unico = k === 1 && n <= 10;
      g.series.forEach((s, j) => s.valores.forEach((v, i) => {
        const x = left + paso * i + (paso - (bw * k + (k - 1) * 2)) / 2 + j * (bw + 2);
        const y0 = y(0), y1 = y(v), alto = Math.abs(y0 - y1);
        const rr = Math.min(4, alto, bw / 2);
        const yt = Math.min(y0, y1);
        const d = v >= 0
          ? `M ${x} ${y0} V ${yt + rr} Q ${x} ${yt} ${x + rr} ${yt} H ${x + bw - rr} Q ${x + bw} ${yt} ${x + bw} ${yt + rr} V ${y0} Z`
          : `M ${x} ${y0} V ${y1 - rr} Q ${x} ${y1} ${x + rr} ${y1} H ${x + bw - rr} Q ${x + bw} ${y1} ${x + bw} ${y1 - rr} V ${y0} Z`;
        // El área de toque es la columna completa, más grande que la barra.
        partes.push(`<g><rect x="${left + paso * i}" y="${top}" width="${paso}" height="${ph}" fill="transparent"/><path d="${alto < 0.5 ? `M ${x} ${y0} H ${x + bw}` : d}" fill="${color(j)}" stroke="${alto < 0.5 ? color(j) : 'none'}" stroke-width="2"/><title>${esc(`${g.etiquetas[i]} · ${k > 1 ? `${s.nombre}: ` : ''}${formatoValor(v, g.unidad)}${g.unidad && !['COP', '%'].includes(g.unidad) ? ` ${g.unidad}` : ''}`)}</title></g>`);
        if (unico && v !== 0) partes.push(texto(x + bw / 2, (v >= 0 ? y1 : y1 + 14) - 6, compacto(v, g.unidad), { anchor: 'middle', size: 11.5, fill: TINTA.media }));
      }));
    } else {
      g.series.forEach((s, j) => {
        const pts = s.valores.map((v, i) => [left + paso * i + paso / 2, y(v)] as const);
        partes.push(`<path d="${pts.map(([px, py], i) => `${i ? 'L' : 'M'} ${px} ${py}`).join(' ')}" fill="none" stroke="${color(j)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
        pts.forEach(([px, py], i) => {
          partes.push(`<g><circle cx="${px}" cy="${py}" r="12" fill="transparent"/>${n <= 16 ? `<circle cx="${px}" cy="${py}" r="4" fill="${color(j)}" stroke="${TINTA.superficie}" stroke-width="2"/>` : ''}<title>${esc(`${g.etiquetas[i]} · ${g.series.length > 1 ? `${s.nombre}: ` : ''}${formatoValor(s.valores[i], g.unidad)}`)}</title></g>`);
        });
        const [ux, uy] = pts[pts.length - 1];
        if (g.series.length <= 2) partes.push(texto(Math.min(ux, W - right), uy - 10, compacto(s.valores[s.valores.length - 1], g.unidad), { anchor: 'end', size: 11.5, fill: TINTA.media }));
      });
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(descripcion.slice(0, 600))}"><title>${esc(g.titulo)}</title><rect width="${W}" height="${H}" fill="${TINTA.superficie}"/>${partes.join('')}</svg>`;
}

/** Acento vigente de la empresa (lo aplica el panel); fuera del panel, el violeta de Omnegia. */
function acentoActual(): string {
  try { return getComputedStyle(document.documentElement).getPropertyValue('--acento').trim() || '#5b3cc4'; } catch { return '#5b3cc4'; }
}

const cargarImagen = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('imagen')); i.src = src; });
const svgAImagen = (svg: string) => cargarImagen(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
const nombreArchivo = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'omnegia';
function descargarLienzo(c: HTMLCanvasElement, nombre: string) {
  return new Promise<void>((res, rej) => c.toBlob((b) => {
    if (!b) return rej(new Error('No se pudo crear la imagen.'));
    const url = URL.createObjectURL(b);
    const a = document.createElement('a');
    a.href = url; a.download = `${nombre}.png`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    res();
  }, 'image/png'));
}

function Datos({ g }: { g: GraficaSpec }) {
  return (
    <div className="vz-datos" tabIndex={0} role="region" aria-label={`Datos de ${g.titulo}`}>
      <table>
        <thead><tr><th scope="col">{g.tipo === 'dona' ? 'Parte' : 'Etiqueta'}</th>{g.series.map((s) => <th key={s.nombre} scope="col" className="num">{s.nombre}</th>)}</tr></thead>
        <tbody>{g.etiquetas.map((e, i) => <tr key={i}><th scope="row">{e}</th>{g.series.map((s) => <td key={s.nombre} className="num">{formatoValor(s.valores[i], g.unidad)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function BotonExportar({ onClick, children }: { onClick: () => Promise<void>; children: ReactNode }) {
  const [estado, setEstado] = useState<'listo' | 'trabajando' | 'error'>('listo');
  return (
    <button type="button" className={`vz-boton ${estado}`} disabled={estado === 'trabajando'} onClick={async () => { setEstado('trabajando'); try { await onClick(); setEstado('listo'); } catch { setEstado('error'); setTimeout(() => setEstado('listo'), 2400); } }}>
      <Icon n={estado === 'error' ? 'alerta' : 'descargar'} className="" size={14} />{estado === 'trabajando' ? 'Preparando…' : estado === 'error' ? 'No se pudo exportar' : children}
    </button>
  );
}

export function Grafica({ g, enInforme }: { g: GraficaSpec; enInforme?: boolean }) {
  const acento = useMemo(acentoActual, []);
  const svg = useMemo(() => svgGrafica(g, { acento }), [g, acento]);
  const [verDatos, setVerDatos] = useState(false);
  const exportar = async () => {
    const W = 1280, img = await svgAImagen(svgGrafica(g, { acento, ancho: 640 }));
    const c = document.createElement('canvas');
    const alto = img.height * 2 + 120;
    c.width = W; c.height = alto;
    const x = c.getContext('2d')!;
    x.fillStyle = '#fff'; x.fillRect(0, 0, W, alto);
    x.fillStyle = TINTA.fuerte; x.font = `600 30px ${FUENTE}`; x.fillText(g.titulo, 32, 52);
    if (g.subtitulo) { x.fillStyle = TINTA.tenue; x.font = `20px ${FUENTE}`; x.fillText(g.subtitulo, 32, 82); }
    x.drawImage(img, 0, 96, W, img.height * 2);
    x.fillStyle = TINTA.tenue; x.font = `16px ${FUENTE}`; x.fillText(`${MARCA.nombre} · ${new Date().toLocaleDateString('es-CO')}`, 32, alto - 14);
    await descargarLienzo(c, nombreArchivo(g.titulo));
  };
  return (
    <figure className={`vz-grafica ${enInforme ? 'en-informe' : ''}`}>
      <figcaption className="vz-cab">
        <span className="vz-titulos"><b>{g.titulo}</b>{g.subtitulo && <small>{g.subtitulo}</small>}</span>
        {!enInforme && <span className="vz-acciones">
          <button type="button" className="vz-boton" aria-pressed={verDatos} onClick={() => setVerDatos((v) => !v)}><Icon n="facturacion" className="" size={14} />{verDatos ? 'Ver gráfica' : 'Ver datos'}</button>
          <BotonExportar onClick={exportar}>PNG</BotonExportar>
        </span>}
      </figcaption>
      {verDatos ? <Datos g={g} /> : <div className="vz-svg" dangerouslySetInnerHTML={{ __html: svg }} />}
    </figure>
  );
}

// ---------------------------------------------------------------- informe
interface Empresa { nombre: string; nit?: string | null; ciudad?: string | null; logo?: string | null; monograma?: string | null }

/** Dibuja el informe en un lienzo (sin capturar el DOM): mismo contenido, con la plantilla de Omnegia. */
async function informeAPng(inf: InformeSpec, e: Empresa, acento: string, generado: Date, origen: string) {
  const W = 1240, P = 64, S = 2;
  const c = document.createElement('canvas');
  const x = c.getContext('2d')!;
  const [icono, logo, graficas] = await Promise.all([
    cargarImagen(MARCA.icono).catch(() => null),
    e.logo ? cargarImagen(e.logo).catch(() => null) : Promise.resolve(null),
    Promise.all(inf.secciones.map((s) => (s.grafica ? svgAImagen(svgGrafica(s.grafica, { acento, ancho: (W - 2 * P) / 1, alto: s.grafica.tipo === 'dona' ? 300 : 320 })).catch(() => null) : Promise.resolve(null)))),
  ]);
  const lineas = (t: string, ancho: number) => {
    const out: string[] = [];
    for (const parrafo of t.split('\n')) {
      let l = '';
      for (const pal of parrafo.split(/\s+/)) {
        const p = l ? `${l} ${pal}` : pal;
        if (x.measureText(p).width > ancho && l) { out.push(l); l = pal; } else l = p;
      }
      out.push(l);
    }
    return out;
  };
  const corta = (t: string, ancho: number) => { let s = t; while (s.length > 1 && x.measureText(s).width > ancho) s = s.slice(0, -1); return s === t ? t : `${s.slice(0, -1)}…`; };
  const dibujar = (pintar: boolean) => {
    let y = 0;
    const f = (peso: number, tam: number, color: string) => { x.font = `${peso} ${tam}px ${FUENTE}`; x.fillStyle = color; };
    const escribir = (t: string, xx: number, yy: number, align: CanvasTextAlign = 'left') => { if (pintar) { x.textAlign = align; x.fillText(t, xx, yy); x.textAlign = 'left'; } };
    if (pintar) { x.fillStyle = '#fff'; x.fillRect(0, 0, W, c.height / S); x.fillStyle = acento; x.fillRect(0, 0, W, 10); }
    y = 58;
    // Cabecera: Omnegia a la izquierda; la empresa a la derecha.
    if (icono && pintar) x.drawImage(icono, P, y - 26, 32, 32);
    f(600, 20, TINTA.fuerte); escribir(MARCA.nombre, P + 42, y);
    f(400, 13, TINTA.tenue); escribir(origen, P + 42, y + 20);
    const derecha = W - P - (logo ? 70 : 0);
    if (logo && pintar) { const r = Math.min(56 / logo.width, 56 / logo.height); x.drawImage(logo, W - P - logo.width * r, y - 34, logo.width * r, logo.height * r); }
    f(600, 18, TINTA.fuerte); escribir(e.nombre, derecha, y - 6, 'right');
    f(400, 13, TINTA.tenue); escribir([e.nit ? `NIT ${e.nit}` : null, e.ciudad].filter(Boolean).join(' · '), derecha, y + 14, 'right');
    y += 54;
    if (pintar) { x.fillStyle = TINTA.rejilla; x.fillRect(P, y, W - 2 * P, 1); }
    y += 56;
    f(650, 36, TINTA.fuerte);
    for (const l of lineas(inf.titulo, W - 2 * P)) { escribir(l, P, y); y += 44; }
    f(400, 16, TINTA.tenue); escribir([inf.periodo, `Generado el ${generado.toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' })}`].filter(Boolean).join(' · '), P, y); y += 34;
    if (inf.resumen) { f(400, 18, TINTA.media); for (const l of lineas(inf.resumen, W - 2 * P)) { escribir(l, P, y); y += 28; } y += 8; }
    if (inf.cifras?.length) {
      const n = inf.cifras.length, gap = 16, cw = (W - 2 * P - gap * (n - 1)) / n;
      inf.cifras.forEach((k, i) => {
        const cx = P + i * (cw + gap);
        if (pintar) { x.fillStyle = '#f6f6f4'; x.beginPath(); x.roundRect(cx, y, cw, 96, 12); x.fill(); x.fillStyle = acento; x.fillRect(cx, y + 18, 4, 60); }
        f(500, 13, TINTA.tenue); escribir(corta(k.etiqueta, cw - 40), cx + 20, y + 32);
        f(650, 26, TINTA.fuerte); escribir(corta(k.valor, cw - 40), cx + 20, y + 66);
        if (k.detalle) { f(400, 12, TINTA.tenue); escribir(corta(k.detalle, cw - 40), cx + 20, y + 86); }
      });
      y += 124;
    }
    inf.secciones.forEach((s, i) => {
      y += 18;
      f(600, 22, TINTA.fuerte); escribir(s.titulo, P, y); y += 14;
      if (pintar) { x.fillStyle = acento; x.fillRect(P, y, 36, 3); }
      y += 28;
      if (s.texto) { f(400, 16, TINTA.media); for (const l of lineas(s.texto, W - 2 * P)) { escribir(l, P, y); y += 25; } y += 8; }
      if (s.tabla) {
        const cols = s.tabla.columnas.length, cw = (W - 2 * P) / cols, fila = 40;
        if (pintar) { x.fillStyle = '#f2f2ef'; x.fillRect(P, y, W - 2 * P, fila); }
        f(600, 13, TINTA.media);
        s.tabla.columnas.forEach((col, j) => escribir(corta(col, cw - 24), j === 0 ? P + 14 : P + cw * (j + 1) - 14, y + 25, j === 0 ? 'left' : 'right'));
        y += fila;
        s.tabla.filas.forEach((r) => {
          f(400, 14, TINTA.fuerte);
          r.forEach((v, j) => escribir(corta(typeof v === 'number' ? formatoValor(v) : String(v), cw - 24), j === 0 ? P + 14 : P + cw * (j + 1) - 14, y + 25, j === 0 ? 'left' : 'right'));
          y += fila;
          if (pintar) { x.fillStyle = TINTA.rejilla; x.fillRect(P, y - 1, W - 2 * P, 1); }
        });
        y += 16;
      }
      const img = graficas[i];
      if (s.grafica && img) {
        f(600, 15, TINTA.media); escribir(s.grafica.titulo, P, y + 4); y += 16;
        const ancho = W - 2 * P, alto = img.height * (ancho / img.width);
        if (pintar) x.drawImage(img, P, y, ancho, alto);
        y += alto + 12;
      }
    });
    if (inf.notas) { y += 8; f(400, 14, TINTA.tenue); for (const l of lineas(inf.notas, W - 2 * P)) { escribir(l, P, y); y += 22; } }
    y += 28;
    if (pintar) { x.fillStyle = TINTA.rejilla; x.fillRect(P, y, W - 2 * P, 1); }
    y += 30;
    f(400, 13, TINTA.tenue);
    for (const l of lineas(`Datos de ${e.nombre} consultados en su panel de ${MARCA.nombre}. Verifica las cifras en el panel antes de tomar decisiones o compartir este informe.`, W - 2 * P)) { escribir(l, P, y); y += 20; }
    return y + 36;
  };
  c.width = W * S; c.height = 4000 * S;
  x.scale(S, S);
  const alto = dibujar(false);
  c.width = W * S; c.height = Math.ceil(alto * S);
  x.setTransform(S, 0, 0, S, 0, 0);
  dibujar(true);
  return c;
}

/** `origen`: quién lo preparó (el asistente, o el panel con los datos de la empresa en Informes). */
export function Informe({ inf, origen = 'Informe preparado por el asistente' }: { inf: InformeSpec; origen?: string }) {
  const { s } = useSesion();
  const ref = useRef<HTMLElement>(null);
  const generado = useMemo(() => new Date(), []);
  const t = s.tenant;
  const empresa: Empresa = { nombre: t.nombre, nit: t.nit, ciudad: t.ciudad, logo: t.logo_data_url, monograma: t.tema?.monograma };
  const imprimir = () => {
    const el = ref.current;
    if (!el) return;
    el.setAttribute('data-imprimir', '');
    document.body.classList.add('imprimiendo-informe');
    const fin = () => { el.removeAttribute('data-imprimir'); document.body.classList.remove('imprimiendo-informe'); window.removeEventListener('afterprint', fin); };
    window.addEventListener('afterprint', fin);
    window.print();
    setTimeout(fin, 1500);
  };
  return (
    <article ref={ref} className="vz-informe" aria-label={`Informe: ${inf.titulo}`}>
      <header className="vz-inf-cab">
        <span className="vz-inf-marca"><img src={MARCA.icono} alt="" width={28} height={28} /><span><b>{MARCA.nombre}</b><small>{origen}</small></span></span>
        <span className="vz-inf-empresa">
          <span><b>{empresa.nombre}</b><small>{[empresa.nit ? `NIT ${empresa.nit}` : null, empresa.ciudad].filter(Boolean).join(' · ')}</small></span>
          {empresa.logo ? <img src={empresa.logo} alt={`Logotipo de ${empresa.nombre}`} /> : empresa.monograma ? <span className="vz-inf-monograma" aria-hidden="true">{empresa.monograma}</span> : null}
        </span>
      </header>
      <div className="vz-inf-cuerpo">
        <h3 className="vz-inf-titulo">{inf.titulo}</h3>
        <p className="vz-inf-periodo">{[inf.periodo, `Generado el ${generado.toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' })}`].filter(Boolean).join(' · ')}</p>
        {inf.resumen && <p className="vz-inf-resumen">{inf.resumen}</p>}
        {inf.cifras?.length ? <div className="vz-inf-cifras">{inf.cifras.map((k, i) => <div key={i} className="vz-inf-cifra" style={{ ['--i' as any]: i }}><span>{k.etiqueta}</span><b>{k.valor}</b>{k.detalle && <small>{k.detalle}</small>}</div>)}</div> : null}
        {inf.secciones.map((sec, i) => (
          <section key={i} className="vz-inf-seccion">
            <h4>{sec.titulo}</h4>
            {sec.texto && <p>{sec.texto}</p>}
            {sec.tabla && (
              <div className="vz-datos" tabIndex={0} role="region" aria-label={sec.titulo}>
                <table>
                  <thead><tr>{sec.tabla.columnas.map((c, j) => <th key={j} scope="col" className={j ? 'num' : ''}>{c}</th>)}</tr></thead>
                  <tbody>{sec.tabla.filas.map((f, k) => <tr key={k}>{f.map((v, j) => j === 0 ? <th key={j} scope="row">{v}</th> : <td key={j} className="num">{typeof v === 'number' ? formatoValor(v) : v}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
            {sec.grafica && <Grafica g={sec.grafica} enInforme />}
          </section>
        ))}
        {inf.notas && <p className="vz-inf-notas">{inf.notas}</p>}
      </div>
      <footer className="vz-inf-pie">
        <span>Datos de {empresa.nombre} consultados en su panel de {MARCA.nombre}. Verifica las cifras antes de compartir este informe.</span>
        <span className="vz-acciones">
          <BotonExportar onClick={async () => descargarLienzo(await informeAPng(inf, empresa, acentoActual(), generado, origen), nombreArchivo(`${inf.titulo}-${empresa.nombre}`))}>Descargar imagen</BotonExportar>
          <button type="button" className="vz-boton" onClick={imprimir}><Icon n="facturacion" className="" size={14} />Imprimir o PDF</button>
        </span>
      </footer>
    </article>
  );
}

/** Bloque de datos visual del asistente; si no se puede leer, lo dice en vez de mostrar el JSON. */
export function BloqueVisual({ lang, json }: { lang: 'grafica' | 'informe'; json: string }) {
  const datos = useMemo(() => { try { return JSON.parse(json); } catch { return null; } }, [json]);
  if (!datos || (lang === 'grafica' && !Array.isArray(datos.series)) || (lang === 'informe' && !Array.isArray(datos.secciones))) {
    return <p className="vz-error"><Icon n="alerta" className="" size={14} />No pude dibujar {lang === 'grafica' ? 'la gráfica' : 'el informe'}. Pídeselo de nuevo al asistente.</p>;
  }
  return lang === 'grafica' ? <Grafica g={datos} /> : <Informe inf={datos} />;
}
