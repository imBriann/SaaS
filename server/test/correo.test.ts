import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as crearTcp, type Server as ServidorTcp } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setup, login, api, CRED, correosA, codigoDelCorreo, loginOperador, type Env } from './helpers.js';
import { config, validarCorreo, integraciones } from '../src/config.js';
import {
  crearProveedor, proveedorCorreo, usarProveedorCorreo, ProveedorFalso, ProveedorResend, ProveedorSmtp, SinProveedor, clasificarErrorResend,
} from '../src/email/proveedores.js';
import * as plantillas from '../src/email/plantillas.js';
import { encolarCorreo, procesarCorreo, validarDestinatario } from '../src/email/servicio.js';
import { emitirOtp, verificarOtp, hashIp, LIMITES_OTP } from '../src/modules/otp.js';
import { drain } from '../src/worker/jobs.js';

/**
 * Sistema de correo: configuración, proveedores (SDK oficial de Resend contra un
 * servidor HTTP local; nodemailer contra un servidor SMTP local), plantillas,
 * bandeja de salida, códigos de un solo uso, verificación del correo, segundo
 * factor del operador, avisos de seguridad, soporte y aislamiento entre empresas.
 * Ninguna prueba envía correos reales.
 */
let E: Env;
let falso: ProveedorFalso;
beforeAll(async () => { E = await setup(); });
afterAll(async () => { await E.app.close(); await E.db.close(); });
beforeEach(() => {
  falso = new ProveedorFalso();
  usarProveedorCorreo(falso);
});

const clonar = () => structuredClone(config) as typeof config;

// ---------------------------------------------------------------- configuración y selección del proveedor
describe('Configuración del correo', () => {
  it('valida proveedor, credenciales, remitente y vencimiento del código', () => {
    const c = clonar();
    c.correo.proveedor = 'resend'; c.correo.resendApiKey = undefined;
    expect(validarCorreo(c)).toContain('EMAIL_PROVIDER=resend exige RESEND_API_KEY.');
    c.correo.resendApiKey = 're_prueba_123'; c.correo.remitenteDireccion = 'no-es-correo';
    expect(validarCorreo(c).join(' ')).toMatch(/EMAIL_FROM_ADDRESS/);
    c.correo.remitenteDireccion = 'soporte@brianacevedo.dev'; c.correo.responderA = 'soporte@brianacevedo.dev'; c.correo.buzonSoporte = 'soporte@brianacevedo.dev';
    expect(validarCorreo(c)).toEqual([]);
    c.correo.otpMinutos = 0;
    expect(validarCorreo(c).join(' ')).toMatch(/EMAIL_OTP_EXPIRY_MINUTES/);
    c.correo.otpMinutos = 10; c.correo.remitenteNombre = 'Omnegia\r\nBcc: x@y.z';
    expect(validarCorreo(c).join(' ')).toMatch(/EMAIL_FROM_NAME/);
  });

  it('rechaza el SMTP de Zoho Mail para envío transaccional y exige credenciales SMTP', () => {
    const c = clonar();
    c.correo.proveedor = 'smtp'; c.correo.smtp.host = 'smtp.zoho.com'; c.correo.smtp.user = 'u'; c.correo.smtp.password = 'p';
    c.correo.remitenteDireccion = c.correo.responderA = c.correo.buzonSoporte = 'soporte@brianacevedo.dev';
    expect(validarCorreo(c).join(' ')).toMatch(/Zoho Mail/);
    c.correo.smtp.host = 'smtp.proveedor-transaccional.test'; c.correo.smtp.password = undefined;
    expect(validarCorreo(c).join(' ')).toMatch(/SMTP_USER y SMTP_PASSWORD/);
  });

  it('el proveedor falso no se admite fuera de desarrollo; un valor desconocido se rechaza', () => {
    const c = clonar();
    c.simuladores = false; c.correo.proveedor = 'fake';
    expect(validarCorreo(c).join(' ')).toMatch(/solo se permite en desarrollo/);
    (c.correo as any).proveedor = 'sendgrid';
    expect(validarCorreo(c)[0]).toMatch(/no es válido/);
  });

  it('cambiar de proveedor solo requiere cambiar el entorno', () => {
    const c = clonar();
    c.correo.proveedor = 'resend'; c.correo.resendApiKey = 're_x';
    expect(crearProveedor(c)).toBeInstanceOf(ProveedorResend);
    c.correo.proveedor = 'smtp'; c.correo.smtp.host = 'localhost';
    expect(crearProveedor(c)).toBeInstanceOf(ProveedorSmtp);
    c.correo.proveedor = 'fake';
    expect(crearProveedor(c)).toBeInstanceOf(ProveedorFalso);
    c.correo.proveedor = 'ninguno';
    expect(crearProveedor(c)).toBeInstanceOf(SinProveedor);
  });

  it('el estado de integraciones nombra el remitente sin exponer la clave', () => {
    const c = clonar();
    c.correo.proveedor = 'resend'; c.correo.resendApiKey = 're_supersecreta_123456';
    c.correo.remitenteNombre = 'Omnegia Soporte'; c.correo.remitenteDireccion = 'soporte@brianacevedo.dev';
    const i = integraciones(c).find((x) => x.clave === 'correo')!;
    expect(i.estado).toBe('conectado');
    expect(i.detalle).toContain('Omnegia Soporte <soporte@brianacevedo.dev>');
    expect(JSON.stringify(i)).not.toContain('re_supersecreta');
  });
});

