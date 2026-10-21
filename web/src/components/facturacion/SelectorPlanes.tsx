import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { cop } from '../../api';
import { Icon } from '../icons';
import { Cascada, Esfera, Rodillo } from './piezas';
import '../../facturacion.css';

const RESORTE = { type: 'spring' as const, stiffness: 300, damping: 30 };

export type CicloPlan = 'MENSUAL' | 'ANUAL';
export interface PlanVista {
  codigo: string; nombre: string; descripcion: string; mensual: number; anual: number; anual_por_mes: number; ahorro_anual: number;
  caracteristicas: string[]; destacado: boolean; actual?: boolean; pactado?: boolean;
  cuotas?: { tokens_ia: number; mensajes: number; documentos: number; usuarios: number };
}

/** Color de cada plan (esfera, barra y botón). */
export const TONOS: Record<string, { c1: string; c2: string; fondo: string; boton: string; tinta: string }> = {
  esencial: { c1: '#ffe3ec', c2: '#ef7fa6', fondo: 'linear-gradient(165deg, #ffe6ee 0%, #f9bcd1 100%)', boton: '#f3a0bf', tinta: '#5b1d36' },
  negocio: { c1: '#ece6ff', c2: '#9a82ef', fondo: 'linear-gradient(165deg, #efe9ff 0%, #c9bbf8 55%, #b9dcf7 100%)', boton: '#b7a5f6', tinta: '#2e1f6b' },
  pro: { c1: '#e2f2ff', c2: '#5eaee9', fondo: 'linear-gradient(165deg, #e4f3ff 0%, #a9d4f5 100%)', boton: '#8fc7f0', tinta: '#123a5c' },
};
export const tono = (codigo: string) => TONOS[codigo] ?? TONOS.negocio;

/** Precio corto para las barras colapsadas: $229k. */
export const corto = (n: number) => `$${Math.round(n / 1000)}k`;

