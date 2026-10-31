import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { AlmacenDisco, AlmacenSupabase, setAlmacen } from '../src/lib/almacen.js';
import { DescargaBloqueada } from '../src/lib/descargaSegura.js';
import { ErrorBuscador, Openverse, Wikimedia, setBuscadorImagenes, setHttpBuscador, type BuscadorImagenes, type CandidataImagen } from '../src/adapters/buscadorImagenes.js';
import { setCargadorSharp, setDescargador, verificarProcesadorImagenes } from '../src/modules/imagenes.js';
import { setLlm } from '../src/ai/llm/index.js';
import { ScriptedLlm } from '../src/ai/llm/scripted.js';
import { drain } from '../src/worker/jobs.js';
import { validarConfiguracion, config } from '../src/config.js';

/**
 * Búsqueda de imágenes como proceso: consulta en español + genérica en inglés, errores del proveedor visibles
 * (429), descargas bloqueadas con motivo, sharp ausente con mensaje claro, lote «Completar imágenes que faltan»,
 * adaptador de Supabase Storage con el cliente HTTP simulado y aislamiento entre empresas.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
let carpeta = '';
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));
const producto = async (nombre: string) => (await sql(`SELECT id FROM product WHERE tenant_id=$1 AND nombre=$2`, [E.A, nombre])).rows[0].id as string;

const cand = (q: string, i: number): CandidataImagen => ({
  url: `https://imagenes.ejemplo.test/${encodeURIComponent(q)}/${i}.jpg`, miniatura: `https://imagenes.ejemplo.test/m/${i}.jpg`, fuente: `https://fuente.ejemplo.test/${i}`,
  titulo: `${q} ${i}`, autor: 'Autora', licencia: 'CC BY 4.0', atribucion: `${q} ${i} por Autora`, proveedor: 'openverse', licenciaAbierta: true,
});
/** Buscador que solo responde a ciertas consultas: lo que imita a Openverse con marcas locales. */
const buscadorPor = (responde: (q: string) => number): BuscadorImagenes & { consultas: string[] } => {
  const consultas: string[] = [];
  return { nombre: 'openverse', consultas, buscar: async (q) => { consultas.push(q); return Array.from({ length: responde(q) }, (_, i) => cand(q, i + 1)); } };
};

let png: Buffer;
const consultaIA = (consulta: string, consulta_en?: string) => setLlm(new ScriptedLlm([], 'ok', { consulta, consulta_en }));

/** Inicia, deja que la cola corra y devuelve la búsqueda. */
async function buscar(productId: string, body: unknown = {}) {
  const ini = await A.post(`/catalogo/productos/${productId}/imagenes/buscar`, body);
  expect(ini.status).toBe(200);
  await drain(E.db);
  return (await A.get(`/catalogo/imagenes/busquedas/${ini.body.id}`)).body;
}
const agregar = async (id: string, indices: number[]) => {
  const r = await A.post(`/catalogo/imagenes/busquedas/${id}/agregar`, { indices });
  expect(r.status).toBe(200);
  await drain(E.db);
  return (await A.get(`/catalogo/imagenes/busquedas/${id}`)).body;
};

beforeAll(async () => {
  carpeta = mkdtempSync(join(tmpdir(), 'omnegia-busqueda-'));
  setAlmacen(new AlmacenDisco(carpeta));
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#a33' } }).png().toBuffer();
  setDescargador(async () => png);
  E = await setup();
  A = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  B = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
});
afterEach(() => { setDescargador(async () => png); setCargadorSharp(null); setBuscadorImagenes(null); setLlm(null); setHttpBuscador(null); });
afterAll(async () => {
  setAlmacen(null); setBuscadorImagenes(null); setDescargador(null); setCargadorSharp(null); setLlm(null);
  rmSync(carpeta, { recursive: true, force: true });
  await E.app.close(); await E.db.close();
});

