import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { drain } from '../src/worker/jobs.js';
import { cicloProactivo } from '../src/modules/proactivo.js';
import { festivoDe, festivosColombia, pascua } from '../src/lib/festivos.js';
import { addDays, localToUtc, todayLocal, utcToLocal } from '../src/lib/time.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Agenda automática: motor único de disponibilidad (buffers, festivos, dos recursos, bloqueos), doble reserva
 * imposible con concurrencia, lista de espera, inasistencia, series y zona horaria en el cambio de día.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
let corte = '';
let recurso = '';
let cliente = '';
const ZONA = 'America/Bogota';
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
/** Primer día laborable (lun–vie, no festivo) desde dentro de `desde` días. */
function laborable(desde = 2) {
  let f = addDays(todayLocal(ZONA), desde);
  for (;;) {
    const d = new Date(`${f}T12:00:00Z`).getUTCDay();
    if (d >= 1 && d <= 5 && !festivoDe(f)) return f;
    f = addDays(f, 1);
  }
}
const huecos = async (fecha: string, producto = corte, rec = recurso) => (await A.get(`/agenda/disponibilidad?servicio_id=${producto}&fecha=${fecha}&recurso_id=${rec}`)).body.franjas as any[];

beforeAll(async () => {
  E = await setup();
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
  corte = (await sql(`SELECT id FROM product WHERE tenant_id=$1 AND nombre='Corte clásico'`, [E.A])).rows[0].id;
  recurso = (await sql(`SELECT id FROM resource WHERE tenant_id=$1 AND activo ORDER BY nombre LIMIT 1`, [E.A])).rows[0].id;
  cliente = (await A.post('/clientes', { nombre: 'Cliente Agenda', telefono: '+573160000001' })).body.id;
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Festivos de Colombia', () => {
  it('Pascua, ley Emiliani y fijos', () => {
    expect(pascua(2026).toISOString().slice(0, 10)).toBe('2026-04-05');
    const f = festivosColombia(2026).map((x) => x.fecha);
    expect(f).toEqual(expect.arrayContaining(['2026-01-01', '2026-01-12', '2026-04-02', '2026-04-03', '2026-05-18', '2026-07-20', '2026-11-02', '2026-11-16', '2026-12-25']));
    expect(f.length).toBe(18);
  });

  it('un festivo no ofrece huecos (con el interruptor encendido)', async () => {
    const lunesFestivo = festivosColombia(2027).find((x) => new Date(`${x.fecha}T12:00:00Z`).getUTCDay() === 1 && x.fecha > todayLocal(ZONA))!.fecha;
    await A.patch('/agenda/ajustes', { horizonte_dias: 365 });
    expect(await huecos(lunesFestivo)).toEqual([]);
    await A.patch('/agenda/ajustes', { usar_festivos: false });
    expect((await huecos(lunesFestivo)).length).toBeGreaterThan(0);
    await A.patch('/agenda/ajustes', { usar_festivos: true, horizonte_dias: 60 });
  });
});

