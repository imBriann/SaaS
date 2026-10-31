import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit, auditPlatform } from '../core/audit.js';
import { invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { config } from '../config.js';
import { almacen } from '../lib/almacen.js';
import { descargarSeguro } from '../lib/descargaSegura.js';

/**
 * Imágenes del catálogo (migración 030).
 *
 *  a) Subidas por la empresa: solo JPG, PNG o WebP verificando el tipo REAL del archivo (firma, no extensión),
 *     con tamaño máximo, redimensionadas, convertidas a WebP con miniatura y SIN metadatos EXIF (pueden traer
 *     la ubicación). Se sirven por una URL pública https (WhatsApp las envía por enlace).
 *  b) Buscadas por la IA: arma la consulta, el buscador trae candidatas y la IA elige las mejores. Las de licencia
 *     abierta se asignan solas (con autor, licencia y fuente) y se guarda una copia; las de búsqueda web general
 *     quedan PENDIENTE_APROBACION con solo el enlace y una miniatura propia para el panel.
 *  c) Solo las ACTIVA se muestran o se envían a clientes, y solo las del propio tenant (RLS).
 */
export type TipoImagen = 'jpeg' | 'png' | 'webp';

/** Tipo real por la firma del archivo. */
export function tipoReal(b: Buffer): TipoImagen | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export interface Procesada { imagen: Buffer; miniatura: Buffer; ancho: number; alto: number }

/**
 * `sharp` trae binarios nativos por plataforma. Se carga al primer uso (no al arrancar) para que, si faltan en el
 * servidor, el resto de la app siga funcionando y el fallo sea claro: ProcesadorNoDisponible.
 */
export class ProcesadorNoDisponible extends Error {}
type Sharp = typeof import('sharp');
let cargadorSharp: () => Promise<Sharp> = async () => (await import('sharp')).default;
let sharpCargado: Promise<Sharp> | null = null;
/** Solo pruebas: reemplaza la carga de sharp (por ejemplo, para simular que no está disponible). */
export const setCargadorSharp = (c: (() => Promise<Sharp>) | null) => { sharpCargado = null; cargadorSharp = c ?? (async () => (await import('sharp')).default); };
async function sharp(): Promise<Sharp> {
  sharpCargado ??= cargadorSharp().catch((e) => { sharpCargado = null; throw new ProcesadorNoDisponible(`El servidor no puede procesar imágenes: ${String((e as Error).message).split(/\r?\n/)[0]}`); });
  return sharpCargado;
}

/** Procesa una imagen de 1×1 para comprobar que sharp y sus binarios nativos funcionan en este servidor. */
export async function verificarProcesadorImagenes(): Promise<{ ok: boolean; error?: string }> {
  try {
    const s = await sharp();
    const png = await s({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
    await s(png).resize({ width: 1 }).webp().toBuffer();
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** Valida, redimensiona y convierte a WebP sin metadatos (sharp no copia EXIF/XMP/ICC salvo que se pida). */
export async function procesarImagen(datos: Buffer): Promise<Procesada> {
  if (datos.length > config.imagenes.maxBytes) throw invalid(`La imagen pesa más de ${Math.round(config.imagenes.maxBytes / 1024 / 1024)} MB.`);
  if (!tipoReal(datos)) throw invalid('Solo se aceptan imágenes JPG, PNG o WebP.');
  const s = await sharp();
  try {
    const base = s(datos, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate();
    const r = await base.clone().resize({ width: config.imagenes.anchoMax, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    const miniatura = await base.clone().resize({ width: config.imagenes.anchoMiniatura, height: config.imagenes.anchoMiniatura, fit: 'cover' }).webp({ quality: 75 }).toBuffer();
    return { imagen: r.data, miniatura, ancho: r.info.width, alto: r.info.height };
  } catch {
    throw invalid('No pudimos leer esa imagen. Prueba con otra.');
  }
}

export const rutas = (tenantId: string, productId: string, id: string) => ({ imagen: `t/${tenantId}/${productId}/${id}.webp`, miniatura: `t/${tenantId}/${productId}/${id}_min.webp` });

async function producto(tx: Tx, productId: string) {
  if (!isUuid(productId)) throw notFound();
  const p = (await tx.query(`SELECT id, nombre, categoria, tipo FROM product WHERE id=$1 AND eliminado_en IS NULL`, [productId])).rows[0];
  if (!p) throw notFound();
  return p;
}

export function vistaImagen(r: any) {
  return {
    id: r.id, product_id: r.product_id, orden: r.orden, origen: r.origen, estado: r.estado, proveedor: r.proveedor, fuente: r.fuente, licencia: r.licencia, autor: r.autor, atribucion: r.atribucion,
    // Panel (con sesión) y, solo si está ACTIVA, la URL pública para WhatsApp.
    archivo: `/api/t/catalogo/imagenes/${r.id}/archivo`, miniatura: `/api/t/catalogo/imagenes/${r.id}/archivo?min=1`,
    url_publica: r.estado === 'ACTIVA' ? urlPublica(r) : null, ancho: r.ancho, alto: r.alto,
  };
}
export const urlPublica = (r: { ruta_archivo?: string | null; url?: string | null }) => (r.ruta_archivo ? almacen().urlPublica(r.ruta_archivo) : r.url ?? null);

export async function listar(tx: Tx, ctx: Ctx, productId: string) {
  requirePerm(ctx, 'catalog:read');
  await producto(tx, productId);
  return { imagenes: (await tx.query(`SELECT * FROM producto_imagen WHERE product_id=$1 ORDER BY estado='ACTIVA' DESC, orden, creado_en`, [productId])).rows.map(vistaImagen) };
}

const Subida = z.object({ base64: z.string().min(16).max(Math.ceil(config.imagenes.maxBytes * 1.4) + 100), nombre: z.string().max(120).optional() });

export async function subir(tx: Tx, ctx: Ctx, productId: string, body: unknown) {
  requirePerm(ctx, 'catalog:write');
  requireWritable(ctx);
  await producto(tx, productId);
  const b = Subida.safeParse(body ?? {});
  if (!b.success) throw invalid(`Elige una imagen de hasta ${Math.round(config.imagenes.maxBytes / 1024 / 1024)} MB.`);
  const datos = Buffer.from(b.data.base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
  const p = await procesarImagen(datos);
  const id = uuidv7();
  const r = rutas(ctx.tenantId, productId, id);
  await almacen().guardar(r.imagen, p.imagen);
  await almacen().guardar(r.miniatura, p.miniatura);
  const orden = Number((await tx.query(`SELECT coalesce(max(orden) + 1, 0) AS n FROM producto_imagen WHERE product_id=$1`, [productId])).rows[0].n);
  await tx.query(
    `INSERT INTO producto_imagen (id, tenant_id, product_id, orden, origen, ruta_archivo, miniatura, estado, ancho, alto, bytes, verificada_en, creado_por)
     VALUES ($1,$2,$3,$4,'SUBIDA',$5,$6,'ACTIVA',$7,$8,$9,now(),$10)`,
    [id, ctx.tenantId, productId, Math.min(orden, 50), r.imagen, r.miniatura, p.ancho, p.alto, p.imagen.length, `${ctx.actor.tipo}:${ctx.actor.nombre}`]);
  await audit(tx, ctx, { accion: 'catalogo.imagen.subir', recurso: 'producto_imagen', recursoId: id, resultado: 'EXITO', detalle: { product_id: productId, bytes: p.imagen.length } });
  return vistaImagen((await tx.query(`SELECT * FROM producto_imagen WHERE id=$1`, [id])).rows[0]);
}

export async function aprobar(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'catalog:write');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`UPDATE producto_imagen SET estado='ACTIVA', aprobada_por=$2 WHERE id=$1 AND estado='PENDIENTE_APROBACION' RETURNING *`, [id, `${ctx.actor.tipo}:${ctx.actor.nombre}`])).rows[0];
  if (!r) throw notFound();
  await audit(tx, ctx, { accion: 'catalogo.imagen.aprobar', recurso: 'producto_imagen', recursoId: id, resultado: 'EXITO', detalle: { fuente: r.fuente } });
  return vistaImagen(r);
}

export async function eliminar(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'catalog:write');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`DELETE FROM producto_imagen WHERE id=$1 RETURNING ruta_archivo, miniatura`, [id])).rows[0];
  if (!r) throw notFound();
  for (const ruta of [r.ruta_archivo, r.miniatura]) if (ruta) await almacen().borrar(ruta).catch(() => undefined);
  await audit(tx, ctx, { accion: 'catalogo.imagen.eliminar', recurso: 'producto_imagen', recursoId: id, resultado: 'EXITO' });
  return { ok: true };
}

/** Archivo para el panel (con sesión): la RLS impide leer el de otra empresa. */
export async function archivoTenant(tx: Tx, ctx: Ctx, id: string, mini: boolean) {
  requirePerm(ctx, 'catalog:read');
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`SELECT ruta_archivo, miniatura FROM producto_imagen WHERE id=$1`, [id])).rows[0];
  const ruta = r ? (mini ? r.miniatura ?? r.ruta_archivo : r.ruta_archivo ?? r.miniatura) : null;
  const datos = ruta ? await almacen().leer(ruta) : null;
  if (!datos) throw notFound();
  return datos;
}

/** URL pública (WhatsApp, POS): solo archivos de imágenes ACTIVA. */
export async function archivoPublico(db: Database, ruta: string) {
  if (!/^t\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}(_min)?\.webp$/.test(ruta)) return null;
  const ok = await db.withPlatform(async (tx) => (await tx.query(`SELECT 1 FROM producto_imagen WHERE (ruta_archivo=$1 OR miniatura=$1) AND estado='ACTIVA'`, [ruta])).rows[0]);
  return ok ? almacen().leer(ruta) : null;
}

