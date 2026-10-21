import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { animate, AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useConstruccion } from './Construccion';
import { useIA } from '../ia/contexto';

const SUAVE = [0.22, 1, 0.36, 1] as const;

/** ¿La pieza todavía espera su turno? (marco vacío o esqueleto durante una construcción). */
function useEsperando() {
  const { fase, activa } = useConstruccion();
  return activa && (fase === 'shell' || fase === 'esqueleto');
}

/**
 * Tarjeta del tablero vivo. Esqueleto y contenido son la MISMA caja: el contenido real ya está
 * montado (con su tamaño final) y solo se revela, así que nada salta al terminar. Fuera de una
 * construcción se pinta directamente. Con el panel de la IA abierto, la grilla se reacomoda y la
 * tarjeta se desliza a su nuevo lugar.
 */
export function Construible({ i = 0, className = '', children, etiqueta, guia }: { i?: number; className?: string; children: ReactNode; etiqueta?: string; guia?: string }) {
  const { fase, activa } = useConstruccion();
  useIA(); // vuelve a medir la grilla cuando el panel de la IA se abre o se cierra
  const reducido = useReducedMotion();
  const vacia = activa && fase === 'shell';
  const esqueleto = activa && (fase === 'shell' || fase === 'esqueleto');
  return (
    <motion.section layout={!reducido} className={`tv-card ${className} ${esqueleto ? 'es-esqueleto' : ''}`} data-construible={i} data-guia={guia} aria-label={etiqueta}
      initial={false}
      animate={vacia ? { opacity: 0, y: 16, scale: 0.97 } : { opacity: 1, y: 0, scale: 1 }}
      transition={{ default: { duration: 0.5, ease: SUAVE, delay: activa && fase === 'esqueleto' ? Math.min(i, 12) * 0.07 : 0 }, layout: { duration: 0.5, ease: SUAVE } }}>
      <motion.div layout={!reducido ? 'position' : false} className="tv-contenido" initial={false}
        animate={esqueleto ? { opacity: 0, y: 12, filter: 'blur(8px)' } : { opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.55, ease: SUAVE, delay: activa && fase === 'revelado' ? Math.min(i, 12) * 0.08 : 0 }}>
        {children}
      </motion.div>
      <AnimatePresence>
        {esqueleto && <motion.span className="tv-esqueleto" aria-hidden="true" initial={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.45, delay: Math.min(i, 12) * 0.08 } }} />}
      </AnimatePresence>
    </motion.section>
  );
}

/**
 * Cifra que cuenta hacia arriba con curva easeOut y respeta su formato (moneda, %, «104 / 132»).
 * En una construcción espera en 0 hasta que su tarjeta se revela; si el valor cambia después,
 * sigue desde lo que se ve. Los lectores de pantalla reciben solo el valor final.
 */
export function Cuenta({ valor, formato = (n: number) => Math.round(n).toLocaleString('es-CO'), duracion = 1.1, i = 0, className = '' }: {
  valor: number; formato?: (n: number) => string; duracion?: number; i?: number; className?: string;
}) {
  const { ciclo, activa } = useConstruccion();
  const esperando = useEsperando();
  const reducido = useReducedMotion();
  const [v, setV] = useState(() => (reducido ? valor : 0));
  const actual = useRef(v);
  useEffect(() => {
    if (esperando) { actual.current = 0; setV(0); return; }
    if (reducido) { actual.current = valor; setV(valor); return; }
    const c = animate(actual.current, valor, { duration: duracion, ease: 'easeOut', delay: activa ? 0.12 + Math.min(i, 12) * 0.08 : 0, onUpdate: (n) => { actual.current = n; setV(n); } });
    return () => c.stop();
  }, [valor, esperando, ciclo, reducido]); // eslint-disable-line react-hooks/exhaustive-deps
  return <span className={`num ${className}`}><span aria-hidden="true">{formato(v)}</span><span className="sr">{formato(valor)}</span></span>;
}

