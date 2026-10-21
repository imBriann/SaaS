import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Contador } from '../Movimiento';
import { sonar } from '../../lib/sonido';

/**
 * Piezas animadas de planes y facturación. Solo decoran datos reales que llegan del servidor:
 * ninguna inventa montos ni estados. Con «reducir movimiento» no ruedan ni lanzan confeti: aparecen con un fundido.
 */

const RESORTE = { type: 'spring' as const, stiffness: 300, damping: 30 };
const DIGITOS = '0123456789'.split('');

/**
 * Cifra tipo odómetro: cada dígito rueda por separado, con un pequeño retraso entre columnas.
 * Las columnas se alinean desde la derecha, así que pasar de $99.000 a $229.000 mueve solo lo que cambia.
 */
export function Rodillo({ texto, className = '', alMontar = true }: { texto: string; className?: string; alMontar?: boolean }) {
  const reducido = useReducedMotion();
  const chars = [...texto];
  if (reducido) {
    return <span className={`rodillo ${className}`}><motion.span key={texto} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>{texto}</motion.span></span>;
  }
  return (
    <span className={`rodillo ${className}`}>
      <span className="sr">{texto}</span>
      <span className="rodillo-fila" aria-hidden="true">
        {chars.map((c, i) => {
          const desdeDerecha = chars.length - i;
          return /\d/.test(c)
            ? <span key={`d${desdeDerecha}`} className="rodillo-col">
                <motion.span className="rodillo-tira" initial={alMontar ? { y: '0%' } : false} animate={{ y: `${-Number(c) * 10}%` }}
                  transition={{ type: 'spring', stiffness: 150, damping: 21, delay: Math.min(desdeDerecha, 8) * 0.035 }}>
                  {DIGITOS.map((d) => <span key={d}>{d}</span>)}
                </motion.span>
              </span>
            : <span key={`s${desdeDerecha}`} className="rodillo-sim">{c}</span>;
        })}
      </span>
    </span>
  );
}

/** Código de barras determinista a partir de la referencia del pago (decorativo; la referencia va escrita debajo). */
export function CodigoBarras({ valor }: { valor: string }) {
  const barras: { x: number; w: number }[] = [];
  let x = 0;
  for (const ch of `*${valor}*`) {
    const c = ch.charCodeAt(0);
    for (let k = 0; k < 4; k++) {
      const w = 1 + ((c >> k) & 1) + ((c >> (k + 3)) & 1);
      if (k % 2 === 0) barras.push({ x, w });
      x += w + 1;
    }
  }
  return (
    <svg className="barras" viewBox={`0 0 ${x} 30`} preserveAspectRatio="none" aria-hidden="true">
      {barras.map((b, i) => <rect key={i} x={b.x} y={0} width={b.w} height={30} />)}
    </svg>
  );
}

/**
 * Impresora térmica: una ranura negra y el recibo que sale de ella hacia abajo, con borde dentado y una
 * vibración al terminar. `clave` reinicia la impresión (por ejemplo, al abrir otro recibo). El sello se estampa al final.
 */
