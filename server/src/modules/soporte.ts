import { z } from 'zod';
import type { Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { audit } from '../core/audit.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { config } from '../config.js';

/**
 * Soporte de la plataforma (empresa → Omnegia). Un ticket es lo único que el
 * operador ve del negocio más allá de los datos comerciales: lo que la empresa
 * decide contar. Cada solicitud llega también a la bandeja de soporte (Zoho Mail)
 * con su número; las respuestas de esa bandeja NO se sincronizan con el panel.
 */
export const CATEGORIAS = ['CUENTA', 'FACTURACION', 'WHATSAPP', 'IA', 'TECNICO', 'OTRO'] as const;
export const PRIORIDADES = ['BAJA', 'NORMAL', 'ALTA', 'URGENTE'] as const;
export const ETIQUETA_CATEGORIA: Record<string, string> = { CUENTA: 'Cuenta y acceso', FACTURACION: 'Suscripción y pagos', WHATSAPP: 'WhatsApp', IA: 'Asistente de IA', TECNICO: 'Problema técnico', OTRO: 'Otro', COMERCIAL: 'Comercial' };

/** Claves, contraseñas y números de tarjeta no deben viajar en un ticket. */
const PARECE_SECRETO = /(\bre_[A-Za-z0-9_]{8,}|\bsk-[A-Za-z0-9-]{10,}|\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{6,}|\bwhsec_[A-Za-z0-9+/=]{8,}|\bEAA[A-Za-z0-9]{20,}|\b(prv|pub)_(test|prod)_[A-Za-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b(contrase(ñ|n)a|password|clave|pin)\s*[:=]\s*\S{4,}|\b(?:\d[ -]?){13,19}\b)/i;

export function revisarContenido(texto: string) {
  if (PARECE_SECRETO.test(texto)) {
    throw invalid('Parece que el mensaje incluye una clave, contraseña o número de tarjeta. Quítalo antes de enviarlo: el equipo de soporte nunca te lo pedirá.');
  }
}

export const TicketInput = z.object({
  categoria: z.enum(CATEGORIAS, 'Elige una categoría.'),
  prioridad: z.enum(PRIORIDADES, 'Elige una prioridad.').default('NORMAL'),
  asunto: z.string().trim().min(5, 'Escribe un asunto de al menos 5 caracteres.').max(120, 'El asunto es demasiado largo.'),
  descripcion: z.string().trim().min(20, 'Cuéntanos un poco más (al menos 20 caracteres).').max(4000, 'La descripción es demasiado larga.'),
});
const MensajeInput = z.object({ cuerpo: z.string().trim().min(2, 'Escribe tu respuesta.').max(4000, 'El mensaje es demasiado largo.') });

const urlTicketEmpresa = (id: string) => `${config.publicUrl}/soporte/${id}`;
export const urlTicketOperador = (id: string) => `${config.publicUrl}/operador/soporte/${id}`;

async function solicitante(tx: Tx, ctx: Ctx) {
  const u = (await tx.query(`SELECT id, email, nombre, email_verificado_en FROM users WHERE id=$1`, [ctx.actor.id])).rows[0];
  if (!u) throw new AppError('UNAUTHENTICATED', 'Tu sesión terminó. Inicia sesión de nuevo.');
  return u;
}

export async function crearTicket(tx: Tx, ctx: Ctx, body: unknown) {
  const d = TicketInput.parse(body);
  revisarContenido(`${d.asunto}\n${d.descripcion}`);
  const u = await solicitante(tx, ctx);
  const empresa = (await tx.query(`SELECT nombre FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]?.nombre ?? '';
  const n = (await tx.query(`SELECT nextval('soporte_ticket_seq') AS n`)).rows[0].n;
  const id = uuidv7();
  const numero = `SOP-${String(n).padStart(6, '0')}`;
  await tx.query(
    `INSERT INTO soporte_ticket (id, numero, tenant_id, creado_por, solicitante_nombre, solicitante_email, categoria, prioridad, asunto)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, numero, ctx.tenantId, u.id, u.nombre, u.email, d.categoria, d.prioridad, d.asunto]);
  // A la bandeja de soporte: responder desde Zoho le llega directo a quien abrió el ticket
  // (solo si confirmó su correo; si no, la respuesta queda en la bandeja de soporte).
  const correoId = await encolarCorreo(tx, {
    tenantId: ctx.tenantId, para: config.correo.buzonSoporte, responderA: u.email_verificado_en ? u.email : undefined,
    correo: plantillas.ticketInterno({ numero, empresa, empresaId: ctx.tenantId, categoria: ETIQUETA_CATEGORIA[d.categoria], prioridad: d.prioridad, asunto: d.asunto, descripcion: d.descripcion, solicitante: `${u.nombre} <${u.email}>`, urlOperador: urlTicketOperador(id) }),
  });
  await tx.query(`INSERT INTO soporte_mensaje (id, tenant_id, ticket_id, autor_tipo, autor_nombre, cuerpo, correo_id) VALUES ($1,$2,$3,'EMPRESA',$4,$5,$6)`,
    [uuidv7(), ctx.tenantId, id, u.nombre, d.descripcion, correoId]);
  await encolarCorreo(tx, { tenantId: ctx.tenantId, userId: u.id, para: u.email, correo: plantillas.ticketRecibido({ nombre: u.nombre, numero, asunto: d.asunto, url: urlTicketEmpresa(id) }) });
  await audit(tx, ctx, { accion: 'soporte.ticket_creado', recurso: 'soporte_ticket', recursoId: id, resultado: 'EXITO', detalle: { numero, categoria: d.categoria, prioridad: d.prioridad } });
  return { id, numero };
}

export async function listarTickets(tx: Tx, _ctx: Ctx) {
  return {
    tickets: (await tx.query(
      `SELECT id, numero, categoria, prioridad, estado, asunto, solicitante_nombre, creado_en, actualizado_en,
              (SELECT count(*)::int FROM soporte_mensaje m WHERE m.ticket_id=t.id) AS mensajes
       FROM soporte_ticket t ORDER BY (estado IN ('RESUELTO','CERRADO')), actualizado_en DESC LIMIT 100`)).rows,
    // Lo que el asistente de soporte resolvió sin esperar a una persona (últimos 90 días).
    asistente: (await tx.query(
      `SELECT count(*) FILTER (WHERE resultado='RESUELTO')::int AS resueltas, count(*) FILTER (WHERE resultado='ESCALADO')::int AS escaladas
       FROM soporte_intento_ia WHERE creado_en > now() - interval '90 days'`)).rows[0],
  };
}

/** La empresa da por resuelta su solicitud (el equipo la ve y puede cerrarla). */
export async function marcarResuelta(tx: Tx, ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const t = (await tx.query(`SELECT id, numero, estado FROM soporte_ticket WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!t) throw notFound();
  if (t.estado === 'CERRADO' || t.estado === 'RESUELTO') throw new AppError('CONFLICT', 'Esta solicitud ya está resuelta.');
  const u = await solicitante(tx, ctx);
  await tx.query(`INSERT INTO soporte_mensaje (id, tenant_id, ticket_id, autor_tipo, autor_nombre, cuerpo) VALUES ($1,$2,$3,'SISTEMA',$4,$5)`,
    [uuidv7(), ctx.tenantId, id, 'Panel de la empresa', `${u.nombre} marcó la solicitud como resuelta.`]);
  await tx.query(`UPDATE soporte_ticket SET estado='RESUELTO', actualizado_en=now() WHERE id=$1`, [id]);
  await audit(tx, ctx, { accion: 'soporte.ticket_resuelto_empresa', recurso: 'soporte_ticket', recursoId: id, resultado: 'EXITO', detalle: { numero: t.numero } });
  return { ok: true };
}

export async function verTicket(tx: Tx, _ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound();
  const t = (await tx.query(`SELECT id, numero, categoria, prioridad, estado, asunto, solicitante_nombre, creado_en, actualizado_en FROM soporte_ticket WHERE id=$1`, [id])).rows[0];
  if (!t) throw notFound();
  const mensajes = (await tx.query(
    `SELECT m.id, m.autor_tipo, m.autor_nombre, m.cuerpo, m.creado_en, e.estado AS estado_correo
     FROM soporte_mensaje m LEFT JOIN email_outbox e ON e.id=m.correo_id WHERE m.ticket_id=$1 ORDER BY m.creado_en`, [id])).rows;
  return { ticket: t, mensajes };
}

export async function responderTicket(tx: Tx, ctx: Ctx, id: string, body: unknown) {
  if (!isUuid(id)) throw notFound();
  const d = MensajeInput.parse(body);
  revisarContenido(d.cuerpo);
  const t = (await tx.query(`SELECT * FROM soporte_ticket WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!t) throw notFound();
  if (t.estado === 'CERRADO') throw new AppError('CONFLICT', 'Este ticket está cerrado. Abre uno nuevo si necesitas ayuda.');
  const u = await solicitante(tx, ctx);
  const empresa = (await tx.query(`SELECT nombre FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]?.nombre ?? '';
  const correoId = await encolarCorreo(tx, {
    tenantId: ctx.tenantId, para: config.correo.buzonSoporte, responderA: u.email_verificado_en ? u.email : undefined,
    correo: plantillas.ticketInterno({ numero: t.numero, empresa, empresaId: ctx.tenantId, categoria: ETIQUETA_CATEGORIA[t.categoria], prioridad: t.prioridad, asunto: t.asunto, descripcion: d.cuerpo, solicitante: `${u.nombre} <${u.email}>`, urlOperador: urlTicketOperador(id), respuesta: true }),
  });
  await tx.query(`INSERT INTO soporte_mensaje (id, tenant_id, ticket_id, autor_tipo, autor_nombre, cuerpo, correo_id) VALUES ($1,$2,$3,'EMPRESA',$4,$5,$6)`,
    [uuidv7(), ctx.tenantId, id, u.nombre, d.cuerpo, correoId]);
  await tx.query(`UPDATE soporte_ticket SET estado=CASE WHEN estado IN ('ESPERANDO_CLIENTE','RESUELTO') THEN 'ABIERTO' ELSE estado END, actualizado_en=now() WHERE id=$1`, [id]);
  await audit(tx, ctx, { accion: 'soporte.ticket_respondido', recurso: 'soporte_ticket', recursoId: id, resultado: 'EXITO', detalle: { numero: t.numero } });
  return { ok: true };
}
