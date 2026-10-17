import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setup, verificarAlta, loginOperador, op, type Env } from './helpers.js';
import { HANDLERS } from '../src/worker/jobs.js';

let E: Env;
let admin: ReturnType<typeof op>;
let soporte: ReturnType<typeof op>;
beforeAll(async () => {
  E = await setup();
  admin = op(E.app, await loginOperador(E.app, E.db));
  soporte = op(E.app, await loginOperador(E.app, E.db, 'soporte@saas.test', 'demo-soporte-2026'));
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

const post = (url: string, payload: any = {}, ip?: string) => E.app.inject({ method: 'POST', url, payload, ...(ip ? { remoteAddress: ip } : {}) });
const patch = (tk: string, payload: any) => E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${tk}`, payload });
let ipN = 20;
const ip = () => `10.1.0.${ipN++}`;

/** Un alta pagada. Con `diferida` el espacio no se crea hasta que la persona lo pide (el flujo actual del registro). */
async function alta(slug: string, diferida: boolean) {
  const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una tienda de ropa y vendo accesorios.', creacion_diferida: diferida })).json();
  const email = `${slug}@reembolso.test`;
  expect((await patch(d.token, { negocio: { nombre: `Negocio ${slug}`, slug, email } })).statusCode).toBe(200);
  await verificarAlta(E, d.token);
  const p = await post(`/api/onboarding/borradores/${d.token}/pago`);
  expect(p.statusCode, p.body).toBe(200);
  await post('/api/pasarela/simular', { ref: p.json().referencia });
  return { tk: d.token as string, ref: p.json().referencia as string, email };
}
const pedir = (a: { ref: string; email: string }, extra: any = {}, dir = ip()) =>
  post('/api/publico/reembolsos', { referencia: a.ref, email: a.email, nombre: 'Marta Rojas', motivo: 'RETRACTO', medio: 'MISMO_MEDIO', detalle: 'Me arrepentí de la compra y quiero el reembolso.', ...extra }, dir);
const fila = (radicado: string) => E.db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM reembolso WHERE radicado=$1`, [radicado])).rows[0]);

