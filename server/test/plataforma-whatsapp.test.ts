import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, CRED, login, loginOperador, op, setup, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { drain } from '../src/worker/jobs.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { setChannelAdapter, type ChannelAdapter, type PlantillaEnvio } from '../src/adapters/channel.js';
import { decidir, type EstadoDialogo } from '../src/modules/plataformaBot.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Número de WhatsApp de Omnegia: el asistente no repite el saludo, resuelve antes de derivar, no expone
 * datos de comercios a un número sin autenticar y calla mientras atiende una persona. La bandeja del
 * operador administra esas conversaciones; de las empresas solo ve indicadores, salvo autorización.
 */
let E: Env;
const NUMERO = 'plat-omnegia';

class CanalPrueba implements ChannelAdapter {
  canal = 'WHATSAPP' as const;
  textos: { pid: string | null; to: string; text: string }[] = [];
  n = 0;
  async sendText(pid: string | null, to: string, text: string) { this.textos.push({ pid, to, text }); return { ok: true, idExterno: `wamid.plat.out.${++this.n}` }; }
  async sendTemplate(_pid: string | null, _to: string, _p: PlantillaEnvio) { return { ok: true, idExterno: `wamid.plat.out.${++this.n}` }; }
}
const canal = new CanalPrueba();

beforeAll(async () => {
  E = await setup();
  config.whatsapp.plataformaPhoneNumberId = NUMERO;
  setChannelAdapter('WHATSAPP', canal);
});
afterAll(async () => {
  config.whatsapp.plataformaPhoneNumberId = undefined;
  await E.app.close();
  await E.db.close();
});

