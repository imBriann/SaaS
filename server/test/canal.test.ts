import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { drain, runJobsOnce } from '../src/worker/jobs.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { signMeta, setChannelAdapter, type ChannelAdapter, type PlantillaEnvio } from '../src/adapters/channel.js';
import { setLlm } from '../src/ai/llm/index.js';
import type { LlmClient } from '../src/ai/llm/types.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Canal de WhatsApp, agente de IA y escalamiento: estados de entrega desordenados,
 * archivos y tipos no admitidos, ventana de 24 h y plantillas, fallo del modelo,
 * toma por una persona mientras el modelo trabaja, y ciclo completo del radicado.
 */
let E: Env;
let admin: ReturnType<typeof api>;
let laura: ReturnType<typeof api>;

/** Canal de prueba: registra lo que se envía y devuelve ids de salida predecibles. */
class CanalPrueba implements ChannelAdapter {
  canal = 'WHATSAPP' as const;
  textos: { to: string; text: string }[] = [];
  plantillas: { to: string; p: PlantillaEnvio }[] = [];
  n = 0;
  async sendText(_pid: string | null, to: string, text: string) { this.textos.push({ to, text }); return { ok: true, idExterno: `wamid.out.${++this.n}` }; }
  async sendTemplate(_pid: string | null, to: string, p: PlantillaEnvio) { this.plantillas.push({ to, p }); return { ok: true, idExterno: `wamid.out.${++this.n}` }; }
}
const canal = new CanalPrueba();

beforeAll(async () => {
  E = await setup();
  setChannelAdapter('WHATSAPP', canal);
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
});
afterAll(async () => { setLlm(null); await E.app.close(); await E.db.close(); });

const wa = async (from: string, texto: string, extra: Record<string, unknown> = {}) => {
  await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from, nombre: 'Cliente Prueba', id: `t.${uuidv7()}`, texto, ...extra }], 'WHATSAPP', 't');
  await drain(E.db);
};
const conv = async (from: string) => E.db.withTenant(E.A, async (tx) => (await tx.query(
  `SELECT v.* FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1`, [`+${from}`])).rows[0]);
const mensajes = async (from: string) => E.db.withTenant(E.A, async (tx) => (await tx.query(
  `SELECT m.* FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1 ORDER BY coalesce(m.ocurrido_en, m.creado_en), m.creado_en`, [`+${from}`])).rows);
const webhook = async (value: Record<string, unknown>) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'sim-elparche' }, ...value } }] }] });
  const r = await E.app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(body) } });
  await drain(E.db);
  return r;
};

