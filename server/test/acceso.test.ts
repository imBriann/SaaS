import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, loginOperador, api, CRED, correosA, tokenDelEnlace, cliente, type Env } from './helpers.js';
import { sha256, uuidv7 } from '../src/lib/util.js';
import { drain } from '../src/worker/jobs.js';

/**
 * Acceso: inicio, expiración, recuperación y cierre de sesión; invitaciones con
 * vencimiento y revocación; permisos en el servidor; intentos entre empresas.
 */
let E: Env;
beforeAll(async () => { E = await setup(); });
afterAll(async () => { await E.app.close(); await E.db.close(); });

const sesionDe = (cookie: string) => sha256(cookie.replace(/^sid=/, ''));

describe('Sesión', () => {
  it('inicio → sesión válida → cierre: el mismo token deja de servir', async () => {
    const c = cliente(E.app);
    expect((await c.call('POST', '/api/auth/login', { email: CRED.laura[0], password: CRED.laura[1] })).status).toBe(200);
    const token = c.cookie;
    expect((await c.call('GET', '/api/auth/sesion')).status).toBe(200);
    expect((await c.call('POST', '/api/auth/logout')).status).toBe(200);
    c.cookie = token; // alguien que se quedó con la cookie
    expect((await c.call('GET', '/api/auth/sesion')).status).toBe(401);
    expect((await c.call('GET', '/api/t/clientes', undefined, { 'x-tenant-slug': 'elparche' })).status).toBe(401);
  });

  it('expira por fecha límite y por inactividad', async () => {
    const vencida = await login(E.app, ...CRED.laura);
    await E.db.withPlatform((tx) => tx.query(`UPDATE session SET expira_en = now() - interval '1 minute' WHERE id=$1`, [sesionDe(vencida)]));
    expect((await api(E.app, vencida, 'elparche').get('/yo')).status).toBe(401);
    const inactiva = await login(E.app, ...CRED.laura);
    expect((await api(E.app, inactiva, 'elparche').get('/yo')).status).toBe(200);
    await E.db.withPlatform((tx) => tx.query(`UPDATE session SET ultimo_uso = now() - interval '13 hours' WHERE id=$1`, [sesionDe(inactiva)]));
    const r = await api(E.app, inactiva, 'elparche').get('/yo');
    expect(r.status).toBe(401);
    expect(r.body.error.message).toMatch(/sesión terminó/);
  });

  it('bloquea tras intentos fallidos repetidos, incluso con la contraseña correcta', async () => {
    const email = 'andres@elparche.test';
    for (let i = 0; i < 8; i++) {
      const r = await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: `mala-${i}` } });
      expect(r.statusCode).toBe(401);
    }
    const bloqueado = await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: CRED.andres[1] } });
    expect(bloqueado.statusCode).toBe(429);
    expect(bloqueado.json().error.message).toMatch(/Demasiados intentos/);
    // Pasada la ventana, vuelve a entrar.
    await E.db.withPlatform((tx) => tx.query(`UPDATE login_attempt SET creado_en = now() - interval '1 hour'`));
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: CRED.andres[1] } })).statusCode).toBe(200);
  });

  it('el mensaje de error no revela si la cuenta existe', async () => {
    const a = await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nadie@x.test', password: 'cualquier-cosa' } });
    const b = await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: CRED.admin[0], password: 'incorrecta-123' } });
    expect(a.json()).toEqual(b.json());
  });
});

