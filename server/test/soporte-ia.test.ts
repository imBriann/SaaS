import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, CRED, login, loginOperador, op, setup, type Env } from './helpers.js';

/**
 * Asistente de soporte (empresa → Omnegia): revisa la cuenta con datos reales y las guías verificadas,
 * propone una solución y, si no puede o el caso es sensible, abre la solicitud al equipo con el diagnóstico.
 */
let E: Env;
let admin: ReturnType<typeof api>;
let laura: ReturnType<typeof api>;
let gym: ReturnType<typeof api>;

beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
  gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

const consulta = (cuerpo: Record<string, unknown>) => ({ categoria: 'WHATSAPP', prioridad: 'NORMAL', ...cuerpo });
const tickets = async (c = admin) => (await c.get('/soporte')).body.tickets as any[];

describe('Asistente de soporte', () => {
  let propuesta = '';

  it('revisa la cuenta con datos reales y propone una solución sin abrir solicitud', async () => {
    const antes = (await tickets()).length;
    const r = await admin.post('/soporte/asistente', consulta({ asunto: 'Los clientes no reciben respuestas', descripcion: 'Escriben al WhatsApp del negocio y el agente no les contesta nada desde ayer.' }));
    expect(r.status).toBe(200);
    expect(r.body.resultado).toBe('PROPUESTO');
    expect(r.body.respuesta).toBeTruthy();
    expect(r.body.escalamiento).toBeNull();
    // El número de la demostración es simulado: la revisión lo dice con el dato real.
    const wa = r.body.revisiones.find((x: any) => x.area === 'whatsapp');
    expect(wa).toMatchObject({ codigo: 'whatsapp_simulado', relevante: true });
    expect(r.body.revisiones.some((x: any) => x.codigo === 'agente_activo')).toBe(true);
    expect((await tickets()).length).toBe(antes);
    propuesta = r.body.id;
  });

  it('otra persona de la empresa no puede decidir sobre una consulta ajena', async () => {
    expect((await laura.post(`/soporte/asistente/${propuesta}/resuelto`)).status).toBe(404);
  });

  it('otra empresa no ve ni toca la consulta', async () => {
    expect((await gym.post(`/soporte/asistente/${propuesta}/resuelto`)).status).toBe(404);
    expect((await gym.post(`/soporte/asistente/${propuesta}/escalar`, {})).status).toBe(404);
  });

  it('si no le sirvió, pasa al equipo con el diagnóstico adjunto y no se repite', async () => {
    const r = await admin.post(`/soporte/asistente/${propuesta}/escalar`, { comentario: 'Ya revisé y sigue igual.' });
    expect(r.status).toBe(200);
    expect(r.body.ticket.numero).toMatch(/^SOP-\d{6}$/);
    const t = (await admin.get(`/soporte/${r.body.ticket.id}`)).body;
    const diag = t.mensajes.find((m: any) => m.autor_tipo === 'SISTEMA');
    expect(diag.cuerpo).toContain('Diagnóstico automático');
    expect(diag.cuerpo).toContain('WhatsApp está en modo simulado');
    expect(diag.cuerpo).toContain('Ya revisé y sigue igual.');
    expect((await admin.post(`/soporte/asistente/${propuesta}/resuelto`)).status).toBe(409);
  });

  it('cuando le sirvió queda resuelta sin solicitud', async () => {
    const r = await admin.post('/soporte/asistente', consulta({ categoria: 'IA', asunto: 'Cómo apago una herramienta', descripcion: 'Quiero que el agente de IA no agende citas, ¿dónde lo configuro?' }));
    expect(r.body.resultado).toBe('PROPUESTO');
    expect(r.body.guias).toContain('ia');
    expect((await admin.post(`/soporte/asistente/${r.body.id}/resuelto`)).status).toBe(200);
    const lista = (await admin.get('/soporte')).body;
    expect(lista.asistente.resueltas).toBeGreaterThanOrEqual(1);
  });

  it('un cobro dudoso pasa directo a una persona, sin que la IA intente responder', async () => {
    const antes = (await tickets()).length;
    const r = await admin.post('/soporte/asistente', consulta({ categoria: 'FACTURACION', asunto: 'Me cobraron dos veces', descripcion: 'En el extracto aparece que me cobraron dos veces la suscripción de este mes.' }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ resultado: 'ESCALADO', respuesta: null });
    expect(r.body.escalamiento.motivo).toBe('cobro_dudoso');
    expect(r.body.escalamiento.ticket.numero).toMatch(/^SOP-/);
    expect((await tickets()).length).toBe(antes + 1);
  });

  it('pedir una persona o marcar urgente también escala de inmediato', async () => {
    const p = await admin.post('/soporte/asistente', consulta({ asunto: 'Necesito ayuda', descripcion: 'Quiero hablar con una persona del equipo sobre la configuración.' }));
    expect(p.body.escalamiento.motivo).toBe('pide_persona');
    const u = await admin.post('/soporte/asistente', consulta({ prioridad: 'URGENTE', asunto: 'Todo detenido', descripcion: 'No podemos vender nada desde esta mañana, el negocio está detenido.' }));
    expect(u.body.escalamiento.motivo).toBe('urgente');
  });

  it('sin una solución comprobada no adivina: abre la solicitud', async () => {
    const r = await admin.post('/soporte/asistente', consulta({ categoria: 'OTRO', asunto: 'Tipografía de los recibos', descripcion: 'Quisiera usar otra tipografía en los recibos impresos del negocio.' }));
    expect(r.body.resultado).toBe('ESCALADO');
    expect(r.body.escalamiento.motivo).toBe('sin_solucion_verificada');
    expect(r.body.respuesta).toBeNull();
  });

  it('rechaza claves y contraseñas en la consulta', async () => {
    const r = await admin.post('/soporte/asistente', consulta({ asunto: 'No entra Wompi', descripcion: 'Mi llave es prv_test_abcdefgh12345678 y no funciona el enlace de pago.' }));
    expect(r.status).toBe(400);
  });

  it('la empresa puede dar por resuelta su solicitud', async () => {
    const t = (await tickets()).find((x) => x.estado !== 'RESUELTO' && x.estado !== 'CERRADO');
    expect((await admin.post(`/soporte/${t.id}/resolver`)).status).toBe(200);
    expect((await admin.get(`/soporte/${t.id}`)).body.ticket.estado).toBe('RESUELTO');
    expect((await admin.post(`/soporte/${t.id}/resolver`)).status).toBe(409);
  });

  it('el operador ve solo cifras del asistente, nunca lo que escribió la empresa', async () => {
    const o = op(E.app, await loginOperador(E.app, E.db));
    const r = await o.get('/soporte');
    expect(r.status).toBe(200);
    expect(r.body.asistente.resueltas).toBeGreaterThanOrEqual(1);
    expect(r.body.asistente.escaladas).toBeGreaterThanOrEqual(4);
    expect(r.raw).not.toContain('tipografía en los recibos');
    await expect(E.db.withOperador((tx) => tx.query(`SELECT descripcion FROM soporte_intento_ia LIMIT 1`))).rejects.toThrow(/permission denied|permiso denegado/i);
  });
});
