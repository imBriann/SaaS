import type { Database } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { auditPlatform } from '../core/audit.js';
import { whatsapp } from '../adapters/channel.js';

/**
 * Diagnóstico del número de WhatsApp de una empresa: consulta a Meta los datos del
 * identificador vinculado y guarda un resultado comprensible para el panel.
 */
export async function verificarWhatsapp(db: Database, tenantId: string, correlacion: string, actor: Ctx['actor'] = { tipo: 'SISTEMA', id: null, nombre: 'Verificación del canal' }) {
  const t = await db.withPlatform(async (tx) => (await tx.query(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [tenantId])).rows[0]);
  if (!t?.whatsapp_phone_number_id) return { estado: 'SIN_CONFIGURAR', mensaje: 'Escribe primero el identificador del número.' };
  const d = await whatsapp.diagnose(t.whatsapp_phone_number_id);
  const estado = d.ok ? (d.simulado ? 'SIMULADO' : 'CONECTADO') : 'ERROR';
  const diagnostico = d.ok
    ? { ok: true, numero: d.numero, nombre: d.nombre, calidad: d.calidad, comprobado: new Date().toISOString() }
    : { ok: false, error: d.error, comprobado: new Date().toISOString() };
  await db.withPlatform(async (tx) => {
    await tx.query(
      `UPDATE tenant SET whatsapp_estado=$2, whatsapp_diagnostico=$3, whatsapp_numero_visible=coalesce($4, whatsapp_numero_visible), whatsapp_verificado_en=CASE WHEN $5 THEN now() ELSE whatsapp_verificado_en END WHERE id=$1`,
      [tenantId, estado, JSON.stringify(diagnostico), d.ok ? d.numero ?? null : null, d.ok],
    );
    await auditPlatform(tx, tenantId, actor, 'PANEL', correlacion, { accion: 'canal.verificar', resultado: d.ok ? 'EXITO' : 'ERROR', detalle: { estado, error: d.ok ? undefined : d.error } });
  });
  return { estado, ...diagnostico, mensaje: d.ok ? (d.simulado ? 'Número de simulación: los mensajes no salen a WhatsApp.' : `Conectado: ${d.numero} (${d.nombre}).`) : d.error };
}
