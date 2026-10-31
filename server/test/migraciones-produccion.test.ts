import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abrirBase } from './helpers.js';
import { seedDemo } from '../src/seed/demo.js';
import type { Database } from '../src/db/index.js';

/**
 * Producción llega hasta la migración 030. Las nuevas (031–033) deben ser aditivas e idempotentes: se aplican sobre
 * una base con datos sin perder nada, repetirlas no falla y el estado final es el mismo que el de una base nueva.
 * Corre en PGlite y, con `npm run test:postgres`, en un PostgreSQL real.
 */
let db: Database;
const sql = (q: string, p: unknown[] = []) => db.withPlatform((tx) => tx.query(q, p));
const conteos = async () => (await sql(`SELECT (SELECT count(*)::int FROM "order") AS ventas, (SELECT count(*)::int FROM order_item) AS lineas,
  (SELECT count(*)::int FROM product) AS productos, (SELECT count(*)::int FROM numero_contratacion) AS numeros, (SELECT count(*)::int FROM producto_imagen) AS imagenes`)).rows[0];
const NUEVAS = ['031_busqueda_imagen', '032_nota_linea_venta', '033_cambio_numero'];

beforeAll(async () => {
  db = await abrirBase();
  // Esquema hasta la 030 aplicado por el mismo mecanismo que en producción…
  await db.migrate({ hasta: '030_producto_imagen' });
  expect((await db.migrations()).at(-1)).toBe('030_producto_imagen');
  // …y datos reales de ejemplo. La semilla actual ya conoce las columnas nuevas, así que se cargan con todo aplicado y
  // después se deshace exactamente lo que añaden 031–033 (son aditivas), dejando el esquema de la 030 con datos.
  await db.migrate();
  await seedDemo(db);
  await db.execScript(`
    DROP TABLE busqueda_imagen;
    ALTER TABLE order_item DROP COLUMN nota;
    DROP INDEX ux_numero_contratacion_cambio;
    DROP INDEX ux_numero_contratacion_vigente;
    ALTER TABLE numero_contratacion DROP COLUMN reemplaza_id, DROP COLUMN es_cambio;
    CREATE UNIQUE INDEX ux_numero_contratacion_vigente ON numero_contratacion (tenant_id) WHERE estado <> 'CANCELADO';
    DELETE FROM schema_migrations WHERE version > '030_producto_imagen';`);
});
afterAll(async () => { await db.close(); });

describe('Migraciones 031–033 sobre una base de producción (hasta la 030)', () => {
  it('la base de partida está en la 030 y tiene datos', async () => {
    const m = await db.migrations();
    expect(m.at(-1)).toBe('030_producto_imagen');
    expect(m).not.toContain('031_busqueda_imagen');
    const c = await conteos();
    expect(c.ventas).toBeGreaterThan(0);
    expect(c.productos).toBeGreaterThan(0);
    // Un número conectado como los que hay en producción.
    const t = (await sql(`SELECT id FROM tenant ORDER BY creado_en LIMIT 1`)).rows[0].id;
    await sql(`INSERT INTO numero_contratacion (id, tenant_id, origen, estado, proveedor, entorno, pais, tipo_numero, numero_e164, nombre_visible)
               VALUES ('0190f0a0-0000-7000-8000-00000000c0de', $1, 'PROPIO', 'CONECTADO', 'meta', 'simulado', 'CO', 'propio', '+573005550001', 'Demo')`, [t]);
  });

  it('aplica las tres nuevas sin perder datos y con valores por defecto seguros', async () => {
    const antes = await conteos();
    await db.migrate();
    const m = await db.migrations();
    for (const v of NUEVAS) expect(m).toContain(v);
    expect(await conteos()).toEqual(antes);
    expect((await sql(`SELECT count(*)::int AS n FROM order_item WHERE nota IS NOT NULL`)).rows[0].n).toBe(0);
    const n = (await sql(`SELECT es_cambio, reemplaza_id, estado FROM numero_contratacion WHERE id='0190f0a0-0000-7000-8000-00000000c0de'`)).rows[0];
    expect(n).toEqual({ es_cambio: false, reemplaza_id: null, estado: 'CONECTADO' });
    expect((await sql(`SELECT to_regclass('public.busqueda_imagen') IS NOT NULL AS existe`)).rows[0].existe).toBe(true);
    // FORCE RLS en la tabla nueva.
    const rls = (await sql(`SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname='busqueda_imagen'`)).rows[0];
    expect(rls).toEqual({ r: true, f: true });
  });

  it('volver a migrar no hace nada y repetir el SQL de cada una no falla (idempotentes)', async () => {
    const antes = await db.migrations();
    await db.migrate();
    expect(await db.migrations()).toEqual(antes);
    const dir = join(import.meta.dirname, '../src/db/migrations');
    for (const v of NUEVAS) await db.execScript(readFileSync(join(dir, `${v}.sql`), 'utf8'));
    const c = await conteos();
    expect(c.numeros).toBeGreaterThan(0);
    // Los índices únicos quedan con la regla nueva: un número vigente y, como máximo, un cambio en curso.
    const idx = (await sql(`SELECT indexname FROM pg_indexes WHERE tablename='numero_contratacion' AND indexname IN ('ux_numero_contratacion_vigente','ux_numero_contratacion_cambio') ORDER BY 1`)).rows.map((r: any) => r.indexname);
    expect(idx).toEqual(['ux_numero_contratacion_cambio', 'ux_numero_contratacion_vigente']);
  });
});
