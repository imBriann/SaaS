import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './icons';
import { Contador } from './Movimiento';

/**
 * Piezas de los tableros (Inicio de las empresas y Resumen del operador). Todas dibujan datos reales
 * que llegan del servidor: si no hay datos, no inventan una forma. El movimiento es de entrada (la
 * cifra cuenta, el anillo se llena, las barras crecen) y se apaga con «reducir movimiento».
 */

const reducido = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** true un instante después de montar: permite que la transición CSS parta de cero. */
function useMontado() {
  const [m, setM] = useState(reducido());
  useEffect(() => { const t = requestAnimationFrame(() => requestAnimationFrame(() => setM(true))); return () => cancelAnimationFrame(t); }, []);
  return m;
}

export type Tono = 'acento' | 'ok' | 'aviso' | 'error' | 'ia' | 'persona';

/** Anillo de progreso: la parte llena es valor/max. */
export function Anillo({ valor, max = 100, tam = 72, grosor = 8, tono = 'acento', etiqueta, children }: { valor: number; max?: number; tam?: number; grosor?: number; tono?: Tono; etiqueta: string; children?: ReactNode }) {
  const montado = useMontado();
  const r = (tam - grosor) / 2;
  const c = 2 * Math.PI * r;
  const p = max > 0 ? Math.max(0, Math.min(1, valor / max)) : 0;
  return (
    <span className={`tb-anillo t-${tono}`} style={{ width: tam, height: tam }} role="img" aria-label={etiqueta}>
      <svg viewBox={`0 0 ${tam} ${tam}`} width={tam} height={tam} aria-hidden="true">
        <circle className="tb-anillo-fondo" cx={tam / 2} cy={tam / 2} r={r} strokeWidth={grosor} />
        <circle className="tb-anillo-uso" cx={tam / 2} cy={tam / 2} r={r} strokeWidth={grosor} strokeDasharray={c} strokeDashoffset={montado ? c * (1 - p) : c} />
      </svg>
      {children !== undefined && <span className="tb-anillo-centro">{children}</span>}
    </span>
  );
}

