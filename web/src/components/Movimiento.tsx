import { useEffect, useRef, useState, type CSSProperties } from 'react';

/**
 * Movimiento del panel: animaciones con propósito (confirmar un cobro, cifras que cuentan, entradas).
 * Todas respetan «reducir movimiento» del sistema: en ese caso el valor final aparece de inmediato.
 * Solo se animan transform y opacity (o números en texto), nada que mueva el diseño de la página.
 */
export function movimientoReducido() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Cifra que cuenta hasta su valor con una curva que frena al final. Cuando el valor cambia, sigue
 * desde lo que se ve (no vuelve a cero). Los lectores de pantalla reciben solo el valor final.
 */
export function Contador({ valor, formato = (n: number) => String(Math.round(n)), ms = 700, desdeCero = true, className }: {
  valor: number; formato?: (n: number) => string; ms?: number; desdeCero?: boolean; className?: string;
}) {
  const [mostrado, setMostrado] = useState(() => (desdeCero && !movimientoReducido() ? 0 : valor));
  const actual = useRef(mostrado);
  useEffect(() => {
    if (movimientoReducido() || ms <= 0) { actual.current = valor; setMostrado(valor); return; }
    const inicio = actual.current;
    const delta = valor - inicio;
    if (!delta) return;
    let raf = 0;
    const t0 = performance.now();
    const paso = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const n = inicio + delta * (1 - Math.pow(1 - p, 3));
      actual.current = n;
      setMostrado(n);
      if (p < 1) raf = requestAnimationFrame(paso);
    };
    raf = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(raf);
  }, [valor, ms]);
  return <span className={className}><span aria-hidden="true">{formato(mostrado)}</span><span className="sr">{formato(valor)}</span></span>;
}

/** Marca de éxito: el anillo se dibuja, el visto entra y un destello de partículas sale del centro. */
export function MarcaExito({ tamano = 76, tono = 'ok' }: { tamano?: number; tono?: 'ok' | 'neutro' }) {
  return (
    <span className={`marca-exito ${tono}`} style={{ '--t': `${tamano}px` } as CSSProperties} aria-hidden="true">
      {Array.from({ length: 10 }).map((_, i) => <i key={i} style={{ '--a': `${i * 36}deg`, '--d': `${(i % 3) * 40}ms` } as CSSProperties} />)}
      <svg width={tamano} height={tamano} viewBox="0 0 76 76">
        <circle className="me-anillo" cx="38" cy="38" r="34" />
        <path className="me-visto" d="M24 39.5 L34 49.5 L53 29" />
      </svg>
    </span>
  );
}

/** Índice para entradas escalonadas (las primeras filas entran una tras otra; el resto sin espera). */
export const escalon = (i: number, maximo = 14): CSSProperties => ({ '--i': Math.min(i, maximo) } as CSSProperties);
