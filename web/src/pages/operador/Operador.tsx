import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { api, cop, descargar, fecha, fechaHora, hace, num } from '../../api';
import { Cabecera } from '../../components/Layout';
import { Campo, Cargando, Cifra, ErrorCarga, Estado, Interruptor, Modal, Paginador, Tarjeta, useAccion, useApi, useRetardo, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { MARCA } from '../../brand';

/**
 * Panel interno del operador de Omnegia. Separado del panel de las empresas: no
 * fija empresa, no muestra clientes, conversaciones, ventas, citas, facturas ni
 * secretos. Todo lo que aparece aquí lo entrega el servidor con una lista cerrada
 * de campos; la pantalla no oculta nada que haya recibido.
 */
interface Yo { id: string; nombre: string; email: string; rol: 'ADMIN' | 'SOPORTE'; permisos: string[] }
export const useYo = () => useOutletContext<{ yo: Yo; puede: (p: string) => boolean }>();

const SECCIONES: { to: string; n: string; t: string }[] = [
  { to: '/operador', n: 'inicio', t: 'Resumen' },
  { to: '/operador/empresas', n: 'plataforma', t: 'Empresas' },
  { to: '/operador/suscripciones', n: 'suscripcion', t: 'Suscripciones' },
  { to: '/operador/salud', n: 'salud', t: 'Salud del sistema' },
  { to: '/operador/incidentes', n: 'alerta', t: 'Incidentes' },
  { to: '/operador/integraciones', n: 'integraciones', t: 'Integraciones' },
  { to: '/operador/conversaciones', n: 'conversaciones', t: 'Conversaciones' },
  { to: '/operador/atencion', n: 'persona', t: 'Atención de las empresas' },
  { to: '/operador/soporte', n: 'soporte', t: 'Soporte' },
  { to: '/operador/reembolsos', n: 'suscripcion', t: 'Reembolsos' },
  { to: '/operador/auditoria', n: 'auditoria', t: 'Auditoría' },
];

export function OperadorLayout() {
  const loc = useLocation();
  const { data: yo, error } = useApi<Yo>(() => api.get('/api/operador/yo'), []);
  const [navAbierta, setNavAbierta] = useState(false);
  useEffect(() => setNavAbierta(false), [loc.pathname]);
  useEffect(() => { document.title = `Operador · ${MARCA.nombre}`; }, []);
  if (error?.status === 404 || error?.status === 401) {
    return (
      <div className="publico" style={{ display: 'grid', placeItems: 'center', padding: 24, minHeight: '100dvh' }}>
        <div className="tarjeta pad col" style={{ maxWidth: 440, gap: 16 }}>
          <div className="bloqueado"><Icon n="candado" className="" size={16} /> No encontramos eso.</div>
          <p className="sec">Esta sección es solo para el equipo de {MARCA.nombre} y exige iniciar sesión con el código enviado a tu correo.</p>
          <Link className="btn primario" to="/entrar">Iniciar sesión</Link>
        </div>
      </div>
    );
  }
  if (error) return <div className="pagina"><ErrorCarga error={error} /></div>;
  if (!yo) return <div className="pagina"><Cargando filas={6} /></div>;
  const puede = (p: string) => yo.permisos.includes(p);
  const salir = async () => { await api.post('/api/auth/logout').catch(() => {}); window.location.href = '/entrar'; };
  return (
    <div className={`app operador ${navAbierta ? 'nav-abierta' : ''}`}>
      <a className="saltar" href="#contenido">Saltar al contenido</a>
      <header className="barra-movil">
        <Link to="/operador" className="contexto"><span className="marca-negocio op-marca" aria-hidden="true"><img src={MARCA.icono} alt="" /></span><span className="contexto-txt"><b>{MARCA.nombre}</b><span>Operador</span></span></Link>
        <button className="btn sutil peq icono" onClick={() => setNavAbierta(true)} aria-label="Abrir navegación" aria-expanded={navAbierta} aria-controls="nav-operador"><Icon n="menu" className="" size={20} /></button>
      </header>
      <aside className="lateral" id="nav-operador" aria-label="Navegación del operador">
        <Link to="/operador" className="contexto">
          <span className="marca-negocio op-marca" aria-hidden="true"><img src={MARCA.icono} alt="" /></span>
          <span className="contexto-txt"><b>{MARCA.nombre}</b><span>Panel del operador</span></span>
        </Link>
        <nav className="nav-grupo" aria-label="Secciones">
          {SECCIONES.map((s) => (
            <NavLink key={s.to} to={s.to} end={s.to === '/operador'} className={({ isActive }) => `nav-item ${isActive ? 'activo' : ''}`}><Icon n={s.n} className="" size={18} />{s.t}</NavLink>
          ))}
        </nav>
        <div className="cuenta">
          <p className="op-privacidad"><Icon n="candado" className="" size={14} />Sin acceso a clientes, ventas ni facturas de las empresas. Sus conversaciones, solo si la empresa las comparte con soporte.</p>
          <div className="bloque" style={{ padding: '8px 4px' }}>
            <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{yo.nombre}</div>
            <div className="tenue peq-txt">{yo.rol === 'ADMIN' ? 'Administración' : 'Soporte'} · {yo.email}</div>
          </div>
          <button className="btn sutil peq" onClick={salir}><Icon n="salir" className="" size={16} />Cerrar sesión</button>
        </div>
      </aside>
      <div className="velo-nav" onClick={() => setNavAbierta(false)} aria-hidden="true" />
      <div className="marco">
        <main className="pagina" id="contenido" tabIndex={-1}><Outlet context={{ yo, puede }} /></main>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ utilidades
const hoyIso = () => new Date().toISOString().slice(0, 10);
const haceDias = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

function usePeriodo(dias = 30) {
  const [p, setP] = useState({ desde: haceDias(dias - 1), hasta: hoyIso() });
  return { p, setP, qs: `desde=${p.desde}&hasta=${p.hasta}` };
}

function SelectorPeriodo({ p, setP }: { p: { desde: string; hasta: string }; setP: (v: { desde: string; hasta: string }) => void }) {
  return (
    <div className="fila op-periodo" role="group" aria-label="Periodo">
      {[[7, '7 días'], [30, '30 días'], [90, '90 días']].map(([d, t]) => (
        <button key={d} className={`chip ${p.desde === haceDias(Number(d) - 1) && p.hasta === hoyIso() ? 'on' : ''}`} onClick={() => setP({ desde: haceDias(Number(d) - 1), hasta: hoyIso() })}>{t}</button>
      ))}
      <label className="sr" htmlFor="op-desde">Desde</label>
      <input id="op-desde" className="input peq" type="date" value={p.desde} max={p.hasta} onChange={(e) => e.target.value && setP({ ...p, desde: e.target.value })} />
      <span className="tenue">a</span>
      <label className="sr" htmlFor="op-hasta">Hasta</label>
      <input id="op-hasta" className="input peq" type="date" value={p.hasta} min={p.desde} max={hoyIso()} onChange={(e) => e.target.value && setP({ ...p, hasta: e.target.value })} />
    </div>
  );
}

const ms = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${num(v)} ms`);
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${String(v).replace('.', ',')} %`);
const ETIQUETA_ESTADO_EMPRESA: Record<string, string> = { ACTIVA: 'Activas', PAGO_PENDIENTE: 'Pago pendiente', EN_GRACIA: 'En gracia', SUSPENDIDA: 'Suspendidas', CANCELADA: 'Canceladas', SIN_SUSCRIPCION: 'Sin suscripción' };

function Barras({ datos, etiqueta }: { datos: { k: string; v: number; corto?: string }[]; etiqueta: string }) {
  const max = Math.max(1, ...datos.map((d) => d.v));
  if (!datos.length) return <p className="tenue">Sin datos en el periodo.</p>;
  return (
    <div className="barras" role="img" aria-label={`${etiqueta}: ${datos.map((d) => `${d.k} ${d.v}`).join(', ')}`}>
      {datos.map((d) => <div key={d.k} className="b" title={`${d.k}: ${d.v}`}><span>{d.v}</span><i style={{ height: `${Math.max(2, (d.v / max) * 100)}%` }} /><span>{d.corto ?? d.k}</span></div>)}
    </div>
  );
}

function Proporcion({ etiqueta, usado, cuota }: { etiqueta: string; usado: number; cuota: number }) {
  const p = cuota ? Math.min(100, (usado / cuota) * 100) : 0;
  return (
    <div className="medidor">
      <div className="fila entre"><span className="etiqueta">{etiqueta}</span><span className="valor">{cuota ? `${Math.round(p)} %` : num(usado)}</span></div>
      {cuota ? <div className={`barra ${p >= 100 ? 'err' : p >= 85 ? 'warn' : ''}`}><div className="uso" style={{ width: `${p}%` }} /></div> : null}
      <span className="tenue peq-txt">{num(usado)} de {cuota ? num(cuota) : 'sin límite'}</span>
    </div>
  );
}

// ------------------------------------------------------------------ resumen
export function OpResumen() {
  const per = usePeriodo(30);
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/resumen?${per.qs}`), [per.qs]);
  return (
    <>
      <Cabecera titulo="Resumen de la plataforma" sub="Cifras de Omnegia: empresas, suscripciones y salud técnica. Ningún dato de los clientes de las empresas."><SelectorPeriodo p={per.p} setP={per.setP} /></Cabecera>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando && !data ? <Cargando filas={6} /> : (
        <div className="col" style={{ gap: 16 }}>
          <div className="kpis">
            <Cifra etiqueta="Empresas activas" valor={num(data.empresas.por_estado.ACTIVA)} detalle={`${num(data.empresas.total)} registradas`} />
            <Cifra etiqueta="Altas y bajas" valor={`+${data.empresas.altas_periodo} / −${data.empresas.bajas_periodo}`} detalle="en el periodo" />
            <Cifra etiqueta="Ingresos aprobados" valor={cop(data.ingresos.aprobados.monto)} detalle={`${data.ingresos.aprobados.n} pagos · ${data.ingresos.pendientes.n} pendientes · ${data.ingresos.rechazados.n} rechazados`} />
            <Cifra etiqueta="Ingreso mensual recurrente" valor={cop(data.ingresos.mrr_estimado)} detalle="estimado con los planes vigentes" />
          </div>
          <div className="kpis">
            <Cifra etiqueta="Disponibilidad observada" valor={pct(data.solicitudes.disponibilidad)} detalle={`${num(data.solicitudes.total)} solicitudes · ${num(data.solicitudes.errores_5xx)} con error 5xx`} />
            <Cifra etiqueta="Latencia" valor={ms(data.solicitudes.latencia_media_ms)} detalle={`p95 ≤ ${ms(data.solicitudes.p95_ms)}`} />
            <Cifra etiqueta="Cola de trabajos" valor={num(data.cola.pendientes)} detalle={`${data.cola.fallidos} fallidos · ${data.cola.reintentando} reintentando`} />
            <Cifra etiqueta="Incidentes abiertos" valor={num(Object.values(data.incidentes_abiertos as Record<string, number>).reduce((a, b) => a + b, 0))} detalle={`${data.incidentes_abiertos.CRITICA} críticos · ${data.soporte_abiertos} ${data.soporte_abiertos === 1 ? 'ticket abierto' : 'tickets abiertos'}`} />
          </div>
          <div className="grid g2">
            <Tarjeta titulo="Empresas por estado">
              <dl className="datos-def">{Object.entries(data.empresas.por_estado).map(([k, v]) => <Fragment key={k}><dt>{ETIQUETA_ESTADO_EMPRESA[k] ?? k}</dt><dd>{num(v as number)}</dd></Fragment>)}</dl>
              <p className="tenue peq-txt" style={{ marginTop: 12 }}>No existe un periodo de prueba: una empresa se crea al confirmarse su primer pago.</p>
            </Tarjeta>
            <Tarjeta titulo="Altas por día">
              <Barras etiqueta="Altas por día" datos={data.serie_altas.slice(-14).map((d: any) => ({ k: d.dia, v: d.altas, corto: `${d.dia.slice(8)}/${d.dia.slice(5, 7)}` }))} />
            </Tarjeta>
            <Tarjeta titulo="Uso de módulos">
              <ul className="lista">{data.modulos.map((m: any) => <li key={m.codigo} className="fila entre"><span>{m.nombre}</span><b className="num">{m.empresas} {m.empresas === 1 ? 'empresa' : 'empresas'}</b></li>)}</ul>
            </Tarjeta>
            <Tarjeta titulo="Consumo técnico de IA">
              <dl className="datos-def">
                <dt>Llamadas al modelo</dt><dd>{num(data.ia.llamadas)} · {num(data.ia.errores)} con error</dd>
                <dt>Tokens de entrada</dt><dd>{num(data.ia.tokens_entrada)}</dd>
                <dt>Tokens de salida</dt><dd>{num(data.ia.tokens_salida)}</dd>
                <dt>Tokens del mes en curso</dt><dd>{num(data.ia.tokens_mes_actual)}</dd>
                <dt>Costo estimado del proveedor</dt><dd>{data.ia.costo_estimado_usd === null ? <span className="tenue">Sin precios configurados (variables IA_PRECIO_*_USD_MTOK)</span> : `US$ ${String(data.ia.costo_estimado_usd).replace('.', ',')}`}</dd>
              </dl>
              <p className="tenue peq-txt" style={{ marginTop: 12 }}>Solo cifras: ni instrucciones, ni conversaciones, ni respuestas del modelo.</p>
            </Tarjeta>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ empresas
export function OpEmpresas() {
  const [q, setQ] = useState('');
  const [estado, setEstado] = useState('');
  const [pagina, setPagina] = useState(1);
  const busqueda = useRetardo(q, 300);
  useEffect(() => setPagina(1), [busqueda, estado]);
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/empresas?q=${encodeURIComponent(busqueda)}&estado=${estado}&pagina=${pagina}`), [busqueda, estado, pagina]);
  const { run, ocupado } = useAccion();
  const nav = useNavigate();
  return (
    <>
      <Cabecera titulo="Empresas" sub="Datos mínimos para administrar la relación comercial.">
        <button className="btn" disabled={ocupado} onClick={() => run(() => descargar('/api/operador/empresas.csv', 'empresas.csv'), 'Exportación lista.')}><Icon n="descargar" className="" size={16} />Exportar CSV</button>
      </Cabecera>
      <Tarjeta sinCuerpo>
        <div className="filtros">
          <label className="buscar"><Icon n="buscar" className="" size={16} /><input placeholder="Nombre, subdominio o identificador" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar empresa" /></label>
          <select className="input" value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado de la suscripción">
            <option value="">Todos los estados</option>{Object.entries(ETIQUETA_ESTADO_EMPRESA).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {error ? <div className="cuerpo"><ErrorCarga error={error} reintentar={recargar} /></div> : cargando && !data ? <div className="cuerpo"><Cargando /></div> : !data.empresas.length ? <div className="cuerpo"><Vacio titulo="Sin resultados">Prueba con otro nombre o estado.</Vacio></div> : (
          <>
            <div className="tabla-wrap"><table className="tabla tabla-movil">
              <thead><tr><th>Empresa</th><th>Contacto administrativo</th><th>Plan</th><th>Suscripción</th><th>Vence</th><th>WhatsApp</th><th className="num">Personas</th></tr></thead>
              <tbody>{data.empresas.map((e: any) => (
                <tr key={e.id} className="enlace-fila" onClick={() => nav(`/operador/empresas/${e.id}`)}>
                  <td data-etiqueta="Empresa"><Link to={`/operador/empresas/${e.id}`}><b>{e.nombre}</b></Link><div className="tenue peq-txt mono">{e.slug}</div></td>
                  <td data-etiqueta="Contacto">{e.contacto_email ?? '—'}</td>
                  <td data-etiqueta="Plan">{e.plan_nombre ?? e.plan}</td>
                  <td data-etiqueta="Suscripción"><Estado v={e.estado} /></td>
                  <td data-etiqueta="Vence">{e.periodo_fin ? fecha(e.periodo_fin) : '—'}</td>
                  <td data-etiqueta="WhatsApp"><Estado v={e.whatsapp_estado} /></td>
                  <td data-etiqueta="Personas" className="num">{e.usuarios_activos}</td>
                </tr>))}
              </tbody></table></div>
            <Paginador pagina={data.pagina} total={data.total} porPagina={data.por_pagina} onPagina={setPagina} />
          </>
        )}
      </Tarjeta>
    </>
  );
}

function AccionConfirmada({ titulo, slug, efecto, peligro, children, listo = true, onConfirmar, onCerrar }: {
  titulo: string; slug: string; efecto: ReactNode; peligro?: boolean; children?: ReactNode; listo?: boolean; onConfirmar: (motivo: string, confirmacion: string) => Promise<unknown>; onCerrar: () => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [confirmacion, setConfirmacion] = useState('');
  const { run, ocupado, error } = useAccion();
  const valido = listo && motivo.trim().length >= 10 && confirmacion.trim() === slug;
  return (
    <Modal titulo={titulo} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Volver</button>
      <button className={`btn ${peligro ? 'peligro' : 'primario'}`} disabled={!valido || ocupado} onClick={async () => { const r = await run(() => onConfirmar(motivo, confirmacion), 'Cambio aplicado y auditado.', { silencioso: true }); if (r) onCerrar(); }}>{ocupado ? 'Aplicando…' : 'Confirmar'}</button></>}>
      <div>{efecto}</div>
      {children}
      <Campo etiqueta="Motivo" ayuda="Queda en la auditoría y se comunica a la empresa. Mínimo 10 caracteres."><textarea className="input" rows={3} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Campo>
      <Campo etiqueta={`Para confirmar, escribe el subdominio: ${slug}`}><input className="input mono" value={confirmacion} onChange={(e) => setConfirmacion(e.target.value)} autoComplete="off" /></Campo>
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
  );
}

export function OpEmpresa() {
  const { id } = useParams();
  const { puede } = useYo();
  const verificacion = useAccion();
  const [resultadoWa, setResultadoWa] = useState<{ estado: string; mensaje: string } | null>(null);
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/empresas/${id}`), [id]);
  const planes = useApi<any>(() => api.get('/api/operador/suscripciones'), []);
  const [accion, setAccion] = useState<null | 'SUSPENDIDA' | 'ACTIVA' | 'CANCELADA' | 'plan'>(null);
  const [plan, setPlan] = useState('');
  const [modulo, setModulo] = useState<null | { codigo: string; nombre: string; activo: boolean }>(null);
  if (error) return <><Cabecera titulo="Empresa" /><ErrorCarga error={error} reintentar={recargar} /></>;
  if (cargando && !data) return <Cargando filas={6} />;
  const e = data.empresa;
  const l = data.limites;
  const gestionar = puede('empresas:gestionar');
  const textoEstado: Record<string, ReactNode> = {
    SUSPENDIDA: <>La empresa pasa a <b>solo lectura</b>: su equipo puede consultar y exportar, pero no registrar cambios, y el agente deja de atender WhatsApp. <b>No se borra ningún dato</b> y se puede reactivar.</>,
    ACTIVA: <>La empresa vuelve a operar con normalidad. Si su periodo ya venció, se extiende un mes.</>,
    CANCELADA: <>La empresa <b>pierde el acceso</b> al panel. Sus datos <b>no se borran</b> y la cancelación se puede revertir reactivándola.</>,
  };
  return (
    <>
      <Cabecera titulo={e.nombre} sub={<span className="fila" style={{ gap: 8, flexWrap: 'wrap' }}><span className="mono">{e.slug}</span><span>·</span><span className="mono tenue">{e.id}</span><Estado v={e.estado} /></span>}>
        <Link className="btn" to="/operador/empresas"><Icon n="atras" className="" size={16} />Empresas</Link>
        {gestionar && e.estado !== 'SUSPENDIDA' && e.estado !== 'CANCELADA' && <button className="btn" onClick={() => setAccion('SUSPENDIDA')}>Suspender</button>}
        {gestionar && (e.estado === 'SUSPENDIDA' || e.estado === 'CANCELADA') && <button className="btn primario" onClick={() => setAccion('ACTIVA')}>Reactivar</button>}
        {gestionar && e.estado !== 'CANCELADA' && <button className="btn peligro" onClick={() => setAccion('CANCELADA')}>Cancelar servicio</button>}
      </Cabecera>
      <div className="col" style={{ gap: 16 }}>
      <div className="grid g2">
        <Tarjeta titulo="Relación comercial" acciones={gestionar && <button className="btn peq" onClick={() => { setPlan(e.plan); setAccion('plan'); }}>Cambiar plan</button>}>
          <dl className="datos-def">
            <dt>Contacto administrativo</dt><dd>{e.contacto_email ?? '—'}</dd>
            <dt>Sector</dt><dd>{e.sector}</dd>
            <dt>Plan</dt><dd>{l?.plan ? `${l.plan.nombre} · ${cop(l.plan.precio_mensual)} al mes` : e.plan}</dd>
            <dt>Suscripción</dt><dd><Estado v={e.estado} /></dd>
            <dt>Periodo</dt><dd>{e.periodo_inicio ? `${fecha(e.periodo_inicio)} – ${fecha(e.periodo_fin)}` : '—'}</dd>
            {e.gracia_hasta && <><dt>Gracia hasta</dt><dd>{fecha(e.gracia_hasta)}</dd></>}
            <dt>Alta</dt><dd>{fecha(e.creado_en)}</dd>
          </dl>
        </Tarjeta>
        <Tarjeta titulo="Límites y consumo del mes">
          {l ? <div className="col" style={{ gap: 14 }}>
            <Proporcion etiqueta="Tokens de IA" usado={l.uso_mes.tokens_ia} cuota={l.cuotas.tokens_ia} />
            <Proporcion etiqueta="Mensajes" usado={l.uso_mes.mensajes} cuota={l.cuotas.mensajes} />
            <Proporcion etiqueta="Documentos fiscales" usado={l.uso_mes.documentos} cuota={l.cuotas.documentos} />
            <Proporcion etiqueta="Personas con acceso" usado={l.usuarios_activos} cuota={l.cuotas.usuarios} />
          </div> : <p className="tenue">Sin plan asociado.</p>}
        </Tarjeta>
        <Tarjeta titulo="Módulos">
          <ul className="lista">{data.modulos.map((m: any) => (
            <li key={m.codigo} className="fila entre">
              <span>{m.nombre}{m.incluido_en_plan ? '' : <span className="tenue peq-txt"> · fuera del plan</span>}</span>
              <Interruptor on={m.activo} disabled={!gestionar} etiqueta={`${m.activo ? 'Desactivar' : 'Activar'} ${m.nombre}`} onChange={() => setModulo(m)} />
            </li>))}
          </ul>
        </Tarjeta>
        <Tarjeta titulo="Estado técnico" acciones={puede('integraciones:verificar') && <button className="btn peq" disabled={verificacion.ocupado} onClick={async () => { const r = await verificacion.run(() => api.post(`/api/operador/empresas/${e.id}/whatsapp/verificar`)); if (r) { setResultadoWa(r as any); recargar(); } }}>{verificacion.ocupado ? 'Consultando a Meta…' : 'Verificar WhatsApp'}</button>}>
          {resultadoWa && <p className={`aviso peq-txt ${resultadoWa.estado === 'CONECTADO' ? 'exito' : ''}`} role="status" style={{ marginBottom: 12 }}><Icon n={resultadoWa.estado === 'CONECTADO' ? 'ok' : 'info'} className="" size={14} /><span>{resultadoWa.mensaje}</span></p>}
          <dl className="datos-def">
            <dt>WhatsApp</dt><dd><Estado v={data.tecnico.whatsapp_estado} /></dd>
            <dt>Correos (30 días)</dt><dd>{Object.entries(data.tecnico.correos_30_dias).map(([k, v]) => `${ESTADO_CORREO[k] ?? k}: ${v}`).join(' · ') || 'Sin envíos'}</dd>
            <dt>Incidentes abiertos</dt><dd>{data.tecnico.incidentes_abiertos ? <Link to={`/operador/incidentes`}>{data.tecnico.incidentes_abiertos}</Link> : 0}</dd>
            <dt>Tickets abiertos</dt><dd>{data.tecnico.tickets_abiertos}</dd>
          </dl>
        </Tarjeta>
      </div>
      <Tarjeta titulo="Pagos de la suscripción" sinCuerpo>
        {!data.pagos.length ? <div className="cuerpo"><Vacio titulo="Sin pagos registrados" /></div> : (
          <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Fecha</th><th>Concepto</th><th>Referencia</th><th className="num">Valor</th><th>Estado</th></tr></thead>
            <tbody>{data.pagos.map((p: any) => <tr key={p.referencia}><td data-etiqueta="Fecha">{fechaHora(p.fecha)}</td><td data-etiqueta="Concepto">{p.concepto}</td><td data-etiqueta="Referencia" className="mono">{p.referencia}</td><td data-etiqueta="Valor" className="num">{cop(p.monto)}</td><td data-etiqueta="Estado"><Estado v={p.estado} /></td></tr>)}</tbody></table></div>
        )}
      </Tarjeta>
      </div>

      {accion && accion !== 'plan' && (
        <AccionConfirmada titulo={accion === 'SUSPENDIDA' ? 'Suspender el servicio' : accion === 'ACTIVA' ? 'Reactivar el servicio' : 'Cancelar el servicio'} slug={e.slug} peligro={accion !== 'ACTIVA'}
          efecto={textoEstado[accion]} onCerrar={() => setAccion(null)}
          onConfirmar={async (motivo, confirmacion) => { const r = await api.post(`/api/operador/empresas/${e.id}/estado`, { estado: accion, motivo, confirmacion }); recargar(); return r; }} />
      )}
      {accion === 'plan' && (
        <AccionConfirmada titulo="Cambiar el plan" slug={e.slug} efecto={<>Cambia las cuotas y el precio de las próximas renovaciones. Los módulos activos no se modifican.</>} listo={!!plan && plan !== e.plan}
          onCerrar={() => setAccion(null)} onConfirmar={async (motivo, confirmacion) => { const r = await api.post(`/api/operador/empresas/${e.id}/plan`, { plan, motivo, confirmacion }); recargar(); return r; }}>
          <Campo etiqueta="Plan nuevo"><select className="input" value={plan} onChange={(ev) => setPlan(ev.target.value)}>{(planes.data?.planes ?? []).map((p: any) => <option key={p.codigo} value={p.codigo}>{p.nombre} · {cop(p.precio_mensual)}</option>)}</select></Campo>
        </AccionConfirmada>
      )}
      {modulo && <CambiarModulo empresa={e.id} m={modulo} onCerrar={() => setModulo(null)} onHecho={() => { setModulo(null); recargar(); }} />}
    </>
  );
}

const ESTADO_CORREO: Record<string, string> = { PENDIENTE: 'En cola', ENVIADO: 'Aceptados', ENTREGADO: 'Entregados', REBOTADO: 'Rebotados', QUEJA: 'Spam', FALLIDO: 'Fallidos' };

function CambiarModulo({ empresa, m, onCerrar, onHecho }: { empresa: string; m: { codigo: string; nombre: string; activo: boolean }; onCerrar: () => void; onHecho: () => void }) {
  const [motivo, setMotivo] = useState('');
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo={`${m.activo ? 'Desactivar' : 'Activar'} ${m.nombre}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Volver</button>
      <button className="btn primario" disabled={ocupado || motivo.trim().length < 10} onClick={async () => { const r = await run(() => api.post(`/api/operador/empresas/${empresa}/modulos`, { modulo: m.codigo, activo: !m.activo, motivo }), 'Módulo actualizado.', { silencioso: true }); if (r) onHecho(); }}>Confirmar</button></>}>
      <p className="sec">{m.activo ? 'La empresa deja de ver este módulo. Sus datos se conservan y vuelven a estar disponibles al activarlo.' : 'La empresa podrá usar este módulo desde ahora.'} Se le avisa por correo.</p>
      <Campo etiqueta="Motivo" ayuda="Mínimo 10 caracteres."><textarea className="input" rows={3} maxLength={300} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Campo>
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ suscripciones
export function OpSuscripciones() {
  const per = usePeriodo(90);
  const { puede } = useYo();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/suscripciones?${per.qs}`), [per.qs]);
  const [editar, setEditar] = useState<any>(null);
  return (
    <>
      <Cabecera titulo="Suscripciones" sub="Planes, renovaciones y pagos que recibe Omnegia. No incluye las ventas de las empresas."><SelectorPeriodo p={per.p} setP={per.setP} /></Cabecera>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando && !data ? <Cargando filas={6} /> : (
        <div className="col" style={{ gap: 16 }}>
          <Tarjeta titulo="Planes" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Plan</th><th className="num">Precio</th><th className="num">Tokens IA</th><th className="num">Mensajes</th><th className="num">Documentos</th><th className="num">Personas</th><th className="num">Vigentes</th><th><span className="sr">Acciones</span></th></tr></thead>
              <tbody>{data.planes.map((p: any) => (
                <tr key={p.codigo}>
                  <td data-etiqueta="Plan"><b>{p.nombre}</b></td><td data-etiqueta="Precio" className="num">{cop(p.precio_mensual)}</td>
                  <td data-etiqueta="Tokens IA" className="num">{num(p.cuotas.tokens_ia)}</td><td data-etiqueta="Mensajes" className="num">{num(p.cuotas.mensajes)}</td>
                  <td data-etiqueta="Documentos" className="num">{num(p.cuotas.documentos)}</td><td data-etiqueta="Personas" className="num">{p.cuotas.usuarios}</td>
                  <td data-etiqueta="Vigentes" className="num">{p.empresas_vigentes}</td>
                  <td>{puede('planes:gestionar') && <button className="btn peq" onClick={() => setEditar(p)}>Editar límites</button>}</td>
                </tr>))}
              </tbody></table></div>
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Altas y bajas por mes">
              {!data.evolucion.length ? <p className="tenue">Sin movimientos en el periodo.</p> : (
                <ul className="lista">{data.evolucion.map((m: any) => <li key={m.mes} className="fila entre"><span>{m.mes}</span><span className="num">+{m.altas} · −{m.bajas}</span></li>)}</ul>
              )}
            </Tarjeta>
            <Tarjeta titulo="Por renovar o en riesgo">
              {!data.por_renovar.length ? <p className="tenue">Ninguna en los próximos 14 días.</p> : (
                <ul className="lista">{data.por_renovar.map((r: any) => <li key={r.empresa_id} className="fila entre"><Link to={`/operador/empresas/${r.empresa_id}`}>{r.empresa}</Link><span className="fila" style={{ gap: 8 }}><Estado v={r.estado} /><span className="tenue peq-txt">{fecha(r.periodo_fin)}</span></span></li>)}</ul>
              )}
            </Tarjeta>
          </div>
          <Tarjeta titulo="Pagos de suscripción" sinCuerpo>
            {!data.pagos.length ? <div className="cuerpo"><Vacio titulo="Sin pagos en el periodo" /></div> : (
              <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Fecha</th><th>Empresa</th><th>Concepto</th><th>Pasarela</th><th className="num">Valor</th><th>Estado</th></tr></thead>
                <tbody>{data.pagos.map((p: any) => <tr key={p.referencia}><td data-etiqueta="Fecha">{fechaHora(p.fecha)}</td><td data-etiqueta="Empresa">{p.empresa_id ? <Link to={`/operador/empresas/${p.empresa_id}`}>{p.empresa}</Link> : <span className="tenue">Alta en curso</span>}</td><td data-etiqueta="Concepto">{p.concepto}</td><td data-etiqueta="Pasarela">{p.proveedor}</td><td data-etiqueta="Valor" className="num">{cop(p.monto)}</td><td data-etiqueta="Estado"><Estado v={p.estado} /></td></tr>)}</tbody></table></div>
            )}
          </Tarjeta>
        </div>
      )}
      {editar && <EditarPlan p={editar} onCerrar={() => setEditar(null)} onHecho={() => { setEditar(null); recargar(); }} />}
    </>
  );
}

function EditarPlan({ p, onCerrar, onHecho }: { p: any; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState({ cuota_tokens_ia: p.cuotas.tokens_ia, cuota_mensajes: p.cuotas.mensajes, cuota_documentos: p.cuotas.documentos, max_usuarios: p.cuotas.usuarios, motivo: '' });
  const { run, ocupado, error } = useAccion();
  const campo = (k: keyof typeof f, etiqueta: string) => <Campo etiqueta={etiqueta}><input className="input num" type="number" min={k === 'max_usuarios' ? 1 : 0} value={f[k] as number} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} /></Campo>;
  return (
    <Modal titulo={`Límites del plan ${p.nombre}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Volver</button>
      <button className="btn primario" disabled={ocupado || f.motivo.trim().length < 10} onClick={async () => { const r = await run(() => api.patch(`/api/operador/planes/${p.codigo}`, f), 'Límites actualizados.', { silencioso: true }); if (r) onHecho(); }}>Guardar</button></>}>
      <p className="sec">Afecta a las {p.empresas_vigentes} empresas con este plan desde el próximo cálculo de cuotas. El precio no se cambia desde aquí.</p>
      <div className="grid g2">{campo('cuota_tokens_ia', 'Tokens de IA al mes')}{campo('cuota_mensajes', 'Mensajes al mes')}{campo('cuota_documentos', 'Documentos al mes')}{campo('max_usuarios', 'Personas con acceso')}</div>
      <Campo etiqueta="Motivo" ayuda="Queda en la auditoría. Mínimo 10 caracteres."><textarea className="input" rows={2} maxLength={300} value={f.motivo} onChange={(e) => setF({ ...f, motivo: e.target.value })} /></Campo>
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ salud del sistema
export function OpSalud() {
  const per = usePeriodo(1);
  const { puede } = useYo();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/salud?${per.qs}`), [per.qs], { cada: 30_000 });
  const { run } = useAccion();
  const reintentar = async (id: string) => { await run(async () => { const r = await api.post(`/api/operador/trabajos/${id}/reintentar`, { motivo: 'Reintento manual desde Salud del sistema' }); if (!r.reintentado) throw new Error(r.razon); return r; }, 'Trabajo en la cola de nuevo.'); recargar(); };
  return (
    <>
      <Cabecera titulo="Salud del sistema" sub="Solicitudes, latencia, errores y cola de trabajos. Se actualiza cada 30 segundos."><SelectorPeriodo p={per.p} setP={per.setP} /></Cabecera>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando && !data ? <Cargando filas={6} /> : (
        <div className="col" style={{ gap: 16 }}>
          <div className="kpis">
            <Cifra etiqueta="Disponibilidad observada" valor={pct(data.solicitudes.disponibilidad)} detalle={`${num(data.solicitudes.total)} solicitudes`} />
            <Cifra etiqueta="Errores" valor={num(data.solicitudes.errores_5xx)} detalle={`5xx · ${num(data.solicitudes.errores_4xx)} 4xx`} />
            <Cifra etiqueta="Latencia media" valor={ms(data.solicitudes.latencia_media_ms)} detalle={`p95 ≤ ${ms(data.solicitudes.p95_ms)}`} />
            <Cifra etiqueta="Cola" valor={num(data.cola.pendientes)} detalle={`espera más antigua ${data.cola.espera_mas_antigua_s ? `${num(data.cola.espera_mas_antigua_s)} s` : '—'}`} />
          </div>
          <div className="grid g2">
            <Tarjeta titulo="Proceso y base de datos">
              <dl className="datos-def">
                <dt>Versión</dt><dd className="mono">{data.proceso.version}</dd>
                <dt>Entorno</dt><dd>{data.proceso.entorno}</dd>
                <dt>En marcha desde</dt><dd>{fechaHora(data.proceso.inicio)} ({hace(data.proceso.inicio)})</dd>
                <dt>Node.js</dt><dd className="mono">{data.proceso.node}</dd>
                <dt>Base de datos</dt><dd>{data.base.disponible ? <Estado v="CONECTADO" texto="Disponible" /> : <Estado v="FALLIDO" texto="Sin conexión" />}</dd>
                <dt>Migraciones</dt><dd className="mono">{data.base.migraciones.join(', ')}</dd>
              </dl>
            </Tarjeta>
            <Tarjeta titulo="Solicitudes por hora">
              <Barras etiqueta="Solicitudes por hora" datos={data.serie.slice(-24).map((s: any) => ({ k: s.hora, v: s.n, corto: s.hora.slice(11, 13) }))} />
            </Tarjeta>
          </div>
          <Tarjeta titulo="Rutas" sinCuerpo>
            {!data.rutas.length ? <div className="cuerpo"><Vacio titulo="Sin solicitudes registradas en el periodo">Las métricas se guardan cada 30 segundos.</Vacio></div> : (
              <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Ruta</th><th className="num">Solicitudes</th><th className="num">5xx</th><th className="num">4xx</th><th className="num">Media</th><th className="num">p95</th><th className="num">Máx.</th></tr></thead>
                <tbody>{data.rutas.map((r: any) => <tr key={r.metodo + r.ruta}><td data-etiqueta="Ruta" className="mono">{r.metodo} {r.ruta}</td><td data-etiqueta="Solicitudes" className="num">{num(r.n)}</td><td data-etiqueta="5xx" className="num">{r.errores_5xx}</td><td data-etiqueta="4xx" className="num">{r.errores_4xx}</td><td data-etiqueta="Media" className="num">{ms(r.media_ms)}</td><td data-etiqueta="p95" className="num">≤ {ms(r.p95_ms)}</td><td data-etiqueta="Máx." className="num">{ms(r.max_ms)}</td></tr>)}</tbody></table></div>
            )}
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="Cola por tipo de trabajo" sinCuerpo>
              {!data.cola.por_tipo.length ? <div className="cuerpo"><Vacio titulo="Cola vacía" /></div> : (
                <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Tipo</th><th className="num">Pendientes</th><th className="num">Reintentando</th><th className="num">Fallidos</th></tr></thead>
                  <tbody>{data.cola.por_tipo.map((t: any) => <tr key={t.tipo}><td className="mono">{t.tipo}</td><td className="num">{t.pendientes}</td><td className="num">{t.reintentando}</td><td className="num">{t.fallidos}</td></tr>)}</tbody></table></div>
              )}
            </Tarjeta>
            <Tarjeta titulo="Trabajos fallidos">
              {!data.trabajos_fallidos.length ? <p className="tenue">Ninguno.</p> : (
                <ul className="lista">{data.trabajos_fallidos.map((j: any) => (
                  <li key={j.id} className="col" style={{ gap: 4, padding: '8px 0', borderBottom: '1px solid var(--borde)' }}>
                    <div className="fila entre"><span className="mono">{j.tipo}</span><span className="tenue peq-txt">{hace(j.fecha)} · {j.intentos} intentos</span></div>
                    <span className="tenue peq-txt">{j.razon}</span>
                    {j.reintentable && puede('trabajos:reintentar') && <div><button className="btn peq" onClick={() => reintentar(j.id)}>Reintentar</button></div>}
                  </li>))}
                </ul>
              )}
            </Tarjeta>
          </div>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ incidentes
export function OpIncidentes() {
  const { puede } = useYo();
  const [f, setF] = useState({ estado: 'ABIERTO', gravedad: '', servicio: '' });
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/incidentes?estado=${f.estado}&gravedad=${f.gravedad}&servicio=${encodeURIComponent(f.servicio)}`), [f.estado, f.gravedad, f.servicio]);
  const { run, ocupado } = useAccion();
  const [resolver, setResolver] = useState<any>(null);
  const reintentar = async (i: any) => { await run(async () => { const r = await api.post(`/api/operador/incidentes/${i.id}/reintentar`, { motivo: `Reintento del incidente ${i.codigo}` }); if (!r.reintentado) throw new Error(r.razon); return r; }, 'En la cola de nuevo. Si vuelve a fallar, el incidente sumará una ocurrencia.'); recargar(); };
  return (
    <>
      <Cabecera titulo="Incidentes" sub="Códigos y descripciones técnicas depuradas. Nunca el contenido de un mensaje ni datos de clientes." />
      <Tarjeta sinCuerpo>
        <div className="filtros">
          <select className="input" value={f.estado} onChange={(e) => setF({ ...f, estado: e.target.value })} aria-label="Estado"><option value="">Todos</option><option value="ABIERTO">Abiertos</option><option value="RECONOCIDO">Reconocidos</option><option value="RESUELTO">Resueltos</option></select>
          <select className="input" value={f.gravedad} onChange={(e) => setF({ ...f, gravedad: e.target.value })} aria-label="Gravedad"><option value="">Toda gravedad</option><option value="CRITICA">Crítica</option><option value="ALTA">Alta</option><option value="MEDIA">Media</option><option value="BAJA">Baja</option></select>
          <select className="input" value={f.servicio} onChange={(e) => setF({ ...f, servicio: e.target.value })} aria-label="Servicio"><option value="">Todos los servicios</option>{(data?.servicios ?? []).map((s: string) => <option key={s} value={s}>{s}</option>)}</select>
        </div>
        {error ? <div className="cuerpo"><ErrorCarga error={error} reintentar={recargar} /></div> : cargando && !data ? <div className="cuerpo"><Cargando /></div> : !data.incidentes.length ? <div className="cuerpo"><Vacio titulo="Sin incidentes con esos filtros">Cuando un trabajo agota sus reintentos o una petición falla, aparece aquí.</Vacio></div> : (
          <ul className="op-incidentes">{data.incidentes.map((i: any) => (
            <li key={i.id}>
              <div className="fila entre" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="fila" style={{ gap: 8 }}><Estado v={i.gravedad} /><b className="mono">{i.codigo}</b><span className="tenue">· {i.servicio}</span></span>
                <Estado v={i.estado} />
              </div>
              <p>{i.descripcion}</p>
              {i.accion_sugerida && <p className="tenue peq-txt"><Icon n="info" className="" size={14} /> {i.accion_sugerida}</p>}
              <dl className="datos-def">
                <dt>Ocurrencias</dt><dd>{i.ocurrencias} · primera {fechaHora(i.primera_vez)} · última {hace(i.ultima_vez)}</dd>
                {i.empresa_id && <><dt>Empresa</dt><dd><Link className="mono" to={`/operador/empresas/${i.empresa_id}`}>{i.empresa_id}</Link></dd></>}
                {i.correlacion && <><dt>Correlación</dt><dd className="mono">{i.correlacion}</dd></>}
                {i.version && <><dt>Versión</dt><dd className="mono">{i.version}</dd></>}
                {Object.entries(i.detalle ?? {}).map(([k, v]) => <Fragment key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd className="mono">{String(v)}</dd></Fragment>)}
                {i.nota && <><dt>Nota</dt><dd>{i.nota}</dd></>}
              </dl>
              {i.estado !== 'RESUELTO' && puede('incidentes:gestionar') && (
                <div className="fila" style={{ gap: 8, flexWrap: 'wrap' }}>
                  {i.estado === 'ABIERTO' && <button className="btn peq" disabled={ocupado} onClick={async () => { await run(() => api.patch(`/api/operador/incidentes/${i.id}`, { estado: 'RECONOCIDO' }), 'Incidente reconocido.'); recargar(); }}>Reconocer</button>}
                  <button className="btn peq" onClick={() => setResolver(i)}>Marcar resuelto</button>
                  {i.reintentable && puede('trabajos:reintentar') && <button className="btn peq primario" disabled={ocupado} onClick={() => reintentar(i)}>Reintentar</button>}
                </div>
              )}
            </li>))}
          </ul>
        )}
      </Tarjeta>
      {resolver && <ResolverIncidente i={resolver} onCerrar={() => setResolver(null)} onHecho={() => { setResolver(null); recargar(); }} />}
    </>
  );
}

