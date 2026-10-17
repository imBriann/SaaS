import type { Database } from '../db/index.js';
import { config } from '../config.js';
import { auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { normalizeText } from '../lib/util.js';
import type { MensajeCanal } from './channelInbound.js';

/**
 * Asistente de Omnegia en su propio número de WhatsApp (WHATSAPP_PLATFORM_PHONE_NUMBER_ID).
 * No es el agente de ningún comercio: reconoce quién escribe por el teléfono de contacto que cada
 * comercio registró en el alta y responde con ese contexto. Solo usa datos que el propio titular del
 * número ya conoce (nombre del comercio, plan y estado de la suscripción); nunca clientes, ventas ni conversaciones.
 * Los mensajes no se guardan: lo único que queda es una constancia de auditoría sin contenido.
 */
export interface ComercioReconocido { id: string; nombre: string; slug: string; plan: string | null; suscripcion: string | null }

export const soloDigitos = (t: string) => String(t ?? '').replace(/\D/g, '');

/**
 * Comercios cuyo teléfono de contacto coincide con el número que escribe. Coincidencia exacta; solo si el
 * comercio guardó un número sin indicativo (10 dígitos o menos) se compara por la terminación.
 */
export async function reconocerTelefono(db: Database, telefono: string): Promise<ComercioReconocido[]> {
  const d = soloDigitos(telefono);
  if (d.length < 7) return [];
  const filas = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT t.id, t.nombre, t.slug, t.plan_codigo AS plan, s.estado AS suscripcion
       FROM tenant t LEFT JOIN subscription s ON s.tenant_id = t.id
      WHERE t.telefono IS NOT NULL AND (
            regexp_replace(t.telefono, '\\D', '', 'g') = $1
         OR (length(regexp_replace(t.telefono, '\\D', '', 'g')) BETWEEN 7 AND 10 AND $1 LIKE '%' || regexp_replace(t.telefono, '\\D', '', 'g')))
      ORDER BY t.creado_en`, [d])).rows);
  return filas as ComercioReconocido[];
}

const ESTADO_SUSCRIPCION: Record<string, string> = {
  ACTIVA: 'activa', PAGO_PENDIENTE: 'con un pago pendiente', EN_GRACIA: 'en periodo de gracia', SUSPENDIDA: 'suspendida', CANCELADA: 'cancelada',
};
const primerNombre = (n: string) => (n.trim().split(/\s+/)[0] ?? '').slice(0, 30);

/** Respuesta personalizada según quién escribe y qué pregunta. Texto fijo y revisable: no inventa datos. */
export function redactarRespuesta(comercios: ComercioReconocido[], nombre: string, texto: string): string {
  const url = config.publicUrl;
  const t = normalizeText(texto);
  const saludo = nombre ? `Hola ${primerNombre(nombre)}.` : 'Hola.';
  const aviso = `Al escribirnos tratamos tus datos según nuestra política: ${url}/privacidad`;
  if (!comercios.length) {
    return [
      `${saludo} Soy el asistente de Omnegia.`,
      'Este número no figura como contacto de ningún comercio en nuestra plataforma. Si ya tienes una cuenta, escríbenos desde el teléfono que registraste o entra a ' + `${url}/entrar.`,
      `Si quieres crear tu espacio, empieza aquí: ${url}/empezar`,
      aviso,
    ].join('\n\n');
  }
  const lista = comercios.map((c) => `«${c.nombre}»${c.suscripcion ? ` (suscripción ${ESTADO_SUSCRIPCION[c.suscripcion] ?? c.suscripcion.toLowerCase()})` : ''}`);
  const quien = comercios.length === 1 ? `este número figura como contacto de ${lista[0]}` : `este número figura como contacto de ${lista.length} comercios: ${lista.join(', ')}`;
  const cabecera = `${saludo} Te reconozco: ${quien} en Omnegia.`;
  const pie = comercios.length === 1 && config.baseDomain !== 'localhost' ? `Tu panel: https://${comercios[0].slug}.${config.baseDomain}` : `Entra a tu panel desde ${url}/entrar`;
  const suspendida = comercios.some((c) => ['SUSPENDIDA', 'EN_GRACIA', 'PAGO_PENDIENTE'].includes(c.suscripcion ?? ''));
  let cuerpo: string;
  if (/(precio|plan|cuanto cuesta|tarifa|modulo)/.test(t)) cuerpo = `Los módulos y la configuración de tu plan los ves en ${url}/planes. Allí los importes se muestran antes de pagar.`;
  else if (/(factur)/.test(t)) cuerpo = 'La facturación está en el módulo Facturación de tu panel. La emisión con validez fiscal requiere conectar un proveedor tecnológico habilitado por la DIAN.';
  else if (/(pago|pagar|suscrip|renov|cobro)/.test(t)) cuerpo = suspendida ? 'Tu suscripción necesita atención: al pagar se reactiva todo. Mientras tanto tu equipo puede consultar y exportar los datos.' : 'Puedes revisar el estado de tu suscripción en Suscripción, dentro de tu panel.';
  else if (/(whatsapp|conectar|numero|api)/.test(t)) cuerpo = 'Para conectar el WhatsApp de tu comercio entra a Configuración › WhatsApp en tu panel y usa «Probar conexión». Allí verás si falta algo.';
  else if (/(humano|asesor|persona|soporte|ayuda|problema|error|falla)/.test(t)) cuerpo = `Abre una solicitud desde Soporte en tu panel y recibirás un radicado para seguirla. También puedes escribir a ${config.correo.buzonSoporte}.`;
  else cuerpo = 'Cuéntame qué necesitas: puedo orientarte sobre planes y módulos, pagos y suscripción, facturación, conectar WhatsApp o ponerte en contacto con soporte.';
  return [cabecera, cuerpo, pie, aviso].join('\n\n');
}

/**
 * Entrada de un mensaje al número de Omnegia. Reconoce al remitente y encola la respuesta; el envío lo hace
 * el trabajador, igual que en los comercios. No crea clientes ni conversaciones.
 */
export async function atenderPlataforma(db: Database, m: MensajeCanal, correlacion: string): Promise<string> {
  const telefono = m.from.startsWith('+') ? m.from : `+${m.from}`;
  const comercios = await reconocerTelefono(db, telefono);
  const respuesta = redactarRespuesta(comercios, m.nombre ?? '', m.texto ?? '');
  await db.withPlatform(async (tx) => {
    await enqueue(tx, null, 'responder_plataforma', { to: telefono, phone_number_id: m.phoneNumberId, texto: respuesta }, { claveUnica: `plat:${m.id}`, maxIntentos: 4 });
    await auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'asistente_plataforma' }, 'WEBHOOK', correlacion, {
      accion: 'plataforma.mensaje', resultado: 'EXITO', detalle: { reconocido: comercios.length > 0, comercios: comercios.length },
    });
  });
  return 'plataforma_aceptado';
}
