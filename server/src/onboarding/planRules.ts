import type { Clasificacion } from './classifier.js';

/**
 * Tabla de reglas determinista (D-01, ADR-06): el modelo clasifica; el CÓDIGO
 * asigna el plan. La misma clasificación produce siempre el mismo plan, y la
 * recomendación nombra la regla aplicada.
 */
export interface PlanDef {
  codigo: 'esencial' | 'negocio' | 'pro';
  nombre: string;
  precio_mensual: number;
  cuota_tokens_ia: number;
  cuota_mensajes: number;
  cuota_documentos: number;
  max_usuarios: number;
  modulos: string[];
  politica_excedente: 'LIMITAR' | 'EXCEDENTE';
  precio_excedente_1k_tokens: number;
  orden: number;
}

export const PLANES: PlanDef[] = [
  {
    codigo: 'esencial', nombre: 'Esencial', precio_mensual: 79000, cuota_tokens_ia: 400_000, cuota_mensajes: 1_500, cuota_documentos: 0,
    max_usuarios: 2, modulos: ['clientes', 'catalogo', 'ventas', 'agenda', 'conversaciones', 'ia'], politica_excedente: 'LIMITAR', precio_excedente_1k_tokens: 0, orden: 1,
  },
  {
    codigo: 'negocio', nombre: 'Negocio', precio_mensual: 149000, cuota_tokens_ia: 1_500_000, cuota_mensajes: 5_000, cuota_documentos: 400,
    max_usuarios: 6, modulos: ['clientes', 'catalogo', 'ventas', 'agenda', 'inventario', 'facturacion', 'conversaciones', 'ia', 'comisiones', 'membresias'],
    politica_excedente: 'LIMITAR', precio_excedente_1k_tokens: 0, orden: 2,
  },
  {
    codigo: 'pro', nombre: 'Pro', precio_mensual: 289000, cuota_tokens_ia: 5_000_000, cuota_mensajes: 20_000, cuota_documentos: 2_000,
    max_usuarios: 20, modulos: ['clientes', 'catalogo', 'ventas', 'agenda', 'inventario', 'facturacion', 'conversaciones', 'ia', 'comisiones', 'membresias'],
    politica_excedente: 'EXCEDENTE', precio_excedente_1k_tokens: 45, orden: 3,
  },
];

interface Regla {
  id: string;
  plan: PlanDef['codigo'];
  cuando: (c: Clasificacion) => boolean;
  explicacion: string;
}

/** Evaluadas en orden; la primera que aplica decide. */
export const REGLAS: Regla[] = [
  { id: 'R-01', plan: 'pro', cuando: (c) => c.volumen_conv_mes === 'alto', explicacion: 'Más de 1.500 conversaciones al mes requieren la cuota y la política de excedente del plan Pro.' },
  { id: 'R-02', plan: 'pro', cuando: (c) => c.tamano === 'mas_15' || c.tamano === '6_15', explicacion: 'Con más de 5 personas en el equipo necesitas los usuarios del plan Pro.' },
  { id: 'R-03', plan: 'negocio', cuando: (c) => c.factura_electronica === true, explicacion: 'Necesitas factura electrónica ante la DIAN, que se incluye desde el plan Negocio.' },
  { id: 'R-04', plan: 'negocio', cuando: (c) => c.modulos_sugeridos.includes('inventario'), explicacion: 'Manejas inventario de productos, disponible desde el plan Negocio.' },
  { id: 'R-05', plan: 'negocio', cuando: (c) => c.volumen_conv_mes === 'medio', explicacion: 'Entre 300 y 1.500 conversaciones al mes caben en la cuota del plan Negocio.' },
  { id: 'R-06', plan: 'negocio', cuando: (c) => c.tamano === '2_5' && c.modulos_sugeridos.length > 5, explicacion: 'Un equipo de 2 a 5 personas con varios módulos encaja en el plan Negocio.' },
  { id: 'R-99', plan: 'esencial', cuando: () => true, explicacion: 'Tu operación cabe en el plan Esencial: clientes, agenda, ventas y atención por WhatsApp con IA.' },
];

export interface Recomendacion {
  plan: PlanDef['codigo'];
  regla: string;
  explicacion: string;
  preguntar: string[];
}

export function recommendPlan(c: Clasificacion): Recomendacion {
  // Un campo descartado o de baja confianza no «sube» ni «baja» el plan por sí solo: se pregunta.
  const preguntar: string[] = [];
  if (!c.prellenar) preguntar.push('confirmar_datos');
  if (c.tamano === null) preguntar.push('tamano');
  if (c.volumen_conv_mes === null) preguntar.push('volumen_conv_mes');
  if (c.factura_electronica === null) preguntar.push('factura_electronica');
  const r = REGLAS.find((x) => x.cuando(c))!;
  return { plan: r.plan, regla: r.id, explicacion: r.explicacion, preguntar };
}
