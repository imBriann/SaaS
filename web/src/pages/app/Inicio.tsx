import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, cop, fechaLarga, hora, hoyLocal } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { Cargando, CicloFiscal, Cifra, ErrorCarga, Estado, Medidor, Mensaje, Recibo, Tarjeta, useApi, Vacio, type TipoMensaje } from '../../components/ui';
import { Icon } from '../../components/icons';
import { ThinkingOrb } from 'thinking-orbs';
import { useWorkspaceBirthReady } from '../../components/WorkspaceBirth';

const TIPO: Record<string, TipoMensaje> = { CUSTOMER: 'cliente', AI: 'ia', HUMAN: 'humano' };

/** SCR-009 · Panel de inicio: la operación manda (P4). Primero lo que espera a una persona. */
export function Inicio() {
  const { s, puede } = useSesion();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get('/api/t/inicio'), [], { cada: 20000 });
  useWorkspaceBirthReady(!!data || !!error);
  const personalizacion = s.tenant.registro_datos?.inicio_ia;
  const accesos = ([
    ['appointment:create', '/agenda', 'agenda', 'Agendar una cita'], ['order:create', '/ventas', 'ventas', 'Registrar una venta'],
    ['customer:write', '/clientes', 'clientes', 'Añadir un cliente'], ['conversation:read', '/conversaciones', 'conversaciones', 'Revisar mensajes'],
  ] as const).filter(([p]) => puede(p));
  return (
    <>
      <Cabecera titulo={personalizacion?.titulo || `Hola, ${s.usuario.nombre.split(' ')[0]}`} sub={data ? `${fechaLarga(data.fecha)} · ${s.tenant.nombre}` : s.tenant.nombre}>
        {accesos.map(([p, to, icon, label]) => <Link key={p} className="btn" to={to}><Icon n={icon} className="" size={16} />{label}</Link>)}
      </Cabecera>
      <div className="contenido">
        {personalizacion?.descripcion && <section className="workspace-personalized" aria-label="Tu espacio personalizado">
          <ThinkingOrb state="breathing" size={64} theme="light" aria-label="Configuración personalizada de Omnegia" />
          <div><span className="workspace-personalized-tag"><Icon n="ia" size={14} className="" />Preparado por la IA para {s.tenant.nombre}</span><p>{personalizacion.descripcion}</p>
            {Array.isArray(personalizacion.prioridades) && <ul>{personalizacion.prioridades.slice(0, 3).map((priority: any, i: number) => {
              const destinations: Record<string, [string, string]> = { clientes: ['/clientes', 'customer:read'], catalogo: ['/inventario', 'catalog:read'], inventario: ['/inventario', 'catalog:read'], ventas: ['/ventas', 'order:read'], agenda: ['/agenda', 'appointment:read'], conversaciones: ['/conversaciones', 'conversation:read'], ia: ['/ia', 'ai:read'], facturacion: ['/facturacion', 'invoice:read'], comisiones: ['/configuracion', 'tenant:configure'], membresias: ['/configuracion', 'tenant:configure'] };
              const destination = destinations[priority.modulo];
              if (!destination || !puede(destination[1]) || !s.modulos.includes(priority.modulo)) return null;
              return <li key={`${priority.modulo}-${i}`}><Link to={destination[0]}><strong>{priority.titulo}</strong><span>{priority.descripcion}</span><Icon n="flecha" size={16} className="" /></Link></li>;
            })}</ul>}
          </div>
        </section>}
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {cargando && !data && <div className="tarjeta"><Cargando filas={8} /></div>}
        {data && (
          <>
            {data.pasos && data.pasos.completos < data.pasos.total && <PrimerosPasos p={data.pasos} />}
            {data.atencion.length === 0 ? (
              <div className="tarjeta pad fila" style={{ gap: 10 }}>
                <span className="estado ok"><Icon n="ok" className="" />Al día</span>
                <span className="sec">Nada requiere tu atención: no hay facturas rechazadas, casos sin responder ni productos bajo mínimo.</span>
              </div>
            ) : (
              <Tarjeta titulo={<span className="fila">Requiere tu atención <span className="estado warn">{data.atencion.length}</span></span>} nivel={data.atencion.some((a: any) => a.nivel === 'error') ? 3 : 2}>
                <div>
                  {data.atencion.map((a: any, i: number) => (
                    <div key={i} className="atencion-fila">
                      <Estado v={a.nivel === 'error' ? 'RECHAZADO' : a.nivel === 'warn' ? 'PENDIENTE' : 'ESCALADA'} texto={a.tipo === 'factura_rechazada' ? 'DIAN' : a.tipo === 'caso' ? 'Caso' : a.tipo === 'stock' ? 'Stock' : a.tipo === 'entrega' ? 'WhatsApp' : 'IA'} />
                      <span style={{ minWidth: 0 }}><span className="lista-titulo">{a.titulo}</span><br /><span className="lista-detalle">{a.detalle}</span></span>
                      <Link className="btn peq" to={a.accion.ruta}>{a.accion.etiqueta}<Icon n="derecha" className="" size={14} /></Link>
                    </div>
                  ))}
                </div>
              </Tarjeta>
            )}

            <div className="kpis" aria-label="Resumen de hoy">
              <Cifra etiqueta="Ventas de hoy" valor={cop(data.cifras.ventas_hoy)} detalle={`${data.cifras.n_ventas_hoy} ${data.cifras.n_ventas_hoy === 1 ? 'venta' : 'ventas'} · semana ${cop(data.cifras.ventas_semana)}`} />
              <Cifra etiqueta="Citas de hoy" valor={data.cifras.citas_hoy} detalle={`${data.cifras.citas_hoy_ia} agendadas por el agente`} />
              <Cifra etiqueta="Conversaciones abiertas" valor={data.cifras.conversaciones_abiertas} detalle={`${data.cifras.escaladas} con una persona`} />
              {puede('order:read') ? <Cifra etiqueta="Por cobrar" valor={cop(data.cifras.por_cobrar)} detalle={<Link to="/ventas?pago=PENDIENTE">Ver ventas sin pagar</Link>} />
                : <Cifra etiqueta="Clientes nuevos (7 días)" valor={data.cifras.clientes_nuevos} detalle={`${data.cifras.resueltas_ia_semana} conversaciones resueltas por la IA`} />}
            </div>

            <div className="grid g-main" style={{ alignItems: 'start' }}>
              <div className="col" style={{ gap: 16 }}>
                {puede('appointment:read') && (
                  <Tarjeta titulo="Agenda de hoy" acciones={<Link to="/agenda" className="btn sutil peq">Abrir agenda</Link>}>
                    {data.agenda.length === 0 ? <Vacio titulo="Sin citas hoy">Las citas que agende el equipo o el agente aparecerán aquí.</Vacio> : (
                      <div>
                        {data.agenda.map((a: any) => (
                          <div key={a.id} className="cita-fila">
                            <span className="h">{a.hora}</span>
                            <span style={{ minWidth: 0 }}><span className="lista-titulo cortar" style={{ display: 'block' }}>{a.cliente}</span><span className="lista-detalle">{a.servicio} · {a.recurso}</span></span>
                            <span className="fila" style={{ gap: 6 }}>{a.origen === 'AGENTE' && <Estado v="AGENTE" texto="IA" />}<Estado v={a.estado} /></span>
                          </div>
                        ))}
                      </div>
                    )}
                    {data.ocupacion.length > 0 && <div className="fila envolver" style={{ marginTop: 12, gap: 6 }} aria-label="Citas por persona">{data.ocupacion.map((o: any) => <span key={o.nombre} className="chip">{o.nombre} <b>{o.citas}</b></span>)}</div>}
                  </Tarjeta>
                )}
                {puede('conversation:read') && (
                  <Tarjeta titulo="Hilo en vivo" acciones={<Link to="/conversaciones" className="btn sutil peq">Ver bandeja</Link>}>
                    {data.hilo.length === 0 ? <Vacio titulo="Sin conversaciones todavía">Cuando tus clientes escriban por WhatsApp, verás aquí lo que responde y ejecuta la IA.</Vacio> : (
                      <div className="hilo dashboard-feed">
                        {data.hilo.map((h: any) => h.kind === 'recibo'
                          ? <Recibo key={h.id} e={{ ...h, nivel_riesgo: h.riesgo, permiso_requerido: h.permiso, motivo_denegacion: h.motivo }} compacto />
                          : <Mensaje key={h.id} a={`/conversaciones/${h.conversation_id}`} tipo={TIPO[h.remitente] ?? 'sistema'} quien={h.remitente === 'CUSTOMER' ? h.cliente : undefined} hora={hora(h.creado_en)}>
                              {h.texto.length > 220 ? h.texto.slice(0, 220) + '…' : h.texto}
                            </Mensaje>)}
                      </div>
                    )}
                  </Tarjeta>
                )}
                <Asistente />
              </div>
              <div className="col" style={{ gap: 16 }}>
                {data.fiscal && <Tarjeta titulo="Ciclo fiscal de hoy" acciones={<Link to="/facturacion" className="btn sutil peq">Facturación</Link>}><CicloFiscal conteos={data.fiscal} /></Tarjeta>}
                {data.ingresos.length > 0 && <Tarjeta titulo="Ingresos de los últimos 7 días">{data.ingresos.some((d: any) => d.total > 0) ? <Barras datos={data.ingresos} /> : <Vacio titulo="Sin ventas esta semana">Cuando registres ventas, aquí verás cuánto entra cada día.</Vacio>}</Tarjeta>}
                {data.consumo && (
                  <Tarjeta titulo="Consumo del plan" acciones={<Link to="/suscripcion" className="btn sutil peq">Detalle</Link>}>
                    <div className="col" style={{ gap: 14 }}>
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

/** Configuración inicial: cada paso se marca solo cuando el dato existe en el servidor. */
function PrimerosPasos({ p }: { p: { pasos: { clave: string; titulo: string; hecho: boolean; ruta: string; detalle: string }[]; completos: number; total: number } }) {
  return (
    <section className="tarjeta pasos-inicio" aria-labelledby="pasos-titulo">
      <div className="cab">
        <h2 className="titulo-tarjeta" id="pasos-titulo">Deja tu negocio listo para atender</h2>
        <span className="tenue peq-txt" style={{ marginLeft: 'auto' }}>{p.completos} de {p.total} listos</span>
        <div className="progreso" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.completos} aria-label="Pasos completados"><i style={{ width: `${(p.completos / p.total) * 100}%` }} /></div>
      </div>
      <ol className="pasos-lista">
        {p.pasos.map((x) => (
          <li key={x.clave} className={x.hecho ? 'hecho' : ''}>
            <span className="marca-paso" aria-hidden="true">{x.hecho ? <Icon n="ok" className="" size={13} /> : null}</span>
            <span className="txt"><b>{x.titulo}</b><span className="tenue peq-txt">{x.detalle}</span></span>
            {!x.hecho && <Link className="btn peq" to={x.ruta}>Hacerlo<Icon n="derecha" className="" size={14} /></Link>}
            {x.hecho && <span className="sr">(listo)</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Barras({ datos }: { datos: { dia: string; total: number }[] }) {
  const max = Math.max(...datos.map((d) => d.total), 1);
  const hoy = hoyLocal();
  return (
    <>
      <div className="barras" role="img" aria-label={`Ingresos por día: ${datos.map((d) => `${d.dia} ${cop(d.total)}`).join(', ')}`}>
        {datos.map((d) => (
          <div key={d.dia} className={`b ${d.dia === hoy ? 'hoy' : ''}`} title={`${d.dia}: ${cop(d.total)}`}>
            <span>{d.total ? `${Math.round(d.total / 1000)}k` : '0'}</span>
            <i style={{ height: `${(d.total / max) * 70}%` }} />
            <span>{d.dia === hoy ? 'hoy' : new Date(d.dia + 'T12:00:00Z').toLocaleDateString('es-CO', { weekday: 'short', timeZone: 'UTC' })}</span>
          </div>
        ))}
      </div>
      <p className="tenue peq-txt" style={{ marginTop: 8 }}>Miles de pesos, IVA incluido.</p>
    </>
  );
}

/** Consultar el negocio en lenguaje natural (CU-10). Cada respuesta muestra sus recibos. */
function Asistente() {
  const { puede, s } = useSesion();
  const [hist, setHist] = useState<{ role: 'user' | 'assistant'; text: string; recibos?: any[]; error?: boolean }[]>([]);
  const [q, setQ] = useState('');
  const [ocupado, setOcupado] = useState(false);
  if (!puede('ai:assist') || !s.modulos.includes('ia')) return null;
  const preguntar = async (e?: FormEvent, texto?: string) => {
    e?.preventDefault();
    const pregunta = (texto ?? q).trim();
    if (!pregunta || ocupado) return;
    setQ('');
    const nuevo = [...hist, { role: 'user' as const, text: pregunta }];
    setHist(nuevo);
    setOcupado(true);
    try {
      const r = await api.post('/api/t/asistente', { pregunta, historial: hist.map(({ role, text }) => ({ role, text })) });
      setHist([...nuevo, { role: 'assistant', text: r.texto, recibos: r.ejecuciones }]);
    } catch (err) {
      setQ(pregunta);
      setHist([...nuevo, { role: 'assistant', text: (err as Error).message, error: true }]);
    } finally { setOcupado(false); }
  };
  return (
    <Tarjeta titulo={<span className="fila"><Icon n="ia" className="" size={16} /> Pregúntale a tu negocio</span>}>
      <div className="hilo" aria-live="polite">
        {hist.length === 0 && (
          <div className="col" style={{ gap: 8 }}>
            <span className="tenue peq-txt">El asistente consulta tus datos con las mismas herramientas y permisos que verás en sus recibos.</span>
            <div className="fila envolver" style={{ gap: 6 }}>{[
              { texto: '¿Cuánto vendimos esta semana?', permiso: 'order:read', modulo: 'ventas' },
              { texto: '¿Qué citas hay hoy?', permiso: 'appointment:read', modulo: 'agenda' },
              { texto: '¿Qué productos están bajo mínimo?', permiso: 'catalog:read', modulo: 'inventario' },
              { texto: '¿Cómo va el consumo del plan?', permiso: 'subscription:manage', modulo: 'ia' },
            ].filter(p => puede(p.permiso) && s.modulos.includes(p.modulo)).map(p => <button key={p.texto} type="button" className="chip" onClick={() => preguntar(undefined, p.texto)} disabled={ocupado}>{p.texto}</button>)}</div>
          </div>
        )}
        {hist.map((h, i) => h.role === 'user'
          ? <Mensaje key={i} tipo="cliente" rol="Tú">{h.text}</Mensaje>
          : h.error
            ? <div key={i} className="bloqueado"><Icon n="alerta" className="" size={16} />{h.text}</div>
            : <div key={i} className="col" style={{ gap: 6, alignItems: 'flex-end', minWidth: 0 }}>
                <Mensaje tipo="ia" rol="Asistente">{h.text}</Mensaje>
                {h.recibos?.map((r) => <Recibo key={r.id} e={{ ...r, nivel_riesgo: r.riesgo, motivo_denegacion: r.motivo }} compacto />)}
              </div>)}
        {ocupado && <span className="tenue peq-txt" style={{ alignSelf: 'flex-end' }}>Consultando…</span>}
      </div>
      <form className="fila" style={{ marginTop: 12 }} onSubmit={preguntar}>
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ej.: ¿qué citas tengo mañana?" aria-label="Pregunta al asistente" />
        <button className="btn primario" disabled={ocupado || !q.trim()}>Preguntar</button>
      </form>
      <div className="assistant-support"><span>Si la respuesta no resuelve tu consulta, puedes pedir ayuda.</span><Link to="/soporte">Solicitar atención humana <Icon n="flecha" size={14} className="" /></Link></div>
    </Tarjeta>
  );
}
