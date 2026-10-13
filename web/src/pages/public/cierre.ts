/**
 * Estado del cierre del alta (/empezar/listo), derivado SOLO de lo que responde
 * el servidor. Abrir la página, pulsar «Pagar» o la respuesta de la pasarela
 * simulada no cuentan como prueba de pago ni de aprovisionamiento.
 */
export type FaseCierre = 'sin_borrador' | 'cargando' | 'error' | 'sin_pago' | 'pendiente' | 'rechazado' | 'confirmando' | 'listo';

export interface EstadoServidor {
  estado: string;
  pago: { estado: string; referencia?: string; monto?: number } | null;
}

export function faseCierre(tk: string | null, st: EstadoServidor | null, error: { status?: number } | null): FaseCierre {
  if (!tk || error?.status === 404) return 'sin_borrador';
  if (error) return 'error';
  if (!st) return 'cargando';
  if (st.estado === 'APROVISIONADO') return 'listo';
  switch (st.pago?.estado) {
    case undefined: return 'sin_pago';
    case 'PENDIENTE': return 'pendiente';
    case 'RECHAZADO': return 'rechazado';
    // Pago aprobado pero el panel aún no figura: el servidor aprovisiona en la misma transacción,
    // así que es transitorio; se sigue consultando sin inventar progreso.
    case 'APROBADO': return 'confirmando';
    default: return 'sin_pago';
  }
}

/** Solo se vuelve a consultar mientras la confirmación puede llegar sola. */
export const debeConsultar = (f: FaseCierre) => f === 'pendiente' || f === 'confirmando';

/** Pasos del alta realmente cumplidos (0–6), según los datos del borrador y el estado del servidor. */
export function pasosCumplidos(f: FaseCierre, borrador: { clasificacion?: unknown; negocio?: { nombre?: string; email?: string } } | null): number {
  if (f === 'listo') return 6;
  if (f === 'confirmando') return 5;
  if (f === 'pendiente' || f === 'rechazado') return 4; // iniciar el pago exige datos completos
  let n = 0;
  if (borrador) n = 1;
  if (borrador?.clasificacion) n = 2;
  if (borrador?.negocio?.nombre && borrador.negocio.email) n = 3;
  return n;
}
