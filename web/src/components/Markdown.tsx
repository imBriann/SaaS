import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './icons';
import { BloqueVisual } from './Visual';

/**
 * Markdown de las respuestas de la IA, convertido a elementos de React. Nunca se inserta HTML crudo:
 * un «<script>» en una respuesta se muestra como texto. Los enlaces solo admiten http(s), mailto y rutas
 * del propio panel. Los bloques ```grafica e ```informe se dibujan como gráfica o informe; el código de
 * conversaciones antiguas se muestra como texto con resaltado y copia, nunca se ejecuta.
 */

// ---------------------------------------------------------------- bloques
type Bloque =
  | { t: 'p'; texto: string }
  | { t: 'h'; nivel: number; texto: string }
  | { t: 'code'; lang: string; codigo: string; abierto: boolean }
  | { t: 'ul' | 'ol'; items: string[]; inicio: number }
  | { t: 'quote'; texto: string }
  | { t: 'table'; cabecera: string[]; filas: string[][]; alineacion: ('left' | 'right' | 'center')[] }
  | { t: 'hr' };

const filaTabla = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const esSeparador = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

export function bloques(md: string): Bloque[] {
  const lineas = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Bloque[] = [];
  let i = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (!l.trim()) { i++; continue; }
    const fence = l.match(/^\s*(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const cuerpo: string[] = [];
      i++;
      while (i < lineas.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lineas[i])) cuerpo.push(lineas[i++]);
      const cerrado = i < lineas.length;
      if (cerrado) i++;
      out.push({ t: 'code', lang: fence[2].toLowerCase(), codigo: cuerpo.join('\n'), abierto: !cerrado });
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) { out.push({ t: 'h', nivel: h[1].length, texto: h[2] }); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^\s*>/.test(l)) {
      const q: string[] = [];
      while (i < lineas.length && /^\s*>/.test(lineas[i])) q.push(lineas[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', texto: q.join('\n') });
      continue;
    }
    if (l.includes('|') && i + 1 < lineas.length && esSeparador(lineas[i + 1])) {
      const cabecera = filaTabla(l);
      const alineacion = filaTabla(lineas[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') as 'left' | 'right' | 'center');
      i += 2;
      const filas: string[][] = [];
      while (i < lineas.length && lineas[i].includes('|') && lineas[i].trim()) filas.push(filaTabla(lineas[i++]));
      out.push({ t: 'table', cabecera, filas, alineacion });
      continue;
    }
    const li = l.match(/^\s*([-*+]|(\d{1,3})[.)])\s+(.*)$/);
    if (li) {
      const ordenada = !!li[2];
      const items: string[] = [];
      while (i < lineas.length) {
        const m = lineas[i].match(/^\s*([-*+]|(\d{1,3})[.)])\s+(.*)$/);
        if (m && !!m[2] === ordenada) { items.push(m[3]); i++; continue; }
        // Continuación del ítem anterior (línea con sangría).
        if (items.length && /^\s{2,}\S/.test(lineas[i]) && !/^\s*([-*+]|\d{1,3}[.)])\s/.test(lineas[i])) { items[items.length - 1] += `\n${lineas[i].trim()}`; i++; continue; }
        break;
      }
      out.push({ t: ordenada ? 'ol' : 'ul', items, inicio: ordenada ? Number(li[2]) : 1 });
      continue;
    }
    const p: string[] = [];
    while (i < lineas.length && lineas[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d{1,3}[.)]\s)/.test(lineas[i]) && !(lineas[i].includes('|') && i + 1 < lineas.length && esSeparador(lineas[i + 1]))) p.push(lineas[i++]);
    if (p.length) out.push({ t: 'p', texto: p.join('\n') });
    else { out.push({ t: 'p', texto: lineas[i] }); i++; }
  }
  return out;
}

// ---------------------------------------------------------------- en línea
const ENLACE_SEGURO = /^(https?:\/\/|mailto:|\/(?!\/))/i;

function enlace(href: string, hijos: ReactNode, k: string) {
  const h = href.trim();
  if (!ENLACE_SEGURO.test(h)) return <Fragment key={k}>{hijos}</Fragment>;
  if (h.startsWith('/')) return <Link key={k} to={h}>{hijos}</Link>;
  return <a key={k} href={h} target="_blank" rel="noopener noreferrer nofollow">{hijos}<span className="sr"> (abre en otra pestaña)</span></a>;
}

