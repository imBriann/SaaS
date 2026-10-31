import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Las pruebas nunca leen el .env local: podría traer credenciales reales (Wompi, Resend).
if (process.env.NODE_ENV !== 'test' && existsSync(join(process.cwd(), '.env'))) process.loadEnvFile(join(process.cwd(), '.env'));

/**
 * Configuración validada. Reglas:
 *  - En desarrollo y pruebas, cada tercero sin credenciales usa su simulador.
 *  - En producción NO se activa un simulador por falta de credenciales: la
 *    integración queda «pendiente de conectar» y la función que la necesita lo
 *    dice. Solo SIMULADORES=1 (demostración explícita) los habilita.
 */
const env = process.env;
const dev = env.NODE_ENV !== 'production';
const test = env.NODE_ENV === 'test';
const simuladores = dev || env.SIMULADORES === '1';
const v = (k: string) => (env[k] ?? '').trim() || undefined;

const publicUrl = (v('APP_PUBLIC_URL') ?? v('PUBLIC_URL') ?? 'http://localhost:5173').replace(/\/$/, '');

/** «Nombre <dir@dominio>» → partes (compatibilidad con EMAIL_FROM). */
function partirRemitente(s: string | undefined): { nombre?: string; direccion?: string } {
  if (!s) return {};
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  return m ? { nombre: m[1].trim() || undefined, direccion: m[2].trim() } : { direccion: s.trim() };
}
const remitenteAntiguo = partirRemitente(v('EMAIL_FROM'));
const proveedorCorreo = (): string => {
  const p = v('EMAIL_PROVIDER') ?? v('CORREO_PROVEEDOR');
  if (p) return p.toLowerCase() === 'registro' ? 'fake' : p.toLowerCase();
  if (v('RESEND_API_KEY')) return 'resend';
  if (v('SMTP_HOST')) return 'smtp';
  return simuladores ? 'fake' : 'ninguno';
};
const buzonSoporte = v('EMAIL_SUPPORT_INBOX') ?? v('CORREO_SOPORTE') ?? v('EMAIL_REPLY_TO') ?? v('EMAIL_FROM_ADDRESS') ?? remitenteAntiguo.direccion;
const smtpSeguro = ['1', 'true', 'si', 'sí'].includes((v('SMTP_SECURE') ?? '').toLowerCase());

