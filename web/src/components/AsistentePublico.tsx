import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { api, ApiError } from '../api';
import { Icon } from './icons';
import { Markdown } from './Markdown';
import { OrbeCara, useCaraIA, type Cara } from './ia/OrbeCara';
import '../asistente-publico.css';
import { sonar, useSonido } from '../lib/sonido';
import { callar, hablar, vozDisponible } from '../lib/voz';
import { SonidoBoton } from './SonidoBoton';

/**
 * Omnegia IA en el sitio público. La primera vez aparece en el centro de la bienvenida con una entrada llamativa,
 * se presenta y dice que estará abajo a la derecha; luego vuela a esa esquina. El chat es real: responde el
 * servidor con la base de conocimiento de Omnegia y, si la persona lo pide, la conecta con un asesor comercial
 * (llega a la bandeja de soporte del equipo). La conversación vive solo en esta pestaña.
 */
type Rol = 'persona' | 'asistente';
interface Msg { id: number; rol: Rol; texto: string; enlaces?: { ruta: string; texto: string }[]; sugerencias?: string[]; siguiente?: string; asesor?: boolean }

const CLAVE_BIENVENIDA = 'omnegia_ia_bienvenida';
const CLAVE_CHAT = 'omnegia_ia_chat';
const INICIALES = ['¿Cuánto cuesta?', '¿Qué plan me conviene?', '¿Cómo empiezo?', 'Hablar con un asesor'];
const PRESENTACION = [
  '¡Hola! Soy **Omnegia IA** ✨',
  'Resuelvo tus dudas sobre planes, funciones y cómo empezar, te ayudo si ya tienes cuenta y, si quieres, te conecto con un asesor comercial.',
  'Estaré aquí abajo a la derecha para cualquier ayuda que necesites.',
];

const leer = (k: string, s: Storage | undefined) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const guardar = (k: string, v: string, s: Storage | undefined) => { try { s?.setItem(k, v); } catch { /* sin almacenamiento */ } };
const almacen = () => (typeof window === 'undefined' ? undefined : window);

export function AsistentePublico() {
  const w = almacen();
  const [fase, setFase] = useState<'oculta' | 'bienvenida' | 'lista'>(() => (leer(CLAVE_BIENVENIDA, w?.localStorage) ? 'lista' : 'oculta'));
  const [abierto, setAbierto] = useState(false);
  // La bienvenida espera a que la página cargue y se ve una sola vez por navegador.
  useEffect(() => {
    if (fase !== 'oculta') return;
    const t = window.setTimeout(() => setFase('bienvenida'), 900);
    return () => window.clearTimeout(t);
  }, [fase]);
  const terminar = (abrir: boolean) => {
    guardar(CLAVE_BIENVENIDA, '1', w?.localStorage);
    setFase('lista');
    if (abrir) window.setTimeout(() => { sonar('abrir'); setAbierto(true); }, 380);
  };
  return createPortal(
    <>
      <AnimatePresence>{fase === 'bienvenida' && <Bienvenida key="bienvenida" onTerminar={terminar} />}</AnimatePresence>
      {fase === 'lista' && <Lanzador abierto={abierto} onAbrir={() => setAbierto((a) => { sonar(a ? 'cerrar' : 'abrir'); return !a; })} />}
      <AnimatePresence>{abierto && <Chat key="chat" onCerrar={() => { sonar('cerrar'); setAbierto(false); }} />}</AnimatePresence>
    </>, document.body,
  );
}

