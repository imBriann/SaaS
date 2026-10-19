import { config } from '../config.js';
import { token as aleatorio } from '../lib/util.js';

/**
 * Activación de WhatsApp sobre un número comprado, con la Graph API oficial de Meta y siempre
 * de servidor a servidor (developers.facebook.com › WhatsApp Business Platform):
 *
 *  1. El cliente completa el registro integrado (Embedded Signup v4, featureType=only_waba_sharing):
 *     inicia sesión en Meta, elige o crea su portafolio y su cuenta de WhatsApp (WABA) y acepta las
 *     condiciones. Ese paso es suyo y no se automatiza.
 *  2. GET  /oauth/access_token                → token de negocio a partir del código del registro
 *  3. POST /{waba}/subscribed_apps             → los webhooks de esa WABA llegan a Omnegia
 *  4. POST /{waba}/phone_numbers               → alta del número comprado con su nombre visible
 *  5. POST /{id}/request_code (VOICE)          → Meta llama al número y dicta el código
 *  6. POST /{id}/verify_code                   → verificación con el código capturado
 *  7. POST /{id}/register (PIN de dos pasos)   → número habilitado en Cloud API
 *  8. GET  /{id}?fields=…                      → estado real antes de mostrarlo como conectado
 */
export class ErrorMeta extends Error {
  constructor(message: string, public reintentable: boolean, public codigo?: number) { super(message); }
}

export interface DatosNumeroMeta {
  numero: string | null; nombre: string | null; estadoNombre: string | null; verificacion: string | null;
  calidad: string | null; estado: string | null; plataforma: string | null;
}

export interface MetaOnboarding {
  simulado: boolean;
  intercambiarCodigo(codigo: string): Promise<string>;
  wabaAccesible(waba: string, token: string): Promise<boolean>;
  suscribirApp(waba: string, token: string): Promise<void>;
  agregarNumero(waba: string, token: string, n: { cc: string; numero: string; nombre: string }): Promise<string>;
  buscarNumero(waba: string, token: string, e164: string): Promise<string | null>;
  solicitarCodigo(id: string, token: string): Promise<void>;
  verificarCodigo(id: string, token: string, codigo: string): Promise<boolean>;
  registrar(id: string, token: string, pin: string): Promise<void>;
  consultar(id: string, token: string): Promise<DatosNumeroMeta>;
  desregistrar(id: string, token: string): Promise<void>;
  /** Solo simulación: lo que «dictaría» la llamada de Meta (null = la llamada no llega). */
  llamadaSimulada?(): string | null;
}

/** Códigos de error de Graph que un reintento puede resolver (límites y fallos temporales). */
const REINTENTABLES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 133004]);
const LEGIBLES: Record<number, string> = {
  190: 'El acceso concedido en Meta venció o fue revocado: repite el registro con Meta.',
  200: 'Faltan permisos en Meta: repite el registro y acepta todos los permisos solicitados.',
  136024: 'Meta no pudo verificar el número: pide otra llamada de verificación.',
  136025: 'El código de verificación no es correcto o venció.',
  133005: 'El PIN de verificación en dos pasos no coincide.',
  133010: 'El número todavía no está registrado en WhatsApp.',
  133016: 'Se superó el límite de intentos de registro del número: espera unas horas y reintenta.',
};

export class MetaGraph implements MetaOnboarding {
  simulado = false;
  constructor(private fetcher: typeof fetch = (...a) => fetch(...a), private version = config.whatsapp.graphVersion) {}

