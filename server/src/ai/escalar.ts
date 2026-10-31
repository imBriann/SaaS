import type { Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { escalate } from '../modules/conversations.js';
import { horarioNegocio } from '../modules/proactivo.js';
import { NOMBRE_REGLA } from './escalamiento.js';
import type { ReglaEscalamiento } from './politica.js';

/** Qué hizo la IA en este episodio (desde el último radicado cerrado), para el radicado. */
const ETIQUETA: Record<string, string> = {
  consultar_catalogo: 'consultó el catálogo', consultar_precio: 'consultó precios', consultar_disponibilidad: 'buscó horarios', crear_cita: 'intentó agendar',
  reprogramar_cita: 'intentó reprogramar', cancelar_cita: 'intentó cancelar', mis_citas: 'revisó sus citas', registrar_venta: 'intentó registrar la venta',
  generar_enlace_pago: 'generó un enlace de pago', consultar_comprobantes: 'revisó sus comprobantes', reenviar_comprobante: 'reenvió un comprobante',
  consultar_inventario: 'consultó existencias', enviar_imagen_producto: 'envió la foto de un producto', unirse_lista_espera: 'lo anotó en la lista de espera',
};

export async function loIntentado(tx: Tx, conversationId: string): Promise<string> {
  const filas = (await tx.query(
    `SELECT herramienta, decision FROM ai_execution WHERE conversation_id=$1
       AND creado_en > coalesce((SELECT max(cerrado_en) FROM support_case WHERE conversation_id=$1), '-infinity'::timestamptz)
     ORDER BY creado_en`, [conversationId])).rows;
  const vistos = new Set<string>();
  const partes: string[] = [];
  for (const f of filas) {
    const e = ETIQUETA[f.herramienta];
    if (!e || vistos.has(e)) continue;
    vistos.add(e);
    partes.push(`${e}${['ERROR', 'DENEGADA'].includes(f.decision) ? ' (sin éxito)' : ''}`);
  }
  return partes.length ? `La IA ${partes.join(', ')}.` : 'La IA no alcanzó a usar herramientas.';
}

/**
 * Escala por una regla explícita: radicado con la regla, el motivo, la prioridad y lo que ya se intentó, y el
 * mensaje para el cliente con qué va a pasar y en cuánto tiempo (fuera del horario no se promete inmediatez).
 */
export async function escalarPorRegla(tx: Tx, ctx: Ctx, conversationId: string, e: { regla: ReglaEscalamiento; prioridad: 'MEDIA' | 'ALTA' | 'URGENTE'; motivo: string }, negocio: string) {
  const intentado = await loIntentado(tx, conversationId);
  const r = await escalate(tx, ctx, conversationId, `[${NOMBRE_REGLA[e.regla]}] ${e.motivo}`, e.prioridad);
  await tx.query(`UPDATE support_case SET regla=coalesce(regla, $2), intentado=coalesce(intentado, $3) WHERE id=$1`, [r.case_id, e.regla, intentado]);
  const h = await horarioNegocio(tx);
  const sla = Number((await tx.query(`SELECT minutos_primera_respuesta FROM sla_policy WHERE prioridad=$1`, [e.prioridad])).rows[0]?.minutos_primera_respuesta ?? 60);
  const tiempo = h.abierto
    ? `Normalmente responden en ${sla < 60 ? `unos ${sla} minutos` : sla === 60 ? 'menos de una hora' : `unas ${Math.round(sla / 60)} horas`}, por este mismo chat.`
    : `En este momento estamos fuera del horario de atención: te responderán ${h.proxima ? `${h.proxima}` : 'apenas abran'}, por este mismo chat.`;
  return { radicado: r.radicado, case_id: r.case_id, mensaje: `Te comunico con una persona del equipo de ${negocio}. Tu radicado es *${r.radicado}*. ${tiempo}`, existente: r.existente };
}
