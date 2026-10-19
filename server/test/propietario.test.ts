import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, correosA, type Env } from './helpers.js';
import { createTenantFromTemplate } from '../src/onboarding/provisioning.js';
import { deriveTheme } from '../src/onboarding/theme.js';
import { reiniciarEmpresas } from '../src/seed/reinicio.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Propietario (rango por encima del administrador), cuentas con varias empresas y reinicio de la
 * plataforma conservando las empresas de una cuenta.
 */
let E: Env;
beforeAll(async () => { E = await setup(); });
afterAll(async () => { await E.app.close(); await E.db.close(); });

const idDe = async (email: string) => (await E.db.withPlatform((tx) => tx.query(`SELECT id FROM users WHERE email=$1`, [email]))).rows[0].id as string;

describe('Una cuenta, varias empresas', () => {
  it('la sesión lista cada empresa con su rol y si la persona es la propietaria', async () => {
    const r = await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: CRED.gym[0], password: CRED.gym[1] } });
    const empresas = r.json().empresas.map((e: any) => [e.slug, e.propietario, e.rol]);
    expect(empresas).toEqual(expect.arrayContaining([['fuerzanorte', true, expect.any(String)], ['elparche', false, 'Supervisor']]));
  });

  it('la misma sesión trabaja en las dos empresas, con el rango de cada una', async () => {
    const c = await login(E.app, ...CRED.gym);
    const gym = await api(E.app, c, 'fuerzanorte').get('/yo');
    const barberia = await api(E.app, c, 'elparche').get('/yo');
    expect(gym.body.usuario).toMatchObject({ propietario: true, rol_nombre: 'Propietario' });
    expect(barberia.body.usuario).toMatchObject({ propietario: false, rol_nombre: 'Supervisor' });
    // En la barbería no administra el equipo; en su gimnasio, sí.
    expect((await api(E.app, c, 'elparche').get('/configuracion')).status).toBe(403);
    expect((await api(E.app, c, 'fuerzanorte').get('/configuracion')).status).toBe(200);
  });
});

