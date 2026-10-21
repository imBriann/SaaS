import { verificarAlta } from './helpers.js';
import { createDecipheriv, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { digitoVerificacionNit } from '../src/adapters/fiscal.js';
import { olvidarMediosPago } from '../src/adapters/payments.js';
import { drain, HANDLERS } from '../src/worker/jobs.js';
import { proveedorCorreo, ProveedorFalso } from '../src/email/proveedores.js';
import { descifrarRecuperable, firmarEnlace, normalizarDocumento, verificarEnlace } from '../src/documentos/proteccion.js';
import { estadoFacturacionPlataforma, olvidarVerificaciones, registrarProveedorFiscalPlataforma, retirarProveedorFiscalPlataforma, type ResultadoEmision } from '../src/documentos/fiscalPlataforma.js';
import { emitirFacturaPago, generarDocumentosPago, recuperarDocumentos } from '../src/documentos/servicio.js';

/**
 * Documentos de los pagos a la plataforma: datos de facturación, comprobante PDF protegido,
 * ZIP sin contraseña, descargas autorizadas, correo con adjunto, facturación DIAN nunca
 * automática y medios de pago confirmados por Wompi. Sin red: `fetch` siempre simulado.
 */
let E: Env;
const DOC = '1012345678';
const SECRETO_EVENTOS = 'prod_events_secreto_ficticio_1234';
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const original = { pagos: structuredClone(config.pagos), institucional: { ...config.institucional }, publicUrl: config.publicUrl, documentos: structuredClone(config.documentos) };
let respuestaWompi: (url: string, init?: RequestInit) => Response = () => new Response('{}', { status: 404 });
const llamadas: { url: string; cabeceras: Headers }[] = [];

function modoInstitucional() {
  config.publicUrl = 'https://omnegia.test';
  config.pagos.proveedor = 'wompi';
  config.pagos.wompi = { entorno: 'produccion', llavePublica: 'pub_prod_llave_ficticia', llavePrivada: 'prv_prod_llave_ficticia', secretoIntegridad: 'prod_integrity_ficticio', secretoEventos: SECRETO_EVENTOS };
  config.institucional = { activo: true, precioCop: 1500, dias: 30 };
}
function restaurar() {
  config.pagos = structuredClone(original.pagos);
  config.institucional = { ...original.institucional };
  config.publicUrl = original.publicUrl;
  config.documentos = structuredClone(original.documentos);
}

const FACT = (slug: string, extra: Record<string, unknown> = {}) => ({ nombre: `Contratante ${slug}`, tipo_documento: 'CC', numero_documento: '1.012.345-678', email: `facturas@${slug}.test`, telefono: '+57 300 123 4567', direccion: 'Calle 10 # 5-20', ciudad: 'Ocaña', departamento: 'Norte de Santander', ...extra });
const post = (url: string, payload?: unknown) => E.app.inject({ method: 'POST', url, payload: payload as any });
const patch = (tk: string, payload: unknown) => E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${tk}`, payload: payload as any });
const estado = async (tk: string) => (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}/estado` })).json();
const correos = () => (proveedorCorreo() as ProveedorFalso).enviados;

function eventoWompi(tx: { id: string; status: string; amount_in_cents: number; reference: string }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = sha(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${SECRETO_EVENTOS}`);
  return { event: 'transaction.updated', data: { transaction: { currency: 'COP', ...tx } }, environment: 'prod', signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum }, timestamp };
}

async function borrador(slug: string, facturacion: Record<string, unknown> | null = FACT(slug)) {
  const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una barbería pequeña en Ocaña, atiendo yo solo con citas por WhatsApp.' })).json();
  await patch(d.token, { negocio: { nombre: `Empresa ${slug}`, email: `dueno@${slug}.test`, slug, nit: '901222333', nit_dv:String(digitoVerificacionNit('901222333')) } });
  if (facturacion) {
    const r = await patch(d.token, { facturacion });
    if (r.statusCode !== 200) throw new Error(r.body);
  }
  await verificarAlta(E,d.token);
  return d.token as string;
}

/** Alta pagada con Wompi (evento firmado) y documentos generados por el trabajador. */
async function altaPagada(slug: string) {
  const tk = await borrador(slug);
  const p = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
  const r = await post('/api/webhooks/wompi', eventoWompi({ id: `tx-${slug}`, status: 'APPROVED', amount_in_cents: 150000, reference: p.referencia }));
  if (r.statusCode !== 200) throw new Error(r.body);
  const paymentId = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT id FROM payment WHERE referencia=$1`, [p.referencia])).rows[0].id as string);
  return { tk, referencia: p.referencia as string, paymentId };
}

