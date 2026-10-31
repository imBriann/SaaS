import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, login, loginOperador, op, api, CRED, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { drain } from '../src/worker/jobs.js';
import { MetaSimulada, setMetaOnboarding } from '../src/numeros/meta.js';
import { ESPERA_REGISTRO } from '../src/numeros/plataforma.js';
import { verificarWhatsapp } from '../src/modules/channelStatus.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { decrypt, uuidv7 } from '../src/lib/util.js';

/**
 * Vincular números de la WABA de Omnegia desde el panel, sin código ni Meta Developers (Meta simulada):
 * lista en vivo cruzada con la base, número reservado de la plataforma, asignación única, registro con PIN
 * cifrado, verificación con código, alta con límite, desasignación, desregistro y el panel de la empresa.
 */
let E: Env;
let O: ReturnType<typeof op>;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
const meta = new MetaSimulada();
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
const fila = async (id: string) => (await O.get('/numeros')).body.numeros.find((n: any) => n.id === id);

let patitas = '';
let pendiente = '';
const reservado = 'sim-num-omnegia';

beforeAll(async () => {
  E = await setup();
  setMetaOnboarding(meta);
  ESPERA_REGISTRO.ms = 1;
  config.whatsapp.limiteNumerosWaba = 10;
  config.whatsapp.plataformaPhoneNumberId = reservado;
  meta.sembrar({ id: reservado, numero: '+57 300 000 0000', nombre: 'Omnegia' });
  // Como el número de Patitas del Zulia: agregado y registrado a mano, CONNECTED y sin asignar.
  patitas = meta.sembrar({ numero: '+57 322 750 0767', nombre: 'Patitas del Zulia' }).id;
  // Verificado pero no registrado en la Cloud API: no recibe ni envía.
  pendiente = meta.sembrar({ numero: '+57 310 555 0101', nombre: 'Negocio pendiente', estado: 'PENDING', verificacion: 'VERIFIED', plataforma: 'NOT_APPLICABLE' }).id;
  O = op(E.app, await loginOperador(E.app, E.db));
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => {
  setMetaOnboarding(null);
  config.whatsapp.plataformaPhoneNumberId = undefined;
  await E.app.close();
  await E.db.close();
});

describe('Lista en vivo de la WABA (operador)', () => {
  it('muestra cada número con su estado, a quién pertenece y qué se puede hacer', async () => {
    const r = await O.get('/numeros');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configurada: true, simulado: true, limite: 10 });
    const p = r.body.numeros.find((n: any) => n.id === patitas);
    expect(p).toMatchObject({ numero: '+57 322 750 0767', operativo: true, asignado: null, texto: 'Conectado · sin asignar' });
    expect(p.acciones).toContain('asignar');
    const pend = r.body.numeros.find((n: any) => n.id === pendiente);
    expect(pend.operativo).toBe(false);
    expect(pend.acciones).toContain('registrar');
  });

  it('el número del asistente de Omnegia está reservado y no se asigna', async () => {
    const x = await fila(reservado);
    expect(x).toMatchObject({ reservado: true, acciones: [] });
    const r = await O.post(`/numeros/${reservado}/asignar`, { tenant_id: E.B });
    expect(r.status).toBe(409);
  });

  it('una empresa no ve ni asigna números de la WABA', async () => {
    const res = await E.app.inject({ method: 'GET', url: '/api/operador/numeros', headers: { cookie: await login(E.app, ...CRED.admin) } });
    expect(res.statusCode).toBe(404);
    // Ni escribiendo el identificador a mano en Configuración.
    const p = await A.patch('/configuracion/empresa', { whatsapp_phone_number_id: '1444821255372205' });
    expect(p.status).toBe(400);
    expect((await sql(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [E.A])).rows[0].whatsapp_phone_number_id).toBe('sim-elparche');
  });

  it('soporte (sin el permiso de números) no puede gestionarlos', async () => {
    const S = op(E.app, await loginOperador(E.app, E.db, 'soporte@saas.test', 'demo-soporte-2026'));
    expect((await S.get('/numeros')).status).toBe(403);
    expect((await S.post(`/numeros/${patitas}/asignar`, { tenant_id: E.A })).status).toBe(403);
  });
});

