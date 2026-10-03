import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, cop, fecha, fechaHora, fechaLarga, hora, hoyLocal } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { Campo, Cargando, CicloFiscal, Cifra, Confirmar, ErrorCarga, Estado, Modal, Recibo, Tarjeta, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

// =================================================================== SCR-010 Clientes
export function Clientes() {
  const { puede } = useSesion();
  const [q, setQ] = useState('');
  const [params, setParams] = useSearchParams();
  const sel = params.get('id');
  const [nuevo, setNuevo] = useState(false);
  const { data, error, recargar } = useApi<any[]>(() => api.get(`/api/t/clientes${q ? `?q=${encodeURIComponent(q)}` : ''}`), [q]);
  return (
    <>
      <Cabecera titulo="Clientes" sub="Contactos, historial y autorización de datos personales">
        <div className="buscar"><Icon n="buscar" className="" size={14} /><input style={{ border: 0, background: 'transparent', outline: 'none', width: '100%' }} placeholder="Nombre, teléfono o documento" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar clientes" /></div>
        {puede('customer:write') && <button className="btn primario" onClick={() => setNuevo(true)}>Nuevo cliente</button>}
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <div className="grid" style={{ gridTemplateColumns: sel ? 'minmax(0,1.3fr) minmax(0,1fr)' : '1fr', alignItems: 'start' }}>
          <section className="tarjeta">
            {!data ? <Cargando /> : data.length === 0 ? <Vacio titulo={q ? 'Nadie coincide con la búsqueda' : 'Aún no tienes clientes'}>{!q && 'Se crean solos cuando alguien te escribe por WhatsApp, o regístralos aquí.'}</Vacio> : (
              <div className="tabla-wrap"><table className="tabla">
                <thead><tr><th>Cliente</th><th>Contacto</th><th>Documento</th><th className="num">Compras</th><th>Última cita</th><th>Datos personales</th></tr></thead>
                <tbody>{data.map((c) => (
                  <tr key={c.id} className={`clic ${sel === c.id ? 'sel' : ''}`} onClick={() => setParams({ id: c.id })}>
                    <td><b>{c.nombre}</b></td>
                    <td><span className="mono">{c.telefono ?? '—'}</span><br /><span className="tenue">{c.email ?? ''}</span></td>
                    <td>{c.numero_documento ? <span className="mono">{c.tipo_documento} {c.numero_documento}</span> : <span className="tenue">Consumidor final</span>}</td>
                    <td className="num">{c.compras} · {cop(c.total_compras)}</td>
                    <td>{c.ultima_cita ? fecha(c.ultima_cita) : '—'}</td>
                    <td>{c.consentimiento_en ? <Estado v="EXITO" texto={`Autorizó · ${fecha(c.consentimiento_en)}`} /> : <Estado v="PENDIENTE" texto="Sin autorización" />}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
          {sel && <FichaCliente id={sel} onCambio={recargar} />}
        </div>
        <p className="tenue">La plataforma trata estos datos por encargo de tu negocio (Ley 1581 de 2012). Desde la ficha puedes exportar los datos de un titular cuando lo solicite.</p>
      </div>
      {nuevo && <FormCliente onCerrar={() => setNuevo(false)} onGuardado={(id) => { setNuevo(false); recargar(); setParams({ id }); }} />}
    </>
  );
}

function FormCliente({ inicial, onCerrar, onGuardado }: { inicial?: any; onCerrar: () => void; onGuardado: (id: string) => void }) {
  const [f, setF] = useState<any>(inicial ?? { nombre: '', telefono: '', email: '', tipo_documento: '', numero_documento: '' });
  const { run, ocupado } = useAccion();
  const guardarCliente = async () => {
    const body = Object.fromEntries(Object.entries(f).filter(([k]) => ['nombre', 'telefono', 'email', 'tipo_documento', 'numero_documento', 'notas'].includes(k)).map(([k, v]) => [k, v === '' ? null : v]));
    const r = await run(() => (inicial ? api.patch(`/api/t/clientes/${inicial.id}`, body) : api.post('/api/t/clientes', body)), 'Cliente guardado');
    if (r) onGuardado(r.id);
  };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal titulo={inicial ? 'Editar cliente' : 'Nuevo cliente'} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !f.nombre} onClick={guardarCliente}>Guardar</button></>}>
      <Campo etiqueta="Nombre o razón social"><input className="input" value={f.nombre ?? ''} onChange={set('nombre')} /></Campo>
      <div className="grid g2">
        <Campo etiqueta="Teléfono" ayuda="con indicativo, ej. +573001234567"><input className="input" value={f.telefono ?? ''} onChange={set('telefono')} /></Campo>
        <Campo etiqueta="Correo" ayuda="para enviar la factura"><input className="input" type="email" value={f.email ?? ''} onChange={set('email')} /></Campo>
        <Campo etiqueta="Tipo de documento"><select className="input" value={f.tipo_documento ?? ''} onChange={set('tipo_documento')}><option value="">Consumidor final</option><option>CC</option><option>NIT</option><option>CE</option><option>PP</option></select></Campo>
        <Campo etiqueta="Número" ayuda={f.tipo_documento === 'NIT' ? 'con dígito de verificación: 900123456-7' : undefined}><input className="input" value={f.numero_documento ?? ''} onChange={set('numero_documento')} /></Campo>
      </div>
    </Modal>
  );
}

function FichaCliente({ id, onCambio }: { id: string; onCambio: () => void }) {
  const { puede } = useSesion();
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
    <section className="tarjeta">
      <div className="cab"><b className="titulo-tarjeta">{data.nombre}</b>
        <div className="fila" style={{ marginLeft: 'auto' }}>
          {puede('customer:write') && <button className="btn peq" onClick={() => setEditar(true)}>Editar</button>}
          <button className="btn peq" onClick={exportar}>Exportar datos</button>
        </div>
      </div>
      <div className="cuerpo col" style={{ gap: 10 }}>
        <span className="tenue">{data.telefono ?? ''} · {data.email ?? 'sin correo'}</span>
        {data.consentimiento_en ? <Estado v="EXITO" texto={`Autorizó el tratamiento de datos · ${fechaHora(data.consentimiento_en)} vía ${data.consentimiento_via}`} />
          : <div className="fila"><Estado v="PENDIENTE" texto="Sin autorización registrada" />{puede('customer:write') && <button className="btn peq" onClick={() => run(() => api.post(`/api/t/clientes/${id}/consentimiento`), 'Autorización registrada').then(recargar)}>Registrar autorización</button>}</div>}
        <span className="etiqueta">Compras</span>
        {data.orders.length === 0 ? <span className="tenue">Sin compras</span> : data.orders.map((o: any) => (
          <Link key={o.id} to={`/ventas/${o.id}`} className="fila entre" style={{ color: 'inherit' }}><span className="mono">#{o.numero}</span><span>{fecha(o.creado_en)}</span><span>{cop(o.total)}</span><Estado v={o.estado_fiscal ?? o.estado} /></Link>
        ))}
        <span className="etiqueta">Citas</span>
        {data.citas.length === 0 ? <span className="tenue">Sin citas</span> : data.citas.slice(0, 8).map((c: any) => (
          <div key={c.id} className="fila entre"><span>{fecha(c.inicio)} {hora(c.inicio)}</span><span className="tenue">{c.servicio} · {c.recurso}</span>{c.origen === 'AGENTE' ? <Estado v="AGENTE" texto="IA" /> : <Estado v={c.estado} />}</div>
        ))}
        {data.conversaciones.length > 0 && <><span className="etiqueta">Conversaciones</span>{data.conversaciones.map((v: any) => <Link key={v.id} to={`/conversaciones/${v.id}`} className="fila entre" style={{ color: 'inherit' }}><span>{v.canal}</span><Estado v={v.estado} /><span className="tenue">{fecha(v.actualizado_en)}</span></Link>)}</>}
      </div>
      {editar && <FormCliente inicial={data} onCerrar={() => setEditar(false)} onGuardado={() => { setEditar(false); recargar(); onCambio(); }} />}
    </section>
  );
}

// =================================================================== SCR-011 Ventas
export function Ventas() {
  const { puede } = useSesion();
  const nav = useNavigate();
  const [filtro, setFiltro] = useState('');
  const [nueva, setNueva] = useState(false);
  const { data, error, recargar } = useApi<any[]>(() => api.get(`/api/t/ventas${filtro ? `?estado_fiscal=${filtro}` : ''}`), [filtro]);
  return (
    <>
      <Cabecera titulo="Ventas" sub="Vender y facturar son el mismo hilo">{puede('order:create') && <button className="btn primario" onClick={() => setNueva(true)}>Registrar venta</button>}</Cabecera>
      <div className="contenido">
        <div className="tabs">{[['', 'Todas'], ['RECHAZADO', 'Factura rechazada'], ['PENDIENTE', 'Factura pendiente'], ['ENTREGADO', 'Facturadas']].map(([k, v]) => <button key={k} className={filtro === k ? 'on' : ''} onClick={() => setFiltro(k)}>{v}</button>)}</div>
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <section className="tarjeta">
          {!data ? <Cargando /> : data.length === 0 ? <Vacio titulo="No hay ventas en esta vista" /> : (
            <div className="tabla-wrap"><table className="tabla">
              <thead><tr><th>#</th><th>Fecha</th><th>Cliente</th><th>Detalle</th><th>Origen</th><th className="num">Total</th><th>Pago</th><th>Estado fiscal</th></tr></thead>
              <tbody>{data.map((o) => (
                <tr key={o.id} className="clic" onClick={() => nav(`/ventas/${o.id}`)}>
                  <td className="mono">#{o.numero}</td><td>{fechaHora(o.creado_en)}</td><td>{o.cliente}</td>
                  <td className="sec" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.detalle}</td>
                  <td><Estado v={o.origen} /></td><td className="num">{cop(o.total)}</td>
                  <td>{o.estado === 'ANULADA' ? <Estado v="ANULADA" /> : <Estado v={o.estado_pago === 'PAGADA' ? 'PAGADA' : 'PENDIENTE'} texto={o.estado_pago === 'PAGADA' ? 'Pagada' : 'Por cobrar'} />}</td>
                  <td>{o.estado_fiscal ? <><Estado v={o.estado_fiscal} /> <span className="mono tenue">{o.documento}</span></> : <span className="tenue">Sin factura</span>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </div>
      {nueva && <NuevaVenta onCerrar={() => setNueva(false)} onGuardada={(id) => nav(`/ventas/${id}`)} />}
    </>
  );
}

function NuevaVenta({ onCerrar, onGuardada }: { onCerrar: () => void; onGuardada: (id: string) => void }) {
  const clientes = useApi<any[]>(() => api.get('/api/t/clientes'), []);
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const [cliente, setCliente] = useState('');
  const [items, setItems] = useState<{ product_id: string; cantidad: number }[]>([]);
  const { run, ocupado } = useAccion();
  const total = items.reduce((a, i) => a + (productos.data?.find((p) => p.id === i.product_id)?.precio ?? 0) * i.cantidad, 0);
  return (
    <Modal titulo="Registrar venta" onCerrar={onCerrar} pie={<><span className="tenue" style={{ marginRight: 'auto' }}>Total {cop(total)} (IVA incluido)</span><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || !cliente || !items.length} onClick={async () => { const r = await run(() => api.post('/api/t/ventas', { customer_id: cliente, items }), 'Venta registrada: la factura se emite en segundo plano'); if (r) onGuardada(r.id); }}>Registrar</button></>}>
      <Campo etiqueta="Cliente"><select className="input" value={cliente} onChange={(e) => setCliente(e.target.value)}><option value="">Elige un cliente…</option>{clientes.data?.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
      <div className="col">
        {items.map((it, i) => (
          <div key={i} className="fila">
            <select className="input" value={it.product_id} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, product_id: e.target.value } : x)))}>{productos.data?.filter((p) => p.activo).map((p) => <option key={p.id} value={p.id}>{p.nombre} · {cop(p.precio)}{p.controla_stock ? ` · quedan ${p.stock}` : ''}</option>)}</select>
            <input className="input" type="number" min={1} style={{ width: 80 }} value={it.cantidad} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, cantidad: Math.max(1, Number(e.target.value)) } : x)))} aria-label="Cantidad" />
            <button className="btn sutil peq" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Quitar"><Icon n="x" className="" size={12} /></button>
          </div>
        ))}
        <button className="btn peq" style={{ alignSelf: 'flex-start' }} disabled={!productos.data?.length} onClick={() => setItems([...items, { product_id: productos.data![0].id, cantidad: 1 }])}>Agregar ítem</button>
      </div>
    </Modal>
  );
}

