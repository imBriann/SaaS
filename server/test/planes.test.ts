import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';

/**
 * Planes de la empresa: catálogo con precio mensual y anual, cambio de plan con prorrateo calculado en el
 * servidor (el navegador no fija el precio), cambios programados que se deshacen, renovación anual,
 * precio pactado de quien ya pagaba y el periodo de gracia real.
 */
let E: Env;
let admin: ReturnType<typeof api>;
let gym: ReturnType<typeof api>;
const DIA = 86_400_000;

const periodo = (tenant: string, diasPasados: number, diasRestantes: number) =>
  E.db.withPlatform((tx) => tx.query(
    `UPDATE subscription SET estado='ACTIVA', gracia_hasta=NULL, periodo_inicio = now() - $2::int * interval '1 day', periodo_fin = now() + $3::int * interval '1 day' WHERE tenant_id=$1`,
    [tenant, diasPasados, diasRestantes]));
const sus = (tenant: string) => E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM subscription WHERE tenant_id=$1`, [tenant])).rows[0]);
const pagar = (ref: string) => E.app.inject({ method: 'POST', url: '/api/pasarela/simular', payload: { ref, resultado: 'aprobado' } });

beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Catálogo de planes', () => {
  it('muestra los tres planes con su precio mensual y anual (12 meses por 10) y marca el actual', async () => {
    const r = await admin.get('/suscripcion/planes');
    expect(r.status).toBe(200);
    expect(r.body.actual).toBe('negocio');
    expect(r.body.ciclo).toBe('MENSUAL');
    expect(r.body.planes.map((p: any) => [p.codigo, p.mensual, p.anual])).toEqual([['esencial', 99_000, 990_000], ['negocio', 229_000, 2_290_000], ['pro', 549_000, 5_490_000]]);
    const negocio = r.body.planes.find((p: any) => p.codigo === 'negocio');
    expect(negocio).toMatchObject({ actual: true, ahorro_anual: 229_000 * 2 });
    expect(negocio.caracteristicas.join(' ')).toMatch(/6 personas.*1\.200 respuestas.*300 facturas/);
  });

  it('solo quien administra la suscripción ve y cambia el plan', async () => {
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await laura.get('/suscripcion/planes')).status).toBe(403);
    expect((await laura.post('/suscripcion/cambio', { plan: 'pro', ciclo: 'MENSUAL', cargo: 0 })).status).toBe(403);
  });
});

describe('Subir de plan en el mismo ciclo', () => {
  let referencia = '';
  it('cotiza la diferencia solo por los días que quedan del periodo', async () => {
    await periodo(E.A, 15, 15);
    const c = (await admin.get('/suscripcion/cambio?plan=pro&ciclo=MENSUAL')).body;
    expect(c.tipo).toBe('INMEDIATO');
    expect(c.dias_restantes).toBe(15);
    // (549.000 − 229.000) × 15/30, redondeado a centenas.
    expect(c.cargo).toBe(160_000);
    expect(c.proximo_cobro.monto).toBe(549_000);
  });

  it('un cargo distinto del calculado no se cobra: se devuelve la cotización vigente', async () => {
    const r = await admin.post('/suscripcion/cambio', { plan: 'pro', ciclo: 'MENSUAL', cargo: 1_000 });
    expect(r.status).toBe(409);
    expect(r.body.error.details.cotizacion.cargo).toBe(160_000);
    const n = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int n FROM payment WHERE tenant_id=$1 AND cambio_plan IS NOT NULL`, [E.A])).rows[0].n);
    expect(n).toBe(0);
    expect((await admin.post('/suscripcion/cambio', { plan: 'institucional', ciclo: 'MENSUAL', cargo: 0 })).status).toBe(400);
  });

  it('con el cargo correcto abre el checkout; el plan solo cambia cuando el pago se aprueba', async () => {
    const finAntes = new Date((await sus(E.A)).periodo_fin).getTime();
    const r = await admin.post('/suscripcion/cambio', { plan: 'pro', ciclo: 'MENSUAL', cargo: 160_000 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tipo: 'PAGO', monto: 160_000 });
    referencia = r.body.referencia;
    expect(r.body.url).toContain(referencia);
    expect((await sus(E.A)).plan_codigo).toBe('negocio');
    expect((await admin.get(`/suscripcion/pagos/${referencia}`)).body.estado).toBe('PENDIENTE');

    await pagar(referencia);
    const s = await sus(E.A);
    expect(s.plan_codigo).toBe('pro');
    expect(new Date(s.periodo_fin).getTime()).toBe(finAntes);
    const p = (await admin.get(`/suscripcion/pagos/${referencia}`)).body;
    expect(p).toMatchObject({ estado: 'APROBADO', monto: 160_000, plan_codigo: 'pro', metodo_detalle: 'Tarjeta de prueba •••• 4242' });
    expect(p.cambio_plan.de.plan).toBe('negocio');
  });

  it('el pago queda en los movimientos con el próximo cobro del plan nuevo', async () => {
    const m = (await admin.get('/suscripcion/movimientos')).body;
    expect(m.pagos[0]).toMatchObject({ referencia, monto: 160_000, plan_nombre: 'Pro' });
    expect(m.proximo).toMatchObject({ monto: 549_000, plan: 'Pro' });
  });

  it('una referencia de otra empresa no se puede consultar', async () => {
    expect((await gym.get(`/suscripcion/pagos/${referencia}`)).status).toBe(404);
    expect((await gym.get(`/suscripcion/pagos/no-es-ref`)).status).toBe(404);
  });
});

