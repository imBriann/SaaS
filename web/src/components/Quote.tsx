import { cop } from '../api';
export function Quote({ quote, loading = false }: { quote: any; loading?: boolean }) {
  return <aside className="quote-card" aria-busy={loading}>
    <span className="eyebrow">TU PLATAFORMA, A TU MEDIDA</span>
    <h3>Así queda tu selección</h3>
    {!quote ? <p className="sec">Elige tus funciones para calcular la estimación.</p> : <>
      <div className="quote-total" aria-live="polite">{loading ? 'Calculando…' : cop(quote.total)}<small> COP / mes</small></div>
      <span className="demo-label">Tarifas de demostración</span>
      <div className="quote-lines"><div><span>Espacio de trabajo</span><b>{cop(quote.base)}</b></div>{quote.lineas.map((m: any) => <div key={m.id}><span>{m.nombre}{m.requerida && <small>Necesaria para tu selección</small>}</span><b>{m.incluida ? 'Incluido' : cop(m.precio)}</b></div>)}</div>
      <p className="quote-note">{quote.nota}</p>
    </>}
  </aside>;
}
