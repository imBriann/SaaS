import { z } from 'zod';
import type { Tx } from '../db/index.js';
import type { ToolDef } from '../ai/registry.js';
import { agregarAlPedido, crearPedido, elegirEntrega, pedidoDelCliente, totales, vistaPedido } from './pedidos.js';
import { mediosHabilitados } from './metodos.js';
import { pesos } from './precios.js';

/**
 * Herramientas del agente para vender por WhatsApp (docs/pagos-whatsapp.md § Flujo). Reglas del gateway:
 *  - el tenant y el cliente los inyecta el ejecutor (nunca viajan en los argumentos);
 *  - un pedido de otro cliente o de otra empresa es «no encontrado»;
 *  - la IA elige productos y cantidades; precios, totales e importe de cobro los calcula el servidor;
 *  - la IA nunca aprueba pagos ni cambia estados financieros: «ya pagué» no confirma nada.
 * Solo se ofrecen si la empresa activó algún método de pago de pedidos.
 */
const uuid = z.uuid();
export async function comercioActivo(tx: Tx): Promise<boolean> {
  const s = (await tx.query(`SELECT pago_manual, pago_en_linea FROM payment_settings LIMIT 1`)).rows[0];
  return !!(s?.pago_manual || s?.pago_en_linea);
}

const Item = z.object({ producto_id: uuid, cantidad: z.number().int().positive().max(100) }).strict();

