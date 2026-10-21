import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, loginOperador, op, api, CRED, type Env } from './helpers.js';
import { drain } from '../src/worker/jobs.js';

/**
 * Pedir ayuda a Omnegia desde una conversación: se abre la solicitud y se comparte el chat en un paso.
 * Soporte responde al cliente solo si la empresa lo autorizó, mientras el acceso esté vigente.
 */
let E: Env;
let admin: ReturnType<typeof api>;
let soporte: ReturnType<typeof op>;
let conv: string;

beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  soporte = op(E.app, await loginOperador(E.app, E.db, 'soporte@saas.test', 'demo-soporte-2026'));
  conv = (await admin.get('/conversaciones?filtro=todas&q=Óscar')).body.conversaciones[0].id;
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

const mensajes = async () => (await admin.get(`/conversaciones/${conv}`)).body.mensajes as any[];

describe('Pedir ayuda a Omnegia', () => {
  it('abre la solicitud y comparte la conversación con permiso para responder', async () => {
    const r = await admin.post(`/conversaciones/${conv}/acceso-soporte`, { motivo: 'El cliente reclama un cobro doble, ayúdenme a responderle', horas: 24, responder: true });
    expect(r.status).toBe(200);
    expect(r.body.ticket).toMatch(/^SOP-\d{6}$/);
    expect(r.body.puede_responder).toBe(true);
    const t = (await E.db.withTenant(E.A, (tx) => tx.query(`SELECT categoria, prioridad, asunto FROM soporte_ticket WHERE numero=$1`, [r.body.ticket]))).rows[0];
    expect(t).toMatchObject({ categoria: 'WHATSAPP', prioridad: 'ALTA' });
    expect(t.asunto).toMatch(/Óscar Jaimes/);
    const d = (await admin.get(`/conversaciones/${conv}`)).body.soporte.acceso;
    expect(d).toMatchObject({ puede_responder: true, ticket_numero: r.body.ticket });
  });

  it('la solicitud de soporte lleva a la conversación compartida', async () => {
    const tickets = (await soporte.get('/soporte')).body.tickets ?? (await soporte.get('/soporte')).body;
    const t = (Array.isArray(tickets) ? tickets : tickets.tickets).find((x: any) => /Óscar Jaimes/.test(x.asunto));
    const d = await soporte.get(`/soporte/${t.id}`);
    expect(d.body.compartida).toMatchObject({ conversation_id: conv, puede_responder: true });
    const lista = (await soporte.get('/atencion-empresas')).body.accesos;
    expect(lista.find((a: any) => a.conversation_id === conv)).toMatchObject({ puede_responder: true });
  });

  it('soporte lee la conversación y sabe que puede responder', async () => {
    const r = await soporte.get(`/atencion-empresas/conversaciones/${conv}`);
    expect(r.status).toBe(200);
    expect(r.body.acceso.puede_responder).toBe(true);
    expect(r.body.ventana_abierta).toBe(true);
    // Las notas internas del equipo no se comparten.
    expect(r.body.mensajes.some((m: any) => m.tipo === 'NOTA_INTERNA')).toBe(false);
  });

  it('la respuesta sale por el canal de la empresa, marcada como Soporte de Omnegia y auditada', async () => {
    const r = await soporte.post(`/atencion-empresas/conversaciones/${conv}/responder`, { texto: 'Hola Óscar, soy de soporte. Ya revisamos el cobro doble y lo estamos devolviendo.' });
    expect(r.status).toBe(200);
    await drain(E.db);
    const m = (await mensajes()).at(-1);
    expect(m).toMatchObject({ remitente: 'HUMAN', estado_entrega: 'SIMULADO' });
    expect(m.metadatos).toMatchObject({ soporte_omnegia: true, operador: 'Soporte SaaS' });
    const v = (await admin.get(`/conversaciones/${conv}`)).body;
    expect(v.control).toBe('HUMANO');
    const aud = (await E.db.withTenant(E.A, (tx) => tx.query(`SELECT actor_tipo, actor_nombre FROM audit_event WHERE accion='soporte.respuesta_enviada' AND recurso_id=$1`, [conv]))).rows;
    expect(aud).toEqual([{ actor_tipo: 'PLATAFORMA', actor_nombre: 'Soporte de Omnegia' }]);
    // En el panel de soporte también la reconoce como propia.
    const vista = (await soporte.get(`/atencion-empresas/conversaciones/${conv}`)).body.mensajes.at(-1);
    expect(vista).toMatchObject({ de_soporte: true, operador: 'Soporte SaaS' });
  });

  it('no deja pasar claves ni responder fuera de la ventana de 24 horas', async () => {
    expect((await soporte.post(`/atencion-empresas/conversaciones/${conv}/responder`, { texto: 'Te dejo la contraseña: Clave1234567' })).status).toBe(400);
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE conversation SET ultimo_mensaje_cliente_en = now() - interval '2 days' WHERE id=$1`, [conv]));
    expect((await soporte.post(`/atencion-empresas/conversaciones/${conv}/responder`, { texto: 'Hola de nuevo' })).status).toBe(409);
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE conversation SET ultimo_mensaje_cliente_en = now() WHERE id=$1`, [conv]));
  });

  it('con «solo leer» no puede responder, y al retirar el acceso pierde las dos cosas', async () => {
    expect((await admin.post(`/conversaciones/${conv}/acceso-soporte`, { motivo: 'Solo revisen qué respondió el agente', horas: 24, responder: false })).status).toBe(200);
    const antes = (await mensajes()).length;
    const r = await soporte.post(`/atencion-empresas/conversaciones/${conv}/responder`, { texto: 'Hola' });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/solo para lectura/);
    expect((await mensajes()).length).toBe(antes);
    expect((await admin.post(`/conversaciones/${conv}/acceso-soporte/revocar`)).status).toBe(200);
    expect((await soporte.post(`/atencion-empresas/conversaciones/${conv}/responder`, { texto: 'Hola' })).status).toBe(404);
    expect((await soporte.get(`/atencion-empresas/conversaciones/${conv}`)).status).toBe(404);
  });

  it('quien no administra la empresa no puede compartir', async () => {
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await laura.post(`/conversaciones/${conv}/acceso-soporte`, { motivo: 'Necesito ayuda con este cliente', horas: 24, responder: true })).status).toBe(403);
  });
});
