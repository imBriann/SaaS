import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, CRED, login, setup, type Env } from './helpers.js';
import { drain } from '../src/worker/jobs.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { setChannelAdapter, type ChannelAdapter } from '../src/adapters/channel.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Agente de WhatsApp de cada empresa: el aviso de datos no se repite en bucle, la insistencia y la
 * molestia llevan a una persona, una conversación derivada no recibe respuestas automáticas (salvo un
 * aviso de espera espaciado) y el catálogo se responde con datos reales.
 */
let E: Env;
let admin: ReturnType<typeof api>;

class CanalPrueba implements ChannelAdapter {
  canal = 'WHATSAPP' as const;
  n = 0;
  async sendText() { return { ok: true, idExterno: `wamid.ag.${++this.n}` }; }
  async sendTemplate() { return { ok: true, idExterno: `wamid.ag.${++this.n}` }; }
}

beforeAll(async () => {
  E = await setup();
  setChannelAdapter('WHATSAPP', new CanalPrueba());
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

const wa = async (from: string, texto: string) => {
  await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from, nombre: 'Cliente Agente', id: `ag.${uuidv7()}`, texto }], 'WHATSAPP', 't');
  await drain(E.db);
};
/** Mensajes que salieron hacia el cliente (IA o sistema), en orden. */
const salientes = async (from: string) => E.db.withTenant(E.A, async (tx) => (await tx.query(
  `SELECT m.remitente, m.contenido, m.metadatos FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN customer c ON c.id=v.customer_id
   WHERE c.telefono=$1 AND m.remitente IN ('AI','SYSTEM') AND m.tipo <> 'NOTA_INTERNA' ORDER BY m.creado_en`, [`+${from}`])).rows as any[]);
const conv = async (from: string) => E.db.withTenant(E.A, async (tx) => (await tx.query(
  `SELECT v.*, (SELECT k.radicado FROM support_case k WHERE k.conversation_id=v.id ORDER BY k.creado_en DESC LIMIT 1) AS radicado,
          (SELECT k.prioridad FROM support_case k WHERE k.conversation_id=v.id ORDER BY k.creado_en DESC LIMIT 1) AS prioridad
   FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1`, [`+${from}`])).rows[0]);

describe('Autorización de datos sin bucle', () => {
  it('el aviso completo sale una vez, luego un recordatorio, y si sigue escribiendo lo atiende una persona', async () => {
    const from = '573117770001';
    await wa(from, 'hola');
    await wa(from, 'quiero un corte para mañana');
    await wa(from, '¿cuánto vale?');
    const s = await salientes(from);
    expect(s).toHaveLength(3);
    expect(s[0].contenido).toContain('¿Autorizas el tratamiento?');
    expect(s[1].contenido).toContain('Para continuar necesito tu autorización');
    expect(s[2].contenido).toMatch(/Tu radicado es \*RAD-/);
    expect(new Set(s.map((x) => x.contenido)).size).toBe(3);
    expect((await conv(from)).control).toBe('HUMANO');
    // Ya derivada: más mensajes no producen respuestas automáticas.
    await wa(from, 'hola?');
    expect(await salientes(from)).toHaveLength(3);
  });

  it('quien no autoriza recibe una explicación una vez y puede pedir una persona', async () => {
    const from = '573117770002';
    await wa(from, 'buenas');
    await wa(from, 'no');
    await wa(from, 'asesor');
    const s = await salientes(from);
    expect(s[1].contenido).toContain('sin tu autorización no puedo atenderte con el asistente');
    expect(s[2].contenido).toMatch(/RAD-/);
    expect((await conv(from)).control).toBe('HUMANO');
  });
});

