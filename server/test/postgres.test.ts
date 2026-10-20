import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { abrirBase, motor } from './helpers.js';
import type { Database } from '../src/db/index.js';
import { ensurePlatformCatalog } from '../src/onboarding/provisioning.js';
import { seedDemo } from '../src/seed/demo.js';
import { systemCtx, type Ctx } from '../src/core/context.js';
import { insertAppointment } from '../src/modules/agenda.js';
import { insertOrder } from '../src/modules/orders.js';
import { escalate, takeCase } from '../src/modules/conversations.js';
import { procesarEventoPago } from '../src/modules/billing.js';
import { uuidv7 } from '../src/lib/util.js';
import { addDays, localToUtc, todayLocal } from '../src/lib/time.js';

/**
 * Migraciones y concurrencia contra el motor (PGlite por defecto; PostgreSQL real con
 * `npm run test:postgres`). En PostgreSQL las transacciones corren en paralelo de
 * verdad (pool de conexiones), así que estas pruebas ejercitan los bloqueos.
 */
let db: Database;
let A: string;

beforeAll(async () => {
  db = await abrirBase();
  // Base «antigua»: solo el esquema base, sin registro de migraciones.
  await db.execScript(readFileSync(join(import.meta.dirname, '../src/db/migrations/001_base.sql'), 'utf8'));
  expect(await db.migrate()).toBe(false); // no es nueva: no se cargan datos de demostración
  await db.withPlatform((tx) => ensurePlatformCatalog(tx));
  A = (await seedDemo(db)).tenantId;
});
afterAll(async () => { await db.close(); });

const ctxDe = (nombre: string): Ctx => ({ ...systemCtx(A, uuidv7(), nombre), origen: 'PANEL' });

describe(`Migraciones (${motor()})`, () => {
  it('una base creada antes del registro de migraciones se actualiza sin perder datos y repetir es inocuo', async () => {
    expect(await db.migrations()).toEqual(['001_base', '002_operacion', '003_correo_operador', '004_institucional', '005_documentos_pago','006_registro','007_comisiones','008_creacion_asistida','009_legal','010_reembolsos','011_asistente','012_atencion_whatsapp','013_pagos_ventas','014_asistente_acciones','015_soporte_ia','016_numeros','017_asistente_informes','018_avisos','019_propietario','020_soporte_responde']);
    expect(await db.migrate()).toBe(false);
    const cols = await db.raw(async (tx) => (await tx.query(`SELECT column_name FROM information_schema.columns WHERE table_name='message' AND column_name IN ('ocurrido_en','id_externo_salida','error_entrega')`)).rows.length);
    expect(cols).toBe(3);
    const rls = await db.raw(async (tx) => (await tx.query(`SELECT relname FROM pg_class WHERE relname IN ('invitation','case_event') AND relrowsecurity AND relforcerowsecurity ORDER BY 1`)).rows.map((r: any) => r.relname));
    expect(rls).toEqual(['case_event', 'invitation']);
    // El historial de radicados es evidencia: ni la aplicación ni la plataforma lo editan.
    await expect(db.withPlatform((tx) => tx.query(`DELETE FROM case_event`))).rejects.toThrow(/permission denied/);
  });
});

