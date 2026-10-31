import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cop } from '../../api';
import { Cabecera, Escritura, useSesion } from '../../components/Layout';
import { Cargando, ErrorCarga, Modal, useAccion, useApi, useRetardo, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { CamposCobro, CobroExitoso, cuerpoPago, type Metodos, nuevaClave, type PagoElegido, validarPago } from '../../components/Cobro';
import { descargarComprobante } from './Comprobantes';

/**
 * Punto de venta: cuadrícula de productos y servicios con imagen, buscador, categorías como pestañas, carrito con
 * cantidades y descuento por línea o total, cliente (buscador o «cliente de mostrador»), medio de pago y total
 * grande. Los importes los calcula el servidor con el catálogo; aquí solo se estima. Si la empresa lo configuró,
 * el comprobante se genera al confirmar (regla del sistema, no de la IA) y se ofrece enviarlo.
 */
interface Linea { product_id: string; cantidad: number; descuento_pct: number }

export function Vender() {
  const { puede } = useSesion();
  const toast = useToast();
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const cobra = puede('payment:register');
  const metodos = useApi<Metodos | null>(() => (cobra ? api.get('/api/t/cobros/metodos') : Promise.resolve(null)), [cobra]);
  const [q, setQ] = useState('');
  const qr = useRetardo(q, 150);
  const [cat, setCat] = useState('');
  const [carrito, setCarrito] = useState<Linea[]>([]);
  const [descTotal, setDescTotal] = useState(0);
  const [cliente, setCliente] = useState<any>(null);
  const [buscarCliente, setBuscarCliente] = useState(false);
  const [pago, setPago] = useState<PagoElegido>({ metodo: 'DESPUES', recibido: '', referencia: '' });
  const [clave, setClave] = useState(nuevaClave);
  const [hecha, setHecha] = useState<any>(null);
  const { run, ocupado, error, limpiarError } = useAccion();
  useEffect(() => { if (metodos.data?.EFECTIVO) setPago((p) => (p.metodo === 'DESPUES' ? { ...p, metodo: 'EFECTIVO' } : p)); }, [metodos.data]);

  const activos = useMemo(() => (productos.data ?? []).filter((p) => p.activo), [productos.data]);
  const categorias = useMemo(() => [...new Set(activos.map((p) => p.categoria).filter(Boolean))] as string[], [activos]);
  const visibles = activos.filter((p) => (!cat || p.categoria === cat) && (!qr || `${p.nombre} ${p.sku ?? ''}`.toLowerCase().includes(qr.toLowerCase())));
  const prod = (id: string) => activos.find((p) => p.id === id);
  const subtotal = carrito.reduce((a, l) => a + (prod(l.product_id)?.precio ?? 0) * l.cantidad * (1 - (l.descuento_pct || descTotal || 0) / 100), 0);
  const total = Math.round(subtotal);
  const errorPago = carrito.length ? validarPago(pago, total) : null;
  const sinStock = carrito.find((l) => { const p = prod(l.product_id); return p?.controla_stock && l.cantidad > p.stock; });

  const agregar = (id: string) => setCarrito((c) => { const i = c.findIndex((l) => l.product_id === id); if (i >= 0) { const n = [...c]; n[i] = { ...n[i], cantidad: n[i].cantidad + 1 }; return n; } return [...c, { product_id: id, cantidad: 1, descuento_pct: 0 }]; });
  const cambiar = (id: string, campo: 'cantidad' | 'descuento_pct', v: number) => setCarrito((c) => c.map((l) => (l.product_id === id ? { ...l, [campo]: v } : l)).filter((l) => l.cantidad > 0));
  const nueva = () => { setHecha(null); setCarrito([]); setDescTotal(0); setCliente(null); setClave(nuevaClave()); setPago({ metodo: metodos.data?.EFECTIVO ? 'EFECTIVO' : 'DESPUES', recibido: '', referencia: '' }); limpiarError(); productos.recargar(); };
  const confirmar = async () => {
    const cuerpo = cobra ? cuerpoPago(pago, clave) : null;
    const r = await run(() => api.post('/api/t/ventas', {
      ...(cliente ? { customer_id: cliente.id } : { mostrador: true }), descuento_total_pct: descTotal || undefined,
      items: carrito.map((l) => ({ product_id: l.product_id, cantidad: l.cantidad, ...(l.descuento_pct ? { descuento_pct: l.descuento_pct } : {}) })), ...(cuerpo ? { pago: cuerpo } : {}),
    }), undefined, { silencioso: true });
    if (r) setHecha(r);
  };

  return (
    <>
      <Cabecera titulo="Vender" sub="Toca un producto para agregarlo. El total lo confirma el servidor con tu catálogo.">
        <Link className="btn sutil" to="/ventas"><Icon n="ventas" className="" size={16} />Ver ventas</Link>
      </Cabecera>
      <div className="contenido pos">
        {productos.error ? <ErrorCarga error={productos.error} reintentar={productos.recargar} /> : !productos.data ? <Cargando filas={6} /> : (
          <div className="pos-rejilla">
            <section className="pos-catalogo" aria-label="Catálogo">
              <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" autoFocus placeholder="Buscar producto o servicio" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar producto" /></label>
              {categorias.length > 0 && <div className="tabs pos-cats" role="tablist" aria-label="Categorías">
                <button role="tab" aria-selected={!cat} className={!cat ? 'on' : ''} onClick={() => setCat('')}>Todo</button>
                {categorias.map((c) => <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
              </div>}
              <div className="pos-productos">
                {visibles.map((p) => {
                  const agotado = p.controla_stock && p.stock <= 0;
                  return (
                    <button key={p.id} className="pos-producto" disabled={agotado} onClick={() => agregar(p.id)} aria-label={`Agregar ${p.nombre}, ${cop(p.precio)}`}>
                      <span className="pos-img">{p.imagen ? <img src={p.imagen} alt="" loading="lazy" /> : <Icon n={p.tipo === 'SERVICIO' ? 'agenda' : 'inventario'} className="" size={28} />}</span>
                      <b>{p.nombre}</b>
                      <span className="pos-precio">{cop(p.precio)}</span>
                      {p.controla_stock && <span className={`tenue peq-txt ${agotado ? 'error' : ''}`}>{agotado ? 'Agotado' : `Quedan ${p.stock}`}</span>}
                    </button>
                  );
                })}
                {!visibles.length && <p className="tenue">Nada coincide con la búsqueda.</p>}
              </div>
            </section>
            <aside className="pos-carrito tarjeta" aria-label="Carrito">
              <div className="cuerpo col" style={{ gap: 10 }}>
                <div className="fila entre"><span>Cliente: <b>{cliente ? cliente.nombre : 'Cliente de mostrador'}</b></span><button className="btn peq sutil" onClick={() => setBuscarCliente(true)}>{cliente ? 'Cambiar' : 'Elegir cliente'}</button></div>
                {!carrito.length ? <p className="tenue">Toca los productos para agregarlos.</p> : (
                  <ul className="pos-lineas">{carrito.map((l) => {
                    const p = prod(l.product_id);
                    return (
                      <li key={l.product_id}>
                        <span className="col" style={{ gap: 2, minWidth: 0 }}><b className="cortar">{p?.nombre}</b><span className="tenue peq-txt">{cop(p?.precio ?? 0)} c/u</span></span>
                        <span className="pos-cant">
                          <button className="btn peq" aria-label="Quitar uno" onClick={() => cambiar(l.product_id, 'cantidad', l.cantidad - 1)}>−</button>
                          <span aria-live="polite">{l.cantidad}</span>
                          <button className="btn peq" aria-label="Agregar uno" onClick={() => cambiar(l.product_id, 'cantidad', l.cantidad + 1)}>+</button>
                        </span>
                        <label className="pos-desc">Desc. %<input className="input" type="number" min={0} max={100} value={l.descuento_pct || ''} onChange={(e) => cambiar(l.product_id, 'descuento_pct', Math.min(100, Math.max(0, Number(e.target.value) || 0)))} /></label>
                      </li>
                    );
                  })}</ul>
                )}
                <label className="fila entre peq-txt">Descuento a toda la venta (%)<input className="input" style={{ width: 90 }} type="number" min={0} max={100} value={descTotal || ''} onChange={(e) => setDescTotal(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} /></label>
                <div className="pos-total"><span>Total</span><b>{cop(total)}</b></div>
                {sinStock && <div className="aviso" role="alert"><Icon n="alerta" className="" size={16} />No hay suficientes existencias de {prod(sinStock.product_id)?.nombre}.</div>}
                {cobra && carrito.length > 0 && <CamposCobro metodos={metodos.data} total={total} valor={pago} onCambio={setPago} />}
                {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
                <Escritura permiso="order:create" modulo="ventas"><button className="btn primario grande" disabled={ocupado || !carrito.length || !!errorPago || !!sinStock} onClick={confirmar}>{ocupado ? 'Registrando…' : `Cobrar ${cop(total)}`}</button></Escritura>
              </div>
            </aside>
          </div>
        )}
      </div>
      {buscarCliente && <ElegirCliente onCerrar={() => setBuscarCliente(false)} onElegir={(c) => { setCliente(c); setBuscarCliente(false); }} />}
      {hecha && (
        <Modal titulo={`Venta #${hecha.numero}`} onCerrar={nueva} pie={<><Link className="btn" to={`/ventas/${hecha.id}`}>Ver la venta</Link><button className="btn primario" onClick={nueva}>Nueva venta</button></>}>
          <CobroExitoso titulo={hecha.pago ? 'Venta pagada' : 'Venta registrada (por cobrar)'} pago={hecha.pago} total={hecha.total}>
            {hecha.comprobante ? <div className="col" style={{ gap: 8 }}>
              <span>Comprobante <b className="mono">{hecha.comprobante.numero}</b> generado.</span>
              <span className="fila envolver" style={{ gap: 6 }}>
                <button className="btn peq" onClick={() => descargarComprobante(hecha.comprobante).catch((e) => toast(e.message, true))}><Icon n="descargar" className="" size={14} />PDF</button>
                <EnviarComprobante id={hecha.comprobante.id} />
              </span>
            </div> : null}
          </CobroExitoso>
        </Modal>
      )}
    </>
  );
}

function EnviarComprobante({ id }: { id: string }) {
  const { run, ocupado } = useAccion();
  return (
    <>
      <Escritura permiso="comprobante:send"><button className="btn peq" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/comprobantes/${id}/reenviar`, { canal: 'WHATSAPP' }), 'Comprobante enviado por WhatsApp')}>Enviar por WhatsApp</button></Escritura>
      <Escritura permiso="comprobante:send"><button className="btn peq" disabled={ocupado} onClick={() => run(() => api.post(`/api/t/comprobantes/${id}/reenviar`, { canal: 'CORREO' }), 'Comprobante enviado por correo')}>Enviar por correo</button></Escritura>
    </>
  );
}

function ElegirCliente({ onCerrar, onElegir }: { onCerrar: () => void; onElegir: (c: any) => void }) {
  const [q, setQ] = useState('');
  const qr = useRetardo(q, 250);
  const { data } = useApi<any>(() => api.get(`/api/t/clientes?por_pagina=12${qr ? `&q=${encodeURIComponent(qr)}` : ''}`), [qr]);
  const [nuevo, setNuevo] = useState(false);
  const [tel, setTel] = useState('');
  const { run, ocupado } = useAccion();
  return (
    <Modal titulo="Elegir cliente" onCerrar={onCerrar} pie={<button className="btn" onClick={() => onElegir(null)}>Cliente de mostrador</button>}>
      <input className="input" autoFocus placeholder="Nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cliente" />
      <ul className="lista seleccion">{(data?.clientes ?? []).map((c: any) => <li key={c.id}><button className="enlace" onClick={() => onElegir(c)}>{c.nombre}{c.telefono ? ` · ${c.telefono}` : ''}</button></li>)}</ul>
      {nuevo ? <div className="fila envolver" style={{ gap: 6 }}><input className="input" placeholder="Teléfono (opcional)" value={tel} onChange={(e) => setTel(e.target.value)} />
        <button className="btn primario" disabled={ocupado || q.trim().length < 2} onClick={async () => { const r = await run(() => api.post('/api/t/clientes', { nombre: q.trim(), telefono: tel.trim() || null })); if (r) onElegir({ id: r.id, nombre: q.trim() }); }}>Crear «{q.trim()}»</button></div>
        : <button className="btn peq sutil" onClick={() => setNuevo(true)}><Icon n="mas" className="" size={14} />Cliente nuevo</button>}
    </Modal>
  );
}
