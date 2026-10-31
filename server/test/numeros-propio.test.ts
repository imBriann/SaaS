import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { drain, HANDLERS } from '../src/worker/jobs.js';
import { config } from '../src/config.js';
import { signMeta } from '../src/adapters/channel.js';
import { MetaSimulada, setMetaOnboarding } from '../src/numeros/meta.js';

/**
 * «Usar mi propio número» de punta a punta con la Meta simulada: número, SMS, código, registro en la WABA
 * de Omnegia, conexión con la IA y desconexión. Cubre los límites (intentos, reenvíos, bloqueo), los
 * errores traducidos, la reanudación, el aislamiento, los permisos y la compra apagada («Próximamente»).
 *
 * NO valida contra Meta real: la forma de cada petición se prueba en numeros-adaptadores.test.ts.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
const meta = new MetaSimulada();

const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
const fila = async (id: string) => (await sql(`SELECT * FROM numero_contratacion WHERE id=$1`, [id])).rows[0];
/** Simula que pasó el tiempo desde el último código enviado. */
const atrasarEnvio = (id: string, minutos: number) => sql(`UPDATE numero_contratacion SET verificacion=jsonb_set(verificacion, '{enviado_en}', to_jsonb((now() - ($2 || ' minutes')::interval)::text)) WHERE id=$1`, [id, String(minutos)]);
const iniciar = (cli: ReturnType<typeof api>, numero: string, extra: Record<string, unknown> = {}) => cli.post('/numeros/propio', { pais: 'CO', numero, acepto_aviso: true, ...extra });
const cancelar = async (cli: ReturnType<typeof api>, id: string) => cli.post(`/numeros/propio/${id}/desconectar`, { confirmacion: 'DESCONECTAR' });

