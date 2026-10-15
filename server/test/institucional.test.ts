import { verificarAlta } from './helpers.js';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { config, erroresWompi, institucionalDisponible, validarConfiguracion } from '../src/config.js';
import { digitoVerificacionNit } from '../src/adapters/fiscal.js';
import { verificarEventoWompi } from '../src/adapters/payments.js';
import { conciliarPagosPendientes } from '../src/modules/billing.js';
import { drain, HANDLERS } from '../src/worker/jobs.js';
import { PLANES } from '../src/onboarding/planRules.js';

/**
 * Modalidad institucional con Wompi de producción. Ninguna prueba sale a la red:
 * `fetch` está siempre simulado y las credenciales son ficticias con los prefijos reales.
 */
let E: Env;
const SECRETO_EVENTOS = 'prod_events_secreto_ficticio_1234';
const SECRETO_INTEGRIDAD = 'prod_integrity_secreto_ficticio_1234';
const LLAVE_PRIVADA = 'prv_prod_llave_ficticia_1234';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const original = { pagos: structuredClone(config.pagos), institucional: { ...config.institucional }, publicUrl: config.publicUrl, simuladores: config.simuladores };
const llamadas: { url: string; auth: string | null }[] = [];
let respuestaWompi: (url: string) => Response = () => new Response('{}', { status: 404 });

function modoInstitucional(activo = true) {
  config.publicUrl = 'https://omnegia.test';
  config.pagos.proveedor = 'wompi';
  config.pagos.wompi = { entorno: 'produccion', llavePublica: 'pub_prod_llave_ficticia', llavePrivada: LLAVE_PRIVADA, secretoIntegridad: SECRETO_INTEGRIDAD, secretoEventos: SECRETO_EVENTOS };
  config.institucional = { activo, precioCop: 1500, dias: 30 };
}

function restaurar() {
  config.pagos = structuredClone(original.pagos);
  config.institucional = { ...original.institucional };
  config.publicUrl = original.publicUrl;
  config.simuladores = original.simuladores;
}

function eventoWompi(tx: { id: string; status: string; amount_in_cents: number; reference: string; currency?: string }, o: { secreto?: string; environment?: string } = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = sha(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${o.secreto ?? SECRETO_EVENTOS}`).toUpperCase();
  return { event: 'transaction.updated', data: { transaction: { currency: 'COP', ...tx } }, environment: o.environment ?? 'prod', signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum }, timestamp, sent_at: new Date().toISOString() };
}

const post = (url: string, payload?: unknown) => E.app.inject({ method: 'POST', url, payload: payload as any });
const webhook = (payload: unknown) => E.app.inject({ method: 'POST', url: '/api/webhooks/wompi', payload: payload as any });
const estado = async (tk: string) => (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}/estado` })).json();
const contar = (sql: string, p: unknown[] = []) => E.db.withPlatform(async (tx) => (await tx.query(sql, p)).rows[0].n as number);

/** Datos de facturación de prueba: la contraseña de los documentos queda en 1012345678. */
export const FACTURACION = (slug: string) => ({ nombre: `Contratante ${slug}`, tipo_documento: 'CC', numero_documento: '1.012.345.678', email: `facturas@${slug}.test`, telefono: '+57 300 123 4567', direccion: 'Calle 10 # 5-20', ciudad: 'Ocaña', departamento: 'Norte de Santander' });

async function borrador(slug: string, conFacturacion = true) {
  const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una barbería pequeña en Ocaña, atiendo yo solo con citas por WhatsApp.' })).json();
  await E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${d.token}`, payload: { negocio: { nombre: `Empresa ${slug}`, email: `dueno@${slug}.test`, slug, nit: '901222333', nit_dv:String(digitoVerificacionNit('901222333')) } } });
  if (conFacturacion) {
    const f = await E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${d.token}`, payload: { facturacion: FACTURACION(slug) } });
    if (f.statusCode !== 200) throw new Error(`facturación: ${f.body}`);
  }
  await verificarAlta(E,d.token);
  return d.token as string;
}

beforeAll(async () => { E = await setup(); });
afterAll(async () => { restaurar(); await E.app.close(); await E.db.close(); });
beforeEach(() => {
  llamadas.length = 0;
  respuestaWompi = () => new Response('{}', { status: 404 });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    llamadas.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
    return respuestaWompi(String(url));
  }));
  modoInstitucional();
});
afterEach(() => { vi.unstubAllGlobals(); restaurar(); });

