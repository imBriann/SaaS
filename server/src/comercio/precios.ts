import { config } from '../config.js';
import { cop } from '../lib/util.js';

/**
 * Separación estricta (docs/pagos-whatsapp.md § Precios):
 *   1. precio oficial del producto (catálogo, nunca se modifica);
 *   2. total oficial del pedido (suma de líneas con los precios congelados);
 *   3. importe que se cobra (según el modo de precios CONGELADO en el pedido);
 *   4–6. importe reportado por Wompi, comisión y neto (los llena el webhook y la conciliación).
 * Todo en centavos enteros. El navegador y la IA nunca deciden el importe: solo este módulo, en el servidor.
 */
export type ModoPrecios = 'institutional_test' | 'official';
export interface PrecioConfig { modo: ModoPrecios; cargo_fijo_centavos: number | null; congelado_en: string }

/** Configuración vigente del servidor, lista para congelarse en un pedido. */
export function configVigente(ahora = new Date()): PrecioConfig {
  const modo = config.comercio.pricingMode;
  return { modo, cargo_fijo_centavos: modo === 'institutional_test' ? Math.round(config.comercio.testChargeCop) * 100 : null, congelado_en: ahora.toISOString() };
}

/** Valida una configuración congelada (viene de la base; se revisa igual por si alguien la alteró). */
export function configValida(c: unknown): PrecioConfig {
  const x = c as PrecioConfig;
  if (!x || (x.modo !== 'institutional_test' && x.modo !== 'official')) throw new Error('Configuración de precios congelada no válida');
  if (x.modo === 'institutional_test' && !(Number.isSafeInteger(x.cargo_fijo_centavos) && (x.cargo_fijo_centavos as number) >= 150000)) throw new Error('Importe fijo congelado no válido');
  return x;
}

/** Importe que se cobra, a partir del total oficial y la configuración CONGELADA del pedido. */
export function importeCobro(totalOficialCentavos: number, c: PrecioConfig): number {
  if (!Number.isSafeInteger(totalOficialCentavos) || totalOficialCentavos <= 0) throw new Error('Total oficial no válido');
  const v = configValida(c);
  return v.modo === 'official' ? totalOficialCentavos : (v.cargo_fijo_centavos as number);
}

export const pesos = (centavos: number) => cop(centavos / 100);

/** Texto para el cliente: precio oficial y lo que realmente pagará (en modo institucional son distintos). */
export function textoCobro(totalOficialCentavos: number, c: PrecioConfig): string {
  const cobro = importeCobro(totalOficialCentavos, c);
  if (c.modo === 'official') return `Total del pedido: ${pesos(totalOficialCentavos)} COP. Vas a pagar ${pesos(cobro)} COP.`;
  return `Este pedido participa en el modo de demostración institucional de Omnegia. El precio oficial del pedido es ${pesos(totalOficialCentavos)} COP, pero el cobro real de esta demostración será de ${pesos(cobro)} COP.`;
}