export function Impresora({ clave, children, sello, tono = 'claro', luz = true }: { clave: string; children: ReactNode; sello?: string | null; tono?: 'claro' | 'oscuro'; luz?: boolean }) {
  const reducido = useReducedMotion();
  // El cabezal suena mientras sale el papel y el sello golpea al final.
  useEffect(() => {
    sonar('impresora');
    if (!sello) return;
    const t = window.setTimeout(() => sonar('sello'), reducido ? 200 : 1250);
    return () => window.clearTimeout(t);
  }, [clave]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`impresora impresora-${tono}`}>
      <div className="impresora-ranura" aria-hidden="true">{luz && <span className="impresora-luz" />}</div>
      <div className="impresora-salida">
        <motion.div key={clave} className="ticket"
          initial={reducido ? { opacity: 0 } : { y: '-101%' }}
          animate={reducido ? { opacity: 1 } : { y: '0%', x: [0, 0, -1.5, 1.5, -1, 0] }}
          transition={reducido ? { duration: 0.2 } : { y: { duration: 1.15, ease: [0.16, 1, 0.3, 1] }, x: { duration: 1.45, times: [0, 0.76, 0.83, 0.89, 0.95, 1] } }}>
          {children}
          {sello && (
            <motion.div className="ticket-sello" aria-hidden="true"
              initial={{ opacity: 0, scale: reducido ? 1 : 1.9, rotate: -13 }} animate={{ opacity: 1, scale: 1, rotate: -13 }}
              transition={reducido ? { duration: 0.2 } : { delay: 1.2, type: 'spring', stiffness: 460, damping: 17 }}>
              {sello}
            </motion.div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

/**
 * Pila de tarjetas: la elegida pasa al frente y las demás se reacomodan detrás con desfase y giro.
 * Es un grupo de opciones: se elige con clic o con las flechas.
 */
export function Pila<T extends { id: string }>({ items, seleccion, onSeleccion, render, etiqueta, className = '' }: {
  items: T[]; seleccion: string; onSeleccion: (id: string) => void; render: (item: T, alFrente: boolean) => ReactNode; etiqueta: string; className?: string;
}) {
  const reducido = useReducedMotion();
  const orden = [seleccion, ...items.map((i) => i.id).filter((id) => id !== seleccion)];
  const tecla = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const i = items.findIndex((x) => x.id === seleccion);
    const sig = items[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    onSeleccion(sig.id);
  };
  return (
    <div className={`pila ${className}`} role="radiogroup" aria-label={etiqueta} onKeyDown={tecla}>
      {items.map((it) => {
        const pos = orden.indexOf(it.id);
        return (
          <motion.button key={it.id} type="button" role="radio" aria-checked={pos === 0} tabIndex={pos === 0 ? 0 : -1}
            className={`pila-tarjeta ${pos === 0 ? 'al-frente' : ''}`} onClick={() => onSeleccion(it.id)}
            initial={false}
            animate={{ x: pos * 26, y: pos * -18, rotate: pos * 4.5, scale: 1 - pos * 0.06, zIndex: 10 - pos, opacity: pos === 0 ? 1 : Math.max(0.35, 0.8 - pos * 0.2) }}
            transition={reducido ? { duration: 0 } : { ...RESORTE, stiffness: 260, zIndex: { delay: pos === 0 ? 0.12 : 0 } }}>
            {render(it, pos === 0)}
          </motion.button>
        );
      })}
    </div>
  );
}

/** Confeti en lienzo, unos 2 segundos sobre toda la pantalla. No se muestra con «reducir movimiento». */
export function Confeti({ disparo }: { disparo: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const reducido = useReducedMotion();
  useEffect(() => {
    const c = ref.current;
    if (disparo) { sonar('exito'); window.setTimeout(() => sonar('confeti'), 250); }
    if (!disparo || reducido || !c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = window.innerWidth, H = window.innerHeight;
    c.width = W * dpr; c.height = H * dpr;
    ctx.scale(dpr, dpr);
    const colores = ['#f5c451', '#f28cb1', '#9d86f0', '#6fb7ee', '#7ad3a8', '#ffffff'];
    const ps = Array.from({ length: Math.min(180, Math.round(W / 7)) }, () => ({
      x: Math.random() * W, y: -20 - Math.random() * H * 0.6, vx: (Math.random() - 0.5) * 1.6, vy: 2.2 + Math.random() * 3.2,
      w: 4 + Math.random() * 4, h: 7 + Math.random() * 7, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.28, c: colores[Math.floor(Math.random() * colores.length)],
    }));
    let raf = 0;
    const t0 = performance.now();
    const paso = (t: number) => {
      const e = t - t0;
      ctx.clearRect(0, 0, W, H);
      ctx.globalAlpha = e > 2000 ? Math.max(0, 1 - (e - 2000) / 600) : 1;
      for (const p of ps) {
        p.x += p.vx + Math.sin(e / 320 + p.r) * 0.6; p.y += p.vy; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 1.3)) + 1);
        ctx.restore();
      }
      if (e < 2600) raf = requestAnimationFrame(paso); else ctx.clearRect(0, 0, W, H);
    };
    raf = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(raf);
  }, [disparo, reducido]);
  return createPortal(<canvas ref={ref} className="confeti" aria-hidden="true" />, document.body);
}

/** Lista en cascada: cada característica entra con su check que se dibuja. */
export function Cascada({ items, clave, className = '', retraso = 0.2 }: { items: string[]; clave: string; className?: string; retraso?: number }) {
  const reducido = useReducedMotion();
  return (
    <ul className={`cascada ${className}`}>
      {items.map((t, i) => (
        <motion.li key={`${clave}-${t}`} initial={reducido ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reducido ? 0 : retraso + i * 0.06, duration: 0.28 }}>
          <span className="cascada-check" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="12" height="12"><motion.path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"
              initial={reducido ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: reducido ? 0 : retraso + 0.08 + i * 0.06, duration: 0.3 }} /></svg>
          </span>
          {t}
        </motion.li>
      ))}
    </ul>
  );
}

