import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, cop, descargar, fechaHora, hoyLocal } from '../../../api';
import { Cabecera, Escritura, useSesion } from '../../../components/Layout';
import { Cargando, ErrorCarga, Estado, Paginador, useAccion, useApi, useRetardo, Vacio } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { NOMBRE_METODO } from '../../../components/Cobro';
import { escalon } from '../../../components/Movimiento';
import { descargarComprobante } from '../Comprobantes';
import { CajaDelDia } from '../Negocio';
import { PestanasVentas } from './Pestanas';

/**
 * Historial de ventas: filtros como chips (período, origen, estado del pago), búsqueda por cliente o número,
 * totales del filtro y el detalle en un panel lateral sin salir de la lista. Se actualiza solo: las ventas que
 * hace la IA por WhatsApp entran en vivo con una animación y el distintivo «IA».
 */
const PERIODOS: [string, string][] = [['', 'Todo'], ['hoy', 'Hoy'], ['semana', 'Esta semana'], ['mes', 'Este mes']];
const ORIGENES: [string, string][] = [['', 'Cualquier origen'], ['AGENTE', 'Hechas por la IA'], ['PANEL', 'Hechas en el panel']];
const PAGOS: [string, string][] = [['', 'Cualquier pago'], ['PENDIENTE', 'Por cobrar'], ['PAGADA', 'Pagadas']];
const COMPROBANTES: [string, string][] = [['', 'Con o sin comprobante'], ['CON', 'Con comprobante'], ['SIN', 'Sin comprobante']];
const FISCALES: [string, string][] = [['', 'Cualquier factura'], ['RECHAZADO', 'Factura rechazada'], ['PENDIENTE', 'Factura en trámite'], ['ENTREGADO', 'Facturadas'], ['SIN_FACTURA', 'Sin factura']];

function Chips({ etiqueta, opciones, valor, onCambio }: { etiqueta: string; opciones: [string, string][]; valor: string; onCambio: (v: string) => void }) {
  return (
    <div className="chips-filtro" role="group" aria-label={etiqueta}>
      {opciones.map(([k, v]) => <button key={k} type="button" className={`chip ${valor === k ? 'on' : ''}`} aria-pressed={valor === k} onClick={() => onCambio(k)}>{v}</button>)}
    </div>
  );
}

