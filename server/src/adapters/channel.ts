import { config } from '../config.js';
import { hmacHex, safeEqual, token } from '../lib/util.js';

/**
 * Puerto del canal de mensajería. WhatsAppCloudAdapter habla con la API oficial
 * de Meta (Graph API /{phone-number-id}/messages). Sin credenciales:
 *   - con simuladores habilitados (desarrollo o SIMULADORES=1) el envío se simula
 *     y el mensaje queda marcado SIMULADO, nunca ENTREGADO;
 *   - en producción el envío falla de forma explícita («pendiente de conectar»).
 * WebWidgetAdapter es el plan de contingencia (el widget consulta por sondeo).
 */
export interface SendResult {
  ok: boolean;
  idExterno?: string;
  error?: string;
  /** El fallo puede resolverse reintentando (red, límite de tasa, 5xx). */
  reintentable?: boolean;
  simulado?: boolean;
}

export interface PlantillaEnvio { nombre: string; idioma: string; parametros: string[] }

export interface ChannelAdapter {
  canal: 'WHATSAPP' | 'WEB';
  sendText(phoneNumberId: string | null, to: string, text: string): Promise<SendResult>;
  sendTemplate(phoneNumberId: string | null, to: string, p: PlantillaEnvio): Promise<SendResult>;
  /** Documento por enlace (p. ej. el PDF de un comprobante). Solo dentro de la ventana de 24 horas. */
  sendDocument?(phoneNumberId: string | null, to: string, d: { enlace: string; archivo: string; texto: string }): Promise<SendResult>;
  /** Imagen por enlace https (foto de un producto). Solo dentro de la ventana de 24 horas. */
  sendImage?(phoneNumberId: string | null, to: string, d: { enlace: string; texto: string }): Promise<SendResult>;
}

/** Firma X-Hub-Signature-256 del webhook de Meta: sha256=<hmac(app_secret, cuerpo)>. */
export function verifyMetaSignature(rawBody: string, header: string | undefined, secret = config.whatsapp.appSecret): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), hmacHex(secret, rawBody));
}
export function signMeta(rawBody: string, secret = config.whatsapp.appSecret ?? ''): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

const esSimulado = (phoneNumberId: string | null) => !phoneNumberId || phoneNumberId.startsWith('sim-');

/**
 * Token con que se habla con Meta por un número. Una empresa conectada con el registro integrado
 * tiene su propio token de negocio (cifrado en la base); el resto usa el token de la plataforma.
 */
type ResolverToken = (phoneNumberId: string) => Promise<string | null | undefined>;
let resolverToken: ResolverToken | null = null;
export const setResolverToken = (r: ResolverToken | null) => { resolverToken = r; };
async function tokenPara(phoneNumberId: string | null): Promise<string | undefined> {
  if (phoneNumberId && !esSimulado(phoneNumberId) && resolverToken) {
    const propio = await resolverToken(phoneNumberId).catch(() => null);
    if (propio) return propio;
  }
  return config.whatsapp.accessToken;
}

/**
 * Códigos de error de la Cloud API que merecen reintento: límites de tasa
 * (4, 80007, 130429, 131056) y fallos temporales del servicio (1, 2, 131000, 133004).
 */
const CODIGOS_REINTENTABLES = new Set([1, 2, 4, 80007, 130429, 131000, 131056, 133004]);
/** Mensajes en lenguaje del negocio para los errores definitivos más frecuentes. */
const CODIGOS_LEGIBLES: Record<number, string> = {
  131047: 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se puede escribir con una plantilla aprobada.',
  131026: 'El número no puede recibir el mensaje (no tiene WhatsApp o no aceptó las condiciones).',
  131051: 'Tipo de mensaje no admitido por WhatsApp.',
  132000: 'La plantilla no coincide con la aprobada en Meta (número de variables).',
  132001: 'La plantilla no existe en Meta o no está aprobada en ese idioma.',
  190: 'El token de acceso de WhatsApp venció o fue revocado.',
  100: 'Meta rechazó la solicitud: revisa el identificador del número.',
};

export class WhatsAppCloudAdapter implements ChannelAdapter {
  canal = 'WHATSAPP' as const;
  constructor(private fetcher: typeof fetch = fetch) {}

  private sinConexion(phoneNumberId: string | null, accessToken: string | undefined): SendResult | null {
    if (esSimulado(phoneNumberId) || !accessToken) {
      if (config.simuladores) return { ok: true, idExterno: `sim.${token(10)}`, simulado: true };
      return { ok: false, reintentable: false, error: esSimulado(phoneNumberId) ? 'La empresa no tiene un número de WhatsApp verificado.' : 'WhatsApp está pendiente de conectar (falta el token de acceso).' };
    }
    return null;
  }

