import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, hace, hora, preguntarEnVivo } from '../../api';
import { useSesion } from '../../components/Layout';
import { AiVoice } from '../../components/AiVoice';
import { BotonCopiar, Markdown } from '../../components/Markdown';
import { accionIA, Cargando, Confirmar, motivoIA, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useIA } from '../../components/ia/contexto';
import { GUIAS } from '../../components/ia/guias';
import { OrbeCara, useCaraIA } from '../../components/ia/OrbeCara';

interface Alcance { fecha?: string; desde?: string; hasta?: string; periodo?: string; dias?: number; encontrados?: number }
export interface Ejecucion { id: string; herramienta: string; decision: string; motivo?: string | null; riesgo?: string | null; pendiente_id?: string; resumen?: string | null; pendiente?: { estado: string; expira_en: string } | null; alcance?: Alcance; guia?: string }
export interface Item { id?: string; rol: 'user' | 'assistant'; contenido: string; ejecuciones?: Ejecucion[]; creado_en?: string; nuevo?: boolean; fallo?: string | null }
export interface Paso { herramienta: string; fase: 'inicio' | 'fin'; decision?: string }

/** Lo que el asistente está haciendo en este momento, en presente (lo informa el servidor, no un temporizador). */
const PROGRESO: Record<string, string> = {
  resumen_ventas: 'Consultando las ventas', citas_del_dia: 'Revisando la agenda', agenda_periodo: 'Revisando la agenda', stock_bajo_minimo: 'Revisando el inventario', buscar_cliente: 'Buscando el cliente',
  consultar_catalogo: 'Consultando el catálogo', consumo_del_plan: 'Revisando el consumo del plan', ayuda_plataforma: 'Buscando en la guía del panel', mostrar_guia: 'Preparando la guía en pantalla',
  crear_item_catalogo: 'Preparando el nuevo ítem', editar_item_catalogo: 'Preparando el cambio',
};
const MAX = 1000;
/**
 * Pantalla táctil (teléfono o tableta): ahí devolver el foco al cuadro de texto abre el teclado y tapa
 * la respuesta. Solo se enfoca solo con teclado y ratón.
 */
const tactil = () => !!window.matchMedia?.('(pointer: coarse)').matches;

