import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm } from '../core/context.js';
import { uuidv7 } from '../lib/util.js';

/**
 * Libro financiero del proyecto (financial_ledger): solo inserción. Un disparador en la base impide editar o borrar;
 * una corrección es un movimiento nuevo (REVERSO o AJUSTE_COMISION). El índice único (cobro, tipo) hace que un evento
 * repetido de Wompi no duplique el recaudo.
 *
 * La comisión real de Wompi no llega en la transacción: el recaudo queda PENDIENTE_COMISION hasta que la conciliación
 * la registre con un AJUSTE_COMISION. Un pago manual no tiene comisión (0) y queda CONFIRMADO.
 */
export interface Movimiento {
  orderId: string; pagoId: string; tipo: 'RECAUDO' | 'REVERSO' | 'AJUSTE_COMISION';
  brutoCentavos: number; comisionCentavos: number | null; transaccionId?: string | null;
}

/** Registra el movimiento si no existía (idempotente). Devuelve true si se insertó. */
export async function registrarMovimiento(tx: Tx, tenantId: string, m: Movimiento): Promise<boolean> {
  if (!Number.isSafeInteger(m.brutoCentavos)) throw new Error('Importe del movimiento no válido');
  const neto = m.comisionCentavos == null ? null : m.brutoCentavos - m.comisionCentavos;
  const r = await tx.query(
    `INSERT INTO financial_ledger (id, tenant_id, order_id, commerce_payment_id, tipo, bruto_centavos, comision_centavos, neto_centavos, estado, transaccion_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (commerce_payment_id, tipo) WHERE tipo IN ('RECAUDO','REVERSO') DO NOTHING RETURNING id`,
    [uuidv7(), tenantId, m.orderId, m.pagoId, m.tipo, m.brutoCentavos, m.comisionCentavos, neto, m.comisionCentavos == null ? 'PENDIENTE_COMISION' : 'CONFIRMADO', m.transaccionId ?? null]);
  return !!r.rows[0];
}

/** Panel › Ventas › Pagos › Historial financiero: movimientos y totales (bruto, comisión conocida y neto). */
export async function historial(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'order:read');
  const movimientos = (await tx.query(
    `SELECT l.id, l.tipo, l.bruto_centavos, l.comision_centavos, l.neto_centavos, l.estado, l.creado_en, o.numero, cp.referencia, cp.metodo, cp.modo_precios, cp.total_oficial_centavos
     FROM financial_ledger l JOIN "order" o ON o.id=l.order_id JOIN commerce_payment cp ON cp.id=l.commerce_payment_id ORDER BY l.creado_en DESC LIMIT 300`)).rows
    .map((r: any) => ({ ...r, bruto: Number(r.bruto_centavos) / 100, comision: r.comision_centavos == null ? null : Number(r.comision_centavos) / 100, neto: r.neto_centavos == null ? null : Number(r.neto_centavos) / 100, total_oficial: Number(r.total_oficial_centavos) / 100 }));
  const t = (await tx.query(
    `SELECT coalesce(sum(CASE WHEN tipo='REVERSO' THEN -bruto_centavos WHEN tipo='RECAUDO' THEN bruto_centavos ELSE 0 END),0)::bigint AS bruto,
            coalesce(sum(comision_centavos),0)::bigint AS comision,
            count(*) FILTER (WHERE estado='PENDIENTE_COMISION')::int AS sin_comision FROM financial_ledger`)).rows[0];
  return { movimientos, totales: { bruto: Number(t.bruto) / 100, comision_conocida: Number(t.comision) / 100, pendientes_de_comision: t.sin_comision } };
}