describe('Asignar un número a una empresa', () => {
  it('busca empresas por nombre y asigna sin escribir identificadores', async () => {
    const e = (await O.get('/numeros/empresas?q=parche')).body.empresas;
    expect(e.map((x: any) => x.id)).toContain(E.A);
    const r = await O.post(`/numeros/${patitas}/asignar`, { tenant_id: E.A });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, operativo: true });
    const t = (await sql(`SELECT whatsapp_phone_number_id, whatsapp_estado, whatsapp_numero_visible FROM tenant WHERE id=$1`, [E.A])).rows[0];
    expect(t).toMatchObject({ whatsapp_phone_number_id: patitas, whatsapp_estado: 'SIMULADO', whatsapp_numero_visible: '+57 322 750 0767' });
    expect((await fila(patitas)).asignado).toMatchObject({ id: E.A });
    const aud = (await sql(`SELECT accion FROM auditoria_plataforma WHERE recurso_id=$1`, [patitas])).rows.map((x) => x.accion);
    expect(aud).toContain('numero_waba.asignar');
  });

  it('los mensajes que llegan a ese número los atiende esa empresa, sin reiniciar nada', async () => {
    await receiveChannelMessages(E.db, [{ phoneNumberId: patitas, from: '573019990001', nombre: 'Cliente Patitas', id: `wa.${uuidv7()}`, texto: 'hola' }], 'WHATSAPP', 't');
    await drain(E.db);
    const c = (await sql(`SELECT tenant_id FROM customer WHERE telefono LIKE '%3019990001'`)).rows[0];
    expect(c.tenant_id).toBe(E.A);
  });

  it('asignar un número que ya tiene otra empresa falla con un mensaje claro', async () => {
    const r = await O.post(`/numeros/${patitas}/asignar`, { tenant_id: E.B });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/ya está asignado a «.+»/);
  });

  it('desasignar deja el número libre sin desregistrarlo', async () => {
    const antes = meta.llamadas.filter((x) => x === 'desregistrar').length;
    const r = await O.post(`/numeros/${patitas}/desasignar`);
    expect(r.status).toBe(200);
    expect((await sql(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [E.A])).rows[0].whatsapp_phone_number_id).toBeNull();
    expect(meta.llamadas.filter((x) => x === 'desregistrar').length).toBe(antes);
    expect(await fila(patitas)).toMatchObject({ asignado: null, operativo: true });
  });
});

describe('Verificado pero no registrado: «Registrar en la API»', () => {
  it('el camino manual nunca lo deja PENDING sin ofrecer el registro', async () => {
    await sql(`UPDATE tenant SET whatsapp_phone_number_id='9990001112223' WHERE id=$1`, [E.B]);
    const canal = { diagnose: async () => ({ ok: true, numero: '+57 310 555 0101', nombre: 'Gimnasio', estado: 'PENDING', plataforma: 'CLOUD_API' }) };
    const r = await verificarWhatsapp(E.db, E.B, 'prueba', undefined, canal);
    expect(r).toMatchObject({ estado: 'PENDIENTE_REGISTRO', acciones: ['registrar'] });
    expect(r.mensaje).toMatch(/registrar/i);
    expect((await sql(`SELECT whatsapp_estado FROM tenant WHERE id=$1`, [E.B])).rows[0].whatsapp_estado).toBe('PENDIENTE_REGISTRO');
    await sql(`UPDATE tenant SET whatsapp_phone_number_id=NULL, whatsapp_estado='SIN_CONFIGURAR' WHERE id=$1`, [E.B]);
  });

  it('al asignarlo, la empresa ve «Necesita atención» y el operador «Registrar en la API»', async () => {
    const r = await O.post(`/numeros/${pendiente}/asignar`, { tenant_id: E.B });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ operativo: false, acciones: ['registrar'] });
    expect((await B.get('/numeros/whatsapp')).body.estado).toBe('NECESITA_ATENCION');
  });

  it('registra con un PIN aleatorio cifrado que no aparece en respuestas ni registros', async () => {
    const espias = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];
    const r = await O.post(`/numeros/${pendiente}/registrar`);
    expect(r.status).toBe(200);
    expect(r.body.operativo).toBe(true);
    const guardado = (await sql(`SELECT pin_cifrado FROM numero_credencial_plataforma WHERE phone_number_id=$1`, [pendiente])).rows[0].pin_cifrado;
    const pin = decrypt(config.appKey, guardado);
    expect(pin).toMatch(/^\d{6}$/);
    expect(guardado).not.toContain(pin);
    const lista = await O.get('/numeros');
    for (const texto of [r.raw, lista.raw]) expect(texto).not.toContain(pin);
    for (const e of espias) { for (const c of e.mock.calls) expect(JSON.stringify(c)).not.toContain(pin); e.mockRestore(); }
    const aud = JSON.stringify((await sql(`SELECT detalle FROM auditoria_plataforma WHERE recurso_id=$1`, [pendiente])).rows);
    expect(aud).not.toContain(pin);
    // La empresa queda conectada sin hacer nada más.
    expect((await B.get('/numeros/whatsapp')).body.estado).toBe('CONECTADO');
    expect((await fila(pendiente)).acciones).toContain('ver_pin');
  });

  it('«Ver PIN» exige motivo y queda auditado (sin el PIN)', async () => {
    expect((await O.post(`/numeros/${pendiente}/pin`, {})).status).toBe(400);
    const r = await O.post(`/numeros/${pendiente}/pin`, { motivo: 'Migración del número a otro proveedor' });
    expect(r.status).toBe(200);
    expect(r.body.pin).toMatch(/^\d{6}$/);
    const a = (await sql(`SELECT motivo, detalle FROM auditoria_plataforma WHERE recurso_id=$1 AND accion='numero_waba.ver_pin'`, [pendiente])).rows[0];
    expect(a.motivo).toMatch(/Migración/);
    expect(JSON.stringify(a.detalle)).not.toContain(r.body.pin);
  });
});

