import { config } from '../config.js';
import { hmacHex, safeEqual, token } from '../lib/util.js';

/**
 * Puerto del canal de mensajería (PRO-SW-002 fig. 14). WhatsAppCloudAdapter
 * habla con la API oficial cuando hay credenciales; sin ellas simula la entrega,
 * lo que mantiene vivo el producto (y el simulador del panel) mientras se
 * resuelve el punto go/no-go 1. WebWidgetAdapter es el plan de contingencia.
 */
export interface SendResult { ok: boolean; idExterno?: string; error?: string; simulado?: boolean }

export interface ChannelAdapter {
  canal: 'WHATSAPP' | 'WEB';
  sendText(phoneNumberId: string | null, to: string, text: string): Promise<SendResult>;
}

/** Firma X-Hub-Signature-256 del webhook de Meta: sha256=<hmac(app_secret, cuerpo)>. */
export function verifyMetaSignature(rawBody: string, header: string | undefined, secret = config.whatsapp.appSecret): boolean {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(header.slice(7), hmacHex(secret, rawBody));
}
export function signMeta(rawBody: string, secret = config.whatsapp.appSecret): string {
  return `sha256=${hmacHex(secret, rawBody)}`;
}

export class WhatsAppCloudAdapter implements ChannelAdapter {
  canal = 'WHATSAPP' as const;
  async sendText(phoneNumberId: string | null, to: string, text: string): Promise<SendResult> {
    if (!config.whatsapp.accessToken || !phoneNumberId || phoneNumberId.startsWith('sim-')) {
      return { ok: true, idExterno: `sim.${token(10)}`, simulado: true };
    }
    const res = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text.slice(0, 4096) } }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body?.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, idExterno: body?.messages?.[0]?.id };
  }
}

export class WebWidgetAdapter implements ChannelAdapter {
  canal = 'WEB' as const;
  // El widget consulta los mensajes por sondeo: entregar es dejarlos persistidos.
  async sendText(): Promise<SendResult> { return { ok: true, idExterno: `web.${token(8)}` }; }
}

const adapters: Record<string, ChannelAdapter> = { WHATSAPP: new WhatsAppCloudAdapter(), WEB: new WebWidgetAdapter() };
export const channel = (c: string) => adapters[c] ?? adapters.WEB;
export const setChannelAdapter = (c: string, a: ChannelAdapter) => { adapters[c] = a; };

/** Extrae los mensajes de texto de un payload de webhook de WhatsApp Cloud. */
export function parseWhatsAppWebhook(payload: any): { phoneNumberId: string; from: string; nombre: string; id: string; texto: string }[] {
  const out: any[] = [];
  for (const e of payload?.entry ?? []) {
    for (const ch of e?.changes ?? []) {
      const v = ch?.value;
      const pid = v?.metadata?.phone_number_id;
      for (const m of v?.messages ?? []) {
        const texto = m?.type === 'text' ? m.text?.body : m?.type === 'button' ? m.button?.text : m?.type === 'interactive' ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : null;
        if (!pid || !m?.from || !m?.id || typeof texto !== 'string') continue;
        const nombre = (v.contacts ?? []).find((c: any) => c.wa_id === m.from)?.profile?.name ?? '';
        out.push({ phoneNumberId: String(pid), from: String(m.from), nombre: String(nombre).slice(0, 80), id: String(m.id), texto: texto.slice(0, 4000) });
      }
    }
  }
  return out;
}
