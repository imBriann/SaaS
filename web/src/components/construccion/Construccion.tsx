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
interface Estado {
  fase: Fase; activa: boolean; ciclo: number; reconstruir: () => void; avisarListo: (ciclo: number) => void;
  /** Durante «esqueleto» la IA arma tarjeta por tarjeta: cuáles ya nacieron y cuáles ya muestran su contenido. */
  nacida: (i: number) => boolean; revelada: (i: number) => boolean;
}
const Ctx = createContext<Estado>({ fase: 'listo', activa: false, ciclo: 0, reconstruir: () => {}, avisarListo: () => {}, nacida: () => true, revelada: () => true });
export const useConstruccion = () => useContext(Ctx);

/** La pantalla que se construye avisa cuando sus datos reales ya están (o cuando falló la carga). */
export function useListoParaConstruir(listo: boolean) {
  const { ciclo, avisarListo } = useConstruccion();
  useEffect(() => { if (listo) avisarListo(ciclo); }, [listo, ciclo, avisarListo]);
}

/** Sin afán: la IA entra y saluda, recorre el menú y luego arma cada tarjeta a la vista. */
const MIN_SHELL = 1500;
const DURA_REVELADO = 1100;
/** Si algo falla, la obra nunca se queda a medias. */
const TOPE_OBRA = 30000;

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
  const [nacidas, setNacidas] = useState<ReadonlySet<number>>(new Set());
  const [reveladas, setReveladas] = useState<ReadonlySet<number>>(new Set());
  const nacer = useCallback((i: number) => setNacidas((x) => new Set(x).add(i)), []);
  const revelar = useCallback((i: number) => setReveladas((x) => new Set(x).add(i)), []);
  const terminarObra = useCallback(() => setFase((f) => (f === 'esqueleto' ? 'revelado' : f)), []);

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
    if (fase === 'esqueleto') t = window.setTimeout(() => setFase('revelado'), TOPE_OBRA);
    if (fase === 'revelado') t = window.setTimeout(() => setFase('listo'), DURA_REVELADO);
    return () => window.clearTimeout(t);
  }, [fase, activa, listoCiclo, ciclo]);

  const reconstruir = useCallback(() => {
    if (loc.pathname !== '/') { ruta.current = '/'; nav('/'); }
    inicio.current = performance.now();
    setNacidas(new Set()); setReveladas(new Set());
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

  // En el esqueleto cada tarjeta espera su turno; en las demás fases todo se ve completo.
  const nacida = useCallback((i: number) => !activa || fase === 'revelado' || (fase === 'esqueleto' && nacidas.has(i)), [activa, fase, nacidas]);
  const revelada = useCallback((i: number) => !activa || fase === 'revelado' || (fase === 'esqueleto' && reveladas.has(i)), [activa, fase, reveladas]);
  const valor = useMemo(() => ({ fase, activa, ciclo, reconstruir, avisarListo, nacida, revelada }), [fase, activa, ciclo, reconstruir, avisarListo, nacida, revelada]);
  return (
    <Ctx.Provider value={valor}>
      <div className={`construccion ${activa ? 'construyendo' : ''}`} data-fase={fase} aria-busy={activa || undefined}>
        {children}
      </div>
      <AnimatePresence>{(activa || cierre) && <OrbeConstructor key={ciclo} nombre={nombre} fase={fase} cierre={cierre} onFin={() => setCierre(false)}
        nacer={nacer} revelar={revelar} terminar={terminarObra} saltar={() => { setFase('listo'); setCierre(false); }} />}</AnimatePresence>
    </Ctx.Provider>
  );
}

// ---------------------------------------------------------------- la IA que construye
const ORBE = 56;
const espera = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const nombreDe = (el: HTMLElement) => (el.getAttribute('aria-label') || el.querySelector('.nav-txt')?.textContent
  || el.querySelector('h1, h2, h3, h4, .tv-cab b, .tv-titulo, .tv-etq')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 42);

/**
 * La IA durante la construcción. Entra flotando y saluda; luego, con calma, recorre el menú (cada módulo
 * aparece cuando ella pasa a su lado y dice su nombre) y después arma las tarjetas del inicio una por una:
 * se posa sobre la tarjeta, la tarjeta nace vacía, se llena con los datos reales y ella pasa a la siguiente.
 * Al final se presenta y se recoge en su pastilla. «Saltar» termina todo de inmediato.
 */
function OrbeConstructor({ nombre, fase, cierre, onFin, nacer, revelar, terminar, saltar }: {
  nombre: string; fase: Fase; cierre: boolean; onFin: () => void;
  nacer: (i: number) => void; revelar: (i: number) => void; terminar: () => void; saltar: () => void;
}) {
  const { iniciarGuia } = useIA();
  const reducido = useReducedMotion();
  const [pos, setPos] = useState(() => ({ x: window.innerWidth / 2 - ORBE / 2, y: window.innerHeight + 40, escala: 1 }));
  const [cara, setCara] = useState<Cara>('normal');
  const [globo, setGlobo] = useState<string | null>(null);
  const [recogiendo, setRecogiendo] = useState(false);
  const estrecha = window.innerWidth < 640;

  const centro = () => {
    const marco = document.querySelector('.marco')?.getBoundingClientRect();
    const x = marco ? marco.left + marco.width / 2 : window.innerWidth / 2;
    return { x: x - ORBE / 2, y: Math.min(window.innerHeight * 0.36, 300), escala: 1 };
  };

  // Entrada: sube desde abajo hasta el centro y saluda mientras llegan los datos.
  useEffect(() => {
    if (fase !== 'shell') return;
    setCara('feliz'); setGlobo(`Hola, voy a armar el espacio de ${nombre}`);
    const t = window.setTimeout(() => setPos(centro()), 60);
    return () => window.clearTimeout(t);
  }, [fase]); // eslint-disable-line react-hooks/exhaustive-deps

  // La obra, paso a paso. Cada espera es para que se vea: nada aparece sin que la IA esté ahí.
  useEffect(() => {
    if (fase !== 'esqueleto') return;
    let vivo = true;
    const lento = (ms: number) => espera(reducido ? 0 : ms);
    (async () => {
      // 1) Los módulos del menú (en el teléfono el menú es la barra inferior: aparece al final).
      const menu = estrecha ? [] : [...document.querySelectorAll<HTMLElement>('.lateral .nav-titulo, .lateral .nav-item')];
      if (menu.length) {
        setCara('hablando'); setGlobo('Primero, tus módulos');
        await lento(700);
      }
      for (const el of menu) {
        if (!vivo) return;
        const r = el.getBoundingClientRect();
        setPos({ x: r.right + 14, y: r.top + r.height / 2 - ORBE / 2, escala: 0.72 });
        await lento(el.matches('.nav-item') ? 150 : 60);
        el.classList.add('obra-ok');
        if (el.matches('.nav-item')) { setGlobo(nombreDe(el)); sonar('tick'); }
        await lento(el.matches('.nav-item') ? 190 : 60);
      }
      // 2) Las tarjetas del inicio, en su orden de aparición. La página baja con la IA para que se vea cada una
      // (hasta 8; el resto aparece al final) y vuelve arriba cuando termina.
      const tarjetas = [...document.querySelectorAll<HTMLElement>('[data-construible]')]
        .sort((a, b) => Number(a.dataset.construible) - Number(b.dataset.construible))
        .slice(0, 8);
      if (vivo && tarjetas.length) { setCara('hablando'); setGlobo('Ahora, tu inicio con tus datos reales'); setPos(centro()); await lento(900); }
      for (const el of tarjetas) {
        if (!vivo) return;
        const i = Number(el.dataset.construible);
        let r = el.getBoundingClientRect();
        if (r.bottom > window.innerHeight - 30 || r.top < 70) {
          el.scrollIntoView({ behavior: reducido ? 'auto' : 'smooth', block: 'center' });
          await lento(520);
          r = el.getBoundingClientRect();
        }
        setCara('pensando');
        setPos({ x: Math.max(8, Math.min(window.innerWidth - ORBE - 8, r.left + Math.min(r.width - ORBE, 28))), y: Math.max(8, Math.min(window.innerHeight - 160, r.top - ORBE / 2)), escala: 0.85 });
        setGlobo(nombreDe(el) || 'Una tarjeta más');
        await lento(460);
        nacer(i); sonar('pop');
        el.classList.add('obra-destello');
        await lento(480);
        revelar(i); setCara('hablando');
        await lento(560);
        el.classList.remove('obra-destello');
      }
      if (!vivo) return;
      setGlobo('¡Listo!');
      window.scrollTo({ top: 0, behavior: reducido ? 'auto' : 'smooth' });
      await lento(600);
      terminar();
    })();
    return () => { vivo = false; };
  }, [fase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fase === 'revelado') { setCara('feliz'); setGlobo('Poniendo los últimos detalles'); setPos(centro()); }
    if (fase === 'listo') {
      document.querySelectorAll('.obra-ok, .obra-destello').forEach((el) => el.classList.remove('obra-ok', 'obra-destello'));
      setGlobo(null);
      if (cierre) { setCara('feliz'); setPos(centro()); const t = window.setTimeout(() => setCara('normal'), 1400); return () => window.clearTimeout(t); }
    }
  }, [fase, cierre]); // eslint-disable-line react-hooks/exhaustive-deps

  // Termina recogiéndose en la pastilla de la esquina (que la reemplaza).
  const recoger = useCallback(() => {
    if (recogiendo) return;
    setRecogiendo(true);
    const destino = document.querySelector('.pildora-ia .orbe-cara')?.getBoundingClientRect();
    if (destino) setPos({ x: destino.left + destino.width / 2 - ORBE / 2, y: destino.top + destino.height / 2 - ORBE / 2, escala: destino.width / ORBE });
    window.setTimeout(onFin, reducido ? 0 : 620);
  }, [recogiendo, onFin, reducido]);
  useEffect(() => {
    if (fase !== 'listo' || !cierre) return;
    const t = window.setTimeout(recoger, 12000);
    return () => window.clearTimeout(t);
  }, [fase, cierre, recoger]);

  const lado = pos.x > window.innerWidth - 300 ? 'izquierda' : pos.x < 240 ? 'derecha' : 'arriba';
  const presentandose = fase === 'listo' && cierre && !recogiendo;
  const enObra = fase !== 'listo';
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
        transition={reducido ? { duration: 0 } : recogiendo ? { type: 'spring', stiffness: 170, damping: 24 } : { type: 'spring', stiffness: 70, damping: 15, mass: 1 }}>
        <span className="oc-estela" aria-hidden="true" />
        <span className="oc-flota"><OrbeCara tamano={ORBE} cara={cara} etiqueta={presentandose ? 'Omnegia IA' : undefined} /></span>
        <AnimatePresence mode="wait">
          {enObra && globo && !recogiendo && (
            <motion.span key={globo} className={`globo-ia mini lado-${lado}`} initial={{ opacity: 0, y: 6, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4, scale: 0.96 }} transition={{ duration: 0.25 }}>
              {globo}
            </motion.span>
          )}
          {presentandose && !estrecha && presentacion}
        </AnimatePresence>
      </motion.div>
      <AnimatePresence>{presentandose && estrecha && presentacion}</AnimatePresence>
      {enObra && <button type="button" className="obra-saltar" onClick={saltar} data-sin-tap>Saltar</button>}
    </motion.div>
  );
}
