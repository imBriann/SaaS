import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, cliente, correosA, codigoDelCorreo, type Env } from './helpers.js';

/**
 * Perfil de la persona: datos propios, foto y teléfono, cambio de correo con código,
 * sesiones por dispositivo, nombre en la empresa y copia de los datos.
 */
let E: Env;
beforeAll(async () => { E = await setup(); });
afterAll(async () => { await E.app.close(); await E.db.close(); });

const FOTO = `data:image/png;base64,${'iVBORw0KGgo'.padEnd(400, 'A')}=`;

describe('Perfil', () => {
  it('muestra los datos propios y cambia nombre, teléfono y foto (con validación)', async () => {
    const c = cliente(E.app);
    await c.call('POST', '/api/auth/login', { email: CRED.laura[0], password: CRED.laura[1] }, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0' });
    const p = await c.call('GET', '/api/auth/perfil');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ email: CRED.laura[0], tiene_contrasena: true, foto: null, correo_pendiente: null });
    expect(p.body.sesiones.find((s: any) => s.actual)).toMatchObject({ agente: expect.stringContaining('Chrome') });
    expect(p.body.empresas.map((e: any) => e.slug)).toContain('elparche');
    expect(JSON.stringify(p.body)).not.toMatch(/password|hash|scrypt/);

    for (const malo of [{ nombre: 'x' }, { nombre: '<b>Laura</b>' }, { telefono: 'llámame' }, { foto: 'data:image/svg+xml;base64,PHN2Zz4=' }, { foto: 'javascript:alert(1)' }, {}]) {
      expect((await c.call('PATCH', '/api/auth/perfil', malo)).status).toBe(400);
    }
    const ok = await c.call('PATCH', '/api/auth/perfil', { nombre: '  Laura   Pabón R. ', telefono: '+57 (300) 123-4567', foto: FOTO, email: 'otro@correo.test' });
    expect(ok.status).toBe(200);
    const d = (await c.call('GET', '/api/auth/perfil')).body;
    expect(d).toMatchObject({ nombre: 'Laura Pabón R.', telefono: '+573001234567', foto: FOTO, email: CRED.laura[0] });
    expect((await c.call('GET', '/api/t/yo', undefined, { 'x-tenant-slug': 'elparche' })).body.usuario).toMatchObject({ nombre: 'Laura Pabón R.', foto: FOTO });
    expect(d.actividad[0]).toMatchObject({ accion: 'perfil.actualizado', resultado: 'EXITO' });
    // Quitar la foto y el teléfono.
    expect((await c.call('PATCH', '/api/auth/perfil', { foto: null, telefono: '' })).status).toBe(200);
    expect((await c.call('GET', '/api/auth/perfil')).body).toMatchObject({ foto: null, telefono: null });
    expect((await cliente(E.app).call('GET', '/api/auth/perfil')).status).toBe(401);
  });

  it('cambia el correo solo con la contraseña y el código del correo nuevo, y avisa al anterior', async () => {
    const c = cliente(E.app);
    await c.call('POST', '/api/auth/login', { email: CRED.andres[0], password: CRED.andres[1] });
    expect((await c.call('POST', '/api/auth/perfil/correo', { nuevo: 'andres.nuevo@correo.test', contrasena: 'no-es' })).status).toBe(400);
    expect((await c.call('POST', '/api/auth/perfil/correo', { nuevo: CRED.admin[0], contrasena: CRED.andres[1] })).status).toBe(409);
    expect((await c.call('POST', '/api/auth/perfil/correo', { nuevo: 'no-es-correo', contrasena: CRED.andres[1] })).status).toBe(400);
    const s = await c.call('POST', '/api/auth/perfil/correo', { nuevo: 'Andres.Nuevo@Correo.test', contrasena: CRED.andres[1] });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ destino: 'andres.nuevo@correo.test' });
    expect(JSON.stringify(s.body)).not.toMatch(/\b\d{6}\b/);
    expect((await c.call('GET', '/api/auth/perfil')).body).toMatchObject({ email: CRED.andres[0], correo_pendiente: 'andres.nuevo@correo.test' });

    const codigo = await codigoDelCorreo(E.db, 'andres.nuevo@correo.test', 'cambio_correo_codigo');
    expect((await c.call('POST', '/api/auth/perfil/correo/confirmar', { codigo: codigo === '000000' ? '000001' : '000000' })).status).toBe(400);
    const ok = await c.call('POST', '/api/auth/perfil/correo/confirmar', { codigo });
    expect(ok.status).toBe(200);
    expect((await c.call('GET', '/api/auth/perfil')).body).toMatchObject({ email: 'andres.nuevo@correo.test', correo_pendiente: null, correo_verificado: true });
    expect((await correosA(E.db, CRED.andres[0])).some((m) => m.tipo === 'correo_cambiado')).toBe(true);
    // El código no sirve dos veces y el correo anterior ya no entra.
    expect((await c.call('POST', '/api/auth/perfil/correo/confirmar', { codigo })).status).toBe(409);
    expect((await cliente(E.app).call('POST', '/api/auth/login', { email: CRED.andres[0], password: CRED.andres[1] })).status).toBe(401);
    expect((await cliente(E.app).call('POST', '/api/auth/login', { email: 'andres.nuevo@correo.test', password: CRED.andres[1] })).status).toBe(200);
  });

  it('cancelar el cambio de correo invalida el código', async () => {
    const c = cliente(E.app);
    await c.call('POST', '/api/auth/login', { email: CRED.gym[0], password: CRED.gym[1] });
    expect((await c.call('POST', '/api/auth/perfil/correo', { nuevo: 'gym.otro@correo.test', contrasena: CRED.gym[1] })).status).toBe(200);
    const codigo = await codigoDelCorreo(E.db, 'gym.otro@correo.test', 'cambio_correo_codigo');
    expect((await c.call('DELETE', '/api/auth/perfil/correo')).status).toBe(200);
    expect((await c.call('POST', '/api/auth/perfil/correo/confirmar', { codigo })).status).toBe(409);
    expect((await c.call('GET', '/api/auth/perfil')).body).toMatchObject({ email: CRED.gym[0], correo_pendiente: null });
  });

  it('lista las sesiones por dispositivo y cierra una o todas las demás, nunca la actual por id', async () => {
    const otra = await login(E.app, ...CRED.admin);
    const tercera = await login(E.app, ...CRED.admin);
    const c = cliente(E.app);
    await c.call('POST', '/api/auth/login', { email: CRED.admin[0], password: CRED.admin[1] });
    const s = (await c.call('GET', '/api/auth/perfil')).body.sesiones;
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s[0].actual).toBe(true);
    expect(s.every((x: any) => /^[0-9a-f]{12}$/.test(x.id))).toBe(true);
    expect((await c.call('DELETE', `/api/auth/perfil/sesiones/${s[0].id}`)).status).toBe(409);
    expect((await c.call('DELETE', '/api/auth/perfil/sesiones/no-valido')).status).toBe(400);
    expect((await c.call('DELETE', `/api/auth/perfil/sesiones/${s[1].id}`)).status).toBe(200);
    expect((await c.call('GET', '/api/auth/perfil')).body.sesiones.length).toBe(s.length - 1);
    const r = await c.call('POST', '/api/auth/perfil/sesiones/cerrar-otras');
    expect(r.status).toBe(200);
    expect((await c.call('GET', '/api/auth/perfil')).body.sesiones).toHaveLength(1);
    expect((await api(E.app, otra, 'elparche').get('/yo')).status).toBe(401);
    expect((await api(E.app, tercera, 'elparche').get('/yo')).status).toBe(401);
    expect((await c.call('GET', '/api/auth/sesion')).status).toBe(200);
  });

  it('cada quien define cómo lo ve su empresa y descarga una copia de sus datos', async () => {
    const cookie = await login(E.app, ...CRED.admin);
    const A = api(E.app, cookie, 'elparche');
    expect((await A.patch('/yo/perfil', { nombre_visible: 'x' })).status).toBe(400);
    expect((await A.patch('/yo/perfil', { nombre_visible: 'Andrea (dueña)', disponible: false })).status).toBe(200);
    expect((await A.get('/yo')).body.usuario).toMatchObject({ nombre_en_empresa: 'Andrea (dueña)', disponible: false });
    expect((await A.get('/configuracion')).body.personas.find((u: any) => u.email === CRED.admin[0]).nombre).toBe('Andrea (dueña)');
    expect((await A.patch('/yo/perfil', { nombre_visible: null, disponible: true })).status).toBe(200);
    expect((await A.get('/yo')).body.usuario).toMatchObject({ nombre_en_empresa: null, disponible: true });

    const x = await E.app.inject({ method: 'GET', url: '/api/auth/perfil/exportar', headers: { cookie } });
    expect(x.statusCode).toBe(200);
    expect(x.headers['content-disposition']).toMatch(/mis-datos\.json/);
    const datos = x.json();
    expect(datos.cuenta).toMatchObject({ email: CRED.admin[0] });
    expect(datos.empresas[0]).toMatchObject({ direccion: 'elparche' });
    expect(x.body).not.toMatch(/password|hash|scrypt|sid=/);
  });
});