/** Curva suave que pasa por todos los puntos (Catmull-Rom → Bézier), sin pasarse por debajo de 0. */
function curva(p: [number, number][], piso: number) {
  if (p.length < 2) return p.length ? `M${p[0][0]},${p[0][1]}` : '';
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let k = 0; k < p.length - 1; k++) {
    const a = p[k - 1] ?? p[k], b = p[k], c = p[k + 1], e = p[k + 2] ?? c;
    const c1y = Math.min(piso, b[1] + (c[1] - a[1]) / 6), c2y = Math.min(piso, c[1] - (e[1] - b[1]) / 6);
    d += ` C${b[0] + (c[0] - a[0]) / 6},${c1y} ${c[0] - (e[0] - b[0]) / 6},${c2y} ${c[0]},${c[1]}`;
  }
  return d;
}

/**
 * Gráfica de línea del tablero: se dibuja (pathLength 0 → 1), el área aparece debajo y el mejor
 * punto queda marcado. Al pasar el dedo o el cursor muestra el valor de cada día.
 */
export function LineaViva({ valores, etiquetas, formato, alto = 170, i = 0, nombre }: { valores: number[]; etiquetas: string[]; formato: (n: number) => string; alto?: number; i?: number; nombre: string }) {
  const { ciclo, activa } = useConstruccion();
  const esperando = useEsperando();
  const reducido = useReducedMotion();
  const id = useId().replace(/:/g, '');
  const [sobre, setSobre] = useState<number | null>(null);
  const W = 600, H = alto, PAD = 14;
  const max = Math.max(...valores, 1);
  const puntos = useMemo(() => valores.map((v, k) => [valores.length === 1 ? W / 2 : (k / (valores.length - 1)) * W, H - PAD - (v / max) * (H - PAD * 2.6)] as [number, number]), [valores, max, H]);
  const d = curva(puntos, H - PAD);
  const pico = valores.indexOf(Math.max(...valores));
  const hayDatos = valores.some((v) => v > 0);
  const retraso = activa ? 0.2 + Math.min(i, 12) * 0.08 : 0;
  const mover = (x: number, ancho: number) => setSobre(Math.max(0, Math.min(valores.length - 1, Math.round((x / ancho) * (valores.length - 1)))));
  return (
    <div className="tv-linea" style={{ height: alto }} role="img" aria-label={`${nombre}: ${valores.map((v, k) => `${etiquetas[k]} ${formato(v)}`).join(', ')}`}
      onPointerMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); mover(e.clientX - r.left, r.width); }} onPointerLeave={() => setSobre(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`area-${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--acento)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--acento)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={PAD + (H - PAD * 2) * f} y2={PAD + (H - PAD * 2) * f} className="tv-linea-guia" />)}
        {!esperando && hayDatos && <motion.path key={`a${ciclo}`} d={`${d} L${W},${H} L0,${H} Z`} fill={`url(#area-${id})`} initial={reducido ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.8, delay: retraso + 0.5 }} />}
        {!esperando && <motion.path key={`l${ciclo}`} d={d} className="tv-linea-trazo" initial={reducido ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: 'easeInOut', delay: retraso }} />}
        {sobre !== null && <line x1={puntos[sobre][0]} x2={puntos[sobre][0]} y1={PAD / 2} y2={H} className="tv-linea-cursor" />}
      </svg>
      {!esperando && hayDatos && (
        <motion.span key={`p${ciclo}`} className="tv-pico" style={{ left: `${(puntos[pico][0] / W) * 100}%`, top: `${(puntos[pico][1] / H) * 100}%` }}
          initial={reducido ? false : { scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 18, delay: retraso + 1.05 }}>
          <i /><b>{formato(valores[pico])}</b><small>{etiquetas[pico]}</small>
        </motion.span>
      )}
      {sobre !== null && (
        <span className="tv-linea-tip" style={{ left: `${(puntos[sobre][0] / W) * 100}%`, top: `${(puntos[sobre][1] / H) * 100}%` }}>
          <b>{formato(valores[sobre])}</b><small>{etiquetas[sobre]}</small>
        </span>
      )}
    </div>
  );
}

