import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, CRED, login, setup, type Env } from './helpers.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Pagos de las ventas: efectivo con valor recibido y cambio, transferencia y datáfono como registro
 * interno, pasarela confirmada por su evento, un solo pago vigente por venta, anulación con historial,
 * reportes por método, permisos por rol y aislamiento entre empresas.
 */
let E: Env;
let admin: ReturnType<typeof api>;
let laura: ReturnType<typeof api>;
let andres: ReturnType<typeof api>;
let gym: ReturnType<typeof api>;
let cliente = '';
let corte = { id: '', precio: 0 };
const SECRETO_EVENTOS = 'test_events_secreto_pagos';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const nuevaVenta = async (extra: Record<string, unknown> = {}, cantidad = 1) => admin.post('/ventas', { customer_id: cliente, items: [{ product_id: corte.id, cantidad }], ...extra });

function eventoWompi(tx: { id: string; status: string; amount_in_cents: number; reference: string }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = sha(`${tx.id}${tx.status}${tx.amount_in_cents}${timestamp}${SECRETO_EVENTOS}`).toUpperCase();
  return { event: 'transaction.updated', data: { transaction: { ...tx, currency: 'COP' } }, environment: 'test', signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum }, timestamp, sent_at: new Date().toISOString() };
}

beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
  andres = api(E.app, await login(E.app, ...CRED.andres), 'elparche');
  gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
  cliente = (await admin.get('/clientes?q=Mateo')).body.clientes[0].id;
  const p = (await admin.get('/productos')).body.find((x: any) => x.nombre === 'Corte clásico');
  corte = { id: p.id, precio: p.precio };
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Venta pagada en efectivo', () => {
  it('registra la venta y su pago en una sola operación, con el cambio calculado en el servidor', async () => {
    const recibido = corte.precio * 2 + 3550;
    const r = await nuevaVenta({ pago: { metodo: 'EFECTIVO', recibido, clave: `c-${uuidv7()}` } }, 2);
    expect(r.status).toBe(200);
    expect(r.body.pago).toMatchObject({ metodo: 'EFECTIVO', monto: corte.precio * 2, recibido, cambio: 3550, estado: 'REGISTRADO' });
    // Persistido: al volver a cargar la venta, el pago sigue ahí con quién y cuándo.
    const d = (await admin.get(`/ventas/${r.body.id}`)).body;
    expect(d.estado_pago).toBe('PAGADA');
    expect(d.pagos).toHaveLength(1);
    expect(d.pagos[0]).toMatchObject({ metodo: 'EFECTIVO', cambio: 3550, registrado_por: 'Andrea Jaimes' });
    expect(d.pagos[0].creado_en).toBeTruthy();
    const aud = (await admin.get('/auditoria?q=pago.registrar')).body.find((e: any) => e.recurso_id === r.body.id);
    expect(aud.detalle).toMatchObject({ metodo: 'EFECTIVO', cambio: 3550 });
  });

  it('sin valor recibido se entiende pago exacto (sin cambio)', async () => {
    const r = await nuevaVenta({ pago: { metodo: 'EFECTIVO' } });
    expect(r.body.pago).toMatchObject({ recibido: corte.precio, cambio: 0 });
  });

  it('con efectivo insuficiente no se crea la venta ni el pago, y el mensaje dice cuánto falta', async () => {
    const antes = (await admin.get('/ventas')).body.total;
    const r = await nuevaVenta({ pago: { metodo: 'EFECTIVO', recibido: corte.precio - 2000 } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/faltan \$2\.000/);
    expect((await admin.get('/ventas')).body.total).toBe(antes);
  });

  it('valores inválidos se rechazan: negativos, texto o recibido en un pago que no es efectivo', async () => {
    expect((await nuevaVenta({ pago: { metodo: 'EFECTIVO', recibido: -5 } })).status).toBe(400);
    expect((await nuevaVenta({ pago: { metodo: 'EFECTIVO', recibido: 'mucho' } })).status).toBe(400);
    expect((await nuevaVenta({ pago: { metodo: 'BITCOIN' } })).status).toBe(400);
    const t = await nuevaVenta({ pago: { metodo: 'TRANSFERENCIA', recibido: 99999 } });
    expect(t.status).toBe(400);
    expect(t.body.error.message).toContain('solo aplican al efectivo');
  });
});