describe('Doble reserva imposible', () => {
  it('dos pedidos simultáneos del mismo hueco: uno lo consigue y el otro recibe alternativas', async () => {
    const fecha = laborable(3);
    const inicio = localToUtc(fecha, '10:00', ZONA).toISOString();
    const otro = (await A.post('/clientes', { nombre: 'Competidor', telefono: '+573160000002' })).body.id;
    const [a, b] = await Promise.all([
      A.post('/agenda/citas', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio }),
      A.post('/agenda/citas', { customer_id: otro, product_id: corte, resource_id: recurso, inicio }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const perdedor = a.status === 409 ? a : b;
    expect(perdedor.body.error.details.alternativas.length).toBeGreaterThan(0);
    expect(perdedor.body.error.details.alternativas.length).toBeLessThanOrEqual(3);
    expect((await sql(`SELECT count(*)::int AS n FROM appointment WHERE resource_id=$1 AND inicio=$2 AND estado <> 'CANCELADA'`, [recurso, inicio])).rows[0].n).toBe(1);
  });

  it('la base rechaza un solapamiento aunque el código se saltara la comprobación (exclusión)', async () => {
    const tiene = (await sql(`SELECT 1 FROM pg_constraint WHERE conname='ex_appt_recurso_libre'`)).rows.length;
    if (!tiene) return; // motor sin btree_gist: queda el bloqueo transaccional (docs/agenda)
    const fecha = laborable(4);
    const ini = localToUtc(fecha, '11:00', ZONA);
    await A.post('/agenda/citas', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio: ini.toISOString() });
    await expect(E.db.withTenant(E.A, (tx) => tx.query(
      `INSERT INTO appointment (id, tenant_id, customer_id, product_id, resource_id, inicio, fin, estado, origen) VALUES ($1,$2,$3,$4,$5,$6,$7,'RESERVADA','PANEL')`,
      [uuidv7(), E.A, cliente, corte, recurso, new Date(ini.getTime() + 10 * 60000).toISOString(), new Date(ini.getTime() + 40 * 60000).toISOString()]))).rejects.toThrow();
  });
});

describe('Motor de disponibilidad', () => {
  it('respeta los buffers del servicio', async () => {
    await A.patch(`/productos/${corte}`, { buffer_despues_min: 30 });
    const fecha = laborable(5);
    await A.post('/agenda/citas', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio: localToUtc(fecha, '14:00', ZONA).toISOString() });
    const horas = (await huecos(fecha)).map((s) => s.hora);
    // 14:00–14:30 + 30 min de limpieza: 14:30 no está; 15:00 sí (si el horario lo permite).
    expect(horas).not.toContain('14:30');
    expect(horas).not.toContain('13:30'); // el nuevo corte (30 min + 30 de buffer) chocaría con el de las 14:00
    expect(horas).toContain('15:00');
    await A.patch(`/productos/${corte}`, { buffer_despues_min: 0 });
  });

  it('un servicio de dos recursos solo se ofrece si ambos están libres', async () => {
    const mesa = (await A.post('/agenda/recursos', { nombre: 'Mesa de lavado', tipo: 'ESPACIO', color: '#3366aa', horario: { lun: ['08:00', '20:00'], mar: ['08:00', '20:00'], mie: ['08:00', '20:00'], jue: ['08:00', '20:00'], vie: ['08:00', '20:00'] } })).body.id;
    const lavado = (await A.post('/productos', { tipo: 'SERVICIO', nombre: 'Lavado con masaje', precio: 20000, duracion_min: 30, recursos_secundarios: [mesa] })).body.id;
    const fecha = laborable(6);
    const libres = await huecos(fecha, lavado);
    expect(libres.length).toBeGreaterThan(0);
    expect(libres[0].recurso_secundario_id).toBe(mesa);
    // Bloqueo de la mesa todo el día: sin la mesa no hay servicio, aunque el barbero esté libre.
    const bloqueo = await A.post('/agenda/bloqueos', { resource_id: mesa, desde: localToUtc(fecha, '00:00', ZONA).toISOString(), hasta: localToUtc(fecha, '23:59', ZONA).toISOString(), motivo: 'Mantenimiento' });
    expect(bloqueo.status).toBe(200);
    expect(await huecos(fecha, lavado)).toEqual([]);
    // La cita creada ocupa los dos recursos.
    const otraFecha = laborable(7);
    const s = (await huecos(otraFecha, lavado))[0];
    const cita = (await A.post('/agenda/citas', { customer_id: cliente, product_id: lavado, inicio: s.inicio })).body;
    expect((await sql(`SELECT recurso_secundario_id FROM appointment WHERE id=$1`, [cita.id])).rows[0].recurso_secundario_id).toBe(mesa);
  });

  it('zona horaria correcta en el cambio de día (18:30 en Bogotá es 23:30 UTC del mismo día)', async () => {
    const fecha = laborable(8);
    const s = (await huecos(fecha)).find((x) => x.hora === '18:30');
    if (!s) return; // el horario del recurso no llega a esa hora
    expect(s.inicio).toBe(`${fecha}T23:30:00.000Z`);
    const cita = (await A.post('/agenda/citas', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio: s.inicio })).body;
    const dia = (await A.get(`/agenda?fecha=${fecha}`)).body.citas.map((c: any) => c.id);
    const siguiente = (await A.get(`/agenda?fecha=${addDays(fecha, 1)}`)).body.citas.map((c: any) => c.id);
    expect(dia).toContain(cita.id);
    expect(siguiente).not.toContain(cita.id);
    expect(utcToLocal(new Date(s.inicio), ZONA).fecha).toBe(fecha);
  });

  it('mover y estirar desde el calendario pasa por el mismo motor', async () => {
    const fecha = laborable(25); // fecha propia: laborable(n) salta fines de semana y puede repetir días de otras pruebas
    const a = (await A.post('/agenda/citas', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio: localToUtc(fecha, '09:00', ZONA).toISOString() })).body;
    const b = (await A.post('/agenda/citas', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio: localToUtc(fecha, '10:00', ZONA).toISOString() })).body;
    // Estirar la primera hasta chocar con la segunda: vuelve a su lugar con alternativas.
    expect((await A.post(`/agenda/citas/${a.id}/mover`, { inicio: localToUtc(fecha, '09:00', ZONA).toISOString(), duracion_min: 90, avisar: false })).status).toBe(409);
    const ok = await A.post(`/agenda/citas/${a.id}/mover`, { inicio: localToUtc(fecha, '09:15', ZONA).toISOString(), duracion_min: 45, avisar: true });
    expect(ok.status).toBe(200);
    expect(ok.body.aviso).toBeTruthy();
    expect((await A.get('/agenda/rango?desde=' + fecha + '&hasta=' + fecha)).body.citas.map((c: any) => c.id)).toEqual(expect.arrayContaining([a.id, b.id]));
  });
});