describe('Alta de un número nuevo con código (Meta simulada)', () => {
  let id = '';
  it('agrega, envía el código, verifica, registra, asigna, desasigna y desregistra', async () => {
    const a = await O.post('/numeros', { nombre_visible: 'Fuerza Norte', pais: 'CO', numero: '300 111 2233' });
    expect(a.status).toBe(200);
    id = a.body.id;
    expect((await fila(id)).acciones).toEqual(expect.arrayContaining(['enviar_codigo', 'verificar_codigo']));
    expect((await O.post(`/numeros/${id}/registrar`)).status).toBe(409);
    expect((await O.post(`/numeros/${id}/codigo`, { metodo: 'SMS' })).status).toBe(200);
    expect((await O.post(`/numeros/${id}/verificar`, { codigo: '000000' })).status).toBe(409);
    expect((await O.post(`/numeros/${id}/verificar`, { codigo: '123456' })).status).toBe(200);
    expect((await fila(id)).acciones).toContain('registrar');
    expect((await O.post(`/numeros/${id}/registrar`)).body.operativo).toBe(true);
    await O.post(`/numeros/${pendiente}/desasignar`);
    expect((await O.post(`/numeros/${id}/asignar`, { tenant_id: E.B })).status).toBe(200);
    expect((await O.post(`/numeros/${id}/desasignar`)).status).toBe(200);
    expect((await O.post(`/numeros/${id}/desregistrar`, {})).status).toBe(400);
    const d = await O.post(`/numeros/${id}/desregistrar`, { confirmacion: 'DESREGISTRAR' });
    expect(d.status).toBe(200);
    expect(meta.llamadas).toContain('desregistrar');
    expect((await fila(id)).estado_meta).toBe('DISCONNECTED');
  });

  it('con el límite de la WABA alcanzado lo explica y no llama a Meta', async () => {
    const usados = (await O.get('/numeros')).body.usados;
    config.whatsapp.limiteNumerosWaba = usados;
    const antes = meta.llamadas.filter((x) => x === 'agregar').length;
    const r = await O.post('/numeros', { nombre_visible: 'Otro negocio', pais: 'CO', numero: '300 444 5566' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/2/);
    expect(r.body.error.message).toMatch(/verifica/i);
    expect(meta.llamadas.filter((x) => x === 'agregar').length).toBe(antes);
    expect((await O.get('/numeros')).body.puede_agregar).toBe(false);
    config.whatsapp.limiteNumerosWaba = 10;
  });
});

describe('Panel de la empresa: «Conectar WhatsApp»', () => {
  it('muestra las opciones: número propio activo; compra y cuenta propia «Próximamente»', async () => {
    const e = (await A.get('/numeros/whatsapp')).body;
    expect(e.estado).toBe('SIN_CONECTAR');
    expect(e.opciones.propio.disponible).toBe(true);
    expect(e.opciones.compra.proximamente).toBe(true);
    expect(e.opciones.cuenta_propia).toMatchObject({ proximamente: true });
    expect(e.opciones.cuenta_propia.motivo).toMatch(/próximamente/i);
  });

  it('«Probar conexión» respeta la ventana de 24 horas', async () => {
    await O.post(`/numeros/${patitas}/asignar`, { tenant_id: E.A });
    const e = (await A.get('/numeros/whatsapp')).body;
    expect(e).toMatchObject({ estado: 'CONECTADO', puede_probar: true });
    expect(e.texto).toMatch(/^Conectado: \+57 322 750 0767/);
    const fuera = await A.post('/numeros/whatsapp/probar', { telefono: '300 999 8877' });
    expect(fuera.status).toBe(409);
    expect(fuera.body.error.message).toMatch(/escribe primero/i);
    // Quien escribió hace un momento sí recibe la prueba.
    const ok = await A.post('/numeros/whatsapp/probar', { telefono: '301 999 0001' });
    expect(ok.status).toBe(200);
  });

  it('«Desconectar» pide confirmación, desregistra y deja el número libre', async () => {
    expect((await A.post('/numeros/whatsapp/desconectar', {})).status).toBe(400);
    const r = await A.post('/numeros/whatsapp/desconectar', { confirmacion: 'DESCONECTAR' });
    expect(r.status).toBe(200);
    expect(r.body.estado.estado).toBe('DESCONECTADO');
    expect((await sql(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [E.A])).rows[0].whatsapp_phone_number_id).toBeNull();
    expect((await fila(patitas)).asignado).toBeNull();
  });
});
