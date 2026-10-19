import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cop } from '../api';
import { Campo } from './ui';
import { Icon } from './icons';
import { Contador, MarcaExito } from './Movimiento';

/**
 * Cobro en el mostrador: método, valor recibido y cambio. Lo que se muestra es una ayuda para quien
 * cobra; el servidor vuelve a calcular el total y el cambio y rechaza un efectivo que no alcance.
 * No hay abonos: la venta se paga completa o queda por cobrar.
 */
export type MetodoManual = 'EFECTIVO' | 'TRANSFERENCIA' | 'DATAFONO';
export interface Metodos { EFECTIVO: boolean; TRANSFERENCIA: boolean; DATAFONO: boolean; PASARELA: boolean }
export interface PagoElegido { metodo: MetodoManual | 'DESPUES'; recibido: string; referencia: string }

export const NOMBRE_METODO: Record<string, string> = { EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', DATAFONO: 'Tarjeta (datáfono)', PASARELA: 'Pasarela de pagos' };
const ICONO_METODO: Record<string, string> = { EFECTIVO: 'efectivo', TRANSFERENCIA: 'flecha', DATAFONO: 'suscripcion', DESPUES: 'reloj' };

/** «15.000», «15000», «15.000,50» → número; vacío → null. */
export function leerPesos(s: string): number | null {
  const limpio = s.replace(/[$\s]/g, '');
  if (!limpio) return null;
  const normal = /^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(limpio) ? limpio.replace(/\./g, '').replace(',', '.') : limpio.replace(',', '.');
  const n = Number(normal);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** Billetes con los que suele pagar alguien: el total exacto y los siguientes valores redondos. */
export function montosRapidos(total: number): number[] {
  const out = new Set<number>([total]);
  for (const paso of [5000, 10000, 20000, 50000, 100000]) {
    const v = Math.ceil(total / paso) * paso;
    if (v > total) out.add(v);
    if (out.size >= 4) break;
  }
  return [...out].slice(0, 4);
}

/** Clave única por formulario: un doble clic o un reintento de red no registra dos pagos. */
export const nuevaClave = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

export function validarPago(p: PagoElegido, total: number): string | null {
  if (p.metodo !== 'EFECTIVO') return null;
  const r = leerPesos(p.recibido);
  if (r === null) return null; // vacío = pago exacto
  if (Number.isNaN(r)) return 'Escribe el valor recibido solo con números.';
  if (r < total) return `Faltan ${cop(total - r)}. La venta se paga completa: no se registran abonos.`;
  return null;
}

/** Lo que se envía al servidor (o null si queda por cobrar). */
export function cuerpoPago(p: PagoElegido, clave: string) {
  if (p.metodo === 'DESPUES') return null;
  const recibido = p.metodo === 'EFECTIVO' ? leerPesos(p.recibido) : null;
  return { metodo: p.metodo, ...(recibido ? { recibido } : {}), ...(p.metodo !== 'EFECTIVO' && p.referencia.trim() ? { referencia: p.referencia.trim() } : {}), clave };
}

export function CamposCobro({ metodos, total, valor, onCambio, permitirDespues = true, enfocar = false }: {
  metodos: Metodos | null; total: number; valor: PagoElegido; onCambio: (p: PagoElegido) => void; permitirDespues?: boolean; enfocar?: boolean;
}) {
  const disponibles = useMemo(() => (['EFECTIVO', 'TRANSFERENCIA', 'DATAFONO'] as MetodoManual[]).filter((m) => metodos?.[m]), [metodos]);
  const opciones: (MetodoManual | 'DESPUES')[] = [...disponibles, ...(permitirDespues ? ['DESPUES' as const] : [])];
  const recibido = leerPesos(valor.recibido);
  const cambio = valor.metodo === 'EFECTIVO' && recibido !== null && !Number.isNaN(recibido) && recibido >= total ? recibido - total : null;
  const error = validarPago(valor, total);
  const campo = useRef<HTMLInputElement>(null);
  useEffect(() => { if (enfocar && valor.metodo === 'EFECTIVO') campo.current?.focus(); }, [valor.metodo, enfocar]);
  if (!metodos) return <span className="tenue peq-txt">Cargando los métodos de pago…</span>;
  if (!disponibles.length && !permitirDespues) return <div className="aviso peq-txt"><Icon n="info" className="" size={14} /><span>No hay métodos de pago activos. Actívalos en Configuración › Cobros.</span></div>;
  return (
    <fieldset className="cobro">
      <legend className="etiqueta">¿Cómo se paga?</legend>
      <div className="cobro-metodos" role="radiogroup" aria-label="Método de pago">
        {opciones.map((m) => (
          <label key={m} className={`cobro-metodo ${valor.metodo === m ? 'on' : ''}`}>
            <input type="radio" name="metodo-pago" value={m} checked={valor.metodo === m} onChange={() => onCambio({ ...valor, metodo: m })} />
            <Icon n={ICONO_METODO[m]} className="" size={16} />
            <span>{m === 'DESPUES' ? 'Cobrar después' : NOMBRE_METODO[m]}</span>
          </label>
        ))}
      </div>
      {valor.metodo === 'EFECTIVO' && (
        <div className="cobro-efectivo">
          <Campo etiqueta="Recibido del cliente" ayuda="déjalo vacío si paga exacto" error={error ?? undefined}>
            <input ref={campo} className="input num cobro-recibido" inputMode="decimal" autoComplete="off" value={valor.recibido} placeholder={cop(total)} onChange={(e) => onCambio({ ...valor, recibido: e.target.value.replace(/[^\d.,$\s]/g, '') })} aria-invalid={!!error} />
          </Campo>
          <div className="cobro-rapidos" role="group" aria-label="Montos rápidos">
            {montosRapidos(total).map((v, i) => <button key={v} type="button" className={`chip ${recibido === v ? 'on' : ''}`} aria-pressed={recibido === v} onClick={() => onCambio({ ...valor, recibido: cop(v).slice(1) })}>{i === 0 ? 'Exacto' : cop(v)}</button>)}
          </div>
          <div className={`cobro-cambio ${cambio && cambio > 0 ? 'con-cambio' : ''}`} aria-live="polite">
            <span>Cambio</span><b className="num">{cambio === null ? (recibido === null ? cop(0) : '—') : <Contador valor={cambio} formato={cop} ms={320} desdeCero={false} />}</b>
          </div>
        </div>
      )}
      {(valor.metodo === 'TRANSFERENCIA' || valor.metodo === 'DATAFONO') && (
        <Campo etiqueta={valor.metodo === 'TRANSFERENCIA' ? 'Referencia de la transferencia' : 'Número de aprobación del datáfono'} ayuda="opcional, ayuda a conciliar">
          <input className="input mono" maxLength={80} value={valor.referencia} onChange={(e) => onCambio({ ...valor, referencia: e.target.value })} placeholder={valor.metodo === 'TRANSFERENCIA' ? 'Ej.: Nequi 3001234567 · comprobante 8812' : 'Ej.: 123456'} />
        </Campo>
      )}
      {valor.metodo !== 'DESPUES' && valor.metodo !== 'EFECTIVO' && <p className="tenue peq-txt cobro-nota">Es un registro interno: confirma que el dinero llegó a tu cuenta antes de guardarlo.</p>}
      {valor.metodo === 'DESPUES' && <p className="tenue peq-txt cobro-nota">La venta queda «por cobrar». Podrás registrar el pago desde su detalle{metodos.PASARELA ? ' o enviar un enlace de pago' : ''}.</p>}
    </fieldset>
  );
}

/**
 * Confirmación del cobro: lo primero que necesita quien está en la caja es saber cuánto devolver.
 * El cambio sale grande y contando; el resto (método, recibido) queda como detalle.
 */
export function CobroExitoso({ titulo, pago, total, children }: { titulo: string; pago: any | null; total: number; children: ReactNode }) {
  const cambio = Number(pago?.cambio ?? 0);
  return (
    <div className="cobro-exito" role="status">
      <MarcaExito tono={pago ? 'ok' : 'neutro'} />
      <h3>{titulo}</h3>
      <div className="cobro-exito-dato">
        {!pago ? <span className="sec">Quedó por cobrar: <b>{cop(total)}</b>. Registra el pago desde su detalle cuando llegue.</span>
          : pago.metodo === 'EFECTIVO' && cambio > 0 ? <>
            <div className="cobro-exito-cambio-caja">
              <span className="etiqueta">Entrega de cambio</span>
              <Contador valor={cambio} formato={cop} ms={900} className="cobro-exito-cambio" />
            </div>
            <span className="tenue peq-txt" style={{ marginTop: 6 }}>Recibido {cop(pago.recibido)} · Total {cop(pago.monto)}</span>
          </>
          : <span className="sec">{NOMBRE_METODO[pago.metodo] ?? pago.metodo} · <b>{cop(pago.monto)}</b>{pago.metodo === 'EFECTIVO' ? ' · pago exacto, sin cambio' : pago.referencia ? ` · ref. ${pago.referencia}` : ''}</span>}
      </div>
      <div className="acciones">{children}</div>
    </div>
  );
}
