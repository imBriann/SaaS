import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { evaluateAndExecute } from '../src/ai/gateway.js';
import { loadAgent } from '../src/ai/runtime.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { drain } from '../src/worker/jobs.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Pagos de comercio por WhatsApp (docs/pagos-whatsapp.md). Nunca se hace una transacción real: Wompi se simula.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
const comercioOriginal = { ...config.comercio };

/** Conversación de WhatsApp de un cliente nuevo (como llegaría por el webhook). */
async function clienteWhatsApp(tenantPid: string, telefono: string, nombre: string) {
  const wa = async (t: string) => { await receiveChannelMessages(E.db, [{ phoneNumberId: tenantPid, from: telefono, nombre, id: `pc.${uuidv7()}`, texto: t }], 'WHATSAPP', 't'); await drain(E.db); };
  await wa('hola, quiero comprar');
  return (await sql(`SELECT v.id, v.customer_id, v.tenant_id FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1 ORDER BY v.creado_en DESC LIMIT 1`, [`+${telefono}`])).rows[0];
}
/** Ejecuta una herramienta como la propondría el agente, pasando por el gateway (permisos, riesgo, aislamiento). */
async function herramienta(tenantId: string, conv: { id: string; customer_id: string }, nombre: string, argumentos: Record<string, unknown>) {
  return E.db.withTenant(tenantId, async (tx) => {
    const agente = (await loadAgent(tx, 'atencion'))!;
    const ctx = { tenantId, actor: { tipo: 'AGENTE' as const, id: agente.id, nombre: 'Agente' }, roleKey: agente.roleKey, permisos: agente.permisos, origen: 'WHATSAPP' as const, correlacion: 't' };
    return evaluateAndExecute({ tx, ctx, conversationId: conv.id, customerId: conv.customer_id }, agente, { nombre, argumentos });
  });
}
const producto = async (tenantId: string, nombre: string) => (await sql(`SELECT id, precio, stock FROM product WHERE tenant_id=$1 AND nombre=$2`, [tenantId, nombre])).rows[0];

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

describe('Fase 4 · Pedidos y herramientas del agente', () => {
  let conv: any;
  let otro: any;
  let pedido = '';
  beforeAll(async () => {
    conv = await clienteWhatsApp('sim-elparche', '573170001001', 'Compradora Uno');
    otro = await clienteWhatsApp('sim-elparche', '573170001002', 'Comprador Dos');
  });

  it('sin métodos de pedidos activos, las herramientas no están disponibles', async () => {
    await A.patch('/pagos/ajustes', { pago_manual: false, pago_en_linea: false });
    const cera = await producto(E.A, 'Cera para peinar');
    const r = await herramienta(E.A, conv, 'crear_pedido', { items: [{ producto_id: cera.id, cantidad: 1 }] });
    expect(r.decision).toBe('DENEGADA');
    await A.patch('/pagos/ajustes', { pago_manual: true, pago_en_linea: false });
  });

  it('crea el pedido en borrador con los precios del catálogo: no es venta ni descuenta inventario', async () => {
    const cera = await producto(E.A, 'Cera para peinar');
    const r = await herramienta(E.A, conv, 'crear_pedido', { items: [{ producto_id: cera.id, cantidad: 2 }] });
    expect(r.decision).toBe('PERMITIDA');
    const p = r.resultado as any;
    pedido = p.pedido_id;
    expect(p.estado).toBe('ABIERTO');
    expect(p.total_oficial).toBe(Number(cera.precio) * 2);
    expect(p.cobro).toBe(1500);
    expect(Number((await producto(E.A, 'Cera para peinar')).stock)).toBe(Number(cera.stock));
    const o = (await sql(`SELECT estado, pedido_estado, precio_config FROM "order" WHERE id=$1`, [pedido])).rows[0];
    expect(o).toMatchObject({ estado: 'BORRADOR', pedido_estado: 'ABIERTO' });
    expect(o.precio_config).toMatchObject({ modo: 'institutional_test', cargo_fijo_centavos: 150000 });
    expect((await A.get('/ventas')).body.ventas.some((v: any) => v.id === pedido)).toBe(false);
  });

  it('la IA no puede mandar precios ni importes: el esquema los rechaza', async () => {
    const cera = await producto(E.A, 'Cera para peinar');
    const r = await herramienta(E.A, conv, 'crear_pedido', { items: [{ producto_id: cera.id, cantidad: 1, precio: 1 }] });
    expect(r.decision).not.toBe('PERMITIDA');
    const r2 = await herramienta(E.A, conv, 'calcular_total', { pedido_id: pedido, monto: 100 });
    expect(r2.decision).not.toBe('PERMITIDA');
  });

  it('calcular_total explica el precio oficial y el cobro institucional', async () => {
    const r = (await herramienta(E.A, conv, 'calcular_total', { pedido_id: pedido })).resultado as any;
    expect(r).toMatchObject({ modo: 'institutional_test', distintos: true, cobro_texto: '$1.500' });
    expect(r.explicacion).toMatch(/precio oficial del pedido es .* pero el cobro real de esta demostración será de \$1\.500 COP/);
  });

  it('el pedido de otro cliente es «no encontrado»', async () => {
    const r = await herramienta(E.A, otro, 'calcular_total', { pedido_id: pedido });
    expect(r).toMatchObject({ decision: 'DENEGADA', motivo: 'recurso_no_encontrado' });
  });

  it('entrega: el domicilio exige dirección; el medio debe estar habilitado', async () => {
    const sinDir = await herramienta(E.A, conv, 'elegir_entrega', { pedido_id: pedido, entrega: 'DOMICILIO' });
    expect(JSON.stringify(sinDir.resultado ?? sinDir)).toMatch(/dirección/);
    const ok = (await herramienta(E.A, conv, 'elegir_entrega', { pedido_id: pedido, entrega: 'DOMICILIO', direccion: 'Calle 10 # 4-25, barrio La Playa, Cúcuta' })).resultado as any;
    expect(ok).toMatchObject({ entrega: 'DOMICILIO' });
    const medios = (await herramienta(E.A, conv, 'medios_de_pago', {})).resultado as any;
    expect(medios.medios.map((m: any) => m.clave)).toEqual(['NEQUI']);
    expect(medios.medios[0].modalidad).toBe('MANUAL');
    expect(((await herramienta(E.A, conv, 'elegir_medio_pago', { pedido_id: pedido, medio: 'CHECKOUT' })).resultado as any).error).toBe('medio_no_habilitado');
    expect(((await herramienta(E.A, conv, 'elegir_medio_pago', { pedido_id: pedido, medio: 'NEQUI' })).resultado as any).ok).toBe(true);
  });

  it('valida el celular de Nequi del comprador', async () => {
    expect(((await herramienta(E.A, conv, 'pedir_celular_nequi', { pedido_id: pedido, celular: '12345678901' })).resultado as any).valido).toBe(false);
    expect(((await herramienta(E.A, conv, 'pedir_celular_nequi', { pedido_id: pedido, celular: '+57 317 000 1001' })).resultado as any)).toMatchObject({ valido: true, terminado_en: '1001' });
  });
});
