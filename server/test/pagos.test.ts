import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, login, api, CRED, type Env, loginOperador, op } from './helpers.js';
import { drain, HANDLERS } from '../src/worker/jobs.js';
import { digitoVerificacionNit } from '../src/adapters/fiscal.js';

/**
 * Pagos: cobros del comercio con Wompi (firma, idempotencia, monto, otra empresa),
 * verificación del retorno sin confiar en el navegador, ciclo de la suscripción y
 * aprovisionamiento que falla y se recupera sin cobrar dos veces.
 */
let E: Env;
let admin: ReturnType<typeof api>;
const SECRETO_EVENTOS = 'test_events_secreto_del_comercio';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });
afterEach(() => { vi.unstubAllGlobals(); });

function eventoWompi(tx: { id: string; status: string; amount_in_cents: number; reference: string }, secreto = SECRETO_EVENTOS) {
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = sha(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${secreto}`).toUpperCase();
  return { event: 'transaction.updated', data: { transaction: { ...tx, currency: 'COP' } }, environment: 'test', signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum }, timestamp, sent_at: new Date().toISOString() };
}

describe('Cobros del comercio con Wompi', () => {
  let webhookUrl = '';
  let venta = { id: '', total: 0 };
  let referencia = '';

  it('vincula la cuenta (secretos cifrados, nunca devueltos) y genera un enlace firmado', async () => {
    expect((await admin.post('/configuracion/pasarela', { proveedor: 'wompi', entorno: 'produccion', llave_publica: 'pub_test_abc123', secreto_integridad: 'test_integrity_123456', secreto_eventos: SECRETO_EVENTOS })).status).toBe(400);
    const r = await admin.post('/configuracion/pasarela', { proveedor: 'wompi', entorno: 'sandbox', llave_publica: 'pub_test_abc123', secreto_integridad: 'test_integrity_123456', secreto_eventos: SECRETO_EVENTOS });
    expect(r.status).toBe(200);
    webhookUrl = new URL(r.body.webhook_url).pathname;
    const conf = JSON.stringify((await admin.get('/configuracion')).body.pasarela);
    expect(conf).not.toMatch(/test_integrity|test_events/);
    const guardado = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT secreto_eventos_cifrado FROM merchant_gateway_account WHERE tenant_id=$1`, [E.A])).rows[0].secreto_eventos_cifrado);
    expect(guardado).not.toContain(SECRETO_EVENTOS);

    const cliente = (await admin.get('/clientes?q=Mateo')).body.clientes[0].id;
    const corte = (await admin.get('/productos')).body.find((p: any) => p.nombre === 'Corte clásico').id;
    const v = await admin.post('/ventas', { customer_id: cliente, items: [{ product_id: corte, cantidad: 2 }] });
    venta = { id: v.body.id, total: v.body.total };
    const l = (await admin.post(`/ventas/${venta.id}/enlace-pago`)).body;
    referencia = l.referencia;
    const url = new URL(l.enlace);
    expect(url.host).toBe('checkout.wompi.co');
    expect(url.searchParams.get('amount-in-cents')).toBe(String(venta.total * 100));
    expect(url.searchParams.get('signature:integrity')).toBe(sha(`${referencia}${venta.total * 100}COP${url.searchParams.get('expiration-time')}test_integrity_123456`));
  });

  it('webhook con firma inválida o monto distinto no marca la venta como pagada', async () => {
    const malo = eventoWompi({ id: 'tx-1', status: 'APPROVED', amount_in_cents: venta.total * 100, reference: referencia }, 'otro-secreto');
    expect((await E.app.inject({ method: 'POST', url: webhookUrl, payload: malo })).statusCode).toBe(401);
    const menos = eventoWompi({ id: 'tx-2', status: 'APPROVED', amount_in_cents: 100, reference: referencia });
    expect((await E.app.inject({ method: 'POST', url: webhookUrl, payload: menos })).json().estado).toBe('MONTO_NO_COINCIDE');
    expect((await admin.get(`/ventas/${venta.id}`)).body.estado_pago).toBe('PENDIENTE');
  });

  it('un rechazo deja el enlace abierto para reintentar; la aprobación válida concilia una sola vez', async () => {
    const declinado = eventoWompi({ id: 'tx-3', status: 'DECLINED', amount_in_cents: venta.total * 100, reference: referencia });
    await E.app.inject({ method: 'POST', url: webhookUrl, payload: declinado });
    let d = (await admin.get(`/ventas/${venta.id}`)).body;
    expect(d.estado_pago).toBe('PENDIENTE');
    expect(d.enlaces[0]).toMatchObject({ estado: 'ABIERTO', ultimo_estado_proveedor: 'RECHAZADO' });
    const ok = eventoWompi({ id: 'tx-4', status: 'APPROVED', amount_in_cents: venta.total * 100, reference: referencia });
    const [a, b] = await Promise.all([E.app.inject({ method: 'POST', url: webhookUrl, payload: ok }), E.app.inject({ method: 'POST', url: webhookUrl, payload: ok })]);
    expect([a.json().duplicado, b.json().duplicado].filter(Boolean)).toHaveLength(1);
    d = (await admin.get(`/ventas/${venta.id}`)).body;
    expect(d.estado_pago).toBe('PAGADA');
    expect(d.enlaces[0].estado).toBe('PAGADO');
    const conciliados = (await admin.get('/auditoria?q=cobro.conciliado')).body.filter((e: any) => e.recurso_id === venta.id);
    expect(conciliados).toHaveLength(1);
  });

  it('el webhook de una empresa no concilia referencias de otra', async () => {
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    const r = await gym.post('/configuracion/pasarela', { proveedor: 'wompi', entorno: 'sandbox', llave_publica: 'pub_test_gym', secreto_integridad: 'gym_integrity_1234', secreto_eventos: 'gym_events_secreto_1234' });
    const urlGym = new URL(r.body.webhook_url).pathname;
    const cliente = (await admin.get('/clientes?q=Sebasti')).body.clientes[0].id;
    const corte = (await admin.get('/productos')).body.find((p: any) => p.nombre === 'Corte clásico').id;
    const v = (await admin.post('/ventas', { customer_id: cliente, items: [{ product_id: corte, cantidad: 1 }] })).body;
    const l = (await admin.post(`/ventas/${v.id}/enlace-pago`)).body;
    const ev = eventoWompi({ id: 'tx-cruzado', status: 'APPROVED', amount_in_cents: v.total * 100, reference: l.referencia }, 'gym_events_secreto_1234');
    expect((await E.app.inject({ method: 'POST', url: urlGym, payload: ev })).json().ignorado).toBe('referencia de otra empresa');
    expect((await admin.get(`/ventas/${v.id}`)).body.estado_pago).toBe('PENDIENTE');
  });

  it('el retorno del navegador no confirma nada por sí solo: el servidor consulta la transacción a Wompi', async () => {
    const cliente = (await admin.get('/clientes?q=Felipe')).body.clientes[0].id;
    const corte = (await admin.get('/productos')).body.find((p: any) => p.nombre === 'Corte clásico').id;
    const v = (await admin.post('/ventas', { customer_id: cliente, items: [{ product_id: corte, cantidad: 1 }] })).body;
    const l = (await admin.post(`/ventas/${v.id}/enlace-pago`)).body;
    // Sin respuesta de la pasarela: no se marca nada aunque el navegador diga «aprobado».
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    const sin = (await E.app.inject({ method: 'GET', url: '/api/pagos/verificar?id=tx-retorno&status=APPROVED' })).json();
    expect(sin.estado).toBe('DESCONOCIDO');
    expect((await admin.get(`/ventas/${v.id}`)).body.estado_pago).toBe('PENDIENTE');
    // Con la consulta servidor a servidor confirmando la transacción, se concilia.
    const llamadas: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      llamadas.push(String(url));
      return new Response(JSON.stringify({ data: { id: 'tx-retorno', status: 'APPROVED', amount_in_cents: v.total * 100, reference: l.referencia, currency: 'COP' } }), { status: 200 });
    }));
    const con = (await E.app.inject({ method: 'GET', url: '/api/pagos/verificar?id=tx-retorno' })).json();
    expect(con.estado).toBe('APROBADO');
    expect(llamadas[0]).toBe('https://sandbox.wompi.co/v1/transactions/tx-retorno');
    expect((await admin.get(`/ventas/${v.id}`)).body.estado_pago).toBe('PAGADA');
  });
});