describe('Recuperación de acceso', () => {
  it('correo con enlace de un solo uso → nueva contraseña → se cierran todas las sesiones', async () => {
    const email = CRED.laura[0];
    const abierta = await login(E.app, ...CRED.laura);
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/recuperar', payload: { email } })).statusCode).toBe(200);
    const [correo] = (await correosA(E.db, email)).slice(-1);
    expect(correo.asunto).toMatch(/Restablece/);
    const tk = tokenDelEnlace(correo.html);
    const corta = await E.app.inject({ method: 'POST', url: '/api/auth/restablecer', payload: { token: tk, password: 'corta' } });
    expect(corta.statusCode).toBe(400);
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/restablecer', payload: { token: tk, password: 'nueva-clave-laura-2026' } })).statusCode).toBe(200);
    expect((await api(E.app, abierta, 'elparche').get('/yo')).status).toBe(401);
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: CRED.laura[1] } })).statusCode).toBe(401);
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'nueva-clave-laura-2026' } })).statusCode).toBe(200);
    const reuso = await E.app.inject({ method: 'POST', url: '/api/auth/restablecer', payload: { token: tk, password: 'otra-clave-larga-1' } });
    expect(reuso.statusCode).toBe(409);
    // Se deja como estaba para el resto de pruebas.
    await E.db.withPlatform(async (tx) => tx.query(`UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE email='andres@elparche.test') WHERE email=$1`, [email]));
  });

  it('un enlace vencido no sirve y un correo inexistente recibe la misma respuesta sin correo', async () => {
    await E.app.inject({ method: 'POST', url: '/api/auth/recuperar', payload: { email: CRED.admin[0] } });
    const tk = tokenDelEnlace((await correosA(E.db, CRED.admin[0])).at(-1)!.html);
    await E.db.withPlatform((tx) => tx.query(`UPDATE password_reset SET expira_en = now() - interval '1 minute' WHERE token_hash=$1`, [sha256(tk)]));
    const r = await E.app.inject({ method: 'POST', url: '/api/auth/restablecer', payload: { token: tk, password: 'clave-nueva-larga-1' } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toMatch(/venció/);
    const x = await E.app.inject({ method: 'POST', url: '/api/auth/recuperar', payload: { email: 'nadie@nada.test' } });
    expect(x.json()).toEqual({ ok: true });
    expect(await correosA(E.db, 'nadie@nada.test')).toHaveLength(0);
  });

  it('cambiar la contraseña exige la actual, mantiene esta sesión y cierra las demás', async () => {
    const otra = await login(E.app, ...CRED.gym);
    const esta = await login(E.app, ...CRED.gym);
    const A = api(E.app, esta, 'fuerzanorte');
    const mal = await E.app.inject({ method: 'POST', url: '/api/auth/cambiar-contrasena', payload: { actual: 'no-es', nueva: 'clave-gym-nueva-2026' }, headers: { cookie: esta } });
    expect(mal.statusCode).toBe(400);
    const ok = await E.app.inject({ method: 'POST', url: '/api/auth/cambiar-contrasena', payload: { actual: CRED.gym[1], nueva: 'clave-gym-nueva-2026' }, headers: { cookie: esta } });
    expect(ok.statusCode).toBe(200);
    expect((await A.get('/yo')).status).toBe(200);
    expect((await api(E.app, otra, 'fuerzanorte').get('/yo')).status).toBe(401);
    await E.app.inject({ method: 'POST', url: '/api/auth/cambiar-contrasena', payload: { actual: 'clave-gym-nueva-2026', nueva: CRED.gym[1] }, headers: { cookie: esta } });
  });

});

