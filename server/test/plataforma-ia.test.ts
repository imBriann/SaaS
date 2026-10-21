import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { drain } from '../src/worker/jobs.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { setChannelAdapter, type ChannelAdapter, type PlantillaEnvio } from '../src/adapters/channel.js';
import { conocimientoOmnegia } from '../src/modules/plataformaConocimiento.js';
import { llm, setLlm } from '../src/ai/llm/index.js';
import type { LlmClient, StructuredInput } from '../src/ai/llm/types.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * WhatsApp de Omnegia con IA: entiende la conversación («sí» a lo que preguntó), responde con la base de
 * conocimiento real (módulos, precios, niveles, guías) y nunca pierde los controles del gestor de diálogo:
 * contraseñas, recuperación de acceso, pedir una persona, URL inventadas o modelo caído.
 */
let E: Env;
const NUMERO = 'plat-omnegia-ia';
class CanalPrueba implements ChannelAdapter {
  canal = 'WHATSAPP' as const;
  n = 0;
  async sendText() { return { ok: true, idExterno: `wamid.ia.out.${++this.n}` }; }
  async sendTemplate(_p: string | null, _t: string, _x: PlantillaEnvio) { return { ok: true, idExterno: `wamid.ia.out.${++this.n}` }; }
}
let base: LlmClient;
const llamadas: StructuredInput<any>[] = [];
/** Modelo de prueba: por defecto el simulador; cada prueba puede fijar la respuesta del WhatsApp de Omnegia. */
let fijo: ((i: StructuredInput<any>) => unknown) | null = null;

beforeAll(async () => {
  E = await setup();
  config.whatsapp.plataformaPhoneNumberId = NUMERO;
  setChannelAdapter('WHATSAPP', new CanalPrueba());
  base = llm();
  setLlm({
    nombre: 'prueba',
    runLoop: (i, f) => base.runLoop(i, f),
    structured: async (i) => {
      if (i.tarea === 'responder_plataforma') {
        llamadas.push(i);
        if (fijo) { const raw = fijo(i); const p = i.schema.safeParse(raw); return { data: p.success ? p.data : null, raw, tokens: 900 }; }
      }
      return base.structured(i);
    },
  });
});
afterAll(async () => { setLlm(null); config.whatsapp.plataformaPhoneNumberId = undefined; await E.app.close(); await E.db.close(); });

async function escribir(from: string, texto: string, nombre = 'Brian Acevedo') {
  const antes = (await respuestas(from)).length;
  await receiveChannelMessages(E.db, [{ phoneNumberId: NUMERO, from, nombre, id: `wamid.ia.${uuidv7()}`, texto }], 'WHATSAPP', 'prueba');
  await drain(E.db);
  return (await respuestas(from)).slice(antes);
}
const respuestas = async (from: string) => E.db.withPlatform(async (tx) => (await tx.query(
  `SELECT m.contenido, m.metadatos FROM plataforma_mensaje m JOIN plataforma_conversacion c ON c.id=m.conversacion_id
   WHERE c.telefono=$1 AND m.remitente='ASISTENTE' ORDER BY m.creado_en`, [`+${from}`])).rows as { contenido: string; metadatos: any }[]);

describe('Base de conocimiento', () => {
  it('trae los módulos con sus precios, los niveles reales de la base, las guías y solo páginas que existen', async () => {
    const k = await conocimientoOmnegia(E.db);
    expect(k).toContain('$29.000 al mes e incluye Clientes y Catálogo');
    expect(k).toMatch(/Agenda y reservas: .*\$18\.000 al mes/);
    expect(k).toMatch(/Asistente inteligente: .*requiere WhatsApp y atención/);
    const negocio = (await E.db.withPlatform((tx) => tx.query(`SELECT precio_mensual FROM plan WHERE codigo='negocio'`))).rows[0].precio_mensual;
    expect(k).toContain(`Negocio: $${Math.round(Number(negocio)).toLocaleString('es-CO')} al mes`);
    expect(k).toMatch(/Retracto: dentro de los 5 días hábiles/);
    expect(k).toMatch(/de demostración/);
    expect(k).toContain(`${config.publicUrl}/planes`);
    expect(k).not.toMatch(/elparche|Barbería El Parche|fuerzanorte/i);
  });
});

