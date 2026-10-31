import type { Database, Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { notFound } from '../lib/errors.js';
import { isUuid } from '../lib/util.js';
import { addMessage } from '../modules/conversations.js';
import { ajustesIA } from './politica.js';
import { evaluateAndExecute } from './gateway.js';
import { agentCtx, confirmationText, loadAgent } from './runtime.js';

/**
 * Bandeja de aprobaciones (autonomía SUPERVISADO). Las acciones que la empresa eligió (p. ej. ventas desde un
 * monto) quedan esperando a una persona, que aprueba o rechaza con un clic. Si nadie responde en X minutos se
 * aplica la regla configurada: aprobar sola o avisar al cliente. La ejecución pasa por el mismo Gateway.
 */
export async function listarAprobaciones(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'order:create');
  return (await tx.query(
    `SELECT p.id, p.herramienta, p.resumen, p.expira_en, p.creado_en, p.conversation_id, c.nombre AS cliente
     FROM pending_action p JOIN conversation v ON v.id=p.conversation_id JOIN customer c ON c.id=v.customer_id
     WHERE p.tipo='NEGOCIO' AND p.estado='PENDIENTE' ORDER BY p.creado_en`)).rows;
}

export async function decidirDesdePanel(db: Database, ctx: Ctx, id: string, body: unknown) {
  await db.withTenant(ctx.tenantId, async () => { requirePerm(ctx, 'order:create'); requireWritable(ctx); });
  if (!isUuid(id)) throw notFound();
  const aprobar = (body as any)?.aprobar === true;
  const r = await decidirAprobacion(db, ctx.tenantId, id, { aprobar, por: `USUARIO:${ctx.actor.nombre}` }, ctx.correlacion);
  if (!r) throw notFound();
  return r;
}

/** decision = null: venció sin respuesta y se aplica la regla de la empresa. */
export async function decidirAprobacion(db: Database, tenantId: string, id: string, decision: { aprobar: boolean; por: string } | null, correlacion: string) {
  return db.withTenant(tenantId, async (tx) => {
    const p = (await tx.query(
      `SELECT p.*, v.customer_id, c.nombre AS cliente FROM pending_action p JOIN conversation v ON v.id=p.conversation_id JOIN customer c ON c.id=v.customer_id
       WHERE p.id=$1 AND p.tipo='NEGOCIO' AND p.estado='PENDIENTE' FOR UPDATE OF p`, [id])).rows[0];
    if (!p) return null;
    const agent = await loadAgent(tx, 'atencion');
    if (!agent) return null;
    const ctx = agentCtx(tenantId, agent, 'WHATSAPP', correlacion);
    const aj = await ajustesIA(tx);
    const aprobar = decision ? decision.aprobar : aj.aprobacion_sin_respuesta === 'APROBAR';
    const por = decision?.por ?? 'SISTEMA:sin respuesta a tiempo';
    if (aprobar) {
      await tx.query(`UPDATE pending_action SET estado='CONFIRMADA', decidido_por=$2 WHERE id=$1`, [id, por]);
      const r = await evaluateAndExecute({ tx, ctx, conversationId: p.conversation_id, customerId: p.customer_id }, agent, { nombre: p.herramienta, argumentos: p.argumentos },
        { confirmacion: { por: `NEGOCIO:${por}`, pendingActionId: id } });
      const texto = r.decision === 'CONFIRMADA' ? confirmationText(p.herramienta, r.resultado as any) : 'No pude completar tu compra; el equipo del negocio te escribirá por aquí para ayudarte.';
      await addMessage(tx, ctx, { conversation_id: p.conversation_id, remitente: 'AI', contenido: texto, metadatos: { ejecuciones: [r.executionId], aprobacion: id } });
      await audit(tx, ctx, { accion: 'ia.aprobacion.aprobada', recurso: 'pending_action', recursoId: id, resultado: 'EXITO', detalle: { por, decision: r.decision } });
      return { id, estado: 'APROBADA', ejecucion: r.decision };
    }
    await tx.query(`UPDATE pending_action SET estado=$2, decidido_por=$3 WHERE id=$1`, [id, decision ? 'RECHAZADA' : 'EXPIRADA', por]);
    const texto = decision
      ? `El negocio no pudo aprobar «${p.resumen}» en este momento. Te escribirán por aquí para ayudarte con otra opción.`
      : `«${p.resumen}» sigue en revisión del negocio. Te escribirán por aquí apenas lo confirmen.`;
    await addMessage(tx, ctx, { conversation_id: p.conversation_id, remitente: 'AI', contenido: texto, metadatos: { aprobacion: id } });
    if (!decision) await addMessage(tx, ctx, { conversation_id: p.conversation_id, remitente: 'SYSTEM', tipo: 'NOTA_INTERNA', contenido: `Pendiente: nadie aprobó a tiempo «${p.resumen}». El cliente sabe que se le escribirá.`, metadatos: { pendiente: true } });
    await audit(tx, ctx, { accion: decision ? 'ia.aprobacion.rechazada' : 'ia.aprobacion.vencida', recurso: 'pending_action', recursoId: id, resultado: 'EXITO', detalle: { por } });
    return { id, estado: decision ? 'RECHAZADA' : 'VENCIDA' };
  });
}
