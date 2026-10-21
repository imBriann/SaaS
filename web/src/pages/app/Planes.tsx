import { useEffect, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { api, cop } from '../../api';
import { Cargando, ErrorCarga, Modal, useApi } from '../../components/ui';
import { Icon } from '../../components/icons';
import { Cascada, Esfera, Rodillo } from '../../components/facturacion/piezas';
import { type Catalogo, type Ciclo, type PlanCat, corto, fechaCobro, textoConfirmar, tono, useCambioPlan } from './suscripcion/cambio';
import '../../facturacion.css';

const RESORTE = { type: 'spring' as const, stiffness: 300, damping: 30 };

/**
 * Matiz: elegir plan. Los planes inactivos son barras verticales y el elegido se expande; sin plan elegido
 * se ven como tarjetas iguales. Precios y características salen del catálogo real; el cargo exacto de un
 * cambio lo calcula el servidor y se muestra antes de confirmar.
 */
export function Planes() {
  const { data, error, recargar } = useApi<Catalogo>(() => api.get('/api/t/suscripcion/planes'), []);
  const [cicloElegido, setCiclo] = useState<Ciclo | null>(null);
  const [activo, setActivo] = useState<string | null>(null);
  const [hoja, setHoja] = useState(false);
  const nav = useNavigate();
  const reducido = useReducedMotion();
  const cambio = useCambioPlan((r) => nav('/suscripcion', { state: { resultado: r } }));
  const ciclo: Ciclo = cicloElegido ?? data?.ciclo ?? 'MENSUAL';
  const planes = data?.planes ?? [];

  useEffect(() => {
    const tecla = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (hoja || t.closest('input, textarea, select, .pila, dialog')) return;
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
  }, [activo, planes, hoja]);

  const elegir = async (p: PlanCat) => {
    const c = await cambio.cotizar(p.codigo, ciclo);
    if (c) setHoja(true);
  };

  return (
    <div className="matiz">
      <div className="matiz-volver"><Link to="/suscripcion" className="btn peq fantasma"><Icon n="atras" className="" size={14} />Suscripción</Link></div>
      <header className="matiz-cab">
        <h1>Elige tu <span className="subrayado">plan<svg viewBox="0 0 120 14" preserveAspectRatio="none" aria-hidden="true"><path d="M3 9 C 18 3, 30 13, 46 7 S 76 3, 90 8 S 110 10, 117 5" /></svg></span></h1>
        <p>Cambia de plan cuando quieras, sin permanencia. Antes de pagar ves el valor exacto y nada se cobra solo.</p>
        <div className="matiz-ciclo">
          <div className="pastilla-ciclo" role="radiogroup" aria-label="Forma de pago">
            {(['MENSUAL', 'ANUAL'] as Ciclo[]).map((c) => (
              <button key={c} type="button" role="radio" aria-checked={ciclo === c} className={ciclo === c ? 'on' : ''} onClick={() => setCiclo(c)}>
                {ciclo === c && <motion.span layoutId="ciclo-fondo" className="pastilla-fondo" transition={reducido ? { duration: 0 } : RESORTE} />}
                <span>{c === 'MENSUAL' ? 'Mensual' : 'Anual'}</span>
              </button>
            ))}
          </div>
          <span className="chip-gratis">+ 2 meses gratis</span>
        </div>
      </header>

      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <div className="tarjeta"><Cargando filas={6} /></div> : (
        <LayoutGroup>
          <div className={`matiz-planes ${activo ? 'con-activo' : 'general'}`}>
            {planes.map((p, i) => {
              const modo = !activo ? 'tarjeta' : activo === p.codigo ? 'abierto' : 'barra';
              const t = tono(p.codigo);
              const precioMes = ciclo === 'MENSUAL' ? p.mensual : p.anual_por_mes;
              const estilo = { '--plan-fondo': t.fondo, '--plan-boton': t.boton, '--plan-tinta': t.tinta, '--plan-c2': t.c2 } as CSSProperties;
              const chip = p.actual ? 'Tu plan' : p.destacado ? 'Más elegido' : `Plan ${String(i + 1).padStart(2, '0')}`;
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
                          {p.actual && ciclo === data.ciclo && data.estado !== 'ACTIVA' ? (
                            <Link to="/suscripcion" className="btn-plan">Renovar tu plan<Icon n="derecha" className="" size={15} /></Link>
                          ) : <button type="button" className="btn-plan" disabled={(p.actual && ciclo === data.ciclo) || cambio.cargando} onClick={() => elegir(p)}>
                            {p.actual && ciclo === data.ciclo ? 'Es tu plan actual' : p.actual ? `Pasar a ${ciclo === 'ANUAL' ? 'anual' : 'mensual'}` : `Elegir ${p.nombre}`}
                            {!(p.actual && ciclo === data.ciclo) && <Icon n="derecha" className="" size={15} />}
                          </button>}
                          <p className="abierto-nota">Sin permanencia · verás el valor exacto antes de pagar</p>
                          {cambio.error && !hoja && <p className="aviso-err peq-txt" role="alert">{cambio.error}</p>}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              );
            })}
          </div>
        </LayoutGroup>
      )}
      <p className="matiz-ayuda">Toca un plan para ver lo que incluye · <kbd>←</kbd> <kbd>→</kbd> para cambiar · <kbd>Esc</kbd> para volver</p>
      {data?.cambio_programado && <p className="matiz-ayuda">Tienes un cambio programado a {data.cambio_programado.nombre} desde el {fechaCobro(data.cambio_programado.desde)}. Puedes deshacerlo en Suscripción.</p>}

      {hoja && cambio.cot && (
        <Modal titulo={cambio.cot.tipo === 'SIN_CAMBIO' ? 'Sin cambios' : `Cambiar a ${cambio.cot.a.nombre}${cambio.cot.a.ciclo === 'ANUAL' ? ' anual' : ''}`} onCerrar={() => { setHoja(false); cambio.limpiar(); }}
          pie={<>
            <button type="button" className="btn" onClick={() => { setHoja(false); cambio.limpiar(); }}>Cancelar</button>
            <button type="button" className="btn primario" disabled={cambio.enviando || !!cambio.cot.bloqueo || cambio.cot.tipo === 'SIN_CAMBIO'} onClick={cambio.confirmar}>{cambio.enviando ? 'Preparando…' : textoConfirmar(cambio.cot)}</button>
          </>}>
          <ResumenCambio c={cambio.cot} />
          {cambio.error && <p className="aviso-err peq-txt" role="alert" style={{ marginTop: 10 }}>{cambio.error}</p>}
        </Modal>
      )}
    </div>
  );
}

