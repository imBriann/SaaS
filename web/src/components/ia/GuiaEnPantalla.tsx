import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { OrbeCara } from './OrbeCara';
import { useIA } from './contexto';
import { GUIAS } from './guias';
import { Icon } from '../icons';
import { sonar } from '../../lib/sonido';
import { callar, hablar } from '../../lib/voz';

/** Busca el elemento señalado que de verdad se ve (el menú móvil escondido o un rol sin permiso no cuentan). */
function buscar(ancla: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guia="${CSS.escape(ancla)}"]`)) {
    const r = el.getBoundingClientRect();
    const visible = typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true }) : r.width > 0;
    if (visible && r.width > 0 && r.height > 0) return el;
  }
  return null;
}

/** Guía que está corriendo (una a la vez); cada nueva guía empieza de cero. */
export function GuiaEnPantalla() {
  const { guia, terminarGuia } = useIA();
  if (!guia || !GUIAS[guia.id]) return null;
  return <Recorrido key={guia.n} id={guia.id} onFin={terminarGuia} />;
}

interface Caja { x: number; y: number; w: number; h: number }
const iguales = (a: Caja | null, b: Caja) => !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
const ORBE = 44;

function Recorrido({ id, onFin }: { id: string; onFin: () => void }) {
  const g = GUIAS[id];
  const nav = useNavigate();
  const loc = useLocation();
  const reducido = useReducedMotion();
  const [k, setK] = useState(0);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [estado, setEstado] = useState<'buscando' | 'listo' | 'perdido'>('buscando');
  const [caja, setCaja] = useState<Caja | null>(null);
  const [capa, setCapa] = useState<HTMLElement>(document.body);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [altoGlobo, setAltoGlobo] = useState(170);
  const sentido = useRef(1);
  const navegado = useRef(-1);
  const ultima = useRef({ orbe: { x: window.innerWidth - 80, y: window.innerHeight - 90 }, globo: { x: window.innerWidth - 360, y: window.innerHeight - 280 } });
  const nodo = useRef<HTMLDivElement>(null);
  const globo = useRef<HTMLDivElement>(null);
  const paso = g.pasos[k];

  const ir = useCallback((n: number) => {
    if (n >= g.pasos.length) { onFin(); return; }
    if (n < 0) return;
    sentido.current = n >= k ? 1 : -1;
    setEl(null); setEstado('buscando'); setK(n);
  }, [g.pasos.length, k, onFin]);

  // Llega a la pantalla del paso y espera a que el elemento aparezca (un formulario que se abre, datos que cargan).
  useEffect(() => {
    if (!paso || estado !== 'buscando') return;
    if (paso.ruta) {
      const [ruta, consulta] = paso.ruta.split('?');
      // Una sola vez por paso: si la pantalla limpia su dirección (?pago=…), no se vuelve a navegar.
      if (navegado.current !== k && (loc.pathname !== ruta || (consulta && !loc.search.includes(consulta)))) { navegado.current = k; nav(paso.ruta); return; }
    }
    const t0 = performance.now();
    let t = 0;
    const intento = () => {
      const x = buscar(paso.ancla);
      if (x) {
        const r = x.getBoundingClientRect();
        if (r.top < 72 || r.bottom > window.innerHeight - 96) x.scrollIntoView({ block: 'center', behavior: reducido ? 'auto' : 'smooth' });
        setEl(x); setEstado('listo'); sonar('guia');
        return;
      }
      // Un paso opcional que no está (p. ej. los métodos de pago antes de agregar un ítem) se salta rápido.
      if (performance.now() - t0 > (paso.opcional ? 1400 : 4500)) {
        if (paso.opcional) { const n = k + sentido.current; if (n < 0) ir(k + 1); else ir(n); } else { setEstado('perdido'); sonar('error'); }
        return;
      }
      t = window.setTimeout(intento, 110);
    };
    intento();
    return () => window.clearTimeout(t);
  }, [paso, estado, loc.pathname, loc.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sigue al elemento mientras se desplaza la página, cambia el tamaño o se anima un formulario.
  useEffect(() => {
    if (!el) return;
    let raf = 0;
    const seguir = () => {
      if (!el.isConnected) { setEl(null); setEstado('buscando'); return; }
      const r = el.getBoundingClientRect();
      const nueva = { x: r.left, y: r.top, w: r.width, h: r.height };
      setCaja((c) => (iguales(c, nueva) ? c : nueva));
      const dialogo = el.closest('dialog');
      const destino = dialogo instanceof HTMLDialogElement && dialogo.open ? dialogo : document.body;
      setCapa((c) => (c === destino ? c : destino));
      setVp((v) => (v.w === window.innerWidth && v.h === window.innerHeight ? v : { w: window.innerWidth, h: window.innerHeight }));
      raf = requestAnimationFrame(seguir);
    };
    raf = requestAnimationFrame(seguir);
    return () => cancelAnimationFrame(raf);
  }, [el]);

  // Si la persona pulsa ella misma el botón que se le señala, la guía avanza sola.
  useEffect(() => {
    if (!el || !paso?.abrir) return;
    const pulsado = () => window.setTimeout(() => ir(k + 1), 60);
    el.addEventListener('click', pulsado);
    return () => el.removeEventListener('click', pulsado);
  }, [el, paso, k, ir]);

  // La capa vive en la capa superior del navegador (popover), también por encima de un formulario modal.
  useLayoutEffect(() => {
    const n = nodo.current as (HTMLDivElement & { showPopover?: () => void }) | null;
    try { n?.showPopover?.(); } catch { /* sin soporte: queda como capa fija con z-index alto */ }
  }, [capa]);

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFin();
      if (e.key === 'ArrowRight' && estado === 'listo' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement)) siguiente();
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  });

  useLayoutEffect(() => {
    const n = globo.current;
    if (!n) return;
    const ro = new ResizeObserver(() => setAltoGlobo(n.offsetHeight));
    ro.observe(n);
    return () => ro.disconnect();
  }, [capa]);

  const siguiente = () => {
    if (paso?.abrir && el) { el.click(); return; } // el oyente de clic avanza
    ir(k + 1);
  };

  // Modo automático: la IA lee cada paso en voz alta (si el sonido está activo) y pasa sola al siguiente,
  // con calma. «Pausar» la deja quieta en el paso; el último paso espera a la persona.
  const [auto, setAuto] = useState(true);
  const [tiempo, setTiempo] = useState(0);
  const avanzar = useRef(siguiente);
  avanzar.current = siguiente;
  useEffect(() => {
    if (estado !== 'listo' || !paso || !auto) return;
    let vivo = true;
    let t = 0;
    const lectura = Math.max(3200, paso.texto.length * 52 + 900);
    const seguir = () => { if (vivo && k < g.pasos.length - 1) t = window.setTimeout(() => vivo && avanzar.current(), reducido ? 400 : 700); };
    setTiempo(0);
    hablar(`${paso.titulo}. ${paso.texto}`).then((r) => {
      if (!vivo) return;
      if (r === 'ok') { seguir(); return; }
      if (r === 'cancelado') return;
      // Sin voz: se da tiempo de leer (la barra del botón lo muestra).
      setTiempo(lectura);
      t = window.setTimeout(() => { if (vivo && k < g.pasos.length - 1) avanzar.current(); }, lectura);
    });
    return () => { vivo = false; window.clearTimeout(t); callar(); };
  }, [estado, k, auto]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => callar(), []);

  // ---------------------------------------------------------------- posiciones
  const movil = vp.w < 640;
  const anchoGlobo = Math.min(340, vp.w - 24);
  let orbe = ultima.current.orbe;
  let pos = ultima.current.globo;
  if (caja && estado === 'listo') {
    const cabe = (x: number, y: number, w: number, h: number) => x >= 8 && y >= 8 && x + w <= vp.w - 8 && y + h <= vp.h - 8;
    const grande = caja.w > vp.w * 0.6;
    const opciones: [number, number][] = grande
      ? [[caja.x + caja.w - ORBE - 6, caja.y - ORBE / 2], [caja.x + caja.w / 2 - ORBE / 2, caja.y + caja.h + 10]]
      : [[caja.x + caja.w + 12, caja.y + caja.h / 2 - ORBE / 2], [caja.x - ORBE - 12, caja.y + caja.h / 2 - ORBE / 2], [caja.x + caja.w / 2 - ORBE / 2, caja.y + caja.h + 12], [caja.x + caja.w / 2 - ORBE / 2, caja.y - ORBE - 12]];
    const o = opciones.find(([x, y]) => cabe(x, y, ORBE, ORBE)) ?? opciones[0];
    orbe = { x: Math.max(8, Math.min(vp.w - ORBE - 8, o[0])), y: Math.max(8, Math.min(vp.h - ORBE - 8, o[1])) };
    const choca = (x: number, y: number) => x < caja.x + caja.w + 6 && x + anchoGlobo > caja.x - 6 && y < caja.y + caja.h + 6 && y + altoGlobo > caja.y - 6;
    if (movil) {
      const abajo = vp.h - altoGlobo - (document.querySelector('.tabbar') ? 84 : 16);
      pos = { x: 12, y: choca(12, abajo) ? Math.max(12, Math.min(caja.y - altoGlobo - 16, 64)) : abajo };
    } else {
      const candidatos: [number, number][] = [
        [orbe.x + ORBE + 12, orbe.y - 8], [orbe.x - anchoGlobo - 12, orbe.y - 8],
        [caja.x, caja.y + caja.h + 14], [caja.x, caja.y - altoGlobo - 14], [vp.w - anchoGlobo - 20, vp.h - altoGlobo - 20],
      ];
      const ajusta = ([x, y]: [number, number]) => [Math.max(12, Math.min(vp.w - anchoGlobo - 12, x)), Math.max(12, Math.min(vp.h - altoGlobo - 12, y))] as [number, number];
      const c = candidatos.map(ajusta).find(([x, y]) => !choca(x, y)) ?? ajusta(candidatos[candidatos.length - 1]);
      pos = { x: c[0], y: c[1] };
    }
    ultima.current = { orbe, globo: pos };
  }

  const ultimo = k === g.pasos.length - 1;
  const resorte = reducido ? { duration: 0 } : { type: 'spring' as const, stiffness: 140, damping: 20, mass: 0.9 };
  return createPortal(
    <div ref={nodo} popover="manual" className={`guia-capa ${capa !== document.body ? 'en-dialogo' : ''}`}>
      <AnimatePresence>
        {caja && estado === 'listo' && (
          <motion.div key="foco" className="guia-foco" initial={{ opacity: 0, x: caja.x - 6, y: caja.y - 6, width: caja.w + 12, height: caja.h + 12 }}
            animate={{ opacity: 1, x: caja.x - 6, y: caja.y - 6, width: caja.w + 12, height: caja.h + 12 }} exit={{ opacity: 0 }}
            transition={reducido ? { duration: 0 } : { type: 'spring', stiffness: 220, damping: 26 }} />
        )}
      </AnimatePresence>
      <motion.div className="guia-orbe" initial={ultima.current.orbe} animate={orbe} transition={resorte}>
        <span className="oc-flota"><OrbeCara tamano={ORBE} cara={estado === 'perdido' ? 'confundida' : estado === 'buscando' ? 'pensando' : ultimo ? 'feliz' : 'hablando'} /></span>
      </motion.div>
      <motion.div ref={globo} className="guia-globo" role="dialog" aria-modal="false" aria-label={`Guía: ${g.titulo}`} style={{ width: anchoGlobo }}
        initial={{ ...ultima.current.globo, opacity: 0, scale: 0.96 }} animate={{ ...pos, opacity: 1, scale: 1 }} transition={resorte}>
        <div className="guia-cab">
          <span className="guia-marca"><b className="nombre-ia">Omnegia IA</b> · {g.titulo}</span>
          <span className="guia-n">{Math.min(k + 1, g.pasos.length)} de {g.pasos.length}</span>
          <button type="button" className="guia-cerrar" onClick={onFin} aria-label="Cerrar la guía"><Icon n="x" className="" size={14} /></button>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${k}-${estado}`} className="guia-cuerpo" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: reducido ? 0 : 0.2 }} aria-live="polite">
            {estado === 'perdido' ? (
              <><b>No encuentro «{paso.titulo}» en esta pantalla</b><p>Puede que tu rol no tenga esa opción o que el módulo esté apagado. Quien administra la empresa puede activarlo.</p></>
            ) : estado === 'buscando' ? (
              <><b>{paso.titulo}</b><p className="guia-buscando">Buscando en la pantalla…</p></>
            ) : (
              <><b>{paso.titulo}</b><p><Escribe texto={paso.texto} /></p></>
            )}
          </motion.div>
        </AnimatePresence>
        <div className="guia-pie">
          <span className="guia-puntos" aria-hidden="true">{g.pasos.map((_, i) => <i key={i} className={i === k ? 'on' : i < k ? 'hecho' : ''} />)}</span>
          {k > 0 && estado !== 'buscando' && <button type="button" className="btn peq sutil" onClick={() => ir(k - 1)}>Anterior</button>}
          {!ultimo && estado === 'listo' && (
            <button type="button" className="btn peq sutil guia-auto" onClick={() => { if (auto) callar(); setAuto(!auto); }} aria-pressed={!auto}
              aria-label={auto ? 'Pausar la guía' : 'Seguir solo'} title={auto ? 'Pausar' : 'Seguir solo'}><Icon n={auto ? 'pause' : 'play'} className="" size={13} /></button>
          )}
          {estado === 'perdido'
            ? <button type="button" className="btn peq primario" onClick={onFin}>Cerrar guía</button>
            : <button type="button" key={`${k}-${tiempo}-${auto}`} className={`btn peq primario guia-sig ${auto && tiempo && !ultimo ? 'contando' : ''}`} style={{ '--dura': `${tiempo}ms` } as CSSProperties}
                disabled={estado !== 'listo'} onClick={siguiente}>{ultimo ? 'Listo' : paso?.abrir ? 'Ábrelo' : 'Siguiente'}{!ultimo && <Icon n="derecha" className="" size={14} />}</button>}
        </div>
      </motion.div>
    </div>,
    capa,
  );
}

/** Texto que se escribe letra a letra (la versión completa se anuncia de una vez a los lectores de pantalla). */
function Escribe({ texto }: { texto: string }) {
  const reducido = useReducedMotion();
  const [n, setN] = useState(reducido ? texto.length : 0);
  useEffect(() => {
    if (reducido) { setN(texto.length); return; }
    setN(0);
    let raf = 0;
    const t0 = performance.now();
    const paso = (t: number) => { const x = Math.min(texto.length, Math.floor((t - t0) / 14)); setN(x); if (x < texto.length) raf = requestAnimationFrame(paso); };
    raf = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(raf);
  }, [texto, reducido]);
  return <><span aria-hidden="true">{texto.slice(0, n)}<span className="guia-cursor" data-fin={n >= texto.length || undefined} /></span><span className="sr">{texto}</span></>;
}
