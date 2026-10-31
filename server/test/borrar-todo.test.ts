import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, loginOperador, op, type Env } from './helpers.js';
import { borrarTodo, carpetasDeArchivos, FRASE_CONFIRMACION, tablasDeDatos, TABLA_MIGRACIONES, validarArgumentos } from '../src/seed/borrado.js';
import { crearOperador } from '../src/seed/cuentaOperador.js';
import { ensurePlatformCatalog } from '../src/onboarding/provisioning.js';
import { seedDemo } from '../src/seed/demo.js';

/**
 * `npm run borrar-todo` sobre una base TEMPORAL de prueba (PGlite en memoria, o el PostgreSQL de
 * test:postgres). Nunca contra una base real.
 */
let E: Env;
let carpeta = '';

const conteo = async () => E.db.raw(async (tx) => {
  const out: Record<string, number> = {};
  for (const t of await tablasDeDatos(tx)) out[t] = Number((await tx.query(`SELECT count(*)::bigint AS n FROM "${t}"`)).rows[0].n);
  return out;
});
const migraciones = () => E.db.raw(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM ${TABLA_MIGRACIONES}`)).rows[0].n as number);

beforeAll(async () => {
  E = await setup();
  carpeta = mkdtempSync(join(tmpdir(), 'omnegia-buzon-'));
  mkdirSync(join(carpeta, 'sub'));
  writeFileSync(join(carpeta, 'correo.html'), '<p>prueba</p>');
  writeFileSync(join(carpeta, 'sub', 'otro.txt'), 'x');
  // Una tabla «futura» creada por una migración de prueba: debe vaciarse sin estar en ninguna lista.
  await E.db.execScript(`CREATE TABLE prueba_futura (id int PRIMARY KEY, dato text); INSERT INTO prueba_futura VALUES (1, 'a'), (2, 'b');`);
});
afterAll(async () => {
  rmSync(carpeta, { recursive: true, force: true });
  await E.app.close();
  await E.db.close();
});

describe('Argumentos de la consola', () => {
  it('en producción se niega sin --produccion', () => {
    expect(validarArgumentos([], { NODE_ENV: 'production' })).toMatchObject({ error: expect.stringMatching(/--produccion/) });
    expect(validarArgumentos(['--aplicar', '--respaldo', 'r.json'], { NODE_ENV: 'production' })).toHaveProperty('error');
    expect(validarArgumentos(['--produccion'], { NODE_ENV: 'production' })).toHaveProperty('opciones');
    expect(validarArgumentos(['--aplicar', '--sin-respaldo', '--produccion', '--con-demo'], { NODE_ENV: 'production' })).toHaveProperty('error');
  });
  it('con --aplicar exige --respaldo o --sin-respaldo explícito', () => {
    expect(validarArgumentos(['--aplicar'], {})).toHaveProperty('error');
    expect(validarArgumentos(['--aplicar', '--respaldo', 'r.json'], {})).toMatchObject({ opciones: { aplicar: true, respaldo: 'r.json' } });
    expect(validarArgumentos(['--aplicar', '--sin-respaldo', '--confirmar', FRASE_CONFIRMACION], {})).toMatchObject({ opciones: { confirmacion: FRASE_CONFIRMACION } });
    expect(validarArgumentos(['--borra-rapido'], {})).toHaveProperty('error');
  });
  it('las carpetas de archivos nunca apuntan al código, a node_modules ni a data/', () => {
    for (const c of carpetasDeArchivos()) expect(c).not.toMatch(/[\\/](src|node_modules|data)([\\/]|$)/);
  });
});

describe('Simulacro y confirmación', () => {
  it('el simulacro cuenta y no cambia ninguna fila ni archivo', async () => {
    const antes = await conteo();
    const r = await borrarTodo(E.db, { aplicar: false, carpetas: [carpeta] });
    expect(r.aplicado).toBe(false);
    expect(r.total).toBeGreaterThan(0);
    expect(r.tablas.map((t) => t.tabla)).toEqual(expect.arrayContaining(['tenant', 'users', 'audit_event', 'comprobante_venta', 'prueba_futura']));
    expect(r.tablas.map((t) => t.tabla)).not.toContain(TABLA_MIGRACIONES);
    expect(r.carpetas[0].archivos).toBe(2);
    expect(await conteo()).toEqual(antes);
    expect(readdirSync(carpeta).length).toBe(2);
  });

  it('sin la frase exacta no borra nada', async () => {
    const antes = await conteo();
    for (const confirmacion of [undefined, '', 'borrar todo', 'BORRAR', 'BORRAR TODO ']) {
      await expect(borrarTodo(E.db, { aplicar: true, confirmacion, carpetas: [carpeta] })).rejects.toThrow(/BORRAR TODO/);
    }
    expect(await conteo()).toEqual(antes);
    expect(readdirSync(carpeta).length).toBe(2);
  });

  it('si algo falla antes de borrar, la transacción se revierte entera', async () => {
    const antes = await conteo();
    await expect(borrarTodo(E.db, { aplicar: true, confirmacion: FRASE_CONFIRMACION, carpetas: [carpeta], antesDeBorrar: () => { throw new Error('disco lleno'); } })).rejects.toThrow('disco lleno');
    expect(await conteo()).toEqual(antes);
  });
});

describe('Borrado aplicado', () => {
  let respaldo: Record<string, unknown[]> = {};
  it('deja todas las tablas de datos en 0 y conserva las migraciones', async () => {
    const versiones = await migraciones();
    expect(versiones).toBeGreaterThan(20);
    const r = await borrarTodo(E.db, { aplicar: true, confirmacion: FRASE_CONFIRMACION, conRespaldo: true, carpetas: [carpeta], antesDeBorrar: (x) => { respaldo = x.respaldo ?? {}; } });
    expect(r.aplicado).toBe(true);
    const despues = await conteo();
    expect(Object.entries(despues).filter(([, n]) => n > 0)).toEqual([]);
    expect(despues.prueba_futura).toBe(0);
    expect(await migraciones()).toBe(versiones);
    expect(existsSync(carpeta)).toBe(true);
    expect(readdirSync(carpeta)).toEqual([]);
  });

  it('el respaldo no lleva contraseñas, tokens, PIN ni sesiones', () => {
    expect(respaldo.tenant?.length).toBeGreaterThan(0);
    expect(respaldo.session).toBeUndefined();
    const texto = JSON.stringify(respaldo);
    expect(texto).not.toMatch(/"password_hash"|"token_publico"|"pin_cifrado"|"token_cifrado"/);
    expect(respaldo.users?.length).toBeGreaterThan(0);
  });

  it('el servidor arranca, se crea el operador y una empresa nueva', async () => {
    await E.db.withPlatform((tx) => ensurePlatformCatalog(tx));
    const r = await crearOperador(E.db, { email: 'admin@omnegia.test', rol: 'ADMIN' });
    expect(r.creado).toBe(true);
    const O = op(E.app, await loginOperador(E.app, E.db, 'admin@omnegia.test', r.temporal));
    expect((await O.get('/yo')).status).toBe(200);
    expect((await O.get('/empresas')).status).toBe(200);
    const demo = await seedDemo(E.db);
    expect(demo.tenantId).toBeTruthy();
    const n = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM tenant`)).rows[0].n);
    expect(n).toBeGreaterThan(0);
  });
});
