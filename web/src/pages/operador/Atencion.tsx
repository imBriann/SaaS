import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fecha, fechaHora, hace, hora } from '../../api';
import { Cabecera } from '../../components/Layout';
import { Campo, Cargando, Cifra, ErrorCarga, Estado, Mensaje, Modal, Tarjeta, useAccion, useApi, useRetardo, Vacio, type TipoMensaje } from '../../components/ui';
import { Icon } from '../../components/icons';
import { TextoWhatsApp } from '../../components/Markdown';
import { Contador, escalon } from '../../components/Movimiento';
import { ESTADO_TICKET, useYo } from './Operador';

/**
 * Atención por WhatsApp en el panel del operador.
 *
 *  - «Conversaciones»: lo que escriben al número de Omnegia. Son conversaciones de Omnegia: el equipo las
 *    lee completas. Abrir una queda en la auditoría porque muestra el número completo.
 *  - «Atención de las empresas»: solo cifras de cada negocio. El texto de una conversación de una empresa
 *    se lee únicamente si la empresa la compartió con soporte, y cada lectura queda en ambas auditorías.
 * Todas las acciones las valida el servidor (permiso, responsable, ventana de 24 horas de WhatsApp).
 */
const VISTAS: [string, string][] = [
  ['activas', 'Activas'], ['pendientes', 'Por responder'], ['sin_asignar', 'Sin responsable'], ['mias', 'Mías'],
  ['ia', 'Con el asistente'], ['cerradas', 'Cerradas'], ['todas', 'Todas'],
];
const ENTREGA: Record<string, string> = { PENDIENTE: 'enviando…', ENVIADO: 'enviado', ENTREGADO: 'entregado', LEIDO: 'leído', SIMULADO: 'simulado (no salió a WhatsApp)', FALLIDO: 'no entregado' };
const TEMA: Record<string, string> = { ACCESO: 'Acceso a la cuenta', SUSCRIPCION: 'Pagos y suscripción', WHATSAPP: 'Conectar WhatsApp', PLANES: 'Planes y precios', FUNCIONES: 'Qué incluye Omnegia', ALTA: 'Crear una cuenta', DATOS: 'Datos y privacidad', IA: 'Inteligencia artificial', OTRO: 'Otro tema' };
const ACCION_HISTORIAL: Record<string, string> = {
  'plataforma.conversacion.abrir': 'La abrió', 'plataforma.conversacion.tomar': 'La tomó', 'plataforma.conversacion.asignar': 'La asignó',
  'plataforma.conversacion.responder': 'Respondió', 'plataforma.conversacion.nota': 'Dejó una nota', 'plataforma.conversacion.devolver_ia': 'La devolvió al asistente',
  'plataforma.conversacion.cerrar': 'La cerró', 'plataforma.conversacion.derivada': 'El asistente la pasó a una persona',
};