async function descargar(tk: string) {
  const e = await post(`/api/onboarding/borradores/${tk}/documentos/enlace`);
  expect(e.statusCode).toBe(200);
  const r = await post('/api/documentos/descarga', { token: e.json().token });
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toBe('application/zip');
  expect(r.headers['cache-control']).toMatch(/no-store/);
  return r.rawPayload;
}

/** Bit 0 del «general purpose flag» de cada cabecera local: 1 = la entrada del ZIP está cifrada. */
function entradasCifradasDelZip(zip: Buffer): number {
  let n = 0;
  let i = 0;
  while (i + 30 <= zip.length && zip.readUInt32LE(i) === 0x04034b50) {
    if (zip.readUInt16LE(i + 6) & 1) n++;
    i += 30 + zip.readUInt16LE(i + 26) + zip.readUInt16LE(i + 28) + zip.readUInt32LE(i + 18);
  }
  if (i === 0) throw new Error('No es un ZIP');
  return n;
}

/**
 * Verificación independiente del cifrado AES-256 (PDF V5/R5): la contraseña valida la entrada
 * /U, desbloquea la clave del archivo (/UE) y con ella se descifra el contenido de la página.
 */
function abrirPdf(pdf: Buffer, contrasena: string): string | null {
  const s = pdf.toString('latin1');
  const hex = (k: string) => Buffer.from(new RegExp(`/${k} <([0-9a-fA-F]+)>`).exec(s)![1], 'hex');
  if (!/\/V 5/.test(s) || !/\/CFM \/AESV3/.test(s)) throw new Error('El PDF no usa AES-256');
  const U = hex('U');
  const UE = hex('UE');
  const pw = Buffer.from(contrasena, 'utf8');
  if (createHash('sha256').update(Buffer.concat([pw, U.subarray(32, 40)])).digest().compare(U.subarray(0, 32)) !== 0) return null;
  const kek = createHash('sha256').update(Buffer.concat([pw, U.subarray(40, 48)])).digest();
  const d = createDecipheriv('aes-256-cbc', kek, Buffer.alloc(16)).setAutoPadding(false);
  const clave = Buffer.concat([d.update(UE), d.final()]);
  let texto = '';
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const ini = m.index! + m[0].length;
    const fin = s.indexOf('endstream', ini);
    const datos = pdf.subarray(ini, fin).subarray(0, -1);
    try {
      const dd = createDecipheriv('aes-256-cbc', clave, datos.subarray(0, 16));
      const plano = inflateSync(Buffer.concat([dd.update(datos.subarray(16, 16 + Math.floor((datos.length - 16) / 16) * 16)), dd.final()])).toString('latin1');
      texto += [...plano.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => Buffer.from(x[1], 'hex').toString('latin1')).join('');
    } catch { /* imágenes u otros flujos */ }
  }
  return texto;
}

beforeAll(async () => { E = await setup(); });
afterAll(async () => { restaurar(); await E.app.close(); await E.db.close(); });
beforeEach(() => {
  llamadas.length = 0;
  respuestaWompi = () => new Response('{}', { status: 404 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { llamadas.push({ url: String(url), cabeceras: new Headers(init?.headers) }); return respuestaWompi(String(url), init); }));
  modoInstitucional();
  olvidarMediosPago();
});
afterEach(() => { vi.unstubAllGlobals(); restaurar(); });

