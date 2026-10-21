import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { setup, verificarAlta, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { olvidarMediosPago } from '../src/adapters/payments.js';
import { olvidarBancos, accionDe, cuerpoTransaccion, decodificarHtml } from '../src/adapters/wompiDirecto.js';

/**
 * Cobro con formulario propio. Ninguna prueba sale a la red: Wompi es un `fetch` simulado que responde
 * con la forma documentada (docs.wompi.co) y registra lo que el servidor le envía.
 */
let E: Env;
const SECRETO_INTEGRIDAD = 'test_integrity_secreto_ficticio_1234';
const SECRETO_EVENTOS = 'test_events_secreto_ficticio_1234';
const original = { pagos: structuredClone(config.pagos), institucional: { ...config.institucional }, publicUrl: config.publicUrl };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Llamada { url: string; metodo: string; cuerpo: any; auth: string | null; llave: string | null }
const llamadas: Llamada[] = [];
let transacciones: Record<string, any> = {};
let medios: string[] = ['CARD', 'NEQUI', 'PSE', 'BANCOLOMBIA_TRANSFER', 'BANCOLOMBIA_QR'];
let siguiente: (cuerpo: any) => { status: number; body: any } = () => ({ status: 201, body: {} });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function wompiFalso(url: string, init?: RequestInit) {
  const cab = new Headers(init?.headers);
  const cuerpo = init?.body ? JSON.parse(String(init.body)) : null;
  llamadas.push({ url, metodo: init?.method ?? 'GET', cuerpo, auth: cab.get('authorization'), llave: cab.get('x-merchant-public-key') });
  const ruta = url.replace('https://sandbox.wompi.co/v1', '');
  if (ruta === '/merchants/info') return json(200, { data: {
    accepted_payment_methods: medios,
    presigned_acceptance: { acceptance_token: 'acc_terminos_1', permalink: 'https://wompi.com/terminos.pdf', type: 'END_USER_POLICY' },
    presigned_personal_data_auth: { acceptance_token: 'acc_datos_1', permalink: 'https://wompi.com/datos.pdf', type: 'PERSONAL_DATA_AUTH' } } });
  if (ruta === '/pse/financial_institutions') return json(200, { data: [{ financial_institution_code: '0', financial_institution_name: 'A continuación seleccione su banco' }, { financial_institution_code: '1007', financial_institution_name: 'BANCOLOMBIA' }] });
  if (ruta === '/transactions' && init?.method === 'POST') { const r = siguiente(cuerpo); return json(r.status, r.body); }
  const m = ruta.match(/^\/transactions\/([\w-]+)$/);
  if (m && transacciones[m[1]]) return json(200, { data: transacciones[m[1]] });
  return json(404, {});
}

const post = (url: string, payload?: unknown) => E.app.inject({ method: 'POST', url, payload: payload as any });
const get = (url: string) => E.app.inject({ method: 'GET', url });

async function alta(slug: string) {
  const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una tienda de ropa y vendo accesorios.', creacion_diferida: true })).json();
  const r = await E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${d.token}`, payload: { negocio: { nombre: `Tienda ${slug}`, email: `${slug}@directo.test`, slug }, facturacion: { nombre: `Contratante ${slug}`, tipo_documento: 'CC', numero_documento: '1.012.345.678', email: `facturas@${slug}.test`, telefono: '+57 300 123 4567', direccion: 'Calle 10 # 5-20', ciudad: 'Ocaña', departamento: 'Norte de Santander' } } });
  expect(r.statusCode, r.body).toBe(200);
  await verificarAlta(E, d.token);
  return d.token as string;
}

const cliente = { nombre: 'Marta Rojas', telefono: '3001234567' };
const nequi = { metodo: 'NEQUI', celular: '3107654321' };
const url = (tk: string, sufijo = '') => `/api/onboarding/borradores/${tk}/pago/directo${sufijo}`;
const txWompi = (o: any = {}) => ({ id: '11854-1728506262-27959', reference: 'SUB-X', amount_in_cents: 22900000, currency: 'COP', status: 'PENDING', status_message: null, payment_method_type: 'NEQUI', payment_method: { type: 'NEQUI', extra: {} }, ...o });

beforeAll(async () => { E = await setup(); });
afterAll(async () => { config.pagos = structuredClone(original.pagos); config.institucional = { ...original.institucional }; config.publicUrl = original.publicUrl; await E.app.close(); await E.db.close(); });
beforeEach(() => {
  llamadas.length = 0; transacciones = {}; medios = ['CARD', 'NEQUI', 'PSE', 'BANCOLOMBIA_TRANSFER', 'BANCOLOMBIA_QR'];
  olvidarMediosPago(); olvidarBancos();
  config.publicUrl = 'https://omnegia.test';
  config.pagos.proveedor = 'wompi'; config.pagos.tarifasConfirmadas = true;
  config.pagos.wompi = { entorno: 'sandbox', llavePublica: 'pub_test_ficticia', llavePrivada: 'prv_test_ficticia', secretoIntegridad: SECRETO_INTEGRIDAD, secretoEventos: SECRETO_EVENTOS };
  config.institucional = { ...config.institucional, activo: false };
  siguiente = (c) => ({ status: 201, body: { data: txWompi({ reference: c.reference }) } });
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => wompiFalso(String(u), init)));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('Qué métodos se ofrecen', () => {
  it('ofrece solo lo que Wompi confirma para la cuenta, con los enlaces de aceptación y los bancos, sin entregar los tokens', async () => {
    medios = ['CARD', 'NEQUI', 'PSE', 'DAVIPLATA'];
    const tk = await alta('config-ok');
    const r = (await get(url(tk))).json();
    expect(r.disponible).toBe(true);
    expect(r.metodos.map((m: any) => m.codigo)).toEqual(['CARD', 'NEQUI', 'PSE']);
    expect(r.aceptacion).toEqual({ terminos: 'https://wompi.com/terminos.pdf', datos: 'https://wompi.com/datos.pdf' });
    expect(r.bancos).toEqual([{ codigo: '1007', nombre: 'BANCOLOMBIA' }]);
    expect(r.api).toBe('https://sandbox.wompi.co/v1');
    expect(JSON.stringify(r)).not.toMatch(/acc_terminos|acc_datos|prv_test|integrity/i);
  });

  it('sin métodos confirmados no promete nada: queda el checkout de Wompi', async () => {
    medios = ['DAVIPLATA'];
    const tk = await alta('config-vacio');
    expect((await get(url(tk))).json()).toEqual({ disponible: false });
  });

  it('en la pasarela simulada ofrece los métodos de demostración', async () => {
    config.pagos.proveedor = 'simulada';
    const tk = await alta('config-sim');
    const r = (await get(url(tk))).json();
    expect(r).toMatchObject({ disponible: true, simulado: true });
    expect(r.metodos).toHaveLength(5);
  });
});

describe('Crear la transacción', () => {
  it('Nequi: el monto y la referencia salen de la base, la firma es la de integridad y los tokens de aceptación se piden al cobrar', async () => {
    const tk = await alta('nequi');
    const r = await post(url(tk), { acepta_wompi: true, cliente, pago: nequi, monto: 1, referencia: 'SUB-FALSA' });
    expect(r.statusCode, r.body).toBe(200);
    const tx = llamadas.find((l) => l.metodo === 'POST' && l.url.endsWith('/transactions'))!;
    expect(tx.auth).toBe('Bearer pub_test_ficticia');
    const c = tx.cuerpo;
    // El navegador no manda monto ni referencia: aunque lo intente, no cuentan.
    expect(c.reference).toMatch(/^SUB-/);
    expect(c.reference).not.toBe('SUB-FALSA');
    expect(c.amount_in_cents).toBe(22_900_000); // plan Negocio mensual
    expect(c.currency).toBe('COP');
    expect(c.signature).toBe(sha(`${c.reference}${c.amount_in_cents}COP${SECRETO_INTEGRIDAD}`));
    expect(c).toMatchObject({ acceptance_token: 'acc_terminos_1', accept_personal_auth: 'acc_datos_1', customer_email: 'nequi@directo.test', payment_method: { type: 'NEQUI', phone_number: '3107654321' } });
    expect(c.redirect_url).toBe('https://omnegia.test/empezar/listo');
    expect(r.json()).toMatchObject({ referencia: c.reference, transaccion_id: '11854-1728506262-27959', estado: 'PENDING', accion: { tipo: 'nequi' } });
    // La constancia no guarda datos del pago.
    const auditoria = await E.db.withPlatform(async (t) => (await t.query(`SELECT detalle FROM audit_event WHERE accion='pago.directo_iniciado'`)).rows);
    expect(JSON.stringify(auditoria)).not.toContain('3107654321');
  });

  it('exige aceptar los términos de Wompi y valida cada método', async () => {
    const tk = await alta('validar');
    expect((await post(url(tk), { acepta_wompi: false, cliente, pago: nequi })).statusCode).toBe(400);
    expect((await post(url(tk), { cliente, pago: nequi })).statusCode).toBe(400);
    expect((await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'NEQUI', celular: '123' } })).statusCode).toBe(400);
    expect((await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'PSE', tipo_persona: 0, tipo_documento: 'CC', documento: 'abc', banco: '1007' } })).statusCode).toBe(400);
    expect((await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'CARD', token: 'no-es-token', cuotas: 1, navegador: {} } })).statusCode).toBe(400);
    expect((await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'DAVIPLATA' } })).statusCode).toBe(400);
    expect(llamadas.filter((l) => l.url.endsWith('/transactions') && l.metodo === 'POST')).toHaveLength(0);
  });

  it('tarjeta: manda el token, las cuotas y pide 3D Secure con los datos del navegador', async () => {
    const tk = await alta('tarjeta');
    const navegador = { browser_color_depth: '24', browser_screen_height: '1050', browser_screen_width: '1680', browser_language: 'es-CO', browser_user_agent: 'Mozilla/5.0', browser_tz: '300' };
    siguiente = (c) => ({ status: 201, body: { data: txWompi({ reference: c.reference, payment_method_type: 'CARD', payment_method: { type: 'CARD', extra: { is_three_ds: true } } }) } });
    const r = await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'CARD', token: 'tok_test_1234_abcdEFGH', cuotas: 3, navegador } });
    expect(r.statusCode, r.body).toBe(200);
    const c = llamadas.find((l) => l.metodo === 'POST' && l.url.endsWith('/transactions'))!.cuerpo;
    expect(c.payment_method).toEqual({ type: 'CARD', token: 'tok_test_1234_abcdEFGH', installments: 3 });
    expect(c.is_three_ds).toBe(true);
    // El sandbox de Wompi exige el escenario de 3DS; sin él la tarjeta no se procesa.
    expect(c.three_ds_auth_type).toBe('no_challenge_success');
    expect(c.customer_data.browser_info).toEqual(navegador);
    expect(r.json().accion).toEqual({ tipo: 'esperar', mensaje: 'Verificando tu tarjeta con tu banco…' });
  });

  it('PSE, botón Bancolombia y QR arman el cuerpo documentado', async () => {
    const tk = await alta('metodos');
    const pse = await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'PSE', tipo_persona: 0, tipo_documento: 'CC', documento: '1012345678', banco: '1007' } });
    expect(pse.statusCode, pse.body).toBe(200);
    let c = llamadas.filter((l) => l.metodo === 'POST' && l.url.endsWith('/transactions')).at(-1)!.cuerpo;
    expect(c.payment_method).toMatchObject({ type: 'PSE', user_type: 0, user_legal_id_type: 'CC', user_legal_id: '1012345678', financial_institution_code: '1007' });
    expect(c.payment_method.payment_description).not.toMatch(/'/);
    await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'BANCOLOMBIA_TRANSFER' } });
    c = llamadas.filter((l) => l.metodo === 'POST' && l.url.endsWith('/transactions')).at(-1)!.cuerpo;
    expect(c.payment_method).toMatchObject({ type: 'BANCOLOMBIA_TRANSFER', user_type: 'PERSON', ecommerce_url: 'https://omnegia.test/empezar/listo' });
    await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'BANCOLOMBIA_QR' } });
    c = llamadas.filter((l) => l.metodo === 'POST' && l.url.endsWith('/transactions')).at(-1)!.cuerpo;
    expect(c.payment_method).toMatchObject({ type: 'BANCOLOMBIA_QR' });
    // Los tres intentos reutilizan el mismo pago pendiente.
    const pagos = await E.db.withPlatform(async (t) => (await t.query(`SELECT count(*)::int AS n FROM payment WHERE draft_token=$1 AND estado='PENDIENTE'`, [tk])).rows[0].n);
    expect(pagos).toBe(1);
  });

  it('un error de Wompi se muestra sin su detalle crudo', async () => {
    const tk = await alta('error-wompi');
    siguiente = () => ({ status: 422, body: { error: { type: 'INPUT_VALIDATION_ERROR', messages: { payment_method: ['token: tok_secreto_no_mostrar'] } } } });
    const r = await post(url(tk), { acepta_wompi: true, cliente, pago: nequi });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('tok_secreto_no_mostrar');
    expect(r.json().error.message).toMatch(/Wompi no aceptó/);
  });

  it('sin datos completos de facturación no se cobra (las mismas reglas del checkout)', async () => {
    const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una tienda de ropa y vendo accesorios.', creacion_diferida: true })).json();
    await E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${d.token}`, payload: { negocio: { nombre: 'Sin facturación', email: 'sinfact@directo.test', slug: 'sinfact' } } });
    await verificarAlta(E, d.token);
    const r = await post(url(d.token), { acepta_wompi: true, cliente, pago: nequi });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.faltan).toContain('facturacion');
  });
});

