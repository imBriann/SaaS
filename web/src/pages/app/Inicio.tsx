import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { LayoutGroup } from 'motion/react';
import { api, cop, fechaLarga, hace, hora, hoyLocal } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { CicloFiscal, ErrorCarga, Estado, Medidor, Mensaje, Recibo, useApi, Vacio, type TipoMensaje } from '../../components/ui';
import { Icon } from '../../components/icons';
import { ThinkingOrb } from 'thinking-orbs';
import { useConstruccion, useListoParaConstruir } from '../../components/construccion/Construccion';
import { Arco, Chispa, Construible, Cuenta, LineaViva, MiniBarras, Variacion } from '../../components/construccion/Piezas';
import { OrbeCara } from '../../components/ia/OrbeCara';
import { useIA } from '../../components/ia/contexto';
import { usePuedeIA } from '../../components/ia/PanelIA';

const TIPO: Record<string, TipoMensaje> = { CUSTOMER: 'cliente', AI: 'ia', HUMAN: 'humano' };
const METODO: Record<string, string> = { EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', DATAFONO: 'Datáfono', PASARELA: 'Pasarela' };
const copCorto = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M` : n >= 10_000 ? `$${Math.round(n / 1000).toLocaleString('es-CO')} mil` : cop(n));
const diaCorto = (f: string) => (f === hoyLocal() ? 'hoy' : new Date(`${f}T12:00:00Z`).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).replace('.', ''));

/**
 * SCR-009 · Inicio. Un tablero vivo con las cifras reales de la empresa: al estrenar el espacio (o al
 * pedir «Reconstruir») la IA lo arma delante de la persona; en el día a día se actualiza solo. Primero
 * lo que espera a una persona (P4), después el dinero, la agenda y lo que pasa en WhatsApp.
 */
export function Inicio() {
  const { s, puede } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/inicio'), [], { cada: 20000 });
  useListoParaConstruir(!!data || !!error);
  const { activa, fase } = useConstruccion();
  const personalizacion = s.tenant.registro_datos?.inicio_ia;
  const accesos = ([
    ['appointment:create', '/agenda', 'agenda', 'Agendar una cita'], ['order:create', '/ventas', 'ventas', 'Registrar una venta'],
    ['customer:write', '/clientes', 'clientes', 'Añadir un cliente'], ['conversation:read', '/conversaciones', 'conversaciones', 'Revisar mensajes'],
  ] as const).filter(([p]) => puede(p));
  const ver = (p: string, m?: string) => puede(p) && (!m || s.modulos.includes(m));
  let n = 0; // orden de aparición de cada tarjeta durante la construcción
  const sig = () => n++;
  return (
    <>
      <Cabecera titulo={personalizacion?.titulo || `Hola, ${s.usuario.nombre.split(' ')[0]}`} sub={data ? `${fechaLarga(data.fecha)} · ${s.tenant.nombre}` : s.tenant.nombre}>
        {accesos.map(([p, to, icon, label]) => <Link key={p} className="btn" to={to}><Icon n={icon} className="" size={16} />{label}</Link>)}
      </Cabecera>
      <div className="contenido tablero-vivo">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {!data && !error && !activa && <EsqueletoInicial />}
        {data && (
          <LayoutGroup>
            <div className={`tv-grid ${activa ? 'en-obra' : ''}`} data-fase-obra={activa ? fase : undefined}>
              {data.pasos && data.pasos.completos < data.pasos.total && <Construible i={sig()} className="ancho-total"><PrimerosPasos p={data.pasos} /></Construible>}
              {personalizacion?.descripcion && <Construible i={sig()} className="ancho-total"><Personalizado p={personalizacion} /></Construible>}
              <Construible i={sig()} className={`ancho-total ${data.atencion.length ? 'tv-atencion' : 'tv-aldia'}`} etiqueta="Lo que requiere tu atención"><Atencion a={data.atencion} /></Construible>

              {ver('order:read') && data.mes ? <>
                <Construible i={sig()} etiqueta="Vendido este mes"><VendidoMes d={data} /></Construible>
                <Construible i={sig()} etiqueta="Clientes nuevos"><ClientesNuevos d={data} /></Construible>
                <Construible i={sig()} etiqueta="Cobrado hoy"><CobradoHoy d={data} /></Construible>
              </> : <>
                <Construible i={sig()} etiqueta="Citas de hoy"><Tile icono="agenda" etiqueta="Citas de hoy" valor={data.cifras.citas_hoy} pie={`${data.cifras.citas_hoy_ia} agendadas por la IA`} /></Construible>
                <Construible i={sig()} etiqueta="Clientes nuevos"><ClientesNuevos d={data} /></Construible>
                <Construible i={sig()} etiqueta="Conversaciones abiertas"><Tile icono="conversaciones" etiqueta="Conversaciones abiertas" valor={data.cifras.conversaciones_abiertas} pie={`${data.cifras.escaladas} con una persona`} /></Construible>
              </>}
              {data.actividad ? <Construible i={sig()} className="tv-vivo" etiqueta="WhatsApp en vivo"><EnVivo d={data} /></Construible>
                : <Construible i={sig()} etiqueta="Clientes en total"><Tile icono="persona" etiqueta="Clientes en total" valor={data.empresa.clientes} pie={`${data.empresa.catalogo} ítems en el catálogo`} /></Construible>}

              {ver('order:read') && data.mes && <Construible i={sig()} className="ancho-2 alto-2" etiqueta="Ventas"><Balance d={data} /></Construible>}
              {ver('order:read') && data.mes && <Construible i={sig()} className="alto-2" etiqueta="Cobrado del mes"><CobradoMes d={data} /></Construible>}
              <Construible i={sig()} className="alto-2" etiqueta="Tu empresa"><Empresa d={data} /></Construible>

              {ver('appointment:read') && <Construible i={sig()} className="ancho-2" etiqueta="Agenda de hoy"><AgendaHoy d={data} /></Construible>}
              {ver('order:read') && <Construible i={sig()} etiqueta="Últimos pagos"><UltimosPagos pagos={data.pagos_recientes} /></Construible>}
              <PreguntaNegocio i={sig()} />
              {ver('conversation:read') && <Construible i={sig()} className="ancho-2" etiqueta="Hilo en vivo"><HiloVivo hilo={data.hilo} /></Construible>}
              {data.fiscal && <Construible i={sig()} etiqueta="Ciclo fiscal de hoy"><Cab titulo="Ciclo fiscal de hoy" accion={<Link to="/facturacion" className="btn sutil peq">Facturación</Link>} /><CicloFiscal conteos={data.fiscal} /></Construible>}
              {data.consumo && <Construible i={sig()} etiqueta="Consumo del plan"><Cab titulo="Consumo del plan" accion={<Link to="/suscripcion" className="btn sutil peq">Detalle</Link>} />
                <div className="col" style={{ gap: 14 }}><Medidor c={data.consumo.tokens_ia} etiqueta="IA" /><Medidor c={data.consumo.mensajes} etiqueta="Mensajes" /><Medidor c={data.consumo.documentos} etiqueta="Documentos fiscales" /></div></Construible>}
            </div>
          </LayoutGroup>
        )}
      </div>
    </>
  );
}

/** Mientras llegan los datos (fuera de una construcción): la silueta del tablero, sin cifras inventadas. */
function EsqueletoInicial() {
  return <div className="tv-grid" aria-hidden="true">{['ancho-total', '', '', '', '', 'ancho-2 alto-2', 'alto-2', 'alto-2'].map((c, i) => <div key={i} className={`tv-card es-esqueleto ${c}`}><span className="tv-esqueleto" /></div>)}</div>;
}

function Cab({ titulo, accion, extra }: { titulo: ReactNode; accion?: ReactNode; extra?: ReactNode }) {
  return <div className="tv-cab"><h2>{titulo}</h2>{extra}{accion && <span className="tv-cab-accion">{accion}</span>}</div>;
}

/** «Preguntar a Omnegia IA sobre esto»: abre el chat lateral con la pregunta ya escrita. */
function PreguntarSobre({ pregunta }: { pregunta: string }) {
  const { abrirPanel } = useIA();
  if (!usePuedeIA()) return null;
  return <button type="button" className="tv-preguntar" onClick={() => abrirPanel(pregunta)}><Icon n="ia" className="" size={14} />Preguntar a Omnegia IA sobre esto</button>;
}

/** Tarjeta de cifra: etiqueta arriba, la cifra con su gráfica pequeña y el detalle a todo lo ancho. */
function Stat({ icono, moneda, etiqueta, valor, pie, grafica, a }: { icono?: string; moneda?: boolean; etiqueta: ReactNode; valor: ReactNode; pie: ReactNode; grafica?: ReactNode; a?: string }) {
  const cuerpo = <>
    <span className="tv-stat-cab">{icono && <span className={`tv-stat-ico ${moneda ? 'moneda' : ''}`}><Icon n={icono} className="" size={16} /></span>}<span className="tv-etq">{etiqueta}</span></span>
    <span className="tv-stat-cuerpo"><b className="tv-cifra">{valor}</b>{grafica}</span>
    <small className="tv-stat-pie">{pie}</small>
  </>;
  return a ? <Link to={a} className="tv-stat tv-enlace">{cuerpo}</Link> : <div className="tv-stat">{cuerpo}</div>;
}

function Tile({ icono, etiqueta, valor, pie }: { icono: string; etiqueta: string; valor: number; pie: string }) {
  return <Stat icono={icono} etiqueta={etiqueta} valor={<Cuenta valor={valor} />} pie={pie} />;
}

function VendidoMes({ d }: { d: any }) {
  const m = d.mes;
  return <Stat etiqueta="Vendido este mes" valor={<Cuenta valor={m.ventas} formato={cop} />}
    grafica={<MiniBarras valores={d.ingresos.map((x: any) => x.total)} nombre={`Ventas de los últimos 7 días: ${d.ingresos.map((x: any) => `${diaCorto(x.dia)} ${cop(x.total)}`).join(', ')}`} />}
    pie={<><Variacion actual={m.ventas} previo={m.ventas_previo} sufijo="frente al mismo tramo del mes pasado" /> {m.n} {m.n === 1 ? 'venta' : 'ventas'}</>} />;
}

function ClientesNuevos({ d }: { d: any }) {
  return <Stat icono="clientes" etiqueta="Clientes nuevos · 7 días" valor={<Cuenta valor={d.cifras.clientes_nuevos} />}
    grafica={<Chispa valores={d.clientes_serie} nombre={`Clientes nuevos por día: ${d.clientes_serie.join(', ')}`} />} pie={`${d.empresa.clientes} en total`} />;
}

function CobradoHoy({ d }: { d: any }) {
  const c = d.cobros_hoy;
  const metodo = c && ['efectivo', 'transferencia', 'datafono', 'pasarela'].filter((k) => c[k] > 0).sort((x, y) => c[y] - c[x])[0];
  return <Stat a="/ventas?caja=1" icono="moneda" moneda etiqueta="Cobrado hoy" valor={<Cuenta valor={c?.total ?? 0} formato={cop} />}
    pie={c?.pagos ? `${c.pagos} ${c.pagos === 1 ? 'pago' : 'pagos'}${metodo ? ` · más en ${METODO[metodo.toUpperCase()]?.toLowerCase() ?? metodo}` : ''}` : 'Todavía no hay pagos hoy'} />;
}

function EnVivo({ d }: { d: any }) {
  const a = d.actividad;
  return <Stat a="/conversaciones" etiqueta={<><span className="tv-envivo"><i />En vivo</span>WhatsApp</>} valor={<Cuenta valor={a.recibidos} />}
    grafica={<Chispa valores={a.serie} clara nombre={`Mensajes de clientes por hora, últimas 12 horas: ${a.serie.join(', ')}`} />}
    pie={`${a.recibidos === 1 ? 'mensaje' : 'mensajes'} de clientes hoy · ${a.ia} de la IA`} />;
}

function Balance({ d }: { d: any }) {
  const [rango, setRango] = useState<7 | 30>(30);
  const m = d.mes;
  const serie: { dia: string; total: number }[] = rango === 30 ? d.serie_mes : d.serie_mes.slice(-7);
  const tendencia = !m.semana_previa ? null : m.semana >= m.semana_previa * 1.03 ? ['ok', 'Al alza'] : m.semana <= m.semana_previa * 0.97 ? ['aviso', 'A la baja'] : ['neutro', 'Estable'];
  return (
    <div className="tv-balance">
      <Cab titulo="Ventas" extra={tendencia && <span className={`tv-tendencia ${tendencia[0]}`}><Icon n={tendencia[0] === 'ok' ? 'ok' : 'info'} className="" size={13} />{tendencia[1]}</span>}
        accion={<span className="tabs tv-rango" role="group" aria-label="Periodo de la gráfica">{([7, 30] as const).map((r) => <button key={r} type="button" className={rango === r ? 'on' : ''} aria-pressed={rango === r} onClick={() => setRango(r)}>{r} días</button>)}</span>} />
      <div className="tv-submetricas">
        <div className="tv-sub"><span className="tv-etq">Esta semana</span><b><Cuenta valor={m.semana} formato={cop} /></b><Variacion actual={m.semana} previo={m.semana_previa} sufijo="frente a la semana anterior" /></div>
        <div className="tv-sub"><span className="tv-etq">Ticket promedio</span><b><Cuenta valor={m.ticket_semana} formato={cop} /></b><Variacion actual={m.ticket_semana} previo={m.ticket_semana_previa} sufijo="frente a la semana anterior" /></div>
      </div>
      <LineaViva key={rango} valores={serie.map((x) => x.total)} etiquetas={serie.map((x) => diaCorto(x.dia))} formato={copCorto} nombre={`Ventas por día, últimos ${rango} días`} />
      <PreguntarSobre pregunta={`¿Cómo van las ventas de los últimos ${rango} días? Muéstrame una gráfica.`} />
    </div>
  );
}

function CobradoMes({ d }: { d: any }) {
  const m = d.mes;
  const pct = m.ventas > 0 ? (m.cobrado / m.ventas) * 100 : 0;
  return (
    <div className="tv-cobrado">
      <Cab titulo="Cobrado del mes" />
      <span className="tv-etq">De lo vendido este mes</span>
      <b className="tv-cifra grande"><Cuenta valor={m.cobrado} formato={cop} /></b>
      <small className="tenue">de {cop(m.ventas)} vendidos</small>
      <Arco pct={pct} etiqueta="Porcentaje cobrado de lo vendido este mes" pie={m.ventas > 0 ? 'cobrado' : 'sin ventas aún'} />
      {d.cifras.por_cobrar > 0 && <Link to="/ventas?pago=PENDIENTE" className="tv-porcobrar"><Icon n="reloj" className="" size={14} />Por cobrar <b>{cop(d.cifras.por_cobrar)}</b><Icon n="derecha" className="" size={14} /></Link>}
    </div>
  );
}

function Empresa({ d }: { d: any }) {
  const { s } = useSesion();
  const t = s.tenant;
  return (
    <div className="tv-empresa">
      <span className="tv-empresa-marca">{t.logo_data_url ? <img src={t.logo_data_url} alt="" /> : <span>{t.tema?.monograma ?? t.nombre.slice(0, 2)}</span>}<i aria-hidden="true" /></span>
      <b className="tv-empresa-nombre">{t.nombre}</b>
      <span className="tenue peq-txt">{s.usuario.nombre} · {s.usuario.rol_nombre}</span>
      <dl className="tv-empresa-cifras">
        <div><dt>Clientes</dt><dd><Cuenta valor={d.empresa.clientes} /></dd></div>
        <div><dt>Catálogo</dt><dd><Cuenta valor={d.empresa.catalogo} /></dd></div>
        <div><dt>Equipo</dt><dd><Cuenta valor={d.empresa.equipo} /></dd></div>
      </dl>
    </div>
  );
}

function Atencion({ a }: { a: any[] }) {
  if (!a.length) return <div className="tv-aldia-fila"><span className="estado ok"><Icon n="ok" className="" />Al día</span><span className="sec">Nada requiere tu atención: no hay facturas rechazadas, casos sin responder ni productos bajo mínimo.</span></div>;
  return (
    <>
      <Cab titulo={<span className="fila">Requiere tu atención <span className="estado warn">{a.length}</span></span>} />
      <div>
        {a.map((x, i) => (
          <div key={i} className="atencion-fila">
            <Estado v={x.nivel === 'error' ? 'RECHAZADO' : x.nivel === 'warn' ? 'PENDIENTE' : 'ESCALADA'} texto={x.tipo === 'factura_rechazada' ? 'DIAN' : x.tipo === 'caso' ? 'Caso' : x.tipo === 'stock' ? 'Stock' : x.tipo === 'entrega' ? 'WhatsApp' : 'IA'} />
            <span style={{ minWidth: 0 }}><span className="lista-titulo">{x.titulo}</span><br /><span className="lista-detalle">{x.detalle}</span></span>
            <Link className="btn peq" to={x.accion.ruta}>{x.accion.etiqueta}<Icon n="derecha" className="" size={14} /></Link>
          </div>
        ))}
      </div>
    </>
  );
}

function AgendaHoy({ d }: { d: any }) {
  return (
    <>
      <Cab titulo="Agenda de hoy" accion={<Link to="/agenda" className="btn sutil peq">Abrir agenda</Link>} />
      {d.agenda.length === 0 ? <Vacio titulo="Sin citas hoy">Las citas que agende el equipo o la IA aparecerán aquí.</Vacio> : (
        <div>
          {d.agenda.map((a: any) => (
            <div key={a.id} className="cita-fila">
              <span className="h">{a.hora}</span>
              <span style={{ minWidth: 0 }}><span className="lista-titulo cortar" style={{ display: 'block' }}>{a.cliente}</span><span className="lista-detalle">{a.servicio} · {a.recurso}</span></span>
              <span className="fila" style={{ gap: 6 }}>{a.origen === 'AGENTE' && <Estado v="AGENTE" texto="IA" />}<Estado v={a.estado} /></span>
            </div>
          ))}
        </div>
      )}
      {d.ocupacion.length > 0 && <div className="fila envolver" style={{ marginTop: 12, gap: 6 }} aria-label="Citas por persona">{d.ocupacion.map((o: any) => <span key={o.nombre} className="chip">{o.nombre} <b>{o.citas}</b></span>)}</div>}
    </>
  );
}

function UltimosPagos({ pagos }: { pagos: any[] }) {
  return (
    <>
      <Cab titulo="Últimos pagos" accion={<Link to="/ventas?caja=1" className="tv-flecha" aria-label="Caja del día"><Icon n="derecha" className="" size={16} /></Link>} />
      {pagos.length === 0 ? <Vacio titulo="Sin pagos todavía">Los pagos en efectivo, transferencia, datáfono o por enlace aparecerán aquí.</Vacio> : (
        <ul className="tv-pagos">
          {pagos.map((p) => (
            <li key={p.id} className={p.estado === 'REGISTRADO' ? 'entra' : 'anulado'}>
              <Link to={`/ventas/${p.order_id}`}>
                <span className="tv-pago-txt"><b className="cortar">{p.cliente}</b><small>{METODO[p.metodo] ?? p.metodo} · #{p.numero} · {hace(p.creado_en)}</small></span>
                <span className="tv-monto">{p.estado === 'REGISTRADO' ? '+' : ''}{cop(p.monto)}{p.estado !== 'REGISTRADO' && <span className="sr"> (anulado)</span>}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function HiloVivo({ hilo }: { hilo: any[] }) {
  return (
    <>
      <Cab titulo="Hilo en vivo" accion={<Link to="/conversaciones" className="btn sutil peq">Ver bandeja</Link>} />
      {hilo.length === 0 ? <Vacio titulo="Sin conversaciones todavía">Cuando tus clientes escriban por WhatsApp, verás aquí lo que responde y ejecuta la IA.</Vacio> : (
        <div className="hilo dashboard-feed">
          {hilo.map((h: any) => h.kind === 'recibo'
            ? <Recibo key={h.id} e={{ ...h, nivel_riesgo: h.riesgo, permiso_requerido: h.permiso, motivo_denegacion: h.motivo }} compacto />
            : <Mensaje key={h.id} a={`/conversaciones/${h.conversation_id}`} tipo={TIPO[h.remitente] ?? 'sistema'} quien={h.remitente === 'CUSTOMER' ? h.cliente : undefined} hora={hora(h.creado_en)}>
                {h.texto.length > 220 ? h.texto.slice(0, 220) + '…' : h.texto}
              </Mensaje>)}
        </div>
      )}
    </>
  );
}

/** Tarjeta de la IA en el tablero: una pregunta rápida abre el chat lateral. */
function PreguntaNegocio({ i }: { i: number }) {
  const { abrirPanel } = useIA();
  const { s, puede } = useSesion();
  if (!usePuedeIA()) return null;
  const chips = [
    { texto: '¿Cuánto vendimos esta semana?', permiso: 'order:read', modulo: 'ventas' },
    { texto: '¿Qué citas hay hoy?', permiso: 'appointment:read', modulo: 'agenda' },
    { texto: '¿Cómo registro una venta?', permiso: 'order:create', modulo: 'ventas' },
  ].filter((p) => puede(p.permiso) && s.modulos.includes(p.modulo)).slice(0, 2);
  return (
    <Construible i={i} className="tv-ia" etiqueta="Pregúntale a tu negocio">
      <OrbeCara tamano={52} />
      <b>Pregúntale a tu negocio</b>
      <span className="tenue peq-txt">Consulta tus cifras al momento o pide que te muestre cómo se hace algo.</span>
      <span className="tv-ia-chips">{chips.map((c) => <button key={c.texto} type="button" className="chip" onClick={() => abrirPanel(c.texto)}>{c.texto}</button>)}</span>
      <button type="button" className="btn primario" onClick={() => abrirPanel()}>Preguntar a Omnegia IA</button>
    </Construible>
  );
}

function Personalizado({ p }: { p: any }) {
  const { s, puede } = useSesion();
  const destinos: Record<string, [string, string]> = { clientes: ['/clientes', 'customer:read'], catalogo: ['/inventario', 'catalog:read'], inventario: ['/inventario', 'catalog:read'], ventas: ['/ventas', 'order:read'], agenda: ['/agenda', 'appointment:read'], conversaciones: ['/conversaciones', 'conversation:read'], ia: ['/ia', 'ai:read'], facturacion: ['/facturacion', 'invoice:read'], comisiones: ['/configuracion', 'tenant:configure'], membresias: ['/configuracion', 'tenant:configure'] };
  return (
    <section className="workspace-personalized" aria-label="Tu espacio personalizado">
      <ThinkingOrb state="breathing" size={64} theme="light" aria-label="Configuración personalizada de Omnegia" />
      <div><span className="workspace-personalized-tag"><Icon n="ia" size={14} className="" />Preparado por la IA para {s.tenant.nombre}</span><p>{p.descripcion}</p>
        {Array.isArray(p.prioridades) && <ul>{p.prioridades.slice(0, 3).map((x: any, i: number) => {
          const dest = destinos[x.modulo];
          if (!dest || !puede(dest[1]) || !s.modulos.includes(x.modulo)) return null;
          return <li key={`${x.modulo}-${i}`}><Link to={dest[0]}><strong>{x.titulo}</strong><span>{x.descripcion}</span><Icon n="flecha" size={16} className="" /></Link></li>;
        })}</ul>}
      </div>
    </section>
  );
}

/** Configuración inicial: cada paso se marca solo cuando el dato existe en el servidor. */
function PrimerosPasos({ p }: { p: { pasos: { clave: string; titulo: string; hecho: boolean; ruta: string; detalle: string }[]; completos: number; total: number } }) {
  return (
    <div className="pasos-inicio" aria-labelledby="pasos-titulo">
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
    </div>
  );
}
