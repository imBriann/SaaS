import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { signMeta } from '../src/adapters/channel.js';

/** Avisos del menú: lo nuevo de WhatsApp por persona, lo que espera a una persona y su privacidad. */
let E: Env;
let admin: ReturnType<typeof api>;
let laura: ReturnType<typeof api>;
let gym: ReturnType<typeof api>;

const entrante = async (pid: string, de: string, texto: string, id: string) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pid }, contacts: [{ wa_id: de, profile: { name: 'Cliente Aviso' } }], messages: [{ from: de, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texto } }] } }] }] });
  return E.app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(body) } });
};

beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
  gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Avisos de conversaciones', () => {
  it('un mensaje nuevo suma un aviso a cada persona y desaparece para quien abre la conversación', async () => {
    // Base: se leen las que ya había para medir solo lo nuevo.
    for (const c of (await admin.get('/conversaciones')).body.conversaciones) await admin.get(`/conversaciones/${c.id}`);
    for (const c of (await laura.get('/conversaciones')).body.conversaciones) await laura.get(`/conversaciones/${c.id}`);
    const antes = (await admin.get('/avisos')).body.conversaciones;
    const pid = (await E.db.withPlatform((tx) => tx.query(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [E.A]))).rows[0].whatsapp_phone_number_id;
    expect((await entrante(pid, '573005551234', 'Hola, ¿tienen turno hoy?', 'wamid.aviso1')).json().recibidos[0].estado).toBe('aceptado');
    const a = (await admin.get('/avisos')).body.conversaciones;
    expect(a.total).toBe(antes.total + 1);
    expect(a.ultima).toMatchObject({ cliente: 'Cliente Aviso', texto: 'Hola, ¿tienen turno hoy?' });
    const lista = (await admin.get('/conversaciones')).body.conversaciones;
    const nueva = lista.find((c: any) => c.id === a.ultima.id);
    expect(nueva.sin_leer).toBe(true);
    // Abrirla la marca como leída solo para quien la abrió.
    await admin.get(`/conversaciones/${a.ultima.id}`);
    expect((await admin.get('/avisos')).body.conversaciones.total).toBe(antes.total);
    expect((await laura.get('/avisos')).body.conversaciones.ultima?.id).toBe(a.ultima.id);
  });

  it('una conversación escalada sigue avisando mientras espera la respuesta de una persona', async () => {
    const a = (await laura.get('/avisos')).body.conversaciones;
    const id = a.ultima.id;
    expect((await admin.post(`/conversaciones/${id}/escalar`, { motivo: 'Prueba de aviso' })).status).toBeLessThan(300);
    await admin.get(`/conversaciones/${id}`);
    const pid = (await E.db.withPlatform((tx) => tx.query(`SELECT whatsapp_phone_number_id FROM tenant WHERE id=$1`, [E.A]))).rows[0].whatsapp_phone_number_id;
    await entrante(pid, '573005551234', '¿Alguien me ayuda?', 'wamid.aviso2');
    await admin.get(`/conversaciones/${id}`);
    const d = (await admin.get('/avisos')).body.conversaciones;
    expect(d.por_atender).toBeGreaterThan(0);
    expect(d.ultima).toMatchObject({ id, espera: true });
    await admin.post(`/conversaciones/${id}/responder`, { texto: 'Hola, ya te atiendo.' });
    expect((await admin.get('/avisos')).body.conversaciones.ultima?.id ?? null).not.toBe(id);
  });

  it('otra empresa no ve los avisos ajenos', async () => {
    const g = (await gym.get('/avisos')).body.conversaciones;
    expect(g.ultima?.cliente).not.toBe('Cliente Aviso');
  });
});