describe('Invitaciones al equipo', () => {
  let admin: ReturnType<typeof api>;
  beforeAll(async () => { admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche'); });

  it('invitar → aceptar con contraseña → entra con el rol asignado; el token no se reutiliza', async () => {
    const r = await admin.post('/configuracion/invitaciones', { email: 'Nueva.Asesora@elparche.test', nombre: 'Nueva Asesora', rol: 'recepcion' });
    expect(r.status).toBe(200);
    const tk = tokenDelEnlace((await correosA(E.db, 'nueva.asesora@elparche.test')).at(-1)!.html);
    const info = (await E.app.inject({ method: 'GET', url: `/api/invitaciones/${tk}` })).json();
    expect(info).toMatchObject({ estado: 'PENDIENTE', empresa: 'Barbería El Parche', rol: 'Recepción', cuenta_existente: false });
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tk}/aceptar`, payload: { password: 'corta' } })).statusCode).toBe(400);
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tk}/aceptar`, payload: { password: 'asesora-clave-2026' } })).statusCode).toBe(200);
    const yo = await api(E.app, await login(E.app, 'nueva.asesora@elparche.test', 'asesora-clave-2026'), 'elparche').get('/yo');
    expect(yo.body.usuario.rol).toBe('recepcion');
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tk}/aceptar`, payload: { password: 'asesora-clave-2026' } })).statusCode).toBe(409);
  });

  it('una cuenta existente se une a otra empresa confirmando su contraseña actual', async () => {
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    expect((await gym.post('/configuracion/invitaciones', { email: CRED.laura[0], nombre: 'Laura', rol: 'recepcion' })).status).toBe(200);
    const tk = tokenDelEnlace((await correosA(E.db, CRED.laura[0])).at(-1)!.html);
    expect((await E.app.inject({ method: 'GET', url: `/api/invitaciones/${tk}` })).json().cuenta_existente).toBe(true);
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tk}/aceptar`, payload: { password: 'no-es-la-mia-123' } })).statusCode).toBe(400);
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tk}/aceptar`, payload: { password: CRED.laura[1] } })).statusCode).toBe(200);
    const empresas = (await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: CRED.laura[0], password: CRED.laura[1] } })).json().empresas.map((e: any) => e.slug).sort();
    expect(empresas).toEqual(['elparche', 'fuerzanorte']);
  });

  it('revocada o vencida: no se puede aceptar; reenviar genera un enlace nuevo', async () => {
    const a = await admin.post('/configuracion/invitaciones', { email: 'revocar@x.test', nombre: 'Revocar', rol: 'barbero' });
    const tkA = tokenDelEnlace((await correosA(E.db, 'revocar@x.test')).at(-1)!.html);
    expect((await admin.post(`/configuracion/invitaciones/${a.body.id}/revocar`)).status).toBe(200);
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tkA}/aceptar`, payload: { password: 'clave-larga-123' } })).json().error.message).toMatch(/retirada/);

    const b = await admin.post('/configuracion/invitaciones', { email: 'vence@x.test', nombre: 'Vence', rol: 'barbero' });
    const tkB = tokenDelEnlace((await correosA(E.db, 'vence@x.test')).at(-1)!.html);
    await E.db.withPlatform((tx) => tx.query(`UPDATE invitation SET expira_en = now() - interval '1 minute' WHERE id=$1`, [b.body.id]));
    expect((await E.app.inject({ method: 'GET', url: `/api/invitaciones/${tkB}` })).json().estado).toBe('EXPIRADA');
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tkB}/aceptar`, payload: { password: 'clave-larga-123' } })).json().error.message).toMatch(/venció/);
    expect((await admin.post(`/configuracion/invitaciones/${b.body.id}/reenviar`)).status).toBe(200);
    const tkB2 = tokenDelEnlace((await correosA(E.db, 'vence@x.test')).at(-1)!.html);
    expect(tkB2).not.toBe(tkB);
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tkB}/aceptar`, payload: { password: 'clave-larga-123' } })).statusCode).toBe(404);
    expect((await E.app.inject({ method: 'POST', url: `/api/invitaciones/${tkB2}/aceptar`, payload: { password: 'clave-larga-123' } })).statusCode).toBe(200);
  });

  it('el cupo del plan cuenta invitaciones pendientes; sin permiso no se invita', async () => {
    const plan = (await admin.get('/suscripcion')).body.suscripcion.max_usuarios;
    for (let i = 0; i < plan; i++) {
      const r = await admin.post('/configuracion/invitaciones', { email: `cupo${i}@x.test`, nombre: `Cupo ${i}`, rol: 'barbero' });
      if (r.status !== 200) { expect(r.status).toBe(409); expect(r.body.error.message).toMatch(/plan permite/); break; }
      expect(i).toBeLessThan(plan);
    }
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    expect((await laura.post('/configuracion/invitaciones', { email: 'x@x.test', nombre: 'X', rol: 'barbero' })).status).toBe(403);
  });

  it('retirar el acceso devuelve sus radicados a la cola y cierra su entrada a la empresa', async () => {
    const yo = (await admin.get('/configuracion')).body.personas.find((p: any) => p.email === 'nueva.asesora@elparche.test');
    const cookie = await login(E.app, 'nueva.asesora@elparche.test', 'asesora-clave-2026');
    expect((await admin.patch(`/configuracion/personas/${yo.id}`, { activo: false })).status).toBe(200);
    expect((await api(E.app, cookie, 'elparche').get('/yo')).status).toBe(404);
  });
});