describe('Consulta en español + genérica en inglés', () => {
  it('0 resultados en español y resultados en inglés: se ofrecen como genéricas y se agregan al confirmar', async () => {
    const b = buscadorPor((q) => (/dog food/i.test(q) ? 4 : 0));
    setBuscadorImagenes(b);
    consultaIA('Chunky adulto 4 kg', 'dog food bag');
    const cera = await producto('Cera para peinar');
    const ini = await A.post(`/catalogo/productos/${cera}/imagenes/buscar`);
    expect(ini.body).toMatchObject({ estado: 'EN_CURSO', terminada: false });
    expect(ini.body.pasos.map((p: any) => p.id)).toEqual(['entender', 'buscar', 'elegir', 'descargar']);
    await drain(E.db);
    const r = (await A.get(`/catalogo/imagenes/busquedas/${ini.body.id}`)).body;
    expect(b.consultas).toEqual(['Chunky adulto 4 kg', 'dog food bag']);
    expect(r.estado).toBe('ESPERA_ELECCION');
    expect(r.consulta).toBe('Chunky adulto 4 kg');
    expect(r.mensaje).toMatch(/No encontramos fotos libres de «Chunky adulto 4 kg»\. Probamos con «dog food bag» y encontramos 4 genéricas\. ¿Las agrego\?/);
    expect(r.candidatas).toHaveLength(4);
    expect(r.candidatas.every((c: any) => c.generica && c.licencia && c.autor && c.miniatura)).toBe(true);
    expect(r.pasos.find((p: any) => p.id === 'buscar')).toMatchObject({ estado: 'hecho' });
    expect(r.pasos.find((p: any) => p.id === 'buscar').detalle).toMatch(/Openverse: 0 resultados con «Chunky adulto 4 kg» · Openverse: 4 resultados con «dog food bag»/);
    expect(r.registro.intentos).toMatchObject([{ resultados: 0, http: 200 }, { resultados: 4, http: 200 }]);
    // Nada se agregó todavía.
    expect((await A.get(`/catalogo/productos/${cera}/imagenes`)).body.imagenes).toHaveLength(0);

    const fin = await agregar(ini.body.id, [0, 1]);
    expect(fin).toMatchObject({ estado: 'LISTO', resultado: { agregadas: 2, pendientes: 0 } });
    expect(fin.pasos.find((p: any) => p.id === 'descargar')).toMatchObject({ estado: 'hecho', detalle: '2 de 2' });
    expect((await A.get(`/catalogo/productos/${cera}/imagenes`)).body.imagenes).toHaveLength(2);
    // Ya no espera elección: no se puede confirmar dos veces.
    expect((await A.post(`/catalogo/imagenes/busquedas/${ini.body.id}/agregar`, { indices: [0] })).status).toBe(409);
  });

  it('una consulta escrita a mano se usa tal cual, sin pasar por la IA', async () => {
    const b = buscadorPor((q) => (q === 'peine de madera' ? 3 : 0));
    setBuscadorImagenes(b);
    const r = await buscar(await producto('Aceite para barba'), { consulta: 'peine de madera' });
    expect(b.consultas).toEqual(['peine de madera']);
    expect(r.estado).toBe('ESPERA_ELECCION');
    expect(r.candidatas.every((c: any) => !c.generica && c.elegida)).toBe(true);
  });

  it('sin resultados en ninguna consulta: SIN_RESULTADOS con las consultas probadas', async () => {
    setBuscadorImagenes(buscadorPor(() => 0));
    consultaIA('Marca rara 7 kg', 'rare thing');
    const r = await buscar(await producto('Cera para peinar'));
    expect(r.estado).toBe('SIN_RESULTADOS');
    expect(r.terminada).toBe(true);
    expect(r.mensaje).toMatch(/Marca rara 7 kg.*rare thing.*subir tu propia foto/);
    expect(r.registro.intentos).toHaveLength(2);
  });
});

