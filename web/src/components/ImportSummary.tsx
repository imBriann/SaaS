import { Icon } from './icons';

/**
 * Resultado real de una importación: cuántos registros se guardaron, omitieron o rechazaron, con el
 * motivo por fila y un reporte descargable. Nunca dice «exitosa» si no se guardó nada.
 */
export function ImportSummary({ resumen, draft = false, onContinue, onOtro }: { resumen: any; draft?: boolean; onContinue: () => void; onOtro?: () => void }) {
  const guardados = resumen.importados ?? ((resumen.creados ?? 0) + (resumen.actualizados ?? 0));
  const reporte: any[] = resumen.reporte ?? [];
  const descargar = () => {
    const csv = '﻿Fila;Resultado;Motivo\r\n' + reporte.map((r) => [r.fila, r.estado, r.motivo].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = 'resultado-importacion.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const problemas = reporte.filter((r) => r.estado !== 'GUARDADO');
  return (
    <section className="tarjeta resumen-import" aria-live="polite">
      <div className="cuerpo col" style={{ gap: 16 }}>
        <h2 className="titulo-tarjeta fila" style={{ gap: 8 }}>
          <Icon n={guardados > 0 ? 'ok' : 'alerta'} className="" size={18} />
          {guardados > 0 ? (draft ? 'Catálogo guardado en tu borrador' : 'Registros guardados en tu empresa') : 'No se guardó ningún registro'}
        </h2>
        <div className="resumen-cifras">
          <div className="ok"><b>{guardados}</b><span>guardados</span></div>
          <div><b>{resumen.omitidos ?? 0}</b><span>omitidos</span></div>
          <div className={resumen.rechazados ? 'err' : ''}><b>{resumen.rechazados ?? 0}</b><span>rechazados</span></div>
        </div>
        {draft && guardados > 0 && <p className="sec" style={{ margin: 0 }}>Pasarán a tu empresa en cuanto se confirme el pago. Si vuelves a importar el mismo archivo, no se duplican.</p>}
        {problemas.length > 0 && (
          <div className="tabla-wrap" style={{ maxHeight: 260 }}>
            <table className="tabla"><thead><tr><th>Fila</th><th>Resultado</th><th>Motivo</th></tr></thead>
              <tbody>{problemas.map((r, i) => <tr key={i}><td className="mono">{r.fila}</td><td>{r.estado === 'RECHAZADO' ? 'Rechazada' : 'Omitida'}</td><td>{r.motivo}</td></tr>)}</tbody></table>
          </div>
        )}
        <div className="fila envolver" style={{ gap: 8 }}>
          {reporte.length > 0 && <button className="btn" onClick={descargar}><Icon n="descargar" className="" size={14} />Descargar el reporte por fila</button>}
          {onOtro && <button className="btn sutil" onClick={onOtro}>Importar otro archivo</button>}
          <button className="btn primario" style={{ marginLeft: 'auto' }} onClick={onContinue}>{draft ? 'Continuar a la revisión del pago' : 'Ver catálogo'}</button>
        </div>
      </div>
    </section>
  );
}
