import { config } from '../config.js';
import { hmacHex, safeEqual } from '../lib/util.js';

/**
 * Puerto de la pasarela de pagos (suscripción del SaaS). En el piloto se usa una
 * pasarela simulada con el mismo contrato que las reales: checkout alojado,
 * webhook firmado (HMAC-SHA256 con marca de tiempo) y eventos con id único.
 *
 * Cabecera: x-pasarela-firma: t=<unix>,v1=<hex(hmac(secreto, `${t}.${cuerpo}`))>
 */
const TOLERANCIA_S = 300;

export function signWebhook(body: string, secret = config.payments.webhookSecret, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;
}

export function verifyWebhook(body: string, header: string | undefined, secret = config.payments.webhookSecret, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > TOLERANCIA_S) return false; // repetición fuera de ventana
  return safeEqual(parts.v1, hmacHex(secret, `${t}.${body}`));
}

export interface EventoPago {
  id: string; // id único del evento: base de la idempotencia
  tipo: 'pago.aprobado' | 'pago.rechazado';
  referencia: string;
  monto: number;
  moneda: string;
  creado: string;
}

export function checkoutUrl(referencia: string, monto: number, concepto: string): string {
  return `${config.publicUrl}/pasarela/checkout?ref=${encodeURIComponent(referencia)}&monto=${monto}&concepto=${encodeURIComponent(concepto)}`;
}
