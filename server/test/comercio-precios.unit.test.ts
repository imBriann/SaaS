import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { configVigente, importeCobro, textoCobro, type PrecioConfig } from '../src/comercio/precios.js';

/** Fase 3 · Precios: el importe lo decide solo el servidor, con la configuración congelada del pedido. */
const original = { ...config.comercio };
afterEach(() => { Object.assign(config.comercio, original); });
const inst = (): PrecioConfig => ({ modo: 'institutional_test', cargo_fijo_centavos: 150000, congelado_en: '2026-10-31T00:00:00Z' });
const ofi = (): PrecioConfig => ({ modo: 'official', cargo_fijo_centavos: null, congelado_en: '2026-10-31T00:00:00Z' });

describe('Modo institucional', () => {
  it('producto de $80.000 → cobro de $1.500 (150000 centavos)', () => expect(importeCobro(8_000_000, inst())).toBe(150_000));
  it('producto de $200.000 → cobro de $1.500', () => expect(importeCobro(20_000_000, inst())).toBe(150_000));
  it('pedido de varios productos → un único cobro de $1.500', () => expect(importeCobro(8_000_000 + 2 * 3_500_000 + 990_000, inst())).toBe(150_000));
  it('explica la diferencia entre el precio oficial y el cobro real', () => {
    const t = textoCobro(8_000_000, inst());
    expect(t).toMatch(/demostración institucional de Omnegia/);
    expect(t).toMatch(/precio oficial del pedido es \$80\.000 COP/);
    expect(t).toMatch(/cobro real de esta demostración será de \$1\.500 COP/);
  });
});

describe('Modo oficial', () => {
  it('se cobra el total completo', () => expect(importeCobro(8_000_000, ofi())).toBe(8_000_000));
  it('no aplica el importe fijo', () => expect(importeCobro(20_000_000, ofi())).toBe(20_000_000));
});

describe('Congelado', () => {
  it('cambiar el modo global no cambia la configuración ya congelada de un pedido', () => {
    config.comercio.pricingMode = 'institutional_test'; config.comercio.testChargeCop = 1500;
    const congelada = configVigente();
    config.comercio.pricingMode = 'official';
    expect(importeCobro(8_000_000, congelada)).toBe(150_000);
    expect(configVigente().modo).toBe('official');
    config.comercio.pricingMode = 'institutional_test'; config.comercio.testChargeCop = 5000;
    expect(importeCobro(8_000_000, congelada)).toBe(150_000);
  });
  it('rechaza configuraciones alteradas o totales inválidos', () => {
    expect(() => importeCobro(8_000_000, { modo: 'institutional_test', cargo_fijo_centavos: 100, congelado_en: '' })).toThrow();
    expect(() => importeCobro(8_000_000, { modo: 'sandbox' as any, cargo_fijo_centavos: null, congelado_en: '' })).toThrow();
    expect(() => importeCobro(0, ofi())).toThrow();
    expect(() => importeCobro(1.5, ofi())).toThrow();
  });
});
