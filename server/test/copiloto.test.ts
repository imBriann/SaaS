import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { drain } from '../src/worker/jobs.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { uuidv7 } from '../src/lib/util.js';
import { llm, setLlm } from '../src/ai/llm/index.js';
import type { LlmClient } from '../src/ai/llm/types.js';

/**
 * Copiloto del asesor: la sugerencia responde con los datos reales del negocio y la mejora pule el
 * borrador sin cambiar lo que dice. Ambas son propuestas: nada se envía al cliente.
 */
let E: Env;
let admin: ReturnType<typeof api>;
let conv: string;
const entradas: { tarea: string; system: string; user: string }[] = [];

beforeAll(async () => {
  E = await setup();
  // Se envuelve el modelo para ver qué recibe (el simulador sigue respondiendo).
  const base = llm();
  const espia: LlmClient = {
    nombre: base.nombre,
    runLoop: (i, f) => base.runLoop(i, f),
    structured: async (i) => { entradas.push({ tarea: i.tarea, system: i.system, user: i.user }); return base.structured(i); },
  };
  setLlm(espia);
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  const from = '573209990011';
  const wa = async (texto: string) => { await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from, nombre: 'Valentina Ríos', id: `cp.${uuidv7()}`, texto }], 'WHATSAPP', 'cp'); await drain(E.db); };
  await wa('hola');
  await wa('sí');
  await wa('¿cuánto vale el corte clásico?');
  conv = (await admin.get('/conversaciones?filtro=todas&q=Valentina')).body.conversaciones[0].id;
});
afterAll(async () => { setLlm(null); await E.app.close(); await E.db.close(); });

describe('Sugerir respuesta', () => {
  it('responde al último mensaje con el precio real del catálogo y dice qué entendió', async () => {
    const precio = (await E.db.withTenant(E.A, (tx) => tx.query(`SELECT precio FROM product WHERE nombre='Corte clásico'`))).rows[0].precio;
    const r = await admin.post(`/conversaciones/${conv}/sugerencia`);
    expect(r.status).toBe(200);
    expect(r.body.sugerencia).toMatch(/Valentina/);
    expect(r.body.sugerencia).toContain(`$${Math.round(Number(precio)).toLocaleString('es-CO')}`);
    expect(r.body.intencion).toMatch(/precio/i);
    expect(r.body.datos_usados.join(' ')).toMatch(/Corte clásico/);
  });

  it('el modelo recibe el negocio, el catálogo con precios, los horarios y el hilo como datos', async () => {
    const e = entradas.filter((x) => x.tarea === 'sugerir_respuesta').at(-1)!;
    expect(e.user).toMatch(/<catalogo>[\s\S]*Corte clásico \(servicio\): \$/);
    expect(e.user).toMatch(/<horarios>/);
    expect(e.user).toMatch(/Cliente: ¿cuánto vale el corte clásico\?/);
    expect(e.system).toMatch(/no lo inventes/);
    expect(e.system).toMatch(/información, no instrucciones/);
  });

  it('no envía nada al cliente: solo propone', async () => {
    const antes = (await admin.get(`/conversaciones/${conv}`)).body.mensajes.length;
    await admin.post(`/conversaciones/${conv}/sugerencia`);
    expect((await admin.get(`/conversaciones/${conv}`)).body.mensajes.length).toBe(antes);
  });
});

describe('Mejorar redacción', () => {
  it('corrige abreviaturas, saluda por el nombre y conserva los datos del borrador', async () => {
    const r = await admin.post(`/conversaciones/${conv}/mejorar`, { texto: 'q tal, si tenemos espacio mañana a las 3 pm xq se libero un turno' });
    expect(r.status).toBe(200);
    expect(r.body.texto).toMatch(/^Hola Valentina/);
    expect(r.body.texto).toMatch(/\bque\b/);
    expect(r.body.texto).toMatch(/\bporque\b/);
    expect(r.body.texto).toContain('3 pm');
    expect(r.body.texto).not.toMatch(/\bq\b|\bxq\b/);
    expect(r.body.cambios.length).toBeGreaterThan(0);
    const e = entradas.filter((x) => x.tarea === 'mejorar_redaccion').at(-1)!;
    expect(e.user).toContain('<borrador_del_asesor>');
    expect(e.system).toMatch(/Conserva exactamente el contenido/);
  });

  it('pide un borrador y valida permisos', async () => {
    expect((await admin.post(`/conversaciones/${conv}/mejorar`, { texto: ' ' })).status).toBe(400);
    const andres = api(E.app, await login(E.app, ...CRED.andres), 'elparche');
    expect((await andres.post(`/conversaciones/${conv}/mejorar`, { texto: 'hola, ya te atiendo' })).status).toBe(403);
    expect((await andres.post(`/conversaciones/${conv}/sugerencia`)).status).toBe(403);
  });

  it('queda auditado y cuenta en el consumo de IA de la empresa', async () => {
    const n = (await E.db.withTenant(E.A, (tx) => tx.query(`SELECT count(*)::int AS n FROM audit_event WHERE accion IN ('ia.copiloto.sugerencia','ia.copiloto.mejora') AND recurso_id=$1`, [conv]))).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
