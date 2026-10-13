import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, cop, fecha, hace, hora } from '../../api';
import { Escritura, Cabecera, useSesion } from '../../components/Layout';
import { Cargando, Confirmar, ErrorCarga, Estado, Mensaje, Recibo, Tarjeta, useAccion, useApi, Vacio, type TipoMensaje } from '../../components/ui';
import { Icon } from '../../components/icons';

/** SCR-014 · Bandeja y radicados. */
export function Conversaciones() {
  const { id } = useParams();
  const nav = useNavigate();
  const [filtro, setFiltro] = useState('todas');
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/conversaciones?filtro=${filtro}`), [filtro], { cada: 5000 });
  const filtros: [string, string][] = [['todas', 'Todas'], ['escaladas', 'Con una persona'], ['ia', 'Atendiendo la IA'], ['mias', 'Asignadas a mí'], ['cerradas', 'Cerradas']];
  const vacio = <Vacio titulo="No hay conversaciones en esta vista">{filtro === 'todas' ? 'Cuando un cliente escriba por WhatsApp, su conversación aparecerá aquí.' : 'Prueba con otro filtro.'}</Vacio>;
  return (
    <>
      {!id && <Cabecera titulo="Conversaciones" sub="Un solo hilo por cliente: IA, equipo y sistema" />}
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {!id ? (
          <section className="tarjeta" hidden={!!error}>
            <div className="filtros">
              <div className="tabs" role="group" aria-label="Filtrar conversaciones">
                {filtros.map(([k, v]) => <button key={k} className={filtro === k ? 'on' : ''} aria-pressed={filtro === k} onClick={() => setFiltro(k)}>{v}{data?.contadores?.[k] !== undefined && <span className="tenue"> {data.contadores[k]}</span>}</button>)}
              </div>
            </div>
            {!data ? <Cargando /> : data.conversaciones.length === 0 ? vacio : (
              <div className="tabla-wrap">
                <table className="tabla">
                  <thead><tr><th>Cliente</th><th>Último mensaje</th><th>Estado</th><th>Al frente</th><th>Acciones de IA</th><th>Radicado</th><th>SLA</th></tr></thead>
                  <tbody>{data.conversaciones.map((c: any) => (
                    <tr key={c.id} className="clic" onClick={() => nav(`/conversaciones/${c.id}`)}>
                      <td style={{ whiteSpace: 'nowrap' }}><Link to={`/conversaciones/${c.id}`} style={{ color: 'inherit', fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>{c.cliente}</Link><br /><span className="tenue peq-txt">{hace(c.actualizado_en)}</span></td>
                      <td className="sec cortar" style={{ maxWidth: 320 }}>{c.ultimo}</td>
                      <td><Estado v={c.estado} /></td>
                      <td>{c.resuelta_por ? <Estado v={c.resuelta_por} /> : c.control === 'AI' ? <Estado v="AGENTE" texto="IA al frente" /> : <Estado v="PERSONA" texto={c.asignado ?? 'En cola'} />}</td>
                      <td><span className="fila" style={{ gap: 4 }}><span className="estado ok" title="Ejecutadas"><Icon n="ok" className="" />{c.ia_ejecutadas}<span className="sr"> ejecutadas</span></span>{c.ia_bloqueadas > 0 && <span className="estado err" title="Bloqueadas"><Icon n="candado" className="" />{c.ia_bloqueadas}<span className="sr"> bloqueadas</span></span>}</span></td>
                      <td>{c.radicado ? <span className="id">{c.radicado}</span> : <span className="tenue">—</span>}</td>
                      <td><Sla c={c} /></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
        ) : (
          <div className="bandeja-detalle con-detalle" hidden={!!error}>
            <section className="tarjeta bandeja-lista" aria-label="Bandeja">
              <div className="filtros">
                <select className="input" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar conversaciones">
                  {filtros.map(([k, v]) => <option key={k} value={k}>{v}{data?.contadores?.[k] !== undefined ? ` (${data.contadores[k]})` : ''}</option>)}
                </select>
              </div>
              {!data ? <Cargando /> : data.conversaciones.length === 0 ? vacio : (
                <div className="tabla-wrap">
                  <table className="tabla">
                    <tbody>{data.conversaciones.map((c: any) => (
                      <tr key={c.id} className={`clic ${c.id === id ? 'sel' : ''}`} onClick={() => nav(`/conversaciones/${c.id}`)} aria-current={c.id === id ? 'true' : undefined}>
                        <td>
                          <div className="conv-item">
                            <div className="linea1"><Link to={`/conversaciones/${c.id}`} className="cortar" style={{ color: 'inherit', fontWeight: 600 }} onClick={(e) => e.stopPropagation()}>{c.cliente}</Link><span className="tenue peq-txt" style={{ whiteSpace: 'nowrap' }}>{hace(c.actualizado_en)}</span></div>
                            <div className="ultimo cortar">{c.ultimo}</div>
                            <div className="estados"><Estado v={c.estado} />{c.radicado && <span className="id tenue">{c.radicado}</span>}</div>
                          </div>
                        </td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
            </section>
            <Detalle id={id} onCambio={recargar} />
          </div>
        )}
      </div>
    </>
  );
}

function Sla({ c }: { c: any }) {
  if (!c.sla_vence_en || c.estado_caso === 'CERRADO') return <span className="tenue">—</span>;
  if (c.primera_respuesta_en) return <Estado v="EXITO" texto="Respondido" />;
  const min = Math.round((new Date(c.sla_vence_en).getTime() - Date.now()) / 60000);
  return min < 0 ? <Estado v="RECHAZADO" texto={`Vencido hace ${-min} min`} /> : <Estado v="PENDIENTE" texto={`Vence en ${min} min`} />;
}

function tipoDe(m: any): TipoMensaje {
  if (m.tipo === 'NOTA_INTERNA') return 'nota';
  return m.remitente === 'CUSTOMER' ? 'cliente' : m.remitente === 'AI' ? 'ia' : m.remitente === 'HUMAN' ? 'humano' : 'sistema';
}

/** SCR-015 · Detalle: el asesor entra al mismo hilo; la IA pasa a asistirlo (P5). */
function Detalle({ id, onCambio }: { id: string; onCambio: () => void }) {
  const { puede, s } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/conversaciones/${id}`), [id], { cada: 4000 });
  const [texto, setTexto] = useState('');
  const [nota, setNota] = useState(false);
  const [cerrar, setCerrar] = useState(false);
  const { run, ocupado } = useAccion();
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [data?.mensajes?.length]);
  if (error) return <ErrorCarga error={error} />;
  if (!data) return <section className="tarjeta"><Cargando filas={8} /></section>;

  const eventos = [
    ...data.mensajes.map((m: any) => ({ t: 'm', at: m.creado_en, m })),
    ...data.ejecuciones.map((e: any) => ({ t: 'e', at: e.creado_en, e })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const caso = data.caso;
  const nombre = data.cliente.split(' ')[0];
  const enviar = async () => {
    if (!texto.trim()) return;
    const r = await run(() => api.post(`/api/t/conversaciones/${id}/${nota ? 'nota' : 'responder'}`, { texto }), nota ? 'Nota interna guardada' : 'Mensaje enviado');
    if (r) { setTexto(''); recargar(); onCambio(); }
  };
  const sugerir = async () => { const r = await run(() => api.post(`/api/t/conversaciones/${id}/sugerencia`)); if (r?.sugerencia) setTexto(r.sugerencia); };

  return (
    <div className="detalle-conv">
      <section className="tarjeta panel-hilo" aria-label={`Conversación con ${data.cliente}`}>
        <div className="cab">
          <Link to="/conversaciones" className="btn sutil peq icono solo-movil" aria-label="Volver a la bandeja"><Icon n="atras" className="" size={18} /></Link>
          <div className="conv-cab-txt">
            <h1 className="titulo-tarjeta" style={{ fontSize: 17 }}>{data.cliente}</h1>
            <span className="tenue"><span className="mono">{data.telefono}</span> · {data.canal === 'WHATSAPP' ? 'WhatsApp' : 'Web'}</span>
          </div>
          <span className="fila envolver" style={{ marginLeft: 'auto', gap: 6 }}>
            {data.control === 'AI' ? <Estado v="AGENTE" texto="La IA está al frente" /> : <Estado v="PERSONA" texto="Una persona está al frente" />}
          </span>
          <div className="fila envolver" style={{ gap: 6, flexBasis: '100%' }}>
            {caso && caso.estado !== 'CERRADO' && !caso.asignado_a && <Escritura permiso="case:manage" modulo="conversaciones"><button className="btn peq primario" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/casos/${caso.id}/tomar`), 'Caso asignado a ti').then(recargar)}><Icon n="persona" className="" size={14} />Tomar caso</button></Escritura>}
            {data.control === 'AI' && data.estado !== 'CERRADA' && <Escritura permiso="case:create" modulo="conversaciones"><button className="btn peq" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/conversaciones/${id}/escalar`, { motivo: 'Intervención manual desde el panel', prioridad: 'MEDIA' }), 'Conversación escalada').then(() => { recargar(); onCambio(); })}><Icon n="persona" className="" size={14} />Intervenir</button></Escritura>}
            {data.control === 'HUMANO' && <Escritura permiso="case:manage" modulo="conversaciones"><button className="btn peq" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/conversaciones/${id}/devolver-ia`), 'La IA vuelve a atender').then(() => { recargar(); onCambio(); })}><Icon n="ia" className="" size={14} />Devolver a la IA</button></Escritura>}
            {data.estado !== 'CERRADA' && <Escritura permiso="case:manage" modulo="conversaciones"><button className="btn peq sutil" onClick={() => setCerrar(true)}>Cerrar conversación</button></Escritura>}
          </div>
        </div>
        <div className="hilo-scroll">
          <div className="hilo" aria-live="polite" aria-relevant="additions">
            {eventos.map((ev: any) => {
              if (ev.t === 'e') return <Recibo key={ev.e.id} e={ev.e} />;
              const m = ev.m;
              if (m.remitente === 'SYSTEM' && m.tipo === 'NOTA_INTERNA') return <div key={m.id} className="evento-sistema"><Icon n="info" className="" size={13} /> {m.contenido} · {hora(m.creado_en)}</div>;
              const tipo = tipoDe(m);
              const quien = tipo === 'nota' ? m.autor : tipo === 'cliente' ? data.cliente : tipo === 'humano' ? m.autor : undefined;
              const rol = m.tipo === 'PLANTILLA' ? `Plantilla · ${m.metadatos?.plantilla}` : undefined;
              return (
                <Mensaje key={m.id} tipo={tipo} quien={quien} rol={rol} hora={`${fecha(m.creado_en)} ${hora(m.creado_en)}`}
                  meta={m.estado_entrega !== 'N/A' ? m.estado_entrega.toLowerCase() : tipo === 'nota' ? 'Solo la ve el equipo' : undefined}>
                  {m.contenido}
                </Mensaje>
              );
            })}
            {caso && <div className="escalado-aviso"><Icon n="persona" className="" size={14} /><span><span className="id">{caso.radicado}</span> · {caso.motivo} · prioridad {caso.prioridad.toLowerCase()} {caso.asignado ? `· asignado a ${caso.asignado}` : '· en cola'}</span></div>}
            {data.pendientes.map((p: any) => <div key={p.id} className="recibo pendiente"><span className="ic"><Icon n="reloj" className="" size={14} /></span><span className="que">Esperando que el cliente confirme: <b>{p.resumen}</b></span><Estado v="PENDIENTE_CONFIRMACION" /></div>)}
            <div ref={fin} />
          </div>
        </div>
        {data.estado === 'CERRADA' ? (
          <div className="composer"><span className="tenue peq-txt fila"><Icon n="ok" className="" size={14} />Conversación cerrada. Si el cliente vuelve a escribir, la IA retoma este mismo hilo.</span></div>
        ) : puede('conversation:reply') && !s.solo_lectura ? (
          <div className={`composer ${nota ? 'nota' : ''}`}>
            <div className="fila entre envolver" style={{ gap: 8 }}>
              <div className="tabs" role="group" aria-label="Tipo de mensaje">
                <button type="button" className={!nota ? 'on' : ''} aria-pressed={!nota} onClick={() => setNota(false)}>Responder a {nombre}</button>
                <button type="button" className={nota ? 'on' : ''} aria-pressed={nota} onClick={() => setNota(true)}><Icon n="nota" className="" size={13} /> Nota interna</button>
              </div>
              {puede('ai:assist') && !nota && <button className="btn peq sutil" disabled={ocupado} onClick={sugerir}><Icon n="ia" className="" size={14} /> Sugerir respuesta</button>}
            </div>
            {!data.ventana_abierta && data.canal === 'WHATSAPP' && !nota && <div className="aviso peq-txt"><Icon n="reloj" className="" size={14} />Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas.</div>}
            <textarea className="input" value={texto} onChange={(e) => setTexto(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!ocupado) enviar(); } }}
              placeholder={nota ? 'Nota visible solo para el equipo' : `Escribe a ${nombre}. La respuesta sale por ${data.canal === 'WHATSAPP' ? 'WhatsApp' : 'el canal web'} desde este hilo.`} aria-label={nota ? 'Nota interna' : `Respuesta a ${data.cliente}`} />
            <div className="fila entre envolver" style={{ gap: 8 }}>
              <span className="tenue peq-txt ayuda-composer" style={{ maxWidth: '60ch' }}>{nota ? 'La nota queda en el hilo, marcada como interna. El cliente no la recibe.' : 'Responde siempre desde aquí, no desde tu teléfono: así el hilo y el SLA quedan registrados.'}</span>
              <button className="btn primario" style={{ marginLeft: 'auto' }} disabled={ocupado || !texto.trim()} onClick={enviar}><Icon n={nota ? 'nota' : 'enviar'} className="" size={14} /> {nota ? 'Guardar nota' : 'Enviar'}</button>
            </div>
          </div>
        ) : (
          <div className="composer"><span className="tenue peq-txt fila"><Icon n="candado" className="" size={14} />{s.solo_lectura ? 'Suscripción suspendida (solo lectura): no se pueden enviar respuestas ni guardar notas internas. Puedes leer el hilo completo.' : 'Tu rol puede leer esta conversación, pero no responder.'}</span></div>
        )}
      </section>

      <div className="col" style={{ gap: 16 }}>
        {caso && (
          <Tarjeta titulo={<span className="id">{caso.radicado}</span>} acciones={<Estado v={caso.estado} />} nivel={caso.estado === 'EN_COLA' ? 3 : 2}>
            <div className="col" style={{ gap: 12 }}>
              <dl className="datos-def">
                <dt>Motivo</dt><dd>{caso.motivo}</dd>
                <dt>Prioridad</dt><dd>{caso.prioridad.toLowerCase()}</dd>
                <dt>SLA</dt><dd>vence a las {hora(caso.sla_vence_en)}</dd>
                <dt>Asignado</dt><dd>{caso.asignado ?? 'Nadie (en cola)'}</dd>
                {caso.motivo_cierre && <><dt>Cierre</dt><dd>{caso.motivo_cierre}</dd></>}
              </dl>
              {caso.resumen_ia && <div className="resumen-copiloto"><span className="rol"><Icon n="ia" className="" size={12} />Resumen del copiloto · propuesta, no decisión</span>{caso.resumen_ia}</div>}
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
            <span>{data.consentimiento_en ? <Estado v="EXITO" texto="Autorizó tratamiento de datos" /> : <Estado v="PENDIENTE" texto="Sin autorización de datos" />}</span>
          </div>
        </Tarjeta>
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
      {cerrar && <Confirmar titulo="Cerrar conversación" riesgo="confirmable" pedirMotivo efecto={<>Se cerrará {caso ? <>el radicado <span className="id">{caso.radicado}</span> y </> : ''}la conversación. Si el cliente vuelve a escribir, la IA retoma el mismo hilo.</>}
        textoBoton="Cerrar conversación" onCerrar={() => setCerrar(false)} onConfirmar={async (motivo) => { setCerrar(false); await run(() => api.post(`/api/t/conversaciones/${id}/cerrar`, { motivo }), 'Conversación cerrada'); recargar(); onCambio(); }} />}
    </div>
  );
}
