import type { Database } from '../db/index.js';
import { systemCtx } from '../core/context.js';
import { avisar, type TipoAviso } from '../modules/proactivo.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { uuidv7 } from '../lib/util.js';
import { pesos } from './precios.js';

/**
 * Avisos de pago (cola con reintentos). Al cliente, con la regla de la ventana de 24 horas de proactivo.avisar
 * (WhatsApp → plantilla aprobada → correo → «no enviado» visible). Al negocio, por correo a su contacto y con el
 * pedido visible en Ventas › Pedidos. Cada aviso es único por (tipo, referencia): un evento repetido no lo duplica.
 */
export type TipoAvisoPago = 'PAGO_CONFIRMADO' | 'PAGO_RECHAZADO' | 'PAGO_EN_ESPERA' | 'PAGO_PENDIENTE' | 'PAGO_NEGOCIO';

export async function avisoPago(db: Database, tenantId: string, p: { pago_id: string; tipo: TipoAvisoPago; texto?: string }) {
  await db.withTenant(tenantId, async (tx) => {
    const ctx = systemCtx(tenantId, p.pago_id, 'Pagos de comercio');
    const pago = (await tx.query(
      `SELECT cp.*, o.numero, o.customer_id FROM commerce_payment cp JOIN "order" o ON o.id=cp.order_id WHERE cp.id=$1`, [p.pago_id])).rows[0];
    if (!pago) return;
    const cobro = pesos(Number(pago.monto_cobro_centavos));
    const oficial = pesos(Number(pago.total_oficial_centavos));
    const institucional = pago.modo_precios === 'institutional_test';
    const negocio = (await tx.query(`SELECT nombre, email_contacto FROM tenant LIMIT 1`)).rows[0];

    const cliente: Record<Exclude<TipoAvisoPago, 'PAGO_NEGOCIO'>, string> = {
      PAGO_CONFIRMADO: `¡Tu pago fue confirmado! Tu pedido #${pago.numero} está confirmado y el negocio comenzará a prepararlo.${institucional ? ` Recuerda que este pedido corresponde a una demostración institucional y el cobro realizado fue de ${cobro} COP.` : ''}`,
      PAGO_RECHAZADO: `Tu pago del pedido #${pago.numero} no fue aprobado${pago.motivo ? ` (${String(pago.motivo).slice(0, 120)})` : ''}. Si quieres, puedes intentarlo de nuevo con otro medio de pago: escríbenos por aquí.`,
      PAGO_EN_ESPERA: `Estamos esperando la confirmación de la entidad financiera para tu pedido #${pago.numero}. Te avisamos por aquí apenas llegue.`,
      PAGO_PENDIENTE: `Sobre tu pago del pedido #${pago.numero}: ${p.texto ?? 'el negocio necesita otro comprobante.'}`,
    };
    if (p.tipo !== 'PAGO_NEGOCIO') {
      await avisar(tx, ctx, {
        tipo: p.tipo as TipoAviso, referencia: `${pago.referencia}:${p.tipo}${p.tipo === 'PAGO_PENDIENTE' ? `:${Date.now()}` : ''}`, customerId: pago.customer_id,
        texto: cliente[p.tipo], variables: { pedido: String(pago.numero), monto: cobro }, asunto: p.tipo === 'PAGO_CONFIRMADO' ? 'Pago confirmado' : p.tipo === 'PAGO_RECHAZADO' ? 'Pago no aprobado' : 'Tu pago',
        metadatos: { referencia_pago: pago.referencia },
      });
    }
    // Al negocio: pagos confirmados y los que necesitan revisión.
    if ((p.tipo === 'PAGO_CONFIRMADO' || p.tipo === 'PAGO_NEGOCIO') && negocio?.email_contacto) {
      const texto = p.tipo === 'PAGO_CONFIRMADO'
        ? `Se confirmó el pago del pedido #${pago.numero} por ${cobro}. Precio oficial del pedido: ${oficial}.${institucional ? ' (Cobro de demostración institucional.)' : ''}`
        : `El cobro ${pago.referencia} del pedido #${pago.numero} necesita revisión: ${pago.motivo ?? 'Wompi reportó algo distinto a lo esperado.'} Revísalo en Ventas › Pagos.`;
      const ins = await tx.query(`INSERT INTO aviso_proactivo (id, tenant_id, tipo, referencia, canal, estado) VALUES ($1,$2,'PAGO_NEGOCIO',$3,'NEGOCIO','ENVIADO') ON CONFLICT DO NOTHING RETURNING id`,
        [uuidv7(), tenantId, `${pago.referencia}:${p.tipo}`]);
      if (ins.rows[0]) {
        await encolarCorreo(tx, {
          tenantId, para: negocio.email_contacto, clave: `pago-negocio:${pago.referencia}:${p.tipo}`,
          correo: plantillas.avisoCliente({ cliente: negocio.nombre, empresa: 'Omnegia', asunto: p.tipo === 'PAGO_CONFIRMADO' ? `Pago confirmado · pedido #${pago.numero}` : `Revisar cobro · pedido #${pago.numero}`, texto }),
        });
      }
    }
  });
}