describe('Configuración de Wompi y de la modalidad institucional', () => {
  it('rechaza llaves de otro ambiente y exige la configuración completa antes de contratar', () => {
    modoInstitucional();
    expect(institucionalDisponible().ok).toBe(true);
    // Llaves de pruebas con WOMPI_ENTORNO=produccion: error de arranque y contratación bloqueada.
    config.pagos.wompi = { ...config.pagos.wompi, llavePrivada: 'prv_test_xxx', secretoEventos: 'test_events_xxx' };
    const e = erroresWompi().join('\n');
    expect(e).toMatch(/WOMPI_LLAVE_PRIVADA es de pruebas/);
    expect(e).toMatch(/WOMPI_SECRETO_EVENTOS es de pruebas/);
    expect(validarConfiguracion().errores.join('\n')).toMatch(/prv_prod_/);
    expect(institucionalDisponible().ok).toBe(false);
    // Formato desconocido.
    modoInstitucional();
    config.pagos.wompi.secretoIntegridad = 'cualquier-cosa';
    expect(erroresWompi().join('\n')).toMatch(/WOMPI_SECRETO_INTEGRIDAD no tiene el formato/);
    // Sin llave privada en producción no se puede verificar: bloqueado.
    modoInstitucional();
    config.pagos.wompi.llavePrivada = undefined;
    expect(institucionalDisponible().motivos.join(' ')).toMatch(/WOMPI_LLAVE_PRIVADA/);
    // Ambiente de pruebas o pasarela simulada: nunca para cobros institucionales.
    modoInstitucional();
    config.pagos.wompi = { entorno: 'sandbox', llavePublica: 'pub_test_x', llavePrivada: 'prv_test_x', secretoIntegridad: 'test_integrity_x', secretoEventos: 'test_events_x' };
    expect(institucionalDisponible().motivos.join(' ')).toMatch(/WOMPI_ENTORNO=produccion/);
    modoInstitucional();
    config.pagos.proveedor = 'simulada';
    expect(institucionalDisponible().ok).toBe(false);
  });

  it('valida el precio y la vigencia configurables', () => {
    for (const precioCop of [0, 1499, 1500.5, Number.NaN, 20_000_000]) {
      modoInstitucional();
      config.institucional.precioCop = precioCop;
      expect(institucionalDisponible().motivos.join(' ')).toMatch(/PRECIO_INSTITUCIONAL_COP/);
    }
    for (const dias of [0, 366, 2.5]) {
      modoInstitucional();
      config.institucional.dias = dias;
      expect(institucionalDisponible().motivos.join(' ')).toMatch(/ACCESO_INSTITUCIONAL_DIAS/);
    }
    modoInstitucional();
    config.institucional.precioCop = 2500;
    expect(institucionalDisponible().ok).toBe(true);
  });

  it('con la configuración incompleta no se puede iniciar el pago ni se cae al cobro comercial', async () => {
    const tk = await borrador('incompleta');
    config.pagos.wompi.secretoEventos = undefined;
    const d = (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}` })).json();
    expect(d.pago_disponible).toBe(false);
    expect(d.modalidad.disponible).toBe(false);
    const r = await post(`/api/onboarding/borradores/${tk}/pago`);
    expect(r.statusCode).toBe(409);
    expect(await contar(`SELECT count(*)::int n FROM payment WHERE draft_token=$1`, [tk])).toBe(0);
  });
});

describe('Cobro institucional', () => {
  let tk = '';
  let ref = '';

  it('cobra exactamente PRECIO_INSTITUCIONAL_COP (150000 centavos) con firma de integridad y conserva la referencia comercial', async () => {
    tk = await borrador('institucional');
    const d = (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}` })).json();
    expect(d.oferta).toMatchObject({ modalidad: 'INSTITUCIONAL', monto: 1500, acceso_dias: 30 });
    expect(d.oferta.monto_referencia).toBe(d.cotizacion.total);
    expect(d.modalidad).toMatchObject({ disponible: true, cobro_real: true, renovacion_automatica: false });
    // Un monto enviado por el navegador se ignora: el servidor decide.
    const r = await post(`/api/onboarding/borradores/${tk}/pago`, { monto: 1, amount_in_cents: 100, modalidad: 'COMERCIAL' });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    ref = p.referencia;
    expect(p).toMatchObject({ monto: 1500, modalidad: 'INSTITUCIONAL', acceso_dias: 30 });
    const url = new URL(p.url);
    expect(url.origin + url.pathname).toBe('https://checkout.wompi.co/p/');
    expect(url.searchParams.get('amount-in-cents')).toBe('150000');
    expect(url.searchParams.get('currency')).toBe('COP');
    expect(url.searchParams.get('public-key')).toBe('pub_prod_llave_ficticia');
    expect(url.searchParams.get('redirect-url')).toBe('https://omnegia.test/empezar/listo');
    const expira = url.searchParams.get('expiration-time')!;
    expect(new Date(expira).getTime()).toBeGreaterThan(Date.now());
    expect(url.searchParams.get('signature:integrity')).toBe(sha(`${ref}150000COP${expira}${SECRETO_INTEGRIDAD}`));
    // Ningún secreto viaja al navegador.
    expect(p.url).not.toMatch(/prv_prod|prod_integrity|prod_events/);
    const pago = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM payment WHERE referencia=$1`, [ref])).rows[0]);
    expect(pago).toMatchObject({ modalidad: 'INSTITUCIONAL', acceso_dias: 30, proveedor: 'wompi', entorno: 'produccion', estado: 'PENDIENTE' });
    expect(Number(pago.monto)).toBe(1500);
    expect(Number(pago.monto_referencia)).toBe(d.cotizacion.total);
    // Repetir el clic devuelve el mismo checkout (mismos términos).
    expect((await post(`/api/onboarding/borradores/${tk}/pago`)).json().referencia).toBe(ref);
    // Con el pago en curso el borrador (y lo que se cotizó) ya no se puede modificar.
    expect((await E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${tk}`, payload: { monto: 1 } })).statusCode).toBe(409);
  });

  it('rechaza eventos fraudulentos: firma inválida, ambiente de pruebas, monto o moneda distintos y la pasarela simulada', async () => {
    expect((await webhook(eventoWompi({ id: 'f-1', status: 'APPROVED', amount_in_cents: 150000, reference: ref }, { secreto: 'otro' }))).statusCode).toBe(401);
    expect((await webhook(eventoWompi({ id: 'f-2', status: 'APPROVED', amount_in_cents: 150000, reference: ref }, { environment: 'test' }))).statusCode).toBe(401);
    expect((await webhook(eventoWompi({ id: 'f-3', status: 'APPROVED', amount_in_cents: 100, reference: ref }))).json().ignorado).toBe('monto no coincide');
    expect((await webhook(eventoWompi({ id: 'f-4', status: 'APPROVED', amount_in_cents: 150000, reference: ref, currency: 'USD' }))).json().ignorado).toBe('monto no coincide');
    // La pasarela simulada no puede aprobar un cobro real aunque el entorno tenga simuladores.
    const sim = (await post('/api/pasarela/simular', { ref, resultado: 'aprobado', monto: 1500 })).json();
    expect(sim.entregas[0].body.ignorado).toBe('pasarela no coincide');
    // Referencia ajena: no aprovisiona nada.
    expect((await webhook(eventoWompi({ id: 'f-5', status: 'APPROVED', amount_in_cents: 150000, reference: 'SUB-inventada' }))).json().ignorado).toBe('referencia desconocida');
    expect((await estado(tk)).estado).toBe('PAGO_INICIADO');
    expect(await contar(`SELECT count(*)::int n FROM tenant WHERE slug='institucional'`)).toBe(0);
    const auditoria = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT accion FROM audit_event WHERE accion IN ('pago.monto_no_coincide','pago.pasarela_no_coincide','pago.referencia_desconocida','webhook.wompi.firma_invalida')`)).rows.map((x: any) => x.accion));
    expect(new Set(auditoria)).toEqual(new Set(['pago.monto_no_coincide', 'pago.pasarela_no_coincide', 'pago.referencia_desconocida', 'webhook.wompi.firma_invalida']));
  });

  it('un evento pendiente no aprovisiona', async () => {
    const r = (await webhook(eventoWompi({ id: 'tx-inst', status: 'PENDING', amount_in_cents: 150000, reference: ref }))).json();
    expect(r.estado).toBe('PENDIENTE');
    const st = await estado(tk);
    expect(st.estado).toBe('PAGO_INICIADO');
    expect(st.pago).toMatchObject({ estado: 'PENDIENTE', monto: 1500, modalidad: 'INSTITUCIONAL' });
  });

  it('la aprobación entregada tres veces a la vez crea UNA empresa con acceso institucional de 30 días desde la activación', async () => {
    const ev = eventoWompi({ id: 'tx-inst', status: 'APPROVED', amount_in_cents: 150000, reference: ref });
    const antes = Date.now();
    const rs = await Promise.all([webhook(ev), webhook(ev), webhook(ev)]);
    expect(rs.map((x) => x.statusCode)).toEqual([200, 200, 200]);
    expect(rs.filter((x) => x.json().duplicado)).toHaveLength(2);
    expect(await contar(`SELECT count(*)::int n FROM tenant WHERE slug='institucional'`)).toBe(1);
    const st = await estado(tk);
    expect(st.estado).toBe('APROVISIONADO');
    expect(st.acceso).toMatchObject({ modalidad: 'INSTITUCIONAL', monto_pagado: 1500, referencia: ref });
    const fin = new Date(st.acceso.vigente_hasta).getTime();
    expect(fin).toBeGreaterThanOrEqual(antes + 30 * 86_400_000 - 1000);
    expect(fin).toBeLessThan(Date.now() + 30 * 86_400_000 + 1000);
    const t = await E.db.withPlatform(async (tx) => (await tx.query(
      `SELECT s.modalidad, s.precio_pagado, s.condiciones, p.precio_mensual, sp.monto_pagado, sp.monto_referencia, pay.estado, pay.transaccion_id, pay.verificado_en
       FROM tenant t JOIN subscription s ON s.tenant_id=t.id JOIN plan p ON p.codigo=s.plan_codigo
       JOIN subscription_period sp ON sp.tenant_id=t.id JOIN payment pay ON pay.id=sp.payment_id WHERE t.slug='institucional'`)).rows);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ modalidad: 'INSTITUCIONAL', estado: 'APROBADO', transaccion_id: 'tx-inst' });
    expect(Number(t[0].precio_pagado)).toBe(1500);
    expect(Number(t[0].monto_pagado)).toBe(1500);
    expect(Number(t[0].monto_referencia)).toBe(Number(t[0].precio_mensual));
    expect(t[0].condiciones).toMatchObject({ renovacion_automatica: false, cobro_automatico: false, acceso_dias: 30 });
    expect(t[0].verificado_en).not.toBeNull();
    // Confirmación por correo encolada una sola vez, con el monto real.
    await drain(E.db);
    const correos = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT asunto FROM email_outbox WHERE para='facturas@institucional.test' AND clave_idempotencia LIKE 'pago:%'`)).rows);
    expect(correos).toHaveLength(1);
    // Un pago aprobado no permite generar otro cobro.
    expect((await post(`/api/onboarding/borradores/${tk}/pago`)).statusCode).toBe(409);
  });
});