describe('Bajar de plan', () => {
  it('queda programado para la renovación, cambia el próximo cobro y se puede deshacer', async () => {
    await periodo(E.A, 10, 20);
    const c = (await admin.get('/suscripcion/cambio?plan=negocio&ciclo=MENSUAL')).body;
    expect(c).toMatchObject({ tipo: 'PROGRAMADO', cargo: 0 });
    expect(c.modulos_que_se_apagan).toEqual([]);
    const r = await admin.post('/suscripcion/cambio', { plan: 'negocio', ciclo: 'MENSUAL', cargo: 0 });
    expect(r.body.tipo).toBe('PROGRAMADO');
    expect((await sus(E.A)).plan_codigo).toBe('pro');
    const info = (await admin.get('/suscripcion')).body;
    expect(info.suscripcion.cambio_programado).toMatchObject({ plan: 'negocio', ciclo: 'MENSUAL' });
    expect(info.renovacion.monto).toBe(229_000);
    // Adelantar la renovación aplicaría el plan nuevo antes de que termine lo pagado.
    expect((await admin.post('/suscripcion/pagar')).status).toBe(409);

    const d = await admin.del('/suscripcion/cambio');
    expect(d.body.deshecho).toBe(true);
    expect((await sus(E.A)).cambio_programado).toBeNull();
    expect((await admin.get('/suscripcion')).body.renovacion.monto).toBe(549_000);
  });

  it('no deja bajar a un plan con menos personas de las que tienen acceso', async () => {
    const c = (await admin.get('/suscripcion/cambio?plan=esencial&ciclo=MENSUAL')).body;
    expect(c.bloqueo).toMatch(/personas con acceso/);
    expect((await admin.post('/suscripcion/cambio', { plan: 'esencial', ciclo: 'MENSUAL', cargo: 0 })).status).toBe(409);
  });
});

describe('Pago anual', () => {
  it('pasar a anual descuenta lo que queda del mes y empieza un año desde hoy', async () => {
    await periodo(E.B, 20, 10);
    const c = (await gym.get('/suscripcion/cambio?plan=pro&ciclo=ANUAL')).body;
    expect(c.tipo).toBe('INMEDIATO');
    // 549.000 × 10/30 de crédito.
    expect(c.credito).toBe(183_000);
    expect(c.cargo).toBe(5_490_000 - 183_000);
    const r = await gym.post('/suscripcion/cambio', { plan: 'pro', ciclo: 'ANUAL', cargo: c.cargo });
    expect(r.body.tipo).toBe('PAGO');
    await pagar(r.body.referencia);
    const s = await sus(E.B);
    expect(s.ciclo).toBe('ANUAL');
    expect(new Date(s.periodo_fin).getTime()).toBeGreaterThan(Date.now() + 364 * DIA);
  });

  it('la renovación anual cobra 10 meses y extiende 12', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET estado='PAGO_PENDIENTE', periodo_fin = now() - interval '1 day' WHERE tenant_id=$1`, [E.B]));
    const info = (await gym.get('/suscripcion')).body;
    expect(info.renovacion).toMatchObject({ ciclo: 'ANUAL', monto: 5_490_000 });
    const p = await gym.post('/suscripcion/pagar');
    expect(p.body).toMatchObject({ monto: 5_490_000, ciclo: 'ANUAL' });
    await pagar(p.body.referencia);
    const s = await sus(E.B);
    expect(s.estado).toBe('ACTIVA');
    expect(new Date(s.periodo_fin).getTime()).toBeGreaterThan(Date.now() + 364 * DIA);
    const periodos = (await gym.get('/suscripcion')).body.periodos;
    expect(periodos[0]).toMatchObject({ ciclo: 'ANUAL', monto_pagado: 5_490_000 });
  });

  it('volver a mensual queda programado para cuando termine el año', async () => {
    const c = (await gym.get('/suscripcion/cambio?plan=pro&ciclo=MENSUAL')).body;
    expect(c.tipo).toBe('PROGRAMADO');
    expect(new Date(c.aplica_desde).getTime()).toBeGreaterThan(Date.now() + 364 * DIA);
  });
});

describe('Precio pactado y gracia', () => {
  it('quien ya pagaba conserva su precio en su plan; al cambiar de plan pasa al precio vigente', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET precio_pactado=149000, ciclo='MENSUAL' WHERE tenant_id=$1`, [E.A]));
    await periodo(E.A, 15, 15);
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET plan_codigo='negocio' WHERE tenant_id=$1`, [E.A]));
    await E.db.withPlatform((tx) => tx.query(`UPDATE tenant SET plan_codigo='negocio' WHERE id=$1`, [E.A]));
    const planes = (await admin.get('/suscripcion/planes')).body.planes;
    expect(planes.find((p: any) => p.codigo === 'negocio')).toMatchObject({ mensual: 149_000, pactado: true });
    expect((await admin.get('/suscripcion')).body.renovacion.monto).toBe(149_000);
    // Subir desde el precio pactado: diferencia (549.000 − 149.000) × 15/30.
    expect((await admin.get('/suscripcion/cambio?plan=pro&ciclo=MENSUAL')).body.cargo).toBe(200_000);
  });

  it('en gracia muestra los días reales que quedan y qué se pausa', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET estado='EN_GRACIA', periodo_fin=now() - interval '3 days', gracia_hasta = now() + interval '4 days' - interval '1 hour' WHERE tenant_id=$1`, [E.A]));
    const info = (await admin.get('/suscripcion')).body;
    expect(info.gracia).toMatchObject({ dias_total: 7, dias_restantes: 4 });
    expect(info.solo_lectura.pausa[0]).toMatch(/IA/);
    // Estando vencida, cambiar de plan es renovar con el plan elegido.
    const c = (await admin.get('/suscripcion/cambio?plan=esencial&ciclo=MENSUAL')).body;
    expect(c.tipo).toBe('RENOVAR');
  });
});
