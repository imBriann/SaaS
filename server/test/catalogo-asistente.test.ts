import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, CRED, login, setup, type Env } from './helpers.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Catálogo: validación de nombres, duplicados y revisión de datos incompletos sin borrar nada.
 * Asistente del panel: propone crear o editar ítems y solo se guardan cuando la misma persona confirma
 * (con sus permisos comprobados otra vez al confirmar); la guía que da corresponde a pantallas reales.
 */
let E: Env;
let admin: ReturnType<typeof api>;
let laura: ReturnType<typeof api>;
let cookieAdmin = '';

beforeAll(async () => {
  E = await setup();
  cookieAdmin = await login(E.app, ...CRED.admin);
  admin = api(E.app, cookieAdmin, 'elparche');
  laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

const productos = async () => (await admin.get('/productos')).body as any[];

describe('Calidad del catálogo', () => {
  it('rechaza nombres sin letras y duplicados del mismo tipo', async () => {
    const r = await admin.post('/productos', { tipo: 'SERVICIO', nombre: '12', precio: 12, duracion_min: 30 });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('al menos una letra');
    const d = await admin.post('/productos', { tipo: 'SERVICIO', nombre: 'corte CLÁSICO', precio: 20000, duracion_min: 30 });
    expect(d.status).toBe(409);
    expect(d.body.error.message).toContain('Ya existe «Corte clásico»');
  });

  it('señala los ítems a revisar (como un servicio «12» sin categoría) sin cambiarlos ni borrarlos', async () => {
    const id = uuidv7();
    // Un registro de prueba heredado (anterior a la validación).
    await E.db.withTenant(E.A, (tx) => tx.query(`INSERT INTO product (id, tenant_id, tipo, nombre, precio, duracion_min) VALUES ($1,$2,'SERVICIO','12',12,30)`, [id, E.A]));
    const r = (await admin.get('/productos/revision')).body;
    const item = r.items.find((i: any) => i.id === id);
    expect(item.problemas.map((p: any) => p.codigo)).toEqual(expect.arrayContaining(['nombre_sin_letras', 'precio_bajo', 'sin_categoria']));
    // Lo que impide vender bien va antes que la falta de categoría.
    expect(r.items[0].problemas.some((p: any) => p.codigo !== 'sin_categoria')).toBe(true);
    expect((await productos()).some((p) => p.id === id)).toBe(true);
    // Se corrige editándolo; deja de aparecer en la revisión.
    expect((await admin.patch(`/productos/${id}`, { nombre: 'Corte infantil', categoria: 'Cortes', precio: 12000 })).status).toBe(200);
    const despues = (await admin.get('/productos/revision')).body.items.find((i: any) => i.id === id);
    expect(despues).toBeUndefined();
  });

  it('la importación marca y rechaza filas cuyo nombre no tiene letras', async () => {
    const r = await admin.post('/productos/importar/confirmar', { duplicados: 'omitir', filas: [{ fila: 2, tipo: 'SERVICIO', nombre: '999', precio: 1000, iva_pct: 0, duracion_min: 30 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ creados: 0, rechazados: 1 });
    expect(r.body.reporte[0].motivo).toContain('al menos una letra');
  });
});

describe('Asistente: cambios de catálogo con confirmación explícita', () => {
  let hilo = '';
  let pendiente = '';

  it('propone crear un servicio y no lo guarda hasta que la persona confirma', async () => {
    const r = await admin.post('/asistente', { pregunta: 'crea el servicio Corte premium a 35.000 de 45 minutos' });
    expect(r.status).toBe(200);
    hilo = r.body.hilo_id;
    const recibo = r.body.ejecuciones.find((e: any) => e.herramienta === 'crear_item_catalogo');
    expect(recibo).toMatchObject({ decision: 'PENDIENTE_CONFIRMACION' });
    expect(recibo.resumen).toContain('«Corte premium» por $35.000, 45 min');
    pendiente = recibo.pendiente_id;
    expect(r.body.texto).toContain('Confirmar');
    expect(r.body.texto).not.toMatch(/Listo: creé|quedó creado/);
    expect((await productos()).some((p) => p.nombre === 'Corte premium')).toBe(false);
  });

  it('otra persona no puede confirmar la acción de alguien más', async () => {
    expect((await laura.post(`/asistente/acciones/${pendiente}`, { decision: 'confirmar' })).status).toBe(404);
  });

  it('al confirmar se crea con los datos dados, queda auditado y la conversación lo cuenta', async () => {
    const c = await admin.post(`/asistente/acciones/${pendiente}`, { decision: 'confirmar' });
    expect(c.status).toBe(200);
    expect(c.body.texto).toContain('Listo: creé el servicio «Corte premium» por $35.000 (45 min)');
    const p = (await productos()).find((x) => x.nombre === 'Corte premium');
    expect(p).toMatchObject({ tipo: 'SERVICIO', precio: 35000, duracion_min: 45, activo: true });
    const aud = (await admin.get('/auditoria?q=catalogo.crear')).body.find((e: any) => e.recurso_id === p.id);
    expect(aud.actor_tipo).toBe('AGENTE');
    expect(aud.actor_nombre).toBe('Asistente (para Andrea Jaimes)');
    expect((await admin.post(`/asistente/acciones/${pendiente}`, { decision: 'confirmar' })).status).toBe(409);
    const h = (await admin.get(`/asistente/hilos/${hilo}`)).body;
    const propuesto = h.mensajes.flatMap((m: any) => m.ejecuciones).find((e: any) => e.pendiente_id === pendiente);
    expect(propuesto.pendiente.estado).toBe('CONFIRMADA');
    expect(h.mensajes.at(-1).contenido).toContain('Listo: creé');
  });

  it('cancelar no cambia nada y queda registrado como rechazado por la persona', async () => {
    const antes = (await productos()).find((x) => x.nombre === 'Corte clásico');
    const r = await admin.post('/asistente', { pregunta: 'cambia el precio del corte clásico a 99.000', hilo_id: hilo });
    const recibo = r.body.ejecuciones.find((e: any) => e.herramienta === 'editar_item_catalogo');
    expect(recibo.resumen).toContain(`precio $${antes.precio.toLocaleString('es-CO').replace(/,/g, '.')} → $99.000`);
    const c = await admin.post(`/asistente/acciones/${recibo.pendiente_id}`, { decision: 'cancelar' });
    expect(c.body).toMatchObject({ decision: 'RECHAZADA_POR_CLIENTE', estado: 'RECHAZADA' });
    expect((await productos()).find((x) => x.nombre === 'Corte clásico').precio).toBe(antes.precio);
  });

  it('los permisos se comprueban de nuevo al confirmar: si ya no puede editar el catálogo, no se hace', async () => {
    const r = await admin.post('/asistente', { pregunta: 'cambia el precio del corte clásico a 41.000', hilo_id: hilo });
    const id = r.body.ejecuciones.find((e: any) => e.herramienta === 'editar_item_catalogo').pendiente_id;
    await E.db.withTenant(E.A, (tx) => tx.query(`DELETE FROM role_permission WHERE permiso='catalog:write' AND role_id=(SELECT id FROM role WHERE clave='administrador')`));
    try {
      const cookie = await login(E.app, ...CRED.admin); // la sesión toma los permisos nuevos
      const c = await api(E.app, cookie, 'elparche').post(`/asistente/acciones/${id}`, { decision: 'confirmar' });
      expect(c.status).toBe(200);
      expect(c.body.estado).toBe('FALLIDA');
      expect(c.body.texto).toContain('tu rol no puede editar el catálogo');
      expect((await productos()).find((x) => x.nombre === 'Corte clásico').precio).not.toBe(41000);
    } finally {
      await E.db.withTenant(E.A, (tx) => tx.query(`INSERT INTO role_permission (tenant_id, role_id, permiso) SELECT tenant_id, id, 'catalog:write' FROM role WHERE clave='administrador' ON CONFLICT DO NOTHING`));
    }
  });

  it('una confirmación vencida no ejecuta nada', async () => {
    const r = await admin.post('/asistente', { pregunta: 'crea el producto Gel fijador a 18.000', hilo_id: hilo });
    const id = r.body.ejecuciones.find((e: any) => e.herramienta === 'crear_item_catalogo').pendiente_id;
    await E.db.withTenant(E.A, (tx) => tx.query(`UPDATE pending_action SET expira_en = now() - interval '1 minute' WHERE id=$1`, [id]));
    const c = await admin.post(`/asistente/acciones/${id}`, { decision: 'confirmar' });
    expect(c.status).toBe(409);
    expect(c.body.error.message).toContain('venció');
    expect((await productos()).some((p) => p.nombre === 'Gel fijador')).toBe(false);
  });

  it('quien no puede editar el catálogo no recibe la herramienta y el asistente no finge que lo hizo', async () => {
    const r = await laura.post('/asistente', { pregunta: 'crea el servicio Masaje capilar a 20.000 de 20 minutos' });
    expect(r.status).toBe(200);
    expect(r.body.ejecuciones.some((e: any) => e.herramienta === 'crear_item_catalogo')).toBe(false);
    expect(r.body.texto).not.toMatch(/Listo: creé|quedó creado/);
    expect((await productos()).some((p) => p.nombre === 'Masaje capilar')).toBe(false);
  });
});

describe('Asistente: guía verificada y avance real', () => {
  it('explica dónde importar el catálogo según la pantalla real (no en Configuración)', async () => {
    const r = await admin.post('/asistente', { pregunta: '¿cómo importo muchos productos del catálogo?' });
    expect(r.body.texto).toContain('«Importar» en esa misma pantalla');
    expect(r.body.texto).not.toMatch(/importación desde hoja de cálculo en Configuración/);
  });

  it('el modo en vivo envía el avance real (herramientas) y luego la respuesta', async () => {
    const res = await E.app.inject({ method: 'POST', url: '/api/t/asistente/stream', payload: { pregunta: '¿cuánto vendimos esta semana?' }, headers: { cookie: cookieAdmin, 'x-tenant-slug': 'elparche' } });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('event: progreso');
    expect(res.body).toMatch(/"herramienta":"resumen_ventas","fase":"inicio"/);
    const respuesta = res.body.split('\n\n').find((b) => b.startsWith('event: respuesta'))!;
    const data = JSON.parse(respuesta.split('\ndata: ')[1]);
    expect(data.texto).toContain('ventas por');
    expect(data.hilo_id).toBeTruthy();
    const sinPregunta = await E.app.inject({ method: 'POST', url: '/api/t/asistente/stream', payload: { pregunta: '  ' }, headers: { cookie: cookieAdmin, 'x-tenant-slug': 'elparche' } });
    expect(sinPregunta.statusCode).toBe(400);
  });
});
