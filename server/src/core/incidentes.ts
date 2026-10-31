import type { Tx } from '../db/index.js';
import { config } from '../config.js';
import { sha256, uuidv7 } from '../lib/util.js';

/**
 * Incidentes técnicos para el panel del operador. Reglas de privacidad:
 *  - La descripción sale de un catálogo fijo por código, nunca del texto de una
 *    excepción o de un proveedor.
 *  - El detalle solo admite claves de una lista permitida y valores cortos con
 *    caracteres técnicos (sin @, sin espacios largos, sin datos libres).
 *  - Un incidente abierto con la misma huella (código + servicio + empresa) suma
 *    ocurrencias en vez de duplicarse.
 */
export type Gravedad = 'BAJA' | 'MEDIA' | 'ALTA' | 'CRITICA';

export const CATALOGO_INCIDENTES: Record<string, { gravedad: Gravedad; descripcion: string; accion: string }> = {
  HTTP_ERROR_INTERNO: { gravedad: 'ALTA', descripcion: 'Una petición terminó en un error interno (HTTP 500).', accion: 'Busca el identificador de correlación en los registros del servidor. Si se repite, revisa el último despliegue.' },
  TRABAJO_FALLIDO: { gravedad: 'MEDIA', descripcion: 'Un trabajo en segundo plano agotó sus reintentos.', accion: 'Corrige la causa y, si el trabajo es reintentable, reintenta desde aquí.' },
  TRABAJO_CREDENCIAL: { gravedad: 'ALTA', descripcion: 'Un proveedor rechazó la credencial al ejecutar un trabajo.', accion: 'Renueva la credencial del proveedor (variables de entorno o configuración de la empresa).' },
  TRABAJO_TIEMPO_AGOTADO: { gravedad: 'MEDIA', descripcion: 'Un proveedor no respondió a tiempo durante un trabajo.', accion: 'Revisa el estado del proveedor y reintenta si el trabajo lo permite.' },
  TRABAJO_LIMITE: { gravedad: 'MEDIA', descripcion: 'Un proveedor limitó las solicitudes durante un trabajo.', accion: 'Espera a que se libere el límite o revisa el plan del proveedor.' },
  CORREO_CREDENCIAL: { gravedad: 'CRITICA', descripcion: 'El proveedor de correo rechazó la credencial: no sale ningún correo.', accion: 'Revisa RESEND_API_KEY (o SMTP_USER y SMTP_PASSWORD) y reinicia el servidor.' },
  CORREO_REMITENTE: { gravedad: 'CRITICA', descripcion: 'El dominio del remitente no está verificado en el proveedor de correo.', accion: 'Verifica el dominio (SPF y DKIM) en el proveedor o corrige EMAIL_FROM_ADDRESS.' },
  CORREO_CUOTA: { gravedad: 'ALTA', descripcion: 'Se agotó la cuota de envío del proveedor de correo.', accion: 'Amplía el plan del proveedor; los correos pendientes se reintentan solos.' },
  CORREO_SIN_PROVEEDOR: { gravedad: 'ALTA', descripcion: 'No hay proveedor de correo configurado.', accion: 'Configura EMAIL_PROVIDER y sus credenciales.' },
  CORREO_NO_ENVIADO: { gravedad: 'MEDIA', descripcion: 'Un correo no se pudo enviar tras sus reintentos.', accion: 'Si la causa fue temporal, reintenta el envío.' },
  WHATSAPP_CREDENCIAL: { gravedad: 'ALTA', descripcion: 'Meta rechazó el token de acceso: no salen mensajes de WhatsApp.', accion: 'Renueva WHATSAPP_ACCESS_TOKEN o revisa los permisos del usuario del sistema en Meta.' },
  WHATSAPP_ENVIO_FALLIDO: { gravedad: 'MEDIA', descripcion: 'Un mensaje de WhatsApp no se pudo entregar.', accion: 'Revisa el estado del número en Configuración › WhatsApp de la empresa (sin abrir sus conversaciones).' },
  PAGO_REQUIERE_REVISION: { gravedad: 'ALTA', descripcion: 'Un pago de la plataforma no coincide con lo esperado (monto, moneda, pasarela) o se cobró dos veces.', accion: 'Revisa la referencia en el panel de Wompi y en la auditoría; si hubo cobro doble o anulación, gestiona el reembolso o la suspensión manualmente.' },
  REEMBOLSO_POR_VENCER: { gravedad: 'ALTA', descripcion: 'Hay solicitudes de reembolso que vencen en menos de 3 días o ya vencieron. La ley fija un máximo de 15 días calendario para devolver el dinero (Ley 1480 de 2011, art. 47, según la Ley 2439 de 2024).', accion: 'Abre Reembolsos en el panel del operador, decide las solicitudes en revisión y registra la devolución de las aprobadas.' },
  APROVISIONAMIENTO_FALLIDO: { gravedad: 'ALTA', descripcion: 'Un alta pagada no terminó de crear el espacio.', accion: 'Reintenta el aprovisionamiento: es idempotente y no cobra de nuevo.' },
  NUMERO_APROVISIONAMIENTO_FALLIDO: { gravedad: 'ALTA', descripcion: 'Un número de WhatsApp pagado no se pudo comprar o asignar en el proveedor.', accion: 'Revisa la orden en el proveedor de números. La empresa puede elegir otro número sin pagar de nuevo o pedir el reembolso.' },
  NUMERO_REQUISITOS_RECHAZADOS: { gravedad: 'ALTA', descripcion: 'El proveedor rechazó los documentos regulatorios de un número pagado.', accion: 'Lee los comentarios de la orden en el proveedor, contacta a la empresa y corrige los documentos antes del plazo de la orden.' },
  NUMERO_CONEXION_FALLIDA: { gravedad: 'ALTA', descripcion: 'Un número comprado no se pudo activar en WhatsApp.', accion: 'Revisa el estado del número en WhatsApp Manager (verificación, nombre visible, límites) y reintenta la activación desde el panel de la empresa.' },
  NUMERO_PAGO_SIN_CONTRATACION: { gravedad: 'ALTA', descripcion: 'Llegó un pago aprobado de un número cuya contratación ya estaba cancelada o pagada.', accion: 'Verifica la referencia en Wompi y gestiona el reembolso del cobro sobrante.' },
  NUMERO_LIMITE_WABA: { gravedad: 'CRITICA', descripcion: 'La cuenta de WhatsApp Business de Omnegia alcanzó su límite de números: ninguna empresa puede conectar su propio número.', accion: 'En el Administrador comercial de Meta, completa la verificación del negocio o pide un límite mayor para la WABA de WHATSAPP_PLATFORM_WABA_ID. Luego avisa a la empresa para que lo intente de nuevo.' },
  NUMERO_LIBERACION_FALLIDA: { gravedad: 'MEDIA', descripcion: 'No se pudo liberar en el proveedor un número cancelado: sigue generando costo.', accion: 'Libera el número desde el portal del proveedor y marca el incidente como resuelto.' },
  IA_NO_DISPONIBLE: { gravedad: 'MEDIA', descripcion: 'El modelo de lenguaje no respondió; la conversación pasó a una persona.', accion: 'Revisa el estado del proveedor y ANTHROPIC_API_KEY.' },
};