/** Lo que pasaría con el cambio, tal como lo calculó el servidor. */
export function ResumenCambio({ c }: { c: NonNullable<ReturnType<typeof useCambioPlan>['cot']> }) {
  return (
    <div className="resumen-cambio">
      <p>{c.explicacion}</p>
      <dl className="resumen-pago">
        <div><dt>Hoy pagas</dt><dd className="cifra">{cop(c.cargo)}</dd></div>
        {c.credito > 0 && <div><dt>Descuento por días no usados</dt><dd className="cifra">−{cop(c.credito)}</dd></div>}
        <div><dt>{c.tipo === 'PROGRAMADO' ? 'Se aplica el' : 'Desde'}</dt><dd>{fechaCobro(c.aplica_desde)}</dd></div>
        <div><dt>Próximo cobro</dt><dd className="cifra">{cop(c.proximo_cobro.monto)} · {fechaCobro(c.proximo_cobro.fecha)}</dd></div>
      </dl>
      {c.modulos_que_se_apagan.length > 0 && <p className="aviso peq-txt"><Icon n="alerta" className="" size={14} />Se apagan: {c.modulos_que_se_apagan.join(', ')}. Tus datos se conservan.</p>}
      {c.bloqueo && <p className="aviso-err peq-txt" role="alert">{c.bloqueo}</p>}
      {c.cargo > 0 && <p className="tenue peq-txt">El pago se hace en la pasarela segura; tu plan cambia cuando la pasarela confirma el pago.</p>}
    </div>
  );
}