/** Esfera brillante del plan: degradado radial con reflejo, flota en bucle. */
export function Esfera({ c1, c2, tam = 120, flota = true }: { c1: string; c2: string; tam?: number; flota?: boolean }) {
  const reducido = useReducedMotion();
  return (
    <motion.span className="esfera" aria-hidden="true" style={{ '--c1': c1, '--c2': c2, width: tam, height: tam } as CSSProperties}
      animate={flota && !reducido ? { y: [0, -8, 0] } : undefined} transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }} />
  );
}

/** Barra de días del periodo hecha de segmentos: los usados oscuros y los que quedan claros. Un periodo anual se cuenta por meses. */
export function BarraDias({ inicio, fin }: { inicio: string; fin: string }) {
  const reducido = useReducedMotion();
  const ini = new Date(inicio).getTime(), f = new Date(fin).getTime();
  const totalDias = Math.max(1, Math.round((f - ini) / 86_400_000));
  const anual = totalDias > 62;
  const n = anual ? 12 : Math.min(totalDias, 31);
  const usado = Math.min(1, Math.max(0, (Date.now() - ini) / (f - ini)));
  const llenos = Math.round(usado * n);
  return (
    <div className="barra-dias" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <motion.span key={i} className={i < llenos ? 'usado' : ''} initial={reducido ? false : { scaleY: 0.2, opacity: 0 }} animate={{ scaleY: 1, opacity: 1 }} transition={{ delay: reducido ? 0 : i * 0.015, duration: 0.25 }} />
      ))}
    </div>
  );
}

/** Anillo segmentado de días de gracia: se enciende segmento por segmento y el número cuenta hasta su valor. */
export function AnilloGracia({ total, restantes, texto }: { total: number; restantes: number; texto: string }) {
  const reducido = useReducedMotion();
  // Cada segmento que se enciende hace «tic», como un contador.
  useEffect(() => {
    if (reducido) return;
    const ts = Array.from({ length: restantes }, (_, i) => window.setTimeout(() => sonar('tick'), 150 + i * 90));
    return () => ts.forEach((t) => window.clearTimeout(t));
  }, [restantes, reducido]);
  const R = 62, C = 2 * Math.PI * R;
  const hueco = 9;
  const largo = C / total - hueco;
  return (
    <div className="anillo-gracia" role="img" aria-label={`${restantes} de ${total} ${texto}`}>
      <svg viewBox="0 0 160 160" width="160" height="160">
        {Array.from({ length: total }, (_, i) => {
          const encendido = i < restantes;
          return (
            <motion.circle key={i} cx="80" cy="80" r={R} fill="none" strokeWidth="13" strokeLinecap="round"
              strokeDasharray={`${largo} ${C - largo}`} strokeDashoffset={-(i * (C / total)) + C / 4}
              className={encendido ? 'on' : ''} initial={reducido ? false : { opacity: 0.25 }} animate={{ opacity: 1 }}
              transition={{ delay: reducido ? 0 : 0.15 + i * 0.09, duration: 0.25 }} />
          );
        })}
      </svg>
      <div className="anillo-centro" aria-hidden="true">
        <Contador valor={restantes} ms={Math.min(1200, 150 + total * 90)} />
        <span>{texto}</span>
      </div>
    </div>
  );
}

/** Aviso inferior con una acción (Deshacer). Se cierra solo; la acción la decide quien lo muestra. */
export function AvisoDeshacer({ aviso, onCerrar }: { aviso: { id: number; texto: string; accion?: { texto: string; fn: () => void } } | null; onCerrar: () => void }) {
  const reducido = useReducedMotion();
  useEffect(() => {
    if (!aviso) return;
    sonar('ok');
    const t = window.setTimeout(onCerrar, aviso.accion ? 9000 : 5000);
    return () => window.clearTimeout(t);
  }, [aviso?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return createPortal(
    <div className="aviso-deshacer-zona" aria-live="polite">
      <AnimatePresence>
        {aviso && (
          <motion.div key={aviso.id} className="aviso-deshacer" role="status"
            initial={reducido ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reducido ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.98 }} transition={RESORTE}>
            <span className="aviso-deshacer-check" aria-hidden="true"><svg viewBox="0 0 20 20" width="12" height="12"><path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
            <span>{aviso.texto}</span>
            {aviso.accion && <button type="button" onClick={() => { aviso.accion!.fn(); onCerrar(); }}>{aviso.accion.texto}</button>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>, document.body,
  );
}
