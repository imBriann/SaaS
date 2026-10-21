import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { api, ApiError, preguntarEnVivo, tenantSlug } from '../../api';
import { useSesion } from '../Layout';
import { Icon } from '../icons';
import { OrbeCara, useCaraIA, type Cara } from './OrbeCara';
import { useIA } from './contexto';
import { useConstruccion } from '../construccion/Construccion';
import { guiaDe, Respuesta, Trabajando, type Ejecucion, type Item, type Paso } from '../../pages/app/Asistente';

const MAX = 1000;
const claveHilo = () => `omnegia-panel-hilo:${tenantSlug() ?? ''}`;
const leerHilo = () => { try { return sessionStorage.getItem(claveHilo()) ?? undefined; } catch { return undefined; } };
const guardarHilo = (id: string | null) => { try { if (id) sessionStorage.setItem(claveHilo(), id); else sessionStorage.removeItem(claveHilo()); } catch { /* sin almacenamiento: el hilo dura lo que la pestaña */ } };

/** ¿Esta persona puede usar el asistente? (rol y módulo de IA activo). */
export function usePuedeIA() {
  const { s, puede } = useSesion();
  return puede('ai:assist') && s.modulos.includes('ia');
}

/**
 * Pastilla «Preguntar a Omnegia IA», abajo a la derecha. Se esconde mientras la IA construye el
 * panel (ella misma se recoge aquí al terminar), durante una guía y en la pantalla del asistente.
 */
export function PildoraIA() {
  const { panelAbierto, abrirPanel, guia } = useIA();
  const { activa } = useConstruccion();
  const loc = useLocation();
  const puedeIA = usePuedeIA();
  const [cara, setCara] = useState<Cara>('normal');
  if (!puedeIA || loc.pathname.startsWith('/asistente')) return null;
  const oculta = panelAbierto || !!guia || activa;
  return (
    <button type="button" className="pildora-ia" data-oculta={oculta || undefined} data-guia="ia/pildora" onClick={() => abrirPanel()} aria-label="Preguntar a Omnegia IA (Ctrl + K)" tabIndex={oculta ? -1 : 0}
      onPointerEnter={() => setCara('atenta')} onPointerLeave={() => setCara('normal')} onFocus={() => setCara('atenta')} onBlur={() => setCara('normal')}>
      <OrbeCara tamano={30} cara={cara} />
      <span>Preguntar a <b>Omnegia IA</b></span>
    </button>
  );
}

/**
 * Chat lateral con el asistente real: los mismos permisos, recibos, gráficas e informes que la
 * pantalla del asistente, y las guías que mueven a la IA por la pantalla. En el escritorio empuja el
 * contenido (la grilla del inicio se reacomoda); en el teléfono sube como una hoja.
 */