function ResolverIncidente({ i, onCerrar, onHecho }: { i: any; onCerrar: () => void; onHecho: () => void }) {
  const [nota, setNota] = useState('');
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo={`Resolver ${i.codigo}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Volver</button>
      <button className="btn primario" disabled={ocupado} onClick={async () => { const r = await run(() => api.patch(`/api/operador/incidentes/${i.id}`, { estado: 'RESUELTO', nota: nota || undefined }), 'Incidente resuelto.', { silencioso: true }); if (r) onHecho(); }}>Marcar resuelto</button></>}>
      <p className="sec">Si vuelve a ocurrir, se abrirá un incidente nuevo.</p>
      <Campo etiqueta="Nota técnica (opcional)" ayuda="Sin datos de clientes ni secretos."><textarea className="input" rows={3} maxLength={300} value={nota} onChange={(e) => setNota(e.target.value)} /></Campo>
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ integraciones
export function OpIntegraciones() {
  const { data, error, cargando, recargar } = useApi<any>(() => api.get('/api/operador/integraciones'), []);
  return (
    <>
      <Cabecera titulo="Integraciones" sub="Estado técnico de los proveedores. Sin credenciales ni contenido procesado." />
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando && !data ? <Cargando filas={5} /> : (
        <div className="col" style={{ gap: 16 }}>
          <Tarjeta titulo="Proveedores de la plataforma" sinCuerpo>
            <ul className="lista op-integraciones">{data.plataforma.map((i: any) => (
              <li key={i.clave}>
                <div className="fila entre" style={{ flexWrap: 'wrap', gap: 8 }}><b>{i.nombre}</b><Estado v={i.estado} /></div>
                <p className="tenue">{i.detalle}</p>
                <p className="peq-txt tenue">Variables: <span className="mono">{i.variables.join(', ')}</span></p>
              </li>))}
            </ul>
          </Tarjeta>
          <div className="grid g2">
            <Tarjeta titulo="WhatsApp de las empresas">
              <dl className="datos-def">{data.whatsapp.por_estado.map((w: any) => <Fragment key={w.estado}><dt><Estado v={w.estado} /></dt><dd>{w.n}</dd></Fragment>)}</dl>
              {data.whatsapp.con_problemas.length > 0 && <>
                <h3 className="titulo-tarjeta" style={{ fontSize: 14, marginTop: 16 }}>Requieren atención</h3>
                <ul className="lista">{data.whatsapp.con_problemas.map((t: any) => <li key={t.empresa_id} className="fila entre"><Link to={`/operador/empresas/${t.empresa_id}`}>{t.empresa}</Link><Estado v={t.estado} /></li>)}</ul>
              </>}
            </Tarjeta>
            <Tarjeta titulo="Correo (últimos 7 días)">
              <dl className="datos-def">{Object.entries(data.correo.por_estado_7_dias).map(([k, v]) => <Fragment key={k}><dt>{ESTADO_CORREO[k] ?? k}</dt><dd>{v as number}</dd></Fragment>)}</dl>
              {Object.keys(data.correo.por_estado_7_dias).length === 0 && <p className="tenue">Sin envíos.</p>}
              <p className="tenue peq-txt" style={{ marginTop: 8 }}>«Aceptados» significa que el proveedor los recibió; «Entregados» solo aparece con el webhook de entregas configurado.</p>
              {data.correo.fallos_7_dias.length > 0 && <ul className="lista" style={{ marginTop: 12 }}>{data.correo.fallos_7_dias.map((f: any) => <li key={f.codigo} className="fila entre"><span><span className="mono">{f.codigo}</span><br /><span className="tenue peq-txt">{f.descripcion}</span></span><b>{f.n}</b></li>)}</ul>}
            </Tarjeta>
          </div>
          <Tarjeta titulo="Modelo de lenguaje (últimos 7 días)">
            {!data.ia.modelos_7_dias.length ? <p className="tenue">Sin llamadas.</p> : <ul className="lista">{data.ia.modelos_7_dias.map((m: any) => <li key={m.modelo} className="fila entre"><span className="mono">{m.modelo}</span><span>{num(m.llamadas)} llamadas · {num(m.errores)} errores</span></li>)}</ul>}
          </Tarjeta>
        </div>
      )}
    </>
  );
}

// ------------------------------------------------------------------ soporte
export const ESTADO_TICKET: Record<string, string> = { ABIERTO: 'Abierto', EN_PROCESO: 'En proceso', ESPERANDO_CLIENTE: 'Esperando a la empresa', RESUELTO: 'Resuelto', CERRADO: 'Cerrado' };

export function OpSoporte() {
  const [estado, setEstado] = useState('');
  const [canal, setCanal] = useState('');
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/soporte?estado=${estado}&canal=${canal}`), [estado, canal]);
  const nav = useNavigate();
  return (
    <>
      <Cabecera titulo="Soporte" sub="Solicitudes que llegan desde el panel de las empresas o por el WhatsApp de Omnegia. Solo se ve lo que la persona escribió en su solicitud." />
      <Tarjeta sinCuerpo>
        <div className="filtros">
          <select className="input" value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado"><option value="">Todos los estados</option>{Object.entries(ESTADO_TICKET).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select className="input" value={canal} onChange={(e) => setCanal(e.target.value)} aria-label="Canal"><option value="">Todos los canales</option><option value="PANEL">Desde el panel</option><option value="WHATSAPP">Por WhatsApp</option></select>
        </div>
        {error ? <div className="cuerpo"><ErrorCarga error={error} reintentar={recargar} /></div> : cargando && !data ? <div className="cuerpo"><Cargando /></div> : !data.tickets.length ? <div className="cuerpo"><Vacio titulo="Sin solicitudes" /></div> : (
          <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Radicado</th><th>Empresa</th><th>Asunto</th><th>Categoría</th><th>Prioridad</th><th>Estado</th><th>Actividad</th></tr></thead>
            <tbody>{data.tickets.map((t: any) => (
              <tr key={t.id} className="enlace-fila" onClick={() => nav(`/operador/soporte/${t.id}`)}>
                <td data-etiqueta="Radicado"><span className="fila" style={{ gap: 6 }}><Link className="mono" to={`/operador/soporte/${t.id}`}>{t.numero}</Link>{t.canal === 'WHATSAPP' && <Estado v="WHATSAPP" />}</span></td>
                <td data-etiqueta="Empresa">{t.empresa ? <>{t.empresa}{t.empresa_sin_verificar && <span className="tenue peq-txt"> · sin verificar</span>}</> : <span className="tenue">Sin empresa</span>}</td><td data-etiqueta="Asunto">{t.asunto}</td>
                <td data-etiqueta="Categoría">{t.categoria_nombre}</td><td data-etiqueta="Prioridad"><Estado v={t.prioridad} /></td><td data-etiqueta="Estado"><Estado v={t.estado} texto={ESTADO_TICKET[t.estado]} /></td><td data-etiqueta="Actividad">{hace(t.actualizado_en)}</td>
              </tr>))}
            </tbody></table></div>
        )}
      </Tarjeta>
    </>
  );
}

