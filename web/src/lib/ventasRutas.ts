import { leer } from '../api';

/**
 * Ventas es una sola sección con tres pestañas: Vender (punto de venta), Historial y Comprobantes.
 * La última pestaña usada se recuerda en este navegador: «Ventas» en el menú te devuelve a ella.
 */
export type PestanaVentas = 'vender' | 'historial' | 'comprobantes';
export const CLAVE_PESTANA_VENTAS = 'omnegia.ventas.pestana';
export const RUTA_PESTANA: Record<PestanaVentas, string> = { vender: '/ventas/vender', historial: '/ventas', comprobantes: '/ventas/comprobantes' };

export const pestanaRecordada = (): PestanaVentas | null => { const v = leer(CLAVE_PESTANA_VENTAS); return v === 'vender' || v === 'historial' || v === 'comprobantes' ? v : null; };

/** Destino de «Ventas» en el menú: la última pestaña usada si la persona aún puede verla; si no, la primera disponible. */
export function rutaDeVentas(puede: (permiso: string) => boolean): string {
  const permitida: Record<PestanaVentas, boolean> = { vender: puede('order:create'), historial: puede('order:read'), comprobantes: puede('comprobante:read') };
  const ultima = pestanaRecordada();
  if (ultima && permitida[ultima]) return RUTA_PESTANA[ultima];
  const primera = (['historial', 'vender', 'comprobantes'] as PestanaVentas[]).find((p) => permitida[p]);
  return RUTA_PESTANA[primera ?? 'historial'];
}
