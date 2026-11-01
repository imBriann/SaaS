import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { evaluateAndExecute } from '../src/ai/gateway.js';
import { loadAgent } from '../src/ai/runtime.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { drain } from '../src/worker/jobs.js';
import { uuidv7 } from '../src/lib/util.js';
import { setHttpComercio } from '../src/comercio/cobros.js';
import { PERMISOS_PROHIBIDOS_A_AGENTES } from '../src/core/permissions.js';
import { TOOL_MAP } from '../src/ai/registry.js';

/**
 * Pagos de comercio · Fases 6 (manual) y 7 (Wompi). Wompi se simula: la suite nunca hace transacciones reales.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
const comercioOriginal = { ...config.comercio };
const pagosOriginal = JSON.parse(JSON.stringify(config.pagos));

async function clienteWhatsApp(telefono: string, nombre: string, email?: string) {
  await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from: telefono, nombre, id: `pc.${uuidv7()}`, texto: 'hola, quiero comprar' }], 'WHATSAPP', 't');
  await drain(E.db);
  if (email) await sql(`UPDATE customer SET email=$2 WHERE telefono=$1`, [`+${telefono}`, email]);
  return (await sql(`SELECT v.id, v.customer_id FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1 ORDER BY v.creado_en DESC LIMIT 1`, [`+${telefono}`])).rows[0];
}
/** Herramienta propuesta por el agente, por el gateway real. `confirmar` = el cliente respondió «SÍ». */
async function herramienta(conv: { id: string; customer_id: string }, nombre: string, argumentos: Record<string, unknown>, confirmar = false) {
  return E.db.withTenant(E.A, async (tx) => {
    const agente = (await loadAgent(tx, 'atencion'))!;
    const ctx = { tenantId: E.A, actor: { tipo: 'AGENTE' as const, id: agente.id, nombre: 'Agente' }, roleKey: agente.roleKey, permisos: agente.permisos, origen: 'WHATSAPP' as const, correlacion: 't' };
    return evaluateAndExecute({ tx, ctx, conversationId: conv.id, customerId: conv.customer_id }, agente, { nombre, argumentos }, confirmar ? { confirmacion: { por: 'cliente', pendingActionId: uuidv7() } } : {});
  });
}
const producto = async (nombre: string) => (await sql(`SELECT id, precio, stock FROM product WHERE tenant_id=$1 AND nombre=$2`, [E.A, nombre])).rows[0];
async function pedidoListo(conv: any, medio: string, cantidad = 1, nombre = 'Cera para peinar') {
  const p = await producto(nombre);
  const r = (await herramienta(conv, 'crear_pedido', { items: [{ producto_id: p.id, cantidad }] })).resultado as any;
  await herramienta(conv, 'elegir_entrega', { pedido_id: r.pedido_id, entrega: 'RECOGER' });
  const m = (await herramienta(conv, 'elegir_medio_pago', { pedido_id: r.pedido_id, medio })).resultado as any;
  expect(m.ok).toBe(true);
  return r.pedido_id as string;
}
const pago = async (orderId: string) => (await sql(`SELECT * FROM commerce_payment WHERE order_id=$1 ORDER BY creado_en DESC LIMIT 1`, [orderId])).rows[0];
const ledger = async (pagoId: string) => (await sql(`SELECT * FROM financial_ledger WHERE commerce_payment_id=$1`, [pagoId])).rows;
const avisos = async (tipo: string, referencia: string) => (await sql(`SELECT count(*)::int AS n FROM aviso_proactivo WHERE tipo=$1 AND referencia LIKE $2`, [tipo, `${referencia}%`])).rows[0].n;

beforeAll(async () => {
  E = await setup();
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
  await A.post('/pagos/cuentas', { tipo: 'NEQUI', titular: 'Barbería El Parche', valor: '300 123 4567', instrucciones: 'Envía el comprobante por este chat' });
  expect((await A.patch('/pagos/ajustes', { pago_manual: true, pago_en_linea: false })).status).toBe(200);
});
afterAll(async () => {
  Object.assign(config.comercio, comercioOriginal);
  Object.assign(config.pagos, pagosOriginal); config.pagos.wompi = pagosOriginal.wompi;
  setHttpComercio(null);
  await E.app.close(); await E.db.close();
});