describe('Medios de pago de Wompi', () => {
  it('solo anuncia los medios que la cuenta confirma, excluye los que no admiten el monto y no promete Bre-B', async () => {
    respuestaWompi = (url) => (url.endsWith('/merchants/info') ? new Response(JSON.stringify({ data: { accepted_payment_methods: ['CARD', 'PSE', 'NEQUI', 'SU_PLUS', 'BANCOLOMBIA_BNPL', 'DESCONOCIDO'] } }), { status: 200 }) : new Response('{}', { status: 404 }));
    const r = (await E.app.inject({ method: 'GET', url: '/api/publico/medios-pago' })).json();
    expect(r.fuente).toBe('wompi');
    expect(r.medios.map((m: any) => m.codigo)).toEqual(['CARD', 'PSE', 'NEQUI']);
    expect(r.medios[0].nombre).toMatch(/crédito o débito/);
    expect(r.bre_b).toBe(false);
    expect(llamadas[0].url).toBe('https://production.wompi.co/v1/merchants/info');
    expect(llamadas[0].cabeceras.get('x-merchant-public-key')).toBe('pub_prod_llave_ficticia');
    expect(llamadas[0].cabeceras.get('authorization')).toBeNull();
  });

  it('Bre-B aparece solo si Wompi lo confirma; sin lista confirmada no se anuncia ningún medio', async () => {
    respuestaWompi = () => new Response(JSON.stringify({ data: { accepted_payment_methods: ['CARD', 'BRE_B'] } }), { status: 200 });
    let r = (await E.app.inject({ method: 'GET', url: '/api/publico/medios-pago' })).json();
    expect(r.bre_b).toBe(true);
    expect(r.medios.map((m: any) => m.nombre)).toContain('Bre-B');
    olvidarMediosPago();
    respuestaWompi = () => new Response(JSON.stringify({ data: { presigned_acceptance: {} } }), { status: 200 });
    r = (await E.app.inject({ method: 'GET', url: '/api/publico/medios-pago' })).json();
    expect(r).toEqual({ fuente: 'no_confirmado', medios: [], bre_b: false });
    olvidarMediosPago();
    respuestaWompi = () => { throw new Error('sin red'); };
    expect((await E.app.inject({ method: 'GET', url: '/api/publico/medios-pago' })).json().medios).toEqual([]);
  });
});

