import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api, cop, fechaHora, guardar, leer, tenantSlug, urlArchivo } from '../../api';
import { Cabecera, Escritura, useSesion } from '../../components/Layout';
import { Cargando, Confirmar, ErrorCarga, Modal, Vacio, useAccion, useApi, useRetardo, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { CamposCobro, CobroExitoso, cuerpoPago, type Metodos, NOMBRE_METODO, nuevaClave, type PagoElegido, validarPago } from '../../components/Cobro';
import { Contador, movimientoReducido } from '../../components/Movimiento';
import { descargarComprobante } from './Comprobantes';
import { PestanasVentas } from './ventas/Pestanas';

/**
 * Punto de venta. Pensado para el mostrador: buscador con foco (y lector de código de barras), tarjetas grandes con
 * imagen, un toque agrega, mantener presionado elige la cantidad, carrito con cantidades editables, descuento por
 * línea o al total, nota por línea, ventas en espera, cliente (recientes, buscar, crear o mostrador), cobro con
 * cambio, atajos de teclado y deshacer. Los importes los calcula el servidor con el catálogo; aquí solo se estima.
 * Si la empresa lo configuró, el comprobante se genera al confirmar (regla del sistema, no de la IA).
 */
interface Linea { product_id: string; cantidad: number; descuento_pct: number; nota: string }
interface Venta { carrito: Linea[]; descTotal: number; cliente: any | null }
interface Espera { id: string; en: number; venta: Venta }
const VACIA: Venta = { carrito: [], descTotal: 0, cliente: null };
const claveEspera = () => `omnegia.pos.espera.${tenantSlug() ?? 'local'}`;
const leerEspera = (): Espera[] => { try { const v = JSON.parse(leer(claveEspera()) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
const ATAJOS: [string, string][] = [['F2', 'Buscar un producto'], ['Enter', 'Agregar el primer resultado (o el SKU escaneado)'], ['F4', 'Elegir el cliente'], ['F9', 'Cobrar'], ['Ctrl + Z', 'Deshacer la última acción del carrito'], ['Esc', 'Vaciar el carrito'], ['?', 'Ver esta ayuda']];

/** ¿Pantalla de celular? (el carrito pasa a ser una hoja inferior fija a la pantalla) */
function useMovil() {
  const q = '(max-width: 900px)';
  const [m, setM] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const mq = window.matchMedia(q); const f = () => setM(mq.matches); mq.addEventListener('change', f); return () => mq.removeEventListener('change', f); }, []);
  return m;
}

export function Vender() {
  const movil = useMovil();
  const { s, puede } = useSesion();
  const toast = useToast();
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const cobra = puede('payment:register');
  const metodos = useApi<Metodos | null>(() => (cobra ? api.get('/api/t/cobros/metodos') : Promise.resolve(null)), [cobra]);
  const recientes = useApi<any>(() => api.get('/api/t/clientes?por_pagina=10&orden=reciente'), []);
  const [q, setQ] = useState('');
  const qr = useRetardo(q, 120);
  const [cat, setCat] = useState('');
  const [venta, setVenta] = useState<Venta>(VACIA);
  const [pasados, setPasados] = useState<Venta[]>([]);
  const [espera, setEspera] = useState<Espera[]>(leerEspera);
  const [buscarCliente, setBuscarCliente] = useState(false);
  const [cantidadDe, setCantidadDe] = useState<any>(null);
  const [ayuda, setAyuda] = useState(false);
  const [vaciar, setVaciar] = useState(false);
  const [hoja, setHoja] = useState(false);
  const [pago, setPago] = useState<PagoElegido>({ metodo: 'DESPUES', recibido: '', referencia: '' });
  const [clave, setClave] = useState(nuevaClave);
  const [hecha, setHecha] = useState<any>(null);
  const [pulso, setPulso] = useState(0);
  const { run, ocupado, error, limpiarError } = useAccion();
  const buscador = useRef<HTMLInputElement>(null);
  const destino = useRef<HTMLElement>(null);
  const { carrito, descTotal, cliente } = venta;
  useEffect(() => { if (metodos.data?.EFECTIVO) setPago((p) => (p.metodo === 'DESPUES' ? { ...p, metodo: 'EFECTIVO' } : p)); }, [metodos.data]);

  const activos = useMemo(() => (productos.data ?? []).filter((p) => p.activo), [productos.data]);
  const categorias = useMemo(() => [...new Set(activos.map((p) => p.categoria).filter(Boolean))] as string[], [activos]);
  const visibles = useMemo(() => activos.filter((p) => (!cat || p.categoria === cat) && (!qr || `${p.nombre} ${p.sku ?? ''} ${p.categoria ?? ''}`.toLowerCase().includes(qr.toLowerCase()))), [activos, cat, qr]);
  const prod = (id: string) => activos.find((p) => p.id === id);
  const total = Math.round(carrito.reduce((a, l) => a + (prod(l.product_id)?.precio ?? 0) * l.cantidad * (1 - (l.descuento_pct || descTotal || 0) / 100), 0));
  const unidades = carrito.reduce((a, l) => a + l.cantidad, 0);
  const errorPago = carrito.length ? validarPago(pago, total) : null;
  const sinStock = carrito.find((l) => { const p = prod(l.product_id); return p?.controla_stock && l.cantidad > p.stock; });
  const puedeCobrar = !ocupado && carrito.length > 0 && !errorPago && !sinStock;
  const clientesRecientes = ((recientes.data?.clientes ?? []) as any[]).filter((c) => c.nombre !== 'Cliente de mostrador').slice(0, 5);

  /** Todo cambio del carrito pasa por aquí: guarda el estado anterior para poder deshacer. */
  const cambiar = useCallback((fn: (v: Venta) => Venta) => {
    setVenta((v) => { const n = fn(v); if (n !== v) setPasados((p) => [...p.slice(-29), v]); return n; });
  }, []);
  const deshacer = useCallback(() => {
    setPasados((p) => { if (!p.length) return p; setVenta(p[p.length - 1]); return p.slice(0, -1); });
  }, []);

  /** Un punto sale del producto hacia el carrito: la persona ve a dónde fue lo que tocó. */
  const volar = (desde: Element | null) => {
    setPulso((n) => n + 1);
    const a = destino.current;
    if (!desde || !a || movimientoReducido() || !('animate' in HTMLElement.prototype)) return;
    const o = desde.getBoundingClientRect(), d = a.getBoundingClientRect();
    if (!d.width) return;
    const punto = document.createElement('span');
    punto.className = 'pos-vuelo';
    punto.style.left = `${o.left + o.width / 2 - 9}px`;
    punto.style.top = `${o.top + o.height / 2 - 9}px`;
    document.body.appendChild(punto);
    const dx = d.left + d.width / 2 - (o.left + o.width / 2), dy = d.top + d.height / 2 - (o.top + o.height / 2);
    punto.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(.3)`, opacity: .2 }], { duration: 420, easing: 'cubic-bezier(.4,0,.2,1)' }).finished.finally(() => punto.remove());
  };
  const agregar = (id: string, n = 1, desde: Element | null = null) => {
    const p = prod(id);
    if (!p || n <= 0) return;
    cambiar((v) => {
      const i = v.carrito.findIndex((l) => l.product_id === id);
      if (i >= 0) { const c = [...v.carrito]; c[i] = { ...c[i], cantidad: c[i].cantidad + n }; return { ...v, carrito: c }; }
      return { ...v, carrito: [...v.carrito, { product_id: id, cantidad: n, descuento_pct: 0, nota: '' }] };
    });
    volar(desde);
  };
  const editar = (id: string, campo: keyof Linea, v: number | string) => cambiar((x) => ({ ...x, carrito: x.carrito.map((l) => (l.product_id === id ? { ...l, [campo]: v } : l)).filter((l) => l.cantidad > 0) }));
  const quitar = (id: string) => cambiar((x) => ({ ...x, carrito: x.carrito.filter((l) => l.product_id !== id) }));

  const nueva = () => { setHecha(null); setVenta(VACIA); setPasados([]); setClave(nuevaClave()); setPago({ metodo: metodos.data?.EFECTIVO ? 'EFECTIVO' : 'DESPUES', recibido: '', referencia: '' }); limpiarError(); productos.recargar(); recientes.recargar(); setHoja(false); setTimeout(() => buscador.current?.focus(), 50); };
  const confirmar = async () => {
    if (!puedeCobrar) return;
    const cuerpo = cobra ? cuerpoPago(pago, clave) : null;
    const r = await run(() => api.post('/api/t/ventas', {
      ...(cliente ? { customer_id: cliente.id } : { mostrador: true }), descuento_total_pct: descTotal || undefined,
      items: carrito.map((l) => ({ product_id: l.product_id, cantidad: l.cantidad, ...(l.descuento_pct ? { descuento_pct: l.descuento_pct } : {}), ...(l.nota.trim() ? { nota: l.nota.trim() } : {}) })), ...(cuerpo ? { pago: cuerpo } : {}),
    }), undefined, { silencioso: true });
    if (r) setHecha({ ...r, cliente_datos: cliente, lineas: carrito.map((l) => ({ ...l, nombre: prod(l.product_id)?.nombre ?? '' })) });
  };

  // Ventas en espera (se guardan en este navegador): apartar el carrito y retomarlo cuando llegue el siguiente cliente.
  const guardarEspera = (lista: Espera[]) => { setEspera(lista); guardar(claveEspera(), lista.length ? JSON.stringify(lista) : null); };
  const apartar = () => {
    if (!carrito.length) return;
    guardarEspera([...espera, { id: nuevaClave(), en: Date.now(), venta }]);
    setVenta(VACIA); setPasados([]); setHoja(false);
    toast('Venta apartada. La encuentras en «En espera».');
    buscador.current?.focus();
  };
  const retomar = (e: Espera) => {
    const resto = espera.filter((x) => x.id !== e.id);
    const actual: Espera[] = carrito.length ? [{ id: nuevaClave(), en: Date.now(), venta }] : [];
    guardarEspera([...resto, ...actual]);
    setVenta({ ...e.venta, carrito: e.venta.carrito.filter((l) => prod(l.product_id)) }); setPasados([]);
  };

  // Buscador: Enter agrega el SKU exacto (lector de código de barras) o, si no, el primer resultado.
  const alEnter = () => {
    const t = q.trim().toLowerCase();
    if (!t) return;
    const exacto = activos.find((p) => p.sku && String(p.sku).toLowerCase() === t);
    const elegido = exacto ?? visibles[0];
    if (!elegido) { toast('Ese producto no está en el catálogo.', true); return; }
    if (elegido.controla_stock && elegido.stock <= 0) { toast(`${elegido.nombre} está agotado.`, true); return; }
    agregar(elegido.id, 1, buscador.current);
    setQ('');
  };

  // Atajos de teclado (no actúan mientras hay un diálogo abierto).
  const dialogo = buscarCliente || !!cantidadDe || ayuda || vaciar || !!hecha;
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      const escribiendo = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
      if (dialogo) return;
      if (e.key === 'F2') { e.preventDefault(); buscador.current?.focus(); buscador.current?.select(); }
      else if (e.key === 'F4') { e.preventDefault(); setBuscarCliente(true); }
      else if (e.key === 'F9') { e.preventDefault(); confirmar(); }
      else if (e.key === 'Escape' && carrito.length) { setVaciar(true); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !escribiendo) { e.preventDefault(); deshacer(); }
      else if (e.key === '?' && !escribiendo) { e.preventDefault(); setAyuda(true); }
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  });

  // Sin hoja inferior abierta en pantallas grandes.
  useEffect(() => { if (hecha || buscarCliente) setHoja(false); }, [hecha, buscarCliente]);

  const carritoAside = (
            <aside className={`pos-carrito tarjeta ${hoja ? 'abierta' : ''}`} aria-label="Carrito">
              <HojaAsa abierta={hoja} onAlternar={setHoja} unidades={unidades} total={total} />
              <div className="cuerpo col pos-carrito-cuerpo" style={{ gap: 10 }}>
                <div data-guia="venta/cliente" className="col" style={{ gap: 6 }}>
                  <div className="fila entre"><span>Cliente: <b>{cliente ? cliente.nombre : 'Cliente de mostrador'}</b></span><button className="btn peq sutil" onClick={() => setBuscarCliente(true)}>{cliente ? 'Cambiar' : 'Elegir cliente'} <kbd className="tecla">F4</kbd></button></div>
                  <div className="chips-filtro" role="group" aria-label="Clientes recientes">
                    <button type="button" className={`chip ${!cliente ? 'on' : ''}`} aria-pressed={!cliente} onClick={() => cambiar((v) => ({ ...v, cliente: null }))}>Mostrador</button>
                    {clientesRecientes.map((c) => <button key={c.id} type="button" className={`chip ${cliente?.id === c.id ? 'on' : ''}`} aria-pressed={cliente?.id === c.id} onClick={() => cambiar((v) => ({ ...v, cliente: c }))}>{c.nombre.split(' ').slice(0, 2).join(' ')}</button>)}
                  </div>
                </div>
                {espera.length > 0 && (
                  <div className="pos-espera" role="group" aria-label="Ventas en espera">
                    <b className="peq-txt">En espera</b>
                    {espera.map((e, i) => (
                      <span key={e.id} className="chip-doble">
                        <button type="button" className="chip" onClick={() => retomar(e)} title={`Apartada a las ${new Date(e.en).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`}>{i + 1}. {e.venta.cliente?.nombre?.split(' ')[0] ?? 'Mostrador'} · {e.venta.carrito.length} {e.venta.carrito.length === 1 ? 'ítem' : 'ítems'}</button>
                        <button type="button" className="chip" aria-label={`Descartar la venta en espera ${i + 1}`} onClick={() => guardarEspera(espera.filter((x) => x.id !== e.id))}><Icon n="x" className="" size={10} /></button>
                      </span>
                    ))}
                  </div>
                )}
                {!carrito.length ? <p className="tenue">Toca los productos para agregarlos, o escribe y pulsa Enter.</p> : (
                  <ul className="pos-lineas">{carrito.map((l) => <LineaCarrito key={l.product_id} l={l} p={prod(l.product_id)} onEditar={editar} onQuitar={quitar} />)}</ul>
                )}
                <div className="fila entre envolver" style={{ gap: 6 }}>
                  <label className="fila peq-txt" style={{ gap: 6 }}>Descuento a toda la venta (%)<input className="input" style={{ width: 78 }} type="number" min={0} max={100} value={descTotal || ''} onChange={(e) => cambiar((v) => ({ ...v, descTotal: Math.min(100, Math.max(0, Number(e.target.value) || 0)) }))} /></label>
                  <span className="fila" style={{ gap: 4 }}>
                    <button className="btn peq sutil" onClick={deshacer} disabled={!pasados.length} title="Deshacer (Ctrl + Z)"><Icon n="atras" className="" size={14} />Deshacer</button>
                    <button className="btn peq sutil" onClick={apartar} disabled={!carrito.length} title="Guardar esta venta y atender a otro cliente">Apartar</button>
                  </span>
                </div>
                <div className="pos-total" ref={destino as any}><span>Total</span><b key={pulso} className="pos-total-cifra"><Contador valor={total} formato={cop} ms={380} desdeCero={false} /></b></div>
                {sinStock && <div className="aviso" role="alert"><Icon n="alerta" className="" size={16} />No hay suficientes existencias de {prod(sinStock.product_id)?.nombre}.</div>}
                {cobra && carrito.length > 0 && <div data-guia="venta/cobro"><CamposCobro metodos={metodos.data} total={total} valor={pago} onCambio={setPago} /></div>}
                {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
                <Escritura permiso="order:create" modulo="ventas"><button className="btn primario grande" data-guia="venta/registrar" disabled={!puedeCobrar} onClick={confirmar}>{ocupado ? 'Registrando…' : `Cobrar ${cop(total)}`} <kbd className="tecla">F9</kbd></button></Escritura>
                {carrito.length > 0 && <button className="btn sutil" onClick={() => setVaciar(true)}>Vaciar el carrito</button>}
              </div>
            </aside>
  );

  return (
    <>
      <Cabecera titulo="Ventas" sub="Toca un producto para agregarlo. El total lo confirma el servidor con tu catálogo." pestanas={<PestanasVentas activa="vender" />}>
        <button className="btn sutil" onClick={() => setAyuda(true)} aria-label="Atajos de teclado"><kbd className="tecla">?</kbd>Atajos</button>
      </Cabecera>
      <div className="contenido pos">
        {productos.error ? <ErrorCarga error={productos.error} reintentar={productos.recargar} /> : !productos.data ? <Cargando filas={6} /> : activos.length === 0 ? (
          <Vacio titulo="Todavía no tienes productos ni servicios para vender" accion={<span className="fila envolver" style={{ gap: 8 }}><Link className="btn primario" to="/inventario">Crear productos</Link><Link className="btn" to="/inventario">Importar desde Excel</Link></span>}>
            El punto de venta se arma con tu catálogo. Crea tus productos o impórtalos y vuelve aquí.
          </Vacio>
        ) : (
          <div className="pos-rejilla">
            <section className="pos-catalogo" aria-label="Catálogo">
              <label className="buscar"><Icon n="buscar" className="" size={16} />
                <input ref={buscador} type="search" autoFocus placeholder="Buscar o escanear un producto (Enter para agregar)" value={q} onChange={(e) => setQ(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); alEnter(); } }} aria-label="Buscar producto" enterKeyHint="done" autoComplete="off" />
              </label>
              <div className="pos-atajos" aria-label="Atajos de teclado">
                <span><kbd className="tecla">F2</kbd> Buscar</span><span><kbd className="tecla">F4</kbd> Cliente</span><span><kbd className="tecla">F9</kbd> Cobrar</span><span><kbd className="tecla">Esc</kbd> Vaciar</span>
                <button type="button" className="enlace" onClick={() => setAyuda(true)}>Ver todos</button>
              </div>
              {categorias.length > 0 && <div className="tabs pos-cats" role="tablist" aria-label="Categorías">
                <button role="tab" aria-selected={!cat} className={!cat ? 'on' : ''} onClick={() => setCat('')}>Todo</button>
                {categorias.map((c) => <button key={c} role="tab" aria-selected={cat === c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>{c}</button>)}
              </div>}
              <div className="pos-productos" data-guia="venta/items">
                {visibles.map((p) => <TarjetaProducto key={p.id} p={p} enCarrito={carrito.find((l) => l.product_id === p.id)?.cantidad ?? 0} alAgregar={(el) => agregar(p.id, 1, el)} alElegirCantidad={() => setCantidadDe(p)} />)}
                {!visibles.length && <p className="tenue">Nada coincide con «{q}».</p>}
              </div>
            </section>

            {movil ? createPortal(carritoAside, document.body) : carritoAside}
          </div>
        )}
      </div>

      {buscarCliente && <ElegirCliente recientes={clientesRecientes} onCerrar={() => setBuscarCliente(false)} onElegir={(c) => { cambiar((v) => ({ ...v, cliente: c })); setBuscarCliente(false); }} />}
      {cantidadDe && <ElegirCantidad p={cantidadDe} actual={carrito.find((l) => l.product_id === cantidadDe.id)?.cantidad ?? 0} onCerrar={() => setCantidadDe(null)} onAgregar={(n) => { agregar(cantidadDe.id, n, null); setCantidadDe(null); }} />}
      {ayuda && <Modal titulo="Atajos de teclado" onCerrar={() => setAyuda(false)} pie={<button className="btn primario" onClick={() => setAyuda(false)}>Entendido</button>}>
        <dl className="datos-def">{ATAJOS.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt><kbd className="tecla">{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        <p className="tenue peq-txt">Con un lector de código de barras: escanea y el producto con ese SKU se agrega solo. En el celular, usa los botones en pantalla.</p>
      </Modal>}
      {vaciar && <Confirmar titulo="Vaciar el carrito" riesgo="confirmable" textoBoton="Vaciar" efecto={<>Se quitan los {carrito.length} productos del carrito. Puedes deshacerlo con <kbd className="tecla">Ctrl + Z</kbd>.</>} onCerrar={() => setVaciar(false)} onConfirmar={async () => { setVaciar(false); cambiar(() => VACIA); }} />}
      {hecha && <ExitoVenta hecha={hecha} empresa={s.tenant.nombre} onNueva={nueva} />}
    </>
  );
}

function TarjetaProducto({ p, enCarrito, alAgregar, alElegirCantidad }: { p: any; enCarrito: number; alAgregar: (el: Element) => void; alElegirCantidad: () => void }) {
  const agotado = p.controla_stock && p.stock <= 0;
  const largo = useRef<number | null>(null);
  const fueLargo = useRef(false);
  const ref = useRef<HTMLButtonElement>(null);
  const empezar = () => { fueLargo.current = false; largo.current = window.setTimeout(() => { fueLargo.current = true; alElegirCantidad(); }, 550); };
  const soltar = () => { if (largo.current) window.clearTimeout(largo.current); largo.current = null; };
  return (
    <div className={`pos-tarjeta ${enCarrito ? 'en-carrito' : ''}`}>
      <button ref={ref} className="pos-producto" disabled={agotado} aria-label={`Agregar ${p.nombre}, ${cop(p.precio)}`}
        onPointerDown={empezar} onPointerUp={soltar} onPointerLeave={soltar} onPointerCancel={soltar} onContextMenu={(e) => e.preventDefault()}
        onClick={() => { if (fueLargo.current) { fueLargo.current = false; return; } if (ref.current) alAgregar(ref.current); }}>
        <span className="pos-img">{p.imagen ? <img src={urlArchivo(p.imagen)} alt="" loading="lazy" /> : <Icon n={p.tipo === 'SERVICIO' ? 'agenda' : 'inventario'} className="" size={32} />}</span>
        <b>{p.nombre}</b>
        <span className="pos-precio">{cop(p.precio)}</span>
        {p.controla_stock && <span className={`peq-txt ${agotado ? 'error' : p.stock <= (p.stock_minimo ?? 0) ? 'aviso-stock' : 'tenue'}`}>{agotado ? 'Agotado' : `Quedan ${p.stock}`}</span>}
      </button>
      {enCarrito > 0 && <span className="pos-cuenta" aria-label={`${enCarrito} en el carrito`}>{enCarrito}</span>}
      {!agotado && <button type="button" className="pos-mas" aria-label={`Elegir la cantidad de ${p.nombre}`} onClick={alElegirCantidad}><Icon n="mas" className="" size={14} /></button>}
    </div>
  );
}

function LineaCarrito({ l, p, onEditar, onQuitar }: { l: Linea; p: any; onEditar: (id: string, campo: keyof Linea, v: number | string) => void; onQuitar: (id: string) => void }) {
  const [nota, setNota] = useState(!!l.nota);
  const paso = (d: number) => onEditar(l.product_id, 'cantidad', Math.max(0, Math.round((l.cantidad + d) * 100) / 100));
  return (
    <li className="pos-linea">
      <span className="col" style={{ gap: 2, minWidth: 0 }}><b className="cortar">{p?.nombre}</b><span className="tenue peq-txt">{cop(p?.precio ?? 0)} c/u · <b>{cop(Math.round((p?.precio ?? 0) * l.cantidad * (1 - l.descuento_pct / 100)))}</b></span></span>
      <span className="pos-cant">
        <button className="btn peq" aria-label={`Quitar uno de ${p?.nombre}`} onClick={() => paso(-1)}>−</button>
        <input className="input pos-cant-campo" type="number" inputMode="decimal" min={0} step={p?.tipo === 'SERVICIO' ? 1 : 'any'} value={l.cantidad} aria-label={`Cantidad de ${p?.nombre}`} onChange={(e) => onEditar(l.product_id, 'cantidad', Math.max(0, Number(e.target.value) || 0))} />
        <button className="btn peq" aria-label={`Agregar uno de ${p?.nombre}`} onClick={() => paso(1)}>+</button>
      </span>
      <span className="pos-desc">
        <label>Desc. %<input className="input" type="number" min={0} max={100} value={l.descuento_pct || ''} onChange={(e) => onEditar(l.product_id, 'descuento_pct', Math.min(100, Math.max(0, Number(e.target.value) || 0)))} /></label>
        <button type="button" className="enlace" aria-expanded={nota} onClick={() => setNota(!nota)}>{l.nota ? 'Nota ✓' : 'Nota'}</button>
        <button type="button" className="enlace" onClick={() => onQuitar(l.product_id)}>Quitar</button>
      </span>
      {nota && <input className="input pos-nota" maxLength={200} placeholder="Nota de esta línea (por ejemplo, sin cebolla)" value={l.nota} onChange={(e) => onEditar(l.product_id, 'nota', e.target.value)} aria-label={`Nota de ${p?.nombre}`} />}
    </li>
  );
}

/** En el celular el carrito es una hoja inferior: se arrastra hacia arriba para abrirla y hacia abajo para cerrarla. */
function HojaAsa({ abierta, onAlternar, unidades, total }: { abierta: boolean; onAlternar: (a: boolean) => void; unidades: number; total: number }) {
  const y0 = useRef<number | null>(null);
  return (
    <button type="button" className="pos-asa" aria-expanded={abierta} aria-label={abierta ? 'Cerrar el carrito' : 'Abrir el carrito'}
      onPointerDown={(e) => { y0.current = e.clientY; }}
      onPointerUp={(e) => { const dy = y0.current === null ? 0 : e.clientY - y0.current; y0.current = null; if (dy < -30) onAlternar(true); else if (dy > 30) onAlternar(false); else onAlternar(!abierta); }}>
      <span className="pos-asa-barra" aria-hidden="true" />
      <span className="fila entre" style={{ width: '100%' }}><span>{unidades > 0 ? `${unidades} ${unidades === 1 ? 'producto' : 'productos'}` : 'Carrito vacío'}</span><b>{cop(total)}</b></span>
    </button>
  );
}

function ElegirCantidad({ p, actual, onCerrar, onAgregar }: { p: any; actual: number; onCerrar: () => void; onAgregar: (n: number) => void }) {
  const [n, setN] = useState('1');
  const valor = Number(n.replace(',', '.'));
  const entero = p.tipo === 'SERVICIO';
  const invalido = !(valor > 0) || (entero && !Number.isInteger(valor)) || (p.controla_stock && actual + valor > p.stock);
  return (
    <Modal titulo={`¿Cuántos «${p.nombre}»?`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={invalido} onClick={() => onAgregar(valor)}>Agregar {valor > 0 ? valor : ''}</button></>}>
      <form className="col" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); if (!invalido) onAgregar(valor); }}>
        <div className="fila" style={{ gap: 8, justifyContent: 'center' }}>
          <button type="button" className="btn grande" aria-label="Menos uno" onClick={() => setN(String(Math.max(1, (valor || 1) - 1)))}>−</button>
          <input className="input pos-cantidad-grande" autoFocus inputMode="decimal" value={n} onChange={(e) => setN(e.target.value.replace(/[^\d.,]/g, ''))} aria-label="Cantidad" />
          <button type="button" className="btn grande" aria-label="Más uno" onClick={() => setN(String((valor || 0) + 1))}>+</button>
        </div>
        <div className="fila envolver" style={{ gap: 6, justifyContent: 'center' }}>{[2, 3, 5, 10, 20].map((v) => <button key={v} type="button" className="chip" onClick={() => setN(String(v))}>{v}</button>)}</div>
        {p.controla_stock && <span className={`peq-txt ${actual + valor > p.stock ? 'error' : 'tenue'}`} role="status">Quedan {p.stock}{actual ? ` · ya llevas ${actual}` : ''}.</span>}
        {entero && !Number.isInteger(valor) && <span className="error peq-txt" role="alert">Un servicio se vende por unidades enteras.</span>}
      </form>
    </Modal>
  );
}

function ElegirCliente({ recientes, onCerrar, onElegir }: { recientes: any[]; onCerrar: () => void; onElegir: (c: any) => void }) {
  const [q, setQ] = useState('');
  const qr = useRetardo(q, 250);
  const { data } = useApi<any>(() => api.get(`/api/t/clientes?por_pagina=12${qr ? `&q=${encodeURIComponent(qr)}` : '&orden=reciente'}`), [qr]);
  const [nuevo, setNuevo] = useState(false);
  const [tel, setTel] = useState('');
  const { run, ocupado } = useAccion();
  const lista = ((data?.clientes ?? recientes) as any[]).filter((c) => c.nombre !== 'Cliente de mostrador');
  return (
    <Modal titulo="Elegir cliente" onCerrar={onCerrar} pie={<button className="btn" onClick={() => onElegir(null)}>Cliente de mostrador</button>}>
      <input className="input" autoFocus placeholder="Nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cliente" />
      {!qr && lista.length > 0 && <span className="tenue peq-txt">Clientes recientes</span>}
      <ul className="lista seleccion">{lista.map((c: any) => <li key={c.id}><button className="enlace" onClick={() => onElegir(c)}>{c.nombre}{c.telefono ? ` · ${c.telefono}` : ''}</button></li>)}</ul>
      {nuevo ? <div className="fila envolver" style={{ gap: 6 }}><input className="input" placeholder="Teléfono (opcional)" value={tel} onChange={(e) => setTel(e.target.value)} />
        <button className="btn primario" disabled={ocupado || q.trim().length < 2} onClick={async () => { const r = await run(() => api.post('/api/t/clientes', { nombre: q.trim(), telefono: tel.trim() || null })); if (r) onElegir({ id: r.id, nombre: q.trim(), telefono: tel.trim() || null }); }}>Crear «{q.trim()}»</button></div>
        : <button className="btn peq sutil" onClick={() => setNuevo(true)}><Icon n="mas" className="" size={14} />Cliente nuevo{q.trim().length >= 2 ? `: «${q.trim()}»` : ''}</button>}
    </Modal>
  );
}

/** Después de cobrar: lo primero es el cambio; luego nueva venta, comprobante por WhatsApp, imprimir o ver la venta. */
function ExitoVenta({ hecha, empresa, onNueva }: { hecha: any; empresa: string; onNueva: () => void }) {
  const toast = useToast();
  const { run, ocupado } = useAccion();
  const [comprobante, setComprobante] = useState<any>(hecha.comprobante ?? null);
  const telefono = hecha.cliente_datos?.telefono;
  const enviarWhatsApp = async () => {
    let c = comprobante;
    if (!c) { c = await run(() => api.post(`/api/t/ventas/${hecha.id}/comprobante`)); if (!c) return; setComprobante(c); }
    await run(() => api.post(`/api/t/comprobantes/${c.id}/reenviar`, { canal: 'WHATSAPP' }), 'Comprobante enviado por WhatsApp');
  };
  const imprimir = () => {
    document.body.classList.add('imprimiendo-recibo');
    const quitar = () => { document.body.classList.remove('imprimiendo-recibo'); window.removeEventListener('afterprint', quitar); };
    window.addEventListener('afterprint', quitar);
    window.print();
  };
  useEffect(() => {
    const tecla = (e: KeyboardEvent) => { if (e.key === 'Enter' && !(e.target as HTMLElement)?.closest('button, a, input')) onNueva(); };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [onNueva]);
  return (
    <>
      <Modal titulo={`Venta #${hecha.numero}`} onCerrar={onNueva} pie={<><Link className="btn" to={`/ventas/${hecha.id}`}>Ver la venta</Link><button className="btn primario" autoFocus onClick={onNueva}>Nueva venta</button></>}>
        <CobroExitoso titulo={hecha.pago ? 'Venta pagada' : 'Venta registrada (por cobrar)'} pago={hecha.pago} total={hecha.total}>
          <div className="col" style={{ gap: 8 }}>
            {comprobante && <span>Comprobante <b className="mono">{comprobante.numero}</b> generado.</span>}
            <span className="fila envolver" style={{ gap: 6 }}>
              <Escritura permiso="comprobante:send"><button className="btn peq" disabled={ocupado || !telefono} title={telefono ? undefined : 'Elige un cliente con teléfono para enviarle el comprobante'} onClick={enviarWhatsApp}>Enviar comprobante por WhatsApp</button></Escritura>
              {comprobante && <button className="btn peq" onClick={() => descargarComprobante(comprobante).catch((e) => toast(e.message, true))}><Icon n="descargar" className="" size={14} />PDF</button>}
              <button className="btn peq" onClick={imprimir}>Imprimir</button>
            </span>
            {!telefono && <span className="tenue peq-txt">Para enviar el comprobante por WhatsApp, la próxima vez elige un cliente con teléfono.</span>}
          </div>
        </CobroExitoso>
      </Modal>
      {createPortal(<ReciboTermico hecha={hecha} empresa={empresa} />, document.body)}
    </>
  );
}

/** Ticket para impresora térmica de 80 mm: solo se ve al imprimir. */
function ReciboTermico({ hecha, empresa }: { hecha: any; empresa: string }) {
  return (
    <div className="pos-recibo-print" aria-hidden="true">
      <b>{empresa}</b>
      <span>Venta #{hecha.numero} · {fechaHora(new Date().toISOString())}</span>
      <span>Cliente: {hecha.cliente_datos?.nombre ?? hecha.cliente ?? 'Cliente de mostrador'}</span>
      <hr />
      {(hecha.items ?? []).map((i: any, k: number) => <div key={k} className="pos-recibo-fila"><span>{i.cantidad} × {i.nombre}</span><span>{cop(i.total)}</span></div>)}
      <hr />
      {hecha.descuento > 0 && <div className="pos-recibo-fila"><span>Descuentos</span><span>−{cop(hecha.descuento)}</span></div>}
      <div className="pos-recibo-fila"><b>Total</b><b>{cop(hecha.total)}</b></div>
      {hecha.pago ? <><span>Pago: {NOMBRE_METODO[hecha.pago.metodo] ?? hecha.pago.metodo}</span>{hecha.pago.metodo === 'EFECTIVO' && Number(hecha.pago.cambio) > 0 && <span>Recibido {cop(hecha.pago.recibido)} · Cambio {cop(hecha.pago.cambio)}</span>}</> : <span>Pendiente de pago</span>}
      <hr />
      <small>Documento no válido como factura electrónica de venta ante la DIAN.</small>
      <small>¡Gracias por tu compra!</small>
    </div>
  );
}
