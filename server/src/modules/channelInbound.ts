import type { Database } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { systemCtx } from '../core/context.js';
import { findOrCreateByPhone } from './customers.js';
import { addMessage, getOrOpenConversation } from './conversations.js';

/**
 * Entrada del canal. Resolución de tenant por el identificador del número de la
 * cuenta de negocio que llega en el webhook (ADR-02). El webhook se acepta,
 * se persiste y se responde de inmediato; el trabajo real ocurre en el trabajador.
 */
export async function receiveChannelMessages(
  db: Database,
  msgs: { phoneNumberId: string; from: string; nombre: string; id: string; texto: string }[],
  canal: 'WHATSAPP' | 'WEB',
  correlacion: string,
) {
  const resultados: { id: string; estado: string }[] = [];
  for (const m of msgs) {
    const tenant = await db.withPlatform(async (tx) =>
      (await tx.query(
        `SELECT t.id, s.estado FROM tenant t JOIN subscription s ON s.tenant_id=t.id WHERE t.whatsapp_phone_number_id=$1`,
        [m.phoneNumberId],
      )).rows[0],
    );
    if (!tenant) {
      await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'canal' }, 'WEBHOOK', correlacion, {
        accion: 'canal.numero_desconocido', resultado: 'NO_ENCONTRADO', detalle: { phone_number_id: m.phoneNumberId },
      }));
      resultados.push({ id: m.id, estado: 'numero_desconocido' });
      continue;
    }
    if (tenant.estado === 'CANCELADA') { resultados.push({ id: m.id, estado: 'cancelada' }); continue; }
    const r = await db.withTenant(tenant.id, async (tx) => {
      const ctx = { ...systemCtx(tenant.id, correlacion, 'Canal'), origen: canal === 'WHATSAPP' ? 'WHATSAPP' as const : 'WEB' as const };
      const telefono = m.from.startsWith('+') ? m.from : `+${m.from}`;
      const c = await findOrCreateByPhone(tx, ctx, telefono, m.nombre);
      const v = await getOrOpenConversation(tx, ctx, c.id, canal);
      const msg = await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'CUSTOMER', contenido: m.texto, id_externo: m.id });
      if (msg.duplicado) return 'duplicado';
      await enqueue(tx, tenant.id, 'procesar_mensaje', { conversation_id: v.id, message_id: msg.id }, { claveUnica: `proc:${msg.id}` });
      return 'aceptado';
    });
    resultados.push({ id: m.id, estado: r });
  }
  return resultados;
}
