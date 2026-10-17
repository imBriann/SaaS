import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, verificarAlta, login, api, type Env } from './helpers.js';
import { drain } from '../src/worker/jobs.js';
import { setLlm, SinModelo } from '../src/ai/llm/index.js';
import { ScriptedLlm } from '../src/ai/llm/scripted.js';
import { classifyBusiness } from '../src/onboarding/classifier.js';
import { personalizarEspacio } from '../src/onboarding/personalization.js';

let E: Env;
const password = 'Negocio-seguro-2026';
const post = (url: string, payload: any = {}, cookie?: string) => E.app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
const status = async (tk: string) => (await E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}/estado` })).json();
const personalizacion = { titulo: 'Las citas y clientes de tu veterinaria', descripcion: 'Organiza la atención de las mascotas, prepara tus servicios y encuentra a cada cliente en un solo lugar.', prioridades: [
  { modulo: 'agenda', titulo: 'Prepara las próximas consultas', descripcion: 'Organiza tus citas y ajusta los horarios de atención de la veterinaria.' },
  { modulo: 'clientes', titulo: 'Conoce a quienes te visitan', descripcion: 'Registra a tus clientes para encontrar sus datos cuando te escriban.' },
] };

beforeAll(async () => { E = await setup(); });
afterEach(() => setLlm(null));
afterAll(async () => { await E.app.close(); await E.db.close(); });

async function draft(slug: string, email = `dueno@${slug}.test`) {
  const d = (await post('/api/onboarding/borradores', { descripcion: 'Tengo una veterinaria con consultas por cita, atiendo yo solo y no necesito factura electrónica.', creacion_diferida: true })).json();
  const r = await E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${d.token}`, payload: {
    negocio: { nombre: `Veterinaria ${slug}`, email, slug },
    facturacion: { nombre: 'Persona de prueba', tipo_documento: 'CC', numero_documento: '1012345678', email, telefono: '+573001234567', direccion: 'Calle 10 # 5-20', ciudad: 'Ocaña' },
  } });
  expect(r.statusCode).toBe(200);
  await verificarAlta(E, d.token);
  return d.token as string;
}
async function pay(tk: string) {
  const checkout = await post(`/api/onboarding/borradores/${tk}/pago`);
  expect(checkout.statusCode).toBe(200);
  const p = checkout.json();
  expect((await post('/api/pasarela/simular', { ref: p.referencia, entregas: 3 })).statusCode).toBe(200);
  await drain(E.db);
  return p;
}

