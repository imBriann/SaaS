import { ImportSummary } from '../../components/ImportSummary';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, cop, descargar, fecha, fechaHora, fechaLarga, hora, hoyLocal, zona } from '../../api';
import { Cabecera, Escritura, useSesion } from '../../components/Layout';
import { Campo, Cargando, CicloFiscal, Cifra, Confirmar, ErrorCarga, Estado, Modal, Paginador, Recibo, Tarjeta, useAccion, useApi, useRetardo, useToast, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { CamposCobro, CobroExitoso, cuerpoPago, type Metodos, NOMBRE_METODO, nuevaClave, type PagoElegido, validarPago } from '../../components/Cobro';
import { Contador, escalon } from '../../components/Movimiento';

// =================================================================== Clientes
export function Clientes() {
  const [q, setQ] = useState('');
  const qr = useRetardo(q);
  const [pagina, setPagina] = useState(1);
  const [params, setParams] = useSearchParams();
  const sel = params.get('id');
  const [nuevo, setNuevo] = useState(false);
  const { run } = useAccion();
  useEffect(() => setPagina(1), [qr]);
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/clientes?pagina=${pagina}&por_pagina=50${qr ? `&q=${encodeURIComponent(qr)}` : ''}`), [qr, pagina]);
  return (
    <>
      <Cabecera titulo="Clientes" sub="Encuentra sus datos, consulta su historial o añade un contacto.">
        <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Nombre, teléfono, correo o documento" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar clientes" /></label>
        <button className="btn" onClick={() => run(() => descargar('/api/t/clientes.csv', 'clientes.csv'), 'Exportación lista')}>Exportar</button>
        <Escritura permiso="customer:write"><button className="btn primario" onClick={() => setNuevo(true)}><Icon n="mas" className="" size={16} />Nuevo cliente</button></Escritura>
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <div className={`grid ${sel ? 'g-main con-ficha' : ''}`} style={{ alignItems: 'start' }}>
          <section className="tarjeta lista-con-ficha" hidden={!!error}>
            {!data ? <Cargando /> : data.clientes.length === 0 ? <Vacio titulo={qr ? 'Nadie coincide con la búsqueda' : 'Aún no tienes clientes'} accion={!qr ? <Escritura permiso="customer:write"><button className="btn" onClick={() => setNuevo(true)}>Registrar un cliente</button></Escritura> : undefined}>{qr ? 'Revisa la ortografía o busca por teléfono o documento.' : 'Se crean solos cuando alguien te escribe por WhatsApp, o regístralos aquí.'}</Vacio> : (
              <>
                <div className="tabla-wrap"><table className="tabla tabla-movil">
                  <thead><tr><th>Cliente</th><th>Contacto</th><th>Documento</th><th className="num">Compras</th><th>Última cita</th><th>Datos personales</th></tr></thead>
                  <tbody>{data.clientes.map((c: any) => (
                    <tr key={c.id} className={`clic ${sel === c.id ? 'sel' : ''}`} onClick={() => setParams({ id: c.id })} aria-current={sel === c.id ? 'true' : undefined}>
                      <td data-etiqueta="Cliente" className="principal"><button type="button" className="enlace-fila" onClick={(e) => { e.stopPropagation(); setParams({ id: c.id }); }}>{c.nombre}</button></td>
                      <td data-etiqueta="Contacto"><span className="mono">{c.telefono ?? '—'}</span>{c.email && <><br /><span className="tenue peq-txt">{c.email}</span></>}</td>
                      <td data-etiqueta="Documento">{c.numero_documento ? <span className="mono">{c.tipo_documento} {c.numero_documento}</span> : <span className="tenue">Consumidor final</span>}</td>
                      <td data-etiqueta="Compras" className="num">{c.compras} · {cop(c.total_compras)}</td>
                      <td data-etiqueta="Última cita">{c.ultima_cita ? fecha(c.ultima_cita) : <span className="tenue">—</span>}</td>
                      <td data-etiqueta="Datos">{c.consentimiento_en ? <Estado v="EXITO" texto="Autorizó" /> : <Estado v="PENDIENTE" texto="Sin autorización" />}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
                <Paginador pagina={data.pagina} total={data.total} porPagina={data.por_pagina} onPagina={setPagina} />
              </>
            )}
          </section>
          {sel && <FichaCliente id={sel} onCambio={recargar} onCerrar={() => setParams({})} />}
        </div>
        <p className="nota-pie"><Icon n="candado" className="" size={14} />Tratamos estos datos por encargo de tu negocio (Ley 1581 de 2012). Desde la ficha puedes exportar los datos de un titular cuando lo pida.</p>
      </div>
      {nuevo && <FormCliente onCerrar={() => setNuevo(false)} onGuardado={(id) => { setNuevo(false); recargar(); setParams({ id }); }} />}
    </>
  );
}

function FormCliente({ inicial, onCerrar, onGuardado }: { inicial?: any; onCerrar: () => void; onGuardado: (id: string) => void }) {
  const [f, setF] = useState<any>(inicial ?? { nombre: '', telefono: '', email: '', tipo_documento: '', numero_documento: '' });
  const { run, ocupado, error } = useAccion();
  const guardarCliente = async () => {
    const body = Object.fromEntries(Object.entries(f).filter(([k]) => ['nombre', 'telefono', 'email', 'tipo_documento', 'numero_documento', 'notas'].includes(k)).map(([k, v]) => [k, v === '' ? null : v]));
    const r = await run(() => (inicial ? api.patch(`/api/t/clientes/${inicial.id}`, body) : api.post('/api/t/clientes', body)), 'Cliente guardado', { silencioso: true });
    if (r) onGuardado(r.id);
  };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const campoError = (k: string) => (error?.details as any[])?.find?.((d: any) => d.campo === k)?.mensaje;
  return (
    <Modal titulo={inicial ? 'Editar cliente' : 'Nuevo cliente'} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !f.nombre?.trim()} onClick={guardarCliente}>Guardar</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <Campo etiqueta="Nombre o razón social" error={campoError('nombre')}><input className="input" value={f.nombre ?? ''} onChange={set('nombre')} autoComplete="off" /></Campo>
      <div className="grid g2">
        <Campo etiqueta="Teléfono" ayuda="con indicativo; en Colombia basta el celular" error={campoError('telefono')}><input className="input" inputMode="tel" value={f.telefono ?? ''} onChange={set('telefono')} placeholder="300 123 4567" /></Campo>
        <Campo etiqueta="Correo" ayuda="para enviar la factura" error={campoError('email')}><input className="input" type="email" value={f.email ?? ''} onChange={set('email')} /></Campo>
        <Campo etiqueta="Tipo de documento"><select className="input" value={f.tipo_documento ?? ''} onChange={set('tipo_documento')}><option value="">Consumidor final</option><option value="CC">Cédula (CC)</option><option value="NIT">NIT</option><option value="CE">Cédula de extranjería</option><option value="PP">Pasaporte</option></select></Campo>
        <Campo etiqueta="Número" ayuda={f.tipo_documento === 'NIT' ? 'con dígito de verificación: 900123456-7' : undefined}><input className="input" value={f.numero_documento ?? ''} onChange={set('numero_documento')} disabled={!f.tipo_documento} /></Campo>
      </div>
    </Modal>
  );
}

function FichaCliente({ id, onCambio, onCerrar }: { id: string; onCambio: () => void; onCerrar: () => void }) {
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/clientes/${id}`), [id]);
  const [editar, setEditar] = useState(false);
  const { run } = useAccion();
  if (error) return <ErrorCarga error={error} />;
  if (!data) return <section className="tarjeta"><Cargando /></section>;
  const exportar = async () => {
    const r = await run(() => api.get(`/api/t/clientes/${id}/exportar`), 'Exportación registrada en auditoría');
    if (!r) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' }));
    a.download = `titular-${data.nombre.replace(/\s+/g, '-')}.json`;
    a.click();
  };
  return (
    <section className="tarjeta ficha" aria-label={`Ficha de ${data.nombre}`}>
      <div className="cab"><button className="btn peq sutil icono solo-movil" onClick={onCerrar} aria-label="Volver a la lista"><Icon n="atras" className="" size={16} /></button><h2 className="titulo-tarjeta">{data.nombre}</h2>
        <div className="fila" style={{ marginLeft: 'auto', gap: 6 }}>
          <Escritura permiso="customer:write"><button className="btn peq" onClick={() => setEditar(true)}>Editar</button></Escritura>
          <button className="btn peq" onClick={exportar}>Exportar datos</button>
          <button className="btn peq sutil icono no-movil" onClick={onCerrar} aria-label="Cerrar ficha"><Icon n="x" className="" size={16} /></button>
        </div>
      </div>
      <div className="cuerpo col" style={{ gap: 16 }}>
        <dl className="datos-def">
          <dt>Teléfono</dt><dd>{data.telefono ? <span className="mono">{data.telefono}</span> : <span className="tenue">Sin teléfono</span>}</dd>
          <dt>Correo</dt><dd>{data.email ?? <span className="tenue">Sin correo</span>}</dd>
          <dt>Documento</dt><dd>{data.numero_documento ? <span className="mono">{data.tipo_documento} {data.numero_documento}</span> : 'Consumidor final'}</dd>
        </dl>
        {data.consentimiento_en ? <span><Estado v="EXITO" texto={`Autorizó el tratamiento de datos · ${fechaHora(data.consentimiento_en)}`} /></span>
          : <div className="fila envolver"><Estado v="PENDIENTE" texto="Sin autorización registrada" /><Escritura permiso="customer:write"><button className="btn peq" onClick={() => run(() => api.post(`/api/t/clientes/${id}/consentimiento`), 'Autorización registrada').then(recargar)}>Registrar autorización</button></Escritura></div>}
        <div className="col" style={{ gap: 2 }}>
          <span className="etiqueta">Compras</span>
          {data.orders.length === 0 ? <span className="tenue peq-txt">Sin compras</span> : <div className="lista">{data.orders.map((o: any) => (
            <Link key={o.id} to={`/ventas/${o.id}`} className="lista-fila" style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto auto' }}><span className="mono">#{o.numero}</span><span className="tenue peq-txt">{fecha(o.creado_en)}</span><span className="num">{cop(o.total)}</span><Estado v={o.estado === 'ANULADA' ? 'ANULADA' : o.estado_fiscal ?? o.estado} /></Link>
          ))}</div>}
        </div>
        <div className="col" style={{ gap: 2 }}>
          <span className="etiqueta">Citas</span>
          {data.citas.length === 0 ? <span className="tenue peq-txt">Sin citas</span> : <div className="lista">{data.citas.slice(0, 8).map((c: any) => (
            <div key={c.id} className="lista-fila"><span className="peq-txt" style={{ whiteSpace: 'nowrap' }}>{fecha(c.inicio)} {hora(c.inicio)}</span><span className="tenue peq-txt cortar">{c.servicio} · {c.recurso}</span><span className="fila" style={{ gap: 4 }}>{c.origen === 'AGENTE' && <Estado v="AGENTE" texto="IA" />}<Estado v={c.estado} /></span></div>
          ))}</div>}
        </div>
        {data.conversaciones.length > 0 && <div className="col" style={{ gap: 2 }}><span className="etiqueta">Conversaciones</span><div className="lista">{data.conversaciones.map((v: any) => <Link key={v.id} to={`/conversaciones/${v.id}`} className="lista-fila"><span>{v.canal === 'WHATSAPP' ? 'WhatsApp' : v.canal}</span><span className="tenue peq-txt">{fecha(v.actualizado_en)}</span><Estado v={v.estado} /></Link>)}</div></div>}
      </div>
      {editar && <FormCliente inicial={data} onCerrar={() => setEditar(false)} onGuardado={() => { setEditar(false); recargar(); onCambio(); }} />}
    </section>
  );
}

