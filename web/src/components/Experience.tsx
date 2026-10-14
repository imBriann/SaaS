import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Icon } from './icons';
import { Quote } from './Quote';

export function FeatureBuilder() {
  const [selected, setSelected] = useState<string[]>(['conversaciones', 'agenda']);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [quote, setQuote] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [quoteError, setQuoteError] = useState('');
  const error = catalogError || quoteError;
  const [attempt, setAttempt] = useState(0);
  const nav = useNavigate();
  useEffect(() => {
    let alive = true; setCatalogError('');
    api.get('/api/publico/modulos').then(r => { if (alive) setCatalog(r.modulos); }).catch(() => { if (alive) setCatalogError('No pudimos cargar las funciones. Vuelve a intentarlo.'); });
    return () => { alive = false; };
  }, [attempt]);
  useEffect(() => {
    let alive = true; setLoading(true); setQuoteError('');
    api.post('/api/publico/cotizacion', { modulos: selected }).then(r => { if (alive) setQuote(r); }).catch(() => { if (alive) setQuoteError('No pudimos calcular tu selección. Reintenta en un momento.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selected, attempt]);
  const proceed = () => {
    if (!quote || loading || error || !catalog.length) return;
    sessionStorage.setItem('descripcion_inicial', `Quiero configurar mi negocio con estas funciones: ${catalog.filter(f => selected.includes(f.id)).map(f => f.nombre).join(', ')}.`);
    sessionStorage.setItem('funciones_elegidas', JSON.stringify(selected));
    nav('/empezar');
  };
  const opciones = catalog.filter(m => m.precio > 0);
  return <section className="feature-builder" id="seleccion">
    <div className="feature-intro"><h2>Tu selección, a la vista.</h2><p>Marca las funciones que te ayudan hoy. Esta estimación usa tarifas de demostración; los precios comerciales y los impuestos están pendientes de definición.</p></div>
    <div className="builder-layout">
      <div>
        <div className="feature-grid" aria-busy={!catalog.length && !error}>
          {!catalog.length && !error && Array.from({ length: 4 }).map((_, i) => <div key={i} className="feature-option esqueleto-op" aria-hidden="true"><div className="esqueleto" style={{ width: '40%' }} /><div className="esqueleto" style={{ width: '80%' }} /></div>)}
          {opciones.map((m) => {
            const checked = selected.includes(m.id);
            const required = !checked && quote?.modulos.includes(m.id);
            return <button key={m.id} type="button" className={`feature-option ${checked || required ? 'chosen' : ''}`} aria-pressed={!!(checked || required)} disabled={!!required} onClick={() => setSelected(old => checked ? old.filter(x => x !== m.id) : [...old, m.id])}>
              <span className="feature-top"><span className="module-icon"><Icon n={m.icono} className="" size={20} /></span><span className="feature-check" aria-hidden="true"><Icon n={checked || required ? 'ok' : 'mas'} className="" size={14} /></span></span>
              <h3>{m.nombre}</h3><p>{m.id === 'facturacion' ? 'Documentos en pruebas, sin validez fiscal. Requiere un proveedor para emisión real.' : m.descripcion}</p><span className="feature-status">{required ? 'Necesaria para otra función elegida' : checked ? 'En tu selección' : 'Añadir a mi selección'}</span>
            </button>;
          })}
        </div>
        <p className="included-note"><Icon n="ok" className="" size={14} />Clientes y catálogo vienen incluidos en tu espacio de trabajo.</p>
      </div>
      <div className="builder-summary">
        <Quote quote={quote} loading={loading} />
        {error && <div role="alert" className="bloqueado">{error}<button className="btn peq" onClick={() => setAttempt(n => n + 1)}>Reintentar</button></div>}
        <button className="btn primario grande" disabled={loading || !!error || !quote || !catalog.length} onClick={proceed}>Continuar con esta selección</button>
        <Link className="ai-alternative" to="/empezar">Prefiero describir mi negocio</Link>
      </div>
    </div>

  </section>;
}