describe('Registro con creación explícita', () => {
  it('el comprobante se descarga tras pagar sin crear empresa; doble Crear crea un solo espacio personalizado', async () => {
    const tk = await draft('huellas-creacion');
    await pay(tk);
    const antes = await status(tk);
    expect(antes).toMatchObject({ estado: 'PAGO_INICIADO', creacion_diferida: true, requiere_contrasena: true, cuenta_existente: false, creacion: { estado: 'pendiente' }, pago: { estado: 'APROBADO' }, documentos: { disponible: true } });
    expect(antes.tenant).toBeNull();
    const link = (await post(`/api/onboarding/borradores/${tk}/documentos/enlace`)).json();
    expect((await post('/api/documentos/descarga', { token: link.token })).headers['content-type']).toBe('application/zip');
    const [a, b] = await Promise.all([post(`/api/onboarding/borradores/${tk}/crear`, { password }), post(`/api/onboarding/borradores/${tk}/crear`, { password })]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().creacion.estado).toBe('en_cola');
    const pending = await E.db.withPlatform(async tx => (await tx.query("SELECT count(*)::int n FROM job WHERE tipo='crear_espacio_ia' AND payload->>'draft_token'=$1", [tk])).rows[0]);
    expect(pending.n).toBe(1);
    setLlm(new ScriptedLlm([], '', personalizacion));
    await drain(E.db);
    const despues = await status(tk);
    expect(despues).toMatchObject({ estado: 'APROVISIONADO', requiere_contrasena: false, creacion: { estado: 'completado', motor: 'simulador' }, panel: { personalizacion: { ...personalizacion, motor: 'simulador' } } });
    const cookie = await login(E.app, 'dueno@huellas-creacion.test', password);
    const yo = await api(E.app, cookie, 'huellas-creacion').get('/yo');
    expect(yo.body.tenant.registro_datos.inicio_ia).toMatchObject(personalizacion);
    expect(yo.body.usuario.correo_verificado).toBe(true);
    const privado = await E.db.withPlatform(async tx => (await tx.query('SELECT password_hash_inicial FROM onboarding_draft WHERE token=$1', [tk])).rows[0]);
    expect(privado.password_hash_inicial).toBeNull();
    expect((await post(`/api/onboarding/borradores/${tk}/crear`, {}, cookie)).json().creacion.estado).toBe('completado');
    const n = await E.db.withPlatform(async tx => (await tx.query("SELECT count(*)::int n FROM tenant WHERE slug='huellas-creacion'")).rows[0].n);
    expect(n).toBe(1);
    expect(JSON.stringify(despues)).not.toContain(password);
  });

  it('no crea antes de pagar y no acepta una contraseña insuficiente', async () => {
    const tk = await draft('sin-pago-creacion');
    expect((await post(`/api/onboarding/borradores/${tk}/crear`, { password })).statusCode).toBe(409);
    await pay(tk);
    expect((await post(`/api/onboarding/borradores/${tk}/crear`, { password: 'corta' })).statusCode).toBe(400);
    expect((await status(tk)).creacion.estado).toBe('pendiente');
  });

  it('una cuenta existente exige su contraseña y nunca la cambia desde el borrador', async () => {
    const tk = await draft('cuenta-existente-creacion', 'admin@elparche.test');
    await pay(tk);
    expect((await status(tk)).cuenta_existente).toBe(true);
    expect((await post(`/api/onboarding/borradores/${tk}/crear`, { password })).statusCode).toBe(401);
    expect((await status(tk)).creacion.estado).toBe('pendiente');
    const inicio = await post(`/api/onboarding/borradores/${tk}/crear`, { password: 'demo-parche-2026' });
    expect(inicio.statusCode).toBe(200);
    expect(inicio.cookies.some(c => c.name === 'sid')).toBe(true);
    await drain(E.db);
    expect((await status(tk)).estado).toBe('APROVISIONADO');
    expect(await login(E.app, 'admin@elparche.test', 'demo-parche-2026')).toContain('sid=');
  });

  it('un fallo real de la IA queda visible y se puede reintentar sin cobrar otra vez', async () => {
    const tk = await draft('reintento-creacion');
    await pay(tk);
    await post(`/api/onboarding/borradores/${tk}/crear`, { password });
    setLlm(new SinModelo());
    await drain(E.db);
    const fallo = await status(tk);
    expect(fallo).toMatchObject({ estado: 'PAGO_INICIADO', creacion: { estado: 'error' }, pago: { estado: 'APROBADO' } });
    expect(fallo.creacion.error).toContain('IA no está conectada');
    expect(fallo.tenant).toBeNull();
    setLlm(new ScriptedLlm([], '', personalizacion));
    expect((await post(`/api/onboarding/borradores/${tk}/crear`, { password })).statusCode).toBe(200);
    await drain(E.db);
    expect((await status(tk)).estado).toBe('APROVISIONADO');
  });

  it('el estado distingue simulación, falta de modelo y respuesta de respaldo', async () => {
    const simulado = (await E.app.inject({ method: 'GET', url: '/api/onboarding/ia/estado' })).json();
    expect(simulado).toMatchObject({ disponible: false, motor: 'reglas', simulado: true, proveedor: 'simulador' });
    setLlm(new SinModelo());
    expect((await classifyBusiness('Tengo una veterinaria con consultas por cita.')).analisis).toMatchObject({ estado: 'respaldo', proveedor: 'sin_modelo', motivo: 'sin_configurar' });
  });

  it('descarta los módulos que la IA propone fuera del plan y rechaza la respuesta si no queda ninguno', async () => {
    setLlm(new ScriptedLlm([], '', personalizacion));
    const p = await personalizarEspacio({ descripcion: 'Veterinaria con citas', negocio: { nombre: 'Huellas' }, clasificacion: {} }, ['clientes']);
    expect(p.prioridades.map(x => x.modulo)).toEqual(['clientes']);
    setLlm(new ScriptedLlm([], '', personalizacion));
    await expect(personalizarEspacio({ descripcion: 'Veterinaria con citas', negocio: { nombre: 'Huellas' }, clasificacion: {} }, ['ventas'])).rejects.toThrow('configuración válida');
  });
});