// ---------------------------------------------------------------- plantillas
describe('Plantillas', () => {
  it('código grande en HTML y texto plano; nunca en el asunto; contenido dinámico escapado', () => {
    const c = plantillas.codigoVerificacion({ nombre: '<script>alert(1)</script> Ana', codigo: '048213', minutos: 10 });
    expect(c.asunto).not.toContain('048213');
    expect(c.html).toContain('048213');
    expect(c.texto).toContain('Tu código: 048213');
    expect(c.html).not.toContain('<script>');
    expect(c.html).toContain('&lt;script&gt;');
    expect(c.html).toMatch(/Vence en 10 minutos/);
    expect(c.texto).toMatch(/¿No fuiste tú\?/);
    expect(c.html).toMatch(/max-width:600px/);
  });

  it('los botones solo enlazan a la plataforma o a https; el texto plano incluye el enlace', () => {
    const ok = plantillas.recuperarContrasena({ nombre: 'Ana', url: `${config.publicUrl}/restablecer?token=abc`, minutos: 60 });
    expect(ok.html).toContain(`${config.publicUrl}/restablecer?token=abc`);
    expect(ok.texto).toContain(`${config.publicUrl}/restablecer?token=abc`);
    const malo = plantillas.recuperarContrasena({ nombre: 'Ana', url: 'javascript:alert(1)', minutos: 60 });
    expect(malo.html).not.toContain('javascript:');
    expect(plantillas.urlSegura('http://evil.test/x')).toBeNull();
    expect(plantillas.urlSegura('https://wompi.co/x')).toBe('https://wompi.co/x');
  });

  it('los correos de una empresa llevan su nombre; los de plataforma, la marca', () => {
    const inv = plantillas.invitacion({ nombre: 'Leo', invitador: 'Andrea', empresa: 'Barbería El Parche', rol: 'Recepción', url: `${config.publicUrl}/invitacion?token=x`, dias: 7 });
    expect(inv.html).toContain('Enviado por Barbería El Parche con Omnegia');
    expect(inv.asunto).toBe('Andrea te invitó a Barbería El Parche');
    const bien = plantillas.bienvenida({ nombre: 'Ana', empresa: 'X', urlPanel: config.publicUrl });
    expect(bien.html).toContain('Todo tu negocio. Un solo lugar.');
    expect(bien.html).toContain(config.correo.responderA);
  });

  it('con APP_PUBLIC_URL en https el logotipo es el icono real de la marca; sin https, un monograma', () => {
    expect(plantillas.bienvenida({ nombre: 'A', empresa: 'X', urlPanel: config.publicUrl }).html).not.toContain('<img');
    const antes = config.publicUrl;
    (config as any).publicUrl = 'https://app.brianacevedo.dev';
    try {
      expect(plantillas.bienvenida({ nombre: 'A', empresa: 'X', urlPanel: config.publicUrl }).html).toContain('https://app.brianacevedo.dev/marca/icono-192.png');
    } finally { (config as any).publicUrl = antes; }
  });
});

// ---------------------------------------------------------------- Resend (SDK oficial contra un servidor local)
interface Recibido { ruta: string; cabeceras: IncomingMessage['headers']; cuerpo: any }
function servidorResend(respuesta: () => { estado: number; cuerpo?: unknown; colgar?: boolean }) {
  const recibidos: Recibido[] = [];
  const srv: Server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      recibidos.push({ ruta: req.url ?? '', cabeceras: req.headers, cuerpo: b ? JSON.parse(b) : null });
      const r = respuesta();
      if (r.colgar) return;
      res.writeHead(r.estado, { 'content-type': 'application/json' }).end(JSON.stringify(r.cuerpo ?? {}));
    });
  });
  return new Promise<{ url: string; recibidos: Recibido[]; cerrar: () => Promise<void> }>((ok) => srv.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    ok({ url, recibidos, cerrar: () => new Promise((c) => { srv.closeAllConnections(); srv.close(() => c()); }) });
  }));
}
const mensaje = (extra: Partial<Parameters<ProveedorResend['enviar']>[0]> = {}) => ({
  para: 'cliente@destino.test', asunto: 'Asunto', html: '<p>Hola</p>', texto: 'Hola', responderA: 'soporte@brianacevedo.dev', claveIdempotencia: 'clave-123', tipo: 'prueba', ...extra,
});

