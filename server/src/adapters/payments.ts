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
 *    Las consultas servidor a servidor usan la llave privada (Authorization: Bearer).
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
  llavePrivada?: string;
  secretoIntegridad?: string;
  secretoEventos?: string;
}

export interface EventoPago {
  /** Identificador único del evento: base de la idempotencia. */
  id: string;
  /** Pasarela que originó el evento: debe coincidir con la del pago registrado. */
  proveedor: Proveedor;
  referencia: string;
  estado: EstadoPago;
  montoCentavos: number;
  moneda: string;
  transaccionId?: string;
  /** Cómo pagó (CARD, PSE, NEQUI, BANCOLOMBIA_TRANSFER…) y un detalle legible para el recibo; nunca el número completo. */
  metodo?: string;
  metodoDetalle?: string;
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
    return { proveedor: 'wompi', entorno: w.entorno, llavePublica: w.llavePublica, llavePrivada: w.llavePrivada, secretoIntegridad: w.secretoIntegridad, secretoEventos: w.secretoEventos };
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
/** Valor de «environment» que Wompi pone en cada evento. */
const AMBIENTE_EVENTO: Record<CuentaPasarela['entorno'], string> = { produccion: 'prod', sandbox: 'test' };

function valorEnRuta(obj: any, ruta: string): unknown {
  return ruta.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Transacción de Wompi → evento normalizado. Descarta datos incompletos o con tipos inesperados. */
function normalizarTransaccionWompi(t: any): EventoPago | null {
  if (!t || typeof t !== 'object') return null;
  const monto = Number(t.amount_in_cents);
  if (!t.id || typeof t.reference !== 'string' || !t.reference || !ESTADO_WOMPI[t.status] || !Number.isSafeInteger(monto) || monto < 0) return null;
  const tipo = typeof t.payment_method_type === 'string' && /^[A-Z_]{2,40}$/.test(t.payment_method_type) ? t.payment_method_type : undefined;
  const extra = t.payment_method?.extra ?? {};
  const ultimos = typeof extra.last_four === 'string' && /^\d{4}$/.test(extra.last_four) ? extra.last_four : null;
  const marca = typeof extra.brand === 'string' && /^[A-Za-z ]{2,20}$/.test(extra.brand) ? extra.brand : null;
  const detalle = ultimos ? `${marca ? `${marca} ` : ''}•••• ${ultimos}` : undefined;
  return { id: `wompi:${t.id}:${t.status}`, proveedor: 'wompi', referencia: t.reference, estado: ESTADO_WOMPI[t.status], montoCentavos: monto, moneda: String(t.currency ?? ''), transaccionId: String(t.id), metodo: tipo, metodoDetalle: detalle };
}

/** Verifica el checksum de un evento de Wompi y lo normaliza. */
export function verificarEventoWompi(cuenta: CuentaPasarela, cuerpo: any, checksumCabecera?: string): EventoPago | null {
  if (!cuenta.secretoEventos || cuerpo?.event !== 'transaction.updated') return null;
  const props: unknown = cuerpo?.signature?.properties;
  const checksum = String(cuerpo?.signature?.checksum ?? checksumCabecera ?? '');
  if (!Array.isArray(props) || !props.length || !checksum || cuerpo?.timestamp === undefined) return null;
  const concatenado = props.map((p) => String(valorEnRuta(cuerpo.data, String(p)) ?? '')).join('') + String(cuerpo.timestamp) + cuenta.secretoEventos;
  if (!safeEqual(sha256(concatenado).toLowerCase(), checksum.toLowerCase())) return null;
  // Un evento de otro ambiente (p. ej. de pruebas contra la cuenta de producción) no cuenta.
  if (cuerpo.environment !== undefined && cuerpo.environment !== AMBIENTE_EVENTO[cuenta.entorno]) return null;
  return normalizarTransaccionWompi(cuerpo.data?.transaction);
}

const cabecerasConsulta = (cuenta: CuentaPasarela): Record<string, string> =>
  cuenta.llavePrivada ? { authorization: `Bearer ${cuenta.llavePrivada}`, accept: 'application/json' } : { accept: 'application/json' };

/** Consulta servidor a servidor del estado real de una transacción (verificación del retorno). */
export async function consultarTransaccionWompi(cuenta: CuentaPasarela, transaccionId: string, fetcher: typeof fetch = fetch): Promise<EventoPago | null> {
  if (!/^[\w-]{3,80}$/.test(transaccionId)) return null;
  try {
    const res = await fetcher(`${apiWompi(cuenta.entorno)}/transactions/${encodeURIComponent(transaccionId)}`, { headers: cabecerasConsulta(cuenta), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const ev = normalizarTransaccionWompi((await res.json() as any)?.data);
    // La respuesta debe corresponder a la transacción pedida.
    return ev && ev.transaccionId === transaccionId ? ev : null;
  } catch {
    // Sin detalles: el error de red podría incluir la URL o cabeceras.
    return null;
  }
}

/**
 * Transacciones asociadas a una referencia (recuperación cuando el evento se retrasa
 * o se perdió). Exige la llave privada. `null` = no se pudo consultar; `[]` = no hay.
 */
export async function consultarPorReferenciaWompi(cuenta: CuentaPasarela, referencia: string, fetcher: typeof fetch = fetch): Promise<EventoPago[] | null> {
  if (!cuenta.llavePrivada || !/^[\w-]{3,80}$/.test(referencia)) return null;
  try {
    const res = await fetcher(`${apiWompi(cuenta.entorno)}/transactions?reference=${encodeURIComponent(referencia)}`, { headers: cabecerasConsulta(cuenta), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = (await res.json() as any)?.data;
    const lista: unknown[] = Array.isArray(data) ? data : data ? [data] : [];
    return lista.map(normalizarTransaccionWompi).filter((e): e is EventoPago => !!e && e.referencia === referencia);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- medios de pago del comercio
/**
 * Medios de pago documentados por Wompi (docs.wompi.co › Métodos de pago). CARD cubre tarjetas
 * de crédito y débito. Bre-B no figura como medio de pago en la documentación (solo
 * «Dispersiones con BRE-B, próximamente»): se anuncia únicamente si la cuenta lo confirma.
 */
const MEDIOS_WOMPI: Record<string, { nombre: string; minimo?: number }> = {
  CARD: { nombre: 'Tarjeta de crédito o débito' },
  PSE: { nombre: 'PSE' },
  NEQUI: { nombre: 'Nequi' },
  BANCOLOMBIA_TRANSFER: { nombre: 'Botón de transferencia Bancolombia' },
  BANCOLOMBIA_QR: { nombre: 'QR Bancolombia' },
  DAVIPLATA: { nombre: 'Daviplata' },
  BANCOLOMBIA_COLLECT: { nombre: 'Efectivo en corresponsales Bancolombia' },
  PCOL: { nombre: 'Puntos Colombia' },
  SU_PLUS: { nombre: 'SU+ Pay', minimo: 35_000 },
  BANCOLOMBIA_BNPL: { nombre: 'Compra ahora, paga después (Bancolombia)', minimo: 100_000 },
};

export interface MediosPago {
  /** 'wompi' = lista confirmada por la cuenta; 'no_confirmado' = Wompi no la informó. */
  fuente: 'wompi' | 'no_confirmado';
  medios: { codigo: string; nombre: string }[];
  bre_b: boolean;
}

let cacheMedios: { clave: string; en: number; valor: MediosPago } | null = null;

/**
 * Medios habilitados para la cuenta, según Wompi (GET /merchants/info con la llave pública).
 * Si la respuesta no trae la lista, no se promete ninguno: el checkout de Wompi muestra los suyos.
 * Se excluyen los medios cuyo mínimo documentado supera el monto que se va a cobrar.
 */
export async function mediosPagoWompi(cuenta: CuentaPasarela, montoCop: number, fetcher: typeof fetch = fetch): Promise<MediosPago> {
  const sinConfirmar: MediosPago = { fuente: 'no_confirmado', medios: [], bre_b: false };
  if (cuenta.proveedor !== 'wompi' || !cuenta.llavePublica) return sinConfirmar;
  const clave = `${cuenta.entorno}:${cuenta.llavePublica}:${montoCop}`;
  if (cacheMedios?.clave === clave && Date.now() - cacheMedios.en < 10 * 60_000) return cacheMedios.valor;
  let valor = sinConfirmar;
  try {
    const res = await fetcher(`${apiWompi(cuenta.entorno)}/merchants/info`, { headers: { 'x-merchant-public-key': cuenta.llavePublica, accept: 'application/json' }, signal: AbortSignal.timeout(6_000) });
    const lista: unknown = res.ok ? (await res.json() as any)?.data?.accepted_payment_methods : undefined;
    if (Array.isArray(lista)) {
      const codigos = lista.filter((x): x is string => typeof x === 'string');
      const breB = codigos.some((x) => /^BRE[_-]?B$/i.test(x));
      valor = {
        fuente: 'wompi', bre_b: breB,
        medios: [
          ...codigos.filter((x) => MEDIOS_WOMPI[x] && (MEDIOS_WOMPI[x].minimo ?? 0) <= montoCop).map((x) => ({ codigo: x, nombre: MEDIOS_WOMPI[x].nombre })),
          ...(breB ? [{ codigo: 'BRE_B', nombre: 'Bre-B' }] : []),
        ],
      };
    }
  } catch { /* sin confirmación: no se anuncia ningún medio */ }
  cacheMedios = { clave, en: Date.now(), valor };
  return valor;
}
export const olvidarMediosPago = () => { cacheMedios = null; };

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
  return { id: String(ev.id), proveedor: 'simulada', referencia: String(ev.referencia), estado: ev.tipo === 'pago.aprobado' ? 'APROBADO' : 'RECHAZADO', montoCentavos: Math.round(Number(ev.monto) * 100), moneda: String(ev.moneda ?? 'COP'), transaccionId: ev.transaccion ?? undefined, metodo: 'SIMULADA', metodoDetalle: 'Tarjeta de prueba •••• 4242' };
}

// ---------------------------------------------------------------- checkout
export function checkoutUrl(cuenta: CuentaPasarela, i: CheckoutInput): string {
  const moneda = i.moneda ?? 'COP';
  if (!Number.isSafeInteger(i.montoCentavos) || i.montoCentavos <= 0) throw new Error('Monto del checkout inválido');
  if (cuenta.proveedor === 'wompi') {
    if (!cuenta.llavePublica || !cuenta.secretoIntegridad) throw new Error('Cuenta de Wompi incompleta');
    if (cuenta.entorno === 'produccion' && !i.redirectUrl.startsWith('https://')) throw new Error('El retorno del checkout de Wompi en producción exige https');
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
