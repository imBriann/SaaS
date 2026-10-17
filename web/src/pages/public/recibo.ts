/**
 * Estado del recibo que «imprime» Omnegia tras el pago, derivado SOLO de lo que responde
 * el servidor. La animación nunca adelanta un estado que el servidor no confirmó.
 *
 *  validando  → el pago todavía no está confirmado o el espacio se está creando.
 *  generando  → pago confirmado; el comprobante y el ZIP se están preparando.
 *  listo      → el ZIP está disponible para descargar.
 *  pendiente  → la generación falló o faltan datos: se puede reintentar sin volver a pagar.
 */
export type FaseRecibo = 'validando' | 'generando' | 'listo' | 'pendiente';

export interface EstadoDocumentos { estado: string; disponible?: boolean; estado_fiscal?: string; validez_fiscal?: boolean }

export function faseRecibo(st: { estado?: string; pago?: { estado?: string } | null; documentos?: EstadoDocumentos | null } | null): FaseRecibo {
  if (!st || st.pago?.estado !== 'APROBADO') return 'validando';
  const d = st.documentos;
  if (!d || d.estado === 'PENDIENTE' || d.estado === 'GENERANDO') return 'generando';
  if (d.estado === 'LISTO' && d.disponible !== false) return 'listo';
  return 'pendiente';
}

/** Se sigue consultando mientras los documentos pueden llegar solos. */
export const reciboEnCurso = (f: FaseRecibo) => f === 'validando' || f === 'generando';

export const TEXTO_RECIBO: Record<FaseRecibo, { titulo: string; detalle: string }> = {
  validando: { titulo: 'Validando el pago', detalle: 'Esperamos la confirmación de Wompi antes de emitir el recibo.' },
  generando: { titulo: 'Generando tu comprobante', detalle: 'Preparamos el PDF protegido y el archivo .zip con tus documentos.' },
  listo: { titulo: 'Recibo listo', detalle: 'Tus documentos están disponibles para descargar.' },
  pendiente: { titulo: 'Documentos pendientes', detalle: 'Tu pago está confirmado. Puedes reintentar la descarga cuando los documentos estén preparados.' },
};