describe('Errores visibles, no silenciosos', () => {
  it('si un proveedor falla pero otro responde sin resultados, es «sin resultados» (y se dice cuál falló)', async () => {
    let n = 0;
    setBuscadorImagenes({ nombre: 'openverse', buscar: async () => { n++; if (n === 1) throw new ErrorBuscador('openverse', null, 'sin respuesta'); return []; } });
    consultaIA('Marca rara 9 kg', 'rare thing');
    const r = await buscar(await producto('Cera para peinar'));
    expect(r.registro.intentos).toHaveLength(2);
    expect(r.estado).toBe('SIN_RESULTADOS');
    expect(r.mensaje).toMatch(/No encontramos fotos libres.*Openverse no respondió a tiempo/);
  });

  it('proveedor que responde 429: mensaje claro y el código HTTP queda en el registro', async () => {
    setBuscadorImagenes({ nombre: 'openverse', buscar: async () => { throw new ErrorBuscador('openverse', 429, 'openverse respondió 429'); } });
    const r = await buscar(await producto('Cera para peinar'));
    expect(r.estado).toBe('ERROR');
    expect(r.mensaje).toMatch(/demasiadas consultas/);
    expect(r.registro.intentos[0]).toMatchObject({ http: 429, resultados: 0 });
    expect(r.pasos.find((p: any) => p.id === 'buscar').estado).toBe('fallo');
  });

  it('el adaptador de Openverse conserva el código (429, 401) y reintenta solo ante 5xx', async () => {
    let llamadas = 0;
    setHttpBuscador(async () => { llamadas++; return new Response('{}', { status: 429 }); });
    await expect(new Openverse().buscar('x')).rejects.toMatchObject({ status: 429, proveedor: 'openverse' });
    expect(llamadas).toBe(1);
    llamadas = 0;
    setHttpBuscador(async () => { llamadas++; return new Response('{}', { status: llamadas === 1 ? 503 : 200 }); });
    await expect(new Openverse().buscar('x')).resolves.toEqual([]);
    expect(llamadas).toBe(2);
    setHttpBuscador(async () => new Response('{}', { status: 401 }));
    await expect(new Openverse().buscar('x')).rejects.toMatchObject({ status: 401, paraPersona: expect.stringMatching(/rechazó nuestra llave/) });
  });

  it('Wikimedia Commons: solo imágenes JPG/PNG/WebP, con autor y licencia, y respuesta que no es JSON cuenta como falla', async () => {
    const pagina = (index: number, title: string, mime: string) => ({ index, title, imageinfo: [{ mime, thumburl: `https://upload.wikimedia.org/t/${index}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/${index}`, extmetadata: { Artist: { value: '<a href="x">Tiia Monto</a>' }, LicenseShortName: { value: 'CC BY-SA 3.0' } } }] });
    setHttpBuscador(async () => new Response(JSON.stringify({ query: { pages: [pagina(2, 'File:Lunch Bag.jpg', 'image/jpeg'), pagina(1, 'File:Libro.pdf', 'application/pdf'), pagina(3, 'File:Bolsa.png', 'image/png')] } })));
    const r = await new Wikimedia().buscar('lunch bag');
    expect(r.map((c: any) => c.titulo)).toEqual(['Lunch Bag', 'Bolsa']);
    expect(r[0]).toMatchObject({ autor: 'Tiia Monto', licencia: 'CC BY-SA 3.0', proveedor: 'wikimedia', licenciaAbierta: true });
    expect(r[0].atribucion).toMatch(/Lunch Bag\.jpg por Tiia Monto \(CC BY-SA 3\.0\) vía Wikimedia Commons/);
    setHttpBuscador(async () => new Response('<html>504 Gateway Time-out</html>'));
    await expect(new Wikimedia().buscar('x')).rejects.toMatchObject({ status: 502 });
  });

  it('descarga bloqueada: el motivo queda registrado y la búsqueda no falla en silencio', async () => {
    setBuscadorImagenes(buscadorPor(() => 3));
    setDescargador(async () => { throw new DescargaBloqueada('Dirección no permitida (cdn.ejemplo.test)'); });
    const esp = await buscar(await producto('Aceite para barba'));
    const r = await agregar(esp.id, esp.candidatas.map((c: any) => c.indice));
    expect(r.estado).toBe('SIN_RESULTADOS');
    expect(r.mensaje).toMatch(/No pudimos descargar ninguna.*Dirección no permitida/);
    expect(r.registro.descartadas).toHaveLength(3);
    expect(r.registro.descartadas[0].motivo).toMatch(/Dirección no permitida/);
    expect(r.pasos.find((p: any) => p.id === 'descargar').estado).toBe('fallo');
  });

  it('sharp no disponible: error visible y comprobación de arranque que lo detecta', async () => {
    setCargadorSharp(async () => { throw new Error("Could not load the \"sharp\" module using the linux-x64 runtime"); });
    expect((await verificarProcesadorImagenes()).ok).toBe(false);
    setBuscadorImagenes(buscadorPor(() => 2));
    const esp = await buscar(await producto('Corte clásico'));
    const r = await agregar(esp.id, [0]);
    expect(r.estado).toBe('ERROR');
    expect(r.mensaje).toMatch(/El servidor no puede procesar imágenes/);
    setCargadorSharp(null);
    expect((await verificarProcesadorImagenes())).toEqual({ ok: true });
  });
});