export function PanelIA() {
  const { panelAbierto, cerrarPanel, abrirPanel, pregunta, iniciarGuia } = useIA();
  const { reconstruir } = useConstruccion();
  const { s, puede } = useSesion();
  const puedeIA = usePuedeIA();
  const nav = useNavigate();
  const reducido = useReducedMotion();
  const [hilo, setHilo] = useState<string | undefined>(leerHilo);
  const [mensajes, setMensajes] = useState<Item[]>([]);
  const [cargado, setCargado] = useState(false);
  const [q, setQ] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [pasos, setPasos] = useState<Paso[]>([]);
  const [fase, setFase] = useState('pensando');
  const [movil, setMovil] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const cuerpo = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const atendida = useRef(0);
  const [respuestas, setRespuestas] = useState(0);
  const [fallos, setFallos] = useState(0);
  const [largo, setLargo] = useState(0);
  const cara = useCaraIA({ ocupado, escribiendo: !!q.trim(), respuesta: respuestas, fallo: fallos, largo });

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const cambio = () => setMovil(mq.matches);
    mq.addEventListener('change', cambio);
    return () => mq.removeEventListener('change', cambio);
  }, []);

  // Ctrl/⌘ + K abre o cierra el panel desde cualquier pantalla.
  useEffect(() => {
    if (!puedeIA) return;
    const tecla = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (panelAbierto) cerrarPanel(); else abrirPanel(); }
      if (e.key === 'Escape' && panelAbierto) cerrarPanel();
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [panelAbierto, puedeIA, abrirPanel, cerrarPanel]);

  // La conversación del panel se retoma al volver a abrirlo (vive en el servidor; aquí solo su id).
  useEffect(() => {
    if (!panelAbierto || cargado) return;
    setCargado(true);
    if (!hilo) return;
    api.get<any>(`/api/t/asistente/hilos/${hilo}`).then((h) => setMensajes(h.mensajes)).catch(() => { setHilo(undefined); guardarHilo(null); });
  }, [panelAbierto]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (panelAbierto) window.setTimeout(() => campo.current?.focus(), reducido ? 0 : 320); }, [panelAbierto, reducido]);
  useLayoutEffect(() => { const el = cuerpo.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); }, [mensajes, ocupado, pasos.length]);
  useEffect(() => { const el = campo.current; if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 140)}px`; } }, [q]);

  const preguntar = async (texto: string) => {
    const t = texto.trim();
    if (!t || ocupado) return;
    setQ(''); setOcupado(true); setPasos([]); setFase('pensando');
    setMensajes((m) => [...m.map((x) => ({ ...x, nuevo: false })), { rol: 'user', contenido: t, creado_en: new Date().toISOString() }]);
    try {
      const r = await preguntarEnVivo<any>({ pregunta: t, hilo_id: hilo }, (e) => {
        if (e.tipo === 'herramienta') setPasos((p) => [...p, e]);
        if (e.tipo === 'estado') setFase(e.fase);
      });
      setMensajes((m) => [...m, { rol: 'assistant', contenido: r.texto, ejecuciones: r.ejecuciones, creado_en: new Date().toISOString(), nuevo: true }]);
      setLargo(r.texto?.length ?? 0); setRespuestas((n) => n + 1);
      if (r.hilo_id) { setHilo(r.hilo_id); guardarHilo(r.hilo_id); }
      const g = guiaDe(r.ejecuciones);
      if (g) window.setTimeout(() => iniciarGuia(g), 1100);
    } catch (err) {
      setMensajes((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, fallo: (err as ApiError).message } : x)));
      setFallos((n) => n + 1);
    } finally { setOcupado(false); }
  };

  // Abierto con una pregunta («Preguntar a Omnegia IA sobre esto»): se envía sola, una vez.
  useEffect(() => {
    if (!panelAbierto || !pregunta || pregunta.n === atendida.current) return;
    atendida.current = pregunta.n;
    void preguntar(pregunta.texto);
  }, [panelAbierto, pregunta]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!puedeIA) return null;
  const nombre = s.usuario.nombre.split(' ')[0];
  const vacio = mensajes.length === 0 && !ocupado;
  const sugerencias = [
    { texto: '¿Cuánto vendimos esta semana?', icono: 'ventas', permiso: 'order:read', modulo: 'ventas' },
    { texto: '¿Qué citas hay hoy?', icono: 'agenda', permiso: 'appointment:read', modulo: 'agenda' },
    { texto: '¿Cómo registro una venta?', icono: 'ia', permiso: 'order:create', modulo: 'ventas' },
    { texto: 'Gráfica de las ventas de los últimos 7 días', icono: 'grafica', permiso: 'order:read', modulo: 'ventas' },
    { texto: '¿Cómo agendo una cita?', icono: 'ia', permiso: 'appointment:create', modulo: 'agenda' },
    { texto: '¿Qué productos están bajo mínimo?', icono: 'inventario', permiso: 'inventory:read', modulo: 'inventario' },
    { texto: 'Hazme un informe de ventas del mes', icono: 'documento', permiso: 'order:read', modulo: 'ventas' },
    { texto: 'Muéstrame un recorrido por el panel', icono: 'ia', permiso: 'ai:assist', modulo: 'ia' },
  ].filter((p) => puede(p.permiso) && s.modulos.includes(p.modulo)).slice(0, 6);
  const nueva = () => { setMensajes([]); setHilo(undefined); guardarHilo(null); campo.current?.focus(); };
  const enviar = (e?: FormEvent) => { e?.preventDefault(); void preguntar(q); };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(); } };
  const alResolver = (texto: string, recibo: Ejecucion) => setMensajes((m) => [...m.map((x) => ({ ...x, nuevo: false })), { rol: 'assistant', contenido: texto, ejecuciones: [recibo], creado_en: new Date().toISOString(), nuevo: true }]);
  const entrada = movil ? { y: '100%' } : { x: '100%' };

  return (
    <AnimatePresence>
      {panelAbierto && (
        <motion.aside key="panel" className="panel-ia" aria-label="Omnegia IA" role="complementary"
          initial={reducido ? { opacity: 0 } : { ...entrada, opacity: 0.6 }} animate={{ x: 0, y: 0, opacity: 1 }} exit={reducido ? { opacity: 0 } : { ...entrada, opacity: 0.6 }}
          transition={reducido ? { duration: 0.12 } : { type: 'spring', stiffness: 320, damping: 34 }}>
          <header className="pia-cab">
            <OrbeCara tamano={34} cara={cara} />
            <span className="pia-cab-txt"><b>Omnegia IA</b><span><i className={`ai-status-dot ${ocupado ? 'active' : 'live'}`} />{ocupado ? 'Trabajando en tu respuesta' : `Conectada a los datos de ${s.tenant.nombre}`}</span></span>
            <span className="pia-cab-acciones">
              {mensajes.length > 0 && <button type="button" className="pia-icono" onClick={nueva} aria-label="Nueva conversación" title="Nueva conversación"><Icon n="mas" className="" size={16} /></button>}
              <button type="button" className="pia-icono" onClick={() => { cerrarPanel(); window.setTimeout(reconstruir, reducido ? 0 : 280); }} aria-label="Ver cómo la IA arma tu inicio" title="Reconstruir el inicio (Alt + Shift + R)"><Icon n="refrescar" className="" size={16} /></button>
              <button type="button" className="pia-icono" onClick={() => { cerrarPanel(); nav(hilo ? `/asistente/${hilo}` : '/asistente'); }} aria-label="Abrir en pantalla completa" title="Pantalla completa"><Icon n="externo" className="" size={16} /></button>
              <button type="button" className="pia-icono" onClick={cerrarPanel} aria-label="Cerrar Omnegia IA" title="Cerrar (Esc)"><Icon n="x" className="" size={16} /></button>
            </span>
          </header>

          <div className="pia-cuerpo" ref={cuerpo} aria-live="polite" aria-busy={ocupado}>
            {vacio ? (
              <div className="pia-hola">
                <motion.span className="pia-hola-orbe" initial={reducido ? false : { scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 16, delay: 0.1 }}>
                  <OrbeCara tamano={88} cara={cara} mirada={q.trim() ? { x: 0, y: 0.9 } : undefined} />
                </motion.span>
                <h2>Hola {nombre}, soy <span className="nombre-ia">Omnegia IA</span></h2>
                <p>Pregúntame por tus ventas, citas o clientes: lo consulto en el momento con tus permisos. Si quieres saber cómo se hace algo, te lo muestro en la pantalla, paso a paso.</p>
                {sugerencias.length > 0 && (
                  <div className="pia-chips">
                    {sugerencias.map((p, i) => (
                      <motion.button key={p.texto} type="button" className="pia-chip" onClick={() => void preguntar(p.texto)}
                        initial={reducido ? false : { opacity: 0, y: 10, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} transition={{ duration: 0.4, delay: 0.18 + i * 0.06 }}>
                        <span className="pia-chip-ico"><Icon n={p.icono} className="" size={15} /></span>{p.texto}
                      </motion.button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="pia-hilo">
                {mensajes.map((m, i) => m.rol === 'user' ? (
                  <div key={m.id ?? `u${i}`} className={`as-msg yo ${m.fallo ? 'con-fallo' : ''}`}>
                    <div className="as-burbuja"><p className="as-texto">{m.contenido}</p></div>
                    {m.fallo && <div className="as-fallo" role="alert"><Icon n="alerta" className="" size={14} /><span>No se pudo responder: {m.fallo}</span></div>}
                  </div>
                ) : <Respuesta key={m.id ?? `a${i}`} m={m} onAccion={alResolver} />)}
                {ocupado && <Trabajando pasos={pasos} fase={fase} />}
              </div>
            )}
          </div>

          <form className="pia-composer" onSubmit={enviar}>
            <div className="as-caja">
              <textarea ref={campo} rows={1} value={q} onChange={(e) => setQ(e.target.value.slice(0, MAX))} onKeyDown={teclas} maxLength={MAX} placeholder="Pregunta por ventas, citas, clientes… o «¿cómo hago…?»" aria-label="Pregunta a Omnegia IA" />
              <button type="submit" className="composer-send" disabled={ocupado || !q.trim()} aria-label={ocupado ? 'Trabajando en la respuesta' : 'Preguntar'}>
                {ocupado ? <OrbeCara tamano={22} cara="pensando" /> : <Icon n="enviar" size={18} className="" />}
              </button>
            </div>
            <span className="pia-pie"><Icon n="candado" className="" size={12} />Consulta tus datos con tus permisos y deja recibo de cada consulta.</span>
          </form>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
