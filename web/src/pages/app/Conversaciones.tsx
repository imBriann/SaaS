import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, cop, fecha, hace, hora } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { Cargando, Confirmar, ErrorCarga, Estado, Recibo, Tarjeta, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

/** SCR-014 · Bandeja y radicados. */
export function Conversaciones() {
  const { id } = useParams();
  const nav = useNavigate();
  const [filtro, setFiltro] = useState('todas');
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/conversaciones?filtro=${filtro}`), [filtro], { cada: 5000 });
  const filtros: [string, string][] = [['todas', 'Todas'], ['escaladas', 'Con una persona'], ['ia', 'Atendiendo la IA'], ['mias', 'Asignadas a mí'], ['cerradas', 'Cerradas']];
  return (
    <>
      <Cabecera titulo="Conversaciones" sub="Un solo hilo por cliente: IA, equipo y sistema" />
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <div className="grid" style={{ gridTemplateColumns: id ? '300px minmax(0, 1fr)' : '1fr', alignItems: 'start' }}>
          <section className="tarjeta">
            {id ? (
              <div style={{ padding: '20px 20px 8px' }}>
                <select className="input" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar conversaciones">
                  {filtros.map(([k, v]) => <option key={k} value={k}>{v}{data?.contadores?.[k] !== undefined ? ` (${data.contadores[k]})` : ''}</option>)}
                </select>
              </div>
            ) : (
              <div className="tabs" style={{ margin: '20px 20px 8px' }}>
                {filtros.map(([k, v]) => <button key={k} className={filtro === k ? 'on' : ''} onClick={() => setFiltro(k)}>{v}{data?.contadores?.[k] !== undefined && <span className="tenue"> {data.contadores[k]}</span>}</button>)}
              </div>
            )}
            {!data ? <Cargando /> : data.conversaciones.length === 0 ? <Vacio titulo="No hay conversaciones en esta vista" /> : (
              <div className="tabla-wrap" style={{ maxHeight: 'calc(100vh - 300px)' }}>
                <table className="tabla">
                  <thead><tr><th>Cliente</th>{!id && <><th>Último mensaje</th><th>Estado</th></>}{!id && <><th>Resuelta por</th><th>Acciones de IA</th><th>Radicado</th><th>SLA</th></>}</tr></thead>
                  <tbody>{data.conversaciones.map((c: any) => (
                    <tr key={c.id} className={`clic ${c.id === id ? 'sel' : ''}`} onClick={() => nav(`/conversaciones/${c.id}`)}>
                      {id ? (
                        <td>
                          <div className="fila entre" style={{ gap: 8 }}><b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.cliente}</b><span className="tenue" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{hace(c.actualizado_en)}</span></div>
                          <div className="tenue" style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 230, margin: '2px 0 6px' }}>{c.ultimo}</div>
                          <Estado v={c.estado} />
                        </td>
                      ) : <td><b>{c.cliente}</b><br /><span className="tenue">{hace(c.actualizado_en)}</span></td>}
                      {!id && <td className="sec" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.ultimo}</td>}
                      {!id && <td><Estado v={c.estado} /></td>}
                      {!id && <>
                        <td>{c.resuelta_por ? <Estado v={c.resuelta_por} /> : c.control === 'AI' ? <Estado v="AGENTE" texto="IA al frente" /> : <Estado v="PERSONA" texto={c.asignado ?? 'En cola'} />}</td>
                        <td><span className="estado ok"><Icon n="ok" className="" />{c.ia_ejecutadas}</span> {c.ia_bloqueadas > 0 && <span className="estado err"><Icon n="candado" className="" />{c.ia_bloqueadas}</span>}</td>
                        <td className="mono">{c.radicado ?? '—'}</td>
                        <td><Sla c={c} /></td>
                      </>}
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
          {id && <Detalle id={id} onCambio={recargar} />}
        </div>
      </div>
    </>
  );
}

function Sla({ c }: { c: any }) {
  if (!c.sla_vence_en || c.estado_caso === 'CERRADO') return <span className="tenue">—</span>;
  if (c.primera_respuesta_en) return <Estado v="EXITO" texto="Respondido" />;
  const min = Math.round((new Date(c.sla_vence_en).getTime() - Date.now()) / 60000);
  return min < 0 ? <Estado v="RECHAZADO" texto={`Vencido ${-min} min`} /> : <Estado v="PENDIENTE" texto={`${min} min`} />;
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
  const enviar = async () => {
    const r = await run(() => api.post(`/api/t/conversaciones/${id}/${nota ? 'nota' : 'responder'}`, { texto }), nota ? 'Nota interna guardada' : 'Mensaje enviado');
    if (r) { setTexto(''); recargar(); onCambio(); }
  };
  const sugerir = async () => { const r = await run(() => api.post(`/api/t/conversaciones/${id}/sugerencia`)); if (r?.sugerencia) setTexto(r.sugerencia); };

  return (
    <div className="grid detalle-conv" style={{ alignItems: 'start' }}>
      <section className="tarjeta" style={{ display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 230px)', minHeight: 520 }}>
        <div className="cab" style={{ flexWrap: 'wrap', flex: 'none', paddingBottom: 16, borderBottom: '1px solid var(--linea)' }}>
          <div style={{ minWidth: 0 }}><div className="titulo-tarjeta">{data.cliente}</div><div className="tenue" style={{ fontSize: 13.5 }}><span className="mono">{data.telefono}</span> · {data.canal === 'WHATSAPP' ? 'WhatsApp' : 'Web'} · {data.control === 'AI' ? 'la IA está al frente' : 'una persona está al frente'}</div></div>
          <div className="fila envolver" style={{ marginLeft: 'auto', gap: 6 }}>
            {caso && caso.estado !== 'CERRADO' && !caso.asignado_a && puede('case:manage') && <button className="btn peq" onClick={() => run(() => api.post(`/api/t/casos/${caso.id}/tomar`), 'Caso asignado a ti').then(recargar)}>Tomar caso</button>}
            {data.control === 'AI' && data.estado !== 'CERRADA' && puede('case:create') && <button className="btn peq" onClick={() => run(() => api.post(`/api/t/conversaciones/${id}/escalar`, { motivo: 'Intervención manual desde el panel', prioridad: 'MEDIA' }), 'Conversación escalada').then(() => { recargar(); onCambio(); })}>Intervenir</button>}
            {data.control === 'HUMANO' && puede('case:manage') && <button className="btn peq" onClick={() => run(() => api.post(`/api/t/conversaciones/${id}/devolver-ia`), 'La IA vuelve a atender').then(() => { recargar(); onCambio(); })}>Devolver a la IA</button>}
            {data.estado !== 'CERRADA' && puede('case:manage') && <button className="btn peq" onClick={() => setCerrar(true)}>Cerrar</button>}
          </div>
        </div>
        <div className="cuerpo hilo" style={{ overflowY: 'auto', flex: 1 }}>
          {eventos.map((ev: any) => {
            if (ev.t === 'e') return <Recibo key={ev.e.id} e={ev.e} />;
            const m = ev.m;
            if (m.remitente === 'SYSTEM' && m.tipo === 'NOTA_INTERNA') return <div key={m.id} className="burbuja sistema"><Icon n="info" className="" size={12} /> {m.contenido}</div>;
            const cls = m.tipo === 'NOTA_INTERNA' ? 'nota' : m.remitente === 'CUSTOMER' ? 'cliente' : m.remitente === 'AI' ? 'ia' : m.remitente === 'HUMAN' ? 'humano' : 'sistema';
            const quien = m.tipo === 'NOTA_INTERNA' ? `Nota interna · ${m.autor}` : m.remitente === 'CUSTOMER' ? data.cliente : m.remitente === 'AI' ? 'Agente IA' : m.remitente === 'HUMAN' ? m.autor : m.tipo === 'PLANTILLA' ? `Plantilla · ${m.metadatos?.plantilla}` : 'Sistema';
            return (
              <div key={m.id} className={`burbuja ${cls}`}>
                <div className="quien">{quien}</div>{m.contenido}
                <div className="hora">{fecha(m.creado_en)} {hora(m.creado_en)}{m.estado_entrega !== 'N/A' && ` · ${m.estado_entrega.toLowerCase()}`}</div>
              </div>
            );
          })}
          {caso && <div className="escalado-aviso"><Icon n="persona" className="" size={13} /> {caso.radicado} · {caso.motivo} · prioridad {caso.prioridad.toLowerCase()} {caso.asignado ? `· asignado a ${caso.asignado}` : '· en cola'}</div>}
          {data.pendientes.map((p: any) => <div key={p.id} className="recibo pendiente"><span className="ic"><Icon n="reloj" className="" size={13} /></span><span>Esperando que el cliente confirme: <b>{p.resumen}</b></span><Estado v="PENDIENTE_CONFIRMACION" /></div>)}
          <div ref={fin} />
        </div>
        {puede('conversation:reply') && data.estado !== 'CERRADA' && (
          <div className="cuerpo col" style={{ borderTop: '1px solid var(--linea)', gap: 8 }}>
            {!data.ventana_abierta && data.canal === 'WHATSAPP' && !nota && <span className="estado warn" style={{ alignSelf: 'flex-start' }}><Icon n="reloj" className="" />Pasaron más de 24 h desde el último mensaje del cliente: WhatsApp solo permite plantillas aprobadas.</span>}
            <textarea className="input" style={{ minHeight: 64 }} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={nota ? 'Nota visible solo para el equipo' : `Responder a ${data.cliente.split(' ')[0]} desde el panel`} aria-label="Mensaje" />
            <div className="fila entre">
              <label className="fila tenue"><input type="checkbox" checked={nota} onChange={(e) => setNota(e.target.checked)} /> Nota interna</label>
              <div className="fila">
                {puede('ai:assist') && <button className="btn" disabled={ocupado} onClick={sugerir}><Icon n="ia" className="" size={13} /> Sugerir respuesta</button>}
                <button className="btn primario" disabled={ocupado || !texto.trim()} onClick={enviar}><Icon n="enviar" className="" size={13} /> {nota ? 'Guardar nota' : 'Enviar'}</button>
              </div>
            </div>
            <span className="tenue">Respondes siempre desde aquí, nunca desde tu teléfono: así la conversación completa y el SLA quedan registrados.</span>
          </div>
        )}
      </section>
      <div className="col" style={{ gap: 16 }}>
        {caso && (
          <Tarjeta titulo={<span className="mono">{caso.radicado}</span>} acciones={<Estado v={caso.estado} />} nivel={caso.estado === 'EN_COLA' ? 3 : 2}>
            <div className="col" style={{ gap: 6 }}>
              <span><b>Motivo:</b> {caso.motivo}</span>
              <span><b>Prioridad:</b> {caso.prioridad.toLowerCase()} · <b>SLA:</b> {hora(caso.sla_vence_en)}</span>
              <span><b>Asignado:</b> {caso.asignado ?? 'nadie (en cola)'}</span>
              {caso.resumen_ia && <div className="burbuja ia" style={{ maxWidth: '100%', alignSelf: 'stretch' }}><div className="quien">Resumen del copiloto</div>{caso.resumen_ia}</div>}
              {caso.motivo_cierre && <span className="tenue">Cerrado: {caso.motivo_cierre}</span>}
            </div>
          </Tarjeta>
        )}
        <Tarjeta titulo="Cliente">
          <div className="col" style={{ gap: 4 }}>
            <b>{data.cliente}</b>
            <span className="tenue">{data.email ?? 'sin correo'} · {data.numero_documento ? `${data.tipo_documento} ${data.numero_documento}` : 'consumidor final'}</span>
            <span>{data.consentimiento_en ? <Estado v="EXITO" texto="Autorizó tratamiento de datos" /> : <Estado v="PENDIENTE" texto="Sin autorización de datos" />}</span>
            <Link to={`/clientes?id=${data.customer_id}`} className="btn sutil peq" style={{ alignSelf: 'flex-start' }}>Ver ficha</Link>
          </div>
        </Tarjeta>
        {data.ventas.length > 0 && (
          <Tarjeta titulo="Compras recientes">
            {data.ventas.map((v: any) => <Link key={v.id} to={`/ventas/${v.id}`} className="fila entre" style={{ color: 'inherit', padding: '3px 0' }}><span className="mono">#{v.numero}</span><span>{cop(v.total)}</span><Estado v={v.estado_fiscal} /></Link>)}
          </Tarjeta>
        )}
        {data.citas.length > 0 && (
          <Tarjeta titulo="Citas">
            {data.citas.map((c: any) => <div key={c.id} className="fila entre" style={{ padding: '3px 0' }}><span>{fecha(c.inicio)} {hora(c.inicio)}</span><span className="tenue">{c.servicio}</span><Estado v={c.estado} /></div>)}
          </Tarjeta>
        )}
        {s.solo_lectura && <div className="bloqueado">Cuenta en solo lectura.</div>}
      </div>
      {cerrar && <Confirmar titulo="Cerrar conversación" riesgo="confirmable" pedirMotivo efecto={<>Se cerrará {caso ? `el radicado ${caso.radicado} y ` : ''}la conversación. Si el cliente vuelve a escribir, la IA retoma el mismo hilo.</>}
        textoBoton="Cerrar" onCerrar={() => setCerrar(false)} onConfirmar={async (motivo) => { setCerrar(false); await run(() => api.post(`/api/t/conversaciones/${id}/cerrar`, { motivo }), 'Conversación cerrada'); recargar(); onCambio(); }} />}
    </div>
  );
}