export const config = {
  dev,
  test,
  simuladores,
  port: Number(env.PORT ?? 3000),
  /** Dominio base para subdominios de tenant: <slug>.<baseDomain> */
  baseDomain: (v('BASE_DOMAIN') ?? 'localhost').toLowerCase(),
  /** URL pública del panel (enlaces en correos, retorno de pagos). */
  publicUrl,
  /** URL pública que reciben los proveedores para sus webhooks (por defecto, la misma). */
  apiPublicUrl: (v('API_PUBLIC_URL') ?? publicUrl).replace(/\/$/, ''),
  cookieSegura: publicUrl.startsWith('https://'),
  /**
   * Dominio de la cookie de sesión. En producción, el dominio base (p. ej. omnegia.brianacevedo.dev)
   * para que la sesión valga en el panel principal y en cada subdominio de empresa. En local, sin dominio.
   */
  cookieDominio: (() => {
    const base = (v('BASE_DOMAIN') ?? 'localhost').toLowerCase();
    if (base === 'localhost' || !publicUrl.startsWith('https://')) return undefined;
    const host = new URL(publicUrl).hostname;
    return host === base || host.endsWith('.' + base) ? base : undefined;
  })(),
  databaseUrl: v('DATABASE_URL'),
  /** Recordatorios por la regla antigua de plantilla (programar_recordatorio). Apagado: los envía el ciclo proactivo. */
  recordatoriosPorRegla: v('RECORDATORIOS_POR_REGLA') === '1',
  dataDir: v('PGLITE_DIR') ?? './data/pglite',
  /** Clave para cifrar secretos de terceros en reposo (AES-256-GCM). */
  appKey: v('APP_KEY') ?? (dev ? 'dev-app-key-no-usar-en-produccion-0000' : ''),
  sesion: {
    dias: Number(env.SESION_DIAS ?? 7),
    /** Sin actividad durante este tiempo, la sesión expira aunque no haya llegado a su fin. */
    inactividadHoras: Number(env.SESION_INACTIVIDAD_HORAS ?? 12),
  },
  whatsapp: {
    appSecret: v('WHATSAPP_APP_SECRET') ?? (simuladores ? 'dev-whatsapp-app-secret' : undefined),
    verifyToken: v('WHATSAPP_VERIFY_TOKEN') ?? (simuladores ? 'dev-verify-token' : undefined),
    accessToken: v('WHATSAPP_ACCESS_TOKEN'),
    graphVersion: v('WHATSAPP_GRAPH_VERSION') ?? 'v23.0',
    idiomaPlantillas: v('WHATSAPP_IDIOMA_PLANTILLAS') ?? 'es',
    /** Identificador del número de WhatsApp de Omnegia (no de un comercio): lo atiende el asistente de la plataforma. */
    plataformaPhoneNumberId: v('WHATSAPP_PLATFORM_PHONE_NUMBER_ID'),
    /**
     * Cuenta de WhatsApp Business (WABA) de Omnegia. «Usar mi propio número» registra el número de cada
     * empresa dentro de esta cuenta con WHATSAPP_ACCESS_TOKEN: la empresa nunca entra a Meta.
     */
    plataformaWabaId: v('WHATSAPP_PLATFORM_WABA_ID'),
    /** Números que admite la WABA de Omnegia (2 con el portafolio de Meta sin verificar). El operador lo ve antes de agregar uno. */
    limiteNumerosWaba: Math.max(1, Number(v('WHATSAPP_WABA_LIMITE_NUMEROS') ?? 2) || 2),
    /** Conectar la WABA propia de la empresa (registro integrado, Tech Provider). Apagada = «Próximamente». */
    cuentaPropiaHabilitada: v('WHATSAPP_CUENTA_PROPIA_HABILITADA') === '1',
  },
  llm: {
    /** 'anthropic' con clave; 'mock' es el simulador determinista (solo con simuladores habilitados). */
    provider: (v('LLM_PROVIDER') ?? (v('ANTHROPIC_API_KEY') ? 'anthropic' : simuladores ? 'mock' : 'ninguno')) as 'anthropic' | 'mock' | 'ninguno',
    apiKey: v('ANTHROPIC_API_KEY'),
    model: v('LLM_MODEL') ?? 'claude-opus-5-5',
    timeoutMs: Number(env.LLM_TIMEOUT_MS ?? 45_000),
    maxRetries: Number(env.LLM_MAX_RETRIES ?? 2),
    maxIteraciones: Number(env.LLM_MAX_ITERACIONES ?? 6),
  },
  pagos: {
    proveedor: (v('PAGOS_PROVEEDOR') ?? (v('WOMPI_LLAVE_PUBLICA') ? 'wompi' : simuladores ? 'simulada' : 'ninguno')) as 'wompi' | 'simulada' | 'ninguno',
    /** Secreto de la pasarela simulada (desarrollo y demostración). */
    webhookSecret: v('PAYMENT_WEBHOOK_SECRET') ?? 'dev-pasarela-secreto',
    wompi: {
      entorno: (v('WOMPI_ENTORNO') ?? 'sandbox') as 'sandbox' | 'produccion',
      llavePublica: v('WOMPI_LLAVE_PUBLICA'),
      /** Solo para consultas servidor a servidor (Authorization: Bearer). Nunca sale del servidor. */
      llavePrivada: v('WOMPI_LLAVE_PRIVADA'),
      secretoIntegridad: v('WOMPI_SECRETO_INTEGRIDAD'),
      secretoEventos: v('WOMPI_SECRETO_EVENTOS'),
    },
    /** 3D Secure en pagos con tarjeta de Wompi (por defecto sí). WOMPI_3DS=off si la cuenta no lo tiene habilitado. */
    tresDS: v('WOMPI_3DS') !== 'off',
    /** Escenario de 3DS en sandbox (Wompi lo exige en pruebas; en producción no se envía). */
    tresDSPrueba: v('WOMPI_3DS_SANDBOX') ?? 'no_challenge_success',
    /** Precios comerciales confirmados por el operador (habilita la contratación comercial). */
    tarifasConfirmadas: v('TARIFAS_CONFIRMADAS') === '1',
  },
  /**
   * Modalidad institucional: cobro real y único por un acceso de duración fija, sin
   * renovación automática. No altera los precios comerciales, que se muestran como referencia.
   */
  /**
   * Pagos de comercio por WhatsApp (docs/pagos-whatsapp.md). Independientes de las suscripciones.
   *  - liveEnabled: cobros reales en línea con la cuenta Wompi del proyecto (credenciales de PRODUCCIÓN).
   *    Apagado por defecto. Nunca se interpreta el modo de precios como sandbox.
   *  - pricingMode: institutional_test (muestra el precio oficial y cobra un importe fijo real) u official.
   *  - testChargeCop: importe fijo del modo institucional (entero en pesos, mínimo 1.500).
   */
  comercio: {
    liveEnabled: ['1', 'true', 'si', 'sí'].includes((v('PAYMENTS_LIVE_ENABLED') ?? 'false').toLowerCase()),
    pricingMode: (v('COMMERCE_PRICING_MODE') ?? 'institutional_test') as 'institutional_test' | 'official',
    testChargeCop: Number(v('COMMERCE_TEST_CHARGE_COP') ?? 1500),
  },
  institucional: {
    activo: v('MODO_INSTITUCIONAL') === '1',
    precioCop: Number(v('PRECIO_INSTITUCIONAL_COP') ?? 1500),
    dias: Number(v('ACCESO_INSTITUCIONAL_DIAS') ?? 30),
  },
  /**
   * Documentos de los pagos a la plataforma. El emisor (operador de Omnegia) y su régimen
   * de IVA vienen del entorno: el código no supone ninguno. La factura electrónica DIAN de la
   * plataforma NUNCA se activa sola: exige FACTURACION_ELECTRONICA_PLATAFORMA=1, un proveedor
   * tecnológico implementado y verificado, emisor y numeración autorizada vigente.
   */
  documentos: {
    emisor: {
      razonSocial: v('EMISOR_RAZON_SOCIAL'),
      tipoDocumento: v('EMISOR_TIPO_DOCUMENTO') ?? 'NIT',
      numeroDocumento: v('EMISOR_NUMERO_DOCUMENTO'),
      direccion: v('EMISOR_DIRECCION'),
      ciudad: v('EMISOR_CIUDAD'),
      correo: v('EMISOR_CORREO'),
      telefono: v('EMISOR_TELEFONO'),
    },
    /** '1' responsable de IVA, '0' no responsable, sin definir = régimen pendiente de configurar. */
    responsableIva: (v('EMISOR_RESPONSABLE_IVA') ?? null) as '1' | '0' | null,
    ivaPct: Number(v('IVA_PCT') ?? 19),
    facturacion: {
      activa: v('FACTURACION_ELECTRONICA_PLATAFORMA') === '1',
      proveedor: v('FACTURACION_PROVEEDOR'),
      prefijo: v('FACTURACION_PREFIJO'),
      resolucion: v('FACTURACION_RESOLUCION'),
      rangoDesde: Number(v('FACTURACION_RANGO_DESDE') ?? NaN),
      rangoHasta: Number(v('FACTURACION_RANGO_HASTA') ?? NaN),
      vigenciaHasta: v('FACTURACION_RESOLUCION_VIGENCIA'),
    },
  },
  /**
   * Imágenes del catálogo. Se guardan con un adaptador de almacenamiento (hoy: disco; la interfaz admite un
   * almacenamiento de objetos después) y se sirven por una URL pública https (WhatsApp las envía por enlace).
   */
  imagenes: {
    /**
     * Dónde se guardan los archivos: «disco» (desarrollo; en Render gratuito se BORRA en cada despliegue) o
     * «supabase» (Supabase Storage: bucket público, carga con la llave de servicio solo desde el servidor).
     */
    almacen: (v('ALMACEN_PROVEEDOR') ?? v('IMAGENES_ALMACEN') ?? 'disco') as 'disco' | 'supabase',
    supabaseUrl: (v('SUPABASE_URL') ?? '').replace(/\/+$/, ''),
    supabaseServiceKey: v('SUPABASE_SERVICE_ROLE_KEY'),
    supabaseBucket: v('SUPABASE_BUCKET_IMAGENES'),
    dir: v('IMAGENES_DIR') ?? './almacen/imagenes',
    maxBytes: Math.round(Math.max(0.1, Number(v('IMAGENES_MAX_MB') ?? 5)) * 1024 * 1024),
    anchoMax: Math.max(320, Number(v('IMAGENES_ANCHO_MAX') ?? 1600)),
    anchoMiniatura: 320,
    /**
     * Búsqueda de imágenes con IA. openverse (por defecto): gratis, solo licencias abiertas con uso comercial.
     * pexels: gratis con clave (PEXELS_API_KEY). brave: búsqueda web general de pago (BRAVE_SEARCH_API_KEY); sus
     * imágenes quedan pendientes de aprobación. simulado: desarrollo y pruebas, sin red.
     */
    proveedor: (v('IMAGENES_PROVEEDOR') ?? (test ? 'simulado' : 'openverse')) as 'openverse' | 'pexels' | 'brave' | 'simulado' | 'ninguno',
    pexelsKey: v('PEXELS_API_KEY'),
    /** Openverse anónimo tiene límites bajos; con una aplicación registrada (client_credentials) suben. */
    openverseClientId: v('OPENVERSE_CLIENT_ID'),
    openverseClientSecret: v('OPENVERSE_CLIENT_SECRET'),
    /** Tiempo máximo de una consulta al buscador (Openverse puede tardar más de 10 s). */
    buscadorTimeoutMs: Number(env.IMAGENES_BUSCADOR_TIMEOUT_MS ?? 20_000),
    braveKey: v('BRAVE_SEARCH_API_KEY'),
    descargaTimeoutMs: Number(env.IMAGENES_TIMEOUT_MS ?? 10_000),
  },
  fiscal: {
    /** Solo existe el adaptador de pruebas: sin validez fiscal. */
    provider: (v('FISCAL_PROVIDER') ?? (simuladores ? 'sandbox' : 'ninguno')) as 'sandbox' | 'ninguno',
    /**
     * Facturación electrónica DIAN. Apagada (por defecto) el panel la muestra como «Próximamente», las rutas de
     * emisión responden 409 y el trabajador no encola emisiones; las empresas usan comprobantes de venta internos.
     */
    dianHabilitada: v('FACTURACION_DIAN_HABILITADA') === '1',
  },
  /**
   * Correo transaccional. El remitente y el proveedor dependen solo del entorno:
   * cambiar de Resend a SMTP, o de dominio, no requiere tocar el código (sí verificar
   * el dominio en el proveedor). Zoho Mail recibe; Resend/SMTP transaccional envía.
   */
  correo: {
    proveedor: proveedorCorreo() as 'resend' | 'smtp' | 'fake' | 'ninguno',
    resendApiKey: v('RESEND_API_KEY'),
    /** Secreto de firma del webhook de Resend (whsec_…): estados de entrega reales. */
    resendWebhookSecret: v('RESEND_WEBHOOK_SECRET'),
    remitenteNombre: v('EMAIL_FROM_NAME') ?? remitenteAntiguo.nombre ?? 'Omnegia',
    remitenteDireccion: v('EMAIL_FROM_ADDRESS') ?? remitenteAntiguo.direccion ?? (simuladores ? 'no-responder@omnegia.local' : ''),
    responderA: v('EMAIL_REPLY_TO') ?? buzonSoporte ?? (simuladores ? 'soporte@omnegia.local' : ''),
    /** Bandeja humana (Zoho Mail) donde llegan las solicitudes de soporte. */
    buzonSoporte: buzonSoporte ?? (simuladores ? 'soporte@omnegia.local' : ''),
    otpMinutos: Number(env.EMAIL_OTP_EXPIRY_MINUTES ?? 10),
    timeoutMs: Number(env.EMAIL_TIMEOUT_MS ?? 15_000),
    smtp: {
      host: v('SMTP_HOST'),
      port: Number(env.SMTP_PORT ?? (smtpSeguro ? 465 : 587)),
      secure: smtpSeguro,
      user: v('SMTP_USER'),
      password: v('SMTP_PASSWORD'),
    },
    /** Proveedor de prueba: carpeta donde deja cada correo (solo desarrollo; nunca en registros). */
    buzonLocal: v('EMAIL_FAKE_DIR') ?? (dev && !test ? './.buzon-dev' : undefined),
  },
  /**
   * Números de WhatsApp contratados desde Omnegia. El proveedor telefónico aprovisiona el número
   * (Telnyx, con su API oficial); Meta activa WhatsApp sobre él. Sin credenciales, en producción la
   * compra queda «pendiente de conectar» y el cliente sigue con su propio número.
   */
  numeros: {
    /** Compra de números nuevos (Telnyx). Apagada, el panel la muestra como «Próximamente» y sus rutas responden 409. */
    compraHabilitada: v('NUMEROS_COMPRA_HABILITADA') === '1',
    proveedor: (v('NUMEROS_PROVEEDOR') ?? (v('TELNYX_API_KEY') ? 'telnyx' : simuladores ? 'simulado' : 'ninguno')) as 'telnyx' | 'simulado' | 'ninguno',
    telnyx: {
      apiKey: v('TELNYX_API_KEY'),
      /** Llave pública Ed25519 de la cuenta (Mission Control › Keys & Credentials): firma de los webhooks. */
      llavePublica: v('TELNYX_PUBLIC_KEY'),
      /** Aplicación TeXML que atiende las llamadas entrantes del número (la llamada de verificación de Meta). */
      conexionVozId: v('TELNYX_TEXML_APP_ID'),
    },
    /** Países ofrecidos, en orden. El lanzamiento prioriza Colombia; otros se añaden aquí sin tocar el código. */
    paises: (v('NUMEROS_PAISES') ?? 'CO').split(',').map((p) => p.trim().toUpperCase()).filter((p) => /^[A-Z]{2}$/.test(p)),
    comercial: {
      /** Tasa USD→COP fija. Sin ella se usa la TRM oficial publicada en datos.gov.co. */
      tasaUsdCop: Number(v('NUMEROS_TASA_USD_COP') ?? 0) || null,
      /** Colchón sobre la tasa de cambio para cubrir su variación entre el cobro y la factura del proveedor. */
      colchonCambioPct: Number(v('NUMEROS_COLCHON_CAMBIO_PCT') ?? 5),
      /** Margen de Omnegia sobre el costo del proveedor (va incluido y se muestra en el precio final). */
      margenPct: Number(v('NUMEROS_MARGEN_PCT') ?? 0),
      /** Cargo único de Omnegia por gestionar la activación (pesos, sin IVA). */
      cargoActivacionCop: Number(v('NUMEROS_CARGO_ACTIVACION_COP') ?? 0),
      /** Los precios están confirmados por el operador: sin esto, en producción no se vende. */
      confirmadas: v('NUMEROS_TARIFAS_CONFIRMADAS') === '1',
    },
    /** Días de gracia tras el vencimiento de la mensualidad antes de liberar el número. */
    graciaDias: Number(v('NUMEROS_GRACIA_DIAS') ?? 7),
    /** Tarifas de Meta por plantilla en Colombia (COP), solo informativas; sin ellas se enlaza la tarifa oficial. */
    tarifasMeta: {
      marketing: Number(v('WHATSAPP_TARIFA_MARKETING_COP') ?? 0) || null,
      utilidad: Number(v('WHATSAPP_TARIFA_UTILIDAD_COP') ?? 0) || null,
      autenticacion: Number(v('WHATSAPP_TARIFA_AUTENTICACION_COP') ?? 0) || null,
    },
  },
  /** App de Meta para el registro integrado (Embedded Signup) como Tech Provider. */
  meta: {
    appId: v('META_APP_ID'),
    /** Configuración de Facebook Login for Business (Embedded Signup v4). */
    configId: v('META_ES_CONFIG_ID'),
  },
  ia: {
    /** Precios del proveedor en USD por millón de tokens (para estimar el costo técnico). */
    precioEntradaMTok: Number(env.IA_PRECIO_ENTRADA_USD_MTOK ?? 0) || null,
    precioSalidaMTok: Number(env.IA_PRECIO_SALIDA_USD_MTOK ?? 0) || null,
  },
  version: v('APP_VERSION') ?? '0.1.0',
  /** Límite de intentos de inicio de sesión por correo o IP en la ventana. */
  login: { maxIntentos: Number(env.LOGIN_MAX_INTENTOS ?? 8), ventanaMin: Number(env.LOGIN_VENTANA_MIN ?? 15) },
  workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 700),
  logNivel: (v('LOG_NIVEL') ?? (test ? 'silent' : 'info')) as 'silent' | 'error' | 'warn' | 'info' | 'debug',
};


