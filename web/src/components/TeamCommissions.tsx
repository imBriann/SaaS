import { useState } from 'react';
import { api, cop, hoyLocal } from '../api';
import { Campo, Cargando, Confirmar, ErrorCarga, Interruptor, useAccion, useApi } from './ui';
import { Icon } from './icons';

/**
 * Comisiones del equipo (opcional). La comisión es un porcentaje sobre la base de cada venta, no
 * una «ganancia»: base = valor pagado − descuentos − IVA, solo en ventas confirmadas y totalmente
 * pagadas. La regla por servicio manda sobre la regla general de la persona, y las reglas se fijan
 * al registrar cada venta (cambiarlas no recalcula ventas anteriores).
 */
const FRECUENCIAS: [string, string][] = [['diaria', 'Diaria'], ['semanal', 'Semanal (lunes a domingo)'], ['quincenal', 'Quincenal (1–15 y 16–fin de mes)'], ['mensual', 'Mensual']];

export function TeamCommissions({ people }: { people: any[] }) {
  const { data, error, cargando, recargar } = useApi<any>(() => api.get('/api/t/equipo/comisiones'), []);
  const productos = useApi<any[]>(() => api.get('/api/t/productos'), []);
  const [borrador, setBorrador] = useState<any>(null);
  const [confirmar, setConfirmar] = useState(false);
  const [informe, setInforme] = useState<any>(null);
  const [fecha, setFecha] = useState(hoyLocal());
  const [ejemplo, setEjemplo] = useState(100000);
  const [iva, setIva] = useState(19);
  const [descuento, setDescuento] = useState(0);
  const { run, ocupado } = useAccion();
  if (cargando) return <Cargando />;
  if (error) return <ErrorCarga error={error} reintentar={recargar} />;
  if (!data) return null;

  const c = borrador ?? data.config;
  const cambiar = (v: any) => setBorrador({ ...c, ...v });
  const regla = (i: number, v: any) => cambiar({ reglas: c.reglas.map((r: any, j: number) => (i === j ? { ...r, ...v } : r)) });
  // Misma cuenta que el servidor, en centavos: (valor con IVA − descuento) ÷ (1 + IVA).
  const base = Math.round(Math.round(Math.round(ejemplo * 100) * (1 - descuento / 100)) / (1 + iva / 100)) / 100;
  const activos = people.filter((p) => p.activo);
  const servicios = (productos.data ?? []).filter((p) => p.tipo === 'SERVICIO');
  const nombre = (id: string) => people.find((p) => p.id === id)?.nombre ?? 'Persona sin elegir';
  const incompletas = c.reglas.filter((r: any) => !r.user_id).length;

  return (
    <section className="tarjeta comisiones">
      <div className="cab"><h2 className="titulo-tarjeta">Comisiones del equipo</h2><span className="tenue peq-txt" style={{ marginLeft: 'auto' }}>Opcional</span></div>
      <div className="cuerpo col" style={{ gap: 20 }}>
        <div className="comisiones-explica">
          <b>¿Cómo se calcula?</b>
          <ol>
            <li>Se toman solo las ventas <b>confirmadas y totalmente pagadas</b>. Las anuladas, con nota crédito o con pago pendiente no generan comisión.</li>
            <li>La base es el <b>valor pagado menos descuentos y sin IVA</b>.</li>
            <li>A esa base se aplica el porcentaje de la persona que registró la venta. Una regla por servicio manda sobre su porcentaje general.</li>
          </ol>
          <span className="tenue peq-txt">Las reglas se fijan al registrar cada venta: cambiarlas no recalcula ventas anteriores. Los datos del equipo no se envían en la factura electrónica.</span>
        </div>

        <div className="comisiones-opcion">
          <div><b>Calcular comisiones</b><span className="tenue peq-txt">Registra la comisión de cada venta atribuible a una persona.</span></div>
          <Interruptor on={c.activo} etiqueta="Calcular comisiones" onChange={(v) => cambiar({ activo: v })} />
        </div>

        {c.activo && (
          <div className="col" style={{ gap: 12 }}>
            <div className="comisiones-reglas">
              {c.reglas.length === 0 && <p className="tenue">Aún no hay reglas. Añade el porcentaje general de cada persona y, si quieres, uno distinto para un servicio.</p>}
              {c.reglas.map((r: any, i: number) => (
                <fieldset className="comision-regla" key={i}>
                  <legend className="sr">Regla {i + 1}</legend>
                  <Campo etiqueta="Persona"><select className="input" value={r.user_id} onChange={(e) => regla(i, { user_id: e.target.value })}><option value="">Elige a la persona</option>{activos.map((p) => <option value={p.id} key={p.id}>{p.nombre}</option>)}</select></Campo>
                  <Campo etiqueta="Aplica a"><select className="input" value={r.product_id ?? ''} onChange={(e) => regla(i, { product_id: e.target.value || null })}><option value="">Todas sus ventas (general)</option>{servicios.map((p) => <option value={p.id} key={p.id}>Solo «{p.nombre}»</option>)}</select></Campo>
                  <Campo etiqueta="Porcentaje"><div className="porcentaje"><input className="input" type="number" min={0} max={100} step="0.01" inputMode="decimal" value={r.porcentaje} onChange={(e) => regla(i, { porcentaje: Math.min(100, Math.max(0, Number(e.target.value))) })} /><span>%</span></div></Campo>
                  <button type="button" className="btn sutil peq" aria-label={`Quitar la regla ${i + 1}`} onClick={() => cambiar({ reglas: c.reglas.filter((_: any, j: number) => i !== j) })}><Icon n="x" className="" size={14} /></button>
                </fieldset>
              ))}
              <button type="button" className="btn peq" style={{ alignSelf: 'flex-start' }} onClick={() => cambiar({ reglas: [...c.reglas, { user_id: '', product_id: null, porcentaje: 0 }] })}><Icon n="mas" className="" size={14} />Añadir regla</button>
            </div>

            <fieldset className="comisiones-vista">
              <legend>Comprueba el cálculo antes de guardar</legend>
              <div className="grid g3">
                <Campo etiqueta="Venta de ejemplo (con IVA)"><input className="input" type="number" min={0} inputMode="numeric" value={ejemplo} onChange={(e) => setEjemplo(Math.max(0, Number(e.target.value)))} /></Campo>
                <Campo etiqueta="IVA"><select className="input" value={iva} onChange={(e) => setIva(Number(e.target.value))}>{[0, 5, 19].map((n) => <option value={n} key={n}>{n}%</option>)}</select></Campo>
                <Campo etiqueta="Descuento"><div className="porcentaje"><input className="input" type="number" min={0} max={100} value={descuento} onChange={(e) => setDescuento(Math.min(100, Math.max(0, Number(e.target.value))))} /><span>%</span></div></Campo>
              </div>
              <p className="comisiones-base">{cop(ejemplo)} {descuento ? `− ${descuento}% de descuento ` : ''}sin IVA ({iva}%) = base de <b>{cop(base)}</b></p>
              {c.reglas.length > 0 && <ul className="comisiones-resultado">{c.reglas.map((r: any, i: number) => <li key={i}><span>{nombre(r.user_id)}{r.product_id ? ` · ${servicios.find((p) => p.id === r.product_id)?.nombre ?? 'servicio'}` : ''}</span><span>{r.porcentaje}% de {cop(base)}</span><b>{cop(Math.round(base * r.porcentaje) / 100)}</b></li>)}</ul>}
            </fieldset>
          </div>
        )}

        <div className="comisiones-opcion">
          <div><b>Informes de comisiones</b><span className="tenue peq-txt">Consulta en el panel lo que corresponde a cada persona por período.</span></div>
          <Interruptor on={c.informes} etiqueta="Activar informes de comisiones" onChange={(v) => cambiar({ informes: v })} />
        </div>
        {c.informes && <Campo etiqueta="Frecuencia del informe"><select className="input" style={{ maxWidth: 320 }} value={c.frecuencia} onChange={(e) => cambiar({ frecuencia: e.target.value })}>{FRECUENCIAS.map(([k, n]) => <option value={k} key={k}>{n}</option>)}</select></Campo>}

        <div className="fila envolver" style={{ gap: 10, alignItems: 'center' }}>
          <button className="btn primario" disabled={!borrador || ocupado || incompletas > 0} onClick={() => setConfirmar(true)}>Revisar y guardar</button>
          {borrador && <button className="btn sutil" onClick={() => setBorrador(null)}>Descartar cambios</button>}
          {incompletas > 0 && <span className="tenue peq-txt">Elige la persona de cada regla para guardar.</span>}
        </div>
        {confirmar && <Confirmar titulo="¿Guardar estas reglas de comisión?" efecto={<>Aplicarán a las ventas que se registren desde ahora; las anteriores no cambian. {data.base}</>} textoBoton={ocupado ? 'Guardando…' : 'Guardar reglas'} onCerrar={() => setConfirmar(false)}
          onConfirmar={async () => { if (ocupado) return; const r = await run(() => api.patch('/api/t/equipo/comisiones', { ...c, confirmar: true }), 'Reglas guardadas'); if (r) { setConfirmar(false); setBorrador(null); setInforme(null); recargar(); } }} />}

        {data.config.informes && (
          <div className="comisiones-informe">
            <div className="fila envolver" style={{ gap: 10, alignItems: 'flex-end' }}>
              <Campo etiqueta="Un día del período que quieres consultar"><input className="input" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
              <button className="btn" disabled={ocupado} onClick={async () => { const r = await run(() => api.get(`/api/t/equipo/comisiones/informe?fecha=${fecha}`)); if (r) setInforme(r); }}>Ver informe</button>
            </div>
            {informe && (
              <div className="col" style={{ gap: 10 }}>
                <p style={{ margin: 0 }}><b>Del {informe.desde} al día anterior a {informe.hasta_exclusivo}</b> · total de comisiones <b>{cop(informe.total)}</b></p>
                <p className="tenue peq-txt" style={{ margin: 0 }}>{informe.criterio_periodo}</p>
                {!informe.filas.length ? <p className="tenue">No hay ventas atribuibles y pagadas en este período.</p> : (
                  <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Persona</th><th>Venta</th><th>Servicio</th><th className="num">Base</th><th className="num">%</th><th className="num">Comisión</th></tr></thead>
                    <tbody>{informe.filas.map((r: any) => <tr key={r.id}><td>{r.persona}</td><td className="mono">#{r.numero}</td><td>{r.servicio}</td><td className="num">{cop(r.base)}</td><td className="num">{r.porcentaje}</td><td className="num"><b>{cop(r.comision)}</b></td></tr>)}</tbody></table></div>
                )}
              </div>
            )}
          </div>
        )}

        <details className="comisiones-historial">
          <summary>Historial de cambios ({data.historial.length})</summary>
          {data.historial.length === 0 ? <p className="tenue peq-txt">Sin cambios todavía.</p> : <ul>{data.historial.map((h: any, i: number) => (
            <li key={i}><b>{new Date(h.creado_en).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}</b> · {h.actor_nombre}
              <span>{h.detalle.despues.activo ? 'Cálculo activado' : 'Cálculo desactivado'} · {h.detalle.despues.reglas.map((r: any) => `${nombre(r.user_id)}: ${r.porcentaje}%`).join('; ') || 'sin reglas'}</span></li>
          ))}</ul>}
        </details>
      </div>
    </section>
  );
}