describe('La conversación de la captura, ahora con contexto', () => {
  const from = '573215550001';
  it('«conocer los planes» explica cómo se calcula el valor con las tarifas reales', async () => {
    await escribir(from, 'hola');
    const [r] = await escribir(from, 'conocer los planes que tiene omnegia');
    expect(r.contenido).toMatch(/\$29\.000/);
    expect(r.contenido).toMatch(/Agenda y reservas.*\$18\.000/);
    expect(r.contenido).toMatch(/demostración/);
    expect(r.metadatos.ia).toMatchObject({ tokens: expect.any(Number) });
  });

  it('un «sí» a la oferta de contar los módulos se entiende y los explica', async () => {
    fijo = null;
    // El asistente terminó ofreciendo los módulos: un «sí» corto debe responderse con ellos.
    await E.db.withPlatform((tx) => tx.query(
      `INSERT INTO plataforma_mensaje (id, conversacion_id, remitente, tipo, contenido, metadatos) SELECT $1, id, 'ASISTENTE', 'TEXTO', '¿Quieres saber qué incluye algún módulo?', '{}' FROM plataforma_conversacion WHERE telefono=$2`,
      [uuidv7(), `+${from}`]));
    const [r] = await escribir(from, 'si');
    expect(r.contenido).not.toMatch(/Cuéntame con un poco más de detalle|No tengo información verificada/);
    expect(r.contenido).toMatch(/WhatsApp y atención/);
    expect(r.contenido).toMatch(/Control de inventario/);
  });

  it('el modelo recibió la conversación completa, la base de conocimiento y las reglas de privacidad', () => {
    const i = llamadas.at(-1)!;
    expect(i.user).toMatch(/<conocimiento>[\s\S]*Módulos y precio del alta/);
    expect(i.user).toMatch(/Persona: conocer los planes que tiene omnegia[\s\S]*Persona: si/);
    expect(i.system).toMatch(/Solo temas de Omnegia/);
    expect(i.system).toMatch(/Nunca digas si un correo o teléfono tiene cuenta/);
    expect(i.system).toMatch(/no vuelvas a saludar/);
  });
});

describe('Controles que la IA no cambia', () => {
  it('las contraseñas y la recuperación de acceso siguen en el gestor de diálogo', async () => {
    fijo = () => { throw new Error('no debería llamarse'); };
    const from = '573215550002';
    await escribir(from, 'hola');
    const n = llamadas.length;
    const [c] = await escribir(from, 'mi contraseña es Secreta2026');
    expect(c.contenido).toMatch(/no compartas tu contraseña/);
    expect(llamadas.length).toBe(n);
    fijo = null;
  });

  it('si el modelo falla o no está disponible, responde el gestor (nunca se queda callado)', async () => {
    fijo = () => ({ respuesta: '' });
    const from = '573215550003';
    await escribir(from, 'hola');
    const [r] = await escribir(from, '¿tienen oficina en Medellín?');
    expect(r.contenido).toContain('No tengo información verificada');
    fijo = null;
  });

  it('una respuesta con una dirección que no está en la lista cerrada se descarta', async () => {
    fijo = () => ({ respuesta: 'Mira los precios en https://omnegia-descuentos.example.com/oferta', tema: 'PLANES', siguiente: 'conversar', motivo_persona: '' });
    const from = '573215550004';
    await escribir(from, 'hola');
    const [r] = await escribir(from, '¿cuánto cuesta?');
    expect(r.contenido).not.toContain('example.com');
    expect(r.contenido).toContain(`${config.publicUrl}/planes`);
    fijo = null;
  });

  it('cuando la IA decide que hace falta una persona, se abre la solicitud con su motivo', async () => {
    fijo = () => ({ respuesta: 'Entiendo, esto lo revisa una persona del equipo.', tema: 'SUSCRIPCION', siguiente: 'pasar_a_persona', motivo_persona: 'Reporta un cobro que no reconoce.' });
    const from = '573215550005';
    await escribir(from, 'hola');
    const [r] = await escribir(from, 'me llegó un cobro raro de omnegia, ¿qué es?');
    expect(r.contenido).toMatch(/Entiendo, esto lo revisa una persona del equipo\.[\s\S]*SOP-\d{6}/);
    const t = (await E.db.withPlatform((tx) => tx.query(
      `SELECT k.categoria FROM soporte_ticket k JOIN plataforma_conversacion c ON c.ticket_id=k.id WHERE c.telefono=$1`, [`+${from}`]))).rows[0];
    expect(t.categoria).toBe('FACTURACION');
    fijo = null;
  });

  it('si la IA pide el correo, el siguiente mensaje usa la recuperación real del sistema', async () => {
    fijo = () => ({ respuesta: 'Te ayudo a crear una contraseña nueva. ¿Cuál es el correo con el que entras a Omnegia?', tema: 'ACCESO', siguiente: 'pedir_correo', motivo_persona: '' });
    const from = '573215550006';
    await escribir(from, 'hola');
    await escribir(from, 'no me acuerdo cómo entrar al panel, ayúdame');
    fijo = null;
    const [r] = await escribir(from, 'admin@elparche.test');
    expect(r.contenido).toMatch(/te llega un correo con un enlace/);
    const enviado = (await E.db.withPlatform((tx) => tx.query(`SELECT count(*)::int AS n FROM password_reset p JOIN users u ON u.id=p.user_id WHERE u.email='admin@elparche.test'`))).rows[0].n;
    expect(enviado).toBeGreaterThan(0);
  });
});
