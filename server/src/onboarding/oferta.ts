import { config, institucionalDisponible } from '../config.js';
import { cuentaPlataforma } from '../adapters/payments.js';

/**
 * Qué se cobra y en qué condiciones. Única fuente del monto: el navegador nunca lo envía.
 *
 *  - COMERCIAL: la cotización por módulos, mensual (exige TARIFAS_CONFIRMADAS=1 o simuladores).
 *  - INSTITUCIONAL (MODO_INSTITUCIONAL=1): un cobro real y único de PRECIO_INSTITUCIONAL_COP
 *    por ACCESO_INSTITUCIONAL_DIAS días con Wompi en producción. Los precios comerciales se
 *    muestran solo como referencia y no se modifican. Sin renovación ni cobro automático.
 */
export type Modalidad = 'COMERCIAL' | 'INSTITUCIONAL';

export interface Oferta {
  modalidad: Modalidad;
  /** Monto que se cobra, en pesos enteros. */
  monto: number;
  /** Precio comercial mensual de referencia (no se cobra en la modalidad institucional). */
  montoReferencia: number;
  /** Días de acceso que compra el pago; null = un mes calendario (comercial). */
  accesoDias: number | null;
  concepto: string;
}

export const modalidadVigente = (): Modalidad => (config.institucional.activo ? 'INSTITUCIONAL' : 'COMERCIAL');

/** ¿Se puede contratar en línea ahora? Con la modalidad institucional activa, nunca se cae al cobro comercial. */
export function puedeContratar(): boolean {
  if (config.institucional.activo) return institucionalDisponible().ok;
  return !!cuentaPlataforma() && (config.simuladores || config.pagos.tarifasConfirmadas);
}

export const conceptoInstitucional = (dias = config.institucional.dias) => `Omnegia · acceso institucional ${dias} días`;

/** Oferta del alta para una cotización comercial ya calculada en el servidor. */
export function ofertaAlta(totalComercial: number): Oferta {
  if (config.institucional.activo) {
    return { modalidad: 'INSTITUCIONAL', monto: config.institucional.precioCop, montoReferencia: totalComercial, accesoDias: config.institucional.dias, concepto: conceptoInstitucional() };
  }
  return { modalidad: 'COMERCIAL', monto: totalComercial, montoReferencia: totalComercial, accesoDias: null, concepto: 'Omnegia · primer mes' };
}

/** Lo que la interfaz muestra antes de pagar (sin secretos ni motivos internos de configuración). */
export function resumenModalidad() {
  if (!config.institucional.activo) return null;
  return {
    modalidad: 'INSTITUCIONAL' as const,
    disponible: institucionalDisponible().ok,
    precio: config.institucional.precioCop,
    moneda: 'COP',
    acceso_dias: config.institucional.dias,
    cobro_real: true,
    renovacion_automatica: false,
    nota: `Cobro real y único de ${formatoCop(config.institucional.precioCop)} con Wompi por ${config.institucional.dias} días de acceso. No es una simulación. No se guardan datos de tarjeta ni se programan cobros automáticos. Los precios mensuales se muestran solo como referencia comercial.`,
  };
}

const formatoCop = (n: number) => `$${n.toLocaleString('es-CO')} COP`;