describe('Rechazos, retrasos y recuperación', () => {
  it('un pago rechazado no crea la empresa y permite reintentar con una referencia nueva', async () => {
    const tk = await borrador('rechazada');
    const p1 = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    expect((await webhook(eventoWompi({ id: 'tx-rech', status: 'DECLINED', amount_in_cents: 150000, reference: p1.referencia }))).json().estado).toBe('RECHAZADO');
    let st = await estado(tk);
    expect(st.estado).toBe('BORRADOR');
    expect(st.pago.estado).toBe('RECHAZADO');
    expect(await contar(`SELECT count(*)::int n FROM tenant WHERE slug='rechazada'`)).toBe(0);
    const p2 = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    expect(p2.referencia).not.toBe(p1.referencia);
    // Un evento anulado tampoco crea nada.
    await webhook(eventoWompi({ id: 'tx-anul', status: 'VOIDED', amount_in_cents: 150000, reference: p2.referencia }));
    st = await estado(tk);
    expect(st.pago.estado).toBe('ANULADO');
    expect(await contar(`SELECT count(*)::int n FROM tenant WHERE slug='rechazada'`)).toBe(0);
  });

  it('webhook retrasado: el estado consulta a Wompi por la referencia con la llave privada y aprovisiona', async () => {
    const tk = await borrador('retrasada');
    const p = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    // Recién creado: no se consulta todavía.
    expect((await estado(tk)).pago.estado).toBe('PENDIENTE');
    expect(llamadas).toHaveLength(0);
    await E.db.withPlatform((tx) => tx.query(`UPDATE payment SET creado_en = now() - interval '1 minute' WHERE referencia=$1`, [p.referencia]));
    respuestaWompi = (url) => url.includes(`reference=${p.referencia}`)
      ? new Response(JSON.stringify({ data: [{ id: 'tx-tarde', status: 'APPROVED', amount_in_cents: 150000, reference: p.referencia, currency: 'COP' }] }), { status: 200 })
      : new Response('{}', { status: 404 });
    const st = await estado(tk);
    expect(llamadas[0]).toEqual({ url: `https://production.wompi.co/v1/transactions?reference=${p.referencia}`, auth: `Bearer ${LLAVE_PRIVADA}` });
    expect(st.estado).toBe('APROVISIONADO');
    // El webhook que llega después es un duplicado: no crea otra empresa.
    const tarde = (await webhook(eventoWompi({ id: 'tx-tarde', status: 'APPROVED', amount_in_cents: 150000, reference: p.referencia }))).json();
    expect(tarde.duplicado).toBe(true);
    expect(await contar(`SELECT count(*)::int n FROM tenant WHERE slug LIKE 'retrasada%'`)).toBe(1);
    // La consulta de Wompi también debe coincidir en monto: una transacción por otro valor no aprueba.
    const tk2 = await borrador('consultamal');
    const p2 = (await post(`/api/onboarding/borradores/${tk2}/pago`)).json();
    await E.db.withPlatform((tx) => tx.query(`UPDATE payment SET creado_en = now() - interval '1 minute' WHERE referencia=$1`, [p2.referencia]));
    respuestaWompi = () => new Response(JSON.stringify({ data: [{ id: 'tx-otro-monto', status: 'APPROVED', amount_in_cents: 1000, reference: p2.referencia, currency: 'COP' }] }), { status: 200 });
    expect((await estado(tk2)).estado).toBe('PAGO_INICIADO');
  });

  it('el retorno del navegador solo aporta el id: el servidor consulta la transacción con Bearer', async () => {
    const tk = await borrador('retorno');
    const p = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    const sin = (await E.app.inject({ method: 'GET', url: '/api/pagos/verificar?id=tx-ret&status=APPROVED' })).json();
    expect(sin.estado).toBe('DESCONOCIDO');
    expect((await estado(tk)).estado).toBe('PAGO_INICIADO');
    respuestaWompi = (url) => url.endsWith('/transactions/tx-ret')
      ? new Response(JSON.stringify({ data: { id: 'tx-ret', status: 'APPROVED', amount_in_cents: 150000, reference: p.referencia, currency: 'COP' } }), { status: 200 })
      : new Response('{}', { status: 404 });
    const con = (await E.app.inject({ method: 'GET', url: '/api/pagos/verificar?id=tx-ret' })).json();
    expect(con.estado).toBe('APROBADO');
    expect(llamadas.find((l) => l.url.endsWith('/transactions/tx-ret'))?.auth).toBe(`Bearer ${LLAVE_PRIVADA}`);
    expect((await estado(tk)).estado).toBe('APROVISIONADO');
  });

  it('si el alta falla tras el pago, el pago queda aprobado y el trabajo de conciliación la termina sin volver a cobrar', async () => {
    const tk = await borrador('recupera-inst');
    const p = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    await E.db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET clasificacion = clasificacion || '{"sector":"inexistente"}'::jsonb WHERE token=$1`, [tk]));
    await webhook(eventoWompi({ id: 'tx-rec', status: 'APPROVED', amount_in_cents: 150000, reference: p.referencia }));
    let st = await estado(tk);
    expect(st.pago.estado).toBe('APROBADO');
    expect(st.estado).not.toBe('APROVISIONADO');
    expect(st.error_aprovisionamiento).toMatch(/No pudimos terminar/);
    // Volver a pulsar «pagar» no genera otro cobro.
    const otra = await post(`/api/onboarding/borradores/${tk}/pago`);
    expect(otra.json().ya_pagado).toBe(true);
    expect(otra.json().url).toBeNull();
    await E.db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET clasificacion = clasificacion || '{"sector":"barberia"}'::jsonb WHERE token=$1`, [tk]));
    await E.db.withPlatform((tx) => tx.query(`UPDATE payment SET actualizado_en = now() - interval '5 minutes' WHERE referencia=$1`, [p.referencia]));
    await conciliarPagosPendientes(E.db, 'prueba-conciliacion');
    st = await estado(tk);
    expect(st.estado).toBe('APROVISIONADO');
    expect(await contar(`SELECT count(*)::int n FROM payment WHERE draft_token=$1`, [tk])).toBe(1);
    expect(await contar(`SELECT count(*)::int n FROM tenant WHERE slug LIKE 'recupera-inst%'`)).toBe(1);
  });
});

