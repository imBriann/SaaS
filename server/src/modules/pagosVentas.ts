import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { zonaDe } from '../core/tenant.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { cop, isUuid, uuidv7 } from '../lib/util.js';
import { aCentavos, aPesos } from '../lib/money.js';
import { rangoDia, todayLocal } from '../lib/time.js';

/**
 * Pagos de las ventas.
 *
 *  - Efectivo, transferencia y datáfono los registra una persona del negocio: es una operación interna,
 *    no pasa por ninguna pasarela y no marca nada en Wompi.
 *  - La pasarela (Wompi) solo se registra cuando llega su evento firmado (payments.ts).
 *  - No hay pagos parciales ni abonos (el producto no los maneja): una venta queda pagada con un pago
 *    vigente por su total. La base lo garantiza con un índice único sobre el pago vigente.
 *  - Un pago no se borra ni se edita: se anula con motivo y queda en el historial y la auditoría.
 */
export const METODOS_MANUALES = ['EFECTIVO', 'TRANSFERENCIA', 'DATAFONO'] as const;
export type MetodoManual = (typeof METODOS_MANUALES)[number];
export type MetodoPago = MetodoManual | 'PASARELA';
export const ETIQUETA_METODO: Record<MetodoPago, string> = {
  EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', DATAFONO: 'Tarjeta (datáfono)', PASARELA: 'Pasarela de pagos',
};

const MAX_RECIBIDO = 999_999_999;

/** Métodos que el negocio acepta. Sin configuración: efectivo y transferencia. La pasarela, si vinculó su cuenta. */
export async function metodosDePago(tx: Tx) {
  const s = (await tx.query(`SELECT efectivo, transferencia, datafono, actualizado_en, actualizado_por FROM payment_settings LIMIT 1`)).rows[0];
  const pasarela = !!(await tx.query(`SELECT 1 FROM merchant_gateway_account LIMIT 1`)).rows[0];
  return {
    EFECTIVO: s ? !!s.efectivo : true,
    TRANSFERENCIA: s ? !!s.transferencia : true,
    DATAFONO: s ? !!s.datafono : false,
    PASARELA: pasarela,
    actualizado_en: s?.actualizado_en ?? null,
    actualizado_por: s?.actualizado_por ?? null,
  };
}

const MetodosInput = z.object({ EFECTIVO: z.boolean(), TRANSFERENCIA: z.boolean(), DATAFONO: z.boolean() }).strict();

export async function guardarMetodos(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = MetodosInput.parse(body ?? {});
  const antes = await metodosDePago(tx);
  if (!d.EFECTIVO && !d.TRANSFERENCIA && !d.DATAFONO && !antes.PASARELA) throw invalid('Deja al menos un método activo para poder registrar pagos.');
  await tx.query(
    `INSERT INTO payment_settings (tenant_id, efectivo, transferencia, datafono, actualizado_en, actualizado_por) VALUES ($1,$2,$3,$4, now(), $5)
     ON CONFLICT (tenant_id) DO UPDATE SET efectivo=EXCLUDED.efectivo, transferencia=EXCLUDED.transferencia, datafono=EXCLUDED.datafono, actualizado_en=now(), actualizado_por=EXCLUDED.actualizado_por`,
    [ctx.tenantId, d.EFECTIVO, d.TRANSFERENCIA, d.DATAFONO, ctx.actor.nombre]);
  await audit(tx, ctx, { accion: 'cobros.metodos', recurso: 'payment_settings', resultado: 'EXITO', detalle: { antes: { EFECTIVO: antes.EFECTIVO, TRANSFERENCIA: antes.TRANSFERENCIA, DATAFONO: antes.DATAFONO }, despues: d } });
  return metodosDePago(tx);
}

