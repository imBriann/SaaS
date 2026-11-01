import { z } from 'zod';
import type { Database } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid } from '../lib/util.js';
import { registrarMovimiento } from './ledger.js';
import { exigir, type Operador } from '../modules/operador.js';
import { modoPrecios, enLineaDisponible } from './metodos.js';

/**
 * Panel del operador › Recaudos: los cobros de pedidos de todas las empresas (que hoy llegan a la cuenta Wompi del
 * proyecto) y el modo de precios vigente. El modo y el importe fijo se cambian solo con variables del servidor
 * (COMMERCE_PRICING_MODE, COMMERCE_TEST_CHARGE_COP): ni las empresas, ni los agentes, ni los clientes pueden.
 * El operador ve metadatos financieros (importes, estados, método), no datos personales del comprador.
 */
export async function recaudos(db: Database, op: Operador) {
  exigir(op, 'plataforma:ver');
  return db.withOperador(async (tx) => {
    const cobros = (await tx.query(
      `SELECT cp.id, cp.referencia, cp.monto_reportado_centavos IS NOT NULL AND cp.comision_centavos IS NULL AND cp.estado='PAGADO' AS comision_pendiente, cp.modalidad, cp.metodo, cp.estado, cp.modo_precios, cp.entorno, cp.total_oficial_centavos, cp.monto_cobro_centavos,
              cp.monto_reportado_centavos, cp.comision_centavos, cp.creado_en, t.nombre AS empresa
       FROM commerce_payment cp JOIN tenant t ON t.id=cp.tenant_id ORDER BY cp.creado_en DESC LIMIT 300`)).rows
      .map((r: any) => ({ ...r, total_oficial: Number(r.total_oficial_centavos) / 100, cobro: Number(r.monto_cobro_centavos) / 100, reportado: r.monto_reportado_centavos == null ? null : Number(r.monto_reportado_centavos) / 100, comision: r.comision_centavos == null ? null : Number(r.comision_centavos) / 100 }));
    const t = (await tx.query(
      `SELECT coalesce(sum(CASE WHEN l.tipo='RECAUDO' THEN l.bruto_centavos WHEN l.tipo='REVERSO' THEN -l.bruto_centavos ELSE 0 END),0)::bigint AS bruto,
              count(*) FILTER (WHERE l.tipo='RECAUDO' AND l.estado='PENDIENTE_COMISION' AND NOT EXISTS (SELECT 1 FROM financial_ledger a WHERE a.commerce_payment_id=l.commerce_payment_id AND a.tipo='AJUSTE_COMISION'))::int AS sin_comision FROM financial_ledger l`)).rows[0];
    const porEstado = (await tx.query(`SELECT estado, count(*)::int AS n FROM commerce_payment GROUP BY estado ORDER BY 2 DESC`)).rows;
    const revisiones = (await tx.query(`SELECT count(*)::int AS n FROM payment_reconciliation WHERE resuelto_en IS NULL`)).rows[0].n;
    const abiertas = (await tx.query(`SELECT r.id, r.tipo, r.esperado, r.recibido, r.detalle, r.creado_en, cp.referencia FROM payment_reconciliation r JOIN commerce_payment cp ON cp.id=r.commerce_payment_id WHERE r.resuelto_en IS NULL ORDER BY r.creado_en DESC LIMIT 50`)).rows;
    const linea = enLineaDisponible();
    return { precios: modoPrecios(), pagos_reales: linea.ok, motivo: linea.motivo, recaudado: Number(t.bruto) / 100, pendientes_de_comision: t.sin_comision, revisiones_abiertas: revisiones, revisiones: abiertas, por_estado: porEstado, cobros };
  });
}

// ---------------------------------------------------------------------------
// Conciliación con el reporte de Wompi (la comisión real no viene en la transacción)
// ---------------------------------------------------------------------------
const ACTOR = (op: Operador) => ({ tipo: 'PLATAFORMA' as const, id: op.user.id, nombre: op.user.nombre });

