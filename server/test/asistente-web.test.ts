import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, correosA, loginOperador, op, type Env } from './helpers.js';
import { setLlm } from '../src/ai/llm/index.js';
import { MockLlm } from '../src/ai/llm/mock.js';
import { hashIp } from '../src/modules/otp.js';
import { LIMITE_HORA } from '../src/modules/asistenteWeb.js';
import { uuidv7 } from '../src/lib/util.js';
import { config } from '../src/config.js';

/**
 * Asistente de IA del sitio público: responde con el catálogo real, solo enlaza páginas verificadas, no manda
 * claves al modelo, tiene límite por visitante y lleva a un asesor comercial que llega a la bandeja del operador.
 */
let E: Env;
const post = (url: string, payload: unknown, ip = '203.0.113.7') => E.app.inject({ method: 'POST', url, payload: payload as any, remoteAddress: ip });
const preguntar = (texto: string, previos: { rol: string; texto: string }[] = [], ip?: string) => post('/api/publico/asistente', { mensajes: [...previos, { rol: 'persona', texto }] }, ip);

beforeAll(async () => { E = await setup(); setLlm(new MockLlm(() => '2026-10-21')); });
afterEach(() => setLlm(new MockLlm(() => '2026-10-21')));
afterAll(async () => { setLlm(null); await E.app.close(); await E.db.close(); });

describe('Conversación', () => {
  it('responde los planes con los precios reales y enlaza solo páginas del sitio', async () => {
    const r = await preguntar('¿Cuánto cuesta Omnegia?');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.motor).toBe('ia');
    expect(b.respuesta).toMatch(/Esencial\*\*: \$99\.000 al mes o \$990\.000 al año/);
    expect(b.enlaces).toEqual([{ ruta: '/planes', texto: 'Ver los planes' }]);
  });

  it('pedir un asesor abre el formulario', async () => {
    expect((await preguntar('quiero hablar con un asesor comercial')).json().siguiente).toBe('abrir_asesor');
  });

  it('una respuesta con una dirección web inventada o una ruta fuera de la lista no llega a la persona', async () => {
    const falso = (data: any) => ({ nombre: 'falso', runLoop: async () => { throw new Error('no'); }, structured: async () => ({ data, raw: data, tokens: 10 }) }) as any;
    setLlm(falso({ respuesta: 'Paga aquí: https://pagos-falsos.test', siguiente: 'conversar', enlaces: [], sugerencias: [] }));
    const a = (await preguntar('¿cuánto cuesta?')).json();
    expect(a.motor).toBe('respaldo');
    expect(a.respuesta).not.toMatch(/pagos-falsos/);
    setLlm(falso({ respuesta: 'Mira esto.', siguiente: 'conversar', enlaces: ['/operador', 'https://otro.test/planes', '/planes', `${config.publicUrl}/empezar`], sugerencias: [] }));
    expect((await preguntar('hola')).json().enlaces.map((e: any) => e.ruta)).toEqual(['/planes', '/empezar']);
  });

  it('una contraseña o una tarjeta pegada en el chat no se envía al modelo', async () => {
    setLlm({ nombre: 'no-debe', runLoop: async () => { throw new Error('no'); }, structured: async () => { throw new Error('no debía llamarse'); } } as any);
    const r = (await preguntar('mi tarjeta es 4242 4242 4242 4242, ¿me cobran?')).json();
    expect(r.respuesta).toMatch(/no escribas contraseñas/);
  });

  it('sin modelo disponible responde igual, con datos reales', async () => {
    setLlm({ nombre: 'caido', runLoop: async () => { throw new Error('x'); }, structured: async () => { throw new Error('caído'); } } as any);
    const r = (await preguntar('precio del plan anual')).json();
    expect(r).toMatchObject({ motor: 'respaldo', siguiente: 'conversar' });
    expect(r.respuesta).toMatch(/Negocio\*\*: \$229\.000 al mes o \$2\.290\.000 al año/);
  });

  it('valida la entrada y limita los mensajes por visitante', async () => {
    expect((await post('/api/publico/asistente', { mensajes: [] })).statusCode).toBe(400);
    expect((await post('/api/publico/asistente', { mensajes: [{ rol: 'asistente', texto: 'hola' }] })).statusCode).toBe(400);
    const ip = '198.51.100.9';
    await E.db.withPlatform(async (tx) => { for (let i = 0; i < LIMITE_HORA; i++) await tx.query(`INSERT INTO asistente_web_uso (id, ip_hash, resultado) VALUES ($1,$2,'IA')`, [uuidv7(), hashIp(ip)]); });
    const r = (await preguntar('¿cuánto cuesta?', [], ip)).json();
    expect(r.siguiente).toBe('abrir_asesor');
    expect((await preguntar('¿cuánto cuesta?')).json().motor).toBe('ia');
    // Solo se guardan cifras, nunca lo que se escribió.
    const cols = (await E.db.withPlatform((tx) => tx.query(`SELECT column_name FROM information_schema.columns WHERE table_name='asistente_web_uso'`))).rows.map((c: any) => c.column_name);
    expect(cols.sort()).toEqual(['creado_en', 'id', 'ip_hash', 'motor', 'resultado', 'tokens']);
  });
});