/** Indicador de trabajo: muestra los pasos reales que llegan del servidor y el tiempo que lleva. */
export function Trabajando({ pasos, fase }: { pasos: Paso[]; fase: string }) {
  const [s, setS] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setS((x) => x + 1), 1000); return () => window.clearInterval(t); }, []);
  // Varias consultas a la misma fuente (p. ej. la agenda día por día) se muestran como un solo paso con su conteo.
  const herramientas = pasos.reduce<{ herramienta: string; veces: number; listas: number; hecho: boolean; bloqueada: boolean }[]>((acc, p) => {
    const fuente = FUENTE[p.herramienta]?.clave ?? p.herramienta;
    let ya = acc.find((x) => (FUENTE[x.herramienta]?.clave ?? x.herramienta) === fuente);
    if (!ya) { ya = { herramienta: p.herramienta, veces: 0, listas: 0, hecho: false, bloqueada: false }; acc.push(ya); }
    if (p.fase === 'inicio') ya.veces++;
    else { ya.listas++; ya.bloqueada ||= p.decision === 'DENEGADA' || p.decision === 'ERROR'; }
    ya.hecho = ya.listas >= ya.veces;
    return acc;
  }, []);
  return (
    <div className="as-msg ia as-trabajando" role="status" aria-live="polite">
      <div className="as-quien"><span className="as-avatar"><OrbeCara tamano={24} cara="pensando" /></span><b>Omnegia IA</b><span className="as-trabajando-t">{s >= 3 ? `${s} s` : ''}</span></div>
      <ol className="as-pasos">
        {herramientas.map((h, i) => (
          <li key={i} className={h.hecho ? (h.bloqueada ? 'bloqueado' : 'hecho') : 'actual'}>
            <span className="as-paso-ico" aria-hidden="true">{h.hecho ? <Icon n={h.bloqueada ? 'candado' : 'ok'} className="" size={13} /> : <span className="as-punto" />}</span>
            {PROGRESO[h.herramienta] ?? 'Consultando tus datos'}{h.veces > 1 ? <span className="as-paso-n"> · {h.listas} de {h.veces}</span> : null}{h.hecho && h.bloqueada ? ' · no permitido' : ''}
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

// ---------------------------------------------------------------- dónde buscó
/** Fuente de datos de cada herramienta: agrupa los recibos («la agenda», aunque haya sido día por día). */
const FUENTE: Record<string, { clave: string; titulo: string; icono: string; unidad?: [string, string] }> = {
  citas_del_dia: { clave: 'agenda', titulo: 'Agenda', icono: 'agenda', unidad: ['cita', 'citas'] },
  agenda_periodo: { clave: 'agenda', titulo: 'Agenda', icono: 'agenda', unidad: ['cita', 'citas'] },
  resumen_ventas: { clave: 'ventas', titulo: 'Ventas y cobros', icono: 'ventas' },
  stock_bajo_minimo: { clave: 'inventario', titulo: 'Inventario', icono: 'inventario', unidad: ['producto bajo mínimo', 'productos bajo mínimo'] },
  consultar_catalogo: { clave: 'catalogo', titulo: 'Catálogo', icono: 'inventario', unidad: ['ítem', 'ítems'] },
  buscar_cliente: { clave: 'clientes', titulo: 'Clientes', icono: 'clientes', unidad: ['coincidencia', 'coincidencias'] },
  consumo_del_plan: { clave: 'plan', titulo: 'Consumo del plan', icono: 'suscripcion' },
  ayuda_plataforma: { clave: 'guia', titulo: 'Guía del panel', icono: 'soporte' },
  mostrar_guia: { clave: 'guia', titulo: 'Guía del panel', icono: 'soporte' },
};
const DIA = (f: string) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\./g, '');
const DIA_CORTO = (f: string) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\./g, '');

/** Fechas que abarcó un grupo de consultas: «19 – 24 oct · 6 días» o los días sueltos. */
function rango(es: Ejecucion[]): { texto: string; dias: string[] } | null {
  const dias = new Set<string>();
  for (const e of es) {
    const a = e.alcance;
    if (a?.fecha) dias.add(a.fecha);
    if (a?.desde && a?.hasta) for (let d = a.desde, i = 0; d <= a.hasta && i < 62; i++) { dias.add(d); const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); d = x.toISOString().slice(0, 10); }
  }
  const l = [...dias].sort();
  if (!l.length) return null;
  if (l.length === 1) return { texto: DIA(l[0]), dias: l };
  const seguidos = l.every((d, i) => i === 0 || (new Date(`${d}T12:00:00Z`).getTime() - new Date(`${l[i - 1]}T12:00:00Z`).getTime()) === 86_400_000);
  return { texto: seguidos ? `${DIA_CORTO(l[0])} – ${DIA_CORTO(l[l.length - 1])} · ${l.length} días` : `${l.length} días`, dias: l };
}

/** Una sola tarjeta con lo que consultó el asistente, agrupado por fuente, en vez de un recibo por llamada. */
function Consultas({ recibos }: { recibos: Ejecucion[] }) {
  const grupos = recibos.reduce<{ clave: string; fuente: (typeof FUENTE)[string] | null; es: Ejecucion[] }[]>((acc, e) => {
    const f = FUENTE[e.herramienta] ?? null;
    const clave = `${f?.clave ?? e.herramienta}:${e.decision === 'PERMITIDA' ? 'ok' : e.decision}`;
    const g = acc.find((x) => x.clave === clave);
    if (g) g.es.push(e); else acc.push({ clave, fuente: f, es: [e] });
    return acc;
  }, []);
  const total = recibos.length;
  const bloqueadas = recibos.filter((e) => e.decision === 'DENEGADA' || e.decision === 'ERROR').length;
  return (
    <section className="as-consultas" aria-label="Dónde buscó el asistente">
      <header className="as-consultas-cab">
        <span className="as-consultas-ico" aria-hidden="true"><Icon n="buscar" className="" size={14} /></span>
        <b>Dónde buscó</b>
        <span className="as-consultas-meta">{total} {total === 1 ? 'consulta' : 'consultas'} a tus datos{bloqueadas ? ` · ${bloqueadas} no permitida${bloqueadas === 1 ? '' : 's'}` : ' · todas permitidas'}</span>
      </header>
      <ul className="as-consultas-lista">
        {grupos.map((g, i) => {
          const r = rango(g.es);
          const encontrados = g.es.reduce<number | null>((s, e) => (typeof e.alcance?.encontrados === 'number' ? (s ?? 0) + e.alcance.encontrados : s), null);
          const denegada = g.es[0].decision === 'DENEGADA' || g.es[0].decision === 'ERROR';
          const u = g.fuente?.unidad;
          return (
            <li key={g.clave} className={`as-consulta ${denegada ? 'denegada' : ''}`} style={{ ['--i' as any]: i }}>
              <span className="as-consulta-ico" aria-hidden="true"><Icon n={denegada ? 'candado' : g.fuente?.icono ?? 'ia'} className="" size={15} /></span>
              <span className="as-consulta-txt">
                <b>{g.fuente?.titulo ?? accionIA(g.es[0].herramienta)}</b>
                <span>
                  {r ? r.texto : g.es[0].alcance?.dias ? (g.es[0].alcance.dias === 1 ? 'Hoy' : `Últimos ${g.es[0].alcance.dias} días`) : g.es.length > 1 ? `${g.es.length} consultas` : accionIA(g.es[0].herramienta)}
                  {encontrados !== null && u ? ` · ${encontrados === 0 ? `sin ${u[1]}` : `${encontrados} ${encontrados === 1 ? u[0] : u[1]}`}` : ''}
                </span>
                {r && r.dias.length > 1 && r.dias.length <= 14 && <span className="as-consulta-dias" aria-label="Días consultados">{r.dias.map((d) => <i key={d}>{DIA(d).split(' ')[0]} {d.slice(8).replace(/^0/, '')}</i>)}</span>}
                {denegada && g.es[0].motivo && <small className="as-consulta-motivo">{motivoIA(g.es[0].motivo)}</small>}
              </span>
              <span className={`as-consulta-estado ${denegada ? 'no' : 'si'}`}><Icon n={denegada ? 'candado' : 'ok'} className="" size={12} />{denegada ? 'No permitida' : g.es.length > 1 ? 'Permitidas' : 'Permitida'}</span>
              <Link className="as-consulta-audit" to={`/auditoria?q=${g.es[0].id}`} aria-label={`Ver ${g.fuente?.titulo ?? 'la consulta'} en auditoría`}><Icon n="auditoria" className="" size={14} /></Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** La guía que preparó el asistente: arranca sola al llegar la respuesta y se puede repetir desde aquí. */
function GuiaRecibo({ id }: { id: string }) {
  const { iniciarGuia } = useIA();
  const g = GUIAS[id];
  return (
    <div className="as-guia">
      <span className="as-guia-orbe" aria-hidden="true"><OrbeCara tamano={30} cara="feliz" /></span>
      <span className="as-guia-txt"><b>Guía en pantalla · {g.titulo}</b><span>{g.pasos.length} pasos sobre los botones reales de tu panel</span></span>
      <button type="button" className="btn peq" onClick={() => iniciarGuia(id)}><Icon n="derecha" className="" size={14} />Mostrármela</button>
    </div>
  );
}

/** Primera guía nueva de una respuesta (para arrancarla en cuanto llega). */
export const guiaDe = (ejecuciones?: Ejecucion[]) => ejecuciones?.find((e) => e.guia && GUIAS[e.guia])?.guia ?? null;

export function Respuesta({ m, onAccion }: { m: Item; onAccion: (texto: string, recibo: Ejecucion) => void }) {
  const pendientes = (m.ejecuciones ?? []).filter((e) => e.pendiente_id);
  const recibos = (m.ejecuciones ?? []).filter((e) => !e.pendiente_id);
  const guias = [...new Set((m.ejecuciones ?? []).map((e) => e.guia).filter((g): g is string => !!g && !!GUIAS[g]))];
  return (
    <article className="as-msg ia" aria-label="Respuesta del asistente">
      <div className="as-quien">
        <span className="as-avatar"><OrbeCara tamano={24} /></span>
        <b>Omnegia IA</b>{m.creado_en && <time dateTime={m.creado_en}>{hora(m.creado_en)}</time>}
      </div>
      <div className="as-cuerpo-msg"><Markdown texto={m.contenido} revelar={!!m.nuevo} /></div>
      {guias.map((g) => <GuiaRecibo key={g} id={g} />)}
      {pendientes.map((e) => <AccionPendiente key={e.pendiente_id} e={e} onResuelta={onAccion} />)}
      {recibos.length > 0 && <Consultas recibos={recibos} />}
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
  const [buscar, setBuscar] = useState('');
  const { run } = useAccion();
  const { iniciarGuia } = useIA();
  const [respuestas, setRespuestas] = useState(0);
  const [fallos, setFallos] = useState(0);
  const [largo, setLargo] = useState(0);
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
    // En el teléfono se cierra el teclado al enviar: la persona ve cómo trabaja el asistente y su respuesta.
    if (tactil()) campo.current?.blur();
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
        setLargo(r.texto?.length ?? 0); setRespuestas((n) => n + 1);
        const g = guiaDe(r.ejecuciones);
        if (g) window.setTimeout(() => iniciarGuia(g), 900);
        if (r.titulo && !hiloAlEnviar) setTitulo(r.titulo);
        if (r.hilo_id && r.hilo_id !== hiloAlEnviar) { recienCreado.current = r.hilo_id; nav(`/asistente/${r.hilo_id}`, { replace: true }); }
      }
      hilos.recargar();
    } catch (err) {
      // La pregunta queda en pantalla, marcada, con un botón para reintentar: no se pierde lo escrito.
      const mensaje = (err as ApiError).message;
      if (actual.current === hiloAlEnviar) setMensajes((m) => m.map((x, i) => (i === (reintento ?? m.length - 1) ? { ...x, fallo: mensaje } : x)));
      setFallos((n) => n + 1);
    } finally { setOcupado(false); if (!tactil()) campo.current?.focus(); }
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
  const todos = hilos.data ?? [];
  const lista = buscar.trim() ? todos.filter((h) => String(h.titulo ?? '').toLowerCase().includes(buscar.trim().toLowerCase())) : todos;
  // Preguntas de seguimiento: las sugerencias que todavía no se hicieron en esta conversación.
  const hechas = new Set(mensajes.filter((m) => m.rol === 'user').map((m) => m.contenido.trim()));
  const seguir = !vacio && !ocupado && mensajes.length > 0 && mensajes[mensajes.length - 1].rol === 'assistant' ? sugerencias.filter((p) => !hechas.has(p.texto)).slice(0, 3) : [];
  const nombre = s.usuario.nombre.split(' ')[0];
  const saludo = `Hola, ${nombre}. Soy el asistente de ${s.tenant.nombre}. Conozco tu catálogo, tus horarios y tus módulos; lo que cambia —ventas, citas, existencias— lo consulto en el momento y te muestro de dónde sale.`;
  const cara = useCaraIA({ ocupado, escribiendo: !!q.trim(), respuesta: respuestas, fallo: fallos, largo });
  const nueva = () => { setVerLista(false); nav('/asistente'); if (!tactil()) campo.current?.focus(); };
  const alResolverAccion = (texto: string, recibo: Ejecucion) => {
    setMensajes((m) => [...m.map((x) => ({ ...x, nuevo: false })), { rol: 'assistant', contenido: texto, ejecuciones: [recibo], creado_en: new Date().toISOString(), nuevo: true }]);
  };

  return (
    <>
      <div className={`as-ventana ${verLista ? 'ver-lista' : ''}`}>
        <aside className="as-lista" aria-label="Tus conversaciones con el asistente">
          <div className="as-lista-cab">
            <div className="as-lista-marca"><span className="as-lista-orbe"><OrbeCara tamano={26} /></span><div><h2>Omnegia IA</h2><span>Solo tú ves tus conversaciones</span></div></div>
            <button className="as-nueva" onClick={nueva}><Icon n="mas" className="" size={16} />Nueva conversación</button>
            {todos.length > 4 && <label className="as-buscar"><Icon n="buscar" className="" size={15} /><input type="search" value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Buscar en tus conversaciones" aria-label="Buscar en tus conversaciones" /></label>}
          </div>
          {hilos.cargando && !hilos.data ? <Cargando filas={4} /> : lista.length === 0 ? (
            <p className="as-lista-vacia">{buscar.trim() ? 'Ninguna conversación coincide.' : 'Cuando preguntes algo, la conversación quedará guardada aquí. Solo tú la ves.'}</p>
          ) : (
            <ul className="asistente-hilos">
              {lista.map((h, i) => (
                <li key={h.id} style={{ ['--i' as any]: Math.min(i, 8) }}>
                  <button type="button" className={`asistente-hilo ${h.id === id ? 'activo' : ''}`} aria-current={h.id === id ? 'true' : undefined} onClick={() => nav(`/asistente/${h.id}`)}>
                    <span className="lista-titulo cortar"><Icon n="conversaciones" className="" size={14} />{h.titulo}</span>
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
            <span className="as-cab-orbe" aria-hidden="true"><OrbeCara tamano={30} cara={cara} /></span>
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
                  <OrbeCara tamano={112} cara={cara} mirada={q.trim() ? { x: 0, y: 0.9 } : undefined} etiqueta="Omnegia IA" /></div>
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
            {seguir.length > 0 && <div className="as-seguir" aria-label="Preguntas sugeridas">{seguir.map((p, i) => <button key={p.texto} type="button" style={{ ['--i' as any]: i }} onClick={() => preguntar(p.texto)}><Icon n="ia" className="" size={13} />{p.texto}</button>)}</div>}
            <div className="as-caja">
              <textarea ref={campo} rows={1} value={q} onChange={(e) => setQ(e.target.value.slice(0, MAX))} onKeyDown={teclas} maxLength={MAX} placeholder="Pregúntale a tu negocio…" aria-label="Pregunta al asistente" disabled={noEncontrado} />
              <button type="submit" className="composer-send" disabled={ocupado || !q.trim() || noEncontrado} aria-label={ocupado ? 'Trabajando en la respuesta' : 'Preguntar'}>
                {ocupado ? <OrbeCara tamano={22} cara="pensando" /> : <Icon n="enviar" size={18} className="" />}
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