describe('Fase 6 · Pago manual', () => {
  let conv: any;
  let pedido = '';
  beforeAll(async () => { conv = await clienteWhatsApp('573170002001', 'Cliente Manual'); });

  it('generar_cobro pide al cliente confirmar el importe exacto antes de crear nada', async () => {
    pedido = await pedidoListo(conv, 'NEQUI', 2);
    const r = await herramienta(conv, 'generar_cobro', { pedido_id: pedido });
    expect(r.decision).not.toBe('PERMITIDA');
    const pend = (await sql(`SELECT resumen FROM pending_action WHERE conversation_id=$1 AND herramienta='generar_cobro' ORDER BY creado_en DESC LIMIT 1`, [conv.id])).rows[0];
    expect(pend.resumen).toMatch(/cobro por exactamente \$1\.500 COP/);
    expect(pend.resumen).toMatch(/precio oficial del pedido es/);
    expect(await pago(pedido)).toBeUndefined();
  });

  it('confirmado por el cliente: queda pendiente de confirmación con los datos de pago del negocio', async () => {
    const r = (await herramienta(conv, 'generar_cobro', { pedido_id: pedido }, true)).resultado as any;
    expect(r).toMatchObject({ estado: 'PENDIENTE_CONFIRMACION', cobro_texto: '$1.500' });
    expect(r.para_el_cliente).toMatch(/Nequi a Barbería El Parche: 300 123 4567/);
    expect(r.para_el_cliente).toMatch(/enviar un comprobante no confirma el pago/);
    const p = await pago(pedido);
    expect(p).toMatchObject({ modalidad: 'MANUAL', metodo: 'NEQUI', estado: 'PENDIENTE_CONFIRMACION', modo_precios: 'institutional_test' });
    expect(Number(p.monto_cobro_centavos)).toBe(150000);
    const otra = (await herramienta(conv, 'generar_cobro', { pedido_id: pedido }, true)).resultado as any;
    expect(otra.ya_existia).toBe(true);
    expect((await sql(`SELECT count(*)::int AS n FROM commerce_payment WHERE order_id=$1`, [pedido])).rows[0].n).toBe(1);
  });

  it('«ya pagué» no cambia nada: la IA no puede confirmar pagos', async () => {
    const e = (await herramienta(conv, 'estado_pedido', { pedido_id: pedido })).resultado as any;
    expect(e.estado).toBe('PENDIENTE_CONFIRMACION');
    expect(e.nota).toMatch(/Lo que diga el cliente no cambia el estado/);
    expect((await pago(pedido)).estado).toBe('PENDIENTE_CONFIRMACION');
  });

  it('solo una persona con permiso confirma; el importe no se cambia desde el panel', async () => {
    const p = await pago(pedido);
    // La IA nunca: registrar pagos está prohibido a los agentes y ninguna herramienta lo hace.
    expect(PERMISOS_PROHIBIDOS_A_AGENTES).toEqual(expect.arrayContaining(['payment:register', 'payment:void']));
    expect([...TOOL_MAP.values()].some((t) => t.permiso === 'payment:register' || t.permiso === 'payment:void')).toBe(false);
    expect((await A.post(`/pagos/cobros/${p.id}/confirmar`, {})).status).toBe(400);
    expect((await B.post(`/pagos/cobros/${p.id}/confirmar`, { nota: 'Intruso confirmando' })).status).toBe(404);
    const stock = Number((await producto('Cera para peinar')).stock);
    const r = await A.post(`/pagos/cobros/${p.id}/confirmar`, { nota: 'Llegó el Nequi de $1.500', monto: 1, monto_cobro_centavos: 1 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'PAGADO', cobro: 1500, comision: 0, neto: 1500 });
    expect((await sql(`SELECT estado, estado_pago, pedido_estado FROM "order" WHERE id=$1`, [pedido])).rows[0]).toEqual({ estado: 'CONFIRMADA', estado_pago: 'PAGADA', pedido_estado: 'PAGADO' });
    expect(Number((await producto('Cera para peinar')).stock)).toBe(stock - 2);
    const l = await ledger(p.id);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ tipo: 'RECAUDO', estado: 'CONFIRMADO' });
    expect(Number(l[0].bruto_centavos)).toBe(150000);
    expect((await A.get('/ventas')).body.ventas.some((v: any) => v.id === pedido)).toBe(true);
    const aud = (await sql(`SELECT detalle FROM audit_event WHERE accion='cobro.manual.confirmar' AND recurso_id=$1`, [p.id])).rows[0];
    expect(aud.detalle.nota).toMatch(/Llegó el Nequi/);
  });

  it('el aviso al cliente sale una sola vez aunque la cola corra dos veces', async () => {
    await drain(E.db);
    await drain(E.db);
    expect(await avisos('PAGO_CONFIRMADO', (await pago(pedido)).referencia)).toBe(1);
    const m = (await sql(`SELECT contenido FROM message WHERE conversation_id=$1 AND remitente='AI' ORDER BY creado_en DESC LIMIT 1`, [conv.id])).rows[0];
    expect(m.contenido).toMatch(/¡Tu pago fue confirmado!.*demostración institucional.*\$1\.500 COP/);
  });

  it('rechazar y pedir otro comprobante quedan auditados con el motivo; luego se puede intentar de nuevo', async () => {
    const otro = await clienteWhatsApp('573170002002', 'Cliente Rechazo');
    const ped = await pedidoListo(otro, 'NEQUI');
    await herramienta(otro, 'generar_cobro', { pedido_id: ped }, true);
    const p = await pago(ped);
    expect((await A.post(`/pagos/cobros/${p.id}/observar`, { nota: 'El comprobante está borroso, envíalo de nuevo', pedir_comprobante: true })).status).toBe(200);
    expect((await A.post(`/pagos/cobros/${p.id}/rechazar`, { motivo: 'No llegó el dinero a la cuenta' })).body).toMatchObject({ estado: 'RECHAZADO' });
    expect((await sql(`SELECT pedido_estado FROM "order" WHERE id=$1`, [ped])).rows[0].pedido_estado).toBe('RECHAZADO');
    expect(await ledger(p.id)).toHaveLength(0);
    const acciones = (await sql(`SELECT accion FROM audit_event WHERE recurso_id=$1 ORDER BY creado_en`, [p.id])).rows.map((r: any) => r.accion);
    expect(acciones).toEqual(expect.arrayContaining(['cobro.manual.crear', 'cobro.manual.pedir_comprobante', 'cobro.manual.rechazar']));
    expect(((await herramienta(otro, 'generar_cobro', { pedido_id: ped }, true)).resultado as any).estado).toBe('PENDIENTE_CONFIRMACION');
  });

  it('el libro financiero no se puede editar ni borrar', async () => {
    const l = (await sql(`SELECT id FROM financial_ledger LIMIT 1`)).rows[0];
    // Ni la empresa ni la plataforma tienen permiso de editar…
    await expect(sql(`UPDATE financial_ledger SET bruto_centavos=1 WHERE id=$1`, [l.id])).rejects.toThrow(/permission denied|solo inserción/);
    await expect(E.db.withTenant(E.A, (tx) => tx.query(`DELETE FROM financial_ledger WHERE id=$1`, [l.id]))).rejects.toThrow(/permission denied|solo inserción/);
    // …y aun el dueño del esquema choca con el disparador.
    await expect(E.db.execScript(`UPDATE financial_ledger SET bruto_centavos=1 WHERE id='${l.id}'`)).rejects.toThrow(/solo inserción/);
    await expect(E.db.execScript(`DELETE FROM financial_ledger WHERE id='${l.id}'`)).rejects.toThrow(/solo inserción/);
  });
});