export const PagoInput = z.object({
  metodo: z.enum(METODOS_MANUALES, 'Elige cómo se pagó: efectivo, transferencia o datáfono.'),
  recibido: z.number('Escribe el valor recibido.').positive('El valor recibido debe ser mayor que cero.').max(MAX_RECIBIDO, 'El valor recibido es demasiado alto.').optional().nullable(),
  referencia: z.string().trim().max(80, 'La referencia es demasiado larga.').optional().nullable(),
  /** Generada por el navegador al abrir el formulario: un reenvío (doble clic, red) no registra dos pagos. */
  clave: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional().nullable(),
}).strict();
export type PagoData = z.infer<typeof PagoInput>;

const filaPago = (p: any) => ({
  id: p.id, metodo: p.metodo, metodo_nombre: ETIQUETA_METODO[p.metodo as MetodoPago] ?? p.metodo, monto: Number(p.monto),
  recibido: p.recibido == null ? null : Number(p.recibido), cambio: Number(p.cambio ?? 0), referencia: p.referencia, estado: p.estado, origen: p.origen,
  registrado_por: p.registrado_por_nombre, creado_en: p.creado_en,
  anulado_en: p.anulado_en, anulado_por: p.anulado_por_nombre, motivo_anulacion: p.motivo_anulacion,
});

/**
 * Registra el pago de una venta confirmada. Valida el valor recibido (efectivo), calcula el cambio en
 * centavos, deja la venta pagada y cierra los enlaces de pago abiertos para que nadie la pague dos veces.
 */
export async function registrarPago(tx: Tx, ctx: Ctx, orderId: string, body: unknown) {
  requirePerm(ctx, 'payment:register');
  requireWritable(ctx);
  if (!isUuid(orderId)) throw notFound();
  const d = PagoInput.parse(body ?? {});
  if (d.clave) {
    const previo = (await tx.query(`SELECT * FROM order_payment WHERE clave_idempotencia=$1`, [d.clave])).rows[0];
    if (previo) {
      if (previo.order_id !== orderId) throw new AppError('CONFLICT', 'Ese registro de pago pertenece a otra venta. Recarga la página.');
      return { ...filaPago(previo), repetido: true };
    }
  }
  const o = (await tx.query(`SELECT id, numero, total, estado, estado_pago FROM "order" WHERE id=$1 AND eliminado_en IS NULL FOR UPDATE`, [orderId])).rows[0];
  if (!o) throw notFound();
  if (o.estado !== 'CONFIRMADA') throw new AppError('CONFLICT', 'Solo se registran pagos de ventas confirmadas: esta venta está anulada.');
  if (o.estado_pago === 'PAGADA') throw new AppError('CONFLICT', 'Esta venta ya está pagada. Si el pago registrado tiene un error, anúlalo primero y registra el correcto.');
  const metodos = await metodosDePago(tx);
  if (!metodos[d.metodo]) throw invalid(`${ETIQUETA_METODO[d.metodo]} no está habilitado como método de pago. Actívalo en Configuración › Cobros.`);

  const total = aCentavos(o.total);
  let recibido: number | null = null;
  let cambio = 0;
  if (d.metodo === 'EFECTIVO') {
    recibido = d.recibido == null ? total : aCentavos(d.recibido);
    if (recibido < total) throw invalid(`El efectivo recibido no alcanza: faltan ${cop(aPesos(total - recibido))}. La venta se paga completa (no se registran abonos).`, { campo: 'recibido' });
    cambio = recibido - total;
  } else if (d.recibido != null) {
    throw invalid('El valor recibido y el cambio solo aplican al efectivo.');
  }
  const id = uuidv7();
  await tx.query(
    `INSERT INTO order_payment (id, tenant_id, order_id, metodo, monto, recibido, cambio, referencia, estado, origen, registrado_por, registrado_por_nombre, clave_idempotencia)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REGISTRADO','PANEL',$9,$10,$11)`,
    [id, ctx.tenantId, o.id, d.metodo, aPesos(total), recibido == null ? null : aPesos(recibido), aPesos(cambio), d.referencia || null,
      ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null, ctx.actor.nombre, d.clave ?? null]);
  await tx.query(`UPDATE "order" SET estado_pago='PAGADA' WHERE id=$1`, [o.id]);
  // Un enlace de pago que siguiera abierto permitiría cobrar dos veces la misma venta.
  const enlaces = (await tx.query(`UPDATE payment_link SET estado='EXPIRADO', actualizado_en=now() WHERE order_id=$1 AND estado='ABIERTO' RETURNING referencia`, [o.id])).rows.length;
  await audit(tx, ctx, {
    accion: 'pago.registrar', recurso: 'order', recursoId: o.id, resultado: 'EXITO',
    detalle: { numero: o.numero, metodo: d.metodo, monto: aPesos(total), recibido: recibido == null ? null : aPesos(recibido), cambio: aPesos(cambio), enlaces_cerrados: enlaces, pago: id },
  });
  return filaPago((await tx.query(`SELECT * FROM order_payment WHERE id=$1`, [id])).rows[0]);
}