export function OpTicket() {
  const { id } = useParams();
  const { puede } = useYo();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/soporte/${id}`), [id]);
  const [texto, setTexto] = useState('');
  const [siguiente, setSiguiente] = useState('ESPERANDO_CLIENTE');
  const { run, ocupado, error: errEnvio } = useAccion();
  if (error) return <><Cabecera titulo="Soporte" /><ErrorCarga error={error} reintentar={recargar} /></>;
  if (cargando && !data) return <Cargando filas={5} />;
  const t = data.ticket;
  const gestionar = puede('soporte:gestionar');
  return (
    <>
      <Cabecera titulo={t.asunto} sub={<span className="fila" style={{ gap: 8, flexWrap: 'wrap' }}><span className="mono">{t.numero}</span><span>·</span>{t.empresa_id ? <Link to={`/operador/empresas/${t.empresa_id}`}>{t.empresa}</Link> : <span className="tenue">Sin empresa</span>}{t.empresa_sin_verificar && <span className="tenue peq-txt">(relacionada por el teléfono, sin verificar)</span>}<span>·</span><span>{t.categoria_nombre}</span>{t.canal === 'WHATSAPP' && <Estado v="WHATSAPP" />}<Estado v={t.prioridad} /><Estado v={t.estado} texto={ESTADO_TICKET[t.estado]} /></span>}>
        <Link className="btn" to="/operador/soporte"><Icon n="atras" className="" size={16} />Todas</Link>
        {t.canal === 'WHATSAPP' && t.conversacion_id && <Link className="btn primario" to={`/operador/conversaciones/${t.conversacion_id}`}><Icon n="conversaciones" className="" size={16} />Abrir la conversación</Link>}
        {gestionar && t.estado !== 'CERRADO' && <button className="btn" disabled={ocupado} onClick={async () => { await run(() => api.patch(`/api/operador/soporte/${t.id}`, { estado: 'CERRADO' }), 'Solicitud cerrada.'); recargar(); }}>Cerrar</button>}
      </Cabecera>
      <div className="grid g-main">
        <Tarjeta titulo="Conversación">
          <ol className="hilo-soporte">{data.mensajes.map((m: any) => (
            <li key={m.id} className={m.autor_tipo === 'OPERADOR' ? 'de-soporte' : 'de-empresa'}>
              <div className="msg-meta"><b>{m.autor_tipo === 'OPERADOR' ? 'Soporte' : m.autor}</b><span className="tenue peq-txt">{fechaHora(m.fecha)}</span></div>
              <p className="msg-texto">{m.cuerpo}</p>
            </li>))}
          </ol>
          {t.canal === 'WHATSAPP' && t.estado !== 'CERRADO' && <p className="aviso peq-txt" style={{ marginTop: 16 }}><Icon n="conversaciones" className="" size={14} /><span>Llegó por WhatsApp: respóndela desde su conversación para que la persona la reciba en el mismo chat.</span></p>}
          {gestionar && t.estado !== 'CERRADO' && t.canal !== 'WHATSAPP' && (
            <div className="col" style={{ gap: 10, marginTop: 16 }}>
              <textarea className="input" rows={4} maxLength={4000} value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Respuesta" placeholder="Respuesta para la empresa. Nunca pidas contraseñas, claves ni datos de sus clientes." />
              <div className="fila" style={{ gap: 8, flexWrap: 'wrap' }}>
                <select className="input" value={siguiente} onChange={(e) => setSiguiente(e.target.value)} aria-label="Estado después de responder"><option value="ESPERANDO_CLIENTE">Esperando a la empresa</option><option value="EN_PROCESO">En proceso</option><option value="RESUELTO">Resuelto</option></select>
                <button className="btn primario" disabled={ocupado || texto.trim().length < 2} onClick={async () => { const r = await run(() => api.post(`/api/operador/soporte/${t.id}/responder`, { cuerpo: texto, estado: siguiente }), 'Respuesta enviada por el panel y por correo.', { silencioso: true }); if (r) { setTexto(''); recargar(); } }}>{ocupado ? 'Enviando…' : 'Responder'}</button>
              </div>
              {errEnvio && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{errEnvio.message}</p>}
              <p className="tenue peq-txt">Las respuestas que se den desde la bandeja de correo de soporte no se copian a este panel.</p>
            </div>
          )}
        </Tarjeta>
        <Tarjeta titulo="Solicitante">
          <dl className="datos-def"><dt>Nombre</dt><dd>{t.solicitante}</dd>{t.solicitante_email && <><dt>Correo</dt><dd>{t.solicitante_email}</dd></>}{t.solicitante_telefono && <><dt>WhatsApp</dt><dd className="mono">{t.solicitante_telefono}</dd></>}<dt>Creada</dt><dd>{fechaHora(t.creado_en)}</dd></dl>
          {gestionar && <Campo etiqueta="Prioridad"><select className="input" value={t.prioridad} onChange={async (e) => { await run(() => api.patch(`/api/operador/soporte/${t.id}`, { prioridad: e.target.value }), 'Prioridad actualizada.'); recargar(); }}>
            <option value="BAJA">Baja</option><option value="NORMAL">Normal</option><option value="ALTA">Alta</option><option value="URGENTE">Urgente</option></select></Campo>}
        </Tarjeta>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ auditoría
// ------------------------------------------------------------------ reembolsos
const PLAZO = (r: any) => r.estado === 'REEMBOLSADO' || r.estado === 'RECHAZADO' ? null
  : r.vencido ? { tono: 'err', texto: `Vencido hace ${Math.abs(r.dias_restantes)} ${Math.abs(r.dias_restantes) === 1 ? 'día' : 'días'}: la ley fija 15 días calendario` }
  : { tono: r.dias_restantes <= 3 ? 'warn' : 'neutro', texto: `Quedan ${r.dias_restantes} ${r.dias_restantes === 1 ? 'día' : 'días'} para devolver el dinero (límite legal: 15 días calendario)` };

export function OpReembolsos() {
  const { puede } = useYo();
  const [estado, setEstado] = useState('');
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/operador/reembolsos?estado=${estado}`), [estado]);
  const [accion, setAccion] = useState<{ tipo: 'decidir' | 'devuelto'; r: any } | null>(null);
  const gestiona = puede('reembolsos:gestionar');
  return (
    <>
      <Cabecera titulo="Reembolsos" sub="Retracto y devoluciones de los pagos a la plataforma. El dinero se devuelve en Wompi o por transferencia; aquí se decide y se deja la referencia." />
      <Tarjeta sinCuerpo>
        <div className="filtros">
          <select className="input" value={estado} onChange={(e) => setEstado(e.target.value)} aria-label="Estado">
            <option value="">Todos</option><option value="EN_REVISION">En revisión</option><option value="APROBADO">Aprobados: falta devolver</option><option value="REEMBOLSADO">Devueltos</option><option value="RECHAZADO">Rechazados</option>
          </select>
        </div>
        {error ? <div className="cuerpo"><ErrorCarga error={error} reintentar={recargar} /></div> : cargando && !data ? <div className="cuerpo"><Cargando /></div> : !data.reembolsos.length ? <div className="cuerpo"><Vacio titulo="Sin solicitudes de reembolso">Cuando alguien pida un retracto o una devolución desde la zona legal, aparece aquí.</Vacio></div> : (
          <ul className="op-incidentes">{data.reembolsos.map((r: any) => {
            const plazo = PLAZO(r);
            return (
              <li key={r.id}>
                <div className="fila entre" style={{ flexWrap: 'wrap', gap: 8 }}>
                  <span className="fila" style={{ gap: 8 }}><b className="mono">{r.radicado}</b><span className="tenue">· {r.motivo_nombre}</span></span>
                  <Estado v={r.estado} />
                </div>
                {plazo && <p className={plazo.tono === 'err' ? 'bloqueado' : 'tenue peq-txt'} style={{ margin: 0 }}><Icon n={plazo.tono === 'neutro' ? 'reloj' : 'alerta'} className="" size={14} /> {plazo.texto}</p>}
                <dl className="datos-def">
                  <dt>Valor</dt><dd><b>{cop(r.monto)}</b> {r.moneda}</dd>
                  <dt>Pago</dt><dd className="mono">{r.referencia}{r.empresa ? ` · ${r.empresa}` : ''}</dd>
                  <dt>Solicitante</dt><dd>{r.solicitante} · <a href={`mailto:${r.solicitante_email}`}>{r.solicitante_email}</a></dd>
                  <dt>Devolver por</dt><dd>{r.medio}</dd>
                  <dt>Pidió</dt><dd>{fechaHora(r.creado_en)} · límite {fecha(r.vence_en)}</dd>
                  <dt>Lo que dice</dt><dd>«{r.detalle}»</dd>
                  <dt>Evaluación</dt><dd>{r.evaluacion?.razon}{r.decidido_por ? ` (${r.decidido_por === 'sistema' ? 'decidido por el sistema' : `decidido por ${r.decidido_por}`})` : ''}</dd>
                  {r.decision_motivo && <><dt>Decisión</dt><dd>{r.decision_motivo}</dd></>}
                  {r.referencia_devolucion && <><dt>Devolución</dt><dd className="mono">{r.referencia_devolucion} · {fechaHora(r.reembolsado_en)}</dd></>}
                </dl>
                {gestiona && r.estado === 'EN_REVISION' && <div className="fila"><button className="btn peq primario" onClick={() => setAccion({ tipo: 'decidir', r })}>Decidir</button></div>}
                {gestiona && r.estado === 'APROBADO' && <div className="fila"><button className="btn peq primario" onClick={() => setAccion({ tipo: 'devuelto', r })}>Registrar devolución hecha</button></div>}
              </li>
            );
          })}</ul>
        )}
      </Tarjeta>
      {accion?.tipo === 'decidir' && <DecidirReembolso r={accion.r} onCerrar={() => setAccion(null)} onHecho={() => { setAccion(null); recargar(); }} />}
      {accion?.tipo === 'devuelto' && <RegistrarDevolucion r={accion.r} onCerrar={() => setAccion(null)} onHecho={() => { setAccion(null); recargar(); }} />}
    </>
  );
}

