import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, cop, fechaHora } from '../../../api';
import { Cabecera, Escritura, useSesion } from '../../../components/Layout';
import { Campo, Cargando, ErrorCarga, Estado, Interruptor, Modal, Tarjeta, useAccion, useApi, Vacio } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { PestanasVentas } from './Pestanas';

/**
 * Pedidos y pagos por WhatsApp (docs/pagos-whatsapp.md). La IA arma el pedido y genera el cobro; aquí el negocio ve el
 * estado real. Un pago en línea solo lo confirma Wompi; un pago manual, una persona del negocio (con motivo). Nada se
 * marca como pagado desde el navegador.
 */
const ESTADO: Record<string, [string, string]> = {
  ABIERTO: ['BORRADOR', 'Armando el pedido'], PENDIENTE_PAGO: ['PENDIENTE', 'Pendiente de pago'], PROCESANDO: ['PENDIENTE', 'Procesando'],
  PAGADO: ['PAGADO', 'Aprobado'], RECHAZADO: ['RECHAZADO', 'Rechazado'], ERROR: ['ERROR', 'Error'], EN_REVISION: ['EN_REVISION', 'Requiere revisión'],
  PENDIENTE_CONFIRMACION: ['PENDIENTE_CONFIRMACION', 'Espera tu confirmación'], CANCELADO: ['CANCELADA', 'Cancelado'], ANULADO: ['ANULADA', 'Anulado'],
};
export const EstadoPago = ({ v }: { v: string }) => <Estado v={ESTADO[v]?.[0] ?? v} texto={ESTADO[v]?.[1] ?? v} />;
const METODO: Record<string, string> = { NEQUI: 'Nequi', CHECKOUT: 'Tarjeta, PSE o Bancolombia', PSE: 'PSE', CARD: 'Tarjeta', BANCOLOMBIA_TRANSFER: 'Bancolombia', DAVIPLATA: 'Daviplata', BREB: 'Bre-B', QR: 'QR', CUENTA_BANCARIA: 'Cuenta bancaria' };
const pesos = (centavos: number) => cop(Number(centavos) / 100);