// =================================================================== Ventas
const FILTROS_VENTA: [string, string][] = [['', 'Todas'], ['pago:PENDIENTE', 'Por cobrar'], ['RECHAZADO', 'Factura rechazada'], ['PENDIENTE', 'Factura en trámite'], ['ENTREGADO', 'Facturadas'], ['SIN_FACTURA', 'Sin factura']];

export function Ventas() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [filtro, setFiltro] = useState(params.get('pago') ? `pago:${params.get('pago')}` : '');
  const [metodo, setMetodo] = useState('');
  const [q, setQ] = useState('');
  const qr = useRetardo(q);
  const [pagina, setPagina] = useState(1);
  const [nueva, setNueva] = useState(false);
  const [caja, setCaja] = useState(params.get('caja') === '1');
  const { run } = useAccion();
  useEffect(() => setPagina(1), [qr, filtro, metodo]);
  const consulta = (filtro.startsWith('pago:') ? `pago=${filtro.slice(5)}` : filtro ? `estado_fiscal=${filtro}` : '') + (metodo ? `&metodo=${metodo}` : '');
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/ventas?pagina=${pagina}&por_pagina=50&${consulta}${qr ? `&q=${encodeURIComponent(qr)}` : ''}`), [consulta, qr, pagina]);
  return (
    <>
      <Cabecera titulo="Ventas" sub="Registra lo que vendes y revisa qué está pagado y qué falta por cobrar.">
        <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Número, cliente o factura" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar ventas" /></label>
        <button className="btn" onClick={() => setCaja(true)}><Icon n="caja" className="" size={16} />Caja del día</button>
        <button className="btn" onClick={() => run(() => descargar(`/api/t/ventas.csv`, `ventas-${hoyLocal()}.csv`), 'Exportación lista')}>Exportar</button>
        <Escritura permiso="order:create" modulo="ventas"><button className="btn primario" onClick={() => setNueva(true)}><Icon n="mas" className="" size={16} />Registrar venta</button></Escritura>
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <section className="tarjeta" hidden={!!error}>
          <div className="filtros">
            <div className="tabs" role="group" aria-label="Filtrar ventas">{FILTROS_VENTA.map(([k, v]) => <button key={k} className={filtro === k ? 'on' : ''} aria-pressed={filtro === k} onClick={() => setFiltro(k)}>{v}</button>)}</div>
            <select className="input filtro-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)} aria-label="Filtrar por método de pago">
              <option value="">Cualquier método</option>
              {Object.entries(NOMBRE_METODO).map(([k, v]) => <option key={k} value={k}>Pagadas con {v.toLowerCase()}</option>)}
            </select>
          </div>
          {!data ? <Cargando /> : data.ventas.length === 0 ? <Vacio titulo="No hay ventas en esta vista">{filtro || qr || metodo ? 'Prueba con otro filtro o búsqueda.' : 'Registra la primera venta o deja que el agente la cree desde WhatsApp.'}</Vacio> : (
            <>
              <div className="tabla-wrap"><table className="tabla tabla-movil">
                <thead><tr><th>#</th><th>Fecha</th><th>Cliente</th><th>Detalle</th><th className="num">Total</th><th>Pago</th><th>Factura</th></tr></thead>
                <tbody className="entra-escalonado">{data.ventas.map((o: any, i: number) => (
                  <tr key={o.id} className="clic" style={escalon(i)} onClick={() => nav(`/ventas/${o.id}`)}>
                    <td data-etiqueta="Venta" className="principal"><Link to={`/ventas/${o.id}`} className="mono" onClick={(e) => e.stopPropagation()}>#{o.numero}</Link> {o.origen === 'AGENTE' && <Estado v="AGENTE" texto="IA" />}</td>
                    <td data-etiqueta="Fecha">{fechaHora(o.creado_en)}</td>
                    <td data-etiqueta="Cliente">{o.cliente}</td>
                    <td data-etiqueta="Detalle" className="sec cortar detalle-celda">{o.detalle}</td>
                    <td data-etiqueta="Total" className="num"><b>{cop(o.total)}</b></td>
                    <td data-etiqueta="Pago">{o.estado === 'ANULADA' ? <Estado v="ANULADA" /> : <span className="col" style={{ gap: 2 }}><Estado v={o.estado_pago === 'PAGADA' ? 'PAGADA' : 'PENDIENTE'} texto={o.estado_pago === 'PAGADA' ? 'Pagada' : 'Por cobrar'} />{o.estado_pago === 'PAGADA' && o.metodo_pago && <span className="tenue peq-txt">{NOMBRE_METODO[o.metodo_pago] ?? o.metodo_pago}</span>}</span>}</td>
                    <td data-etiqueta="Factura">{o.estado_fiscal ? <span className="fila" style={{ gap: 6 }}><Estado v={o.estado_fiscal} texto={o.proveedor_fiscal === 'sandbox' && ['VALIDADO', 'ENTREGADO'].includes(o.estado_fiscal) ? 'Prueba' : undefined} /><span className="mono tenue">{o.documento}</span></span> : <span className="tenue">Sin factura</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              <Paginador pagina={data.pagina} total={data.total} porPagina={data.por_pagina} onPagina={setPagina} />
            </>
          )}
        </section>
      </div>
      {nueva && <NuevaVenta onCerrar={() => { setNueva(false); recargar(); }} onGuardada={(id) => nav(`/ventas/${id}`)} />}
      {caja && <CajaDelDia onCerrar={() => setCaja(false)} />}
    </>
  );
}

/**
 * Cierre de caja: lo cobrado en el día por método (según la fecha del pago), el efectivo recibido y el
 * cambio entregado, y lo que quedó por cobrar. Son los registros del sistema; el conteo físico del
 * dinero lo hace el negocio.
 */
function CajaDelDia({ onCerrar }: { onCerrar: () => void }) {
  const [dia, setDia] = useState(hoyLocal());
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/ventas/caja?fecha=${dia}`), [dia]);
  return (
    <Modal titulo="Caja del día" className="modal-ancho" onCerrar={onCerrar} pie={<button className="btn" onClick={onCerrar}>Cerrar</button>}>
      <Campo etiqueta="Día" ayuda={`hora de ${zona()}`}><input className="input" type="date" value={dia} max={hoyLocal()} onChange={(e) => e.target.value && setDia(e.target.value)} /></Campo>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={4} /> : (
        <>
          <div className="caja-cifras" key={data.fecha}>
            <div className="caja-total" style={escalon(0)}><span className="etiqueta">Cobrado</span><b className="num"><Contador valor={data.total_cobrado} formato={cop} ms={900} /></b><span className="tenue peq-txt">{fechaLarga(data.fecha)}</span></div>
            {data.metodos.filter((m: any) => m.pagos > 0 || m.metodo !== 'PASARELA').map((m: any, i: number) => (
              <div key={m.metodo} className="caja-metodo" data-metodo={m.metodo} style={escalon(i + 1)}>
                <span className="tenue peq-txt">{m.nombre}</span><b className="num"><Contador valor={m.total} formato={cop} ms={800} /></b>
                <span className="tenue peq-txt">{m.pagos} {m.pagos === 1 ? 'pago' : 'pagos'}{data.total_cobrado > 0 && m.total > 0 ? ` · ${Math.round((m.total / data.total_cobrado) * 100)} %` : ''}</span>
                {data.total_cobrado > 0 && m.total > 0 && <i className="caja-barra" style={{ width: `${(m.total / data.total_cobrado) * 100}%` }} aria-hidden="true" />}
              </div>
            ))}
          </div>
          <div className="caja-arqueo">
            <div className="caja-recibo" role="group" aria-label="Arqueo del efectivo">
              <div><span>Efectivo recibido</span><span>{cop(data.efectivo.recibido)}</span></div>
              <div><span>Cambio entregado</span><span>{data.efectivo.cambio > 0 ? '−' : ''}{cop(data.efectivo.cambio)}</span></div>
              <div className="total"><span>Efectivo que debe haber</span><b><Contador valor={data.efectivo.neto} formato={cop} ms={900} /></b></div>
            </div>
          <dl className="datos-def">
            <dt>Ventas del día</dt><dd>{data.ventas.n} por {cop(data.ventas.total)}</dd>
            <dt>Quedaron por cobrar</dt><dd>{data.ventas.por_cobrar ? <Link to="/ventas?pago=PENDIENTE" onClick={onCerrar}>{data.ventas.por_cobrar} por {cop(data.ventas.total_por_cobrar)}</Link> : 'Ninguna'}</dd>
            {data.anulados.pagos > 0 && <><dt>Pagos anulados</dt><dd>{data.anulados.pagos} por {cop(data.anulados.total)} <span className="tenue peq-txt">(no suman)</span></dd></>}
            {data.excedentes.pagos > 0 && <><dt>Pagados de más</dt><dd className="error">{data.excedentes.pagos} por {cop(data.excedentes.total)}: devuélvelos desde la pasarela</dd></>}
          </dl>
          </div>
          {data.detalle.length > 0 ? (
            <div className="tabla-wrap"><table className="tabla tabla-movil">
              <thead><tr><th>Hora</th><th>Venta</th><th>Método</th><th className="num">Valor</th><th>Estado</th><th>Registró</th></tr></thead>
              <tbody className="entra-escalonado">{data.detalle.map((p: any, i: number) => (
                <tr key={p.id} style={escalon(i)}>
                  <td data-etiqueta="Hora" className="mono">{hora(p.creado_en)}</td>
                  <td data-etiqueta="Venta" className="principal"><Link to={`/ventas/${p.venta_id}`} onClick={onCerrar} className="mono">#{p.venta}</Link> <span className="tenue">{p.cliente}</span></td>
                  <td data-etiqueta="Método">{p.metodo_nombre}{p.metodo === 'EFECTIVO' && p.cambio > 0 && <span className="tenue peq-txt"> · cambio {cop(p.cambio)}</span>}</td>
                  <td data-etiqueta="Valor" className="num">{cop(p.monto)}</td>
                  <td data-etiqueta="Estado"><Estado v={p.estado} /></td>
                  <td data-etiqueta="Registró" className="tenue">{p.registrado_por ?? '—'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Vacio titulo="No hay pagos registrados ese día" />}
          <p className="tenue peq-txt">Son los pagos registrados en Omnegia. Cuenta el dinero de la caja y compáralo con «Efectivo que debe haber».</p>
        </>
      )}
    </Modal>
  );
}

function NuevaVenta({ onCerrar, onGuardada }: { onCerrar: () => void; onGuardada: (id: string) => void }) {
  const { puede } = useSesion();
  const responsables=useApi<any[]>(()=>api.get('/api/t/equipo/responsables'),[]);
  const [responsable,setResponsable]=useState('');
  const [qCliente, setQCliente] = useState('');
  const qc = useRetardo(qCliente);
  const clientes = useApi<any>(() => api.get(`/api/t/clientes?por_pagina=30${qc ? `&q=${encodeURIComponent(qc)}` : ''}`), [qc]);
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const cobra = puede('payment:register');
  const metodos = useApi<Metodos | null>(() => (cobra ? api.get('/api/t/cobros/metodos') : Promise.resolve(null)), [cobra]);
  const [cliente, setCliente] = useState<any>(null);
  const [nuevoCliente, setNuevoCliente] = useState<{ nombre: string; telefono: string } | null>(null);
  const [items, setItems] = useState<{ product_id: string; cantidad: number; descuento_pct: number }[]>([]);
  const [pago, setPago] = useState<PagoElegido>({ metodo: 'DESPUES', recibido: '', referencia: '' });
  // Una clave por venta: un doble clic o un reintento no registra dos ventas pagadas.
  const [clave, setClave] = useState(nuevaClave);
  const [hecha, setHecha] = useState<any>(null);
  const { run, ocupado, error, limpiarError } = useAccion();
  const pagoInicial = (): PagoElegido => ({ metodo: metodos.data?.EFECTIVO ? 'EFECTIVO' : 'DESPUES', recibido: '', referencia: '' });
  // Si el negocio acepta efectivo, es lo que se propone primero en el mostrador.
  useEffect(() => { if (metodos.data?.EFECTIVO) setPago((p) => (p.metodo === 'DESPUES' ? { ...p, metodo: 'EFECTIVO' } : p)); }, [metodos.data]);
  const otraVenta = () => { setHecha(null); setCliente(null); setItems([]); setResponsable(''); setQCliente(''); setPago(pagoInicial()); setClave(nuevaClave()); limpiarError(); productos.recargar(); };
  const activos = (productos.data ?? []).filter((p) => p.activo);
  const prod = (id: string) => activos.find((p) => p.id === id);
  // Estimación en pantalla; el total real lo calcula el servidor con el catálogo vigente.
  const total = items.reduce((a, i) => a + Math.round((prod(i.product_id)?.precio ?? 0) * i.cantidad * (1 - (i.descuento_pct || 0) / 100) * 100) / 100, 0);
  const faltaStock = items.find((i) => { const p = prod(i.product_id); return p?.controla_stock && i.cantidad > p.stock; });
  const errorPago = items.length ? validarPago(pago, total) : null;
  const crearCliente = async () => {
    const nombre = nuevoCliente?.nombre.trim();
    if (!nombre) return;
    const r = await run(() => api.post('/api/t/clientes', { nombre, telefono: nuevoCliente!.telefono.trim() || null }), undefined, { silencioso: true });
    if (r) { setCliente({ id: r.id, nombre }); setNuevoCliente(null); setQCliente(''); }
  };
  const registrar = async () => {
    const cuerpo = cobra ? cuerpoPago(pago, clave) : null;
    const r = await run(() => api.post('/api/t/ventas', { customer_id: cliente.id, items, responsable_id: responsable || null, ...(cuerpo ? { pago: cuerpo } : {}) }), undefined, { silencioso: true });
    if (r) setHecha(r);
  };
  if (hecha) {
    return (
      <Modal titulo={`Venta #${hecha.numero}`} className="modal-venta" onCerrar={onCerrar}>
        <CobroExitoso titulo={hecha.pago ? `Venta #${hecha.numero} pagada` : `Venta #${hecha.numero} registrada`} pago={hecha.pago} total={hecha.total}>
          <button className="btn primario" onClick={otraVenta} autoFocus><Icon n="mas" className="" size={16} />Registrar otra venta</button>
          <button className="btn" onClick={() => onGuardada(hecha.id)}>Ver la venta</button>
        </CobroExitoso>
        <p className="tenue peq-txt" style={{ textAlign: 'center', margin: 0 }}>La factura electrónica, si aplica, se emite en segundo plano.</p>
      </Modal>
    );
  }
  return (
    <Modal titulo="Registrar venta" className="modal-venta" onCerrar={onCerrar} pie={<><span className="tenue" style={{ marginRight: 'auto' }}>Total <b>{cop(total)}</b> (IVA incluido)</span><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || !cliente || !items.length || !!faltaStock || !!errorPago} onClick={registrar}>{ocupado ? 'Registrando…' : cobra && pago.metodo !== 'DESPUES' ? 'Registrar y cobrar' : 'Registrar por cobrar'}</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <Campo etiqueta="Persona responsable de la venta" ayuda="Opcional. Permite atribuir la actividad y calcular la comisión configurada."><select className="input" value={responsable} onChange={e=>setResponsable(e.target.value)}><option value="">Sin atribuir</option>{responsables.data?.map(p=><option value={p.id} key={p.id}>{p.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Cliente">
        {cliente ? <span className="fila entre"><b>{cliente.nombre}</b><button type="button" className="btn peq sutil" onClick={() => setCliente(null)}>Cambiar</button></span> : nuevoCliente ? (
          <span className="col nuevo-cliente">
            <input className="input" value={nuevoCliente.nombre} maxLength={120} onChange={(e) => setNuevoCliente({ ...nuevoCliente, nombre: e.target.value })} placeholder="Nombre del cliente" aria-label="Nombre del cliente nuevo" />
            <input className="input" inputMode="tel" value={nuevoCliente.telefono} maxLength={20} onChange={(e) => setNuevoCliente({ ...nuevoCliente, telefono: e.target.value })} placeholder="Teléfono (opcional), ej. 300 123 4567" aria-label="Teléfono del cliente nuevo" />
            <span className="fila envolver" style={{ gap: 6 }}>
              <button type="button" className="btn peq primario" disabled={ocupado || !nuevoCliente.nombre.trim()} onClick={crearCliente}>Crear y usar</button>
              <button type="button" className="btn peq sutil" onClick={() => setNuevoCliente(null)}>Volver a buscar</button>
            </span>
          </span>
        ) : <>
          <input className="input" type="search" placeholder="Busca por nombre, teléfono o documento" value={qCliente} onChange={(e) => setQCliente(e.target.value)} />
          <div className="opciones-busqueda" role="listbox" aria-label="Clientes encontrados">{clientes.data?.clientes?.slice(0, 6).map((c: any) => <button type="button" role="option" aria-selected="false" key={c.id} onClick={() => setCliente(c)}>{c.nombre}<span className="tenue peq-txt">{c.telefono ?? c.numero_documento ?? ''}</span></button>)}
            {clientes.data && !clientes.data.clientes.length && <span className="tenue peq-txt">Nadie coincide{puede('customer:write') ? '.' : '. Pide a quien administra que lo registre en Clientes.'}</span>}</div>
          {puede('customer:write') && <button type="button" className="btn peq sutil" style={{ alignSelf: 'flex-start' }} onClick={() => setNuevoCliente({ nombre: /\d{5,}/.test(qCliente) ? '' : qCliente.trim(), telefono: /\d{5,}/.test(qCliente) ? qCliente.trim() : '' })}><Icon n="mas" className="" size={14} />{qCliente.trim() && !/\d{5,}/.test(qCliente) ? `Crear cliente «${qCliente.trim().slice(0, 40)}»` : 'Crear cliente nuevo'}</button>}
        </>}
      </Campo>
      <div className="col">
        <span className="etiqueta">Productos y servicios</span>
        {items.length === 0 && <span className="tenue peq-txt">Agrega al menos uno.</span>}
        {items.map((it, i) => {
          const p = prod(it.product_id);
          return (
            <div key={i} className="linea-venta">
              <select className="input" value={it.product_id} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))} aria-label={`Producto del ítem ${i + 1}`}>{activos.map((p2) => <option key={p2.id} value={p2.id}>{p2.nombre} · {cop(p2.precio)}{p2.controla_stock ? ` · quedan ${p2.stock}` : ''}</option>)}</select>
              <label className="mini"><span>Cant.</span><input className="input" type="number" min={1} step={p?.tipo === 'SERVICIO' ? 1 : 'any'} value={it.cantidad} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, cantidad: Math.max(0.01, Number(e.target.value) || 1) } : x)))} aria-label={`Cantidad del ítem ${i + 1}`} /></label>
              <label className="mini"><span>Desc. %</span><input className="input" type="number" min={0} max={100} value={it.descuento_pct} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, descuento_pct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } : x)))} aria-label={`Descuento del ítem ${i + 1} en porcentaje`} /></label>
              <button className="btn sutil icono" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label={`Quitar ítem ${i + 1}`}><Icon n="x" className="" size={14} /></button>
              {p?.controla_stock && it.cantidad > p.stock && <span className="error peq-txt" role="alert">Solo quedan {p.stock} de {p.nombre}.</span>}
            </div>
          );
        })}
        <button className="btn peq" style={{ alignSelf: 'flex-start' }} disabled={!activos.length} onClick={() => setItems([...items, { product_id: activos[0].id, cantidad: 1, descuento_pct: 0 }])}><Icon n="mas" className="" size={14} />Agregar ítem</button>
      </div>
      {cobra ? (items.length > 0 && <CamposCobro metodos={metodos.data} total={total} valor={pago} onCambio={setPago} />)
        : <p className="tenue peq-txt">La venta queda por cobrar. Tu rol no registra pagos: quien cobra lo hace desde el detalle de la venta.</p>}
    </Modal>
  );
}

