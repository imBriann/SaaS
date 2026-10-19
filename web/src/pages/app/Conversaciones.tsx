import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, cop, descargar, fecha, fechaHora, hace, hora } from '../../api';
import { Escritura, Cabecera, useSesion } from '../../components/Layout';
import { Campo, Cargando, Confirmar, ErrorCarga, Estado, Mensaje, Modal, Recibo, Tarjeta, useAccion, useApi, useRetardo, Vacio, type TipoMensaje } from '../../components/ui';
import { Icon } from '../../components/icons';
import { TextoWhatsApp } from '../../components/Markdown';

const FILTROS: [string, string][] = [['todas', 'Todas'], ['escaladas', 'Con una persona'], ['cola', 'En cola'], ['mias', 'Asignadas a mí'], ['ia', 'Atendiendo la IA'], ['cerradas', 'Cerradas']];
const PRIORIDADES = ['BAJA', 'MEDIA', 'ALTA', 'URGENTE'];
const ENTREGA: Record<string, string> = { PENDIENTE: 'enviando…', ENVIADO: 'enviado', ENTREGADO: 'entregado', LEIDO: 'leído', SIMULADO: 'simulado (no sale a WhatsApp)', FALLIDO: 'no entregado' };

/** Bandeja y radicados. */
export function Conversaciones() {
  const { id } = useParams();
  const nav = useNavigate();
  const [filtro, setFiltro] = useState('todas');
  const [q, setQ] = useState('');
  const qr = useRetardo(q);
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/conversaciones?filtro=${filtro}${qr ? `&q=${encodeURIComponent(qr)}` : ''}`), [filtro, qr], { cada: 6000 });
  const vacio = <Vacio titulo={qr ? 'Nada coincide con la búsqueda' : 'No hay conversaciones en esta vista'}>{qr ? 'Busca por nombre, teléfono o radicado.' : filtro === 'todas' ? 'Cuando un cliente escriba por WhatsApp, su conversación aparecerá aquí.' : 'Prueba con otro filtro.'}</Vacio>;
  const buscador = <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Nombre, teléfono o radicado" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar conversaciones" /></label>;
  return (
    <>
      {!id && <Cabecera titulo="Conversaciones" sub="Lee los mensajes de tus clientes y responde desde aquí.">{buscador}</Cabecera>}
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {!id ? (
          <section className="tarjeta" hidden={!!error}>
            <div className="filtros">
              <div className="tabs" role="group" aria-label="Filtrar conversaciones">
                {FILTROS.map(([k, v]) => <button key={k} className={filtro === k ? 'on' : ''} aria-pressed={filtro === k} onClick={() => setFiltro(k)}>{v}{data?.contadores?.[k] !== undefined && <span className="tenue"> {data.contadores[k]}</span>}</button>)}
              </div>
            </div>
            {!data ? <Cargando /> : data.conversaciones.length === 0 ? vacio : (
              <ul className="lista-conv" aria-label="Conversaciones">
                {data.conversaciones.map((c: any) => (
                  <li key={c.id}>
                    <Link to={`/conversaciones/${c.id}`} className="conv-fila">
                      <span className="conv-quien"><b className="cortar">{c.cliente}</b><span className="tenue peq-txt">{hace(c.actualizado_en)}</span></span>
                      <span className="conv-ultimo cortar">{c.ultimo}</span>
                      <span className="conv-estado">
                        {c.radicado && c.estado_caso !== 'CERRADO' ? <Estado v={c.estado_caso} /> : <Estado v={c.estado} />}
                        {c.control === 'AI' && c.estado !== 'CERRADA' ? <Estado v="AGENTE" texto="IA al frente" /> : c.asignado ? <span className="estado info"><Icon n="persona" className="" />{c.asignado}</span> : null}
                      </span>
                      <span className="conv-caso">{c.radicado ? <span className="id">{c.radicado}</span> : null}<Sla c={c} /></span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <div className="bandeja-detalle con-detalle" hidden={!!error}>
            <section className="tarjeta bandeja-lista" aria-label="Bandeja">
              <div className="filtros">
                <select className="input" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar conversaciones">
                  {FILTROS.map(([k, v]) => <option key={k} value={k}>{v}{data?.contadores?.[k] !== undefined ? ` (${data.contadores[k]})` : ''}</option>)}
                </select>
              </div>
              {!data ? <Cargando /> : data.conversaciones.length === 0 ? vacio : (
                <ul className="lista-conv compacta">
                  {data.conversaciones.map((c: any) => (
                    <li key={c.id}>
                      <Link to={`/conversaciones/${c.id}`} className={`conv-fila ${c.id === id ? 'sel' : ''}`} aria-current={c.id === id ? 'page' : undefined}>
                        <span className="conv-quien"><b className="cortar">{c.cliente}</b><span className="tenue peq-txt">{hace(c.actualizado_en)}</span></span>
                        <span className="conv-ultimo cortar">{c.ultimo}</span>
                        <span className="conv-estado">{c.radicado && c.estado_caso !== 'CERRADO' ? <Estado v={c.estado_caso} /> : <Estado v={c.estado} />}<Sla c={c} /></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <Detalle id={id} onCambio={recargar} volver={() => nav('/conversaciones')} />
          </div>
        )}
      </div>
    </>
  );
}

function Sla({ c }: { c: any }) {
  const caso = c.caso ?? c;
  const estado = caso.estado_caso ?? caso.estado;
  if (!caso.sla_vence_en || estado === 'CERRADO') return null;
  if (caso.primera_respuesta_en) return <Estado v="EXITO" texto="Respondido" />;
  const min = Math.round((new Date(caso.sla_vence_en).getTime() - Date.now()) / 60000);
  return min < 0 ? <Estado v="RECHAZADO" texto={`Sin respuesta hace ${-min} min`} /> : <Estado v="PENDIENTE" texto={`Responder en ${min} min`} />;
}

function tipoDe(m: any): TipoMensaje {
  if (m.tipo === 'NOTA_INTERNA') return 'nota';
  return m.remitente === 'CUSTOMER' ? 'cliente' : m.remitente === 'AI' ? 'ia' : m.remitente === 'HUMAN' ? 'humano' : 'sistema';
}

const ACCION_CASO: Record<string, string> = { crear: 'Se creó el radicado', tomar: 'Lo tomó', reasignar: 'Se reasignó', prioridad: 'Cambió la prioridad', responder: 'Primera respuesta', cerrar: 'Se cerró', reabrir: 'Se reabrió', devolver_ia: 'Se devolvió a la IA' };

/** Detalle: el asesor entra al mismo hilo; la IA pasa a asistirlo. */
function Detalle({ id, onCambio, volver }: { id: string; onCambio: () => void; volver: () => void }) {
  const { puede, s } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/conversaciones/${id}`), [id], { cada: 4000 });
  const [texto, setTexto] = useState('');
  const [nota, setNota] = useState(false);
  const [cerrar, setCerrar] = useState(false);
  const [reabrir, setReabrir] = useState(false);
  const [reasignar, setReasignar] = useState(false);
  const [plantilla, setPlantilla] = useState<any>(null);
  const [compartir, setCompartir] = useState(false);
  const { run, ocupado } = useAccion();
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [data?.mensajes?.length]);
  useEffect(() => { setTexto(''); setNota(false); }, [id]);
  if (error) return <div className="col"><button className="btn sutil solo-movil" onClick={volver}><Icon n="atras" className="" size={16} />Bandeja</button><ErrorCarga error={error} reintentar={recargar} /></div>;
  if (!data) return <section className="tarjeta"><Cargando filas={8} /></section>;

  const eventos = [
    ...data.mensajes.map((m: any) => ({ t: 'm', at: m.creado_en, m })),
    ...data.ejecuciones.filter((e: any) => e.decision !== 'PERMITIDA' || !['consultar_catalogo', 'consultar_precio', 'mis_citas'].includes(e.herramienta)).map((e: any) => ({ t: 'e', at: e.creado_en, e })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const caso = data.caso;
  const casoAbierto = caso && caso.estado !== 'CERRADO';
  const nombre = data.cliente.split(' ')[0];
  const accion = async (fn: () => Promise<any>, ok: string) => { const r = await run(fn, ok); if (r) { recargar(); onCambio(); } return r; };
  const enviar = async () => {
    if (!texto.trim()) return;
    const r = await accion(() => api.post(`/api/t/conversaciones/${id}/${nota ? 'nota' : 'responder'}`, { texto }), nota ? 'Nota interna guardada' : 'Mensaje enviado');
    if (r) setTexto('');
  };
  const sugerir = async () => { const r = await run(() => api.post(`/api/t/conversaciones/${id}/sugerencia`)); if (r?.sugerencia) setTexto(r.sugerencia); };
  const puedeResponder = puede('conversation:reply') && !s.solo_lectura;
  const ventanaCerrada = data.canal === 'WHATSAPP' && !data.ventana_abierta;

  return (
    <div className="detalle-conv">
      <section className="tarjeta panel-hilo" aria-label={`Conversación con ${data.cliente}`}>
        <div className="cab">
          <button className="btn sutil peq icono solo-movil" onClick={volver} aria-label="Volver a la bandeja"><Icon n="atras" className="" size={18} /></button>
          <div className="conv-cab-txt">
            <h1 className="titulo-tarjeta" style={{ fontSize: 17 }}>{data.cliente}</h1>
            <span className="tenue"><span className="mono">{data.telefono}</span> · {data.canal === 'WHATSAPP' ? 'WhatsApp' : 'Web'}</span>
          </div>
          <span className="fila envolver" style={{ marginLeft: 'auto', gap: 6 }}>
            {data.estado === 'CERRADA' ? <Estado v="CERRADA" /> : data.control === 'AI' ? <Estado v="AGENTE" texto="La IA está al frente" /> : <Estado v="PERSONA" texto={caso?.asignado ? `Atiende ${caso.asignado}` : 'Espera a una persona'} />}
          </span>
          {/* El radicado se ve siempre, también en móvil, encima del hilo. */}
          {caso && (
            <div className="caso-franja" aria-label="Radicado">
              <span className="id">{caso.radicado}</span><Estado v={caso.estado} />
              <span className="peq-txt">Prioridad {caso.prioridad.toLowerCase()}</span>
              <span className="peq-txt">{caso.asignado ? `Responsable: ${caso.asignado}` : 'Sin responsable'}</span>
              <Sla c={{ caso }} />
            </div>
          )}
          <div className="fila envolver acciones-conv">
            {casoAbierto && (!caso.asignado_a || caso.asignado_a === s.usuario.id) && !caso.tomado_en && <Escritura permiso="case:manage" modulo="conversaciones"><button className="btn peq primario" disabled={ocupado} onClick={() => accion(() => api.post(`/api/t/casos/${caso.id}/tomar`), 'Radicado asignado a ti')}><Icon n="persona" className="" size={14} />{caso.asignado_a ? 'Aceptar radicado' : 'Tomar radicado'}</button></Escritura>}
            {data.control === 'AI' && data.estado !== 'CERRADA' && <Escritura permiso="case:create" modulo="conversaciones"><button className="btn peq" disabled={ocupado} onClick={() => accion(() => api.post(`/api/t/conversaciones/${id}/escalar`, { motivo: 'Intervención manual desde el panel', prioridad: 'MEDIA' }), 'La conversación pasó a una persona')}><Icon n="persona" className="" size={14} />Pasar a una persona</button></Escritura>}
            {casoAbierto && <Escritura permiso="case:supervise" modulo="conversaciones"><button className="btn peq" disabled={ocupado} onClick={() => setReasignar(true)}>Reasignar o prioridad</button></Escritura>}
            {data.control === 'HUMANO' && data.estado !== 'CERRADA' && <Escritura permiso="case:manage" modulo="conversaciones"><button className="btn peq" disabled={ocupado} onClick={() => accion(() => api.post(`/api/t/conversaciones/${id}/devolver-ia`), 'La IA vuelve a atender')}><Icon n="ia" className="" size={14} />Devolver a la IA</button></Escritura>}
            {data.estado !== 'CERRADA' && <Escritura permiso="case:manage" modulo="conversaciones"><button className="btn peq sutil" onClick={() => setCerrar(true)}>Cerrar</button></Escritura>}
            {data.puede_reabrir && !casoAbierto && <Escritura permiso="case:manage" modulo="conversaciones"><button className="btn peq" onClick={() => setReabrir(true)}>Reabrir radicado</button></Escritura>}
          </div>
        </div>
        <div className="hilo-scroll">
          <div className="hilo" aria-live="polite" aria-relevant="additions">
            {eventos.map((ev: any) => {
              if (ev.t === 'e') return <Recibo key={ev.e.id} e={ev.e} compacto />;
              const m = ev.m;
              if (m.remitente === 'SYSTEM' && m.tipo === 'NOTA_INTERNA') return <div key={m.id} className="evento-sistema"><Icon n="info" className="" size={13} /> {m.contenido} · {hora(m.creado_en)}</div>;
              const tipo = tipoDe(m);
              const quien = tipo === 'nota' ? m.autor : tipo === 'cliente' ? data.cliente : tipo === 'humano' ? m.autor : undefined;
              const rol = m.tipo === 'PLANTILLA' ? 'Plantilla' : undefined;
              const entrega = m.estado_entrega !== 'N/A' ? (
                <span className={m.estado_entrega === 'FALLIDO' ? 'entrega-fallo' : ''}>{ENTREGA[m.estado_entrega] ?? m.estado_entrega}{m.estado_entrega === 'FALLIDO' && m.error_entrega ? `: ${m.error_entrega}` : ''}</span>
              ) : tipo === 'nota' ? 'Solo la ve el equipo' : undefined;
              return (
                <Mensaje key={m.id} tipo={tipo} quien={quien} rol={rol} hora={`${fecha(m.creado_en)} ${hora(m.creado_en)}`} meta={entrega}>
                  {m.tipo === 'MEDIA' ? <Archivo m={m} conv={id} /> : <TextoWhatsApp texto={m.contenido ?? ''} />}
                </Mensaje>
              );
            })}
            {data.pendientes.map((p: any) => <div key={p.id} className="recibo pendiente"><span className="ic"><Icon n="reloj" className="" size={14} /></span><span className="que">Esperando que el cliente confirme: <b>{p.resumen}</b></span><Estado v="PENDIENTE_CONFIRMACION" /></div>)}
            <div ref={fin} />
          </div>
        </div>
        {data.estado === 'CERRADA' ? (
          <div className="composer"><span className="tenue peq-txt fila"><Icon n="ok" className="" size={14} />Conversación cerrada. Si el cliente vuelve a escribir, la IA retoma este mismo hilo.</span></div>
        ) : !puedeResponder ? (
          <div className="composer"><span className="tenue peq-txt fila"><Icon n="candado" className="" size={14} />{s.solo_lectura ? 'Suscripción suspendida: puedes leer el hilo, pero no responder.' : 'Tu rol puede leer esta conversación, pero no responder.'}</span></div>
        ) : (
          <div className={`composer ${nota ? 'nota' : ''}`}>
            <div className="fila entre envolver" style={{ gap: 8 }}>
              <div className="tabs" role="group" aria-label="Tipo de mensaje">
                <button type="button" className={!nota ? 'on' : ''} aria-pressed={!nota} onClick={() => setNota(false)}>Responder a {nombre}</button>
                <button type="button" className={nota ? 'on' : ''} aria-pressed={nota} onClick={() => setNota(true)}><Icon n="nota" className="" size={13} /> Nota interna</button>
              </div>
              {puede('ai:assist') && !nota && !ventanaCerrada && <button className="btn peq sutil" disabled={ocupado} onClick={sugerir}><Icon n="ia" className="" size={14} /> Sugerir respuesta</button>}
            </div>
            {ventanaCerrada && !nota ? (
              <div className="col" style={{ gap: 8 }}>
                <div className="aviso peq-txt"><Icon n="reloj" className="" size={14} /><span>Pasaron más de 24 horas desde el último mensaje de {nombre}. WhatsApp solo permite escribirle con una plantilla aprobada.</span></div>
                <div className="fila envolver" style={{ gap: 6 }}>
                  {data.plantillas.map((p: any) => <button key={p.clave} type="button" className="chip" onClick={() => setPlantilla(p)}>{p.clave.replace(/_/g, ' ')}{p.estado_aprobacion !== 'APROBADA' && ' · sin aprobar'}</button>)}
                </div>
              </div>
            ) : (
              <>
                <textarea className="input" value={texto} maxLength={4000} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!ocupado) enviar(); } }}
                  placeholder={nota ? 'Nota visible solo para el equipo' : `Escribe a ${nombre}. Sale por ${data.canal === 'WHATSAPP' ? 'WhatsApp' : 'el canal web'} desde este hilo.`} aria-label={nota ? 'Nota interna' : `Respuesta a ${data.cliente}`} />
                <div className="fila entre envolver" style={{ gap: 8 }}>
                  <span className="tenue peq-txt ayuda-composer" style={{ maxWidth: '60ch' }}>{nota ? 'El cliente no recibe la nota.' : data.control === 'AI' ? 'Al responder, tomas la conversación: la IA deja de contestar y queda un radicado a tu nombre.' : 'Responde siempre desde aquí: así el hilo y el tiempo de respuesta quedan registrados.'}</span>
                  <button className="btn primario" style={{ marginLeft: 'auto' }} disabled={ocupado || !texto.trim()} onClick={enviar}><Icon n={nota ? 'nota' : 'enviar'} className="" size={14} /> {nota ? 'Guardar nota' : 'Enviar'}</button>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <div className="col contexto-conv" style={{ gap: 16 }}>
        {caso && (
          <Tarjeta titulo={<span className="id">{caso.radicado}</span>} acciones={<Estado v={caso.estado} />} nivel={caso.estado === 'EN_COLA' ? 3 : 2}>
            <div className="col" style={{ gap: 12 }}>
              <dl className="datos-def">
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
            </div>
          </Tarjeta>
        )}
        <Tarjeta titulo="Cliente" acciones={<Link to={`/clientes?id=${data.customer_id}`} className="btn sutil peq">Ver ficha</Link>}>
          <div className="col" style={{ gap: 8 }}>
            <dl className="datos-def">
              <dt>Nombre</dt><dd>{data.cliente}</dd>
              <dt>Correo</dt><dd>{data.email ?? <span className="tenue">Sin correo</span>}</dd>
              <dt>Documento</dt><dd>{data.numero_documento ? <span className="mono">{data.tipo_documento} {data.numero_documento}</span> : 'Consumidor final'}</dd>
            </dl>
            <span>{data.consentimiento_en ? <Estado v="EXITO" texto="Autorizó el tratamiento de datos" /> : <Estado v="PENDIENTE" texto="Sin autorización de datos" />}</span>
          </div>
        </Tarjeta>
        {data.soporte && <SoporteOmnegia soporte={data.soporte} onCompartir={() => setCompartir(true)} onRetirar={() => accion(() => api.post(`/api/t/conversaciones/${id}/acceso-soporte/revocar`), 'Acceso retirado: soporte ya no puede leerla')} ocupado={ocupado} />}
        {data.ventas.length > 0 && (
          <Tarjeta titulo="Compras recientes">
            <div className="lista">{data.ventas.map((v: any) => <Link key={v.id} to={`/ventas/${v.id}`} className="lista-fila"><span className="mono">#{v.numero}</span><span className="num">{cop(v.total)}</span><Estado v={v.estado_fiscal} /></Link>)}</div>
          </Tarjeta>
        )}
        {data.citas.length > 0 && (
          <Tarjeta titulo="Citas">
            <div className="lista">{data.citas.map((c: any) => <div key={c.id} className="lista-fila"><span className="peq-txt" style={{ whiteSpace: 'nowrap' }}>{fecha(c.inicio)} {hora(c.inicio)}</span><span className="tenue cortar">{c.servicio}</span><Estado v={c.estado} /></div>)}</div>
          </Tarjeta>
        )}
      </div>

      {cerrar && <Confirmar titulo="Cerrar conversación" riesgo="confirmable" pedirMotivo efecto={<>Se cerrará {caso && casoAbierto ? <>el radicado <span className="id">{caso.radicado}</span> y </> : ''}la conversación. Si el cliente vuelve a escribir, la IA retoma el mismo hilo.</>}
        textoBoton="Cerrar conversación" onCerrar={() => setCerrar(false)} onConfirmar={async (motivo) => { setCerrar(false); await accion(() => api.post(`/api/t/conversaciones/${id}/cerrar`, { motivo }), 'Conversación cerrada'); }} />}
      {reabrir && caso && <Confirmar titulo={`Reabrir ${caso.radicado}`} riesgo="confirmable" pedirMotivo efecto={<>El radicado vuelve a {caso.asignado ?? 'ti'} y la IA deja de responder en este hilo.</>}
        textoBoton="Reabrir" onCerrar={() => setReabrir(false)} onConfirmar={async (motivo) => { setReabrir(false); await accion(() => api.post(`/api/t/casos/${caso.id}/reabrir`, { motivo }), 'Radicado reabierto'); }} />}
      {reasignar && caso && <Reasignar caso={caso} onCerrar={() => setReasignar(false)} onHecho={() => { setReasignar(false); recargar(); onCambio(); }} />}
      {plantilla && <EnviarPlantilla conv={id} p={plantilla} cliente={nombre} onCerrar={() => setPlantilla(null)} onHecho={() => { setPlantilla(null); recargar(); }} />}
      {compartir && <CompartirConSoporte conv={id} cliente={data.cliente} onCerrar={() => setCompartir(false)} onHecho={() => { setCompartir(false); recargar(); }} />}
    </div>
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
    <Tarjeta titulo="Soporte de Omnegia" acciones={a ? <Estado v="PENDIENTE" texto="Compartida" /> : <Estado v="CERRADA" texto="Privada" />}>
      <div className="col" style={{ gap: 10 }}>
        {a ? <>
          <span className="peq-txt">El soporte puede leer esta conversación hasta el <b>{fechaHora(a.expira_en)}</b>. No puede responder al cliente ni cambiar nada.</span>
          <dl className="datos-def">
            <dt>Motivo</dt><dd>{a.motivo}</dd>
            {a.ticket_numero && <><dt>Solicitud</dt><dd className="mono">{a.ticket_numero}</dd></>}
            <dt>Autorizó</dt><dd>{a.otorgado_por_nombre} · {fechaHora(a.creado_en)}</dd>
          </dl>
          <Escritura permiso="tenant:configure"><button className="btn peq peligro" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={onRetirar}>Retirar acceso ahora</button></Escritura>
        </> : <>
          <span className="peq-txt sec">El equipo de Omnegia no puede leer tus conversaciones. Si pediste ayuda sobre esta, compártela con soporte por un tiempo limitado.</span>
          <Escritura permiso="tenant:configure"><button className="btn peq" style={{ alignSelf: 'flex-start' }} onClick={onCompartir}><Icon n="compartir" className="" size={14} />Compartir con soporte</button></Escritura>
        </>}
        {lecturas.length > 0 && <span className="tenue peq-txt">Soporte la abrió {lecturas.length === 1 ? 'una vez' : `${lecturas.length} veces`}; la última {hace(lecturas[0])}.</span>}
      </div>
    </Tarjeta>
  );
}

function CompartirConSoporte({ conv, cliente, onCerrar, onHecho }: { conv: string; cliente: string; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState({ motivo: '', horas: 24, ticket: '' });
  const { run, ocupado, error } = useAccion();
  const ticketValido = !f.ticket.trim() || /^SOP-\d{6}$/i.test(f.ticket.trim());
  const listo = f.motivo.trim().length >= 10 && ticketValido;
  return (
    <Modal titulo="Compartir con soporte de Omnegia" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || !listo} onClick={async () => { const r = await run(() => api.post(`/api/t/conversaciones/${conv}/acceso-soporte`, { motivo: f.motivo.trim(), horas: f.horas, ticket: f.ticket.trim() || null }), 'Conversación compartida con soporte', { silencioso: true }); if (r) onHecho(); }}>Compartir</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <p className="sec" style={{ margin: 0 }}>Soporte podrá <b>leer</b> la conversación con {cliente} (mensajes, nombre y teléfono del cliente) hasta que venza el plazo o retires el acceso. No podrá responder ni ver otras conversaciones.</p>
      <Campo etiqueta="¿Para qué lo necesita soporte?"><textarea className="input" value={f.motivo} maxLength={300} onChange={(e) => setF({ ...f, motivo: e.target.value })} placeholder="Ej.: el agente le respondió mal el precio al cliente y quiero que revisen qué pasó" /></Campo>
      <div className="grid g2">
        <Campo etiqueta="Por cuánto tiempo"><select className="input" value={f.horas} onChange={(e) => setF({ ...f, horas: Number(e.target.value) })}><option value={24}>24 horas</option><option value={72}>3 días</option><option value={168}>7 días</option></select></Campo>
        <Campo etiqueta="Número de solicitud" ayuda="opcional" error={ticketValido ? undefined : 'Tiene la forma SOP-000123.'}><input className="input mono" value={f.ticket} maxLength={10} onChange={(e) => setF({ ...f, ticket: e.target.value.toUpperCase() })} placeholder="SOP-000123" /></Campo>
      </div>
      <span className="tenue peq-txt">Cada vez que soporte la abra quedará en la auditoría de tu empresa.</span>
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