describe('Un solo pago por venta', () => {
  it('una venta pagada no admite un segundo pago; la misma clave repetida devuelve el mismo pago', async () => {
    const v = (await nuevaVenta()).body;
    const clave = `c-${uuidv7()}`;
    const a = await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'TRANSFERENCIA', referencia: 'Nequi 4455', clave });
    expect(a.status).toBe(200);
    const repetido = await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'TRANSFERENCIA', referencia: 'Nequi 4455', clave });
    expect(repetido.status).toBe(200);
    expect(repetido.body).toMatchObject({ id: a.body.id, repetido: true });
    const otro = await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'EFECTIVO' });
    expect(otro.status).toBe(409);
    expect(otro.body.error.message).toContain('ya está pagada');
    expect((await admin.get(`/ventas/${v.id}`)).body.pagos).toHaveLength(1);
  });

  it('dos registros simultáneos del mismo pago dejan uno solo', async () => {
    const v = (await nuevaVenta()).body;
    const [x, y] = await Promise.all([admin.post(`/ventas/${v.id}/pagos`, { metodo: 'EFECTIVO' }), admin.post(`/ventas/${v.id}/pagos`, { metodo: 'EFECTIVO' })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect((await admin.get(`/ventas/${v.id}`)).body.pagos.filter((p: any) => p.estado === 'REGISTRADO')).toHaveLength(1);
  });

  it('pagos parciales y abonos no se admiten: el registro exige el total', async () => {
    const v = (await nuevaVenta({}, 3)).body;
    const r = await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'EFECTIVO', recibido: corte.precio });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('no se registran abonos');
  });
});

describe('Métodos configurables y pago digital', () => {
  it('el datáfono está apagado hasta que el negocio lo active; solo quien configura puede cambiar los métodos', async () => {
    const v = (await nuevaVenta()).body;
    const sin = await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'DATAFONO', referencia: 'Aprob. 123456' });
    expect(sin.status).toBe(400);
    expect(sin.body.error.message).toContain('Configuración › Cobros');
    expect((await laura.patch('/configuracion/cobros/metodos', { EFECTIVO: true, TRANSFERENCIA: true, DATAFONO: true })).status).toBe(403);
    const m = await admin.patch('/configuracion/cobros/metodos', { EFECTIVO: true, TRANSFERENCIA: true, DATAFONO: true });
    expect(m.status).toBe(200);
    expect(m.body.DATAFONO).toBe(true);
    expect((await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'DATAFONO', referencia: 'Aprob. 123456' })).status).toBe(200);
  });

  it('la pasarela marca pagada la venta solo con su evento firmado, y queda en el registro de pagos como pasarela', async () => {
    const r = await admin.post('/configuracion/pasarela', { proveedor: 'wompi', entorno: 'sandbox', llave_publica: 'pub_test_pagos1', secreto_integridad: 'test_integrity_pagos1', secreto_eventos: SECRETO_EVENTOS });
    const webhook = new URL(r.body.webhook_url).pathname;
    const v = (await nuevaVenta()).body;
    // Elegir «efectivo» en otra venta no toca la pasarela: no hay ninguna transacción de Wompi de por medio.
    const l = (await admin.post(`/ventas/${v.id}/enlace-pago`)).body;
    expect((await admin.get(`/ventas/${v.id}`)).body.estado_pago).toBe('PENDIENTE');
    const ev = eventoWompi({ id: 'tx-pv-1', status: 'APPROVED', amount_in_cents: v.total * 100, reference: l.referencia });
    expect((await E.app.inject({ method: 'POST', url: webhook, payload: ev })).statusCode).toBe(200);
    const d = (await admin.get(`/ventas/${v.id}`)).body;
    expect(d.estado_pago).toBe('PAGADA');
    expect(d.pagos).toHaveLength(1);
    expect(d.pagos[0]).toMatchObject({ metodo: 'PASARELA', origen: 'PASARELA', estado: 'REGISTRADO' });
    // Un pago de la pasarela no se anula a mano.
    expect((await admin.post(`/ventas/${v.id}/pagos/${d.pagos[0].id}/anular`, { motivo: 'prueba de anulación' })).status).toBe(409);
  });

  it('si la venta se pagó en efectivo y luego llega el pago por la pasarela, se marca como excedente para devolverlo', async () => {
    const v = (await nuevaVenta()).body;
    const l = (await admin.post(`/ventas/${v.id}/enlace-pago`)).body;
    expect((await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'EFECTIVO' })).status).toBe(200);
    // Registrar el efectivo cerró el enlace abierto.
    expect((await admin.get(`/ventas/${v.id}`)).body.enlaces[0].estado).toBe('EXPIRADO');
    const webhook = new URL((await admin.get('/configuracion')).body.pasarela.webhook_url).pathname;
    const ev = eventoWompi({ id: 'tx-pv-2', status: 'APPROVED', amount_in_cents: v.total * 100, reference: l.referencia });
    expect((await E.app.inject({ method: 'POST', url: webhook, payload: ev })).json().estado).toBe('EXCEDENTE');
    const d = (await admin.get(`/ventas/${v.id}`)).body;
    expect(d.pagos.map((p: any) => `${p.metodo}:${p.estado}`).sort()).toEqual(['EFECTIVO:REGISTRADO', 'PASARELA:EXCEDENTE']);
    const inicio = (await admin.get('/inicio')).body;
    expect(inicio.atencion.some((a: any) => a.tipo === 'pago_excedente' && a.accion.ruta === `/ventas/${v.id}`)).toBe(true);
  });
});

