import { Resend } from 'resend';
import type { Database, Tx } from '../db/index.js';
import { enqueue } from '../core/events.js';
import { registrarIncidente } from '../core/incidentes.js';
import { config } from '../config.js';
import { decrypt, encrypt, uuidv7 } from '../lib/util.js';
import { MENSAJE_FALLO, proveedorCorreo, type CodigoFalloCorreo } from './proveedores.js';
import type { CorreoRenderizado } from './plantillas.js';

/**
 * Servicio de correo: bandeja de salida (email_outbox) + entrega desde el trabajador.
 *
 *  - Encolar es transaccional: el correo existe si y solo si la operación que lo
 *    origina se confirma.
 *  - Los correos «sensibles» (códigos, enlaces de acceso) se guardan cifrados con
 *    APP_KEY y su contenido se borra en cuanto el proveedor los acepta o fallan.
 *  - ENVIADO significa «aceptado por el proveedor». ENTREGADO, REBOTADO y QUEJA
 *    solo llegan por el webhook firmado del proveedor.
 *  - La clave de idempotencia del proveedor es el id del correo: un reintento no
 *    produce un segundo envío.
 */
const DESTINATARIO_RE = /^[^@\s<>,;"'()\\[\]]+@[^@\s<>,;"'()\\[\]]+\.[A-Za-z]{2,}$/;

export function validarDestinatario(para: unknown): string | null {
  const s = String(para ?? '').trim();
  if (!s || s.length > 254 || /[\r\n]/.test(s) || !DESTINATARIO_RE.test(s)) return null;
  const [local, dominio] = s.split('@');
  if (local.length > 64) return null;
  return `${local}@${dominio.toLowerCase()}`;
}

export interface Encolar {
  tenantId: string | null;
  userId?: string | null;
  para: string;
  correo: CorreoRenderizado;
  /** Contiene códigos o enlaces de acceso: cifrado y borrado tras el envío. */
  sensible?: boolean;
  /** Pasado este momento el correo ya no sirve y no se envía. */
  caducaEn?: Date;
  /** Evita encolar dos veces el mismo aviso (p. ej. un aviso por ventana de tiempo). */
  clave?: string;
  responderA?: string;
  adjuntoRef?: string | null;
  conversationId?: string | null;
}

/** Encola un correo dentro de la transacción del llamador. Devuelve su id (o el ya existente con esa clave). */
export async function encolarCorreo(tx: Tx, o: Encolar): Promise<string> {
  const id = uuidv7();
  const para = validarDestinatario(o.para);
  const responderA = o.responderA ? validarDestinatario(o.responderA) : null;
  const sensible = !!o.sensible;
  const contenido = sensible ? encrypt(config.appKey, JSON.stringify({ html: o.correo.html, texto: o.correo.texto })) : null;
  const r = await tx.query(
    `INSERT INTO email_outbox (id, tenant_id, user_id, para, asunto, tipo, cuerpo_html, cuerpo_texto, sensible, contenido_cifrado, responder_a, caduca_en,
                               clave_idempotencia, adjunto_ref, conversation_id, estado, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (clave_idempotencia) WHERE clave_idempotencia IS NOT NULL DO NOTHING RETURNING id`,
    [id, o.tenantId, o.userId ?? null, para ?? String(o.para ?? '').slice(0, 254), o.correo.asunto, o.correo.tipo,
      sensible ? null : o.correo.html, sensible ? null : o.correo.texto, sensible, contenido, responderA, o.caducaEn ?? null,
      o.clave ?? null, o.adjuntoRef ?? null, o.conversationId ?? null, para ? 'PENDIENTE' : 'FALLIDO', para ? null : 'DESTINATARIO_INVALIDO'],
  );
  if (!r.rows[0]) return (await tx.query(`SELECT id FROM email_outbox WHERE clave_idempotencia=$1`, [o.clave])).rows[0].id;
  if (para) await enqueue(tx, o.tenantId, 'enviar_correo', { email_id: id }, { claveUnica: `mail:${id}`, maxIntentos: 6 });
  return id;
}

/** Mensaje seguro de un código de fallo guardado en email_outbox.error. */
export const mensajeFallo = (codigo: string | null | undefined) => (codigo && codigo in MENSAJE_FALLO ? MENSAJE_FALLO[codigo as CodigoFalloCorreo] : codigo ? 'No se pudo enviar el correo.' : null);

const INCIDENTE_POR_FALLO: Partial<Record<CodigoFalloCorreo, string>> = {
  CREDENCIAL_INVALIDA: 'CORREO_CREDENCIAL', REMITENTE_NO_VERIFICADO: 'CORREO_REMITENTE', CUOTA_AGOTADA: 'CORREO_CUOTA',
  SIN_PROVEEDOR: 'CORREO_SIN_PROVEEDOR', LIMITE_PROVEEDOR: 'CORREO_NO_ENVIADO', TIEMPO_AGOTADO: 'CORREO_NO_ENVIADO',
  PROVEEDOR_NO_DISPONIBLE: 'CORREO_NO_ENVIADO', ERROR_DESCONOCIDO: 'CORREO_NO_ENVIADO', RECHAZADO: 'CORREO_NO_ENVIADO',
};

export interface ResultadoProceso { estado: 'ENVIADO' | 'PENDIENTE' | 'FALLIDO' | 'OMITIDO'; codigo?: CodigoFalloCorreo; esperaSegundos?: number; correo?: any }

/**
 * Entrega un correo de la bandeja (lo llama el trabajador). Idempotente: un correo ya
 * aceptado no se vuelve a enviar. `ultimo` indica que no quedan reintentos.
 */
export async function procesarCorreo(db: Database, tenantId: string | null, emailId: string, meta: { ultimo: boolean; trabajoId?: string }): Promise<ResultadoProceso> {
  const con = <T,>(fn: (tx: Tx) => Promise<T>) => (tenantId ? db.withTenant(tenantId, fn) : db.withPlatform(fn));
  const m = await con(async (tx) => (await tx.query(`SELECT * FROM email_outbox WHERE id=$1`, [emailId])).rows[0]);
  if (!m || m.estado !== 'PENDIENTE') return { estado: 'OMITIDO', correo: m };
  const purgar = m.sensible ? `, contenido_cifrado=NULL, cuerpo_html=NULL, cuerpo_texto=NULL` : '';

  if (m.caduca_en && new Date(m.caduca_en) < new Date()) {
    await con((tx) => tx.query(`UPDATE email_outbox SET estado='FALLIDO', error='CADUCADO', actualizado_en=now()${purgar} WHERE id=$1`, [m.id]));
    return { estado: 'FALLIDO', codigo: 'CADUCADO', correo: m };
  }
  let html = m.cuerpo_html ?? '';
  let texto = m.cuerpo_texto ?? '';
  if (m.sensible) {
    try { ({ html, texto } = JSON.parse(decrypt(config.appKey, m.contenido_cifrado))); } catch {
      await con((tx) => tx.query(`UPDATE email_outbox SET estado='FALLIDO', error='ERROR_DESCONOCIDO', actualizado_en=now()${purgar} WHERE id=$1`, [m.id]));
      return { estado: 'FALLIDO', codigo: 'ERROR_DESCONOCIDO', correo: m };
    }
  }
  if (!texto) texto = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // Adjunto de un pago a la plataforma: el ZIP se lee del almacenamiento privado en el momento del envío.
  let adjuntos: { nombre: string; contenido: Buffer; tipo: string }[] | undefined;
  if (typeof m.adjunto_ref === 'string' && m.adjunto_ref.startsWith('docpago:')) {
    const d = await db.withPlatform(async (tx) => (await tx.query(`SELECT numero, zip FROM documento_pago WHERE id=$1 AND estado='LISTO'`, [m.adjunto_ref.slice(8)])).rows[0]);
    if (d?.zip) adjuntos = [{ nombre: `documentos-omnegia-${d.numero}.zip`, contenido: Buffer.from(d.zip), tipo: 'application/zip' }];
  }
  const p = proveedorCorreo();
  const r = await p.enviar({
    para: m.para, asunto: m.asunto, html, texto, tipo: m.tipo,
    responderA: m.responder_a ?? config.correo.responderA, claveIdempotencia: m.id, adjuntos,
  });

  if (r.ok) {
    await con((tx) => tx.query(
      `UPDATE email_outbox SET estado='ENVIADO', id_proveedor=$2, proveedor=$3, error=NULL, intentos=intentos+1, ultimo_intento_en=now(), aceptado_en=now(), actualizado_en=now()${purgar} WHERE id=$1 AND estado='PENDIENTE'`,
      [m.id, r.idProveedor, p.nombre]));
    if (!config.test) console.log(`[correo] ${m.tipo} ${m.id} aceptado por ${p.nombre}`);
    return { estado: 'ENVIADO', correo: m };
  }
  const reintentar = r.reintentable && !meta.ultimo;
  await con((tx) => tx.query(
    `UPDATE email_outbox SET estado=$2, error=$3, proveedor=$4, intentos=intentos+1, ultimo_intento_en=now(), actualizado_en=now()${reintentar ? '' : purgar} WHERE id=$1`,
    [m.id, reintentar ? 'PENDIENTE' : 'FALLIDO', r.codigo, p.nombre]));
  if (!config.test) console.warn(`[correo] ${m.tipo} ${m.id} no enviado por ${p.nombre}: ${r.codigo}${reintentar ? ' (se reintentará)' : ''}`);
  // Fallos de configuración (credencial, remitente, cuota) y fallos definitivos llegan al operador.
  const incidente = INCIDENTE_POR_FALLO[r.codigo];
  if (incidente && (!reintentar || ['CORREO_CREDENCIAL', 'CORREO_REMITENTE', 'CORREO_CUOTA'].includes(incidente))) {
    await db.withPlatform((tx) => registrarIncidente(tx, {
      codigo: incidente, servicio: 'correo', tenantId: m.tenant_id, trabajoId: reintentar ? null : meta.trabajoId ?? null,
      detalle: { proveedor: p.nombre, codigo_proveedor: r.codigo, tipo_correo: m.tipo, intentos: Number(m.intentos) + 1 },
    })).catch(() => {});
  }
  return { estado: reintentar ? 'PENDIENTE' : 'FALLIDO', codigo: r.codigo, esperaSegundos: r.esperaSegundos, correo: m };
}

// ------------------------------------------------------------------ webhook de Resend (estados de entrega)
const RANGO: Record<string, number> = { PENDIENTE: 0, ENVIADO: 1, ENTREGADO: 2, REBOTADO: 3, QUEJA: 3, FALLIDO: 3 };
const EVENTO_A_ESTADO: Record<string, { estado: string; error?: string }> = {
  'email.delivered': { estado: 'ENTREGADO' },
  'email.bounced': { estado: 'REBOTADO', error: 'DESTINATARIO_INVALIDO' },
  'email.complained': { estado: 'QUEJA' },
  'email.failed': { estado: 'FALLIDO', error: 'RECHAZADO' },
  'email.suppressed': { estado: 'REBOTADO', error: 'DESTINATARIO_INVALIDO' },
};

export class FirmaInvalida extends Error {}

/** Verifica la firma (SDK oficial, esquema Svix) y aplica el estado. Solo avanza, nunca retrocede. */
export async function webhookResend(db: Database, cuerpo: string, cabeceras: Record<string, unknown>) {
  const secreto = config.correo.resendWebhookSecret;
  if (!secreto) throw new FirmaInvalida('sin secreto');
  let evento: any;
  try {
    evento = new Resend(config.correo.resendApiKey ?? 're_solo_verificacion').webhooks.verify({
      payload: cuerpo,
      headers: { id: String(cabeceras['svix-id'] ?? ''), timestamp: String(cabeceras['svix-timestamp'] ?? ''), signature: String(cabeceras['svix-signature'] ?? '') },
      webhookSecret: secreto,
    });
  } catch { throw new FirmaInvalida('firma'); }
  const cambio = EVENTO_A_ESTADO[evento?.type];
  const idProveedor = evento?.data?.email_id;
  if (!cambio || !idProveedor) return { ok: true, aplicado: false };
  return db.withPlatform(async (tx) => {
    const m = (await tx.query(`SELECT id, estado, tenant_id, adjunto_ref FROM email_outbox WHERE id_proveedor=$1 FOR UPDATE`, [String(idProveedor)])).rows[0];
    if (!m || (RANGO[cambio.estado] ?? 0) <= (RANGO[m.estado] ?? 0)) return { ok: true, aplicado: false };
    await tx.query(
      `UPDATE email_outbox SET estado=$2, error=coalesce($3, error), entregado_en=CASE WHEN $2='ENTREGADO' THEN now() ELSE entregado_en END, actualizado_en=now() WHERE id=$1`,
      [m.id, cambio.estado, cambio.error ?? null]);
    if (m.adjunto_ref && m.tenant_id) {
      await tx.query(`UPDATE fiscal_document SET entrega_email=$2 WHERE id=$1 AND tenant_id=$3`, [m.adjunto_ref, cambio.estado === 'ENTREGADO' ? 'ENTREGADO' : 'FALLIDO', m.tenant_id]);
    }
    return { ok: true, aplicado: true, estado: cambio.estado };
  });
}
