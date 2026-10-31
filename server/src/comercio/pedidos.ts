import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm } from '../core/context.js';
import { audit } from '../core/audit.js';
import { publish } from '../core/events.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { aCentavos, aPesos, calcularLinea, sumarLineas } from '../lib/money.js';
import { registerMovement } from '../modules/catalog.js';
import { record as recordCommission } from '../modules/commissions.js';
import { configValida, configVigente, importeCobro, pesos, textoCobro, type PrecioConfig } from './precios.js';

/**
 * Pedidos de WhatsApp sobre la tabla "order" existente (docs/pagos-whatsapp.md § 1):
 *   - nacen en estado BORRADOR con pedido_estado ABIERTO: no cuentan como venta ni mueven inventario;
 *   - los precios se calculan en el servidor con el catálogo y se congelan en order_item;
 *   - la configuración de precios (modo e importe fijo) se congela al crear el pedido;
 *   - al aprobarse el pago, el pedido pasa a CONFIRMADA (venta), descuenta inventario y queda PAGADO.
 * La IA nunca decide precios ni importes: solo elige productos y cantidades.
 */
export interface ItemPedido { product_id: string; cantidad: number }
const MAX_ITEMS = 20;

async function productos(tx: Tx, ids: string[]) {
  const ps = (await tx.query(`SELECT id, nombre, tipo, precio, iva_pct, controla_stock, stock FROM product WHERE id = ANY($1::uuid[]) AND eliminado_en IS NULL AND activo`, [ids])).rows;
  if (ps.length !== new Set(ids).size) throw notFound();
  return new Map(ps.map((p: any) => [p.id, p]));
}

function validarItems(items: ItemPedido[]) {
  if (!items.length || items.length > MAX_ITEMS) throw invalid(`Un pedido lleva entre 1 y ${MAX_ITEMS} productos.`);
  for (const i of items) if (!isUuid(i.product_id) || !Number.isInteger(i.cantidad) || i.cantidad <= 0 || i.cantidad > 100) throw invalid('Revisa los productos y las cantidades del pedido.');
}

/** Recalcula subtotal, impuestos y total del pedido a partir de sus líneas congeladas. */
async function recalcular(tx: Tx, orderId: string) {
  const lineas = (await tx.query(`SELECT precio_unit, cantidad, iva_pct FROM order_item WHERE order_id=$1`, [orderId])).rows;
  const tot = sumarLineas(lineas.map((l: any) => calcularLinea({ precioUnitario: Number(l.precio_unit), cantidad: Number(l.cantidad), ivaPct: Number(l.iva_pct), descuentoPct: 0 })));
  await tx.query(`UPDATE "order" SET subtotal=$2, impuestos=$3, total=$4 WHERE id=$1`, [orderId, aPesos(tot.base), aPesos(tot.impuesto), aPesos(tot.total)]);
}

async function insertarLineas(tx: Tx, ctx: Ctx, orderId: string, items: ItemPedido[]) {
  const byId = await productos(tx, items.map((i) => i.product_id));
  for (const i of items) {
    const p: any = byId.get(i.product_id);
    const c = calcularLinea({ precioUnitario: Number(p.precio), cantidad: i.cantidad, ivaPct: Number(p.iva_pct), descuentoPct: 0 });
    const previa = (await tx.query(`SELECT id, cantidad FROM order_item WHERE order_id=$1 AND product_id=$2`, [orderId, p.id])).rows[0];
    if (previa) {
      const cant = Number(previa.cantidad) + i.cantidad;
      const c2 = calcularLinea({ precioUnitario: Number(p.precio), cantidad: cant, ivaPct: Number(p.iva_pct), descuentoPct: 0 });
      await tx.query(`UPDATE order_item SET cantidad=$2, total=$3 WHERE id=$1`, [previa.id, cant, aPesos(c2.total)]);
    } else {
      await tx.query(
        `INSERT INTO order_item (id, tenant_id, order_id, product_id, descripcion, cantidad, precio_unit, iva_pct, total, descuento_pct, descuento) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0)`,
        [uuidv7(), ctx.tenantId, orderId, p.id, p.nombre, i.cantidad, Number(p.precio), Number(p.iva_pct), aPesos(c.total)]);
    }
  }
}