const espera = (min: number) => (min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} d`);

function FilaConversacion({ c, sel, compacta }: { c: any; sel?: boolean; compacta?: boolean }) {
  const empresa = c.empresa ? (c.varias_empresas ? `${c.empresa} y otras` : c.empresa) : c.varias_empresas ? 'Varias empresas' : null;
  return (
    <Link to={`/operador/conversaciones/${c.id}`} className={`conv-fila ${sel ? 'sel' : ''} ${c.pendiente ? 'pendiente' : ''}`} aria-current={sel ? 'page' : undefined}>
      <span className="conv-quien"><b className="cortar">{c.pendiente && <span className="pulso" aria-hidden="true" />}{c.nombre || c.telefono}</b><span className="tenue peq-txt">{c.ultimo_mensaje_en ? hace(c.ultimo_mensaje_en) : ''}</span></span>
      <span className="conv-ultimo cortar">{c.ultimo_de === 'ASISTENTE' ? 'Asistente: ' : c.ultimo_de === 'OPERADOR' ? 'Equipo: ' : ''}{c.ultimo ?? 'Sin mensajes'}</span>
      <span className="conv-estado">
        {c.pendiente && <Estado v="PENDIENTE" texto={c.espera_min != null ? `Espera hace ${espera(c.espera_min)}` : 'Por responder'} />}
        {c.estado === 'CERRADA' ? <Estado v="CERRADA" /> : <Estado v={c.control} />}
        {c.asignado && <span className="estado info"><Icon n="persona" className="" />{c.asignado}</span>}
        {c.fallidos > 0 && <Estado v="FALLIDO" texto={`${c.fallidos} sin entregar`} />}
      </span>
      {!compacta && <span className="conv-caso">{c.ticket && <span className="id">{c.ticket}</span>}<span className="tenue peq-txt mono">{c.telefono}</span>{empresa && <span className="tenue peq-txt">{empresa}</span>}</span>}
    </Link>
  );
}

export function OpConversaciones() {
  const { id } = useParams();
  const nav = useNavigate();
  const [vista, setVista] = useState('activas');
  const [empresa, setEmpresa] = useState('');
  const [responsable, setResponsable] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [q, setQ] = useState('');
  const qr = useRetardo(q);
  const qs = new URLSearchParams({ vista, ...(empresa ? { empresa } : {}), ...(responsable ? { responsable } : {}), ...(desde ? { desde } : {}), ...(hasta ? { hasta } : {}), ...(qr ? { q: qr } : {}) }).toString();
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/operador/conversaciones?${qs}`), [qs], { cada: 8000 });
  const hayFiltros = !!(empresa || responsable || desde || hasta || qr);
  const vacio = <Vacio titulo={hayFiltros ? 'Nada coincide con los filtros' : 'No hay conversaciones en esta vista'}>{hayFiltros ? 'Prueba con otros filtros.' : vista === 'pendientes' ? 'Nadie está esperando una respuesta del equipo.' : 'Cuando alguien escriba al WhatsApp de Omnegia, aparecerá aquí.'}</Vacio>;
  const lista = (compacta: boolean) => !data ? <Cargando /> : data.conversaciones.length === 0 ? vacio : (
    <ul className={`lista-conv entra-escalonado ${compacta ? 'compacta' : ''}`} aria-label="Conversaciones">
      {data.conversaciones.map((c: any, i: number) => <li key={c.id} style={escalon(i)}><FilaConversacion c={c} sel={c.id === id} compacta={compacta} /></li>)}
    </ul>
  );
  return (
    <>
      {!id && (
        <Cabecera titulo="Conversaciones de WhatsApp" sub="Lo que escriben al número de Omnegia. El asistente responde primero y pasa a una persona lo que no puede resolver.">
          <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Nombre, número o solicitud" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar conversaciones" /></label>
        </Cabecera>
      )}
      {error && <ErrorCarga error={error} reintentar={recargar} />}
      {!id ? (
        <section className="tarjeta" hidden={!!error}>
          <div className="filtros">
            <div className="tabs" role="group" aria-label="Vista">
              {VISTAS.map(([k, v]) => <button key={k} className={vista === k ? 'on' : ''} aria-pressed={vista === k} onClick={() => setVista(k)}>{v}{data?.contadores?.[k] !== undefined && <span className={k === 'pendientes' && data.contadores[k] > 0 ? 'cont-alerta' : 'tenue'}> {data.contadores[k]}</span>}</button>)}
            </div>
            <div className="fila envolver op-filtros-conv">
              <select className="input" value={empresa} onChange={(e) => setEmpresa(e.target.value)} aria-label="Empresa relacionada"><option value="">Todas las empresas</option>{data?.empresas?.map((e: any) => <option key={e.id} value={e.id}>{e.nombre}</option>)}</select>
              <select className="input" value={responsable} onChange={(e) => setResponsable(e.target.value)} aria-label="Responsable"><option value="">Cualquier responsable</option><option value="nadie">Sin responsable</option>{data?.equipo?.map((p: any) => <option key={p.id} value={p.id}>{p.nombre}</option>)}</select>
              <label className="fila peq-txt" style={{ gap: 6 }}>Desde<input className="input peq" type="date" value={desde} max={hasta || undefined} onChange={(e) => setDesde(e.target.value)} /></label>
              <label className="fila peq-txt" style={{ gap: 6 }}>Hasta<input className="input peq" type="date" value={hasta} min={desde || undefined} onChange={(e) => setHasta(e.target.value)} /></label>
              {hayFiltros && <button className="btn peq sutil" onClick={() => { setEmpresa(''); setResponsable(''); setDesde(''); setHasta(''); setQ(''); }}>Quitar filtros</button>}
            </div>
          </div>
          {lista(false)}
        </section>
      ) : (
        <div className="bandeja-detalle con-detalle" hidden={!!error}>
          <section className="tarjeta bandeja-lista" aria-label="Bandeja">
            <div className="filtros">
              <select className="input" value={vista} onChange={(e) => setVista(e.target.value)} aria-label="Vista">
                {VISTAS.map(([k, v]) => <option key={k} value={k}>{v}{data?.contadores?.[k] !== undefined ? ` (${data.contadores[k]})` : ''}</option>)}
              </select>
            </div>
            {lista(true)}
          </section>
          <DetalleConversacion id={id} onCambio={recargar} volver={() => nav('/operador/conversaciones')} />
        </div>
      )}
    </>
  );
}

function tipoDe(m: any): TipoMensaje | null {
  if (m.tipo === 'NOTA_INTERNA') return m.autor ? 'nota' : null;
  return m.remitente === 'CLIENTE' ? 'cliente' : m.remitente === 'ASISTENTE' ? 'ia' : m.remitente === 'OPERADOR' ? 'humano' : 'sistema';
}