/**
 * Origen al que Wompi puede devolver al usuario: el mismo donde empezó el alta (allí está la llave
 * del borrador en el navegador). Solo se aceptan el dominio público, los subdominios https de
 * BASE_DOMAIN y, en desarrollo, localhost. Cualquier otro valor se descarta.
 */
export function origenRetorno(origen: unknown, c = config): string | null {
  try {
    const u = new URL(String(origen ?? ''));
    if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
    if (u.origin === new URL(c.publicUrl).origin) return u.origin;
    if (c.baseDomain !== 'localhost' && u.protocol === 'https:' && u.hostname.endsWith('.' + c.baseDomain)) return u.origin;
    if (c.dev && ['localhost', '127.0.0.1'].includes(u.hostname.replace(/^.*\.(?=localhost$)/, ''))) return u.origin;
    return null;
  } catch { return null; }
}

/** Dirección de acceso de una empresa: <slug>.<BASE_DOMAIN> (o la URL del panel en local). */
export function urlEmpresa(slug: string, c = config): string {
  if (c.baseDomain === 'localhost' || !/^[a-z0-9-]{1,63}$/.test(slug)) return c.publicUrl;
  return `${c.publicUrl.startsWith('https://') ? 'https' : 'http'}://${slug}.${c.baseDomain}`;
}

