import { useState } from 'react';
import { api, cop, num } from '../api';
import { PastillaCiclo, type CicloPlan, type PlanVista } from './facturacion/SelectorPlanes';
import { Cascada, Rodillo } from './facturacion/piezas';

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

/**
 * Resumen del alta. En la modalidad comercial es el plan elegido (Esencial, Negocio o Pro) con su ciclo: se
 * puede cambiar aquí mismo y el servidor recalcula el valor. En la institucional se muestra la cotización de siempre.
 */
export function ResumenAlta({ d, setD, loading = false }: { d: any; setD: (d: any) => void; loading?: boolean }) {
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const q = d?.cotizacion;
  if (!q?.plan || !Array.isArray(d.planes)) return <Quote quote={q} loading={loading} modalidad={d?.modalidad} />;
  const ciclo: CicloPlan = d.ciclo === 'ANUAL' ? 'ANUAL' : 'MENSUAL';
  const plan = d.planes.find((p: PlanVista) => p.codigo === q.plan.codigo) ?? d.planes[0];
  const recomendado = d.plan_recomendado && d.plan_recomendado !== plan.codigo ? d.planes.find((p: PlanVista) => p.codigo === d.plan_recomendado) : null;
  const cambiar = async (cambios: { plan_codigo?: string; ciclo?: CicloPlan }) => {
    if (guardando) return;
    setGuardando(true); setError('');
    try { setD(await api.patch(`/api/onboarding/borradores/${d.token}`, cambios)); }
    catch (e) { setError((e as Error).message); }
    finally { setGuardando(false); }
  };
  return <aside className="quote-card plan-alta" aria-busy={loading || guardando}>
    <div className="plan-alta-cab"><h3>Tu plan</h3><PastillaCiclo ciclo={ciclo} onCiclo={(c) => cambiar({ ciclo: c })} id="ciclo-alta" peq /></div>
    <div className="mini-planes alta" role="radiogroup" aria-label="Plan">
      {d.planes.map((p: PlanVista) => (
        <button key={p.codigo} type="button" role="radio" aria-checked={p.codigo === plan.codigo} disabled={guardando} className={`mini-plan ${p.codigo === plan.codigo ? 'elegido' : ''}`} onClick={() => p.codigo !== plan.codigo && cambiar({ plan_codigo: p.codigo })}>
          {p.codigo === d.plan_recomendado && <span className="chip-actual">✦ Sugerido</span>}
          <b>{p.nombre}</b>
          <span className="mini-precio"><Rodillo texto={cop(ciclo === 'ANUAL' ? p.anual_por_mes : p.mensual)} alMontar={false} /><small>/mes</small></span>
          <span className="tenue">{p.cuotas?.usuarios} personas · {num(Math.floor((p.cuotas?.tokens_ia ?? 0) / 5000 / 50) * 50)} respuestas IA</span>
        </button>
      ))}
    </div>
    <div className="plan-alta-total">
      <span className="sobretitulo">{ciclo === 'ANUAL' ? 'Pagas hoy · 12 meses' : 'Pagas hoy · primer mes'}</span>
      <Rodillo texto={cop(q.total)} className="proximo-cifra" alMontar={false} />
      <span className="tenue peq-txt">{ciclo === 'ANUAL' ? `Equivale a ${cop(plan.anual_por_mes)} al mes: ahorras ${cop(plan.ahorro_anual)}.` : `O ${cop(plan.anual)} por el año completo (2 meses gratis).`}</span>
    </div>
    <Cascada items={plan.caracteristicas} clave={`${plan.codigo}-alta`} className="dos-col ambar" retraso={0.05} />
    {recomendado && <p className="aviso peq-txt"><span>Para tu negocio sugerimos <b>{recomendado.nombre}</b>{d.recomendacion?.explicacion ? `: ${d.recomendacion.explicacion}` : '.'}</span> <button type="button" className="enlace" disabled={guardando} onClick={() => cambiar({ plan_codigo: recomendado.codigo })}>Usar {recomendado.nombre}</button></p>}
    {error && <p className="aviso-err peq-txt" role="alert">{error}</p>}
    <p className="quote-note">{q.nota} Puedes cambiar de plan después desde tu panel.</p>
  </aside>;
}