describe('Automatizaciones', () => {
  it('la lista de espera llena un cupo cancelado', async () => {
    const from = '573160000010';
    const wa = async (t: string) => { await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from, nombre: 'En espera', id: `le.${uuidv7()}`, texto: t }], 'WHATSAPP', 't'); await drain(E.db); };
    await wa('hola'); await wa('sí');
    const espera = (await sql(`SELECT id FROM customer WHERE tenant_id=$1 AND telefono=$2`, [E.A, `+${from}`])).rows[0].id;
    const fecha = laborable(10);
    const s = (await huecos(fecha)).find((x) => x.hora === '16:00') ?? (await huecos(fecha))[0];
    const cita = (await A.post('/agenda/citas', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio: s.inicio })).body;
    expect((await A.post('/agenda/lista-espera', { customer_id: espera, product_id: corte, desde: fecha, hasta: fecha })).status).toBe(200);
    expect((await A.patch(`/agenda/citas/${cita.id}`, { estado: 'CANCELADA', motivo: 'El cliente no puede' })).status).toBe(200);
    await drain(E.db);
    const le = (await sql(`SELECT estado, oferta FROM lista_espera WHERE customer_id=$1`, [espera])).rows[0];
    expect(le.estado).toBe('OFRECIDA');
    await wa('sí');
    const asignada = (await sql(`SELECT estado, appointment_id FROM lista_espera WHERE customer_id=$1`, [espera])).rows[0];
    expect(asignada.estado).toBe('ASIGNADA');
    expect((await sql(`SELECT origen, inicio FROM appointment WHERE id=$1`, [asignada.appointment_id])).rows[0]).toMatchObject({ origen: 'AUTOMATIZACION' });
  });

  it('una cita pasada sin marcar queda «No asistió» y se invita a reprogramar', async () => {
    const id = uuidv7();
    const ini = new Date(Date.now() - 3 * 3600_000);
    await E.db.withTenant(E.A, (tx) => tx.query(
      `INSERT INTO appointment (id, tenant_id, customer_id, product_id, resource_id, inicio, fin, estado, origen) VALUES ($1,$2,$3,$4,$5,$6,$7,'RESERVADA','PANEL')`,
      [id, E.A, cliente, corte, recurso, ini.toISOString(), new Date(ini.getTime() + 30 * 60000).toISOString()]));
    await cicloProactivo(E.db, 'prueba');
    expect((await sql(`SELECT estado FROM appointment WHERE id=$1`, [id])).rows[0].estado).toBe('NO_ASISTIO');
    expect((await sql(`SELECT tipo FROM aviso_proactivo WHERE appointment_id=$1`, [id])).rows.map((r) => r.tipo)).toContain('INASISTENCIA');
  });

  it('citas recurrentes cada 4 semanas', async () => {
    const fecha = laborable(2);
    const s = (await huecos(fecha))[0];
    const r = await A.post('/agenda/series', { customer_id: cliente, product_id: corte, resource_id: recurso, inicio: s.inicio, cada_semanas: 4, max_citas: 3 });
    expect(r.status).toBe(200);
    const citas = (await sql(`SELECT origen FROM appointment WHERE serie_id=$1 ORDER BY inicio`, [r.body.serie_id])).rows.map((x) => x.origen);
    expect(citas.length + r.body.sin_cupo.length).toBe(3);
    expect(citas[0]).toBe('PANEL');
  });
});

describe('Aislamiento', () => {
  it('otra empresa no ve ni mueve citas, bloqueos ni lista de espera ajenos', async () => {
    const cita = (await sql(`SELECT id FROM appointment WHERE tenant_id=$1 AND estado IN ('RESERVADA','CONFIRMADA') LIMIT 1`, [E.A])).rows[0].id;
    expect((await B.get(`/agenda/citas/${cita}`)).status).toBe(404);
    expect((await B.post(`/agenda/citas/${cita}/mover`, { inicio: new Date().toISOString() })).status).toBe(404);
    const bloqueo = (await sql(`SELECT id FROM resource_excepcion WHERE tenant_id=$1 LIMIT 1`, [E.A])).rows[0].id;
    expect((await B.del(`/agenda/bloqueos/${bloqueo}`)).status).toBe(404);
    expect((await B.get('/agenda/lista-espera')).body).toEqual([]);
    expect((await B.get(`/agenda/rango?desde=${todayLocal(ZONA)}&hasta=${addDays(todayLocal(ZONA), 30)}`)).body.citas.some((c: any) => c.id === cita)).toBe(false);
  });
});