describe('Anulaciones con historial', () => {
  it('solo quien puede anular pagos lo hace; la venta vuelve a «por cobrar» y el pago queda anulado con motivo', async () => {
    const v = (await nuevaVenta({ pago: { metodo: 'EFECTIVO', recibido: corte.precio + 1000 } })).body;
    expect((await andres.post(`/ventas/${v.id}/pagos/${v.pago.id}/anular`, { motivo: 'Me equivoqué de venta' })).status).toBe(403);
    expect((await admin.post(`/ventas/${v.id}/pagos/${v.pago.id}/anular`, { motivo: 'no' })).status).toBe(400);
    expect((await admin.post(`/ventas/${v.id}/pagos/${v.pago.id}/anular`, { motivo: 'Se registró en la venta equivocada' })).status).toBe(200);
    const d = (await admin.get(`/ventas/${v.id}`)).body;
    expect(d.estado_pago).toBe('PENDIENTE');
    expect(d.pagos[0]).toMatchObject({ estado: 'ANULADO', motivo_anulacion: 'Se registró en la venta equivocada', anulado_por: 'Andrea Jaimes' });
    // Se puede registrar el pago correcto después.
    expect((await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'TRANSFERENCIA', referencia: 'Bancolombia 778' })).status).toBe(200);
    expect((await admin.get(`/ventas/${v.id}`)).body.pagos).toHaveLength(2);
  });

  it('anular una venta pagada anula su pago con el motivo de la venta, sin borrarlo', async () => {
    const v = (await nuevaVenta({ pago: { metodo: 'EFECTIVO' } })).body;
    const r = await admin.post(`/ventas/${v.id}/anular`, { motivo: 'El cliente devolvió el producto' });
    expect(r.status).toBe(200);
    expect(r.body.pagos_anulados).toBe(1);
    const d = (await admin.get(`/ventas/${v.id}`)).body;
    expect(d.pagos[0]).toMatchObject({ estado: 'ANULADO', motivo_anulacion: 'Venta anulada: El cliente devolvió el producto' });
    expect((await admin.post(`/ventas/${v.id}/pagos`, { metodo: 'EFECTIVO' })).status).toBe(409);
  });
});