describe('Propietario', () => {
  it('conserva todos los permisos aunque su rol cambie', async () => {
    const andrea = await idDe(CRED.admin[0]);
    const tenant = (await E.db.withPlatform((tx) => tx.query(`SELECT id, propietario_id FROM tenant WHERE slug='elparche'`))).rows[0];
    expect(tenant.propietario_id).toBe(andrea);
    const barbero = (await E.db.withPlatform((tx) => tx.query(`SELECT id FROM role WHERE tenant_id=$1 AND clave='barbero'`, [tenant.id]))).rows[0].id;
    const admin = (await E.db.withPlatform((tx) => tx.query(`SELECT role_id FROM user_tenant WHERE tenant_id=$1 AND user_id=$2`, [tenant.id, andrea]))).rows[0].role_id;
    await E.db.withPlatform((tx) => tx.query(`UPDATE user_tenant SET role_id=$3 WHERE tenant_id=$1 AND user_id=$2`, [tenant.id, andrea, barbero]));
    const c = await login(E.app, ...CRED.admin);
    const yo = await api(E.app, c, 'elparche').get('/yo');
    expect(yo.body.usuario.rol).toBe('barbero');
    expect(yo.body.permisos).toEqual(expect.arrayContaining(['user:manage', 'tenant:configure', 'subscription:manage', 'audit:read']));
    expect((await api(E.app, c, 'elparche').get('/configuracion')).status).toBe(200);
    await E.db.withPlatform((tx) => tx.query(`UPDATE user_tenant SET role_id=$3 WHERE tenant_id=$1 AND user_id=$2`, [tenant.id, andrea, admin]));
  });

  it('otro administrador no puede bajarle el rango, retirarle el acceso ni cambiarle el nombre', async () => {
    const dueña = await login(E.app, ...CRED.admin);
    const laura = await idDe(CRED.laura[0]);
    const andrea = await idDe(CRED.admin[0]);
    expect((await api(E.app, dueña, 'elparche').patch(`/configuracion/personas/${laura}`, { rol: 'administrador' })).status).toBe(200);

    const admin = await login(E.app, ...CRED.laura);
    const personas = (await api(E.app, admin, 'elparche').get('/configuracion')).body.personas;
    expect(personas[0]).toMatchObject({ id: andrea, propietario: true });
    for (const cambio of [{ rol: 'recepcion' }, { activo: false }, { nombre: 'Otra persona' }]) {
      const r = await api(E.app, admin, 'elparche').patch(`/configuracion/personas/${andrea}`, cambio);
      expect(r.status).toBe(403);
      expect(r.body.error.message).toMatch(/propietaria/);
    }
    // A cualquier otra persona sí la administra.
    expect((await api(E.app, admin, 'elparche').patch(`/configuracion/personas/${await idDe(CRED.andres[0])}`, { disponible: false })).status).toBe(200);
    const intento = (await E.db.withPlatform((tx) => tx.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE accion='usuario.editar' AND resultado='DENEGADO' AND actor_id=$1`, [laura]))).rows[0].n;
    expect(intento).toBeGreaterThan(0);
  });

  it('solo el propietario cede la propiedad, con su contraseña, a alguien activo y con correo confirmado', async () => {
    const laura = await idDe(CRED.laura[0]);
    const andres = await idDe(CRED.andres[0]);
    const admin = await login(E.app, ...CRED.laura);
    expect((await api(E.app, admin, 'elparche').post('/configuracion/propietario', { user_id: laura, contrasena: CRED.laura[1] })).status).toBe(403);

    const dueña = await login(E.app, ...CRED.admin);
    const mala = await api(E.app, dueña, 'elparche').post('/configuracion/propietario', { user_id: laura, contrasena: 'no-es-esta-1234' });
    expect(mala.status).toBe(400);
    expect(mala.body.error.message).toMatch(/contraseña/);

    await E.db.withPlatform((tx) => tx.query(`UPDATE users SET email_verificado_en=NULL WHERE id=$1`, [andres]));
    const sinCorreo = await api(E.app, dueña, 'elparche').post('/configuracion/propietario', { user_id: andres, contrasena: CRED.admin[1] });
    expect(sinCorreo.status).toBe(409);
    await E.db.withPlatform((tx) => tx.query(`UPDATE users SET email_verificado_en=now() WHERE id=$1`, [andres]));

    // Otra empresa: la persona no existe allí.
    const diego = await idDe(CRED.gym[0]);
    const gym = await login(E.app, ...CRED.gym);
    expect((await api(E.app, gym, 'fuerzanorte').post('/configuracion/propietario', { user_id: laura, contrasena: CRED.gym[1] })).status).toBe(404);
    expect(diego).toBeTruthy();

    const ok = await api(E.app, dueña, 'elparche').post('/configuracion/propietario', { user_id: laura, contrasena: CRED.admin[1] });
    expect(ok.status).toBe(200);
    expect((await correosA(E.db, CRED.laura[0])).some((c) => /Ahora eres el propietario/.test(c.asunto))).toBe(true);
    expect((await correosA(E.db, CRED.admin[0])).some((c) => /Cediste la propiedad/.test(c.asunto))).toBe(true);
  });

  it('el nuevo propietario sí puede cambiar el rol de quien le cedió la empresa', async () => {
    const andrea = await idDe(CRED.admin[0]);
    const nueva = await login(E.app, ...CRED.laura);
    expect((await api(E.app, nueva, 'elparche').get('/yo')).body.usuario).toMatchObject({ propietario: true, rol: 'administrador' });
    expect((await api(E.app, nueva, 'elparche').patch(`/configuracion/personas/${andrea}`, { rol: 'recepcion' })).status).toBe(200);
    const antes = await login(E.app, ...CRED.admin);
    expect((await api(E.app, antes, 'elparche').get('/configuracion')).status).toBe(403);
    // Se devuelve la empresa como estaba para las pruebas siguientes.
    expect((await api(E.app, nueva, 'elparche').patch(`/configuracion/personas/${andrea}`, { rol: 'administrador' })).status).toBe(200);
    expect((await api(E.app, nueva, 'elparche').post('/configuracion/propietario', { user_id: andrea, contrasena: CRED.laura[1] })).status).toBe(200);
  });
});

describe('Reinicio de la plataforma', () => {
  const crearEmpresaDePrueba = async () => {
    const r = await E.db.withPlatform((tx) => createTenantFromTemplate(tx, {
      nombre: 'Prueba Borrable', slug: 'pruebaborrable', ciudad: 'Cúcuta', email: 'dueno@borrable.test', telefono: '+573001119999',
      plan: 'negocio', sector: 'barberia', admin: { nombre: 'Dueño Prueba', email: 'dueno@borrable.test', password: 'clave-de-prueba-2026' },
      tema: deriveTheme(['#333333'], 'Prueba Borrable'),
    } as any));
    return r;
  };

  it('el simulacro cuenta lo que se borraría y no borra nada', async () => {
    await crearEmpresaDePrueba();
    const r = await reiniciarEmpresas(E.db, { conservar: [CRED.admin[0]], aplicar: false });
    expect(r.aplicado).toBe(false);
    expect(r.conservadas.map((t) => t.slug)).toEqual(['elparche']);
    expect(r.borradas.map((t) => t.slug).sort()).toEqual(['fuerzanorte', 'pruebaborrable']);
    expect(r.cuentasBorradas).toEqual(['dueno@borrable.test']);
    // Diego sigue: también trabaja en la barbería. Las cuentas del operador nunca se tocan.
    expect(r.cuentasConservadas).toEqual(expect.arrayContaining([CRED.gym[0], 'plataforma@saas.test', 'soporte@saas.test']));
    expect(r.filas.tenant).toBe(2);
    const siguen = (await E.db.withPlatform((tx) => tx.query(`SELECT count(*)::int AS n FROM tenant`))).rows[0].n;
    expect(siguen).toBe(3);
  });

  it('se niega si la cuenta a conservar no existe o si hay un número real vigente', async () => {
    await expect(reiniciarEmpresas(E.db, { conservar: ['nadie@x.test'], aplicar: false })).rejects.toThrow(/No existe la cuenta/);
    const t = (await E.db.withPlatform((tx) => tx.query(`SELECT id FROM tenant WHERE slug='pruebaborrable'`))).rows[0].id;
    await E.db.withPlatform((tx) => tx.query(
      `INSERT INTO numero_contratacion (id, tenant_id, estado, proveedor, entorno, pais, tipo_numero, numero_e164, cotizacion)
       VALUES ($1,$2,'CONECTADO','telnyx','real','CO','local','+5776000000','{}')`, [uuidv7(), t]));
    await expect(reiniciarEmpresas(E.db, { conservar: [CRED.admin[0]], aplicar: false })).rejects.toThrow(/números reales vigentes/);
    const r = await reiniciarEmpresas(E.db, { conservar: [CRED.admin[0]], aplicar: false, permitirNumerosReales: true });
    expect(r.filas.numero_contratacion).toBe(1);
  });

  it('aplicado: borra las demás empresas y sus cuentas; la conservada sigue funcionando', async () => {
    const r = await reiniciarEmpresas(E.db, { conservar: [CRED.admin[0]], aplicar: true, permitirNumerosReales: true });
    expect(r.aplicado).toBe(true);
    expect(r.respaldo.tenant).toHaveLength(2);
    expect(JSON.stringify(r.respaldo.users)).not.toMatch(/password_hash|scrypt/);
    const slugs = (await E.db.withPlatform((tx) => tx.query(`SELECT slug FROM tenant`))).rows.map((x) => x.slug);
    expect(slugs).toEqual(['elparche']);
    const c = await login(E.app, ...CRED.admin);
    expect((await api(E.app, c, 'elparche').get('/yo')).status).toBe(200);
    expect((await api(E.app, c, 'elparche').get('/ventas')).status).toBe(200);
    // Diego conserva la barbería; su gimnasio ya no existe.
    const diego = await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: CRED.gym[0], password: CRED.gym[1] } });
    expect(diego.json().empresas.map((e: any) => e.slug)).toEqual(['elparche']);
    expect((await E.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'dueno@borrable.test', password: 'clave-de-prueba-2026' } })).statusCode).toBe(401);
    const huerfanas = (await E.db.raw((tx) => tx.query(`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id NOT IN (SELECT id FROM tenant)`))).rows[0].n;
    expect(huerfanas).toBe(0);
    const reinicio = (await E.db.raw((tx) => tx.query(`SELECT count(*)::int AS n FROM audit_event WHERE accion='plataforma.reinicio' AND tenant_id IS NULL`))).rows[0].n;
    expect(reinicio).toBe(1);
  });
});
