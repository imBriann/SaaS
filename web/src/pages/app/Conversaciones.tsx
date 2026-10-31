import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, cop, descargar, fecha, fechaHora, guardar, hace, hora, leer } from '../../api';
import { Escritura, Menu, useSesion } from '../../components/Layout';
import { Campo, Cargando, Confirmar, ErrorCarga, Estado, Modal, Recibo, Tarjeta, useAccion, useApi, useRetardo, useToast, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { TextoWhatsApp } from '../../components/Markdown';
import { Bienvenida, ConfigConversaciones, useNumeroConectado } from './ConversacionesConfig';

/** Qué resolvió la IA en cada conversación (una línea; no pide nada). */
const RESOLVIO: Record<string, string> = {
  crear_cita: 'La IA agendó una cita', reprogramar_cita: 'La IA reprogramó una cita', cancelar_cita: 'La IA canceló una cita', registrar_venta: 'La IA registró una venta',
  generar_enlace_pago: 'La IA envió un enlace de pago', reenviar_comprobante: 'La IA reenvió un comprobante', unirse_lista_espera: 'La IA lo anotó en la lista de espera', enviar_imagen_producto: 'La IA envió la foto de un producto',
};
const REGLA: Record<string, string> = { PIDE_PERSONA: 'Pidió una persona', QUEJA: 'Queja', PAGOS: 'Pagos o reembolso', URGENCIA: 'Urgencia', SIN_SOLUCION: 'La IA no pudo resolverlo', MONTO: 'Venta grande' };
const FILTROS: [string, string][] = [['persona', 'Necesitan a una persona'], ['todas', 'Todas'], ['escaladas', 'Con una persona'], ['cola', 'En cola'], ['mias', 'Mías'], ['ia', 'IA al frente'], ['cerradas', 'Cerradas']];
const PRIORIDADES = ['BAJA', 'MEDIA', 'ALTA', 'URGENTE'];
const ENTREGA: Record<string, string> = { PENDIENTE: 'enviando…', ENVIADO: 'enviado', ENTREGADO: 'entregado', LEIDO: 'leído', SIMULADO: 'simulado', FALLIDO: 'no entregado' };
const MARCA_ENTREGA: Record<string, string> = { ENVIADO: '✓', ENTREGADO: '✓✓', LEIDO: '✓✓' };
/** En pantallas táctiles Enter salta de línea (el teclado no tiene Shift a mano); con teclado físico, envía. */
const tactil = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/** Color estable por persona (tono derivado del nombre): ayuda a reconocer a cada cliente en la bandeja. */
const tono = (s: string) => { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
export function Avatar({ nombre, grande }: { nombre: string; grande?: boolean }) {
  const ini = nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return <span className={`cv-avatar ${grande ? 'grande' : ''}`} style={{ ['--h' as any]: tono(nombre) }} aria-hidden="true">{ini || '?'}</span>;
}

/**
 * Bandeja de conversaciones: espacio de trabajo a pantalla completa. Lista a la izquierda, el chat al
 * centro (lo más grande) y los detalles del cliente y del radicado en un panel que se pliega. En el
 * teléfono, la lista y el chat ocupan cada uno la pantalla entera.
 */
/** Decide qué ver: bienvenida (sin número ni conversaciones), configuración o la bandeja. */
export function Conversaciones() {
  const [params, setParams] = useSearchParams();
  const conectado = useNumeroConectado();
  const previas = useApi<any>(() => (conectado ? Promise.resolve(null) : api.get('/api/t/conversaciones?filtro=persona')), [conectado]);
  if (params.get('vista') === 'config') return <ConfigConversaciones onVolver={() => setParams({}, { replace: true })} />;
  if (!conectado) {
    if (!previas.data && !previas.error) return <div className="contenido"><Cargando filas={4} /></div>;
    if ((previas.data?.contadores?.todas ?? 0) === 0) return <Bienvenida />;
  }
  return <Bandeja sinNumero={!conectado} onConfig={() => setParams({ vista: 'config' })} />;
}

function Bandeja({ sinNumero, onConfig }: { sinNumero: boolean; onConfig: () => void }) {
  const { puede } = useSesion();
  const { id } = useParams();
  const nav = useNavigate();
  const [filtro, setFiltro] = useState('persona');
  const [q, setQ] = useState('');
  const qr = useRetardo(q);
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/conversaciones?filtro=${filtro}${qr ? `&q=${encodeURIComponent(qr)}` : ''}`), [filtro, qr], { cada: 6000 });
  const [detalles, setDetalles] = useState(() => leer('cv-detalles') !== '0');
  const alternar = () => setDetalles((v) => { guardar('cv-detalles', v ? '0' : '1'); return !v; });
  const lista: any[] = data?.conversaciones ?? [];
  const cont = data?.contadores ?? {};
  return (
    <div className={`cv-ventana ${id ? 'con-chat' : ''} ${detalles ? 'con-detalles' : ''}`}>
      <aside className="cv-lista" aria-label="Bandeja de conversaciones">
        <header className="cv-lista-cab">
          <div className="cv-lista-titulo">
            <h1>Conversaciones</h1>
            {puede('tenant:configure') && <button type="button" className="btn peq sutil" onClick={onConfig} aria-label="Configuración de Conversaciones" title="Configuración"><Icon n="configuracion" className="" size={14} />Configuración</button>}
            {cont.escaladas > 0 && <span className="cv-alerta" title="Esperan a una persona"><i />{cont.escaladas}</span>}
          </div>
          {sinNumero && puede('tenant:configure') && <button type="button" className="aviso" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={onConfig}><Icon n="alerta" className="" size={16} /><span>No hay un número de WhatsApp conectado. <b>Conéctalo</b> para recibir mensajes nuevos.</span></button>}
          <label className="cv-buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Buscar nombre, teléfono o radicado" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar conversaciones" /></label>
          <div className="cv-filtros" role="group" aria-label="Filtrar conversaciones">
            {FILTROS.map(([k, v]) => (
              <button key={k} type="button" className={filtro === k ? 'on' : ''} aria-pressed={filtro === k} onClick={() => setFiltro(k)}>
                {v}{cont[k] !== undefined && <span className="n">{cont[k]}</span>}
              </button>
            ))}
          </div>
        </header>
        <div className="cv-filas-wrap">
          {error ? <div className="cv-pad"><ErrorCarga error={error} reintentar={recargar} /></div> : !data ? <Cargando filas={7} /> : lista.length === 0 ? (
            <div className="cv-pad"><Vacio titulo={qr ? 'Nada coincide con la búsqueda' : 'No hay conversaciones en esta vista'}>{qr ? 'Busca por nombre, teléfono o radicado.' : filtro === 'persona' ? 'Tu asistente está atendiendo todo: nada espera por ti. Mira «Todas» para ver lo que resolvió.' : filtro === 'todas' ? 'Cuando un cliente escriba por WhatsApp, su conversación aparecerá aquí.' : 'Prueba con otro filtro.'}</Vacio></div>
          ) : (
            <ul className="cv-filas">
              {lista.map((c, i) => {
                const sel = c.id === id;
                const nuevo = c.sin_leer && !sel;
                return (
                  <li key={c.id} style={{ ['--i' as any]: Math.min(i, 14) }}>
                    <Link to={`/conversaciones/${c.id}`} className={`cv-fila ${sel ? 'sel' : ''} ${nuevo ? 'sin-leer' : ''} ${c.estado === 'ESCALADA' ? 'escalada' : ''}`} aria-current={sel ? 'page' : undefined} data-guia={i === 0 ? 'conv/fila' : undefined}>
                      <span className="cv-fila-av"><Avatar nombre={c.cliente} />{c.control === 'AI' && c.estado !== 'CERRADA' && <span className="cv-av-ia" title="La IA está al frente"><Icon n="ia" className="" size={10} /></span>}</span>
                      <span className="cv-fila-txt">
                        <span className="cv-fila-l1"><b className="cortar">{c.cliente}</b><time dateTime={c.actualizado_en}>{hace(c.actualizado_en)}</time></span>
                        <span className="cv-fila-l2"><span className="cortar">{c.ultimo ?? 'Sin mensajes'}</span>{nuevo && <i className="cv-punto" aria-label="Sin leer" />}</span>
                        <span className="cv-fila-l3">
                          {c.estado === 'CERRADA' ? <span className="cv-chip gris">Cerrada</span> : c.control === 'AI' ? <span className="cv-chip ia"><Icon n="ia" className="" size={11} />IA</span> : <span className="cv-chip persona"><Icon n="persona" className="" size={11} />{c.asignado ?? 'Sin asignar'}</span>}
                          {c.radicado && c.estado_caso !== 'CERRADO' && <span className="cv-chip mono">{c.radicado}</span>}
                          {c.regla && c.control === 'HUMANO' && c.estado !== 'CERRADA' && <span className="cv-chip persona">{REGLA[c.regla] ?? c.regla}</span>}
                          <Sla c={c} mini />
                        </span>
                        {c.ia_resolvio && <span className="cv-fila-l4 tenue peq-txt">{RESOLVIO[c.ia_resolvio] ?? 'La IA resolvió una solicitud'}</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {id ? <Detalle key={id} id={id} onCambio={recargar} volver={() => nav('/conversaciones')} detalles={detalles} alternarDetalles={alternar} /> : (
        <section className="cv-chat cv-sin-chat" aria-label="Ninguna conversación abierta">
          <div className="cv-elige">
            <span className="cv-elige-ico" aria-hidden="true"><i /><i /><Icon n="conversaciones" className="" size={30} /></span>
            <h2>Elige una conversación</h2>
            <p>Lee el hilo completo, responde por WhatsApp y deja notas para tu equipo, todo desde aquí.</p>
            {data && <div className="cv-elige-cifras">
              <span><b>{cont.todas ?? 0}</b>en total</span>
              <span className={cont.escaladas ? 'urgente' : ''}><b>{cont.escaladas ?? 0}</b>esperan a una persona</span>
              <span><b>{cont.ia ?? 0}</b>las atiende la IA</span>
            </div>}
          </div>
        </section>
      )}
    </div>
  );
}

function Sla({ c, mini }: { c: any; mini?: boolean }) {
  const caso = c.caso ?? c;
  const estado = caso.estado_caso ?? caso.estado;
  if (!caso.sla_vence_en || estado === 'CERRADO') return null;
  if (caso.primera_respuesta_en) return mini ? null : <Estado v="EXITO" texto="Respondido" />;
  const min = Math.round((new Date(caso.sla_vence_en).getTime() - Date.now()) / 60000);
  if (mini) return <span className={`cv-chip ${min < 0 ? 'vencido' : 'reloj'}`}><Icon n="reloj" className="" size={11} />{min < 0 ? `−${-min} min` : `${min} min`}</span>;
  return min < 0 ? <Estado v="RECHAZADO" texto={`Sin respuesta hace ${-min} min`} /> : <Estado v="PENDIENTE" texto={`Responder en ${min} min`} />;
}

const ACCION_CASO: Record<string, string> = { crear: 'Se creó el radicado', tomar: 'Lo tomó', reasignar: 'Se reasignó', prioridad: 'Cambió la prioridad', responder: 'Primera respuesta', cerrar: 'Se cerró', reabrir: 'Se reabrió', devolver_ia: 'Se devolvió a la IA' };
const ROL_BURBUJA: Record<string, [string, string]> = { cliente: ['Cliente', 'persona'], ia: ['Agente IA', 'ia'], humano: ['Equipo', 'persona'], nota: ['Nota interna', 'nota'], sistema: ['Sistema', 'info'] };

function tipoDe(m: any): string {
  if (m.tipo === 'NOTA_INTERNA') return 'nota';
  return m.remitente === 'CUSTOMER' ? 'cliente' : m.remitente === 'AI' ? 'ia' : m.remitente === 'HUMAN' ? 'humano' : 'sistema';
}
const diaDe = (iso: string) => new Date(iso).toLocaleDateString('en-CA');
function etiquetaDia(iso: string) {
  const d = diaDe(iso);
  const hoy = new Date().toLocaleDateString('en-CA');
  const ayer = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
  return d === hoy ? 'Hoy' : d === ayer ? 'Ayer' : fecha(iso);
}

/** Detalle: el asesor entra al mismo hilo; la IA pasa a asistirlo. */
function Detalle({ id, onCambio, volver, detalles, alternarDetalles }: { id: string; onCambio: () => void; volver: () => void; detalles: boolean; alternarDetalles: () => void }) {
  const { puede, s } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/conversaciones/${id}`), [id], { cada: 4000 });
  const [texto, setTexto] = useState('');
  const [nota, setNota] = useState(false);
  const [cerrar, setCerrar] = useState(false);
  const [reabrir, setReabrir] = useState(false);
  const [reasignar, setReasignar] = useState(false);
  const [plantilla, setPlantilla] = useState<any>(null);
  const [compartir, setCompartir] = useState(false);
  const [panelMovil, setPanelMovil] = useState(false);
  const [nuevos, setNuevos] = useState(false);
  // Propuesta del copiloto: se revisa antes de usarla; nunca se envía sola.
  const [propuesta, setPropuesta] = useState<null | { tipo: 'sugerencia' | 'mejora'; texto: string; nota?: string; detalle: string[]; original?: string }>(null);
  const [pensando, setPensando] = useState<null | 'sugerencia' | 'mejora'>(null);
  const [anterior, setAnterior] = useState<string | null>(null);
  const navegar = useNavigate();
  const { run, ocupado } = useAccion();
  const scroll = useRef<HTMLDivElement>(null);
  const campo = useRef<HTMLTextAreaElement>(null);
  const pegado = useRef(true);
  const vistos = useRef(0);
  const total = (data?.mensajes?.length ?? 0) + (data?.ejecuciones?.length ?? 0);

  // El hilo baja solo si la persona estaba al final; si está leyendo arriba, aparece «Mensajes nuevos».
  useLayoutEffect(() => {
    const el = scroll.current;
    if (!el || !total) return;
    if (pegado.current || vistos.current === 0) el.scrollTop = el.scrollHeight;
    else if (total > vistos.current) setNuevos(true);
    vistos.current = total;
  }, [total]);
  const alDesplazar = () => {
    const el = scroll.current;
    if (!el) return;
    pegado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    if (pegado.current) setNuevos(false);
  };
  const alFinal = () => { const el = scroll.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); pegado.current = true; setNuevos(false); };
  useEffect(() => {
    const el = campo.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [texto]);
  useEffect(() => { setPropuesta(null); setAnterior(null); }, [nota]);

  if (error) return <section className="cv-chat"><div className="cv-pad"><button className="btn sutil solo-movil" onClick={volver}><Icon n="atras" className="" size={16} />Bandeja</button><ErrorCarga error={error} reintentar={recargar} /></div></section>;
  if (!data) return <section className="cv-chat"><div className="cv-pad"><Cargando filas={8} /></div></section>;

  const eventos = [
    ...data.mensajes.map((m: any) => ({ t: 'm', at: m.creado_en, m })),
    ...data.ejecuciones.filter((e: any) => e.decision !== 'PERMITIDA' || !['consultar_catalogo', 'consultar_precio', 'mis_citas'].includes(e.herramienta)).map((e: any) => ({ t: 'e', at: e.creado_en, e })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const caso = data.caso;
  const casoAbierto = caso && caso.estado !== 'CERRADO';
  const nombre = data.cliente.split(' ')[0];
  const accion = async (fn: () => Promise<any>, ok: string) => { const r = await run(fn, ok); if (r) { recargar(); onCambio(); } return r; };
  const enviar = async () => {
    if (!texto.trim() || ocupado) return;
    const r = await accion(() => api.post(`/api/t/conversaciones/${id}/${nota ? 'nota' : 'responder'}`, { texto }), nota ? 'Nota interna guardada' : 'Mensaje enviado');
    if (r) { setTexto(''); pegado.current = true; }
  };
  const teclas = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && !tactil())) { e.preventDefault(); enviar(); }
  };
  const sugerir = async () => {
    setPropuesta(null); setPensando('sugerencia');
    const r = await run(() => api.post(`/api/t/conversaciones/${id}/sugerencia`));
    setPensando(null);
    if (r?.sugerencia) setPropuesta({ tipo: 'sugerencia', texto: r.sugerencia, nota: r.intencion, detalle: r.datos_usados ?? [] });
  };
  const mejorar = async () => {
    if (texto.trim().length < 2) return;
    setPropuesta(null); setPensando('mejora');
    const r = await run(() => api.post(`/api/t/conversaciones/${id}/mejorar`, { texto }));
    setPensando(null);
    if (r?.texto) setPropuesta({ tipo: 'mejora', texto: r.texto, detalle: r.cambios ?? [], original: texto });
  };
  const usarPropuesta = () => {
    if (!propuesta) return;
    setAnterior(propuesta.tipo === 'mejora' ? propuesta.original ?? null : texto || null);
    setTexto(propuesta.texto); setPropuesta(null);
    if (!tactil()) requestAnimationFrame(() => campo.current?.focus());
  };
  const puedeResponder = puede('conversation:reply') && !s.solo_lectura;
  const ventanaCerrada = data.canal === 'WHATSAPP' && !data.ventana_abierta;

  // Acción principal visible; las demás en el menú «Más acciones».
  const tomar = casoAbierto && (!caso.asignado_a || caso.asignado_a === s.usuario.id) && !caso.tomado_en && puede('case:manage');
  const pasar = data.control === 'AI' && data.estado !== 'CERRADA' && puede('case:create');
  const secundarias: { t: string; i: string; f: () => void; peligro?: boolean }[] = [];
  if (casoAbierto && puede('case:supervise')) secundarias.push({ t: 'Reasignar o cambiar prioridad', i: 'persona', f: () => setReasignar(true) });
  if (data.control === 'HUMANO' && data.estado !== 'CERRADA' && puede('case:manage')) secundarias.push({ t: 'Devolver a la IA', i: 'ia', f: () => accion(() => api.post(`/api/t/conversaciones/${id}/devolver-ia`), 'La IA vuelve a atender') });
  if (data.puede_reabrir && !casoAbierto && puede('case:manage')) secundarias.push({ t: 'Reabrir radicado', i: 'reloj', f: () => setReabrir(true) });
  // Casos extremos: la empresa comparte esta conversación con el soporte de Omnegia (solo lectura, con plazo).
  if (data.soporte && !data.soporte.acceso) secundarias.push({ t: 'Pedir ayuda a Omnegia', i: 'soporte', f: () => setCompartir(true) });
  if (data.soporte?.acceso) secundarias.push({ t: 'Retirar el acceso de Omnegia', i: 'candado', f: () => accion(() => api.post(`/api/t/conversaciones/${id}/acceso-soporte/revocar`), 'Acceso retirado: soporte ya no puede leerla') });
  if (!data.soporte) secundarias.push({ t: 'Pedir ayuda a soporte de Omnegia', i: 'soporte', f: () => navegar('/soporte') });
  if (data.estado !== 'CERRADA' && puede('case:manage')) secundarias.push({ t: 'Cerrar conversación', i: 'ok', f: () => setCerrar(true), peligro: true });

  let diaPrevio = '';
  const estadoTxt = data.estado === 'CERRADA' ? 'Cerrada' : data.control === 'AI' ? 'La IA está al frente' : caso?.asignado ? `Atiende ${caso.asignado}` : 'Espera a una persona';

  return (
    <>
      <section className="cv-chat" aria-label={`Conversación con ${data.cliente}`}>
        <header className="cv-chat-cab">
          <button className="cv-icono solo-movil" onClick={volver} aria-label="Volver a la bandeja"><Icon n="atras" className="" size={20} /></button>
          <Avatar nombre={data.cliente} grande />
          <div className="cv-chat-quien">
            <h2 className="cortar">{data.cliente}</h2>
            <span className="cv-chat-sub"><i className={`cv-estado-punto ${data.estado === 'CERRADA' ? 'gris' : data.control === 'AI' ? 'ia' : 'persona'}`} />{estadoTxt}<span className="cv-sep">·</span><span className="mono">{data.telefono}</span></span>
          </div>
          <div className="cv-chat-acciones">
            {tomar && <button className="btn peq primario" disabled={ocupado || s.solo_lectura} onClick={() => accion(() => api.post(`/api/t/casos/${caso.id}/tomar`), 'Radicado asignado a ti')}><Icon n="persona" className="" size={14} /><span className="cv-ocultable">{caso.asignado_a ? 'Aceptar' : 'Tomar'}</span></button>}
            {!tomar && pasar && <button className="btn peq" disabled={ocupado || s.solo_lectura} onClick={() => accion(() => api.post(`/api/t/conversaciones/${id}/escalar`, { motivo: 'Intervención manual desde el panel', prioridad: 'MEDIA' }), 'La conversación pasó a una persona')}><Icon n="persona" className="" size={14} /><span className="cv-ocultable">Pasar a una persona</span></button>}
            {secundarias.length > 0 && (
              <Menu boton={(abrir, abierto) => <button className="cv-icono" onClick={abrir} aria-expanded={abierto} aria-haspopup="menu" aria-label="Más acciones"><Icon n="puntos" className="" size={20} /></button>}>
                {(cerrarMenu) => <>{tomar && pasar && <button className="opcion" role="menuitem" onClick={() => { cerrarMenu(); accion(() => api.post(`/api/t/conversaciones/${id}/escalar`, { motivo: 'Intervención manual desde el panel', prioridad: 'MEDIA' }), 'La conversación pasó a una persona'); }}><Icon n="persona" className="" size={16} />Pasar a una persona</button>}
                  {secundarias.map((a) => <button key={a.t} className={`opcion ${a.peligro ? 'peligro' : ''}`} role="menuitem" onClick={() => { cerrarMenu(); a.f(); }}><Icon n={a.i} className="" size={16} />{a.t}</button>)}</>}
              </Menu>
            )}
            <button className={`cv-icono cv-btn-detalles ${detalles ? 'on' : ''}`} onClick={() => { if (window.matchMedia('(max-width: 1280px)').matches) setPanelMovil(true); else alternarDetalles(); }} aria-label={detalles ? 'Ocultar detalles' : 'Ver detalles'} aria-pressed={detalles}><Icon n="info" className="" size={18} /></button>
          </div>
        </header>

        {caso && (
          <div className={`cv-franja ${casoAbierto ? '' : 'cerrada'}`} aria-label="Radicado">
            <span className="mono">{caso.radicado}</span>
            <Estado v={caso.estado} />
            <span className={`cv-prioridad p-${caso.prioridad.toLowerCase()}`}>Prioridad {caso.prioridad.toLowerCase()}</span>
            <span className="cv-franja-quien">{caso.asignado ? <><Icon n="persona" className="" size={12} />{caso.asignado}</> : 'Sin responsable'}</span>
            <Sla c={{ caso }} />
          </div>
        )}

        {data.soporte?.acceso && (
          <div className="cv-compartida" role="status"><Icon n="compartir" className="" size={13} /><span>Soporte de Omnegia está ayudando{data.soporte.acceso.ticket_numero ? ` (${data.soporte.acceso.ticket_numero})` : ''} · {data.soporte.acceso.puede_responder ? 'puede leer y responder al cliente' : 'solo lectura'} hasta el {fechaHora(data.soporte.acceso.expira_en)}</span>
            <button type="button" onClick={() => accion(() => api.post(`/api/t/conversaciones/${id}/acceso-soporte/revocar`), 'Acceso retirado: soporte ya no puede leerla')}>Retirar</button></div>
        )}
        <div className="cv-hilo-scroll" ref={scroll} onScroll={alDesplazar}>
          <div className="cv-hilo" aria-live="polite" aria-relevant="additions">
            {eventos.map((ev: any) => {
              const dia = diaDe(ev.at);
              const separador = dia !== diaPrevio ? <div className="cv-dia" key={`d-${dia}`}><span>{etiquetaDia(ev.at)}</span></div> : null;
              diaPrevio = dia;
              if (ev.t === 'e') return <Fragment key={ev.e.id}>{separador}<div className="cv-recibo"><Recibo e={ev.e} compacto /></div></Fragment>;
              const m = ev.m;
              if (m.remitente === 'SYSTEM' && m.tipo === 'NOTA_INTERNA') return <Fragment key={m.id}>{separador}<div className="cv-evento"><Icon n="info" className="" size={13} />{m.contenido}<span>{hora(m.creado_en)}</span></div></Fragment>;
              const soporte = m.metadatos?.soporte_omnegia === true;
              const tipo = tipoDe(m);
              const [rolTxt, rolIco] = ROL_BURBUJA[tipo];
              const autor = soporte ? `Soporte de Omnegia${m.metadatos?.operador ? ` · ${m.metadatos.operador}` : ''}` : tipo === 'humano' || tipo === 'nota' ? m.autor : tipo === 'ia' ? 'Agente IA' : null;
              const fallo = m.estado_entrega === 'FALLIDO';
              return (
                <Fragment key={m.id}>
                  {separador}
                  <div className={`cv-msg ${tipo} ${soporte ? 'soporte' : ''} ${fallo ? 'fallo' : ''}`}>
                    {(autor || m.tipo === 'PLANTILLA' || tipo === 'sistema') && <span className="cv-msg-autor"><Icon n={rolIco} className="" size={11} />{m.tipo === 'PLANTILLA' ? 'Plantilla' : autor ?? rolTxt}</span>}
                    <div className="cv-burbuja">
                      {m.tipo === 'MEDIA' && m.metadatos?.imagen ? <figure className="cv-imagen"><img src={m.metadatos.imagen} alt={m.contenido ?? 'Imagen enviada'} loading="lazy" /><figcaption className="tenue peq-txt">{m.contenido}</figcaption></figure> : m.tipo === 'MEDIA' ? <Archivo m={m} conv={id} /> : <TextoWhatsApp texto={m.contenido ?? ''} />}
                      <span className="cv-msg-meta">
                        {hora(m.creado_en)}
                        {m.estado_entrega !== 'N/A' && tipo !== 'cliente' && <span className={`cv-entrega e-${String(m.estado_entrega).toLowerCase()}`} title={ENTREGA[m.estado_entrega] ?? m.estado_entrega}>{MARCA_ENTREGA[m.estado_entrega] ?? (fallo ? '!' : m.estado_entrega === 'SIMULADO' ? '◦' : '…')}</span>}
                      </span>
                    </div>
                    {fallo && <span className="cv-msg-error">No se entregó{m.error_entrega ? `: ${m.error_entrega}` : ''}</span>}
                    {tipo === 'nota' && <span className="cv-msg-nota-pie">Solo la ve el equipo</span>}
                  </div>
                </Fragment>
              );
            })}
            {data.pendientes.map((p: any) => <div key={p.id} className="cv-recibo"><div className="recibo pendiente"><span className="ic"><Icon n="reloj" className="" size={14} /></span><span className="que">Esperando que el cliente confirme: <b>{p.resumen}</b></span><Estado v="PENDIENTE_CONFIRMACION" /></div></div>)}
          </div>
        </div>
        {nuevos && <button type="button" className="cv-nuevos" onClick={alFinal}><Icon n="abajo" className="" size={14} />Mensajes nuevos</button>}

        {data.estado === 'CERRADA' ? (
          <div className="cv-composer cv-composer-info"><Icon n="ok" className="" size={15} />Conversación cerrada. Si el cliente vuelve a escribir, la IA retoma este mismo hilo.</div>
        ) : !puedeResponder ? (
          <div className="cv-composer cv-composer-info"><Icon n="candado" className="" size={15} />{s.solo_lectura ? 'Suscripción suspendida: puedes leer el hilo, pero no responder.' : 'Tu rol puede leer esta conversación, pero no responder.'}</div>
        ) : (
          <div className={`cv-composer ${nota ? 'nota' : ''}`} data-guia="conv/composer">
            <div className="cv-modos" role="group" aria-label="Tipo de mensaje">
              <button type="button" className={!nota ? 'on' : ''} aria-pressed={!nota} onClick={() => setNota(false)}><Icon n="enviar" className="" size={13} />Responder a {nombre}</button>
              <button type="button" className={nota ? 'on' : ''} aria-pressed={nota} onClick={() => setNota(true)}><Icon n="nota" className="" size={13} />Nota interna</button>
              {puede('ai:assist') && !nota && !ventanaCerrada && (
                <span className="cv-ia-botones">
                  {texto.trim().length >= 2 && <button type="button" className="cv-ia-btn" disabled={!!pensando} onClick={mejorar} title="Corrige y vuelve más amable lo que escribiste, sin cambiar lo que dice"><Icon n="editar" className="" size={13} />Mejorar redacción</button>}
                  <button type="button" className="cv-ia-btn" disabled={!!pensando} onClick={sugerir} title="Propone una respuesta con los datos de tu negocio"><Icon n="ia" className="" size={13} />Sugerir respuesta</button>
                </span>
              )}
            </div>
            {(pensando || propuesta) && (
              <div className={`cv-propuesta ${pensando ? 'cargando' : ''}`} role="status" aria-live="polite">
                <div className="cv-propuesta-cab">
                  <span className="cv-propuesta-ico" aria-hidden="true"><Icon n={(pensando ?? propuesta?.tipo) === 'mejora' ? 'editar' : 'ia'} className="" size={14} /></span>
                  <b>{(pensando ?? propuesta?.tipo) === 'mejora' ? 'Redacción mejorada' : 'Respuesta sugerida'}</b>
                  {propuesta?.nota && <span className="cv-propuesta-nota">Entendí: {propuesta.nota}</span>}
                  {!pensando && <button type="button" className="cv-propuesta-x" onClick={() => setPropuesta(null)} aria-label="Descartar"><Icon n="x" className="" size={14} /></button>}
                </div>
                {pensando ? (
                  <div className="cv-propuesta-brillo"><i /><i /><i /><span>{pensando === 'mejora' ? `Puliendo tu mensaje para ${nombre}…` : 'Leyendo la conversación, el radicado y tu catálogo…'}</span></div>
                ) : propuesta && <>
                  <p className="cv-propuesta-texto">{propuesta.texto}</p>
                  {propuesta.detalle.length > 0 && <div className="cv-propuesta-datos"><span>{propuesta.tipo === 'mejora' ? 'Cambios:' : 'Con base en:'}</span>{propuesta.detalle.map((d) => <i key={d}>{d}</i>)}</div>}
                  <div className="cv-propuesta-acciones">
                    <button type="button" className="btn peq primario" onClick={usarPropuesta}><Icon n="ok" className="" size={14} />Usar este texto</button>
                    {propuesta.tipo === 'sugerencia' ? <button type="button" className="btn peq" onClick={sugerir}>Otra opción</button> : <button type="button" className="btn peq" onClick={mejorar}>Otra versión</button>}
                    <span className="tenue peq-txt">Revísalo antes de enviar: no sale hasta que tú lo envíes.</span>
                  </div>
                </>}
              </div>
            )}
            {ventanaCerrada && !nota ? (
              <div className="cv-ventana-24">
                <p><Icon n="reloj" className="" size={14} />Pasaron más de 24 horas desde el último mensaje de {nombre}. WhatsApp solo permite escribirle con una plantilla aprobada.</p>
                <div className="cv-plantillas">{data.plantillas.map((p: any) => <button key={p.clave} type="button" className="chip" onClick={() => setPlantilla(p)}>{p.clave.replace(/_/g, ' ')}{p.estado_aprobacion !== 'APROBADA' && ' · sin aprobar'}</button>)}</div>
              </div>
            ) : (
              <div className="cv-caja">
                <textarea ref={campo} rows={1} value={texto} maxLength={4000} onChange={(e) => { setTexto(e.target.value); setAnterior(null); }} onKeyDown={teclas}
                  placeholder={nota ? 'Nota visible solo para el equipo…' : `Escribe a ${nombre}…`} aria-label={nota ? 'Nota interna' : `Respuesta a ${data.cliente}`} />
                <button type="button" className="cv-enviar" data-guia="conv/enviar" disabled={ocupado || !texto.trim()} onClick={enviar} aria-label={nota ? 'Guardar nota' : 'Enviar'}><Icon n={nota ? 'nota' : 'enviar'} className="" size={18} /></button>
              </div>
            )}
            <span className="cv-composer-pie">{nota ? 'El cliente no recibe la nota.' : data.control === 'AI' ? 'Al responder, tomas la conversación: la IA deja de contestar y queda un radicado a tu nombre.' : `Sale por ${data.canal === 'WHATSAPP' ? 'WhatsApp' : 'el canal web'} desde este hilo.`}{!tactil() && <span className="cv-teclas"> · Enter envía · Shift + Enter salta de línea</span>}
              {anterior !== null && <button type="button" className="cv-deshacer" onClick={() => { setTexto(anterior); setAnterior(null); }}>Deshacer</button>}</span>
          </div>
        )}
      </section>

      <aside className={`cv-detalles ${panelMovil ? 'abierto' : ''}`} aria-label="Detalles de la conversación">
        <header className="cv-detalles-cab">
          <b>Detalles</b>
          <button className="cv-icono" onClick={() => { setPanelMovil(false); if (!window.matchMedia('(max-width: 1280px)').matches) alternarDetalles(); }} aria-label="Cerrar detalles"><Icon n="x" className="" size={18} /></button>
        </header>
        <div className="cv-detalles-cuerpo">
          <div className="cv-perfil">
            <Avatar nombre={data.cliente} grande />
            <b>{data.cliente}</b>
            <span className="mono tenue">{data.telefono}</span>
            <span>{data.consentimiento_en ? <Estado v="EXITO" texto="Autorizó el tratamiento de datos" /> : <Estado v="PENDIENTE" texto="Sin autorización de datos" />}</span>
            <Link to={`/clientes?id=${data.customer_id}`} className="btn peq">Ver ficha del cliente</Link>
          </div>
          <dl className="cv-datos">
            <dt>Correo</dt><dd>{data.email ?? <span className="tenue">Sin correo</span>}</dd>
            <dt>Documento</dt><dd>{data.numero_documento ? <span className="mono">{data.tipo_documento} {data.numero_documento}</span> : 'Consumidor final'}</dd>
            <dt>Canal</dt><dd>{data.canal === 'WHATSAPP' ? 'WhatsApp' : 'Web'}</dd>
          </dl>
          {caso && (
            <section className="cv-bloque">
              <h3><span className="mono">{caso.radicado}</span><Estado v={caso.estado} /></h3>
              <dl className="cv-datos">
                <dt>Motivo</dt><dd>{caso.motivo}</dd>
                <dt>Prioridad</dt><dd>{caso.prioridad.toLowerCase()}</dd>
                <dt>Responder antes</dt><dd>{fecha(caso.sla_vence_en)} {hora(caso.sla_vence_en)}</dd>
                <dt>Responsable</dt><dd>{caso.asignado ?? 'Nadie (en cola)'}</dd>
                {caso.motivo_cierre && <><dt>Cierre</dt><dd>{caso.motivo_cierre}</dd></>}
              </dl>
              {caso.resumen_ia && <div className="resumen-copiloto"><span className="rol"><Icon n="ia" className="" size={12} />Resumen del copiloto · propuesta, no decisión</span>{caso.resumen_ia}</div>}
              {data.historial?.length > 0 && (
                <details className="historial-caso">
                  <summary>Historial del radicado ({data.historial.length})</summary>
                  <ol>{data.historial.map((h: any, i: number) => <li key={i}><span className="peq-txt"><b>{ACCION_CASO[h.accion] ?? h.accion}</b>{h.asignado && h.accion !== 'prioridad' ? ` · ${h.asignado}` : ''}{h.detalle?.a && h.accion === 'prioridad' ? ` · ${String(h.detalle.a).toLowerCase()}` : ''}</span><span className="tenue peq-txt">{h.actor_nombre} · {fecha(h.creado_en)} {hora(h.creado_en)}</span></li>)}</ol>
                </details>
              )}
            </section>
          )}
          {data.ventas.length > 0 && (
            <section className="cv-bloque">
              <h3>Compras recientes</h3>
              <div className="lista">{data.ventas.map((v: any) => <Link key={v.id} to={`/ventas/${v.id}`} className="lista-fila"><span className="mono">#{v.numero}</span><span className="num">{cop(v.total)}</span><Estado v={v.estado_fiscal} /></Link>)}</div>
            </section>
          )}
          {data.citas.length > 0 && (
            <section className="cv-bloque">
              <h3>Citas</h3>
              <div className="lista">{data.citas.map((c: any) => <div key={c.id} className="lista-fila"><span className="peq-txt" style={{ whiteSpace: 'nowrap' }}>{fecha(c.inicio)} {hora(c.inicio)}</span><span className="tenue cortar">{c.servicio}</span><Estado v={c.estado} /></div>)}</div>
            </section>
          )}
          {data.soporte && <SoporteOmnegia soporte={data.soporte} onCompartir={() => setCompartir(true)} onRetirar={() => accion(() => api.post(`/api/t/conversaciones/${id}/acceso-soporte/revocar`), 'Acceso retirado: soporte ya no puede leerla')} ocupado={ocupado} />}
        </div>
      </aside>
      {panelMovil && <div className="cv-velo" onClick={() => setPanelMovil(false)} aria-hidden="true" />}

      {cerrar && <Confirmar titulo="Cerrar conversación" riesgo="confirmable" pedirMotivo efecto={<>Se cerrará {caso && casoAbierto ? <>el radicado <span className="id">{caso.radicado}</span> y </> : ''}la conversación. Si el cliente vuelve a escribir, la IA retoma el mismo hilo.</>}
        textoBoton="Cerrar conversación" onCerrar={() => setCerrar(false)} onConfirmar={async (motivo) => { setCerrar(false); await accion(() => api.post(`/api/t/conversaciones/${id}/cerrar`, { motivo }), 'Conversación cerrada'); }} />}
      {reabrir && caso && <Confirmar titulo={`Reabrir ${caso.radicado}`} riesgo="confirmable" pedirMotivo efecto={<>El radicado vuelve a {caso.asignado ?? 'ti'} y la IA deja de responder en este hilo.</>}
        textoBoton="Reabrir" onCerrar={() => setReabrir(false)} onConfirmar={async (motivo) => { setReabrir(false); await accion(() => api.post(`/api/t/casos/${caso.id}/reabrir`, { motivo }), 'Radicado reabierto'); }} />}
      {reasignar && caso && <Reasignar caso={caso} onCerrar={() => setReasignar(false)} onHecho={() => { setReasignar(false); recargar(); onCambio(); }} />}
      {plantilla && <EnviarPlantilla conv={id} p={plantilla} cliente={nombre} onCerrar={() => setPlantilla(null)} onHecho={() => { setPlantilla(null); recargar(); }} />}
      {compartir && <CompartirConSoporte conv={id} cliente={data.cliente} onCerrar={() => setCompartir(false)} onHecho={() => { setCompartir(false); recargar(); }} />}
    </>
  );
}

/**
 * El soporte de Omnegia no puede leer las conversaciones de la empresa (la base de datos se lo impide).
 * Quien administra puede compartir UNA conversación por un tiempo limitado; cada lectura queda registrada.
 */
function SoporteOmnegia({ soporte, onCompartir, onRetirar, ocupado }: { soporte: any; onCompartir: () => void; onRetirar: () => void; ocupado: boolean }) {
  const a = soporte.acceso;
  const lecturas: string[] = soporte.lecturas ?? [];
  return (
    <Tarjeta titulo="Soporte de Omnegia" acciones={a ? <Estado v="PENDIENTE" texto={a.puede_responder ? 'Puede responder' : 'Solo lectura'} /> : <Estado v="CERRADA" texto="Privada" />}>
      <div className="col" style={{ gap: 10 }}>
        {a ? <>
          <span className="peq-txt">{a.puede_responder ? <>Soporte puede leer esta conversación y responderle al cliente hasta el <b>{fechaHora(a.expira_en)}</b>. No puede cambiar nada más.</> : <>Soporte puede leer esta conversación hasta el <b>{fechaHora(a.expira_en)}</b>. No puede responder al cliente ni cambiar nada.</>}</span>
          <dl className="datos-def">
            <dt>Motivo</dt><dd>{a.motivo}</dd>
            {a.ticket_numero && <><dt>Solicitud</dt><dd className="mono">{a.ticket_numero}</dd></>}
            <dt>Autorizó</dt><dd>{a.otorgado_por_nombre} · {fechaHora(a.creado_en)}</dd>
          </dl>
          <Escritura permiso="tenant:configure"><button className="btn peq peligro" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={onRetirar}>Retirar acceso ahora</button></Escritura>
        </> : <>
          <span className="peq-txt sec">El equipo de Omnegia no puede leer tus conversaciones. En un caso difícil, pide ayuda: compartes solo esta, por un tiempo limitado, y eliges si soporte puede responder.</span>
          <Escritura permiso="tenant:configure"><button className="btn peq" style={{ alignSelf: 'flex-start' }} onClick={onCompartir}><Icon n="soporte" className="" size={14} />Pedir ayuda a Omnegia</button></Escritura>
        </>}
        {lecturas.length > 0 && <span className="tenue peq-txt">Soporte la abrió {lecturas.length === 1 ? 'una vez' : `${lecturas.length} veces`}; la última {hace(lecturas[0])}.</span>}
      </div>
    </Tarjeta>
  );
}

function CompartirConSoporte({ conv, cliente, onCerrar, onHecho }: { conv: string; cliente: string; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState({ motivo: '', horas: 24, ticket: '', responder: true });
  const [conTicket, setConTicket] = useState(false);
  const { run, ocupado, error } = useAccion();
  const toast = useToast();
  const ticketValido = !f.ticket.trim() || /^SOP-\d{6}$/i.test(f.ticket.trim());
  const listo = f.motivo.trim().length >= 10 && ticketValido;
  const enviar = async () => {
    const r = await run(() => api.post(`/api/t/conversaciones/${conv}/acceso-soporte`, { motivo: f.motivo.trim(), horas: f.horas, ticket: conTicket ? f.ticket.trim() || null : null, responder: f.responder }), undefined, { silencioso: true });
    if (r) { toast(r.ticket ? `Listo: solicitud ${r.ticket} enviada a Omnegia` : 'Conversación compartida con soporte'); onHecho(); }
  };
  return (
    <Modal titulo="Pedir ayuda a Omnegia" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || !listo} onClick={enviar}><Icon n="soporte" className="" size={15} />{ocupado ? 'Enviando…' : 'Pedir ayuda'}</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <p className="sec" style={{ margin: 0 }}>El equipo de Omnegia recibe tu solicitud y la conversación con {cliente}. Solo esta conversación y solo mientras dure el plazo; puedes retirar el acceso cuando quieras.</p>
      <Campo etiqueta="¿Qué necesitas que haga soporte?"><textarea className="input" value={f.motivo} maxLength={300} onChange={(e) => setF({ ...f, motivo: e.target.value })} placeholder="Ej.: el cliente reclama un cobro doble y no sé cómo resolverlo; ayúdenme a responderle" /></Campo>
      <div className="op-permiso" role="radiogroup" aria-label="Qué puede hacer soporte">
        <button type="button" role="radio" aria-checked={f.responder} className={f.responder ? 'on' : ''} onClick={() => setF({ ...f, responder: true })}>
          <Icon n="conversaciones" className="" size={18} /><b>Leer y responder</b><span>Soporte puede escribirle al cliente por tu WhatsApp. Sus mensajes se ven en el hilo como «Soporte de Omnegia».</span>
        </button>
        <button type="button" role="radio" aria-checked={!f.responder} className={!f.responder ? 'on' : ''} onClick={() => setF({ ...f, responder: false })}>
          <Icon n="candado" className="" size={18} /><b>Solo leer</b><span>Soporte revisa la conversación y te orienta, pero no le escribe al cliente.</span>
        </button>
      </div>
      <div className="grid g2">
        <Campo etiqueta="Por cuánto tiempo"><select className="input" value={f.horas} onChange={(e) => setF({ ...f, horas: Number(e.target.value) })}><option value={24}>24 horas</option><option value={72}>3 días</option><option value={168}>7 días</option></select></Campo>
        <Campo etiqueta="Solicitud" ayuda={conTicket ? 'usa una que ya abriste' : 'se crea una nueva'} error={ticketValido ? undefined : 'Tiene la forma SOP-000123.'}>
          {conTicket ? <input className="input mono" value={f.ticket} maxLength={10} onChange={(e) => setF({ ...f, ticket: e.target.value.toUpperCase() })} placeholder="SOP-000123" />
            : <button type="button" className="btn" style={{ width: '100%' }} onClick={() => setConTicket(true)}>Ya tengo una solicitud</button>}
        </Campo>
      </div>
      <span className="tenue peq-txt">Cada vez que soporte abra o responda esta conversación quedará en la auditoría de tu empresa.</span>
    </Modal>
  );
}

function Archivo({ m, conv }: { m: any; conv: string }) {
  const media = m.metadatos?.media ?? {};
  const etiqueta: Record<string, string> = { image: 'Imagen', audio: 'Audio', video: 'Video', document: 'Documento', sticker: 'Sticker' };
  const [error, setError] = useState('');
  return (
    <span className="col" style={{ gap: 6 }}>
      <span className="fila" style={{ gap: 6 }}><Icon n="subir" className="" size={14} /><b>{etiqueta[media.tipo] ?? 'Archivo'} recibido</b>{media.nombreArchivo && <span className="tenue cortar">{media.nombreArchivo}</span>}</span>
      {media.leyenda && <span>{media.leyenda}</span>}
      <button type="button" className="btn peq" style={{ alignSelf: 'flex-start' }} onClick={() => descargar(`/api/t/conversaciones/${conv}/archivos/${m.id}`, media.nombreArchivo ?? `archivo-${m.id.slice(-6)}`).catch((e) => setError(e.message))}>Descargar</button>
      {error && <span className="error peq-txt" role="alert">{error}</span>}
    </span>
  );
}

function Reasignar({ caso, onCerrar, onHecho }: { caso: any; onCerrar: () => void; onHecho: () => void }) {
  const asesores = useApi<any[]>(() => api.get('/api/t/asesores'), []);
  const [usuario, setUsuario] = useState(caso.asignado_a ?? '');
  const [prioridad, setPrioridad] = useState(caso.prioridad);
  const { run, ocupado } = useAccion();
  const guardar = async () => {
    let ok = true;
    if (usuario && usuario !== caso.asignado_a) ok = !!(await run(() => api.post(`/api/t/casos/${caso.id}/reasignar`, { user_id: usuario }), 'Responsable actualizado'));
    if (ok && prioridad !== caso.prioridad) ok = !!(await run(() => api.post(`/api/t/casos/${caso.id}/prioridad`, { prioridad }), 'Prioridad actualizada'));
    if (ok) onHecho();
  };
  return (
    <Modal titulo={`Responsable y prioridad · ${caso.radicado}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado} onClick={guardar}>Guardar</button></>}>
      <Campo etiqueta="Responsable">{!asesores.data ? <Cargando filas={1} /> : (
        <select className="input" value={usuario} onChange={(e) => setUsuario(e.target.value)}>
          <option value="" disabled>Elige…</option>
          {asesores.data.map((a) => <option key={a.id} value={a.id}>{a.nombre} · {a.carga} abiertos{a.disponible ? '' : ' · no disponible'}</option>)}
        </select>)}
      </Campo>
      <Campo etiqueta="Prioridad" ayuda="cambia el tiempo de respuesta esperado"><select className="input" value={prioridad} onChange={(e) => setPrioridad(e.target.value)}>{PRIORIDADES.map((p) => <option key={p} value={p}>{p.charAt(0) + p.slice(1).toLowerCase()}</option>)}</select></Campo>
    </Modal>
  );
}

function EnviarPlantilla({ conv, p, cliente, onCerrar, onHecho }: { conv: string; p: any; cliente: string; onCerrar: () => void; onHecho: () => void }) {
  const [vars, setVars] = useState<Record<string, string>>(() => Object.fromEntries((p.variables as string[]).map((k) => [k, k === 'cliente' ? cliente : ''])));
  const { run, ocupado } = useAccion();
  const vista = String(p.cuerpo).replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => vars[k] || `[${k}]`);
  const listo = (p.variables as string[]).every((k) => vars[k]?.trim());
  return (
    <Modal titulo="Enviar plantilla" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !listo} onClick={async () => { const r = await run(() => api.post(`/api/t/conversaciones/${conv}/plantilla`, { clave: p.clave, variables: vars }), 'Plantilla en camino'); if (r) onHecho(); }}>Enviar</button></>}>
      {p.estado_aprobacion !== 'APROBADA' && <div className="aviso peq-txt"><Icon n="alerta" className="" size={14} /><span>Esta plantilla no está registrada como aprobada en Meta: fuera de la ventana de 24 h WhatsApp la rechazará. Regístrala en Configuración › WhatsApp.</span></div>}
      {(p.variables as string[]).map((k) => <Campo key={k} etiqueta={k.charAt(0).toUpperCase() + k.slice(1)}><input className="input" value={vars[k] ?? ''} maxLength={200} onChange={(e) => setVars({ ...vars, [k]: e.target.value })} /></Campo>)}
      <div className="col" style={{ gap: 4 }}><span className="etiqueta">Así le llega</span><div className="vista-plantilla">{vista}</div></div>
    </Modal>
  );
}
