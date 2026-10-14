import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { hmacHex, safeEqual } from '../lib/util.js';

/**
 * Puerto de la pasarela de pagos. Dos implementaciones con el mismo contrato:
 *
 *  - Wompi (Colombia): checkout web alojado con firma de integridad
 *    SHA-256(referencia + monto_en_centavos + moneda [+ expiración] + secreto_integridad)
 *    y eventos «transaction.updated» firmados con un checksum SHA-256 sobre las
 *    propiedades indicadas en signature.properties + timestamp + secreto_eventos.
 *  - Simulada (desarrollo y demostración): HMAC-SHA256 con marca de tiempo.
 *
 * Un pago NUNCA se da por confirmado por la redirección del navegador: solo por un
 * evento con firma válida o por una consulta servidor a servidor de la transacción.
 */
export type Proveedor = 'wompi' | 'simulada';
export type EstadoPago = 'APROBADO' | 'RECHAZADO' | 'ANULADO' | 'ERROR' | 'PENDIENTE';

export interface CuentaPasarela {
  proveedor: Proveedor;
  entorno: 'sandbox' | 'produccion';
  llavePublica?: string;
  secretoIntegridad?: string;
  secretoEventos?: string;
}

export interface EventoPago {
  /** Identificador único del evento: base de la idempotencia. */
  id: string;
  referencia: string;
  estado: EstadoPago;
  montoCentavos: number;
  moneda: string;
  transaccionId?: string;
}

