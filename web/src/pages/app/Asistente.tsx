import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, hace, hora } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { Cargando, Confirmar, Mensaje, Recibo, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

interface Item { id?: string; rol: 'user' | 'assistant'; contenido: string; ejecuciones?: any[]; creado_en?: string }

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
  const [fallo, setFallo] = useState<string | null>(null);
  const [verLista, setVerLista] = useState(false);
  const [borrar, setBorrar] = useState(false);
  const { run } = useAccion();
  const actual = useRef<string | undefined>(id);
  const recienCreado = useRef<string | null>(null);
  const fin = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const permitido = puede('ai:assist') && s.modulos.includes('ia');

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

  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [mensajes, ocupado]);

  const preguntar = async (texto: string) => {
    const pregunta = texto.trim();
    if (!pregunta || ocupado) return;
    const hiloAlEnviar = id;
    setFallo(null); setQ(''); setOcupado(true);
    setMensajes((m) => [...m, { rol: 'user', contenido: pregunta }]);
    try {
      const r = await api.post('/api/t/asistente', { pregunta, hilo_id: hiloAlEnviar });
      // Si la persona cambió de conversación mientras esperaba, la respuesta ya quedó guardada en la suya.
      if (actual.current === hiloAlEnviar) {
        setMensajes((m) => [...m, { rol: 'assistant', contenido: r.texto, ejecuciones: r.ejecuciones }]);
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
                {lista.map((h) => (
                  <li key={h.id}>
                    <button type="button" className={`asistente-hilo ${h.id === id ? 'activo' : ''}`} aria-current={h.id === id ? 'true' : undefined} onClick={() => nav(`/asistente/${h.id}`)}>
                      <span className="lista-titulo cortar">{h.titulo}</span>
                      <span className="lista-detalle">{hace(h.actualizado_en)} · {h.preguntas} {h.preguntas === 1 ? 'pregunta' : 'preguntas'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <section className="tarjeta panel-hilo" aria-label="Conversación con el asistente">
            <div className="cab">
              <div className="conv-cab-txt">
                <h2 className="titulo-tarjeta cortar">{titulo ?? 'Nueva conversación'}</h2>
                <span className="tenue">Solo tú ves esta conversación.</span>
              </div>
              {id && !noEncontrado && <button className="btn sutil peq" style={{ marginLeft: 'auto' }} onClick={() => setBorrar(true)}><Icon n="x" className="" size={14} />Borrar</button>}
            </div>
            <div className="hilo-scroll">
              {cargandoHilo ? <Cargando filas={4} /> : noEncontrado ? (
                <Vacio titulo="No encontramos esa conversación" accion={<button className="btn" onClick={() => nav('/asistente')}>Empezar una nueva</button>}>Puede que ya la hayas borrado.</Vacio>
              ) : (
                <div className="hilo" role="log" aria-live="polite">
                  {mensajes.length === 0 && (
                    <div className="col asistente-inicio">
                      <b>¿Qué quieres saber de {s.tenant.nombre}?</b>
                      <span className="tenue peq-txt">Conoce tu catálogo, horarios y módulos. Las cifras y los datos de tus clientes los consulta en el momento, con tus permisos, y cada consulta deja su recibo.</span>
                      {sugerencias.length > 0 && <div className="fila envolver" style={{ gap: 6 }}>{sugerencias.map((p) => <button key={p.texto} type="button" className="chip" onClick={() => preguntar(p.texto)} disabled={ocupado}>{p.texto}</button>)}</div>}
                    </div>
                  )}
                  {mensajes.map((m, i) => m.rol === 'user'
                    ? <Mensaje key={m.id ?? `u${i}`} tipo="cliente" rol="Tú" hora={m.creado_en ? hora(m.creado_en) : undefined}>{m.contenido}</Mensaje>
                    : <div key={m.id ?? `a${i}`} className="col" style={{ gap: 6, alignItems: 'flex-end', minWidth: 0 }}>
                        <Mensaje tipo="ia" rol="Asistente" hora={m.creado_en ? hora(m.creado_en) : undefined}>{m.contenido}</Mensaje>
                        {m.ejecuciones?.map((r) => <Recibo key={r.id} e={{ ...r, nivel_riesgo: r.riesgo, motivo_denegacion: r.motivo }} compacto />)}
                      </div>)}
                  {ocupado && <span className="tenue peq-txt" style={{ alignSelf: 'flex-end' }}>Consultando…</span>}
                  <div ref={fin} />
                </div>
              )}
            </div>
            <form className="composer" onSubmit={enviar}>
              {fallo && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{fallo}</div>}
              <textarea ref={campo} className="input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={teclas} maxLength={1000} placeholder="Escribe tu pregunta. Enter envía, Shift + Enter salta de línea." aria-label="Pregunta al asistente" disabled={noEncontrado} />
              <div className="fila" style={{ justifyContent: 'space-between', gap: 12 }}>
                <span className="tenue peq-txt">El asistente puede equivocarse. <Link to="/soporte">¿Necesitas a una persona?</Link></span>
                <button className="btn primario" disabled={ocupado || !q.trim() || noEncontrado}><Icon n="enviar" className="" size={16} />{ocupado ? 'Consultando…' : 'Preguntar'}</button>
              </div>
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