describe('Webhook de WhatsApp', () => {
  it('la verificación del webhook exige el token configurado', async () => {
    const ok = await E.app.inject({ method: 'GET', url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=42' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('42');
    expect((await E.app.inject({ method: 'GET', url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=42' })).statusCode).toBe(403);
  });

  it('un mensaje repetido por el proveedor se guarda una sola vez y produce una sola respuesta', async () => {
    const from = '573208880001';
    await wa(from, 'hola'); await wa(from, 'sí');
    const id = `dup.${uuidv7()}`;
    const m = { phoneNumberId: 'sim-elparche', from, nombre: 'X', id, texto: '¿cuánto vale el corte clásico?' };
    await receiveChannelMessages(E.db, [m], 'WHATSAPP', 't');
    const segunda = await receiveChannelMessages(E.db, [m], 'WHATSAPP', 't');
    expect(segunda[0].estado).toBe('duplicado');
    await drain(E.db);
    const ms = await mensajes(from);
    expect(ms.filter((x: any) => x.id_externo === id)).toHaveLength(1);
    expect(ms.filter((x: any) => x.remitente === 'AI' && /Corte clásico/.test(x.contenido))).toHaveLength(1);
  });

  it('una ráfaga o un mensaje retrasado: responde una sola vez, al más reciente', async () => {
    const from = '573208880002';
    await wa(from, 'hola'); await wa(from, 'sí');
    const ahora = Date.now();
    await receiveChannelMessages(E.db, [
      { phoneNumberId: 'sim-elparche', from, nombre: 'X', id: `r.${uuidv7()}`, texto: '¿cuánto vale la cera para peinar?', ocurridoEn: new Date(ahora) },
      { phoneNumberId: 'sim-elparche', from, nombre: 'X', id: `r.${uuidv7()}`, texto: 'hola otra vez', ocurridoEn: new Date(ahora - 60_000) }, // llegó tarde
    ], 'WHATSAPP', 't');
    const antes = (await mensajes(from)).filter((x: any) => x.remitente === 'AI').length;
    await drain(E.db);
    const ms = await mensajes(from);
    expect(ms.filter((x: any) => x.remitente === 'AI').length).toBe(antes + 1);
    // El historial queda ordenado por el momento real del mensaje, no por el de llegada.
    const cliente = ms.filter((x: any) => x.remitente === 'CUSTOMER').map((x: any) => x.contenido);
    expect(cliente.indexOf('hola otra vez')).toBeLessThan(cliente.indexOf('¿cuánto vale la cera para peinar?'));
  });

  it('estados de entrega desordenados solo avanzan: entregado no retrocede a enviado; fallido no pisa leído', async () => {
    const from = '573208880003';
    await wa(from, 'hola');
    const salida = (await mensajes(from)).find((x: any) => x.remitente === 'SYSTEM' && x.id_externo_salida);
    expect(salida.estado_entrega).toBe('ENVIADO');
    const est = (status: string, extra: object = {}) => webhook({ statuses: [{ id: salida.id_externo_salida, status, timestamp: '1', recipient_id: from, ...extra }] });
    await est('delivered');
    await est('sent');
    let m = (await mensajes(from)).find((x: any) => x.id === salida.id);
    expect(m.estado_entrega).toBe('ENTREGADO');
    await est('read');
    await est('failed', { errors: [{ code: 131026, title: 'Undeliverable' }] });
    m = (await mensajes(from)).find((x: any) => x.id === salida.id);
    expect(m.estado_entrega).toBe('LEIDO');
  });

  it('un estado que llega antes que el id de salida se aplica después, en segundo plano', async () => {
    const r = await webhook({ statuses: [{ id: 'wamid.futuro', status: 'delivered', timestamp: '1', recipient_id: '57300' }] });
    expect(r.json().estados[0].estado).toBe('diferido');
    const from = '573208880004';
    await wa(from, 'hola');
    const salida = (await mensajes(from)).find((x: any) => x.remitente === 'SYSTEM' && x.id_externo_salida);
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE message SET id_externo_salida='wamid.futuro' WHERE id=$1`, [salida.id]));
    await E.db.withPlatform((tx) => tx.query(`UPDATE job SET ejecutar_en=now() WHERE tipo='aplicar_estado_entrega'`));
    await runJobsOnce(E.db);
    expect((await mensajes(from)).find((x: any) => x.id === salida.id).estado_entrega).toBe('ENTREGADO');
  });

  it('imagen sin texto, audio y tipos no admitidos: respuesta explícita y nota para el equipo; nunca silencio', async () => {
    const from = '573208880005';
    await wa(from, 'hola'); await wa(from, 'sí');
    await webhook({ contacts: [{ wa_id: from, profile: { name: 'Foto' } }], messages: [{ id: `img.${uuidv7()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' } }] });
    let ms = await mensajes(from);
    expect(ms.find((x: any) => x.tipo === 'MEDIA').metadatos.media).toMatchObject({ tipo: 'image', id: 'media-1' });
    expect(ms.at(-2).contenido).toMatch(/Recibí tu imagen.*no puedo revisar archivos/);
    expect(ms.at(-1)).toMatchObject({ tipo: 'NOTA_INTERNA' });
    await webhook({ messages: [{ id: `un.${uuidv7()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'unsupported' }] });
    ms = await mensajes(from);
    expect(ms.filter((x: any) => x.remitente === 'AI').at(-1).contenido).toMatch(/no lo puedo leer/);
  });

  it('una imagen con leyenda la atiende la IA con el texto de la leyenda', async () => {
    const from = '573208880006';
    await wa(from, 'hola'); await wa(from, 'sí');
    await webhook({ messages: [{ id: `cap.${uuidv7()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'image', image: { id: 'media-2', caption: '¿cuánto vale el corte clásico?' } }] });
    expect((await mensajes(from)).filter((x: any) => x.remitente === 'AI').at(-1).contenido).toMatch(/Corte clásico/);
  });
});

describe('Ventana de 24 horas y plantillas', () => {
  it('fuera de la ventana: texto libre bloqueado; plantilla no registrada falla con motivo; plantilla aprobada sale por la API de plantillas', async () => {
    const from = '573208880007';
    await wa(from, 'hola'); await wa(from, 'sí'); await wa(from, 'quiero poner un reclamo');
    const v = await conv(from);
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE conversation SET ultimo_mensaje_cliente_en = now() - interval '25 hours' WHERE id=$1`, [v.id]));
    const libre = await admin.post(`/conversaciones/${v.id}/responder`, { texto: 'Hola, ¿sigues ahí?' });
    expect(libre.status).toBe(409);
    expect(libre.body.error.message).toMatch(/24 horas/);
    const detalle = (await admin.get(`/conversaciones/${v.id}`)).body;
    expect(detalle.ventana_abierta).toBe(false);
    expect(detalle.plantillas.map((p: any) => p.clave)).toContain('recordatorio_24h');

    const vars = { cliente: 'Ana', servicio: 'Corte', hora: '10:00', recurso: 'Andrés' };
    expect((await admin.post(`/conversaciones/${v.id}/plantilla`, { clave: 'recordatorio_24h', variables: { cliente: 'Ana' } })).status).toBe(400);
    expect((await admin.post(`/conversaciones/${v.id}/plantilla`, { clave: 'recordatorio_24h', variables: vars })).status).toBe(200);
    await drain(E.db);
    let ultimo = (await mensajes(from)).at(-1);
    expect(ultimo).toMatchObject({ tipo: 'PLANTILLA', estado_entrega: 'FALLIDO' });
    expect(ultimo.error_entrega).toMatch(/no está registrada como aprobada/);

    expect((await admin.patch('/configuracion/plantillas/recordatorio_24h', { estado_aprobacion: 'APROBADA' })).status).toBe(400);
    expect((await admin.patch('/configuracion/plantillas/recordatorio_24h', { nombre_proveedor: 'recordatorio_cita', idioma: 'es_CO', estado_aprobacion: 'APROBADA' })).status).toBe(200);
    await admin.post(`/conversaciones/${v.id}/plantilla`, { clave: 'recordatorio_24h', variables: vars });
    await drain(E.db);
    ultimo = (await mensajes(from)).at(-1);
    expect(ultimo.estado_entrega).toBe('ENVIADO');
    expect(canal.plantillas.at(-1)).toEqual({ to: from, p: { nombre: 'recordatorio_cita', idioma: 'es_CO', parametros: ['Ana', 'Corte', '10:00', 'Andrés'] } });
  });
});

describe('Agente de IA ante fallos y concurrencia', () => {
  it('si el modelo no responde, la conversación pasa a una persona con radicado (no queda muda)', async () => {
    const from = '573208880008';
    await wa(from, 'hola'); await wa(from, 'sí');
    const caido: LlmClient = { nombre: 'caido', runLoop: async () => { throw new Error('timeout'); }, structured: async () => ({ data: null, raw: null, tokens: 0 }) };
    setLlm(caido);
    await wa(from, '¿tienen cupo mañana?');
    setLlm(null);
    const v = await conv(from);
    expect(v).toMatchObject({ estado: 'ESCALADA', control: 'HUMANO' });
    expect((await mensajes(from)).at(-1).contenido).toMatch(/RAD-\d{4}-\d{5}/);
    const k = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT motivo, prioridad FROM support_case WHERE conversation_id=$1`, [v.id])).rows[0]);
    expect(k).toMatchObject({ motivo: 'El agente de IA no respondió a tiempo', prioridad: 'ALTA' });
  });

  it('si una persona toma la conversación mientras el modelo piensa, la respuesta de la IA se descarta', async () => {
    const from = '573208880009';
    await wa(from, 'hola'); await wa(from, 'sí');
    const v = await conv(from);
    const lento: LlmClient = {
      nombre: 'lento', structured: async () => ({ data: null, raw: null, tokens: 0 }),
      runLoop: async () => {
        // Mientras «piensa», la asesora responde desde el panel.
        expect((await laura.post(`/conversaciones/${v.id}/responder`, { texto: 'Hola, te atiendo yo.' })).status).toBe(200);
        return { text: 'Respuesta tardía de la IA', tokens: 10, toolCalls: 0, stopReason: 'end_turn' };
      },
    };
    setLlm(lento);
    await wa(from, 'necesito ayuda con algo');
    setLlm(null);
    const ms = await mensajes(from);
    expect(ms.some((x: any) => x.contenido === 'Respuesta tardía de la IA')).toBe(false);
    expect(ms.at(-1)).toMatchObject({ remitente: 'HUMAN', contenido: 'Hola, te atiendo yo.' });
    const audit = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int n FROM audit_event WHERE accion='ia.respuesta_descartada' AND recurso_id=$1`, [v.id])).rows[0].n);
    expect(audit).toBe(1);
  });

  it('una confirmación vencida no ejecuta nada y se le dice al cliente', async () => {
    const from = '573208880010';
    await wa(from, 'hola'); await wa(from, 'sí');
    await wa(from, 'quiero comprar una cera para peinar');
    const v = await conv(from);
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE pending_action SET expira_en = now() - interval '1 minute' WHERE conversation_id=$1`, [v.id]));
    await wa(from, 'sí');
    expect((await mensajes(from)).at(-1).contenido).toMatch(/venció y no hice ningún cambio/);
    const ventas = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int n FROM "order" WHERE conversation_id=$1`, [v.id])).rows[0].n);
    expect(ventas).toBe(0);
  });

  it('si la franja se ocupa entre la propuesta y el «sí», no hay doble reserva y se ofrecen alternativas', async () => {
    const from = '573208880011';
    await wa(from, 'hola'); await wa(from, 'sí');
    await wa(from, 'quiero una cita de corte clásico pasado mañana a las 10');
    const v = await conv(from);
    const pend = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT argumentos FROM pending_action WHERE conversation_id=$1 AND estado='PENDIENTE'`, [v.id])).rows[0]);
    expect(pend).toBeTruthy();
    // Otra persona reserva esa franja desde el panel antes de que el cliente confirme.
    const otro = (await admin.get('/clientes?q=Mateo')).body.clientes[0].id;
    expect((await admin.post('/agenda/citas', { customer_id: otro, product_id: pend.argumentos.servicio_id, resource_id: pend.argumentos.recurso_id, inicio: pend.argumentos.inicio })).status).toBe(200);
    await wa(from, 'sí');
    expect((await mensajes(from)).at(-1).contenido).toMatch(/se acaba de ocupar.*Tengo libre/);
    const citas = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int n FROM appointment WHERE inicio=$1 AND resource_id=$2 AND estado <> 'CANCELADA'`, [pend.argumentos.inicio, pend.argumentos.recurso_id])).rows[0].n);
    expect(citas).toBe(1);
  });
});

describe('Escalamiento y radicados', () => {
  async function escalada(from: string) {
    await wa(from, 'hola'); await wa(from, 'sí'); await wa(from, 'quiero poner una queja');
    const v = await conv(from);
    const k = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT * FROM support_case WHERE conversation_id=$1`, [v.id])).rows[0]);
    return { v, k };
  }

  it('cola → dos asesores intentan tomarlo a la vez → solo uno lo obtiene', async () => {
    await admin.patch(`/configuracion/personas/${(await admin.get('/yo')).body.usuario.id}`, { disponible: false });
    const lauraId = (await laura.get('/yo')).body.usuario.id;
    await admin.patch(`/configuracion/personas/${lauraId}`, { disponible: false }); // nadie disponible: queda en cola
    const { k } = await escalada('573208880020');
    expect(k.estado).toBe('EN_COLA');
    const [a, b] = await Promise.all([laura.post(`/casos/${k.id}/tomar`), admin.post(`/casos/${k.id}/tomar`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    await admin.patch(`/configuracion/personas/${lauraId}`, { disponible: true });
  });

  it('ciclo completo: asignado → respuesta humana (la IA calla) → reasignar → cerrar → reabrir → devolver a la IA, con historial', async () => {
    const from = '573208880021';
    const { v, k } = await escalada(from);
    expect(k.estado).toBe('ASIGNADO');
    await wa(from, '¿alguien me lee?');
    expect((await mensajes(from)).at(-1).remitente).toBe('CUSTOMER'); // la IA no responde con una persona al frente
    expect((await laura.post(`/conversaciones/${v.id}/responder`, { texto: 'Hola, revisamos tu caso.' })).status).toBe(200);
    // Un barbero no puede atender radicados.
    const andres = api(E.app, await login(E.app, ...CRED.andres), 'elparche');
    expect((await andres.post(`/casos/${k.id}/tomar`)).status).toBe(403);
    // Reasignación por supervisión a alguien que sí atiende.
    const adminId = (await admin.get('/yo')).body.usuario.id;
    expect((await admin.post(`/casos/${k.id}/reasignar`, { user_id: adminId })).status).toBe(200);
    expect((await admin.post(`/casos/${k.id}/prioridad`, { prioridad: 'URGENTE' })).status).toBe(200);
    // Laura ya no es la responsable: no puede cerrarlo.
    expect((await laura.post(`/conversaciones/${v.id}/cerrar`, { motivo: 'Resuelto' })).status).toBe(404);
    expect((await admin.post(`/conversaciones/${v.id}/cerrar`, { motivo: 'Se resolvió el reclamo' })).status).toBe(200);
    expect((await admin.post(`/conversaciones/${v.id}/cerrar`, { motivo: 'otra vez' })).status).toBe(409);
    expect((await admin.post(`/casos/${k.id}/reabrir`, { motivo: 'El cliente volvió a escribir' })).status).toBe(200);
    expect((await admin.get(`/conversaciones/${v.id}`)).body).toMatchObject({ estado: 'ESCALADA', control: 'HUMANO', caso: { estado: 'ASIGNADO', reaperturas: 1 } });
    expect((await admin.post(`/conversaciones/${v.id}/devolver-ia`)).status).toBe(200);
    await wa(from, '¿cuánto vale el corte clásico?');
    expect((await mensajes(from)).at(-1)).toMatchObject({ remitente: 'AI' });
    const h = (await admin.get(`/conversaciones/${v.id}`)).body.historial.map((e: any) => `${e.accion}:${e.a_estado}`);
    expect(h).toEqual(['crear:ASIGNADO', 'responder:EN_ATENCION', 'reasignar:EN_ATENCION', 'prioridad:EN_ATENCION', 'cerrar:CERRADO', 'reabrir:ASIGNADO', 'devolver_ia:CERRADO']);
  });

  it('la reapertura tiene plazo: pasados 7 días se debe abrir un radicado nuevo', async () => {
    const { v, k } = await escalada('573208880022');
    await admin.post(`/conversaciones/${v.id}/cerrar`, { motivo: 'Listo' });
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE support_case SET cerrado_en = now() - interval '8 days' WHERE id=$1`, [k.id]));
    const r = await admin.post(`/casos/${k.id}/reabrir`, { motivo: 'tarde' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/7 días/);
  });

  it('tras devolverla a la IA, la misma conversación puede escalar de nuevo (el límite es por episodio)', async () => {
    const from = '573208880023';
    const { v } = await escalada(from);
    await admin.post(`/conversaciones/${v.id}/devolver-ia`);
    await wa(from, 'otra vez tengo una queja');
    const casos = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT estado FROM support_case WHERE conversation_id=$1 ORDER BY creado_en`, [v.id])).rows.map((r: any) => r.estado));
    expect(casos).toEqual(['CERRADO', 'ASIGNADO']);
  });

  it('una persona que responde una conversación de la IA queda como responsable de un radicado nuevo', async () => {
    const from = '573208880024';
    await wa(from, 'hola'); await wa(from, 'sí');
    const v = await conv(from);
    expect((await laura.post(`/conversaciones/${v.id}/responder`, { texto: 'Hola, soy Laura.' })).status).toBe(200);
    const d = (await laura.get(`/conversaciones/${v.id}`)).body;
    expect(d.caso).toMatchObject({ estado: 'EN_ATENCION', asignado: 'Laura Pabón' });
    expect(d.control).toBe('HUMANO');
  });
});