// ---------------------------------------------------------------------------
// Wompi simulado
// ---------------------------------------------------------------------------
const SECRETO_EVENTOS = 'prod_events_de_prueba';
const wompi = { transacciones: new Map<string, any>(), posts: [] as any[], fallarPost: 0, estado: 'PENDING', monto: null as number | null, moneda: 'COP', referencia: null as string | null };
function wompiFalso(): typeof fetch {
  return (async (url: any, init: any = {}) => {
    const u = String(url);
    const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/merchants/info')) return json({ data: { presigned_acceptance: { acceptance_token: 'tok_terminos', permalink: 'https://wompi.co/terminos.pdf' }, presigned_personal_data_auth: { acceptance_token: 'tok_datos', permalink: 'https://wompi.co/datos.pdf' } } });
    if (u.endsWith('/transactions') && init.method === 'POST') {
      if (wompi.fallarPost > 0) { wompi.fallarPost--; return json({ error: 'temporal' }, 503); }
      const b = JSON.parse(init.body);
      wompi.posts.push({ body: b, auth: init.headers?.authorization });
      const id = `tx-${wompi.posts.length}`;
      wompi.transacciones.set(id, { id, reference: b.reference, amount_in_cents: b.amount_in_cents, currency: b.currency, status: 'PENDING', payment_method_type: 'NEQUI', payment_method: { type: 'NEQUI' } });
      return json({ data: wompi.transacciones.get(id) }, 201);
    }
    const m = /\/transactions\/([\w-]+)$/.exec(u);
    if (m) {
      const t = wompi.transacciones.get(m[1]);
      if (!t) return json({}, 404);
      return json({ data: { ...t, status: wompi.estado, amount_in_cents: wompi.monto ?? t.amount_in_cents, currency: wompi.moneda, reference: wompi.referencia ?? t.reference } });
    }
    return json({}, 404);
  }) as typeof fetch;
}
function firmar(t: any) {
  const timestamp = Math.floor(Date.now() / 1000);
  const checksum = createHash('sha256').update(`${t.id}${t.status}${t.amount_in_cents}${timestamp}${SECRETO_EVENTOS}`).digest('hex');
  return { event: 'transaction.updated', data: { transaction: t }, environment: 'prod', signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum }, timestamp, sent_at: new Date().toISOString() };
}
const webhook = (cuerpo: any) => E.app.inject({ method: 'POST', url: '/api/webhooks/wompi', payload: cuerpo, headers: { 'content-type': 'application/json' } });
const eventoDe = (p: any, status: string, extra: Record<string, unknown> = {}) => firmar({ id: p.transaccion_id, reference: p.referencia, amount_in_cents: 150000, currency: 'COP', status, ...extra });