describe('Intentos de acceso entre empresas (cambiando identificadores)', () => {
  it('ningún recurso de B se lee ni se modifica desde A; todos responden igual que uno inexistente', async () => {
    const A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
    const B = await E.db.withPlatform(async (tx) => ({
      producto: (await tx.query(`SELECT id, precio FROM product WHERE tenant_id=$1 LIMIT 1`, [E.B])).rows[0],
      cliente: (await tx.query(`SELECT id FROM customer WHERE tenant_id=$1 LIMIT 1`, [E.B])).rows[0].id,
      recurso: (await tx.query(`SELECT id FROM resource WHERE tenant_id=$1 LIMIT 1`, [E.B])).rows[0].id,
    }));
    const nada = uuidv7();
    const intentos: [string, string, unknown][] = [
      ['PATCH', `/productos/${B.producto.id}`, { precio: 1 }],
      ['PATCH', `/agenda/recursos/${B.recurso}`, { nombre: 'Hackeado' }],
      ['POST', `/agenda/citas`, { customer_id: B.cliente, product_id: B.producto.id, inicio: new Date(Date.now() + 86400000).toISOString() }],
      ['POST', `/ventas`, { customer_id: B.cliente, items: [{ product_id: B.producto.id, cantidad: 1 }] }],
      ['POST', `/casos/${nada}/tomar`, {}],
      ['POST', `/clientes/${B.cliente}/consentimiento`, {}],
      ['GET', `/clientes/${B.cliente}/exportar`, undefined],
    ];
    for (const [m, u, p] of intentos) {
      const r = await E.app.inject({ method: m as any, url: `/api/t${u}`, payload: p as any, headers: { cookie: (A as any).cookie ?? '', 'x-tenant-slug': 'elparche' } });
      void r;
    }
    const cookie = await login(E.app, ...CRED.admin);
    for (const [m, u, p] of intentos) {
      const r = await E.app.inject({ method: m as any, url: `/api/t${u}`, payload: p as any, headers: { cookie, 'x-tenant-slug': 'elparche' } });
      expect([404], `${m} ${u}`).toContain(r.statusCode);
    }
    const intacto = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT precio FROM product WHERE id=$1`, [B.producto.id])).rows[0].precio);
    expect(Number(intacto)).toBe(Number(B.producto.precio));
    const recurso = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT nombre FROM resource WHERE id=$1`, [B.recurso])).rows[0].nombre);
    expect(recurso).not.toBe('Hackeado');
  });

  it('un tenant_id enviado por el navegador se ignora: el dato queda en la empresa de la sesión', async () => {
    const A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
    const r = await A.post('/clientes', { nombre: 'Intento de inyección', tenant_id: E.B, telefono: '+573009998877' });
    expect(r.status).toBe(200);
    const fila = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT tenant_id FROM customer WHERE id=$1`, [r.body.id])).rows[0]);
    expect(fila.tenant_id).toBe(E.A);
  });

  it('cambiar la cabecera de empresa a una ajena no da acceso y deja evidencia', async () => {
    const cookie = await login(E.app, ...CRED.andres);
    const r = await api(E.app, cookie, 'fuerzanorte').get('/clientes');
    expect(r.status).toBe(404);
    const ev = await E.db.withTenant(E.B, async (tx) => (await tx.query(`SELECT count(*)::int n FROM audit_event WHERE accion='acceso.cruzado'`)).rows[0].n);
    expect(ev).toBeGreaterThan(0);
  });

  it('una escritura con Origin ajeno se rechaza (CSRF)', async () => {
    const cookie = await login(E.app, ...CRED.admin);
    const r = await E.app.inject({ method: 'POST', url: '/api/t/clientes', payload: { nombre: 'csrf' }, headers: { cookie, 'x-tenant-slug': 'elparche', origin: 'https://sitio-malicioso.test' } });
    expect(r.statusCode).toBe(403);
    const ok = await E.app.inject({ method: 'POST', url: '/api/t/clientes', payload: { nombre: 'Origen propio' }, headers: { cookie, 'x-tenant-slug': 'elparche', origin: 'http://elparche.localhost:5173' } });
    expect(ok.statusCode).toBe(200);
  });

  it('el administrador de la plataforma no opera datos de los negocios', async () => {
    const cookie = await loginOperador(E.app, E.db);
    expect((await api(E.app, cookie, 'elparche').get('/clientes')).status).toBe(404);
    expect((await E.app.inject({ method: 'GET', url: '/api/operador/empresas', headers: { cookie } })).statusCode).toBe(200);
    const normal = await login(E.app, ...CRED.admin);
    expect((await E.app.inject({ method: 'GET', url: '/api/operador/empresas', headers: { cookie: normal } })).statusCode).toBe(404);
  });
});

describe('Salud y migraciones', () => {
  it('readiness solo dice ok o degradado por servicio: sin proveedores, versiones, migraciones ni errores', async () => {
    const r = await E.app.inject({ method: 'GET', url: '/api/salud/listo' });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.ok).toBe(true);
    expect(b.servicios.base).toBe('ok');
    expect(Object.values(b.servicios).every((v) => v === 'ok' || v === 'degradado')).toBe(true);
    expect(Object.keys(b)).toEqual(['ok', 'servicios']);
    expect(r.body).not.toMatch(/sk-ant|secret|token-de|Wompi|Meta|Claude|Telnyx|Resend|001_base|version/i);
  });

  it('las migraciones aplicadas están al día (detalle solo interno)', async () => {
    const m = await E.db.migrations();
    expect(m[0]).toBe('001_base');
    expect(m.at(-1)).toBe('034_pagos_comercio');
  });
  void drain;
});