export interface ResultadoValidacion { errores: string[]; avisos: string[] }

/** Comprobación de arranque. En producción, cualquier error detiene el proceso. */
export function validarConfiguracion(c = config): ResultadoValidacion {
  const errores: string[] = [];
  const avisos: string[] = [];
  if (!c.dev) {
    if (!c.appKey || c.appKey.length < 32) errores.push('APP_KEY es obligatoria en producción y debe tener al menos 32 caracteres (openssl rand -base64 48).');
    if (!c.databaseUrl) errores.push('DATABASE_URL es obligatoria en producción (PostgreSQL 15 o superior).');
    if (!c.publicUrl.startsWith('https://')) errores.push('PUBLIC_URL debe usar https:// en producción (las cookies de sesión se marcan como seguras).');
    if (c.baseDomain === 'localhost') avisos.push('BASE_DOMAIN sigue en «localhost»: los subdominios de las empresas no funcionarán fuera de esta máquina.');
    if (env.SIMULADORES === '1') avisos.push('SIMULADORES=1: los terceros sin credenciales se simulan. Úsalo solo en una instancia de demostración.');
  }
  if (c.imagenes.almacen === 'supabase') {
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.imagenes.supabaseUrl)) errores.push('ALMACEN_PROVEEDOR=supabase exige SUPABASE_URL con la forma https://<proyecto>.supabase.co.');
    if (!c.imagenes.supabaseServiceKey) errores.push('ALMACEN_PROVEEDOR=supabase exige SUPABASE_SERVICE_ROLE_KEY (solo en el servidor; nunca en el panel).');
    if (!c.imagenes.supabaseBucket || !/^[a-z0-9][a-z0-9_.-]{1,62}$/.test(c.imagenes.supabaseBucket)) errores.push('ALMACEN_PROVEEDOR=supabase exige SUPABASE_BUCKET_IMAGENES con el nombre del bucket público (por ejemplo, imagenes).');
  } else if (!c.dev) {
    avisos.push('ALMACEN_PROVEEDOR=disco: las imágenes del catálogo se guardan en el disco del servidor, que en Render (plan gratuito) se borra en cada despliegue. Usa ALMACEN_PROVEEDOR=supabase (ver docs/imagenes).');
  }
  errores.push(...erroresComercio(c));
  if (c.llm.provider === 'anthropic' && !c.llm.apiKey) errores.push('LLM_PROVIDER=anthropic exige ANTHROPIC_API_KEY.');
  if (c.llm.provider === 'mock' && !c.simuladores) errores.push('LLM_PROVIDER=mock solo se permite en desarrollo o con SIMULADORES=1.');
  const pagos = validarPagos(c);
  errores.push(...pagos.errores);
  avisos.push(...pagos.avisos);
  errores.push(...validarCorreo(c));
  if (c.correo.proveedor === 'ninguno' && !c.dev) avisos.push('Sin proveedor de correo (EMAIL_PROVIDER): no salen códigos, recuperaciones ni invitaciones.');
  if (c.correo.proveedor === 'resend' && c.correo.resendApiKey && !c.correo.resendApiKey.startsWith('re_')) avisos.push('RESEND_API_KEY no tiene el formato habitual (re_…).');
  if (c.correo.proveedor === 'resend' && !c.correo.resendWebhookSecret) avisos.push('Sin RESEND_WEBHOOK_SECRET: se sabe que Resend aceptó cada correo, pero no si se entregó o rebotó.');
  if (c.whatsapp.accessToken && !c.whatsapp.appSecret) errores.push('Con WHATSAPP_ACCESS_TOKEN también se necesita WHATSAPP_APP_SECRET para verificar los webhooks.');
  if (c.whatsapp.accessToken && !c.whatsapp.verifyToken) errores.push('Con WHATSAPP_ACCESS_TOKEN también se necesita WHATSAPP_VERIFY_TOKEN para registrar el webhook.');
  errores.push(...erroresNumeros(c));
  errores.push(...erroresNumeroPropio(c));
  if (c.numeros.proveedor === 'telnyx' && !c.numeros.comercial.confirmadas && !c.dev) avisos.push('Números de WhatsApp: falta NUMEROS_TARIFAS_CONFIRMADAS=1; la compra de números queda bloqueada hasta confirmar el modelo comercial.');
  if (c.numeros.proveedor === 'telnyx' && (!c.meta.appId || !c.meta.configId)) avisos.push('Números de WhatsApp: sin META_APP_ID y META_ES_CONFIG_ID se pueden comprar números, pero la activación de WhatsApp no puede iniciar el registro integrado de Meta.');
  return { errores, avisos };
}