describe('Seguimiento del pago', () => {
  it('traduce lo que Wompi pide a la persona: Nequi, banco, QR y desafío 3D Secure', () => {
    expect(accionDe(txWompi())).toMatchObject({ tipo: 'nequi' });
    expect(accionDe(txWompi({ payment_method_type: 'PSE', payment_method: { type: 'PSE', extra: {} } }))).toMatchObject({ tipo: 'esperar' });
    expect(accionDe(txWompi({ payment_method_type: 'PSE', payment_method: { type: 'PSE', extra: { async_payment_url: 'https://banco.example/pago?x=1' } } }))).toEqual({ tipo: 'redirigir', url: 'https://banco.example/pago?x=1' });
    // Una URL que no es https nunca llega al navegador.
    expect(accionDe(txWompi({ payment_method_type: 'PSE', payment_method: { type: 'PSE', extra: { async_payment_url: 'javascript:alert(1)' } } }))).toMatchObject({ tipo: 'esperar' });
    expect(accionDe(txWompi({ payment_method_type: 'BANCOLOMBIA_QR', payment_method: { type: 'BANCOLOMBIA_QR', extra: { qr_image: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' } } })))
      .toMatchObject({ tipo: 'qr', imagen: expect.stringMatching(/^data:image\/png;base64,iVBOR/) });
    expect(accionDe(txWompi({ payment_method_type: 'BANCOLOMBIA_QR', payment_method: { type: 'BANCOLOMBIA_QR', extra: { qr_image: '"><script>x</script>' } } }))).toMatchObject({ tipo: 'esperar' });
    const desafio = txWompi({ payment_method_type: 'CARD', payment_method: { type: 'CARD', extra: { three_ds_auth: { current_step: 'CHALLENGE', current_step_status: 'PENDING', three_ds_method_data: '&lt;iframe src=&#39;https://acs.example&#39;&gt;&lt;/iframe&gt;' } } } });
    expect(accionDe(desafio)).toEqual({ tipo: 'desafio_3ds', html: "<iframe src='https://acs.example'></iframe>" });
    expect(accionDe(txWompi({ status: 'APPROVED' }))).toEqual({ tipo: 'final' });
    expect(decodificarHtml('&amp;lt;')).toBe('&lt;');
  });

  it('una transacción ajena al borrador no se consulta', async () => {
    const tk = await alta('ajena');
    transacciones['otra-tx-1'] = txWompi({ id: 'otra-tx-1', reference: 'SUB-DE-OTRO' });
    expect((await get(url(tk, '/estado?tx=otra-tx-1'))).statusCode).toBe(404);
    expect((await get(url(tk, '/estado?tx=../../x'))).statusCode).toBe(404);
  });

  it('pendiente → aprobado: la aprobación sigue el camino de siempre y confirma el pago', async () => {
    const tk = await alta('aprobar');
    const r = (await post(url(tk), { acepta_wompi: true, cliente, pago: nequi })).json();
    const id = r.transaccion_id as string;
    transacciones[id] = txWompi({ id, reference: r.referencia });
    let e = (await get(url(tk, `/estado?tx=${id}`))).json();
    expect(e).toMatchObject({ estado: 'PENDIENTE', accion: { tipo: 'nequi' } });
    transacciones[id] = txWompi({ id, reference: r.referencia, status: 'APPROVED' });
    e = (await get(url(tk, `/estado?tx=${id}`))).json();
    expect(e).toMatchObject({ estado: 'APROBADO', accion: { tipo: 'final' } });
    const pago = await E.db.withPlatform(async (t) => (await t.query(`SELECT estado, transaccion_id FROM payment WHERE referencia=$1`, [r.referencia])).rows[0]);
    expect(pago).toEqual({ estado: 'APROBADO', transaccion_id: id });
    // Repetir la consulta no cobra ni activa nada de nuevo.
    expect((await get(url(tk, `/estado?tx=${id}`))).json().estado).toBe('APROBADO');
  });

  it('rechazado: informa el motivo y deja volver a intentar con otro método', async () => {
    const tk = await alta('rechazo');
    const r = (await post(url(tk), { acepta_wompi: true, cliente, pago: nequi })).json();
    const id = r.transaccion_id as string;
    transacciones[id] = txWompi({ id, reference: r.referencia, status: 'DECLINED', status_message: 'Fondos insuficientes' });
    expect((await get(url(tk, `/estado?tx=${id}`))).json()).toMatchObject({ estado: 'RECHAZADO', mensaje: 'Fondos insuficientes' });
    const otra = await post(url(tk), { acepta_wompi: true, cliente, pago: { metodo: 'BANCOLOMBIA_QR' } });
    expect(otra.statusCode, otra.body).toBe(200);
    expect(otra.json().referencia).toMatch(/^SUB-/);
  });
});

describe('Pasarela simulada', () => {
  it('registra el intento y deja aprobar o rechazar con la pasarela de demostración', async () => {
    config.pagos.proveedor = 'simulada';
    const tk = await alta('simulada');
    const r = await post(url(tk), { acepta_wompi: true, cliente, pago: nequi });
    expect(r.json()).toMatchObject({ simulado: true, estado: 'PENDIENTE', accion: { tipo: 'simulado' } });
    expect(llamadas).toHaveLength(0);
    expect((await get(url(tk, '/estado'))).json().estado).toBe('PENDIENTE');
    await post('/api/pasarela/simular', { ref: r.json().referencia });
    expect((await get(url(tk, '/estado'))).json().estado).toBe('APROBADO');
  });
});

describe('Cuerpo de la transacción', () => {
  it('la firma cambia si cambia el monto: no se puede reutilizar para otro valor', () => {
    const cuenta = { proveedor: 'wompi' as const, entorno: 'sandbox' as const, llavePublica: 'pub_test_x', secretoIntegridad: SECRETO_INTEGRIDAD };
    const base = { referencia: 'SUB-1', montoCentavos: 100, descripcion: 'x', redirectUrl: 'https://a.test/b', cliente: { email: 'a@b.co', nombre: 'A B', telefono: '3001112233' }, datos: { metodo: 'BANCOLOMBIA_QR' as const },
      aceptacion: { terminos: { token: 't', permalink: 'https://x.test' }, datos: { token: 'd', permalink: 'https://x.test' } } };
    const a = cuerpoTransaccion(cuenta, base).signature, b = cuerpoTransaccion(cuenta, { ...base, montoCentavos: 101 }).signature;
    expect(a).not.toBe(b);
  });

  it('tarjeta: el escenario de 3DS va solo en sandbox, y sin 3DS si la cuenta no lo tiene', () => {
    const navegador = { browser_color_depth: '24', browser_screen_height: '900', browser_screen_width: '1440', browser_language: 'es-CO', browser_user_agent: 'x', browser_tz: '300' };
    const t = { referencia: 'SUB-2', montoCentavos: 100, descripcion: 'x', redirectUrl: 'https://a.test/b', cliente: { email: 'a@b.co', nombre: 'A B', telefono: '3001112233' },
      datos: { metodo: 'CARD' as const, token: 'tok_test_1_x', cuotas: 1, navegador }, aceptacion: { terminos: { token: 't', permalink: 'https://x.test' }, datos: { token: 'd', permalink: 'https://x.test' } } };
    const base = { proveedor: 'wompi' as const, llavePublica: 'pub_x', secretoIntegridad: SECRETO_INTEGRIDAD };
    expect(cuerpoTransaccion({ ...base, entorno: 'sandbox', tresDSPrueba: 'challenge_v2' }, t)).toMatchObject({ is_three_ds: true, three_ds_auth_type: 'challenge_v2' });
    expect(cuerpoTransaccion({ ...base, entorno: 'sandbox', tresDSPrueba: 'inventado' }, t).three_ds_auth_type).toBe('no_challenge_success');
    const prod = cuerpoTransaccion({ ...base, entorno: 'produccion' }, t);
    expect(prod.is_three_ds).toBe(true);
    expect(prod).not.toHaveProperty('three_ds_auth_type');
    const sin = cuerpoTransaccion({ ...base, entorno: 'produccion', tresDS: false }, t);
    expect(sin).not.toHaveProperty('is_three_ds');
    expect((sin.customer_data as any).browser_info).toBeUndefined();
  });
});
