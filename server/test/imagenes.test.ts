import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { AlmacenDisco, setAlmacen } from '../src/lib/almacen.js';
import { DescargaBloqueada, descargarSeguro, ipPrivada, validarUrl } from '../src/lib/descargaSegura.js';
import { BuscadorSimulado, setBuscadorImagenes } from '../src/adapters/buscadorImagenes.js';
import { setDescargador, tipoReal } from '../src/modules/imagenes.js';
import { evaluateAndExecute } from '../src/ai/gateway.js';
import { loadAgent } from '../src/ai/runtime.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { drain } from '../src/worker/jobs.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Imágenes del catálogo: tipo real (no la extensión), sin EXIF, SSRF bloqueado, imágenes pendientes que nunca
 * salen a clientes, aislamiento entre empresas y envío por WhatsApp solo dentro de la ventana de 24 horas.
 */
let E: Env;
let A: ReturnType<typeof api>;
let B: ReturnType<typeof api>;
let cookieA = '';
let cookieB = '';
let carpeta = '';
let cera = '';
const buscador = new BuscadorSimulado();
const sql = (q: string, p: unknown[] = []) => E.db.withPlatform((tx) => tx.query(q, p));

/** JPEG con EXIF (incluida una «ubicación» en los metadatos) para comprobar que se borra. */
const jpegConExif = () => sharp({ create: { width: 800, height: 600, channels: 3, background: '#3a7' } })
  .jpeg().withExif({ IFD0: { Copyright: 'Ubicacion secreta 7.89,-72.50', Artist: 'Celular de Diana' } }).toBuffer();
const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#a33' } }).png().toBuffer();
const archivo = (cookie: string, url: string) => E.app.inject({ method: 'GET', url, headers: { cookie, 'x-tenant-slug': cookie === cookieA ? 'elparche' : 'fuerzanorte' } });

beforeAll(async () => {
  carpeta = mkdtempSync(join(tmpdir(), 'omnegia-imagenes-'));
  setAlmacen(new AlmacenDisco(carpeta));
  setBuscadorImagenes(buscador);
  const imagenPng = await png();
  setDescargador(async () => imagenPng);
  E = await setup();
  cookieA = await login(E.app, ...CRED.admin);
  cookieB = await login(E.app, ...CRED.gym);
  A = api(E.app, cookieA, 'elparche');
  B = api(E.app, cookieB, 'fuerzanorte');
  cera = (await sql(`SELECT id FROM product WHERE tenant_id=$1 AND nombre='Cera para peinar'`, [E.A])).rows[0].id;
});
afterAll(async () => {
  setAlmacen(null); setBuscadorImagenes(null); setDescargador(null);
  rmSync(carpeta, { recursive: true, force: true });
  await E.app.close(); await E.db.close();
});

describe('Subir imágenes', () => {
  it('un «.png» que en realidad es un ejecutable se rechaza (se mira la firma, no la extensión)', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
    expect(tipoReal(exe)).toBeNull();
    const r = await A.post(`/catalogo/productos/${cera}/imagenes`, { base64: exe.toString('base64'), nombre: 'foto.png' });
    expect(r.status).toBe(400);
  });

  it('se guarda en WebP, redimensionada, con miniatura y sin metadatos EXIF', async () => {
    const original = await jpegConExif();
    expect((await sharp(original).metadata()).exif).toBeTruthy();
    const r = await A.post(`/catalogo/productos/${cera}/imagenes`, { base64: original.toString('base64'), nombre: 'foto.jpg' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: 'ACTIVA', origen: 'SUBIDA' });
    const guardada = (await archivo(cookieA, r.body.archivo)).rawPayload;
    const m = await sharp(guardada).metadata();
    expect(m.format).toBe('webp');
    expect(m.exif).toBeUndefined();
    expect(guardada.toString('latin1')).not.toContain('Ubicacion secreta');
    const mini = await sharp((await archivo(cookieA, r.body.miniatura)).rawPayload).metadata();
    expect(mini.width).toBe(320);
    // La URL pública (para WhatsApp) sirve la imagen ACTIVA sin sesión.
    const ruta = new URL(r.body.url_publica).pathname;
    expect((await E.app.inject({ method: 'GET', url: ruta })).statusCode).toBe(200);
  });
});