/** Medidor semicircular: el arco se llena hasta su porcentaje y la cifra cuenta a la par. */
export function Arco({ pct, i = 0, etiqueta, pie }: { pct: number; i?: number; etiqueta: string; pie?: ReactNode }) {
  const { ciclo, activa } = useConstruccion();
  const esperando = useEsperando();
  const reducido = useReducedMotion();
  const p = Math.max(0, Math.min(100, pct));
  const arco = 'M14,106 A86,86 0 0 1 186,106';
  return (
    <div className="tv-arco" role="img" aria-label={`${etiqueta}: ${Math.round(p)} %`}>
      <svg viewBox="0 0 200 116" aria-hidden="true">
        <path d={arco} className="tv-arco-pista" />
        {!esperando && p > 0 && <motion.path key={ciclo} d={arco} className="tv-arco-valor" initial={reducido ? false : { pathLength: 0 }} animate={{ pathLength: Math.max(p / 100, 0.001) }} transition={{ duration: 1.3, ease: 'easeOut', delay: activa ? 0.15 + i * 0.08 : 0.1 }} />}
      </svg>
      <span className="tv-arco-cifra"><Cuenta valor={p} formato={(n) => `${Math.round(n)} %`} i={i} duracion={1.3} />{pie && <small>{pie}</small>}</span>
    </div>
  );
}

/** Barras pequeñas que suben una tras otra (la última, la de hoy, en el color de acento). */
export function MiniBarras({ valores, i = 0, nombre }: { valores: number[]; i?: number; nombre: string }) {
  const { ciclo, activa } = useConstruccion();
  const esperando = useEsperando();
  const reducido = useReducedMotion();
  const max = Math.max(...valores, 1);
  return (
    <span className="tv-minibarras" role="img" aria-label={nombre}>
      {valores.map((v, k) => (
        <motion.i key={`${ciclo}-${k}`} className={k === valores.length - 1 ? 'hoy' : ''} style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
          initial={reducido ? false : { scaleY: 0 }} animate={{ scaleY: esperando ? 0 : 1 }} transition={{ type: 'spring', stiffness: 260, damping: 20, delay: activa ? 0.2 + i * 0.08 + k * 0.05 : k * 0.04 }} />
      ))}
    </span>
  );
}

/** Línea de tendencia mínima (sin ejes) que se dibuja de izquierda a derecha. */
export function Chispa({ valores, i = 0, nombre, clara }: { valores: number[]; i?: number; nombre: string; clara?: boolean }) {
  const { ciclo, activa } = useConstruccion();
  const esperando = useEsperando();
  const reducido = useReducedMotion();
  const W = 120, H = 40;
  const max = Math.max(...valores, 1);
  const d = curva(valores.map((v, k) => [(k / Math.max(1, valores.length - 1)) * W, H - 4 - (v / max) * (H - 10)] as [number, number]), H - 4);
  return (
    <svg className={`tv-chispa ${clara ? 'clara' : ''}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={nombre}>
      {!esperando && <motion.path key={ciclo} d={d} initial={reducido ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1, ease: 'easeInOut', delay: activa ? 0.2 + i * 0.08 : 0 }} />}
    </svg>
  );
}

/** Variación frente al periodo anterior: verde si sube, roja si baja; sin base de comparación no se muestra. */
export function Variacion({ actual, previo, sufijo }: { actual: number; previo: number; sufijo?: string }) {
  if (!previo) return null;
  const pct = ((actual - previo) / previo) * 100;
  const tono = Math.abs(pct) < 0.5 ? 'igual' : pct > 0 ? 'sube' : 'baja';
  return <span className={`tv-var ${tono}`} title={sufijo}>{tono === 'sube' ? '+' : tono === 'baja' ? '−' : ''}{Math.abs(pct).toLocaleString('es-CO', { maximumFractionDigits: 1 })} %{sufijo && <span className="sr"> {sufijo}</span>}</span>;
}
