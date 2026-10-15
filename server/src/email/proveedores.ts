import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resend } from 'resend';
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { token } from '../lib/util.js';

/**
 * Proveedores de correo transaccional detrás de una interfaz interna. El resto del
 * sistema no conoce Resend ni SMTP: encola un correo (servicio.ts) y el trabajador
 * lo entrega con el proveedor configurado en EMAIL_PROVIDER.
 *
 * Los errores del proveedor se traducen a un código seguro: nunca se guarda ni se
 * registra el texto del proveedor (puede traer direcciones u otros datos).
 */
export interface CorreoSaliente {
  para: string;
  asunto: string;
  html: string;
  texto: string;
  responderA: string;
  /** Identificador estable del correo: evita duplicados al reintentar. */
  claveIdempotencia: string;
  tipo: string;
  /** Archivos adjuntos (p. ej. el ZIP de documentos de un pago). */
  adjuntos?: { nombre: string; contenido: Buffer; tipo: string }[];
}

export type CodigoFalloCorreo =
  | 'CREDENCIAL_INVALIDA' | 'REMITENTE_NO_VERIFICADO' | 'DESTINATARIO_INVALIDO' | 'LIMITE_PROVEEDOR'
  | 'CUOTA_AGOTADA' | 'TIEMPO_AGOTADO' | 'PROVEEDOR_NO_DISPONIBLE' | 'RECHAZADO' | 'SIN_PROVEEDOR'
  | 'CADUCADO' | 'ERROR_DESCONOCIDO';

export type ResultadoEnvio =
  | { ok: true; idProveedor: string }
  | { ok: false; codigo: CodigoFalloCorreo; reintentable: boolean; esperaSegundos?: number };

/** Texto seguro para cada fallo (lo ven el panel y el operador). */
export const MENSAJE_FALLO: Record<CodigoFalloCorreo, string> = {
  CREDENCIAL_INVALIDA: 'El proveedor rechazó la credencial de envío.',
  REMITENTE_NO_VERIFICADO: 'El dominio del remitente no está verificado en el proveedor.',
  DESTINATARIO_INVALIDO: 'La dirección de destino no es válida o fue rechazada.',
  LIMITE_PROVEEDOR: 'El proveedor limitó temporalmente los envíos.',
  CUOTA_AGOTADA: 'Se agotó la cuota de envío del proveedor.',
  TIEMPO_AGOTADO: 'El proveedor no respondió a tiempo.',
  PROVEEDOR_NO_DISPONIBLE: 'El proveedor de correo no está disponible.',
  RECHAZADO: 'El proveedor rechazó el mensaje.',
  SIN_PROVEEDOR: 'El correo está pendiente de conectar.',
  CADUCADO: 'El correo caducó antes de poder enviarse.',
  ERROR_DESCONOCIDO: 'No se pudo enviar el correo.',
};

export interface ProveedorCorreo {
  nombre: 'resend' | 'smtp' | 'fake' | 'ninguno';
  enviar(m: CorreoSaliente): Promise<ResultadoEnvio>;
}

export const remitente = () => ({ nombre: config.correo.remitenteNombre, direccion: config.correo.remitenteDireccion });
const remitenteTexto = () => `${remitente().nombre} <${remitente().direccion}>`;

// ------------------------------------------------------------------ Resend (SDK oficial)
type ClienteResend = Pick<Resend, 'emails'>;

export function clasificarErrorResend(e: { name?: string; statusCode?: number | null }): ResultadoEnvio {
  const n = String(e.name ?? '');
  const s = e.statusCode ?? null;
  if (['invalid_api_key', 'missing_api_key', 'restricted_api_key'].includes(n) || s === 401) return { ok: false, codigo: 'CREDENCIAL_INVALIDA', reintentable: false };
  if (n === 'invalid_from_address' || (s === 403 && n !== 'rate_limit_exceeded')) return { ok: false, codigo: 'REMITENTE_NO_VERIFICADO', reintentable: false };
  if (n === 'rate_limit_exceeded' || s === 429 && !/quota/.test(n)) return { ok: false, codigo: 'LIMITE_PROVEEDOR', reintentable: true, esperaSegundos: 30 };
  if (n === 'daily_quota_exceeded' || n === 'monthly_quota_exceeded') return { ok: false, codigo: 'CUOTA_AGOTADA', reintentable: true, esperaSegundos: 3600 };
  if (n === 'concurrent_idempotent_requests') return { ok: false, codigo: 'LIMITE_PROVEEDOR', reintentable: true, esperaSegundos: 5 };
  if (['validation_error', 'invalid_parameter', 'missing_required_field'].includes(n)) return { ok: false, codigo: 'DESTINATARIO_INVALIDO', reintentable: false };
  if (['invalid_idempotent_request', 'invalid_idempotency_key', 'security_error', 'invalid_attachment', 'invalid_access', 'invalid_region', 'not_found', 'method_not_allowed'].includes(n)) return { ok: false, codigo: 'RECHAZADO', reintentable: false };
  if (s === null) return { ok: false, codigo: 'TIEMPO_AGOTADO', reintentable: true };
  return { ok: false, codigo: 'PROVEEDOR_NO_DISPONIBLE', reintentable: true };
}

