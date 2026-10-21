import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { OrbeCara, type Cara } from '../ia/OrbeCara';
import { useIA } from '../ia/contexto';
import { sonar } from '../../lib/sonido';

/**
 * Construcción en vivo del espacio de una empresa (al estrenarlo después del pago, o al pedir «Reconstruir»).
 * No es una pantalla de carga aparte: el panel real se ensambla delante de la persona.
 *   shell     → el marco vacío: menú sin accesos, el título entra desenfocado y llega la IA.
 *                Dura lo que tarden los datos reales en llegar (con un mínimo para que se vea).
 *   esqueleto → cada tarjeta aparece vacía, con su tamaño final, en cascada; la IA las recorre.
 *   revelado  → el contenido real aparece dentro de cada tarjeta, las cifras cuentan y las gráficas se dibujan.
 *   listo     → todo quieto; la IA se presenta y luego se recoge en la pastilla «Preguntar a Omnegia IA».
 * Lo que se ve son datos ya cargados del servidor: las fases son presentación, nunca progreso inventado.
 */
export type Fase = 'shell' | 'esqueleto' | 'revelado' | 'listo';
interface Estado { fase: Fase; activa: boolean; ciclo: number; reconstruir: () => void; avisarListo: (ciclo: number) => void }
const Ctx = createContext<Estado>({ fase: 'listo', activa: false, ciclo: 0, reconstruir: () => {}, avisarListo: () => {} });
export const useConstruccion = () => useContext(Ctx);

/** La pantalla que se construye avisa cuando sus datos reales ya están (o cuando falló la carga). */
export function useListoParaConstruir(listo: boolean) {
  const { ciclo, avisarListo } = useConstruccion();
  useEffect(() => { if (listo) avisarListo(ciclo); }, [listo, ciclo, avisarListo]);
}

const MIN_SHELL = 520;
const DURA_ESQUELETO = 820;
const DURA_REVELADO = 1150;

