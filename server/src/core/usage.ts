import type { Tx } from '../db/index.js';
import { num, periodo } from '../lib/util.js';

/**
 * Medición de consumo por tenant (ADR-10: pertenece a los cimientos).
 * Métricas: tokens de IA, mensajes, documentos fiscales y plantillas de marketing.
 */
export type Metrica = 'tokens_ia' | 'mensajes' | 'documentos' | 'plantillas_marketing';

const CUOTA_COLUMNA: Record<Metrica, string | null> = {
  tokens_ia: 'cuota_tokens_ia',
  mensajes: 'cuota_mensajes',
  documentos: 'cuota_documentos',
  plantillas_marketing: null,
};

export async function addUsage(tx: Tx, tenantId: string, metrica: Metrica, cantidad: number): Promise<void> {
  if (cantidad <= 0) return;
  await tx.query(
    `INSERT INTO usage_record (tenant_id, periodo, metrica, cantidad) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, periodo, metrica) DO UPDATE SET cantidad = usage_record.cantidad + EXCLUDED.cantidad`,
    [tenantId, periodo(), metrica, Math.round(cantidad)],
  );
}

export interface EstadoCuota {
  metrica: Metrica;
  usado: number;
  cuota: number | null;
  porcentaje: number;
  proyeccion: number;
  proyeccionPorcentaje: number;
  politica: 'LIMITAR' | 'EXCEDENTE';
  agotada: boolean;
}

/** Consumo del periodo con proyección lineal al cierre del mes (medidor con proyección, PRO-SW-003 §7.5). */
export async function quotaStatus(tx: Tx, tenantId: string, metrica: Metrica, now = new Date()): Promise<EstadoCuota> {
  const plan = (
    await tx.query(
      `SELECT p.* FROM tenant t JOIN plan p ON p.codigo = t.plan_codigo WHERE t.id = $1`,
      [tenantId],
    )
  ).rows[0];
  const usado = num(
    (await tx.query(`SELECT cantidad FROM usage_record WHERE tenant_id=$1 AND periodo=$2 AND metrica=$3`, [tenantId, periodo(now), metrica]))
      .rows[0]?.cantidad,
  );
  const col = CUOTA_COLUMNA[metrica];
  const cuota = col && plan ? num(plan[col]) : null;
  const diasMes = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const diaActual = Math.max(1, now.getUTCDate());
  const proyeccion = Math.round((usado / diaActual) * diasMes);
  const pct = (n: number) => (cuota ? Math.round((n / cuota) * 1000) / 10 : 0);
  const politica = (plan?.politica_excedente ?? 'LIMITAR') as 'LIMITAR' | 'EXCEDENTE';
  return {
    metrica,
    usado,
    cuota,
    porcentaje: pct(usado),
    proyeccion,
    proyeccionPorcentaje: pct(proyeccion),
    politica,
    agotada: cuota !== null && usado >= cuota && politica === 'LIMITAR',
  };
}

export async function allQuotas(tx: Tx, tenantId: string) {
  const out: Record<string, EstadoCuota> = {};
  for (const m of ['tokens_ia', 'mensajes', 'documentos'] as Metrica[]) out[m] = await quotaStatus(tx, tenantId, m);
  return out;
}