beforeAll(async () => {
  E = await setup();
  config.numeros.compraHabilitada = false;
  setMetaOnboarding(meta);
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterAll(async () => {
  setMetaOnboarding(null);
  await E.app.close();
  await E.db.close();
});

describe('Compra de números apagada («Próximamente»)', () => {
  it('el panel recibe la compra deshabilitada y el número propio disponible', async () => {
    const o = (await A.get('/numeros/opciones')).body;
    expect(o.compra_habilitada).toBe(false);
    expect(o.disponible).toBe(false);
    expect(o.motivo).toMatch(/próximamente/i);
    expect(o.propio).toMatchObject({ disponible: true, simulado: true });
  });

  it('las rutas de compra responden 409 con un mensaje claro', async () => {
    const id = '0190f0a0-0000-7000-8000-000000000000';
    for (const r of [
      await A.get('/numeros/disponibles?pais=CO&tipo=local'),
      await A.post('/numeros/contrataciones', { numero: '+576015550110', pais: 'CO', tipo: 'local' }),
      await A.post(`/numeros/contrataciones/${id}/requisitos`, { valores: {} }),
      await A.post(`/numeros/contrataciones/${id}/confirmar`, { total_hoy: 1, total_mensual: 1, acepto_cargo: true, acepto_mensualidad: true, acepto_condiciones: true }),
    ]) {
      expect(r.status).toBe(409);
      expect(r.body.error.message).toMatch(/próximamente/i);
    }
  });
});

describe('Usar mi propio número (camino completo)', () => {
  let id = '';
  let pid = '';

  it('recepción no puede conectar un número', async () => {
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await iniciar(laura, '3001234567')).status).toBe(403);
  });

  it('valida el número y exige aceptar el aviso antes de llamar a Meta', async () => {
    const antes = meta.llamadas.length;
    expect((await iniciar(A, '12345')).status).toBe(400);
    expect((await iniciar(A, '300 123 4567', { acepto_aviso: false })).status).toBe(400);
    expect((await A.post('/numeros/propio', { pais: 'CO', numero: '3001234567' })).status).toBe(400);
    expect(meta.llamadas.length).toBe(antes);
  });

  it('registra el número en la WABA de Omnegia y envía el código por SMS', async () => {
    const r = await iniciar(A, '300 123 4567');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ origen: 'PROPIO', estado: 'CODIGO_ENVIADO', numero: '+573001234567', simulado: true });
    expect(r.body.verificacion).toMatchObject({ metodo: 'SMS', intentos_restantes: 5, reenvios_restantes: 3 });
    expect(r.body.verificacion.espera_s).toBeGreaterThan(50);
    expect(meta.metodos.at(-1)).toBe('SMS');
    id = r.body.id;
    const f = await fila(id);
    pid = f.phone_number_id;
    expect(pid).toMatch(/^sim-num-/);
    expect(f.waba_id).toBe('sim-waba-plataforma');
    // Sin pago ni proveedor telefónico.
    expect(f.cotizacion).toBeNull();
    expect((await sql(`SELECT count(*)::int AS n FROM payment WHERE numero_contratacion_id=$1`, [id])).rows[0].n).toBe(0);
  });

  it('se retoma desde otra sesión (se cerró el navegador) y repetir el número devuelve el mismo proceso', async () => {
    const otra = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
    const v = (await otra.get('/numeros/contratacion')).body.contratacion;
    expect(v).toMatchObject({ id, origen: 'PROPIO', estado: 'CODIGO_ENVIADO' });
    const again = await iniciar(otra, '3001234567');
    expect(again.body.id).toBe(id);
  });

  it('otra empresa no ve ni opera este proceso', async () => {
    expect((await B.post(`/numeros/propio/${id}/verificar`, { codigo: '123456' })).status).toBe(404);
    expect((await B.post(`/numeros/propio/${id}/reenviar`, {})).status).toBe(404);
    expect((await B.post(`/numeros/propio/${id}/desconectar`, { confirmacion: 'DESCONECTAR' })).status).toBe(404);
    expect((await B.get('/numeros/contratacion')).body.contratacion).toBeNull();
  });

  it('código incorrecto: lo informa con los intentos que quedan', async () => {
    const r = await A.post(`/numeros/propio/${id}/verificar`, { codigo: '000000' });
    expect(r.status).toBe(409);
    expect(r.body.error.details).toMatchObject({ motivo: 'CODIGO_INCORRECTO', quedan: 4 });
    expect(r.body.error.message).toMatch(/quedan 4 intentos/);
  });

  it('reenvío con espera de 60 s y cambio a llamada', async () => {
    const pronto = await A.post(`/numeros/propio/${id}/reenviar`, { metodo: 'SMS' });
    expect(pronto.status).toBe(409);
    expect(pronto.body.error.details.espera_s).toBeGreaterThan(0);
    await atrasarEnvio(id, 2);
    const llamada = await A.post(`/numeros/propio/${id}/reenviar`, { metodo: 'VOICE' });
    expect(llamada.status).toBe(200);
    expect(meta.metodos.at(-1)).toBe('VOICE');
    expect(llamada.body.verificacion).toMatchObject({ metodo: 'VOICE', reenvios_restantes: 2, intentos_restantes: 4 });
  });

  it('con el código correcto registra con PIN y conecta el número a la empresa', async () => {
    meta.estadoNombre = 'PENDING_REVIEW';
    const r = await A.post(`/numeros/propio/${id}/verificar`, { codigo: '123-456' });
    expect(r.status).toBe(200);
    expect(r.body.estado).toBe('CONECTADO');
    expect(r.body.whatsapp).toMatchObject({ registrado: true, estado_nombre: 'PENDING_REVIEW' });
    expect(meta.llamadas).toEqual(expect.arrayContaining(['agregar', 'codigo', 'verificar', 'registrar']));
    const t = (await sql(`SELECT whatsapp_phone_number_id, whatsapp_estado, whatsapp_numero_visible FROM tenant WHERE id=$1`, [E.A])).rows[0];
    expect(t).toMatchObject({ whatsapp_phone_number_id: pid, whatsapp_estado: 'SIMULADO', whatsapp_numero_visible: '+573001234567' });
    // PIN cifrado y fuera del alcance del rol de ejecución; ni el código ni el PIN quedan en la bitácora o la auditoría.
    const cred = (await sql(`SELECT pin_cifrado, token_cifrado FROM numero_credencial WHERE contratacion_id=$1`, [id])).rows[0];
    expect(cred.pin_cifrado).toBeTruthy();
    expect(cred.pin_cifrado).not.toMatch(/^\d{6}$/);
    expect(cred.token_cifrado).toBeNull();
    await expect(E.db.withTenant(E.A, (tx) => tx.query(`SELECT * FROM numero_credencial`))).rejects.toThrow();
    const rastro = JSON.stringify([
      ...(await sql(`SELECT detalle FROM numero_evento WHERE contratacion_id=$1`, [id])).rows,
      ...(await sql(`SELECT detalle FROM audit_event WHERE recurso_id=$1`, [id])).rows,
    ]);
    expect(rastro).not.toMatch(/123456|000000/);
    // Cada intento quedó registrado.
    const tipos = (await sql(`SELECT tipo FROM numero_evento WHERE contratacion_id=$1`, [id])).rows.map((x: any) => x.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['numero_ingresado', 'numero_agregado', 'codigo_enviado', 'codigo_incorrecto', 'codigo_reenviado', 'codigo_verificado', 'numero_registrado', 'whatsapp_conectado']));
    meta.estadoNombre = 'APPROVED';
  });

  it('el primer mensaje entrante va a la IA de esta empresa y completa la prueba', async () => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: pid }, contacts: [{ wa_id: '573118887766', profile: { name: 'Cliente' } }], messages: [{ from: '573118887766', id: 'wamid.propio1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Hola, ¿tienen turno hoy?' } }] } }] }] });
    const r = await E.app.inject({ method: 'POST', url: '/api/webhooks/whatsapp', payload: body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(body) } });
    expect(r.json().recibidos[0].estado).toBe('aceptado');
    await drain(E.db);
    const enA = (await E.db.withTenant(E.A, (tx) => tx.query(`SELECT count(*)::int AS n FROM message m JOIN conversation c ON c.id=m.conversation_id JOIN customer k ON k.id=c.customer_id WHERE k.telefono='+573118887766' AND m.remitente <> 'CUSTOMER'`))).rows[0].n;
    expect(enA).toBeGreaterThan(0);
    const enB = (await E.db.withTenant(E.B, (tx) => tx.query(`SELECT count(*)::int AS n FROM customer WHERE telefono='+573118887766'`))).rows[0].n;
    expect(enB).toBe(0);
    expect((await A.get('/numeros/contratacion')).body.contratacion.prueba_recibida_en).toBeTruthy();
  });

  it('con un número conectado no se puede iniciar otro', async () => {
    expect((await A.get('/numeros/opciones')).body.propio.disponible).toBe(false);
    const r = await iniciar(A, '3009876543');
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Ya tienes un número conectado/);
  });

  it('desconectar exige confirmación escrita, hace deregister y libera el número', async () => {
    expect((await A.post(`/numeros/propio/${id}/desconectar`, {})).status).toBe(400);
    expect((await A.post(`/numeros/propio/${id}/desconectar`, { confirmacion: 'si' })).status).toBe(400);
    const r = await cancelar(A, id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'CANCELADO', subestado: 'desconectado' });
    expect(meta.llamadas).toContain('desregistrar');
    const t = (await sql(`SELECT whatsapp_phone_number_id, whatsapp_estado FROM tenant WHERE id=$1`, [E.A])).rows[0];
    expect(t).toMatchObject({ whatsapp_phone_number_id: null, whatsapp_estado: 'SIN_CONFIGURAR' });
    expect((await sql(`SELECT pin_cifrado FROM numero_credencial WHERE contratacion_id=$1`, [id])).rows[0].pin_cifrado).toBeNull();
    // Desde ahora se puede conectar otro número.
    expect((await A.get('/numeros/opciones')).body.propio.disponible).toBe(true);
  });
});