describe('Activación y desactivación', () => {
  it('desactivar recupera la lógica comercial, no reutiliza checkouts institucionales y no altera lo ya pagado', async () => {
    const tk = await borrador('alterna');
    const pInst = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    expect(pInst.monto).toBe(1500);
    const subsAntes = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT s.tenant_id, s.modalidad, s.periodo_fin, s.precio_pagado FROM subscription s WHERE s.modalidad='INSTITUCIONAL' ORDER BY tenant_id`)).rows);
    const aprobadosAntes = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT referencia, monto, estado FROM payment WHERE estado='APROBADO' ORDER BY referencia`)).rows);

    // MODO_INSTITUCIONAL=0 sin tarifas confirmadas: no se puede contratar (no hay cobro comercial silencioso).
    config.institucional.activo = false;
    config.pagos.tarifasConfirmadas = false;
    config.simuladores = false;
    expect((await post(`/api/onboarding/borradores/${tk}/pago`)).statusCode).toBe(409);
    // Con tarifas confirmadas: precio comercial, y el checkout institucional pendiente se reemplaza (no se reutiliza).
    config.pagos.tarifasConfirmadas = true;
    const d = (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}` })).json();
    expect(d.modalidad).toBeNull();
    expect(d.oferta).toMatchObject({ modalidad: 'COMERCIAL', monto: d.cotizacion.total, acceso_dias: null });
    const pCom = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    expect(pCom.referencia).not.toBe(pInst.referencia);
    expect(pCom.monto).toBe(d.cotizacion.total);
    expect(new URL(pCom.url).searchParams.get('amount-in-cents')).toBe(String(d.cotizacion.total * 100));
    const viejo = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado FROM payment WHERE referencia=$1`, [pInst.referencia])).rows[0]);
    expect(viejo.estado).toBe('REEMPLAZADO');
    // Lo ya pagado y las suscripciones institucionales no cambian.
    expect(await E.db.withPlatform(async (tx) => (await tx.query(`SELECT s.tenant_id, s.modalidad, s.periodo_fin, s.precio_pagado FROM subscription s WHERE s.modalidad='INSTITUCIONAL' ORDER BY tenant_id`)).rows)).toEqual(subsAntes);
    expect(await E.db.withPlatform(async (tx) => (await tx.query(`SELECT referencia, monto, estado FROM payment WHERE estado='APROBADO' ORDER BY referencia`)).rows)).toEqual(aprobadosAntes);
    // Reactivar: el checkout comercial pendiente tampoco se reutiliza para el precio institucional.
    config.institucional.activo = true;
    const pInst2 = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    expect(pInst2.monto).toBe(1500);
    expect([pInst.referencia, pCom.referencia]).not.toContain(pInst2.referencia);
    // Si el checkout reemplazado se pagara igual, se registra por su propio monto (no por el vigente).
    expect((await webhook(eventoWompi({ id: 'tx-viejo', status: 'APPROVED', amount_in_cents: 150000 * 2, reference: pInst.referencia }))).json().ignorado).toBe('monto no coincide');
  });

  it('las tarifas comerciales se conservan con el modo activo', async () => {
    const planes = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT codigo, precio_mensual FROM plan WHERE codigo IN ('esencial','negocio','pro') ORDER BY orden`)).rows);
    expect(planes.map((p: any) => [p.codigo, Number(p.precio_mensual)])).toEqual(PLANES.map((p) => [p.codigo, p.precio_mensual]));
    const q = (await post('/api/publico/cotizacion', { modulos: ['agenda', 'conversaciones'] })).json();
    config.institucional.activo = false;
    const qCom = (await post('/api/publico/cotizacion', { modulos: ['agenda', 'conversaciones'] })).json();
    expect(q.total).toBe(qCom.total);
    expect(q.lineas).toEqual(qCom.lineas);
    expect(q.oferta).toMatchObject({ modalidad: 'INSTITUCIONAL', monto: 1500, monto_referencia: q.total });
    expect(qCom.oferta).toMatchObject({ modalidad: 'COMERCIAL', monto: qCom.total });
  });
});

describe('Renovación sin cobros automáticos', () => {
  const slug = 'institucional';
  let admin: ReturnType<typeof api>;
  let tenantId = '';

  beforeAll(async () => {
    tenantId = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT id FROM tenant WHERE slug=$1`, [slug])).rows[0].id);
    await E.app.inject({ method: 'POST', url: `/api/onboarding/borradores/${await E.db.withPlatform(async (tx) => (await tx.query(`SELECT token FROM onboarding_draft WHERE tenant_id=$1`, [tenantId])).rows[0].token)}/contrasena`, payload: { password: 'clave-institucional-1' } });
    admin = api(E.app, await login(E.app, `dueno@${slug}.test`, 'clave-institucional-1'), slug);
  });

  it('antes del vencimiento avisa las condiciones y no genera ningún pago', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET periodo_fin = now() + interval '3 days' WHERE tenant_id=$1`, [tenantId]));
    const pagosAntes = await contar(`SELECT count(*)::int n FROM payment WHERE tenant_id=$1`, [tenantId]);
    await HANDLERS.ciclo_suscripcion(E.db, null, {}, {});
    await HANDLERS.ciclo_suscripcion(E.db, null, {}, {});
    const avisos = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT asunto FROM email_outbox WHERE clave_idempotencia LIKE 'vence-institucional:' || $1 || ':%'`, [tenantId])).rows);
    expect(avisos).toHaveLength(1);
    expect(avisos[0].asunto).toMatch(/acceso institucional vence/);
    expect(await contar(`SELECT count(*)::int n FROM payment WHERE tenant_id=$1`, [tenantId])).toBe(pagosAntes);
    expect((await admin.get('/suscripcion')).body.suscripcion.estado).toBe('ACTIVA');
  });

  it('renovar exige confirmar el precio institucional vigente y extiende 30 días sin autorización recurrente', async () => {
    const info = (await admin.get('/suscripcion')).body;
    expect(info.suscripcion.modalidad).toBe('INSTITUCIONAL');
    expect(info.renovacion).toMatchObject({ disponible: true, modalidad: 'INSTITUCIONAL', monto: 1500, acceso_dias: 30, requiere_aceptacion: false, requiere_confirmacion: true });
    expect(info.periodos).toHaveLength(1);
    // Sin confirmar lo mostrado (o con otro monto): no se genera el cobro.
    expect((await admin.post('/suscripcion/pagar')).status).toBe(409);
    expect((await admin.post('/suscripcion/pagar', { modalidad: 'INSTITUCIONAL', monto: 1 })).status).toBe(409);
    // El precio cambió entre lo mostrado y el clic: se pide confirmar de nuevo.
    config.institucional.precioCop = 2000;
    expect((await admin.post('/suscripcion/pagar', { modalidad: 'INSTITUCIONAL', monto: 1500 })).status).toBe(409);
    config.institucional.precioCop = 1500;
    const r = await admin.post('/suscripcion/pagar', { modalidad: 'INSTITUCIONAL', monto: 1500 });
    expect(r.status).toBe(200);
    expect(new URL(r.body.url).searchParams.get('amount-in-cents')).toBe('150000');
    const finAntes = new Date(info.suscripcion.periodo_fin).getTime();
    await webhook(eventoWompi({ id: 'tx-renov', status: 'APPROVED', amount_in_cents: 150000, reference: r.body.referencia }));
    const s = (await admin.get('/suscripcion')).body;
    expect(new Date(s.suscripcion.periodo_fin).getTime()).toBe(finAntes + 30 * 86_400_000);
    expect(s.suscripcion.modalidad).toBe('INSTITUCIONAL');
    expect(s.periodos).toHaveLength(2);
    expect(s.periodos[0].condiciones).toMatchObject({ renovacion_automatica: false, cobro_automatico: false });
  });

  it('si termina la modalidad institucional, el plan comercial exige aceptación expresa y nunca se cobra solo', async () => {
    config.institucional.activo = false;
    config.pagos.tarifasConfirmadas = true;
    const info = (await admin.get('/suscripcion')).body;
    expect(info.renovacion).toMatchObject({ modalidad: 'COMERCIAL', requiere_aceptacion: true, requiere_confirmacion: true });
    const precio = info.renovacion.monto;
    expect(precio).toBe(info.suscripcion.precio_mensual);
    // Sin aceptar: nada. El ciclo de suscripción tampoco convierte ni cobra.
    expect((await admin.post('/suscripcion/pagar', { modalidad: 'COMERCIAL', monto: precio })).status).toBe(409);
    await HANDLERS.ciclo_suscripcion(E.db, null, {}, {});
    expect((await admin.get('/suscripcion')).body.suscripcion.modalidad).toBe('INSTITUCIONAL');
    const r = await admin.post('/suscripcion/pagar', { modalidad: 'COMERCIAL', monto: precio, acepto: true });
    expect(r.status).toBe(200);
    const aceptacion = await E.db.withTenant(tenantId, async (tx) => (await tx.query(`SELECT detalle FROM audit_event WHERE accion='suscripcion.aceptacion_comercial'`)).rows);
    expect(aceptacion).toHaveLength(1);
    expect(aceptacion[0].detalle).toMatchObject({ modalidad: 'COMERCIAL', monto: precio, aceptado: true });
  });
});