  private async post(phoneNumberId: string, accessToken: string, body: Record<string, unknown>): Promise<SendResult> {
    let res: Response;
    try {
      res = await this.fetcher(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...body }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return { ok: false, reintentable: true, error: `Sin respuesta de WhatsApp (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : 'error de red'}).` };
    }
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.messages?.[0]?.id) return { ok: true, idExterno: String(data.messages[0].id) };
    const code = Number(data?.error?.code);
    const reintentable = res.status >= 500 || res.status === 429 || CODIGOS_REINTENTABLES.has(code);
    return { ok: false, reintentable, error: CODIGOS_LEGIBLES[code] ?? `WhatsApp rechazó el envío (${code || res.status}).` };
  }

  async sendText(phoneNumberId: string | null, to: string, text: string): Promise<SendResult> {
    const tk = await tokenPara(phoneNumberId);
    return this.sinConexion(phoneNumberId, tk) ?? this.post(phoneNumberId!, tk!, { to, type: 'text', text: { preview_url: false, body: text.slice(0, 4096) } });
  }

  async sendTemplate(phoneNumberId: string | null, to: string, p: PlantillaEnvio): Promise<SendResult> {
    const tk = await tokenPara(phoneNumberId);
    return this.sinConexion(phoneNumberId, tk) ?? this.post(phoneNumberId!, tk!, {
      to, type: 'template',
      template: {
        name: p.nombre, language: { code: p.idioma },
        components: p.parametros.length ? [{ type: 'body', parameters: p.parametros.map((t) => ({ type: 'text', text: t.slice(0, 1024) })) }] : [],
      },
    });
  }

  async sendDocument(phoneNumberId: string | null, to: string, d: { enlace: string; archivo: string; texto: string }): Promise<SendResult> {
    const tk = await tokenPara(phoneNumberId);
    return this.sinConexion(phoneNumberId, tk) ?? this.post(phoneNumberId!, tk!, { to, type: 'document', document: { link: d.enlace, filename: d.archivo.slice(0, 120), caption: d.texto.slice(0, 1024) } });
  }

  async sendImage(phoneNumberId: string | null, to: string, d: { enlace: string; texto: string }): Promise<SendResult> {
    const tk = await tokenPara(phoneNumberId);
    return this.sinConexion(phoneNumberId, tk) ?? this.post(phoneNumberId!, tk!, { to, type: 'image', image: { link: d.enlace, caption: d.texto.slice(0, 1024) } });
  }

  /** Diagnóstico del número: datos públicos de la cuenta y calidad, sin enviar nada. */
  async diagnose(phoneNumberId: string): Promise<{ ok: boolean; numero?: string; nombre?: string; calidad?: string; estado?: string; plataforma?: string; error?: string; simulado?: boolean }> {
    if (esSimulado(phoneNumberId)) {
      return config.simuladores ? { ok: true, simulado: true, numero: 'Simulador', nombre: 'Número de pruebas' } : { ok: false, error: 'Los identificadores sim-… solo funcionan en demostración.' };
    }
    const tk = await tokenPara(phoneNumberId);
    if (!tk) return { ok: false, error: 'Falta WHATSAPP_ACCESS_TOKEN en el servidor.' };
    try {
      const res = await this.fetcher(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,status,platform_type`, {
        headers: { Authorization: `Bearer ${tk}` }, signal: AbortSignal.timeout(10_000),
      });
      const d: any = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: CODIGOS_LEGIBLES[Number(d?.error?.code)] ?? `Meta respondió ${res.status}: revisa el identificador del número y los permisos del token.` };
      return { ok: true, numero: d.display_phone_number, nombre: d.verified_name, calidad: d.quality_rating, estado: d.status, plataforma: d.platform_type };
    } catch {
      return { ok: false, error: 'No hubo respuesta de Meta. Intenta de nuevo en unos minutos.' };
    }
  }

  /** Descarga de un archivo recibido: primero la URL temporal del medio y luego su contenido. */
  async downloadMedia(mediaId: string, phoneNumberId: string | null = null): Promise<{ ok: boolean; data?: Buffer; mime?: string; error?: string }> {
    const tk = await tokenPara(phoneNumberId);
    if (!tk) return { ok: false, error: 'WhatsApp está pendiente de conectar.' };
    try {
      const auth = { Authorization: `Bearer ${tk}` };
      const meta: any = await (await this.fetcher(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${encodeURIComponent(mediaId)}`, { headers: auth, signal: AbortSignal.timeout(10_000) })).json();
      if (!meta?.url) return { ok: false, error: 'El archivo ya no está disponible en WhatsApp.' };
      const bin = await this.fetcher(meta.url, { headers: auth, signal: AbortSignal.timeout(30_000) });
      if (!bin.ok) return { ok: false, error: 'No se pudo descargar el archivo.' };
      return { ok: true, data: Buffer.from(await bin.arrayBuffer()), mime: meta.mime_type };
    } catch {
      return { ok: false, error: 'No hubo respuesta de WhatsApp al descargar el archivo.' };
    }
  }
}