/**
 * El operador registra la comisión real de un cobro aprobado, tomada del reporte de Wompi. Queda un movimiento
 * AJUSTE_COMISION en el libro (el RECAUDO original no se toca) y el cobro guarda comisión y neto. Auditado.
 */
export async function registrarComision(db: Database, op: Operador, pagoId: string, body: unknown) {
  exigir(op, 'reembolsos:gestionar');
  if (!isUuid(pagoId)) throw notFound();
  const b = z.object({ comision_cop: z.number().min(0).max(10_000_000), motivo: z.string().trim().min(5).max(300) }).parse(body ?? {});
  const comision = Math.round(b.comision_cop * 100);
  const fila = await db.withPlatform(async (tx) => (await tx.query(`SELECT tenant_id FROM commerce_payment WHERE id=$1`, [pagoId])).rows[0]);
  if (!fila) throw notFound();
  return db.withTenant(fila.tenant_id, async (tx) => {
    const p = (await tx.query(`SELECT * FROM commerce_payment WHERE id=$1 FOR UPDATE`, [pagoId])).rows[0];
    if (p.estado !== 'PAGADO' || p.modalidad !== 'MANAGED') throw new AppError('CONFLICT', 'Solo se concilia la comisión de cobros en línea aprobados.');
    if (p.comision_centavos != null) throw new AppError('CONFLICT', 'Este cobro ya tiene su comisión conciliada.');
    const bruto = Number(p.monto_reportado_centavos ?? p.monto_cobro_centavos);
    if (comision > bruto) throw invalid('La comisión no puede superar lo recaudado.');
    await tx.query(`UPDATE commerce_payment SET comision_centavos=$2, neto_centavos=$3, actualizado_en=now() WHERE id=$1`, [p.id, comision, bruto - comision]);
    await registrarMovimiento(tx, fila.tenant_id, { orderId: p.order_id, pagoId: p.id, tipo: 'AJUSTE_COMISION', brutoCentavos: 0, comisionCentavos: comision, transaccionId: p.transaccion_id });
    await auditPlatform(tx, fila.tenant_id, ACTOR(op), 'PLATAFORMA', op.correlacion, { accion: 'cobro.comision_conciliada', recurso: 'commerce_payment', recursoId: p.id, resultado: 'EXITO', detalle: { comision_centavos: comision, neto_centavos: bruto - comision, motivo: b.motivo } });
    return { ok: true, comision: comision / 100, neto: (bruto - comision) / 100 };
  });
}

/** Cierra una discrepancia con su explicación (el cobro sigue como esté: el operador no aprueba pagos desde aquí). */
export async function resolverRevision(db: Database, op: Operador, revisionId: string, body: unknown) {
  exigir(op, 'reembolsos:gestionar');
  if (!isUuid(revisionId)) throw notFound();
  const b = z.object({ motivo: z.string().trim().min(10).max(500) }).parse(body ?? {});
  const fila = await db.withPlatform(async (tx) => (await tx.query(`SELECT tenant_id FROM payment_reconciliation WHERE id=$1`, [revisionId])).rows[0]);
  if (!fila) throw notFound();
  return db.withTenant(fila.tenant_id, async (tx) => {
    const r = (await tx.query(`UPDATE payment_reconciliation SET resuelto_en=now(), resuelto_por=$2, detalle=left(coalesce(detalle,'') || ' · Resuelto: ' || $3, 500) WHERE id=$1 AND resuelto_en IS NULL RETURNING commerce_payment_id`,
      [revisionId, `OPERADOR:${op.user.nombre}`, b.motivo])).rows[0];
    if (!r) throw new AppError('CONFLICT', 'Esta revisión ya estaba resuelta.');
    await auditPlatform(tx, fila.tenant_id, ACTOR(op), 'PLATAFORMA', op.correlacion, { accion: 'cobro.revision_resuelta', recurso: 'payment_reconciliation', recursoId: revisionId, resultado: 'EXITO', detalle: { motivo: b.motivo } });
    return { ok: true };
  });
}
