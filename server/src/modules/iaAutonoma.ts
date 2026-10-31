import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, can, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { zonaDe } from '../core/tenant.js';
import { invalid } from '../lib/errors.js';
import { addDays, rangoDia, todayLocal } from '../lib/time.js';
import { AJUSTES_IA_DEFECTO, ajustesIA, REGLAS_OBLIGATORIAS } from '../ai/politica.js';
import { NOMBRE_REGLA } from '../ai/escalamiento.js';

/**
 * «Cómo trabaja tu asistente»: autonomía, reglas de escalamiento, urgencias y avisos; lo que hizo la IA hoy
 * (Inicio) y las métricas por periodo (Informes, evidencia para la tesis).
 */
const AjustesInput = z.object({
  autonomia: z.enum(['AUTOMATICO', 'SUPERVISADO', 'ASESOR']),
  aprobacion_monto_min: z.number().positive().max(1_000_000_000).nullable(),
  aprobacion_espera_min: z.number().int().min(5).max(1440),
  aprobacion_sin_respuesta: z.enum(['APROBAR', 'AVISAR']),
  reglas_escalamiento: z.array(z.enum(['PIDE_PERSONA', 'QUEJA', 'PAGOS', 'URGENCIA', 'SIN_SOLUCION', 'MONTO'])).max(6),
  palabras_urgencia: z.array(z.string().trim().min(3).max(40)).max(30),
  contacto_urgencias: z.string().trim().max(300).nullable(),
  recordatorios_horas: z.array(z.number().int().min(1).max(168)).max(3),
  seguimiento_horas: z.number().int().min(0).max(168),
  recordar_pago: z.boolean(),
}).partial().strict();

export async function obtenerAjustes(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'ai:read');
  return { ...(await ajustesIA(tx)), obligatorias: REGLAS_OBLIGATORIAS, reglas: NOMBRE_REGLA, defecto: AJUSTES_IA_DEFECTO };
}

export async function guardarAjustes(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'ai:configure');
  requireWritable(ctx);
  const p = AjustesInput.safeParse(body ?? {});
  if (!p.success) throw invalid(p.error.issues[0]?.message ?? 'Revisa los datos.');
  const d = { ...p.data };
  if (d.reglas_escalamiento) d.reglas_escalamiento = [...new Set([...d.reglas_escalamiento, ...REGLAS_OBLIGATORIAS])];
  if (d.autonomia === 'SUPERVISADO' && d.aprobacion_monto_min === undefined && (await ajustesIA(tx)).aprobacion_monto_min == null) {
    throw invalid('En modo supervisado indica desde qué monto una venta necesita tu aprobación.');
  }
  const k = Object.keys(d) as (keyof typeof d)[];
  await tx.query(`INSERT INTO ia_ajustes (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.tenantId]);
  if (k.length) await tx.query(`UPDATE ia_ajustes SET ${k.map((x, i) => `${x}=$${i + 2}`).join(', ')}, actualizado_en=now(), actualizado_por=$${k.length + 2} WHERE tenant_id=$1`,
    [ctx.tenantId, ...k.map((x) => d[x] as unknown), `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  await audit(tx, ctx, { accion: 'ia.ajustes', recurso: 'ia_ajustes', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { campos: k, autonomia: d.autonomia ?? null } });
  return obtenerAjustes(tx, ctx);
}

