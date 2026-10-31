import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { AppError, notFound, invalid } from '../lib/errors.js';
import { isUuid, normalizeText, uuidv7 } from '../lib/util.js';

/** Un nombre sin letras («12», «---») no describe un producto: suele ser un dato de prueba. */
export const conLetras = (n: string) => /\p{L}/u.test(n);
const MSG_SIN_LETRAS = 'El nombre debe describir el producto o servicio (incluye al menos una letra).';

export const ProductInput = z.object({
  tipo: z.enum(['PRODUCTO', 'SERVICIO']),
  nombre: z.string().trim().min(2, 'Escribe el nombre (mínimo 2 caracteres).').max(120).refine(conLetras, MSG_SIN_LETRAS),
  categoria: z.string().trim().max(60).optional().nullable(),
  precio: z.number().nonnegative().max(999_999_999),
  iva_pct: z.number().min(0).max(19).default(0),
  duracion_min: z.number().int().positive().max(600).optional().nullable(),
  controla_stock: z.boolean().default(false),
  stock: z.number().min(0).default(0),
  stock_minimo: z.number().min(0).default(0),
  sku: z.string().max(40).optional().nullable(),
  activo: z.boolean().default(true),
  // Agenda del servicio (029): tiempo de preparación antes y después, quién lo presta, segundo recurso y repetición.
  buffer_antes_min: z.number().int().min(0).max(240).optional(),
  buffer_despues_min: z.number().int().min(0).max(240).optional(),
  recursos_permitidos: z.array(z.uuid()).max(30).nullable().optional(),
  recursos_secundarios: z.array(z.uuid()).max(30).nullable().optional(),
  repetir_cada_semanas: z.number().int().min(1).max(104).nullable().optional(),
});
export type ProductData = z.infer<typeof ProductInput>;

const mapP = (r: any) => ({ ...r, precio: Number(r.precio), iva_pct: Number(r.iva_pct), stock: Number(r.stock), stock_minimo: Number(r.stock_minimo) });

export async function listProducts(tx: Tx, ctx: Ctx, opts: { soloActivos?: boolean } = {}) {
  requirePerm(ctx, 'catalog:read');
  const { rows } = await tx.query(
    `SELECT id, tipo, nombre, categoria, precio, moneda, iva_pct, duracion_min, controla_stock, stock, stock_minimo, sku, activo,
            buffer_antes_min, buffer_despues_min, recursos_permitidos, recursos_secundarios, repetir_cada_semanas
     FROM product WHERE eliminado_en IS NULL ${opts.soloActivos ? 'AND activo' : ''} ORDER BY categoria NULLS LAST, nombre`,
  );
  // Imagen principal ACTIVA (miniatura) para la cuadrícula del punto de venta y el catálogo.
  const imagenes = new Map((await tx.query(`SELECT DISTINCT ON (product_id) product_id, id FROM producto_imagen WHERE estado='ACTIVA' ORDER BY product_id, orden, creado_en`)).rows
    .map((r: any) => [r.product_id, `/api/t/catalogo/imagenes/${r.id}/archivo?min=1`]));
  const pendientes = new Set((await tx.query(`SELECT DISTINCT product_id FROM producto_imagen WHERE estado='PENDIENTE_APROBACION'`)).rows.map((r: any) => r.product_id));
  return rows.map((r) => ({ ...mapP(r), imagen: imagenes.get(r.id) ?? null, imagenes_pendientes: pendientes.has(r.id) }));
}

export async function getProduct(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'catalog:read');
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`SELECT * FROM product WHERE id=$1 AND eliminado_en IS NULL`, [id])).rows[0];
  if (!r) throw notFound();
  return mapP(r);
}

