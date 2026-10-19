import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { OrbState } from 'thinking-orbs';
import { api, ApiError, hace, hora, preguntarEnVivo } from '../../api';
import { useSesion } from '../../components/Layout';
import { AiOrb } from '../../components/AiOrb';
import { AiVoice } from '../../components/AiVoice';
import { BotonCopiar, Markdown } from '../../components/Markdown';
import { accionIA, Cargando, Confirmar, Recibo, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Ejecucion { id: string; herramienta: string; decision: string; motivo?: string | null; riesgo?: string | null; pendiente_id?: string; resumen?: string | null; pendiente?: { estado: string; expira_en: string } | null }
interface Item { id?: string; rol: 'user' | 'assistant'; contenido: string; ejecuciones?: Ejecucion[]; creado_en?: string; nuevo?: boolean; fallo?: string | null }
interface Paso { herramienta: string; fase: 'inicio' | 'fin'; decision?: string }

/** Lo que el asistente está haciendo en este momento, en presente (lo informa el servidor, no un temporizador). */
const PROGRESO: Record<string, string> = {
  resumen_ventas: 'Consultando las ventas', citas_del_dia: 'Revisando la agenda', stock_bajo_minimo: 'Revisando el inventario', buscar_cliente: 'Buscando el cliente',
  consultar_catalogo: 'Consultando el catálogo', consumo_del_plan: 'Revisando el consumo del plan', ayuda_plataforma: 'Buscando en la guía del panel',
  crear_item_catalogo: 'Preparando el nuevo ítem', editar_item_catalogo: 'Preparando el cambio',
};
const MAX = 1000;

/** Indicador de trabajo: muestra los pasos reales que llegan del servidor y el tiempo que lleva. */
function Trabajando({ pasos, fase }: { pasos: Paso[]; fase: string }) {
  const [s, setS] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setS((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);
  const herramientas = pasos.reduce<{ herramienta: string; hecho: boolean; bloqueada: boolean }[]>((acc, p) => {
    const ya = acc.find((x) => x.herramienta === p.herramienta && !x.hecho);
    if (p.fase === 'inicio') acc.push({ herramienta: p.herramienta, hecho: false, bloqueada: false });
    else if (ya) { ya.hecho = true; ya.bloqueada = p.decision === 'DENEGADA' || p.decision === 'ERROR'; }
    return acc;
  }, []);
  return (
    <div className="as-msg ia as-trabajando" role="status" aria-live="polite">
      <div className="as-quien"><span className="as-avatar"><AiOrb state="working" size={20} theme="light" label="Trabajando" /></span><b>Asistente</b><span className="as-trabajando-t">{s >= 3 ? `${s} s` : ''}</span></div>
      <ol className="as-pasos">
        {herramientas.map((h, i) => (
          <li key={i} className={h.hecho ? (h.bloqueada ? 'bloqueado' : 'hecho') : 'actual'}>
            <span className="as-paso-ico" aria-hidden="true">{h.hecho ? <Icon n={h.bloqueada ? 'candado' : 'ok'} className="" size={13} /> : <span className="as-punto" />}</span>
            {PROGRESO[h.herramienta] ?? 'Consultando tus datos'}{h.hecho && h.bloqueada ? ' · no permitido' : ''}
          </li>
        ))}
        <li className="actual"><span className="as-paso-ico" aria-hidden="true"><span className="as-punto" /></span>{fase === 'redactando' ? 'Redactando la respuesta' : herramientas.length ? 'Analizando lo encontrado' : 'Pensando'}</li>
      </ol>
    </div>
  );
}

/** Acción que el asistente dejó lista: no pasa nada hasta que la persona la confirma aquí. */
function AccionPendiente({ e, onResuelta }: { e: Ejecucion; onResuelta: (texto: string, recibo: Ejecucion) => void }) {
  const [estado, setEstado] = useState(e.pendiente?.estado ?? 'PENDIENTE');
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<null | 'confirmar' | 'cancelar'>(null);
  const vence = e.pendiente?.expira_en ? Math.max(0, Math.round((new Date(e.pendiente.expira_en).getTime() - Date.now()) / 60000)) : null;
  const resolver = async (decision: 'confirmar' | 'cancelar') => {
    setOcupado(decision); setError(null);
    try {
      const r = await api.post(`/api/t/asistente/acciones/${e.pendiente_id}`, { decision });
      setEstado(r.estado === 'CONFIRMADA' ? 'CONFIRMADA' : r.estado === 'RECHAZADA' ? 'RECHAZADA' : 'FALLIDA');
      onResuelta(r.texto, { ...r.recibo, herramienta: e.herramienta });
    } catch (err) {
      const m = (err as Error).message;
      if (/venció/.test(m)) setEstado('EXPIRADA');
      setError(m);
    } finally { setOcupado(null); }
  };
  const etiqueta: Record<string, string> = { CONFIRMADA: 'Confirmado y guardado', RECHAZADA: 'Cancelado: no se hizo ningún cambio', EXPIRADA: 'Venció sin confirmarse: no se hizo ningún cambio', FALLIDA: 'No se pudo hacer: nada cambió' };
  return (
    <div className={`as-accion ${estado.toLowerCase()}`}>
      <div className="as-accion-cab"><Icon n={estado === 'PENDIENTE' ? 'reloj' : estado === 'CONFIRMADA' ? 'ok' : 'x'} className="" size={15} /><b>{accionIA(e.herramienta)}</b>{estado === 'PENDIENTE' && vence !== null && <span className="tenue peq-txt">vence en {vence} min</span>}</div>
      {e.resumen && <p className="as-accion-resumen">{e.resumen}</p>}
      {estado === 'PENDIENTE' ? (
        <div className="as-accion-botones">
          <button type="button" className="btn primario peq" disabled={!!ocupado} onClick={() => resolver('confirmar')}>{ocupado === 'confirmar' ? 'Guardando…' : 'Confirmar'}</button>
          <button type="button" className="btn peq" disabled={!!ocupado} onClick={() => resolver('cancelar')}>{ocupado === 'cancelar' ? 'Cancelando…' : 'Cancelar'}</button>
          <span className="tenue peq-txt">Hasta que confirmes, nada cambia en tu negocio.</span>
        </div>
      ) : <p className="as-accion-estado">{etiqueta[estado] ?? estado}</p>}
      {error && <p className="bloqueado peq-txt" role="alert"><Icon n="alerta" className="" size={14} />{error}</p>}
    </div>
  );
}

function Respuesta({ m, onAccion }: { m: Item; onAccion: (texto: string, recibo: Ejecucion) => void }) {
  const pendientes = (m.ejecuciones ?? []).filter((e) => e.pendiente_id);
  const recibos = (m.ejecuciones ?? []).filter((e) => !e.pendiente_id);
  return (
    <article className="as-msg ia" aria-label="Respuesta del asistente">
      <div className="as-quien">
        <span className="as-avatar"><AiOrb state="breathing" size={20} theme="light" label="Asistente" /></span>
        <b>Asistente</b>{m.creado_en && <time dateTime={m.creado_en}>{hora(m.creado_en)}</time>}
      </div>
      <div className="as-cuerpo-msg"><Markdown texto={m.contenido} revelar={!!m.nuevo} /></div>
      {pendientes.map((e) => <AccionPendiente key={e.pendiente_id} e={e} onResuelta={onAccion} />)}
      {recibos.length > 0 && <div className="as-recibos">{recibos.map((r) => <Recibo key={r.id} e={{ ...r, nivel_riesgo: r.riesgo, motivo_denegacion: r.motivo }} compacto />)}</div>}
      <div className="as-msg-acciones"><BotonCopiar texto={m.contenido} etiqueta="Copiar respuesta" className="sutil" /></div>
    </article>
  );
}

/**
 * Asistente IA del panel. La conversación vive en el servidor: recargar o cambiar de pantalla no la
 * reinicia. Muestra en vivo lo que consulta, presenta las respuestas con formato (listas, tablas,
 * código) y nunca da por hecho un cambio que la persona no confirmó.
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
  const [pasos, setPasos] = useState<Paso[]>([]);
  const [fase, setFase] = useState('pensando');
  const [verLista, setVerLista] = useState(false);
  const [borrar, setBorrar] = useState(false);
  const [lejos, setLejos] = useState(false);
  const { run } = useAccion();
  const actual = useRef<string | undefined>(id);
  const recienCreado = useRef<string | null>(null);
  const cuerpo = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const pegado = useRef(true);
  const permitido = puede('ai:assist') && s.modulos.includes('ia');
  const vacio = mensajes.length === 0 && !cargandoHilo && !noEncontrado && !ocupado;

  useEffect(() => {
    actual.current = id;
    setNoEncontrado(false); setVerLista(false);
    if (!id) { setMensajes([]); setTitulo(null); return; }
    if (recienCreado.current === id) { recienCreado.current = null; return; }
    let vivo = true;
    setCargandoHilo(true);
    api.get(`/api/t/asistente/hilos/${id}`)
      .then((h) => { if (vivo) { setMensajes(h.mensajes); setTitulo(h.titulo); pegado.current = true; } })
      .catch(() => { if (vivo) { setMensajes([]); setTitulo(null); setNoEncontrado(true); } })
      .finally(() => { if (vivo) setCargandoHilo(false); });
    return () => { vivo = false; };
  }, [id]);

  // Desplazamiento: solo baja solo si la persona estaba al final; si está leyendo arriba, no la mueve.
  const alFinal = (suave = true) => { const el = cuerpo.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: suave ? 'smooth' : 'auto' }); };
  useLayoutEffect(() => { if (pegado.current) alFinal(false); else setLejos(true); }, [mensajes, ocupado, pasos.length]);
  const alDesplazar = () => {
    const el = cuerpo.current;
    if (!el) return;
    pegado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (pegado.current) setLejos(false);
  };

  useEffect(() => {
    const el = campo.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [q]);

  const preguntar = async (texto: string, reintento?: number) => {
    const pregunta = texto.trim();
    if (!pregunta || ocupado) return;
    const hiloAlEnviar = id;
    setQ(''); setOcupado(true); setPasos([]); setFase('pensando'); pegado.current = true;
    setMensajes((m) => {
      const base = m.map((x) => ({ ...x, nuevo: false }));
      if (reintento !== undefined) return base.map((x, i) => (i === reintento ? { ...x, fallo: null } : x));
      return [...base, { rol: 'user', contenido: pregunta, creado_en: new Date().toISOString() }];
    });
    try {
      const r = await preguntarEnVivo({ pregunta, hilo_id: hiloAlEnviar }, (e) => {
        if (actual.current !== hiloAlEnviar) return;
        if (e.tipo === 'herramienta') setPasos((p) => [...p, e]);
        if (e.tipo === 'estado') setFase(e.fase);
      });
      if (actual.current === hiloAlEnviar) {
        setMensajes((m) => [...m, { rol: 'assistant', contenido: r.texto, ejecuciones: r.ejecuciones, creado_en: new Date().toISOString(), nuevo: true }]);
        if (r.titulo && !hiloAlEnviar) setTitulo(r.titulo);
        if (r.hilo_id && r.hilo_id !== hiloAlEnviar) { recienCreado.current = r.hilo_id; nav(`/asistente/${r.hilo_id}`, { replace: true }); }
      }
      hilos.recargar();
    } catch (err) {
      // La pregunta queda en pantalla, marcada, con un botón para reintentar: no se pierde lo escrito.
      const mensaje = (err as ApiError).message;
      if (actual.current === hiloAlEnviar) setMensajes((m) => m.map((x, i) => (i === (reintento ?? m.length - 1) ? { ...x, fallo: mensaje } : x)));
    } finally { setOcupado(false); campo.current?.focus(); }
  };

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
      <div className="contenido" style={{ padding: 24 }}><Vacio titulo="No tienes acceso al asistente">Pide a quien administra la empresa que active el asistente para tu rol.</Vacio></div>
    );
  }

  const enviar = (e?: FormEvent) => { e?.preventDefault(); preguntar(q); };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(); }
  };
  const sugerencias = [
    { texto: '¿Cuánto vendimos esta semana y cuánto entró en efectivo?', permiso: 'order:read', modulo: 'ventas' },
    { texto: '¿Qué citas hay hoy?', permiso: 'appointment:read', modulo: 'agenda' },
    { texto: '¿Qué productos están bajo mínimo?', permiso: 'inventory:read', modulo: 'inventario' },
    { texto: '¿Cómo registro un pago en efectivo?', permiso: 'ai:assist', modulo: 'ventas' },
    { texto: '¿Cómo emito una nota crédito?', permiso: 'ai:assist', modulo: 'facturacion' },
  ].filter((p) => puede(p.permiso) && s.modulos.includes(p.modulo)).slice(0, 4);
  const lista = hilos.data ?? [];
  const nombre = s.usuario.nombre.split(' ')[0];
  const saludo = `Hola, ${nombre}. Soy el asistente de ${s.tenant.nombre}. Conozco tu catálogo, tus horarios y tus módulos; lo que cambia —ventas, citas, existencias— lo consulto en el momento y te muestro de dónde sale.`;
  const orbe: OrbState = ocupado ? 'solving' : q.trim() ? 'listening' : 'breathing';
  const nueva = () => { setVerLista(false); nav('/asistente'); campo.current?.focus(); };
  const alResolverAccion = (texto: string, recibo: Ejecucion) => {
    setMensajes((m) => [...m.map((x) => ({ ...x, nuevo: false })), { rol: 'assistant', contenido: texto, ejecuciones: [recibo], creado_en: new Date().toISOString(), nuevo: true }]);
  };

  return (
    <>
      <div className={`as-ventana ${verLista ? 'ver-lista' : ''}`}>
        <aside className="as-lista" aria-label="Tus conversaciones con el asistente">
          <div className="as-lista-cab">
            <h2>Conversaciones</h2>
            <button className="btn primario" onClick={nueva}><Icon n="mas" className="" size={16} />Nueva conversación</button>
          </div>
          {hilos.cargando && !hilos.data ? <Cargando filas={4} /> : lista.length === 0 ? (
            <p className="as-lista-vacia">Cuando preguntes algo, la conversación quedará guardada aquí. Solo tú la ves.</p>
          ) : (
            <ul className="asistente-hilos">
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

        <section className={`as-escena ${vacio ? 'is-vacio' : ''} ${ocupado ? 'is-working' : ''}`} aria-label="Conversación con el asistente" aria-busy={ocupado}>
          <header className="as-cab">
            <button className="as-lista-btn" onClick={() => setVerLista((v) => !v)} aria-expanded={verLista}><Icon n="conversaciones" className="" size={16} />Conversaciones</button>
            <span className="as-cab-orbe" aria-hidden="true"><AiOrb state={orbe} size={20} theme="light" label="Asistente" /></span>
            <div className="as-cab-txt">
              <h2 className="cortar">{titulo ?? 'Nueva conversación'}</h2>
              <span className="as-estado"><i className={`ai-status-dot ${ocupado ? 'active' : 'live'}`} />{ocupado ? 'Trabajando en tu respuesta' : 'Conoce tu negocio · solo tú ves esta conversación'}</span>
            </div>
            {id && !noEncontrado && <button className="btn sutil peq" onClick={() => setBorrar(true)}><Icon n="x" className="" size={14} />Borrar</button>}
          </header>

          <div className="as-cuerpo" ref={cuerpo} onScroll={alDesplazar}>
            {cargandoHilo ? <div className="as-hilo"><Cargando filas={4} /></div> : noEncontrado ? (
              <div className="as-hilo"><Vacio titulo="No encontramos esa conversación" accion={<button className="btn" onClick={() => nav('/asistente')}>Empezar una nueva</button>}>Puede que ya la hayas borrado.</Vacio></div>
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
              <div className="as-hilo" role="log" aria-live="polite" aria-relevant="additions">
                {mensajes.map((m, i) => m.rol === 'user' ? (
                  <div key={m.id ?? `u${i}`} className={`as-msg yo ${m.fallo ? 'con-fallo' : ''}`}>
                    <div className="as-burbuja"><p className="as-texto">{m.contenido}</p></div>
                    {m.fallo ? (
                      <div className="as-fallo" role="alert">
                        <Icon n="alerta" className="" size={14} /><span>No se pudo responder: {m.fallo}</span>
                        <button type="button" className="btn peq" disabled={ocupado} onClick={() => preguntar(m.contenido, i)}>Reintentar</button>
                      </div>
                    ) : m.creado_en && <time className="as-hora" dateTime={m.creado_en}>{hora(m.creado_en)}</time>}
                  </div>
                ) : <Respuesta key={m.id ?? `a${i}`} m={m} onAccion={alResolverAccion} />)}
                {ocupado && <Trabajando pasos={pasos} fase={fase} />}
              </div>
            )}
          </div>
          {lejos && !vacio && <button type="button" className="as-ir-final" onClick={() => { pegado.current = true; setLejos(false); alFinal(); }}><Icon n="abajo" className="" size={16} />Ir al final</button>}

          <form className="as-composer" onSubmit={enviar}>
            <div className="as-caja">
              <textarea ref={campo} rows={1} value={q} onChange={(e) => setQ(e.target.value.slice(0, MAX))} onKeyDown={teclas} maxLength={MAX} placeholder="Pregúntale a tu negocio…" aria-label="Pregunta al asistente" disabled={noEncontrado} />
              <button type="submit" className="composer-send" disabled={ocupado || !q.trim() || noEncontrado} aria-label={ocupado ? 'Trabajando en la respuesta' : 'Preguntar'}>
                {ocupado ? <AiOrb state="working" size={20} theme="dark" label="Trabajando" /> : <Icon n="enviar" size={18} className="" />}
              </button>
            </div>
            <span className="as-pie">{q.length > MAX - 120 ? <b>{MAX - q.length} caracteres disponibles · </b> : null}Enter envía · Shift + Enter salta de línea · El asistente puede equivocarse. <Link to="/soporte">¿Necesitas a una persona?</Link></span>
          </form>
        </section>
      </div>
      {borrar && id && <Confirmar titulo="Borrar esta conversación" efecto={<>Se elimina con todos sus mensajes y el asistente deja de recordarla. Las consultas que hizo siguen en la auditoría de tu empresa.</>} textoBoton="Borrar"
        onCerrar={() => setBorrar(false)}
        onConfirmar={async () => { setBorrar(false); const r = await run(() => api.del(`/api/t/asistente/hilos/${id}`), 'Conversación borrada'); if (r) { hilos.recargar(); nav('/asistente'); } }} />}
    </>
  );
}
