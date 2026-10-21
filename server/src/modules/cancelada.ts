import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm } from '../core/context.js';
import { AppError } from '../lib/errors.js';
import { crearTicket, revisarContenido } from './soporte.js';

/**
 * Empresa con la suscripción cancelada. La cancelación la decide el equipo de la plataforma (con un motivo),
 * así que reactivar no es un pago automático: se pide y el equipo la revisa y reactiva. Los datos se conservan.
 */
const ASUNTO = 'Solicitud de reactivación de la suscripción';

export async function estadoCancelada(tx: Tx, ctx: Ctx) {
  const t = (await tx.query(
    `SELECT t.nombre, t.slug, s.estado, s.actualizado_en, s.plan_codigo, p.nombre AS plan_nombre
     FROM tenant t JOIN subscription s ON s.tenant_id=t.id JOIN plan p ON p.codigo=s.plan_codigo WHERE t.id=$1`, [ctx.tenantId])).rows[0];
  const solicitud = (await tx.query(
    `SELECT id, numero, estado, creado_en FROM soporte_ticket WHERE asunto=$1 AND estado NOT IN ('RESUELTO','CERRADO') ORDER BY creado_en DESC LIMIT 1`, [ASUNTO])).rows[0] ?? null;
  return {
    cancelada: t?.estado === 'CANCELADA', empresa: t?.nombre, plan: t?.plan_nombre, desde: t?.actualizado_en,
    puede_solicitar: ctx.permisos.has('subscription:manage'), solicitud,
  };
}

export async function solicitarReactivacion(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'subscription:manage');
  const d = z.object({ mensaje: z.string().trim().max(2000, 'El mensaje es demasiado largo.').optional().default('') }).parse(body ?? {});
  if (d.mensaje) revisarContenido(d.mensaje);
  const e = await estadoCancelada(tx, ctx);
  if (!e.cancelada) throw new AppError('CONFLICT', 'La suscripción de esta empresa no está cancelada.');
  if (e.solicitud) return { id: e.solicitud.id, numero: e.solicitud.numero, ya_existia: true };
  const descripcion = [
    `${e.empresa} pide reactivar su suscripción (plan ${e.plan}).`,
    d.mensaje ? `Mensaje de la empresa: ${d.mensaje}` : 'La empresa no dejó un mensaje adicional.',
    'Revisa el motivo de la cancelación antes de reactivar desde el panel del operador.',
  ].join('\n\n');
  const t = await crearTicket(tx, ctx, { categoria: 'FACTURACION', prioridad: 'ALTA', asunto: ASUNTO, descripcion });
  return { ...t, ya_existia: false };
}
