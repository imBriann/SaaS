import type { Tx } from '../db/index.js';
import type { Ctx } from './context.js';
import { uuidv7 } from '../lib/util.js';

/**
 * Bus de eventos de negocio. Los eventos se persisten en la misma transacción
 * que el cambio que los origina (outbox), y el proceso trabajador los despacha
 * a las reglas declarativas de automatización.
 */
export type TipoEvento =
  | 'venta_registrada'
  | 'venta_anulada'
  | 'cita_creada'
  | 'cita_cancelada'
  | 'stock_bajo_minimo'
  | 'documento_emitido'
  | 'documento_rechazado'
  | 'caso_escalado'
  | 'caso_cerrado'
  | 'suscripcion_suspendida'
  | 'cliente_creado';

export async function publish(tx: Tx, ctx: Ctx, tipo: TipoEvento, payload: Record<string, unknown>): Promise<void> {
  await tx.query(
    `INSERT INTO domain_event (id, tenant_id, tipo, payload, actor) VALUES ($1,$2,$3,$4,$5)`,
    [uuidv7(), ctx.tenantId, tipo, JSON.stringify(payload), `${ctx.actor.tipo}:${ctx.actor.nombre}`],
  );
}

/** Encola un trabajo para el proceso trabajador. clave_unica evita duplicados. */
export async function enqueue(
  tx: Tx,
  tenantId: string | null,
  tipo: string,
  payload: Record<string, unknown>,
  opts: { ejecutarEn?: Date; claveUnica?: string; maxIntentos?: number } = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO job (id, tenant_id, tipo, payload, ejecutar_en, clave_unica, max_intentos)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (clave_unica) DO NOTHING`,
    [uuidv7(), tenantId, tipo, JSON.stringify(payload), (opts.ejecutarEn ?? new Date()).toISOString(), opts.claveUnica ?? null, opts.maxIntentos ?? 5],
  );
}
