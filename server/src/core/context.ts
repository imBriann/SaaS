import type { Permiso } from './permissions.js';
import { AppError } from '../lib/errors.js';

export type ActorTipo = 'USUARIO' | 'AGENTE' | 'SISTEMA' | 'CLIENTE' | 'PLATAFORMA' | 'ANONIMO';
export type Origen = 'PANEL' | 'WHATSAPP' | 'WEB' | 'WEBHOOK' | 'TRABAJADOR' | 'ONBOARDING' | 'PLATAFORMA';

/**
 * Contexto validado de una operación. Se deriva SIEMPRE en el servidor
 * (PRO-SW-001 §11.1) y viaja explícito a cada servicio y herramienta.
 */
export interface Ctx {
  tenantId: string;
  actor: { tipo: ActorTipo; id: string | null; nombre: string };
  roleKey: string | null;
  permisos: ReadonlySet<string>;
  origen: Origen;
  correlacion: string;
  /** Suscripción SUSPENDIDA: solo lectura y exportación. */
  soloLectura?: boolean;
}

export function systemCtx(tenantId: string, correlacion: string, nombre = 'Sistema'): Ctx {
  return {
    tenantId,
    actor: { tipo: 'SISTEMA', id: null, nombre },
    roleKey: 'sistema',
    permisos: new Set(['*']),
    origen: 'TRABAJADOR',
    correlacion,
  };
}

export function can(ctx: Ctx, p: Permiso): boolean {
  return ctx.permisos.has('*') || ctx.permisos.has(p);
}

/**
 * Comprobación de permiso para una acción. El error lleva los datos para que el
 * manejador global registre la denegación en auditoría en una transacción aparte
 * (la transacción de la petición se revierte, la evidencia no).
 */
export function requirePerm(ctx: Ctx, p: Permiso, recurso?: string): void {
  if (!can(ctx, p)) {
    throw new AppError('FORBIDDEN', 'No tienes permiso para esta acción.', {
      audit: { accion: `permiso.${p}`, recurso: recurso ?? null, motivo: 'permiso_ausente' },
    });
  }
}

export function requireWritable(ctx: Ctx): void {
  if (ctx.soloLectura) {
    throw new AppError('SUSPENDED', 'La suscripción está suspendida: la cuenta está en modo de solo lectura y exportación.');
  }
}
