import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, cop, fechaLarga, hora, hoyLocal, num } from '../../api';
import { useSesion } from '../../components/Layout';
import { Cargando, CicloFiscal, ErrorCarga, Estado, Mensaje, Recibo, Tarjeta, useApi, Vacio, type TipoMensaje } from '../../components/ui';
import { Icon } from '../../components/icons';
import { AiOrb } from '../../components/AiOrb';
import { ThinkingOrb } from 'thinking-orbs';
import { useWorkspaceBirthReady } from '../../components/WorkspaceBirth';
import { Contador, escalon } from '../../components/Movimiento';
import { Pulso, type FichaPulso } from '../../components/Pulso';
import { Anillo, BarrasVivas, Chispa, TarjetaCifra } from '../../components/Tablero';

const TIPO: Record<string, TipoMensaje> = { CUSTOMER: 'cliente', AI: 'ia', HUMAN: 'humano' };

/** SCR-009 · Panel de inicio: la operación manda (P4). Primero lo que espera a una persona. */
export function Inicio() {
  const { s, puede } = useSesion();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get('/api/t/inicio'), [], { cada: 20000 });
  useWorkspaceBirthReady(!!data || !!error);
  const personalizacion = s.tenant.registro_datos?.inicio_ia;
  const accesos = ([
    ['appointment:create', '/agenda', 'agenda', 'Agendar cita'], ['order:create', '/ventas', 'ventas', 'Registrar venta'],
    ['customer:write', '/clientes', 'clientes', 'Añadir cliente'], ['conversation:read', '/conversaciones', 'conversaciones', 'Mensajes'],
  ] as const).filter(([p]) => puede(p));
  const h = new Date().getHours();
  const saludo = personalizacion?.titulo || `${h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches'}, ${s.usuario.nombre.split(' ')[0]}`;
  return (
    <>
      <header className="tb-cabecera">
        <div className="tb-cabecera-txt">
          <span className="tb-eyebrow">{data ? fechaLarga(data.fecha) : s.tenant.nombre}</span>
          <h1>{saludo}</h1>
          <p>{data ? resumenDelDia(data, puede) : `Así va ${s.tenant.nombre} hoy.`}</p>
        </div>
        {accesos.length > 0 && <nav className="tb-accesos" aria-label="Accesos rápidos">{accesos.map(([p, to, icon, label], i) => <Link key={p} className="tb-acceso" to={to} style={{ ['--i' as any]: i }}><span><Icon n={icon} className="" size={18} /></span>{label}</Link>)}</nav>}
      </header>
      <div className="contenido tablero-entrada">
        {data && <PulsoDelDia data={data} puede={puede} />}
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {cargando && !data && <div className="tarjeta"><Cargando filas={8} /></div>}
        {data && (
          <>
            <div className="tb-bento" aria-label="Resumen de hoy">
              {puede('order:read') && <TarjetaCifra i={0} icono="ventas" etiqueta="Ventas de hoy" valor={data.cifras.ventas_hoy} formato={cop} ruta="/ventas" tono="acento"
                detalle={`${data.cifras.n_ventas_hoy} ${data.cifras.n_ventas_hoy === 1 ? 'venta' : 'ventas'} · semana ${cop(data.cifras.ventas_semana)}`}
                grafica={<Chispa serie={(data.ingresos ?? []).map((d: any) => Number(d.total))} etiqueta="Ventas de los últimos 7 días" />} />}
              {puede('appointment:read') && <TarjetaCifra i={1} icono="agenda" etiqueta="Citas de hoy" valor={data.cifras.citas_hoy} ruta="/agenda" tono="persona"
                detalle={data.cifras.citas_hoy ? `${data.cifras.citas_hoy_ia} agendadas por la IA` : 'Ninguna por ahora'}
                grafica={data.cifras.citas_hoy > 0 ? <Anillo valor={data.cifras.citas_hoy_ia} max={data.cifras.citas_hoy} tam={48} grosor={6} tono="ia" etiqueta={`${data.cifras.citas_hoy_ia} de ${data.cifras.citas_hoy} citas las agendó la IA`}><small>IA</small></Anillo> : undefined} />}
              {puede('conversation:read') && <TarjetaCifra i={2} icono="conversaciones" etiqueta="Conversaciones abiertas" valor={data.cifras.conversaciones_abiertas} ruta="/conversaciones" tono={data.cifras.escaladas ? 'aviso' : 'ia'}
                detalle={data.cifras.escaladas ? `${data.cifras.escaladas} ${data.cifras.escaladas === 1 ? 'espera' : 'esperan'} a una persona` : 'La IA las tiene al día'}
                grafica={data.cifras.conversaciones_abiertas > 0 ? <Anillo valor={data.cifras.conversaciones_abiertas - data.cifras.escaladas} max={data.cifras.conversaciones_abiertas} tam={48} grosor={6} tono="ia" etiqueta={`${data.cifras.conversaciones_abiertas - data.cifras.escaladas} de ${data.cifras.conversaciones_abiertas} las atiende la IA`}><small>IA</small></Anillo> : undefined} />}
              {puede('order:read') ? <TarjetaCifra i={3} icono="reloj" etiqueta="Por cobrar" valor={data.cifras.por_cobrar} formato={cop} ruta="/ventas?pago=PENDIENTE" tono={data.cifras.por_cobrar > 0 ? 'aviso' : 'ok'}
                  detalle={data.cifras.por_cobrar > 0 ? 'Ventas con saldo pendiente' : 'Todo cobrado'} />
                : <TarjetaCifra i={3} icono="clientes" etiqueta="Clientes nuevos · 7 días" valor={data.cifras.clientes_nuevos} tono="ok" detalle={`${data.cifras.resueltas_ia_semana} conversaciones resueltas por la IA`} />}
            </div>

            {data.atencion.length === 0 ? (
              <div className="tb-al-dia"><span className="tb-al-dia-ico"><Icon n="ok" className="" size={18} /></span><div><b>Todo al día</b><span>No hay facturas rechazadas, casos sin responder ni productos bajo mínimo.</span></div></div>
            ) : (
              <section className="tarjeta tb-atencion" aria-labelledby="tb-atencion-t">
                <div className="cab"><h2 className="titulo-tarjeta" id="tb-atencion-t">Requiere tu atención</h2><span className={`tb-contador ${data.atencion.some((a: any) => a.nivel === 'error') ? 'error' : ''}`}>{data.atencion.length}</span></div>
                <ul className="tb-atencion-lista">
                  {data.atencion.map((a: any, i: number) => (
                    <li key={i} className={`n-${a.nivel}`} style={{ ['--i' as any]: i }}>
                      <span className="tb-atencion-ico"><Icon n={a.tipo === 'factura_rechazada' ? 'facturacion' : a.tipo === 'caso' ? 'conversaciones' : a.tipo === 'stock' ? 'inventario' : a.tipo === 'entrega' ? 'alerta' : a.tipo === 'pago_excedente' ? 'efectivo' : 'ia'} className="" size={16} /></span>
                      <span className="tb-atencion-txt"><b>{a.titulo}</b><span>{a.detalle}</span></span>
                      <Link className="btn peq" to={a.accion.ruta}>{a.accion.etiqueta}<Icon n="derecha" className="" size={14} /></Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {data.pasos && data.pasos.completos < data.pasos.total && <PrimerosPasos p={data.pasos} />}

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

            <div className="tb-rejilla">
              <div className="tb-columna">
                {data.ingresos.length > 0 && (
                  <Tarjeta titulo="Ingresos de los últimos 7 días" acciones={<Link to="/ventas" className="btn sutil peq">Ventas</Link>}>
                    {data.ingresos.some((d: any) => d.total > 0) ? (
                      <BarrasVivas etiqueta="Ingresos por día" formato={cop} datos={data.ingresos.map((d: any) => ({ clave: d.dia, valor: Number(d.total), destacado: d.dia === hoyLocal(), corto: d.dia === hoyLocal() ? 'Hoy' : new Date(d.dia + 'T12:00:00Z').toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).replace('.', '') }))} />
                    ) : <Vacio titulo="Sin ventas esta semana">Cuando registres ventas, aquí verás cuánto entra cada día.</Vacio>}
                  </Tarjeta>
                )}
                {puede('appointment:read') && (
                  <Tarjeta titulo="Agenda de hoy" acciones={<Link to="/agenda" className="btn sutil peq">Abrir agenda</Link>}>
                    {data.agenda.length === 0 ? <Vacio titulo="Sin citas hoy">Las citas que agende el equipo o el agente aparecerán aquí.</Vacio> : (
                      <ol className="tb-agenda">
                        {data.agenda.map((a: any, i: number) => (
                          <li key={a.id} className={`e-${String(a.estado).toLowerCase()}`} style={{ ['--i' as any]: i }}>
                            <span className="tb-agenda-hora">{a.hora}</span>
                            <span className="tb-agenda-punto" aria-hidden="true" />
                            <span className="tb-agenda-txt"><b className="cortar">{a.cliente}</b><span className="cortar">{a.servicio} · {a.recurso}</span></span>
                            <span className="fila" style={{ gap: 6 }}>{a.origen === 'AGENTE' && <Estado v="AGENTE" texto="IA" />}<Estado v={a.estado} /></span>
                          </li>
                        ))}
                      </ol>
                    )}
                    {data.ocupacion.length > 0 && <div className="fila envolver" style={{ marginTop: 14, gap: 6 }} aria-label="Citas por persona">{data.ocupacion.map((o: any) => <span key={o.nombre} className="chip">{o.nombre} <b>{o.citas}</b></span>)}</div>}
                  </Tarjeta>
                )}
                {puede('conversation:read') && (
                  <Tarjeta titulo={<span className="fila" style={{ gap: 8 }}><span className="tb-en-vivo" aria-hidden="true" />Hilo en vivo</span>} acciones={<Link to="/conversaciones" className="btn sutil peq">Ver bandeja</Link>}>
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
              </div>
              <div className="tb-columna">
                <AccesoAsistente />
                {data.cobros_hoy && <CobradoHoy c={data.cobros_hoy} />}
                {data.fiscal && <Tarjeta titulo="Ciclo fiscal de hoy" acciones={<Link to="/facturacion" className="btn sutil peq">Facturación</Link>}><CicloFiscal conteos={data.fiscal} /></Tarjeta>}
                {data.consumo && (
                  <Tarjeta titulo="Consumo del plan" acciones={<Link to="/suscripcion" className="btn sutil peq">Detalle</Link>}>
                    <div className="tb-consumo">
                      {([['IA', data.consumo.tokens_ia, 'ia'], ['Mensajes', data.consumo.mensajes, 'persona'], ['Documentos', data.consumo.documentos, 'ok']] as const).filter(([, c]) => c).map(([t, c, tono]) => {
                        const pct = Math.round(c.porcentaje ?? 0);
                        return (
                          <div key={t} className="tb-consumo-item" title={c.cuota ? `${num(c.usado)} de ${num(c.cuota)} · proyección al cierre ${Math.round(c.proyeccionPorcentaje ?? 0)} %` : 'Sin cuota en tu plan'}>
                            <Anillo valor={c.cuota ? Math.min(pct, 100) : 0} tam={68} grosor={7} tono={pct >= 100 ? 'error' : (c.proyeccionPorcentaje ?? 0) >= 90 ? 'aviso' : tono} etiqueta={c.cuota ? `${t}: ${pct} % del plan` : `${t}: sin cuota`}><b>{c.cuota ? `${pct}%` : '∞'}</b></Anillo>
                            <span>{t}</span>
                            <small>{c.cuota ? `${num(c.usado)} de ${num(c.cuota)}` : num(c.usado)}</small>
                          </div>
                        );
                      })}
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

/** Una línea que resume el día en lenguaje natural, con lo que el servidor contó. */
function resumenDelDia(data: any, puede: (p: string) => boolean): string {
  const c = data.cifras;
  const partes: string[] = [];
  if (puede('order:read')) partes.push(c.n_ventas_hoy ? `${c.n_ventas_hoy} ${c.n_ventas_hoy === 1 ? 'venta' : 'ventas'} por ${cop(c.ventas_hoy)}` : 'todavía sin ventas');
  if (puede('appointment:read')) partes.push(`${c.citas_hoy} ${c.citas_hoy === 1 ? 'cita' : 'citas'}`);
  if (puede('conversation:read') && c.escaladas) partes.push(`${c.escaladas} ${c.escaladas === 1 ? 'cliente espera' : 'clientes esperan'} respuesta`);
  if (!partes.length) return 'Así va tu negocio hoy.';
  const t = partes.join(', ');
  return `Hoy llevas ${t}.`;
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

/** El asistente tiene su propia sección (conserva la conversación); desde Inicio solo se abre con una pregunta. */
function AccesoAsistente() {
  const { puede, s } = useSesion();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  if (!puede('ai:assist') || !s.modulos.includes('ia')) return null;
  const abrir = (texto: string) => { if (texto.trim()) nav(`/asistente?q=${encodeURIComponent(texto.trim())}`); };
  return (
    <section className="tb-ia" aria-label="Pregúntale a tu negocio">
      <span className="tb-ia-brillo" aria-hidden="true" />
      <div className="tb-ia-cab">
        <span className="tb-ia-orbe"><AiOrb state="breathing" size={20} theme="dark" label="Asistente" /></span>
        <div><b>Pregúntale a tu negocio</b><span>Conoce tus ventas, citas e inventario y te muestra de dónde sale cada dato.</span></div>
      </div>
      <form className="tb-ia-form" onSubmit={(e: FormEvent) => { e.preventDefault(); abrir(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="¿Qué citas tengo mañana?" aria-label="Pregunta al asistente" />
        <button disabled={!q.trim()} aria-label="Preguntar"><Icon n="enviar" className="" size={16} /></button>
      </form>
      <div className="tb-ia-sugerencias">{[
        { texto: '¿Cuánto vendimos esta semana?', permiso: 'order:read', modulo: 'ventas' },
        { texto: '¿Qué citas hay hoy?', permiso: 'appointment:read', modulo: 'agenda' },
        { texto: '¿Qué productos están bajo mínimo?', permiso: 'catalog:read', modulo: 'inventario' },
        { texto: '¿Cómo va el consumo del plan?', permiso: 'subscription:manage', modulo: 'ia' },
      ].filter((p) => puede(p.permiso) && s.modulos.includes(p.modulo)).slice(0, 3).map((p) => <button key={p.texto} type="button" onClick={() => abrir(p.texto)}>{p.texto}</button>)}</div>
      <Link to="/asistente" className="tb-ia-abrir">Abrir el asistente<Icon n="derecha" className="" size={14} /></Link>
    </section>
  );
}

const METODOS_HOY: [string, string][] = [['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['datafono', 'Datáfono'], ['pasarela', 'Pasarela']];

/** Lo cobrado hoy por método: el total cuenta y cada método crece según su parte. */
function CobradoHoy({ c }: { c: any }) {
  const metodos = METODOS_HOY.filter(([k]) => c[k] > 0);
  return (
    <Tarjeta titulo="Cobrado hoy" acciones={<Link to="/ventas?caja=1" className="btn sutil peq">Caja del día</Link>}>
      {c.total <= 0 ? <Vacio titulo="Todavía no hay pagos hoy">Lo que cobres en efectivo, transferencia, datáfono o por enlace aparecerá aquí.</Vacio> : (
        <div className="col" style={{ gap: 12 }}>
          <span className="cobrado-hoy"><b className="num"><Contador valor={c.total} formato={cop} ms={900} /></b><span className="tenue peq-txt">{c.pagos} {c.pagos === 1 ? 'pago' : 'pagos'}</span></span>
          <ul className="reparto entra-escalonado">
            {metodos.map(([k, t], i) => (
              <li key={k} style={escalon(i)} data-metodo={k}>
                <span className="fila entre"><span>{t}</span><span className="num"><b>{cop(c[k])}</b> <span className="tenue peq-txt">{Math.round((c[k] / c.total) * 100)} %</span></span></span>
                <span className="reparto-barra" aria-hidden="true"><i style={{ width: `${(c[k] / c.total) * 100}%` }} /></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Tarjeta>
  );
}

/** Cabecera viva del Inicio: lo vendido hoy contando, frente a ayer, la semana dibujada y lo que espera. */
function PulsoDelDia({ data, puede }: { data: any; puede: (p: string) => boolean }) {
  const c = data.cifras;
  const serie: number[] = (data.ingresos ?? []).map((d: any) => Number(d.total));
  const ayer = serie.length >= 2 ? serie[serie.length - 2] : 0;
  // A primera hora no se compara contra un día completo: la tendencia aparece cuando ya hay ventas hoy.
  const tendencia = puede('order:read') && ayer > 0 && c.ventas_hoy > 0 ? { pct: ((c.ventas_hoy - ayer) / ayer) * 100, texto: 'frente a todo ayer' } : null;
  const errores = data.atencion.filter((a: any) => a.nivel === 'error').length;
  const fichas: FichaPulso[] = [];
  if (data.atencion.length) fichas.push({ icono: 'alerta', texto: `${data.atencion.length} ${data.atencion.length === 1 ? 'asunto espera' : 'asuntos esperan'} por ti`, tono: errores ? 'error' : 'aviso' });
  if (puede('appointment:read')) fichas.push({ icono: 'agenda', texto: `${c.citas_hoy} ${c.citas_hoy === 1 ? 'cita' : 'citas'} hoy`, ruta: '/agenda' });
  if (puede('conversation:read')) fichas.push({ icono: 'conversaciones', texto: `${c.conversaciones_abiertas} ${c.conversaciones_abiertas === 1 ? 'conversación abierta' : 'conversaciones abiertas'}${c.escaladas ? ` · ${c.escaladas} con una persona` : ''}`, tono: c.escaladas ? 'aviso' : 'neutro', ruta: '/conversaciones' });
  if (data.cobros_hoy) fichas.push({ icono: 'caja', texto: `Cobrado hoy ${cop(data.cobros_hoy.total)}`, tono: 'ok', ruta: '/ventas?caja=1' });
  if (puede('order:read') && c.por_cobrar > 0) fichas.push({ icono: 'reloj', texto: `Por cobrar ${cop(c.por_cobrar)}`, tono: 'aviso', ruta: '/ventas?pago=PENDIENTE' });
  return (
    <Pulso etiqueta="Vendido hoy" valor={c.ventas_hoy} formato={cop} tendencia={tendencia} serie={serie.length ? serie : undefined} serieEtiqueta="Ventas de los últimos 7 días"
      pie={`${c.n_ventas_hoy} ${c.n_ventas_hoy === 1 ? 'venta' : 'ventas'} · semana ${cop(c.ventas_semana)}${!tendencia && ayer > 0 ? ` · ayer ${cop(ayer)}` : ''}`} fichas={fichas} />
  );
}