describe('Suscripción de la plataforma (distinta de los cobros del negocio)', () => {
  it('vencida → pago pendiente → gracia → suspendida (solo lectura, canal pausado) → pago → reactivada', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET periodo_fin = now() - interval '3 days' WHERE tenant_id=$1`, [E.A]));
    await HANDLERS.ciclo_suscripcion(E.db, null, {}, {});
    expect((await admin.get('/yo')).body.tenant.suscripcion).toBe('PAGO_PENDIENTE');
    await HANDLERS.ciclo_suscripcion(E.db, null, {}, {});
    expect((await admin.get('/yo')).body.tenant.suscripcion).toBe('EN_GRACIA');
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET gracia_hasta = now() - interval '1 minute' WHERE tenant_id=$1`, [E.A]));
    await HANDLERS.ciclo_suscripcion(E.db, null, {}, {});
    const yo = (await admin.get('/yo')).body;
    expect(yo.tenant.suscripcion).toBe('SUSPENDIDA');
    expect(yo.solo_lectura).toBe(true);
    expect((await admin.get('/clientes')).status).toBe(200);
    expect((await admin.post('/clientes', { nombre: 'No debe crearse' })).status).toBe(423);
    // Cada cambio avisa al correo de la empresa.
    await drain(E.db);
    const avisos = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT asunto FROM email_outbox WHERE tenant_id IS NULL AND para='admin@elparche.test' ORDER BY creado_en`)).rows.map((r: any) => r.asunto));
    expect(avisos.join(' | ')).toMatch(/venció.*gracia.*suspendida/);
    // El pago (aún suspendida) reactiva y extiende el periodo desde hoy.
    const pago = await admin.post('/suscripcion/pagar');
    expect(pago.status).toBe(200);
    const repetido = await admin.post('/suscripcion/pagar');
    expect(repetido.body.referencia).toBe(pago.body.referencia);
    await E.app.inject({ method: 'POST', url: '/api/pasarela/simular', payload: { ref: pago.body.referencia, resultado: 'aprobado', entregas: 2 } });
    const s = (await admin.get('/suscripcion')).body.suscripcion;
    expect(s.estado).toBe('ACTIVA');
    expect(new Date(s.periodo_fin).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    expect((await admin.post('/clientes', { nombre: 'Ya se puede' })).status).toBe(200);
  });

  it('el administrador de la plataforma suspende y reactiva con motivo auditado', async () => {
    const plat = op(E.app, await loginOperador(E.app, E.db));
    const sin = await plat.post(`/empresas/${E.B}/estado`, { estado: 'SUSPENDIDA', confirmacion: 'fuerzanorte' });
    expect(sin.status).toBe(400);
    expect((await plat.post(`/empresas/${E.B}/estado`, { estado: 'SUSPENDIDA', motivo: 'Mora de 60 días sin acuerdo', confirmacion: 'fuerzanorte' })).status).toBe(200);
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    expect((await gym.get('/yo')).body.solo_lectura).toBe(true);
    expect((await plat.post(`/empresas/${E.B}/estado`, { estado: 'ACTIVA', motivo: 'Acuerdo de pago firmado', confirmacion: 'fuerzanorte' })).status).toBe(200);
    expect((await gym.get('/yo')).body.solo_lectura).toBe(false);
    const ev = await E.db.withTenant(E.B, async (tx) => (await tx.query(`SELECT accion FROM audit_event WHERE accion LIKE 'plataforma.%' ORDER BY creado_en`)).rows.map((r: any) => r.accion));
    expect(ev).toEqual(expect.arrayContaining(['plataforma.estado_suspendida', 'plataforma.estado_activa']));
  });
});

describe('Aprovisionamiento recuperable', () => {
  it('si el alta falla después del pago, queda el pago aprobado, se muestra el error y el reintento crea UNA empresa sin cobrar otra vez', async () => {
    const post = (url: string, payload?: unknown) => E.app.inject({ method: 'POST', url, payload: payload as any });
    const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una barbería pequeña en Ocaña, atiendo yo solo con citas por WhatsApp.' })).json();
    await E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${d.token}`, payload: { negocio: { nombre: 'Barbería Recupera', email: 'dueno@recupera.test', slug: 'recupera', nit: `901999888-${digitoVerificacionNit('901999888')}` } } });
    const pago = (await post(`/api/onboarding/borradores/${d.token}/pago`)).json();
    // Se fuerza un fallo del alta: el plan congelado del borrador desaparece antes del pago.
    await E.db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET plan_codigo='esencial' WHERE token=$1`, [d.token]));
    await E.db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET clasificacion = clasificacion || '{"sector":"inexistente"}'::jsonb WHERE token=$1`, [d.token]));
    const r = (await post('/api/pasarela/simular', { ref: pago.referencia, resultado: 'aprobado' })).json();
    expect(r.entregas[0].status).toBe(200);
    let st = (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${d.token}/estado` })).json();
    expect(st.estado).not.toBe('APROVISIONADO');
    expect(st.pago.estado).toBe('APROBADO');
    expect(st.error_aprovisionamiento).toMatch(/No pudimos terminar/);
    expect(await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int n FROM tenant WHERE slug='recupera'`)).rows[0].n)).toBe(0);
    // Se corrige la causa y se reintenta (manual o por el trabajador): una empresa, un pago.
    await E.db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET clasificacion = clasificacion || '{"sector":"barberia"}'::jsonb WHERE token=$1`, [d.token]));
    const [x, y] = await Promise.all([post(`/api/onboarding/borradores/${d.token}/reintentar`), post(`/api/onboarding/borradores/${d.token}/reintentar`)]);
    expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
    // Una nueva entrega del mismo webhook tampoco duplica nada.
    await post('/api/pasarela/simular', { ref: pago.referencia, resultado: 'aprobado', entregas: 2 });
    st = (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${d.token}/estado` })).json();
    expect(st.estado).toBe('APROVISIONADO');
    expect(st.error_aprovisionamiento).toBeNull();
    const n = await E.db.withPlatform(async (tx) => ({
      tenants: (await tx.query(`SELECT count(*)::int n FROM tenant WHERE slug LIKE 'recupera%'`)).rows[0].n,
      pagos: (await tx.query(`SELECT count(*)::int n FROM payment WHERE draft_token=$1 AND estado='APROBADO'`, [d.token])).rows[0].n,
      usuarios: (await tx.query(`SELECT count(*)::int n FROM users WHERE email='dueno@recupera.test'`)).rows[0].n,
    }));
    expect(n).toEqual({ tenants: 1, pagos: 1, usuarios: 1 });
  });
});