/** Pago de una venta que quedó por cobrar (el cliente pagó después, por ejemplo al recoger). */
function RegistrarPago({ venta, metodos, onCerrar, onHecho }: { venta: any; metodos: Metodos; onCerrar: () => void; onHecho: () => void }) {
  const [hecho, setHecho] = useState<any>(null);
  const inicial: PagoElegido['metodo'] = metodos.EFECTIVO ? 'EFECTIVO' : metodos.TRANSFERENCIA ? 'TRANSFERENCIA' : metodos.DATAFONO ? 'DATAFONO' : 'DESPUES';
  const [pago, setPago] = useState<PagoElegido>({ metodo: inicial, recibido: '', referencia: '' });
  const clave = useMemo(nuevaClave, []);
  const { run, ocupado, error } = useAccion();
  const errorPago = validarPago(pago, venta.total);
  const guardar = async () => {
    const cuerpo = cuerpoPago(pago, clave);
    if (!cuerpo) return;
    const r = await run(() => api.post(`/api/t/ventas/${venta.id}/pagos`, cuerpo), undefined, { silencioso: true });
    if (r) setHecho(r);
  };
  if (hecho) {
    return (
      <Modal titulo={`Venta #${venta.numero}`} className="modal-venta" onCerrar={onHecho}>
        <CobroExitoso titulo="Pago registrado" pago={hecho} total={venta.total}>
          <button className="btn primario" onClick={onHecho} autoFocus>Listo</button>
        </CobroExitoso>
      </Modal>
    );
  }
  return (
    <Modal titulo={`Registrar pago · venta #${venta.numero}`} className="modal-venta" onCerrar={onCerrar} pie={<><span className="tenue" style={{ marginRight: 'auto' }}>Total <b>{cop(venta.total)}</b></span><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || pago.metodo === 'DESPUES' || !!errorPago} onClick={guardar}>{ocupado ? 'Registrando…' : 'Registrar pago'}</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <CamposCobro metodos={metodos} total={venta.total} valor={pago} onCambio={setPago} permitirDespues={false} enfocar />
      {venta.enlaces?.some((l: any) => l.estado === 'ABIERTO') && <p className="tenue peq-txt">Al registrar el pago se cierra el enlace de pago abierto, para que no se cobre dos veces.</p>}
    </Modal>
  );
}