export class ProveedorResend implements ProveedorCorreo {
  nombre = 'resend' as const;
  private cliente: ClienteResend;
  constructor(apiKey: string, opciones: { cliente?: ClienteResend; baseUrl?: string } = {}) {
    const c = opciones.cliente ?? new Resend(apiKey, opciones.baseUrl ? { baseUrl: opciones.baseUrl } : undefined);
    // El SDK imprime el error crudo del proveedor fuera de producción; puede traer direcciones.
    (c as any).logError = () => {};
    this.cliente = c;
  }
  async enviar(m: CorreoSaliente): Promise<ResultadoEnvio> {
    try {
      const r = await this.cliente.emails.send(
        {
          from: remitenteTexto(), to: [m.para], subject: m.asunto, html: m.html, text: m.texto, replyTo: m.responderA,
          tags: [{ name: 'tipo', value: m.tipo.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256) }],
          ...(m.adjuntos?.length ? { attachments: m.adjuntos.map((a) => ({ filename: a.nombre, content: a.contenido, contentType: a.tipo })) } : {}),
        },
        { idempotencyKey: m.claveIdempotencia, signal: AbortSignal.timeout(config.correo.timeoutMs) } as any,
      );
      if (r.error) return clasificarErrorResend(r.error);
      if (!r.data?.id) return { ok: false, codigo: 'ERROR_DESCONOCIDO', reintentable: true };
      return { ok: true, idProveedor: r.data.id };
    } catch (e) {
      return { ok: false, codigo: (e as Error)?.name === 'TimeoutError' ? 'TIEMPO_AGOTADO' : 'PROVEEDOR_NO_DISPONIBLE', reintentable: true };
    }
  }
}

// ------------------------------------------------------------------ SMTP transaccional (nodemailer)
type TransporteSmtp = { sendMail(o: any): Promise<{ messageId?: string; accepted?: unknown[]; rejected?: unknown[] }> };

export function clasificarErrorSmtp(e: any): ResultadoEnvio {
  const code = String(e?.code ?? '');
  const resp = Number(e?.responseCode ?? 0);
  if (code === 'EAUTH' || resp === 535 || resp === 534) return { ok: false, codigo: 'CREDENCIAL_INVALIDA', reintentable: false };
  if (code === 'EENVELOPE' || [550, 551, 553, 501].includes(resp)) return { ok: false, codigo: 'DESTINATARIO_INVALIDO', reintentable: false };
  if (resp === 554 || resp === 552) return { ok: false, codigo: 'RECHAZADO', reintentable: false };
  if (resp === 421 || resp === 450 || resp === 451 || resp === 452) return { ok: false, codigo: 'LIMITE_PROVEEDOR', reintentable: true, esperaSegundos: 60 };
  if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'EDNS', 'ECONNRESET', 'ECONNREFUSED'].includes(code)) return { ok: false, codigo: code === 'ETIMEDOUT' ? 'TIEMPO_AGOTADO' : 'PROVEEDOR_NO_DISPONIBLE', reintentable: true };
  if (resp >= 400 && resp < 500) return { ok: false, codigo: 'LIMITE_PROVEEDOR', reintentable: true };
  if (resp >= 500) return { ok: false, codigo: 'RECHAZADO', reintentable: false };
  return { ok: false, codigo: 'PROVEEDOR_NO_DISPONIBLE', reintentable: true };
}