const AnularInput = z.object({ motivo: z.string().trim().min(5, 'Explica el motivo de la anulación (mínimo 5 caracteres).').max(300) });

/** Anula un pago registrado por error. La venta vuelve a quedar por cobrar; el pago queda en el historial. */
export async function anularPago(tx: Tx, ctx: Ctx, orderId: string, pagoId: string, body: unknown) {
  requirePerm(ctx, 'payment:void');
  requireWritable(ctx);
  if (!isUuid(orderId) || !isUuid(pagoId)) throw notFound();
  const d = AnularInput.parse(body ?? {});
  const p = (await tx.query(`SELECT * FROM order_payment WHERE id=$1 AND order_id=$2 FOR UPDATE`, [pagoId, orderId])).rows[0];
  if (!p) throw notFound();
  if (p.estado === 'ANULADO') throw new AppError('CONFLICT', 'Ese pago ya está anulado.');
  if (p.metodo === 'PASARELA' && p.estado === 'REGISTRADO') {
    throw new AppError('CONFLICT', 'Un pago confirmado por la pasarela no se anula aquí. Si devolviste el dinero en Wompi, anula la venta.');
  }
  await tx.query(
    `UPDATE order_payment SET estado='ANULADO', anulado_en=now(), anulado_por=$2, anulado_por_nombre=$3, motivo_anulacion=$4 WHERE id=$1`,
    [p.id, ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null, ctx.actor.nombre, d.motivo]);
  if (p.estado === 'REGISTRADO') await tx.query(`UPDATE "order" SET estado_pago='PENDIENTE' WHERE id=$1 AND estado='CONFIRMADA'`, [orderId]);
  await audit(tx, ctx, { accion: 'pago.anular', recurso: 'order', recursoId: orderId, resultado: 'EXITO', detalle: { pago: p.id, metodo: p.metodo, monto: Number(p.monto), estado_anterior: p.estado, motivo: d.motivo } });
  return { ok: true };
}

/** Al anular una venta, sus pagos quedan anulados con el mismo motivo (la devolución del dinero es por fuera). */
export async function anularPagosDeVenta(tx: Tx, ctx: Ctx, orderId: string, motivo: string) {
  return (await tx.query(
    `UPDATE order_payment SET estado='ANULADO', anulado_en=now(), anulado_por=$2, anulado_por_nombre=$3, motivo_anulacion=$4
     WHERE order_id=$1 AND estado IN ('REGISTRADO','EXCEDENTE') RETURNING id, metodo, monto`,
    [orderId, ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null, ctx.actor.nombre, `Venta anulada: ${motivo}`.slice(0, 300)])).rows;
}

export async function pagosDeVenta(tx: Tx, orderId: string) {
  return (await tx.query(`SELECT * FROM order_payment WHERE order_id=$1 ORDER BY creado_en`, [orderId])).rows.map(filaPago);
}

/**
 * Cierre de caja de un día: lo cobrado por método (por fecha del pago, no de la venta), el efectivo
 * recibido y el cambio entregado, lo anulado y lo que quedó por cobrar de las ventas del día.
 */