describe('Aislamiento', () => {
  it('el historial de periodos pagados es por empresa y el rol de ejecución no lee los pagos', async () => {
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    expect((await gym.get('/suscripcion')).body.periodos).toEqual([]);
    const otro = await E.db.withTenant(E.B, async (tx) => (await tx.query(`SELECT count(*)::int n FROM subscription_period`)).rows[0].n);
    expect(otro).toBe(0);
    await expect(E.db.withTenant(E.B, (tx) => tx.query(`SELECT * FROM payment`))).rejects.toThrow(/permission denied/);
    await expect(E.db.withTenant(E.B, (tx) => tx.query(`INSERT INTO subscription_period (id, tenant_id, modalidad, plan_codigo, monto_pagado, periodo_inicio, periodo_fin) VALUES (gen_random_uuid(), $1, 'INSTITUCIONAL', 'esencial', 0, now(), now())`, [E.B]))).rejects.toThrow(/permission denied/);
    // La evidencia no se reescribe.
    await expect(E.db.withPlatform((tx) => tx.query(`UPDATE subscription_period SET monto_pagado=0`))).rejects.toThrow(/permission denied/);
  });

  it('un evento firmado para la cuenta de un comercio no confirma pagos de la plataforma', () => {
    const cuentaComercio = { proveedor: 'wompi' as const, entorno: 'produccion' as const, secretoEventos: 'prod_events_del_comercio' };
    const ev = eventoWompi({ id: 'x', status: 'APPROVED', amount_in_cents: 150000, reference: 'SUB-x' }, { secreto: 'prod_events_del_comercio' });
    expect(verificarEventoWompi(cuentaComercio, ev)).not.toBeNull();
    expect(verificarEventoWompi({ ...cuentaComercio, secretoEventos: SECRETO_EVENTOS }, ev)).toBeNull();
  });
});