// =================================================================== Detalle de venta
export function VentaDetalle() {
  const { id } = useParams();
  const { puede } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/ventas/${id}`), [id], { cada: 4000 });
  const [anular, setAnular] = useState(false);
  const { run, ocupado } = useAccion();
  if (error) return <><Cabecera titulo="Venta" /><div className="contenido"><ErrorCarga error={error} /></div></>;
  if (!data) return <Cargando filas={8} />;
  const factura = data.documentos.find((d: any) => d.tipo === 'FACTURA');
  const nota = data.documentos.find((d: any) => d.tipo === 'NOTA_CREDITO');
  return (
    <>
      <Cabecera titulo={`Venta #${data.numero}`} sub={`${fechaHora(data.creado_en)} · ${data.cliente}`}>
        <Estado v={data.origen} />
        {data.estado === 'CONFIRMADA' && data.estado_pago !== 'PAGADA' && puede('payment:link') && <button className="btn" disabled={ocupado} onClick={async () => { const r = await run(() => api.post(`/api/t/ventas/${id}/enlace-pago`)); if (r?.enlace) { navigator.clipboard?.writeText(r.enlace); window.open(r.enlace.replace(/^https?:\/\/[^/]+/, ''), '_blank'); recargar(); } else if (r?.error) alert(r.error); }}>Enlace de pago</button>}
        {data.estado === 'CONFIRMADA' && puede('order:void') && <button className="btn" onClick={() => setAnular(true)}>Anular</button>}
      </Cabecera>
      <div className="contenido">
        {factura?.estado === 'RECHAZADO' && (
          <section className="decision">
            <div className="cab"><Estado v="RECHAZADO" texto="La DIAN rechazó la factura" /><span className="mono" style={{ marginLeft: 'auto' }}>{factura.numero}</span></div>
            <div className="cuerpo col">
              <b>{factura.motivo_rechazo}</b>
              <span className="sec">La venta sigue siendo válida. Corrige el dato del cliente y vuelve a enviar la factura; el reintento queda en la traza.</span>
              <div className="fila">
                <Link className="btn" to={`/clientes?id=${data.customer_id}`}>Corregir datos del cliente</Link>
                {puede('invoice:issue') && <button className="btn primario" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/facturacion/${factura.id}/reintentar`), 'Factura reenviada a la DIAN').then(recargar)}>Corregir y reintentar</button>}
              </div>
            </div>
          </section>
        )}
        <div className="grid g-main">
          <div className="col" style={{ gap: 16 }}>
            <Tarjeta titulo="Detalle" sinCuerpo>
              <table className="tabla"><thead><tr><th>Descripción</th><th className="num">Cant.</th><th className="num">Valor unit.</th><th className="num">IVA</th><th className="num">Total</th></tr></thead>
                <tbody>{data.items.map((i: any, k: number) => <tr key={k}><td>{i.descripcion}</td><td className="num">{i.cantidad}</td><td className="num">{cop(i.precio_unit)}</td><td className="num">{i.iva_pct}%</td><td className="num">{cop(i.total)}</td></tr>)}
                  <tr><td colSpan={4} className="num tenue">Base</td><td className="num">{cop(data.subtotal)}</td></tr>
                  <tr><td colSpan={4} className="num tenue">IVA</td><td className="num">{cop(data.impuestos)}</td></tr>
                  <tr><td colSpan={4} className="num"><b>Total</b></td><td className="num"><b>{cop(data.total)}</b></td></tr></tbody></table>
            </Tarjeta>
            {data.recibos.length > 0 && <Tarjeta titulo="Origen: acción de IA"><div className="col">{data.recibos.map((r: any) => <Recibo key={r.id} e={r} />)}</div>{data.conversation_id && <Link to={`/conversaciones/${data.conversation_id}`} className="btn sutil peq" style={{ marginTop: 8 }}>Ver conversación</Link>}</Tarjeta>}
            <Tarjeta titulo="Traza completa">
              {data.traza.length === 0 ? <span className="tenue">Sin eventos</span> : (
                <div className="col" style={{ gap: 6 }}>{data.traza.map((t: any) => (
                  <div key={t.id} className="fila" style={{ gap: 10 }}><span className="mono tenue" style={{ width: 90 }}>{hora(t.creado_en)}</span><span className="mono">{t.accion}</span><Estado v={t.resultado} /><span className="tenue">{t.actor_nombre}</span></div>
                ))}</div>
              )}
            </Tarjeta>
          </div>
          <div className="col" style={{ gap: 16 }}>
            <Tarjeta titulo="Documento fiscal" nivel={factura?.estado === 'RECHAZADO' ? 3 : 2}>
              {!factura ? (
                <div className="col"><span className="tenue">Esta venta no tiene factura.</span>{data.estado === 'CONFIRMADA' && puede('invoice:issue') && <button className="btn primario" onClick={() => run(() => api.post(`/api/t/ventas/${id}/facturar`), 'Factura solicitada').then(recargar)}>Emitir factura</button>}</div>
              ) : (
                <div className="col" style={{ gap: 10 }}>
                  <CicloFiscal estado={factura.estado} />
                  <div className="fila entre"><span className="mono">{factura.numero}</span><Estado v={factura.estado} /></div>
                  {factura.cufe && <><span className="etiqueta">CUFE</span><code style={{ wordBreak: 'break-all' }}>{factura.cufe}</code></>}
                  <div className="fila entre"><span>WhatsApp</span><Estado v={factura.entrega_whatsapp === 'ENVIADO' ? 'ENTREGADO' : factura.entrega_whatsapp} texto={factura.entrega_whatsapp.toLowerCase()} /></div>
                  <div className="fila entre"><span>Correo</span><Estado v={factura.entrega_email} texto={factura.entrega_email.toLowerCase()} /></div>
                  <a className="btn sutil peq" href={`/api/publico/documentos/${factura.token_publico}`} target="_blank" rel="noreferrer">Ver documento</a>
                </div>
              )}
            </Tarjeta>
            {nota && <Tarjeta titulo="Nota crédito"><div className="fila entre"><span className="mono">{nota.numero}</span><Estado v={nota.estado} /></div></Tarjeta>}
            {data.enlaces.length > 0 && <Tarjeta titulo="Enlaces de cobro">{data.enlaces.map((l: any) => <div key={l.id} className="fila entre"><span className="mono">{l.referencia}</span><Estado v={l.estado === 'PAGADO' ? 'PAGADA' : 'PENDIENTE'} texto={l.estado.toLowerCase()} /></div>)}<span className="tenue">El dinero va directo a la cuenta de pasarela del negocio.</span></Tarjeta>}
          </div>
        </div>
      </div>
      {anular && <Confirmar titulo={`Anular venta #${data.numero}`} riesgo="critica" pedirMotivo textoBoton="Anular venta"
        efecto={<>{factura && ['VALIDADO', 'ENTREGADO'].includes(factura.estado) ? <>La factura <b className="mono">{factura.numero}</b> ya fue validada por la DIAN: <b>no se borra</b>, se emitirá una <b>nota crédito</b> por {cop(data.total)}.</> : 'La venta quedará anulada.'} Las existencias vuelven al inventario.</>}
        onCerrar={() => setAnular(false)} onConfirmar={async (motivo) => { setAnular(false); await run(() => api.post(`/api/t/ventas/${id}/anular`, { motivo }), 'Venta anulada'); recargar(); }} />}
    </>
  );
}

// =================================================================== SCR-012 Inventario
export function Inventario() {
  const { puede } = useSesion();
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const movs = useApi<any[]>(() => (puede('inventory:read') ? api.get('/api/t/inventario/movimientos') : Promise.resolve([])), []);
  const [editar, setEditar] = useState<any>(null);
  const [mov, setMov] = useState<any>(null);
  const { run, ocupado } = useAccion();
  const bajos = (productos.data ?? []).filter((p) => p.controla_stock && p.stock <= p.stock_minimo);
  const guardarProducto = async () => {
    const body = { ...editar, precio: Number(editar.precio), iva_pct: Number(editar.iva_pct ?? 0), duracion_min: editar.tipo === 'SERVICIO' ? Number(editar.duracion_min || 30) : null, stock_minimo: Number(editar.stock_minimo ?? 0), stock: Number(editar.stock ?? 0) };
    delete body.id; delete body.moneda;
    if (editar.id) delete body.stock;
    const r = await run(() => (editar.id ? api.patch(`/api/t/productos/${editar.id}`, body) : api.post('/api/t/productos', body)), 'Catálogo actualizado');
    if (r) { setEditar(null); productos.recargar(); }
  };
  return (
    <>
      <Cabecera titulo="Catálogo e inventario" sub="Precios con IVA incluido">{puede('catalog:write') && <button className="btn primario" onClick={() => setEditar({ tipo: 'PRODUCTO', nombre: '', precio: '', iva_pct: 19, controla_stock: true, stock: 0, stock_minimo: 0, activo: true })}>Nuevo ítem</button>}</Cabecera>
      <div className="contenido">
        {bajos.length > 0 && <Tarjeta nivel={3} titulo={<span className="fila"><Icon n="alerta" className="" size={14} /> {bajos.length} producto(s) en o por debajo del mínimo</span>}><div className="fila envolver">{bajos.map((p) => <span key={p.id} className="chip">{p.nombre}: {p.stock} / mín. {p.stock_minimo}</span>)}</div></Tarjeta>}
        {productos.error && <ErrorCarga error={productos.error} />}
        <section className="tarjeta">
          {!productos.data ? <Cargando /> : (
            <table className="tabla"><thead><tr><th>Nombre</th><th>Tipo</th><th>Categoría</th><th className="num">Precio</th><th className="num">IVA</th><th className="num">Existencias</th><th>Estado</th><th /></tr></thead>
              <tbody>{productos.data.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.nombre}</b>{p.duracion_min && <span className="tenue"> · {p.duracion_min} min</span>}</td><td>{p.tipo === 'SERVICIO' ? 'Servicio' : 'Producto'}</td><td>{p.categoria ?? '—'}</td>
                  <td className="num">{cop(p.precio)}</td><td className="num">{p.iva_pct}%</td>
                  <td className="num">{p.controla_stock ? <span style={{ color: p.stock <= p.stock_minimo ? 'var(--atencion)' : undefined, fontWeight: 480 }}>{p.stock}</span> : '—'}</td>
                  <td>{p.activo ? <Estado v="ACTIVA" texto="Activo" /> : <Estado v="CANCELADA" texto="Inactivo" />}</td>
                  <td className="fila">{puede('catalog:write') && <button className="btn peq" onClick={() => setEditar(p)}>Editar</button>}{p.controla_stock && puede('inventory:write') && <button className="btn peq" onClick={() => setMov({ product_id: p.id, nombre: p.nombre, tipo: 'ENTRADA', cantidad: 1, motivo: '' })}>Movimiento</button>}</td>
                </tr>
              ))}</tbody></table>
          )}
        </section>
        {puede('inventory:read') && (
          <Tarjeta titulo="Movimientos recientes" sinCuerpo>
            {!movs.data?.length ? <Vacio titulo="Sin movimientos" /> : (
              <table className="tabla"><thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th className="num">Cantidad</th><th>Motivo</th><th>Actor</th></tr></thead>
                <tbody>{movs.data.slice(0, 30).map((m) => <tr key={m.id}><td>{fechaHora(m.creado_en)}</td><td>{m.producto}</td><td>{m.tipo}</td><td className="num">{m.cantidad}</td><td>{m.motivo}</td><td className="tenue">{String(m.actor).replace(/^\w+:/, '')}</td></tr>)}</tbody></table>
            )}
          </Tarjeta>
        )}
        <p className="tenue"><Icon n="ia" className="" size={12} /> La misma herramienta de lectura que usa el agente responde a «¿qué tengo por debajo del mínimo?».</p>
      </div>
      {editar && (
        <Modal titulo={editar.id ? `Editar ${editar.nombre}` : 'Nuevo ítem'} onCerrar={() => setEditar(null)} pie={<><button className="btn" onClick={() => setEditar(null)}>Cancelar</button><button className="btn primario" disabled={ocupado || !editar.nombre || editar.precio === ''} onClick={guardarProducto}>Guardar</button></>}>
          <div className="grid g2">
            <Campo etiqueta="Tipo"><select className="input" value={editar.tipo} disabled={!!editar.id} onChange={(e) => setEditar({ ...editar, tipo: e.target.value, controla_stock: e.target.value === 'PRODUCTO' })}><option value="SERVICIO">Servicio</option><option value="PRODUCTO">Producto</option></select></Campo>
            <Campo etiqueta="Nombre"><input className="input" value={editar.nombre} onChange={(e) => setEditar({ ...editar, nombre: e.target.value })} /></Campo>
            <Campo etiqueta="Precio (IVA incluido)"><input className="input" inputMode="numeric" value={editar.precio} onChange={(e) => setEditar({ ...editar, precio: e.target.value.replace(/[^\d.]/g, '') })} /></Campo>
            <Campo etiqueta="IVA"><select className="input" value={editar.iva_pct} onChange={(e) => setEditar({ ...editar, iva_pct: Number(e.target.value) })}><option value={0}>0 %</option><option value={5}>5 %</option><option value={19}>19 %</option></select></Campo>
            <Campo etiqueta="Categoría"><input className="input" value={editar.categoria ?? ''} onChange={(e) => setEditar({ ...editar, categoria: e.target.value })} /></Campo>
            {editar.tipo === 'SERVICIO' ? <Campo etiqueta="Duración (min)"><input className="input" type="number" value={editar.duracion_min ?? 30} onChange={(e) => setEditar({ ...editar, duracion_min: e.target.value })} /></Campo>
              : <Campo etiqueta="Mínimo de existencias"><input className="input" type="number" value={editar.stock_minimo ?? 0} onChange={(e) => setEditar({ ...editar, stock_minimo: e.target.value })} /></Campo>}
            {!editar.id && editar.tipo === 'PRODUCTO' && <Campo etiqueta="Existencias iniciales"><input className="input" type="number" value={editar.stock ?? 0} onChange={(e) => setEditar({ ...editar, stock: e.target.value })} /></Campo>}
          </div>
          {editar.id && <label className="fila"><input type="checkbox" checked={editar.activo} onChange={(e) => setEditar({ ...editar, activo: e.target.checked })} /> Activo (visible para el agente y en ventas)</label>}
          {editar.id && <span className="tenue">Los cambios de precio quedan en auditoría con el valor anterior.</span>}
        </Modal>
      )}
      {mov && (
        <Modal titulo={`Movimiento · ${mov.nombre}`} onCerrar={() => setMov(null)} pie={<><button className="btn" onClick={() => setMov(null)}>Cancelar</button><button className="btn primario" disabled={ocupado || mov.motivo.length < 3} onClick={async () => { const r = await run(() => api.post('/api/t/inventario/movimientos', { product_id: mov.product_id, tipo: mov.tipo, cantidad: Number(mov.cantidad), motivo: mov.motivo }), 'Movimiento registrado'); if (r) { setMov(null); productos.recargar(); movs.recargar(); } }}>Registrar</button></>}>
          <div className="grid g2">
            <Campo etiqueta="Tipo"><select className="input" value={mov.tipo} onChange={(e) => setMov({ ...mov, tipo: e.target.value })}><option value="ENTRADA">Entrada</option><option value="SALIDA">Salida</option><option value="AJUSTE">Ajuste (conteo físico)</option></select></Campo>
            <Campo etiqueta={mov.tipo === 'AJUSTE' ? 'Existencia contada' : 'Cantidad'}><input className="input" type="number" min={0} value={mov.cantidad} onChange={(e) => setMov({ ...mov, cantidad: e.target.value })} /></Campo>
          </div>
          <Campo etiqueta="Motivo"><input className="input" value={mov.motivo} onChange={(e) => setMov({ ...mov, motivo: e.target.value })} placeholder="Compra a proveedor, producto dañado…" /></Campo>
        </Modal>
      )}
    </>
  );
}

