import { z } from 'zod';
import type { Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import type { Permiso } from '../core/permissions.js';
import { alternatives, availability, cancelAppointmentCore, customerAppointments, insertAppointment, ListaEsperaInput, moverCita, unirseListaEspera } from '../modules/agenda.js';
import { addMessage } from '../modules/conversations.js';
import { ajustesIA } from './politica.js';
import { AppError } from '../lib/errors.js';
import { evaluarMensaje } from './escalamiento.js';
import { escalarPorRegla } from './escalar.js';
import { urlPublica } from '../modules/imagenes.js';
import { ventanaAbierta } from '../modules/conversations.js';
import { createProduct, findProductsByName, lowStock, updateProduct } from '../modules/catalog.js';
import { insertOrder } from '../modules/orders.js';
import { escalate } from '../modules/conversations.js';
import { allQuotas } from '../core/usage.js';
import { addDays, formatFechaLarga, rangoDia, todayLocal, utcToLocal } from '../lib/time.js';
import { zonaDe } from '../core/tenant.js';
import { cop } from '../lib/util.js';
import { createPaymentLink } from '../modules/payments.js';
import { cobradoPorMetodo } from '../modules/pagosVentas.js';
import { GUIAS, IDS_GUIA } from './guias.js';
import { HERRAMIENTAS_COMERCIO } from '../comercio/herramientas.js';
import { delCliente as comprobantesDelCliente, reenviar as reenviarComprobante } from '../modules/comprobantes.js';

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
  /** Asistente del panel: persona que debe confirmar las acciones y su conversación con el asistente. */
  solicitante?: string | null;
  hiloId?: string | null;
  /** Permisos propios de la persona que pregunta (las guías no ofrecen lo que su rol no puede hacer). */
  permisosSolicitante?: ReadonlySet<string>;
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
  /** Se ofrece solo si la empresa tiene activa la función (p. ej. pagos de pedidos). */
  disponible?: (tx: Tx) => Promise<boolean>;
  /** Monto de la acción (ventas), para la política de aprobación del modo SUPERVISADO. */
  monto?: (a: z.infer<A>, rt: ToolRuntime) => Promise<number>;
  /** Texto legible para pedir confirmación al humano. */
  resumen?: (a: z.infer<A>, rt: ToolRuntime) => Promise<string>;
  run: (a: z.infer<A>, rt: ToolRuntime) => Promise<Record<string, unknown>>;
}

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha local AAAA-MM-DD');
const uuid = z.uuid();

const tz = zonaDe;

function def<A extends z.ZodType>(d: ToolDef<A>): ToolDef<A> { return d; }

/**
 * Guía del panel. Cada texto describe pantallas y botones que existen en web/src (verificado contra el código:
 * rutas de main.tsx, menú de Layout.tsx y etiquetas de cada pantalla). Si una pantalla cambia, se cambia aquí.
 */