/** Lo que hizo la IA hoy y lo único que exige acción (arriba en Inicio). */
export async function hoy(tx: Tx, ctx: Ctx) {
  const zona = await zonaDe(tx);
  const { desde, hasta } = rangoDia(todayLocal(zona), zona);
  const a = desde.toISOString(), b = hasta.toISOString();
  const n = async (sql: string, p: unknown[] = [a, b]) => Number((await tx.query(sql, p)).rows[0]?.n ?? 0);
  const atendidas = await n(`SELECT count(DISTINCT conversation_id)::int AS n FROM message WHERE remitente='AI' AND creado_en >= $1 AND creado_en < $2`);
  const escaladasHoy = await n(`SELECT count(*)::int AS n FROM support_case WHERE creado_en >= $1 AND creado_en < $2`);
  return {
    conversaciones_atendidas: atendidas,
    citas_agendadas: can(ctx, 'appointment:read') ? await n(`SELECT count(*)::int AS n FROM appointment WHERE origen IN ('AGENTE','AUTOMATIZACION') AND creado_en >= $1 AND creado_en < $2`) : null,
    ventas_registradas: can(ctx, 'order:read') ? await n(`SELECT count(*)::int AS n FROM "order" WHERE origen='AGENTE' AND estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2`) : null,
    resuelto_sin_persona_pct: atendidas ? Math.max(0, Math.round(((atendidas - Math.min(escaladasHoy, atendidas)) / atendidas) * 100)) : null,
    // Lo único que pide acción:
    esperan_persona: await n(`SELECT count(*)::int AS n FROM conversation WHERE control='HUMANO' AND estado <> 'CERRADA'`, []),
    aprobaciones: await n(`SELECT count(*)::int AS n FROM pending_action WHERE tipo='NEGOCIO' AND estado='PENDIENTE'`, []),
    pendientes_anotados: await n(`SELECT count(*)::int AS n FROM message WHERE tipo='NOTA_INTERNA' AND (metadatos->>'pendiente')='true' AND creado_en > now() - interval '7 days'`, []),
    avisos_no_enviados: await n(`SELECT count(*)::int AS n FROM aviso_proactivo WHERE estado='NO_ENVIADO' AND creado_en > now() - interval '7 days'`, []),
  };
}