describe('Datos de facturación del contratante', () => {
  it('normaliza el número de documento quitando puntos, espacios, guiones y separadores', () => {
    expect(normalizarDocumento(' 1.012.345-678 ')).toBe(DOC);
    expect(normalizarDocumento('ab-12 34/5_6')).toBe('AB123456');
    expect(normalizarDocumento('１０１２')).toBe('1012');
  });

  it('se piden antes de un cobro real, se prellenan con el registro y validan cada tipo de documento', async () => {
    const tk = await borrador('factdatos', null);
    const d = (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}` })).json();
    expect(d.facturacion_requerida).toBe(true);
    expect(d.facturacion).toMatchObject({ completa: false, sugerida: true, datos: { nombre: 'Empresa factdatos', email: 'dueno@factdatos.test', tipo_documento: 'NIT', numero_sugerido: '901222333' } });
    const sin = await post(`/api/onboarding/borradores/${tk}/pago`);
    expect(sin.statusCode).toBe(400);
    expect(sin.json().error.details.faltan).toContain('facturacion');
    expect((await patch(tk, { facturacion: FACT('x', { tipo_documento: 'NIT', numero_documento: '901222333', dv: '0' }) })).statusCode).toBe(400);
    expect((await patch(tk, { facturacion: FACT('x', { numero_documento: 'ABC' }) })).statusCode).toBe(400);
    expect((await patch(tk, { facturacion: FACT('x', { telefono: '12' }) })).statusCode).toBe(400);
    const nit = await patch(tk, { facturacion: FACT('x', { tipo_documento: 'NIT', numero_documento: `901.222.333-${digitoVerificacionNit('901222333')}` }) });
    expect(nit.statusCode).toBe(200);
    expect(nit.json().facturacion.datos).toMatchObject({ tipo_documento: 'NIT', documento_mascara: '•••• 2333', dv: String(digitoVerificacionNit('901222333')) });
    const ok = await patch(tk, { facturacion: FACT('factdatos') });
    expect(ok.statusCode).toBe(200);
    // El número completo nunca vuelve al navegador, ni cifrado.
    expect(ok.body).not.toContain(DOC);
    expect(ok.body).not.toContain('documento_cifrado');
    expect(ok.json().facturacion).toMatchObject({ completa: true, datos: { documento_mascara: '•••• 5678', tipo_documento: 'CC' } });
    // Se puede corregir otro campo sin volver a escribir el documento.
    const sinDoc = { ...FACT('factdatos', { direccion: 'Carrera 7 # 1-2' }) } as any;
    delete sinDoc.numero_documento;
    expect((await patch(tk, { facturacion: sinDoc })).json().facturacion.datos.direccion).toBe('Carrera 7 # 1-2');
    expect((await post(`/api/onboarding/borradores/${tk}/pago`)).statusCode).toBe(200);
    const guardado = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT facturacion, documento_cifrado FROM payment WHERE draft_token=$1`, [tk])).rows[0]);
    expect(JSON.stringify(guardado.facturacion)).not.toContain(DOC);
    expect(guardado.documento_cifrado).not.toContain(DOC);
  });

  it('corregir los datos con un pago en curso reemplaza el checkout por uno con los datos nuevos', async () => {
    const tk = await borrador('factcambio');
    const p1 = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    expect((await post(`/api/onboarding/borradores/${tk}/pago`)).json().referencia).toBe(p1.referencia);
    expect((await patch(tk, { facturacion: FACT('factcambio', { nombre: 'Razón Social Corregida SAS' }) })).statusCode).toBe(200);
    const p2 = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    expect(p2.referencia).not.toBe(p1.referencia);
    const viejo = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado FROM payment WHERE referencia=$1`, [p1.referencia])).rows[0].estado);
    expect(viejo).toBe('REEMPLAZADO');
  });
});

describe('Comprobante, ZIP y correo tras un pago aprobado (facturación DIAN deshabilitada)', () => {
  let alta: Awaited<ReturnType<typeof altaPagada>>;
  let zipBuf: Buffer;

  it('la empresa se crea aunque la facturación electrónica no esté configurada y el recibo pasa de «generando» a «listo»', async () => {
    const { faseRecibo } = await import('../../web/src/pages/public/recibo.js');
    alta = await altaPagada('docs1');
    let st = await estado(alta.tk);
    expect(st.estado).toBe('APROVISIONADO');
    expect(st.documentos).toMatchObject({ estado: 'GENERANDO', disponible: false });
    expect(faseRecibo(st)).toBe('generando');
    expect((await post(`/api/onboarding/borradores/${alta.tk}/documentos/enlace`)).statusCode).toBe(409);
    await drain(E.db);
    st = await estado(alta.tk);
    expect(st.documentos).toMatchObject({ estado: 'LISTO', disponible: true, numero: expect.stringMatching(/^CP-\d{6}$/), estado_fiscal: 'PENDIENTE_CONFIGURACION', validez_fiscal: false });
    expect(faseRecibo(st)).toBe('listo');
    const doc = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM documento_pago WHERE payment_id=$1`, [alta.paymentId])).rows[0]);
    // Sin facturación habilitada: ni XML, ni CUFE, ni número de factura.
    expect(doc).toMatchObject({ estado_fiscal: 'PENDIENTE_CONFIGURACION', cufe: null, factura_numero: null, factura_xml: null, factura_consecutivo: null });
    expect(doc.fiscal_motivo).toMatch(/no está activada/);
  });

  it('el ZIP se abre sin contraseña y cada documento viene protegido; no incluye documentos tributarios', async () => {
    zipBuf = await descargar(alta.tk);
    expect(entradasCifradasDelZip(zipBuf)).toBe(0);
    const zip = await JSZip.loadAsync(zipBuf);
    const nombres = Object.keys(zip.files).sort();
    expect(nombres).toEqual(['LEEME.txt', expect.stringMatching(/^comprobante-pago-CP-\d{6}-sin-validez-fiscal\.pdf$/)].sort());
    expect(nombres.some((n) => /\.xml/.test(n))).toBe(false);
    const pdf = await zip.file(nombres.find((n) => n.endsWith('.pdf'))!)!.async('nodebuffer');
    expect(abrirPdf(pdf, '1012345679')).toBeNull();
    expect(abrirPdf(pdf, '1.012.345.678')).toBeNull();
    const texto = abrirPdf(pdf, DOC)!;
    expect(texto).toMatch(/DOCUMENTO SIN VALIDEZ FISCAL/);
    expect(texto).toMatch(/Comprobante de pago/);
    expect(texto).toContain(alta.referencia);
    expect(texto).toContain('tx-docs1');
    expect(texto).toMatch(/\$1\.500 COP/);
    expect(texto).toMatch(/pendiente de configuración/);
    expect(texto).not.toMatch(/CUFE/);
    // Sin la contraseña, ni el nombre ni el documento del contratante son legibles.
    expect(pdf.toString('latin1')).not.toContain(DOC);
    const leeme = await zip.file('LEEME.txt')!.async('string');
    expect(leeme).toMatch(/se abre sin contraseña/);
    expect(leeme).toMatch(/sin puntos, espacios, guiones/);
    expect(leeme).toMatch(/NO es una factura electrónica/);
    expect(leeme).not.toContain(DOC);
  });

  it('envía UNA confirmación por Resend con el ZIP adjunto, sin la contraseña, aunque el evento se repita', async () => {
    const mios = () => correos().filter((m) => m.para === 'facturas@docs1.test');
    expect(mios()).toHaveLength(1);
    const m = mios()[0];
    expect(m.adjuntos).toHaveLength(1);
    expect(m.adjuntos![0].nombre).toMatch(/^documentos-omnegia-CP-\d{6}\.zip$/);
    expect(sha(m.adjuntos![0].contenido)).toBe(sha(zipBuf));
    expect(m.texto).toMatch(/1\.500/);
    expect(m.texto).toMatch(/Empresa docs1/);
    expect(m.texto).toMatch(/sin puntos, espacios ni guiones/);
    expect(`${m.texto}${m.html}`).not.toContain(DOC);
    // Webhook repetido y retorno del navegador: ni documentos ni correos nuevos.
    await post('/api/webhooks/wompi', eventoWompi({ id: 'tx-docs1', status: 'APPROVED', amount_in_cents: 150000, reference: alta.referencia }));
    await post('/api/webhooks/wompi', eventoWompi({ id: 'tx-docs1', status: 'APPROVED', amount_in_cents: 150000, reference: alta.referencia }));
    await drain(E.db);
    expect(mios()).toHaveLength(1);
    const docs = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT version FROM documento_pago WHERE payment_id=$1`, [alta.paymentId])).rows);
    expect(docs).toEqual([{ version: 1 }]);
    expect(sha(await descargar(alta.tk))).toBe(sha(zipBuf));
  });

  it('las descargas exigen un enlace firmado y vigente, y cada empresa ve solo sus documentos', async () => {
    expect((await post('/api/documentos/descarga', {})).statusCode).toBe(403);
    const e = (await post(`/api/onboarding/borradores/${alta.tk}/documentos/enlace`)).json();
    expect(e.token).not.toContain(DOC);
    const alterado = e.token.slice(0, -2) + (e.token.endsWith('A') ? 'BB' : 'AA');
    expect((await post('/api/documentos/descarga', { token: alterado })).statusCode).toBe(403);
    expect(verificarEnlace(e.token, Date.now() + 11 * 60_000)).toBeNull();
    expect((await post(`/api/onboarding/borradores/${'x'.repeat(32)}/documentos/enlace`)).statusCode).toBe(404);
    // Dentro de la empresa: con sesión y permiso de suscripción.
    await post(`/api/onboarding/borradores/${alta.tk}/contrasena`, { password: 'clave-docs-larga-1' });
    const duenoDocs1 = api(E.app, await login(E.app, 'dueno@docs1.test', 'clave-docs-larga-1'), 'docs1');
    const lista = (await duenoDocs1.get('/suscripcion/documentos')).body;
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({ estado: 'LISTO', estado_fiscal: 'PENDIENTE_CONFIGURACION' });
    expect(JSON.stringify(lista)).not.toMatch(/zip"/);
    const enlace = await duenoDocs1.post(`/suscripcion/documentos/${lista[0].id}/enlace`);
    expect(enlace.status).toBe(200);
    expect((await post('/api/documentos/descarga', { token: enlace.body.token })).statusCode).toBe(200);
    // Otra empresa: no lista ni descarga documentos ajenos.
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    expect((await gym.get('/suscripcion/documentos')).body).toEqual([]);
    expect((await gym.post(`/suscripcion/documentos/${lista[0].id}/enlace`)).status).toBe(404);
    // El rol de ejecución no puede leer el contenido del ZIP ni el XML aunque lo intente.
    await expect(E.db.withTenant(E.B, (tx) => tx.query(`SELECT zip FROM documento_pago`))).rejects.toThrow(/permission denied/);
    await expect(E.db.withTenant(E.A, (tx) => tx.query(`SELECT factura_xml FROM documento_pago`))).rejects.toThrow(/permission denied/);
  });
});

describe('Recuperación ante errores', () => {
  it('si la generación falla, el pago y la empresa siguen confirmados, la confirmación sale sin adjunto y el reintento genera el ZIP sin duplicar correos', async () => {
    const { faseRecibo } = await import('../../web/src/pages/public/recibo.js');
    const tk = await borrador('docsfalla');
    const p = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    const paymentId = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT id FROM payment WHERE referencia=$1`, [p.referencia])).rows[0].id as string);
    const cifrado = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT documento_cifrado FROM payment WHERE id=$1`, [paymentId])).rows[0].documento_cifrado);
    await post('/api/webhooks/wompi', eventoWompi({ id: 'tx-falla', status: 'APPROVED', amount_in_cents: 150000, reference: p.referencia }));
    await E.db.withPlatform((tx) => tx.query(`UPDATE payment SET documento_cifrado='dañado' WHERE id=$1`, [paymentId]));
    await expect(HANDLERS.generar_documentos_pago(E.db, null, { payment_id: paymentId }, { id: 'job-prueba', intentos: 4, max_intentos: 5 })).rejects.toThrow();
    let st = await estado(tk);
    expect(st.estado).toBe('APROVISIONADO');
    expect(st.pago.estado).toBe('APROBADO');
    expect(st.documentos.estado).toBe('FALLIDO');
    expect(faseRecibo(st)).toBe('pendiente');
    await drain(E.db);
    const mios = () => correos().filter((m) => m.para === 'facturas@docsfalla.test');
    expect(mios()).toHaveLength(1);
    expect(mios()[0].adjuntos ?? []).toHaveLength(0);
    // Se corrige la causa y se reintenta desde el resultado del pago.
    await E.db.withPlatform((tx) => tx.query(`UPDATE payment SET documento_cifrado=$2 WHERE id=$1`, [paymentId, cifrado]));
    expect((await post(`/api/onboarding/borradores/${tk}/documentos/reintentar`)).json().estado).toBe('GENERANDO');
    await drain(E.db);
    st = await estado(tk);
    expect(st.documentos.estado).toBe('LISTO');
    expect(entradasCifradasDelZip(await descargar(tk))).toBe(0);
    expect(mios()).toHaveLength(1);
    expect(await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int n FROM payment WHERE draft_token=$1`, [tk])).rows[0].n)).toBe(1);
  });

  it('el trabajo de recuperación genera los documentos que quedaron sin hacer', async () => {
    const { tk, paymentId } = await altaPagada('docsrecup');
    // Simula una caída: el trabajo se perdió y el documento quedó «generando».
    await E.db.withPlatform((tx) => tx.query(`DELETE FROM job WHERE tipo='generar_documentos_pago' AND payload->>'payment_id'=$1`, [paymentId]));
    await E.db.withPlatform((tx) => tx.query(`UPDATE documento_pago SET actualizado_en = now() - interval '10 minutes' WHERE payment_id=$1`, [paymentId]));
    expect((await recuperarDocumentos(E.db)).documentos).toBeGreaterThanOrEqual(1);
    await drain(E.db);
    expect((await estado(tk)).documentos.estado).toBe('LISTO');
  });

  it('un pago sin datos de facturación no recibe documentos inventados (pasarela simulada de demostración)', async () => {
    restaurar();
    const tk = await borrador('docssindatos', null);
    const p = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    await post('/api/pasarela/simular', { ref: p.referencia, resultado: 'aprobado' });
    await drain(E.db);
    const st = await estado(tk);
    expect(st.estado).toBe('APROVISIONADO');
    expect(st.documentos.estado).toBe('SIN_DATOS');
    const m = correos().filter((x) => x.para === 'dueno@docssindatos.test' && /listo/.test(x.asunto));
    expect(m).toHaveLength(1);
    expect(m[0].adjuntos ?? []).toHaveLength(0);
  });
});

