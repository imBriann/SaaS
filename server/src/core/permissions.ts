/**
 * Catálogo de permisos. Las decisiones se basan en permisos concretos,
 * nunca solo en el nombre del rol (PRO-SW-001 §12, PRO-SW-002 fig. 05).
 */
export const PERMISOS = {
  'tenant:configure': 'Configurar la empresa, módulos e identidad visual',
  'user:manage': 'Gestionar personas y roles',
  'customer:read': 'Consultar clientes',
  'customer:write': 'Crear y editar clientes',
  'catalog:read': 'Consultar catálogo',
  'catalog:write': 'Editar catálogo',
  'inventory:read': 'Consultar inventario',
  'inventory:write': 'Registrar movimientos de inventario',
  'order:read': 'Consultar ventas',
  'order:create': 'Registrar ventas',
  'order:void': 'Anular ventas',
  'appointment:read': 'Consultar agenda',
  'appointment:create': 'Crear citas',
  'appointment:cancel': 'Cancelar citas',
  'conversation:read': 'Ver conversaciones',
  'conversation:reply': 'Responder conversaciones',
  'case:create': 'Crear radicados (escalar)',
  'case:manage': 'Atender y cerrar radicados',
  'case:supervise': 'Supervisar colas y reasignar',
  'invoice:read': 'Consultar documentos fiscales',
  'invoice:issue': 'Emitir facturas electrónicas',
  'invoice:void': 'Emitir notas crédito',
  'ai:read': 'Ver el Centro de IA',
  'ai:configure': 'Configurar herramientas y políticas de IA',
  'ai:assist': 'Usar el copiloto',
  'audit:read': 'Consultar auditoría',
  'subscription:manage': 'Gestionar suscripción y pagos',
  'usage:read': 'Ver consumo frente a la cuota',
  'payment:link': 'Generar enlaces de cobro',
  'platform:govern': 'Gobierno global de la plataforma',
} as const;

export type Permiso = keyof typeof PERMISOS;

/** Permisos que ningún rol de tenant ni agente puede recibir. */
export const PERMISOS_SOLO_PLATAFORMA: Permiso[] = ['platform:govern'];

/** Permisos que nunca se otorgan a un rol de agente de IA (fig. 05: «Nunca a»). */
export const PERMISOS_PROHIBIDOS_A_AGENTES: Permiso[] = [
  'invoice:void', 'invoice:issue', 'user:manage', 'tenant:configure', 'audit:read',
  'subscription:manage', 'ai:configure', 'order:void', 'platform:govern',
];

export const TODOS_LOS_PERMISOS_DE_TENANT = (Object.keys(PERMISOS) as Permiso[]).filter(
  (p) => !PERMISOS_SOLO_PLATAFORMA.includes(p),
);

export function esPermiso(p: string): p is Permiso {
  return p in PERMISOS;
}
