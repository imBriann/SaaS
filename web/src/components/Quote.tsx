import { cop } from '../api';

/** Modalidad institucional publicada por el servidor (precio real, vigencia y condiciones). */
export type ModalidadInstitucional = { modalidad: 'INSTITUCIONAL'; disponible: boolean; precio: number; acceso_dias: number; cobro_real: boolean; renovacion_automatica: boolean; nota: string } | null;

export function Quote({ quote, loading = false, modalidad }: { quote: any; loading?: boolean; modalidad?: ModalidadInstitucional }) {
  const inst: ModalidadInstitucional = modalidad !== undefined ? modalidad : quote?.modalidad ?? null;
  return <aside className="quote-card" aria-busy={loading}>
    <h3>Así queda tu selección</h3>
    {!quote ? <p className="sec">Elige tus funciones para calcular la estimación.</p> : <>
      {inst && <div className="quote-inst">
        <span className="quote-inst-chip">Modalidad institucional</span>
        <div className="quote-total" aria-live="polite">{cop(inst.precio)}<small> COP · pago único</small></div>
        <p className="quote-inst-txt">Acceso por {inst.acceso_dias} días con las funciones que elijas. Cobro real con Wompi, sin renovación ni cobros automáticos.</p>
      </div>}
      <div className={inst ? 'quote-total referencia' : 'quote-total'} aria-live={inst ? undefined : 'polite'}>{loading ? 'Calculando…' : cop(quote.total)}<small> COP / mes</small></div>
      <span className="demo-label">{inst ? 'Precio comercial de referencia · no se cobra hoy' : 'Tarifas de demostración'}</span>
      <div className="quote-lines"><div><span>Espacio de trabajo</span><b>{cop(quote.base)}</b></div>{quote.lineas.map((m: any) => <div key={m.id}><span>{m.nombre}{m.requerida && <small>Necesaria para tu selección</small>}</span><b>{m.incluida ? 'Incluido' : cop(m.precio)}</b></div>)}</div>
      <p className="quote-note">{inst ? inst.nota : quote.nota}</p>
    </>}
  </aside>;
}
