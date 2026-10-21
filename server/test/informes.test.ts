import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { Informe } from '../src/ai/visual.js';

/** Informes: cifras reales del periodo, en la plantilla de Omnegia, solo para quien puede verlas. */
let E: Env;
let admin: ReturnType<typeof api>;
let andres: ReturnType<typeof api>;
let gym: ReturnType<typeof api>;
beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  andres = api(E.app, await login(E.app, ...CRED.andres), 'elparche');
  gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Informes', () => {
  it('lista solo los informes que el rol y los módulos permiten', async () => {
    const a = (await admin.get('/informes')).body.tipos;
    expect(a).toEqual(expect.arrayContaining(['ventas', 'cobros', 'agenda', 'clientes']));
  });

  it('el de ventas suma lo mismo que el inicio y cumple la plantilla', async () => {
    const r = await admin.get('/informes/ventas?periodo=semana');
    expect(r.status).toBe(200);
    expect(() => Informe.parse(r.body.informe)).not.toThrow();
    const inicio = (await admin.get('/inicio')).body;
    const barras = r.body.informe.secciones[0].grafica.series[0].valores as number[];
    expect(barras).toHaveLength(7);
    expect(barras.reduce((a, b) => a + b, 0)).toBeCloseTo(inicio.cifras.ventas_semana, 0);
    expect(r.body.informe.cifras[1].valor).toBe(String(inicio.mes.n_semana));
  });

  it('cada tipo se genera con datos válidos, también en un rango largo (por semanas)', async () => {
    for (const tipo of ['cobros', 'agenda', 'clientes', 'inventario']) {
      const r = await admin.get(`/informes/${tipo}?periodo=mes`);
      expect(r.status, tipo).toBe(200);
      expect(() => Informe.parse(r.body.informe)).not.toThrow();
    }
    const largo = await admin.get('/informes/ventas?periodo=rango&desde=2026-07-01&hasta=2026-09-15');
    expect(largo.status).toBe(200);
    expect(largo.body.informe.secciones[0].titulo).toMatch(/semana/);
  });

  it('valida el periodo y el tipo', async () => {
    expect((await admin.get('/informes/ventas?periodo=rango&desde=2026-01-01&hasta=2026-12-31')).status).toBe(400);
    expect((await admin.get('/informes/ventas?periodo=rango&desde=2026-10-10&hasta=2026-10-01')).status).toBe(400);
    expect((await admin.get('/informes/nomina')).status).toBe(400);
  });

  it('cada empresa ve solo sus cifras', async () => {
    const a = (await admin.get('/informes/clientes?periodo=mes')).body.informe;
    const g = (await gym.get('/informes/clientes?periodo=mes')).body.informe;
    expect(a.cifras[3].valor).not.toBe(g.cifras[3].valor);
  });

  it('un rol sin permiso no abre el informe', async () => {
    const tipos = (await andres.get('/informes')).body.tipos as string[];
    for (const t of ['ventas', 'cobros', 'agenda', 'clientes', 'inventario'].filter((x) => !tipos.includes(x))) {
      expect([400, 403]).toContain((await andres.get(`/informes/${t}`)).status);
    }
  });
});
