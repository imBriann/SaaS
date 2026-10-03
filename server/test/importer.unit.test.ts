import { describe, expect, it } from 'vitest';
import { parsePrecio } from '../src/onboarding/importer.js';

/**
 * Pruebas de caja blanca por camino básico (McCabe) de parsePrecio.
 * V(G) = 8 (4 if + 3 operadores ternarios + 1): un caso por camino independiente.
 */
describe('parsePrecio — camino básico, V(G) = 8', () => {
  it.each([
    ['C1 vacío → null', '', null],
    ['C2 «25 mil» → 25000', '25 mil', 25000],
    ['C3 separador de miles sin decimales', '$ 25.000', 25000],
    ['C4 separador de miles con decimales', '1.500,50', 1500.5],
    ['C5 coma decimal sin miles', '12,5', 12.5],
    ['C6 texto no numérico → null', 'gratis', null],
    ['C7 negativo → null', '-5000', null],
    ['C8 límite superior aceptado', '999999999', 999999999],
    ['C8b fuera de rango → null', '1000000000', null],
  ])('%s', (_caso, entrada, esperado) => {
    expect(parsePrecio(entrada)).toBe(esperado);
  });
});