describe('Completar imágenes que faltan (lote)', () => {
  it('corre el mismo proceso por producto, con avance general y resultado por producto', async () => {
    setBuscadorImagenes(buscadorPor(() => 2));
    const ini = await A.post('/catalogo/imagenes/completar');
    expect(ini.status).toBe(200);
    expect(ini.body.total).toBeGreaterThan(0);
    expect(ini.body).toMatchObject({ terminado: false, terminadas: 0 });
    await drain(E.db);
    const lote = (await A.get(`/catalogo/imagenes/lotes/${ini.body.lote_id}`)).body;
    expect(lote.terminado).toBe(true);
    expect(lote.busquedas.every((b: any) => b.estado === 'LISTO')).toBe(true);
    expect(lote.agregadas).toBe(lote.total * 2);
    expect(lote.busquedas[0]).toHaveProperty('producto');
    expect((await B.get(`/catalogo/imagenes/lotes/${ini.body.lote_id}`)).status).toBe(404);
  });

  it('en automático lo genérico no se agrega solo: la búsqueda queda esperando a la persona', async () => {
    await E.db.withTenant(E.A, (tx) => tx.query(`DELETE FROM producto_imagen`));
    setBuscadorImagenes(buscadorPor((q) => (/hair wax/.test(q) ? 3 : 0)));
    consultaIA('Cera Marca Local 100 g', 'hair wax');
    const ini = await A.post('/catalogo/imagenes/completar');
    await drain(E.db);
    const lote = (await A.get(`/catalogo/imagenes/lotes/${ini.body.lote_id}`)).body;
    expect(lote.busquedas.length).toBeGreaterThan(0);
    expect(lote.busquedas.every((b: any) => b.estado === 'ESPERA_ELECCION')).toBe(true);
    expect(lote.agregadas).toBe(0);
  });
});

describe('Aislamiento y permisos', () => {
  it('otra empresa no ve ni confirma la búsqueda', async () => {
    setBuscadorImagenes(buscadorPor(() => 2));
    const r = await buscar(await producto('Corte clásico'));
    expect((await B.get(`/catalogo/imagenes/busquedas/${r.id}`)).status).toBe(404);
    expect((await B.post(`/catalogo/imagenes/busquedas/${r.id}/agregar`, { indices: [0] })).status).toBe(404);
    expect((await B.post(`/catalogo/productos/${await producto('Corte clásico')}/imagenes/buscar`)).status).toBe(404);
  });
});