export async function cajaDelDia(tx: Tx, ctx: Ctx, fecha?: string) {
  requirePerm(ctx, 'order:read');
  const zona = await zonaDe(tx);
  const dia = /^\d{4}-\d{2}-\d{2}$/.test(fecha ?? '') ? fecha! : todayLocal(zona);
  const { desde, hasta } = rangoDia(dia, zona);
  const grupos = (await tx.query(
    `SELECT metodo, estado, count(*)::int AS n, coalesce(sum(monto),0) AS monto, coalesce(sum(recibido),0) AS recibido, coalesce(sum(cambio),0) AS cambio
     FROM order_payment WHERE creado_en >= $1 AND creado_en < $2 GROUP BY metodo, estado`, [desde.toISOString(), hasta.toISOString()])).rows;
  const vigentes = grupos.filter((g: any) => g.estado === 'REGISTRADO');
  const metodos = (['EFECTIVO', 'TRANSFERENCIA', 'DATAFONO', 'PASARELA'] as MetodoPago[]).map((m) => {
    const g = vigentes.find((x: any) => x.metodo === m);
    return { metodo: m, nombre: ETIQUETA_METODO[m], pagos: g?.n ?? 0, total: Number(g?.monto ?? 0) };
  });
  const ef = vigentes.find((x: any) => x.metodo === 'EFECTIVO');
  const anulados = grupos.filter((g: any) => g.estado === 'ANULADO');
  const excedentes = grupos.filter((g: any) => g.estado === 'EXCEDENTE');
  const ventas = (await tx.query(
    `SELECT count(*)::int AS n, coalesce(sum(total),0) AS total, count(*) FILTER (WHERE estado_pago <> 'PAGADA')::int AS por_cobrar, coalesce(sum(total) FILTER (WHERE estado_pago <> 'PAGADA'),0) AS total_por_cobrar
     FROM "order" WHERE estado='CONFIRMADA' AND eliminado_en IS NULL AND creado_en >= $1 AND creado_en < $2`, [desde.toISOString(), hasta.toISOString()])).rows[0];
  const detalle = (await tx.query(
    `SELECT p.*, o.numero, c.nombre AS cliente FROM order_payment p JOIN "order" o ON o.id=p.order_id JOIN customer c ON c.id=o.customer_id
     WHERE p.creado_en >= $1 AND p.creado_en < $2 ORDER BY p.creado_en DESC LIMIT 300`, [desde.toISOString(), hasta.toISOString()])).rows
    .map((p: any) => ({ ...filaPago(p), venta_id: p.order_id, venta: p.numero, cliente: p.cliente }));
  return {
    fecha: dia, zona, metodos,
    total_cobrado: metodos.reduce((a, m) => a + m.total, 0),
    efectivo: { recibido: Number(ef?.recibido ?? 0), cambio: Number(ef?.cambio ?? 0), neto: Number(ef?.monto ?? 0) },
    anulados: { pagos: anulados.reduce((a: number, g: any) => a + g.n, 0), total: anulados.reduce((a: number, g: any) => a + Number(g.monto), 0) },
    excedentes: { pagos: excedentes.reduce((a: number, g: any) => a + g.n, 0), total: excedentes.reduce((a: number, g: any) => a + Number(g.monto), 0) },
    ventas: { n: ventas.n, total: Number(ventas.total), por_cobrar: ventas.por_cobrar, total_por_cobrar: Number(ventas.total_por_cobrar) },
    detalle,
  };
}

/** Lo cobrado por método en los últimos `dias` (lo usa el asistente para responder «¿cuánto entró en efectivo?»). */
export async function cobradoPorMetodo(tx: Tx, dias: number) {
  return (await tx.query(
    `SELECT metodo, count(*)::int AS pagos, coalesce(sum(monto),0)::float AS total FROM order_payment
     WHERE estado='REGISTRADO' AND creado_en > now() - ($1 || ' days')::interval GROUP BY metodo ORDER BY 3 DESC`, [String(dias)])).rows
    .map((r: any) => ({ metodo: ETIQUETA_METODO[r.metodo as MetodoPago] ?? r.metodo, pagos: r.pagos, total: r.total, total_texto: cop(r.total) }));
}