function DecidirReembolso({ r, onCerrar, onHecho }: { r: any; onCerrar: () => void; onHecho: () => void }) {
  const [decision, setDecision] = useState<'APROBAR' | 'RECHAZAR'>('APROBAR');
  const [motivo, setMotivo] = useState('');
  const { run, ocupado, error } = useAccion();
  const listo = decision === 'APROBAR' || motivo.trim().length >= 10;
  return (
    <Modal titulo={`Decidir ${r.radicado}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Volver</button>
      <button className="btn primario" disabled={ocupado || !listo} onClick={async () => { const x = await run(() => api.post(`/api/operador/reembolsos/${r.id}/decidir`, { decision, motivo: motivo.trim() || undefined }), decision === 'APROBAR' ? 'Aprobado. Falta devolver el dinero.' : 'Rechazado. La persona recibió el motivo.', { silencioso: true }); if (x) onHecho(); }}>{decision === 'APROBAR' ? 'Aprobar' : 'Rechazar'}</button></>}>
      <p className="sec">{cop(r.monto)} · {r.motivo_nombre}. Si apruebas, la devolución es del valor completo, sin descuentos ni retenciones, y la persona recibe un correo. {r.motivo === 'RETRACTO' || r.motivo === 'NO_ACTIVACION' ? 'Si el espacio aún no se creó, ya no se podrá crear con este pago.' : ''}</p>
      <fieldset className="legal-tipos" style={{ marginBottom: 12 }}>
        <legend>Decisión</legend>
        <label className={decision === 'APROBAR' ? 'on' : ''}><input type="radio" name="decision" checked={decision === 'APROBAR'} onChange={() => setDecision('APROBAR')} /><span><b>Aprobar la devolución</b></span></label>
        <label className={decision === 'RECHAZAR' ? 'on' : ''}><input type="radio" name="decision" checked={decision === 'RECHAZAR'} onChange={() => setDecision('RECHAZAR')} /><span><b>Rechazar</b><small>Debes explicar el motivo: la persona lo recibe y puede acudir a la Superintendencia de Industria y Comercio.</small></span></label>
      </fieldset>
      <Campo etiqueta={decision === 'RECHAZAR' ? 'Motivo del rechazo' : 'Nota (opcional)'} ayuda="la lee la persona"><textarea className="input" rows={3} maxLength={1000} value={motivo} onChange={(e) => setMotivo(e.target.value)} /></Campo>
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
  );
}

function RegistrarDevolucion({ r, onCerrar, onHecho }: { r: any; onCerrar: () => void; onHecho: () => void }) {
  const [ref, setRef] = useState('');
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo={`Devolución de ${r.radicado}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Volver</button>
      <button className="btn primario" disabled={ocupado || ref.trim().length < 3} onClick={async () => { const x = await run(() => api.post(`/api/operador/reembolsos/${r.id}/devuelto`, { referencia: ref.trim() }), 'Devolución registrada. La persona recibió el aviso.', { silencioso: true }); if (x) onHecho(); }}>Registrar devolución</button></>}>
      <p className="sec">Haz primero la devolución de <b>{cop(r.monto)}</b> ({r.medio.toLowerCase()}), desde el panel de Wompi o por transferencia, y pega aquí la referencia del comprobante. Al registrarla, el pago queda como reembolsado y la persona recibe el aviso con esa referencia.</p>
      <Campo etiqueta="Referencia de la devolución" ayuda="comprobante de Wompi o de la transferencia"><input className="input mono" value={ref} maxLength={80} onChange={(e) => setRef(e.target.value)} /></Campo>
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
  );
}