export function Historial() {
  const { s, puede } = useSesion();
  const dian = !!s.factura_dian;
  const [periodo, setPeriodo] = useState('');
  const [origen, setOrigen] = useState('');
  const [params] = useSearchParams();
  const [pago, setPago] = useState(params.get('pago') ?? '');
  const [comprobante, setComprobante] = useState('');
  const [fiscal, setFiscal] = useState('');
  const [metodo, setMetodo] = useState('');
  const [q, setQ] = useState('');
  const qr = useRetardo(q);
  const [pagina, setPagina] = useState(1);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [caja, setCaja] = useState(params.get('caja') === '1');
  const { run } = useAccion();
  // Los enlaces de otras pantallas («Por cobrar» en Inicio) llegan con ?pago=PENDIENTE aunque esta ya esté abierta.
  useEffect(() => { setPago(params.get('pago') ?? ''); if (params.get('caja') === '1') setCaja(true); }, [params]);
  useEffect(() => setPagina(1), [qr, periodo, origen, pago, comprobante, fiscal, metodo]);
  const consulta = new URLSearchParams({
    ...(periodo && { periodo }), ...(origen && { origen }), ...(pago && { pago }), ...(comprobante && !dian && { comprobante }), ...(fiscal && dian && { estado_fiscal: fiscal }), ...(metodo && { metodo }),
    ...(qr && { q: qr }), pagina: String(pagina), por_pagina: '50',
  }).toString();
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/ventas?${consulta}`), [consulta], { cada: 5000 });

  // Ventas que llegan mientras la lista está abierta: entran con una animación (la primera carga no cuenta).
  const conocidas = useRef<Set<string> | null>(null);
  const [nuevas, setNuevas] = useState<Set<string>>(new Set());
  useEffect(() => { conocidas.current = null; setNuevas(new Set()); }, [consulta]);
  useEffect(() => {
    if (!data) return;
    const ids = data.ventas.map((v: any) => v.id as string);
    if (conocidas.current) {
      const llegadas = ids.filter((id: string) => !conocidas.current!.has(id));
      if (llegadas.length) {
        setNuevas((p) => new Set([...p, ...llegadas]));
        setTimeout(() => setNuevas((p) => { const n = new Set(p); llegadas.forEach((id: string) => n.delete(id)); return n; }), 6000);
      }
    }
    conocidas.current = new Set([...(conocidas.current ?? []), ...ids]);
  }, [data]);

  const t = data?.totales;
  const hayFiltro = !!(periodo || origen || pago || comprobante || fiscal || metodo || qr);
  return (
    <>
      <Cabecera titulo="Ventas" sub="Lo que vendes, qué está pagado y qué falta por cobrar." pestanas={<PestanasVentas activa="historial" />}>
        <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder={dian ? 'Cliente, número o factura' : 'Cliente, número o comprobante'} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar ventas" /></label>
        <button className="btn" onClick={() => setCaja(true)}><Icon n="caja" className="" size={16} />Caja del día</button>
        <button className="btn" onClick={() => run(() => descargar(`/api/t/ventas.csv`, `ventas-${hoyLocal()}.csv`), 'Exportación lista')}>Exportar</button>
        {puede('order:create') && <Link className="btn primario" to="/ventas/vender" data-guia="ventas/registrar"><Icon n="mas" className="" size={16} />Registrar venta</Link>}
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <section className="tarjeta" hidden={!!error}>
          <div className="filtros col" style={{ gap: 8 }}>
            <Chips etiqueta="Período" opciones={PERIODOS} valor={periodo} onCambio={setPeriodo} />
            <div className="fila envolver" style={{ gap: 12 }}>
              <Chips etiqueta="Origen" opciones={ORIGENES} valor={origen} onCambio={setOrigen} />
              <Chips etiqueta="Estado del pago" opciones={PAGOS} valor={pago} onCambio={setPago} />
              <Chips etiqueta={dian ? 'Factura' : 'Comprobante'} opciones={dian ? FISCALES : COMPROBANTES} valor={dian ? fiscal : comprobante} onCambio={dian ? setFiscal : setComprobante} />
              <select className="input filtro-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)} aria-label="Filtrar por método de pago">
                <option value="">Cualquier método</option>
                {Object.entries(NOMBRE_METODO).map(([k, v]) => <option key={k} value={k}>Pagadas con {v.toLowerCase()}</option>)}
              </select>
            </div>
          </div>
          {t && (
            <p className="totales-filtro" aria-live="polite">
              <b>{t.vigentes}</b> {t.vigentes === 1 ? 'venta' : 'ventas'} · <b>{cop(t.vendido)}</b> vendido{t.por_cobrar > 0 && <> · <b className="error">{cop(t.por_cobrar)}</b> por cobrar</>}
            </p>
          )}
          {!data ? <Cargando /> : data.ventas.length === 0 ? (
            <Vacio titulo="No hay ventas en esta vista" accion={hayFiltro ? <button className="btn" onClick={() => { setPeriodo(''); setOrigen(''); setPago(''); setComprobante(''); setFiscal(''); setMetodo(''); setQ(''); }}>Quitar los filtros</button> : puede('order:create') ? <Link className="btn primario" to="/ventas/vender">Hacer la primera venta</Link> : undefined}>
              {hayFiltro ? 'Prueba con otro filtro o búsqueda.' : 'Registra la primera venta o deja que el asistente la cree desde WhatsApp.'}
            </Vacio>
          ) : (
            <>
              <div className="tabla-wrap"><table className="tabla tabla-movil">
                <thead><tr><th>#</th><th>Fecha</th><th>Cliente</th><th>Detalle</th><th className="num">Total</th><th>Pago</th><th>{dian ? 'Factura' : 'Comprobante'}</th></tr></thead>
                <tbody className="entra-escalonado">{data.ventas.map((o: any, i: number) => (
                  <tr key={o.id} className={`clic ${nuevas.has(o.id) ? 'fila-nueva' : ''} ${abierta === o.id ? 'fila-abierta' : ''}`} style={escalon(i)} data-guia={i === 0 ? 'ventas/fila' : undefined} onClick={() => setAbierta(o.id)}>
                    <td data-etiqueta="Venta" className="principal"><button className="enlace mono" onClick={(e) => { e.stopPropagation(); setAbierta(o.id); }}>#{o.numero}</button> {o.origen === 'AGENTE' && <span className={`insignia-ia ${nuevas.has(o.id) ? 'late' : ''}`} title="Venta hecha por la IA"><Icon n="ia" className="" size={12} />IA</span>}</td>
                    <td data-etiqueta="Fecha">{fechaHora(o.creado_en)}</td>
                    <td data-etiqueta="Cliente">{o.cliente}</td>
                    <td data-etiqueta="Detalle" className="sec cortar detalle-celda">{o.detalle}</td>
                    <td data-etiqueta="Total" className="num"><b>{cop(o.total)}</b></td>
                    <td data-etiqueta="Pago">{o.estado === 'ANULADA' ? <Estado v="ANULADA" /> : <span className="col" style={{ gap: 2 }}><Estado v={o.estado_pago === 'PAGADA' ? 'PAGADA' : 'PENDIENTE'} texto={o.estado_pago === 'PAGADA' ? 'Pagada' : 'Por cobrar'} />{o.estado_pago === 'PAGADA' && o.metodo_pago && <span className="tenue peq-txt">{NOMBRE_METODO[o.metodo_pago] ?? o.metodo_pago}</span>}</span>}</td>
                    {dian
                      ? <td data-etiqueta="Factura">{o.estado_fiscal ? <span className="fila" style={{ gap: 6 }}><Estado v={o.estado_fiscal} /><span className="mono tenue">{o.documento}</span></span> : <span className="tenue">{o.estado === 'ANULADA' ? '—' : 'Sin factura'}</span>}</td>
                      : <td data-etiqueta="Comprobante">{o.comprobante ? <span className="mono">{o.comprobante}</span> : <span className="tenue">{o.estado === 'ANULADA' ? '—' : 'Sin comprobante'}</span>}</td>}
                  </tr>
                ))}</tbody>
              </table></div>
              <Paginador pagina={data.pagina} total={data.total} porPagina={data.por_pagina} onPagina={setPagina} />
            </>
          )}
        </section>
      </div>
      {abierta && <DetalleLateral id={abierta} onCerrar={() => setAbierta(null)} onCambio={recargar} />}
      {caja && <CajaDelDia onCerrar={() => setCaja(false)} />}
    </>
  );
}

/** Panel lateral con el resumen de una venta: se ve sin salir de la lista; lo demás vive en la venta completa. */
function DetalleLateral({ id, onCerrar, onCambio }: { id: string; onCerrar: () => void; onCambio: () => void }) {
  const { data, error } = useApi<any>(() => api.get(`/api/t/ventas/${id}`), [id], { cada: 8000 });
  const { run, ocupado } = useAccion();
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onCerrar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onCerrar]);
  const pagos: any[] = (data?.pagos ?? []).filter((p: any) => p.estado === 'REGISTRADO');
  const c = data?.comprobante;
  return (
    <>
      <div className="panel-velo" onClick={onCerrar} aria-hidden="true" />
      <aside className="panel-lateral" role="dialog" aria-label="Detalle de la venta" aria-modal="false">
        <header className="fila entre" style={{ gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{data ? `Venta #${data.numero}` : 'Venta'}</h2>
          <button className="btn peq sutil" onClick={onCerrar} aria-label="Cerrar el detalle"><Icon n="x" className="" size={14} /></button>
        </header>
        {error ? <ErrorCarga error={error} /> : !data ? <Cargando filas={5} /> : (
          <div className="col" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 4 }}>
              <span className="fila envolver" style={{ gap: 6 }}>{fechaHora(data.creado_en)} {data.origen === 'AGENTE' && <span className="insignia-ia"><Icon n="ia" className="" size={12} />IA</span>}</span>
              <span><b>{data.cliente}</b>{data.telefono ? <span className="tenue"> · {data.telefono}</span> : null}</span>
              <span className="fila envolver" style={{ gap: 6 }}>{data.estado === 'ANULADA' ? <Estado v="ANULADA" /> : <Estado v={data.estado_pago === 'PAGADA' ? 'PAGADA' : 'PENDIENTE'} texto={data.estado_pago === 'PAGADA' ? 'Pagada' : 'Por cobrar'} />}</span>
            </div>
            <ul className="lineas-lateral">
              {data.items.map((i: any, k: number) => (
                <li key={k}><span className="col" style={{ gap: 0, minWidth: 0 }}><b className="cortar">{i.descripcion}</b><span className="tenue peq-txt">{i.cantidad} × {cop(i.precio_unit)}{i.descuento_pct > 0 ? ` · −${i.descuento_pct} %` : ''}</span>{i.nota && <span className="peq-txt">Nota: {i.nota}</span>}</span><b className="num">{cop(i.total)}</b></li>
              ))}
            </ul>
            <div className="pos-total"><span>Total</span><b>{cop(data.total)}</b></div>
            {pagos.map((p) => <span key={p.id} className="tenue peq-txt">{p.metodo_nombre} · {cop(p.monto)}{p.metodo === 'EFECTIVO' && p.cambio > 0 ? ` · cambio ${cop(p.cambio)}` : ''}</span>)}
            <div className="col" style={{ gap: 6 }}>
              <b className="peq-txt">Comprobante</b>
              {c?.estado === 'EMITIDO' ? (
                <span className="fila envolver" style={{ gap: 6 }}>
                  <span className="mono">{c.numero}</span>
                  <button className="btn peq" disabled={ocupado} onClick={() => run(() => descargarComprobante(c))}><Icon n="descargar" className="" size={14} />PDF</button>
                  <Escritura permiso="comprobante:send"><button className="btn peq" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/comprobantes/${c.id}/reenviar`, { canal: 'WHATSAPP' }), 'Comprobante enviado por WhatsApp')}>Enviar por WhatsApp</button></Escritura>
                </span>
              ) : data.estado === 'CONFIRMADA' ? (
                <Escritura permiso="comprobante:issue" modulo="ventas"><button className="btn peq" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={async () => { const r = await run(() => api.post(`/api/t/ventas/${id}/comprobante`), 'Comprobante generado'); if (r) onCambio(); }}>Generar comprobante</button></Escritura>
              ) : <span className="tenue peq-txt">Sin comprobante.</span>}
            </div>
            <Link className="btn primario" to={`/ventas/${id}`}>Abrir la venta completa</Link>
            <span className="tenue peq-txt">Para cobrar, anular o ver el historial de la venta, ábrela completa.</span>
          </div>
        )}
      </aside>
    </>
  );
}