describe('Fase 7 · Wompi (simulado) y confirmación real', () => {
  let conv: any;
  beforeAll(async () => {
    config.pagos.proveedor = 'wompi';
    Object.assign(config.pagos.wompi, { entorno: 'produccion', llavePublica: 'pub_prod_prueba', llavePrivada: 'prv_prod_prueba', secretoIntegridad: 'prod_integrity_prueba', secretoEventos: SECRETO_EVENTOS });
    setHttpComercio(wompiFalso());
    conv = await clienteWhatsApp('573170003001', 'Cliente Nequi', 'nequi@cliente.test');
  });

  it('con pagos reales apagados el pago en línea no se activa; encendidos, sí', async () => {
    config.comercio.liveEnabled = false;
    expect((await A.patch('/pagos/ajustes', { pago_manual: true, pago_en_linea: true })).status).toBe(400);
    config.comercio.liveEnabled = true;
    const r = await A.patch('/pagos/ajustes', { pago_manual: true, pago_en_linea: true });
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/prv_|prod_integrity|prod_events|pub_prod/);
  });

  let pedido = '';
  it('Nequi: la transacción se crea en la cola con el importe congelado, la llave privada y el celular del comprador', async () => {
    pedido = await pedidoListo(conv, 'NEQUI', 3);
    expect((await herramienta(conv, 'generar_cobro', { pedido_id: pedido, celular_nequi: '3170003001' })).decision).not.toBe('PERMITIDA');
    const pend = (await sql(`SELECT resumen FROM pending_action WHERE conversation_id=$1 AND herramienta='generar_cobro' ORDER BY creado_en DESC LIMIT 1`, [conv.id])).rows[0];
    expect(pend.resumen).toMatch(/exactamente \$1\.500 COP.*Nequi terminado en 3001.*https:\/\/wompi\.co\/terminos\.pdf.*https:\/\/wompi\.co\/datos\.pdf/);
    const r = (await herramienta(conv, 'generar_cobro', { pedido_id: pedido, celular_nequi: '3170003001' }, true)).resultado as any;
    expect(r.estado).toBe('PENDIENTE_PAGO');
    expect(r.para_el_cliente).toMatch(/Nequi terminado en 3001/);
    await drain(E.db);
    const post = wompi.posts.at(-1);
    expect(post.auth).toBe('Bearer prv_prod_prueba');
    expect(post.body).toMatchObject({ amount_in_cents: 150000, currency: 'COP', acceptance_token: 'tok_terminos', accept_personal_auth: 'tok_datos', payment_method: { type: 'NEQUI', phone_number: '3170003001' } });
    expect(post.body.reference).toMatch(/^CP-/);
    expect(post.body.signature).toBe(createHash('sha256').update(`${post.body.reference}150000COPprod_integrity_prueba`).digest('hex'));
    expect(await pago(pedido)).toMatchObject({ estado: 'PROCESANDO', transaccion_id: `tx-${wompi.posts.length}`, celular_final: '3001' });
  });

  it('firma inválida: 401 y nada cambia', async () => {
    const ev = eventoDe(await pago(pedido), 'APPROVED');
    ev.signature.checksum = 'f'.repeat(64);
    expect((await webhook(ev)).statusCode).toBe(401);
    expect((await pago(pedido)).estado).toBe('PROCESANDO');
  });

  it('el evento dice APPROVED pero Wompi aún dice PENDING: se cree a Wompi, no al evento', async () => {
    wompi.estado = 'PENDING';
    const rr = await webhook(eventoDe(await pago(pedido), 'APPROVED'));
    expect(rr.statusCode).toBe(200);
    expect((await pago(pedido)).estado).toBe('PROCESANDO');
  });

  it('aprobado: confirma el pedido, registra el recaudo y avisa; el evento repetido no duplica nada', async () => {
    wompi.estado = 'APPROVED';
    const ev = eventoDe(await pago(pedido), 'APPROVED');
    expect((await webhook(ev)).statusCode).toBe(200);
    expect((await webhook(ev)).statusCode).toBe(200);
    const final = await pago(pedido);
    expect(final).toMatchObject({ estado: 'PAGADO', estado_proveedor: 'APPROVED', comision_centavos: null });
    expect(Number(final.monto_reportado_centavos)).toBe(150000);
    expect(Number(final.total_oficial_centavos)).toBeGreaterThan(150000);
    const l = await ledger(final.id);
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ tipo: 'RECAUDO', estado: 'PENDIENTE_COMISION' });
    expect((await sql(`SELECT pedido_estado, estado FROM "order" WHERE id=$1`, [pedido])).rows[0]).toEqual({ pedido_estado: 'PAGADO', estado: 'CONFIRMADA' });
    await drain(E.db);
    expect(await avisos('PAGO_CONFIRMADO', final.referencia)).toBe(1);
  });

  let n = 3002;
  const nuevoCobro = async () => {
    const tel = `57317000${n++}`;
    const c = await clienteWhatsApp(tel, `Cliente ${tel.slice(-4)}`, `c${tel.slice(-4)}@cliente.test`);
    const ped = await pedidoListo(c, 'NEQUI');
    wompi.estado = 'PENDING';
    await herramienta(c, 'generar_cobro', { pedido_id: ped, celular_nequi: tel.slice(2) }, true);
    await drain(E.db);
    return { c, ped, p: await pago(ped), tel };
  };

  it('importe distinto al esperado: queda en revisión con la discrepancia registrada', async () => {
    const { ped, p } = await nuevoCobro();
    wompi.estado = 'APPROVED'; wompi.monto = 100;
    await webhook(eventoDe(p, 'APPROVED', { amount_in_cents: 100 }));
    wompi.monto = null;
    expect((await pago(ped)).estado).toBe('EN_REVISION');
    expect((await sql(`SELECT pedido_estado FROM "order" WHERE id=$1`, [ped])).rows[0].pedido_estado).toBe('EN_REVISION');
    expect((await sql(`SELECT tipo, esperado, recibido FROM payment_reconciliation WHERE commerce_payment_id=$1`, [p.id])).rows[0]).toEqual({ tipo: 'MONTO', esperado: '150000', recibido: '100' });
    expect(await ledger(p.id)).toHaveLength(0);
  });

  it('moneda y referencia incorrectas: en revisión', async () => {
    const a = await nuevoCobro();
    wompi.estado = 'APPROVED'; wompi.moneda = 'USD';
    await webhook(eventoDe(a.p, 'APPROVED', { currency: 'USD' }));
    wompi.moneda = 'COP';
    expect((await pago(a.ped)).estado).toBe('EN_REVISION');
    const b = await nuevoCobro();
    wompi.estado = 'APPROVED'; wompi.referencia = 'CP-OTRA-REFERENCIA';
    await webhook(eventoDe(b.p, 'APPROVED'));
    wompi.referencia = null;
    expect((await pago(b.ped)).estado).toBe('EN_REVISION');
    expect((await sql(`SELECT tipo FROM payment_reconciliation WHERE commerce_payment_id=$1`, [b.p.id])).rows[0].tipo).toBe('REFERENCIA');
  });

  it('rechazado: queda RECHAZADO, avisa y permite intentar de nuevo', async () => {
    const { c, ped, p, tel } = await nuevoCobro();
    wompi.estado = 'DECLINED';
    await webhook(eventoDe(p, 'DECLINED'));
    expect((await pago(ped)).estado).toBe('RECHAZADO');
    await drain(E.db);
    expect(await avisos('PAGO_RECHAZADO', p.referencia)).toBe(1);
    wompi.estado = 'PENDING';
    expect(((await herramienta(c, 'generar_cobro', { pedido_id: ped, celular_nequi: tel.slice(2) }, true)).resultado as any).estado).toBe('PENDIENTE_PAGO');
  });

  it('Wompi falla: se reintenta y, agotados los intentos, queda en ERROR', async () => {
    wompi.fallarPost = 99;
    const b = await nuevoCobro();
    for (let i = 0; i < 6; i++) { await sql(`UPDATE job SET ejecutar_en=now() WHERE tipo='cobro_comercio_crear'`); await drain(E.db); }
    wompi.fallarPost = 0;
    expect((await pago(b.ped)).estado).toBe('ERROR');
    expect((await sql(`SELECT pedido_estado FROM "order" WHERE id=$1`, [b.ped])).rows[0].pedido_estado).toBe('ERROR');
  });

  it('cambiar el modo global no cambia cobros anteriores; en modo oficial se cobra el total', async () => {
    const antes = Number((await pago(pedido)).monto_cobro_centavos);
    config.comercio.pricingMode = 'official';
    expect(Number((await pago(pedido)).monto_cobro_centavos)).toBe(antes);
    const c = await clienteWhatsApp('573170003099', 'Cliente Oficial', 'oficial@cliente.test');
    const ped = await pedidoListo(c, 'NEQUI', 1, 'Aceite para barba');
    expect((await herramienta(c, 'calcular_total', { pedido_id: ped })).resultado).toMatchObject({ modo: 'official', distintos: false });
    await herramienta(c, 'generar_cobro', { pedido_id: ped, celular_nequi: '3170003099' }, true);
    const p = await pago(ped);
    expect(Number(p.monto_cobro_centavos)).toBe(Math.round(Number((await producto('Aceite para barba')).precio) * 100));
    expect(p.modo_precios).toBe('official');
    config.comercio.pricingMode = 'institutional_test';
  });

  it('las respuestas del panel nunca exponen llaves, secretos ni el celular completo', async () => {
    const todo = JSON.stringify([(await A.get('/pagos/ajustes')).body, (await A.get('/pagos/cobros')).body, (await A.get('/pagos/pedidos')).body, (await A.get('/pagos/historial')).body]);
    expect(todo).not.toMatch(/prv_prod|pub_prod|prod_integrity|prod_events|tok_terminos|3170003001/);
  });

  it('otra empresa no ve cobros ni pedidos ajenos', async () => {
    expect((await B.get('/pagos/cobros')).body.cobros).toHaveLength(0);
    expect((await B.get('/pagos/pedidos')).body.pedidos).toHaveLength(0);
    expect((await B.post(`/pagos/cobros/${(await pago(pedido)).id}/verificar`)).status).toBe(404);
  });
});
