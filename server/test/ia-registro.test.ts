import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loginOperador, setup, verificarAlta, type Env } from './helpers.js';
import { classifyBusiness } from '../src/onboarding/classifier.js';
import { classifyHeuristic } from '../src/ai/llm/mock.js';
import { setLlm } from '../src/ai/llm/index.js';
import { ScriptedLlm } from '../src/ai/llm/scripted.js';
import { buildApp } from '../src/http/app.js';
import { config } from '../src/config.js';

/**
 * Alta asistida por IA (Claude en producción; aquí un modelo con guion, sin red): evidencia literal,
 * preguntas solo para lo pendiente, sin confirmar lo que no se dijo; actividad sin plantilla propia;
 * subdominios reales (dominio en index.html y cookie para todos los subdominios).
 */
let E: Env;
const DESCRIPCION = 'Tengo una veterinaria en Bucaramanga con dos médicos y una auxiliar. Nos escriben unos 40 mensajes al día por WhatsApp para pedir citas.';
const post = (url: string, payload: any = {}) => E.app.inject({ method: 'POST', url, payload });
const patch = (tk: string, payload: any) => E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${tk}`, payload });

beforeAll(async () => { E = await setup(); });
afterEach(() => setLlm(null));
afterAll(async () => { setLlm(null); await E.app.close(); await E.db.close(); });

describe('Clasificación con Claude', () => {
  const respuesta = (extra: Record<string, unknown> = {}) => ({
    sector: 'mascotas', tipo_negocio: 'Veterinaria', tamano: '2_5', volumen_conv_mes: 'medio', factura_electronica: true,
    modulos_sugeridos: ['clientes', 'catalogo', 'agenda', 'conversaciones'], confianza: 0.92, justificacion: 'Veterinaria con equipo pequeño.',
    evidencia: { tipo_negocio: 'veterinaria', tamano: 'dos médicos y una auxiliar', volumen_conv_mes: '40 mensajes al día', factura_electronica: 'necesito facturar ante la DIAN' },
    preguntas: { tamano: '¿Cuántas personas atienden?', factura_electronica: '¿Emites facturas a empresas que te las piden?' },
    ...extra,
  });

  it('acepta solo la evidencia literal: un dato sin frase del texto queda pendiente y con su pregunta', async () => {
    setLlm(new ScriptedLlm([], '', respuesta()));
    const c = await classifyBusiness(DESCRIPCION);
    expect(c.motor).toBe('ia');
    expect(c).toMatchObject({ sector: 'mascotas', tipo_negocio: 'Veterinaria', tamano: '2_5', volumen_conv_mes: 'medio' });
    // «necesito facturar ante la DIAN» no aparece en la descripción: no se acepta.
    expect(c.factura_electronica).toBeNull();
    expect(c.evidencia).toEqual({ tipo_negocio: 'veterinaria', tamano: 'dos médicos y una auxiliar', volumen_conv_mes: '40 mensajes al día' });
    // Solo sobrevive la pregunta del dato que quedó pendiente.
    expect(c.preguntas).toEqual({ factura_electronica: '¿Emites facturas a empresas que te las piden?' });
    expect(c.estados).toMatchObject({ factura_electronica: 'pendiente', tamano: 'sugerido' });
    expect(c.confirmados).toEqual([]);
  });

  it('no propone una actividad que el texto no respalda', async () => {
    setLlm(new ScriptedLlm([], '', respuesta({ evidencia: { sector: 'clínica de mascotas' } })));
    const c = await classifyBusiness('Atiendo clientes con cita y quiero organizarme mejor.');
    expect(c.sector).toBeNull();
    expect(c.tipo_negocio).toBeNull();
  });

  it('las reglas de respaldo suman el equipo y citan la frase, sin contar el negocio como persona', () => {
    const r = classifyHeuristic(DESCRIPCION);
    expect(r.tamano).toBe('2_5');
    expect(r.evidencia.tamano).toBe('dos médicos · una auxiliar');
    expect(r.evidencia.volumen_conv_mes).toBe('40 mensajes al día');
    expect(classifyHeuristic('Barbería en Ocaña, atiendo yo solo.').tamano).toBe('unipersonal');
    expect(classifyHeuristic('Tengo una tienda de ropa.').tamano).toBeNull();
  });
});

describe('Prioridad de lo que responde la persona', () => {
  it('confirmar las funciones sin tocar «Facturación» no responde la pregunta fiscal', async () => {
    const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una tienda de ropa en Cúcuta y vendo por Instagram.' })).json();
    expect(d.clasificacion.factura_electronica).toBeNull();
    let r = (await patch(d.token, { clasificacion: { modulos_sugeridos: d.clasificacion.modulos_sugeridos } })).json();
    expect(r.clasificacion.factura_electronica).toBeNull();
    expect(r.clasificacion.confirmados).not.toContain('factura_electronica');
    expect(r.clasificacion.estados.factura_electronica).toBe('pendiente');
    // Activar la función sí es una respuesta explícita.
    r = (await patch(d.token, { clasificacion: { modulos_sugeridos: [...d.clasificacion.modulos_sugeridos, 'facturacion'] } })).json();
    expect(r.clasificacion.factura_electronica).toBe(true);
    expect(r.clasificacion.confirmados).toContain('factura_electronica');
  });

  it('la evidencia deja de mostrarse en el dato que la persona cambió', async () => {
    const d = (await post('/api/onboarding/borradores', { descripcion: DESCRIPCION })).json();
    expect(d.clasificacion.evidencia.tamano).toBeTruthy();
    const r = (await patch(d.token, { clasificacion: { tamano: '6_15' } })).json();
    expect(r.clasificacion.evidencia.tamano).toBeUndefined();
    expect(r.clasificacion.estados.tamano).toBe('confirmado');
  });
});

describe('Actividades sin plantilla propia', () => {
  it('se aprovisionan con la plantilla general: la política de riesgo sigue resolviéndose y la actividad real queda registrada', async () => {
    const d = (await post('/api/onboarding/borradores', { descripcion: DESCRIPCION })).json();
    expect(d.clasificacion.sector).toBe('mascotas');
    expect((await patch(d.token, { negocio: { nombre: 'Veterinaria Huellitas', slug: 'huellitas', email: 'dueno@huellitas.test' } })).statusCode).toBe(200);
    await verificarAlta(E, d.token);
    const p = (await post(`/api/onboarding/borradores/${d.token}/pago`)).json();
    await post('/api/pasarela/simular', { ref: p.referencia, resultado: 'aprobado' });
    const t = await E.db.withPlatform(async (tx) => (await tx.query(
      `SELECT t.sector, t.registro_datos, st.contenido->'politica_riesgo' AS politica, (SELECT count(*)::int FROM role r WHERE r.tenant_id=t.id AND r.clave='barbero') AS barberos,
              (SELECT array_agg(nombre) FROM resource r WHERE r.tenant_id=t.id) AS recursos
       FROM tenant t LEFT JOIN sector_template st ON st.sector=t.sector AND st.version=t.sector_version WHERE t.slug='huellitas'`)).rows[0]);
    expect(t.sector).toBe('general');
    expect(t.politica).not.toBeNull();
    expect(t.registro_datos.actividad).toMatchObject({ sector: 'mascotas', tipo_negocio: 'Veterinaria' });
    expect(t.barberos).toBe(0);
    expect(t.recursos).toEqual(['Agenda principal']);
  });
});

describe('Subdominios reales', () => {
  const original = { cookieDominio: config.cookieDominio, baseDomain: config.baseDomain };
  afterEach(() => { config.cookieDominio = original.cookieDominio; config.baseDomain = original.baseDomain; });

  it('la cookie de sesión vale para todos los subdominios y se borra con el mismo dominio', async () => {
    config.cookieDominio = 'omnegia.test';
    const r = await post('/api/auth/login', { email: 'admin@elparche.test', password: 'demo-parche-2026' });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['set-cookie'])).toMatch(/Domain=omnegia\.test/i);
    const salir = await E.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `sid=${r.cookies[0].value}` } });
    expect(String(salir.headers['set-cookie'])).toMatch(/Domain=omnegia\.test/i);
  });

  it('cada host sirve solo lo suyo: empresa existente, subdominio inventado, operador solo en el principal', async () => {
    const { olvidarEmpresas } = await import('../src/http/dominios.js');
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>Omnegia</title></head><body><div id="root"></div></body></html>');
    const publicoOriginal = config.publicUrl;
    config.baseDomain = 'omnegia.test'; config.publicUrl = 'https://omnegia.test'; olvidarEmpresas();
    const app = await buildApp(E.db, { webDir: dir, logger: false });
    const pedir = (host: string, url: string) => app.inject({ method: 'GET', url, headers: { host } });
    try {
      // Empresa que existe: su panel sí; lo exclusivo del principal redirige allá.
      expect((await pedir('elparche.omnegia.test', '/clientes')).statusCode).toBe(200);
      const op = await pedir('elparche.omnegia.test', '/operador/empresas/123');
      expect(op.statusCode).toBe(302);
      expect(op.headers.location).toBe('https://omnegia.test/operador/empresas/123');
      expect((await pedir('elparche.omnegia.test', '/empezar')).headers.location).toBe('https://omnegia.test/empezar');
      expect((await pedir('elparche.omnegia.test', '/entrar')).statusCode).toBe(200);
      // Subdominio inventado: «esta dirección no existe», sin servir la aplicación.
      const inventado = await pedir('scs.omnegia.test', '/operador/empresas/01a13d79');
      expect(inventado.statusCode).toBe(404);
      expect(inventado.body).toContain('Esta dirección no existe');
      expect(inventado.body).not.toContain('id="root"');
      expect((await pedir('a.b.omnegia.test', '/')).statusCode).toBe(404);
      // La API del operador tampoco responde fuera del principal.
      const sesion = await loginOperador(E.app, E.db);
      const conSesion = (host: string) => app.inject({ method: 'GET', url: '/api/operador/yo', headers: { host, cookie: sesion } });
      expect((await conSesion('omnegia.test')).statusCode).toBe(200);
      expect((await conSesion('elparche.omnegia.test')).statusCode).toBe(404);
      expect((await conSesion('scs.omnegia.test')).statusCode).toBe(404);
      // www y hosts ajenos (la URL de onrender.com) redirigen al principal, conservando la ruta.
      expect((await pedir('www.omnegia.test', '/planes')).headers.location).toBe('https://omnegia.test/planes');
      expect((await pedir('omnegia-pruebas.onrender.com', '/empezar/listo?id=1')).headers.location).toBe('https://omnegia.test/empezar/listo?id=1');
      // El principal sirve todo.
      for (const ruta of ['/', '/operador', '/empezar']) expect((await pedir('omnegia.test', ruta)).statusCode).toBe(200);
      // Las comprobaciones de salud de Render siguen respondiendo en cualquier host.
      expect((await pedir('omnegia-pruebas.onrender.com', '/api/salud')).statusCode).toBe(200);
    } finally { config.publicUrl = publicoOriginal; olvidarEmpresas(); await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('el panel recibe el dominio base en index.html para detectar el subdominio de la empresa', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><title>Omnegia</title></head><body><div id="root"></div></body></html>');
    config.baseDomain = 'omnegia.brianacevedo.dev';
    const app = await buildApp(E.db, { webDir: dir, logger: false });
    try {
      for (const ruta of ['/', '/clientes', '/entrar']) {
        const r = await app.inject({ method: 'GET', url: ruta, headers: { host: 'huellitas.omnegia.brianacevedo.dev' } });
        expect(r.statusCode).toBe(200);
        expect(r.body).toContain('<meta name="omnegia-dominio" content="omnegia.brianacevedo.dev">');
      }
    } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