describe('Permisos y aislamiento', () => {
  it('un colaborador con ventas registra pagos; un rol sin ese permiso no puede', async () => {
    const v = (await andres.post('/ventas', { customer_id: cliente, items: [{ product_id: corte.id, cantidad: 1 }], pago: { metodo: 'EFECTIVO' } }));
    expect(v.status).toBe(200);
    // Un rol sin «registrar pagos» no puede pagar ni siquiera al crear la venta (y la venta no se crea a medias).
    await E.db.withTenant(E.A, (tx) => tx.query(`DELETE FROM role_permission WHERE permiso='payment:register' AND role_id=(SELECT id FROM role WHERE clave='barbero')`));
    try {
      const antes = (await admin.get('/ventas')).body.total;
      const sin = await andres.post('/ventas', { customer_id: cliente, items: [{ product_id: corte.id, cantidad: 1 }], pago: { metodo: 'EFECTIVO' } });
      expect(sin.status).toBe(403);
      expect((await admin.get('/ventas')).body.total).toBe(antes);
      const pendiente = (await nuevaVenta()).body;
      expect((await andres.post(`/ventas/${pendiente.id}/pagos`, { metodo: 'EFECTIVO' })).status).toBe(403);
    } finally {
      await E.db.withTenant(E.A, (tx) => tx.query(`INSERT INTO role_permission (tenant_id, role_id, permiso) SELECT tenant_id, id, 'payment:register' FROM role WHERE clave='barbero' ON CONFLICT DO NOTHING`));
    }
  });

  it('otra empresa no puede registrar, anular ni ver pagos de esta (no encontrado)', async () => {
    const v = (await nuevaVenta({ pago: { metodo: 'EFECTIVO' } })).body;
    expect((await gym.post(`/ventas/${v.id}/pagos`, { metodo: 'EFECTIVO' })).status).toBe(404);
    expect((await gym.post(`/ventas/${v.id}/pagos/${v.pago.id}/anular`, { motivo: 'intento cruzado' })).status).toBe(404);
    const cajaGym = (await gym.get('/ventas/caja')).body;
    expect(cajaGym.detalle.some((p: any) => p.venta_id === v.id)).toBe(false);
  });
});

describe('Reportes', () => {
  it('la caja del día, el inicio, la exportación y el asistente reflejan los pagos por método', async () => {
    const caja = (await admin.get('/ventas/caja')).body;
    const efectivo = caja.metodos.find((m: any) => m.metodo === 'EFECTIVO');
    const enBase = await E.db.withTenant(E.A, async (tx) => (await tx.query(
      `SELECT coalesce(sum(monto),0)::float AS total, coalesce(sum(cambio),0)::float AS cambio, count(*)::int AS n FROM order_payment WHERE metodo='EFECTIVO' AND estado='REGISTRADO'`)).rows[0]);
    expect(efectivo.total).toBe(enBase.total);
    expect(efectivo.pagos).toBe(enBase.n);
    expect(caja.efectivo.cambio).toBe(enBase.cambio);
    expect(caja.efectivo.recibido).toBe(enBase.total + enBase.cambio);
    expect(caja.anulados.pagos).toBeGreaterThanOrEqual(2);
    expect(caja.excedentes.pagos).toBe(1);
    expect(caja.total_cobrado).toBe(caja.metodos.reduce((a: number, m: any) => a + m.total, 0));
    const inicio = (await admin.get('/inicio')).body;
    expect(inicio.cobros_hoy.efectivo).toBe(enBase.total);
    const csv = await E.app.inject({ method: 'GET', url: '/api/t/ventas.csv', headers: { cookie: (await login(E.app, ...CRED.admin)), 'x-tenant-slug': 'elparche' } });
    expect(csv.body).toContain('Método de pago');
    expect(csv.body).toContain('Efectivo');
    expect(csv.body).toContain('Transferencia');
    const filtro = (await admin.get('/ventas?metodo=EFECTIVO')).body;
    expect(filtro.ventas.every((v: any) => v.metodo_pago === 'EFECTIVO')).toBe(true);
    const asis = await admin.post('/asistente', { pregunta: '¿cuánto vendimos hoy?' });
    expect(asis.body.texto).toContain('Cobrado por método');
    expect(asis.body.texto).toContain('Efectivo');
    // Preguntar por el dinero que entró es pedir cifras, no la guía de cómo cobrar.
    const entro = await admin.post('/asistente', { pregunta: '¿Cuánto entró hoy en efectivo y por transferencia?' });
    expect(entro.body.ejecuciones.map((e: any) => e.herramienta)).toContain('resumen_ventas');
    expect(entro.body.texto).toContain('Cobrado por método');
    const guia = await admin.post('/asistente', { pregunta: '¿Cómo registro un pago en efectivo?' });
    expect(guia.body.ejecuciones.map((e: any) => e.herramienta)).toContain('ayuda_plataforma');
  });
});