export async function crearPedido(tx: Tx, ctx: Ctx, d: { customerId: string; conversationId?: string | null; items: ItemPedido[] }) {
  requirePerm(ctx, 'order:create');
  validarItems(d.items);
  const c = (await tx.query(`SELECT id FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [d.customerId])).rows[0];
  if (!c) throw notFound();
  // Un cliente tiene como máximo un pedido abierto: se reutiliza en lugar de duplicarlo.
  const abierto = (await tx.query(`SELECT id FROM "order" WHERE customer_id=$1 AND estado='BORRADOR' AND pedido_estado='ABIERTO' ORDER BY creado_en DESC LIMIT 1`, [d.customerId])).rows[0];
  if (abierto) { await insertarLineas(tx, ctx, abierto.id, d.items); await recalcular(tx, abierto.id); return vistaPedido(tx, abierto.id); }
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`order:${ctx.tenantId}`]);
  const numero = Number((await tx.query(`SELECT coalesce(max(numero), 1000) + 1 AS n FROM "order"`)).rows[0].n);
  const id = uuidv7();
  await tx.query(
    `INSERT INTO "order" (id, tenant_id, numero, customer_id, estado, origen, subtotal, impuestos, total, descuento, conversation_id, creado_por, pedido_estado, precio_config)
     VALUES ($1,$2,$3,$4,'BORRADOR','AGENTE',0,0,0,0,$5,$6,'ABIERTO',$7)`,
    [id, ctx.tenantId, numero, d.customerId, d.conversationId ?? null, `${ctx.actor.tipo}:${ctx.actor.nombre}`, JSON.stringify(configVigente())]);
  await insertarLineas(tx, ctx, id, d.items);
  await recalcular(tx, id);
  await audit(tx, ctx, { accion: 'pedido.crear', recurso: 'order', recursoId: id, resultado: 'EXITO', detalle: { numero, items: d.items.length } });
  return vistaPedido(tx, id);
}

/** Pedido del cliente de la conversación (nunca de otro cliente ni de otra empresa: la RLS y el filtro lo impiden). */
export async function pedidoDelCliente(tx: Tx, orderId: string, customerId: string) {
  if (!isUuid(orderId)) throw notFound();
  const o = (await tx.query(`SELECT * FROM "order" WHERE id=$1 AND customer_id=$2 AND pedido_estado IS NOT NULL AND eliminado_en IS NULL`, [orderId, customerId])).rows[0];
  if (!o) throw notFound();
  return o;
}

const editable = (o: any) => { if (o.estado !== 'BORRADOR' || o.pedido_estado !== 'ABIERTO') throw new AppError('CONFLICT', 'Este pedido ya no se puede cambiar: ya se generó su cobro.'); };

export async function agregarAlPedido(tx: Tx, ctx: Ctx, orderId: string, customerId: string, item: ItemPedido) {
  requirePerm(ctx, 'order:create');
  const o = await pedidoDelCliente(tx, orderId, customerId);
  editable(o);
  validarItems([item]);
  await insertarLineas(tx, ctx, o.id, [item]);
  await recalcular(tx, o.id);
  return vistaPedido(tx, o.id);
}

export async function elegirEntrega(tx: Tx, ctx: Ctx, orderId: string, customerId: string, entrega: 'RECOGER' | 'DOMICILIO', direccion?: string | null) {
  requirePerm(ctx, 'order:create');
  const o = await pedidoDelCliente(tx, orderId, customerId);
  editable(o);
  const dir = (direccion ?? '').trim();
  if (entrega === 'DOMICILIO' && dir.length < 8) throw invalid('Para enviar a domicilio necesito la dirección completa (calle, número, barrio y ciudad).');
  await tx.query(`UPDATE "order" SET entrega=$2, direccion_entrega=$3 WHERE id=$1`, [o.id, entrega, entrega === 'DOMICILIO' ? dir.slice(0, 300) : null]);
  return vistaPedido(tx, o.id);
}

/** Total oficial e importe del cobro, calculados en el servidor con la configuración congelada del pedido. */
export function totales(o: any) {
  const totalOficial = aCentavos(Number(o.total));
  const conf: PrecioConfig = configValida(o.precio_config);
  const cobro = importeCobro(totalOficial, conf);
  return { total_oficial_centavos: totalOficial, cobro_centavos: cobro, modo: conf.modo, cargo_fijo_centavos: conf.cargo_fijo_centavos, texto: textoCobro(totalOficial, conf), conf };
}

export async function vistaPedido(tx: Tx, orderId: string) {
  const o = (await tx.query(`SELECT o.*, c.nombre AS cliente FROM "order" o JOIN customer c ON c.id=o.customer_id WHERE o.id=$1`, [orderId])).rows[0];
  if (!o) throw notFound();
  const items = (await tx.query(`SELECT product_id, descripcion, cantidad, precio_unit, total FROM order_item WHERE order_id=$1 ORDER BY descripcion`, [orderId])).rows
    .map((i: any) => ({ producto_id: i.product_id, nombre: i.descripcion, cantidad: Number(i.cantidad), precio_oficial: Number(i.precio_unit), precio_oficial_texto: pesos(aCentavos(Number(i.precio_unit))), total: Number(i.total) }));
  const t = Number(o.total) > 0 ? totales(o) : null;
  return {
    pedido_id: o.id, numero: o.numero, estado: o.pedido_estado, cliente: o.cliente, entrega: o.entrega, direccion: o.direccion_entrega, medio_pago: o.medio_pago, items,
    total_oficial: t ? t.total_oficial_centavos / 100 : 0, total_oficial_texto: t ? pesos(t.total_oficial_centavos) : pesos(0),
    cobro: t ? t.cobro_centavos / 100 : null, cobro_texto: t ? pesos(t.cobro_centavos) : null, modo_precios: t?.modo ?? null, explicacion: t?.texto ?? null,
  };
}

/**
 * Pago aprobado: el pedido se vuelve venta (CONFIRMADA), descuenta inventario y queda PAGADO. Si ya no hay
 * existencias, el pago NO se pierde: el pedido queda EN_REVISION para que el negocio lo resuelva.
 */
export async function confirmarPedidoPagado(tx: Tx, ctx: Ctx, orderId: string): Promise<'PAGADO' | 'EN_REVISION'> {
  const o = (await tx.query(`SELECT * FROM "order" WHERE id=$1 FOR UPDATE`, [orderId])).rows[0];
  if (!o) throw notFound();
  if (o.estado === 'CONFIRMADA' && o.pedido_estado === 'PAGADO') return 'PAGADO';
  const lineas = (await tx.query(`SELECT i.product_id, i.cantidad, p.controla_stock, p.precio, p.iva_pct FROM order_item i JOIN product p ON p.id=i.product_id WHERE i.order_id=$1`, [orderId])).rows;
  await tx.query('SAVEPOINT confirmar_pedido');
  try {
    for (const l of lineas) {
      if (l.controla_stock) await registerMovement(tx, ctx, { product_id: l.product_id, tipo: 'SALIDA', cantidad: Number(l.cantidad), motivo: `Pedido #${o.numero} pagado`, order_id: o.id }, { skipPerm: true });
    }
    await tx.query(`UPDATE "order" SET estado='CONFIRMADA', estado_pago='PAGADA', pedido_estado='PAGADO' WHERE id=$1`, [o.id]);
    await recordCommission(tx, ctx, o.id, null, lineas.map((l: any) => ({ product_id: l.product_id, base: calcularLinea({ precioUnitario: Number(l.precio), cantidad: Number(l.cantidad), ivaPct: Number(l.iva_pct), descuentoPct: 0 }).base })));
    await publish(tx, ctx, 'venta_registrada', { order_id: o.id, numero: o.numero, total: Number(o.total) });
    await tx.query('RELEASE SAVEPOINT confirmar_pedido');
    return 'PAGADO';
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT confirmar_pedido');
    await tx.query(`UPDATE "order" SET estado_pago='PAGADA', pedido_estado='EN_REVISION' WHERE id=$1`, [o.id]);
    await audit(tx, ctx, { accion: 'pedido.pagado_sin_confirmar', recurso: 'order', recursoId: o.id, resultado: 'ERROR', detalle: { motivo: (e as Error).message.slice(0, 200) } });
    return 'EN_REVISION';
  }
}