  private async pedir(metodo: 'GET' | 'POST', ruta: string, token: string | null, cuerpo?: Record<string, unknown>): Promise<any> {
    let res: Response;
    try {
      res = await this.fetcher(`https://graph.facebook.com/${this.version}${ruta}`, {
        method: metodo,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ErrorMeta(`Sin respuesta de Meta (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : 'red'}).`, true);
    }
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && !data?.error) return data;
    const code = Number(data?.error?.code);
    const sub = Number(data?.error?.error_subcode);
    const reintentable = res.status >= 500 || res.status === 429 || REINTENTABLES.has(code);
    throw new ErrorMeta(LEGIBLES[sub] ?? LEGIBLES[code] ?? `Meta rechazó la solicitud (${code || res.status}).`, reintentable, code || res.status);
  }

  async intercambiarCodigo(codigo: string) {
    if (!config.meta.appId || !config.whatsapp.appSecret) throw new ErrorMeta('Falta configurar META_APP_ID y WHATSAPP_APP_SECRET.', false);
    const q = new URLSearchParams({ client_id: config.meta.appId, client_secret: config.whatsapp.appSecret, code: codigo });
    const d = await this.pedir('GET', `/oauth/access_token?${q.toString()}`, null);
    if (typeof d?.access_token !== 'string') throw new ErrorMeta('Meta no entregó el acceso del negocio.', false);
    return d.access_token as string;
  }
  async wabaAccesible(waba: string, token: string) {
    const d = await this.pedir('GET', `/${encodeURIComponent(waba)}?fields=id`, token).catch((e) => { if (e instanceof ErrorMeta && !e.reintentable) return null; throw e; });
    return d?.id === waba;
  }
  async suscribirApp(waba: string, token: string) { await this.pedir('POST', `/${encodeURIComponent(waba)}/subscribed_apps`, token); }
  async agregarNumero(waba: string, token: string, n: { cc: string; numero: string; nombre: string }) {
    const d = await this.pedir('POST', `/${encodeURIComponent(waba)}/phone_numbers`, token, { cc: n.cc, phone_number: n.numero, verified_name: n.nombre });
    if (!d?.id) throw new ErrorMeta('Meta no devolvió el identificador del número.', true);
    return String(d.id);
  }
  async buscarNumero(waba: string, token: string, e164: string) {
    const d = await this.pedir('GET', `/${encodeURIComponent(waba)}/phone_numbers?fields=id,display_phone_number`, token);
    const limpio = e164.replace(/\D/g, '');
    const x = (d?.data ?? []).find((p: any) => String(p?.display_phone_number ?? '').replace(/\D/g, '') === limpio);
    return x?.id ? String(x.id) : null;
  }
  async solicitarCodigo(id: string, token: string) { await this.pedir('POST', `/${encodeURIComponent(id)}/request_code?code_method=VOICE&language=es`, token); }
  async verificarCodigo(id: string, token: string, codigo: string) {
    try {
      const d = await this.pedir('POST', `/${encodeURIComponent(id)}/verify_code?code=${encodeURIComponent(codigo)}`, token);
      return d?.success === true;
    } catch (e) {
      if (e instanceof ErrorMeta && !e.reintentable && e.codigo !== 190 && e.codigo !== 200) return false;
      throw e;
    }
  }
  async registrar(id: string, token: string, pin: string) { await this.pedir('POST', `/${encodeURIComponent(id)}/register`, token, { messaging_product: 'whatsapp', pin }); }
  async consultar(id: string, token: string): Promise<DatosNumeroMeta> {
    const d = await this.pedir('GET', `/${encodeURIComponent(id)}?fields=display_phone_number,verified_name,name_status,code_verification_status,quality_rating,status,platform_type`, token);
    const s = (k: string) => (d?.[k] == null ? null : String(d[k]));
    return { numero: s('display_phone_number'), nombre: s('verified_name'), estadoNombre: s('name_status'), verificacion: s('code_verification_status'), calidad: s('quality_rating'), estado: s('status'), plataforma: s('platform_type') };
  }
  async desregistrar(id: string, token: string) { await this.pedir('POST', `/${encodeURIComponent(id)}/deregister`, token); }
}

/**
 * Meta simulada (desarrollo y demostración, sin app de Meta). No contacta a Meta: los
 * identificadores empiezan por «sim-», así el canal los trata como simulación y nunca como
 * un número real conectado. El código de la llamada simulada es 123456.
 */
export class MetaSimulada implements MetaOnboarding {
  simulado = true;
  llamadas: string[] = [];
  async intercambiarCodigo(codigo: string) { this.llamadas.push('token'); if (!codigo.startsWith('sim-')) throw new ErrorMeta('Código de registro no válido en la simulación.', false); return `sim-token-${aleatorio(6)}`; }
  async wabaAccesible(waba: string) { return /^sim-waba-/.test(waba); }
  async suscribirApp() { this.llamadas.push('suscribir'); }
  async agregarNumero() { this.llamadas.push('agregar'); return `sim-num-${aleatorio(6)}`; }
  async buscarNumero() { return null; }
  async solicitarCodigo() { this.llamadas.push('codigo'); }
  async verificarCodigo(_id: string, _t: string, codigo: string) { this.llamadas.push('verificar'); return codigo === '123456'; }
  async registrar() { this.llamadas.push('registrar'); }
  async consultar(): Promise<DatosNumeroMeta> { return { numero: 'Simulación', nombre: 'Número de demostración', estadoNombre: 'APPROVED', verificacion: 'VERIFIED', calidad: 'GREEN', estado: 'CONNECTED', plataforma: 'CLOUD_API' }; }
  async desregistrar() { this.llamadas.push('desregistrar'); }
  llamadaSimulada(): string | null { return 'Su código de WhatsApp es 1 2 3 4 5 6. Repito, 1 2 3 4 5 6.'; }
}

let reemplazo: MetaOnboarding | null = null;
let real: MetaOnboarding | null = null;
let simulada: MetaSimulada | null = null;
/** Cliente de Meta: el real con app configurada; la simulación solo con simuladores y sin app. */
export function metaOnboarding(): MetaOnboarding | null {
  if (reemplazo) return reemplazo;
  if (config.meta.appId && config.meta.configId) return (real ??= new MetaGraph());
  if (config.simuladores) return (simulada ??= new MetaSimulada());
  return null;
}
export const setMetaOnboarding = (m: MetaOnboarding | null) => { reemplazo = m; };

const PALABRAS: Record<string, string> = { cero: '0', uno: '1', una: '1', dos: '2', tres: '3', cuatro: '4', cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9' };

/**
 * Código de 6 dígitos dictado en la llamada de Meta, a partir de la transcripción. Admite cifras
 * («123 456», «1-2-3») y palabras («uno dos tres»). Meta repite el código: se toma la primera
 * secuencia de seis dígitos seguidos. Sin una secuencia clara no se adivina.
 */
export function codigoDeTranscripcion(texto: string): string | null {
  const normal = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const fichas = normal.split(/[^a-z0-9]+/).filter(Boolean);
  let racha = '';
  for (const f of fichas) {
    const d = /^\d+$/.test(f) ? f : PALABRAS[f];
    if (d === undefined) { if (racha.length >= 6) break; racha = ''; continue; }
    racha += d;
    if (racha.length >= 6) break;
  }
  return racha.length >= 6 ? racha.slice(0, 6) : null;
}
