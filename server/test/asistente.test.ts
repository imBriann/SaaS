import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { setLlm } from '../src/ai/llm/index.js';
import { ScriptedLlm } from '../src/ai/llm/scripted.js';
import type { LoopInput } from '../src/ai/llm/types.js';
import { LOTE_RESUMEN, VENTANA } from '../src/modules/asistente.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * El asistente del panel conserva la conversación en el servidor, lleva la ficha (no sensible) del
 * negocio y mantiene los hilos privados de quien los escribe.
 */
class Espia extends ScriptedLlm {
  entradas: LoopInput[] = [];
  constructor() { super([], 'Respuesta de prueba.', { resumen: 'RESUMEN-DE-PRUEBA' }); }
  async runLoop(input: LoopInput, call: Parameters<ScriptedLlm['runLoop']>[1]) {
    this.entradas.push(input);
    return super.runLoop(input, call);
  }
}

let E: Env;
let admin: string;
let laura: string;
let espia: Espia;

beforeAll(async () => {
  E = await setup();
  admin = await login(E.app, ...CRED.admin);
  laura = await login(E.app, ...CRED.laura);
});
afterAll(async () => { setLlm(null); await E.app.close(); await E.db.close(); });

describe('Memoria del hilo', () => {
  it('la segunda pregunta llega al modelo con la primera pregunta y su respuesta, sin que el navegador las reenvíe', async () => {
    espia = new Espia();
    setLlm(espia);
    const a = await api(E.app, admin, 'elparche').post('/asistente', { pregunta: '¿Cuánto vendimos esta semana?' });
    expect(a.status).toBe(200);
    expect(a.body.hilo_id).toBeTruthy();
    expect(a.body.titulo).toBe('¿Cuánto vendimos esta semana?');
    expect(espia.entradas[0].history).toEqual([{ role: 'user', text: '¿Cuánto vendimos esta semana?' }]);

    const b = await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'Y la semana pasada?', hilo_id: a.body.hilo_id });
    expect(b.body.hilo_id).toBe(a.body.hilo_id);
    expect(espia.entradas[1].history).toEqual([
      { role: 'user', text: '¿Cuánto vendimos esta semana?' },
      { role: 'assistant', text: 'Respuesta de prueba.' },
      { role: 'user', text: 'Y la semana pasada?' },
    ]);
  });

  it('sin hilo_id empieza una conversación nueva, sin arrastrar la anterior', async () => {
    const c = await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'Otra cosa' });
    expect(espia.entradas.at(-1)!.history).toEqual([{ role: 'user', text: 'Otra cosa' }]);
    const lista = await api(E.app, admin, 'elparche').get('/asistente/hilos');
    expect(lista.body.map((h: any) => h.id)).toContain(c.body.hilo_id);
    expect(lista.body.length).toBeGreaterThanOrEqual(2);
  });

  it('el hilo guardado devuelve los mensajes y los recibos de las herramientas', async () => {
    setLlm(null); // simulador: consulta resumen_ventas
    const a = await api(E.app, admin, 'elparche').post('/asistente', { pregunta: '¿cuánto vendimos esta semana?' });
    expect(a.body.ejecuciones[0]).toMatchObject({ herramienta: 'resumen_ventas', decision: 'PERMITIDA' });
    const h = await api(E.app, admin, 'elparche').get(`/asistente/hilos/${a.body.hilo_id}`);
    expect(h.status).toBe(200);
    expect(h.body.mensajes.map((m: any) => m.rol)).toEqual(['user', 'assistant']);
    expect(h.body.mensajes[1].ejecuciones[0]).toMatchObject({ herramienta: 'resumen_ventas', decision: 'PERMITIDA' });
  });

  it('pasada la ventana, lo antiguo se condensa en un resumen que viaja en el contexto', async () => {
    espia = new Espia();
    setLlm(espia);
    const primero = await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'Hilo largo' });
    const hilo = primero.body.hilo_id;
    // Se llena el hilo directamente: LOTE_RESUMEN + VENTANA mensajes más allá de lo ya guardado.
    await E.db.withTenant(E.A, async (tx) => {
      for (let i = 0; i < VENTANA + LOTE_RESUMEN; i++) {
        await tx.query(`INSERT INTO asistente_mensaje (id, tenant_id, hilo_id, rol, contenido) VALUES ($1,$2,$3,$4,$5)`, [uuidv7(), E.A, hilo, i % 2 ? 'assistant' : 'user', `mensaje ${i}`]);
      }
    });
    await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'Pregunta que dispara el resumen', hilo_id: hilo });
    const guardado = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT resumen, resumido_hasta FROM asistente_hilo WHERE id=$1`, [hilo])).rows[0]);
    expect(guardado.resumen).toContain('RESUMEN-DE-PRUEBA');
    expect(Number(guardado.resumido_hasta)).toBeGreaterThan(0);

    await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'Siguiente', hilo_id: hilo });
    const ultima = espia.entradas.at(-1)!;
    expect(ultima.system).toContain('<memoria_de_esta_conversacion>');
    expect(ultima.system).toContain('RESUMEN-DE-PRUEBA');
    // Lo ya resumido no se reenvía: solo la ventana y la pregunta nueva.
    expect(ultima.history.length).toBeLessThanOrEqual(VENTANA + 3);
    expect(ultima.history.at(-1)).toEqual({ role: 'user', text: 'Siguiente' });
  });
});

describe('Ficha del negocio', () => {
  it('lleva el nombre, el catálogo y los horarios, y nada sensible', async () => {
    espia = new Espia();
    setLlm(espia);
    await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'hola' });
    const s = espia.entradas[0].system;
    expect(s).toContain('<ficha_del_negocio>');
    expect(s).toContain('Barbería El Parche');
    expect(s).toContain('Cúcuta');
    expect(s).toMatch(/Catálogo: \d+ servicios/);
    expect(s).toContain('Agenda (personas o espacios que atienden)');
    // Identificadores, contacto y claves no viajan al modelo.
    expect(s).not.toContain('901456789');
    expect(s).not.toContain('admin@elparche.test');
    expect(s).not.toContain('+573001112233');
    expect(s).not.toContain('sim-elparche');
    expect(s).not.toMatch(/laura@|andres@/);
  });
});

describe('Privacidad de los hilos', () => {
  it('un compañero no ve, lee ni borra el hilo de otra persona; otra empresa tampoco', async () => {
    const a = await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'Pregunta privada del administrador' });
    const id = a.body.hilo_id;

    const lista = await api(E.app, laura, 'elparche').get('/asistente/hilos');
    expect(lista.status).toBe(200);
    expect(lista.body.map((h: any) => h.id)).not.toContain(id);
    expect((await api(E.app, laura, 'elparche').get(`/asistente/hilos/${id}`)).status).toBe(404);
    expect((await api(E.app, laura, 'elparche').del(`/asistente/hilos/${id}`)).status).toBe(404);
    // Retomarlo con su propia sesión tampoco: se trata como inexistente.
    expect((await api(E.app, laura, 'elparche').post('/asistente', { pregunta: 'hola', hilo_id: id })).status).toBe(404);

    const gym = await login(E.app, ...CRED.gym);
    expect((await api(E.app, gym, 'fuerzanorte').get(`/asistente/hilos/${id}`)).status).toBe(404);
    expect((await api(E.app, admin, 'elparche').get(`/asistente/hilos/${id}`)).status).toBe(200);
  });

  it('sin ai:assist no se listan hilos', async () => {
    const andres = await login(E.app, ...CRED.andres);
    expect((await api(E.app, andres, 'elparche').get('/asistente/hilos')).status).toBe(403);
  });

  it('borrar un hilo lo elimina con sus mensajes y deja constancia sin el contenido', async () => {
    const a = await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'Para borrar con un secreto 12345' });
    const id = a.body.hilo_id;
    expect((await api(E.app, admin, 'elparche').del(`/asistente/hilos/${id}`)).status).toBe(200);
    expect((await api(E.app, admin, 'elparche').get(`/asistente/hilos/${id}`)).status).toBe(404);
    const quedan = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int n FROM asistente_mensaje WHERE hilo_id=$1`, [id])).rows[0].n);
    expect(quedan).toBe(0);
    const aud = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT detalle FROM audit_event WHERE accion='ia.asistente.hilo_eliminado' AND recurso_id=$1`, [id])).rows);
    expect(aud).toHaveLength(1);
    expect(JSON.stringify(aud)).not.toContain('12345');
  });

  it('un hilo_id inválido es «no encontrado», no un error del servidor', async () => {
    expect((await api(E.app, admin, 'elparche').post('/asistente', { pregunta: 'hola', hilo_id: 'no-es-uuid' })).status).toBe(404);
    expect((await api(E.app, admin, 'elparche').get('/asistente/hilos/no-es-uuid')).status).toBe(404);
  });
});
