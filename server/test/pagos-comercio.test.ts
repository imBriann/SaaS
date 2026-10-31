import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { config } from '../src/config.js';

/**
 * Pagos de comercio por WhatsApp (docs/pagos-whatsapp.md). Nunca se hace una transacción real: Wompi se simula.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
const comercioOriginal = { ...config.comercio };

beforeAll(async () => {
  E = await setup();
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => { Object.assign(config.comercio, comercioOriginal); await E.app.close(); await E.db.close(); });

describe('Fase 2 · Métodos de pago', () => {
  it('por defecto: pagos reales apagados, modo institucional de $1.500 y nada activo', async () => {
    const r = (await A.get('/pagos/ajustes')).body;
    expect(r).toMatchObject({ pago_manual: false, pago_en_linea: false, en_linea_disponible: false });
    expect(r.precios).toEqual({ modo: 'institutional_test', cargo_fijo_cop: 1500, pagos_reales: false });
    expect(r.motivo_en_linea).toMatch(/PAYMENTS_LIVE_ENABLED/);
  });

  it('el pago en línea no se puede activar mientras el operador no habilite los pagos reales', async () => {
    const r = await A.patch('/pagos/ajustes', { pago_manual: false, pago_en_linea: true });
    expect(r.status).toBe(400);
  });

  it('el pago manual exige al menos un dato de pago y valida cada tipo', async () => {
    expect((await A.patch('/pagos/ajustes', { pago_manual: true, pago_en_linea: false })).status).toBe(400);
    expect((await A.post('/pagos/cuentas', { tipo: 'NEQUI', titular: 'Barbería El Parche', valor: '12345' })).status).toBe(400);
    expect((await A.post('/pagos/cuentas', { tipo: 'CUENTA_BANCARIA', titular: 'El Parche', valor: '123456789' })).status).toBe(400);
    const c = await A.post('/pagos/cuentas', { tipo: 'NEQUI', titular: 'Barbería El Parche', valor: '300 123 4567', instrucciones: 'Envía el comprobante por este chat' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ tipo: 'NEQUI', tipo_nombre: 'Nequi', activo: true });
    const r = await A.patch('/pagos/ajustes', { pago_manual: true, pago_en_linea: false });
    expect(r.status).toBe(200);
    expect(r.body.pago_manual).toBe(true);
    expect(r.body.cuentas).toHaveLength(1);
  });

  it('otra empresa no ve ni modifica los datos de pago (404)', async () => {
    const id = (await A.get('/pagos/ajustes')).body.cuentas[0].id;
    expect((await B.get('/pagos/ajustes')).body.cuentas).toHaveLength(0);
    expect((await B.put(`/pagos/cuentas/${id}`, { tipo: 'NEQUI', titular: 'Intruso', valor: '3009999999' })).status).toBe(404);
    expect((await B.del(`/pagos/cuentas/${id}`)).status).toBe(404);
  });

  it('recepción (sin configurar la empresa) no cambia los métodos', async () => {
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await laura.patch('/pagos/ajustes', { pago_manual: false, pago_en_linea: false })).status).toBe(403);
    expect((await laura.post('/pagos/cuentas', { tipo: 'NEQUI', titular: 'X', valor: '3001112233' })).status).toBe(403);
  });

  it('FORCE RLS en todas las tablas nuevas', async () => {
    const r = (await sql(`SELECT relname, relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = ANY($1) ORDER BY relname`,
      [['commerce_payment', 'financial_ledger', 'merchant_payment_account', 'payment_event', 'payment_reconciliation']])).rows;
    expect(r).toHaveLength(5);
    expect(r.every((x: any) => x.r && x.f)).toBe(true);
  });
});