describe('Supabase Storage', () => {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const falso = (estado = 200, cuerpo: Uint8Array | string = 'ok') => async (url: any, init: any) => { llamadas.push({ url: String(url), init }); return new Response(cuerpo as any, { status: estado }); };

  it('guarda, lee y borra por la API con la llave de servicio, y la URL pública es https', async () => {
    llamadas.length = 0;
    const a = new AlmacenSupabase('https://abc.supabase.co', 'LLAVE-SECRETA', 'imagenes', falso(200, new Uint8Array([1, 2, 3])));
    const ruta = 't/aaaaaaaa-0000-0000-0000-000000000000/p/i.webp';
    await a.guardar(ruta, Buffer.from('datos'));
    expect(llamadas[0].url).toBe(`https://abc.supabase.co/storage/v1/object/imagenes/${ruta}`);
    expect(llamadas[0].init.method).toBe('POST');
    expect((llamadas[0].init.headers as any).authorization).toBe('Bearer LLAVE-SECRETA');
    expect((llamadas[0].init.headers as any)['x-upsert']).toBe('true');
    expect((await a.leer(ruta))!.equals(Buffer.from([1, 2, 3]))).toBe(true);
    await a.borrar(ruta);
    expect(llamadas[2].init.method).toBe('DELETE');
    expect(a.urlPublica(ruta)).toBe(`https://abc.supabase.co/storage/v1/object/public/imagenes/${ruta}`);
    expect(a.urlPublica(ruta).startsWith('https://')).toBe(true);
  });

  it('un archivo que no existe devuelve null; un rechazo da un error útil que NO incluye la llave', async () => {
    expect(await new AlmacenSupabase('https://abc.supabase.co', 'LLAVE-SECRETA', 'imagenes', falso(404, '{}')).leer('t/a/b/c.webp')).toBeNull();
    const mala = new AlmacenSupabase('https://abc.supabase.co', 'LLAVE-SECRETA', 'imagenes', falso(403, '{"error":"x"}'));
    const e = await mala.guardar('t/a/b/c.webp', Buffer.from('x')).then(() => new Error('no falló'), (x) => x as Error);
    expect(e.message).toMatch(/rechazó la carga \(403\).*bucket «imagenes»/);
    expect(e.message).not.toContain('LLAVE-SECRETA');
    const red = new AlmacenSupabase('https://abc.supabase.co', 'LLAVE-SECRETA', 'imagenes', async () => { throw new Error('ECONNRESET LLAVE-SECRETA'); });
    const e2 = await red.guardar('t/a/b/c.webp', Buffer.from('x')).then(() => new Error('no falló'), (x) => x as Error);
    expect(e2.message).toMatch(/no respondió/);
    expect(e2.message).not.toContain('LLAVE-SECRETA');
  });

  it('rutas inseguras se rechazan antes de llamar a la red', async () => {
    llamadas.length = 0;
    const a = new AlmacenSupabase('https://abc.supabase.co', 'K', 'imagenes', falso());
    await expect(a.guardar('../secreto.webp', Buffer.from('x'))).rejects.toThrow(/no válida/);
    await expect(a.leer('T/Mayus.webp')).rejects.toThrow(/no válida/);
    expect(llamadas).toHaveLength(0);
  });

  it('la configuración exige URL y llave cuando el proveedor es supabase', () => {
    const c = { ...config, imagenes: { ...config.imagenes, almacen: 'supabase' as const, supabaseUrl: '', supabaseServiceKey: undefined } };
    const v = validarConfiguracion(c);
    expect(v.errores.join(' ')).toMatch(/SUPABASE_URL/);
    expect(v.errores.join(' ')).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    const ok = validarConfiguracion({ ...c, imagenes: { ...c.imagenes, supabaseUrl: 'https://abc.supabase.co', supabaseServiceKey: 'k', supabaseBucket: 'imagenes' } });
    expect(ok.errores.join(' ')).not.toMatch(/SUPABASE/);
  });
});