describe('Proveedor Resend', () => {
  it('envía con remitente, responder-a, texto plano y clave de idempotencia; devuelve el id', async () => {
    const s = await servidorResend(() => ({ estado: 200, cuerpo: { id: 'resend-id-1' } }));
    try {
      const r = await new ProveedorResend('re_prueba', { baseUrl: s.url }).enviar(mensaje());
      expect(r).toEqual({ ok: true, idProveedor: 'resend-id-1' });
      const [req] = s.recibidos;
      expect(req.ruta).toBe('/emails');
      expect(req.cabeceras['idempotency-key']).toBe('clave-123');
      expect(req.cabeceras.authorization).toBe('Bearer re_prueba');
      expect(req.cuerpo).toMatchObject({ to: ['cliente@destino.test'], subject: 'Asunto', html: '<p>Hola</p>', text: 'Hola', reply_to: 'soporte@brianacevedo.dev' });
      expect(req.cuerpo.from).toBe(`${config.correo.remitenteNombre} <${config.correo.remitenteDireccion}>`);
    } finally { await s.cerrar(); }
  });

  it('clasifica errores: credencial y dominio no se reintentan; límite y caída sí', async () => {
    const casos: [number, unknown, string, boolean][] = [
      [401, { statusCode: 401, name: 'invalid_api_key', message: 'API key is invalid' }, 'CREDENCIAL_INVALIDA', false],
      [403, { statusCode: 403, name: 'validation_error', message: 'The brianacevedo.dev domain is not verified' }, 'REMITENTE_NO_VERIFICADO', false],
      [429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' }, 'LIMITE_PROVEEDOR', true],
      [429, { statusCode: 429, name: 'daily_quota_exceeded', message: 'quota' }, 'CUOTA_AGOTADA', true],
      [422, { statusCode: 422, name: 'validation_error', message: 'Invalid `to` field: persona@privada.test' }, 'DESTINATARIO_INVALIDO', false],
      [500, { statusCode: 500, name: 'internal_server_error', message: 'boom' }, 'PROVEEDOR_NO_DISPONIBLE', true],
    ];
    const errores = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [estado, cuerpo, codigo, reintentable] of casos) {
      const s = await servidorResend(() => ({ estado, cuerpo }));
      try {
        const r = await new ProveedorResend('re_prueba', { baseUrl: s.url }).enviar(mensaje());
        expect(r).toMatchObject({ ok: false, codigo, reintentable });
      } finally { await s.cerrar(); }
    }
    // El SDK imprime el error crudo fuera de producción: aquí se silencia (puede traer direcciones).
    expect(errores).not.toHaveBeenCalled();
    errores.mockRestore();
  });

  it('un proveedor que no responde termina por tiempo agotado y es reintentable', async () => {
    const antes = config.correo.timeoutMs;
    config.correo.timeoutMs = 250;
    const s = await servidorResend(() => ({ estado: 200, colgar: true }));
    try {
      const r = await new ProveedorResend('re_prueba', { baseUrl: s.url }).enviar(mensaje());
      expect(r).toMatchObject({ ok: false, reintentable: true });
      expect(['TIEMPO_AGOTADO', 'PROVEEDOR_NO_DISPONIBLE']).toContain((r as any).codigo);
    } finally { config.correo.timeoutMs = antes; await s.cerrar(); }
  });

  it('la tabla de errores cubre los nombres del SDK', () => {
    expect(clasificarErrorResend({ name: 'missing_api_key', statusCode: 401 })).toMatchObject({ codigo: 'CREDENCIAL_INVALIDA' });
    expect(clasificarErrorResend({ name: 'application_error', statusCode: null })).toMatchObject({ codigo: 'TIEMPO_AGOTADO', reintentable: true });
    expect(clasificarErrorResend({ name: 'invalid_idempotent_request', statusCode: 409 })).toMatchObject({ codigo: 'RECHAZADO', reintentable: false });
  });
});