// =================================================================== Bienvenida en el centro
function Bienvenida({ onTerminar }: { onTerminar: (abrir: boolean) => void }) {
  const reducido = useReducedMotion();
  const [paso, setPaso] = useState(0);
  const [saliendo, setSaliendo] = useState(false);
  const [destino, setDestino] = useState({ x: 0, y: 0 });
  const zona = useRef<HTMLDivElement>(null);
  const ultimoPaso = PRESENTACION.length - 1;
  // Voz: se intenta hablar cada frase; si el navegador no lo permite (sin gesto previo) o no hay voz en
  // español, la bienvenida sigue con texto y ofrece «Escúchame».
  const [sonidoOn] = useSonido();
  const [sinVoz, setSinVoz] = useState(() => !vozDisponible() || !sonidoOn);
  const [bloqueada, setBloqueada] = useState(false);
  const [hablando, setHablando] = useState(false);
  const turno = useRef(0);
  const cara: Cara = saliendo ? 'feliz' : hablando ? 'hablando' : paso === 0 ? 'feliz' : paso === ultimoPaso ? 'atenta' : 'hablando';
  // Entrada con brillo y una burbuja por cada frase (el navegador solo deja sonar tras el primer gesto).
  useEffect(() => { sonar('magia'); return () => callar(); }, []);
  useEffect(() => { if (paso > 0) sonar('burbuja'); }, [paso]);
  useEffect(() => { if (!sonidoOn) { callar(); setHablando(false); setSinVoz(true); } }, [sonidoOn]);

  const salir = (abrir: boolean) => {
    if (saliendo) return;
    turno.current++; callar(); setHablando(false);
    // Vuela al lugar del lanzador (abajo a la derecha): del centro del orbe al centro del botón.
    const r = zona.current?.getBoundingClientRect();
    const cx = r ? r.left + r.width / 2 : window.innerWidth / 2, cy = r ? r.top + r.height / 2 : window.innerHeight / 2;
    setDestino({ x: window.innerWidth - 44 - cx, y: window.innerHeight - 44 - cy });
    setSaliendo(true);
    sonar('swoosh');
    window.setTimeout(() => onTerminar(abrir), reducido ? 150 : 900);
  };

  useEffect(() => {
    if (saliendo) return;
    let t2 = 0;
    if (!sinVoz) {
      const n = ++turno.current;
      const t = window.setTimeout(() => {
        hablar(PRESENTACION[paso], { alEmpezar: () => { if (n === turno.current) setHablando(true); } }).then((r) => {
          if (n !== turno.current) return;
          setHablando(false);
          if (r === 'ok') t2 = window.setTimeout(() => (paso < ultimoPaso ? setPaso((p) => p + 1) : salir(false)), paso < ultimoPaso ? 420 : 1700);
          else if (r !== 'cancelado') { setBloqueada(r === 'bloqueado'); setSinVoz(true); }
        });
      }, paso === 0 && !reducido ? 900 : 200);
      return () => { window.clearTimeout(t); window.clearTimeout(t2); };
    }
    // Sin voz: las frases avanzan solas y, tras la última, se despide si la persona no hace nada.
    const t = window.setTimeout(() => (paso < ultimoPaso ? setPaso((p) => p + 1) : salir(false)),
      paso < ultimoPaso ? (reducido ? 1400 : 1900 + PRESENTACION[paso].length * 18) : 5200);
    return () => window.clearTimeout(t);
  }, [paso, saliendo, sinVoz]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Con un toque (gesto) el navegador ya deja hablar: retoma la voz desde la frase actual. */
  const escuchar = () => {
    if (!sonidoOn) return;
    setBloqueada(false); setSinVoz(false);
  };
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') salir(false); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const chispas = useMemo(() => Array.from({ length: 26 }, (_, i) => ({ a: (i / 26) * Math.PI * 2 + Math.random() * 0.3, d: 120 + Math.random() * 170, s: 4 + Math.random() * 8, c: ['#8b7bff', '#f28cb1', '#6fd3ff', '#ffd166', '#7ef0c2'][i % 5], r: Math.random() * 360 })), []);

  return (
    <motion.div className="apub-velo" role="dialog" aria-modal="false" aria-label="Bienvenida de Omnegia IA"
      initial={{ opacity: 0 }} animate={{ opacity: saliendo ? 0 : 1 }} exit={{ opacity: 0 }} transition={{ duration: saliendo ? 0.7 : 0.4 }}>
      {!saliendo && <SonidoBoton className="apub-sonido-esquina" size={17} />}
      <div className="apub-escena">
        <motion.div className="apub-orbe-zona" ref={zona}
          initial={reducido ? { opacity: 0 } : { y: 260, scale: 0.2, rotate: -200, opacity: 0 }}
          animate={saliendo
            ? (reducido ? { opacity: 0 } : { x: destino.x, y: destino.y, scale: 0.28, rotate: 20, opacity: 0.9 })
            : { y: 0, scale: 1, rotate: 0, opacity: 1 }}
          transition={saliendo ? { duration: 0.85, ease: [0.65, 0, 0.35, 1] } : { type: 'spring', stiffness: 120, damping: 11, mass: 1.1 }}>
          {!reducido && <>
            <motion.span className="apub-aro a1" animate={{ rotate: 360 }} transition={{ duration: 6, repeat: Infinity, ease: 'linear' }} />
            <motion.span className="apub-aro a2" animate={{ rotate: -360 }} transition={{ duration: 9, repeat: Infinity, ease: 'linear' }} />
            <motion.span className="apub-onda" initial={{ scale: 0.4, opacity: 0.9 }} animate={{ scale: 3.2, opacity: 0 }} transition={{ duration: 1.4, delay: 0.35, ease: 'easeOut' }} />
            <motion.span className="apub-onda" initial={{ scale: 0.4, opacity: 0.7 }} animate={{ scale: 2.4, opacity: 0 }} transition={{ duration: 1.4, delay: 0.6, ease: 'easeOut' }} />
            <span className="apub-rayos" aria-hidden="true" />
            {chispas.map((c, i) => (
              <motion.i key={i} className="apub-chispa" style={{ '--c': c.c, width: c.s, height: c.s } as CSSProperties}
                initial={{ x: 0, y: 0, scale: 0, opacity: 1, rotate: 0 }} animate={{ x: Math.cos(c.a) * c.d, y: Math.sin(c.a) * c.d, scale: [0, 1.4, 0], opacity: [1, 1, 0], rotate: c.r }}
                transition={{ duration: 1.5, delay: 0.3 + (i % 6) * 0.03, ease: 'easeOut' }} />
            ))}
          </>}
          {hablando && !reducido && <span className="apub-voz-ondas" aria-hidden="true"><i /><i /><i /></span>}
          <motion.div className={hablando ? 'apub-habla' : ''} animate={reducido || saliendo ? {} : { y: [0, -10, 0], rotate: [0, -3, 3, 0] }} transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut', delay: 1 }}>
            <OrbeCara tamano={128} cara={cara} etiqueta="Omnegia IA" />
          </motion.div>
        </motion.div>

        <AnimatePresence mode="wait">
          {!saliendo && (
            <motion.div key={paso} className="apub-globo" aria-live="polite"
              initial={reducido ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.92, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              exit={reducido ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.96, filter: 'blur(4px)' }} transition={{ duration: 0.45, delay: paso === 0 && !reducido ? 0.7 : 0 }}>
              <Escrito texto={PRESENTACION[paso]} />
              <div className="apub-globo-pie">
                <div className="apub-puntos" aria-hidden="true">{PRESENTACION.map((_, i) => <i key={i} className={i <= paso ? 'on' : ''} />)}</div>
                {hablando ? <span className="apub-hablando" aria-label="Omnegia IA está hablando"><i /><i /><i /><i /></span>
                  : bloqueada && sonidoOn ? <button type="button" className="apub-escuchame" onClick={escuchar} data-sin-tap><Icon n="volume" className="" size={14} />Escúchame</button> : null}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!saliendo && (
          <motion.div className="apub-acciones" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: reducido ? 0 : 1.1 }}>
            <button type="button" className="apub-btn primario" onClick={() => salir(true)} data-sin-tap><Icon n="ia" className="" size={16} />Preguntar algo ahora</button>
            <button type="button" className="apub-btn" onClick={() => salir(false)} data-sin-tap>Explorar por mi cuenta</button>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}

/** Texto que aparece palabra por palabra (la lectura de pantalla recibe el texto completo). */
function Escrito({ texto }: { texto: string }) {
  const reducido = useReducedMotion();
  const palabras = texto.split(' ');
  const [n, setN] = useState(reducido ? palabras.length : 0);
  useEffect(() => {
    if (reducido) { setN(palabras.length); return; }
    setN(0);
    let i = 0;
    const t = window.setInterval(() => { i += 1; setN(i); if (i >= palabras.length) window.clearInterval(t); }, 55);
    return () => window.clearInterval(t);
  }, [texto]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="apub-escrito"><span className="sr">{texto.replace(/\*\*/g, '')}</span><span aria-hidden="true"><Markdown texto={palabras.slice(0, n).join(' ') || ' '} /></span></div>;
}

// =================================================================== Lanzador abajo a la derecha
function Lanzador({ abierto, onAbrir }: { abierto: boolean; onAbrir: () => void }) {
  const reducido = useReducedMotion();
  return (
    <motion.button type="button" className={`apub-lanzador ${abierto ? 'abierto' : ''}`} onClick={onAbrir} data-sin-tap aria-expanded={abierto} aria-label={abierto ? 'Cerrar el chat de Omnegia IA' : 'Abrir el chat de Omnegia IA'}
      initial={reducido ? { opacity: 0 } : { scale: 0, opacity: 0, rotate: -90 }} animate={{ scale: 1, opacity: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 16 }}
      whileHover={reducido ? undefined : { scale: 1.06 }} whileTap={reducido ? undefined : { scale: 0.94 }}>
      {!abierto && !reducido && <span className="apub-halo" aria-hidden="true" />}
      <OrbeCara tamano={40} cara={abierto ? 'atenta' : 'normal'} />
      <span className="apub-lanzador-txt">{abierto ? 'Cerrar' : <>¿Dudas? <b>Pregúntame</b></>}</span>
    </motion.button>
  );
}

// =================================================================== Chat
function Chat({ onCerrar }: { onCerrar: () => void }) {
  const w = almacen();
  const reducido = useReducedMotion();
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try { const g = JSON.parse(leer(CLAVE_CHAT, w?.sessionStorage) ?? 'null'); if (Array.isArray(g) && g.length) return g; } catch { /* conversación nueva */ }
    return [{ id: 1, rol: 'asistente', texto: '¡Hola! ¿En qué te ayudo? Puedo contarte de los planes, cómo empezar, cómo funciona Omnegia o conectarte con un asesor.', sugerencias: INICIALES }];
  });
  const [texto, setTexto] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [respuestas, setRespuestas] = useState(0);
  const [leyendo, setLeyendo] = useState<number | null>(null);
  const leerEnVoz = (m: Msg) => {
    if (leyendo === m.id) { callar(); setLeyendo(null); return; }
    setLeyendo(m.id);
    hablar(m.texto).then(() => setLeyendo((x) => (x === m.id ? null : x)));
  };
  useEffect(() => () => callar(), []);
  const [fallos, setFallos] = useState(0);
  const lista = useRef<HTMLDivElement>(null);
  const entrada = useRef<HTMLTextAreaElement>(null);
  const ultimo = msgs[msgs.length - 1];
  const caraBase = useCaraIA({ ocupado, escribiendo: texto.trim().length > 0, respuesta: respuestas, fallo: fallos, largo: ultimo?.texto.length ?? 0 });
  const cara: Cara = leyendo !== null ? 'hablando' : caraBase;

  useEffect(() => { guardar(CLAVE_CHAT, JSON.stringify(msgs.slice(-30)), w?.sessionStorage); }, [msgs]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lista.current?.scrollTo({ top: lista.current.scrollHeight, behavior: reducido ? 'auto' : 'smooth' }); }, [msgs, ocupado, reducido]);
  useEffect(() => { entrada.current?.focus(); }, []);
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [onCerrar]);

  const nuevo = (m: Omit<Msg, 'id'>) => setMsgs((l) => [...l, { ...m, id: (l[l.length - 1]?.id ?? 0) + 1 }]);
  const abrirAsesor = () => nuevo({ rol: 'asistente', texto: 'Déjame tus datos y un asesor comercial te escribe a tu correo.', asesor: true });

  const enviar = async (valor: string) => {
    const t = valor.trim();
    if (!t || ocupado) return;
    setTexto('');
    if (/^hablar con un asesor$/i.test(t)) { nuevo({ rol: 'persona', texto: t }); abrirAsesor(); return; }
    const historia = [...msgs.filter((m) => !m.asesor), { id: 0, rol: 'persona' as Rol, texto: t }].slice(-14).map((m) => ({ rol: m.rol, texto: m.texto.slice(0, 1200) }));
    // La conversación del lado del servidor empieza con la persona.
    while (historia.length && historia[0].rol !== 'persona') historia.shift();
    nuevo({ rol: 'persona', texto: t });
    sonar('enviar'); window.setTimeout(() => sonar('pensar'), 320);
    setOcupado(true);
    try {
      const r = await api.post<any>('/api/publico/asistente', { mensajes: historia });
      nuevo({ rol: 'asistente', texto: r.respuesta, enlaces: r.enlaces, sugerencias: r.sugerencias, siguiente: r.siguiente });
      if (r.siguiente === 'abrir_asesor') abrirAsesor();
      setRespuestas((n) => n + 1); sonar('recibir');
    } catch (e) {
      nuevo({ rol: 'asistente', texto: e instanceof ApiError && e.status === 400 ? e.message : 'No pude responder en este momento. Intenta de nuevo o habla con un asesor.', siguiente: 'ofrecer_asesor' });
      setFallos((n) => n + 1); sonar('error');
    } finally { setOcupado(false); }
  };
  const enviarForm = (e: FormEvent) => { e.preventDefault(); enviar(texto); };

  return (
    <motion.section className="apub-chat" role="dialog" aria-label="Chat con Omnegia IA"
      initial={reducido ? { opacity: 0 } : { opacity: 0, y: 30, scale: 0.9, transformOrigin: '100% 100%' }} animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reducido ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.94 }} transition={{ type: 'spring', stiffness: 320, damping: 28 }}>
      <header className="apub-chat-cab">
        <OrbeCara tamano={42} cara={cara} etiqueta="Omnegia IA" />
        <div><b>Omnegia IA</b><span><i className="apub-vivo" aria-hidden="true" />{ocupado ? 'Pensando…' : 'Responde con información verificada'}</span></div>
        <SonidoBoton className="apub-cerrar" size={15} />
        <button type="button" className="apub-cerrar" onClick={onCerrar} aria-label="Cerrar el chat" data-sin-tap><Icon n="x" className="" size={16} /></button>
      </header>
      <div className="apub-lista" ref={lista} aria-live="polite">
        {msgs.map((m, i) => (
          <motion.div key={m.id} className={`apub-msg ${m.rol} ${m.asesor ? 'formulario' : ''}`} initial={reducido ? false : { opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.25 }}>
            {m.asesor ? <FormAsesor conversacion={msgs.filter((x) => !x.asesor).map((x) => ({ rol: x.rol, texto: x.texto }))} mensaje={[...msgs].reverse().find((x) => x.rol === 'persona')?.texto ?? ''}
                onEnviado={(texto) => setMsgs((l) => l.map((x) => (x.id === m.id ? { id: x.id, rol: 'asistente', texto } : x)))} />
              : <div className="apub-burbuja">{m.rol === 'asistente' ? <Markdown texto={m.texto} /> : m.texto}
                {m.rol === 'asistente' && vozDisponible() && (
                  <button type="button" className={`apub-escuchar ${leyendo === m.id ? 'on' : ''}`} onClick={() => leerEnVoz(m)} data-sin-tap
                    aria-label={leyendo === m.id ? 'Detener la lectura' : 'Escuchar esta respuesta'} title={leyendo === m.id ? 'Detener' : 'Escuchar'}>
                    <Icon n={leyendo === m.id ? 'pause' : 'volume'} className="" size={13} />
                  </button>
                )}
              </div>}
            {!!m.enlaces?.length && <div className="apub-enlaces">{m.enlaces.map((e) => <Link key={e.ruta} to={e.ruta} className="apub-enlace" onClick={() => { if (window.innerWidth < 640) onCerrar(); }}>{e.texto}<Icon n="derecha" className="" size={12} /></Link>)}</div>}
            {m.siguiente === 'ofrecer_asesor' && i === msgs.length - 1 && <button type="button" className="apub-chip fuerte" onClick={abrirAsesor}><Icon n="persona" className="" size={13} />Hablar con un asesor</button>}
            {i === msgs.length - 1 && !!m.sugerencias?.length && !ocupado && (
              <div className="apub-sugerencias">{m.sugerencias.map((s) => <button key={s} type="button" className="apub-chip" onClick={() => enviar(s)}>{s}</button>)}</div>
            )}
          </motion.div>
        ))}
        {ocupado && <div className="apub-msg asistente"><div className="apub-burbuja apub-pensando" aria-label="Omnegia IA está pensando"><i /><i /><i /></div></div>}
      </div>
      <form className="apub-entrada" onSubmit={enviarForm}>
        <textarea ref={entrada} rows={1} maxLength={1200} value={texto} placeholder="Escribe tu pregunta…" aria-label="Tu pregunta"
          onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(texto); } }} />
        <button type="submit" className="apub-enviar" data-sin-tap disabled={!texto.trim() || ocupado} aria-label="Enviar"><Icon n="enviar" className="" size={17} /></button>
      </form>
      <p className="apub-nota">No compartas contraseñas ni datos de tarjetas. La IA puede equivocarse: confirma lo importante con un asesor.</p>
    </motion.section>
  );
}