/** Claves de detalle permitidas. Cualquier otra se descarta. */
export const DETALLE_PERMITIDO = ['tipo_trabajo', 'intentos', 'http_estado', 'proveedor', 'codigo_proveedor', 'ruta', 'metodo', 'tipo_correo', 'clase_error'] as const;
const VALOR_SEGURO = /^[A-Za-z0-9_.:/{}\-]{0,80}$/;

export function depurarDetalle(d: Record<string, unknown> = {}): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of DETALLE_PERMITIDO) {
    const v = d[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && VALOR_SEGURO.test(v)) out[k] = v;
  }
  return out;
}

const servicioSeguro = (s: string) => (/^[a-z0-9_.:/{}\-]{1,60}$/i.test(s) ? s : 'otro');

export interface NuevoIncidente {
  codigo: keyof typeof CATALOGO_INCIDENTES | string;
  servicio: string;
  tenantId?: string | null;
  trabajoId?: string | null;
  correlacion?: string | null;
  detalle?: Record<string, unknown>;
}

/** Registra (o agrupa) un incidente. Debe ejecutarse con el rol de plataforma. */
export async function registrarIncidente(tx: Tx, i: NuevoIncidente): Promise<string> {
  const codigo = i.codigo in CATALOGO_INCIDENTES ? String(i.codigo) : 'TRABAJO_FALLIDO';
  const servicio = servicioSeguro(i.servicio);
  const huella = sha256(`${codigo}|${servicio}|${i.tenantId ?? '-'}`);
  const detalle = JSON.stringify(depurarDetalle(i.detalle));
  const correlacion = i.correlacion && /^[\w-]{8,64}$/.test(i.correlacion) ? i.correlacion : null;
  const act = await tx.query(
    `UPDATE incidente SET ocurrencias=ocurrencias+1, ultima_vez=now(), correlacion=coalesce($2, correlacion), trabajo_id=coalesce($3, trabajo_id), detalle=$4, version=$5
     WHERE huella=$1 AND estado <> 'RESUELTO' RETURNING id`, [huella, correlacion, i.trabajoId ?? null, detalle, config.version]);
  if (act.rows[0]) return act.rows[0].id;
  const id = uuidv7();
  await tx.query(
    `INSERT INTO incidente (id, codigo, servicio, gravedad, huella, tenant_id, trabajo_id, correlacion, version, detalle)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (huella) WHERE estado <> 'RESUELTO' DO UPDATE SET ocurrencias=incidente.ocurrencias+1, ultima_vez=now()`,
    [id, codigo, servicio, CATALOGO_INCIDENTES[codigo].gravedad, huella, i.tenantId ?? null, i.trabajoId ?? null, correlacion, config.version, detalle]);
  return id;
}