/** Mini gráfica de línea con área (tendencia de una tarjeta). Necesita al menos dos puntos. */
export function Chispa({ serie, tono = 'acento', etiqueta }: { serie: number[]; tono?: Tono; etiqueta: string }) {
  const id = useId().replace(/:/g, '');
  if (serie.length < 2) return null;
  const W = 120, H = 40, P = 3;
  const max = Math.max(...serie, 1), min = Math.min(...serie, 0);
  const x = (i: number) => P + (i * (W - 2 * P)) / (serie.length - 1);
  const y = (v: number) => H - P - ((v - min) / (max - min || 1)) * (H - 2 * P);
  const d = serie.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className={`tb-chispa t-${tono}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`${etiqueta}: ${serie.join(', ')}`}>
      <defs><linearGradient id={`ch${id}`} x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="currentColor" stopOpacity=".28" /><stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
      <path className="tb-chispa-area" d={`${d} L${x(serie.length - 1)},${H} L${x(0)},${H} Z`} fill={`url(#ch${id})`} />
      <path className="tb-chispa-linea" d={d} pathLength={1} />
      <circle className="tb-chispa-fin" cx={x(serie.length - 1)} cy={y(serie[serie.length - 1])} r="2.6" />
    </svg>
  );
}

/** Tarjeta de cifra del tablero: icono, cifra que cuenta, detalle y, opcionalmente, una gráfica. */
export function TarjetaCifra({ icono, etiqueta, valor, formato, detalle, ruta, tono = 'acento', grafica, i = 0 }: {
  icono: string; etiqueta: string; valor: number | string; formato?: (n: number) => string; detalle?: ReactNode; ruta?: string; tono?: Tono; grafica?: ReactNode; i?: number;
}) {
  const cuerpo = (
    <>
      <span className="tb-cifra-cab"><span className={`tb-icono t-${tono}`}><Icon n={icono} className="" size={17} /></span><span className="tb-cifra-etiqueta">{etiqueta}</span>{ruta && <Icon n="derecha" className="tb-cifra-ir" size={15} />}</span>
      <span className="tb-cifra-fila">
        <span className="tb-cifra-valor">{typeof valor === 'number' ? <Contador valor={valor} formato={formato} ms={1100} /> : valor}</span>
        {grafica && <span className="tb-cifra-grafica">{grafica}</span>}
      </span>
      {detalle && <span className="tb-cifra-detalle">{detalle}</span>}
    </>
  );
  const estilo = { ['--i' as any]: i };
  return ruta ? <Link to={ruta} className="tb-cifra" style={estilo}>{cuerpo}</Link> : <div className="tb-cifra" style={estilo}>{cuerpo}</div>;
}

/** Barras verticales con el valor de cada una al pasar el cursor (o al tocarla). */
export function BarrasVivas({ datos, formato = (n) => String(n), etiqueta, alto = 168, tono = 'acento' }: {
  datos: { clave: string; corto: string; valor: number; destacado?: boolean }[]; formato?: (n: number) => string; etiqueta: string; alto?: number; tono?: Tono;
}) {
  const montado = useMontado();
  const [activa, setActiva] = useState<number | null>(null);
  const max = Math.max(1, ...datos.map((d) => d.valor));
  const total = datos.reduce((s, d) => s + d.valor, 0);
  const mostrar = activa ?? datos.findIndex((d) => d.destacado);
  const sel = mostrar >= 0 ? datos[mostrar] : null;
  // Con muchas barras se rotula una de cada pocas para que las etiquetas no se monten.
  const cada = datos.length > 16 ? Math.ceil(datos.length / 8) : 1;
  return (
    <div className={`tb-barras t-${tono}`} role="img" aria-label={`${etiqueta}: ${datos.map((d) => `${d.corto} ${formato(d.valor)}`).join(', ')}`}>
      <div className="tb-barras-cab" aria-hidden="true">
        <b>{sel ? formato(sel.valor) : formato(total)}</b>
        <span>{sel ? sel.corto : 'en el periodo'}</span>
      </div>
      <div className="tb-barras-zona" style={{ height: alto }} onMouseLeave={() => setActiva(null)}>
        <span className="tb-barras-guia" style={{ bottom: '50%' }} aria-hidden="true" />
        <span className="tb-barras-guia" style={{ bottom: '100%' }} aria-hidden="true" />
        {datos.map((d, i) => (
          <button key={d.clave} type="button" tabIndex={-1} aria-hidden="true" className={`tb-barra ${i === mostrar ? 'on' : ''} ${d.destacado ? 'destacada' : ''}`}
            onMouseEnter={() => setActiva(i)} onFocus={() => setActiva(i)} onClick={() => setActiva(i)} style={{ ['--i' as any]: i }}>
            <i style={{ height: montado ? `${Math.max(d.valor ? 4 : 1.5, (d.valor / max) * 100)}%` : '0%' }} />
          </button>
        ))}
      </div>
      <div className="tb-barras-ejes" aria-hidden="true">{datos.map((d, i) => <span key={d.clave} className={i === mostrar ? 'on' : ''}>{i % cada === 0 || i === datos.length - 1 ? d.corto : ''}</span>)}</div>
    </div>
  );
}

/** Dona por partes (p. ej. empresas por estado), con su leyenda. Las partes en cero no se dibujan. */
export function Dona({ partes, centro, sub, etiqueta }: { partes: { etiqueta: string; valor: number; color: string }[]; centro: ReactNode; sub: string; etiqueta: string }) {
  const montado = useMontado();
  const total = partes.reduce((s, p) => s + p.valor, 0);
  const R = 52, G = 14, C = 2 * Math.PI * R;
  let acumulado = 0;
  return (
    <div className="tb-dona">
      <span className="tb-dona-grafica" role="img" aria-label={`${etiqueta}: ${partes.map((p) => `${p.etiqueta} ${p.valor}`).join(', ')}`}>
        <svg viewBox="0 0 136 136" width="150" height="150" aria-hidden="true">
          <circle cx="68" cy="68" r={R} fill="none" stroke="var(--superficie-3)" strokeWidth={G} />
          {total > 0 && partes.filter((p) => p.valor > 0).map((p, i) => {
            const largo = (p.valor / total) * C;
            const seg = <circle key={p.etiqueta} className="tb-dona-seg" cx="68" cy="68" r={R} fill="none" stroke={p.color} strokeWidth={G}
              strokeDasharray={`${montado ? Math.max(0, largo - 2) : 0} ${C}`} strokeDashoffset={-acumulado} style={{ ['--i' as any]: i }} />;
            acumulado += largo;
            return seg;
          })}
        </svg>
        <span className="tb-dona-centro"><b>{centro}</b><span>{sub}</span></span>
      </span>
      <ul className="tb-dona-leyenda">
        {partes.map((p) => <li key={p.etiqueta} className={p.valor ? '' : 'cero'}><i style={{ background: p.color }} /><span>{p.etiqueta}</span><b>{p.valor}</b></li>)}
      </ul>
    </div>
  );
}

/** Barras horizontales (p. ej. uso de módulos): cada una crece hasta su parte del máximo. */
export function BarrasH({ datos, formato = (n) => String(n) }: { datos: { etiqueta: string; valor: number }[]; formato?: (n: number) => string }) {
  const montado = useMontado();
  const max = Math.max(1, ...datos.map((d) => d.valor));
  return (
    <ul className="tb-barrash">
      {datos.map((d, i) => (
        <li key={d.etiqueta} style={{ ['--i' as any]: i }}>
          <span className="tb-barrash-txt"><span>{d.etiqueta}</span><b>{formato(d.valor)}</b></span>
          <span className="tb-barrash-pista"><i style={{ width: montado ? `${(d.valor / max) * 100}%` : '0%' }} /></span>
        </li>
      ))}
    </ul>
  );
}
