import type { Tx } from '../db/index.js';
import { requirePerm, type Ctx } from '../core/context.js';
import { audit } from '../core/audit.js';
import { notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';

/**
 * Hilos del asistente del panel. Son privados de quien los escribe: aunque la RLS aísla por empresa,
 * dentro de ella cada consulta filtra por la persona (un compañero no lee las preguntas de otro).
 *
 * El modelo recibe siempre el resumen de lo antiguo más los últimos VENTANA mensajes completos; quien
 * decide qué recuerda es el servidor, no el navegador.
 */
export const VENTANA = 30;
/** Cuántos mensajes pueden acumularse fuera del resumen antes de condensarlos (evita resumir en cada turno). */
export const LOTE_RESUMEN = 10;

export interface Recibo {
  id: string; herramienta: string; decision: string; motivo?: string | null; riesgo?: string | null;
  /** Acción propuesta que espera la confirmación de la persona (botones Confirmar / Cancelar). */
  pendiente_id?: string; resumen?: string | null;
  /** Estado actual de esa acción al leer el hilo: PENDIENTE, CONFIRMADA, RECHAZADA o EXPIRADA. */
  pendiente?: { estado: string; expira_en: string } | null;
  /** Qué abarcó la consulta (fechas y conteo), para agrupar los recibos en el panel. */
  alcance?: { fecha?: string; desde?: string; hasta?: string; periodo?: string; dias?: number; encontrados?: number };
  /** Guía en pantalla que preparó el asistente (identificador del catálogo de guías). */
  guia?: string;
}
export interface MensajeHilo { id: string; orden: number; rol: 'user' | 'assistant'; contenido: string; ejecuciones: Recibo[]; creado_en: string }

export const tituloDe = (pregunta: string) => {
  const t = pregunta.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
};

/** El hilo de quien pregunta, o «no encontrado»: el de otra persona o de otra empresa no se distingue de uno inexistente. */
export async function hiloPropio(tx: Tx, ctx: Ctx, id: unknown) {
  if (!isUuid(id)) throw notFound();
  const h = (await tx.query(`SELECT id, titulo, resumen, resumido_hasta, creado_en, actualizado_en FROM asistente_hilo WHERE id=$1 AND user_id=$2`, [id, ctx.actor.id])).rows[0];
  if (!h) throw notFound();
  return h as { id: string; titulo: string; resumen: string | null; resumido_hasta: string | number; creado_en: string; actualizado_en: string };
}

export async function listarHilos(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'ai:assist');
  return (await tx.query(
    `SELECT h.id, h.titulo, h.creado_en, h.actualizado_en,
            (SELECT count(*)::int FROM asistente_mensaje m WHERE m.hilo_id=h.id AND m.rol='user') AS preguntas
     FROM asistente_hilo h WHERE h.user_id=$1 ORDER BY h.actualizado_en DESC LIMIT 60`, [ctx.actor.id])).rows;
}

export async function verHilo(tx: Tx, ctx: Ctx, id: unknown) {
  requirePerm(ctx, 'ai:assist');
  const h = await hiloPropio(tx, ctx, id);
  const mensajes = (await tx.query(
    `SELECT id, orden::int AS orden, rol, contenido, ejecuciones, creado_en FROM asistente_mensaje WHERE hilo_id=$1 ORDER BY orden`, [h.id])).rows as MensajeHilo[];
  // Las acciones propuestas muestran su estado de ahora (pudo confirmarse, cancelarse o vencer).
  const ids = mensajes.flatMap((m) => (m.ejecuciones ?? []).map((e) => e.pendiente_id).filter(Boolean)) as string[];
  if (ids.length) {
    const estados = new Map((await tx.query(
      `SELECT id, CASE WHEN estado='PENDIENTE' AND expira_en <= now() THEN 'EXPIRADA' ELSE estado END AS estado, expira_en FROM pending_action WHERE id = ANY($1::uuid[]) AND solicitado_por=$2`,
      [ids, ctx.actor.id])).rows.map((r: any) => [r.id, { estado: r.estado, expira_en: r.expira_en }]));
    for (const m of mensajes) for (const e of m.ejecuciones ?? []) if (e.pendiente_id) e.pendiente = estados.get(e.pendiente_id) ?? null;
  }
  return { id: h.id, titulo: h.titulo, creado_en: h.creado_en, actualizado_en: h.actualizado_en, mensajes };
}

