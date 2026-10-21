import { useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Icon } from './icons';
import { OrbeCara } from './ia/OrbeCara';

/**
 * Mientras el servidor crea la empresa después del pago: una espera tranquila con Omnegia IA y los pasos
 * reales que ya terminaron. El espectáculo de la creación ocurre en el panel, donde la IA arma el inicio frente
 * a la persona; aquí solo se informa (nada se marca hecho sin que el servidor lo diga).
 */
export function PreparandoEspacio({ nombre, titulo, detalle, pasos, listo, aviso, onDescargar, descargando, reciboListo, onCompleto }: {
  nombre: string; titulo: string; detalle: string; pasos: { clave: string; nombre: string; hecho: boolean }[]; listo: boolean;
  aviso?: string | null; onDescargar: () => void; descargando: boolean; reciboListo: boolean; onCompleto: () => void;
}) {
  const reducido = useReducedMotion();
  useEffect(() => {
    if (!listo) return;
    const t = window.setTimeout(onCompleto, reducido ? 0 : 900);
    return () => window.clearTimeout(t);
  }, [listo]); // eslint-disable-line react-hooks/exhaustive-deps
  const hechos = pasos.filter((p) => p.hecho).length;
  return (
    <section className="preparando" aria-live="polite" aria-busy={!listo}>
      <motion.div className="preparando-orbe" animate={reducido ? undefined : { y: [0, -8, 0] }} transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}>
        <OrbeCara tamano={88} cara={listo ? 'feliz' : 'pensando'} etiqueta="Omnegia IA" />
      </motion.div>
      <h1>{titulo}</h1>
      <p className="preparando-detalle">{detalle}</p>
      <div className="preparando-barra" role="progressbar" aria-valuemin={0} aria-valuemax={pasos.length} aria-valuenow={hechos} aria-label="Pasos completados">
        <motion.span initial={false} animate={{ scaleX: listo ? 1 : Math.max(0.06, hechos / pasos.length) }} transition={{ type: 'spring', stiffness: 80, damping: 18 }} />
      </div>
      <ul className="preparando-pasos">
        {pasos.map((p) => (
          <li key={p.clave} className={p.hecho ? 'hecho' : ''}>
            <span aria-hidden="true">{p.hecho ? <Icon n="ok" className="" size={12} /> : <i />}</span>{p.nombre}
            <span className="sr">{p.hecho ? ' (listo)' : ' (en curso)'}</span>
          </li>
        ))}
      </ul>
      <p className="preparando-nota"><Icon n="ia" className="" size={14} /><span>Cuando entres, Omnegia IA armará el inicio de <b>{nombre}</b> frente a ti, con tus datos reales.</span></p>
      <button type="button" className="btn sutil peq" disabled={!reciboListo || descargando} onClick={onDescargar}><Icon n="descargar" size={15} className="" />{descargando ? 'Preparando…' : reciboListo ? 'Descargar recibo y documentos' : 'Recibo en preparación'}</button>
      {aviso && <p className="finish-return-note">{aviso}</p>}
    </section>
  );
}
