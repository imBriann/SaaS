import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { drain, HANDLERS } from '../src/worker/jobs.js';
import { config } from '../src/config.js';
import { signMeta } from '../src/adapters/channel.js';
import { procesarEventoPago } from '../src/modules/billing.js';
import { SimuladorNumeros } from '../src/numeros/simulado.js';
import { ErrorProveedor, setProveedorNumeros } from '../src/numeros/proveedor.js';
import { ErrorMeta, MetaSimulada, setMetaOnboarding } from '../src/numeros/meta.js';

/**
 * Contratación de un número de WhatsApp de punta a punta, con el inventario de demostración y
 * una Meta simulada controlable. Cubre pago rechazado y con retraso, número agotado, errores del
 * proveedor, documentos en revisión, verificación que requiere al cliente, fallo de activación,
 * reanudación, duplicados, cancelación con liberación y aislamiento entre empresas.
 *
 * NO valida contra Telnyx ni Meta reales: esas llamadas se prueban por su forma en numeros-adaptadores.test.ts.
 */
class MetaPrueba extends MetaSimulada {
  dicta: string | null = null;
  fallarRegistro: ErrorMeta | null = null;
  estadoMeta = 'CONNECTED';
  override async registrar() { this.llamadas.push('registrar'); if (this.fallarRegistro) { const e = this.fallarRegistro; this.fallarRegistro = null; throw e; } }
  override async consultar() { return { ...(await super.consultar()), estado: this.estadoMeta }; }
  override llamadaSimulada() { return this.dicta; }
}

let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
const sim = new SimuladorNumeros();
const meta = new MetaPrueba();
const tasaOriginal = config.numeros.comercial.tasaUsdCop;

const PDF = Buffer.from('%PDF-1.4 documento de prueba').toString('base64');
const valoresRequisitos = { valores: {
  'sim-req-razon': 'Barbería El Parche S.A.S.',
  'sim-req-direccion': { nombre: 'Andrea', apellido: 'Jaimes', empresa: 'Barbería El Parche', direccion: 'Calle 5 # 2-10', ciudad: 'Bogotá' },
  'sim-req-documento': { nombre: 'camara.pdf', base64: PDF },
} };

