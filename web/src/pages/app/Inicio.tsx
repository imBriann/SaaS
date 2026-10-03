import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, cop, fechaLarga, hora } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { Cargando, CicloFiscal, Cifra, ErrorCarga, Estado, Medidor, Recibo, Tarjeta, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

/** SCR-009 · Panel de inicio: la operación manda (P4). */
export function Inicio() {
  const { s, puede } = useSesion();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get('/api/t/inicio'), [], { cada: 20000 });
  return (
    <>
      <Cabecera titulo={`Hola, ${s.usuario.nombre.split(' ')[0]}`} sub={data ? fechaLarga(data.fecha) : ''} />
      <div className="contenido dashboard-home">
        <section className="operation-banner"><div><span className="eyebrow">TU ESPACIO DE OPERACIÓN</span><h2>Un buen día empieza<br /><em>con todo en orden.</em></h2></div><div><span className="tenue">{s.tenant.nombre}</span><p>Una vista de lo que importa hoy.</p>{puede('conversation:read') && <Link className="btn" to="/conversaciones">Abrir conversaciones ↗</Link>}</div></section>
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {cargando && !data && <Cargando filas={8} />}
        {data && (
          <>
            <div className="quick-actions" aria-label="Acciones rápidas">{[
              ['appointment:create','/agenda','agenda','Agendar una cita'],['order:create','/ventas','ventas','Registrar una venta'],['customer:write','/clientes','clientes','Añadir un cliente'],['conversation:read','/conversaciones','conversaciones','Revisar mensajes']
            ].filter(([p]) => puede(p)).map(([p, to, icon, label]) => <Link key={p} to={to}><Icon n={icon} className="" size={20}/><span>{label}</span><span>↗</span></Link>)}</div>
            <div className="grid g4">
              <Cifra etiqueta="Ventas de hoy" valor={cop(data.cifras.ventas_hoy)} detalle={`${data.cifras.n_ventas_hoy} ventas · semana ${cop(data.cifras.ventas_semana)}`} />
              <Cifra etiqueta="Citas de hoy" valor={data.cifras.citas_hoy} detalle={`${data.cifras.citas_hoy_ia} agendadas por el agente`} />
              <Cifra etiqueta="Conversaciones abiertas" valor={data.cifras.conversaciones_abiertas} detalle={`${data.cifras.escaladas} con una persona`} />
              <Cifra etiqueta="Clientes nuevos (7 días)" valor={data.cifras.clientes_nuevos} detalle={`${data.cifras.resueltas_ia_semana} conversaciones resueltas por la IA`} />
            </div>
            <div className="grid g-main">
              <div className="col" style={{ gap: 16 }}>
                <Tarjeta titulo="Requiere tu atención" nivel={data.atencion.some((a: any) => a.nivel === 'error') ? 3 : 2}>
                  {data.atencion.length === 0 ? <Vacio titulo="Todo en orden">No hay facturas rechazadas, casos sin responder ni productos bajo mínimo.</Vacio> : (
                    <div className="col" style={{ gap: 10 }}>
                      {data.atencion.map((a: any, i: number) => (
                        <div key={i} className="fila entre" style={{ gap: 12 }}>
                          <span className="fila" style={{ gap: 10, alignItems: 'flex-start' }}>
                            <Estado v={a.nivel === 'error' ? 'RECHAZADO' : a.nivel === 'warn' ? 'PENDIENTE' : 'ESCALADA'} texto={a.tipo === 'factura_rechazada' ? 'DIAN' : a.tipo === 'caso' ? 'Caso' : a.tipo === 'stock' ? 'Stock' : 'IA'} />
                            <span><b>{a.titulo}</b><br /><span className="tenue">{a.detalle}</span></span>
                          </span>
                          <Link className="btn peq" to={a.accion.ruta}>{a.accion.etiqueta}</Link>
                        </div>
                      ))}
                    </div>
                  )}
                </Tarjeta>
                {puede('conversation:read') && (
                  <Tarjeta titulo="Hilo en vivo" acciones={<Link to="/conversaciones" className="btn sutil peq">Ver bandeja</Link>}>
                    {data.hilo.length === 0 ? <Vacio titulo="Sin conversaciones todavía">Cuando tus clientes escriban por WhatsApp, verás aquí lo que hace la IA.</Vacio> : (
                      <div className="hilo dashboard-feed">
                        {data.hilo.map((h: any) => h.kind === 'recibo'
                          ? <Recibo key={h.id} e={{ ...h, nivel_riesgo: h.riesgo, permiso_requerido: h.permiso, motivo_denegacion: h.motivo }} compacto />
                          : <Link key={h.id} to={`/conversaciones/${h.conversation_id}`} style={{ color: 'inherit', textDecoration: 'none', alignSelf: h.remitente === 'CUSTOMER' ? 'flex-start' : 'flex-end', maxWidth: '80%' }}>
                              <div className={`burbuja ${h.remitente === 'CUSTOMER' ? 'cliente' : h.remitente === 'AI' ? 'ia' : h.remitente === 'HUMAN' ? 'humano' : 'sistema'}`} style={{ maxWidth: '100%' }}>
                                <div className="quien">{h.remitente === 'CUSTOMER' ? h.cliente : h.remitente === 'AI' ? 'Agente IA' : h.remitente === 'HUMAN' ? 'Equipo' : 'Sistema'} · {hora(h.creado_en)}</div>
                                {h.texto.length > 220 ? h.texto.slice(0, 220) + '…' : h.texto}
                              </div>
                            </Link>)}
                      </div>
                    )}
                  </Tarjeta>
                )}
                <Asistente />
              </div>
              <div className="col" style={{ gap: 16 }}>
                {puede('appointment:read') && (
                  <Tarjeta titulo="Agenda de hoy" acciones={<Link to="/agenda" className="btn sutil peq">Abrir agenda</Link>}>
                    {data.agenda.length === 0 ? <Vacio titulo="Sin citas hoy" /> : (
                      <div className="col" style={{ gap: 0 }}>
                        {data.agenda.map((a: any, i: number) => (
                          <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '52px minmax(0, 1fr) auto', gap: 12, alignItems: 'center', padding: '10px 0', borderTop: i ? '1px solid var(--linea)' : 0 }}>
                            <span className="mono tenue">{a.hora}</span>
                            <span style={{ minWidth: 0 }}><span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.cliente}</span><span className="tenue" style={{ fontSize: 13 }}>{a.servicio} · {a.recurso}</span></span>
                            {a.origen === 'AGENTE' ? <Estado v="AGENTE" texto="IA" /> : <Estado v={a.estado} />}
                          </div>
                        ))}
                      </div>
                    )}
                    {data.ocupacion.length > 0 && <div className="fila envolver" style={{ marginTop: 12 }}>{data.ocupacion.map((o: any) => <span key={o.nombre} className="chip">{o.nombre}: {o.citas}</span>)}</div>}
                  </Tarjeta>
                )}
                {data.fiscal && <Tarjeta titulo="Ciclo fiscal de hoy" acciones={<Link to="/facturacion" className="btn sutil peq">Facturación</Link>}><CicloFiscal conteos={data.fiscal} /></Tarjeta>}
                {data.ingresos.length > 0 && <Tarjeta titulo="Ingresos de la semana"><Barras datos={data.ingresos} /></Tarjeta>}
                {data.consumo && (
                  <Tarjeta titulo="Consumo del plan" acciones={<Link to="/suscripcion" className="btn sutil peq">Detalle</Link>}>
                    <div className="col" style={{ gap: 12 }}>
                      <Medidor c={data.consumo.tokens_ia} etiqueta="IA" />
                      <Medidor c={data.consumo.mensajes} etiqueta="Mensajes" />
                      <Medidor c={data.consumo.documentos} etiqueta="Documentos fiscales" />
                    </div>
                  </Tarjeta>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function Barras({ datos }: { datos: { dia: string; total: number }[] }) {
  const max = Math.max(...datos.map((d) => d.total), 1);
  return (
    <div className="fila" style={{ alignItems: 'flex-end', gap: 8, height: 120 }} role="img" aria-label="Ingresos por día">
      {datos.map((d) => (
        <div key={d.dia} className="col" style={{ flex: 1, alignItems: 'center', gap: 4, height: '100%', justifyContent: 'flex-end' }} title={`${d.dia}: ${cop(d.total)}`}>
          <span className="tenue" style={{ fontSize: 12 }}>{Math.round(d.total / 1000)}k</span>
          <div style={{ width: '100%', maxWidth: 28, height: `${(d.total / max) * 80}%`, background: 'var(--ceniza)', opacity: 0.85, borderRadius: 6, minHeight: 2 }} />
          <span className="tenue" style={{ fontSize: 12 }}>{new Date(d.dia + 'T12:00:00Z').toLocaleDateString('es-CO', { weekday: 'short', timeZone: 'UTC' })}</span>
        </div>
      ))}
    </div>
  );
}

/** Consultar el negocio en lenguaje natural (CU-10). Cada respuesta muestra sus recibos. */
function Asistente() {
  const { puede } = useSesion();
  const [hist, setHist] = useState<{ role: 'user' | 'assistant'; text: string; recibos?: any[] }[]>([]);
  const [q, setQ] = useState('');
  const [ocupado, setOcupado] = useState(false);
  if (!puede('ai:assist')) return null;
  const preguntar = async (e?: FormEvent, texto?: string) => {
    e?.preventDefault();
    const pregunta = (texto ?? q).trim();
    if (!pregunta) return;
    setQ('');
    const nuevo = [...hist, { role: 'user' as const, text: pregunta }];
    setHist(nuevo);
    setOcupado(true);
    try {
      const r = await api.post('/api/t/asistente', { pregunta, historial: hist.map(({ role, text }) => ({ role, text })) });
      setHist([...nuevo, { role: 'assistant', text: r.texto, recibos: r.ejecuciones }]);
    } catch (err) {
      setHist([...nuevo, { role: 'assistant', text: (err as Error).message }]);
    } finally { setOcupado(false); }
  };
  return (
    <Tarjeta titulo={<span className="fila"><Icon n="ia" className="" size={15} /> Pregúntale a tu negocio</span>}>
      <div className="hilo">
        {hist.length === 0 && <div className="fila envolver">{['¿Cuánto vendimos esta semana?', '¿Qué citas hay hoy?', '¿Qué productos están bajo mínimo?', '¿Cómo va el consumo del plan?'].map((s) => <button key={s} className="chip" onClick={() => preguntar(undefined, s)}>{s}</button>)}</div>}
        {hist.map((h, i) => (
          <div key={i} className="col" style={{ alignItems: h.role === 'user' ? 'flex-start' : 'flex-end', gap: 4 }}>
            <div className={`burbuja ${h.role === 'user' ? 'cliente' : 'ia'}`}>{h.text}</div>
            {h.recibos?.map((r) => <Recibo key={r.id} e={{ ...r, nivel_riesgo: r.riesgo, motivo_denegacion: r.motivo }} compacto />)}
          </div>
        ))}
        {ocupado && <div className="burbuja ia tenue">Consultando…</div>}
      </div>
      <form className="fila" style={{ marginTop: 10 }} onSubmit={preguntar}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ej.: ¿qué citas tengo mañana?" aria-label="Pregunta al asistente" />
        <button className="btn primario" disabled={ocupado}>Preguntar</button>
      </form>
    </Tarjeta>
  );
}
