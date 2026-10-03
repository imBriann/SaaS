import type { Tx } from '../db/index.js';
import type { Ctx } from './context.js';
import { uuidv7 } from '../lib/util.js';

export type Resultado = 'PERMITIDO' | 'DENEGADO' | 'NO_ENCONTRADO' | 'ERROR' | 'EXITO';

export interface AuditEntry {
  accion: string;
  recurso?: string | null;
  recursoId?: string | null;
  resultado: Resultado;
  detalle?: Record<string, unknown>;
}

/** Inserta un evento de auditoría. La tabla es append-only (sin UPDATE ni DELETE). */
export async function audit(tx: Tx, ctx: Ctx, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_event (id, tenant_id, actor_tipo, actor_id, actor_nombre, accion, recurso, recurso_id, resultado, origen, correlacion, detalle)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      uuidv7(), ctx.tenantId, ctx.actor.tipo, ctx.actor.id, ctx.actor.nombre, e.accion,
      e.recurso ?? null, e.recursoId ?? null, e.resultado, ctx.origen, ctx.correlacion,
      JSON.stringify(e.detalle ?? {}),
    ],
  );
}

/** Auditoría desde contexto de plataforma (p. ej. intento de acceso cruzado sin pertenencia). */
export async function auditPlatform(
  tx: Tx,
  tenantId: string | null,
  actor: { tipo: Ctx['actor']['tipo']; id: string | null; nombre: string },
  origen: string,
  correlacion: string,
  e: AuditEntry,
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_event (id, tenant_id, actor_tipo, actor_id, actor_nombre, accion, recurso, recurso_id, resultado, origen, correlacion, detalle)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      uuidv7(), tenantId, actor.tipo, actor.id, actor.nombre, e.accion, e.recurso ?? null,
      e.recursoId ?? null, e.resultado, origen, correlacion, JSON.stringify(e.detalle ?? {}),
    ],
  );
}