export class ProveedorSmtp implements ProveedorCorreo {
  nombre = 'smtp' as const;
  private transporte: TransporteSmtp;
  constructor(transporte?: TransporteSmtp) {
    const s = config.correo.smtp;
    const t = config.correo.timeoutMs;
    this.transporte = transporte ?? nodemailer.createTransport({
      host: s.host, port: s.port, secure: s.secure,
      // Fuera de esta máquina se exige cifrado (STARTTLS si no es TLS directo).
      requireTLS: !s.secure && !['localhost', '127.0.0.1', '::1'].includes(String(s.host)),
      auth: s.user ? { user: s.user, pass: s.password } : undefined,
      connectionTimeout: t, greetingTimeout: t, socketTimeout: t,
      logger: false, debug: false,
    });
  }
  async enviar(m: CorreoSaliente): Promise<ResultadoEnvio> {
    const dominio = remitente().direccion.split('@')[1] ?? 'localhost';
    try {
      const info = await this.transporte.sendMail({
        from: { name: remitente().nombre, address: remitente().direccion },
        to: m.para, replyTo: m.responderA, subject: m.asunto, html: m.html, text: m.texto,
        // Message-ID estable: si un reintento duplica el envío, los clientes lo agrupan.
        messageId: `<${m.claveIdempotencia}@${dominio}>`,
        headers: { 'X-Entity-Ref-ID': m.claveIdempotencia },
        attachments: m.adjuntos?.map((a) => ({ filename: a.nombre, content: a.contenido, contentType: a.tipo })),
      });
      if (info.rejected?.length) return { ok: false, codigo: 'DESTINATARIO_INVALIDO', reintentable: false };
      return { ok: true, idProveedor: String(info.messageId ?? `<${m.claveIdempotencia}@${dominio}>`) };
    } catch (e) {
      return clasificarErrorSmtp(e);
    }
  }
}

// ------------------------------------------------------------------ prueba y desarrollo
const enmascarar = (correo: string) => correo.replace(/^(.).*?(@.*)$/, '$1***$2');

/**
 * Proveedor falso: guarda los correos en memoria (pruebas) y, en desarrollo, en una
 * carpeta local (EMAIL_FAKE_DIR) para poder abrirlos. En la consola solo aparece el
 * tipo y el destinatario enmascarado: nunca el contenido ni los códigos.
 */
export class ProveedorFalso implements ProveedorCorreo {
  nombre = 'fake' as const;
  enviados: (CorreoSaliente & { id: string })[] = [];
  /** Las pruebas pueden forzar un fallo con un código concreto. */
  fallarCon: { codigo: CodigoFalloCorreo; reintentable: boolean; veces?: number } | null = null;
  constructor(private carpeta?: string) {}
  async enviar(m: CorreoSaliente): Promise<ResultadoEnvio> {
    if (this.fallarCon && (this.fallarCon.veces ?? 1) > 0) {
      const f = this.fallarCon;
      if (f.veces !== undefined) f.veces -= 1;
      if (f.veces === 0) this.fallarCon = null;
      return { ok: false, codigo: f.codigo, reintentable: f.reintentable };
    }
    const id = `fake_${token(9)}`;
    this.enviados.push({ ...m, id });
    if (this.carpeta) {
      try {
        mkdirSync(this.carpeta, { recursive: true });
        const base = `${new Date().toISOString().replace(/[:.]/g, '-')}_${m.tipo}`;
        writeFileSync(join(this.carpeta, `${base}.html`), `<!-- Para: ${m.para} · Asunto: ${m.asunto} · Responder a: ${m.responderA} -->\n${m.html}`);
        writeFileSync(join(this.carpeta, `${base}.txt`), `Para: ${m.para}\nAsunto: ${m.asunto}\nResponder a: ${m.responderA}\n\n${m.texto}`);
      } catch { /* la carpeta es una comodidad de desarrollo */ }
    }
    if (!config.test) console.log(`[correo de prueba] ${m.tipo} → ${enmascarar(m.para)}${this.carpeta ? ` (copia en ${this.carpeta})` : ''}`);
    return { ok: true, idProveedor: id };
  }
}

export class SinProveedor implements ProveedorCorreo {
  nombre = 'ninguno' as const;
  async enviar(): Promise<ResultadoEnvio> { return { ok: false, codigo: 'SIN_PROVEEDOR', reintentable: false }; }
}

/** Construye el proveedor a partir de la configuración (EMAIL_PROVIDER). */
export function crearProveedor(c = config): ProveedorCorreo {
  switch (c.correo.proveedor) {
    case 'resend': return c.correo.resendApiKey ? new ProveedorResend(c.correo.resendApiKey) : new SinProveedor();
    case 'smtp': return c.correo.smtp.host ? new ProveedorSmtp() : new SinProveedor();
    case 'fake': return new ProveedorFalso(c.correo.buzonLocal);
    default: return new SinProveedor();
  }
}

let proveedor: ProveedorCorreo = crearProveedor();
export const proveedorCorreo = () => proveedor;
export const usarProveedorCorreo = (p: ProveedorCorreo) => (proveedor = p);
/** ¿Hay un proveedor real que entregue correos fuera de este equipo? */
export const correoReal = () => proveedor.nombre === 'resend' || proveedor.nombre === 'smtp';
