import { useEffect, useState } from 'react';
import { cop, fecha, fechaCompleta } from '../api';
import { TEXTO_RECIBO, type FaseRecibo } from '../pages/public/recibo';
import { Icon } from './icons';
import { CodigoBarras, Confeti, Impresora } from './facturacion/piezas';
import '../facturacion.css';

export interface PagoRecibo {
  referencia?: string; concepto?: string | null; plan_nombre?: string | null; ciclo?: string | null; verificado_en?: string | null;
  metodo_detalle?: string | null; metodo_pago?: string | null; proveedor?: string | null; modalidad?: string; acceso_dias?: number | null;
}

const METODO: Record<string, string> = { CARD: 'Tarjeta', PSE: 'PSE', NEQUI: 'Nequi', BANCOLOMBIA_TRANSFER: 'Bancolombia', SIMULADA: 'Pasarela de prueba' };

/**
 * Omnegia «imprime» el recibo de la primera contratación con la misma impresora del panel: ranura, papel con
 * borde dentado, sello y confeti. El papel solo sale cuando el servidor confirmó el pago (fase distinta de
 * «validando»); mientras tanto la ranura espera. Los botones de descarga nunca esperan a la animación.
 */
export function ReciboImpresion({ fase, numero, monto, concepto, empresa, fiscal, validez, pago }: {
  fase: FaseRecibo; numero?: string | null; monto?: number | null; concepto?: string | null; empresa?: string | null; fiscal?: string | null; validez?: boolean; pago?: PagoRecibo | null;
}) {
  const t = TEXTO_RECIBO[fase];
  const aprobado = fase !== 'validando';
  const [disparo, setDisparo] = useState(0);
  useEffect(() => {
    if (!aprobado) return;
    const id = window.setTimeout(() => setDisparo(Date.now()), 900);
    return () => window.clearTimeout(id);
  }, [aprobado]);
  const metodo = pago?.metodo_detalle ?? (pago?.metodo_pago ? METODO[pago.metodo_pago] ?? pago.metodo_pago : null);
  const ref = pago?.referencia ?? numero ?? 'OMNEGIA';
  const hasta = (() => {
    if (!pago?.verificado_en) return null;
    const d = new Date(pago.verificado_en);
    if (pago.acceso_dias) d.setDate(d.getDate() + pago.acceso_dias); else d.setMonth(d.getMonth() + (pago.ciclo === 'ANUAL' ? 12 : 1));
    return d;
  })();
  return (
    <div className={`recibo-alta recibo-alta-${fase}`}>
      <Confeti disparo={disparo} />
      {/* El papel es decorativo: el estado y el resumen se anuncian en la línea de estado. */}
      <div className="recibo-papel" aria-hidden="true">
      {aprobado ? (
        <Impresora clave={ref} sello="Pagado">
          <div className="ticket-cuerpo centrado">
            <span className="ticket-ok" aria-hidden="true"><Icon n="ok" className="" size={16} /></span>
            <b className="ticket-titulo">Pago aprobado</b>
            <span className="ticket-tenue">{empresa ?? 'Tu empresa'}{pago?.verificado_en ? ` · ${fechaCompleta(pago.verificado_en)}` : ''}</span>
            <hr />
            <div className="ticket-linea"><span>{pago?.concepto ?? concepto ?? 'Acceso a Omnegia'}<small>{pago?.plan_nombre && !pago.acceso_dias ? `Plan ${pago.plan_nombre} · ${pago.ciclo === 'ANUAL' ? 'anual (12 meses)' : 'mensual'}` : pago?.acceso_dias ? `${pago.acceso_dias} días de acceso` : ''}</small></span><span>{monto != null ? cop(monto) : '—'}</span></div>
            <hr className="doble" />
            <div className="ticket-total"><span>Total</span><b>{monto != null ? cop(monto) : '—'}</b></div>
            {hasta && <span className="ticket-chip">Tu espacio queda activo hasta el {fecha(hasta)}{hasta.getFullYear() !== new Date().getFullYear() ? ` de ${hasta.getFullYear()}` : ''}</span>}
            {metodo && <span className="ticket-tenue">Pagado con {metodo}</span>}
            <span className="ticket-tenue">Comprobante <span className="mono">{numero ?? 'en preparación'}</span>{validez ? ' · factura validada DIAN' : ' · sin validez fiscal'}</span>
            <CodigoBarras valor={ref} />
            <span className="ticket-gracias">Bienvenido a Omnegia</span>
          </div>
        </Impresora>
      ) : (
        <div className="impresora impresora-claro">
          <div className="impresora-ranura" aria-hidden="true"><span className="impresora-luz" /></div>
          <div className="recibo-espera" aria-hidden="true"><span /><span /><span /></div>
        </div>
      )}
      </div>
      <div className="impresion-estado" role="status" aria-live="polite">
        <span className={`estado ${fase === 'listo' ? 'ok' : fase === 'pendiente' ? 'warn' : 'neutro'}`}>
          <Icon n={fase === 'listo' ? 'ok' : fase === 'pendiente' ? 'alerta' : 'reloj'} className="" />{t.titulo}
        </span>
        <span className="sec peq-txt">{aprobado && monto != null ? `Pago aprobado de ${cop(monto)}${pago?.referencia ? ` (ref. ${pago.referencia})` : ''}. ` : ''}{t.detalle}{fase === 'listo' && fiscal ? ` ${fiscal}.` : ''}</span>
      </div>
    </div>
  );
}
