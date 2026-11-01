import { apiWompi, firmaIntegridadWompi, type CuentaPasarela } from './payments.js';

/**
 * Cobro con formulario propio (sin enviar a la persona al checkout de Wompi). Se apoya solo en lo que
 * documenta Wompi (docs.wompi.co): tokens de aceptación (GET /merchants/info), bancos PSE, POST /transactions
 * con CARD, NEQUI, PSE, BANCOLOMBIA_TRANSFER o BANCOLOMBIA_QR, y consulta de la transacción hasta un estado final.
 *
 * Los datos de la tarjeta nunca pasan por este servidor: el navegador los cifra y los entrega a Wompi, y aquí
 * solo llega el token de un solo uso. El monto y la referencia salen siempre de la base, nunca del navegador.
 */
export const METODOS_DIRECTOS = ['CARD', 'NEQUI', 'PSE', 'BANCOLOMBIA_TRANSFER', 'BANCOLOMBIA_QR'] as const;
export type MetodoDirecto = (typeof METODOS_DIRECTOS)[number];

const TIEMPO = 15_000;
const cabeceraPublica = (c: CuentaPasarela) => ({ authorization: `Bearer ${c.llavePublica}`, accept: 'application/json', 'content-type': 'application/json' });

export interface Aceptacion { token: string; permalink: string }
export interface AceptacionWompi { terminos: Aceptacion; datos: Aceptacion }

/** Solo se muestran enlaces https: el permalink llega de un tercero y termina en un `href`. */
const enlaceSeguro = (u: unknown) => (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);

/** Tokens de aceptación vigentes de Wompi (política de uso y autorización de datos). Se piden en cada transacción. */
export async function aceptacionWompi(cuenta: CuentaPasarela, fetcher: typeof fetch = fetch): Promise<AceptacionWompi | null> {
  if (!cuenta.llavePublica) return null;
  try {
    const res = await fetcher(`${apiWompi(cuenta.entorno)}/merchants/info`, { headers: { 'x-merchant-public-key': cuenta.llavePublica, accept: 'application/json' }, signal: AbortSignal.timeout(TIEMPO) });
    if (!res.ok) return null;
    const d = (await res.json() as any)?.data;
    const a = d?.presigned_acceptance, p = d?.presigned_personal_data_auth;
    const ta = typeof a?.acceptance_token === 'string' ? a.acceptance_token : null, tp = typeof p?.acceptance_token === 'string' ? p.acceptance_token : null;
    const la = enlaceSeguro(a?.permalink), lp = enlaceSeguro(p?.permalink);
    return ta && tp && la && lp ? { terminos: { token: ta, permalink: la }, datos: { token: tp, permalink: lp } } : null;
  } catch { return null; }
}

let cacheBancos: { clave: string; en: number; lista: { codigo: string; nombre: string }[] } | null = null;
/** Bancos de PSE. Wompi antepone una opción de relleno con código «0», que no es un banco. */
export async function bancosPse(cuenta: CuentaPasarela, fetcher: typeof fetch = fetch): Promise<{ codigo: string; nombre: string }[]> {
  if (!cuenta.llavePublica) return [];
  const clave = `${cuenta.entorno}:${cuenta.llavePublica}`;
  if (cacheBancos?.clave === clave && Date.now() - cacheBancos.en < 60 * 60_000) return cacheBancos.lista;
  try {
    const res = await fetcher(`${apiWompi(cuenta.entorno)}/pse/financial_institutions`, { headers: cabeceraPublica(cuenta), signal: AbortSignal.timeout(TIEMPO) });
    if (!res.ok) return [];
    const data = (await res.json() as any)?.data;
    const lista = (Array.isArray(data) ? data : [])
      .map((b: any) => ({ codigo: String(b?.financial_institution_code ?? b?.code ?? ''), nombre: String(b?.financial_institution_name ?? b?.name ?? '').trim().slice(0, 80) }))
      .filter((b) => /^\d{1,6}$/.test(b.codigo) && b.codigo !== '0' && b.nombre);
    cacheBancos = { clave, en: Date.now(), lista };
    return lista;
  } catch { return []; }
}
export const olvidarBancos = () => { cacheBancos = null; };

export interface ClienteDirecto { email: string; nombre: string; telefono: string }
export type DatosMetodo =
  | { metodo: 'CARD'; token: string; cuotas: number; navegador: Record<'browser_color_depth' | 'browser_screen_height' | 'browser_screen_width' | 'browser_language' | 'browser_user_agent' | 'browser_tz', string> }
  | { metodo: 'NEQUI'; celular: string }
  | { metodo: 'PSE'; tipoPersona: 0 | 1; tipoDocumento: 'CC' | 'NIT'; documento: string; banco: string; ip?: string }
  | { metodo: 'BANCOLOMBIA_TRANSFER' }
  | { metodo: 'BANCOLOMBIA_QR' };