/** Búsqueda aproximada por nombre (normalizada, sin tildes). */
export async function findProductsByName(tx: Tx, texto: string) {
  const all = (await tx.query(`SELECT id, tipo, nombre, categoria, precio, iva_pct, duracion_min, controla_stock, stock, stock_minimo FROM product WHERE eliminado_en IS NULL AND activo`)).rows.map(mapP);
  const t = normalizeText(texto);
  const words = t.split(/\s+/).filter((w) => w.length > 2);
  return all
    .map((p) => {
      const n = normalizeText(p.nombre);
      let score = n === t ? 100 : n.includes(t) || t.includes(n) ? 50 : 0;
      for (const w of words) if (n.includes(w)) score += 10;
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
}

export async function insertProduct(tx: Tx, ctx: Ctx, d: ProductData) {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO product (id, tenant_id, tipo, nombre, categoria, precio, iva_pct, duracion_min, controla_stock, stock, stock_minimo, sku, activo,
       buffer_antes_min, buffer_despues_min, recursos_permitidos, recursos_secundarios, repetir_cada_semanas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, ctx.tenantId, d.tipo, d.nombre, d.categoria ?? null, d.precio, d.iva_pct, d.duracion_min ?? null, d.controla_stock, d.stock, d.stock_minimo, d.sku ?? null, d.activo,
      d.buffer_antes_min ?? 0, d.buffer_despues_min ?? 0, d.recursos_permitidos?.length ? d.recursos_permitidos : null, d.recursos_secundarios?.length ? d.recursos_secundarios : null, d.repetir_cada_semanas ?? null],
  );
  return id;
}

export async function createProduct(tx: Tx, ctx: Ctx, input: unknown) {
  requirePerm(ctx, 'catalog:write');
  requireWritable(ctx);
  const d = ProductInput.parse(input);
  if (d.tipo === 'SERVICIO' && d.controla_stock) throw invalid('Un servicio no controla existencias.');
  // Dos ítems con el mismo nombre confunden al agente y a quien vende: se edita el existente.
  const mismo = (await tx.query(`SELECT nombre FROM product WHERE eliminado_en IS NULL AND tipo=$1`, [d.tipo])).rows.find((p: any) => normalizeText(p.nombre) === normalizeText(d.nombre));
  if (mismo) throw new AppError('CONFLICT', `Ya existe «${mismo.nombre}» en tu catálogo. Edítalo en lugar de crear otro.`);
  const id = await insertProduct(tx, ctx, d);
  await audit(tx, ctx, { accion: 'catalogo.crear', recurso: 'product', recursoId: id, resultado: 'EXITO', detalle: { nombre: d.nombre, precio: d.precio } });
  return { id };
}

export async function updateProduct(tx: Tx, ctx: Ctx, id: string, input: unknown) {
  requirePerm(ctx, 'catalog:write');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const d = ProductInput.partial().omit({ stock: true }).parse(input);
  const before = (await tx.query(`SELECT precio FROM product WHERE id=$1 AND eliminado_en IS NULL`, [id])).rows[0];
  if (!before) throw notFound();
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, v] of Object.entries(d)) {
    params.push(v ?? null);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length) await tx.query(`UPDATE product SET ${sets.join(', ')} WHERE id=$1`, params);
  await audit(tx, ctx, {
    accion: 'catalogo.editar', recurso: 'product', recursoId: id, resultado: 'EXITO',
    detalle: { campos: Object.keys(d), precio_anterior: Number(before.precio), precio_nuevo: d.precio },
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Inventario
// ---------------------------------------------------------------------------
export async function registerMovement(
  tx: Tx,
  ctx: Ctx,
  input: { product_id: string; tipo: 'ENTRADA' | 'SALIDA' | 'AJUSTE'; cantidad: number; motivo: string; order_id?: string | null },
  opts: { skipPerm?: boolean } = {},
) {
  if (!opts.skipPerm) {
    requirePerm(ctx, 'inventory:write');
    requireWritable(ctx);
  }
  if (!isUuid(input.product_id)) throw notFound();
  const p = (await tx.query(`SELECT id, nombre, controla_stock, stock, stock_minimo FROM product WHERE id=$1 AND eliminado_en IS NULL FOR UPDATE`, [input.product_id])).rows[0];
  if (!p) throw notFound();
  if (!p.controla_stock) throw invalid('Este ítem no controla existencias.');
  if (!(input.cantidad > 0) && input.tipo !== 'AJUSTE') throw invalid('La cantidad debe ser positiva.');
  const actual = Number(p.stock);
  const nuevo = input.tipo === 'ENTRADA' ? actual + input.cantidad : input.tipo === 'SALIDA' ? actual - input.cantidad : input.cantidad;
  if (nuevo < 0) throw invalid(`No hay existencias suficientes de ${p.nombre} (quedan ${actual}).`);
  await tx.query(`UPDATE product SET stock=$2 WHERE id=$1`, [p.id, nuevo]);
  await tx.query(
    `INSERT INTO stock_movement (id, tenant_id, product_id, tipo, cantidad, motivo, order_id, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv7(), ctx.tenantId, p.id, input.tipo, input.tipo === 'AJUSTE' ? nuevo - actual : input.cantidad, input.motivo, input.order_id ?? null, `${ctx.actor.tipo}:${ctx.actor.nombre}`],
  );
  if (nuevo <= Number(p.stock_minimo) && actual > Number(p.stock_minimo)) {
    await publish(tx, ctx, 'stock_bajo_minimo', { product_id: p.id, nombre: p.nombre, stock: nuevo, minimo: Number(p.stock_minimo) });
  }
  if (!opts.skipPerm) {
    await audit(tx, ctx, { accion: 'inventario.movimiento', recurso: 'product', recursoId: p.id, resultado: 'EXITO', detalle: { tipo: input.tipo, cantidad: input.cantidad, stock: nuevo } });
  }
  return { stock: nuevo };
}

export async function lowStock(tx: Tx) {
  return (await tx.query(
    `SELECT id, nombre, stock, stock_minimo FROM product WHERE controla_stock AND eliminado_en IS NULL AND stock <= stock_minimo ORDER BY nombre`,
  )).rows.map(mapP);
}

export async function listMovements(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'inventory:read');
  return (await tx.query(
    `SELECT m.id, m.tipo, m.cantidad, m.motivo, m.actor, m.creado_en, p.nombre AS producto
     FROM stock_movement m JOIN product p ON p.id=m.product_id ORDER BY m.creado_en DESC LIMIT 100`,
  )).rows.map((r) => ({ ...r, cantidad: Number(r.cantidad) }));
}

// ---------------------------------------------------------------------------
// Importación desde hoja de cálculo (panel): vista previa y confirmación atómica
// ---------------------------------------------------------------------------
export const FilaImportacion = z.object({
  tipo: z.enum(['PRODUCTO', 'SERVICIO']),
  nombre: z.string().trim().min(1).max(120).refine(conLetras, MSG_SIN_LETRAS),
  categoria: z.string().trim().max(60).nullable().optional(),
  precio: z.number().nonnegative().max(999_999_999),
  iva_pct: z.number().refine((v) => [0, 5, 19].includes(v), 'IVA admitido: 0, 5 o 19 %.').default(0),
  duracion_min: z.number().int().positive().max(600).nullable().optional(),
  stock: z.number().min(0).nullable().optional(),
  sku: z.string().max(40).nullable().optional(),
});

/** Marca qué filas coinciden con un ítem existente (mismo nombre, sin tildes ni mayúsculas). */
export async function marcarDuplicados(tx: Tx, ctx: Ctx, nombres: string[]) {
  requirePerm(ctx, 'catalog:write');
  const existentes = (await tx.query(`SELECT id, nombre FROM product WHERE eliminado_en IS NULL`)).rows;
  const porNombre = new Map(existentes.map((p: any) => [normalizeText(p.nombre), p.nombre]));
  return nombres.map((n) => porNombre.get(normalizeText(n)) ?? null);
}

/** Confirma filas válidas, conserva motivos por fila y serializa importaciones de la empresa. */
export async function confirmImport(tx: Tx, ctx: Ctx, body: unknown) {
 requirePerm(ctx,'catalog:write'); requireWritable(ctx);
 const d=z.object({filas:z.array(z.any()).min(1,'No hay filas para importar.').max(2000),duplicados:z.enum(['omitir','actualizar']),archivo:z.string().max(200).optional()}).parse(body);
 await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`catalog-import:${ctx.tenantId}`]);
 const existentes=(await tx.query('SELECT id,nombre,sku,tipo FROM product WHERE eliminado_en IS NULL FOR UPDATE')).rows;
 let creados=0,actualizados=0,omitidos=0,rechazados=0;const reporte:any[]=[];
 for(const [i,raw] of d.filas.entries()){
  const fila=raw.fila??i+1;
  if(raw.incluir===false){omitidos++;reporte.push({fila,estado:'OMITIDO',motivo:'Excluido al revisar'});continue;}
  const p=FilaImportacion.safeParse(raw);
  if(!p.success){rechazados++;reporte.push({fila,estado:'RECHAZADO',motivo:p.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')});continue;}
  const f=p.data;
  const e=existentes.find(x=>(f.sku&&x.sku&&normalizeText(x.sku)===normalizeText(f.sku))||normalizeText(x.nombre)===normalizeText(f.nombre));
  if(e&&d.duplicados==='omitir'){omitidos++;reporte.push({fila,estado:'OMITIDO',motivo:'Ya existe en el catálogo'});continue;}
  if(e&&e.tipo!==f.tipo){rechazados++;reporte.push({fila,estado:'RECHAZADO',motivo:'El tipo no coincide con el registro existente'});continue;}
  if(e){await tx.query('UPDATE product SET precio=$2,iva_pct=$3,categoria=coalesce($4,categoria),duracion_min=coalesce($5,duracion_min),sku=coalesce($6,sku) WHERE id=$1',[e.id,f.precio,f.iva_pct,f.categoria??null,f.tipo==='SERVICIO'?f.duracion_min??null:null,f.sku??null]);actualizados++;}
  else{const controla=f.tipo==='PRODUCTO'&&f.stock!=null;
   const item=await insertProduct(tx,ctx,{tipo:f.tipo,nombre:f.nombre,categoria:f.categoria??null,precio:f.precio,iva_pct:f.iva_pct,duracion_min:f.tipo==='SERVICIO'?f.duracion_min??30:null,controla_stock:controla,stock:controla?f.stock!:0,stock_minimo:0,sku:f.sku??null,activo:true});
   existentes.push({...f,id:item});creados++;
  }
  reporte.push({fila,estado:e?'ACTUALIZADO':'IMPORTADO',motivo:e?'Datos actualizados; las existencias no se reemplazan':'Registro creado'});
 }
 await audit(tx,ctx,{accion:'catalogo.importar',recurso:'product',resultado:'EXITO',detalle:{archivo:d.archivo,creados,actualizados,omitidos,rechazados,modo:d.duplicados}});
 return {creados,actualizados,omitidos,rechazados,reporte};
}

// ---------------------------------------------------------------------------
// Revisión de calidad: señala datos incompletos o de prueba; no cambia ni borra nada
// ---------------------------------------------------------------------------
export const PROBLEMAS_CATALOGO: Record<string, string> = {
  nombre_sin_letras: 'El nombre no tiene letras: parece un dato de prueba.',
  nombre_corto: 'El nombre es muy corto para que un cliente lo reconozca.',
  precio_cero: 'Precio en $0: confírmalo si es gratuito.',
  precio_bajo: 'Precio menor a $100: revisa que no le falten ceros.',
  sin_duracion: 'Servicio sin duración: no se puede agendar.',
  sin_categoria: 'Sin categoría: agruparlo ayuda a encontrarlo.',
  duplicado: 'Hay otro ítem con el mismo nombre.',
};

export async function revisarCatalogo(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'catalog:read');
  const items = (await tx.query(`SELECT id, tipo, nombre, categoria, precio, moneda, duracion_min, activo FROM product WHERE eliminado_en IS NULL ORDER BY activo DESC, nombre`)).rows.map(mapP);
  const nombres = new Map<string, number>();
  for (const i of items) nombres.set(normalizeText(i.nombre), (nombres.get(normalizeText(i.nombre)) ?? 0) + 1);
  const revisar = items.map((i: any) => {
    const p: string[] = [];
    if (!conLetras(i.nombre)) p.push('nombre_sin_letras');
    else if (i.nombre.trim().length < 3) p.push('nombre_corto');
    if (i.precio === 0) p.push('precio_cero');
    // En pesos colombianos nada se vende por menos de $100 (la moneda más pequeña es de $50).
    else if (i.moneda === 'COP' && i.precio < 100) p.push('precio_bajo');
    if (i.tipo === 'SERVICIO' && !i.duracion_min) p.push('sin_duracion');
    if (!i.categoria) p.push('sin_categoria');
    if ((nombres.get(normalizeText(i.nombre)) ?? 0) > 1) p.push('duplicado');
    return { id: i.id, tipo: i.tipo, nombre: i.nombre, precio: i.precio, activo: i.activo, problemas: p.map((codigo) => ({ codigo, texto: PROBLEMAS_CATALOGO[codigo] })) };
  }).filter((i: any) => i.problemas.length);
  // Lo que impide vender o agendar va primero; la falta de categoría es una mejora.
  const peso = (i: any) => i.problemas.some((x: any) => x.codigo !== 'sin_categoria') ? 0 : 1;
  revisar.sort((a: any, b: any) => peso(a) - peso(b) || Number(b.activo) - Number(a.activo));
  return { total: items.length, por_revisar: revisar.length, criticos: revisar.filter((i: any) => peso(i) === 0).length, items: revisar };
}