/** Mínimo por transacción para el importe fijo (Wompi no publica un mínimo oficial; ver docs/pagos-whatsapp.md). */
export const COMERCIO_CARGO_MINIMO_COP = 1500;
export const COMERCIO_CARGO_MAXIMO_COP = 10_000_000;

/**
 * Pagos de comercio: el modo de precios y el importe fijo deben ser válidos siempre; con PAYMENTS_LIVE_ENABLED=true
 * además se exige la cuenta Wompi de PRODUCCIÓN completa y se rechazan credenciales de sandbox.
 */
export function erroresComercio(c = config): string[] {
  const e: string[] = [];
  const k = c.comercio;
  if (!['institutional_test', 'official'].includes(k.pricingMode)) e.push('COMMERCE_PRICING_MODE debe ser «institutional_test» u «official».');
  if (!Number.isInteger(k.testChargeCop) || k.testChargeCop < COMERCIO_CARGO_MINIMO_COP || k.testChargeCop > COMERCIO_CARGO_MAXIMO_COP) {
    e.push(`COMMERCE_TEST_CHARGE_COP debe ser un entero en pesos entre ${COMERCIO_CARGO_MINIMO_COP} y ${COMERCIO_CARGO_MAXIMO_COP} (sin decimales ni separadores).`);
  }
  if (k.liveEnabled) {
    const w = c.pagos.wompi;
    if (c.pagos.proveedor !== 'wompi') e.push('PAYMENTS_LIVE_ENABLED=true exige PAGOS_PROVEEDOR=wompi.');
    if (w.entorno !== 'produccion') e.push('PAYMENTS_LIVE_ENABLED=true exige WOMPI_ENTORNO=produccion: los cobros reales no usan sandbox.');
    if (!w.llavePublica || !w.llavePrivada || !w.secretoIntegridad || !w.secretoEventos) e.push('PAYMENTS_LIVE_ENABLED=true exige WOMPI_LLAVE_PUBLICA, WOMPI_LLAVE_PRIVADA, WOMPI_SECRETO_INTEGRIDAD y WOMPI_SECRETO_EVENTOS de producción.');
    const sandbox = [w.llavePublica, w.llavePrivada, w.secretoIntegridad, w.secretoEventos].some((x) => /^(pub|prv)_test_|^test_/.test(x ?? ''));
    if (sandbox) e.push('PAYMENTS_LIVE_ENABLED=true no admite credenciales de sandbox de Wompi (pub_test_, prv_test_, test_…): usa las de producción.');
  }
  return e;
}

/**
 * «Usar mi propio número»: la función está activa cuando hay token de WhatsApp de la plataforma. En
 * producción exige entonces la WABA de Omnegia, porque ahí se registra el número de cada empresa.
 */
export function erroresNumeroPropio(c = config): string[] {
  const waba = c.whatsapp.plataformaWabaId;
  if (waba && !/^\d{5,25}$/.test(waba)) return ['WHATSAPP_PLATFORM_WABA_ID debe ser el identificador numérico de la cuenta de WhatsApp Business de Omnegia (WhatsApp Manager › Configuración de la cuenta).'];
  if (!c.dev && c.whatsapp.accessToken && !waba) return ['Con WHATSAPP_ACCESS_TOKEN también se necesita WHATSAPP_PLATFORM_WABA_ID: «Usar mi propio número» registra los números de las empresas en la cuenta de WhatsApp Business de Omnegia.'];
  return [];
}