/** Texto con **negrita**, *cursiva*, `código`, [enlaces](url) y URL sueltas. */
export function enLinea(texto: string, clave = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])|~~([\s\S]+?)~~|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"»])/g;
  let ultimo = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(texto))) {
    if (m.index > ultimo) out.push(saltos(texto.slice(ultimo, m.index), `${clave}t${n}`));
    const k = `${clave}m${n++}`;
    if (m[2] !== undefined) out.push(<code key={k} className="md-code-in">{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={k}>{enLinea(m[3] ?? m[4], k)}</strong>);
    else if (m[5] !== undefined || m[6] !== undefined) out.push(<em key={k}>{enLinea(m[5] ?? m[6], k)}</em>);
    else if (m[7] !== undefined) out.push(<del key={k}>{enLinea(m[7], k)}</del>);
    else if (m[8] !== undefined) out.push(enlace(m[9], enLinea(m[8], k), k));
    else if (m[10] !== undefined) out.push(enlace(m[10], m[10], k));
    ultimo = re.lastIndex;
  }
  if (ultimo < texto.length) out.push(saltos(texto.slice(ultimo), `${clave}t${n}`));
  return out;
}

function saltos(t: string, k: string): ReactNode {
  const partes = t.split('\n');
  return partes.length === 1 ? t : <Fragment key={k}>{partes.map((p, i) => <Fragment key={i}>{i > 0 && <br />}{p}</Fragment>)}</Fragment>;
}

