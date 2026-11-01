import type { Database } from '../db/index.js';
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
      `SELECT cp.id, cp.referencia, cp.modalidad, cp.metodo, cp.estado, cp.modo_precios, cp.entorno, cp.total_oficial_centavos, cp.monto_cobro_centavos,
              cp.monto_reportado_centavos, cp.comision_centavos, cp.creado_en, t.nombre AS empresa
       FROM commerce_payment cp JOIN tenant t ON t.id=cp.tenant_id ORDER BY cp.creado_en DESC LIMIT 300`)).rows
      .map((r: any) => ({ ...r, total_oficial: Number(r.total_oficial_centavos) / 100, cobro: Number(r.monto_cobro_centavos) / 100, reportado: r.monto_reportado_centavos == null ? null : Number(r.monto_reportado_centavos) / 100, comision: r.comision_centavos == null ? null : Number(r.comision_centavos) / 100 }));
    const t = (await tx.query(
      `SELECT coalesce(sum(CASE WHEN tipo='RECAUDO' THEN bruto_centavos WHEN tipo='REVERSO' THEN -bruto_centavos ELSE 0 END),0)::bigint AS bruto,
              count(*) FILTER (WHERE estado='PENDIENTE_COMISION')::int AS sin_comision FROM financial_ledger`)).rows[0];
    const porEstado = (await tx.query(`SELECT estado, count(*)::int AS n FROM commerce_payment GROUP BY estado ORDER BY 2 DESC`)).rows;
    const revisiones = (await tx.query(`SELECT count(*)::int AS n FROM payment_reconciliation WHERE resuelto_en IS NULL`)).rows[0].n;
    const linea = enLineaDisponible();
    return { precios: modoPrecios(), pagos_reales: linea.ok, motivo: linea.motivo, recaudado: Number(t.bruto) / 100, pendientes_de_comision: t.sin_comision, revisiones_abiertas: revisiones, por_estado: porEstado, cobros };
  });
}