/** Reglas de la compra de números. */
export function erroresNumeros(c = config): string[] {
  const e: string[] = [];
  const n = c.numeros;
  if (!['telnyx', 'simulado', 'ninguno'].includes(n.proveedor)) return [`NUMEROS_PROVEEDOR=${n.proveedor} no es válido: usa telnyx.`];
  if (n.proveedor === 'simulado' && !c.simuladores) e.push('NUMEROS_PROVEEDOR=simulado solo se permite en desarrollo o con SIMULADORES=1.');
  if (n.proveedor === 'telnyx') {
    if (!n.telnyx.apiKey) e.push('NUMEROS_PROVEEDOR=telnyx exige TELNYX_API_KEY.');
    if (!n.telnyx.llavePublica) e.push('NUMEROS_PROVEEDOR=telnyx exige TELNYX_PUBLIC_KEY para verificar la firma de sus webhooks.');
    if (!n.telnyx.conexionVozId) e.push('NUMEROS_PROVEEDOR=telnyx exige TELNYX_TEXML_APP_ID: la verificación de WhatsApp llega como llamada de voz al número.');
  }
  const k = n.comercial;
  if (!Number.isFinite(k.margenPct) || k.margenPct < 0 || k.margenPct > 300) e.push('NUMEROS_MARGEN_PCT debe ser un porcentaje entre 0 y 300.');
  if (!Number.isFinite(k.colchonCambioPct) || k.colchonCambioPct < 0 || k.colchonCambioPct > 50) e.push('NUMEROS_COLCHON_CAMBIO_PCT debe estar entre 0 y 50.');
  if (!Number.isInteger(k.cargoActivacionCop) || k.cargoActivacionCop < 0) e.push('NUMEROS_CARGO_ACTIVACION_COP debe ser un entero en pesos, sin separadores.');
  if (k.tasaUsdCop !== null && (k.tasaUsdCop < 500 || k.tasaUsdCop > 20_000)) e.push('NUMEROS_TASA_USD_COP no parece una tasa USD→COP válida.');
  if (!Number.isInteger(n.graciaDias) || n.graciaDias < 0 || n.graciaDias > 30) e.push('NUMEROS_GRACIA_DIAS debe ser un entero entre 0 y 30.');
  if (!n.paises.length) e.push('NUMEROS_PAISES debe tener al menos un código de país ISO (por ejemplo, CO).');
  return e;
}

/** Prefijos que Wompi asigna a cada credencial según el ambiente. */
export const PREFIJOS_WOMPI = {
  produccion: { llavePublica: 'pub_prod_', llavePrivada: 'prv_prod_', secretoIntegridad: 'prod_integrity_', secretoEventos: 'prod_events_' },
  sandbox: { llavePublica: 'pub_test_', llavePrivada: 'prv_test_', secretoIntegridad: 'test_integrity_', secretoEventos: 'test_events_' },
} as const;
const VARIABLE_WOMPI = { llavePublica: 'WOMPI_LLAVE_PUBLICA', llavePrivada: 'WOMPI_LLAVE_PRIVADA', secretoIntegridad: 'WOMPI_SECRETO_INTEGRIDAD', secretoEventos: 'WOMPI_SECRETO_EVENTOS' } as const;

/** Wompi no documenta un mínimo por transacción; este piso evita montos que algunos medios rechazan. */
export const PRECIO_INSTITUCIONAL_MIN = 1500;
export const PRECIO_INSTITUCIONAL_MAX = 10_000_000;

/** Credenciales de Wompi: presentes y del mismo ambiente que WOMPI_ENTORNO (nunca se imprime su valor). */
export function erroresWompi(c = config): string[] {
  const w = c.pagos.wompi;
  if (w.entorno !== 'produccion' && w.entorno !== 'sandbox') return [`WOMPI_ENTORNO=${String(w.entorno)} no es válido: usa produccion o sandbox.`];
  const e: string[] = [];
  const faltan: string[] = (['llavePublica', 'secretoIntegridad', 'secretoEventos'] as const).filter((k) => !w[k]).map((k) => VARIABLE_WOMPI[k]);
  // Sin la llave privada no se puede consultar una transacción (Wompi responde 404 a consultas sin ella).
  if (w.entorno === 'produccion' && !w.llavePrivada) faltan.push(VARIABLE_WOMPI.llavePrivada);
  if (faltan.length) e.push(`PAGOS_PROVEEDOR=wompi exige ${faltan.join(', ')}.`);
  const esperado = PREFIJOS_WOMPI[w.entorno];
  const otro = PREFIJOS_WOMPI[w.entorno === 'produccion' ? 'sandbox' : 'produccion'];
  for (const k of Object.keys(esperado) as (keyof typeof esperado)[]) {
    const valor = w[k];
    if (!valor || valor.startsWith(esperado[k])) continue;
    e.push(valor.startsWith(otro[k])
      ? `${VARIABLE_WOMPI[k]} es de ${w.entorno === 'produccion' ? 'pruebas' : 'producción'} y WOMPI_ENTORNO=${w.entorno}: usa la credencial que empieza por ${esperado[k]}.`
      : `${VARIABLE_WOMPI[k]} no tiene el formato de Wompi para ${w.entorno} (${esperado[k]}…).`);
  }
  return e;
}

/** Parámetros de la modalidad institucional (precio y vigencia). */
export function erroresInstitucional(c = config): string[] {
  const e: string[] = [];
  const { precioCop, dias } = c.institucional;
  if (!Number.isInteger(precioCop) || precioCop < PRECIO_INSTITUCIONAL_MIN || precioCop > PRECIO_INSTITUCIONAL_MAX) {
    e.push(`PRECIO_INSTITUCIONAL_COP debe ser un entero en pesos entre ${PRECIO_INSTITUCIONAL_MIN} y ${PRECIO_INSTITUCIONAL_MAX} (sin decimales ni separadores).`);
  }
  if (!Number.isInteger(dias) || dias < 1 || dias > 365) e.push('ACCESO_INSTITUCIONAL_DIAS debe ser un entero entre 1 y 365.');
  return e;
}

/**
 * ¿Se puede cobrar en la modalidad institucional? Exige Wompi en producción con todas
 * las credenciales válidas: nunca una pasarela simulada ni el ambiente de pruebas.
 */