export function VentaDetalle() {
  const { id } = useParams();
  const { puede } = useSesion();
  const toast = useToast();
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/ventas/${id}`), [id], { cada: 5000 });
  const [anular, setAnular] = useState(false);
  const [cobrar, setCobrar] = useState(false);
  const [anularPago, setAnularPago] = useState<any>(null);
  const [enlace, setEnlace] = useState<string | null>(null);
  const { run, ocupado } = useAccion();
  if (error) return <><Cabecera titulo="Venta" /><div className="contenido"><ErrorCarga error={error} /><Link to="/ventas" className="btn" style={{ alignSelf: 'flex-start' }}><Icon n="atras" className="" size={16} />Volver a ventas</Link></div></>;
  if (!data) return <div className="tarjeta"><Cargando filas={8} /></div>;
  const factura = data.documentos.find((d: any) => d.tipo === 'FACTURA');
  const nota = data.documentos.find((d: any) => d.tipo === 'NOTA_CREDITO');
  const prueba = factura?.proveedor_fiscal === 'sandbox';
  const pagos: any[] = data.pagos ?? [];
  const vigente = pagos.find((p) => p.estado === 'REGISTRADO');
  const excedentes = pagos.filter((p) => p.estado === 'EXCEDENTE');
  const porCobrar = data.estado === 'CONFIRMADA' && data.estado_pago !== 'PAGADA';
  const pedirEnlace = async () => {
    const r = await run(() => api.post(`/api/t/ventas/${id}/enlace-pago`));
    if (r?.enlace) { setEnlace(r.enlace); recargar(); } else if (r?.error) toast(r.error, true); else if (r?.pagada) toast('Esta venta ya está pagada.');
  };
  return (
    <>
      <Cabecera titulo={`Venta #${data.numero}`} sub={<span className="fila envolver" style={{ gap: 8 }}>{fechaHora(data.creado_en)} · {data.cliente} <Estado v={data.origen} />{data.estado === 'ANULADA' && <Estado v="ANULADA" />}<Estado v={data.estado_pago === 'PAGADA' ? 'PAGADA' : data.estado === 'ANULADA' ? undefined : 'PENDIENTE'} texto={data.estado_pago === 'PAGADA' ? (vigente ? `Pagada · ${vigente.metodo_nombre.toLowerCase()}` : 'Pagada') : 'Por cobrar'} /></span>}>
        <Link to="/ventas" className="btn sutil"><Icon n="atras" className="" size={16} />Ventas</Link>
        {porCobrar && <Escritura permiso="payment:register" modulo="ventas"><button className="btn primario" onClick={() => setCobrar(true)}><Icon n="efectivo" className="" size={16} />Registrar pago</button></Escritura>}
        {porCobrar && <Escritura permiso="payment:link" modulo="ventas"><button className="btn" disabled={ocupado} onClick={pedirEnlace}>Enlace de pago</button></Escritura>}
        {data.estado === 'CONFIRMADA' && <Escritura permiso="order:void" modulo="ventas"><button className="btn peligro" onClick={() => setAnular(true)}>Anular</button></Escritura>}
      </Cabecera>
      <div className="contenido">
        {excedentes.length > 0 && (
          <div className="aviso error" role="alert">
            <Icon n="alerta" className="" size={16} />
            <span className="col" style={{ gap: 4 }}><b>La pasarela confirmó {excedentes.length === 1 ? 'un pago' : `${excedentes.length} pagos`} de más por {cop(excedentes.reduce((a, p) => a + p.monto, 0))}.</b>
              <span>Esta venta ya estaba pagada o anulada cuando llegó. Omnegia no lo suma a la venta: devuélvele el dinero al cliente desde tu cuenta de Wompi.</span></span>
          </div>
        )}
        {enlace && (
          <div className="aviso exito" role="status">
            <Icon n="ok" className="" size={16} />
            <span className="col" style={{ gap: 4, minWidth: 0 }}><b>Enlace de pago listo. Vence en 24 horas.</b><span className="mono cortar">{enlace}</span></span>
            <span className="fila envolver" style={{ gap: 6 }}>
              <button className="btn peq" onClick={() => navigator.clipboard?.writeText(enlace).then(() => toast('Enlace copiado'))}>Copiar</button>
              <a className="btn peq" href={enlace} target="_blank" rel="noreferrer">Abrir</a>
            </span>
          </div>
        )}
        {factura?.estado === 'RECHAZADO' && (
          <section className="decision" aria-label="Factura rechazada">
            <div className="cab"><Estado v="RECHAZADO" texto="Factura rechazada" /><span className="mono" style={{ marginLeft: 'auto' }}>{factura.numero}</span></div>
            <div className="cuerpo col" style={{ gap: 12 }}>
              <b style={{ overflowWrap: 'anywhere' }}>{factura.motivo_rechazo}</b>
              <span className="sec">La venta sigue siendo válida. Corrige el dato del cliente y vuelve a enviar la factura; el reintento queda en la traza.</span>
              <ol className="pasos-recuperar">
                <li><Link className="btn" to={`/clientes?id=${data.customer_id}`}>1 · Corregir datos del cliente</Link></li>
                {puede('invoice:issue') && <li><Escritura permiso="invoice:issue" modulo="facturacion"><button className="btn primario" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/facturacion/${factura.id}/reintentar`), 'Factura enviada de nuevo').then(recargar)}>2 · Volver a enviar</button></Escritura></li>}
              </ol>
            </div>
          </section>
        )}
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <div className="col" style={{ gap: 16 }}>
            <Tarjeta titulo="Detalle" sinCuerpo>
              <div className="tabla-wrap"><table className="tabla">
                <thead><tr><th>Descripción</th><th className="num">Cant.</th><th className="num">Valor unit.</th><th className="num">Desc.</th><th className="num">IVA</th><th className="num">Total</th></tr></thead>
                <tbody>{data.items.map((i: any, k: number) => <tr key={k}><td className="envuelve">{i.descripcion}</td><td className="num">{i.cantidad}</td><td className="num">{cop(i.precio_unit)}</td><td className="num">{i.descuento_pct ? `${i.descuento_pct}%` : '—'}</td><td className="num">{i.iva_pct}%</td><td className="num">{cop(i.total)}</td></tr>)}
                  {data.descuento > 0 && <tr className="total"><td colSpan={5} className="num tenue">Descuentos aplicados</td><td className="num">−{cop(data.descuento)}</td></tr>}
                  <tr className="total"><td colSpan={5} className="num tenue">Base</td><td className="num">{cop(data.subtotal)}</td></tr>
                  <tr className="total"><td colSpan={5} className="num tenue">IVA</td><td className="num">{cop(data.impuestos)}</td></tr>
                  <tr className="total"><td colSpan={5} className="num"><b>Total</b></td><td className="num"><b>{cop(data.total)}</b></td></tr></tbody></table></div>
            </Tarjeta>
            {data.recibos.length > 0 && <Tarjeta titulo="Origen: acción de la IA" acciones={data.conversation_id && <Link to={`/conversaciones/${data.conversation_id}`} className="btn sutil peq">Ver conversación</Link>}><div className="col">{data.recibos.map((r: any) => <Recibo key={r.id} e={r} />)}</div></Tarjeta>}
            <Tarjeta titulo="Historial" sinCuerpo>
              {data.traza.length === 0 ? <Vacio titulo="Sin eventos registrados" /> : (
                <ol className="traza">{data.traza.map((t: any) => <li key={t.id}><span className="mono tenue">{hora(t.creado_en)}</span><span>{TRAZA[t.accion] ?? t.accion.replace(/[._]/g, ' ')}</span><Estado v={t.resultado} /><span className="tenue peq-txt">{t.actor_nombre}</span></li>)}</ol>
              )}
            </Tarjeta>
          </div>
          <div className="col" style={{ gap: 16 }}>
            <Tarjeta titulo="Factura electrónica" nivel={factura?.estado === 'RECHAZADO' ? 3 : 2}>
              {!factura ? (
                <div className="col"><span className="tenue">Esta venta no tiene factura.</span>{data.estado === 'CONFIRMADA' && <Escritura permiso="invoice:issue" modulo="facturacion"><button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={() => run(() => api.post(`/api/t/ventas/${id}/facturar`), 'Factura solicitada').then(recargar)}>Emitir factura</button></Escritura>}</div>
              ) : (
                <div className="col" style={{ gap: 14 }}>
                  {prueba && <span className="estado warn" style={{ alignSelf: 'flex-start' }}><Icon n="alerta" className="" />Documento de prueba: sin validez fiscal</span>}
                  <CicloFiscal estado={factura.estado} />
                  <dl className="datos-def">
                    <dt>Número</dt><dd className="fila entre envolver"><span className="mono">{factura.numero}</span><Estado v={factura.estado} /></dd>
                    {factura.cufe && <><dt>{prueba ? 'Código' : 'CUFE'}</dt><dd><code className="cufe">{factura.cufe}</code></dd></>}
                    {!['VALIDADO', 'ENTREGADO'].includes(factura.estado) ? <><dt>Envío</dt><dd className="tenue">Se envía al cliente cuando quede validada.</dd></> : <>
                    <dt>WhatsApp</dt><dd><Estado v={factura.entrega_whatsapp === 'ENVIADO' ? 'ENTREGADO' : factura.entrega_whatsapp} texto={ENTREGA_DOC[factura.entrega_whatsapp] ?? factura.entrega_whatsapp.toLowerCase()} /></dd>
                    <dt>Correo</dt><dd><Estado v={factura.entrega_email === 'ENVIADO' ? 'ENTREGADO' : factura.entrega_email} texto={factura.entrega_email === 'NO_APLICA' ? 'sin correo' : ENTREGA_DOC[factura.entrega_email] ?? factura.entrega_email.toLowerCase()} /></dd></>}
                  </dl>
                  <a className="btn peq" style={{ alignSelf: 'flex-start' }} href={`/api/publico/documentos/${factura.token_publico}`} target="_blank" rel="noreferrer">Ver documento</a>
                </div>
              )}
            </Tarjeta>
            <Tarjeta titulo="Pagos" acciones={porCobrar && <Escritura permiso="payment:register" modulo="ventas"><button className="btn peq" onClick={() => setCobrar(true)}>Registrar pago</button></Escritura>}>
              {pagos.length === 0 ? <span className="tenue">{data.estado === 'ANULADA' ? 'La venta se anuló sin pagos registrados.' : 'Todavía no hay pagos. La venta está por cobrar.'}</span> : (
                <ul className="lista-pagos">
                  {pagos.map((p) => (
                    <li key={p.id} className={`pago ${p.estado !== 'REGISTRADO' ? 'inactivo' : ''}`}>
                      <span className="fila entre envolver" style={{ gap: 8 }}><b>{p.metodo_nombre}</b><Estado v={p.estado} /></span>
                      <span className="fila entre envolver" style={{ gap: 8 }}><span className="num"><b>{cop(p.monto)}</b>{p.metodo === 'EFECTIVO' && p.recibido != null && <span className="tenue peq-txt"> · recibido {cop(p.recibido)} · cambio {cop(p.cambio)}</span>}</span><span className="tenue peq-txt">{fechaHora(p.creado_en)}</span></span>
                      {p.referencia && <span className="mono peq-txt cortar">Ref. {p.referencia}</span>}
                      <span className="tenue peq-txt">{p.origen === 'PASARELA' ? 'Confirmado por la pasarela' : `Registró ${p.registrado_por ?? 'el equipo'}`}</span>
                      {p.estado === 'ANULADO' && <span className="peq-txt">Anulado por {p.anulado_por ?? 'el equipo'} el {fechaHora(p.anulado_en)}: {p.motivo_anulacion}</span>}
                      {p.estado === 'REGISTRADO' && p.metodo !== 'PASARELA' && data.estado === 'CONFIRMADA' && <Escritura permiso="payment:void" modulo="ventas"><button className="btn peq sutil" style={{ alignSelf: 'flex-start' }} onClick={() => setAnularPago(p)}>Anular este pago</button></Escritura>}
                    </li>
                  ))}
                </ul>
              )}
            </Tarjeta>
            {nota && <Tarjeta titulo="Nota crédito"><div className="fila entre"><span className="mono">{nota.numero}</span><Estado v={nota.estado} /></div></Tarjeta>}
            {data.enlaces.length > 0 && <Tarjeta titulo="Enlaces de cobro"><div className="lista">{data.enlaces.map((l: any) => <div key={l.id} className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span className="col" style={{ gap: 2, minWidth: 0 }}><span className="mono cortar">{l.referencia}</span>{l.ultimo_estado_proveedor && l.estado === 'ABIERTO' && <span className="tenue peq-txt">Último intento: {l.ultimo_estado_proveedor.toLowerCase()}</span>}</span><Estado v={l.estado} /></div>)}</div><p className="tenue peq-txt" style={{ marginTop: 8 }}>El dinero va directo a la cuenta de pagos del negocio. La venta se marca pagada solo cuando la pasarela lo confirma.</p></Tarjeta>}
          </div>
        </div>
      </div>
      {anular && <Confirmar titulo={`Anular venta #${data.numero}`} riesgo="critica" pedirMotivo textoBoton="Anular venta"
        efecto={<>{factura && ['VALIDADO', 'ENTREGADO'].includes(factura.estado) ? <>La factura <b className="mono">{factura.numero}</b> ya fue validada: <b>no se borra</b>, se emitirá una <b>nota crédito</b> por {cop(data.total)}.</> : 'La venta quedará anulada.'} Las existencias vuelven al inventario.{data.estado_pago === 'PAGADA' && <> <b>Esta venta ya está pagada{vigente ? ` (${vigente.metodo_nombre.toLowerCase()})` : ''}:</b> el pago queda anulado en el historial y la devolución del dinero se hace por fuera de la plataforma.</>}</>}
        onCerrar={() => setAnular(false)} onConfirmar={async (motivo) => { setAnular(false); await run(() => api.post(`/api/t/ventas/${id}/anular`, { motivo }), 'Venta anulada'); recargar(); }} />}
      {cobrar && data.metodos_pago && <RegistrarPago venta={data} metodos={data.metodos_pago} onCerrar={() => setCobrar(false)} onHecho={() => { setCobrar(false); recargar(); }} />}
      {anularPago && <Confirmar titulo="Anular pago" riesgo="confirmable" pedirMotivo textoBoton="Anular pago"
        efecto={<>El pago en <b>{anularPago.metodo_nombre.toLowerCase()}</b> por <b>{cop(anularPago.monto)}</b> queda anulado en el historial (no se borra) y la venta vuelve a estar <b>por cobrar</b>. Úsalo si se registró por error; si devolviste el dinero, anula la venta.</>}
        onCerrar={() => setAnularPago(null)} onConfirmar={async (motivo) => { const p = anularPago; setAnularPago(null); await run(() => api.post(`/api/t/ventas/${id}/pagos/${p.id}/anular`, { motivo }), 'Pago anulado. La venta quedó por cobrar.'); recargar(); }} />}
    </>
  );
}

const ENTREGA_DOC: Record<string, string> = { NO_APLICA: 'sin teléfono', PENDIENTE: 'enviando…', ENVIADO: 'enviada', SIMULADO: 'simulada (demostración)', FALLIDO: 'no se pudo entregar', ENTREGADO: 'entregada' };

const TRAZA: Record<string, string> = {
  'venta.registrar': 'Venta registrada', 'venta.anular': 'Venta anulada', 'factura.solicitar': 'Factura solicitada', 'factura.validada': 'Factura validada',
  'factura.rechazada': 'Factura rechazada', 'factura.reintentar': 'Factura enviada de nuevo', 'documento.entregar': 'Factura enviada al cliente',
  'nota_credito.solicitar': 'Nota crédito solicitada', 'nota_credito.validada': 'Nota crédito validada', 'cobro.enlace': 'Enlace de pago generado',
  'cobro.conciliado': 'Pago confirmado por la pasarela', 'cobro.intento': 'Intento de pago', 'cobro.monto_no_coincide': 'Pago con monto distinto (no aplicado)',
  'pago.registrar': 'Pago registrado', 'pago.anular': 'Pago anulado', 'cobro.pago_excedente': 'Pago recibido de más (por devolver)',
};

// =================================================================== Catálogo e inventario
export function Inventario() {
  const { puede } = useSesion();
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const movs = useApi<any[]>(() => (puede('inventory:read') ? api.get('/api/t/inventario/movimientos') : Promise.resolve([])), []);
  const revision = useApi<any>(() => api.get('/api/t/productos/revision'), []);
  const [verRevision, setVerRevision] = useState(false);
  const [editar, setEditar] = useState<any>(null);
  const [mov, setMov] = useState<any>(null);
  const [importar, setImportar] = useState(false);
  const [q, setQ] = useState('');
  const { run, ocupado, error } = useAccion();
  const bajos = (productos.data ?? []).filter((p) => p.controla_stock && p.activo && p.stock <= p.stock_minimo);
  const lista = (productos.data ?? []).filter((p) => !q || p.nombre.toLowerCase().includes(q.toLowerCase()) || (p.categoria ?? '').toLowerCase().includes(q.toLowerCase()));
  const guardarProducto = async () => {
    const body: any = { ...editar, precio: Number(editar.precio), iva_pct: Number(editar.iva_pct ?? 0), duracion_min: editar.tipo === 'SERVICIO' ? Number(editar.duracion_min || 30) : null, stock_minimo: Number(editar.stock_minimo ?? 0), stock: Number(editar.stock ?? 0), categoria: editar.categoria || null, sku: editar.sku || null };
    delete body.id; delete body.moneda;
    if (editar.id) delete body.stock;
    const r = await run(() => (editar.id ? api.patch(`/api/t/productos/${editar.id}`, body) : api.post('/api/t/productos', body)), 'Catálogo actualizado', { silencioso: true });
    if (r) { setEditar(null); productos.recargar(); revision.recargar(); }
  };
  const porRevisar: any[] = revision.data?.items ?? [];
  const problemas = new Map<string, any[]>(porRevisar.map((i) => [i.id, i.problemas]));
  const criticos = porRevisar.filter((i) => i.problemas.some((p: any) => p.codigo !== 'sin_categoria'));
  const soloCategoria = porRevisar.length - criticos.length;
  const nombreSinLetras = !!editar?.nombre?.trim() && !/\p{L}/u.test(editar.nombre);
  return (
    <>
      <Cabecera titulo="Catálogo e inventario" sub="Organiza tus productos y servicios. Revisa precios y existencias. Los precios incluyen IVA.">
        <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Buscar producto o categoría" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar en el catálogo" /></label>
        <Escritura permiso="catalog:write"><button className="btn" onClick={() => setImportar(true)}><Icon n="subir" className="" size={16} />Importar</button></Escritura>
        <Escritura permiso="catalog:write"><button className="btn primario" onClick={() => setEditar({ tipo: 'PRODUCTO', nombre: '', precio: '', iva_pct: 19, controla_stock: true, stock: 0, stock_minimo: 0, activo: true })}><Icon n="mas" className="" size={16} />Nuevo ítem</button></Escritura>
      </Cabecera>
      <div className="contenido">
        {bajos.length > 0 && <Tarjeta nivel={3} titulo={<span className="fila"><Icon n="alerta" className="" size={16} /> {bajos.length === 1 ? '1 producto está' : `${bajos.length} productos están`} en o por debajo del mínimo</span>}><div className="fila envolver" style={{ gap: 6 }}>{bajos.map((p) => <span key={p.id} className="chip">{p.nombre}: <b>{p.stock}</b> / mín. {p.stock_minimo}</span>)}</div></Tarjeta>}
        {porRevisar.length > 0 && (
          <Tarjeta nivel={criticos.length ? 3 : 2} titulo={<span className="fila"><Icon n={criticos.length ? 'alerta' : 'info'} className="" size={16} /> {criticos.length ? `${criticos.length === 1 ? '1 ítem tiene' : `${criticos.length} ítems tienen`} datos por revisar` : `${soloCategoria === 1 ? '1 ítem no tiene' : `${soloCategoria} ítems no tienen`} categoría`}</span>}
            acciones={<button className="btn peq sutil" aria-expanded={verRevision} onClick={() => setVerRevision(!verRevision)}>{verRevision ? 'Ocultar' : 'Ver cuáles'}</button>}>
            <p className="tenue peq-txt" style={{ margin: 0 }}>Nada se borra ni se cambia solo: revisa cada ítem y corrígelo, o desactívalo si era una prueba. {criticos.length > 0 && soloCategoria > 0 && `Además, ${soloCategoria} sin categoría.`}</p>
            <div className={`plegable ${verRevision ? 'abierto' : ''}`} inert={!verRevision}><div>
              <ul className="lista entra-escalonado" style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
                {porRevisar.map((i, k) => {
                  const p = productos.data?.find((x) => x.id === i.id);
                  return (
                    <li key={i.id} className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto', ...escalon(k) }}>
                      <span className="col" style={{ gap: 2, minWidth: 0 }}>
                        <span><b>«{i.nombre}»</b> <span className="tenue">· {i.tipo === 'SERVICIO' ? 'Servicio' : 'Producto'} · {cop(i.precio)}{!i.activo && ' · inactivo'}</span></span>
                        <span className="peq-txt sec">{i.problemas.map((x: any) => x.texto).join(' ')}</span>
                      </span>
                      {p && puede('catalog:write') && <button className="btn peq" onClick={() => setEditar(p)} aria-label={`Corregir ${i.nombre}`}>Corregir</button>}
                    </li>
                  );
                })}
              </ul>
            </div></div>
          </Tarjeta>
        )}
        {productos.error && <ErrorCarga error={productos.error} reintentar={productos.recargar} />}
        <section className="tarjeta" hidden={!!productos.error}>
          {!productos.data ? <Cargando /> : productos.data.length === 0 ? <Vacio titulo="Tu catálogo está vacío" accion={<Escritura permiso="catalog:write"><button className="btn" onClick={() => setImportar(true)}>Importar desde una hoja de cálculo</button></Escritura>}>Agrega productos y servicios para venderlos y para que el agente pueda consultarlos.</Vacio> : lista.length === 0 ? <Vacio titulo="Nada coincide con la búsqueda" /> : (
            <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Nombre</th><th>Tipo</th><th>Categoría</th><th className="num">Precio</th><th className="num">IVA</th><th className="num">Existencias</th><th>Estado</th><th><span className="sr">Acciones</span></th></tr></thead>
              <tbody>{lista.map((p) => {
                const bajo = p.controla_stock && p.stock <= p.stock_minimo;
                return (
                <tr key={p.id}>
                  <td data-etiqueta="Nombre" className="principal"><b style={{ fontWeight: 600 }}>{p.nombre}</b>{p.duracion_min && <span className="tenue"> · {p.duracion_min} min</span>}{problemas.get(p.id)?.some((x: any) => x.codigo !== 'sin_categoria') && <> <span className="estado warn" title={problemas.get(p.id)!.map((x: any) => x.texto).join(' ')}><Icon n="alerta" className="" />Revisar</span></>}</td>
                  <td data-etiqueta="Tipo">{p.tipo === 'SERVICIO' ? 'Servicio' : 'Producto'}</td><td data-etiqueta="Categoría">{p.categoria ?? <span className="tenue">—</span>}</td>
                  <td data-etiqueta="Precio" className="num">{cop(p.precio)}</td><td data-etiqueta="IVA" className="num">{p.iva_pct}%</td>
                  <td data-etiqueta="Existencias" className="num">{p.controla_stock ? (bajo ? <span className="estado warn"><Icon n="alerta" className="" />{p.stock}<span className="sr"> (bajo mínimo)</span></span> : p.stock) : <span className="tenue">—</span>}</td>
                  <td data-etiqueta="Estado">{p.activo ? <Estado v="ACTIVA" texto="Activo" /> : <Estado v="CANCELADA" texto="Inactivo" />}</td>
                  <td data-etiqueta="Acciones"><div className="acciones-fila">{puede('catalog:write') && <button className="btn peq" onClick={() => setEditar(p)} aria-label={`Editar ${p.nombre}`}>Editar</button>}{p.controla_stock && puede('inventory:write') && <button className="btn peq" onClick={() => setMov({ product_id: p.id, nombre: p.nombre, tipo: 'ENTRADA', cantidad: 1, motivo: '', actual: p.stock })} aria-label={`Registrar movimiento de ${p.nombre}`}>Movimiento</button>}</div></td>
                </tr>
              ); })}</tbody></table></div>
          )}
        </section>
        {puede('inventory:read') && (
          <Tarjeta titulo="Movimientos recientes" sinCuerpo>
            {movs.error ? <div className="cuerpo"><ErrorCarga error={movs.error} reintentar={movs.recargar} /></div> : !movs.data ? <Cargando /> : !movs.data.length ? <Vacio titulo="Sin movimientos">Las entradas, salidas y ajustes de existencias aparecerán aquí.</Vacio> : (
              <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th className="num">Cantidad</th><th>Motivo</th><th>Quién</th></tr></thead>
                <tbody>{movs.data.slice(0, 30).map((m) => <tr key={m.id}><td data-etiqueta="Fecha">{fechaHora(m.creado_en)}</td><td data-etiqueta="Producto" className="principal">{m.producto}</td><td data-etiqueta="Tipo">{{ ENTRADA: 'Entrada', SALIDA: 'Salida', AJUSTE: 'Ajuste' }[m.tipo as string] ?? m.tipo}</td><td data-etiqueta="Cantidad" className="num">{m.cantidad > 0 && m.tipo === 'AJUSTE' ? '+' : ''}{m.cantidad}</td><td data-etiqueta="Motivo" className="envuelve">{m.motivo}</td><td data-etiqueta="Quién" className="tenue">{String(m.actor).replace(/^\w+:/, '')}</td></tr>)}</tbody></table></div>
            )}
          </Tarjeta>
        )}
      </div>
      {editar && (
        <Modal titulo={editar.id ? `Editar ${editar.nombre}` : 'Nuevo ítem'} onCerrar={() => setEditar(null)} pie={<><button className="btn" onClick={() => setEditar(null)}>Cancelar</button><button className="btn primario" disabled={ocupado || !editar.nombre?.trim() || nombreSinLetras || editar.precio === ''} onClick={guardarProducto}>Guardar</button></>}>
          {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
          {editar.id && problemas.get(editar.id) && <div className="aviso peq-txt"><Icon n="info" className="" size={14} /><span>{problemas.get(editar.id)!.map((x: any) => x.texto).join(' ')}</span></div>}
          <div className="grid g2">
            <Campo etiqueta="Tipo"><select className="input" value={editar.tipo} disabled={!!editar.id} onChange={(e) => setEditar({ ...editar, tipo: e.target.value, controla_stock: e.target.value === 'PRODUCTO' })}><option value="SERVICIO">Servicio</option><option value="PRODUCTO">Producto</option></select></Campo>
            <Campo etiqueta="Nombre" error={nombreSinLetras ? 'El nombre debe tener al menos una letra (por ejemplo «Corte clásico»).' : undefined}><input className="input" value={editar.nombre} maxLength={120} onChange={(e) => setEditar({ ...editar, nombre: e.target.value })} aria-invalid={nombreSinLetras} /></Campo>
            <Campo etiqueta="Precio (IVA incluido)"><input className="input" inputMode="decimal" value={editar.precio} onChange={(e) => setEditar({ ...editar, precio: e.target.value.replace(/[^\d.]/g, '') })} /></Campo>
            <Campo etiqueta="IVA"><select className="input" value={editar.iva_pct} onChange={(e) => setEditar({ ...editar, iva_pct: Number(e.target.value) })}><option value={0}>0 %</option><option value={5}>5 %</option><option value={19}>19 %</option></select></Campo>
            <Campo etiqueta="Categoría"><input className="input" value={editar.categoria ?? ''} maxLength={60} onChange={(e) => setEditar({ ...editar, categoria: e.target.value })} /></Campo>
            {editar.tipo === 'SERVICIO' ? <Campo etiqueta="Duración (min)"><input className="input" type="number" min={5} max={600} value={editar.duracion_min ?? 30} onChange={(e) => setEditar({ ...editar, duracion_min: e.target.value })} /></Campo>
              : <Campo etiqueta="Mínimo de existencias" ayuda="avisa al llegar a este número"><input className="input" type="number" min={0} value={editar.stock_minimo ?? 0} onChange={(e) => setEditar({ ...editar, stock_minimo: e.target.value })} /></Campo>}
            {!editar.id && editar.tipo === 'PRODUCTO' && <Campo etiqueta="Existencias iniciales"><input className="input" type="number" min={0} value={editar.stock ?? 0} onChange={(e) => setEditar({ ...editar, stock: e.target.value })} /></Campo>}
          </div>
          {editar.id && <label className="fila"><input type="checkbox" checked={editar.activo} onChange={(e) => setEditar({ ...editar, activo: e.target.checked })} /> Activo (visible para el agente y en ventas)</label>}
          {editar.id && <span className="tenue peq-txt">Los cambios de precio quedan en auditoría con el valor anterior. Para corregir existencias usa «Movimiento».</span>}
        </Modal>
      )}
      {mov && (
        <Modal titulo={`Movimiento · ${mov.nombre}`} onCerrar={() => setMov(null)} pie={<><button className="btn" onClick={() => setMov(null)}>Cancelar</button><button className="btn primario" disabled={ocupado || mov.motivo.trim().length < 3 || mov.cantidad === ''} onClick={async () => { const r = await run(() => api.post('/api/t/inventario/movimientos', { product_id: mov.product_id, tipo: mov.tipo, cantidad: Number(mov.cantidad), motivo: mov.motivo }), 'Movimiento registrado'); if (r) { setMov(null); productos.recargar(); movs.recargar(); } }}>Registrar</button></>}>
          <span className="tenue">Existencias actuales: <b>{mov.actual}</b></span>
          <div className="grid g2">
            <Campo etiqueta="Tipo"><select className="input" value={mov.tipo} onChange={(e) => setMov({ ...mov, tipo: e.target.value })}><option value="ENTRADA">Entrada (compra, devolución)</option><option value="SALIDA">Salida (daño, uso interno)</option><option value="AJUSTE">Ajuste por conteo físico</option></select></Campo>
            <Campo etiqueta={mov.tipo === 'AJUSTE' ? 'Existencia contada' : 'Cantidad'}><input className="input" type="number" min={0} value={mov.cantidad} onChange={(e) => setMov({ ...mov, cantidad: e.target.value })} /></Campo>
          </div>
          <Campo etiqueta="Motivo"><input className="input" value={mov.motivo} maxLength={200} onChange={(e) => setMov({ ...mov, motivo: e.target.value })} placeholder="Compra a proveedor, producto dañado…" /></Campo>
          {mov.tipo === 'SALIDA' && Number(mov.cantidad) > mov.actual && <span className="error peq-txt" role="alert">No puedes sacar más de lo que hay ({mov.actual}).</span>}
        </Modal>
      )}
      {importar && <ImportarCatalogo onCerrar={() => setImportar(false)} onHecho={() => { setImportar(false); productos.recargar(); }} />}
    </>
  );
}

const CAMPOS_MAPEO: [string, string][] = [['nombre', 'Nombre'], ['precio', 'Precio'], ['categoria', 'Categoría'], ['tipo', 'Tipo'], ['duracion_min', 'Duración (min)'], ['stock', 'Existencias'], ['iva_pct', 'IVA %'], ['sku', 'Código'], ['ignorar', 'No importar']];

/** Importación desde hoja de cálculo: vista previa, duplicados visibles y confirmación de todo o nada. */
function ImportarCatalogo({ onCerrar, onHecho }: { onCerrar: () => void; onHecho: () => void }) {
  const [prev, setPrev] = useState<any>(null);
  const [filas, setFilas] = useState<any[]>([]);
  const [duplicados, setDuplicados] = useState('');
  const [resumen,setResumen]=useState<any>(null);
  const [file,setFile]=useState<File|null>(null);
  const { run, ocupado, error } = useAccion();
  const subir = async (f: File, hoja?:string) => {
    setFile(f);setResumen(null);
    const r = await run(() => api.upload(`/api/t/productos/importar/archivo${hoja?`?hoja=${encodeURIComponent(hoja)}`:''}`, f), undefined, { silencioso: true });
    if (r) { setPrev(r); setFilas(r.filas.map((x: any) => ({ ...x, incluir: x.estado === 'OK' }))); }
  };
  const cambiarMapeo = async (col: string, campo: string) => {
    const mapeo = prev.mapeo.map((m: any) => (m.columna === col ? { ...m, campo, confianza: 1 } : m.campo === campo && campo !== 'ignorar' ? { ...m, campo: 'ignorar' } : m));
    const r = await run(() => api.post('/api/t/productos/importar/vista-previa', { datos: prev.datos, mapeo }), undefined, { silencioso: true });
    if (r) { setPrev({ ...prev, mapeo, error: null }); setFilas(r.filas.map((x: any) => ({ ...x, incluir: x.estado === 'OK' }))); }
  };
  const elegidas = filas.filter((f) => f.incluir && f.nombre && f.precio !== null);
  const repetidas = elegidas.filter((f) => f.existente).length;
  const confirmar = async () => {
    const r = await run(() => api.post('/api/t/productos/importar/confirmar', { archivo: prev.archivo, duplicados: duplicados || 'omitir', filas: filas.map((f) => ({ fila:f.fila, incluir:f.incluir, tipo: f.tipo, nombre: f.nombre, categoria: f.categoria, precio: f.precio, iva_pct: f.iva_pct ?? 0, duracion_min: f.duracion_min, stock: f.stock, sku: f.sku })) }), undefined, { silencioso: true });
    if (r) { setResumen(r); }
  };
  if(resumen)return <Modal titulo="Resultado de la importación" onCerrar={onHecho}><ImportSummary resumen={resumen} onContinue={onHecho}/></Modal>;
  return (
    <Modal titulo="Importar catálogo" onCerrar={onCerrar} pie={prev ? <><span className="tenue" style={{ marginRight: 'auto' }}>{elegidas.length} filas seleccionadas</span><button className="btn" onClick={() => { setPrev(null); setFilas([]); }}>Otro archivo</button><button className="btn primario" disabled={ocupado || !elegidas.length || (repetidas > 0 && !duplicados)} onClick={confirmar}>Importar {elegidas.length}</button></> : <button className="btn" onClick={onCerrar}>Cancelar</button>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message} Nada se guardó.</div>}
      {!prev ? (
        <div className="col" style={{ gap: 12 }} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!ocupado&&e.dataTransfer.files[0])subir(e.dataTransfer.files[0]);}}>
          <p className="sec">Sube un archivo .xlsx o .csv con tus productos y servicios. Detectamos las columnas; tú revisas antes de guardar.</p>
          <label className="btn primario" style={{ alignSelf: 'flex-start' }}><Icon n="subir" className="" size={16} />{ocupado ? 'Leyendo…' : 'Elegir archivo'}<input type="file" accept=".xlsx,.csv" className="sr" onChange={(e) => e.target.files?.[0] && subir(e.target.files[0])} /></label>
          <a className="peq-txt" href="/api/onboarding/plantilla-catalogo.xlsx">Descargar una plantilla de ejemplo</a>
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <span className="tenue peq-txt">{prev.archivo} · encabezado en la fila {prev.fila_encabezado} · {prev.total} filas</span>
          <Campo etiqueta="Hoja a importar"><select className="input" value={prev.hoja} disabled={ocupado} onChange={e=>file&&subir(file,e.target.value)}>{(prev.hojas??[prev.hoja]).map((h:string)=><option key={h}>{h}</option>)}</select></Campo><div className="fila envolver" style={{ gap: 8 }}>{prev.mapeo.map((m: any) => (
            <label key={m.columna} className="campo" style={{ minWidth: 140, flex: '1 1 140px' }}><span className="cortar">«{m.columna}»</span>
              <select className="input" value={m.campo} disabled={ocupado} onChange={(e) => cambiarMapeo(m.columna, e.target.value)}>{CAMPOS_MAPEO.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          ))}</div>
          {prev.error && <div className="bloqueado">{prev.error}</div>}
          {/* Solo se pide decidir cuando hay duplicados reales. */}
          {repetidas > 0 && (
            <fieldset className="opciones-dup"><legend>{repetidas === 1 ? '1 ya existe' : `${repetidas} ya existen`} en tu catálogo (mismo nombre). ¿Qué hacemos con {repetidas === 1 ? 'él' : 'ellos'}?</legend>
              <label className="fila"><input type="radio" name="dup" checked={duplicados === 'omitir'} onChange={() => setDuplicados('omitir')} />Dejarlos como están</label>
              <label className="fila"><input type="radio" name="dup" checked={duplicados === 'actualizar'} onChange={() => setDuplicados('actualizar')} />Actualizar su precio y datos</label>
            </fieldset>
          )}
          <div className="tabla-wrap" style={{ maxHeight: 320 }}><table className="tabla">
            <thead><tr><th><span className="sr">Incluir</span></th><th>Fila</th><th>Nombre</th><th>Tipo</th><th className="num">Precio</th><th>Revisión</th></tr></thead>
            <tbody>{filas.map((f, i) => (
              <tr key={i}>
                <td><input type="checkbox" checked={f.incluir} disabled={f.precio === null || !f.nombre} onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, incluir: e.target.checked } : x)))} aria-label={`Incluir fila ${f.fila}`} /></td>
                <td className="mono tenue">{f.fila}</td><td className="envuelve">{f.nombre || <span className="tenue">—</span>}</td>
                <td><select className="input" value={f.tipo} onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, tipo: e.target.value } : x)))} aria-label={`Tipo de la fila ${f.fila}`}><option value="SERVICIO">Servicio</option><option value="PRODUCTO">Producto</option></select></td>
                <td className="num">{f.precio === null ? <span className="tenue">—</span> : cop(f.precio)}</td>
                <td>{f.problemas?.length ? <span className="estado warn" title={f.problemas.join(' · ')}><Icon n="alerta" className="" />{f.problemas[0]}</span> : f.existente ? <Estado v="PENDIENTE" texto="Ya existe" /> : <Estado v="EXITO" texto="Nuevo" />}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <span className="tenue peq-txt">Las filas con precio ilegible no se importan: corrígelas en el archivo y vuelve a subirlo. La importación es todo o nada: si una fila falla, no se guarda ninguna.</span>
        </div>
      )}
    </Modal>
  );
}

