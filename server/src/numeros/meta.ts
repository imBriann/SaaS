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
  /**
   * `crudo` es el texto de Meta: solo sirve para clasificar el error (motivoRegistro). Nunca se
   * muestra, ni se guarda en la bitácora o en la auditoría.
   */
  constructor(message: string, public reintentable: boolean, public codigo?: number, public subcodigo?: number, public crudo?: string) { super(message); }
}

export interface DatosNumeroMeta {
  numero: string | null; nombre: string | null; estadoNombre: string | null; verificacion: string | null;
  calidad: string | null; estado: string | null; plataforma: string | null;
}

/** Número de la WABA tal como lo informa Meta (GET /{waba}/phone_numbers). */
export interface NumeroWaba extends DatosNumeroMeta { id: string }

export interface MetaOnboarding {
  simulado: boolean;
  intercambiarCodigo(codigo: string): Promise<string>;
  wabaAccesible(waba: string, token: string): Promise<boolean>;
  suscribirApp(waba: string, token: string): Promise<void>;
  agregarNumero(waba: string, token: string, n: { cc: string; numero: string; nombre: string }): Promise<string>;
  buscarNumero(waba: string, token: string, e164: string): Promise<string | null>;
  /** Por defecto VOICE (números comprados: la llamada la atiende la aplicación TeXML). */
  solicitarCodigo(id: string, token: string, metodo?: 'SMS' | 'VOICE'): Promise<void>;
  verificarCodigo(id: string, token: string, codigo: string): Promise<boolean>;
  registrar(id: string, token: string, pin: string): Promise<void>;
  consultar(id: string, token: string): Promise<DatosNumeroMeta>;
  desregistrar(id: string, token: string): Promise<void>;
  /** Números de la WABA con su estado real (panel del operador). */
  listarNumeros(waba: string, token: string): Promise<NumeroWaba[]>;
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
    const crudo = [data?.error?.error_user_title, data?.error?.error_user_msg, data?.error?.message].filter((x) => typeof x === 'string').join(' · ').slice(0, 500);
    throw new ErrorMeta(LEGIBLES[sub] ?? LEGIBLES[code] ?? `Meta rechazó la solicitud (${code || res.status}).`, reintentable, code || res.status, Number.isFinite(sub) ? sub : undefined, crudo || undefined);
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
  // `language`: la referencia lo describe como código de dos letras («en»), aunque su ejemplo usa en_US.
  // TODO(meta): confirmar con un número real que «es» entrega el SMS y la llamada en español.
  async solicitarCodigo(id: string, token: string, metodo: 'SMS' | 'VOICE' = 'VOICE') { await this.pedir('POST', `/${encodeURIComponent(id)}/request_code?code_method=${metodo}&language=es`, token); }
  async verificarCodigo(id: string, token: string, codigo: string) {
    try {
      const d = await this.pedir('POST', `/${encodeURIComponent(id)}/verify_code?code=${encodeURIComponent(codigo)}`, token);
      return d?.success === true;
    } catch (e) {
      // Código equivocado = false. Vencido, demasiados intentos o acceso: se informan tal cual.
      if (e instanceof ErrorMeta && !e.reintentable && !['ACCESO', 'CODIGO_VENCIDO', 'DEMASIADOS_INTENTOS'].includes(motivoRegistro(e))) return false;
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
  async listarNumeros(waba: string, token: string): Promise<NumeroWaba[]> {
    const campos = 'id,display_phone_number,verified_name,status,code_verification_status,name_status,quality_rating,platform_type';
    const d = await this.pedir('GET', `/${encodeURIComponent(waba)}/phone_numbers?fields=${campos}&limit=100`, token);
    const s = (x: any, k: string) => (x?.[k] == null ? null : String(x[k]));
    return (Array.isArray(d?.data) ? d.data : []).filter((x: any) => x?.id).map((x: any) => ({
      id: String(x.id), numero: s(x, 'display_phone_number'), nombre: s(x, 'verified_name'), estadoNombre: s(x, 'name_status'),
      verificacion: s(x, 'code_verification_status'), calidad: s(x, 'quality_rating'), estado: s(x, 'status'), plataforma: s(x, 'platform_type'),
    }));
  }
}

/**
 * Meta simulada (desarrollo y demostración, sin app de Meta). No contacta a Meta: los
 * identificadores empiezan por «sim-», así el canal los trata como simulación y nunca como
 * un número real conectado. El código de la llamada simulada es 123456.
 */
export class MetaSimulada implements MetaOnboarding {
  simulado = true;
  llamadas: string[] = [];
  /** Método de cada código pedido (SMS o VOICE), para comprobar el cambio a llamada. */
  metodos: string[] = [];
  /**
   * Fallos forzados del registro de un número propio (pruebas). En el panel de desarrollo también se
   * fuerzan con los cuatro últimos dígitos del número: 0001 ya en WhatsApp, 0002 límite de la cuenta,
   * 0003 nombre rechazado, 0004 número inválido.
   */
  forzar = new Set<'numero_en_uso' | 'limite_waba' | 'nombre_rechazado' | 'numero_invalido' | 'codigo_vencido' | 'demasiados_intentos'>();
  estadoNombre = 'APPROVED';
  /**
   * Números de la WABA simulada. Cada alta entra PENDING y sin verificar; verificar el código la marca VERIFIED y
   * registrar la deja CONNECTED en CLOUD_API (como en Meta). `sembrar` deja un número en el estado que haga falta.
   */
  numerosWaba = new Map<string, NumeroWaba>();
  sembrar(n: Partial<NumeroWaba> & { numero: string }): NumeroWaba {
    const x: NumeroWaba = { id: n.id ?? `sim-num-${aleatorio(6)}`, nombre: 'Número de demostración', estadoNombre: 'APPROVED', verificacion: 'VERIFIED', calidad: 'GREEN', estado: 'CONNECTED', plataforma: 'CLOUD_API', ...n };
    this.numerosWaba.set(x.id, x);
    return x;
  }
  async intercambiarCodigo(codigo: string) { this.llamadas.push('token'); if (!codigo.startsWith('sim-')) throw new ErrorMeta('Código de registro no válido en la simulación.', false); return `sim-token-${aleatorio(6)}`; }
  async wabaAccesible(waba: string) { return /^sim-waba-/.test(waba); }
  async suscribirApp() { this.llamadas.push('suscribir'); }
  async agregarNumero(_waba: string, _token: string, n: { cc: string; numero: string; nombre: string }) {
    this.llamadas.push('agregar');
    const fin = n.numero.slice(-4);
    // Los textos imitan la forma de un error de Graph; Meta no documenta un código para cada caso.
    if (this.forzar.has('numero_en_uso') || fin === '0001') throw new ErrorMeta('Meta rechazó la solicitud (100).', false, 100, undefined, 'This phone number is already registered to a WhatsApp account.');
    if (this.forzar.has('limite_waba') || fin === '0002') throw new ErrorMeta('Meta rechazó la solicitud (100).', false, 100, undefined, 'The WhatsApp Business Account has reached the maximum number of phone numbers allowed.');
    if (this.forzar.has('nombre_rechazado') || fin === '0003') throw new ErrorMeta('Meta rechazó la solicitud (100).', false, 100, undefined, 'The display name (verified_name) does not comply with WhatsApp policies.');
    if (this.forzar.has('numero_invalido') || fin === '0004') throw new ErrorMeta('Meta rechazó la solicitud (100).', false, 100, undefined, 'Invalid phone number.');
    return this.sembrar({ numero: `+${n.cc} ${n.numero}`, nombre: n.nombre, estado: 'PENDING', verificacion: 'NOT_VERIFIED', plataforma: 'NOT_APPLICABLE', estadoNombre: this.estadoNombre, calidad: 'UNKNOWN' }).id;
  }
  async buscarNumero() { return null; }
  async solicitarCodigo(_id: string, _t: string, metodo: 'SMS' | 'VOICE' = 'VOICE') {
    this.llamadas.push('codigo'); this.metodos.push(metodo);
    if (this.forzar.has('demasiados_intentos')) throw new ErrorMeta('Meta rechazó la solicitud (133016).', false, 133016, undefined, 'Too many attempts for this phone number.');
  }
  async verificarCodigo(_id: string, _t: string, codigo: string) {
    this.llamadas.push('verificar');
    if (this.forzar.has('codigo_vencido')) throw new ErrorMeta('Meta rechazó la solicitud (100).', false, 100, undefined, 'The verification code has expired.');
    const ok = codigo === '123456';
    const x = this.numerosWaba.get(_id);
    if (ok && x) x.verificacion = 'VERIFIED';
    return ok;
  }
  async registrar(id: string) {
    this.llamadas.push('registrar');
    const x = this.numerosWaba.get(id);
    if (x) Object.assign(x, { estado: 'CONNECTED', plataforma: 'CLOUD_API', verificacion: 'VERIFIED' });
  }
  async consultar(id?: string): Promise<DatosNumeroMeta> {
    const x = id ? this.numerosWaba.get(id) : undefined;
    // Un número que no está en la WABA simulada (demostraciones antiguas) se informa conectado.
    if (!x) return { numero: 'Simulación', nombre: 'Número de demostración', estadoNombre: this.estadoNombre, verificacion: 'VERIFIED', calidad: 'GREEN', estado: 'CONNECTED', plataforma: 'CLOUD_API' };
    const { id: _i, ...datos } = x;
    return { ...datos, estadoNombre: this.estadoNombre ?? datos.estadoNombre };
  }
  async desregistrar(id: string) {
    this.llamadas.push('desregistrar');
    const x = this.numerosWaba.get(id);
    if (x) Object.assign(x, { estado: 'DISCONNECTED', plataforma: 'NOT_APPLICABLE' });
  }
  async listarNumeros(): Promise<NumeroWaba[]> { this.llamadas.push('listar'); return [...this.numerosWaba.values()].map((x) => ({ ...x })); }
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

/**
 * Cliente para «Usar mi propio número»: el número de la empresa se registra en la WABA de Omnegia con el
 * token del usuario del sistema de la plataforma. No necesita registro integrado ni token por empresa.
 * null = pendiente de configurar (producción sin WHATSAPP_ACCESS_TOKEN o sin WHATSAPP_PLATFORM_WABA_ID).
 */
export interface MetaDePlataforma { meta: MetaOnboarding; waba: string; token: string }
export function metaPlataforma(): MetaDePlataforma | null {
  const { accessToken, plataformaWabaId } = config.whatsapp;
  const m = reemplazo ?? (accessToken && plataformaWabaId ? (real ??= new MetaGraph()) : config.simuladores ? (simulada ??= new MetaSimulada()) : null);
  if (!m) return null;
  if (m.simulado) return { meta: m, waba: 'sim-waba-plataforma', token: 'sim-token-plataforma' };
  return accessToken && plataformaWabaId ? { meta: m, waba: plataformaWabaId, token: accessToken } : null;
}

/** Causa de un fallo del registro, para mostrar un mensaje claro sin el texto de Meta. */
export type MotivoRegistro =
  | 'NUMERO_EN_USO' | 'NUMERO_INVALIDO' | 'NUMERO_YA_EN_LA_CUENTA' | 'YA_VERIFICADO' | 'CODIGO_INCORRECTO' | 'CODIGO_VENCIDO'
  | 'DEMASIADOS_INTENTOS' | 'LIMITE_NUMEROS' | 'NOMBRE_RECHAZADO' | 'PIN_EXISTENTE' | 'ACCESO' | 'TEMPORAL' | 'OTRO';

/**
 * Clasifica un error de la Graph API. Los códigos 136024 (ya verificado, referencia de request_code),
 * 133016/133008 (demasiados intentos), 133005 (PIN) y 2388012 (ya está en la cuenta) están en la
 * documentación oficial. Para número en uso, número inválido, código incorrecto o vencido, límite de
 * números y nombre rechazado, Meta no publica un código propio.
 * TODO(meta): reemplazar las heurísticas de texto por los códigos que devuelva Meta en la prueba real.
 */
export function motivoRegistro(e: unknown): MotivoRegistro {
  if (!(e instanceof ErrorMeta)) return 'OTRO';
  const c = e.codigo;
  const t = (e.crudo ?? '').toLowerCase();
  if (c === 190 || c === 200 || c === 10 || c === 3) return 'ACCESO';
  if (e.subcodigo === 2388012) return 'NUMERO_YA_EN_LA_CUENTA';
  if (c === 136024) return 'YA_VERIFICADO';
  if (c === 133016 || c === 133008) return 'DEMASIADOS_INTENTOS';
  if (c === 133005) return 'PIN_EXISTENTE';
  if (/expired|vencid/.test(t) && /code|c[oó]digo/.test(t)) return 'CODIGO_VENCIDO';
  if (/too many|demasiados/.test(t)) return 'DEMASIADOS_INTENTOS';
  if (c === 136025 || /(wrong|incorrect|invalid|mismatch)\b.{0,30}\bcode|\bcode\b.{0,30}(wrong|incorrect|invalid)/.test(t)) return 'CODIGO_INCORRECTO';
  if (/(maximum|limit)\b.{0,50}\bnumbers?|numbers?\b.{0,50}\b(limit|maximum)/.test(t)) return 'LIMITE_NUMEROS';
  if (/(display|verified)[ _]name/.test(t)) return 'NOMBRE_RECHAZADO';
  if (/already (registered|in use|linked)|in use (on|with) whatsapp/.test(t)) return 'NUMERO_EN_USO';
  if (/(invalid|not a valid)\b.{0,30}\b(phone|number)|phone.{0,30}invalid/.test(t)) return 'NUMERO_INVALIDO';
  return e.reintentable ? 'TEMPORAL' : 'OTRO';
}

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
