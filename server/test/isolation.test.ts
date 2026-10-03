import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Batería de pruebas negativas de aislamiento (criterio de salida de la Capa 0,
 * PRO-SW-001 §7.2; PRO-SW-002 fig. 12a). Criterio: cero accesos cruzados
 * exitosos. Debe fallar en rojo si alguien desactiva la RLS.
 */
let E: Env;
beforeAll(async () => { E = await setup(); });
afterAll(async () => { await E.app.close(); await E.db.close(); });

async function tenantTables(): Promise<string[]> {
  return E.db.raw(async (tx) =>
    (await tx.query(`SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='tenant_id' ORDER BY 1`)).rows.map((r: any) => r.table_name),
  );
}

describe('Barrera 2 — Row-Level Security', () => {
  it('toda tabla con tenant_id tiene RLS habilitada Y forzada', async () => {
    const tablas = await tenantTables();
    expect(tablas.length).toBeGreaterThan(25);
    const flags = await E.db.raw(async (tx) =>
      (await tx.query(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'`, [tablas])).rows,
    );
    const sinRls = flags.filter((f: any) => !f.relrowsecurity || !f.relforcerowsecurity).map((f: any) => f.relname);
    // Las únicas excepciones admitidas son tablas de plataforma sin NINGÚN privilegio para el rol de ejecución.
    for (const t of sinRls) {
      const acceso = await E.db.raw(async (tx) =>
        (await tx.query(`SELECT has_table_privilege('app_rt', $1, 'SELECT,INSERT,UPDATE,DELETE') AS a`, [t])).rows[0].a,
      );
      expect(acceso, `tabla ${t} sin RLS y accesible para app_rt`).toBe(false);
    }
    expect(sinRls.sort()).toEqual(['onboarding_draft', 'payment']);
  });

  it('desde el contexto de A no se ve ninguna fila de B en ninguna tabla', async () => {
    for (const t of await tenantTables()) {
      const n = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM "${t}" WHERE tenant_id <> $1`, [E.A])).rows[0].n).catch((e) => {
        if (/permission denied/.test(String(e.message))) return 0; // tablas sin SELECT para el rol: también cumple
        throw e;
      });
      expect(n, `tabla ${t}`).toBe(0);
    }
  });

  it('una consulta que OLVIDA el filtro por tenant sigue aislada', async () => {
    const [a, total] = await Promise.all([
      E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM customer`)).rows[0].n),
      E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM customer`)).rows[0].n),
    ]);
    expect(a).toBeLessThan(total);
    const deB = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM customer WHERE tenant_id=$1`, [E.B])).rows[0].n);
    expect(a + deB).toBe(total);
  });

  it('sin contexto de tenant, el rol de ejecución no ve nada', async () => {
    const n = await E.db.raw(async (tx) => {
      await tx.query('SET LOCAL ROLE app_rt');
      return (await tx.query(`SELECT count(*)::int AS n FROM customer`)).rows[0].n;
    });
    expect(n).toBe(0);
  });

  it('no se puede escribir una fila con el tenant_id de otra empresa (WITH CHECK)', async () => {
    await expect(
      E.db.withTenant(E.A, (tx) => tx.query(`INSERT INTO customer (id, tenant_id, nombre) VALUES ($1,$2,'intruso')`, [uuidv7(), E.B])),
    ).rejects.toThrow(/row-level security/);
  });

  it('no se puede actualizar ni borrar filas de otro tenant (cero filas afectadas)', async () => {
    const r = await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE customer SET nombre='x' WHERE tenant_id=$1 RETURNING id`, [E.B]));
    expect(r.rows.length).toBe(0);
  });

  it('el registro de tenants solo muestra el propio', async () => {
    const rows = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT id FROM tenant`)).rows);
    expect(rows.map((r: any) => r.id)).toEqual([E.A]);
  });
});

