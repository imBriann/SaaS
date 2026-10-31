import type { Database } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { auditPlatform } from '../core/audit.js';
import { whatsapp } from '../adapters/channel.js';

/**
 * Diagnóstico del número de WhatsApp de una empresa: consulta a Meta los datos del
 * identificador vinculado y guarda un resultado comprensible para el panel.
 */
export async function verificarWhatsapp(db: Database, tenantId: string, correlacion: string, actor: Ctx['actor'] = { tipo: 'SISTEMA', id: null, nombre: 'Verificación del canal' }, canal: Pick<typeof whatsapp, 'diagnose'> = whatsapp) {
  const t = await db.withPlatform(async (tx) => (await tx.query(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [tenantId])).rows[0]);
  if (!t?.whatsapp_phone_number_id) return { estado: 'SIN_CONFIGURAR', mensaje: 'Todavía no hay un número conectado. Conéctalo desde «Número de WhatsApp › Usar mi propio número».' };
  const d = await canal.diagnose(t.whatsapp_phone_number_id);
  // Verificado pero no registrado en la Cloud API (status ≠ CONNECTED o platform_type ≠ CLOUD_API): no recibe ni envía.
  // Nunca se muestra como conectado: queda PENDIENTE_REGISTRO y el operador ve «Registrar en la API».
  const sinRegistro = d.ok && !d.simulado && ((d.estado && d.estado !== 'CONNECTED') || (d.plataforma && d.plataforma !== 'CLOUD_API'));
  const estado = !d.ok ? 'ERROR' : d.simulado ? 'SIMULADO' : sinRegistro ? 'PENDIENTE_REGISTRO' : 'CONECTADO';
  const diagnostico = d.ok
    ? { ok: !sinRegistro, numero: d.numero, nombre: d.nombre, calidad: d.calidad, estado_meta: d.estado ?? null, plataforma: d.plataforma ?? null, comprobado: new Date().toISOString() }
    : { ok: false, error: d.error, comprobado: new Date().toISOString() };
  await db.withPlatform(async (tx) => {
    await tx.query(
      `UPDATE tenant SET whatsapp_estado=$2, whatsapp_diagnostico=$3, whatsapp_numero_visible=coalesce($4, whatsapp_numero_visible), whatsapp_verificado_en=CASE WHEN $5 THEN now() ELSE whatsapp_verificado_en END WHERE id=$1`,
      [tenantId, estado, JSON.stringify(diagnostico), d.ok ? d.numero ?? null : null, d.ok && !sinRegistro],
    );
    await auditPlatform(tx, tenantId, actor, 'PANEL', correlacion, { accion: 'canal.verificar', resultado: d.ok ? 'EXITO' : 'ERROR', detalle: { estado, error: d.ok ? undefined : d.error } });
  });
  return {
    estado, ...diagnostico, acciones: sinRegistro ? ['registrar'] : [],
    mensaje: !d.ok ? d.error : d.simulado ? 'Número de simulación: los mensajes no salen a WhatsApp.'
      : sinRegistro ? `${d.numero ?? 'El número'} está verificado pero falta registrarlo en la API de WhatsApp: todavía no recibe ni envía mensajes. Regístralo desde «Números de WhatsApp» en el panel del operador.`
      : `Conectado: ${d.numero} (${d.nombre}).`,
  };
}