/** Mensual / Anual en forma de pastilla, con el fondo que se desliza. */
export function PastillaCiclo({ ciclo, onCiclo, id, peq = false }: { ciclo: CicloPlan; onCiclo: (c: CicloPlan) => void; id: string; peq?: boolean }) {
  const reducido = useReducedMotion();
  return (
    <div className={`pastilla-ciclo ${peq ? 'peq' : ''}`} role="radiogroup" aria-label="Forma de pago">
      {(['MENSUAL', 'ANUAL'] as CicloPlan[]).map((c) => (
        <button key={c} type="button" role="radio" aria-checked={ciclo === c} className={ciclo === c ? 'on' : ''} onClick={() => onCiclo(c)}>
          {ciclo === c && <motion.span layoutId={id} className="pastilla-fondo" transition={reducido ? { duration: 0 } : RESORTE} />}
          <span>{c === 'MENSUAL' ? 'Mensual' : 'Anual'}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Matiz: elegir plan. Los planes inactivos son barras verticales y el elegido se expande; sin plan elegido
 * se ven como tarjetas iguales. Teclado: ← → cambia de plan, Esc vuelve a la vista general. En móvil, vertical.
 * Lo usa el sitio público (antes de contratar) y el panel (cambio de plan); cada uno decide la acción del botón.
 */
export function SelectorPlanes({ planes, ciclo, onCiclo, accion, subtitulo, pausarTeclado = false, chipActual = 'Tu plan', pie }: {
  planes: PlanVista[]; ciclo: CicloPlan; onCiclo: (c: CicloPlan) => void;
  /** Botón principal del plan abierto. */
  accion: (p: PlanVista) => ReactNode;
  subtitulo: ReactNode; pausarTeclado?: boolean; chipActual?: string; pie?: ReactNode;
}) {
  const [activo, setActivo] = useState<string | null>(null);
  const reducido = useReducedMotion();

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (pausarTeclado || t.closest('input, textarea, select, .pila, dialog')) return;
      if (e.key === 'Escape' && activo) { e.preventDefault(); setActivo(null); }
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      if (!planes.length) return;
      e.preventDefault();
      const i = activo ? planes.findIndex((p) => p.codigo === activo) : -1;
      const sig = e.key === 'ArrowRight' ? (i + 1) % planes.length : (i <= 0 ? planes.length - 1 : i - 1);
      setActivo(planes[sig].codigo);
    };
    window.addEventListener('keydown', tecla);
    return () => window.removeEventListener('keydown', tecla);
  }, [activo, planes, pausarTeclado]);

  return (
    <>
      <header className="matiz-cab">
        <h1>Elige tu <span className="subrayado">plan<svg viewBox="0 0 120 14" preserveAspectRatio="none" aria-hidden="true"><path d="M3 9 C 18 3, 30 13, 46 7 S 76 3, 90 8 S 110 10, 117 5" /></svg></span></h1>
        <p>{subtitulo}</p>
        <div className="matiz-ciclo">
          <PastillaCiclo ciclo={ciclo} onCiclo={onCiclo} id="ciclo-fondo" />
          <span className="chip-gratis">+ 2 meses gratis</span>
        </div>
      </header>
      <LayoutGroup>
        <div className={`matiz-planes ${activo ? 'con-activo' : 'general'}`}>
          {planes.map((p, i) => {
            const modo = !activo ? 'tarjeta' : activo === p.codigo ? 'abierto' : 'barra';
            const t = tono(p.codigo);
            const precioMes = ciclo === 'MENSUAL' ? p.mensual : p.anual_por_mes;
            const estilo = { '--plan-fondo': t.fondo, '--plan-boton': t.boton, '--plan-tinta': t.tinta, '--plan-c2': t.c2 } as CSSProperties;
            const chip = p.actual ? chipActual : p.destacado ? 'Más elegido' : `Plan ${String(i + 1).padStart(2, '0')}`;
            return (
              <motion.div key={p.codigo} layout={!reducido} transition={RESORTE} className={`matiz-plan modo-${modo}`} style={estilo}>
                <AnimatePresence mode="popLayout" initial={false}>
                  {modo === 'barra' && (
                    <motion.button key="barra" type="button" className="plan-barra" onClick={() => setActivo(p.codigo)} aria-label={`Ver el plan ${p.nombre}: ${cop(precioMes)} al mes`}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.2, delay: reducido ? 0 : 0.1 }}>
                      <span className="barra-num">{String(i + 1).padStart(2, '0')}</span>
                      <Esfera c1={t.c1} c2={t.c2} tam={26} flota={false} />
                      <span className="barra-nombre">{p.nombre}</span>
                      <span className="barra-precio"><Rodillo texto={corto(precioMes)} alMontar={false} /></span>
                    </motion.button>
                  )}
                  {modo === 'tarjeta' && (
                    <motion.button key="tarjeta" type="button" className="plan-tarjeta" onClick={() => setActivo(p.codigo)} aria-label={`Ver lo que incluye el plan ${p.nombre}`}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.25, delay: reducido ? 0 : 0.18 }}>
                      <span className={`chip-plan ${p.destacado || p.actual ? 'fuerte' : ''}`}>{p.destacado && !p.actual && <i aria-hidden="true">✦</i>}{chip}</span>
                      <span className="tarjeta-esfera"><Esfera c1={t.c1} c2={t.c2} tam={104} /></span>
                      <span className="tarjeta-cuerpo">
                        <span className="tarjeta-tit"><b>{p.nombre}</b><span className="tarjeta-flecha" aria-hidden="true"><Icon n="derecha" className="" size={14} /></span></span>
                        <span className="tarjeta-desc">{p.descripcion}</span>
                        <span className="tarjeta-precio"><Rodillo texto={cop(precioMes)} /><small>/ mes</small></span>
                        <span className="tarjeta-lista">{p.caracteristicas.slice(0, 3).map((c) => <span key={c}><i aria-hidden="true" />{c}</span>)}</span>
                      </span>
                    </motion.button>
                  )}
                  {modo === 'abierto' && (
                    <motion.div key="abierto" className="plan-abierto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.08 } }} transition={{ duration: 0.25, delay: reducido ? 0 : 0.32 }}>
                      <div className="abierto-lado">
                        <span className="chip-plan fuerte">{p.destacado && !p.actual && <i aria-hidden="true">✦</i>}{chip}</span>
                        <span className="abierto-esfera"><Esfera c1={t.c1} c2={t.c2} tam={150} /></span>
                        <h2>{p.nombre}</h2>
                        <p>{p.descripcion}</p>
                      </div>
                      <div className="abierto-hoja">
                        <button type="button" className="abierto-cerrar" onClick={() => setActivo(null)} aria-label="Volver a todos los planes"><Icon n="x" className="" size={14} /></button>
                        <div className="abierto-precio"><Rodillo texto={cop(precioMes)} /><small>/ mes</small></div>
                        <p className="abierto-nota-precio">{ciclo === 'ANUAL' ? `Facturado ${cop(p.anual)} al año · ahorras ${cop(p.ahorro_anual)}` : `${cop(p.anual)} si pagas el año completo`}{p.pactado ? ' · conservas tu precio actual' : ''}</p>
                        <Cascada items={p.caracteristicas} clave={`${p.codigo}`} retraso={reducido ? 0 : 0.42} />
                        {accion(p)}
                        <p className="abierto-nota">Sin permanencia · verás el valor exacto antes de pagar</p>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </LayoutGroup>
      <p className="matiz-ayuda">Toca un plan para ver lo que incluye · <kbd>←</kbd> <kbd>→</kbd> para cambiar · <kbd>Esc</kbd> para volver</p>
      {pie}
    </>
  );
}