export async function eliminarHilo(tx: Tx, ctx: Ctx, id: unknown) {
  requirePerm(ctx, 'ai:assist');
  const h = await hiloPropio(tx, ctx, id);
  await tx.query(`DELETE FROM asistente_hilo WHERE id=$1`, [h.id]);
  // El contenido de la conversación no se audita: solo que la persona la borró.
  await audit(tx, ctx, { accion: 'ia.asistente.hilo_eliminado', recurso: 'asistente_hilo', recursoId: h.id, resultado: 'EXITO' });
  return { ok: true };
}

/** Lo que el modelo debe recordar de un hilo: el resumen y los mensajes que aún no entraron en él. */
export async function memoriaDelHilo(tx: Tx, hiloId: string) {
  const h = (await tx.query(`SELECT resumen, resumido_hasta FROM asistente_hilo WHERE id=$1`, [hiloId])).rows[0];
  const mensajes = (await tx.query(
    `SELECT orden::int AS orden, rol, contenido FROM asistente_mensaje WHERE hilo_id=$1 AND orden > $2 ORDER BY orden`, [hiloId, Number(h?.resumido_hasta ?? 0)])).rows as { orden: number; rol: 'user' | 'assistant'; contenido: string }[];
  return { resumen: (h?.resumen as string | null) ?? null, mensajes };
}

/** Guarda un intercambio (pregunta + respuesta); crea el hilo si todavía no existe. */
export async function guardarIntercambio(tx: Tx, ctx: Ctx, hiloId: string | null, pregunta: string, respuesta: string, ejecuciones: Recibo[]) {
  let id = hiloId;
  if (!id) {
    id = uuidv7();
    await tx.query(`INSERT INTO asistente_hilo (id, tenant_id, user_id, titulo) VALUES ($1,$2,$3,$4)`, [id, ctx.tenantId, ctx.actor.id, tituloDe(pregunta)]);
  }
  await tx.query(`INSERT INTO asistente_mensaje (id, tenant_id, hilo_id, rol, contenido) VALUES ($1,$2,$3,'user',$4)`, [uuidv7(), ctx.tenantId, id, pregunta]);
  await tx.query(
    `INSERT INTO asistente_mensaje (id, tenant_id, hilo_id, rol, contenido, ejecuciones) VALUES ($1,$2,$3,'assistant',$4,$5)`,
    [uuidv7(), ctx.tenantId, id, respuesta, JSON.stringify(ejecuciones)],
  );
  await tx.query(`UPDATE asistente_hilo SET actualizado_en=now() WHERE id=$1`, [id]);
  return id;
}

/** Mensaje del asistente fuera de una pregunta (p. ej. el resultado de una acción que la persona confirmó). */
export async function guardarMensajeAsistente(tx: Tx, ctx: Ctx, hiloId: string, contenido: string, ejecuciones: Recibo[]) {
  await hiloPropio(tx, ctx, hiloId);
  await tx.query(`INSERT INTO asistente_mensaje (id, tenant_id, hilo_id, rol, contenido, ejecuciones) VALUES ($1,$2,$3,'assistant',$4,$5)`,
    [uuidv7(), ctx.tenantId, hiloId, contenido, JSON.stringify(ejecuciones)]);
  await tx.query(`UPDATE asistente_hilo SET actualizado_en=now() WHERE id=$1`, [hiloId]);
}

/** Mensajes que pasaron de la ventana y todavía no están en el resumen, si ya son suficientes para condensarlos. */
export async function pendientesDeResumir(tx: Tx, hiloId: string) {
  const { mensajes } = await memoriaDelHilo(tx, hiloId);
  if (mensajes.length <= VENTANA + LOTE_RESUMEN) return null;
  return mensajes.slice(0, mensajes.length - VENTANA);
}

export async function guardarResumen(tx: Tx, hiloId: string, resumen: string, hasta: number) {
  await tx.query(`UPDATE asistente_hilo SET resumen=$2, resumido_hasta=$3 WHERE id=$1`, [hiloId, resumen, hasta]);
}