// ---------------------------------------------------------------- SMTP transaccional (nodemailer contra un servidor local)
function servidorSmtp(op: { rcpt?: number; auth?: number } = {}) {
  const mensajes: string[] = [];
  const srv: ServidorTcp = crearTcp((sock) => {
    sock.write('220 prueba ESMTP\r\n');
    let datos = false, buf = '', cuerpo = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const linea = buf.slice(0, i); buf = buf.slice(i + 2);
        if (datos) { if (linea === '.') { datos = false; mensajes.push(cuerpo); sock.write('250 2.0.0 OK id=smtp-1\r\n'); } else cuerpo += `${linea}\n`; continue; }
        const c = linea.toUpperCase();
        if (c.startsWith('EHLO') || c.startsWith('HELO')) sock.write('250-prueba\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (c.startsWith('AUTH')) sock.write(op.auth === 535 ? '535 5.7.8 Authentication failed\r\n' : '235 2.7.0 OK\r\n');
        else if (c.startsWith('RCPT TO')) sock.write(op.rcpt === 550 ? '550 5.1.1 Usuario desconocido\r\n' : '250 OK\r\n');
        else if (c === 'DATA') { datos = true; cuerpo = ''; sock.write('354 Adelante\r\n'); }
        else if (c === 'QUIT') { sock.write('221 Adiós\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise<{ puerto: number; mensajes: string[]; cerrar: () => Promise<void> }>((ok) => srv.listen(0, '127.0.0.1', () =>
    ok({ puerto: (srv.address() as AddressInfo).port, mensajes, cerrar: () => new Promise((c) => srv.close(() => c())) })));
}

describe('Proveedor SMTP transaccional', () => {
  const conSmtp = async (op: Parameters<typeof servidorSmtp>[0], fn: (p: ProveedorSmtp, s: Awaited<ReturnType<typeof servidorSmtp>>) => Promise<void>) => {
    const s = await servidorSmtp(op);
    const antes = structuredClone(config.correo.smtp);
    Object.assign(config.correo.smtp, { host: '127.0.0.1', port: s.puerto, secure: false, user: 'usuario', password: 'clave-smtp' });
    try { await fn(new ProveedorSmtp(), s); } finally { Object.assign(config.correo.smtp, antes); await s.cerrar(); }
  };

  it('entrega con From, Reply-To, HTML, texto y Message-ID estable', async () => {
    await conSmtp({}, async (p, s) => {
      const r = await p.enviar(mensaje({ claveIdempotencia: '0190aaaa-0000-7000-8000-000000000001' }));
      expect(r.ok).toBe(true);
      const crudo = s.mensajes[0];
      expect(crudo).toMatch(/^Reply-To: soporte@brianacevedo\.dev/m);
      expect(crudo).toMatch(new RegExp(`^From: .*<${config.correo.remitenteDireccion.replace(/\./g, '\\.')}>`, 'm'));
      expect(crudo).toMatch(/^Message-ID: <0190aaaa-0000-7000-8000-000000000001@/m);
      expect(crudo).toMatch(/text\/plain/);
      expect(crudo).toMatch(/text\/html/);
    });
  });

  it('destinatario rechazado (550) no se reintenta; credencial rechazada (535) tampoco', async () => {
    await conSmtp({ rcpt: 550 }, async (p) => expect(await p.enviar(mensaje())).toMatchObject({ ok: false, codigo: 'DESTINATARIO_INVALIDO', reintentable: false }));
    await conSmtp({ auth: 535 }, async (p) => expect(await p.enviar(mensaje())).toMatchObject({ ok: false, codigo: 'CREDENCIAL_INVALIDA', reintentable: false }));
  });

  it('un servidor caído es un fallo temporal', async () => {
    const antes = structuredClone(config.correo.smtp);
    Object.assign(config.correo.smtp, { host: '127.0.0.1', port: 1, secure: false, user: 'u', password: 'p' });
    try { expect(await new ProveedorSmtp().enviar(mensaje())).toMatchObject({ ok: false, reintentable: true }); }
    finally { Object.assign(config.correo.smtp, antes); }
  });
});

// ---------------------------------------------------------------- bandeja de salida
describe('Servicio de envío (bandeja de salida)', () => {
  const correo = () => plantillas.alertaNegocio({ empresa: 'X', titulo: 'Aviso', lineas: ['Uno'], url: config.publicUrl });

  it('valida destinatarios: sin saltos de línea, sin listas, con dominio', () => {
    expect(validarDestinatario('Ana@Dominio.CO')).toBe('Ana@dominio.co');
    for (const malo of ['a@b', 'a@b.co\r\nBcc: x@y.co', 'a@b.co, c@d.co', '<a@b.co>', '', 'x'.repeat(250) + '@b.co']) expect(validarDestinatario(malo)).toBeNull();
  });

  it('aceptado ≠ entregado: queda ENVIADO con el id del proveedor; un segundo proceso no reenvía', async () => {
    const id = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'aviso@destino.test', correo: correo() }));
    await drain(E.db);
    const m = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM email_outbox WHERE id=$1`, [id])).rows[0]);
    expect(m.estado).toBe('ENVIADO');
    expect(m.id_proveedor).toMatch(/^fake_/);
    expect(m.aceptado_en).not.toBeNull();
    expect(m.entregado_en).toBeNull();
    expect((await procesarCorreo(E.db, null, id, { ultimo: false })).estado).toBe('OMITIDO');
    expect(falso.enviados.filter((x) => x.claveIdempotencia === id)).toHaveLength(1);
  });

  it('un fallo temporal se reintenta con la MISMA clave de idempotencia y termina aceptado', async () => {
    falso.fallarCon = { codigo: 'LIMITE_PROVEEDOR', reintentable: true, veces: 1 };
    const id = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'reintento@destino.test', correo: correo() }));
    const r1 = await procesarCorreo(E.db, null, id, { ultimo: false });
    expect(r1).toMatchObject({ estado: 'PENDIENTE', codigo: 'LIMITE_PROVEEDOR' });
    const r2 = await procesarCorreo(E.db, null, id, { ultimo: false });
    expect(r2.estado).toBe('ENVIADO');
    expect(falso.enviados.map((x) => x.claveIdempotencia)).toEqual([id]);
    const m = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT intentos, error FROM email_outbox WHERE id=$1`, [id])).rows[0]);
    expect(m).toEqual({ intentos: 2, error: null });
  });

  it('un fallo definitivo NUNCA se muestra como éxito: FALLIDO con código seguro e incidente para el operador', async () => {
    falso.fallarCon = { codigo: 'CREDENCIAL_INVALIDA', reintentable: false };
    const id = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'credencial@destino.test', correo: correo() }));
    await drain(E.db);
    const m = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado, error FROM email_outbox WHERE id=$1`, [id])).rows[0]);
    expect(m).toEqual({ estado: 'FALLIDO', error: 'CREDENCIAL_INVALIDA' });
    const inc = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT codigo, detalle FROM incidente WHERE codigo='CORREO_CREDENCIAL'`)).rows[0]);
    expect(inc.detalle).toMatchObject({ proveedor: 'fake', codigo_proveedor: 'CREDENCIAL_INVALIDA' });
    expect(JSON.stringify(inc)).not.toContain('credencial@destino.test');
  });

  it('un destinatario inválido no se encola para envío; un correo caducado no sale', async () => {
    const id = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'no-es-correo', correo: correo() }));
    const m = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado, error FROM email_outbox WHERE id=$1`, [id])).rows[0]);
    expect(m).toEqual({ estado: 'FALLIDO', error: 'DESTINATARIO_INVALIDO' });
    const viejo = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'tarde@destino.test', correo: correo(), sensible: true, caducaEn: new Date(Date.now() - 1000) }));
    await drain(E.db);
    const v = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado, error, contenido_cifrado FROM email_outbox WHERE id=$1`, [viejo])).rows[0]);
    expect(v).toEqual({ estado: 'FALLIDO', error: 'CADUCADO', contenido_cifrado: null });
    expect(falso.enviados.some((x) => x.para === 'tarde@destino.test')).toBe(false);
  });

  it('la misma clave de aviso no encola dos correos', async () => {
    const a = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'uno@destino.test', correo: correo(), clave: 'aviso:unico' }));
    const b = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'uno@destino.test', correo: correo(), clave: 'aviso:unico' }));
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------- webhook de entregas (Resend / Svix)
describe('Estados de entrega (webhook firmado)', () => {
  const secreto = `whsec_${randomBytes(24).toString('base64')}`;
  const firmar = (cuerpo: string, id = `msg_${randomBytes(6).toString('hex')}`, ts = Math.floor(Date.now() / 1000)) => ({
    'svix-id': id, 'svix-timestamp': String(ts),
    'svix-signature': `v1,${createHmac('sha256', Buffer.from(secreto.slice(6), 'base64')).update(`${id}.${ts}.${cuerpo}`).digest('base64')}`,
    'content-type': 'application/json',
  });
  beforeAll(() => { config.correo.resendWebhookSecret = secreto; });
  afterAll(() => { config.correo.resendWebhookSecret = undefined; });

  it('entregado por webhook → ENTREGADO; un evento atrasado no retrocede; firma falsa → 401', async () => {
    const id = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'webhook@destino.test', correo: plantillas.pruebaConfiguracion({ proveedor: 'fake' }) }));
    await drain(E.db);
    const idProveedor = (await E.db.withPlatform(async (tx) => (await tx.query(`SELECT id_proveedor FROM email_outbox WHERE id=$1`, [id])).rows[0])).id_proveedor;
    const evento = (type: string) => JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: idProveedor, to: ['webhook@destino.test'] } });
    const entregado = evento('email.delivered');
    expect((await E.app.inject({ method: 'POST', url: '/api/webhooks/correo', payload: entregado, headers: firmar(entregado) })).statusCode).toBe(200);
    const enviado = evento('email.sent');
    await E.app.inject({ method: 'POST', url: '/api/webhooks/correo', payload: enviado, headers: firmar(enviado) });
    const m = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado, entregado_en FROM email_outbox WHERE id=$1`, [id])).rows[0]);
    expect(m.estado).toBe('ENTREGADO');
    expect(m.entregado_en).not.toBeNull();
    const rebote = evento('email.bounced');
    const falsa = { ...firmar(rebote), 'svix-signature': 'v1,AAAA' };
    expect((await E.app.inject({ method: 'POST', url: '/api/webhooks/correo', payload: rebote, headers: falsa })).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------- códigos de un solo uso
describe('Códigos de un solo uso (OTP)', () => {
  const usuario = async (email: string) => E.db.withPlatform(async (tx) => (await tx.query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0].id as string);
  const envejecer = () => E.db.withPlatform((tx) => tx.query(`UPDATE otp_code SET creado_en = creado_en - interval '2 minutes'`));

  it('seis dígitos aleatorios; en la base solo queda un HMAC; vence según la configuración', async () => {
    const uid = await usuario(CRED.andres[0]);
    const codigos = new Set<string>();
    for (let i = 0; i < 4; i++) {
      await envejecer();
      const o = await E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: `10.0.0.${i}` }));
      expect(o.codigo).toMatch(/^\d{6}$/);
      codigos.add(o.codigo);
      const fila = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT codigo_hash, expira_en, creado_en FROM otp_code WHERE id=$1`, [o.id])).rows[0]);
      expect(fila.codigo_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(fila.codigo_hash).not.toContain(o.codigo);
      expect(Math.round((new Date(fila.expira_en).getTime() - new Date(fila.creado_en).getTime()) / 60_000)).toBe(config.correo.otpMinutos);
    }
    expect(codigos.size).toBeGreaterThan(1);
    // Emitir uno nuevo invalida los anteriores: solo uno queda vigente.
    const vigentes = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM otp_code WHERE user_id=$1 AND usado_en IS NULL AND invalidado_en IS NULL`, [uid])).rows[0].n);
    expect(vigentes).toBe(1);
  });

  it('uso único, intentos limitados y expiración', async () => {
    const uid = await usuario(CRED.laura[0]);
    await envejecer();
    const o = await E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: '10.1.0.1' }));
    const malo = o.codigo === '000000' ? '111111' : '000000';
    await expect(verificarOtp(E.db, { proposito: 'VERIFICAR_CORREO', codigo: malo, userId: uid })).rejects.toThrow(/Te quedan 4 intentos/);
    expect(await verificarOtp(E.db, { proposito: 'VERIFICAR_CORREO', codigo: o.codigo, userId: uid })).toBe(uid);
    await expect(verificarOtp(E.db, { proposito: 'VERIFICAR_CORREO', codigo: o.codigo, userId: uid })).rejects.toThrow(/venció o ya no es válido/);

    await envejecer();
    const o2 = await E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: '10.1.0.1' }));
    const malo2 = o2.codigo === '000000' ? '111111' : '000000';
    for (let i = 0; i < LIMITES_OTP.maxIntentos - 1; i++) await expect(verificarOtp(E.db, { proposito: 'VERIFICAR_CORREO', codigo: malo2, userId: uid })).rejects.toThrow(/no es correcto/);
    await expect(verificarOtp(E.db, { proposito: 'VERIFICAR_CORREO', codigo: malo2, userId: uid })).rejects.toThrow(/Demasiados intentos/);
    // Tras agotar los intentos, ni el código correcto sirve.
    await expect(verificarOtp(E.db, { proposito: 'VERIFICAR_CORREO', codigo: o2.codigo, userId: uid })).rejects.toThrow(/venció o ya no es válido/);

    await envejecer();
    const o3 = await E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: '10.1.0.1' }));
    await E.db.withPlatform((tx) => tx.query(`UPDATE otp_code SET expira_en = now() - interval '1 second' WHERE id=$1`, [o3.id]));
    await expect(verificarOtp(E.db, { proposito: 'VERIFICAR_CORREO', codigo: o3.codigo, userId: uid })).rejects.toThrow(/venció/);
  });

  it('reenvío limitado por usuario (1 por minuto, 5 por hora) y por IP', async () => {
    const uid = await usuario(CRED.gym[0]);
    await envejecer();
    await E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: '10.2.0.1' }));
    await expect(E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: '10.2.0.1' }))).rejects.toThrow(/Espera \d+ segundos/);
    for (let i = 0; i < LIMITES_OTP.porHoraUsuario - 1; i++) {
      await E.db.withPlatform((tx) => tx.query(`UPDATE otp_code SET creado_en = creado_en - interval '61 seconds' WHERE user_id=$1`, [uid]));
      await E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: '10.2.0.1' }));
    }
    await E.db.withPlatform((tx) => tx.query(`UPDATE otp_code SET creado_en = creado_en - interval '61 seconds' WHERE user_id=$1`, [uid]));
    await expect(E.db.withPlatform((tx) => emitirOtp(tx, { userId: uid, proposito: 'VERIFICAR_CORREO', ip: '10.2.0.1' }))).rejects.toThrow(/demasiados códigos/);
    // Por IP: muchas solicitudes desde la misma dirección bloquean también a otra cuenta.
    const ipCargada = '10.9.9.9';
    await E.db.withPlatform((tx) => tx.query(
      `INSERT INTO otp_code (id, user_id, proposito, codigo_hash, ip_hash, expira_en, invalidado_en)
       SELECT gen_random_uuid(), $1, 'VERIFICAR_CORREO', 'x', $2, now(), now() FROM generate_series(1, $3)`, [uid, hashIp(ipCargada), LIMITES_OTP.porHoraIp]));
    const otro = await usuario(CRED.admin[0]);
    await expect(E.db.withPlatform((tx) => emitirOtp(tx, { userId: otro, proposito: 'ACCESO_PLATAFORMA', ip: ipCargada }))).rejects.toThrow(/demasiados códigos/);
  });
});

// ---------------------------------------------------------------- verificación del correo (API)
describe('Verificación del correo', () => {
  it('la API nunca devuelve el código; código correcto → verificado; quien no verificó no puede invitar', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE users SET email_verificado_en=NULL WHERE email=$1`, [CRED.admin[0]]));
    const cookie = await login(E.app, ...CRED.admin);
    const sesion = (await E.app.inject({ method: 'GET', url: '/api/auth/sesion', headers: { cookie } })).json();
    expect(sesion.usuario.correo_verificado).toBe(false);
    const admin = api(E.app, cookie, 'elparche');
    const inv = await admin.post('/configuracion/invitaciones', { email: 'nuevo@elparche.test', nombre: 'Nuevo', rol: 'recepcion' });
    expect(inv.status).toBe(409);
    expect(inv.body.error.message).toMatch(/Confirma tu correo/);

    const env = await E.app.inject({ method: 'POST', url: '/api/auth/verificacion/enviar', headers: { cookie } });
    expect(env.statusCode).toBe(200);
    const codigo = await codigoDelCorreo(E.db, CRED.admin[0]);
    expect(env.body).not.toContain(codigo);
    expect(env.json().destino).toMatch(/^a•••n@elparche\.test$/);
    const otraVez = await E.app.inject({ method: 'POST', url: '/api/auth/verificacion/enviar', headers: { cookie } });
    expect(otraVez.statusCode).toBe(429);

    const mal = await E.app.inject({ method: 'POST', url: '/api/auth/verificacion/confirmar', headers: { cookie }, payload: { codigo: codigo === '999999' ? '999998' : '999999' } });
    expect(mal.statusCode).toBe(400);
    const bien = await E.app.inject({ method: 'POST', url: '/api/auth/verificacion/confirmar', headers: { cookie }, payload: { codigo } });
    expect(bien.statusCode).toBe(200);
    expect((await E.app.inject({ method: 'GET', url: '/api/auth/sesion', headers: { cookie } })).json().usuario.correo_verificado).toBe(true);
    // El correo con el código se guardó cifrado y su contenido se borró al enviarse.
    const fila = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT cuerpo_html, cuerpo_texto, contenido_cifrado, sensible, estado FROM email_outbox WHERE tipo='verificacion_correo' AND para=$1 ORDER BY creado_en DESC LIMIT 1`, [CRED.admin[0]])).rows[0]);
    expect(fila).toEqual({ cuerpo_html: null, cuerpo_texto: null, contenido_cifrado: null, sensible: true, estado: 'ENVIADO' });
  });
});

// ---------------------------------------------------------------- segundo factor del operador
describe('Segundo factor del operador de la plataforma', () => {
  it('la contraseña sola no abre sesión; el código por correo sí; reenvío limitado', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE otp_code SET creado_en = creado_en - interval '2 minutes'`));
    const r = await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'soporte@saas.test', password: 'demo-soporte-2026' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ segundo_factor: true, minutos: config.correo.otpMinutos });
    expect(r.cookies.find((c) => c.name === 'sid')).toBeUndefined();
    const { desafio } = r.json();
    const codigo = await codigoDelCorreo(E.db, 'soporte@saas.test', 'codigo_acceso');
    expect(r.body).not.toContain(codigo);
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/login/codigo/reenviar', payload: { desafio } })).statusCode).toBe(429);
    const mal = await E.app.inject({ method: 'POST', url: '/api/auth/login/codigo', payload: { desafio, codigo: codigo === '123456' ? '654321' : '123456' } });
    expect(mal.statusCode).toBe(400);
    const otro = await E.app.inject({ method: 'POST', url: '/api/auth/login/codigo', payload: { desafio: 'x'.repeat(43), codigo } });
    expect(otro.statusCode).toBe(409);
    const ok = await E.app.inject({ method: 'POST', url: '/api/auth/login/codigo', payload: { desafio, codigo } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().usuario).toMatchObject({ rol_plataforma: 'SOPORTE', segundo_factor: true });
    const cookie = `sid=${ok.cookies.find((c) => c.name === 'sid')!.value}`;
    expect((await E.app.inject({ method: 'GET', url: '/api/operador/yo', headers: { cookie } })).statusCode).toBe(200);
    // El código ya no sirve una segunda vez.
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/login/codigo', payload: { desafio, codigo } })).statusCode).toBe(409);
  });

  it('una sesión de operador sin segundo factor no entra al panel', async () => {
    const { sha256 } = await import('../src/lib/util.js');
    const uid = (await E.db.withPlatform(async (tx) => (await tx.query(`SELECT id FROM users WHERE email='plataforma@saas.test'`)).rows[0])).id;
    await E.db.withPlatform((tx) => tx.query(`INSERT INTO session (id, user_id, expira_en, segundo_factor) VALUES ($1,$2, now() + interval '1 day', false)`, [sha256('token-sin-segundo-factor-123456'), uid]));
    expect((await E.app.inject({ method: 'GET', url: '/api/operador/resumen', headers: { cookie: 'sid=token-sin-segundo-factor-123456' } })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------- recuperación y avisos de seguridad
describe('Recuperación de contraseña y avisos de seguridad', () => {
  it('el enlace viaja en un correo sensible (cifrado y borrado tras enviarse) y el cambio genera un aviso', async () => {
    const email = CRED.andres[0];
    const r1 = await E.app.inject({ method: 'POST', url: '/api/auth/recuperar', payload: { email } });
    const r2 = await E.app.inject({ method: 'POST', url: '/api/auth/recuperar', payload: { email: 'no-existe@nadie.test' } });
    expect(r1.body).toBe(r2.body); // sin enumeración de cuentas
    const correo = (await correosA(E.db, email)).filter((c) => c.tipo === 'recuperar_contrasena').at(-1)!;
    const tk = correo.texto.match(/token=([A-Za-z0-9_-]+)/)![1];
    const fila = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT cuerpo_html, contenido_cifrado FROM email_outbox WHERE tipo='recuperar_contrasena' AND para=$1 ORDER BY creado_en DESC LIMIT 1`, [email])).rows[0]);
    expect(fila).toEqual({ cuerpo_html: null, contenido_cifrado: null });
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/restablecer', payload: { token: tk, password: 'otra-clave-segura-2026' } })).statusCode).toBe(200);
    const aviso = (await correosA(E.db, email)).filter((c) => c.tipo === 'contrasena_cambiada');
    expect(aviso).toHaveLength(1);
    expect(aviso[0].responderA).toBe(config.correo.responderA);
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/restablecer', payload: { token: tk, password: 'otra-clave-segura-2027' } })).statusCode).toBe(409);
  });

  it('el bloqueo por intentos fallidos avisa al titular una sola vez por ventana', async () => {
    const email = 'diego.bloqueo@fuerzanorte.test';
    await E.db.withPlatform((tx) => tx.query(`INSERT INTO users (id, email, nombre, password_hash) VALUES (gen_random_uuid(), $1, 'Diego Bloqueo', 'scrypt$x$y')`, [email]));
    for (let i = 0; i < config.login.maxIntentos + 3; i++) await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'incorrecta-123' }, remoteAddress: `10.20.${i}.1` });
    const avisos = (await correosA(E.db, email)).filter((c) => c.tipo === 'aviso_intentos_fallidos');
    expect(avisos).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- soporte (formulario del panel)
describe('Soporte de la plataforma', () => {
  it('crea el ticket, avisa a la bandeja de soporte (responder-a quien lo abrió) y confirma al solicitante', async () => {
    const admin = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    const r = await admin.post('/soporte', { categoria: 'WHATSAPP', prioridad: 'ALTA', asunto: 'No llegan los mensajes', descripcion: 'Desde ayer los clientes dicen que no reciben respuesta por WhatsApp.' });
    expect(r.status).toBe(200);
    expect(r.body.numero).toMatch(/^SOP-\d{6}$/);
    const interno = (await correosA(E.db, config.correo.buzonSoporte)).filter((c) => c.tipo === 'soporte_interno').at(-1)!;
    expect(interno.asunto).toBe(`[${r.body.numero}] No llegan los mensajes`);
    expect(interno.responderA).toBe(CRED.gym[0]);
    expect(interno.html).toContain('Gimnasio Fuerza Norte');
    const conf = (await correosA(E.db, CRED.gym[0])).filter((c) => c.tipo === 'soporte_recibido').at(-1)!;
    expect(conf.responderA).toBe(config.correo.responderA);
    const det = await admin.get(`/soporte/${r.body.id}`);
    expect(det.body.mensajes).toHaveLength(1);
    expect((await admin.post(`/soporte/${r.body.id}/mensajes`, { cuerpo: 'Adjunto más contexto: pasa solo con plantillas.' })).status).toBe(200);
  });

  it('rechaza claves, contraseñas y tarjetas; valida campos', async () => {
    const admin = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    for (const descripcion of ['Mi clave de Resend es re_AbCdEf123456789 y no funciona', 'Les dejo la contraseña: Secreta2026 para que entren', 'Pagué con 4111 1111 1111 1111 y no aparece']) {
      const r = await admin.post('/soporte', { categoria: 'OTRO', asunto: 'Ayuda con algo', descripcion });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/clave, contraseña o número de tarjeta/);
    }
    expect((await admin.post('/soporte', { categoria: 'NO_EXISTE', asunto: 'Hola', descripcion: 'x' })).status).toBe(400);
  });

  it('una empresa no ve los tickets ni los correos de otra', async () => {
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    const t = (await gym.post('/soporte', { categoria: 'CUENTA', asunto: 'Ticket privado', descripcion: 'Contenido privado del gimnasio que nadie más debe ver.' })).body;
    const parche = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await parche.get(`/soporte/${t.id}`)).status).toBe(404);
    expect((await parche.get('/soporte')).body.tickets.some((x: any) => x.id === t.id)).toBe(false);
    expect((await parche.post(`/soporte/${t.id}/mensajes`, { cuerpo: 'Intrusión' })).status).toBe(404);
    const correosDeB = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM email_outbox WHERE tenant_id=$1`, [E.B])).rows[0].n);
    expect(correosDeB).toBe(0);
  });

  it('el operador responde y la empresa recibe el aviso por correo', async () => {
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    const t = (await gym.post('/soporte', { categoria: 'FACTURACION', asunto: 'Duda con el cobro', descripcion: 'No entiendo el valor del último cobro de la suscripción.' })).body;
    const cookie = await loginOperador(E.app, E.db);
    const r = await E.app.inject({ method: 'POST', url: `/api/operador/soporte/${t.id}/responder`, headers: { cookie }, payload: { cuerpo: 'Hola: el cobro incluye el plan Pro del mes de octubre.' } });
    expect(r.statusCode).toBe(200);
    const aviso = (await correosA(E.db, CRED.gym[0])).filter((c) => c.tipo === 'soporte_respuesta').at(-1)!;
    expect(aviso.texto).toContain('plan Pro del mes de octubre');
    expect((await gym.get(`/soporte/${t.id}`)).body.ticket.estado).toBe('ESPERANDO_CLIENTE');
  });
});

// ---------------------------------------------------------------- privacidad en registros
describe('Registros sin secretos ni códigos', () => {
  it('ni el código ni el enlace aparecen en la consola durante el envío', async () => {
    const lineas: string[] = [];
    const espias = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lineas.push(a.map(String).join(' ')); }));
    const antes = (config as any).test;
    (config as any).test = false; // activa los registros que en pruebas están silenciados
    try {
      await E.db.withPlatform((tx) => tx.query(`UPDATE otp_code SET creado_en = creado_en - interval '2 minutes'`));
      await E.db.withPlatform((tx) => tx.query(`UPDATE users SET email_verificado_en=NULL WHERE email=$1`, [CRED.laura[0]]));
      const cookie = await login(E.app, ...CRED.laura);
      await E.app.inject({ method: 'POST', url: '/api/auth/verificacion/enviar', headers: { cookie } });
      await drain(E.db);
    } finally { (config as any).test = antes; espias.forEach((s) => s.mockRestore()); }
    const codigo = falso.enviados.filter((c) => c.tipo === 'verificacion_correo').at(-1)!.texto.match(/Tu código: (\d{6})/)![1];
    expect(lineas.join('\n')).not.toContain(codigo);
    expect(lineas.join('\n')).not.toContain(CRED.laura[0]);
    expect(lineas.some((l) => /verificacion_correo .* aceptado por fake|\[correo de prueba\] verificacion_correo/.test(l))).toBe(true);
  });

  it('proveedorCorreo() es el falso durante las pruebas (ningún correo real sale)', () => {
    expect(proveedorCorreo().nombre).toBe('fake');
  });
});