describe('Caminos difíciles', () => {
  it('código vencido (regla de Omnegia y respuesta de Meta): pide uno nuevo', async () => {
    const id = (await iniciar(B, '3015550101')).body.id;
    await atrasarEnvio(id, 11);
    const r = await B.post(`/numeros/propio/${id}/verificar`, { codigo: '123456' });
    expect(r.status).toBe(409);
    expect(r.body.error.details.motivo).toBe('CODIGO_VENCIDO');
    expect(r.body.error.message).toMatch(/venció/);
    // Vencido no cuenta como intento fallido.
    expect((await fila(id)).verificacion.intentos).toBe(0);
    expect((await B.post(`/numeros/propio/${id}/reenviar`, {})).status).toBe(200);
    meta.forzar.add('codigo_vencido');
    try {
      const m = await B.post(`/numeros/propio/${id}/verificar`, { codigo: '123456' });
      expect(m.body.error.details.motivo).toBe('CODIGO_VENCIDO');
      expect(m.body.error.message).not.toMatch(/expired/i);
    } finally { meta.forzar.delete('codigo_vencido'); }
    // Abandonar a mitad no pide confirmación escrita.
    expect((await B.post(`/numeros/propio/${id}/desconectar`, {})).body.estado).toBe('CANCELADO');
  });

  it('cinco códigos incorrectos cierran el proceso y bloquean temporalmente un nuevo intento', async () => {
    const id = (await iniciar(B, '3015550102')).body.id;
    for (let i = 1; i <= 4; i++) expect((await B.post(`/numeros/propio/${id}/verificar`, { codigo: '111111' })).body.error.details.quedan).toBe(5 - i);
    const ultimo = await B.post(`/numeros/propio/${id}/verificar`, { codigo: '111111' });
    expect(ultimo.body.error.details.motivo).toBe('DEMASIADOS_INTENTOS');
    const f = await fila(id);
    expect(f.estado).toBe('CONEXION_FALLIDA');
    expect(new Date(f.bloqueo_cliente_hasta).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    // Ni el código correcto pasa durante el bloqueo, ni se puede empezar de nuevo hasta que termine.
    expect((await B.post(`/numeros/propio/${id}/verificar`, { codigo: '123456' })).status).toBe(409);
    await B.post(`/numeros/propio/${id}/desconectar`, {});
    const otra = await iniciar(B, '3015550102');
    expect(otra.status).toBe(409);
    expect(otra.body.error.details.motivo).toBe('DEMASIADOS_INTENTOS');
    await sql(`UPDATE numero_contratacion SET bloqueo_cliente_hasta=NULL WHERE tenant_id=$1`, [E.B]);
  });

  it('máximo tres reenvíos por hora y luego bloqueo', async () => {
    const id = (await iniciar(B, '3015550103')).body.id;
    for (let i = 0; i < 3; i++) {
      await atrasarEnvio(id, 2);
      expect((await B.post(`/numeros/propio/${id}/reenviar`, {})).status).toBe(200);
    }
    await atrasarEnvio(id, 2);
    const cuarto = await B.post(`/numeros/propio/${id}/reenviar`, {});
    expect(cuarto.status).toBe(409);
    expect(cuarto.body.error.message).toMatch(/3 códigos en la última hora/);
    expect((await fila(id)).bloqueo_cliente_hasta).toBeTruthy();
    expect((await sql(`SELECT count(*)::int AS n FROM numero_evento WHERE contratacion_id=$1 AND tipo='reenvios_agotados'`, [id])).rows[0].n).toBe(1);
    await B.post(`/numeros/propio/${id}/desconectar`, {});
    await sql(`UPDATE numero_contratacion SET bloqueo_cliente_hasta=NULL WHERE tenant_id=$1`, [E.B]);
  });

  it('número ya registrado en WhatsApp: mensaje accionable, sin el texto de Meta', async () => {
    const r = await iniciar(B, '3015550001');
    expect(r.status).toBe(409);
    expect(r.body.error.details.motivo).toBe('NUMERO_EN_USO');
    expect(r.body.error.message).toMatch(/Eliminar mi cuenta/);
    expect(r.body.error.message).not.toMatch(/already/i);
    expect((await B.get('/numeros/contratacion')).body.contratacion.estado).toBe('CANCELADO');
  });

  it('límite de números de la WABA: alerta al operador', async () => {
    meta.forzar.add('limite_waba');
    try {
      const r = await iniciar(B, '3015550104');
      expect(r.body.error.details.motivo).toBe('LIMITE_NUMEROS');
      expect(r.body.error.message).toMatch(/Ya avisamos al equipo/);
    } finally { meta.forzar.delete('limite_waba'); }
    const inc = (await sql(`SELECT gravedad, detalle FROM incidente WHERE codigo='NUMERO_LIMITE_WABA' AND tenant_id=$1`, [E.B])).rows[0];
    expect(inc.gravedad).toBe('CRITICA');
  });

  it('nombre visible rechazado por Meta', async () => {
    meta.forzar.add('nombre_rechazado');
    try {
      const r = await iniciar(B, '3015550105', { nombre_visible: 'WHATSAPP OFERTAS' });
      expect(r.body.error.details.motivo).toBe('NOMBRE_RECHAZADO');
      expect(r.body.error.message).toMatch(/WHATSAPP OFERTAS/);
    } finally { meta.forzar.delete('nombre_rechazado'); }
  });

  it('si Meta aún no reporta el número conectado, se queda «Conectando…» y el trabajador lo termina', async () => {
    const lenta = new (class extends MetaSimulada { estadoMeta = 'PENDING'; override async consultar() { return { ...(await super.consultar()), estado: this.estadoMeta }; } })();
    setMetaOnboarding(lenta);
    try {
      const id = (await iniciar(B, '3015550106')).body.id;
      const r = await B.post(`/numeros/propio/${id}/verificar`, { codigo: '123456' });
      expect(r.body).toMatchObject({ estado: 'REGISTRADO', subestado: 'esperando_meta' });
      lenta.estadoMeta = 'CONNECTED';
      await sql(`UPDATE job SET ejecutar_en=now() WHERE estado='PENDIENTE' AND tipo='numero_propio'`);
      await drain(E.db);
      expect((await fila(id)).estado).toBe('CONECTADO');
      expect(lenta.llamadas.filter((x) => x === 'registrar')).toHaveLength(1);
      await cancelar(B, id);
    } finally { setMetaOnboarding(meta); }
  });

  it('un proceso abandonado a mitad se cierra solo a las 48 horas', async () => {
    const id = (await iniciar(B, '3015550107')).body.id;
    await sql(`UPDATE numero_contratacion SET actualizado_en=now() - interval '49 hours' WHERE id=$1`, [id]);
    await HANDLERS.ciclo_numeros(E.db, null, {}, { id: 'ciclo-propio' });
    expect((await fila(id)).estado).toBe('CANCELADO');
  });
});
