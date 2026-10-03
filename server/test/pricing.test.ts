import { describe, expect, it } from 'vitest';
import { quoteModules, quoteClassification } from '../src/onboarding/pricing.js';
describe('Cotización modular', () => {
  it('incluye base y directorio sin duplicar funciones', () => {
    const q = quoteModules({ modulos: ['agenda', 'agenda'] });
    expect(q.total).toBe(47000);
    expect(q.modulos).toEqual(['clientes', 'catalogo', 'agenda']);
  });
  it('desglosa dependencias pagadas: facturación necesita ventas', () => {
    const q = quoteModules({ modulos: ['facturacion'] });
    expect(q.total).toBe(81000);
    expect(q.lineas.find(m => m.id === 'ventas')?.requerida).toBe(true);
  });
  it('IA y selección manual usan exactamente el mismo motor', () => {
    expect(quoteClassification({ modulos_sugeridos: ['ia'], factura_electronica: true })).toEqual(quoteModules({ modulos: ['ia', 'facturacion'] }));
  });
  it('rechaza módulos desconocidos y precios enviados por el navegador', () => {
    expect(() => quoteModules({ modulos: ['admin'] })).toThrow();
    expect(() => quoteModules({ modulos: ['ia'], total: 1 })).toThrow();
    expect(() => quoteModules({ modulos: ['comisiones'] })).toThrow();
  });
  it('eliminar un módulo recalcula y todas las tarifas son de demostración', () => {
    expect(quoteModules({ modulos: ['ia'] }).total - quoteModules({ modulos: [] }).total).toBe(60000);
    expect(quoteModules({ modulos: [] }).demostracion).toBe(true);
  });
});
