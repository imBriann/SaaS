import { useEffect, useRef, useState } from 'react';

/**
 * Ritmo de lectura para estados que el servidor resuelve casi a la vez (el alta ocurre en una
 * transacción). Solo se pausa la PRESENTACIÓN de lo ya confirmado: nunca se muestra un paso que
 * el servidor no registró. Con «reducir movimiento» no hay esperas.
 */
const movimientoReducido = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Cuántos de `total` elementos confirmados se muestran: uno nuevo cada `ms`. */
export function useRevelado(total: number, ms = 650): number {
  const [n, setN] = useState(() => (movimientoReducido() ? total : 0));
  useEffect(() => {
    if (movimientoReducido() || n >= total) { if (n > total) setN(total); return; }
    const t = window.setTimeout(() => setN((x) => Math.min(total, x + 1)), n === 0 ? 250 : ms);
    return () => clearTimeout(t);
  }, [n, total, ms]);
  return movimientoReducido() ? total : n;
}

/**
 * Fase visible de un proceso con orden conocido: avanza de una en una, sosteniendo cada fase al
 * menos `minimos[fase]` ms, sin adelantarse a la fase real. Una fase fuera del orden (p. ej. un
 * error) se muestra de inmediato.
 */
export function useFaseMinima<T extends string>(real: T, orden: readonly T[], minimos: Partial<Record<T, number>>): T {
  const [visible, setVisible] = useState<T>(() => (movimientoReducido() || !orden.includes(real) ? real : orden[0]));
  const desde = useRef(Date.now());
  useEffect(() => {
    if (movimientoReducido() || !orden.includes(real) || !orden.includes(visible)) {
      if (visible !== real) { setVisible(real); desde.current = Date.now(); }
      return;
    }
    const iReal = orden.indexOf(real);
    const iVisible = orden.indexOf(visible);
    if (iVisible === iReal) return;
    if (iVisible > iReal) { setVisible(real); desde.current = Date.now(); return; }
    const resta = Math.max(0, (minimos[visible] ?? 0) - (Date.now() - desde.current));
    const t = window.setTimeout(() => { setVisible(orden[iVisible + 1]); desde.current = Date.now(); }, resta);
    return () => clearTimeout(t);
  }, [real, visible, orden, minimos]);
  return visible;
}
