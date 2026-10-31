import type { Clasificacion } from './classifier.js';
import { config } from '../config.js';

/**
 * Tabla de reglas determinista (D-01, ADR-06): el modelo clasifica; el CÓDIGO
 * asigna el plan. La misma clasificación produce siempre el mismo plan, y la
 * recomendación nombra la regla aplicada.
 */
export interface PlanDef {
  codigo: 'esencial' | 'negocio' | 'pro';
  nombre: string;
  precio_mensual: number;
  /** 12 meses por el precio de 10 (2 meses gratis). */
  precio_anual: number;
  /** Para quién es, en una línea (se muestra al elegir plan). */
  descripcion: string;
  cuota_tokens_ia: number;
  cuota_mensajes: number;
  cuota_documentos: number;
  max_usuarios: number;
  modulos: string[];
  politica_excedente: 'LIMITAR' | 'EXCEDENTE';
  precio_excedente_1k_tokens: number;
  orden: number;
}

/**
 * Precios y cuotas evaluados con costos reales (IA, WhatsApp, DIAN, cobro e infraestructura): ver
 * docs/precios/README.md. Una respuesta del agente de IA usa ~5.000 tokens de la cuota.
 */
export const PLANES: PlanDef[] = [
  {
    codigo: 'esencial', nombre: 'Esencial', precio_mensual: 99_000, precio_anual: 990_000, descripcion: 'Para negocios que empiezan a atender por WhatsApp con IA.',
    cuota_tokens_ia: 2_000_000, cuota_mensajes: 1_500, cuota_documentos: 0,
    max_usuarios: 2, modulos: ['clientes', 'catalogo', 'ventas', 'agenda', 'conversaciones', 'ia'], politica_excedente: 'LIMITAR', precio_excedente_1k_tokens: 0, orden: 1,
  },
  {
    codigo: 'negocio', nombre: 'Negocio', precio_mensual: 229_000, precio_anual: 2_290_000, descripcion: 'Para equipos que venden, agendan y facturan todos los días.',
    cuota_tokens_ia: 6_000_000, cuota_mensajes: 5_000, cuota_documentos: 300,
    max_usuarios: 6, modulos: ['clientes', 'catalogo', 'ventas', 'agenda', 'inventario', 'facturacion', 'conversaciones', 'ia', 'comisiones', 'membresias'],
    politica_excedente: 'LIMITAR', precio_excedente_1k_tokens: 0, orden: 2,
  },
  {
    codigo: 'pro', nombre: 'Pro', precio_mensual: 549_000, precio_anual: 5_490_000, descripcion: 'Para operaciones grandes con mucho volumen de clientes.',
    cuota_tokens_ia: 12_000_000, cuota_mensajes: 15_000, cuota_documentos: 1_000,
    max_usuarios: 20, modulos: ['clientes', 'catalogo', 'ventas', 'agenda', 'inventario', 'facturacion', 'conversaciones', 'ia', 'comisiones', 'membresias'],
    politica_excedente: 'EXCEDENTE', precio_excedente_1k_tokens: 30, orden: 3,
  },
];

const MODULO_TEXTO: Record<string, string> = { inventario: 'Inventario y existencias', facturacion: 'Factura electrónica DIAN', comisiones: 'Comisiones del equipo', membresias: 'Membresías', agenda: 'Agenda con recordatorios', ventas: 'Ventas y caja del día' };
const pesos = (n: number) => '$' + Math.round(n).toLocaleString('es-CO').replace(/,/g, '.');

/** Lo que incluye un plan, en frases cortas y verificables (salen de sus cuotas y módulos). */
export function caracteristicasPlan(p: { max_usuarios: number; modulos: string[]; politica_excedente: string; cuota_tokens_ia: number | string; cuota_mensajes: number | string; cuota_documentos: number | string; precio_excedente_1k_tokens: number | string }): string[] {
  const n = (v: number | string) => Number(v).toLocaleString('es-CO');
  const respuestas = Math.floor(Number(p.cuota_tokens_ia) / 5000 / 50) * 50;
  return [
    `${p.max_usuarios} ${p.max_usuarios === 1 ? 'persona' : 'personas'} con acceso`,
    `IA para unas ${n(respuestas)} respuestas al mes`,
    `${n(p.cuota_mensajes)} mensajes de WhatsApp al mes`,
    Number(p.cuota_documentos) > 0 ? `${n(p.cuota_documentos)} facturas electrónicas al mes` : 'Sin factura electrónica',
    ...['agenda', 'ventas', 'inventario', 'comisiones', 'membresias'].filter((m) => p.modulos.includes(m)).map((m) => MODULO_TEXTO[m]),
    p.politica_excedente === 'EXCEDENTE' ? `La IA sigue al pasar la cuota (${pesos(Number(p.precio_excedente_1k_tokens))} por 1.000 tokens)` : 'Al tope, la IA pasa la conversación a tu equipo',
  ];
}

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
  // Con la facturación DIAN apagada la respuesta se guarda como interés para el futuro: no sube el plan.
  { id: 'R-03', plan: 'negocio', cuando: (c) => c.factura_electronica === true && config.fiscal.dianHabilitada, explicacion: 'Necesitas factura electrónica ante la DIAN, que se incluye desde el plan Negocio.' },
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
