import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';

/** Suscripción cancelada: el panel se cierra, pero se puede pedir la reactivación y hablar con soporte. */
let E: Env;
beforeAll(async () => {
  E = await setup();
  await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET estado='CANCELADA' WHERE tenant_id=$1`, [E.A]));
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Suscripción cancelada', () => {
  it('cierra el panel y el asistente, y deja abiertos la pantalla de cancelación y el soporte', async () => {
    const A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
    const yo = await A.get('/yo');
    expect(yo.status).toBe(423);
    expect(yo.body.error.details).toMatchObject({ cancelada: true });
    expect((await A.get('/clientes')).status).toBe(423);
    expect((await A.post('/soporte/asistente', { mensaje: 'hola' })).status).toBe(423);
    const e = await A.get('/cancelada');
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ cancelada: true, empresa: 'Barbería El Parche', puede_solicitar: true, solicitud: null });
    expect((await A.get('/soporte')).status).toBe(200);
  });

  it('pedir la reactivación abre una solicitud al equipo, una sola vez, y no reactiva por sí sola', async () => {
    const A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
    expect((await A.post('/cancelada/solicitud', { mensaje: 'mi clave: 12345678' })).status).toBe(400);
    const r = await A.post('/cancelada/solicitud', { mensaje: 'Ya pagamos lo pendiente.' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ numero: expect.stringMatching(/^SOP-/), ya_existia: false });
    const otra = await A.post('/cancelada/solicitud', {});
    expect(otra.body).toMatchObject({ id: r.body.id, ya_existia: true });
    const t = await A.get(`/soporte/${r.body.id}`);
    expect(t.body.ticket).toMatchObject({ categoria: 'FACTURACION', prioridad: 'ALTA' });
    expect(t.body.mensajes[0].cuerpo).toMatch(/Ya pagamos lo pendiente/);
    expect((await A.post(`/soporte/${r.body.id}/mensajes`, { cuerpo: '¿Alguna novedad?' })).status).toBe(200);
    expect((await A.get('/cancelada')).body.solicitud).toMatchObject({ id: r.body.id });
    const s = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado FROM subscription WHERE tenant_id=$1`, [E.A])).rows[0]);
    expect(s.estado).toBe('CANCELADA');
  });

  it('solo quien administra la suscripción la pide; el resto puede escribir a soporte', async () => {
    const L = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await L.get('/cancelada')).body.puede_solicitar).toBe(false);
    expect((await L.post('/cancelada/solicitud', {})).status).toBe(403);
    expect((await L.post('/soporte', { categoria: 'CUENTA', prioridad: 'NORMAL', asunto: 'No puedo entrar', descripcion: 'El panel dice que la suscripción está cancelada.' })).status).toBe(200);
  });

  it('una empresa activa no tiene esa pantalla', async () => {
    const G = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    expect((await G.get('/yo')).status).toBe(200);
    expect((await G.post('/cancelada/solicitud', {})).status).toBe(409);
  });
});