describe('Vuelta de la pasarela sin perder el alta', () => {
  it('solo se vuelve a orígenes permitidos', async () => {
    const { origenRetorno } = await import('../src/config.js');
    const c = { ...config, publicUrl: 'https://omnegia.test', baseDomain: 'omnegia.test', dev: false };
    expect(origenRetorno('https://omnegia.test', c)).toBe('https://omnegia.test');
    expect(origenRetorno('https://huellitas.omnegia.test', c)).toBe('https://huellitas.omnegia.test');
    for (const malo of ['https://evil.test', 'http://huellitas.omnegia.test', 'https://omnegia.test.evil.test', 'https://omnegia.test/otra', 'javascript:alert(1)', '', null]) expect(origenRetorno(malo, c)).toBeNull();
    expect(origenRetorno('http://localhost:5173', c)).toBeNull();
    expect(origenRetorno('http://localhost:5173', { ...c, dev: true })).toBe('http://localhost:5173');
  });

  it('Wompi devuelve al mismo dominio donde empezó el alta (y nunca a uno ajeno)', async () => {
    const baseOriginal = config.baseDomain;
    config.baseDomain = 'omnegia.test';
    try {
    const tk = await borrador('retorno-origen');
    const p = (await post(`/api/onboarding/borradores/${tk}/pago`, { retorno: 'https://retorno-origen.omnegia.test' })).json();
    expect(new URL(p.url).searchParams.get('redirect-url')).toBe('https://retorno-origen.omnegia.test/empezar/listo');
    const ajeno = (await post(`/api/onboarding/borradores/${tk}/pago`, { retorno: 'https://evil.test' })).json();
    expect(new URL(ajeno.url).searchParams.get('redirect-url')).toBe('https://omnegia.test/empezar/listo');
    } finally { config.baseDomain = baseOriginal; }
  });

  it('sin la llave en el navegador: confirma con Wompi, envía el enlace al correo verificado y nunca devuelve la llave', async () => {
    const tk = await borrador('rescate');
    const p = (await post(`/api/onboarding/borradores/${tk}/pago`)).json();
    respuestaWompi = (url) => url.endsWith('/transactions/tx-rescate')
      ? new Response(JSON.stringify({ data: { id: 'tx-rescate', status: 'APPROVED', amount_in_cents: 150000, reference: p.referencia, currency: 'COP' } }), { status: 200 })
      : new Response('{}', { status: 404 });
    // El webhook nunca llegó: la vuelta misma confirma el pago y crea la empresa.
    const r = await post('/api/onboarding/retorno', { id: 'tx-rescate' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ alta: true, pago: 'APROBADO', creada: true, empresa: 'Empresa rescate', correo: 'd•••@rescate.test', enviado: true });
    expect(r.body).not.toContain(tk);
    expect((await estado(tk)).estado).toBe('APROVISIONADO');
    // Recargar la página no inunda el correo.
    await post('/api/onboarding/retorno', { id: 'tx-rescate' });
    const enlaces = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT tipo, sensible, para FROM email_outbox WHERE tipo='continuar_alta' AND para='dueno@rescate.test'`)).rows);
    // Uno por la creación de la empresa y uno por la vuelta (ventana de 15 minutos); todos sensibles y al correo verificado.
    expect(enlaces.length).toBe(2);
    expect(enlaces.every((x: any) => x.sensible)).toBe(true);
    // Una transacción desconocida no revela nada.
    respuestaWompi = () => new Response('{}', { status: 404 });
    expect((await post('/api/onboarding/retorno', { id: 'tx-ajena' })).json()).toEqual({ estado: 'DESCONOCIDO', alta: false });
  });
});
