import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';

/**
 * Correcciones del panel: Inicio sin «ciclo fiscal» (con DIAN apagada), Ventas (filtros del historial, nota por
 * línea), Configuración sin el estado técnico de los proveedores y solicitud de cambio de plan.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
let cera = '';

beforeAll(async () => {
  E = await setup();
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
  cera = (await sql(`SELECT id FROM product WHERE tenant_id=$1 AND nombre='Cera para peinar'`, [E.A])).rows[0].id;
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Inicio con la facturación DIAN apagada', () => {
  it('no envía el ciclo fiscal y resume las ventas de hoy', async () => {
    const antes = (await A.get('/inicio')).body;
    expect(antes).not.toHaveProperty('fiscal');
    expect(antes.atencion.some((x: any) => x.tipo === 'factura_rechazada')).toBe(false);
    expect(antes.ventas_hoy).toMatchObject({ n: expect.any(Number), total: expect.any(Number), comprobantes: expect.any(Number), ia: expect.any(Number) });
    const v = await A.post('/ventas', { mostrador: true, items: [{ product_id: cera, cantidad: 2 }], pago: { metodo: 'EFECTIVO' } });
    expect(v.status).toBe(200);
    const despues = (await A.get('/inicio')).body.ventas_hoy;
    expect(despues.n).toBe(antes.ventas_hoy.n + 1);
    expect(despues.total).toBeGreaterThan(antes.ventas_hoy.total);
  });
});

describe('Historial de ventas', () => {
  it('filtra por período y origen, y devuelve los totales de todo el filtro', async () => {
    const hoy = (await A.get('/ventas?periodo=hoy')).body;
    expect(hoy.ventas.length).toBeGreaterThan(0);
    expect(hoy.totales).toMatchObject({ vigentes: expect.any(Number), vendido: expect.any(Number), por_cobrar: expect.any(Number) });
    expect(hoy.totales.vendido).toBeGreaterThan(0);
    expect((await A.get('/ventas?periodo=hoy&origen=PANEL')).body.ventas.every((x: any) => x.origen === 'PANEL')).toBe(true);
    expect((await A.get('/ventas?origen=AGENTE')).body.ventas.every((x: any) => x.origen === 'AGENTE')).toBe(true);
    // Un período desconocido se ignora (no rompe ni filtra de más).
    expect((await A.get('/ventas?periodo=ayer-mismo')).status).toBe(200);
    // Los totales cuentan todo el filtro, no solo la página.
    const pag = (await A.get('/ventas?por_pagina=10')).body;
    expect(pag.totales.vigentes).toBeGreaterThanOrEqual(pag.ventas.filter((x: any) => x.estado === 'CONFIRMADA').length);
  });

  it('guarda la nota de cada línea y la muestra en el detalle', async () => {
    const r = await A.post('/ventas', { mostrador: true, items: [{ product_id: cera, cantidad: 1, nota: 'Sin bolsa, es regalo' }] });
    expect(r.status).toBe(200);
    const d = (await A.get(`/ventas/${r.body.id}`)).body;
    expect(d.items[0].nota).toBe('Sin bolsa, es regalo');
    expect((await A.post('/ventas', { mostrador: true, items: [{ product_id: cera, cantidad: 1, nota: 'x'.repeat(201) }] })).status).toBe(400);
  });

  it('los clientes se pueden pedir por compra más reciente', async () => {
    const r = (await A.get('/clientes?por_pagina=10&orden=reciente')).body;
    expect(r.clientes.length).toBeGreaterThan(0);
  });
});

describe('Configuración sin integraciones para las empresas', () => {
  it('la empresa no recibe el estado técnico de los proveedores', async () => {
    const c = (await A.get('/configuracion')).body;
    expect(c).not.toHaveProperty('integraciones');
    expect(c).not.toHaveProperty('webhook_whatsapp');
    const pub = await E.app.inject({ method: 'GET', url: '/api/publico/estado' });
    expect(pub.json()).not.toHaveProperty('integraciones');
    expect(pub.json()).toHaveProperty('simuladores');
  });
});

describe('Solicitar el cambio de plan', () => {
  it('en modalidad institucional no se cotiza, pero se puede solicitar el cambio (abre un caso)', async () => {
    const plan = (await sql(`SELECT plan_codigo FROM subscription WHERE tenant_id=$1`, [E.A])).rows[0].plan_codigo;
    await sql(`UPDATE subscription SET modalidad='INSTITUCIONAL' WHERE tenant_id=$1`, [E.A]);
    const otro = plan === 'negocio' ? 'pro' : 'negocio';
    const cat = (await A.get('/suscripcion/planes')).body;
    expect(cat.modalidad).toBe('INSTITUCIONAL');
    expect(cat.planes.length).toBeGreaterThan(1);
    const cot = await A.get(`/suscripcion/cambio?plan=${otro}&ciclo=MENSUAL`);
    expect(cot.status).toBe(409);
    expect(cot.body.error.message).toMatch(/institucional/);

    const antes = (await sql(`SELECT count(*)::int AS n FROM soporte_ticket WHERE tenant_id=$1`, [E.A])).rows[0].n;
    const s = await A.post('/suscripcion/solicitar-cambio', { plan: otro, ciclo: 'MENSUAL', nota: 'Necesitamos más personas' });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ ok: true, numero: expect.stringMatching(/^SOP-/) });
    expect(s.body.mensaje).toMatch(/Recibimos tu solicitud/);
    const t = (await sql(`SELECT categoria, asunto FROM soporte_ticket WHERE tenant_id=$1 ORDER BY creado_en DESC LIMIT 1`, [E.A])).rows[0];
    expect((await sql(`SELECT count(*)::int AS n FROM soporte_ticket WHERE tenant_id=$1`, [E.A])).rows[0].n).toBe(antes + 1);
    expect(t.categoria).toBe('FACTURACION');
    expect(t.asunto).toMatch(/cambio de plan/i);
    // Pedir el plan que ya tiene no abre nada.
    expect((await A.post('/suscripcion/solicitar-cambio', { plan, ciclo: (await A.get('/suscripcion/planes')).body.ciclo })).status).toBe(400);
    expect((await A.post('/suscripcion/solicitar-cambio', { plan: 'inexistente' })).status).toBe(400);
    await sql(`UPDATE subscription SET modalidad='COMERCIAL' WHERE tenant_id=$1`, [E.A]);
  });

  it('exige el permiso de gestionar la suscripción', async () => {
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await laura.post('/suscripcion/solicitar-cambio', { plan: 'pro' })).status).toBe(403);
    expect((await B.get('/suscripcion/planes')).status).toBe(200);
  });
});