export function OpAuditoria() {
  const [eventos, setEventos] = useState<any[] | null>(null);
  const [fin, setFin] = useState(false);
  const { run, ocupado, error } = useAccion();
  const cargar = async (antes = '') => {
    const r = await run(() => api.get(`/api/operador/auditoria${antes ? `?antes=${encodeURIComponent(antes)}` : ''}`), undefined, { silencioso: true });
    if (!r) return;
    setEventos((prev) => (antes ? [...(prev ?? []), ...r.eventos] : r.eventos));
    setFin(r.eventos.length < 100);
  };
  useEffect(() => { void cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <Cabecera titulo="Auditoría del operador" sub="Quién hizo qué, sobre qué recurso, por qué y con qué resultado. Solo lectura: nadie la puede modificar desde el panel." />
      {error && !eventos ? <ErrorCarga error={error} reintentar={() => cargar()} /> : !eventos ? <Cargando /> : (
        <Tarjeta sinCuerpo>
          {!eventos.length ? <div className="cuerpo"><Vacio titulo="Sin eventos todavía" /></div> : (
            <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Fecha</th><th>Persona</th><th>Acción</th><th>Recurso</th><th>Motivo</th><th>Resultado</th></tr></thead>
              <tbody>{eventos.map((e) => (
                <tr key={e.id}>
                  <td data-etiqueta="Fecha">{fechaHora(e.fecha)}</td><td data-etiqueta="Persona">{e.actor}</td>
                  <td data-etiqueta="Acción"><span className="mono">{e.accion}</span>{Object.keys(e.detalle ?? {}).length > 0 && <div className="tenue peq-txt">{Object.entries(e.detalle).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join(' · ')}</div>}</td>
                  <td data-etiqueta="Recurso">{e.recurso ?? '—'}{e.empresa_id && <div><Link className="peq-txt mono" to={`/operador/empresas/${e.empresa_id}`}>{e.empresa_id.slice(0, 8)}…</Link></div>}</td>
                  <td data-etiqueta="Motivo">{e.motivo ?? '—'}</td><td data-etiqueta="Resultado"><Estado v={e.resultado} /></td>
                </tr>))}
              </tbody></table></div>
          )}
          {!fin && eventos.length > 0 && <div className="cuerpo"><button className="btn" disabled={ocupado} onClick={() => cargar(eventos[eventos.length - 1].fecha)}>{ocupado ? 'Cargando…' : 'Ver más antiguos'}</button></div>}
        </Tarjeta>
      )}
    </>
  );
}

/** /plataforma (ruta anterior) lleva al panel nuevo. */
export const RedirigirOperador = () => <Navigate to="/operador" replace />;