// =================================================================== Agenda
export function Agenda() {
  const { puede, s } = useSesion();
  const [dia, setDia] = useState(hoyLocal());
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/agenda?fecha=${dia}`), [dia], { cada: 20000 });
  const [nueva, setNueva] = useState(false);
  const [sel, setSel] = useState<any>(null);
  const [reprogramar, setReprogramar] = useState<any>(null);
  const [recursoMovil, setRecursoMovil] = useState<string>('todos');
  const [vista, setVista] = useState<'rejilla' | 'lista'>(() => (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 760px)').matches ? 'lista' : 'rejilla'));
  const { run } = useAccion();
  const mover = (n: number) => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); setDia(d.toISOString().slice(0, 10)); };
  const horas = useMemo(() => {
    const ini = data ? Number(data.abre.slice(0, 2)) : 7;
    const finH = data ? Number(data.cierra.slice(0, 2)) : 20;
    return Array.from({ length: Math.max(1, finH - ini) }, (_, i) => ini + i);
  }, [data?.abre, data?.cierra]);
  const PX = 72;
  const recursos = (data?.recursos ?? []).filter((r: any) => recursoMovil === 'todos' || r.id === recursoMovil);
  const citasVisibles = (data?.citas ?? []).filter((c: any) => recursoMovil === 'todos' || c.resource_id === recursoMovil);
  const cambiarEstado = (estado: string, ok: string) => run(() => api.patch(`/api/t/agenda/citas/${sel.id}`, { estado }), ok).then((r) => { if (r) { setSel(null); recargar(); } });
  return (
    <>
      <Cabecera titulo="Agenda" sub={<span><span className="capital">{fechaLarga(dia)}</span>{zona() !== 'America/Bogota' && <span className="tenue"> · hora de {zona()}</span>}</span>}>
        <div className="fila" style={{ gap: 4 }} role="group" aria-label="Cambiar de día">
          <button className="btn icono" onClick={() => mover(-1)} aria-label="Día anterior"><Icon n="atras" className="" size={16} /></button>
          <button className="btn" onClick={() => setDia(hoyLocal())} disabled={dia === hoyLocal()}>Hoy</button>
          <input className="input selector-fecha" type="date" value={dia} onChange={(e) => e.target.value && setDia(e.target.value)} aria-label="Ir a una fecha" />
          <button className="btn icono" onClick={() => mover(1)} aria-label="Día siguiente"><Icon n="derecha" className="" size={16} /></button>
        </div>
        <Escritura permiso="appointment:create" modulo="agenda"><button className="btn primario" onClick={() => setNueva(true)}><Icon n="mas" className="" size={16} />Nueva cita</button></Escritura>
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {data && data.recursos.length > 0 && (
          <div className="fila entre envolver" style={{ gap: 8 }}>
            <div className="tabs" role="group" aria-label={`Filtrar por ${s.tenant.etiqueta_recurso?.toLowerCase() ?? 'recurso'}`}>
              <button className={recursoMovil === 'todos' ? 'on' : ''} aria-pressed={recursoMovil === 'todos'} onClick={() => setRecursoMovil('todos')}>Todos</button>
              {data.recursos.map((r: any) => <button key={r.id} className={recursoMovil === r.id ? 'on' : ''} aria-pressed={recursoMovil === r.id} onClick={() => setRecursoMovil(r.id)}>{r.nombre} <span className="tenue">{data.citas.filter((c: any) => c.resource_id === r.id && c.estado !== 'CANCELADA').length}</span></button>)}
            </div>
            <div className="tabs" role="group" aria-label="Vista">
              <button className={vista === 'rejilla' ? 'on' : ''} aria-pressed={vista === 'rejilla'} onClick={() => setVista('rejilla')}>Por horas</button>
              <button className={vista === 'lista' ? 'on' : ''} aria-pressed={vista === 'lista'} onClick={() => setVista('lista')}>Lista</button>
            </div>
          </div>
        )}
        {!data ? <div className="tarjeta"><Cargando /></div> : data.recursos.length === 0 ? <div className="tarjeta"><Vacio titulo="No hay agendas configuradas" accion={puede('tenant:configure') ? <Link className="btn" to="/configuracion?tab=equipo">Configurar horarios</Link> : undefined}>Agrega las personas o espacios que atienden y su horario para poder agendar.</Vacio></div>
          : vista === 'lista' ? (
            <section className="tarjeta">
              {citasVisibles.length === 0 ? <Vacio titulo="Sin citas este día">{puede('appointment:create') ? 'Usa «Nueva cita» para agendar.' : ''}</Vacio> : (
                <ul className="agenda-lista">{citasVisibles.map((c: any) => (
                  <li key={c.id}><button type="button" className={`agenda-item ${c.estado === 'CANCELADA' ? 'cancelada' : ''}`} onClick={() => setSel(c)}>
                    <span className="h mono">{c.hora}<span className="tenue">{c.hora_fin}</span></span>
                    <span className="col" style={{ gap: 2, minWidth: 0 }}><b className="cortar">{c.cliente}</b><span className="tenue peq-txt">{c.servicio} · {c.recurso}</span></span>
                    <span className="fila envolver" style={{ gap: 4, justifyContent: 'flex-end' }}>{c.origen === 'AGENTE' && <Estado v="AGENTE" texto="IA" />}<Estado v={c.estado} /></span>
                  </button></li>
                ))}</ul>
              )}
            </section>
          ) : (
          <section className="tarjeta agenda" aria-label={`Agenda del ${fechaLarga(dia)}`}>
            <div className="agenda-rejilla" style={{ gridTemplateColumns: `52px repeat(${recursos.length}, minmax(150px, 1fr))`, minWidth: 52 + recursos.length * 150 }}>
              <div className="agenda-esquina" />
              {recursos.map((r: any) => <div key={r.id} className="agenda-recurso">{r.nombre} <span className="tenue">· {data.citas.filter((c: any) => c.resource_id === r.id && c.estado !== 'CANCELADA').length}</span></div>)}
              <div>{horas.map((h) => <div key={h} className="agenda-hora" style={{ height: PX }}>{String(h).padStart(2, '0')}:00</div>)}</div>
              {recursos.map((r: any) => (
                <div key={r.id} className="agenda-columna" style={{ height: horas.length * PX, backgroundSize: `100% ${PX}px` }}>
                  {data.citas.filter((c: any) => c.resource_id === r.id).map((c: any) => {
                    const [hh, mm] = c.hora.split(':').map(Number);
                    const [fh, fm] = c.hora_fin.split(':').map(Number);
                    const top = ((hh - horas[0]) * 60 + mm) * (PX / 60);
                    const alto = Math.max(28, ((fh - hh) * 60 + (fm - mm)) * (PX / 60) - 2);
                    const ia = c.origen === 'AGENTE';
                    return (
                      <button key={c.id} onClick={() => setSel(c)} className={`cita ${ia ? 'ia' : ''} ${c.estado === 'CANCELADA' ? 'cancelada' : ''}`} style={{ top: top + 2, height: alto - 2 }}
                        aria-label={`${c.hora} a ${c.hora_fin}, ${c.cliente}, ${c.servicio}${ia ? ', agendada por la IA' : ''}, ${c.estado.toLowerCase()}`}>
                        <span className="fila" style={{ gap: 6, minWidth: 0 }}><b className="mono">{c.hora}</b><span className="cortar">{c.cliente}</span>{ia && <span className="estado ia mini-estado">IA</span>}</span><span className="tenue cortar">{c.servicio}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        )}
        <p className="nota-pie"><Icon n="ia" className="" size={14} />Las citas creadas por el agente llevan la marca IA. Las horas están en la zona horaria del negocio ({zona()}).</p>
      </div>
      {sel && (
        <Modal titulo={`${sel.hora} · ${sel.cliente}`} onCerrar={() => setSel(null)} pie={puede('appointment:create') && ['RESERVADA', 'CONFIRMADA', 'NO_ASISTIO'].includes(sel.estado) && !s.solo_lectura ? <div className="pie-acciones">
          {sel.estado !== 'NO_ASISTIO' && puede('appointment:cancel') && <button className="btn peligro" onClick={() => cambiarEstado('CANCELADA', 'Cita cancelada')}>Cancelar cita</button>}
          {sel.estado !== 'NO_ASISTIO' && <button className="btn" onClick={() => { setReprogramar(sel); setSel(null); }}>Reprogramar</button>}
          {sel.estado === 'RESERVADA' && <button className="btn" onClick={() => cambiarEstado('CONFIRMADA', 'Cita confirmada')}>Confirmar</button>}
          {sel.estado !== 'NO_ASISTIO' && <button className="btn" onClick={() => cambiarEstado('NO_ASISTIO', 'Marcada como no asistió')}>No asistió</button>}
          <button className="btn primario" onClick={() => cambiarEstado('ATENDIDA', 'Cita atendida')}>Atendida</button>
        </div> : undefined}>
          <div className="col" style={{ gap: 12 }}>
            <span className="fila envolver"><Estado v={sel.estado} /> {sel.origen === 'AGENTE' && <Estado v="AGENTE" texto="Agendada por la IA" />}</span>
            <dl className="datos-def">
              <dt>Servicio</dt><dd>{sel.servicio}</dd>
              <dt>Con</dt><dd>{sel.recurso}</dd>
              <dt>Horario</dt><dd>{sel.hora}–{sel.hora_fin}</dd>
              <dt>Precio</dt><dd>{cop(sel.precio)}</dd>
              <dt>Teléfono</dt><dd className="mono">{sel.telefono ?? '—'}</dd>
              {sel.notas && <><dt>Notas</dt><dd>{sel.notas}</dd></>}
            </dl>
            <Link to={`/clientes?id=${sel.customer_id}`} className="peq-txt">Ver la ficha del cliente</Link>
          </div>
        </Modal>
      )}
      {nueva && <NuevaCita dia={dia} onCerrar={() => setNueva(false)} onCreada={() => { setNueva(false); recargar(); }} />}
      {reprogramar && <NuevaCita dia={dia} cita={reprogramar} onCerrar={() => setReprogramar(null)} onCreada={() => { setReprogramar(null); recargar(); }} />}
    </>
  );
}

/** Crear o reprogramar una cita: franjas libres reales y, si no hay, los próximos días con espacio. */
function NuevaCita({ dia, cita, onCerrar, onCreada }: { dia: string; cita?: any; onCerrar: () => void; onCreada: () => void }) {
  const [qCliente, setQCliente] = useState('');
  const qc = useRetardo(qCliente);
  const clientes = useApi<any>(() => (cita ? Promise.resolve(null) : api.get(`/api/t/clientes?por_pagina=30${qc ? `&q=${encodeURIComponent(qc)}` : ''}`)), [qc]);
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const recursos = useApi<any[]>(() => api.get('/api/t/agenda/recursos'), []);
  const [cliente, setCliente] = useState<any>(cita ? { id: cita.customer_id, nombre: cita.cliente } : null);
  const [f, setF] = useState<any>({ product_id: cita?.product_id ?? '', fecha: dia, recurso: cita?.resource_id ?? '' });
  const servicios = (productos.data ?? []).filter((p) => p.tipo === 'SERVICIO' && p.duracion_min && p.activo);
  const franjas = useApi<any>(() => (f.product_id ? api.get(`/api/t/agenda/disponibilidad?servicio_id=${f.product_id}&fecha=${f.fecha}${f.recurso ? `&recurso_id=${f.recurso}` : ''}${cita ? `&excluir=${cita.id}` : ''}`) : Promise.resolve(null)), [f.product_id, f.fecha, f.recurso]);
  const { run, ocupado, error, limpiarError } = useAccion();
  const alternativas: any[] = (error?.details as any)?.alternativas ?? [];
  const reservar = async (s: any) => {
    limpiarError();
    const r = cita
      ? await run(() => api.post(`/api/t/agenda/citas/${cita.id}/reprogramar`, { inicio: s.inicio, resource_id: s.recurso_id }), `Cita movida a las ${s.hora} con ${s.recurso}`, { silencioso: true })
      : await run(() => api.post('/api/t/agenda/citas', { customer_id: cliente.id, product_id: f.product_id, resource_id: s.recurso_id, inicio: s.inicio }), `Cita creada: ${s.hora} con ${s.recurso}`, { silencioso: true });
    if (r) onCreada(); else franjas.recargar();
  };
  const boton = (s: any) => <button key={s.inicio + s.recurso_id} className="btn peq" disabled={ocupado || !cliente} onClick={() => reservar(s)}>{s.fecha && s.fecha !== f.fecha ? `${fecha(s.inicio)} ` : ''}{s.hora} · {s.recurso}</button>;
  const libres: any[] = franjas.data?.franjas ?? [];
  const otrosDias: any[] = franjas.data?.alternativas ?? [];
  return (
    <Modal titulo={cita ? `Reprogramar · ${cita.cliente}` : 'Nueva cita'} onCerrar={onCerrar}>
      {!cita && (
        <Campo etiqueta="Cliente">
          {cliente ? <span className="fila entre"><b>{cliente.nombre}</b><button type="button" className="btn peq sutil" onClick={() => setCliente(null)}>Cambiar</button></span> : <>
            <input className="input" type="search" placeholder="Busca por nombre, teléfono o documento" value={qCliente} onChange={(e) => setQCliente(e.target.value)} />
            <div className="opciones-busqueda" role="listbox" aria-label="Clientes encontrados">{clientes.data?.clientes?.slice(0, 6).map((c: any) => <button type="button" role="option" aria-selected="false" key={c.id} onClick={() => setCliente(c)}>{c.nombre}<span className="tenue peq-txt">{c.telefono ?? ''}</span></button>)}</div>
          </>}
        </Campo>
      )}
      <div className="grid g2">
        <Campo etiqueta="Servicio"><select className="input" value={f.product_id} disabled={!!cita} onChange={(e) => setF({ ...f, product_id: e.target.value })}><option value="">Elige…</option>{servicios.map((p) => <option key={p.id} value={p.id}>{p.nombre} · {p.duracion_min} min</option>)}</select></Campo>
        <Campo etiqueta="Fecha"><input className="input" type="date" value={f.fecha} min={hoyLocal()} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
        <Campo etiqueta="Con"><select className="input" value={f.recurso} onChange={(e) => setF({ ...f, recurso: e.target.value })}><option value="">Cualquiera</option>{(recursos.data ?? []).filter((r) => r.activo).map((r) => <option key={r.id} value={r.id}>{r.nombre}</option>)}</select></Campo>
      </div>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      {alternativas.length > 0 && <div className="col"><span className="etiqueta">Horarios cercanos libres</span><div className="fila envolver" style={{ gap: 6 }}>{alternativas.map(boton)}</div></div>}
      {f.product_id && (
        <div className="col"><span className="etiqueta">Franjas libres el {fechaLarga(f.fecha)}</span>
          {!franjas.data ? <Cargando filas={1} /> : libres.length > 0 ? <div className="fila envolver" style={{ gap: 6 }}>{libres.map(boton)}</div>
            : <><span className="tenue">No hay espacio ese día.</span>{otrosDias.length > 0 && <><span className="etiqueta">Próximos espacios</span><div className="fila envolver" style={{ gap: 6 }}>{otrosDias.map(boton)}</div></>}</>}
          {!cliente && <span className="tenue">Elige el cliente para reservar.</span>}
        </div>
      )}
    </Modal>
  );
}

// =================================================================== Facturación
export function Facturacion() {
  const nav = useNavigate();
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/facturacion'), [], { cada: 15000 });
  const [tab, setTab] = useState('');
  const { run, ocupado } = useAccion();
  if (error) return <><Cabecera titulo="Facturación electrónica" /><div className="contenido"><ErrorCarga error={error} reintentar={recargar} /></div></>;
  if (!data) return <><Cabecera titulo="Facturación electrónica" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  const rechazadas = data.documentos.filter((d: any) => d.estado === 'RECHAZADO');
  const cuenta = (e: string) => data.resumen.find((r: any) => r.estado === e)?.n ?? 0;
  const lista = tab ? data.documentos.filter((d: any) => (tab === 'PENDIENTE' ? ['PENDIENTE', 'ENVIADO'].includes(d.estado) : tab === 'ENTREGADO' ? ['VALIDADO', 'ENTREGADO'].includes(d.estado) : d.estado === tab)) : data.documentos;
  return (
    <>
      <Cabecera titulo="Facturación electrónica" sub={data.resolucion ? `Numeración ${data.resolucion.prefijo} ${data.resolucion.numero_desde}–${data.resolucion.numero_hasta} · siguiente ${data.resolucion.siguiente}` : ''} />
      <div className="contenido">
        {!data.validez_fiscal && (
          <div className="aviso" role="note"><Icon n="alerta" className="" size={16} /><span>{data.proveedor === 'sandbox' ? 'Facturación en modo de pruebas: los documentos se generan para que veas el recorrido completo, pero NO tienen validez fiscal ni se transmiten a la DIAN.' : 'La facturación electrónica está pendiente de conectar con un proveedor habilitado por la DIAN.'}</span></div>
        )}
        {rechazadas.map((d: any) => (
          <section key={d.id} className="decision" aria-label={`Factura ${d.numero} rechazada`}>
            <div className="cab"><Estado v="RECHAZADO" texto="Rechazada" /><span className="mono">{d.numero}</span><span className="tenue peq-txt">venta #{d.orden} · {d.cliente}</span></div>
            <div className="cuerpo fila entre envolver" style={{ gap: 12 }}><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><b>{d.motivo_rechazo}</b><br /><span className="tenue peq-txt">Corrige el dato en la ficha del cliente y vuelve a enviar.</span></span><div className="fila envolver"><Link className="btn" to={`/ventas/${d.order_id}`}>Ver venta y corregir</Link><Escritura permiso="invoice:issue" modulo="facturacion"><button className="btn primario" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/facturacion/${d.id}/reintentar`), 'Enviada de nuevo').then(recargar)}>Volver a enviar</button></Escritura></div></div>
          </section>
        ))}
        <div className="kpis">
          <Cifra etiqueta={data.validez_fiscal ? 'Validadas y entregadas' : 'Validadas (prueba)'} valor={cuenta('ENTREGADO') + cuenta('VALIDADO')} />
          <Cifra etiqueta="En trámite" valor={cuenta('PENDIENTE') + cuenta('ENVIADO')} />
          <Cifra etiqueta="Rechazadas" valor={cuenta('RECHAZADO')} />
          <Cifra etiqueta="Total facturado" valor={cop(data.documentos.filter((d: any) => d.tipo === 'FACTURA' && ['VALIDADO', 'ENTREGADO'].includes(d.estado)).reduce((a: number, d: any) => a + d.total, 0))} />
        </div>
        <section className="tarjeta">
          <div className="filtros">
            <div className="tabs" role="group" aria-label="Filtrar documentos">{[['', 'Todos'], ['ENTREGADO', 'Validados'], ['PENDIENTE', 'En trámite'], ['RECHAZADO', 'Rechazados']].map(([k, v]) => <button key={k} className={tab === k ? 'on' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{v}</button>)}</div>
          </div>
          {lista.length === 0 ? <Vacio titulo="No hay documentos en esta vista">Cada venta confirmada genera su factura automáticamente.</Vacio> : (
            <div className="tabla-wrap"><table className="tabla tabla-movil">
              <thead><tr><th>Número</th><th>Estado</th><th>Fecha</th><th>Cliente</th><th className="num">Total</th><th>Entrega</th></tr></thead>
              <tbody>{lista.map((d: any) => (
                <tr key={d.id} className="clic" onClick={() => nav(`/ventas/${d.order_id}`)}>
                  <td data-etiqueta="Documento" className="principal"><Link to={`/ventas/${d.order_id}`} className="mono" onClick={(e) => e.stopPropagation()}>{d.numero}</Link> <span className="tenue peq-txt">{d.tipo === 'FACTURA' ? 'Factura' : 'Nota crédito'}</span></td>
                  <td data-etiqueta="Estado"><Estado v={d.estado} texto={d.proveedor_fiscal === 'sandbox' && ['VALIDADO', 'ENTREGADO'].includes(d.estado) ? 'Validada (prueba)' : undefined} /></td>
                  <td data-etiqueta="Fecha">{fechaHora(d.creado_en)}</td><td data-etiqueta="Cliente">{d.cliente}</td>
                  <td data-etiqueta="Total" className="num">{cop(d.total)}</td>
                  <td data-etiqueta="Entrega">{!['VALIDADO', 'ENTREGADO'].includes(d.estado) ? <span className="tenue peq-txt">Al validarse</span> : <span className="fila envolver" style={{ gap: 4 }}><Estado v={d.entrega_whatsapp === 'ENVIADO' ? 'ENTREGADO' : d.entrega_whatsapp} texto={`WhatsApp: ${ENTREGA_DOC[d.entrega_whatsapp] ?? d.entrega_whatsapp.toLowerCase()}`} /><Estado v={d.entrega_email === 'ENVIADO' ? 'ENTREGADO' : d.entrega_email} texto={`Correo: ${ENTREGA_DOC[d.entrega_email] ?? d.entrega_email.toLowerCase()}`} /></span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <p className="nota-pie"><Icon n="info" className="" size={14} />Un documento validado no se borra ni se edita: se anula con una nota crédito desde el detalle de la venta.</p>
      </div>
    </>
  );
}