describe('Insistencia y molestia', () => {
  it('quien dice que la IA no le ayuda pasa a una persona con prioridad alta', async () => {
    const from = '573117770003';
    await wa(from, 'hola'); await wa(from, 'sí');
    await wa(from, 'quiero saber si atienden domingos');
    await wa(from, 'no me estás ayudando, ya te dije lo que necesito');
    const c = await conv(from);
    expect(c.control).toBe('HUMANO');
    expect(c.prioridad).toBe('ALTA');
    expect((await salientes(from)).at(-1).contenido).toContain('Entiendo tu molestia');
  });

  it('la misma pregunta por tercera vez se deriva en lugar de contestar igual', async () => {
    const from = '573117770004';
    await wa(from, 'hola'); await wa(from, 'sí');
    for (let i = 0; i < 3; i++) await wa(from, 'necesito hablar del pedido de ayer');
    const c = await conv(from);
    expect(c.control).toBe('HUMANO');
    expect(c.radicado).toMatch(/^RAD-/);
  });

  it('la derivación por palabra clave funciona aunque el negocio haya apagado la herramienta de escalar', async () => {
    expect((await admin.patch('/ia/herramientas/escalar_a_humano', { habilitada: false })).status).toBe(200);
    try {
      const from = '573117770005';
      await wa(from, 'hola'); await wa(from, 'sí');
      await wa(from, 'quiero poner un reclamo');
      const c = await conv(from);
      expect(c.control).toBe('HUMANO');
      expect(c.radicado).toMatch(/^RAD-/);
      expect((await salientes(from)).at(-1).contenido).toContain(c.radicado);
    } finally {
      await admin.patch('/ia/herramientas/escalar_a_humano', { habilitada: true });
    }
  });
});

describe('Conversación con una persona al frente', () => {
  it('sin respuesta humana: silencio, y como mucho un aviso de espera cada 4 horas; con respuesta humana, silencio total', async () => {
    const from = '573117770006';
    await wa(from, 'hola'); await wa(from, 'sí');
    await wa(from, 'quiero hablar con una persona');
    const base = (await salientes(from)).length;
    for (const t of ['hola?', 'sigo aquí', 'por favor']) await wa(from, t);
    expect(await salientes(from)).toHaveLength(base);
    // Pasadas más de 4 horas sin respuesta: un aviso de espera (y solo uno).
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE support_case SET creado_en = now() - interval '5 hours' WHERE conversation_id=(SELECT v.id FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1)`, [`+${from}`]));
    await wa(from, '¿alguien me lee?');
    const conAviso = await salientes(from);
    expect(conAviso).toHaveLength(base + 1);
    expect(conAviso.at(-1).contenido).toMatch(/Tu caso \*RAD-.+\* sigue con el equipo/);
    await wa(from, '¿hola?');
    expect(await salientes(from)).toHaveLength(base + 1);
    // Responde una persona: ya no hay avisos automáticos.
    const c = await conv(from);
    expect((await admin.post(`/conversaciones/${c.id}/responder`, { texto: 'Hola, soy Andrea. Ya te ayudo.' })).status).toBe(200);
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE message SET creado_en = now() - interval '6 hours' WHERE (metadatos->>'aviso_espera')='true' AND conversation_id=$1`, [c.id]));
    await wa(from, 'gracias, espero');
    expect((await salientes(from)).filter((m) => m.metadatos?.aviso_espera)).toHaveLength(1);
  });
});

describe('Catálogo con datos reales', () => {
  it('responde los servicios con los precios del catálogo de la empresa y deja el recibo de la consulta', async () => {
    const from = '573117770007';
    await wa(from, 'hola'); await wa(from, 'sí');
    await wa(from, '¿qué servicios tienen?');
    const r = (await salientes(from)).at(-1);
    const productos = (await admin.get('/productos')).body as any[];
    const activo = productos.find((p) => p.activo && p.tipo === 'SERVICIO');
    expect(r.contenido).toContain(activo.nombre);
    const c = await conv(from);
    const recibos = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT herramienta, decision FROM ai_execution WHERE conversation_id=$1`, [c.id])).rows);
    expect(recibos).toContainEqual({ herramienta: 'consultar_catalogo', decision: 'PERMITIDA' });
  });
});
