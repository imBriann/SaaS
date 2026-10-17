import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { OrbState } from 'thinking-orbs';
import { api, hace, hora } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { AiOrb } from '../../components/AiOrb';
import { AiVoice, useEscrituraEnVivo } from '../../components/AiVoice';
import { Cargando, Confirmar, Recibo, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Item { id?: string; rol: 'user' | 'assistant'; contenido: string; ejecuciones?: any[]; creado_en?: string; nuevo?: boolean }

const PENSANDO = ['Entendiendo tu pregunta…', 'Consultando los datos de tu negocio…', 'Armando la respuesta…'];

/** Mientras espera, la IA dice en qué va: no es una barra de carga, es la voz del asistente. */
function Pensando() {
  const [i, setI] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setI((v) => Math.min(v + 1, PENSANDO.length - 1)), 2200); return () => window.clearInterval(t); }, []);
  return (
    <div className="as-msg ia as-pensando" role="status">
      <span className="as-avatar"><AiOrb state="working" size={20} theme="light" label="Consultando" /></span>
      <span className="as-pensando-txt" key={i}>{PENSANDO[i]}</span>
    </div>
  );
}

/** Respuesta del asistente. Si acaba de llegar, se escribe en vivo y los recibos aparecen al terminar. */
function Respuesta({ m, alAvanzar }: { m: Item; alAvanzar: () => void }) {
  const vivo = !!m.nuevo;
  const { visible, escribiendo } = useEscrituraEnVivo(vivo ? m.contenido : '', { escribir: Math.max(4, Math.min(16, 2200 / Math.max(m.contenido.length, 1))) });
  useEffect(() => { if (vivo) alAvanzar(); }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="as-msg ia">
      <span className="as-avatar"><AiOrb state="breathing" size={20} theme="light" label="Asistente" /></span>
      <div className="as-burbuja-col">
        <div className="as-quien"><b>Asistente</b>{m.creado_en && <span>{hora(m.creado_en)}</span>}</div>
        <div className="as-burbuja">
          {vivo ? <>
            <p className="as-texto" aria-hidden="true"><span className="ai-voice-ghost">{m.contenido}</span><span>{visible}{escribiendo && <span className="ai-voice-caret" />}</span></p>
            <p className="sr">{m.contenido}</p>
          </> : <p className="as-texto">{m.contenido}</p>}
        </div>
        {!!m.ejecuciones?.length && (!vivo || !escribiendo) && (
          <div className="as-recibos">{m.ejecuciones.map((r) => <Recibo key={r.id} e={{ ...r, nivel_riesgo: r.riesgo, motivo_denegacion: r.motivo }} compacto />)}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Asistente IA del panel. La conversación vive en el servidor: recargar la página o cambiar de
 * pantalla no la reinicia, y el asistente recuerda lo ya dicho y conoce la ficha del negocio.
 * Cada respuesta que consulta datos muestra el recibo de la herramienta que usó.
 */
export function Asistente() {
  const { s, puede } = useSesion();
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const hilos = useApi<any[]>(() => api.get('/api/t/asistente/hilos'), []);
  const [mensajes, setMensajes] = useState<Item[]>([]);
  const [titulo, setTitulo] = useState<string | null>(null);
  const [cargandoHilo, setCargandoHilo] = useState(false);
  const [noEncontrado, setNoEncontrado] = useState(false);
  const [q, setQ] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [recien, setRecien] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);
  const [verLista, setVerLista] = useState(false);
  const [borrar, setBorrar] = useState(false);
  const { run } = useAccion();
  const actual = useRef<string | undefined>(id);
  const recienCreado = useRef<string | null>(null);
  const fin = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const permitido = puede('ai:assist') && s.modulos.includes('ia');
  const vacio = mensajes.length === 0 && !cargandoHilo && !noEncontrado && !ocupado;

  // Abrir un hilo guardado. El que acaba de crearse aquí ya está en pantalla.
  useEffect(() => {
    actual.current = id;
    setFallo(null); setNoEncontrado(false); setVerLista(false);
    if (!id) { setMensajes([]); setTitulo(null); return; }
    if (recienCreado.current === id) { recienCreado.current = null; return; }
    let vivo = true;
    setCargandoHilo(true);
    api.get(`/api/t/asistente/hilos/${id}`)
      .then((h) => { if (vivo) { setMensajes(h.mensajes); setTitulo(h.titulo); } })
      .catch(() => { if (vivo) { setMensajes([]); setTitulo(null); setNoEncontrado(true); } })
      .finally(() => { if (vivo) setCargandoHilo(false); });
    return () => { vivo = false; };
  }, [id]);

  const alFinal = () => fin.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  useEffect(() => { alFinal(); }, [mensajes, ocupado]);

  // El orbe acompaña: escucha mientras escribes, resuelve mientras consulta y se «forma» al responder.
  useEffect(() => {
    if (!recien) return;
    const t = window.setTimeout(() => setRecien(false), 2600);
    return () => window.clearTimeout(t);
  }, [recien]);
  const orbe: OrbState = ocupado ? 'solving' : recien ? 'shaping' : q.trim() ? 'listening' : 'breathing';

  // El cuadro de escritura crece con el texto, hasta un tope.
  useEffect(() => {
    const el = campo.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [q]);

  const preguntar = async (texto: string) => {
    const pregunta = texto.trim();
    if (!pregunta || ocupado) return;
    const hiloAlEnviar = id;
    setFallo(null); setQ(''); setOcupado(true); setRecien(false);
    setMensajes((m) => [...m.map((x) => ({ ...x, nuevo: false })), { rol: 'user', contenido: pregunta, creado_en: new Date().toISOString() }]);
    try {
      const r = await api.post('/api/t/asistente', { pregunta, hilo_id: hiloAlEnviar });
      // Si la persona cambió de conversación mientras esperaba, la respuesta ya quedó guardada en la suya.
      if (actual.current === hiloAlEnviar) {
        setMensajes((m) => [...m, { rol: 'assistant', contenido: r.texto, ejecuciones: r.ejecuciones, creado_en: new Date().toISOString(), nuevo: true }]);
        setRecien(true);
        if (r.titulo && !hiloAlEnviar) setTitulo(r.titulo);
        if (r.hilo_id && r.hilo_id !== hiloAlEnviar) { recienCreado.current = r.hilo_id; nav(`/asistente/${r.hilo_id}`, { replace: true }); }
      }
      hilos.recargar();
    } catch (err) {
      if (actual.current === hiloAlEnviar) { setMensajes((m) => m.slice(0, -1)); setQ(pregunta); setFallo((err as Error).message); }
    } finally { setOcupado(false); campo.current?.focus(); }
  };

  // Una pregunta que llega desde Inicio (?q=) abre una conversación nueva con ella.
  const desdeInicio = useRef(false);
  useEffect(() => {
    const inicial = params.get('q');
    if (!inicial || id || desdeInicio.current || !permitido) return;
    desdeInicio.current = true;
    setParams({}, { replace: true });
    preguntar(inicial);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (!permitido) {
    return (
      <>
        <Cabecera titulo="Asistente IA" />
        <div className="contenido"><Vacio titulo="No tienes acceso al asistente">Pide a quien administra la empresa que active el asistente para tu rol.</Vacio></div>
      </>
    );
  }

  const enviar = (e?: FormEvent) => { e?.preventDefault(); preguntar(q); };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(); }
  };
  const sugerencias = [
    { texto: '¿Cuánto vendimos esta semana?', permiso: 'order:read', modulo: 'ventas' },
    { texto: '¿Qué citas hay hoy?', permiso: 'appointment:read', modulo: 'agenda' },
    { texto: '¿Qué productos están bajo mínimo?', permiso: 'catalog:read', modulo: 'inventario' },
    { texto: '¿Cómo va el consumo del plan?', permiso: 'subscription:manage', modulo: 'ia' },
    { texto: '¿Cómo emito una nota crédito?', permiso: 'ai:assist', modulo: 'facturacion' },
  ].filter((p) => puede(p.permiso) && s.modulos.includes(p.modulo));
  const lista = hilos.data ?? [];
  const nombre = s.usuario.nombre.split(' ')[0];
  const saludo = `Hola, ${nombre}. Soy el asistente de ${s.tenant.nombre}. Conozco tu catálogo, tus horarios y tus módulos; lo que cambia —ventas, citas, existencias— lo consulto en el momento y te muestro de dónde sale.`;

  return (
    <>
      <Cabecera titulo="Asistente IA" sub="Pregunta por tu negocio. Recuerda la conversación y consulta tus datos con tus permisos.">
        <button className="btn solo-movil" onClick={() => setVerLista((v) => !v)} aria-expanded={verLista}><Icon n="conversaciones" className="" size={16} />Conversaciones</button>
        <button className="btn primario" onClick={() => { nav('/asistente'); campo.current?.focus(); }} disabled={!id && mensajes.length === 0}><Icon n="mas" className="" size={16} />Nueva conversación</button>
      </Cabecera>
      <div className="contenido">
        <div className={`asistente-detalle ${verLista ? 'ver-lista' : ''}`}>
          <aside className="tarjeta asistente-lista" aria-label="Tus conversaciones con el asistente">
            <div className="cab"><h2 className="titulo-tarjeta">Tus conversaciones</h2></div>
            {hilos.cargando && !hilos.data ? <Cargando filas={4} /> : lista.length === 0 ? (
              <div className="cuerpo"><span className="tenue peq-txt">Cuando preguntes algo, la conversación quedará guardada aquí. Solo tú la ves.</span></div>
            ) : (
              <ul className="lista asistente-hilos">
                {lista.map((h, i) => (
                  <li key={h.id} style={{ ['--i' as any]: Math.min(i, 8) }}>
                    <button type="button" className={`asistente-hilo ${h.id === id ? 'activo' : ''}`} aria-current={h.id === id ? 'true' : undefined} onClick={() => nav(`/asistente/${h.id}`)}>
                      <span className="lista-titulo cortar">{h.titulo}</span>
                      <span className="lista-detalle">{hace(h.actualizado_en)} · {h.preguntas} {h.preguntas === 1 ? 'pregunta' : 'preguntas'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className={`panel-hilo as-escena ${vacio ? 'is-vacio' : ''} ${ocupado ? 'is-working' : ''}`} aria-label="Conversación con el asistente" aria-busy={ocupado}>
            <header className="as-cab">
              <span className="as-cab-orbe" aria-hidden={vacio}>
                <span className="orb-halo" aria-hidden="true" /><span className="orb-halo" aria-hidden="true" />
                <AiOrb large theme="dark" state={orbe} label={ocupado ? 'Consultando' : 'Asistente de Omnegia'} />
              </span>
              <div className="as-cab-txt">
                <h2 className="cortar">{titulo ?? 'Nueva conversación'}</h2>
                <span className="as-estado"><i className={`ai-status-dot ${ocupado ? 'active' : 'live'}`} />{ocupado ? 'Consultando tus datos' : 'Conoce tu negocio · solo tú ves esta conversación'}</span>
              </div>
              {id && !noEncontrado && <button className="as-borrar" onClick={() => setBorrar(true)}><Icon n="x" className="" size={14} />Borrar</button>}
            </header>

            <div className="as-cuerpo">
              {cargandoHilo ? <Cargando filas={4} /> : noEncontrado ? (
                <Vacio titulo="No encontramos esa conversación" accion={<button className="btn" onClick={() => nav('/asistente')}>Empezar una nueva</button>}>Puede que ya la hayas borrado.</Vacio>
              ) : vacio ? (
                <div className="as-hero">
                  <div className="registration-orb-stage"><span className="orb-halo" aria-hidden="true" /><span className="orb-halo" aria-hidden="true" />
                    <AiOrb large theme="dark" state={orbe} label="Asistente de Omnegia" /></div>
                  <div className="as-hero-voz"><AiVoice texto={saludo} /></div>
                  {sugerencias.length > 0 && <div className="as-sugerencias">{sugerencias.map((p, i) => (
                    <button key={p.texto} type="button" className="as-sugerencia" style={{ ['--i' as any]: i }} onClick={() => preguntar(p.texto)} disabled={ocupado}>{p.texto}<Icon n="flecha" className="" size={14} /></button>
                  ))}</div>}
                </div>
              ) : (
                <div className="as-hilo" role="log" aria-live="polite">
                  {mensajes.map((m, i) => m.rol === 'user'
                    ? <div key={m.id ?? `u${i}`} className="as-msg yo"><div className="as-burbuja-col"><div className="as-burbuja"><p className="as-texto">{m.contenido}</p></div>{m.creado_en && <span className="as-hora">{hora(m.creado_en)}</span>}</div></div>
                    : <Respuesta key={m.id ?? `a${i}`} m={m} alAvanzar={alFinal} />)}
                  {ocupado && <Pensando />}
                  <div ref={fin} />
                </div>
              )}
            </div>

            <form className="as-composer" onSubmit={enviar}>
              {fallo && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{fallo}</div>}
              <div className="as-caja">
                <textarea ref={campo} rows={1} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={teclas} maxLength={1000} placeholder="Pregúntale a tu negocio…" aria-label="Pregunta al asistente" disabled={noEncontrado} />
                <button type="submit" className="composer-send" disabled={ocupado || !q.trim() || noEncontrado} aria-label={ocupado ? 'Consultando' : 'Preguntar'}>
                  {ocupado ? <AiOrb state="working" size={20} theme="dark" label="Consultando" /> : <Icon n="enviar" size={18} className="" />}
                </button>
              </div>
              <span className="as-pie">Enter envía · Shift + Enter salta de línea · El asistente puede equivocarse. <Link to="/soporte">¿Necesitas a una persona?</Link></span>
            </form>
          </section>
        </div>
      </div>
      {borrar && id && <Confirmar titulo="Borrar esta conversación" efecto={<>Se elimina con todos sus mensajes y el asistente deja de recordarla. Las consultas que hizo siguen en la auditoría de tu empresa.</>} textoBoton="Borrar"
        onCerrar={() => setBorrar(false)}
        onConfirmar={async () => { setBorrar(false); const r = await run(() => api.del(`/api/t/asistente/hilos/${id}`), 'Conversación borrada'); if (r) { hilos.recargar(); nav('/asistente'); } }} />}
    </>
  );
}