describe('Retracto y reembolso', () => {
  it('el retracto en plazo, antes de crear el espacio, se aprueba solo, bloquea la creación y avisa a las dos partes', async () => {
    const a = await alta('retracto-ok', true);
    const r = await pedir(a);
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    expect(s).toMatchObject({ estado: 'APROBADO', aprobado_automatico: true, dias_calendario: 15 });
    expect(s.radicado).toMatch(/^RB-\d{4}-\d{6}$/);
    const x = await fila(s.radicado);
    expect(Number(x.monto)).toBeGreaterThan(0);
    // El plazo de devolución es de 15 días calendario desde la solicitud.
    expect(Math.round((new Date(x.vence_en).getTime() - new Date(x.creado_en).getTime()) / 86_400_000)).toBe(15);
    // El espacio ya no se puede crear con un pago que se devuelve.
    const crear = await post(`/api/onboarding/borradores/${a.tk}/crear`, { password: 'una-clave-larga-2026' });
    expect(crear.statusCode).toBe(409);
    expect(crear.json().error.message).toMatch(/se devuelve/);
    const correos = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT para, tipo FROM email_outbox WHERE tipo IN ('reembolso_recibido','reembolso_interno') ORDER BY creado_en`)).rows);
    expect(correos.filter((c: any) => c.tipo === 'reembolso_recibido' && c.para === a.email)).toHaveLength(1);
    expect(correos.some((c: any) => c.tipo === 'reembolso_interno')).toBe(true);
  });

  it('no revela nada si la referencia o el correo no coinciden, y no admite dos solicitudes vivas del mismo pago', async () => {
    const a = await alta('retracto-id', true);
    const mal1 = await pedir({ ref: a.ref, email: 'otra@persona.test' });
    const mal2 = await pedir({ ref: 'SUB-NOEXISTE1', email: a.email });
    expect(mal1.statusCode).toBe(404);
    expect(mal2.statusCode).toBe(404);
    expect(mal1.json().error.message).toBe(mal2.json().error.message);
    // La referencia se acepta aunque la persona cambie mayúsculas y minúsculas al copiarla.
    expect((await pedir({ ref: a.ref.toLowerCase(), email: a.email.toUpperCase() })).statusCode).toBe(200);
    const otra = await pedir(a);
    expect(otra.statusCode).toBe(409);
    expect(otra.json().error.message).toMatch(/RB-/);
  });

  it('valida los datos de la solicitud y limita las repetidas desde un mismo origen', async () => {
    const a = await alta('retracto-val', true);
    expect((await pedir(a, { detalle: 'corto' })).statusCode).toBe(400);
    expect((await pedir(a, { motivo: 'QUIERO_DINERO' })).statusCode).toBe(400);
    expect((await pedir(a, { email: 'no-es-correo' })).statusCode).toBe(400);
    const mismo = '10.1.9.9';
    let ultimo = 0;
    for (let i = 0; i < 6; i++) ultimo = (await pedir({ ref: 'SUB-NOEXISTE2', email: `x${i}@x.test` }, {}, mismo)).statusCode;
    expect(ultimo).toBe(404); // los intentos fallidos no cuentan: solo las solicitudes registradas
  });

  it('con el espacio ya creado, el retracto pasa a revisión de una persona (nunca se rechaza solo)', async () => {
    const a = await alta('retracto-tarde', false);
    const r = await pedir(a);
    expect(r.json()).toMatchObject({ estado: 'EN_REVISION', aprobado_automatico: false });
    const x = await fila(r.json().radicado);
    expect(x.evaluacion.regla).toBe('servicio_iniciado');
  });

  it('fuera de los 5 días hábiles pasa a revisión', async () => {
    const a = await alta('retracto-plazo', true);
    await E.db.withPlatform((tx) => tx.query(`UPDATE payment SET verificado_en = now() - interval '20 days' WHERE referencia=$1`, [a.ref]));
    const r = await pedir(a);
    expect(r.json().estado).toBe('EN_REVISION');
    expect((await fila(r.json().radicado)).evaluacion.regla).toBe('fuera_de_plazo');
  });

  it('un cobro duplicado verificable se aprueba solo; sin otro pago previo va a revisión', async () => {
    const a = await alta('duplicado', true);
    const b = await alta('no-duplicado', true);
    // Segundo pago aprobado, posterior, para la misma alta.
    await E.db.withPlatform(async (tx) => {
      const p = (await tx.query(`SELECT * FROM payment WHERE referencia=$1`, [a.ref])).rows[0];
      await tx.query(
        `INSERT INTO payment (id, draft_token, referencia, concepto, monto, moneda, estado, proveedor, modalidad, plan_codigo, verificado_en) VALUES ($1,$2,$3,$4,$5,$6,'APROBADO',$7,$8,$9, now() + interval '1 minute')`,
        ['0197c0aa-0000-7000-8000-000000000001', p.draft_token, 'SUB-DUPLICADO01', 'Duplicado', p.monto, p.moneda, p.proveedor, p.modalidad, p.plan_codigo]);
    });
    const dup = await pedir({ ref: 'SUB-DUPLICADO01', email: a.email }, { motivo: 'COBRO_DUPLICADO', detalle: 'Me cobraron dos veces la misma compra.' });
    expect(dup.json()).toMatchObject({ estado: 'APROBADO', aprobado_automatico: true });
    // Un cobro duplicado no cancela el servicio: el otro pago sigue valiendo.
    const x = await fila(dup.json().radicado);
    expect(x.motivo).toBe('COBRO_DUPLICADO');
    const sin = await pedir(b, { motivo: 'COBRO_DUPLICADO', detalle: 'Creo que me cobraron dos veces.' });
    expect(sin.json().estado).toBe('EN_REVISION');
  });

  it('un motivo distinto va siempre a revisión', async () => {
    const a = await alta('otro-motivo', true);
    const r = await pedir(a, { motivo: 'COBRO_NO_RECONOCIDO', detalle: 'No reconozco este cobro en mi tarjeta.' });
    expect(r.json()).toMatchObject({ estado: 'EN_REVISION', aprobado_automatico: false });
  });
});

describe('Cola del operador y devolución del dinero', () => {
  it('el operador de administración decide, registra la devolución y la persona la ve en su consulta', async () => {
    const a = await alta('flujo-operador', false);
    const r = (await pedir(a)).json(); // EN_REVISION (el espacio ya existe)
    const cola = await admin.get('/reembolsos?estado=EN_REVISION');
    expect(cola.status).toBe(200);
    const item = cola.body.reembolsos.find((x: any) => x.radicado === r.radicado);
    expect(item).toMatchObject({ referencia: a.ref, estado: 'EN_REVISION', motivo: 'RETRACTO', vencido: false });
    expect(item.dias_restantes).toBeGreaterThanOrEqual(14);

    // Soporte ve la cola pero no decide ni mueve dinero.
    expect((await soporte.get('/reembolsos')).status).toBe(200);
    expect((await soporte.post(`/reembolsos/${item.id}/decidir`, { decision: 'APROBAR' })).status).toBe(403);
    // Rechazar exige un motivo.
    expect((await admin.post(`/reembolsos/${item.id}/decidir`, { decision: 'RECHAZAR', motivo: 'no' })).status).toBe(400);
    // No se puede registrar la devolución antes de aprobar.
    expect((await admin.post(`/reembolsos/${item.id}/devuelto`, { referencia: 'WOMPI-REF-1' })).status).toBe(409);

    expect((await admin.post(`/reembolsos/${item.id}/decidir`, { decision: 'APROBAR', motivo: 'Fallo en la activación confirmado por soporte.' })).body).toMatchObject({ estado: 'APROBADO' });
    expect((await admin.post(`/reembolsos/${item.id}/decidir`, { decision: 'APROBAR' })).status).toBe(409);
    expect((await admin.post(`/reembolsos/${item.id}/devuelto`, { referencia: '!!' })).status).toBe(400);
    expect((await admin.post(`/reembolsos/${item.id}/devuelto`, { referencia: 'WOMPI-REF-1' })).body).toMatchObject({ estado: 'REEMBOLSADO' });
    expect((await admin.post(`/reembolsos/${item.id}/devuelto`, { referencia: 'WOMPI-REF-2' })).status).toBe(409);

    const pago = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT estado FROM payment WHERE referencia=$1`, [a.ref])).rows[0]);
    expect(pago.estado).toBe('REEMBOLSADO');
    const c = await post('/api/publico/reembolsos/consulta', { radicado: r.radicado, email: a.email.toUpperCase() });
    expect(c.json()).toMatchObject({ radicado: r.radicado, estado: 'REEMBOLSADO', referencia_devolucion: 'WOMPI-REF-1' });
    expect(c.body).not.toContain('detalle');
    expect((await post('/api/publico/reembolsos/consulta', { radicado: r.radicado, email: 'otra@x.test' })).statusCode).toBe(404);
    const auditoria = (await admin.get('/auditoria')).body.eventos.map((e: any) => e.accion);
    expect(auditoria).toEqual(expect.arrayContaining(['reembolso.aprobar', 'reembolso.devuelto']));
    const correos = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT tipo FROM email_outbox WHERE para=$1`, [a.email])).rows.map((x: any) => x.tipo));
    expect(correos).toEqual(expect.arrayContaining(['reembolso_recibido', 'reembolso_decision', 'reembolso_devuelto']));
  });

  it('un rechazo explica el motivo a la persona y deja la solicitud cerrada', async () => {
    const a = await alta('rechazo', false);
    const r = (await pedir(a)).json();
    const id = (await admin.get('/reembolsos?estado=EN_REVISION')).body.reembolsos.find((x: any) => x.radicado === r.radicado).id;
    expect((await admin.post(`/reembolsos/${id}/decidir`, { decision: 'RECHAZAR', motivo: 'El servicio ya se prestó con tu acuerdo expreso.' })).body.estado).toBe('RECHAZADO');
    const c = (await post('/api/publico/reembolsos/consulta', { radicado: r.radicado, email: a.email })).json();
    expect(c).toMatchObject({ estado: 'RECHAZADO', explicacion: 'El servicio ya se prestó con tu acuerdo expreso.' });
    // Tras un rechazo se puede volver a pedir (hay hechos nuevos), porque ya no hay solicitud viva.
    expect((await pedir(a, { motivo: 'OTRO', detalle: 'Presento un nuevo hecho para revisar el caso.' })).statusCode).toBe(200);
  });

  it('el mantenimiento abre un incidente cuando un reembolso está por vencer', async () => {
    const a = await alta('por-vencer', true);
    const r = (await pedir(a)).json();
    await E.db.withPlatform((tx) => tx.query(`UPDATE reembolso SET vence_en = now() + interval '1 day' WHERE radicado=$1`, [r.radicado]));
    await HANDLERS.mantenimiento(E.db, null, {}, { id: 'j' });
    const inc = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT codigo, estado FROM incidente WHERE codigo='REEMBOLSO_POR_VENCER'`)).rows);
    expect(inc).toEqual([{ codigo: 'REEMBOLSO_POR_VENCER', estado: 'ABIERTO' }]);
    const lista = (await admin.get('/reembolsos?estado=APROBADO')).body.reembolsos.find((x: any) => x.radicado === r.radicado);
    expect(lista.dias_restantes).toBeLessThanOrEqual(1);
  });
});