describe('Asesor comercial', () => {
  const datos = { nombre: 'Camila Ortiz', email: 'camila@tienda.test', telefono: '300 123 4567', empresa: 'Tienda Ortiz', mensaje: 'Tengo tres sedes y quiero una demostración.', acepta_datos: true,
    conversacion: [{ rol: 'persona', texto: '¿Sirve para varias sedes?' }, { rol: 'asistente', texto: 'Te recomiendo hablar con un asesor.' }] };

  it('crea la solicitud en la bandeja del operador y avisa al equipo y a la persona', async () => {
    const r = await post('/api/publico/asesor', datos);
    expect(r.statusCode).toBe(200);
    const { numero } = r.json();
    expect(numero).toMatch(/^COM-\d{6}$/);
    expect((await correosA(E.db, 'camila@tienda.test')).map((c) => c.asunto).join()).toContain(numero);
    expect((await correosA(E.db, config.correo.buzonSoporte)).some((c) => c.asunto.includes(numero) && c.texto.includes('Tengo tres sedes'))).toBe(true);

    const plat = op(E.app, await loginOperador(E.app, E.db));
    const lista = (await plat.get('/soporte?canal=WEB')).body.tickets;
    expect(lista[0]).toMatchObject({ numero, canal: 'WEB', categoria: 'COMERCIAL', categoria_nombre: 'Comercial', solicitante: 'Camila Ortiz' });
    const detalle = (await plat.get(`/soporte/${lista[0].id}`)).body;
    expect(detalle.mensajes[0].cuerpo).toMatch(/Conversación con el asistente[\s\S]*varias sedes/);
    // La respuesta del asesor llega por correo, sin botón al panel (la persona no tiene cuenta).
    expect((await plat.post(`/soporte/${lista[0].id}/responder`, { cuerpo: 'Hola Camila, te agendo la demostración.' })).status).toBe(200);
    const respuesta = (await correosA(E.db, 'camila@tienda.test')).find((c) => c.asunto.startsWith('Respuesta'))!;
    expect(respuesta.texto).toMatch(/responde a este correo/i);
    expect(respuesta.texto).not.toMatch(/Responder en el panel/);
  });

  it('exige autorización de datos, rechaza claves y limita las solicitudes', async () => {
    expect((await post('/api/publico/asesor', { ...datos, acepta_datos: false })).statusCode).toBe(400);
    expect((await post('/api/publico/asesor', { ...datos, email: 'x@y.test', mensaje: 'mi contraseña: secreta123' })).statusCode).toBe(400);
    const ip = '192.0.2.44';
    for (let i = 0; i < 3; i++) expect((await post('/api/publico/asesor', { ...datos, email: `p${i}@limite.test` }, ip)).statusCode).toBe(200);
    expect((await post('/api/publico/asesor', { ...datos, email: 'p9@limite.test' }, ip)).statusCode).toBe(429);
  });
});
