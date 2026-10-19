import type { Database, Tx } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { systemCtx } from '../core/context.js';
import { findOrCreateByPhone } from './customers.js';
import { addMessage, getOrOpenConversation } from './conversations.js';
import type { EstadoEntrante, MensajeEntrante } from '../adapters/channel.js';
import { config } from '../config.js';
import { recibirEstadoPlataforma, recibirPlataforma } from './plataformaConversaciones.js';

/**
 * Entrada del canal. El tenant se resuelve por el identificador del número que
 * llega en el webhook firmado (nunca por un dato del navegador). El webhook se
 * acepta, se persiste y se responde de inmediato; el trabajo ocurre en el trabajador.
 */
async function resolverTenant(db: Database, phoneNumberId: string) {
  return db.withPlatform(async (tx) =>
    (await tx.query(
      `SELECT t.id, s.estado FROM tenant t JOIN subscription s ON s.tenant_id=t.id WHERE t.whatsapp_phone_number_id=$1`,
      [phoneNumberId],
    )).rows[0] as { id: string; estado: string } | undefined,
  );
}

export type MensajeCanal = Pick<MensajeEntrante, 'phoneNumberId' | 'from' | 'nombre' | 'id' | 'texto'> & Partial<MensajeEntrante>;

const esNumeroPlataforma = (phoneNumberId: string) => !!config.whatsapp.plataformaPhoneNumberId && phoneNumberId === config.whatsapp.plataformaPhoneNumberId;

export async function receiveChannelMessages(db: Database, msgs: MensajeCanal[], canal: 'WHATSAPP' | 'WEB', correlacion: string) {
  const resultados: { id: string; estado: string }[] = [];
  for (const m of msgs) {
    // El número de Omnegia no pertenece a ningún comercio: lo atiende el asistente de la plataforma.
    if (esNumeroPlataforma(m.phoneNumberId)) {
      resultados.push({ id: m.id, estado: await recibirPlataforma(db, m, correlacion) });
      continue;
    }
    const tenant = await resolverTenant(db, m.phoneNumberId);
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
      const tipo = m.tipo ?? 'TEXTO';
      const msg = await addMessage(tx, ctx, {
        conversation_id: v.id, remitente: 'CUSTOMER', contenido: m.texto, id_externo: m.id,
        tipo: tipo === 'TEXTO' ? 'TEXTO' : tipo, ocurrido_en: m.ocurridoEn ?? null,
        metadatos: m.media ? { media: m.media } : {},
      });
      if (msg.duplicado) return 'duplicado';
      await enqueue(tx, tenant.id, 'procesar_mensaje', { conversation_id: v.id, message_id: msg.id }, { claveUnica: `proc:${msg.id}`, maxIntentos: 3 });
      return 'aceptado';
    });
    resultados.push({ id: m.id, estado: r });
  }
  return resultados;
}

const RANGO: Record<string, number> = { PENDIENTE: 0, SIMULADO: 1, ENVIADO: 1, ENTREGADO: 2, LEIDO: 3, FALLIDO: 1 };

/**
 * Aplica un estado de entrega. Los estados llegan desordenados: solo se avanza
 * (enviado → entregado → leído); un «fallido» no pisa uno entregado o leído.
 * Devuelve false si el mensaje aún no tiene su id de salida (carrera con el envío).
 */
export async function applyDeliveryStatus(tx: Tx, s: Pick<EstadoEntrante, 'idExterno' | 'estado' | 'error'>): Promise<boolean> {
  const m = (await tx.query(`SELECT id, estado_entrega FROM message WHERE id_externo_salida=$1 FOR UPDATE`, [s.idExterno])).rows[0];
  if (!m) return false;
  const actual = m.estado_entrega as string;
  const avanza = s.estado === 'FALLIDO' ? RANGO[actual] < 2 && actual !== 'FALLIDO' : RANGO[s.estado] > RANGO[actual] || actual === 'FALLIDO';
  if (avanza) await tx.query(`UPDATE message SET estado_entrega=$2, error_entrega=$3 WHERE id=$1`, [m.id, s.estado, s.estado === 'FALLIDO' ? s.error ?? 'WhatsApp no pudo entregar el mensaje.' : null]);
  return true;
}

export async function receiveDeliveryStatuses(db: Database, estados: EstadoEntrante[], correlacion: string) {
  const out: { id: string; estado: string }[] = [];
  for (const s of estados) {
    if (esNumeroPlataforma(s.phoneNumberId)) { out.push({ id: s.idExterno, estado: await recibirEstadoPlataforma(db, s, correlacion) }); continue; }
    const tenant = await resolverTenant(db, s.phoneNumberId);
    if (!tenant) { out.push({ id: s.idExterno, estado: 'numero_desconocido' }); continue; }
    const ok = await db.withTenant(tenant.id, async (tx) => {
      if (await applyDeliveryStatus(tx, s)) return true;
      // El estado llegó antes de que guardáramos el id de salida: se reintenta en segundo plano.
      await enqueue(tx, tenant.id, 'aplicar_estado_entrega', { ...s, correlacion }, { claveUnica: `estado:${s.idExterno}:${s.estado}`, ejecutarEn: new Date(Date.now() + 20_000), maxIntentos: 5 });
      return false;
    });
    out.push({ id: s.idExterno, estado: ok ? 'aplicado' : 'diferido' });
  }
  return out;
}