/** Panel: pedidos de WhatsApp con su último intento de cobro. */
export async function listarPedidos(tx: Tx, ctx: Ctx, f: { estado?: string } = {}) {
  requirePerm(ctx, 'order:read');
  const params: unknown[] = [];
  let where = 'o.pedido_estado IS NOT NULL AND o.eliminado_en IS NULL';
  if (f.estado && /^[A-Z_]{3,30}$/.test(f.estado)) { params.push(f.estado); where += ` AND o.pedido_estado=$${params.length}`; }
  const rows = (await tx.query(
    `SELECT o.id, o.numero, o.pedido_estado, o.total, o.entrega, o.direccion_entrega, o.medio_pago, o.precio_config, o.creado_en, c.nombre AS cliente,
            (SELECT row_to_json(x) FROM (SELECT cp.id, cp.referencia, cp.estado, cp.metodo, cp.modalidad, cp.monto_cobro_centavos, cp.total_oficial_centavos, cp.modo_precios, cp.comprobante_nota, cp.motivo, cp.creado_en
               FROM commerce_payment cp WHERE cp.order_id=o.id ORDER BY cp.creado_en DESC LIMIT 1) x) AS cobro,
            (SELECT string_agg(i.descripcion || ' ×' || trim(to_char(i.cantidad, 'FM999990.##')), ', ') FROM order_item i WHERE i.order_id=o.id) AS detalle
     FROM "order" o JOIN customer c ON c.id=o.customer_id WHERE ${where} ORDER BY o.creado_en DESC LIMIT 200`, params)).rows;
  return { pedidos: rows.map((r: any) => ({ ...r, total: Number(r.total) })) };
}