export interface TransaccionNueva {
  referencia: string; montoCentavos: number; descripcion: string; redirectUrl: string; cliente: ClienteDirecto; datos: DatosMetodo; aceptacion: AceptacionWompi;
}

/** Escenarios de 3DS v2 del sandbox de Wompi. */
const ESCENARIOS_3DS = ['no_challenge_success', 'challenge_denied', 'challenge_v2', 'supported_version_error', 'authentication_error'];

/** Cuerpo de POST /transactions según el método. La firma de integridad usa referencia + monto + moneda + secreto. */
export function cuerpoTransaccion(cuenta: CuentaPasarela, t: TransaccionNueva): Record<string, unknown> {
  if (!cuenta.secretoIntegridad) throw new Error('Cuenta de Wompi incompleta');
  const descripcion = t.descripcion.replace(/'/g, '').slice(0, 30);
  const base: Record<string, unknown> = {
    acceptance_token: t.aceptacion.terminos.token, accept_personal_auth: t.aceptacion.datos.token,
    amount_in_cents: t.montoCentavos, currency: 'COP', customer_email: t.cliente.email, reference: t.referencia,
    signature: firmaIntegridadWompi(t.referencia, t.montoCentavos, 'COP', cuenta.secretoIntegridad),
    redirect_url: t.redirectUrl,
    customer_data: { full_name: t.cliente.nombre.slice(0, 80), phone_number: t.cliente.telefono },
  };
  const d = t.datos;
  switch (d.metodo) {
    case 'CARD': {
      const tarjeta = { ...base, payment_method: { type: 'CARD', token: d.token, installments: d.cuotas } };
      // Sin is_three_ds + browser_info Wompi procesa sin autenticación; se pide salvo que la cuenta no tenga 3DS (WOMPI_3DS=off).
      if (cuenta.tresDS === false) return tarjeta;
      // El sandbox exige three_ds_auth_type (el escenario de prueba); en producción no se envía.
      const prueba = cuenta.entorno === 'sandbox' ? { three_ds_auth_type: ESCENARIOS_3DS.includes(cuenta.tresDSPrueba ?? '') ? cuenta.tresDSPrueba : 'no_challenge_success' } : {};
      return { ...tarjeta, is_three_ds: true, ...prueba, customer_data: { ...(base.customer_data as object), browser_info: d.navegador } };
    }
    case 'NEQUI':
      return { ...base, payment_method: { type: 'NEQUI', phone_number: d.celular } };
    case 'PSE':
      return { ...base, payment_method: { type: 'PSE', user_type: d.tipoPersona, user_legal_id_type: d.tipoDocumento, user_legal_id: d.documento, financial_institution_code: d.banco, payment_description: descripcion, ...(d.ip ? { reference_one: d.ip } : {}) } };
    case 'BANCOLOMBIA_TRANSFER':
      return { ...base, payment_method: { type: 'BANCOLOMBIA_TRANSFER', user_type: 'PERSON', payment_description: descripcion, ecommerce_url: t.redirectUrl } };
    case 'BANCOLOMBIA_QR':
      return { ...base, payment_method: { type: 'BANCOLOMBIA_QR', payment_description: descripcion } };
  }
}

export type AccionPago =
  | { tipo: 'esperar'; mensaje: string }
  | { tipo: 'nequi'; mensaje: string }
  | { tipo: 'redirigir'; url: string }
  | { tipo: 'qr'; imagen: string }
  | { tipo: 'desafio_3ds'; html: string }
  | { tipo: 'final' };

export interface TransaccionWompi { id: string; referencia: string; estado: 'PENDING' | 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR'; metodo: string; mensaje: string | null; accion: AccionPago }

const ENTIDADES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
/** El desafío 3D Secure llega con el HTML escapado; se decodifica una sola pasada (el `&amp;` va al final). */
export const decodificarHtml = (s: string) => s.replace(/&lt;|&gt;|&quot;|&#39;|&amp;/g, (e) => ENTIDADES[e]);

/** Qué debe hacer la persona ahora, según el estado y los datos de la transacción. */
export function accionDe(t: any): AccionPago {
  const estado = String(t?.status ?? '');
  if (estado !== 'PENDING') return { tipo: 'final' };
  const tipo = String(t?.payment_method?.type ?? t?.payment_method_type ?? '');
  const extra = t?.payment_method?.extra ?? {};
  if (tipo === 'NEQUI') return { tipo: 'nequi', mensaje: 'Abre la app de Nequi y aprueba la notificación de pago.' };
  if (tipo === 'PSE' || tipo === 'BANCOLOMBIA_TRANSFER') {
    const url = enlaceSeguro(extra.async_payment_url);
    return url ? { tipo: 'redirigir', url } : { tipo: 'esperar', mensaje: 'Preparando el enlace de tu banco…' };
  }
  if (tipo === 'BANCOLOMBIA_QR') {
    const img = typeof extra.qr_image === 'string' ? extra.qr_image : '';
    if (/^[A-Za-z0-9+/=\s]+$/.test(img) && img.length > 40) return { tipo: 'qr', imagen: `data:image/png;base64,${img.replace(/\s/g, '')}` };
    return { tipo: 'esperar', mensaje: 'Generando tu código QR…' };
  }
  if (tipo === 'CARD') {
    const a = extra.three_ds_auth;
    if (a?.current_step === 'CHALLENGE' && a?.current_step_status === 'PENDING' && typeof a?.three_ds_method_data === 'string') return { tipo: 'desafio_3ds', html: decodificarHtml(a.three_ds_method_data) };
    return { tipo: 'esperar', mensaje: 'Verificando tu tarjeta con tu banco…' };
  }
  return { tipo: 'esperar', mensaje: 'Procesando tu pago…' };
}

export function normalizarTransaccion(t: any): TransaccionWompi | null {
  if (!t || typeof t !== 'object' || !t.id || typeof t.reference !== 'string') return null;
  const estado = ['PENDING', 'APPROVED', 'DECLINED', 'VOIDED', 'ERROR'].includes(t.status) ? t.status : null;
  if (!estado) return null;
  return { id: String(t.id), referencia: t.reference, estado, metodo: String(t.payment_method_type ?? t.payment_method?.type ?? ''), mensaje: typeof t.status_message === 'string' ? t.status_message.slice(0, 200) : null, accion: accionDe(t) };
}

export type ResultadoCreacion = { ok: true; transaccion: TransaccionWompi } | { ok: false; mensaje: string; reintentable: boolean };

/** Crea la transacción. Los mensajes de error de Wompi no se muestran crudos: pueden incluir datos de la solicitud. */
export async function crearTransaccionWompi(cuenta: CuentaPasarela, t: TransaccionNueva, fetcher: typeof fetch = fetch, opts: { llavePrivada?: boolean } = {}): Promise<ResultadoCreacion> {
  if (!cuenta.llavePublica) return { ok: false, mensaje: 'El pago en línea no está configurado.', reintentable: false };
  // Por defecto (cobros existentes) se autoriza con la llave pública, como hasta ahora. Los pedidos por WhatsApp usan la
  // llave privada, como indica hoy la página de transacciones de Wompi (docs/pagos-whatsapp.md § 2).
  if (opts.llavePrivada && !cuenta.llavePrivada) return { ok: false, mensaje: 'El pago en línea no está configurado.', reintentable: false };
  const cabeceras = opts.llavePrivada ? { ...cabeceraPublica(cuenta), authorization: `Bearer ${cuenta.llavePrivada}` } : cabeceraPublica(cuenta);
  let res: Response;
  try {
    res = await fetcher(`${apiWompi(cuenta.entorno)}/transactions`, { method: 'POST', headers: cabeceras, body: JSON.stringify(cuerpoTransaccion(cuenta, t)), signal: AbortSignal.timeout(TIEMPO) });
  } catch {
    return { ok: false, mensaje: 'No pudimos comunicarnos con Wompi. Intenta de nuevo en unos segundos.', reintentable: true };
  }
  const cuerpo: any = await res.json().catch(() => ({}));
  const tx = res.ok ? normalizarTransaccion(cuerpo?.data) : null;
  if (tx) return { ok: true, transaccion: tx };
  if (res.status === 422) return { ok: false, mensaje: 'Wompi no aceptó los datos del pago. Revísalos e intenta de nuevo.', reintentable: false };
  return { ok: false, mensaje: 'Wompi no pudo iniciar el pago. Intenta de nuevo o paga en el sitio seguro de Wompi.', reintentable: res.status >= 500 || res.status === 429 };
}

/** Lectura servidor a servidor de la transacción (con la llave privada si existe). */
export async function leerTransaccionWompi(cuenta: CuentaPasarela, id: string, fetcher: typeof fetch = fetch): Promise<TransaccionWompi | null> {
  if (!/^[\w-]{3,80}$/.test(id)) return null;
  try {
    const res = await fetcher(`${apiWompi(cuenta.entorno)}/transactions/${encodeURIComponent(id)}`, {
      headers: cuenta.llavePrivada ? { authorization: `Bearer ${cuenta.llavePrivada}`, accept: 'application/json' } : { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const tx = normalizarTransaccion((await res.json() as any)?.data);
    return tx && tx.id === id ? tx : null;
  } catch { return null; }
}