/** Formulario para que un asesor comercial escriba a la persona. Llega a la bandeja de soporte del equipo. */
function FormAsesor({ conversacion, mensaje, onEnviado }: { conversacion: { rol: Rol; texto: string }[]; mensaje: string; onEnviado: (texto: string) => void }) {
  const [f, setF] = useState({ nombre: '', email: '', telefono: '', empresa: '', mensaje: /asesor/i.test(mensaje) ? '' : mensaje.slice(0, 1000), acepta: false });
  const [estado, setEstado] = useState<{ ok?: string; error?: string; enviando?: boolean }>({});
  const cambiar = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  if (estado.ok) return <div className="apub-burbuja apub-ok"><Icon n="ok" className="" size={16} /><span>Listo. Un asesor te escribirá a <b>{f.email}</b>. Tu radicado es <b className="mono">{estado.ok}</b>; te enviamos la confirmación por correo.</span></div>;
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setEstado({ enviando: true });
    try {
      const r = await api.post<any>('/api/publico/asesor', { nombre: f.nombre, email: f.email, telefono: f.telefono, empresa: f.empresa, mensaje: f.mensaje, acepta_datos: f.acepta, conversacion: conversacion.slice(-12) });
      setEstado({ ok: r.numero }); sonar('exito');
      // En la conversación guardada queda la confirmación, no el formulario (no se reenvía al volver).
      window.setTimeout(() => onEnviado(`✅ Listo. Un asesor te escribirá a **${f.email}**. Tu radicado es **${r.numero}**; te enviamos la confirmación por correo.`), 2500);
    } catch (err) { setEstado({ error: (err as Error).message }); sonar('error'); }
  };
  return (
    <form className="apub-asesor" onSubmit={enviar} noValidate={false}>
      <div className="apub-asesor-cab">
        <span className="apub-asesor-ico" aria-hidden="true"><Icon n="persona" className="" size={18} /></span>
        <div><b>Habla con un asesor</b><small>Te escribe a tu correo, sin compromiso.</small></div>
      </div>
      <div className="apub-campos">
        <label className="apub-campo"><span className="apub-et">Nombre</span><input required minLength={2} maxLength={80} value={f.nombre} onChange={cambiar('nombre')} autoComplete="name" placeholder="Tu nombre" /></label>
        <label className="apub-campo"><span className="apub-et">Correo</span><input required type="email" maxLength={120} value={f.email} onChange={cambiar('email')} autoComplete="email" placeholder="tu@correo.com" inputMode="email" /></label>
        <label className="apub-campo"><span className="apub-et">Teléfono <small>opcional</small></span><input type="tel" maxLength={20} value={f.telefono} onChange={cambiar('telefono')} autoComplete="tel" placeholder="300 123 4567" inputMode="tel" /></label>
        <label className="apub-campo"><span className="apub-et">Negocio <small>opcional</small></span><input maxLength={80} value={f.empresa} onChange={cambiar('empresa')} autoComplete="organization" placeholder="Nombre del negocio" /></label>
        <label className="apub-campo ancho"><span className="apub-et">¿En qué te ayudamos?</span><textarea required minLength={5} maxLength={1000} rows={3} value={f.mensaje} onChange={cambiar('mensaje')} placeholder="Cuéntale al asesor qué necesitas" /></label>
      </div>
      <label className="apub-check"><input type="checkbox" checked={f.acepta} onChange={cambiar('acepta')} required /><span>Autorizo a Omnegia a usar estos datos para contactarme, según la <Link to="/privacidad">política de datos</Link>.</span></label>
      {estado.error && <p className="apub-error" role="alert">{estado.error}</p>}
      <button type="submit" className="apub-btn primario apub-asesor-enviar" disabled={estado.enviando} data-sin-tap>{estado.enviando ? 'Enviando…' : <>Enviar al asesor <Icon n="enviar" className="" size={15} /></>}</button>
    </form>
  );
}