export const TEMAS_AYUDA = ['facturacion', 'agenda', 'catalogo', 'usuarios', 'ia', 'suscripcion', 'whatsapp', 'cobros', 'conversaciones'] as const;
export const AYUDA: Record<(typeof TEMAS_AYUDA)[number], string> = {
  facturacion: 'La factura electrónica DIAN llegará más adelante («Próximamente»). Mientras tanto, en el detalle de una venta confirmada pulsa «Generar comprobante»: es un comprobante de venta para entregarle a tu cliente y llevar tu registro, NO una factura electrónica ni tiene validez ante la DIAN (lo dice el propio documento). En Comprobantes ves todos, los descargas, los reenvías por correo o WhatsApp, los exportas como libro de ventas y los anulas con motivo (un comprobante anulado no se borra). El prefijo, el régimen de IVA y los datos que salen en el PDF se ajustan en Configuración › Comprobantes.',
  agenda: 'En Agenda ves el día por persona o espacio (vistas «Por horas» y «Lista»). Con «Nueva cita» agendas en una franja libre; al tocar una cita puedes confirmarla, reprogramarla, marcarla como atendida o «No asistió», o cancelarla. Las citas que agendó el asistente de WhatsApp llevan la marca IA. Los horarios de atención se ajustan en Configuración › Horarios.',
  catalogo: 'En Catálogo (menú de la izquierda) creas productos y servicios con «Nuevo ítem» y los cambias con «Editar». Para cargar muchos a la vez usa «Importar» en esa misma pantalla, con un archivo .xlsx o .csv (allí hay una plantilla de ejemplo); revisas las filas antes de guardar. Los precios incluyen IVA. Un ítem que ya no ofreces se desactiva con la casilla «Activo» al editarlo: no se borra. La sección «Por revisar» señala ítems con datos incompletos. Si tu rol puede editar el catálogo, también puedo crear o editar ítems por ti: te muestro el cambio y tú lo confirmas antes de guardar.',
  usuarios: 'En Configuración › Equipo y comisiones, en «Personas con acceso», invitas a alguien con «Invitar» y eliges su rol; ahí mismo cambias el rol, decides quién recibe radicados o retiras el acceso. La tabla «Qué puede hacer cada rol» muestra los permisos de cada rol.',
  ia: 'En Centro de IA activas o apagas cada asistente y cada acción que pueden hacer, ves su actividad reciente y las acciones bloqueadas, y fijas un «Límite de gasto de IA» si quieres un tope menor que el de tu plan. Cada acción queda con su recibo en Auditoría.',
  suscripcion: 'En Suscripción ves el estado, el periodo y el consumo del mes; pagas o renuevas con Wompi (no hay cobros automáticos) y descargas los comprobantes en «Documentos de tus pagos». Si la suscripción se suspende, tu equipo conserva la lectura y la exportación de los datos.',
  whatsapp: 'En «Número de WhatsApp» eliges «Usar mi propio número»: escribes el número, recibes un código por SMS o llamada y queda conectado, sin entrar a Meta ni copiar identificadores. Ahí ves el estado, pruebas la conexión enviando un mensaje a un celular y desconectas el número. Comprar un número nuevo y conectar tu propia cuenta de WhatsApp Business llegarán más adelante. Tus clientes escriben a ese número; el asistente responde y, si hace falta, pasa la conversación a una persona con un radicado. Tu equipo responde siempre desde Conversaciones.',
  cobros: 'Al registrar una venta eliges cómo se pagó (efectivo, transferencia o datáfono) o la dejas por cobrar. En efectivo escribes lo que entregó el cliente y se calcula el cambio; no se registran abonos: la venta se paga completa. Una venta por cobrar se paga después desde su detalle con «Registrar pago», y con tu cuenta de Wompi vinculada puedes enviar un «Enlace de pago». Un pago registrado por error se anula con motivo (queda en el historial). Los métodos se activan en Configuración › Cobros y el resumen del día está en Ventas, en «Caja del día».',
  conversaciones: 'En Conversaciones ves los chats de WhatsApp de tus clientes, quién atiende cada uno (la IA o una persona) y sus radicados. Al responder tomas la conversación y la IA deja de contestar; con «Devolver a la IA» vuelve a atender. Las notas internas solo las ve tu equipo. Si el soporte de Omnegia necesita revisar una conversación, quien administra la empresa puede compartirla por un tiempo con «Compartir con soporte».',
};

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
      // Sin cupo ese día: los 3 huecos más cercanos, no una lista larga.
      const cercanas = slots.length ? [] : await alternatives(tx, a.servicio_id, new Date(`${f}T${a.desde ?? '12:00'}:00-05:00`), a.recurso_id ?? null, 3);
      return {
        fecha: f, fecha_texto: formatFechaLarga(f), franjas: slots.map((s) => ({ inicio: s.inicio, hora: s.hora, recurso_id: s.recurso_id, recurso: s.recurso })),
        ...(cercanas.length ? { sin_cupo_ese_dia: true, mas_cercanas: cercanas.map((s) => ({ inicio: s.inicio, fecha: formatFechaLarga(s.fecha!), hora: s.hora, recurso_id: s.recurso_id, recurso: s.recurso })) } : {}),
      };
    },
  }),
  def({
    nombre: 'crear_cita', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Reserva un turno para el cliente de esta conversación en una franja libre (usa el "inicio" exacto devuelto por consultar_disponibilidad). Si el cliente ya dijo servicio, día y hora exactos, úsala de una vez: el sistema decide si hace falta su confirmación. En "notas" pon lo útil para el negocio (nombre de la mascota, a nombre de quién).',
    args: z.object({ servicio_id: uuid, inicio: z.iso.datetime({ offset: true }), recurso_id: uuid.optional(), notas: z.string().max(200).optional() }).strict(),
    permiso: 'appointment:create', riesgo: 'confirmable', efectos: ['escribe appointment', 'emite evento cita_creada'],
    reversiblePor: 'cancelar_cita', limitePorConversacion: 3, requiereCliente: true,
    resumen: async (a, { tx }) => {
      const p = (await tx.query(`SELECT nombre, precio FROM product WHERE id=$1`, [a.servicio_id])).rows[0];
      const r = a.recurso_id ? (await tx.query(`SELECT nombre FROM resource WHERE id=$1`, [a.recurso_id])).rows[0] : null;
      const l = utcToLocal(new Date(a.inicio), await tz(tx));
      return `Cita de ${p?.nombre ?? 'servicio'} (${cop(Number(p?.precio ?? 0))}) el ${formatFechaLarga(l.fecha)} a las ${l.hora}${r ? ` con ${r.nombre}` : ''}`;
    },
    run: async (a, { tx, ctx, customerId }) => {
      const r = await insertAppointment(tx, ctx, { customer_id: customerId!, product_id: a.servicio_id, resource_id: a.recurso_id ?? null, inicio: a.inicio, notas: a.notas ?? null }, 'AGENTE');
      const l = utcToLocal(new Date(r.inicio), await tz(tx));
      return { appointment_id: r.id, servicio: r.servicio, recurso: r.recurso, fecha: formatFechaLarga(l.fecha), hora: l.hora, estado: r.estado };
    },
  }),
  def({
    nombre: 'reprogramar_cita', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Mueve una cita próxima del cliente de esta conversación a otra franja libre (usa el "inicio" exacto de consultar_disponibilidad). Respeta la política de horas del negocio.',
    args: z.object({ cita_id: uuid, inicio: z.iso.datetime({ offset: true }), recurso_id: uuid.optional() }).strict(),
    permiso: 'appointment:create', riesgo: 'confirmable', efectos: ['actualiza appointment', 'emite evento cita_reprogramada'], limitePorConversacion: 3, requiereCliente: true,
    resumen: async (a, { tx }) => {
      const l = utcToLocal(new Date(a.inicio), await tz(tx));
      return `Mover tu cita al ${formatFechaLarga(l.fecha)} a las ${l.hora}`;
    },
    // Solo citas del propio cliente: una cita de otra persona es «no encontrada».
    run: async (a, { tx, ctx, customerId }) => {
      const r = await moverCita(tx, ctx, a.cita_id, { inicio: a.inicio, resource_id: a.recurso_id ?? null }, { soloCliente: customerId!, origen: 'AGENTE' });
      return { appointment_id: r.id, servicio: r.servicio, fecha: r.fecha, hora: r.hora, recurso: r.recurso };
    },
  }),
  def({
    nombre: 'unirse_lista_espera', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Anota al cliente en la lista de espera de un servicio cuando no hay cupo en las fechas que quiere. Si se libera un cupo, se le ofrece por este chat.',
    args: z.object({ servicio_id: uuid, desde: fecha, hasta: fecha, franjas: z.array(z.enum(['MANANA', 'TARDE', 'NOCHE'])).min(1).max(3).optional() }).strict(),
    permiso: 'appointment:create', riesgo: 'reversible', efectos: ['escribe lista_espera'], limitePorConversacion: 2, requiereCliente: true,
    run: async (a, { tx, ctx, customerId }) => {
      const d = ListaEsperaInput.parse({ customer_id: customerId, product_id: a.servicio_id, desde: a.desde, hasta: a.hasta, franjas: a.franjas });
      const r = await unirseListaEspera(tx, ctx, d);
      return { anotado: true, servicio: r.servicio, ya_estaba: r.existente };
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
    descripcion: 'Registra una venta de productos o servicios al cliente de esta conversación. El cliente la confirma con «SÍ»; si el negocio revisa las ventas grandes, queda en revisión.',
    args: z.object({ items: z.array(z.object({ producto_id: uuid, cantidad: z.number().int().positive().max(20) }).strict()).min(1).max(10) }).strict(),
    permiso: 'order:create', riesgo: 'confirmable', efectos: ['escribe order', 'descuenta inventario', 'emite evento venta_registrada'],
    limitePorConversacion: 2, requiereCliente: true,
    monto: async (a, { tx }) => {
      const ps = (await tx.query(`SELECT id, precio FROM product WHERE id = ANY($1::uuid[])`, [a.items.map((i: any) => i.producto_id)])).rows;
      return a.items.reduce((s: number, i: any) => s + Number(ps.find((p: any) => p.id === i.producto_id)?.precio ?? 0) * i.cantidad, 0);
    },
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
    nombre: 'consultar_comprobantes', version: '1.0.0', modulo: 'ventas',
    descripcion: 'Comprobantes de venta de las compras recientes del cliente con el que conversas (número, venta, total y si está vigente o anulado). Un comprobante de venta NO es una factura electrónica: no lo presentes como factura.',
    args: z.object({}).strict(),
    permiso: 'comprobante:read', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (_a, { tx, customerId }) => ({ comprobantes: await comprobantesDelCliente(tx, customerId!), aviso: 'Documento no válido como factura electrónica de venta ante la DIAN.' }),
  }),
  def({
    nombre: 'reenviar_comprobante', version: '1.0.0', modulo: 'ventas',
    descripcion: 'Reenvía al cliente con el que conversas uno de SUS comprobantes de venta, por este chat de WhatsApp (o a su correo registrado). No genera ni anula comprobantes: eso lo hace una persona del negocio desde el panel.',
    args: z.object({ comprobante_id: uuid, canal: z.enum(['WHATSAPP', 'CORREO']).default('WHATSAPP') }).strict(),
    permiso: 'comprobante:send', riesgo: 'reversible', efectos: ['envía un mensaje o un correo al cliente', 'escribe comprobante_venta.entregas'], limitePorConversacion: 3, requiereCliente: true,
    // Un comprobante de otro cliente o de otra empresa responde «no encontrado» (el Gateway lo registra);
    // fuera de la ventana de 24 horas el error explica que no se puede enviar.
    run: async (a, { tx, ctx, customerId }) => {
      const r = await reenviarComprobante(tx, ctx, a.comprobante_id, { canal: a.canal }, { soloCliente: customerId });
      return { enviado: true, numero: r.numero, canal: r.canal };
    },
  }),
  def({
    nombre: 'escalar_a_humano', version: '1.0.0', modulo: 'conversaciones',
    descripcion: 'Sugiere pasar la conversación a una persona. Solo procede si el cliente lo pidió, hay una queja fuerte, un tema de pagos o reembolsos, una urgencia o ya fallaste varias veces; si no, el sistema anota el pendiente para el negocio y sigues atendiendo tú.',
    args: z.object({ motivo: z.string().min(3).max(300), prioridad: z.enum(['BAJA', 'MEDIA', 'ALTA', 'URGENTE']).default('MEDIA') }).strict(),
    permiso: 'case:create', riesgo: 'reversible', efectos: ['crea support_case', 'cede el control a una persona'], limitePorConversacion: 1,
    run: async (a, { tx, ctx, conversationId }) => {
      if (!conversationId) return { error: 'sin_conversacion' };
      const aj = await ajustesIA(tx);
      const t = (await tx.query(`SELECT nombre, sector FROM tenant LIMIT 1`)).rows[0];
      if (aj.autonomia === 'ASESOR') {
        const r = await escalate(tx, ctx, conversationId, a.motivo, a.prioridad);
        return { radicado: r.radicado, escalado: true };
      }
      // El modelo sugiere; la regla decide. Se evalúa el último mensaje del cliente y el motivo propuesto.
      const ultimo = (await tx.query(`SELECT contenido FROM message WHERE conversation_id=$1 AND remitente='CUSTOMER' ORDER BY creado_en DESC LIMIT 1`, [conversationId])).rows[0]?.contenido ?? '';
      const contexto = { reglas: aj.reglas_escalamiento, sector: t?.sector ?? 'general', palabrasUrgencia: aj.palabras_urgencia };
      const regla = evaluarMensaje(ultimo, contexto);
      const fallos = Number((await tx.query(
        `SELECT count(*)::int AS n FROM ai_execution WHERE conversation_id=$1 AND decision IN ('ERROR','DENEGADA')
           AND creado_en > coalesce((SELECT max(cerrado_en) FROM support_case WHERE conversation_id=$1), '-infinity'::timestamptz)`, [conversationId])).rows[0].n);
      const e = regla ?? (fallos >= 3 && aj.reglas_escalamiento.includes('SIN_SOLUCION') ? { regla: 'SIN_SOLUCION' as const, prioridad: 'ALTA' as const, motivo: `La IA falló ${fallos} veces: ${a.motivo}` } : null);
      if (!e) {
        await addMessage(tx, ctx, { conversation_id: conversationId, remitente: 'SYSTEM', tipo: 'NOTA_INTERNA', contenido: `Pendiente para el negocio (la IA sigue atendiendo): ${a.motivo}`, metadatos: { pendiente: true, sugerido_por_ia: true } });
        return { escalado: false, pendiente_anotado: true, instruccion: 'No se pasó a una persona: ninguna regla de escalamiento aplica. Di con honestidad lo que no sabes, ofrece lo que sí puedes hacer y cuéntale que el negocio verá su pendiente.' };
      }
      const r = await escalarPorRegla(tx, ctx, conversationId, e, t?.nombre ?? 'el negocio');
      return { radicado: r.radicado, escalado: true, regla: e.regla, mensaje_para_el_cliente: r.mensaje };
    },
  }),
  def({
    nombre: 'enviar_imagen_producto', version: '1.0.0', modulo: 'catalogo',
    descripcion: 'Envía al cliente de esta conversación la foto de un producto o servicio del catálogo (usa el id de consultar_catalogo o consultar_precio) cuando pregunta por él o pide verlo.',
    args: z.object({ producto_id: uuid }).strict(),
    permiso: 'catalog:read', riesgo: 'reversible', efectos: ['envía una imagen por WhatsApp'], limitePorConversacion: 4, requiereCliente: true,
    run: async (a, { tx, ctx, conversationId }) => {
      if (!conversationId) return { error: 'sin_conversacion' };
      // Solo imágenes ACTIVA del propio negocio (la RLS limita al tenant): una pendiente de aprobación nunca sale.
      const img = (await tx.query(
        `SELECT i.ruta_archivo, i.url, p.nombre FROM producto_imagen i JOIN product p ON p.id=i.product_id
         WHERE i.product_id=$1 AND i.estado='ACTIVA' AND p.eliminado_en IS NULL ORDER BY i.orden, i.creado_en LIMIT 1`, [a.producto_id])).rows[0];
      if (!img) {
        const existe = (await tx.query(`SELECT 1 FROM product WHERE id=$1 AND eliminado_en IS NULL`, [a.producto_id])).rows[0];
        if (!existe) throw new AppError('NOT_FOUND', 'no_encontrado');
        return { enviada: false, motivo: 'Ese producto todavía no tiene foto.' };
      }
      const v = (await tx.query(`SELECT canal, ultimo_mensaje_cliente_en FROM conversation WHERE id=$1`, [conversationId])).rows[0];
      if (v?.canal === 'WHATSAPP' && !ventanaAbierta(v.ultimo_mensaje_cliente_en)) return { enviada: false, motivo: 'Fuera de la ventana de 24 horas: WhatsApp no permite enviar la imagen.' };
      const enlace = urlPublica(img);
      await addMessage(tx, ctx, { conversation_id: conversationId, remitente: 'AI', tipo: 'MEDIA', contenido: img.nombre, metadatos: { imagen: enlace, producto: a.producto_id, media: { tipo: 'image', leyenda: img.nombre } } });
      return { enviada: true, producto: img.nombre };
    },
  }),
  def({
    nombre: 'anotar_pendiente', version: '1.0.0', modulo: 'conversaciones',
    descripcion: 'Deja anotado para el negocio algo que no puedes resolver ahora (sin pasarle la conversación a una persona). Úsala cuando no tengas la información o la herramienta.',
    args: z.object({ pendiente: z.string().min(5).max(400) }).strict(),
    permiso: 'case:create', riesgo: 'reversible', efectos: ['escribe una nota interna'], limitePorConversacion: 3,
    run: async (a, { tx, ctx, conversationId }) => {
      if (!conversationId) return { error: 'sin_conversacion' };
      await addMessage(tx, ctx, { conversation_id: conversationId, remitente: 'SYSTEM', tipo: 'NOTA_INTERNA', contenido: `Pendiente para el negocio: ${a.pendiente}`, metadatos: { pendiente: true } });
      return { anotado: true };
    },
  }),
  // ---- Asistente del negocio (panel) ----------------------------------------
  def({
    nombre: 'resumen_ventas', version: '1.0.0', modulo: 'ventas',
    descripcion: 'Total vendido, número de ventas, ticket promedio y lo cobrado por método de pago (efectivo, transferencia, datáfono, pasarela) en un rango de días (por defecto los últimos 7).',
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
      // Lo efectivamente cobrado en el periodo, por método (efectivo, transferencia, datáfono o pasarela).
      return { dias: a.dias, ventas: r.n, total, total_texto: cop(total), ticket_promedio: r.n ? cop(total / r.n) : cop(0), mas_vendidos: top, cobrado_por_metodo: await cobradoPorMetodo(tx, a.dias) };
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
        [rangoDia(f, zona).desde.toISOString(), rangoDia(f, zona).hasta.toISOString()],
      )).rows;
      return { fecha: f, citas: rows.map((r: any) => ({ ...r, hora: utcToLocal(new Date(r.inicio), zona).hora })) };
    },
  }),
  def({
    nombre: 'agenda_periodo', version: '1.0.0', modulo: 'agenda',
    descripcion: 'Citas de un rango de fechas (hasta 31 días) en UNA consulta, con el conteo por día. Úsala para «esta semana», «este mes» o varios días; para un solo día basta citas_del_dia.',
    args: z.object({ desde: fecha, hasta: fecha }).strict(),
    permiso: 'appointment:read', riesgo: 'lectura', efectos: [],
    run: async (a, { tx }) => {
      const zona = await tz(tx);
      if (a.hasta < a.desde) return { error: 'rango_invalido', mensaje: 'La fecha final es anterior a la inicial.' };
      const dias: string[] = [];
      for (let d = a.desde; d <= a.hasta && dias.length <= 31; d = addDays(d, 1)) dias.push(d);
      if (dias.length > 31) return { error: 'rango_muy_largo', mensaje: 'Consulta como máximo 31 días a la vez.' };
      const rows = (await tx.query(
        `SELECT a.inicio, a.estado, a.origen, c.nombre AS cliente, p.nombre AS servicio, r.nombre AS recurso FROM appointment a
         JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
         WHERE a.inicio >= $1 AND a.inicio < $2 ORDER BY a.inicio LIMIT 300`,
        [rangoDia(a.desde, zona).desde.toISOString(), rangoDia(a.hasta, zona).hasta.toISOString()],
      )).rows.map((r: any) => { const l = utcToLocal(new Date(r.inicio), zona); return { ...r, fecha: l.fecha, hora: l.hora }; });
      const porDia = dias.map((d) => ({ fecha: d, citas: rows.filter((r) => r.fecha === d).length }));
      return { desde: a.desde, hasta: a.hasta, total: rows.length, por_dia: porDia, citas: rows };
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
      compras: (await tx.query(`SELECT numero, total, creado_en FROM "order" WHERE customer_id=$1 AND estado='CONFIRMADA' ORDER BY creado_en DESC LIMIT 5`, [customerId])).rows
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
    nombre: 'ayuda_plataforma', version: '1.1.0', modulo: 'soporte',
    descripcion: 'Guía verificada de uso del panel: dónde está cada función y con qué botones. Úsala antes de explicar cómo hacer algo; no describas pantallas que no aparezcan en la guía.',
    args: z.object({ tema: z.enum(TEMAS_AYUDA) }).strict(),
    permiso: 'ai:assist', riesgo: 'lectura', efectos: [],
    run: async (a) => ({ tema: a.tema, guia: AYUDA[a.tema as (typeof TEMAS_AYUDA)[number]], verificada: true }),
  }),
  def({
    nombre: 'mostrar_guia', version: '1.0.0', modulo: 'soporte',
    descripcion: `Muestra una guía en pantalla: el panel lleva a la IA por los botones reales, paso a paso, para que la persona aprenda haciendo. Úsala cuando pregunten cómo hacer algo que esté en esta lista: ${IDS_GUIA.map((id) => `${id} (${GUIAS[id].para})`).join('; ')}. Después responde en una o dos frases sin repetir los pasos. Si devuelve disponible=false, explica el motivo.`,
    args: z.object({ guia: z.enum(IDS_GUIA) }).strict(),
    permiso: 'ai:assist', riesgo: 'lectura', efectos: [],
    run: async (a, rt) => {
      const g = GUIAS[a.guia];
      const permisos = rt.permisosSolicitante ?? rt.ctx.permisos;
      if (g.permiso && !permisos.has('*') && !permisos.has(g.permiso)) return { guia: a.guia, titulo: g.titulo, disponible: false, motivo: 'el rol de la persona no tiene ese permiso' };
      if (g.modulo && !(await rt.tx.query(`SELECT 1 FROM tenant_module WHERE modulo=$1 AND activo`, [g.modulo])).rows.length) return { guia: a.guia, titulo: g.titulo, disponible: false, motivo: 'el módulo está desactivado' };
      return { guia: a.guia, titulo: g.titulo, disponible: true };
    },
  }),
  // ---- Catálogo desde el asistente: siempre con confirmación explícita de la persona.
  def({
    nombre: 'crear_item_catalogo', version: '1.0.0', modulo: 'catalogo',
    descripcion: 'Crea un producto o servicio en el catálogo con los datos que la persona dio. No se guarda hasta que la persona lo confirme con el botón del panel. No inventes precios, duraciones ni categorías: si falta un dato, pregúntalo.',
    args: z.object({
      tipo: z.enum(['PRODUCTO', 'SERVICIO']),
      nombre: z.string().trim().min(2).max(120).refine((n) => /\p{L}/u.test(n), 'el nombre debe tener letras'),
      precio: z.number().nonnegative().max(999_999_999).describe('Precio con IVA incluido, en pesos'),
      categoria: z.string().trim().min(1).max(60).optional(),
      duracion_min: z.number().int().positive().max(600).optional().describe('Obligatoria para servicios'),
      iva_pct: z.union([z.literal(0), z.literal(5), z.literal(19)]).optional(),
    }).strict().refine((a) => a.tipo !== 'SERVICIO' || !!a.duracion_min, { message: 'un servicio necesita su duración en minutos', path: ['duracion_min'] }),
    permiso: 'catalog:write', riesgo: 'confirmable', efectos: ['escribe product'],
    resumen: async (a) => `Crear ${a.tipo === 'SERVICIO' ? 'el servicio' : 'el producto'} «${a.nombre}» por ${cop(a.precio)}${a.duracion_min ? `, ${a.duracion_min} min` : ''}${a.categoria ? `, categoría «${a.categoria}»` : ', sin categoría'}, IVA ${a.iva_pct ?? 0} %`,
    run: async (a, { tx, ctx }) => {
      const r = await createProduct(tx, ctx, {
        tipo: a.tipo, nombre: a.nombre, precio: a.precio, categoria: a.categoria ?? null, iva_pct: a.iva_pct ?? 0, duracion_min: a.tipo === 'SERVICIO' ? a.duracion_min : null,
        controla_stock: false, stock: 0, stock_minimo: 0, activo: true,
      });
      return { product_id: r.id, tipo: a.tipo, nombre: a.nombre, precio_texto: cop(a.precio), duracion_min: a.duracion_min ?? null, categoria: a.categoria ?? null };
    },
  }),
  def({
    nombre: 'editar_item_catalogo', version: '1.0.0', modulo: 'catalogo',
    descripcion: 'Cambia nombre, precio, categoría, duración o disponibilidad (activo) de un ítem existente (usa el id que devuelve consultar_catalogo). No se guarda hasta que la persona lo confirme con el botón del panel.',
    args: z.object({
      producto_id: uuid,
      nombre: z.string().trim().min(2).max(120).refine((n) => /\p{L}/u.test(n), 'el nombre debe tener letras').optional(),
      precio: z.number().nonnegative().max(999_999_999).optional(),
      categoria: z.string().trim().max(60).nullable().optional(),
      duracion_min: z.number().int().positive().max(600).optional(),
      activo: z.boolean().optional(),
    }).strict().refine((a) => Object.keys(a).some((k) => k !== 'producto_id'), 'indica qué cambiar'),
    permiso: 'catalog:write', riesgo: 'confirmable', efectos: ['actualiza product'],
    resumen: async (a, { tx }) => {
      const p = (await tx.query(`SELECT nombre, precio, categoria, duracion_min, activo FROM product WHERE id=$1 AND eliminado_en IS NULL`, [a.producto_id])).rows[0];
      if (!p) return 'Editar un ítem del catálogo';
      const c: string[] = [];
      if (a.nombre !== undefined && a.nombre !== p.nombre) c.push(`nombre «${p.nombre}» → «${a.nombre}»`);
      if (a.precio !== undefined) c.push(`precio ${cop(Number(p.precio))} → ${cop(a.precio)}`);
      if (a.categoria !== undefined) c.push(`categoría ${p.categoria ? `«${p.categoria}»` : 'sin categoría'} → ${a.categoria ? `«${a.categoria}»` : 'sin categoría'}`);
      if (a.duracion_min !== undefined) c.push(`duración ${p.duracion_min ?? '—'} → ${a.duracion_min} min`);
      if (a.activo !== undefined) c.push(a.activo ? 'volver a ofrecerlo (activo)' : 'dejar de ofrecerlo (inactivo)');
      return `Editar «${p.nombre}»: ${c.join('; ') || 'sin cambios'}`;
    },
    run: async (a, { tx, ctx }) => {
      const { producto_id, ...cambios } = a;
      await updateProduct(tx, ctx, producto_id, cambios);
      const p = (await tx.query(`SELECT nombre, precio, categoria, duracion_min, activo FROM product WHERE id=$1`, [producto_id])).rows[0];
      return { product_id: producto_id, nombre: p.nombre, precio_texto: cop(Number(p.precio)), categoria: p.categoria, duracion_min: p.duracion_min, activo: p.activo, cambios: Object.keys(cambios) };
    },
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

// Pedidos y cobros por WhatsApp (docs/pagos-whatsapp.md).
TOOLS.push(...HERRAMIENTAS_COMERCIO);
export const TOOL_MAP = new Map(TOOLS.map((t) => [t.nombre, t]));

/** Esquema JSON de los argumentos, para exponer la herramienta al modelo. */
export function toolJsonSchema(t: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(t.args, { target: 'draft-7' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
