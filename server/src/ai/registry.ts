import { z } from 'zod';
import type { Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import type { Permiso } from '../core/permissions.js';
import { availability, cancelAppointmentCore, customerAppointments, insertAppointment } from '../modules/agenda.js';
import { findProductsByName, lowStock } from '../modules/catalog.js';
import { insertOrder } from '../modules/orders.js';
import { escalate } from '../modules/conversations.js';
import { allQuotas } from '../core/usage.js';
import { addDays, formatFechaLarga, todayLocal, utcToLocal } from '../lib/time.js';
import { cop } from '../lib/util.js';
import { createPaymentLink } from '../modules/payments.js';

/**
 * Registro de herramientas (PRO-SW-002 fig. 07a y contrato §7.1).
 *
 * El modelo nunca toca la base de datos. Solo PROPONE una llamada a una de estas
 * herramientas; el Gateway la autoriza y el ejecutor la corre con el contexto de
 * tenant inyectado. Invariantes:
 *   1. tenant_id jamás viaja en los argumentos: lo inyecta el ejecutor.
 *   2. Un uuid que no pertenezca al tenant del contexto => «no encontrado».
 *   3. Superar limite_por_conversacion => denegar y registrar.
 */
export type NivelRiesgo = 'lectura' | 'reversible' | 'confirmable' | 'critica';
export const ORDEN_RIESGO: Record<NivelRiesgo, number> = { lectura: 0, reversible: 1, confirmable: 2, critica: 3 };

export interface ToolRuntime {
  tx: Tx;
  ctx: Ctx;
  conversationId: string | null;
  customerId: string | null; // cliente de la conversación (atención)
}

export interface ToolDef<A extends z.ZodType = z.ZodType> {
  nombre: string;
  version: string;
  modulo: string;
  descripcion: string;
  args: A;
  permiso: Permiso;
  riesgo: NivelRiesgo;
  efectos: string[];
  reversiblePor?: string;
  limitePorConversacion?: number;
  /** Requiere que exista un cliente de conversación (herramientas de atención). */
  requiereCliente?: boolean;
  /** Texto legible para pedir confirmación al humano. */
  resumen?: (a: z.infer<A>, rt: ToolRuntime) => Promise<string>;
  run: (a: z.infer<A>, rt: ToolRuntime) => Promise<Record<string, unknown>>;
}

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha local AAAA-MM-DD');
const uuid = z.uuid();

async function tz(tx: Tx) {
  return (await tx.query(`SELECT zona_horaria FROM tenant LIMIT 1`)).rows[0]?.zona_horaria ?? 'America/Bogota';
}

function def<A extends z.ZodType>(d: ToolDef<A>): ToolDef<A> { return d; }

export const TOOLS: ToolDef<any>[] = [
  def({
    nombre: 'consultar_catalogo', version: '1.0.0', modulo: 'catalogo',
    descripcion: 'Lista los servicios y productos activos del negocio con su precio (IVA incluido) y duración.',
    args: z.object({ categoria: z.string().max(60).optional() }).strict(),
    permiso: 'catalog:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => {
      const rows = (await tx.query(
        `SELECT id, tipo, nombre, categoria, precio, duracion_min FROM product WHERE eliminado_en IS NULL AND activo ${a.categoria ? 'AND categoria ILIKE $1' : ''} ORDER BY categoria, nombre`,
        a.categoria ? [`%${a.categoria}%`] : [],
      )).rows;
      return { items: rows.map((r: any) => ({ id: r.id, tipo: r.tipo, nombre: r.nombre, categoria: r.categoria, precio: Number(r.precio), precio_texto: cop(Number(r.precio)), duracion_min: r.duracion_min })) };
    },
  }),
  def({
    nombre: 'consultar_precio', version: '1.0.0', modulo: 'catalogo',
    descripcion: 'Busca un servicio o producto por nombre y devuelve su precio.',
    args: z.object({ nombre: z.string().min(2).max(80) }).strict(),
    permiso: 'catalog:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => {
      const found = await findProductsByName(tx, a.nombre);
      return { coincidencias: found.slice(0, 5).map((p) => ({ id: p.id, nombre: p.nombre, precio: p.precio, precio_texto: cop(p.precio), duracion_min: p.duracion_min })) };
    },
  }),
  def({
    nombre: 'consultar_disponibilidad', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Franjas libres para un servicio en una fecha (hoy si no se indica). Con "desde" (HH:MM) devuelve solo franjas a partir de esa hora.',
    args: z.object({ servicio_id: uuid, fecha: fecha.optional(), recurso_id: uuid.optional(), desde: z.string().regex(/^\d{2}:\d{2}$/).optional() }).strict(),
    permiso: 'appointment:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => {
      const zona = await tz(tx);
      const f = a.fecha ?? todayLocal(zona);
      const slots = await availability(tx, a.servicio_id, f, a.recurso_id ?? null, 12, a.desde ?? null);
      return { fecha: f, fecha_texto: formatFechaLarga(f), franjas: slots.map((s) => ({ inicio: s.inicio, hora: s.hora, recurso_id: s.recurso_id, recurso: s.recurso })) };
    },
  }),
  def({
    nombre: 'crear_cita', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Reserva un turno para el cliente de esta conversación en una franja libre (usa el "inicio" exacto devuelto por consultar_disponibilidad).',
    args: z.object({ servicio_id: uuid, inicio: z.iso.datetime({ offset: true }), recurso_id: uuid.optional() }).strict(),
    permiso: 'appointment:create', riesgo: 'confirmable', efectos: ['escribe appointment', 'emite evento cita_creada'],
    reversiblePor: 'cancelar_cita', limitePorConversacion: 3, requiereCliente: true,
    resumen: async (a, { tx }) => {
      const p = (await tx.query(`SELECT nombre, precio FROM product WHERE id=$1`, [a.servicio_id])).rows[0];
      const r = a.recurso_id ? (await tx.query(`SELECT nombre FROM resource WHERE id=$1`, [a.recurso_id])).rows[0] : null;
      const l = utcToLocal(new Date(a.inicio), await tz(tx));
      return `Cita de ${p?.nombre ?? 'servicio'} (${cop(Number(p?.precio ?? 0))}) el ${formatFechaLarga(l.fecha)} a las ${l.hora}${r ? ` con ${r.nombre}` : ''}`;
    },
    run: async (a, { tx, ctx, customerId }) => {
      const r = await insertAppointment(tx, ctx, { customer_id: customerId!, product_id: a.servicio_id, resource_id: a.recurso_id ?? null, inicio: a.inicio }, 'AGENTE');
      const l = utcToLocal(new Date(r.inicio), await tz(tx));
      return { appointment_id: r.id, servicio: r.servicio, recurso: r.recurso, fecha: formatFechaLarga(l.fecha), hora: l.hora };
    },
  }),
  def({
    nombre: 'mis_citas', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Citas próximas del cliente de esta conversación.',
    args: z.object({}).strict(),
    permiso: 'appointment:read', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (_a, { tx, customerId }) => ({ citas: await customerAppointments(tx, customerId!) }),
  }),
  def({
    nombre: 'cancelar_cita', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Cancela una cita próxima del cliente de esta conversación.',
    args: z.object({ cita_id: uuid }).strict(),
    permiso: 'appointment:cancel', riesgo: 'confirmable', efectos: ['actualiza appointment', 'emite evento cita_cancelada'],
    limitePorConversacion: 3, requiereCliente: true,
    resumen: async (a, { tx, customerId }) => {
      const c = (await tx.query(`SELECT a.inicio, p.nombre FROM appointment a JOIN product p ON p.id=a.product_id WHERE a.id=$1 AND a.customer_id=$2`, [a.cita_id, customerId])).rows[0];
      if (!c) return 'Cancelar una cita';
      const l = utcToLocal(new Date(c.inicio), await tz(tx));
      return `Cancelar la cita de ${c.nombre} del ${formatFechaLarga(l.fecha)} a las ${l.hora}`;
    },
    // Solo citas del propio cliente: una cita de otra persona es «no encontrada».
    run: async (a, { tx, ctx, customerId }) => cancelAppointmentCore(tx, ctx, a.cita_id, customerId!),
  }),
  def({
    nombre: 'consultar_inventario', version: '1.0.0', modulo: 'inventario',
    descripcion: 'Indica si hay existencias de un producto.',
    args: z.object({ nombre: z.string().min(2).max(80) }).strict(),
    permiso: 'inventory:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => {
      const found = (await findProductsByName(tx, a.nombre)).filter((p) => p.tipo === 'PRODUCTO');
      return { productos: found.slice(0, 5).map((p) => ({ id: p.id, nombre: p.nombre, precio_texto: cop(p.precio), disponible: !p.controla_stock || p.stock > 0 })) };
    },
  }),
  def({
    nombre: 'registrar_venta', version: '1.0.0', modulo: 'ventas',
    descripcion: 'Registra una venta de productos o servicios al cliente de esta conversación. La factura electrónica se emite automáticamente.',
    args: z.object({ items: z.array(z.object({ producto_id: uuid, cantidad: z.number().int().positive().max(20) }).strict()).min(1).max(10) }).strict(),
    permiso: 'order:create', riesgo: 'confirmable', efectos: ['escribe order', 'descuenta inventario', 'emite evento venta_registrada'],
    limitePorConversacion: 2, requiereCliente: true,
    resumen: async (a, { tx }) => {
      const ps = (await tx.query(`SELECT id, nombre, precio FROM product WHERE id = ANY($1::uuid[])`, [a.items.map((i: any) => i.producto_id)])).rows;
      let total = 0;
      const partes = a.items.map((i: any) => {
        const p = ps.find((x: any) => x.id === i.producto_id);
        total += Number(p?.precio ?? 0) * i.cantidad;
        return `${i.cantidad} × ${p?.nombre ?? '?'}`;
      });
      return `Compra: ${partes.join(', ')}. Total ${cop(total)} (IVA incluido)`;
    },
    run: async (a, { tx, ctx, customerId, conversationId }) => {
      const r = await insertOrder(tx, ctx, { customer_id: customerId!, items: a.items.map((i: any) => ({ product_id: i.producto_id, cantidad: i.cantidad })) }, { origen: 'AGENTE', conversation_id: conversationId });
      return { order_id: r.id, numero: r.numero, total: r.total, total_texto: cop(r.total) };
    },
  }),
  def({
    nombre: 'generar_enlace_pago', version: '1.0.0', modulo: 'ventas',
    descripcion: 'Genera un enlace de pago de la cuenta de pasarela propia del negocio para una venta del cliente.',
    args: z.object({ order_id: uuid }).strict(),
    permiso: 'payment:link', riesgo: 'reversible', efectos: ['escribe payment_link'], limitePorConversacion: 3, requiereCliente: true,
    run: async (a, { tx, ctx, customerId }) => {
      const o = (await tx.query(`SELECT id FROM "order" WHERE id=$1 AND customer_id=$2`, [a.order_id, customerId])).rows[0];
      if (!o) return { error: 'no_encontrado' };
      return createPaymentLink(tx, ctx, a.order_id, { skipPerm: true });
    },
  }),
  def({
    nombre: 'estado_factura', version: '1.0.0', modulo: 'facturacion',
    descripcion: 'Estado de las facturas electrónicas de las compras recientes del cliente.',
    args: z.object({}).strict(),
    permiso: 'invoice:read', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (_a, { tx, customerId }) => ({
      facturas: (await tx.query(
        `SELECT f.numero, f.estado, f.total, o.numero AS orden FROM fiscal_document f JOIN "order" o ON o.id=f.order_id
         WHERE o.customer_id=$1 AND f.tipo='FACTURA' ORDER BY f.creado_en DESC LIMIT 5`, [customerId])).rows
        .map((f: any) => ({ numero: f.numero, estado: f.estado, orden: f.orden, total_texto: cop(Number(f.total)) })),
    }),
  }),
  def({
    nombre: 'escalar_a_humano', version: '1.0.0', modulo: 'conversaciones',
    descripcion: 'Transfiere la conversación a una persona del equipo. Úsala para reclamos, reembolsos o lo que no puedas resolver.',
    args: z.object({ motivo: z.string().min(3).max(300), prioridad: z.enum(['BAJA', 'MEDIA', 'ALTA', 'URGENTE']).default('MEDIA') }).strict(),
    permiso: 'case:create', riesgo: 'reversible', efectos: ['crea support_case', 'cede el control a una persona'], limitePorConversacion: 1,
    run: async (a, { tx, ctx, conversationId }) => {
      if (!conversationId) return { error: 'sin_conversacion' };
      const r = await escalate(tx, ctx, conversationId, a.motivo, a.prioridad);
      return { radicado: r.radicado, escalado: true };
    },
  }),
  // ---- Asistente del negocio (panel) ----------------------------------------
  def({
    nombre: 'resumen_ventas', version: '1.0.0', modulo: 'ventas',
    descripcion: 'Total vendido, número de ventas y ticket promedio en un rango de días (por defecto los últimos 7).',
    args: z.object({ dias: z.number().int().min(1).max(90).default(7) }).strict(),
    permiso: 'order:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => {
      const r = (await tx.query(
        `SELECT count(*)::int AS n, coalesce(sum(total),0) AS total FROM "order" WHERE estado='CONFIRMADA' AND creado_en > now() - ($1 || ' days')::interval`,
        [String(a.dias)],
      )).rows[0];
      const top = (await tx.query(
        `SELECT i.descripcion, sum(i.cantidad)::float AS unidades, sum(i.total)::float AS total FROM order_item i JOIN "order" o ON o.id=i.order_id
         WHERE o.estado='CONFIRMADA' AND o.creado_en > now() - ($1 || ' days')::interval GROUP BY i.descripcion ORDER BY total DESC LIMIT 5`,
        [String(a.dias)],
      )).rows;
      const total = Number(r.total);
      return { dias: a.dias, ventas: r.n, total, total_texto: cop(total), ticket_promedio: r.n ? cop(total / r.n) : cop(0), mas_vendidos: top };
    },
  }),
  def({
    nombre: 'citas_del_dia', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Citas de una fecha (hoy por defecto) con cliente, servicio y recurso.',
    args: z.object({ fecha: fecha.optional() }).strict(),
    permiso: 'appointment:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => {
      const zona = await tz(tx);
      const f = a.fecha ?? todayLocal(zona);
      const rows = (await tx.query(
        `SELECT a.inicio, a.estado, a.origen, c.nombre AS cliente, p.nombre AS servicio, r.nombre AS recurso FROM appointment a
         JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
         WHERE a.inicio >= $1 AND a.inicio < $2 ORDER BY a.inicio`,
        [new Date(`${f}T00:00:00-05:00`).toISOString(), new Date(`${addDays(f, 1)}T00:00:00-05:00`).toISOString()],
      )).rows;
      return { fecha: f, citas: rows.map((r: any) => ({ ...r, hora: utcToLocal(new Date(r.inicio), zona).hora })) };
    },
  }),
  def({
    nombre: 'stock_bajo_minimo', version: '1.0.0', modulo: 'inventario',
    descripcion: 'Productos con existencias en o por debajo del mínimo.',
    args: z.object({}).strict(),
    permiso: 'inventory:read', riesgo: 'lectura', efectos: [],
    run: async (_a, { tx }) => ({ productos: await lowStock(tx) }),
  }),
  def({
    nombre: 'buscar_cliente', version: '1.0.0', modulo: 'clientes',
    descripcion: 'Busca clientes por nombre o teléfono.',
    args: z.object({ texto: z.string().min(2).max(80) }).strict(),
    permiso: 'customer:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => ({
      clientes: (await tx.query(
        `SELECT id, nombre, telefono, email FROM customer WHERE eliminado_en IS NULL AND (nombre ILIKE $1 OR telefono ILIKE $1) LIMIT 5`,
        [`%${a.texto}%`],
      )).rows,
    }),
  }),
  def({
    nombre: 'historial_cliente', version: '1.0.0', modulo: 'clientes',
    descripcion: 'Últimas compras y citas del cliente de la conversación.',
    args: z.object({}).strict(),
    permiso: 'customer:read', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (_a, { tx, customerId }) => ({
      compras: (await tx.query(`SELECT numero, total, creado_en FROM "order" WHERE customer_id=$1 ORDER BY creado_en DESC LIMIT 5`, [customerId])).rows
        .map((o: any) => ({ ...o, total: cop(Number(o.total)) })),
      citas: (await tx.query(`SELECT a.inicio, a.estado, p.nombre FROM appointment a JOIN product p ON p.id=a.product_id WHERE a.customer_id=$1 ORDER BY a.inicio DESC LIMIT 5`, [customerId])).rows,
    }),
  }),
  def({
    nombre: 'consumo_del_plan', version: '1.0.0', modulo: 'suscripcion',
    descripcion: 'Consumo del mes frente a la cuota del plan, con proyección al cierre.',
    args: z.object({}).strict(),
    permiso: 'usage:read', riesgo: 'lectura', efectos: [],
    run: async (_a, { tx, ctx }) => ({ consumo: await allQuotas(tx, ctx.tenantId) }),
  }),
  def({
    nombre: 'ayuda_plataforma', version: '1.0.0', modulo: 'soporte',
    descripcion: 'Guía de uso de la plataforma: cómo hacer tareas comunes en el panel.',
    args: z.object({ tema: z.enum(['facturacion', 'agenda', 'catalogo', 'usuarios', 'ia', 'suscripcion', 'whatsapp']) }).strict(),
    permiso: 'ai:assist', riesgo: 'lectura', efectos: [],
    run: async (a) => ({ tema: a.tema, guia: AYUDA[a.tema] }),
  }),
  // ---- Crítica: existe en el registro, pero ningún rol de agente tiene su permiso.
  def({
    nombre: 'emitir_nota_credito', version: '1.0.0', modulo: 'facturacion',
    descripcion: 'Emite una nota crédito que anula fiscalmente una factura validada.',
    args: z.object({ documento_id: uuid, motivo: z.string().min(5).max(300) }).strict(),
    permiso: 'invoice:void', riesgo: 'critica', efectos: ['escribe fiscal_document', 'transmite a la DIAN'],
    run: async () => ({ error: 'las acciones críticas solo las ejecuta una persona desde el panel' }),
  }),
];