/** Imagen principal ACTIVA de cada producto (cuadrícula del punto de venta). */
export async function principales(tx: Tx): Promise<Map<string, string>> {
  const rows = (await tx.query(`SELECT DISTINCT ON (product_id) product_id, id FROM producto_imagen WHERE estado='ACTIVA' ORDER BY product_id, orden, creado_en`)).rows;
  return new Map(rows.map((r: any) => [r.product_id, `/api/t/catalogo/imagenes/${r.id}/archivo?min=1`]));
}

// ---------------------------------------------------------------------------
// Descarga (la búsqueda con IA vive en busquedaImagenes.ts)
// ---------------------------------------------------------------------------
type Descargador = (url: string) => Promise<Buffer>;
const descargaReal: Descargador = async (url) => (await descargarSeguro(url, { maxBytes: config.imagenes.maxBytes, timeoutMs: config.imagenes.descargaTimeoutMs })).datos;
let descargador: Descargador = descargaReal;
/** Solo pruebas: reemplaza la descarga por red. */
export const setDescargador = (d: Descargador | null) => { descargador = d ?? descargaReal; };
export const descargarImagen: Descargador = (url) => descargador(url);

/** Trabajo periódico: comprueba los enlaces externos sin copia propia y marca ROTA los que fallan. */
export async function revisarEnlaces(db: Database, correlacion: string) {
  const filas = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT id, tenant_id, url FROM producto_imagen WHERE url IS NOT NULL AND ruta_archivo IS NULL AND estado <> 'ROTA' AND (verificada_en IS NULL OR verificada_en < now() - interval '7 days') LIMIT 50`)).rows);
  let rotas = 0;
  for (const f of filas) {
    let ok = true;
    try { tipoReal(await descargador(f.url)) || (ok = false); } catch { ok = false; }
    await db.withPlatform(async (tx) => {
      await tx.query(`UPDATE producto_imagen SET ${ok ? 'verificada_en=now()' : "estado='ROTA'"} WHERE id=$1`, [f.id]);
      if (!ok) await auditPlatform(tx, f.tenant_id, { tipo: 'SISTEMA', id: null, nombre: 'Revisión de imágenes' }, 'TRABAJADOR', correlacion, { accion: 'catalogo.imagen.rota', recurso: 'producto_imagen', recursoId: f.id, resultado: 'ERROR' });
    });
    if (!ok) rotas++;
  }
  return { revisadas: filas.length, rotas };
}