const simular = (ref: string, resultado: 'aprobado' | 'rechazado', entregas = 1) => E.app.inject({ method: 'POST', url: '/api/pasarela/simular', payload: { ref, resultado, entregas } });
const fila = (id: string) => E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM numero_contratacion WHERE id=$1`, [id])).rows[0]);
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
/** Los reintentos esperan con retroceso: en la prueba se adelantan. */
const adelantar = async () => { await sql(`UPDATE job SET ejecutar_en=now() WHERE estado='PENDIENTE' AND tipo LIKE 'numero_%'`); await sql(`UPDATE numero_contratacion SET bloqueo_hasta=NULL`); await drain(E.db); };

async function hastaPago(cli: ReturnType<typeof api>, numero?: string) {
  const d = (await cli.get('/numeros/disponibles?pais=CO&tipo=local')).body;
  const elegido = numero ?? d.numeros.find((n: any) => !sim.vendidos.has(n.numero)).numero;
  const c = (await cli.post('/numeros/contrataciones', { numero: elegido, pais: 'CO', tipo: 'local' })).body;
  expect(c.estado).toBe('SELECCION_NUMERO');
  const r = (await cli.post(`/numeros/contrataciones/${c.id}/requisitos`, valoresRequisitos)).body;
  expect(r.estado).toBe('CONFIRMACION_PENDIENTE');
  const p = await cli.post(`/numeros/contrataciones/${c.id}/confirmar`, { total_hoy: r.cotizacion.total_hoy, total_mensual: r.cotizacion.total_mensual, acepto_cargo: true, acepto_mensualidad: true, acepto_condiciones: true });
  expect(p.status).toBe(200);
  return { id: c.id as string, ref: p.body.referencia as string, numero: elegido as string };
}

beforeAll(async () => {
  E = await setup();
  config.numeros.comercial.tasaUsdCop = 4000;
  setProveedorNumeros(sim);
  setMetaOnboarding(meta);
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => {
  config.numeros.comercial.tasaUsdCop = tasaOriginal;
  setProveedorNumeros(null);
  setMetaOnboarding(null);
  await E.app.close();
  await E.db.close();
});

describe('Compra y activación de un número (camino completo)', () => {
  let id = '';
  let ref = '';
  let numero = '';

  it('ofrece Colombia con tipos elegibles y precios calculados en el servidor', async () => {
    const o = (await A.get('/numeros/opciones')).body;
    expect(o.disponible).toBe(true);
    expect(o.proveedor.entorno).toBe('simulado');
    const co = o.paises.find((p: any) => p.pais === 'CO');
    expect(co.tipos.find((t: any) => t.tipo === 'local').elegible).toBe(true);
    // Los gratuitos no reciben la llamada internacional de verificación: no se ofrecen.
    expect(co.tipos.find((t: any) => t.tipo === 'toll_free').elegible).toBe(false);
    expect(o.meta.gratis).toMatch(/24 horas/);
    const d = (await A.get('/numeros/disponibles?pais=CO&tipo=local')).body;
    expect(d.simulado).toBe(true);
    expect(d.numeros.length).toBeGreaterThan(2);
    // 1 USD × 4000 × 1,05 (colchón) = 4200 por la activación y 4200 por el primer mes; sin margen ni IVA definido.
    expect(d.numeros[0].precio).toMatchObject({ activacion: 4200, mensual: 4200, hoy: 8400, iva_regimen: 'PENDIENTE' });
    expect(d.tasa.valor).toBe(4000);
  });

  it('una persona sin permiso de suscripción no puede comprar', async () => {
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await laura.post('/numeros/contrataciones', { numero: '+576015550110', pais: 'CO', tipo: 'local' })).status).toBe(403);
  });

  it('pide los requisitos antes de pagar y rechaza precios manipulados o sin consentimiento', async () => {
    const c = (await A.post('/numeros/contrataciones', { numero: '+576015550110', pais: 'CO', tipo: 'local' })).body;
    id = c.id; numero = c.numero;
    expect(c.estado).toBe('SELECCION_NUMERO');
    expect(c.requisitos.lista).toHaveLength(3);
    expect((await A.post(`/numeros/contrataciones/${id}/confirmar`, { total_hoy: 8400, total_mensual: 4200, acepto_cargo: true, acepto_mensualidad: true, acepto_condiciones: true })).status).toBe(409);
    expect((await A.post(`/numeros/contrataciones/${id}/requisitos`, { valores: { 'sim-req-razon': 'X' } })).status).toBe(400);
    const r = (await A.post(`/numeros/contrataciones/${id}/requisitos`, valoresRequisitos)).body;
    expect(r.estado).toBe('CONFIRMACION_PENDIENTE');
    // Solo quedan identificadores del proveedor: ni la dirección ni el documento se guardan.
    expect(JSON.stringify(await fila(id))).not.toMatch(/Calle 5|JVBERi/);
    const bajo = await A.post(`/numeros/contrataciones/${id}/confirmar`, { total_hoy: 100, total_mensual: 4200, acepto_cargo: true, acepto_mensualidad: true, acepto_condiciones: true });
    expect(bajo.status).toBe(409);
    const sinConsentir = await A.post(`/numeros/contrataciones/${id}/confirmar`, { total_hoy: 8400, total_mensual: 4200, acepto_cargo: true, acepto_mensualidad: false, acepto_condiciones: true });
    expect(sinConsentir.status).toBe(400);
  });

  it('genera un único checkout y vuelve a confirmación si el pago se rechaza', async () => {
    const cuerpo = { total_hoy: 8400, total_mensual: 4200, acepto_cargo: true, acepto_mensualidad: true, acepto_condiciones: true };
    const p1 = (await A.post(`/numeros/contrataciones/${id}/confirmar`, cuerpo)).body;
    const p2 = (await A.post(`/numeros/contrataciones/${id}/confirmar`, cuerpo)).body;
    expect(p1.referencia).toMatch(/^NUM-/);
    expect(p2.referencia).toBe(p1.referencia);
    expect((await fila(id)).estado).toBe('PAGO_PENDIENTE');
    await simular(p1.referencia, 'rechazado');
    const f = await fila(id);
    expect(f.estado).toBe('CONFIRMACION_PENDIENTE');
    expect(f.subestado).toBe('pago_rechazado');
    expect(sim.ordenes.size).toBe(0);
    ref = (await A.post(`/numeros/contrataciones/${id}/confirmar`, cuerpo)).body.referencia;
    expect(ref).not.toBe(p1.referencia);
  });

  it('un pago en proceso no activa nada', async () => {
    const pago = (await sql(`SELECT monto FROM payment WHERE referencia=$1`, [ref])).rows[0];
    await procesarEventoPago(E.db, { id: `evt-pend-${ref}`, proveedor: 'simulada', referencia: ref, estado: 'PENDIENTE', montoCentavos: Number(pago.monto) * 100, moneda: 'COP' }, 'prueba', 'prueba');
    const f = await fila(id);
    expect(f.estado).toBe('PAGO_PENDIENTE');
    expect(f.subestado).toBe('pago_en_proceso');
    await drain(E.db);
    expect(sim.ordenes.size).toBe(0);
  });

  it('el pago aprobado (entregado dos veces) compra el número una sola vez', async () => {
    const r = await simular(ref, 'aprobado', 2);
    expect(r.statusCode).toBe(200);
    await drain(E.db);
    expect(sim.ordenes.size).toBe(1);
    const f = await fila(id);
    expect(f.estado).toBe('REGISTRO_WHATSAPP_PENDIENTE');
    expect(f.accion_cliente).toBe('registro_meta');
    expect(f.numero_proveedor_id).toBeTruthy();
    expect(new Date(f.periodo_fin).getTime()).toBeGreaterThan(Date.now() + 27 * 86_400_000);
    const v = (await A.get('/numeros/contratacion')).body.contratacion;
    expect(v.etapas.map((e: any) => e.estado)).toEqual(['hecho', 'hecho', 'accion', 'pendiente', 'pendiente', 'pendiente']);
    expect(v.pagos.filter((p: any) => p.estado === 'APROBADO')).toHaveLength(1);
  });

  it('otra empresa no ve ni opera esta contratación', async () => {
    expect((await B.post(`/numeros/contrataciones/${id}/cancelar`, {})).status).toBe(404);
    expect((await B.post(`/numeros/contrataciones/${id}/meta`, { code: 'sim-xxxxxxxx', waba_id: 'sim-waba-123' })).status).toBe(404);
    expect((await B.get('/numeros/contratacion')).body.contratacion).toBeNull();
  });

  it('tras el registro con Meta verifica con la llamada de voz y conecta el número', async () => {
    const m = await A.post(`/numeros/contrataciones/${id}/meta`, { code: 'sim-codigo-registro', waba_id: 'sim-waba-123', nombre_visible: 'Barbería El Parche' });
    expect(m.status).toBe(200);
    expect(m.body.estado).toBe('VERIFICACION_PENDIENTE');
    await drain(E.db);
    let f = await fila(id);
    expect(f.subestado).toBe('esperando_llamada');
    expect(meta.llamadas).toEqual(expect.arrayContaining(['token', 'suscribir', 'agregar', 'codigo']));
    // Meta llama al número: la aplicación TeXML responde con la transcripción firmada.
    const voz = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx/voz', payload: `To=${encodeURIComponent(numero)}&From=%2B15550001111`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(voz.headers['content-type']).toMatch(/xml/);
    expect(voz.body).toContain('<Transcription');
    const enlace = new URL(voz.body.match(/transcriptionCallback="([^"]+)"/)![1].replace(/&amp;/g, '&'));
    // Un enlace sin la firma correcta no sirve.
    const falso = await E.app.inject({ method: 'POST', url: `${enlace.pathname}?c=${id}&k=00`, payload: { Transcript: 'uno dos tres cuatro cinco seis', IsFinal: 'true' } });
    expect(falso.statusCode).toBe(404);
    const t = await E.app.inject({ method: 'POST', url: `${enlace.pathname}${enlace.search}`, payload: { Transcript: 'Su código de WhatsApp es uno dos tres cuatro cinco seis', IsFinal: 'true' } });
    expect(t.json().codigo).toBe(true);
    // El código nunca queda en la bitácora.
    expect(JSON.stringify((await sql(`SELECT detalle FROM numero_evento WHERE contratacion_id=$1`, [id])).rows)).not.toContain('123456');
    await drain(E.db);
    f = await fila(id);
    expect(f.estado).toBe('CONECTADO');
    expect(f.accion_cliente).toBe('prueba');
    const t2 = (await sql(`SELECT whatsapp_phone_number_id, whatsapp_estado FROM tenant WHERE id=$1`, [E.A])).rows[0];
    expect(t2.whatsapp_phone_number_id).toBe(f.phone_number_id);
    expect(t2.whatsapp_estado).toBe('SIMULADO');
    // Las credenciales quedan cifradas y fuera del alcance del rol de ejecución.
    const cred = (await sql(`SELECT token_cifrado, pin_cifrado FROM numero_credencial WHERE contratacion_id=$1`, [id])).rows[0];
    expect(cred.token_cifrado).not.toMatch(/^sim-token/);
    await expect(E.db.withTenant(E.A, (tx) => tx.query(`SELECT * FROM numero_credencial`))).rejects.toThrow();
  });

  it('una llamada fuera de la verificación se rechaza', async () => {
    const voz = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx/voz', payload: `To=${encodeURIComponent(numero)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(voz.body).toContain('<Reject/>');
  });

  it('el primer mensaje real completa la prueba de funcionamiento y lo atiende la IA', async () => {
    const f = await fila(id);
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: f.phone_number_id }, contacts: [{ wa_id: '573009998877', profile: { name: 'Dueña' } }], messages: [{ from: '573009998877', id: 'wamid.prueba1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hola, ¿están abiertos?' } }] } }] }] });
    const r = await E.app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(body) } });
    expect(r.json().recibidos[0].estado).toBe('aceptado');
    const v = (await A.get('/numeros/contratacion')).body.contratacion;
    expect(v.prueba_recibida_en).toBeTruthy();
    expect(v.etapas.every((e: any) => e.estado === 'hecho')).toBe(true);
    await drain(E.db);
    const salida = (await E.db.withTenant(E.A, (tx) => tx.query(`SELECT count(*)::int AS n FROM message m JOIN conversation c ON c.id=m.conversation_id JOIN customer k ON k.id=c.customer_id WHERE k.telefono='+573009998877' AND m.remitente <> 'CUSTOMER'`))).rows[0].n;
    expect(salida).toBeGreaterThan(0);
  });

  it('la mensualidad se paga desde 10 días antes y extiende el periodo un mes', async () => {
    expect((await A.post(`/numeros/contrataciones/${id}/renovar`)).status).toBe(409);
    await sql(`UPDATE numero_contratacion SET periodo_fin=now() + interval '3 days' WHERE id=$1`, [id]);
    const antes = new Date((await fila(id)).periodo_fin).getTime();
    const r = (await A.post(`/numeros/contrataciones/${id}/renovar`)).body;
    expect(r.monto).toBe(4200);
    await simular(r.referencia, 'aprobado');
    const despues = new Date((await fila(id)).periodo_fin).getTime();
    expect(despues - antes).toBeGreaterThan(27 * 86_400_000);
    // La mensualidad del número no toca la suscripción de Omnegia.
    expect((await sql(`SELECT count(*)::int AS n FROM subscription_period WHERE payment_id=(SELECT id FROM payment WHERE referencia=$1)`, [r.referencia])).rows[0].n).toBe(0);
  });

  it('la cancelación respeta el mes pagado, se puede revertir y al vencer libera el número', async () => {
    const c1 = (await A.post(`/numeros/contrataciones/${id}/cancelar`, {})).body;
    expect(c1.estado).toBe('CANCELACION_PENDIENTE');
    const rev = (await A.post(`/numeros/contrataciones/${id}/cancelar`, { revertir: true })).body;
    expect(rev.estado).toBe('CONECTADO');
    await A.post(`/numeros/contrataciones/${id}/cancelar`, {});
    await HANDLERS.ciclo_numeros(E.db, null, {}, { id: 'ciclo-prueba' });
    await drain(E.db);
    expect((await fila(id)).estado).toBe('CANCELACION_PENDIENTE');
    await sql(`UPDATE numero_contratacion SET periodo_fin=now() - interval '1 minute' WHERE id=$1`, [id]);
    await HANDLERS.ciclo_numeros(E.db, null, {}, { id: 'ciclo-prueba-2' });
    await drain(E.db);
    const f = await fila(id);
    expect(f.estado).toBe('CANCELADO');
    expect(f.liberado_en).toBeTruthy();
    expect(sim.liberados).toContain(f.numero_proveedor_id);
    expect(meta.llamadas).toContain('desregistrar');
    expect((await sql(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [E.A])).rows[0].whatsapp_phone_number_id).toBeNull();
  });
});