function DetalleConversacion({ id, onCambio, volver }: { id: string; onCambio: () => void; volver: () => void }) {
  const { yo, puede } = useYo();
  // La primera carga de cada conversación se registra en la auditoría («abrir»); las recargas no.
  const abierta = useRef<string | null>(null);
  const { data, error, recargar } = useApi<any>(() => {
    const abrir = abierta.current !== id;
    abierta.current = id;
    return api.get(`/api/operador/conversaciones/${id}${abrir ? '?abrir=1' : ''}`);
  }, [id], { cada: 5000 });
  const [texto, setTexto] = useState('');
  const [nota, setNota] = useState(false);
  const [cerrar, setCerrar] = useState(false);
  const [asignar, setAsignar] = useState(false);
  const { run, ocupado } = useAccion();
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [data?.mensajes?.length]);
  useEffect(() => { setTexto(''); setNota(false); }, [id]);
  if (error) return <div className="col"><button className="btn sutil solo-movil" onClick={volver}><Icon n="atras" className="" size={16} />Bandeja</button><ErrorCarga error={error} reintentar={recargar} /></div>;
  if (!data) return <section className="tarjeta"><Cargando filas={8} /></section>;

  const cerrada = data.estado === 'CERRADA';
  const mia = data.asignado_a === yo.id;
  const deOtro = !!data.asignado_a && !mia;
  const admin = yo.rol === 'ADMIN';
  const atender = puede('conversaciones:atender');
  // Si la atiende otra persona, solo administración puede escribirle al cliente; los demás dejan notas.
  const soloNotas = deOtro && !admin;
  const esNota = nota || soloNotas || !data.ventana_abierta;
  const nombre = data.nombre ? String(data.nombre).split(' ')[0] : 'la persona';
  const accion = async (fn: () => Promise<any>, ok: string) => { const r = await run(fn, ok); if (r) { recargar(); onCambio(); } return r; };
  const enviar = async () => {
    if (!texto.trim()) return;
    const r = await accion(() => api.post(`/api/operador/conversaciones/${id}/responder`, { texto, nota: esNota }), esNota ? 'Nota interna guardada' : 'Mensaje en camino por WhatsApp');
    if (r) setTexto('');
  };

  return (
    <div className="detalle-conv">
      <section className="tarjeta panel-hilo" aria-label={`Conversación con ${data.nombre ?? data.telefono}`}>
        <div className="cab">
          <button className="btn sutil peq icono solo-movil" onClick={volver} aria-label="Volver a la bandeja"><Icon n="atras" className="" size={18} /></button>
          <div className="conv-cab-txt">
            <h1 className="titulo-tarjeta" style={{ fontSize: 17 }}>{data.nombre ?? 'Sin nombre de perfil'}</h1>
            <span className="tenue"><span className="mono">{data.telefono}</span> · WhatsApp de Omnegia{data.tema ? ` · ${TEMA[data.tema] ?? data.tema}` : ''}</span>
          </div>
          <span className="fila envolver" style={{ marginLeft: 'auto', gap: 6 }}>
            {cerrada ? <Estado v="CERRADA" /> : data.control === 'AI' ? <span className="fila" style={{ gap: 8 }}><span className="pulso ia" aria-hidden="true" /><Estado v="AI" texto="El asistente está al frente" /></span> : <Estado v="HUMANO" texto={data.asignado ? `Atiende ${data.asignado}` : 'Espera a una persona'} />}
          </span>
          {data.ticket && (
            <div className="caso-franja" aria-label="Solicitud de soporte">
              <span className="id">{data.ticket.numero}</span><Estado v={data.ticket.estado} texto={ESTADO_TICKET[data.ticket.estado]} />
              <span className="peq-txt">Prioridad {String(data.ticket.prioridad).toLowerCase()}</span>
              <span className="peq-txt">{data.asignado ? `Responsable: ${data.asignado}` : 'Sin responsable'}</span>
            </div>
          )}
          {atender && !cerrada && (
            <div className="fila envolver acciones-conv">
              {!mia && (!data.asignado_a || admin) && <button className="btn peq primario" disabled={ocupado} onClick={() => accion(() => api.post(`/api/operador/conversaciones/${id}/tomar`), 'Ahora la atiendes tú: el asistente deja de responder')}><Icon n="persona" className="" size={14} />{data.asignado_a ? 'Tomarla yo' : 'Tomar'}</button>}
              {puede('conversaciones:asignar') && <button className="btn peq" disabled={ocupado} onClick={() => setAsignar(true)}>Asignar</button>}
              {data.control === 'HUMANO' && <button className="btn peq" disabled={ocupado} onClick={() => accion(() => api.post(`/api/operador/conversaciones/${id}/devolver-ia`), 'El asistente vuelve a atender')}><Icon n="ia" className="" size={14} />Devolver al asistente</button>}
              <button className="btn peq sutil" onClick={() => setCerrar(true)}>Cerrar</button>
            </div>
          )}
        </div>
        <div className="hilo-scroll">
          <div className="hilo" aria-live="polite" aria-relevant="additions">
            {data.mensajes.length === 0 && <Vacio titulo="Sin mensajes" />}
            {data.mensajes.map((m: any) => {
              const tipo = tipoDe(m);
              if (!tipo) return <div key={m.id} className="evento-sistema"><Icon n="info" className="" size={13} /> {m.contenido} · {hora(m.creado_en)}</div>;
              const quien = tipo === 'cliente' ? data.nombre ?? undefined : tipo === 'humano' || tipo === 'nota' ? m.autor : undefined;
              const rol = tipo === 'ia' ? 'Asistente de Omnegia' : tipo === 'humano' ? 'Equipo de Omnegia' : undefined;
              const entrega = m.estado_entrega !== 'N/A' ? (
                <span className={m.estado_entrega === 'FALLIDO' ? 'entrega-fallo' : ''}>{ENTREGA[m.estado_entrega] ?? m.estado_entrega}{m.estado_entrega === 'FALLIDO' && m.error_entrega ? `: ${m.error_entrega}` : ''}</span>
              ) : tipo === 'nota' ? 'Solo la ve el equipo' : undefined;
              return (
                <Mensaje key={m.id} tipo={tipo} quien={quien} rol={rol} hora={`${fecha(m.creado_en)} ${hora(m.creado_en)}`} meta={entrega}>
                  {m.tipo === 'MEDIA' || m.tipo === 'NO_SOPORTADO' ? <span className="tenue">{m.contenido || 'Archivo o mensaje que WhatsApp no permite leer aquí.'}</span> : <TextoWhatsApp texto={m.contenido ?? ''} />}
                </Mensaje>
              );
            })}
            <div ref={fin} />
          </div>
        </div>
        {cerrada ? (
          <div className="composer"><span className="tenue peq-txt fila"><Icon n="ok" className="" size={14} />Conversación cerrada{data.motivo_cierre ? `: ${data.motivo_cierre}` : ''}. Si la persona vuelve a escribir, se reabre con el asistente.</span></div>
        ) : !atender ? (
          <div className="composer"><span className="tenue peq-txt fila"><Icon n="candado" className="" size={14} />Tu rol puede leer esta conversación, pero no responder.</span></div>
        ) : (
          <div className={`composer ${esNota ? 'nota' : ''}`}>
            <div className="fila entre envolver" style={{ gap: 8 }}>
              <div className="tabs" role="group" aria-label="Tipo de mensaje">
                <button type="button" className={!esNota ? 'on' : ''} aria-pressed={!esNota} disabled={soloNotas || !data.ventana_abierta} onClick={() => setNota(false)}>Responder a {nombre}</button>
                <button type="button" className={esNota ? 'on' : ''} aria-pressed={esNota} onClick={() => setNota(true)}><Icon n="nota" className="" size={13} /> Nota interna</button>
              </div>
            </div>
            {!data.ventana_abierta && <div className="aviso peq-txt"><Icon n="reloj" className="" size={14} /><span>Pasaron más de 24 horas desde el último mensaje de {nombre}: WhatsApp no permite escribirle con texto libre. Deja una nota, o escríbele por correo si dejó uno en su solicitud.</span></div>}
            {soloNotas && data.ventana_abierta && <div className="aviso peq-txt"><Icon n="persona" className="" size={14} /><span>La atiende {data.asignado}. Puedes dejar una nota interna; para escribirle a {nombre}, pide que te la asignen.</span></div>}
            <textarea className="input" value={texto} maxLength={4000} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!ocupado) enviar(); } }}
              placeholder={esNota ? 'Nota visible solo para el equipo de Omnegia' : `Escribe a ${nombre}. Sale por WhatsApp desde el número de Omnegia. Nunca pidas contraseñas ni códigos.`} aria-label={esNota ? 'Nota interna' : `Respuesta a ${nombre}`} />
            <div className="fila entre envolver" style={{ gap: 8 }}>
              <span className="tenue peq-txt ayuda-composer" style={{ maxWidth: '60ch' }}>{esNota ? 'La persona no recibe la nota.' : data.control === 'AI' ? 'Al responder tomas la conversación: el asistente deja de contestar.' : 'Ctrl + Enter para enviar.'}</span>
              <button className="btn primario" style={{ marginLeft: 'auto' }} disabled={ocupado || !texto.trim()} onClick={enviar}><Icon n={esNota ? 'nota' : 'enviar'} className="" size={14} /> {esNota ? 'Guardar nota' : 'Enviar'}</button>
            </div>
          </div>
        )}
      </section>

      <div className="col contexto-conv" style={{ gap: 16 }}>
        {data.ticket && (
          <Tarjeta titulo={<span className="id">{data.ticket.numero}</span>} acciones={<Link className="btn sutil peq" to={`/operador/soporte/${data.ticket.id}`}>Ver solicitud</Link>}>
            <dl className="datos-def">
              <dt>Asunto</dt><dd>{data.ticket.asunto}</dd>
              <dt>Estado</dt><dd><Estado v={data.ticket.estado} texto={ESTADO_TICKET[data.ticket.estado]} /></dd>
              <dt>Abierta</dt><dd>{fechaHora(data.ticket.creado_en)}</dd>
              {data.escalada_en && <><dt>Pasó a una persona</dt><dd>{fechaHora(data.escalada_en)}</dd></>}
              {data.primera_respuesta_humana_en && <><dt>Primera respuesta</dt><dd>{fechaHora(data.primera_respuesta_humana_en)}</dd></>}
            </dl>
          </Tarjeta>
        )}
        <Tarjeta titulo="Empresas relacionadas">
          {data.empresas.length === 0 ? <span className="tenue peq-txt">El número no figura como contacto de ninguna empresa.</span> : (
            <div className="col" style={{ gap: 8 }}>
              <ul className="lista" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.empresas.map((e: any) => <li key={e.id} className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><Link to={`/operador/empresas/${e.id}`} className="cortar">{e.nombre}</Link><span className="mono tenue peq-txt">{e.slug}</span></li>)}
              </ul>
              <span className="tenue peq-txt">Relación por el teléfono de contacto: no prueba quién escribe. El asistente no le revela estos nombres a la persona.</span>
            </div>
          )}
        </Tarjeta>
        {data.tickets_anteriores?.length > 0 && (
          <Tarjeta titulo="Solicitudes anteriores">
            <ul className="lista" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {data.tickets_anteriores.map((t: any) => <li key={t.id} className="lista-fila" style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto' }}><Link className="mono" to={`/operador/soporte/${t.id}`}>{t.numero}</Link><span className="cortar tenue">{t.asunto}</span><Estado v={t.estado} texto={ESTADO_TICKET[t.estado]} /></li>)}
            </ul>
          </Tarjeta>
        )}
        <Tarjeta titulo="Historial">
          {data.historial.length === 0 ? <span className="tenue peq-txt">Sin acciones registradas.</span> : (
            <ol className="historial-op">
              {data.historial.slice(-30).map((h: any, i: number) => (
                <li key={i}><b className="peq-txt">{ACCION_HISTORIAL[h.accion] ?? h.accion}</b><span className="tenue peq-txt">{h.actor?.includes('@') ? h.actor : 'Asistente de Omnegia'} · {fechaHora(h.fecha)}</span>{h.motivo && <span className="peq-txt sec">{h.motivo}</span>}</li>
              ))}
            </ol>
          )}
          <p className="tenue peq-txt" style={{ marginTop: 8 }}>Abrir la conversación también queda registrado.</p>
        </Tarjeta>
      </div>

      {asignar && <Asignar conv={data} onCerrar={() => setAsignar(false)} onHecho={() => { setAsignar(false); recargar(); onCambio(); }} />}
      {cerrar && <Cerrar conv={data} onCerrar={() => setCerrar(false)} onHecho={() => { setCerrar(false); recargar(); onCambio(); }} />}
    </div>
  );
}