// =================================================================== SCR-013 Agenda
export function Agenda() {
  const { puede, s } = useSesion();
  const [dia, setDia] = useState(hoyLocal());
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/agenda?fecha=${dia}`), [dia], { cada: 15000 });
  const [nueva, setNueva] = useState(false);
  const [sel, setSel] = useState<any>(null);
  const { run } = useAccion();
  const mover = (n: number) => { const d = new Date(`${dia}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); setDia(d.toISOString().slice(0, 10)); };
  const horas = useMemo(() => Array.from({ length: 14 }, (_, i) => 7 + i), []);
  const PX = 76;
  return (
    <>
      <Cabecera titulo="Agenda" sub={fechaLarga(dia)}>
        <button className="btn peq" onClick={() => mover(-1)}>←</button><button className="btn peq" onClick={() => setDia(hoyLocal())}>Hoy</button><button className="btn peq" onClick={() => mover(1)}>→</button>
        {puede('appointment:create') && <button className="btn primario" onClick={() => setNueva(true)}>Nueva cita</button>}
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        {!data ? <Cargando /> : (
          <section className="tarjeta" style={{ overflow: 'auto', padding: '0 12px 16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: `60px repeat(${data.recursos.length}, minmax(180px, 1fr))`, minWidth: 60 + data.recursos.length * 180 }}>
              <div />
              {data.recursos.map((r: any) => <div key={r.id} className="titulo-tarjeta" style={{ padding: '20px 14px 14px', borderBottom: '1px solid var(--linea)', fontSize: 15 }}>{r.nombre} <span className="tenue">({data.citas.filter((c: any) => c.resource_id === r.id && c.estado !== 'CANCELADA').length})</span></div>)}
              <div style={{ position: 'relative' }}>{horas.map((h) => <div key={h} className="mono tenue" style={{ height: PX, paddingTop: 4, textAlign: 'right', paddingRight: 12, fontSize: 13 }}>{String(h).padStart(2, '0')}:00</div>)}</div>
              {data.recursos.map((r: any) => (
                <div key={r.id} style={{ position: 'relative', borderLeft: '1px solid var(--linea)', height: horas.length * PX, background: `repeating-linear-gradient(to bottom, transparent 0 ${PX - 1}px, var(--linea) ${PX - 1}px ${PX}px)` }}>
                  {data.citas.filter((c: any) => c.resource_id === r.id).map((c: any) => {
                    const [hh, mm] = c.hora.split(':').map(Number);
                    const [fh, fm] = c.hora_fin.split(':').map(Number);
                    const top = ((hh - 7) * 60 + mm) * (PX / 60);
                    const alto = Math.max(30, ((fh - hh) * 60 + (fm - mm)) * (PX / 60) - 2);
                    const ia = c.origen === 'AGENTE';
                    return (
                      <button key={c.id} onClick={() => setSel(c)} style={{ position: 'absolute', top: top + 2, left: 6, right: 6, height: alto - 2, textAlign: 'left', border: 0, boxShadow: `inset 3px 0 0 ${ia ? 'var(--acento-claro)' : 'var(--ceniza)'}`, background: c.estado === 'CANCELADA' ? 'transparent' : ia ? 'var(--acento-tinte)' : 'var(--obsidiana)', color: 'var(--texto)', borderRadius: 10, padding: '4px 10px 4px 12px', overflow: 'hidden', cursor: 'pointer', fontSize: 13, lineHeight: 1.35, opacity: c.estado === 'CANCELADA' ? 0.5 : 1, textDecoration: c.estado === 'CANCELADA' ? 'line-through' : 'none' }}>
                        <span className="fila" style={{ gap: 6 }}><b className="mono">{c.hora}</b> {c.cliente}{ia && <span className="estado ia" style={{ height: 18, padding: '0 7px', fontSize: 12.5 }}>IA</span>}</span><span className="tenue">{c.servicio}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        )}
        <p className="tenue">Las citas creadas por el agente llevan la marca IA: se distingue lo automático de lo registrado a mano. Vista por {s.tenant.etiqueta_recurso?.toLowerCase() ?? 'recurso'}.</p>
      </div>
      {sel && (
        <Modal titulo={`${sel.hora} · ${sel.cliente}`} onCerrar={() => setSel(null)} pie={puede('appointment:create') && !['CANCELADA', 'ATENDIDA'].includes(sel.estado) ? <>
          {puede('appointment:cancel') && <button className="btn" onClick={() => run(() => api.patch(`/api/t/agenda/citas/${sel.id}`, { estado: 'CANCELADA' }), 'Cita cancelada').then(() => { setSel(null); recargar(); })}>Cancelar cita</button>}
          <button className="btn" onClick={() => run(() => api.patch(`/api/t/agenda/citas/${sel.id}`, { estado: 'NO_ASISTIO' }), 'Marcada').then(() => { setSel(null); recargar(); })}>No asistió</button>
          <button className="btn primario" onClick={() => run(() => api.patch(`/api/t/agenda/citas/${sel.id}`, { estado: 'ATENDIDA' }), 'Cita atendida').then(() => { setSel(null); recargar(); })}>Atendida</button>
        </> : undefined}>
          <div className="col"><span>{sel.servicio} con {sel.recurso} · {sel.hora}–{sel.hora_fin} · {cop(sel.precio)}</span><span className="fila"><Estado v={sel.estado} /> {sel.origen === 'AGENTE' && <Estado v="AGENTE" texto="Agendada por la IA" />}</span><span className="tenue">{sel.telefono}</span></div>
        </Modal>
      )}
      {nueva && <NuevaCita dia={dia} onCerrar={() => setNueva(false)} onCreada={() => { setNueva(false); recargar(); }} />}
    </>
  );
}

function NuevaCita({ dia, onCerrar, onCreada }: { dia: string; onCerrar: () => void; onCreada: () => void }) {
  const clientes = useApi<any[]>(() => api.get('/api/t/clientes'), []);
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const [f, setF] = useState<any>({ customer_id: '', product_id: '', fecha: dia });
  const servicios = (productos.data ?? []).filter((p) => p.tipo === 'SERVICIO' && p.duracion_min && p.activo);
  const franjas = useApi<any[]>(() => (f.product_id ? api.get(`/api/t/agenda/disponibilidad?servicio_id=${f.product_id}&fecha=${f.fecha}`) : Promise.resolve([])), [f.product_id, f.fecha]);
  const { run, ocupado } = useAccion();
  return (
    <Modal titulo="Nueva cita" onCerrar={onCerrar}>
      <Campo etiqueta="Cliente"><select className="input" value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })}><option value="">Elige…</option>{clientes.data?.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
      <div className="grid g2">
        <Campo etiqueta="Servicio"><select className="input" value={f.product_id} onChange={(e) => setF({ ...f, product_id: e.target.value })}><option value="">Elige…</option>{servicios.map((p) => <option key={p.id} value={p.id}>{p.nombre} · {p.duracion_min} min</option>)}</select></Campo>
        <Campo etiqueta="Fecha"><input className="input" type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
      </div>
      {f.product_id && (
        <div className="col"><span className="etiqueta">Franjas libres</span>
          {!franjas.data ? <Cargando filas={1} /> : franjas.data.length === 0 ? <span className="tenue">No hay espacio ese día.</span> : (
            <div className="fila envolver">{franjas.data.map((s) => <button key={s.inicio + s.recurso_id} className="btn peq" disabled={ocupado || !f.customer_id} onClick={async () => { const r = await run(() => api.post('/api/t/agenda/citas', { customer_id: f.customer_id, product_id: f.product_id, resource_id: s.recurso_id, inicio: s.inicio }), `Cita creada: ${s.hora} con ${s.recurso}`); if (r) onCreada(); }}>{s.hora} · {s.recurso}</button>)}</div>
          )}
          {!f.customer_id && <span className="tenue">Elige el cliente para reservar.</span>}
        </div>
      )}
    </Modal>
  );
}

// =================================================================== SCR-017 Facturación
export function Facturacion() {
  const { puede } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/facturacion'), [], { cada: 10000 });
  const [tab, setTab] = useState('');
  const { run, ocupado } = useAccion();
  if (error) return <><Cabecera titulo="Facturación electrónica" /><div className="contenido"><ErrorCarga error={error} /></div></>;
  if (!data) return <Cargando filas={8} />;
  const rechazadas = data.documentos.filter((d: any) => d.estado === 'RECHAZADO');
  const cuenta = (e: string) => data.resumen.find((r: any) => r.estado === e)?.n ?? 0;
  const lista = tab ? data.documentos.filter((d: any) => d.estado === tab) : data.documentos;
  return (
    <>
      <Cabecera titulo="Facturación electrónica" sub={data.resolucion ? `${data.resolucion.resolucion} · prefijo ${data.resolucion.prefijo} · ${data.resolucion.numero_desde}–${data.resolucion.numero_hasta} · siguiente ${data.resolucion.siguiente}` : ''} />
      <div className="contenido">
        {rechazadas.map((d: any) => (
          <section key={d.id} className="decision">
            <div className="cab"><Estado v="RECHAZADO" texto="Rechazada por la DIAN" /><span className="mono">{d.numero}</span><span className="tenue">venta #{d.orden} · {d.cliente}</span></div>
            <div className="cuerpo fila entre"><b>{d.motivo_rechazo}</b><div className="fila"><Link className="btn" to={`/ventas/${d.order_id}`}>Ver venta</Link>{puede('invoice:issue') && <button className="btn primario" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/facturacion/${d.id}/reintentar`), 'Reenviada a la DIAN').then(recargar)}>Reintentar</button>}</div></div>
          </section>
        ))}
        <div className="grid g4">
          <Cifra etiqueta="Validadas y entregadas" valor={cuenta('ENTREGADO') + cuenta('VALIDADO')} />
          <Cifra etiqueta="En trámite" valor={cuenta('PENDIENTE') + cuenta('ENVIADO')} />
          <Cifra etiqueta="Rechazadas" valor={cuenta('RECHAZADO')} />
          <Cifra etiqueta="Total facturado" valor={cop(data.documentos.filter((d: any) => d.tipo === 'FACTURA' && ['VALIDADO', 'ENTREGADO'].includes(d.estado)).reduce((a: number, d: any) => a + d.total, 0))} />
        </div>
        <div className="tabs">{[['', 'Todos'], ['ENTREGADO', 'Entregados'], ['PENDIENTE', 'Pendientes'], ['RECHAZADO', 'Rechazados']].map(([k, v]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{v}</button>)}</div>
        <section className="tarjeta">
          {lista.length === 0 ? <Vacio titulo="No hay documentos en esta vista">Cada venta confirmada genera su factura automáticamente.</Vacio> : (
            <div className="tabla-wrap"><table className="tabla">
              <thead><tr><th>Número</th><th>Tipo</th><th>Fecha</th><th>Cliente</th><th className="num">Total</th><th>Estado DIAN</th><th>CUFE</th><th>WhatsApp</th><th>Correo</th></tr></thead>
              <tbody>{lista.map((d: any) => (
                <tr key={d.id} className="clic" onClick={() => window.location.assign(`/ventas/${d.order_id}`)}>
                  <td className="mono">{d.numero}</td><td>{d.tipo === 'FACTURA' ? 'Factura' : 'Nota crédito'}</td><td>{fechaHora(d.creado_en)}</td><td>{d.cliente}</td>
                  <td className="num">{cop(d.total)}</td><td><Estado v={d.estado} /></td>
                  <td className="mono tenue">{d.cufe ? `${d.cufe.slice(0, 10)}…` : '—'}</td>
                  <td><Estado v={d.entrega_whatsapp === 'ENVIADO' ? 'ENTREGADO' : d.entrega_whatsapp} texto={d.entrega_whatsapp.toLowerCase().replace('_', ' ')} /></td>
                  <td><Estado v={d.entrega_email} texto={d.entrega_email.toLowerCase().replace('_', ' ')} /></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <p className="tenue">Un documento validado por la DIAN no se borra ni se edita: se anula emitiendo una nota crédito desde el detalle de la venta. Emisión a través de proveedor tecnológico habilitado (entorno de pruebas).</p>
      </div>
    </>
  );
}
