import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './icons';
import { Contador, escalon } from './Movimiento';

/**
 * «Pulso»: la cabecera viva de un tablero. Una cifra protagonista que cuenta, su tendencia, una línea
 * que se dibuja con la serie real y fichas con lo que pide atención. Sin datos inventados: si la serie
 * está vacía, no se dibuja línea; si no hay con qué comparar, no se muestra tendencia.
 */
export interface FichaPulso { icono: string; texto: ReactNode; tono?: 'ok' | 'aviso' | 'error' | 'neutro'; ruta?: string }

export function Pulso({ etiqueta, valor, formato, tendencia, serie, serieEtiqueta, fichas, vivo = true, pie }: {
  etiqueta: string; valor: number; formato?: (n: number) => string; tendencia?: { pct: number; texto: string } | null;
  serie?: number[]; serieEtiqueta?: string; fichas: FichaPulso[]; vivo?: boolean; pie?: ReactNode;
}) {
  const sube = tendencia && tendencia.pct >= 0;
  return (
    <section className="pulso-hero" aria-label={etiqueta}>
      <div className="pulso-aurora" aria-hidden="true"><i /><i /><i /></div>
      <div className="pulso-principal">
        <span className="pulso-etiqueta">{vivo && <span className="pulso-vivo" aria-hidden="true" />}{etiqueta}</span>
        <Contador valor={valor} formato={formato} ms={1300} className="pulso-cifra" />
        {tendencia && (
          <span className={`pulso-tendencia ${sube ? 'sube' : 'baja'}`}>
            <Icon n={sube ? 'arriba' : 'abajo'} className="" size={14} />
            <b>{Math.abs(Math.round(tendencia.pct))} %</b> {tendencia.texto}
          </span>
        )}
        {pie && <span className="pulso-pie">{pie}</span>}
      </div>
      {serie && serie.length >= 3 && serie.some((v) => v > 0) && <Linea serie={serie} etiqueta={serieEtiqueta ?? etiqueta} />}
      {fichas.length > 0 && (
        <ul className="pulso-fichas">
          {fichas.map((f, i) => {
            const contenido = <><Icon n={f.icono} className="" size={15} /><span>{f.texto}</span></>;
            return <li key={i} className={`pulso-ficha t-${f.tono ?? 'neutro'}`} style={escalon(i + 2)}>{f.ruta ? <Link to={f.ruta}>{contenido}<Icon n="derecha" className="" size={13} /></Link> : <span className="pulso-ficha-txt">{contenido}</span>}</li>;
          })}
        </ul>
      )}
    </section>
  );
}

/** Línea de tendencia que se dibuja de izquierda a derecha y termina con un punto que late. */
function Linea({ serie, etiqueta }: { serie: number[]; etiqueta: string }) {
  const W = 260, H = 84, P = 6;
  const max = Math.max(...serie, 1), min = Math.min(...serie, 0);
  const x = (i: number) => P + (i * (W - 2 * P)) / Math.max(1, serie.length - 1);
  const y = (v: number) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const d = serie.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = `${d} L${x(serie.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
  return (
    <svg className="pulso-linea" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${etiqueta}: ${serie.join(', ')}`} preserveAspectRatio="none">
      <defs><linearGradient id="pulso-relleno" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".32" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path className="pulso-area" d={area} fill="url(#pulso-relleno)" />
      <path className="pulso-trazo" d={d} pathLength={1} />
      <circle className="pulso-fin" cx={x(serie.length - 1)} cy={y(serie[serie.length - 1])} r="4" />
    </svg>
  );
}