describe('SSRF', () => {
  it('bloquea http, localhost, IP privadas y la de metadatos', async () => {
    for (const u of ['http://ejemplo.com/a.jpg', 'https://127.0.0.1/a.jpg', 'https://169.254.169.254/latest/meta-data', 'https://localhost/a.jpg', 'https://10.0.0.5/a.jpg', 'https://[::1]/a.jpg', 'https://192.168.1.10:8443/x']) {
      expect(() => validarUrl(u), u).toThrow(DescargaBloqueada);
    }
    await expect(descargarSeguro('http://127.0.0.1/a.jpg', { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(DescargaBloqueada);
    await expect(descargarSeguro('https://169.254.169.254/latest', { maxBytes: 1000, timeoutMs: 1000 })).rejects.toThrow(DescargaBloqueada);
    expect(ipPrivada('172.20.1.1')).toBe(true);
    expect(ipPrivada('100.64.0.1')).toBe(true);
    expect(ipPrivada('::ffff:127.0.0.1')).toBe(true);
    expect(ipPrivada('8.8.8.8')).toBe(false);
  });
});

describe('La IA busca imágenes', () => {
  it('licencia abierta: se asignan solas con autor, licencia y fuente', async () => {
    const corte = (await sql(`SELECT id FROM product WHERE tenant_id=$1 AND nombre='Corte clásico'`, [E.A])).rows[0].id;
    buscador.abiertas = true;
    const r = await A.post(`/catalogo/productos/${corte}/imagenes/buscar`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ proveedor: 'simulado', agregadas: 3, pendientes: 0 });
    const imgs = (await A.get(`/catalogo/productos/${corte}/imagenes`)).body.imagenes;
    expect(imgs.every((i: any) => i.estado === 'ACTIVA' && i.licencia && i.autor && i.fuente)).toBe(true);
  });

  it('búsqueda web general: quedan pendientes y no se envían a clientes hasta aprobarlas', async () => {
    const aceite = (await sql(`SELECT id FROM product WHERE tenant_id=$1 AND nombre='Aceite para barba'`, [E.A])).rows[0].id;
    buscador.abiertas = false;
    const r = await A.post(`/catalogo/productos/${aceite}/imagenes/buscar`);
    expect(r.body.pendientes).toBeGreaterThan(0);
    expect(r.body.mensaje).toMatch(/derecho a usarlas/);
    const pendiente = (await sql(`SELECT id, miniatura, url FROM producto_imagen WHERE product_id=$1 AND estado='PENDIENTE_APROBACION' LIMIT 1`, [aceite])).rows[0];
    expect(pendiente.url).toMatch(/^https:\/\//);
    // La miniatura existe para el panel, pero la URL pública no la sirve.
    expect((await E.app.inject({ method: 'GET', url: `/api/publico/imagenes/${pendiente.miniatura}` })).statusCode).toBe(404);

    // El agente no puede enviarla.
    const from = '573170000001';
    const wa = async (t: string) => { await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from, nombre: 'Cliente Fotos', id: `im.${uuidv7()}`, texto: t }], 'WHATSAPP', 't'); await drain(E.db); };
    await wa('hola'); await wa('sí');
    const v = (await sql(`SELECT v.id, v.customer_id FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1`, [`+${from}`])).rows[0];
    const enviar = () => E.db.withTenant(E.A, async (tx) => {
      const agente = (await loadAgent(tx, 'atencion'))!;
      const ctx = { tenantId: E.A, actor: { tipo: 'AGENTE' as const, id: agente.id, nombre: 'Agente' }, roleKey: agente.roleKey, permisos: agente.permisos, origen: 'WHATSAPP' as const, correlacion: 't' };
      return evaluateAndExecute({ tx, ctx, conversationId: v.id, customerId: v.customer_id }, agente, { nombre: 'enviar_imagen_producto', argumentos: { producto_id: aceite } });
    });
    const antes = await enviar();
    expect(antes.resultado).toMatchObject({ enviada: false });
    expect((await A.post(`/catalogo/imagenes/${pendiente.id}/aprobar`)).status).toBe(200);
    const despues = await enviar();
    expect(despues.resultado).toMatchObject({ enviada: true });
    await drain(E.db);
    const m = (await sql(`SELECT tipo, metadatos, estado_entrega FROM message WHERE conversation_id=$1 AND tipo='MEDIA' ORDER BY creado_en DESC LIMIT 1`, [v.id])).rows[0];
    expect(m.metadatos.imagen).toMatch(/^https:\/\//);
    expect(['SIMULADO', 'ENVIADO']).toContain(m.estado_entrega);

    // Fuera de la ventana de 24 horas no se envía.
    await sql(`UPDATE conversation SET ultimo_mensaje_cliente_en = now() - interval '25 hours' WHERE id=$1`, [v.id]);
    const fuera = await enviar();
    expect(fuera.resultado).toMatchObject({ enviada: false });
    expect(String((fuera.resultado as any).motivo)).toMatch(/24 horas/);
  });
});

describe('Aislamiento', () => {
  it('otra empresa no ve, no descarga ni aprueba imágenes ajenas', async () => {
    const img = (await sql(`SELECT id FROM producto_imagen WHERE tenant_id=$1 LIMIT 1`, [E.A])).rows[0].id;
    expect((await archivo(cookieB, `/api/t/catalogo/imagenes/${img}/archivo`)).statusCode).toBe(404);
    expect((await B.get(`/catalogo/productos/${cera}/imagenes`)).status).toBe(404);
    expect((await B.post(`/catalogo/imagenes/${img}/aprobar`)).status).toBe(404);
    expect((await B.del(`/catalogo/imagenes/${img}`)).status).toBe(404);
    const n = await E.db.withTenant(E.B, async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM producto_imagen`)).rows[0].n);
    expect(n).toBe(0);
  });
});

describe('Punto de venta', () => {
  it('venta de mostrador con descuento total y comprobante automático por regla', async () => {
    await A.patch('/comprobantes/ajustes', { auto_al_vender: true });
    const r = await A.post('/ventas', { mostrador: true, descuento_total_pct: 10, items: [{ product_id: cera, cantidad: 1 }], pago: { metodo: 'EFECTIVO', recibido: 50000 } });
    expect(r.status).toBe(200);
    expect(r.body.cliente).toBe('Cliente de mostrador');
    expect(r.body.descuento).toBeGreaterThan(0);
    expect(r.body.comprobante.numero).toMatch(/^CV-/);
    const p = (await A.get('/productos')).body.find((x: any) => x.id === cera);
    expect(p.imagen).toMatch(/\/api\/t\/catalogo\/imagenes\//);
    await A.patch('/comprobantes/ajustes', { auto_al_vender: false });
  });
});