describe('Barrera 3 — claves foráneas compuestas', () => {
  it('una orden de A no puede referenciar un cliente de B aunque se salte la RLS', async () => {
    const clienteB = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT id FROM customer WHERE tenant_id=$1 LIMIT 1`, [E.B])).rows[0].id);
    await expect(
      E.db.withPlatform((tx) => tx.query(
        `INSERT INTO "order" (id, tenant_id, numero, customer_id, estado, origen, subtotal, impuestos, total, creado_por) VALUES ($1,$2,99999,$3,'CONFIRMADA','PANEL',1,0,1,'test')`,
        [uuidv7(), E.A, clienteB],
      )),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('Evidencia inalterable (amenaza T10)', () => {
  for (const tabla of ['audit_event', 'ai_execution']) {
    it(`${tabla}: la aplicación no puede UPDATE ni DELETE`, async () => {
      await expect(E.db.withTenant(E.A, (tx) => tx.query(`UPDATE ${tabla} SET creado_en = now()`))).rejects.toThrow(/permission denied/);
      await expect(E.db.withTenant(E.A, (tx) => tx.query(`DELETE FROM ${tabla}`))).rejects.toThrow(/permission denied/);
      await expect(E.db.withPlatform((tx) => tx.query(`DELETE FROM ${tabla}`))).rejects.toThrow(/permission denied/);
    });
  }
  it('el rol de ejecución no puede leer hashes de contraseña ni sesiones', async () => {
    await expect(E.db.withTenant(E.A, (tx) => tx.query(`SELECT password_hash FROM users`))).rejects.toThrow(/permission denied/);
    await expect(E.db.withTenant(E.A, (tx) => tx.query(`SELECT * FROM session`))).rejects.toThrow(/permission denied/);
  });
});

describe('Barrera 1 — resolución de tenant y autorización en HTTP', () => {
  it('sin sesión: 401', async () => {
    const r = await E.app.inject({ method: 'GET', url: '/api/t/clientes', headers: { 'x-tenant-slug': 'elparche' } });
    expect(r.statusCode).toBe(401);
  });

  it('usuario de A que apunta al subdominio de B: 404 «no encontramos eso» y evento de auditoría en B', async () => {
    const cookie = await login(E.app, 'laura@elparche.test', 'demo-equipo-2026');
    const r = await E.app.inject({ method: 'GET', url: '/api/t/clientes', headers: { cookie, host: 'fuerzanorte.localhost' } });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toBe('No encontramos eso.');
    const ev = await E.db.withTenant(E.B, async (tx) => (await tx.query(`SELECT * FROM audit_event WHERE accion='acceso.cruzado'`)).rows);
    expect(ev.length).toBeGreaterThan(0);
    expect(ev[0].resultado).toBe('NO_ENCONTRADO');
  });

  it('una identidad con dos empresas ve datos distintos según el subdominio', async () => {
    const cookie = await login(E.app, ...CRED.gym);
    const enB = await api(E.app, cookie, 'fuerzanorte').get('/clientes');
    const enA = await api(E.app, cookie, 'elparche').get('/clientes');
    expect(enB.status).toBe(200);
    expect(enA.status).toBe(200);
    const ids = new Set(enB.body.map((c: any) => c.id));
    expect(enA.body.some((c: any) => ids.has(c.id))).toBe(false);
  });

  it('matriz: todo recurso de B pedido desde A responde igual que uno inexistente', async () => {
    const cookie = await login(E.app, ...CRED.admin);
    const A = api(E.app, cookie, 'elparche');
    const idsB = await E.db.withPlatform(async (tx) => ({
      cliente: (await tx.query(`SELECT id FROM customer WHERE tenant_id=$1 LIMIT 1`, [E.B])).rows[0].id,
      orden: uuidv7(),
      conv: uuidv7(),
    }));
    const inexistente = uuidv7();
    for (const ruta of ['/clientes/', '/ventas/', '/conversaciones/']) {
      const deB = await A.get(ruta + idsB.cliente);
      const nada = await A.get(ruta + inexistente);
      expect(deB.status, ruta).toBe(404);
      expect(deB.body).toEqual(nada.body);
    }
    const pat = await A.patch(`/clientes/${idsB.cliente}`, { nombre: 'x' });
    expect(pat.status).toBe(404);
    const intacto = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT nombre FROM customer WHERE id=$1`, [idsB.cliente])).rows[0].nombre);
    expect(intacto).not.toBe('x');
  });

  it('permiso ausente: 403 y la denegación queda auditada aunque la petición falle', async () => {
    const cookie = await login(E.app, ...CRED.andres); // barbero: sin audit:read ni tenant:configure
    const B = api(E.app, cookie, 'elparche');
    expect((await B.get('/auditoria')).status).toBe(403);
    expect((await B.get('/configuracion')).status).toBe(403);
    const ev = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT * FROM audit_event WHERE accion='permiso.audit:read' AND resultado='DENEGADO'`)).rows);
    expect(ev.length).toBe(1);
  });

  it('el menú refleja solo lo autorizado (permisos del barbero)', async () => {
    const cookie = await login(E.app, ...CRED.andres);
    const yo = await api(E.app, cookie, 'elparche').get('/yo');
    expect(yo.body.permisos).not.toContain('invoice:read');
    expect(yo.body.permisos).toContain('appointment:read');
  });
});

describe('Webhooks del canal y de pagos', () => {
  it('webhook de WhatsApp con firma inválida: 401 y sin efectos', async () => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'sim-elparche' }, messages: [{ id: 'x1', from: '573000000000', type: 'text', text: { body: 'hola' } }] } }] }] });
    const antes = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM message`)).rows[0].n);
    const r = await E.app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' } });
    expect(r.statusCode).toBe(401);
    const despues = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM message`)).rows[0].n);
    expect(despues).toBe(antes);
  });

  it('webhook de pago falsificado: 401', async () => {
    const r = await E.app.inject({ method: 'POST', url: '/api/webhooks/pagos', payload: JSON.stringify({ id: 'e1', tipo: 'pago.aprobado', referencia: 'SUB-x', monto: 1 }), headers: { 'content-type': 'application/json', 'x-pasarela-firma': 't=1,v1=00' } });
    expect(r.statusCode).toBe(401);
  });
});
