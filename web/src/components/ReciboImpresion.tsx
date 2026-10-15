import { cop } from '../api';
import { TEXTO_RECIBO, type FaseRecibo } from '../pages/public/recibo';
import { Icon } from './icons';

/**
 * Omnegia «imprime» el recibo del pago. El papel sale de la ranura según el estado real que
 * informa el servidor (validando → generando → listo, o pendiente). Es solo una representación:
 * los botones de descarga y de acceso a la empresa nunca esperan a que termine la animación.
 */
export function ReciboImpresion({ fase, numero, monto, concepto, empresa, fiscal, validez }: {
  fase: FaseRecibo; numero?: string | null; monto?: number | null; concepto?: string | null; empresa?: string | null; fiscal?: string | null; validez?: boolean;
}) {
  const t = TEXTO_RECIBO[fase];
  return (
    <div className={`impresion impresion-${fase}`}>
      <div className="impresion-impresora" aria-hidden="true">
        <span className="impresion-luz" />
        <span className="impresion-ranura" />
      </div>
      <div className="impresion-salida" aria-hidden="true">
        <div className="impresion-papel">
          <div className="impresion-cab">
            <img src="/marca/isologo.svg" alt="" width={18} height={18} />
            <b>Omnegia</b>
            <span className="mono">{numero ?? 'CP-······'}</span>
          </div>
          <div className="impresion-linea" style={{ ['--i' as any]: 0 }}><span>{concepto ?? 'Acceso a Omnegia'}</span></div>
          <div className="impresion-linea" style={{ ['--i' as any]: 1 }}><span>{empresa ?? 'Tu empresa'}</span></div>
          <div className="impresion-linea total" style={{ ['--i' as any]: 2 }}><span>Total pagado</span><b>{monto != null ? `${cop(monto)} COP` : '—'}</b></div>
          <div className="impresion-sello" style={{ ['--i' as any]: 3 }}>{validez ? 'Factura validada DIAN' : 'Sin validez fiscal'}</div>
          <div className="impresion-corte" />
        </div>
      </div>
      <div className="impresion-estado" role="status" aria-live="polite">
        <span className={`estado ${fase === 'listo' ? 'ok' : fase === 'pendiente' ? 'warn' : 'neutro'}`}>
          <Icon n={fase === 'listo' ? 'ok' : fase === 'pendiente' ? 'alerta' : 'reloj'} className="" />{t.titulo}
        </span>
        <span className="sec peq-txt">{t.detalle}{fase === 'listo' && fiscal ? ` ${fiscal}.` : ''}</span>
      </div>
    </div>
  );
}
