import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Icon } from './icons';
import { Quote } from './Quote';

const scenes = [
  { name: 'Atender', heading: 'Una conversación. Todo empieza aquí.', message: 'Hola, ¿tienen disponibilidad mañana?', reply: 'Claro. Tengo un espacio a las 10:00. ¿Te lo reservo?', result: 'Disponibilidad consultada', detail: 'Agenda conectada · Confirmación pendiente' },
  { name: 'Organizar', heading: 'Cada cita, en su lugar.', message: 'Sí, mañana a las 10 me queda perfecto.', reply: 'Tu cita está confirmada. Te esperamos mañana.', result: 'Cita confirmada', detail: 'Cliente y agenda actualizados' },
  { name: 'Facturar', heading: 'El cierre también está conectado.', message: '¿Me pueden enviar mi factura?', reply: 'Cuando esté validada, recibirás tu documento por este mismo chat.', result: 'Seguimiento del documento', detail: 'Venta → Validación → Entrega' },
];
export function Experience() {
  const [active, setActive] = useState(0);
  const scene = scenes[active];
  return <>
    <section className="experience-hero" id="como">
      <div className="hero-editorial">
        <span className="eyebrow"><i /> MENOS PENDIENTES. MÁS POSIBILIDADES.</span>
        <h1>Tu negocio crece.<br /><em>Tu tiempo vuelve.</em></h1>
        <p>Atiende por WhatsApp, organiza tus citas y controla tus ventas. Todo conectado, con un asistente que te ayuda a avanzar.</p>
        <div className="hero-actions"><a className="btn primario" href="#funciones">Diseñar mi plataforma <span aria-hidden="true">↗</span></a><Link className="btn fantasma" to="/empezar">Recomiéndame con IA ✧</Link></div>
        <span className="hero-footnote">✓ Elige tus funciones   ·   ✓ Mira tu estimación   ·   ✓ Tú decides</span>
      </div>
      <div className="product-stage"><div className="floating-note note-reservation"><span>✓</span><div><b>Una reserva menos por gestionar</b><small>Tu agenda y el chat, conectados</small></div></div>
        <div className="stage-top"><span>PLATAFORMA / EN ACCIÓN</span><span>DEMO INTERACTIVA</span></div>
        <div className="scene-tabs" role="tablist" aria-label="Explorar el producto">{scenes.map((s, i) => <button key={s.name} role="tab" aria-selected={active === i} aria-controls="product-scene" id={`scene-${i}`} onClick={() => setActive(i)} className={active === i ? 'active' : ''}><span>0{i + 1}</span>{s.name}</button>)}</div>
        <div key={active} className="product-scene" id="product-scene" role="tabpanel" aria-labelledby={`scene-${active}`}>
          <div className="scene-heading"><span className="scene-monogram">p.</span><div><b>Tu negocio</b><small>Un solo espacio de trabajo</small></div><span className="scene-dot" /></div>
          <h2>{scene.heading}</h2>
          <div className="scene-message">{scene.message}<small>Cliente · ahora</small></div>
          <div className="scene-reply">{scene.reply}<small>Asistente del negocio</small></div>
          <div className="scene-result"><span>↳</span><div><b>{scene.result}</b><small>{scene.detail}</small></div><span>✓</span></div>
        </div>
        <div className="stage-bottom"><span>Prueba los tres pasos de la demo ↑</span><span>0{active + 1} / 03</span></div>
      </div>
    </section>
    <div className="business-types"><span>PARA EL NEGOCIO QUE ESTÁS CONSTRUYENDO</span><b>Barberías & belleza</b><b>Gimnasios & bienestar</b><b>Comercios & servicios</b></div><section className="statement-strip" id="confianza"><span>MENOS TAREAS REPETIDAS.<br />MÁS TIEMPO PARA LO IMPORTANTE.</span><p>La IA propone.<br />Tu negocio <em>mantiene el control.</em></p><span>Permisos claros.<br />Acciones con historial.</span></section>
  </>;
}
export function FeatureBuilder() {
  const [selected, setSelected] = useState<string[]>(['conversaciones', 'agenda']);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [quote, setQuote] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const nav = useNavigate();
  useEffect(() => {
    let alive = true;
    api.get('/api/publico/modulos').then(r => { if (alive) setCatalog(r.modulos); }).catch(() => { if (alive) setError('No pudimos cargar las funciones. Vuelve a intentarlo.'); });
    return () => { alive = false; };
  }, [attempt]);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    api.post('/api/publico/cotizacion', { modulos: selected }).then(r => { if (alive) setQuote(r); }).catch(() => { if (alive) setError('No pudimos calcular tu selección. Reintenta en un momento.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selected, attempt]);
  const proceed = () => {
    if (!quote || loading || error) return;
    sessionStorage.setItem('descripcion_inicial', `Quiero configurar mi negocio con estas funciones: ${catalog.filter(f => selected.includes(f.id)).map(f => f.nombre).join(', ')}.`);
    sessionStorage.setItem('funciones_elegidas', JSON.stringify(selected));
    nav('/empezar');
  };
  return <section className="feature-builder" id="funciones">
    <div className="feature-intro"><span className="eyebrow">TÚ ELIGES LAS PIEZAS. NOSOTROS LAS CONECTAMOS.</span><h2>Todo lo que necesitas.<br /><em>Solo lo que necesitas.</em></h2><p>Marca las funciones que te ayudan hoy. Tu estimación se actualiza al instante, con cada concepto a la vista.</p></div>
    <div className="builder-layout"><div><div className="feature-grid">{catalog.filter(m => m.precio > 0).map((m, i) => {
      const checked = selected.includes(m.id);
      const required = !checked && quote?.modulos.includes(m.id);
      return <button key={m.id} className={`feature-option ${checked || required ? 'chosen' : ''} tone-${i % 4}`} aria-pressed={!!(checked || required)} onClick={() => setSelected(old => checked ? old.filter(x => x !== m.id) : [...old, m.id])}>
        <span className="feature-top"><span className="module-icon"><Icon n={m.icono} className="" size={24} /></span><span className="feature-check">{checked || required ? '✓' : '+'}</span></span>
        <h3>{m.nombre}</h3><p>{m.descripcion}</p><span className="feature-status">{required ? 'Necesaria para otra función elegida' : checked ? 'En tu plataforma' : 'Añadir a mi plataforma'}</span>
      </button>;
    })}</div><p className="included-note">✓ Clientes y catálogo incluidos en tu espacio de trabajo.</p></div>
    <div className="builder-summary"><Quote quote={quote} loading={loading} />{error && <p role="alert" className="bloqueado">{error}<button className="btn" onClick={() => setAttempt(n => n + 1)}>Reintentar</button></p>}<button className="btn primario" disabled={!selected.length || loading || !!error || !quote} onClick={proceed}>Me gusta. Continuar ↗</button><Link className="ai-alternative" to="/empezar">¿No sabes qué elegir? Te ayuda la IA ✧</Link></div></div>
    <section className="closing-cta"><span className="eyebrow">TU PRÓXIMO PASO</span><h2>Menos administrar.<br />Más hacer crecer tu negocio.</h2><Link className="btn" to="/empezar">Vamos a diseñarlo ↗</Link></section>
  </section>;
}