/** Aviso del modo de precios: lo fija el operador de Omnegia; la empresa solo lo ve. */
function AvisoModo({ precios, enLinea }: { precios: any; enLinea?: boolean }) {
  if (!precios) return null;
  return (
    <div className={`aviso ${precios.pagos_reales ? '' : ''}`} role="note">
      <Icon n="info" className="" size={16} />
      <span>
        {precios.modo === 'institutional_test'
          ? <>Modo de <b>demostración institucional</b>: tus clientes ven el precio oficial de cada producto, pero cada pedido se cobra con un importe fijo de <b>{cop(precios.cargo_fijo_cop)}</b>{precios.pagos_reales ? ' (cobro real)' : ''}.</>
          : <>Modo de <b>precios oficiales</b>: se cobra el total real de cada pedido.</>}
        {' '}{precios.pagos_reales ? <b>Los pagos reales en línea están habilitados.</b> : 'Los pagos en línea están apagados en Omnegia.'}
        {enLinea === false && precios.pagos_reales ? ' Actívalos en «Métodos de pago».' : ''} Este modo lo administra Omnegia.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pedidos
// ---------------------------------------------------------------------------
const FILTROS: [string, string][] = [['', 'Todos'], ['PENDIENTE_CONFIRMACION', 'Esperan tu confirmación'], ['PROCESANDO', 'Procesando'], ['PAGADO', 'Pagados'], ['EN_REVISION', 'Requieren revisión'], ['RECHAZADO', 'Rechazados']];

export function Pedidos() {
  const [estado, setEstado] = useState('');
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/pagos/pedidos${estado ? `?estado=${estado}` : ''}`), [estado], { cada: 8000 });
  const ajustes = useApi<any>(() => api.get('/api/t/pagos/ajustes'), []);
  const [accion, setAccion] = useState<{ tipo: 'confirmar' | 'rechazar' | 'comprobante' | 'observar'; cobro: any; pedido: any } | null>(null);
  return (
    <>
      <Cabecera titulo="Ventas" sub="Pedidos que tu asistente arma por WhatsApp y el estado real de su pago." pestanas={<PestanasVentas activa="pedidos" />} />
      <div className="contenido col" style={{ gap: 14 }}>
        <AvisoModo precios={ajustes.data?.precios} enLinea={ajustes.data?.pago_en_linea} />
        {ajustes.data && !ajustes.data.pago_manual && !ajustes.data.pago_en_linea && (
          <div className="aviso" role="note"><Icon n="alerta" className="" size={16} /><span>Tu asistente todavía no toma pedidos con pago: activa al menos un método en <Link to="/ventas/metodos-de-pago">Métodos de pago</Link>.</span></div>
        )}
        <div className="chips-filtro" role="group" aria-label="Estado del pedido">{FILTROS.map(([k, v]) => <button key={k} type="button" className={`chip ${estado === k ? 'on' : ''}`} aria-pressed={estado === k} onClick={() => setEstado(k)}>{v}</button>)}</div>
        {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={5} /> : !data.pedidos.length ? (
          <Vacio titulo="Todavía no hay pedidos en esta vista">Cuando un cliente compre por WhatsApp, su pedido aparece aquí con el estado del pago.</Vacio>
        ) : (
          <div className="tabla-wrap tarjeta"><table className="tabla tabla-movil">
            <thead><tr><th>#</th><th>Cliente</th><th>Detalle</th><th>Entrega</th><th className="num">Precio oficial</th><th className="num">Cobro</th><th>Pago</th><th /></tr></thead>
            <tbody>{data.pedidos.map((p: any) => {
              const c = p.cobro;
              return (
                <tr key={p.id}>
                  <td data-etiqueta="Pedido" className="principal mono">#{p.numero}</td>
                  <td data-etiqueta="Cliente">{p.cliente}<div className="tenue peq-txt">{fechaHora(p.creado_en)}</div></td>
                  <td data-etiqueta="Detalle" className="sec cortar detalle-celda">{p.detalle}</td>
                  <td data-etiqueta="Entrega">{p.entrega === 'DOMICILIO' ? <>Domicilio<div className="tenue peq-txt cortar">{p.direccion_entrega}</div></> : p.entrega === 'RECOGER' ? 'Recoge en el negocio' : '—'}</td>
                  <td data-etiqueta="Precio oficial" className="num">{cop(p.total)}</td>
                  <td data-etiqueta="Cobro" className="num">{c ? <b>{pesos(c.monto_cobro_centavos)}</b> : '—'}{c && c.modo_precios === 'institutional_test' && <div className="tenue peq-txt">demostración</div>}</td>
                  <td data-etiqueta="Pago"><EstadoPago v={c?.estado ?? p.pedido_estado} />{c && <div className="tenue peq-txt">{METODO[c.metodo] ?? c.metodo}{c.modalidad === 'MANUAL' ? ' · manual' : ''}</div>}{c?.motivo && <div className="peq-txt error cortar" title={c.motivo}>{c.motivo}</div>}</td>
                  <td data-etiqueta="">{c?.modalidad === 'MANUAL' && c.estado === 'PENDIENTE_CONFIRMACION' && (
                    <Escritura permiso="payment:register"><span className="fila envolver" style={{ gap: 4 }}>
                      <button className="btn peq primario" onClick={() => setAccion({ tipo: 'confirmar', cobro: c, pedido: p })}>Confirmar pago</button>
                      <button className="btn peq" onClick={() => setAccion({ tipo: 'comprobante', cobro: c, pedido: p })}>Pedir otro comprobante</button>
                      <button className="btn peq sutil" onClick={() => setAccion({ tipo: 'rechazar', cobro: c, pedido: p })}>Rechazar</button>
                    </span></Escritura>
                  )}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
      {accion && <AccionManual {...accion} onCerrar={() => setAccion(null)} onHecho={() => { setAccion(null); recargar(); }} />}
    </>
  );
}

function AccionManual({ tipo, cobro, pedido, onCerrar, onHecho }: { tipo: 'confirmar' | 'rechazar' | 'comprobante' | 'observar'; cobro: any; pedido: any; onCerrar: () => void; onHecho: () => void }) {
  const [texto, setTexto] = useState('');
  const { run, ocupado, error } = useAccion();
  const titulos = { confirmar: `Confirmar el pago del pedido #${pedido.numero}`, rechazar: `Rechazar el pago del pedido #${pedido.numero}`, comprobante: 'Pedir otro comprobante', observar: 'Anotar una observación' };
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    const ruta = tipo === 'confirmar' ? 'confirmar' : tipo === 'rechazar' ? 'rechazar' : 'observar';
    const cuerpo = tipo === 'rechazar' ? { motivo: texto } : { nota: texto, ...(tipo === 'comprobante' ? { pedir_comprobante: true } : {}) };
    const r = await run(() => api.post(`/api/t/pagos/cobros/${cobro.id}/${ruta}`, cuerpo), tipo === 'confirmar' ? 'Pago confirmado' : 'Listo', { silencioso: true });
    if (r) onHecho();
  };
  return (
    <Modal titulo={titulos[tipo]} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className={`btn ${tipo === 'rechazar' ? 'peligro' : 'primario'}`} form="accion-manual" disabled={ocupado || texto.trim().length < 5}>{ocupado ? 'Guardando…' : tipo === 'confirmar' ? `Sí, recibí ${pesos(cobro.monto_cobro_centavos)}` : tipo === 'rechazar' ? 'Rechazar el pago' : 'Enviar'}</button></>}>
      <form id="accion-manual" className="col" style={{ gap: 10 }} onSubmit={enviar}>
        {tipo === 'confirmar' && <p className="sec">Confírmalo solo si viste el dinero en tu cuenta ({METODO[cobro.metodo] ?? cobro.metodo}) por <b>{pesos(cobro.monto_cobro_centavos)}</b> con la referencia <span className="mono">{cobro.referencia}</span>. Un comprobante enviado por el cliente no basta. Queda registrado a tu nombre.</p>}
        {tipo === 'comprobante' && <p className="sec">Le escribimos al cliente con tu mensaje (respetando la ventana de 24 horas de WhatsApp). El pago sigue esperando tu confirmación.</p>}
        <Campo etiqueta={tipo === 'confirmar' ? 'Cómo lo verificaste' : tipo === 'rechazar' ? 'Motivo' : 'Mensaje'}>
          <textarea className="input" rows={3} maxLength={500} value={texto} onChange={(e) => setTexto(e.target.value)} autoFocus placeholder={tipo === 'confirmar' ? 'Ej.: vi el Nequi de $1.500 en la app a las 3:10 p. m.' : tipo === 'rechazar' ? 'Ej.: el dinero no llegó a la cuenta' : 'Ej.: el comprobante se ve borroso, ¿me lo envías de nuevo?'} />
        </Campo>
        {error && <p className="error peq-txt" role="alert">{error.message}</p>}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pagos: transacciones e historial financiero
// ---------------------------------------------------------------------------
export function PagosComercio() {
  const [vista, setVista] = useState<'transacciones' | 'historial'>('transacciones');
  const cobros = useApi<any>(() => api.get('/api/t/pagos/cobros'), [], { cada: 8000 });
  const hist = useApi<any>(() => (vista === 'historial' ? api.get('/api/t/pagos/historial') : Promise.resolve(null)), [vista]);
  const ajustes = useApi<any>(() => api.get('/api/t/pagos/ajustes'), []);
  const { run, ocupado } = useAccion();
  return (
    <>
      <Cabecera titulo="Ventas" sub="Cada intento de cobro de tus pedidos y el registro financiero." pestanas={<PestanasVentas activa="pagos" />} />
      <div className="contenido col" style={{ gap: 14 }}>
        <AvisoModo precios={ajustes.data?.precios} />
        <div className="tabs" role="tablist" aria-label="Vista de pagos">
          <button role="tab" aria-selected={vista === 'transacciones'} className={vista === 'transacciones' ? 'on' : ''} onClick={() => setVista('transacciones')}>Transacciones</button>
          <button role="tab" aria-selected={vista === 'historial'} className={vista === 'historial' ? 'on' : ''} onClick={() => setVista('historial')}>Historial financiero</button>
        </div>
        {vista === 'transacciones' ? (cobros.error ? <ErrorCarga error={cobros.error} reintentar={cobros.recargar} /> : !cobros.data ? <Cargando filas={5} /> : <>
          {cobros.data.revisiones.length > 0 && (
            <Tarjeta nivel={3} titulo={<span className="fila" style={{ gap: 6 }}><Icon n="alerta" className="" size={16} />{cobros.data.revisiones.length === 1 ? '1 cobro requiere revisión' : `${cobros.data.revisiones.length} cobros requieren revisión`}</span>}>
              <ul className="lista" style={{ margin: 0 }}>{cobros.data.revisiones.map((r: any) => <li key={r.id} className="peq-txt">{r.detalle}: se esperaba <b>{r.esperado}</b> y llegó <b>{r.recibido}</b> ({r.tipo.toLowerCase()}). No se aprobó nada automáticamente.</li>)}</ul>
            </Tarjeta>
          )}
          {!cobros.data.cobros.length ? <Vacio titulo="Todavía no hay cobros">Cuando tu asistente genere un cobro, aparece aquí.</Vacio> : (
            <div className="tabla-wrap tarjeta"><table className="tabla tabla-movil">
              <thead><tr><th>Referencia</th><th>Pedido</th><th>Medio</th><th className="num">Precio oficial</th><th className="num">Cobro</th><th className="num">Reportado</th><th className="num">Comisión</th><th>Estado</th><th /></tr></thead>
              <tbody>{cobros.data.cobros.map((c: any) => (
                <tr key={c.id}>
                  <td data-etiqueta="Referencia" className="mono peq-txt">{c.referencia}<div className="tenue">{fechaHora(c.creado_en)}</div></td>
                  <td data-etiqueta="Pedido">#{c.numero} · {c.cliente}</td>
                  <td data-etiqueta="Medio">{METODO[c.metodo] ?? c.metodo}{c.celular_final ? <span className="tenue"> ···{c.celular_final}</span> : null}<div className="tenue peq-txt">{c.modalidad === 'MANUAL' ? 'Manual' : 'Wompi'}</div></td>
                  <td data-etiqueta="Precio oficial" className="num">{cop(c.total_oficial)}</td>
                  <td data-etiqueta="Cobro" className="num"><b>{cop(c.cobro)}</b></td>
                  <td data-etiqueta="Reportado" className="num">{c.monto_reportado == null ? '—' : cop(c.monto_reportado)}</td>
                  <td data-etiqueta="Comisión" className="num">{c.comision == null ? <span className="tenue" title="Wompi no la informa en la transacción: se completa al conciliar con su reporte">por conciliar</span> : cop(c.comision)}</td>
                  <td data-etiqueta="Estado"><EstadoPago v={c.estado} />{c.motivo && <div className="peq-txt error cortar" title={c.motivo}>{c.motivo}</div>}</td>
                  <td data-etiqueta="">{c.modalidad === 'MANAGED' && ['PENDIENTE_PAGO', 'PROCESANDO'].includes(c.estado) && <button className="btn peq" disabled={ocupado} onClick={async () => { await run(() => api.post(`/api/t/pagos/cobros/${c.id}/verificar`), 'Consultamos a Wompi'); cobros.recargar(); }}>Verificar ahora</button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </>) : (hist.error ? <ErrorCarga error={hist.error} reintentar={hist.recargar} /> : !hist.data ? <Cargando filas={5} /> : <>
          <div className="kpis">
            <div className="kpi"><span className="tenue peq-txt">Recaudado (bruto)</span><b>{cop(hist.data.totales.bruto)}</b></div>
            <div className="kpi"><span className="tenue peq-txt">Comisión conocida</span><b>{cop(hist.data.totales.comision_conocida)}</b></div>
            <div className="kpi"><span className="tenue peq-txt">Movimientos sin comisión conciliada</span><b>{hist.data.totales.pendientes_de_comision}</b></div>
          </div>
          <p className="tenue peq-txt">Registro de solo inserción: un movimiento no se edita ni se borra; una corrección es un movimiento nuevo.</p>
          {!hist.data.movimientos.length ? <Vacio titulo="Sin movimientos todavía" /> : (
            <div className="tabla-wrap tarjeta"><table className="tabla tabla-movil">
              <thead><tr><th>Fecha</th><th>Tipo</th><th>Pedido</th><th>Referencia</th><th className="num">Bruto</th><th className="num">Comisión</th><th className="num">Neto</th><th>Estado</th></tr></thead>
              <tbody>{hist.data.movimientos.map((m: any) => (
                <tr key={m.id}>
                  <td data-etiqueta="Fecha">{fechaHora(m.creado_en)}</td>
                  <td data-etiqueta="Tipo">{m.tipo === 'RECAUDO' ? 'Recaudo' : m.tipo === 'REVERSO' ? 'Reverso' : 'Ajuste de comisión'}</td>
                  <td data-etiqueta="Pedido">#{m.numero}</td>
                  <td data-etiqueta="Referencia" className="mono peq-txt">{m.referencia}</td>
                  <td data-etiqueta="Bruto" className="num">{m.tipo === 'REVERSO' ? '−' : ''}{cop(m.bruto)}</td>
                  <td data-etiqueta="Comisión" className="num">{m.comision == null ? '—' : cop(m.comision)}</td>
                  <td data-etiqueta="Neto" className="num">{m.neto == null ? '—' : cop(m.neto)}</td>
                  <td data-etiqueta="Estado">{m.estado === 'CONFIRMADO' ? 'Confirmado' : 'Comisión por conciliar'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </>)}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Métodos de pago
// ---------------------------------------------------------------------------
const TIPOS: [string, string][] = [['NEQUI', 'Nequi'], ['DAVIPLATA', 'Daviplata'], ['BREB', 'Llave Bre-B'], ['QR', 'Código QR'], ['CUENTA_BANCARIA', 'Cuenta bancaria']];
const VACIA = { tipo: 'NEQUI', titular: '', valor: '', banco: '', tipo_cuenta: 'AHORROS', instrucciones: '', activo: true };

export function MetodosPago() {
  const { s } = useSesion();
  const { data, error, recargar, setData } = useApi<any>(() => api.get('/api/t/pagos/ajustes'), []);
  const [editar, setEditar] = useState<any>(null);
  const { run, ocupado } = useAccion();
  const guardarAjustes = async (cambio: { pago_manual?: boolean; pago_en_linea?: boolean }) => {
    const r = await run(() => api.patch('/api/t/pagos/ajustes', { pago_manual: data.pago_manual, pago_en_linea: data.pago_en_linea, ...cambio }), 'Métodos de pago guardados');
    if (r) setData(r);
  };
  const guardarCuenta = async (e: FormEvent) => {
    e.preventDefault();
    const cuerpo = { ...editar, banco: editar.tipo === 'CUENTA_BANCARIA' ? editar.banco : null, tipo_cuenta: editar.tipo === 'CUENTA_BANCARIA' ? editar.tipo_cuenta : null, instrucciones: editar.instrucciones || null };
    delete cuerpo.id; delete cuerpo.tipo_nombre;
    const r = await run(() => (editar.id ? api.put(`/api/t/pagos/cuentas/${editar.id}`, cuerpo) : api.post('/api/t/pagos/cuentas', cuerpo)), 'Dato de pago guardado');
    if (r) { setEditar(null); recargar(); }
  };
  return (
    <>
      <Cabecera titulo="Ventas" sub={`Cómo pueden pagar los clientes que le compran a ${s.tenant.nombre} por WhatsApp.`} pestanas={<PestanasVentas activa="metodos" />} />
      <div className="contenido col" style={{ gap: 16 }}>
        {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={4} /> : <>
          <AvisoModo precios={data.precios} enLinea={data.pago_en_linea} />
          <div className="grid g2" style={{ alignItems: 'start' }}>
            <Tarjeta titulo="Pago en línea (Wompi)" acciones={<Interruptor on={data.pago_en_linea} disabled={ocupado || (!data.en_linea_disponible && !data.pago_en_linea)} onChange={(v) => guardarAjustes({ pago_en_linea: v })} etiqueta="Pago en línea" />}>
              <p className="sec peq-txt" style={{ marginTop: 0 }}>Nequi (le llega al cliente una solicitud de pago en la app), tarjeta, PSE o Bancolombia. Se confirma solo cuando Wompi aprueba el pago.</p>
              {!data.en_linea_disponible && <p className="aviso peq-txt"><Icon n="info" className="" size={14} />{data.motivo_en_linea}</p>}
              <p className="tenue peq-txt">En esta versión el dinero llega a la cuenta Wompi del proyecto institucional de Omnegia.</p>
            </Tarjeta>
            <Tarjeta titulo="Pago manual" acciones={<Interruptor on={data.pago_manual} disabled={ocupado} onChange={(v) => guardarAjustes({ pago_manual: v })} etiqueta="Pago manual" />}>
              <p className="sec peq-txt" style={{ marginTop: 0 }}>Tu asistente le da al cliente tus datos (Nequi, Daviplata, Bre-B, QR o cuenta). Tú confirmas cada pago en «Pedidos» cuando veas el dinero: un comprobante del cliente no basta.</p>
            </Tarjeta>
          </div>
          <Tarjeta titulo="Tus datos de pago manual" acciones={<Escritura permiso="tenant:configure"><button className="btn peq primario" onClick={() => setEditar({ ...VACIA })}><Icon n="mas" className="" size={14} />Agregar</button></Escritura>} sinCuerpo>
            {!data.cuentas.length ? <p className="cuerpo tenue">Todavía no agregas datos de pago.</p> : (
              <ul className="lista">{data.cuentas.map((c: any) => (
                <li key={c.id} className="agente-fila">
                  <div className="col" style={{ gap: 2 }}><b>{c.tipo_nombre} · {c.valor}</b><span className="tenue peq-txt">{c.titular}{c.banco ? ` · ${c.banco}` : ''}{c.activo ? '' : ' · inactivo'}</span></div>
                  <span className="fila" style={{ gap: 4 }}>
                    <button className="btn peq" onClick={() => setEditar({ ...c, banco: c.banco ?? '', tipo_cuenta: c.tipo_cuenta ?? 'AHORROS', instrucciones: c.instrucciones ?? '' })}>Editar</button>
                    <button className="btn peq sutil" onClick={async () => { await run(() => api.del(`/api/t/pagos/cuentas/${c.id}`), 'Dato de pago quitado'); recargar(); }}>Quitar</button>
                  </span>
                </li>
              ))}</ul>
            )}
          </Tarjeta>
        </>}
      </div>
      {editar && (
        <Modal titulo={editar.id ? 'Editar dato de pago' : 'Agregar dato de pago'} onCerrar={() => setEditar(null)} pie={<><button className="btn" onClick={() => setEditar(null)}>Cancelar</button><button className="btn primario" form="form-cuenta" disabled={ocupado}>Guardar</button></>}>
          <form id="form-cuenta" className="col" style={{ gap: 10 }} onSubmit={guardarCuenta}>
            <Campo etiqueta="Tipo"><select className="input" value={editar.tipo} onChange={(e) => setEditar({ ...editar, tipo: e.target.value })}>{TIPOS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
            <Campo etiqueta="Titular"><input className="input" value={editar.titular} maxLength={120} onChange={(e) => setEditar({ ...editar, titular: e.target.value })} /></Campo>
            <Campo etiqueta={editar.tipo === 'QR' ? 'Enlace https del QR' : editar.tipo === 'BREB' ? 'Llave Bre-B' : editar.tipo === 'CUENTA_BANCARIA' ? 'Número de cuenta' : 'Celular'}><input className="input mono" value={editar.valor} maxLength={120} onChange={(e) => setEditar({ ...editar, valor: e.target.value })} /></Campo>
            {editar.tipo === 'CUENTA_BANCARIA' && <div className="grid g2">
              <Campo etiqueta="Banco"><input className="input" value={editar.banco} maxLength={80} onChange={(e) => setEditar({ ...editar, banco: e.target.value })} /></Campo>
              <Campo etiqueta="Tipo de cuenta"><select className="input" value={editar.tipo_cuenta} onChange={(e) => setEditar({ ...editar, tipo_cuenta: e.target.value })}><option value="AHORROS">Ahorros</option><option value="CORRIENTE">Corriente</option></select></Campo>
            </div>}
            <Campo etiqueta="Instrucciones para el cliente" ayuda="opcional"><input className="input" value={editar.instrucciones} maxLength={500} onChange={(e) => setEditar({ ...editar, instrucciones: e.target.value })} placeholder="Ej.: envía el comprobante por este chat" /></Campo>
            <label className="fila"><input type="checkbox" checked={editar.activo} onChange={(e) => setEditar({ ...editar, activo: e.target.checked })} /> Activo</label>
          </form>
        </Modal>
      )}
    </>
  );
}
