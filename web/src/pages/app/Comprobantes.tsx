import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, cop, descargar, fechaHora } from '../../api';
import { Cabecera, Escritura } from '../../components/Layout';
import { Campo, Cargando, Cifra, Confirmar, ErrorCarga, Estado, Modal, Paginador, Tarjeta, useAccion, useApi, useRetardo, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { TarjetaFacturaDian } from '../../components/Proximamente';

/**
 * Comprobantes de venta: soporte interno de cada venta para entregarle al cliente y llevar el registro propio.
 * NO son facturas electrónicas: la leyenda lo dice en la pantalla, el PDF, el correo y el WhatsApp.
 */
const ESTADOS: [string, string][] = [['', 'Todos'], ['EMITIDO', 'Vigentes'], ['ANULADO', 'Anulados']];
const CANAL: Record<string, string> = { CORREO: 'Correo', WHATSAPP: 'WhatsApp', DESCARGA: 'Descarga' };

export const descargarComprobante = (c: { id: string; numero: string }) => descargar(`/api/t/comprobantes/${c.id}/pdf`, `comprobante-${c.numero}.pdf`);

export function Comprobantes() {
  const [estado, setEstado] = useState('');
  const [q, setQ] = useState('');
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [pagina, setPagina] = useState(1);
  const [abierto, setAbierto] = useState<string | null>(null);
  const busqueda = useRetardo(q, 300);
  const filtros = new URLSearchParams({ ...(estado && { estado }), ...(busqueda && { q: busqueda }), ...(desde && { desde }), ...(hasta && { hasta }) });
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/comprobantes?${filtros}&pagina=${pagina}`), [estado, busqueda, desde, hasta, pagina]);
  const { run, ocupado } = useAccion();
  return (
    <>
      <Cabecera titulo="Comprobantes de venta" sub="Soporte interno de tus ventas para entregar al cliente y llevar tu registro. No son facturas electrónicas.">
        <button className="btn" disabled={ocupado} onClick={() => run(() => descargar(`/api/t/comprobantes.csv?${filtros}`, 'comprobantes.csv'))}><Icon n="descargar" className="" size={16} />Exportar libro de ventas</button>
      </Cabecera>
      <div className="contenido">
        {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <div className="tarjeta"><Cargando filas={8} /></div> : <>
          <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span><b>{data.leyenda}</b> Si tu cliente pide factura electrónica, cuéntale que esa función llegará más adelante.</span></div>
          <div className="kpis">
            <Cifra etiqueta="Vigentes" valor={data.resumen.emitidos} />
            <Cifra etiqueta="Anulados" valor={data.resumen.anulados} />
            <Cifra etiqueta="Total vigente" valor={cop(data.resumen.total)} />
          </div>
          <section className="tarjeta">
            <div className="filtros">
              <div className="tabs" role="group" aria-label="Filtrar por estado">{ESTADOS.map(([k, v]) => <button key={k} className={estado === k ? 'on' : ''} aria-pressed={estado === k} onClick={() => { setEstado(k); setPagina(1); }}>{v}</button>)}</div>
              <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Número, cliente o venta" value={q} onChange={(e) => { setQ(e.target.value); setPagina(1); }} aria-label="Buscar comprobantes" /></label>
              <label className="fila peq-txt" style={{ gap: 6 }}>Desde<input className="input" type="date" value={desde} onChange={(e) => { setDesde(e.target.value); setPagina(1); }} /></label>
              <label className="fila peq-txt" style={{ gap: 6 }}>Hasta<input className="input" type="date" value={hasta} onChange={(e) => { setHasta(e.target.value); setPagina(1); }} /></label>
            </div>
            {data.comprobantes.length === 0 ? (
              <Vacio titulo="Todavía no hay comprobantes en esta vista">Ábrelos desde el detalle de una venta confirmada con «Generar comprobante».</Vacio>
            ) : (
              <div className="tabla-wrap"><table className="tabla tabla-movil">
                <thead><tr><th>Número</th><th>Fecha</th><th>Cliente</th><th>Venta</th><th className="num">Total</th><th>Estado</th></tr></thead>
                <tbody>{data.comprobantes.map((c: any) => (
                  <tr key={c.id} className={`clic ${c.estado === 'ANULADO' ? 'inactiva' : ''}`} onClick={() => setAbierto(c.id)}>
                    <td data-etiqueta="Número" className="principal"><button className="enlace mono" onClick={(e) => { e.stopPropagation(); setAbierto(c.id); }}>{c.numero}</button></td>
                    <td data-etiqueta="Fecha">{fechaHora(c.emitido_en)}</td>
                    <td data-etiqueta="Cliente">{c.cliente.nombre}</td>
                    <td data-etiqueta="Venta"><Link to={`/ventas/${c.order_id}`} onClick={(e) => e.stopPropagation()}>#{c.venta}</Link></td>
                    <td data-etiqueta="Total" className="num">{cop(c.total)}</td>
                    <td data-etiqueta="Estado"><Estado v={c.estado} texto={c.estado === 'ANULADO' ? 'Anulado' : 'Vigente'} /></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <Paginador pagina={data.pagina} total={data.total} porPagina={data.por_pagina} onPagina={setPagina} />
          </section>
          {!data.factura_dian?.habilitada && <TarjetaFacturaDian motivo={data.factura_dian?.motivo} />}
        </>}
      </div>
      {abierto && <DetalleComprobante id={abierto} onCerrar={() => setAbierto(null)} onCambio={recargar} />}
    </>
  );
}

/** Detalle de un comprobante con sus acciones: descargar, reenviar y anular (con motivo; no se borra). */
export function DetalleComprobante({ id, onCerrar, onCambio }: { id: string; onCerrar: () => void; onCambio?: () => void }) {
  const { data: c, error, recargar } = useApi<any>(() => api.get(`/api/t/comprobantes/${id}`), [id]);
  const [reenviar, setReenviar] = useState(false);
  const [anular, setAnular] = useState(false);
  const { run, ocupado } = useAccion();
  const cambio = () => { recargar(); onCambio?.(); };
  return (
    <Modal titulo={c ? `Comprobante de venta ${c.numero}` : 'Comprobante de venta'} onCerrar={onCerrar} className="modal-ancho"
      pie={c && <>
        <button className="btn" disabled={ocupado} onClick={() => run(() => descargarComprobante(c))}><Icon n="descargar" className="" size={16} />Descargar PDF</button>
        <Escritura permiso="comprobante:send"><button className="btn" onClick={() => setReenviar(true)}><Icon n="enviar" className="" size={16} />Reenviar</button></Escritura>
        {c.estado === 'EMITIDO' && <Escritura permiso="comprobante:void"><button className="btn peligro" onClick={() => setAnular(true)}>Anular</button></Escritura>}
      </>}>
      {error ? <ErrorCarga error={error} /> : !c ? <Cargando filas={5} /> : (
        <div className="col" style={{ gap: 14 }}>
          {c.estado === 'ANULADO' && <div className="bloqueado" role="note"><Icon n="alerta" className="" size={16} /><span><b>ANULADO</b> el {fechaHora(c.anulado_en)}{c.anulado_por ? ` por ${c.anulado_por}` : ''}. Motivo: {c.motivo_anulacion}</span></div>}
          <p className="aviso peq-txt" role="note"><Icon n="info" className="" size={14} />{c.leyenda}</p>
          <dl className="datos-def">
            <dt>Cliente</dt><dd>{c.cliente.nombre}{c.cliente.documento ? ` · ${c.cliente.documento}` : ''}</dd>
            <dt>Venta</dt><dd><Link to={`/ventas/${c.order_id}`} onClick={onCerrar}>#{c.venta}</Link></dd>
            <dt>Emitido</dt><dd>{fechaHora(c.emitido_en)}{c.emitido_por ? ` · ${c.emitido_por}` : ''}</dd>
            {c.medio_pago && <><dt>Medio de pago</dt><dd>{c.medio_pago}</dd></>}
            {c.notas && <><dt>Notas</dt><dd>{c.notas}</dd></>}
          </dl>
          <div className="tabla-wrap"><table className="tabla">
            <thead><tr><th>Descripción</th><th className="num">Cant.</th><th className="num">Valor unit.</th><th className="num">Subtotal</th></tr></thead>
            <tbody>{c.lineas.map((l: any, i: number) => <tr key={i}><td className="envuelve">{l.descripcion}</td><td className="num">{l.cantidad}</td><td className="num">{cop(l.precio_unitario)}</td><td className="num">{cop(l.subtotal)}</td></tr>)}
              {c.descuento > 0 && <tr className="total"><td colSpan={3} className="num tenue">Descuentos aplicados</td><td className="num">−{cop(c.descuento)}</td></tr>}
              {c.regimen_iva === 'RESPONSABLE' && <><tr className="total"><td colSpan={3} className="num tenue">Base</td><td className="num">{cop(c.subtotal)}</td></tr><tr className="total"><td colSpan={3} className="num tenue">IVA incluido</td><td className="num">{cop(c.impuestos)}</td></tr></>}
              <tr className="total"><td colSpan={3} className="num"><b>Total</b></td><td className="num"><b>{cop(c.total)}</b></td></tr></tbody>
          </table></div>
          <Tarjeta titulo="Envíos">
            {c.entregas.length === 0 ? <span className="tenue">Todavía no se ha enviado ni descargado.</span> : (
              <ul className="lista">{[...c.entregas].reverse().slice(0, 8).map((e: any, i: number) => <li key={i} className="fila entre"><span>{CANAL[e.canal] ?? e.canal}{e.destino ? <span className="tenue"> · {e.destino}</span> : null}</span><span className="tenue peq-txt">{fechaHora(e.en)}</span></li>)}</ul>
            )}
          </Tarjeta>
        </div>
      )}
      {reenviar && c && <Reenviar c={c} onCerrar={() => setReenviar(false)} onHecho={() => { setReenviar(false); cambio(); }} />}
      {anular && c && <Confirmar titulo={`Anular ${c.numero}`} riesgo="critica" pedirMotivo textoBoton="Anular comprobante"
        efecto={<>El comprobante <b>no se borra</b>: queda marcado como <b>ANULADO</b>, con tu motivo, quién y cuándo, y se puede seguir descargando. La venta no cambia; si se devolvió el dinero, anula también la venta.</>}
        onCerrar={() => setAnular(false)} onConfirmar={async (motivo) => { setAnular(false); await run(() => api.post(`/api/t/comprobantes/${c.id}/anular`, { motivo }), 'Comprobante anulado'); cambio(); }} />}
    </Modal>
  );
}

function Reenviar({ c, onCerrar, onHecho }: { c: any; onCerrar: () => void; onHecho: () => void }) {
  const [canal, setCanal] = useState<'CORREO' | 'WHATSAPP'>(c.cliente.correo ? 'CORREO' : 'WHATSAPP');
  const [correo, setCorreo] = useState(c.cliente.correo ?? '');
  const { run, ocupado, error } = useAccion();
  const enviar = async () => {
    const r = await run(() => api.post(`/api/t/comprobantes/${c.id}/reenviar`, canal === 'CORREO' ? { canal, correo: correo.trim() } : { canal }), canal === 'CORREO' ? `Enviamos el comprobante a ${correo.trim()}` : 'Comprobante enviado por WhatsApp', { silencioso: true });
    if (r) onHecho();
  };
  return (
    <Modal titulo={`Reenviar ${c.numero}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || (canal === 'CORREO' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo.trim()))} onClick={enviar}>{ocupado ? 'Enviando…' : 'Enviar'}</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <div className="col" style={{ gap: 8 }}>
        <label className="fila" style={{ gap: 8 }}><input type="radio" name="canal" checked={canal === 'CORREO'} onChange={() => setCanal('CORREO')} />Por correo</label>
        <label className="fila" style={{ gap: 8 }}><input type="radio" name="canal" checked={canal === 'WHATSAPP'} onChange={() => setCanal('WHATSAPP')} />Por WhatsApp{c.cliente.telefono ? ` (${c.cliente.telefono})` : ''}</label>
      </div>
      {canal === 'CORREO'
        ? <Campo etiqueta="Correo del cliente"><input className="input" type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} /></Campo>
        : <p className="tenue peq-txt">WhatsApp solo deja enviarlo si el cliente te escribió en las últimas 24 horas. Si no, pídele que te escriba (un «hola» basta) o envíalo por correo.</p>}
    </Modal>
  );
}