/** Mensaje entrante al número de Omnegia; devuelve las respuestas nuevas del asistente. */
async function escribir(from: string, texto: string, nombre = 'Brian Acevedo', extra: Record<string, unknown> = {}) {
  const antes = (await respuestas(from)).length;
  await receiveChannelMessages(E.db, [{ phoneNumberId: NUMERO, from, nombre, id: `wamid.plat.${uuidv7()}`, texto, ...extra }], 'WHATSAPP', 'prueba');
  await drain(E.db);
  return (await respuestas(from)).slice(antes);
}
const conversacion = async (from: string) => E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM plataforma_conversacion WHERE telefono=$1`, [`+${from}`])).rows[0]);
const respuestas = async (from: string) => E.db.withPlatform(async (tx) => (await tx.query(
  `SELECT m.contenido, m.metadatos, m.estado_entrega FROM plataforma_mensaje m JOIN plataforma_conversacion c ON c.id=m.conversacion_id
   WHERE c.telefono=$1 AND m.remitente='ASISTENTE' ORDER BY m.creado_en`, [`+${from}`])).rows as { contenido: string; metadatos: any; estado_entrega: string }[]);
const telefonoDe = (tenantId: string, tel: string) => E.db.withPlatform((tx) => tx.query(`UPDATE tenant SET telefono=$2 WHERE id=$1`, [tenantId, tel]));

describe('Asistente del WhatsApp de Omnegia: saludo y continuidad', () => {
  it('el saludo inicial presenta al asistente una sola vez, avisa del tratamiento de datos y no nombra comercios', async () => {
    await telefonoDe(E.A, '+573209990001');
    const [r] = await escribir('573209990001', 'Hola');
    expect(r.contenido).toContain('Hola, Brian. Soy el asistente virtual de Omnegia.');
    expect(r.contenido).toContain('/privacidad');
    expect(r.contenido).not.toMatch(/Barbería El Parche|comercios?|suscripción (activa|suspendida)/i);
    expect(r.estado_entrega).not.toBe('PENDIENTE');
    expect(canal.textos.at(-1)?.pid).toBe(NUMERO);
  });

  it('los mensajes siguientes no repiten el saludo ni la presentación', async () => {
    const [r] = await escribir('573209990001', 'Tengo un error al acceder a mi cuenta');
    expect(r.contenido).not.toMatch(/Soy el asistente|Hola, Brian/);
    expect(r.contenido).not.toContain('/privacidad');
    expect(r.contenido).toContain('1. «Correo o contraseña incorrectos»');
  });

  it('error de acceso: pide el detalle, usa la recuperación real del sistema y comprueba si funcionó', async () => {
    const [pide] = await escribir('573209990001', '1');
    expect(pide.contenido).toContain('correo con el que entras');
    expect(pide.contenido).toContain('Nunca te pediré tu contraseña');
    const [enviado] = await escribir('573209990001', 'es admin@elparche.test');
    expect(enviado.contenido).toContain('Si *admin@elparche.test* tiene una cuenta');
    expect(enviado.contenido).toContain('¿Pudiste entrar?');
    expect(enviado.metadatos.accion).toBe('recuperar_acceso');
    // El enlace lo genera la misma función de «¿Olvidaste tu contraseña?» (respuesta uniforme exista o no la cuenta).
    const enlaces = await E.db.withPlatform(async (tx) => (await tx.query(
      `SELECT count(*)::int AS n FROM password_reset p JOIN users u ON u.id=p.user_id WHERE u.email='admin@elparche.test' AND p.usado_en IS NULL`)).rows[0].n);
    expect(enlaces).toBe(1);
    const [no] = await escribir('573209990001', 'no');
    expect(no.contenido).toContain('spam');
    expect(no.contenido).toContain('¿Te paso con ella?');
    const [si] = await escribir('573209990001', 'sí');
    expect(si.contenido).toMatch(/Tu radicado es \*SOP-\d{6}\*/);
  });

  it('nunca recibe contraseñas por el chat', async () => {
    const [r] = await escribir('573209990002', 'mi contraseña es Parche2026!!');
    expect(r.contenido).toContain('no compartas tu contraseña');
  });
});

describe('Asistente del WhatsApp de Omnegia: insistencia y paso a una persona', () => {
  it('tres mensajes seguidos sobre el mismo problema reciben respuestas distintas y terminan con una persona', async () => {
    const from = '573209990003';
    const textos: string[] = [];
    for (let i = 0; i < 3; i++) textos.push(...(await escribir(from, 'no puedo entrar a mi cuenta')).map((r) => r.contenido));
    expect(textos).toHaveLength(3);
    expect(new Set(textos).size).toBe(3);
    expect(textos[0]).toContain('Soy el asistente virtual');
    expect(textos.slice(1).join(' ')).not.toContain('Soy el asistente virtual');
    expect(textos[2]).toMatch(/SOP-\d{6}/);
    expect((await conversacion(from)).control).toBe('HUMANO');
  });

  it('quien insiste porque no recibió solución pasa a una persona con radicado, prioridad alta y el contexto del caso', async () => {
    const from = '573209990004';
    await escribir(from, 'Tengo un error al acceder a mi cuenta');
    const [r] = await escribir(from, 'no me estás ayudando, ya te dije que no puedo entrar');
    expect(r.contenido).toMatch(/Tu radicado es \*SOP-\d{6}\*/);
    expect(r.contenido).toContain('no tendrás que repetir');
    const c = await conversacion(from);
    expect(c).toMatchObject({ estado: 'ESCALADA', control: 'HUMANO' });
    const t = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM soporte_ticket WHERE id=$1`, [c.ticket_id])).rows[0]);
    expect(t).toMatchObject({ canal: 'WHATSAPP', categoria: 'CUENTA', prioridad: 'ALTA', tenant_id: null, conversacion_id: c.id });
    const resumen = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT autor_tipo, cuerpo FROM soporte_mensaje WHERE ticket_id=$1`, [t.id])).rows[0]);
    expect(resumen.autor_tipo).toBe('SISTEMA');
    expect(resumen.cuerpo).toContain('«Tengo un error al acceder a mi cuenta»');
    expect(resumen.cuerpo).toContain('Problema de acceso a la cuenta');
  });

  it('quien pide un asesor pasa de inmediato a una persona', async () => {
    const from = '573209990005';
    await escribir(from, 'Buenas tardes');
    const [r] = await escribir(from, 'quiero hablar con un asesor');
    expect(r.contenido).toMatch(/SOP-\d{6}/);
    expect((await conversacion(from)).control).toBe('HUMANO');
  });

  it('una conversación transferida no recibe respuestas automáticas; como mucho un aviso de espera si nadie respondió', async () => {
    const from = '573209990005';
    for (const t of ['hola?', 'sigo esperando', 'por favor respondan']) expect(await escribir(from, t)).toHaveLength(0);
    // Pasadas más de 4 horas sin respuesta de una persona: un único aviso de espera.
    await E.db.withPlatform((tx) => tx.query(`UPDATE plataforma_conversacion SET contexto = contexto || '{"avisoEsperaEn":"2020-01-01T00:00:00.000Z"}'::jsonb WHERE telefono=$1`, [`+${from}`]));
    const aviso = await escribir(from, '¿hay alguien?');
    expect(aviso).toHaveLength(1);
    expect(aviso[0].contenido).toMatch(/Tu solicitud \*SOP-\d{6}\* sigue abierta/);
    expect(await escribir(from, '¿hola?')).toHaveLength(0);
  });

  it('si una persona toma el chat mientras el asistente decide, la respuesta automática se descarta', async () => {
    const from = '573209990006';
    await escribir(from, 'Hola');
    await receiveChannelMessages(E.db, [{ phoneNumberId: NUMERO, from, nombre: 'Brian', id: `wamid.plat.${uuidv7()}`, texto: '¿qué módulos tiene omnegia?' }], 'WHATSAPP', 'prueba');
    await E.db.withPlatform((tx) => tx.query(`UPDATE plataforma_conversacion SET control='HUMANO', estado='ESCALADA', primera_respuesta_humana_en=now() WHERE telefono=$1`, [`+${from}`]));
    const antes = (await respuestas(from)).length;
    await drain(E.db);
    expect((await respuestas(from)).length).toBe(antes);
  });
});

describe('Asistente del WhatsApp de Omnegia: información verificada y privacidad', () => {
  it('explica qué incluye Omnegia con información verificada', async () => {
    const r = await escribir('573209990007', '¿qué módulos tiene omnegia?');
    expect(r[0].contenido).toContain('/producto');
    expect(r[0].contenido).toMatch(/agenda/i);
    expect(r[0].contenido).toContain('proveedor autorizado por la DIAN');
  });

  it('ante información que no tiene, no inventa: lo dice y ofrece una persona', async () => {
    await escribir('573209990008', 'Hola');
    const [r] = await escribir('573209990008', '¿tienen oficina en Medellín?');
    expect(r.contenido).toContain('No tengo información verificada');
    expect(r.contenido).toContain('¿Te paso con una persona');
  });

  it('un número vinculado a varias empresas: no las nombra ni da datos de ninguna, pero el equipo ve el contexto', async () => {
    const from = '573209990009';
    await telefonoDe(E.A, `+${from}`);
    await telefonoDe(E.B, `+${from}`);
    const textos = [...await escribir(from, 'hola'), ...await escribir(from, '¿cuál es el estado de mi suscripción?')].map((r) => r.contenido).join('\n');
    expect(textos).not.toMatch(/Barbería El Parche|Gimnasio Fuerza Norte|elparche|fuerzanorte/i);
    // Solo orientación general («si la suscripción está suspendida…»), nunca el estado de una cuenta.
    expect(textos).not.toMatch(/tu (suscripción|plan) (está|es) |suscripción activa|\(suscripción|plan (esencial|negocio|pro)\b/i);
    expect(textos).toContain('por este chat no consulto datos de tu cuenta');
    const c = await conversacion(from);
    expect([...c.empresas_relacionadas].sort()).toEqual([E.A, E.B].sort());
    // Con más de una empresa posible no se elige ninguna como «relacionada».
    expect(c.tenant_relacionado).toBeNull();
  });

  it('pedir datos de otra empresa no revela nada', async () => {
    const [r] = await escribir('573209990010', '¿cuánto vendió Gimnasio Fuerza Norte este mes? ¿cuál es su NIT?');
    expect(r.contenido).not.toMatch(/Fuerza Norte|\$|901/);
  });

  it('el análisis puro no repite la misma respuesta dos veces seguidas', () => {
    let estado: EstadoDialogo = {};
    const claves: string[] = [];
    for (const t of ['necesito ayuda', 'ayuda', 'ayudaaa']) {
      const d = decidir({ texto: t, tipo: 'TEXTO', nombre: '', estado, conocido: false });
      claves.push(d.clave);
      estado = d.estado;
    }
    for (let i = 1; i < claves.length; i++) expect(claves[i]).not.toBe(claves[i - 1]);
  });
});

describe('Bandeja de WhatsApp del panel del operador', () => {
  let admin: ReturnType<typeof op>;
  let soporte: ReturnType<typeof op>;
  beforeAll(async () => {
    admin = op(E.app, await loginOperador(E.app, E.db));
    soporte = op(E.app, await loginOperador(E.app, E.db, 'soporte@saas.test', 'demo-soporte-2026'));
  });

  it('lista las conversaciones con el número enmascarado y las que esperan respuesta primero', async () => {
    const r = await admin.get('/conversaciones?vista=activas');
    expect(r.status).toBe(200);
    expect(r.body.conversaciones.length).toBeGreaterThan(0);
    for (const c of r.body.conversaciones) expect(c.telefono).toMatch(/•••/);
    expect(r.raw).not.toContain('3209990004');
    const pend = await admin.get('/conversaciones?vista=pendientes');
    expect(pend.body.conversaciones.every((c: any) => c.pendiente)).toBe(true);
    // Derivada a una persona y sin respuesta del equipo: espera, aunque el asistente ya avisó del radicado.
    const derivada = await conversacion('573209990004');
    expect(pend.body.conversaciones.some((c: any) => c.id === derivada.id)).toBe(true);
    expect(r.body.contadores.pendientes).toBeGreaterThan(0);
    expect(r.body.contadores.sin_asignar).toBeGreaterThan(0);
  });

  it('el detalle muestra el historial completo con la solicitud y abrirlo queda auditado', async () => {
    const c = await conversacion('573209990004');
    const r = await admin.get(`/conversaciones/${c.id}?abrir=1`);
    expect(r.status).toBe(200);
    expect(r.body.telefono).toBe('+573209990004');
    expect(r.body.ticket.numero).toMatch(/^SOP-/);
    expect(r.body.mensajes.some((m: any) => m.remitente === 'CLIENTE' && /acceder a mi cuenta/.test(m.contenido))).toBe(true);
    expect(r.body.historial.some((h: any) => h.accion === 'plataforma.conversacion.derivada')).toBe(true);
    const aud = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM auditoria_plataforma WHERE accion='plataforma.conversacion.abrir' AND recurso_id=$1`, [c.id])).rows[0].n);
    expect(aud).toBe(1);
  });

  it('tomar, responder (sale por WhatsApp), nota interna (no sale), devolver al asistente y cerrar', async () => {
    const c = await conversacion('573209990004');
    expect((await soporte.post(`/conversaciones/${c.id}/tomar`)).status).toBe(200);
    const enviados = canal.textos.length;
    const resp = await soporte.post(`/conversaciones/${c.id}/responder`, { texto: 'Hola, soy Andrea de Omnegia. Ya revisé tu cuenta: te envié un enlace nuevo.' });
    expect(resp.status).toBe(200);
    expect((await soporte.post(`/conversaciones/${c.id}/responder`, { texto: 'Validar luego si entró.', nota: true })).status).toBe(200);
    await drain(E.db);
    const nuevos = canal.textos.slice(enviados).map((t) => t.text);
    expect(nuevos).toEqual(['Hola, soy Andrea de Omnegia. Ya revisé tu cuenta: te envié un enlace nuevo.']);
    const tras = await conversacion('573209990004');
    expect(tras.asignado_a).toBeTruthy();
    expect(tras.primera_respuesta_humana_en).toBeTruthy();
    const ticket = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado FROM soporte_ticket WHERE id=$1`, [tras.ticket_id])).rows[0]);
    expect(ticket.estado).toBe('EN_PROCESO');
    const pendientes = async () => ((await admin.get('/conversaciones?vista=pendientes')).body.conversaciones as any[]).some((x) => x.id === c.id);
    expect(await pendientes()).toBe(false);
    // Con una persona al frente, el asistente no contesta; el mensaje nuevo vuelve a esperar al equipo.
    expect(await escribir('573209990004', 'ya pude entrar, gracias')).toHaveLength(0);
    expect(await pendientes()).toBe(true);
    expect((await soporte.post(`/conversaciones/${c.id}/devolver-ia`)).status).toBe(200);
    expect((await soporte.post(`/conversaciones/${c.id}/cerrar`, { motivo: 'Acceso recuperado', resolver_solicitud: true })).status).toBe(200);
    expect((await conversacion('573209990004')).estado).toBe('CERRADA');
    const final = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado FROM soporte_ticket WHERE id=$1`, [tras.ticket_id])).rows[0]);
    expect(final.estado).toBe('RESUELTO');
    const acciones = (await E.db.withPlatform(async (tx) => (await tx.query(`SELECT accion FROM auditoria_plataforma WHERE recurso_id=$1 ORDER BY creado_en`, [c.id])).rows)).map((a: any) => a.accion);
    for (const a of ['plataforma.conversacion.tomar', 'plataforma.conversacion.responder', 'plataforma.conversacion.nota', 'plataforma.conversacion.devolver_ia', 'plataforma.conversacion.cerrar']) expect(acciones).toContain(a);
  });

  it('si la persona vuelve a escribir, el hilo se reabre con el asistente y sin repetir el aviso de datos', async () => {
    const [r] = await escribir('573209990004', 'hola de nuevo');
    expect(r.contenido).toContain('Hola de nuevo');
    expect(r.contenido).not.toContain('/privacidad');
    expect((await conversacion('573209990004')).estado).toBe('ABIERTA');
  });

  it('soporte no puede reasignar ni tomar una conversación de otra persona; administración sí', async () => {
    const c = await conversacion('573209990003');
    const equipo = (await admin.get('/conversaciones')).body.equipo as { id: string; rol: string }[];
    const idAdmin = equipo.find((e) => e.rol === 'ADMIN')!.id;
    expect((await soporte.post(`/conversaciones/${c.id}/asignar`, { user_id: idAdmin })).status).toBe(403);
    expect((await admin.post(`/conversaciones/${c.id}/asignar`, { user_id: idAdmin })).status).toBe(200);
    expect((await soporte.post(`/conversaciones/${c.id}/tomar`)).status).toBe(409);
    expect((await admin.post(`/conversaciones/${c.id}/asignar`, { user_id: uuidv7() })).status).toBe(400);
  });

  it('fuera de la ventana de 24 horas no se puede responder con texto libre', async () => {
    const c = await conversacion('573209990003');
    await E.db.withPlatform((tx) => tx.query(`UPDATE plataforma_conversacion SET ultimo_mensaje_cliente_en = now() - interval '2 days' WHERE id=$1`, [c.id]));
    const r = await admin.post(`/conversaciones/${c.id}/responder`, { texto: 'Hola' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('24 horas');
  });

  it('la solicitud de WhatsApp aparece en Soporte del operador y no se responde por correo', async () => {
    const lista = await admin.get('/soporte?canal=WHATSAPP');
    expect(lista.status).toBe(200);
    const t = lista.body.tickets[0];
    expect(t.canal).toBe('WHATSAPP');
    expect(t.conversacion_id).toBeTruthy();
    const r = await admin.post(`/soporte/${t.id}/responder`, { cuerpo: 'Respuesta por correo' });
    expect(r.status).toBe(409);
  });

  it('las empresas no ven las solicitudes de WhatsApp en su propio Soporte, ni una sesión de empresa entra a la bandeja', async () => {
    const cookie = await login(E.app, ...CRED.admin);
    const t = api(E.app, cookie, 'elparche');
    const propias = (await t.get('/soporte')).body.tickets as any[];
    expect(propias.every((x) => !String(x.asunto).startsWith('WhatsApp ·'))).toBe(true);
    const intento = await E.app.inject({ method: 'GET', url: '/api/operador/conversaciones', headers: { cookie } });
    expect(intento.statusCode).toBe(404);
  });
});