// ---------------------------------------------------------------- resaltado de sintaxis
type Regla = [string, RegExp];
const R = (s: string, f = '') => new RegExp(s, f);
const PALABRAS_JS = 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|this|super|yield|delete|void|interface|type|enum|implements|public|private|protected|readonly|static|as';
const LENGUAJES: Record<string, Regla[]> = {
  js: [['com', /\/\/[^\n]*|\/\*[\s\S]*?\*\//], ['str', /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/], ['kw', R(`\\b(?:${PALABRAS_JS})\\b`)], ['lit', /\b(?:true|false|null|undefined|NaN|Infinity)\b/], ['num', /\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i], ['fn', /\b[A-Za-z_$][\w$]*(?=\s*\()/]],
  json: [['key', /"(?:\\.|[^"\\\n])*"(?=\s*:)/], ['str', /"(?:\\.|[^"\\\n])*"/], ['lit', /\b(?:true|false|null)\b/], ['num', /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/i]],
  html: [['com', /<!--[\s\S]*?-->/], ['tag', /<\/?[A-Za-z][\w:-]*|\/?>/], ['attr', /\b[A-Za-z_:][\w:.-]*(?==)/], ['str', /"[^"]*"|'[^']*'/], ['ent', /&[#\w]+;/]],
  css: [['com', /\/\*[\s\S]*?\*\//], ['at', /@[\w-]+/], ['prop', /[\w-]+(?=\s*:(?!:))/], ['str', /"[^"\n]*"|'[^'\n]*'/], ['num', /#[0-9a-fA-F]{3,8}\b|-?\b\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/], ['sel', /[.#][\w-]+|::?[\w-]+/]],
  sql: [['com', /--[^\n]*|\/\*[\s\S]*?\*\//], ['str', /'(?:''|[^'])*'/], ['kw', /\b(?:SELECT|FROM|WHERE|AND|OR|NOT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|BY|ORDER|HAVING|LIMIT|OFFSET|AS|DISTINCT|NULL|IS|IN|LIKE|ILIKE|CASE|WHEN|THEN|ELSE|END|PRIMARY|KEY|REFERENCES|INDEX|UNIQUE|DEFAULT|RETURNING|WITH|UNION|ALL|EXISTS|BETWEEN|COUNT|SUM|AVG|MIN|MAX)\b/i], ['num', /\b\d+(?:\.\d+)?\b/]],
  python: [['com', /#[^\n]*/], ['str', /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/], ['kw', /\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|try|except|finally|raise|with|lambda|yield|pass|break|continue|global|nonlocal|async|await|is|del|assert)\b/], ['lit', /\b(?:True|False|None)\b/], ['num', /\b\d+(?:\.\d+)?\b/], ['fn', /\b[A-Za-z_]\w*(?=\s*\()/], ['at', /@[\w.]+/]],
  bash: [['com', /(?<![\w$])#[^\n]*/], ['str', /"(?:\\.|[^"\\])*"|'[^']*'/], ['var', /\$\{?[\w@#?*!-]+\}?/], ['kw', /\b(?:if|then|else|elif|fi|for|in|do|done|while|case|esac|function|export|local|return|echo|cd|sudo)\b/], ['num', /\b\d+\b/]],
};
const ALIAS: Record<string, string> = {
  javascript: 'js', jsx: 'js', ts: 'js', tsx: 'js', typescript: 'js', mjs: 'js', node: 'js',
  xml: 'html', svg: 'html', vue: 'html', htm: 'html', scss: 'css', less: 'css', postgres: 'sql', postgresql: 'sql', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
};
const NOMBRE_LENGUAJE: Record<string, string> = { js: 'JavaScript', json: 'JSON', html: 'HTML', css: 'CSS', sql: 'SQL', python: 'Python', bash: 'Terminal' };
const lenguaje = (lang: string) => ALIAS[lang] ?? (LENGUAJES[lang] ? lang : '');

/** Resaltado por expresiones regulares: suficiente para leer, sin dependencias ni HTML insertado. */
function resaltar(codigo: string, lang: string): ReactNode[] {
  const reglas = LENGUAJES[lenguaje(lang)];
  if (!reglas || codigo.length > 60_000) return [codigo];
  const re = new RegExp(reglas.map(([, r]) => `(${r.source})`).join('|'), 'g' + (reglas.some(([, r]) => r.flags.includes('i')) ? 'i' : ''));
  const out: ReactNode[] = [];
  let ultimo = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(codigo))) {
    if (!m[0]) { re.lastIndex++; continue; }
    if (m.index > ultimo) out.push(codigo.slice(ultimo, m.index));
    const g = m.slice(1).findIndex((x) => x !== undefined);
    out.push(<span key={n++} className={`tk-${reglas[g]?.[0] ?? 'x'}`}>{m[0]}</span>);
    ultimo = re.lastIndex;
  }
  if (ultimo < codigo.length) out.push(codigo.slice(ultimo));
  return out;
}

// ---------------------------------------------------------------- bloque de código
const LINEAS_VISIBLES = 18;

async function copiarTexto(texto: string) {
  try { await navigator.clipboard.writeText(texto); return true; } catch {
    // Respaldo para navegadores sin portapapeles asíncrono (o sin permiso).
    const area = document.createElement('textarea');
    area.value = texto; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    const ok = document.execCommand('copy'); area.remove();
    return ok;
  }
}

export function BotonCopiar({ texto, etiqueta = 'Copiar', className = '' }: { texto: string; etiqueta?: string; className?: string }) {
  const [estado, setEstado] = useState<'listo' | 'copiado' | 'error'>('listo');
  useEffect(() => { if (estado === 'listo') return; const t = window.setTimeout(() => setEstado('listo'), 1800); return () => window.clearTimeout(t); }, [estado]);
  return (
    <button type="button" className={`md-copiar ${estado} ${className}`} onClick={async () => setEstado((await copiarTexto(texto)) ? 'copiado' : 'error')} aria-live="polite">
      <Icon n={estado === 'copiado' ? 'ok' : estado === 'error' ? 'alerta' : 'copiar'} className="" size={14} />
      <span>{estado === 'copiado' ? 'Copiado' : estado === 'error' ? 'No se pudo copiar' : etiqueta}</span>
    </button>
  );
}

export function BloqueCodigo({ codigo, lang, abierto = false }: { codigo: string; lang: string; abierto?: boolean }) {
  const lineas = codigo.split('\n').length;
  const largo = lineas > LINEAS_VISIBLES + 4;
  const [expandido, setExpandido] = useState(false);
  const contenido = useMemo(() => resaltar(codigo, lang), [codigo, lang]);
  const nombre = NOMBRE_LENGUAJE[lenguaje(lang)] ?? (lang ? lang.toUpperCase() : 'Código');
  return (
    <figure className={`md-bloque ${largo && !expandido ? 'recogido' : ''}`}>
      <figcaption className="md-bloque-cab">
        <span className="md-lang">{nombre}<span className="md-lineas">{lineas} {lineas === 1 ? 'línea' : 'líneas'}</span></span>
        <span className="md-bloque-acciones">
          <BotonCopiar texto={codigo} />
        </span>
      </figcaption>
      <pre className="md-pre" tabIndex={0} aria-label={`Código ${nombre}`}><code>{contenido}</code></pre>
      {largo && (
        <button type="button" className="md-expandir" onClick={() => setExpandido((v) => !v)} aria-expanded={expandido}>
          {expandido ? 'Mostrar menos' : `Mostrar las ${lineas} líneas`}<Icon n={expandido ? 'arriba' : 'abajo'} className="" size={14} />
        </button>
      )}
      {abierto && <p className="md-incompleto">El bloque de código llegó incompleto.</p>}
    </figure>
  );
}

// ---------------------------------------------------------------- documento
export function Markdown({ texto, revelar = false }: { texto: string; revelar?: boolean }) {
  const bs = useMemo(() => bloques(texto ?? ''), [texto]);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={`md ${revelar ? 'md-revelar' : ''}`}>
      {bs.map((b, i) => {
        const estilo = revelar ? { ['--i' as any]: Math.min(i, 12) } : undefined;
        const k = `b${i}`;
        switch (b.t) {
          case 'h': {
            const Tag = (`h${Math.min(6, b.nivel + 2)}`) as 'h3';
            return <Tag key={k} className="md-h" style={estilo}>{enLinea(b.texto, k)}</Tag>;
          }
          case 'code':
            // Gráficas e informes del asistente: datos que el panel dibuja (nunca código que se ejecute).
            if ((b.lang === 'grafica' || b.lang === 'informe') && !b.abierto) return <div key={k} style={estilo} className="md-visual-wrap"><BloqueVisual lang={b.lang} json={b.codigo} /></div>;
            return <div key={k} style={estilo} className="md-bloque-wrap"><BloqueCodigo codigo={b.codigo} lang={b.lang} abierto={b.abierto} /></div>;
          case 'ul': return <ul key={k} style={estilo}>{b.items.map((it, j) => <li key={j}>{enLinea(it, `${k}-${j}`)}</li>)}</ul>;
          case 'ol': return <ol key={k} start={b.inicio} style={estilo}>{b.items.map((it, j) => <li key={j}>{enLinea(it, `${k}-${j}`)}</li>)}</ol>;
          case 'quote': return <blockquote key={k} style={estilo}>{enLinea(b.texto, k)}</blockquote>;
          case 'hr': return <hr key={k} style={estilo} />;
          case 'table': return (
            <div key={k} className="md-tabla" style={estilo} tabIndex={0} role="region" aria-label="Tabla">
              <table>
                <thead><tr>{b.cabecera.map((c, j) => <th key={j} style={{ textAlign: b.alineacion[j] ?? 'left' }}>{enLinea(c, `${k}h${j}`)}</th>)}</tr></thead>
                <tbody>{b.filas.map((f, r) => <tr key={r}>{b.cabecera.map((_, j) => <td key={j} style={{ textAlign: b.alineacion[j] ?? 'left' }}>{enLinea(f[j] ?? '', `${k}${r}-${j}`)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          );
          default: return <p key={k} style={estilo}>{enLinea(b.texto, k)}</p>;
        }
      })}
    </div>
  );
}

/** Texto de WhatsApp: *negrita*, _cursiva_, ~tachado~, ```monoespaciado``` y enlaces; sin otro formato. */
export function TextoWhatsApp({ texto }: { texto: string }) {
  const nodos = useMemo(() => {
    const out: ReactNode[] = [];
    const re = /```([\s\S]+?)```|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])|(?<![\w~])~(?!\s)([^~\n]+?)~(?![\w~])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"»])/g;
    let ultimo = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(texto))) {
      if (m.index > ultimo) out.push(saltos(texto.slice(ultimo, m.index), `w${n}t`));
      const k = `w${n++}`;
      if (m[1] !== undefined) out.push(<code key={k} className="md-code-in">{m[1]}</code>);
      else if (m[2] !== undefined) out.push(<strong key={k}>{m[2]}</strong>);
      else if (m[3] !== undefined) out.push(<em key={k}>{m[3]}</em>);
      else if (m[4] !== undefined) out.push(<del key={k}>{m[4]}</del>);
      else if (m[5] !== undefined) out.push(enlace(m[5], m[5], k));
      ultimo = re.lastIndex;
    }
    if (ultimo < texto.length) out.push(saltos(texto.slice(ultimo), `w${n}f`));
    return out;
  }, [texto]);
  return <span className="texto-wa">{nodos}</span>;
}