export function Construccion({ nombre, children }: { nombre: string; children: ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  const reducido = useReducedMotion();
  const estreno = useRef(new URLSearchParams(loc.search).get('estreno') === '1');
  const [ciclo, setCiclo] = useState(estreno.current ? 1 : 0);
  const [fase, setFase] = useState<Fase>(estreno.current && !reducido ? 'shell' : 'listo');
  const [listoCiclo, setListoCiclo] = useState(0);
  const [cierre, setCierre] = useState(estreno.current);
  const inicio = useRef(performance.now());
  const ruta = useRef(loc.pathname);
  const activa = fase !== 'listo';

  // La marca ?estreno=1 solo enciende la presentación: se quita de la dirección sin recargar.
  useEffect(() => {
    const q = new URLSearchParams(loc.search);
    if (!q.has('estreno')) return;
    q.delete('estreno');
    nav({ pathname: loc.pathname, search: q.toString() ? `?${q}` : '', hash: loc.hash }, { replace: true });
  }, [loc.search]); // eslint-disable-line react-hooks/exhaustive-deps

  // Si la persona se va a otra pantalla en medio de la construcción, se termina sin hacerla esperar.
  useEffect(() => {
    if (loc.pathname === ruta.current) return;
    ruta.current = loc.pathname;
    if (activa) { setFase('listo'); setCierre(false); }
  }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  const avisarListo = useCallback((c: number) => setListoCiclo((x) => Math.max(x, c)), []);

  // La construcción en vivo tiene su sonido: arranca, se arma y queda lista.
  useEffect(() => {
    if (fase === 'esqueleto') sonar('construir');
    if (fase === 'revelado') sonar('magia');
  }, [fase]);

  useEffect(() => {
    if (!activa) return;
    let t: number | undefined;
    if (fase === 'shell') {
      if (listoCiclo >= ciclo) t = window.setTimeout(() => setFase('esqueleto'), Math.max(0, MIN_SHELL - (performance.now() - inicio.current)));
      else t = window.setTimeout(() => setFase('esqueleto'), 7000); // los datos no llegan: no se queda vacío para siempre
    }
    if (fase === 'esqueleto') t = window.setTimeout(() => setFase('revelado'), DURA_ESQUELETO);
    if (fase === 'revelado') t = window.setTimeout(() => setFase('listo'), DURA_REVELADO);
    return () => window.clearTimeout(t);
  }, [fase, activa, listoCiclo, ciclo]);

  const reconstruir = useCallback(() => {
    if (loc.pathname !== '/') { ruta.current = '/'; nav('/'); }
    inicio.current = performance.now();
    setCiclo((c) => c + 1);
    setCierre(true);
    setFase(reducido ? 'listo' : 'shell');
  }, [loc.pathname, nav, reducido]);

  // Atajo para demostraciones: Alt + Shift + R reconstruye el inicio.
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.altKey && e.shiftKey && e.code === 'KeyR') { e.preventDefault(); reconstruir(); } };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [reconstruir]);

  const valor = useMemo(() => ({ fase, activa, ciclo, reconstruir, avisarListo }), [fase, activa, ciclo, reconstruir, avisarListo]);
  return (
    <Ctx.Provider value={valor}>
      <div className={`construccion ${activa ? 'construyendo' : ''}`} data-fase={fase} aria-busy={activa || undefined}>
        {children}
      </div>
      <AnimatePresence>{(activa || cierre) && <OrbeConstructor key={ciclo} nombre={nombre} fase={fase} cierre={cierre} onFin={() => setCierre(false)} />}</AnimatePresence>
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------- la IA que construye
const TEXTO: Record<Fase, string> = {
  shell: 'Abriendo tu espacio…', esqueleto: 'Armando tu panel', revelado: 'Poniendo tus cifras reales', listo: '',
};

/** La IA durante la construcción: entra flotando, recorre las tarjetas que nacen, se presenta y se recoge en su pastilla. */
function OrbeConstructor({ nombre, fase, cierre, onFin }: { nombre: string; fase: Fase; cierre: boolean; onFin: () => void }) {
  const { iniciarGuia } = useIA();
  const reducido = useReducedMotion();
  const [pos, setPos] = useState(() => ({ x: window.innerWidth / 2 - 28, y: window.innerHeight + 40, escala: 1 }));
  const [cara, setCara] = useState<Cara>('normal');
  const [recogiendo, setRecogiendo] = useState(false);
  const paso = useRef(0);

  // Sobre qué tarjeta está la IA mientras se construye (en orden de aparición).
  useEffect(() => {
    const centro = () => {
      const marco = document.querySelector('.marco')?.getBoundingClientRect();
      const x = marco ? marco.left + marco.width / 2 : window.innerWidth / 2;
      return { x: x - 28, y: Math.min(window.innerHeight * 0.38, 320), escala: 1 };
    };
    if (fase === 'shell') { setCara('atenta'); const t = window.setTimeout(() => setPos(centro()), 60); return () => window.clearTimeout(t); }
    if (fase === 'esqueleto' || fase === 'revelado') {
      setCara(fase === 'revelado' ? 'hablando' : 'pensando');
      const tarjetas = [...document.querySelectorAll<HTMLElement>('[data-construible]')]
        .sort((a, b) => Number(a.dataset.construible) - Number(b.dataset.construible))
        .filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < window.innerHeight; });
      if (!tarjetas.length) { setPos(centro()); return; }
      const ir = () => {
        const el = tarjetas[paso.current % tarjetas.length];
        paso.current++;
        const r = el.getBoundingClientRect();
        // Ubicaciones cercanas pero no idénticas en cada tarjeta, como si la fuera dibujando.
        const x = r.left + r.width * (0.35 + Math.random() * 0.4) - 28;
        const y = r.top + Math.min(r.height, 220) * (0.3 + Math.random() * 0.35) - 28;
        setPos({ x: Math.max(8, Math.min(window.innerWidth - 64, x)), y: Math.max(8, Math.min(window.innerHeight - 140, y)), escala: 1 });
      };
      ir();
      const t = window.setInterval(ir, fase === 'esqueleto' ? 240 : 300);
      return () => window.clearInterval(t);
    }
    if (fase === 'listo' && cierre) {
      setCara('feliz');
      const t = window.setTimeout(() => setCara('normal'), 1400);
      setPos(centro());
      return () => window.clearTimeout(t);
    }
  }, [fase, cierre]);

  // Termina recogiéndose en la pastilla de la esquina (que la reemplaza).
  const recoger = useCallback(() => {
    if (recogiendo) return;
    setRecogiendo(true);
    const destino = document.querySelector('.pildora-ia .orbe-cara')?.getBoundingClientRect();
    if (destino) setPos({ x: destino.left + destino.width / 2 - 28, y: destino.top + destino.height / 2 - 28, escala: destino.width / 56 });
    window.setTimeout(onFin, reducido ? 0 : 620);
  }, [recogiendo, onFin, reducido]);
  useEffect(() => {
    if (fase !== 'listo' || !cierre) return;
    const t = window.setTimeout(recoger, 9000);
    return () => window.clearTimeout(t);
  }, [fase, cierre, recoger]);

  const estrecha = window.innerWidth < 640;
  const lado = pos.x > window.innerWidth - 300 ? 'izquierda' : pos.x < 240 ? 'derecha' : 'arriba';
  const presentandose = fase === 'listo' && cierre && !recogiendo;
  const texto = presentandose ? null : TEXTO[fase];
  const presentacion = (
    <motion.div key="hola" className={`globo-ia presentacion ${estrecha ? 'hoja' : `lado-${lado}`}`} initial={{ opacity: 0, y: 8, scale: 0.92 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ type: 'spring', stiffness: 260, damping: 22 }}>
      <span>Soy <b className="nombre-ia">Omnegia IA</b>. Armé el panel de {nombre} con tus datos reales.</span>
      <span className="globo-acciones">
        <button type="button" className="btn peq primario" onClick={() => { recoger(); window.setTimeout(() => iniciarGuia('recorrido_panel'), reducido ? 0 : 640); }}>Muéstrame el panel</button>
        <button type="button" className="btn peq sutil" onClick={recoger}>Entendido</button>
      </span>
    </motion.div>
  );
  return (
    <motion.div className="orbe-constructor" role="status" aria-live="polite"
      initial={{ opacity: 0 }} animate={{ opacity: recogiendo ? 0.001 : 1 }} exit={{ opacity: 0, transition: { duration: 0.2 } }}>
      <motion.div className="oc-volador" initial={false}
        animate={{ x: pos.x, y: pos.y, scale: pos.escala }}
        transition={reducido ? { duration: 0 } : recogiendo ? { type: 'spring', stiffness: 170, damping: 24 } : { type: 'spring', stiffness: 120, damping: 17, mass: 0.9 }}>
        <span className="oc-flota"><OrbeCara tamano={56} cara={cara} etiqueta={presentandose ? 'Omnegia IA' : undefined} /></span>
        <AnimatePresence mode="wait">
          {texto && !recogiendo && (
            <motion.span key={texto} className={`globo-ia mini lado-${lado}`} initial={{ opacity: 0, y: 6, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.96 }} transition={{ duration: 0.22 }}>
              {texto}
            </motion.span>
          )}
          {presentandose && !estrecha && presentacion}
        </AnimatePresence>
      </motion.div>
      <AnimatePresence>{presentandose && estrecha && presentacion}</AnimatePresence>
    </motion.div>
  );
}