describe('Atención de las empresas: indicadores sin contenido y lectura solo con autorización', () => {
  let admin: ReturnType<typeof op>;
  let parche: ReturnType<typeof api>;
  let laura: ReturnType<typeof api>;
  let compartida: string;
  let otra: string;
  beforeAll(async () => {
    admin = op(E.app, await loginOperador(E.app, E.db));
    parche = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
    laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    const convs = (await parche.get('/conversaciones?filtro=todas')).body.conversaciones as any[];
    compartida = convs.find((c) => c.radicado)!.id;
    otra = convs.find((c) => c.id !== compartida)!.id;
  });

  it('muestra por empresa abiertas, escaladas, sin respuesta y entregas fallidas, sin textos ni datos de clientes', async () => {
    const r = await admin.get('/atencion-empresas');
    expect(r.status).toBe(200);
    const fila = r.body.empresas.find((e: any) => e.id === E.A);
    expect(fila.abiertas).toBeGreaterThan(0);
    expect(r.body.radicados.length).toBeGreaterThan(0);
    // Nada del contenido: ni nombres de clientes, ni teléfonos, ni el motivo del radicado.
    expect(r.raw).not.toMatch(/Óscar|Santiago|Kevin|\+57301555|reclamo|cobraron/i);
  });

  it('el rol del operador no puede leer el texto de los mensajes ni los clientes: la base lo rechaza', async () => {
    await expect(E.db.withOperador((tx) => tx.query(`SELECT contenido FROM message LIMIT 1`))).rejects.toThrow(/permission denied|permiso denegado/i);
    await expect(E.db.withOperador((tx) => tx.query(`SELECT nombre FROM customer LIMIT 1`))).rejects.toThrow(/permission denied|permiso denegado/i);
    await expect(E.db.withOperador((tx) => tx.query(`SELECT motivo FROM support_case LIMIT 1`))).rejects.toThrow(/permission denied|permiso denegado/i);
  });

  it('sin autorización de la empresa, la lectura de soporte no devuelve ninguna fila', async () => {
    const n = await E.db.withSoporte(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM message`)).rows[0].n);
    expect(n).toBe(0);
    expect((await admin.get(`/atencion-empresas/conversaciones/${compartida}`)).status).toBe(404);
  });

  it('solo quien administra la empresa puede compartir una conversación con soporte', async () => {
    const r = await laura.post(`/conversaciones/${compartida}/acceso-soporte`, { motivo: 'Revisar por qué no le llegan los mensajes', horas: 24 });
    expect(r.status).toBe(403);
  });

  it('con autorización lee esa conversación y nada más; queda en ambas auditorías y al revocar deja de verla', async () => {
    const g = await parche.post(`/conversaciones/${compartida}/acceso-soporte`, { motivo: 'Revisar por qué el cliente no recibe respuestas', horas: 24 });
    expect(g.status).toBe(200);
    const ok = await admin.get(`/atencion-empresas/conversaciones/${compartida}`);
    expect(ok.status).toBe(200);
    expect(ok.body.mensajes.length).toBeGreaterThan(0);
    expect(ok.body.acceso.motivo).toContain('no recibe respuestas');
    if (ok.body.telefono) expect(ok.body.telefono).toMatch(/•••/);
    // Otra conversación de la misma empresa y cualquiera de otra empresa siguen cerradas.
    expect((await admin.get(`/atencion-empresas/conversaciones/${otra}`)).status).toBe(404);
    const n = await E.db.withSoporte(async (tx) => (await tx.query(`SELECT count(DISTINCT conversation_id)::int AS n FROM message`)).rows[0].n);
    expect(n).toBe(1);
    const detalle = (await parche.get(`/conversaciones/${compartida}`)).body;
    expect(detalle.soporte.acceso).toBeTruthy();
    expect(detalle.soporte.lecturas.length).toBe(1);
    const accesos = (await admin.get('/atencion-empresas')).body.accesos as any[];
    expect(accesos.some((a) => a.conversation_id === compartida)).toBe(true);
    expect((await parche.post(`/conversaciones/${compartida}/acceso-soporte/revocar`)).status).toBe(200);
    expect((await admin.get(`/atencion-empresas/conversaciones/${compartida}`)).status).toBe(404);
    const audit = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT accion FROM audit_event WHERE recurso_id=$1 AND accion LIKE 'soporte.%' ORDER BY creado_en`, [compartida])).rows.map((x: any) => x.accion));
    expect(audit).toEqual(['soporte.acceso_otorgado', 'soporte.conversacion_leida', 'soporte.acceso_revocado']);
  });
});
