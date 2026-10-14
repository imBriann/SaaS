/**
 * Dinero en centavos enteros. La base guarda numeric(14,2); los cálculos se hacen
 * en enteros para que la suma de líneas, descuentos e impuestos no acumule errores
 * de coma flotante.
 */
export const aCentavos = (pesos: number | string): number => Math.round(Number(pesos) * 100);
export const aPesos = (centavos: number): number => Math.round(centavos) / 100;

export interface LineaEntrada { precioUnitario: number; cantidad: number; ivaPct: number; descuentoPct?: number }
export interface LineaCalculada { bruto: number; descuento: number; total: number; base: number; impuesto: number }

/**
 * Precio con IVA incluido (convención del micronegocio). Total = bruto − descuento;
 * la base y el impuesto se derivan del total. Todo en centavos.
 */
export function calcularLinea(l: LineaEntrada): LineaCalculada {
  if (!(l.cantidad > 0)) throw new Error('cantidad inválida');
  const pct = Math.min(100, Math.max(0, l.descuentoPct ?? 0));
  const bruto = Math.round(aCentavos(l.precioUnitario) * l.cantidad);
  const descuento = Math.round((bruto * pct) / 100);
  const total = bruto - descuento;
  const base = Math.round(total / (1 + l.ivaPct / 100));
  return { bruto, descuento, total, base, impuesto: total - base };
}

export function sumarLineas(ls: LineaCalculada[]) {
  return ls.reduce((a, l) => ({ bruto: a.bruto + l.bruto, descuento: a.descuento + l.descuento, total: a.total + l.total, base: a.base + l.base, impuesto: a.impuesto + l.impuesto }),
    { bruto: 0, descuento: 0, total: 0, base: 0, impuesto: 0 });
}