describe('Facturación electrónica DIAN: nunca automática', () => {
  const XML = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Invoice><!-- firma de prueba --><ds:Signature>abc</ds:Signature></Invoice>');
  let respuesta: ResultadoEmision = { estado: 'VALIDADA', numero: 'OMN-990001', cufe: 'a'.repeat(96), xml: XML, qr: 'https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=prueba', validadaEn: new Date() };
  const proveedorPrueba = { nombre: 'proveedor-de-pruebas', verificar: async () => ({ ok: true }), emitir: vi.fn(async () => respuesta) };
  const configurar = () => {
    config.documentos.emisor = { razonSocial: 'Operador de Pruebas SAS', tipoDocumento: 'NIT', numeroDocumento: `900123456-${digitoVerificacionNit('900123456')}`, direccion: 'Calle 1', ciudad: 'Cúcuta', correo: 'facturacion@omnegia.test', telefono: undefined };
    config.documentos.responsableIva = '1';
    config.documentos.facturacion = { activa: true, proveedor: 'proveedor-de-pruebas', prefijo: 'OMN', resolucion: '18760000000000', rangoDesde: 990001, rangoHasta: 990002, vigenciaHasta: '2099-12-31' };
  };
  afterEach(() => { retirarProveedorFiscalPlataforma('proveedor-de-pruebas'); olvidarVerificaciones(); });

  it('no se habilita sin activación explícita, adaptador implementado, emisor y resolución vigente', async () => {
    expect((await estadoFacturacionPlataforma()).motivos.join(' ')).toMatch(/no está activada/);
    configurar();
    expect((await estadoFacturacionPlataforma()).motivos.join(' ')).toMatch(/No hay un adaptador implementado/);
    registrarProveedorFiscalPlataforma(proveedorPrueba);
    config.documentos.facturacion.vigenciaHasta = '2020-01-01';
    expect((await estadoFacturacionPlataforma()).motivos.join(' ')).toMatch(/vigencia/);
    configurar();
    config.documentos.facturacion.activa = false;
    expect((await estadoFacturacionPlataforma()).habilitada).toBe(false);
    configurar();
    registrarProveedorFiscalPlataforma({ ...proveedorPrueba, verificar: async () => ({ ok: false, motivo: 'Credenciales rechazadas' }) });
    expect((await estadoFacturacionPlataforma()).motivos).toEqual(['Credenciales rechazadas']);
    olvidarVerificaciones();
    registrarProveedorFiscalPlataforma(proveedorPrueba);
    expect((await estadoFacturacionPlataforma()).habilitada).toBe(true);
  });

  it('con un proveedor habilitado y verificado, la factura validada reemplaza al comprobante y su XML viaja cifrado y recuperable', async () => {
    const { tk, paymentId } = await altaPagada('docsdian');
    await drain(E.db);
    configurar();
    registrarProveedorFiscalPlataforma(proveedorPrueba);
    expect(await emitirFacturaPago(E.db, paymentId, 'prueba')).toBe('VALIDADA');
    expect(proveedorPrueba.emitir).toHaveBeenCalledWith(expect.objectContaining({ numeroSecuencial: 990001, prefijo: 'OMN', total: 1500, base: 1260.5, iva: 239.5 }));
    // Un segundo intento no emite otra factura.
    expect(await emitirFacturaPago(E.db, paymentId, 'prueba')).toBe('OMITIDO');
    expect(proveedorPrueba.emitir).toHaveBeenCalledTimes(1);
    await drain(E.db);
    const st = await estado(tk);
    expect(st.documentos).toMatchObject({ estado: 'LISTO', version: 2, estado_fiscal: 'VALIDADA', validez_fiscal: true });
    const zip = await JSZip.loadAsync(await descargar(tk));
    const nombres = Object.keys(zip.files).sort();
    expect(nombres).toEqual(['LEEME.txt', 'factura-electronica-OMN-990001.pdf', 'factura-electronica-OMN-990001.xml.enc']);
    const pdf = await zip.file('factura-electronica-OMN-990001.pdf')!.async('nodebuffer');
    const texto = abrirPdf(pdf, DOC)!;
    expect(texto).toMatch(/Factura electrónica de venta/);
    expect(texto).toContain('CUFE');
    expect(texto).toContain('a'.repeat(40));
    expect(texto).not.toMatch(/SIN VALIDEZ FISCAL/);
    expect(pdf.toString('latin1').match(/\/Subtype \/Image/g)!.length).toBeGreaterThanOrEqual(2); // logotipo + QR
    const enc = await zip.file('factura-electronica-OMN-990001.xml.enc')!.async('nodebuffer');
    expect(enc.includes(Buffer.from('<Invoice'))).toBe(false);
    expect(descifrarRecuperable(enc, DOC).equals(XML)).toBe(true);
    expect(() => descifrarRecuperable(enc, '999')).toThrow();
    const leeme = await zip.file('LEEME.txt')!.async('string');
    expect(leeme).toMatch(/openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256/);
    expect(leeme).toContain(sha(XML));
    // Recuperable con OpenSSL estándar, sin software de Omnegia (si está instalado).
    const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
    if (openssl.status === 0) {
      const dir = mkdtempSync(join(tmpdir(), 'xml-'));
      try {
        writeFileSync(join(dir, 'f.enc'), enc);
        const r = spawnSync('openssl', ['enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '600000', '-md', 'sha256', '-in', join(dir, 'f.enc'), '-out', join(dir, 'f.xml'), '-pass', `pass:${DOC}`]);
        expect(r.status).toBe(0);
        expect(readFileSync(join(dir, 'f.xml')).equals(XML)).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // Correo de la factura, una sola vez; el enlace del ZIP anterior ya no sirve.
    expect(correos().filter((m) => m.para === 'facturas@docsdian.test' && /factura electrónica/i.test(m.asunto))).toHaveLength(1);
    const docId = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT id FROM documento_pago WHERE payment_id=$1`, [paymentId])).rows[0].id);
    expect((await post('/api/documentos/descarga', { token: firmarEnlace(docId, 1).token })).statusCode).toBe(409);
  });

  it('una factura rechazada no inventa CUFE ni número y queda para revisión; la base impide «validada» sin CUFE', async () => {
    const { paymentId } = await altaPagada('docsrechazo');
    await drain(E.db);
    configurar();
    respuesta = { estado: 'RECHAZADA', motivo: 'NIT del adquirente inválido' };
    registrarProveedorFiscalPlataforma(proveedorPrueba);
    expect(await emitirFacturaPago(E.db, paymentId, 'prueba')).toBe('RECHAZADA');
    const d = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado_fiscal, cufe, factura_numero, factura_xml FROM documento_pago WHERE payment_id=$1`, [paymentId])).rows[0]);
    expect(d).toEqual({ estado_fiscal: 'RECHAZADA', cufe: null, factura_numero: null, factura_xml: null });
    const incidentes = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int n FROM incidente WHERE codigo='PAGO_REQUIERE_REVISION'`)).rows[0].n);
    expect(incidentes).toBeGreaterThanOrEqual(1);
    await expect(E.db.withPlatform((tx) => tx.query(`UPDATE documento_pago SET estado_fiscal='VALIDADA' WHERE payment_id=$1`, [paymentId]))).rejects.toThrow(/check/i);
  });
});

describe('Animación del recibo', () => {
  it('el estado sale del servidor y nunca adelanta «listo»', async () => {
    const { faseRecibo, reciboEnCurso } = await import('../../web/src/pages/public/recibo.js');
    expect(faseRecibo(null)).toBe('validando');
    expect(faseRecibo({ estado: 'PAGO_INICIADO', pago: { estado: 'PENDIENTE' } })).toBe('validando');
    // El recibo se emite al aprobarse el pago, antes de crear el espacio (registro con creación diferida).
    expect(faseRecibo({ estado: 'PAGO_INICIADO', pago: { estado: 'APROBADO' } })).toBe('generando');
    expect(faseRecibo({ estado: 'APROVISIONADO', pago: { estado: 'APROBADO' }, documentos: null })).toBe('generando');
    expect(faseRecibo({ estado: 'APROVISIONADO', pago: { estado: 'APROBADO' }, documentos: { estado: 'GENERANDO' } })).toBe('generando');
    expect(faseRecibo({ estado: 'APROVISIONADO', pago: { estado: 'APROBADO' }, documentos: { estado: 'LISTO', disponible: true } })).toBe('listo');
    expect(faseRecibo({ estado: 'APROVISIONADO', pago: { estado: 'APROBADO' }, documentos: { estado: 'FALLIDO' } })).toBe('pendiente');
    expect(faseRecibo({ estado: 'APROVISIONADO', pago: { estado: 'APROBADO' }, documentos: { estado: 'SIN_DATOS' } })).toBe('pendiente');
    expect(reciboEnCurso('generando')).toBe(true);
    expect(reciboEnCurso('listo')).toBe(false);
  });

  it('respeta prefers-reduced-motion, anima solo transform y opacity, y anuncia el estado a lectores de pantalla', () => {
    const css = readFileSync(join(import.meta.dirname, '../../web/src/studio.css'), 'utf8');
    const bloque = css.slice(css.indexOf('Recibo que «imprime» Omnegia'));
    const reducido = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(bloque)?.[1] ?? '';
    expect(reducido).toMatch(/\.impresion-papel[^{]*\{[^}]*animation: none/);
    expect(reducido).toMatch(/transition: none/);
    for (const m of bloque.matchAll(/@keyframes [\w-]+ \{([^@]*?)\}\s*\}/g)) expect(m[1]).not.toMatch(/\b(top|left|height|width|margin)\s*:/);
    const tsx = readFileSync(join(import.meta.dirname, '../../web/src/components/ReciboImpresion.tsx'), 'utf8');
    expect(tsx).toMatch(/role="status" aria-live="polite"/);
    expect(tsx).toMatch(/className="recibo-papel" aria-hidden="true"/);
  });
});
