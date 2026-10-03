import { z } from 'zod';

/** Tarifas de demostración: no son una oferta comercial ni habilitan cobros. */
export const MODULE_CATALOG = [
  { id: 'clientes', nombre: 'Clientes', descripcion: 'Tu directorio e historial en un solo lugar.', icono: 'clientes', precio: 0, dependencias: [] as string[] },
  { id: 'catalogo', nombre: 'Catálogo', descripcion: 'Todos tus productos y servicios organizados.', icono: 'inventario', precio: 0, dependencias: [] as string[] },
  { id: 'conversaciones', nombre: 'WhatsApp y atención', descripcion: 'Conversaciones y atención humana en una bandeja.', icono: 'conversaciones', precio: 25000, dependencias: ['clientes'] },
  { id: 'agenda', nombre: 'Agenda y reservas', descripcion: 'Citas, disponibilidad y recordatorios.', icono: 'agenda', precio: 18000, dependencias: ['clientes', 'catalogo'] },
  { id: 'ventas', nombre: 'Ventas y pedidos', descripcion: 'Registra cada venta y haz seguimiento.', icono: 'ventas', precio: 22000, dependencias: ['clientes', 'catalogo'] },
  { id: 'inventario', nombre: 'Control de inventario', descripcion: 'Existencias, movimientos y alertas de mínimos.', icono: 'inventario', precio: 16000, dependencias: ['catalogo'] },
  { id: 'facturacion', nombre: 'Facturación electrónica', descripcion: 'Emisión y seguimiento de documentos fiscales.', icono: 'facturacion', precio: 30000, dependencias: ['ventas'] },
  { id: 'ia', nombre: 'Asistente inteligente', descripcion: 'Atención con IA, permisos y confirmaciones.', icono: 'ia', precio: 35000, dependencias: ['conversaciones'] },
];
const ids = MODULE_CATALOG.map(m => m.id);
export const QuoteInput = z.object({
  modulos: z.array(z.string().refine(id => ids.includes(id), 'Función no disponible')).max(20),
}).strict();
export function quoteModules(input: unknown) {
  const { modulos } = QuoteInput.parse(input);
  const requested = new Set(modulos);
  const included = new Set(['clientes', 'catalogo']);
  const add = (id: string) => {
    if (included.has(id)) return;
    included.add(id);
    MODULE_CATALOG.find(m => m.id === id)!.dependencias.forEach(add);
  };
  requested.forEach(add);
  const lineas = MODULE_CATALOG.filter(m => included.has(m.id)).map(m => ({ ...m, incluida: m.precio === 0, requerida: !requested.has(m.id) && m.precio > 0 }));
  const base = 29000;
  return { version: 'demo-modular-v1', demostracion: true, moneda: 'COP', periodo: 'mes', base, lineas, modulos: lineas.map(m => m.id), total: base + lineas.reduce((n, m) => n + m.precio, 0), nota: 'Estimación de demostración. Tarifas comerciales e impuestos pendientes de definición. No habilita cobros.' };
}
export function quoteClassification(c: { modulos_sugeridos?: string[]; factura_electronica?: boolean | null }) {
  const modulos = (c.modulos_sugeridos ?? []).filter(m => ids.includes(m));
  if (c.factura_electronica) modulos.push('facturacion');
  return quoteModules({ modulos });
}