function Asignar({ conv, onCerrar, onHecho }: { conv: any; onCerrar: () => void; onHecho: () => void }) {
  const [quien, setQuien] = useState<string>(conv.asignado_a ?? '');
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo="Asignar la conversación" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || quien === (conv.asignado_a ?? '')} onClick={async () => { const r = await run(() => api.post(`/api/operador/conversaciones/${conv.id}/asignar`, { user_id: quien || null }), 'Responsable actualizado', { silencioso: true }); if (r) onHecho(); }}>Guardar</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <Campo etiqueta="Responsable"><select className="input" value={quien} onChange={(e) => setQuien(e.target.value)}><option value="">Sin responsable (queda en la cola)</option>{conv.equipo.map((p: any) => <option key={p.id} value={p.id}>{p.nombre} · {p.rol === 'ADMIN' ? 'Administración' : 'Soporte'}</option>)}</select></Campo>
      <span className="tenue peq-txt">Al asignarla, el asistente deja de responder: una persona queda al frente.</span>
    </Modal>
  );
}

function Cerrar({ conv, onCerrar, onHecho }: { conv: any; onCerrar: () => void; onHecho: () => void }) {
  const [motivo, setMotivo] = useState('');
  const [resolver, setResolver] = useState(!!conv.ticket && !['RESUELTO', 'CERRADO'].includes(conv.ticket.estado));
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo="Cerrar la conversación" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Volver</button>
      <button className="btn primario" disabled={ocupado || motivo.trim().length < 5} onClick={async () => { const r = await run(() => api.post(`/api/operador/conversaciones/${conv.id}/cerrar`, { motivo: motivo.trim(), resolver_solicitud: resolver }), 'Conversación cerrada', { silencioso: true }); if (r) onHecho(); }}>Cerrar</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <p className="sec" style={{ margin: 0 }}>No se le envía nada a la persona. Si vuelve a escribir, la conversación se reabre y la atiende el asistente.</p>
      <Campo etiqueta="Motivo" ayuda="queda en el historial"><textarea className="input" rows={3} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej.: recuperó el acceso con el enlace del correo" /></Campo>
      {conv.ticket && !['RESUELTO', 'CERRADO'].includes(conv.ticket.estado) && <label className="fila"><input type="checkbox" checked={resolver} onChange={(e) => setResolver(e.target.checked)} /> Marcar la solicitud <span className="mono">{conv.ticket.numero}</span> como resuelta</label>}
    </Modal>
  );
}

