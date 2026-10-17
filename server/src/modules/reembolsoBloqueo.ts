import type { Tx } from '../db/index.js';

/** El servicio de una alta no puede crearse si su pago se devuelve por retracto o por falta de activación. */
export async function reembolsoBloqueaServicio(tx: Tx, draftToken: string): Promise<boolean> {
  return (await tx.query(
    `SELECT 1 FROM reembolso WHERE draft_token=$1 AND motivo IN ('RETRACTO','NO_ACTIVACION') AND estado IN ('APROBADO','REEMBOLSADO') LIMIT 1`, [draftToken])).rows.length > 0;
}