/** Métricas por periodo (máximo un año). */
export async function metricas(tx: Tx, ctx: Ctx, q: { desde?: string; hasta?: string }) {
  requirePerm(ctx, 'ai:read');
  const zona = await zonaDe(tx);
  const f = /^\d{4}-\d{2}-\d{2}$/;
  const hasta = f.test(q.hasta ?? '') ? q.hasta! : todayLocal(zona);
  const desde = f.test(q.desde ?? '') ? q.desde! : addDays(hasta, -29);
  if (desde > hasta || addDays(desde, 366) < hasta) throw invalid('El periodo debe tener entre 1 y 366 días.');
  const a = rangoDia(desde, zona).desde.toISOString(), b = rangoDia(hasta, zona).hasta.toISOString();
  const uno = async (sql: string) => (await tx.query(sql, [a, b])).rows[0] ?? {};
  const conv = await uno(
    `WITH c AS (SELECT DISTINCT conversation_id AS id FROM message WHERE remitente='CUSTOMER' AND creado_en >= $1 AND creado_en < $2)
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM support_case k WHERE k.conversation_id=c.id AND k.creado_en >= $1 AND k.creado_en < $2))::int AS sin_persona
     FROM c`);
  const primera = await uno(
    `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) AS mediana, avg(s) AS promedio FROM (
       SELECT extract(epoch FROM (SELECT min(r.creado_en) FROM message r WHERE r.conversation_id=m.conversation_id AND r.remitente IN ('AI','HUMAN','SYSTEM') AND r.creado_en >= m.creado_en) - m.creado_en) AS s
       FROM message m WHERE m.remitente='CUSTOMER' AND m.creado_en >= $1 AND m.creado_en < $2
         AND NOT EXISTS (SELECT 1 FROM message p WHERE p.conversation_id=m.conversation_id AND p.remitente='CUSTOMER' AND p.creado_en < m.creado_en AND p.creado_en > m.creado_en - interval '30 minutes')
     ) x WHERE s IS NOT NULL`);
  const citas = await uno(
    `SELECT count(*) FILTER (WHERE origen='AGENTE')::int AS ia, count(*) FILTER (WHERE origen='PANEL')::int AS panel, count(*) FILTER (WHERE origen='AUTOMATIZACION')::int AS automatizacion
     FROM appointment WHERE creado_en >= $1 AND creado_en < $2`);
  const ventas = await uno(
    `SELECT count(*) FILTER (WHERE origen='AGENTE')::int AS ia, count(*) FILTER (WHERE origen='PANEL')::int AS panel,
            coalesce(sum(total) FILTER (WHERE origen='AGENTE'), 0) AS monto_ia FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2`);
  const reglas = (await tx.query(`SELECT coalesce(regla, 'SIN_REGLA') AS regla, count(*)::int AS n FROM support_case WHERE creado_en >= $1 AND creado_en < $2 GROUP BY 1 ORDER BY 2 DESC`, [a, b])).rows;
  const avisos = (await tx.query(`SELECT tipo, canal, estado, count(*)::int AS n FROM aviso_proactivo WHERE creado_en >= $1 AND creado_en < $2 GROUP BY 1, 2, 3 ORDER BY 1`, [a, b])).rows;
  // Inasistencia: citas pasadas con recordatorio enviado frente a las que no lo recibieron.
  const asistencia = await uno(
    `SELECT count(*) FILTER (WHERE con_aviso)::int AS con_aviso, count(*) FILTER (WHERE con_aviso AND estado='NO_ASISTIO')::int AS con_aviso_no_asistio,
            count(*) FILTER (WHERE NOT con_aviso)::int AS sin_aviso, count(*) FILTER (WHERE NOT con_aviso AND estado='NO_ASISTIO')::int AS sin_aviso_no_asistio
     FROM (SELECT a.estado, EXISTS (SELECT 1 FROM aviso_proactivo p WHERE p.appointment_id=a.id AND p.tipo='RECORDATORIO' AND p.estado='ENVIADO') AS con_aviso
           FROM appointment a WHERE a.inicio >= $1 AND a.inicio < $2 AND a.inicio < now() AND a.estado IN ('ATENDIDA','NO_ASISTIO')) x`);
  const pct = (x: number, t: number) => (t ? Math.round((x / t) * 1000) / 10 : null);
  return {
    periodo: { desde, hasta },
    conversaciones: { total: conv.total ?? 0, resueltas_sin_persona: conv.sin_persona ?? 0, pct_sin_persona: pct(conv.sin_persona ?? 0, conv.total ?? 0) },
    primera_respuesta_s: { mediana: primera.mediana == null ? null : Math.round(Number(primera.mediana)), promedio: primera.promedio == null ? null : Math.round(Number(primera.promedio)) },
    citas: { ia: citas.ia ?? 0, panel: citas.panel ?? 0, automatizacion: citas.automatizacion ?? 0 },
    ventas: { ia: ventas.ia ?? 0, panel: ventas.panel ?? 0, monto_ia: Number(ventas.monto_ia ?? 0) },
    escalamientos: reglas.map((r: any) => ({ regla: r.regla, nombre: (NOMBRE_REGLA as any)[r.regla] ?? 'Sin regla (antes del cambio o por una persona)', n: r.n })),
    avisos: {
      enviados: avisos.filter((x: any) => x.estado === 'ENVIADO').reduce((s: number, x: any) => s + x.n, 0),
      no_enviados: avisos.filter((x: any) => x.estado === 'NO_ENVIADO').reduce((s: number, x: any) => s + x.n, 0),
      detalle: avisos,
    },
    inasistencia: {
      con_recordatorio_pct: pct(asistencia.con_aviso_no_asistio ?? 0, asistencia.con_aviso ?? 0), con_recordatorio_citas: asistencia.con_aviso ?? 0,
      sin_recordatorio_pct: pct(asistencia.sin_aviso_no_asistio ?? 0, asistencia.sin_aviso ?? 0), sin_recordatorio_citas: asistencia.sin_aviso ?? 0,
    },
  };
}