const AYUDA: Record<string, string> = {
  facturacion: 'Las ventas confirmadas generan la factura electrónica automáticamente. En Facturación ves su estado ante la DIAN; si una es rechazada, corrige el dato indicado (por ejemplo el NIT del cliente) y pulsa «Corregir y reintentar». Un documento validado no se borra: se anula con nota crédito desde el detalle de la venta.',
  agenda: 'En Agenda ves el día por recurso. Las citas creadas por el agente llevan la marca IA. Puedes confirmar, marcar como atendida o cancelar desde cada cita.',
  catalogo: 'En Inventario y Catálogo puedes crear servicios y productos. Los precios incluyen IVA. Para cargar muchos a la vez usa la importación desde hoja de cálculo en Configuración.',
  usuarios: 'En Configuración > Personas invitas a tu equipo y asignas su rol. La matriz de permisos muestra qué puede hacer cada rol.',
  ia: 'En el Centro de IA ves el registro de herramientas con su nivel de riesgo y puedes apagar cualquiera. Todas las acciones, permitidas o bloqueadas, quedan registradas con su recibo.',
  suscripcion: 'En Suscripción ves tu plan, el consumo del mes con su proyección y el estado de pagos. Si la suscripción se suspende conservas lectura y exportación.',
  whatsapp: 'Tus clientes escriben al número de WhatsApp del negocio. El agente responde y, si hace falta, escala a una persona; tú respondes siempre desde Conversaciones.',
};

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.nombre, t]));

/** Esquema JSON de los argumentos, para exponer la herramienta al modelo. */
export function toolJsonSchema(t: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(t.args, { target: 'draft-7' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