export interface CheckoutInput {
  referencia: string;
  montoCentavos: number;
  moneda?: 'COP';
  redirectUrl: string;
  expiraEn?: Date;
  concepto?: string;
  cliente?: { email?: string | null; nombre?: string | null; telefono?: string | null };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Cuenta de la plataforma (suscripciones y alta de empresas), según la configuración. */
export function cuentaPlataforma(): CuentaPasarela | null {
  if (config.pagos.proveedor === 'wompi') {
    const w = config.pagos.wompi;
    return { proveedor: 'wompi', entorno: w.entorno, llavePublica: w.llavePublica, secretoIntegridad: w.secretoIntegridad, secretoEventos: w.secretoEventos };
  }
  if (config.pagos.proveedor === 'simulada') return { proveedor: 'simulada', entorno: 'sandbox' };
  return null;
}

// ---------------------------------------------------------------- Wompi
export function firmaIntegridadWompi(referencia: string, montoCentavos: number, moneda: string, secreto: string, expiraEn?: string): string {
  return sha256(`${referencia}${montoCentavos}${moneda}${expiraEn ?? ''}${secreto}`);
}

export function apiWompi(entorno: CuentaPasarela['entorno']) {
  return entorno === 'produccion' ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1';
}

const ESTADO_WOMPI: Record<string, EstadoPago> = { APPROVED: 'APROBADO', DECLINED: 'RECHAZADO', VOIDED: 'ANULADO', ERROR: 'ERROR', PENDING: 'PENDIENTE' };

function valorEnRuta(obj: any, ruta: string): unknown {
  return ruta.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Verifica el checksum de un evento de Wompi y lo normaliza. */
export function verificarEventoWompi(cuenta: CuentaPasarela, cuerpo: any): EventoPago | null {
  if (!cuenta.secretoEventos || cuerpo?.event !== 'transaction.updated') return null;
  const props: unknown = cuerpo?.signature?.properties;
  const checksum = String(cuerpo?.signature?.checksum ?? '');
  if (!Array.isArray(props) || !props.length || !checksum || cuerpo?.timestamp === undefined) return null;
  const concatenado = props.map((p) => String(valorEnRuta(cuerpo.data, String(p)) ?? '')).join('') + String(cuerpo.timestamp) + cuenta.secretoEventos;
  if (!safeEqual(sha256(concatenado).toLowerCase(), checksum.toLowerCase())) return null;
  const t = cuerpo.data?.transaction ?? {};
  if (!t.id || !t.reference || !ESTADO_WOMPI[t.status]) return null;
  return { id: `wompi:${t.id}:${t.status}`, referencia: String(t.reference), estado: ESTADO_WOMPI[t.status], montoCentavos: Number(t.amount_in_cents), moneda: String(t.currency ?? 'COP'), transaccionId: String(t.id) };
}

/** Consulta servidor a servidor del estado real de una transacción (verificación del retorno). */
export async function consultarTransaccionWompi(cuenta: CuentaPasarela, transaccionId: string, fetcher: typeof fetch = fetch): Promise<EventoPago | null> {
  if (!/^[\w-]{3,80}$/.test(transaccionId)) return null;
  try {
    const res = await fetcher(`${apiWompi(cuenta.entorno)}/transactions/${encodeURIComponent(transaccionId)}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const t = (await res.json() as any)?.data;
    if (!t?.id || !ESTADO_WOMPI[t.status]) return null;
    return { id: `wompi:${t.id}:${t.status}`, referencia: String(t.reference), estado: ESTADO_WOMPI[t.status], montoCentavos: Number(t.amount_in_cents), moneda: String(t.currency ?? 'COP'), transaccionId: String(t.id) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- simulada
const TOLERANCIA_S = 300;

export function signWebhook(body: string, secret = config.pagos.webhookSecret, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${hmacHex(secret, `${t}.${body}`)}`;
}

export function verifyWebhook(body: string, header: string | undefined, secret = config.pagos.webhookSecret, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > TOLERANCIA_S) return false; // repetición fuera de ventana
  return safeEqual(parts.v1, hmacHex(secret, `${t}.${body}`));
}

/** Evento de la pasarela simulada → evento normalizado (montos en pesos en el cuerpo). */
export function normalizarEventoSimulado(ev: any): EventoPago | null {
  if (!ev?.id || !ev?.referencia || !['pago.aprobado', 'pago.rechazado'].includes(ev.tipo)) return null;
  return { id: String(ev.id), referencia: String(ev.referencia), estado: ev.tipo === 'pago.aprobado' ? 'APROBADO' : 'RECHAZADO', montoCentavos: Math.round(Number(ev.monto) * 100), moneda: String(ev.moneda ?? 'COP'), transaccionId: ev.transaccion ?? undefined };
}

// ---------------------------------------------------------------- checkout
export function checkoutUrl(cuenta: CuentaPasarela, i: CheckoutInput): string {
  const moneda = i.moneda ?? 'COP';
  if (cuenta.proveedor === 'wompi') {
    if (!cuenta.llavePublica || !cuenta.secretoIntegridad) throw new Error('Cuenta de Wompi incompleta');
    const expira = i.expiraEn?.toISOString();
    const q = new URLSearchParams({
      'public-key': cuenta.llavePublica, currency: moneda, 'amount-in-cents': String(i.montoCentavos), reference: i.referencia,
      'signature:integrity': firmaIntegridadWompi(i.referencia, i.montoCentavos, moneda, cuenta.secretoIntegridad, expira),
      'redirect-url': i.redirectUrl,
    });
    if (expira) q.set('expiration-time', expira);
    if (i.cliente?.email) q.set('customer-data:email', i.cliente.email);
    if (i.cliente?.nombre) q.set('customer-data:full-name', i.cliente.nombre.slice(0, 80));
    if (i.cliente?.telefono) q.set('customer-data:phone-number', i.cliente.telefono.replace(/^\+57/, '').replace(/\D/g, ''));
    return `https://checkout.wompi.co/p/?${q.toString()}`;
  }
  const q = new URLSearchParams({ ref: i.referencia, monto: String(i.montoCentavos / 100), concepto: i.concepto ?? 'Pago', volver: i.redirectUrl });
  return `${config.publicUrl}/pasarela/checkout?${q.toString()}`;
}