describe('Caminos difíciles', () => {
  it('número agotado al comprarlo: falla sin cobrar de nuevo y permite elegir otro', async () => {
    const { id, ref, numero } = await hastaPago(A);
    sim.agotados.add(numero);
    await sql(`UPDATE numero_contratacion SET reserva_expira_en=now() - interval '1 minute' WHERE id=$1`, [id]);
    await simular(ref, 'aprobado');
    await drain(E.db);
    let f = await fila(id);
    expect(f.estado).toBe('APROVISIONAMIENTO_FALLIDO');
    expect(f.subestado).toBe('numero_no_disponible');
    expect(f.accion_cliente).toBe('elegir_otro');
    expect((await sql(`SELECT count(*)::int AS n FROM incidente WHERE codigo='NUMERO_APROVISIONAMIENTO_FALLIDO'`)).rows[0].n).toBeGreaterThan(0);
    const otro = (await A.get('/numeros/disponibles?pais=CO&tipo=local')).body.numeros.find((n: any) => n.numero !== numero).numero;
    const r = await A.post(`/numeros/contrataciones/${id}/otro-numero`, { numero: otro });
    expect(r.status).toBe(200);
    await drain(E.db);
    f = await fila(id);
    expect(f.estado).toBe('REGISTRO_WHATSAPP_PENDIENTE');
    expect(f.numero_e164).toBe(otro);
    expect((await sql(`SELECT count(*)::int AS n FROM payment WHERE numero_contratacion_id=$1 AND estado='APROBADO'`, [id])).rows[0].n).toBe(1);
    sim.agotados.delete(numero);
    await A.post(`/numeros/contrataciones/${id}/cancelar`, {});
    await sql(`UPDATE numero_contratacion SET periodo_fin=now() - interval '1 minute' WHERE id=$1`, [id]);
    await HANDLERS.ciclo_numeros(E.db, null, {}, { id: 'c3' });
    await drain(E.db);
    expect((await fila(id)).estado).toBe('CANCELADO');
  });

  it('error temporal del proveedor: reintenta sin duplicar la orden; error definitivo: falla con alerta', async () => {
    const { id, ref } = await hastaPago(A);
    sim.fallos = [new ErrorProveedor('caída', true, '503', 503)];
    const ordenes = sim.ordenes.size;
    await simular(ref, 'aprobado');
    await drain(E.db);
    expect((await fila(id)).estado).toBe('APROVISIONANDO_NUMERO');
    await adelantar();
    expect((await fila(id)).estado).toBe('REGISTRO_WHATSAPP_PENDIENTE');
    expect(sim.ordenes.size).toBe(ordenes + 1);
    await A.post(`/numeros/contrataciones/${id}/cancelar`, {});
    await sql(`UPDATE numero_contratacion SET periodo_fin=now() - interval '1 minute' WHERE id=$1`, [id]);
    await HANDLERS.ciclo_numeros(E.db, null, {}, { id: 'c4' });
    await drain(E.db);

    const d = await hastaPago(A);
    sim.fallos = [new ErrorProveedor('rechazado', false, '400', 400)];
    await simular(d.ref, 'aprobado');
    await drain(E.db);
    const f = await fila(d.id);
    expect(f.estado).toBe('APROVISIONAMIENTO_FALLIDO');
    expect(f.subestado).toBe('error_proveedor');
    // El número no se compró: cancelar deja disponible el reembolso, sin mensualidad.
    const c = (await A.post(`/numeros/contrataciones/${d.id}/cancelar`, {})).body;
    expect(c.estado).toBe('CANCELADO');
    expect(c.accion_cliente).toBe('reembolso');
  });

  it('documentos en revisión: se adelanta Meta y al aprobarse la orden pasa directo a verificación', async () => {
    sim.revision = true;
    meta.dicta = null;
    const { id, ref } = await hastaPago(A);
    await simular(ref, 'aprobado');
    await drain(E.db);
    let f = await fila(id);
    expect(f.estado).toBe('APROVISIONANDO_NUMERO');
    expect(f.subestado).toBe('documentos_en_revision');
    // El registro con Meta se puede hacer mientras tanto.
    expect((await A.post(`/numeros/contrataciones/${id}/meta`, { code: 'sim-codigo-2', waba_id: 'sim-waba-456' })).body.estado).toBe('APROVISIONANDO_NUMERO');
    sim.aprobar(f.orden_id);
    // El proveedor avisa por webhook; se consulta la orden servidor a servidor.
    const ev = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx', payload: { data: { id: `ev-${id}`, event_type: 'number_order.complete', payload: { id: f.orden_id, record_type: 'number_order', customer_reference: id } } } });
    expect(ev.json().ok).toBe(true);
    const repetido = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx', payload: { data: { id: `ev-${id}`, event_type: 'number_order.complete', payload: { id: f.orden_id } } } });
    expect(repetido.json().duplicado).toBe(true);
    await drain(E.db);
    f = await fila(id);
    expect(f.estado).toBe('VERIFICACION_PENDIENTE');
    expect(f.subestado).toBe('esperando_llamada');
    sim.revision = false;

    // La llamada no trae código: tras 10 minutos se pide ayuda al cliente.
    await sql(`UPDATE numero_contratacion SET verificacion=jsonb_set(verificacion, '{solicitado_en}', to_jsonb((now() - interval '11 minutes')::text)) WHERE id=$1`, [id]);
    await HANDLERS.ciclo_numeros(E.db, null, {}, { id: 'c5' });
    await adelantar();
    f = await fila(id);
    expect(f.accion_cliente).toBe('verificacion_manual');
    // Código equivocado → se informa; reenviar la llamada al celular del dueño → TeXML marca a ese número.
    await A.post(`/numeros/contrataciones/${id}/verificacion/codigo`, { codigo: '000000' });
    await adelantar();
    expect((await fila(id)).subestado).toBe('codigo_incorrecto');
    await sql(`UPDATE numero_contratacion SET verificacion=jsonb_set(verificacion, '{solicitado_en}', to_jsonb((now() - interval '2 minutes')::text)) WHERE id=$1`, [id]);
    const otra = await A.post(`/numeros/contrataciones/${id}/verificacion/llamada`, { reenviar_a: '+573001234567' });
    expect(otra.status).toBe(200);
    await adelantar();
    const voz = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx/voz', payload: `To=${encodeURIComponent(f.numero_e164)}`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(voz.body).toContain('<Number>+573001234567</Number>');
    // El dueño escuchó el código y lo escribe en Omnegia. El registro falla una vez (Meta) y se reintenta.
    meta.fallarRegistro = new ErrorMeta('Meta rechazó la solicitud (100).', false, 100);
    await A.post(`/numeros/contrataciones/${id}/verificacion/codigo`, { codigo: '123-456' });
    await adelantar();
    f = await fila(id);
    expect(f.estado).toBe('CONEXION_FALLIDA');
    expect((await sql(`SELECT count(*)::int AS n FROM incidente WHERE codigo='NUMERO_CONEXION_FALLIDA'`)).rows[0].n).toBeGreaterThan(0);
    expect((await A.post(`/numeros/contrataciones/${id}/reintentar`)).body.estado).toBe('CONEXION_PENDIENTE');
    await adelantar();
    expect((await fila(id)).estado).toBe('CONECTADO');
  });

  it('el estado se recupera desde otra sesión (se cerró el navegador) y no se muestra conectado antes de tiempo', async () => {
    const otra = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
    const v = (await otra.get('/numeros/contratacion')).body.contratacion;
    expect(v.estado).toBe('CONECTADO');
    expect(v.etapas.find((e: any) => e.clave === 'prueba').estado).toBe('accion');
    // Meta todavía no reporta el número como conectado: se queda en conexión pendiente.
    const id = v.id;
    await A.post(`/numeros/contrataciones/${id}/cancelar`, {});
    await sql(`UPDATE numero_contratacion SET periodo_fin=now() - interval '1 minute' WHERE id=$1`, [id]);
    await HANDLERS.ciclo_numeros(E.db, null, {}, { id: 'c6' });
    await drain(E.db);
    meta.dicta = 'uno dos tres cuatro cinco seis';
    meta.estadoMeta = 'PENDING';
    const d = await hastaPago(A);
    await simular(d.ref, 'aprobado');
    await drain(E.db);
    await A.post(`/numeros/contrataciones/${d.id}/meta`, { code: 'sim-codigo-3', waba_id: 'sim-waba-789' });
    await drain(E.db);
    const f = await fila(d.id);
    expect(f.estado).toBe('CONEXION_PENDIENTE');
    expect(f.subestado).toBe('esperando_meta');
    expect((await A.get('/numeros/contratacion')).body.contratacion.etapas.find((e: any) => e.clave === 'activacion').estado).toBe('en_curso');
    meta.estadoMeta = 'CONNECTED';
    await adelantar();
    expect((await fila(d.id)).estado).toBe('CONECTADO');
  });

  it('no vende un número a quien ya tiene uno propio conectado (sin mensualidad duplicada)', async () => {
    await sql(`UPDATE tenant SET whatsapp_phone_number_id='1234567890123', whatsapp_estado='CONECTADO', whatsapp_numero_visible='+57 300 000 0000' WHERE id=$1`, [E.B]);
    const o = (await B.get('/numeros/opciones')).body;
    expect(o.disponible).toBe(false);
    expect(o.motivo).toMatch(/número propio/);
    expect((await B.post('/numeros/contrataciones', { numero: '+576015550115', pais: 'CO', tipo: 'local' })).status).toBe(409);
  });

  it('webhooks de Telnyx con llave configurada exigen firma Ed25519 válida', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const crudo = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    config.numeros.telnyx.llavePublica = crudo;
    try {
      const cuerpo = JSON.stringify({ data: { id: 'ev-firmado', event_type: 'number_order.complete', payload: { id: 'ord-x' } } });
      const ts = String(Math.floor(Date.now() / 1000));
      const firma = sign(null, Buffer.from(`${ts}|${cuerpo}`), privateKey).toString('base64');
      const ok = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx', payload: cuerpo, headers: { 'content-type': 'application/json', 'telnyx-signature-ed25519': firma, 'telnyx-timestamp': ts } });
      expect(ok.statusCode).toBe(200);
      const malo = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx', payload: cuerpo, headers: { 'content-type': 'application/json', 'telnyx-signature-ed25519': firma.replace(/^./, 'A'), 'telnyx-timestamp': ts } });
      expect(malo.statusCode).toBe(401);
      const sinFirma = await E.app.inject({ method: 'POST', url: '/api/webhooks/telnyx/voz', payload: 'To=%2B576015550110', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      expect(sinFirma.statusCode).toBe(401);
    } finally {
      config.numeros.telnyx.llavePublica = undefined;
    }
  });
});