export const HERRAMIENTAS_COMERCIO: ToolDef<any>[] = [
  {
    nombre: 'crear_pedido', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Crea (o amplía, si ya hay uno abierto) el pedido del cliente de esta conversación con los productos y cantidades que eligió. Usa los id de consultar_catalogo o consultar_precio. Devuelve el total oficial; el importe que se cobrará lo calcula el servidor con calcular_total.',
    args: z.object({ items: z.array(Item).min(1).max(20) }).strict(),
    permiso: 'order:create', riesgo: 'reversible', efectos: ['escribe order (BORRADOR)', 'escribe order_item'], limitePorConversacion: 4, requiereCliente: true,
    run: async (a, { tx, ctx, customerId, conversationId }) => crearPedido(tx, ctx, { customerId: customerId!, conversationId, items: a.items.map((i: any) => ({ product_id: i.producto_id, cantidad: i.cantidad })) }),
  },
  {
    nombre: 'agregar_al_pedido', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Agrega un producto (o más cantidad) al pedido abierto del cliente.',
    args: z.object({ pedido_id: uuid, producto_id: uuid, cantidad: z.number().int().positive().max(100) }).strict(),
    permiso: 'order:create', riesgo: 'reversible', efectos: ['escribe order_item'], limitePorConversacion: 8, requiereCliente: true,
    run: async (a, { tx, ctx, customerId }) => agregarAlPedido(tx, ctx, a.pedido_id, customerId!, { product_id: a.producto_id, cantidad: a.cantidad }),
  },
  {
    nombre: 'calcular_total', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Total oficial del pedido e importe que realmente se cobrará (los calcula el servidor). Si son distintos (modo de demostración institucional), muéstrale al cliente la explicación tal cual antes de cobrar.',
    args: z.object({ pedido_id: uuid }).strict(),
    permiso: 'order:create', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (a, { tx, customerId }) => {
      const o = await pedidoDelCliente(tx, a.pedido_id, customerId!);
      if (Number(o.total) <= 0) return { error: 'pedido_vacio' };
      const t = totales(o);
      return { total_oficial_texto: pesos(t.total_oficial_centavos), cobro_texto: pesos(t.cobro_centavos), modo: t.modo, distintos: t.cobro_centavos !== t.total_oficial_centavos, explicacion: t.texto };
    },
  },
  {
    nombre: 'elegir_entrega', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Registra si el cliente recoge en el negocio o pide domicilio (con la dirección completa).',
    args: z.object({ pedido_id: uuid, entrega: z.enum(['RECOGER', 'DOMICILIO']), direccion: z.string().max(300).optional() }).strict(),
    permiso: 'order:create', riesgo: 'reversible', efectos: ['escribe order'], limitePorConversacion: 6, requiereCliente: true,
    run: async (a, { tx, ctx, customerId }) => elegirEntrega(tx, ctx, a.pedido_id, customerId!, a.entrega, a.direccion),
  },
  {
    nombre: 'medios_de_pago', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Medios de pago que el negocio tiene habilitados para este pedido. Ofrece solo estos.',
    args: z.object({}).strict(),
    permiso: 'order:create', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (_a, { tx }) => mediosHabilitados(tx),
  },
  {
    nombre: 'elegir_medio_pago', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Registra el medio de pago que eligió el cliente (uno de medios_de_pago). Con NEQUI, pide después su celular registrado en Nequi.',
    args: z.object({ pedido_id: uuid, medio: z.enum(['NEQUI', 'CHECKOUT', 'DAVIPLATA', 'BREB', 'QR', 'CUENTA_BANCARIA']) }).strict(),
    permiso: 'order:create', riesgo: 'reversible', efectos: ['escribe order'], limitePorConversacion: 6, requiereCliente: true,
    run: async (a, { tx, customerId }) => {
      const o = await pedidoDelCliente(tx, a.pedido_id, customerId!);
      if (o.estado !== 'BORRADOR' || o.pedido_estado !== 'ABIERTO') return { error: 'pedido_cerrado' };
      const { medios } = await mediosHabilitados(tx);
      if (!medios.some((m) => m.clave === a.medio)) return { error: 'medio_no_habilitado', habilitados: medios.map((m) => m.clave) };
      await tx.query(`UPDATE "order" SET medio_pago=$2 WHERE id=$1`, [o.id, a.medio]);
      return { ok: true, medio: a.medio, siguiente: a.medio === 'NEQUI' ? 'Pide el celular registrado en Nequi (pedir_celular_nequi).' : 'Muestra el importe y pide confirmación para generar el cobro.' };
    },
  },
  {
    nombre: 'pedir_celular_nequi', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Valida el celular que el cliente dijo tener registrado en Nequi (10 dígitos, empieza por 3). No es la cuenta del negocio: es el número del comprador, al que Nequi le enviará la solicitud de pago.',
    args: z.object({ pedido_id: uuid, celular: z.string().min(10).max(20) }).strict(),
    permiso: 'order:create', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (a, { tx, customerId }) => {
      await pedidoDelCliente(tx, a.pedido_id, customerId!);
      const d = a.celular.replace(/\D/g, '').replace(/^57(?=3\d{9}$)/, '');
      if (!/^3\d{9}$/.test(d)) return { valido: false, motivo: 'El celular de Nequi tiene 10 dígitos y empieza por 3.' };
      return { valido: true, celular: d, terminado_en: d.slice(-4) };
    },
  },
  {
    nombre: 'estado_pedido', version: '1.0.0', modulo: 'ventas', disponible: comercioActivo,
    descripcion: 'Estado del pedido y de su cobro según Omnegia. Si el cliente dice «ya pagué», consulta aquí: solo la confirmación de Wompi o del negocio cuenta.',
    args: z.object({ pedido_id: uuid }).strict(),
    permiso: 'order:create', riesgo: 'lectura', efectos: [], requiereCliente: true,
    run: async (a, { tx, customerId }) => {
      const o = await pedidoDelCliente(tx, a.pedido_id, customerId!);
      const p = await vistaPedido(tx, o.id);
      const cobro = (await tx.query(`SELECT referencia, estado, metodo FROM commerce_payment WHERE order_id=$1 ORDER BY creado_en DESC LIMIT 1`, [o.id])).rows[0] ?? null;
      return { ...p, cobro, nota: 'Un pago solo se da por confirmado cuando Wompi lo aprueba o el negocio lo confirma. Lo que diga el cliente no cambia el estado.' };
    },
  },
];