// ------------------------------------------------------------------ atención de las empresas
export function OpAtencionEmpresas() {
  const { puede } = useYo();
  const [empresa, setEmpresa] = useState('');
  const [vencidos, setVencidos] = useState(false);
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/operador/atencion-empresas?${empresa ? `empresa=${empresa}&` : ''}${vencidos ? 'vencidos=1' : ''}`), [empresa, vencidos], { cada: 30000 });
  // La lista del selector sale de la vista sin filtrar (con un filtro, el servidor devuelve solo esa empresa).
  const [todas, setTodas] = useState<{ id: string; nombre: string }[]>([]);
  useEffect(() => { if (!empresa && data?.empresas) setTodas(data.empresas.map((e: any) => ({ id: e.id, nombre: e.nombre })).sort((a: any, b: any) => a.nombre.localeCompare(b.nombre))); }, [data, empresa]);
  const leer = puede('atencion:leer_autorizadas');
  return (
    <>
      <Cabecera titulo="Atención de las empresas" sub="Cómo atienden los negocios a sus clientes por WhatsApp: solo cifras. El texto de una conversación se ve únicamente si la empresa la comparte con soporte.">
        <select className="input" value={empresa} onChange={(e) => setEmpresa(e.target.value)} aria-label="Empresa"><option value="">Todas las empresas</option>{todas.map((e) => <option key={e.id} value={e.id}>{e.nombre}</option>)}</select>
      </Cabecera>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={6} /> : (
        <div className="col" style={{ gap: 16 }}>
          <div className="kpis">
            <Cifra etiqueta="Conversaciones abiertas" valor={<Contador valor={data.totales.abiertas} />} />
            <Cifra etiqueta="Con una persona" valor={<Contador valor={data.totales.con_persona} />} />
            <Cifra etiqueta="Radicados sin respuesta" valor={<Contador valor={data.totales.sin_respuesta} />} detalle={data.totales.vencidos ? <span className="error">{data.totales.vencidos} con el tiempo vencido</span> : 'ninguno vencido'} />
            <Cifra etiqueta="Mensajes sin entregar (48 h)" valor={<Contador valor={data.totales.fallidos_48h} />} />
          </div>
          <Tarjeta titulo="Por empresa" sinCuerpo>
            {!data.empresas.length ? <div className="cuerpo"><Vacio titulo="Sin empresas" /></div> : (
              <div className="tabla-wrap"><table className="tabla tabla-movil">
                <thead><tr><th>Empresa</th><th>WhatsApp</th><th className="num">Abiertas</th><th className="num">Con IA</th><th className="num">Con persona</th><th className="num">Sin respuesta</th><th className="num">Vencidos</th><th className="num">Sin entregar 48 h</th><th>Última actividad</th></tr></thead>
                <tbody className="entra-escalonado">{data.empresas.map((e: any, i: number) => (
                  <tr key={e.id} style={escalon(i)}>
                    <td data-etiqueta="Empresa" className="principal"><Link to={`/operador/empresas/${e.id}`}>{e.nombre}</Link></td>
                    <td data-etiqueta="WhatsApp"><Estado v={e.whatsapp_estado} /></td>
                    <td data-etiqueta="Abiertas" className="num">{e.abiertas}</td><td data-etiqueta="Con IA" className="num">{e.con_ia}</td><td data-etiqueta="Con persona" className="num">{e.con_persona}</td>
                    <td data-etiqueta="Sin respuesta" className="num">{e.sin_respuesta}</td>
                    <td data-etiqueta="Vencidos" className="num">{e.vencidos ? <span className="estado err">{e.vencidos}</span> : 0}</td>
                    <td data-etiqueta="Sin entregar 48 h" className="num">{e.fallidos_48h ? <span className="estado warn">{e.fallidos_48h}</span> : 0}</td>
                    <td data-etiqueta="Última actividad">{e.ultima_actividad ? hace(e.ultima_actividad) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Tarjeta>
          <Tarjeta titulo="Radicados sin primera respuesta" acciones={<label className="fila peq-txt" style={{ gap: 6 }}><input type="checkbox" checked={vencidos} onChange={(e) => setVencidos(e.target.checked)} /> Solo vencidos</label>} sinCuerpo>
            {!data.radicados.length ? <div className="cuerpo"><Vacio titulo={vencidos ? 'Ningún radicado vencido' : 'Todos los radicados tienen respuesta'} /></div> : (
              <div className="tabla-wrap"><table className="tabla tabla-movil">
                <thead><tr><th>Empresa</th><th>Radicado</th><th>Prioridad</th><th>Estado</th><th>Responsable</th><th>Responder antes de</th><th><span className="sr">Lectura</span></th></tr></thead>
                <tbody>{data.radicados.map((k: any) => (
                  <tr key={k.id}>
                    <td data-etiqueta="Empresa" className="principal">{k.empresa}</td>
                    <td data-etiqueta="Radicado"><span className="id">{k.radicado}</span></td>
                    <td data-etiqueta="Prioridad"><Estado v={k.prioridad} /></td>
                    <td data-etiqueta="Estado"><Estado v={k.estado} /></td>
                    <td data-etiqueta="Responsable">{k.asignado ? 'Asignado' : <span className="tenue">En cola</span>}</td>
                    <td data-etiqueta="Responder antes de">{k.vencido ? <Estado v="RECHAZADO" texto={`Venció ${hace(k.sla_vence_en)}`} /> : fechaHora(k.sla_vence_en)}</td>
                    <td data-etiqueta="Lectura">{k.acceso_hasta && leer ? <Link className="btn peq" to={`/operador/atencion/conversaciones/${k.conversation_id}`}>Leer (compartida)</Link> : <span className="tenue peq-txt">Privada</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Tarjeta>
          <Tarjeta titulo="Conversaciones compartidas con soporte">
            {!data.accesos.length ? <span className="tenue peq-txt">Ninguna empresa ha compartido conversaciones. Se hace desde su panel: Conversaciones › Soporte de Omnegia › Compartir con soporte.</span> : (
              <ul className="lista" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {data.accesos.map((a: any) => (
                  <li key={a.id} className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                    <span className="col" style={{ gap: 2, minWidth: 0 }}><b>{a.empresa}</b><span className="peq-txt sec">{a.motivo}</span><span className="tenue peq-txt">Autorizó {a.otorgado_por_nombre}{a.ticket_numero ? ` · ${a.ticket_numero}` : ''} · vence {fechaHora(a.expira_en)}</span></span>
                    {leer && <Link className="btn peq" to={`/operador/atencion/conversaciones/${a.conversation_id}`}>Leer</Link>}
                  </li>
                ))}
              </ul>
            )}
          </Tarjeta>
        </div>
      )}
    </>
  );
}

/**
 * Conversación que la empresa compartió con soporte. Siempre se puede leer mientras el acceso esté
 * vigente; responder al cliente solo si la empresa lo autorizó («leer y responder»). Cada apertura y
 * cada respuesta quedan en la auditoría del operador y en la de la empresa.
 */
export function OpConversacionCompartida() {
  const { id } = useParams();
  const { yo, puede } = useYo();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/atencion-empresas/conversaciones/${id}`), [id]);
  const [texto, setTexto] = useState('');
  const { run, ocupado } = useAccion();
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [data?.mensajes?.length]);
  if (error) {
    return <>
      <Cabecera titulo="Conversación compartida"><Link className="btn" to="/operador/atencion"><Icon n="atras" className="" size={16} />Atención de las empresas</Link></Cabecera>
      {error.status === 404 ? <div className="bloqueado"><Icon n="candado" className="" size={16} /> No hay un acceso vigente a esta conversación. La empresa no la ha compartido, el plazo venció o retiró el acceso.</div> : <ErrorCarga error={error} reintentar={recargar} />}
    </>;
  }
  if (!data) return <Cargando filas={8} />;
  const tipo = (m: any): TipoMensaje => (m.tipo === 'NOTA_INTERNA' ? 'nota' : m.remitente === 'CUSTOMER' ? 'cliente' : m.remitente === 'AI' ? 'ia' : m.remitente === 'HUMAN' ? 'humano' : 'sistema');
  const responde = !!data.acceso?.puede_responder && puede('atencion:responder_autorizadas');
  const enviar = async () => {
    if (!texto.trim() || ocupado) return;
    const r = await run(() => api.post(`/api/operador/atencion-empresas/conversaciones/${id}/responder`, { texto }), 'Respuesta enviada al cliente');
    if (r) { setTexto(''); recargar(); }
  };
  return (
    <>
      <Cabecera titulo={`${data.empresa} · ${data.cliente}`} sub={<span className="fila envolver" style={{ gap: 8 }}><span className="mono">{data.telefono}</span><span>·</span><span>{data.canal === 'WHATSAPP' ? 'WhatsApp' : 'Web'}</span><Estado v={data.estado} /></span>}>
        <button className="btn" disabled={cargando} onClick={recargar}><Icon n="reloj" className="" size={16} />Actualizar</button>
        <Link className="btn" to="/operador/atencion"><Icon n="atras" className="" size={16} />Atención de las empresas</Link>
      </Cabecera>
      <div className="col" style={{ gap: 16 }}>
        <div className={`op-acceso ${data.acceso?.puede_responder ? 'responde' : ''}`}>
          <Icon n={data.acceso?.puede_responder ? 'conversaciones' : 'candado'} className="" size={16} />
          <span>
            <b>{data.acceso?.puede_responder ? 'Puedes leer y responder al cliente.' : 'Solo lectura.'}</b>{' '}
            {data.acceso ? <>La compartió {data.acceso.otorgado_por_nombre} el {fechaHora(data.acceso.creado_en)} hasta el {fechaHora(data.acceso.expira_en)}: «{data.acceso.motivo}»{data.acceso.ticket_numero ? ` · solicitud ${data.acceso.ticket_numero}` : ''}.</> : null} Cada lectura y respuesta queda en tu auditoría y en la de la empresa.
          </span>
        </div>
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <section className="tarjeta op-chat" aria-label="Mensajes">
            <div className="hilo" style={{ padding: 20 }}>
              {data.mensajes.length === 0 && <Vacio titulo="Sin mensajes" />}
              {data.mensajes.map((m: any) => (
                <Mensaje key={m.id} tipo={m.de_soporte ? 'humano' : tipo(m)} rol={m.de_soporte ? 'Soporte de Omnegia' : undefined}
                  quien={tipo(m) === 'cliente' ? data.cliente : m.de_soporte ? m.operador : undefined} hora={`${fecha(m.creado_en)} ${hora(m.creado_en)}`}
                  meta={m.estado_entrega && m.estado_entrega !== 'N/A' ? (ENTREGA[m.estado_entrega] ?? m.estado_entrega) + (m.estado_entrega === 'FALLIDO' && m.error_entrega ? `: ${m.error_entrega}` : '') : undefined}>
                  {m.tipo === 'MEDIA' ? <span className="tenue">Archivo adjunto (soporte no puede abrirlo).{m.contenido ? ` ${m.contenido}` : ''}</span> : <TextoWhatsApp texto={m.contenido ?? ''} />}
                </Mensaje>
              ))}
              <div ref={fin} />
            </div>
            {responde && (
              data.estado === 'CERRADA' ? <div className="op-chat-pie tenue peq-txt"><Icon n="ok" className="" size={14} />La empresa cerró esta conversación.</div>
              : !data.ventana_abierta ? <div className="op-chat-pie tenue peq-txt"><Icon n="reloj" className="" size={14} />Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no permite escribirle sin una plantilla de la empresa.</div>
              : (
                <div className="op-chat-pie">
                  <div className="cv-caja">
                    <textarea rows={2} value={texto} maxLength={4000} onChange={(e) => setTexto(e.target.value)} placeholder={`Escribe a ${String(data.cliente).split(' ')[0]}…`} aria-label="Respuesta al cliente"
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); enviar(); } }} />
                    <button type="button" className="cv-enviar" disabled={ocupado || !texto.trim()} onClick={enviar} aria-label="Enviar"><Icon n="enviar" className="" size={18} /></button>
                  </div>
                  <span className="tenue peq-txt">Sale por el WhatsApp de {data.empresa}; en su panel aparece como «Soporte de Omnegia» ({yo.nombre}). Enter envía.</span>
                </div>
              )
            )}
          </section>
          {data.caso && (
            <Tarjeta titulo={<span className="id">{data.caso.radicado}</span>} acciones={<Estado v={data.caso.estado} />}>
              <dl className="datos-def">
                <dt>Motivo</dt><dd>{data.caso.motivo}</dd>
                <dt>Prioridad</dt><dd>{String(data.caso.prioridad).toLowerCase()}</dd>
                <dt>Responder antes</dt><dd>{fechaHora(data.caso.sla_vence_en)}</dd>
                <dt>Primera respuesta</dt><dd>{data.caso.primera_respuesta_en ? fechaHora(data.caso.primera_respuesta_en) : <span className="tenue">Todavía no</span>}</dd>
              </dl>
            </Tarjeta>
          )}
        </div>
      </div>
    </>
  );
}