export class WebWidgetAdapter implements ChannelAdapter {
  canal = 'WEB' as const;
  async sendText(): Promise<SendResult> { return { ok: true, idExterno: `web.${token(8)}` }; }
  async sendTemplate(): Promise<SendResult> { return { ok: true, idExterno: `web.${token(8)}` }; }
}

export const whatsapp = new WhatsAppCloudAdapter();
const adapters: Record<string, ChannelAdapter> = { WHATSAPP: whatsapp, WEB: new WebWidgetAdapter() };
export const channel = (c: string) => adapters[c] ?? adapters.WEB;
export const setChannelAdapter = (c: string, a: ChannelAdapter) => { adapters[c] = a; };

// ---------------------------------------------------------------------------
// Webhook entrante
// ---------------------------------------------------------------------------
export type TipoEntrante = 'TEXTO' | 'MEDIA' | 'NO_SOPORTADO';
export interface MensajeEntrante {
  phoneNumberId: string;
  from: string;
  nombre: string;
  id: string;
  texto: string;
  tipo: TipoEntrante;
  /** Momento informado por WhatsApp (segundos Unix → Date). */
  ocurridoEn?: Date;
  media?: { tipo: string; id?: string; mime?: string; nombreArchivo?: string; leyenda?: string };
}
export interface EstadoEntrante {
  phoneNumberId: string;
  idExterno: string;
  estado: 'ENVIADO' | 'ENTREGADO' | 'LEIDO' | 'FALLIDO';
  ocurridoEn?: Date;
  error?: string;
}

const ETIQUETA_MEDIA: Record<string, string> = { image: 'una imagen', audio: 'un audio', video: 'un video', document: 'un documento', sticker: 'un sticker' };
const ESTADOS: Record<string, EstadoEntrante['estado']> = { sent: 'ENVIADO', delivered: 'ENTREGADO', read: 'LEIDO', failed: 'FALLIDO' };

const cuando = (ts: unknown) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : undefined;
};

/** Extrae mensajes y estados de entrega de un payload de webhook de WhatsApp Cloud. */
export function parseWhatsAppWebhook(payload: any): { mensajes: MensajeEntrante[]; estados: EstadoEntrante[] } {
  const mensajes: MensajeEntrante[] = [];
  const estados: EstadoEntrante[] = [];
  for (const e of payload?.entry ?? []) {
    for (const ch of e?.changes ?? []) {
      const v = ch?.value;
      const pid = v?.metadata?.phone_number_id;
      if (!pid) continue;
      for (const m of v?.messages ?? []) {
        if (!m?.from || !m?.id) continue;
        const nombre = String((v.contacts ?? []).find((c: any) => c.wa_id === m.from)?.profile?.name ?? '').slice(0, 80);
        const base = { phoneNumberId: String(pid), from: String(m.from), nombre, id: String(m.id), ocurridoEn: cuando(m.timestamp) };
        const texto = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
        if (typeof texto === 'string') { mensajes.push({ ...base, tipo: 'TEXTO', texto: texto.slice(0, 4000) }); continue; }
        if (m.type in ETIQUETA_MEDIA) {
          const x = m[m.type] ?? {};
          const leyenda = typeof x.caption === 'string' ? x.caption.slice(0, 1000) : undefined;
          mensajes.push({
            ...base, tipo: 'MEDIA', texto: leyenda ? `[${ETIQUETA_MEDIA[m.type]}] ${leyenda}` : `[${ETIQUETA_MEDIA[m.type]}]`,
            media: { tipo: m.type, id: x.id, mime: x.mime_type, nombreArchivo: x.filename, leyenda },
          });
          continue;
        }
        if (m.type === 'location') {
          const l = m.location ?? {};
          mensajes.push({ ...base, tipo: 'TEXTO', texto: `[ubicación] ${[l.name, l.address].filter(Boolean).join(' · ') || `${l.latitude}, ${l.longitude}`}` });
          continue;
        }
        if (m.type === 'reaction') continue; // una reacción no es un mensaje que requiera respuesta
        mensajes.push({ ...base, tipo: 'NO_SOPORTADO', texto: `[mensaje de tipo «${String(m.type ?? 'desconocido')}» no admitido]` });
      }
      for (const s of v?.statuses ?? []) {
        const estado = ESTADOS[s?.status];
        if (!s?.id || !estado) continue;
        const err = s.errors?.[0];
        estados.push({
          phoneNumberId: String(pid), idExterno: String(s.id), estado, ocurridoEn: cuando(s.timestamp),
          error: err ? (CODIGOS_LEGIBLES[Number(err.code)] ?? err.title ?? err.message ?? `Error ${err.code}`) : undefined,
        });
      }
    }
  }
  return { mensajes, estados };
}