export function institucionalDisponible(c = config): { ok: boolean; motivos: string[] } {
  if (!c.institucional.activo) return { ok: false, motivos: ['MODO_INSTITUCIONAL no está activo.'] };
  const motivos = [...erroresInstitucional(c)];
  if (c.pagos.proveedor !== 'wompi') motivos.push('La modalidad institucional cobra con Wompi: configura PAGOS_PROVEEDOR=wompi.');
  else {
    if (c.pagos.wompi.entorno !== 'produccion') motivos.push('La modalidad institucional hace cobros reales: exige WOMPI_ENTORNO=produccion.');
    motivos.push(...erroresWompi(c));
  }
  if (!c.publicUrl.startsWith('https://')) motivos.push('El retorno del checkout de Wompi exige PUBLIC_URL con https://.');
  return { ok: motivos.length === 0, motivos };
}

export function validarPagos(c = config): ResultadoValidacion {
  const errores: string[] = [];
  const avisos: string[] = [];
  if (!['wompi', 'simulada', 'ninguno'].includes(c.pagos.proveedor)) errores.push(`PAGOS_PROVEEDOR=${c.pagos.proveedor} no es válido: usa wompi.`);
  if (c.pagos.proveedor === 'wompi') {
    errores.push(...erroresWompi(c));
    if (c.pagos.wompi.entorno === 'sandbox' && !c.pagos.wompi.llavePrivada) avisos.push('Sin WOMPI_LLAVE_PRIVADA no se puede consultar una transacción si el evento de Wompi se retrasa.');
  }
  if (c.pagos.proveedor === 'simulada' && !c.simuladores) errores.push('PAGOS_PROVEEDOR=simulada solo se permite en desarrollo o con SIMULADORES=1.');
  const docs = c.documentos;
  if (docs.responsableIva !== null && !['0', '1'].includes(docs.responsableIva)) errores.push('EMISOR_RESPONSABLE_IVA debe ser 1 (responsable de IVA) o 0 (no responsable).');
  if (!Number.isFinite(docs.ivaPct) || docs.ivaPct < 0 || docs.ivaPct > 100) errores.push('IVA_PCT debe ser un porcentaje entre 0 y 100.');
  if (c.institucional.activo && (!docs.emisor.razonSocial || !docs.emisor.numeroDocumento)) avisos.push('Faltan EMISOR_RAZON_SOCIAL y EMISOR_NUMERO_DOCUMENTO: el comprobante de pago saldrá sin la identificación completa del emisor.');
  if (c.institucional.activo && docs.responsableIva === null) avisos.push('Sin EMISOR_RESPONSABLE_IVA el comprobante indica que el régimen de IVA del emisor está pendiente de configuración.');
  if (docs.facturacion.activa) avisos.push('FACTURACION_ELECTRONICA_PLATAFORMA=1: solo se emitirán facturas si hay un adaptador de proveedor implementado, verificado y con resolución vigente; si no, quedan pendientes.');
  if (c.institucional.activo) {
    // No detiene el arranque: la contratación queda bloqueada y el motivo se informa.
    const d = institucionalDisponible(c);
    if (!d.ok) avisos.push(`MODO_INSTITUCIONAL=1 pero la contratación está bloqueada: ${d.motivos.join(' ')}`);
  }
  return { errores, avisos };
}

const CORREO_RE =/^[^@\s<>,;"']+@[^@\s<>,;"']+\.[^@\s<>,;"']+$/;