describe(`Concurrencia (${motor()})`, () => {
  it('diez reservas simultáneas de la misma franja: exactamente una', async () => {
    const d = await db.withTenant(A, async (tx) => ({
      servicio: (await tx.query(`SELECT id FROM product WHERE nombre='Corte clásico'`)).rows[0].id,
      recurso: (await tx.query(`SELECT id FROM resource WHERE nombre='Camilo'`)).rows[0].id,
      clientes: (await tx.query(`SELECT id FROM customer ORDER BY nombre LIMIT 10`)).rows.map((r: any) => r.id),
    }));
    let f = addDays(todayLocal(), 3);
    while (new Date(`${f}T12:00:00Z`).getUTCDay() !== 3) f = addDays(f, 1);
    const inicio = localToUtc(f, '11:00').toISOString();
    const r = await Promise.allSettled(d.clientes.map((c: string) => db.withTenant(A, (tx) => insertAppointment(tx, ctxDe('prueba'), { customer_id: c, product_id: d.servicio, resource_id: d.recurso, inicio }, 'PANEL'))));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected').every((x: any) => /ya no está disponible/.test(x.reason.message))).toBe(true);
  });

  it('ventas simultáneas: números consecutivos sin repetir y el inventario nunca queda negativo', async () => {
    const d = await db.withTenant(A, async (tx) => {
      await tx.query(`UPDATE product SET stock=5 WHERE nombre='Aceite para barba'`);
      return {
        producto: (await tx.query(`SELECT id FROM product WHERE nombre='Aceite para barba'`)).rows[0].id,
        cliente: (await tx.query(`SELECT id FROM customer LIMIT 1`)).rows[0].id,
      };
    });
    const r = await Promise.allSettled(Array.from({ length: 8 }, () => db.withTenant(A, (tx) => insertOrder(tx, ctxDe('prueba'), { customer_id: d.cliente, items: [{ product_id: d.producto, cantidad: 1 }] }, { origen: 'PANEL' }))));
    const ok = r.filter((x) => x.status === 'fulfilled').map((x: any) => x.value.numero);
    expect(ok).toHaveLength(5);
    expect(new Set(ok).size).toBe(5);
    const stock = await db.withTenant(A, async (tx) => Number((await tx.query(`SELECT stock FROM product WHERE id=$1`, [d.producto])).rows[0].stock));
    expect(stock).toBe(0);
  });

  it('cinco asesores toman el mismo radicado a la vez: uno lo obtiene, los demás reciben «ya lo tomó»', async () => {
    const conv = await db.withTenant(A, async (tx) => (await tx.query(`SELECT id FROM conversation WHERE estado <> 'ESCALADA' LIMIT 1`)).rows[0].id);
    await db.withTenant(A, (tx) => tx.query(`UPDATE user_tenant SET disponible=false`));
    const caso = await db.withTenant(A, (tx) => escalate(tx, ctxDe('prueba'), conv, 'Concurrencia', 'MEDIA'));
    const asesores = await db.withTenant(A, async (tx) => (await tx.query(`SELECT user_id FROM user_tenant LIMIT 5`)).rows.map((r: any) => r.user_id));
    const r = await Promise.allSettled(asesores.map((id: string) => db.withTenant(A, (tx) => takeCase(tx, { ...ctxDe('asesor'), actor: { tipo: 'USUARIO', id, nombre: id }, permisos: new Set(['case:manage']) }, caso.case_id))));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected').every((x: any) => /ya lo tomó/.test(x.reason.message))).toBe(true);
  });

  it('el mismo evento de pago entregado cinco veces a la vez se procesa una sola vez', async () => {
    const ref = await db.withTenant(A, async (tx) => {
      const o = (await tx.query(`SELECT id, total FROM "order" WHERE estado='CONFIRMADA' AND estado_pago <> 'PAGADA' LIMIT 1`)).rows[0];
      await tx.query(`INSERT INTO payment_link (id, tenant_id, order_id, referencia, url, estado, monto, expira_en) VALUES ($1,$2,$3,'PL-CONC-1','x','ABIERTO',$4, now() + interval '1 day')`, [uuidv7(), A, o.id, o.total]);
      return { order: o.id, total: Number(o.total) };
    });
    const ev = { id: 'evt-conc-1', proveedor: 'wompi' as const, referencia: 'PL-CONC-1', estado: 'APROBADO' as const, montoCentavos: Math.round(ref.total * 100), moneda: 'COP' };
    const r = await Promise.all(Array.from({ length: 5 }, () => procesarEventoPago(db, ev, uuidv7(), 'prueba')));
    expect(r.filter((x) => x.duplicado)).toHaveLength(4);
    const conc = await db.withTenant(A, async (tx) => (await tx.query(`SELECT count(*)::int n FROM audit_event WHERE accion='cobro.conciliado' AND recurso_id=$1`, [ref.order])).rows[0].n);
    expect(conc).toBe(1);
  });
});
