import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { ErrorMeta, MetaSimulada, setMetaOnboarding } from '../src/numeros/meta.js';

/**
 * Cambiar de número de WhatsApp: el número actual sigue funcionando hasta que el nuevo queda conectado; solo
 * entonces se desconecta el anterior (deregister). Si el nuevo falla, la empresa no se queda sin número.
 */
let E: Env;
let A: ReturnType<typeof api>;
const meta = new MetaSimulada();
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
const tenant = async () => (await sql(`SELECT whatsapp_phone_number_id AS pid, whatsapp_estado AS estado, whatsapp_numero_visible AS visible FROM tenant WHERE id=$1`, [E.A])).rows[0];
const fila = async (id: string) => (await sql(`SELECT * FROM numero_contratacion WHERE id=$1`, [id])).rows[0];
const iniciar = (numero: string, extra: Record<string, unknown> = {}) => A.post('/numeros/propio', { pais: 'CO', numero, acepto_aviso: true, ...extra });
const verificar = (id: string, codigo = '123456') => A.post(`/numeros/propio/${id}/verificar`, { codigo });
const desregistros = () => meta.llamadas.filter((x) => x === 'desregistrar').length;

let primero = { id: '', pid: '' };

beforeAll(async () => {
  E = await setup();
  config.numeros.compraHabilitada = false;
  setMetaOnboarding(meta);
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  // El demo trae un número de simulación configurado a mano; se parte de una empresa sin número.
  await sql(`UPDATE tenant SET whatsapp_phone_number_id=NULL, whatsapp_estado='SIN_CONFIGURAR', whatsapp_numero_visible=NULL WHERE id=$1`, [E.A]);
});
afterAll(async () => { setMetaOnboarding(null); await E.app.close(); await E.db.close(); });

describe('Cambiar de número', () => {
  it('se parte de un número conectado; sin número no hay nada que cambiar', async () => {
    const r = await iniciar('3009995511', { cambio: true });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/No tienes un número conectado/);
  });

  it('conecta el primer número', async () => {
    const r = await iniciar('3001115511');
    expect(r.body?.error?.message ?? '').toBe('');
    expect(r.status).toBe(200);
    const v = await verificar(r.body.id);
    expect(v.body).toMatchObject({ estado: 'CONECTADO', es_cambio: false });
    primero = { id: r.body.id, pid: (await fila(r.body.id)).phone_number_id };
    expect((await tenant()).pid).toBe(primero.pid);
    const o = (await A.get('/numeros/opciones')).body.propio;
    expect(o).toMatchObject({ puede_cambiar: true, en_cambio: false });
  });

  it('no se puede conectar un segundo número sin pedir el cambio', async () => {
    expect((await iniciar('3001115522')).status).toBe(409);
  });

  it('un fallo a mitad no deja a la empresa sin número: el anterior sigue conectado', async () => {
    const r = await iniciar('3001115522', { cambio: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'CODIGO_ENVIADO', es_cambio: true });
    // El número anterior sigue siendo el de la empresa y no se tocó en Meta.
    expect((await tenant()).pid).toBe(primero.pid);
    expect((await fila(primero.id)).estado).toBe('CONECTADO');
    expect(desregistros()).toBe(0);
    // Mientras dura el cambio no se puede abrir otro.
    expect((await iniciar('3001115533', { cambio: true })).status).toBe(409);

    // El registro del nuevo falla (la cuenta de WhatsApp lo rechaza): CONEXION_FALLIDA.
    const original = meta.registrar.bind(meta);
    meta.registrar = async () => { throw new ErrorMeta('Meta rechazó la solicitud (190).', false, 190); };
    const v = await verificar(r.body.id);
    meta.registrar = original;
    expect([200, 409]).toContain(v.status);
    expect((await fila(r.body.id)).estado).toBe('CONEXION_FALLIDA');

    const t = await tenant();
    expect(t.pid).toBe(primero.pid);
    expect(t.estado).not.toBe('SIN_CONFIGURAR');
    expect((await fila(primero.id)).estado).toBe('CONECTADO');
    expect(desregistros()).toBe(0);

    // Se descarta el intento fallido y el número anterior sigue intacto.
    expect((await A.post(`/numeros/propio/${r.body.id}/desconectar`, { confirmacion: 'DESCONECTAR' })).status).toBe(200);
    expect((await tenant()).pid).toBe(primero.pid);
    expect((await fila(primero.id)).estado).toBe('CONECTADO');
  });

  it('cancelar el cambio a mitad deja el número anterior funcionando', async () => {
    const r = await iniciar('3001115544', { cambio: true });
    expect(r.body.estado).toBe('CODIGO_ENVIADO');
    expect((await A.post(`/numeros/propio/${r.body.id}/desconectar`, {})).status).toBe(200);
    expect((await fila(r.body.id)).estado).toBe('CANCELADO');
    expect((await tenant()).pid).toBe(primero.pid);
    expect(desregistros()).toBe(0);
  });

  it('cuando el nuevo queda conectado, la empresa pasa al nuevo y solo entonces se desconecta el anterior', async () => {
    const r = await iniciar('3001115555', { cambio: true });
    expect(r.status).toBe(200);
    expect(desregistros()).toBe(0);
    const v = await verificar(r.body.id);
    expect(v.body).toMatchObject({ estado: 'CONECTADO' });
    const nuevo = await fila(r.body.id);
    expect((await tenant()).pid).toBe(nuevo.phone_number_id);
    expect((await tenant()).visible).toMatch(/3001115555|300 111 5555/);
    // El anterior se desregistró en Meta y quedó cerrado en Omnegia.
    expect(desregistros()).toBe(1);
    expect(meta.numerosWaba.get(primero.pid)?.estado).toBe('DISCONNECTED');
    expect((await fila(primero.id)).estado).toBe('CANCELADO');
    // El nuevo ya no figura como «reemplazo»: se puede cambiar otra vez.
    expect(nuevo).toMatchObject({ es_cambio: false, reemplaza_id: null });
    const aud = (await sql(`SELECT resultado FROM audit_event WHERE accion='numero.cambio_completado' AND tenant_id=$1`, [E.A])).rows;
    expect(aud).toHaveLength(1);
    expect(aud[0].resultado).toBe('EXITO');
    primero = { id: r.body.id, pid: nuevo.phone_number_id };
  });

  it('si el desregistro del anterior falla, la empresa conserva el nuevo y se avisa al operador', async () => {
    const r = await iniciar('3001115566', { cambio: true });
    const original = meta.desregistrar.bind(meta);
    meta.desregistrar = async () => { throw new ErrorMeta('Meta rechazó la solicitud (190).', false, 190); };
    const v = await verificar(r.body.id);
    meta.desregistrar = original;
    expect(v.body).toMatchObject({ estado: 'CONECTADO' });
    const nuevo = await fila(r.body.id);
    expect((await tenant()).pid).toBe(nuevo.phone_number_id);
    expect((await fila(primero.id)).estado).toBe('CANCELADO');
    const aud = (await sql(`SELECT resultado FROM audit_event WHERE accion='numero.cambio_completado' AND tenant_id=$1 ORDER BY creado_en DESC LIMIT 1`, [E.A])).rows[0];
    expect(aud.resultado).toBe('ERROR');
  });
});