/** Reglas del correo transaccional. Devuelve errores en lenguaje claro. */
export function validarCorreo(c = config): string[] {
  const e: string[] = [];
  const k = c.correo;
  if (!['resend', 'smtp', 'fake', 'ninguno'].includes(k.proveedor)) return [`EMAIL_PROVIDER=${k.proveedor} no es válido: usa resend, smtp o fake.`];
  if (k.proveedor === 'fake' && !c.simuladores) e.push('EMAIL_PROVIDER=fake solo se permite en desarrollo o con SIMULADORES=1.');
  if (k.proveedor === 'resend' && !k.resendApiKey) e.push('EMAIL_PROVIDER=resend exige RESEND_API_KEY.');
  if (k.proveedor === 'smtp') {
    if (!k.smtp.host) e.push('EMAIL_PROVIDER=smtp exige SMTP_HOST.');
    if (k.smtp.host && /(^|\.)zoho(mail)?\./i.test(k.smtp.host)) e.push('SMTP_HOST apunta a Zoho Mail: su política no permite correo transaccional. Usa Resend u otro proveedor SMTP transaccional; Zoho sigue recibiendo en la bandeja de soporte.');
    if (!k.smtp.user || !k.smtp.password) e.push('EMAIL_PROVIDER=smtp exige SMTP_USER y SMTP_PASSWORD.');
    if (!Number.isInteger(k.smtp.port) || k.smtp.port < 1 || k.smtp.port > 65535) e.push('SMTP_PORT no es un puerto válido.');
  }
  if (k.proveedor === 'resend' || k.proveedor === 'smtp') {
    if (!CORREO_RE.test(k.remitenteDireccion)) e.push('EMAIL_FROM_ADDRESS es obligatoria y debe ser un correo válido de un dominio verificado en el proveedor.');
    if (!CORREO_RE.test(k.responderA)) e.push('EMAIL_REPLY_TO (o EMAIL_SUPPORT_INBOX) debe ser un correo válido.');
    if (!CORREO_RE.test(k.buzonSoporte)) e.push('EMAIL_SUPPORT_INBOX debe ser un correo válido.');
  }
  if (/[\r\n<>"]/.test(k.remitenteNombre) || k.remitenteNombre.length > 80) e.push('EMAIL_FROM_NAME no puede tener saltos de línea, comillas ni < >, y como máximo 80 caracteres.');
  if (!Number.isInteger(k.otpMinutos) || k.otpMinutos < 1 || k.otpMinutos > 60) e.push('EMAIL_OTP_EXPIRY_MINUTES debe ser un entero entre 1 y 60.');
  if (!Number.isFinite(k.timeoutMs) || k.timeoutMs < 1000) e.push('EMAIL_TIMEOUT_MS debe ser de al menos 1000.');
  return e;
}

export type EstadoIntegracion = 'conectado' | 'simulado' | 'pendiente';
export interface Integracion { clave: string; nombre: string; estado: EstadoIntegracion; detalle: string; variables: string[] }

/** Estado de cada tercero, sin exponer secretos. Lo usan /api/salud y la pantalla de integraciones. */
export function integraciones(c = config): Integracion[] {
  return [
    {
      clave: 'whatsapp', nombre: 'WhatsApp Cloud API (Meta)',
      estado: c.whatsapp.accessToken ? 'conectado' : c.simuladores ? 'simulado' : 'pendiente',
      detalle: c.whatsapp.accessToken ? `Graph ${c.whatsapp.graphVersion}. Cada empresa vincula su identificador de número.` : c.simuladores ? 'Los envíos se simulan; usa el Simulador del panel.' : 'Falta el token de acceso: no se envían mensajes.',
      variables: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_PLATFORM_WABA_ID'],
    },
    {
      clave: 'numeros', nombre: 'Números de WhatsApp (Telnyx)',
      estado: c.numeros.proveedor === 'telnyx' ? 'conectado' : c.numeros.proveedor === 'simulado' ? 'simulado' : 'pendiente',
      detalle: (c.numeros.proveedor === 'telnyx'
        ? `Países: ${c.numeros.paises.join(', ')}.${c.numeros.comercial.confirmadas ? '' : ' Precios sin confirmar: la compra está bloqueada.'}${c.meta.configId ? ' Registro integrado de Meta configurado.' : ' Falta el registro integrado de Meta.'}`
        : c.numeros.proveedor === 'simulado' ? 'Inventario de demostración: no se compra ningún número real.' : 'Sin proveedor: las empresas conectan su propio número.')
        + (c.numeros.compraHabilitada ? '' : ' Compra apagada (NUMEROS_COMPRA_HABILITADA=0): el panel la muestra como «Próximamente».'),
      variables: ['NUMEROS_COMPRA_HABILITADA', 'TELNYX_API_KEY', 'TELNYX_PUBLIC_KEY', 'TELNYX_TEXML_APP_ID', 'META_APP_ID', 'META_ES_CONFIG_ID', 'NUMEROS_TARIFAS_CONFIRMADAS'],
    },
    {
      clave: 'ia', nombre: 'Modelo de lenguaje (Claude)',
      estado: c.llm.provider === 'anthropic' ? 'conectado' : c.llm.provider === 'mock' ? 'simulado' : 'pendiente',
      detalle: c.llm.provider === 'anthropic' ? `Modelo ${c.llm.model}.` : c.llm.provider === 'mock' ? 'Simulador determinista: respuestas guionizadas.' : 'Sin modelo: las conversaciones pasan a una persona.',
      variables: ['ANTHROPIC_API_KEY', 'LLM_MODEL'],
    },
    {
      clave: 'pagos', nombre: 'Pasarela de pagos (Wompi)',
      estado: c.pagos.proveedor === 'wompi' ? 'conectado' : c.pagos.proveedor === 'simulada' ? 'simulado' : 'pendiente',
      detalle: (c.pagos.proveedor === 'wompi' ? `Entorno ${c.pagos.wompi.entorno}.` : c.pagos.proveedor === 'simulada' ? 'Pasarela simulada: sin cobros reales.' : 'Sin pasarela: no se pueden contratar ni renovar planes.')
        + (c.institucional.activo ? (institucionalDisponible(c).ok ? ` Modalidad institucional activa: ${c.institucional.precioCop} COP por ${c.institucional.dias} días.` : ' Modalidad institucional activa pero bloqueada por configuración incompleta.') : ''),
      variables: ['WOMPI_LLAVE_PUBLICA', 'WOMPI_LLAVE_PRIVADA', 'WOMPI_SECRETO_INTEGRIDAD', 'WOMPI_SECRETO_EVENTOS', 'WOMPI_ENTORNO', 'MODO_INSTITUCIONAL', 'PRECIO_INSTITUCIONAL_COP', 'ACCESO_INSTITUCIONAL_DIAS'],
    },
    {
      clave: 'facturacion', nombre: 'Proveedor de facturación electrónica',
      estado: !c.fiscal.dianHabilitada ? 'pendiente' : c.fiscal.provider === 'sandbox' ? 'simulado' : 'pendiente',
      detalle: !c.fiscal.dianHabilitada ? 'Apagada (FACTURACION_DIAN_HABILITADA=0): el panel la muestra como «Próximamente» y las empresas generan comprobantes de venta internos sin validez fiscal.'
        : c.fiscal.provider === 'sandbox' ? 'Entorno de pruebas propio: los documentos NO tienen validez fiscal.' : 'Sin proveedor habilitado: no se emiten facturas.',
      variables: ['FACTURACION_DIAN_HABILITADA', 'FISCAL_PROVIDER'],
    },
    {
      clave: 'correo', nombre: c.correo.proveedor === 'smtp' ? 'Correo transaccional (SMTP)' : 'Correo transaccional (Resend)',
      estado: c.correo.proveedor === 'resend' || c.correo.proveedor === 'smtp' ? 'conectado' : c.correo.proveedor === 'fake' ? 'simulado' : 'pendiente',
      detalle: c.correo.proveedor === 'resend' || c.correo.proveedor === 'smtp'
        ? `Remitente ${c.correo.remitenteNombre} <${c.correo.remitenteDireccion}>, respuestas a ${c.correo.responderA}.${c.correo.proveedor === 'resend' ? (c.correo.resendWebhookSecret ? ' Estados de entrega activos.' : ' Sin webhook: solo se confirma la aceptación.') : ''}`
        : c.correo.proveedor === 'fake' ? 'Proveedor de prueba: los correos no salen de este equipo.' : 'Sin proveedor: no se envían códigos, invitaciones ni recuperación de acceso.',
      variables: c.correo.proveedor === 'smtp' ? ['EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'EMAIL_FROM_ADDRESS'] : ['EMAIL_PROVIDER', 'RESEND_API_KEY', 'EMAIL_FROM_ADDRESS', 'RESEND_WEBHOOK_SECRET'],
    },
  ];
}
