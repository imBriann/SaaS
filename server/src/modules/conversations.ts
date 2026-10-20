import { crearTicket } from './soporte.js';
import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, can, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { enqueue, publish } from '../core/events.js';
import { addUsage } from '../core/usage.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';

export type Remitente = 'CUSTOMER' | 'AI' | 'SYSTEM' | 'HUMAN';
export type Prioridad = 'BAJA' | 'MEDIA' | 'ALTA' | 'URGENTE';
export type EstadoCaso = 'EN_COLA' | 'ASIGNADO' | 'EN_ATENCION' | 'CERRADO';
export type TipoMensaje = 'TEXTO' | 'NOTA_INTERNA' | 'DOCUMENTO' | 'PLANTILLA' | 'MEDIA' | 'NO_SOPORTADO';

export const VENTANA_SERVICIO_MS = 24 * 3600 * 1000;
/** Un radicado cerrado se puede reabrir durante este plazo; después se abre uno nuevo. */
export const PLAZO_REAPERTURA_MS = 7 * 24 * 3600 * 1000;
export const PRIORIDADES: Prioridad[] = ['BAJA', 'MEDIA', 'ALTA', 'URGENTE'];

/**
 * Máquina de estados del radicado. El estado del radicado es independiente del de
 * la conversación (ABIERTA/ESCALADA/CERRADA) y de quién tiene el control (IA/persona).
 */
const TRANSICIONES: Record<EstadoCaso, EstadoCaso[]> = {
  EN_COLA: ['ASIGNADO', 'EN_ATENCION', 'CERRADO'],
  ASIGNADO: ['ASIGNADO', 'EN_ATENCION', 'CERRADO'],
  EN_ATENCION: ['EN_ATENCION', 'CERRADO'],
  CERRADO: ['ASIGNADO'],
};
export function transicionValida(de: EstadoCaso, a: EstadoCaso): boolean {
  return TRANSICIONES[de]?.includes(a) ?? false;
}
function exigirTransicion(de: EstadoCaso, a: EstadoCaso) {
  if (!transicionValida(de, a)) {
    const textos: Record<EstadoCaso, string> = { EN_COLA: 'en cola', ASIGNADO: 'asignado', EN_ATENCION: 'en atención', CERRADO: 'cerrado' };
    throw new AppError('CONFLICT', `El radicado está ${textos[de]}: esa acción ya no aplica. Recarga para ver su estado actual.`);
  }
}

async function registrarEvento(tx: Tx, ctx: Ctx, caso: { id: string }, accion: string, de: EstadoCaso | null, a: EstadoCaso, asignado: string | null, detalle: Record<string, unknown> = {}) {
  await tx.query(
    `INSERT INTO case_event (id, tenant_id, case_id, accion, de_estado, a_estado, actor_tipo, actor_nombre, asignado_a, detalle) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [uuidv7(), ctx.tenantId, caso.id, accion, de, a, ctx.actor.tipo, ctx.actor.nombre, asignado, JSON.stringify(detalle)],
  );
}

export async function getOrOpenConversation(tx: Tx, ctx: Ctx, customerId: string, canal: 'WHATSAPP' | 'WEB') {
  const c = (await tx.query(
    `SELECT * FROM conversation WHERE customer_id=$1 AND canal=$2 ORDER BY actualizado_en DESC LIMIT 1 FOR UPDATE`,
    [customerId, canal],
  )).rows[0];
  if (c && c.estado !== 'CERRADA') return c;
  if (c && c.estado === 'CERRADA') {
    // Un nuevo mensaje reabre el hilo con la IA al frente: la historia sigue siendo una sola.
    await tx.query(`UPDATE conversation SET estado='ABIERTA', control='AI', resuelta_por=NULL, actualizado_en=now() WHERE id=$1`, [c.id]);
    return { ...c, estado: 'ABIERTA', control: 'AI' };
  }
  const id = uuidv7();
  await tx.query(
    `INSERT INTO conversation (id, tenant_id, customer_id, canal, estado, control) VALUES ($1,$2,$3,$4,'ABIERTA','AI')`,
    [id, ctx.tenantId, customerId, canal],
  );
  return (await tx.query(`SELECT * FROM conversation WHERE id=$1`, [id])).rows[0];
}

/** Agrega un mensaje al hilo. Los salientes se entregan por el trabajador (con reintentos). */
export async function addMessage(
  tx: Tx,
  ctx: Ctx,
  m: {
    conversation_id: string;
    remitente: Remitente;
    contenido: string;
    tipo?: TipoMensaje;
    metadatos?: Record<string, unknown>;
    id_externo?: string | null;
    autor_user_id?: string | null;
    ocurrido_en?: Date | null;
  },
) {
  const conv = (await tx.query(`SELECT id, canal FROM conversation WHERE id=$1`, [m.conversation_id])).rows[0];
  if (!conv) throw notFound();
  const tipo = m.tipo ?? 'TEXTO';
  const saliente = m.remitente !== 'CUSTOMER' && tipo !== 'NOTA_INTERNA';
  const id = uuidv7();
  const ocurrido = m.ocurrido_en ?? new Date();
  const r = await tx.query(
    `INSERT INTO message (id, tenant_id, conversation_id, remitente, autor_user_id, canal, tipo, contenido, metadatos, id_externo, estado_entrega, ocurrido_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`,
    [id, ctx.tenantId, conv.id, m.remitente, m.autor_user_id ?? null, conv.canal, tipo, m.contenido, JSON.stringify(m.metadatos ?? {}), m.id_externo ?? null, saliente ? 'PENDIENTE' : 'N/A', ocurrido.toISOString()],
  );
  if (!r.rows[0]) return { id: null, duplicado: true }; // reenvío del mismo mensaje del canal
  // Un mensaje retrasado no retrocede la ventana de servicio: se queda con el más reciente.
  await tx.query(
    `UPDATE conversation SET actualizado_en=now() ${m.remitente === 'CUSTOMER' ? ', ultimo_mensaje_cliente_en = GREATEST(coalesce(ultimo_mensaje_cliente_en, $2), $2)' : ''} WHERE id=$1`,
    m.remitente === 'CUSTOMER' ? [conv.id, ocurrido.toISOString()] : [conv.id],
  );
  if (tipo !== 'NOTA_INTERNA') await addUsage(tx, ctx.tenantId, 'mensajes', 1);
  if (saliente) await enqueue(tx, ctx.tenantId, 'enviar_mensaje', { message_id: id }, { claveUnica: `msg:${id}`, maxIntentos: 6 });
  return { id, duplicado: false };
}

export function ventanaAbierta(ultimoMensajeCliente: string | Date | null | undefined, ahora = Date.now()): boolean {
  return !!ultimoMensajeCliente && ahora - new Date(ultimoMensajeCliente).getTime() < VENTANA_SERVICIO_MS;
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------
const FILTROS = ['todas', 'escaladas', 'ia', 'mias', 'cola', 'cerradas'] as const;

/** Un asesor sin supervisión solo ve sus casos, la cola sin asignar y las conversaciones sin caso. */
function soloLasSuyas(ctx: Ctx, params: unknown[]): string | null {
  if (can(ctx, 'case:supervise') || can(ctx, 'tenant:configure')) return null;
  params.push(ctx.actor.id);
  return `(k.id IS NULL OR k.asignado_a = $${params.length} OR k.estado = 'EN_COLA')`;
}

/** Ventana en que un mensaje sin leer cuenta como aviso (lo más antiguo ya no es una novedad). */
const DIAS_AVISO = 7;

/**
 * Avisos del menú: conversaciones con mensajes del cliente que esta persona aún no ha visto y
 * conversaciones que esperan la respuesta de una persona (escaladas cuyo último mensaje es del
 * cliente). Liviano: lo consulta el panel cada pocos segundos.
 */
export async function avisos(tx: Tx, ctx: Ctx) {
  const params: unknown[] = [ctx.actor.id];
  const filtro = soloLasSuyas(ctx, params);
  const base = `
    FROM conversation v JOIN customer c ON c.id=v.customer_id
    LEFT JOIN LATERAL (SELECT * FROM support_case s WHERE s.conversation_id=v.id ORDER BY creado_en DESC LIMIT 1) k ON true
    LEFT JOIN conversation_lectura l ON l.conversation_id=v.id AND l.user_id=$1
    LEFT JOIN LATERAL (SELECT max(coalesce(m.ocurrido_en, m.creado_en)) AS en FROM message m WHERE m.conversation_id=v.id AND m.remitente='HUMAN' AND m.tipo<>'NOTA_INTERNA') h ON true
    WHERE v.ultimo_mensaje_cliente_en > now() - interval '${DIAS_AVISO} days' ${filtro ? `AND ${filtro}` : ''}`;
  const nuevo = `v.ultimo_mensaje_cliente_en > coalesce(l.leido_en, 'epoch'::timestamptz)`;
  const espera = `(v.estado='ESCALADA' AND v.ultimo_mensaje_cliente_en > coalesce(h.en, 'epoch'::timestamptz))`;
  const r = (await tx.query(
    `SELECT count(*) FILTER (WHERE ${nuevo} OR ${espera})::int AS total, count(*) FILTER (WHERE ${nuevo})::int AS sin_leer, count(*) FILTER (WHERE ${espera})::int AS por_atender ${base}`, params)).rows[0];
  const ultima = (await tx.query(
    `SELECT v.id, c.nombre AS cliente, v.ultimo_mensaje_cliente_en AS en, ${espera} AS espera,
            (SELECT contenido FROM message m WHERE m.conversation_id=v.id AND m.remitente='CUSTOMER' ORDER BY coalesce(m.ocurrido_en, m.creado_en) DESC LIMIT 1) AS texto
     ${base} AND (${nuevo} OR ${espera}) ORDER BY v.ultimo_mensaje_cliente_en DESC LIMIT 1`, params)).rows[0];
  return {
    conversaciones: {
      total: r.total, sin_leer: r.sin_leer, por_atender: r.por_atender,
      ultima: ultima ? { id: ultima.id, cliente: ultima.cliente, en: ultima.en, espera: !!ultima.espera, texto: String(ultima.texto ?? '').slice(0, 120) } : null,
    },
  };
}

export async function listInbox(tx: Tx, ctx: Ctx, filtro: string = 'todas', q?: string) {
  requirePerm(ctx, 'conversation:read');
  const f = (FILTROS as readonly string[]).includes(filtro) ? filtro : 'todas';
  const params: unknown[] = [];
  const where: string[] = [];
  if (f === 'escaladas') where.push(`v.estado='ESCALADA'`);
  if (f === 'ia') where.push(`v.control='AI' AND v.estado='ABIERTA'`);
  if (f === 'cerradas') where.push(`v.estado='CERRADA'`);
  if (f === 'cola') where.push(`k.estado='EN_COLA'`);
  if (f === 'mias') { params.push(ctx.actor.id); where.push(`k.asignado_a = $${params.length} AND k.estado <> 'CERRADO'`); }
  const busqueda = (q ?? '').trim().slice(0, 80);
  if (busqueda) { params.push(`%${busqueda}%`); where.push(`(c.nombre ILIKE $${params.length} OR c.telefono ILIKE $${params.length} OR k.radicado ILIKE $${params.length})`); }
  const propias = soloLasSuyas(ctx, params);
  if (propias) where.push(propias);
  params.push(ctx.actor.id);
  const yo = params.length;
  const rows = (await tx.query(
    `SELECT v.id, v.canal, v.estado, v.control, v.resuelta_por, v.actualizado_en, v.ultimo_mensaje_cliente_en,
            c.id AS customer_id, c.nombre AS cliente, c.telefono,
            (SELECT contenido FROM message m WHERE m.conversation_id=v.id AND m.tipo<>'NOTA_INTERNA' ORDER BY coalesce(m.ocurrido_en, m.creado_en) DESC LIMIT 1) AS ultimo,
            (SELECT count(*)::int FROM ai_execution e WHERE e.conversation_id=v.id AND e.decision IN ('PERMITIDA','CONFIRMADA')) AS ia_ejecutadas,
            (SELECT count(*)::int FROM ai_execution e WHERE e.conversation_id=v.id AND e.decision='DENEGADA') AS ia_bloqueadas,
            k.id AS case_id, k.radicado, k.prioridad, k.estado AS estado_caso, k.sla_vence_en, k.primera_respuesta_en, k.asignado_a,
            u.nombre AS asignado,
            (v.ultimo_mensaje_cliente_en IS NOT NULL AND v.ultimo_mensaje_cliente_en > now() - interval '${DIAS_AVISO} days'
              AND v.ultimo_mensaje_cliente_en > coalesce((SELECT l.leido_en FROM conversation_lectura l WHERE l.conversation_id=v.id AND l.user_id=$${yo}), 'epoch'::timestamptz)) AS sin_leer
     FROM conversation v JOIN customer c ON c.id=v.customer_id
     LEFT JOIN LATERAL (SELECT * FROM support_case s WHERE s.conversation_id=v.id ORDER BY creado_en DESC LIMIT 1) k ON true
     LEFT JOIN users u ON u.id = k.asignado_a
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE WHEN k.estado IN ('EN_COLA','ASIGNADO') AND k.primera_respuesta_en IS NULL THEN 0 ELSE 1 END, v.actualizado_en DESC LIMIT 200`,
    params,
  )).rows;
  const contadores = (await tx.query(
    `SELECT count(*) FILTER (WHERE v.estado='ABIERTA' AND v.control='AI')::int AS ia,
            count(*) FILTER (WHERE v.estado='ESCALADA')::int AS escaladas,
            count(*) FILTER (WHERE v.estado='CERRADA')::int AS cerradas,
            (SELECT count(*)::int FROM support_case WHERE estado='EN_COLA') AS cola,
            (SELECT count(*)::int FROM support_case WHERE estado <> 'CERRADO' AND asignado_a = $1) AS mias,
            count(*)::int AS todas FROM conversation v`,
    [ctx.actor.id],
  )).rows[0];
  return { conversaciones: rows, contadores };
}

export async function conversationDetail(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'conversation:read');
  if (!isUuid(id)) throw notFound();
  const v = (await tx.query(
    `SELECT v.*, c.nombre AS cliente, c.telefono, c.email, c.consentimiento_en, c.tipo_documento, c.numero_documento
     FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE v.id=$1`, [id])).rows[0];
  if (!v) throw notFound();
  const caso = (await tx.query(
    `SELECT k.*, u.nombre AS asignado FROM support_case k LEFT JOIN users u ON u.id=k.asignado_a
     WHERE k.conversation_id=$1 ORDER BY k.creado_en DESC LIMIT 1`, [id])).rows[0] ?? null;
  if (caso && !can(ctx, 'case:supervise') && !can(ctx, 'tenant:configure') && caso.asignado_a && caso.asignado_a !== ctx.actor.id && caso.estado !== 'CERRADO') {
    throw notFound();
  }
  // Abrirla la marca como leída para esta persona (el aviso del menú desaparece).
  if (ctx.actor.tipo === 'USUARIO' && ctx.actor.id) {
    await tx.query(`INSERT INTO conversation_lectura (tenant_id, user_id, conversation_id) VALUES ($1,$2,$3)
                    ON CONFLICT (tenant_id, user_id, conversation_id) DO UPDATE SET leido_en=now()`, [ctx.tenantId, ctx.actor.id, id]);
  }
  const mensajes = (await tx.query(
    `SELECT m.id, m.remitente, m.tipo, m.contenido, m.metadatos, m.estado_entrega, m.error_entrega, coalesce(m.ocurrido_en, m.creado_en) AS creado_en, u.nombre AS autor
     FROM message m LEFT JOIN users u ON u.id=m.autor_user_id WHERE m.conversation_id=$1 ORDER BY coalesce(m.ocurrido_en, m.creado_en), m.creado_en`, [id])).rows;
  const ejecuciones = (await tx.query(`SELECT * FROM ai_execution WHERE conversation_id=$1 ORDER BY creado_en`, [id])).rows;
  const pendientes = (await tx.query(`SELECT id, herramienta, resumen, expira_en FROM pending_action WHERE conversation_id=$1 AND estado='PENDIENTE' AND expira_en > now()`, [id])).rows;
  const ventas = (await tx.query(
    `SELECT o.id, o.numero, o.total, o.creado_en, f.estado AS estado_fiscal FROM "order" o
     LEFT JOIN fiscal_document f ON f.order_id=o.id AND f.tipo='FACTURA' WHERE o.customer_id=$1 ORDER BY o.creado_en DESC LIMIT 5`, [v.customer_id])).rows
    .map((o) => ({ ...o, total: Number(o.total) }));
  const citas = (await tx.query(
    `SELECT a.id, a.inicio, a.estado, p.nombre AS servicio FROM appointment a JOIN product p ON p.id=a.product_id
     WHERE a.customer_id=$1 ORDER BY a.inicio DESC LIMIT 5`, [v.customer_id])).rows;
  const historial = caso ? (await tx.query(
    `SELECT e.accion, e.de_estado, e.a_estado, e.actor_nombre, e.creado_en, u.nombre AS asignado, e.detalle
     FROM case_event e LEFT JOIN users u ON u.id=e.asignado_a WHERE e.case_id=$1 ORDER BY e.creado_en`, [caso.id])).rows : [];
  const plantillas = (await tx.query(`SELECT clave, cuerpo, estado_aprobacion, variables FROM message_template WHERE categoria='UTILIDAD' ORDER BY clave`)).rows;
  const puedeReabrir = !!caso && caso.estado === 'CERRADO' && caso.cerrado_en && Date.now() - new Date(caso.cerrado_en).getTime() < PLAZO_REAPERTURA_MS;
  // Acceso del soporte de Omnegia a esta conversación: lo concede y lo ve quien administra la empresa.
  const soporte = can(ctx, 'tenant:configure') ? {
    acceso: (await tx.query(
      `SELECT id, motivo, otorgado_por_nombre, ticket_numero, expira_en, creado_en, puede_responder FROM acceso_soporte WHERE conversation_id=$1 AND revocado_en IS NULL AND expira_en > now() ORDER BY expira_en DESC LIMIT 1`, [id])).rows[0] ?? null,
    lecturas: (await tx.query(
      `SELECT creado_en FROM audit_event WHERE accion='soporte.conversacion_leida' AND recurso_id=$1 ORDER BY creado_en DESC LIMIT 20`, [id])).rows.map((r) => r.creado_en),
  } : null;
  return { ...v, caso, historial, mensajes, ejecuciones, pendientes, ventas, citas, plantillas, soporte, puede_reabrir: puedeReabrir, ventana_abierta: v.canal !== 'WHATSAPP' || ventanaAbierta(v.ultimo_mensaje_cliente_en) };
}

// ---------------------------------------------------------------------------
// Acceso del soporte de Omnegia a una conversación (autorizado por la empresa)
// ---------------------------------------------------------------------------
const AccesoSoporteInput = z.object({
  motivo: z.string().trim().min(10, 'Explica para qué lo necesita soporte (mínimo 10 caracteres).').max(300),
  horas: z.union([z.literal(24), z.literal(72), z.literal(168)], 'Elige por cuánto tiempo.'),
  ticket: z.string().trim().toUpperCase().regex(/^SOP-\d{6}$/, 'El número de solicitud tiene la forma SOP-000123.').optional().nullable().or(z.literal('').transform(() => null)),
  /** Además de leer, soporte puede escribirle al cliente (con la misma vigencia). */
  responder: z.boolean().optional().default(false),
});

/**
 * La empresa comparte UNA conversación con el soporte de Omnegia por un tiempo limitado. Sin esto, el
 * equipo de Omnegia no puede leer el contenido: la base de datos se lo impide. Funciona aunque la
 * suscripción esté suspendida (es justo cuando más se necesita soporte).
 */
export async function otorgarAccesoSoporte(tx: Tx, ctx: Ctx, conversationId: string, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  if (!isUuid(conversationId)) throw notFound();
  const d = AccesoSoporteInput.parse(body ?? {});
  const v = (await tx.query(`SELECT id FROM conversation WHERE id=$1`, [conversationId])).rows[0];
  if (!v) throw notFound();
  if (d.ticket && !(await tx.query(`SELECT 1 FROM soporte_ticket WHERE numero=$1`, [d.ticket])).rows[0]) throw invalid('No encontramos esa solicitud de soporte en tu empresa.');
  // Pedir ayuda desde el chat abre la solicitud a Omnegia en el mismo paso (si no se indicó una existente).
  let ticket = d.ticket ?? null;
  let ticketId: string | null = null;
  if (!ticket) {
    const cliente = (await tx.query(`SELECT c.nombre FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE v.id=$1`, [conversationId])).rows[0]?.nombre ?? 'un cliente';
    const t = await crearTicket(tx, ctx, {
      categoria: 'WHATSAPP', prioridad: 'ALTA', asunto: `Ayuda con la conversación de ${cliente}`.slice(0, 120),
      descripcion: `${d.motivo}\n\nConversación compartida con soporte por ${d.horas} horas (${d.responder ? 'puede leer y responder al cliente' : 'solo lectura'}).`,
    });
    ticket = t.numero; ticketId = t.id;
  }
  await tx.query(`UPDATE acceso_soporte SET revocado_en=now(), revocado_por_nombre=$2 WHERE conversation_id=$1 AND revocado_en IS NULL AND expira_en > now()`, [conversationId, `${ctx.actor.nombre} (reemplazado)`]);
  const id = uuidv7();
  const r = (await tx.query(
    `INSERT INTO acceso_soporte (id, tenant_id, conversation_id, otorgado_por, otorgado_por_nombre, motivo, ticket_numero, expira_en, puede_responder)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' hours')::interval, $9) RETURNING expira_en`,
    [id, ctx.tenantId, conversationId, ctx.actor.id, ctx.actor.nombre, d.motivo, ticket, String(d.horas), d.responder])).rows[0];
  await audit(tx, ctx, { accion: 'soporte.acceso_otorgado', recurso: 'conversation', recursoId: conversationId, resultado: 'EXITO', detalle: { horas: d.horas, ticket, responder: d.responder } });
  return { ok: true, id, expira_en: r.expira_en, ticket, ticket_id: ticketId, puede_responder: d.responder };
}

export async function revocarAccesoSoporte(tx: Tx, ctx: Ctx, conversationId: string) {
  requirePerm(ctx, 'tenant:configure');
  if (!isUuid(conversationId)) throw notFound();
  const r = await tx.query(
    `UPDATE acceso_soporte SET revocado_en=now(), revocado_por_nombre=$2 WHERE conversation_id=$1 AND revocado_en IS NULL AND expira_en > now() RETURNING id`,
    [conversationId, ctx.actor.nombre]);
  if (!r.rows.length) throw new AppError('CONFLICT', 'Esta conversación no tiene un acceso de soporte vigente.');
  await audit(tx, ctx, { accion: 'soporte.acceso_revocado', recurso: 'conversation', recursoId: conversationId, resultado: 'EXITO' });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Escalamiento y radicados
// ---------------------------------------------------------------------------
async function nextRadicado(tx: Tx, tenantId: string): Promise<string> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rad:${tenantId}`]);
  const y = new Date().getUTCFullYear();
  const n = Number((await tx.query(`SELECT count(*)::int AS n FROM support_case WHERE radicado LIKE $1`, [`RAD-${y}-%`])).rows[0].n) + 1;
  return `RAD-${y}-${String(n).padStart(5, '0')}`;
}

/** Motor de asignación: disponibilidad, carga y habilidades. */
async function pickAgent(tx: Tx, habilidad?: string): Promise<string | null> {
  const rows = (await tx.query(
    `SELECT ut.user_id, ut.habilidades,
            (SELECT count(*)::int FROM support_case k WHERE k.asignado_a = ut.user_id AND k.estado <> 'CERRADO') AS carga
     FROM user_tenant ut
     WHERE ut.activo AND ut.disponible
       AND EXISTS (SELECT 1 FROM role_permission rp WHERE rp.role_id = ut.role_id AND rp.permiso = 'case:manage')
     ORDER BY carga ASC, ut.creado_en ASC`,
  )).rows;
  if (!rows.length) return null;
  const conHabilidad = habilidad ? rows.find((r: any) => (r.habilidades ?? []).includes(habilidad)) : null;
  return (conHabilidad ?? rows[0]).user_id;
}

async function minutosSla(tx: Tx, prioridad: Prioridad) {
  return Number((await tx.query(`SELECT minutos_primera_respuesta FROM sla_policy WHERE prioridad=$1`, [prioridad])).rows[0]?.minutos_primera_respuesta ?? 60);
}

export async function escalate(
  tx: Tx,
  ctx: Ctx,
  conversationId: string,
  motivo: string,
  prioridad: Prioridad = 'MEDIA',
  opts: { asignarA?: string | null } = {},
) {
  requirePerm(ctx, 'case:create');
  if (!PRIORIDADES.includes(prioridad)) throw invalid('Prioridad no válida.');
  const v = (await tx.query(`SELECT id, estado FROM conversation WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
  if (!v) throw notFound();
  const abierto = (await tx.query(`SELECT id, radicado, asignado_a FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO'`, [conversationId])).rows[0];
  if (abierto) {
    await tx.query(`UPDATE conversation SET estado='ESCALADA', control='HUMANO', actualizado_en=now() WHERE id=$1`, [conversationId]);
    return { case_id: abierto.id, radicado: abierto.radicado, existente: true, asignado: abierto.asignado_a };
  }
  const sla = await minutosSla(tx, prioridad);
  const radicado = await nextRadicado(tx, ctx.tenantId);
  const asignado = opts.asignarA ?? (await pickAgent(tx));
  const id = uuidv7();
  const estado: EstadoCaso = asignado ? 'ASIGNADO' : 'EN_COLA';
  await tx.query(
    `INSERT INTO support_case (id, tenant_id, radicado, conversation_id, motivo, prioridad, estado, asignado_a, sla_vence_en, tomado_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval, $10)`,
    [id, ctx.tenantId, radicado, conversationId, motivo.slice(0, 500), prioridad, estado, asignado, String(sla), opts.asignarA ? new Date().toISOString() : null],
  );
  await tx.query(`UPDATE conversation SET estado='ESCALADA', control='HUMANO', actualizado_en=now() WHERE id=$1`, [conversationId]);
  await registrarEvento(tx, ctx, { id }, 'crear', null, estado, asignado, { motivo: motivo.slice(0, 300), prioridad });
  await audit(tx, ctx, { accion: 'caso.escalar', recurso: 'support_case', recursoId: id, resultado: 'EXITO', detalle: { radicado, motivo, prioridad, asignado } });
  await publish(tx, ctx, 'caso_escalado', { case_id: id, radicado, prioridad, asignado });
  await enqueue(tx, ctx.tenantId, 'resumir_caso', { case_id: id }, { claveUnica: `resumen:${id}` });
  // Al vencer el SLA sin primera respuesta se avisa al administrador.
  await enqueue(tx, ctx.tenantId, 'revisar_sla', { case_id: id }, { ejecutarEn: new Date(Date.now() + sla * 60000), claveUnica: `sla:${id}:0` });
  return { case_id: id, radicado, existente: false, asignado };
}

async function loadCase(tx: Tx, caseId: string) {
  if (!isUuid(caseId)) throw notFound();
  const k = (await tx.query(`SELECT k.*, u.nombre AS asignado_nombre FROM support_case k LEFT JOIN users u ON u.id=k.asignado_a WHERE k.id=$1 FOR UPDATE OF k`, [caseId])).rows[0];
  if (!k) throw notFound();
  return k;
}
const esSupervisor = (ctx: Ctx) => can(ctx, 'case:supervise');

/**
 * Tomar (aceptar) un radicado. Si dos asesores lo intentan a la vez, el bloqueo de
 * fila serializa las peticiones y el segundo recibe «ya lo tomó…».
 */
export async function takeCase(tx: Tx, ctx: Ctx, caseId: string) {
  requirePerm(ctx, 'case:manage');
  requireWritable(ctx);
  const k = await loadCase(tx, caseId);
  if (k.asignado_a && k.asignado_a !== ctx.actor.id) {
    if (!esSupervisor(ctx) && k.estado !== 'EN_COLA') throw new AppError('CONFLICT', `Este radicado ya lo tomó ${k.asignado_nombre ?? 'otra persona'}.`);
    if (esSupervisor(ctx)) throw new AppError('CONFLICT', `Este radicado lo tiene ${k.asignado_nombre ?? 'otra persona'}. Usa «Reasignar» para cambiar el responsable.`);
  }
  if (k.asignado_a === ctx.actor.id && k.tomado_en) return { ok: true, sin_cambios: true };
  const a: EstadoCaso = k.estado === 'EN_COLA' ? 'ASIGNADO' : k.estado;
  exigirTransicion(k.estado, a);
  await tx.query(`UPDATE support_case SET asignado_a=$2, estado=$3, tomado_en=now() WHERE id=$1`, [caseId, ctx.actor.id, a]);
  await registrarEvento(tx, ctx, k, 'tomar', k.estado, a, ctx.actor.id);
  await audit(tx, ctx, { accion: 'caso.tomar', recurso: 'support_case', recursoId: caseId, resultado: 'EXITO' });
  return { ok: true };
}

export async function reassignCase(tx: Tx, ctx: Ctx, caseId: string, userId: string) {
  requirePerm(ctx, 'case:supervise');
  requireWritable(ctx);
  if (!isUuid(userId)) throw notFound();
  const k = await loadCase(tx, caseId);
  const member = (await tx.query(
    `SELECT ut.user_id FROM user_tenant ut WHERE ut.user_id=$1 AND ut.activo
       AND EXISTS (SELECT 1 FROM role_permission rp WHERE rp.role_id=ut.role_id AND rp.permiso='case:manage')`, [userId])).rows[0];
  if (!member) throw invalid('Esa persona no atiende radicados (su rol no lo permite o no está activa).');
  const a: EstadoCaso = k.estado === 'EN_COLA' ? 'ASIGNADO' : k.estado;
  exigirTransicion(k.estado, a);
  await tx.query(`UPDATE support_case SET asignado_a=$2, estado=$3, tomado_en=NULL WHERE id=$1`, [k.id, userId, a]);
  await registrarEvento(tx, ctx, k, 'reasignar', k.estado, a, userId, { de: k.asignado_a });
  await audit(tx, ctx, { accion: 'caso.reasignar', recurso: 'support_case', recursoId: k.id, resultado: 'EXITO', detalle: { de: k.asignado_a, a: userId } });
  return { ok: true };
}

export async function changePriority(tx: Tx, ctx: Ctx, caseId: string, prioridad: string) {
  requirePerm(ctx, 'case:supervise');
  requireWritable(ctx);
  if (!PRIORIDADES.includes(prioridad as Prioridad)) throw invalid('Prioridad no válida.');
  const k = await loadCase(tx, caseId);
  if (k.estado === 'CERRADO') throw new AppError('CONFLICT', 'El radicado está cerrado.');
  const sla = await minutosSla(tx, prioridad as Prioridad);
  // El SLA se recalcula desde la creación del radicado, no desde el cambio.
  await tx.query(`UPDATE support_case SET prioridad=$2, sla_vence_en = creado_en + ($3 || ' minutes')::interval WHERE id=$1`, [k.id, prioridad, String(sla)]);
  await registrarEvento(tx, ctx, k, 'prioridad', k.estado, k.estado, k.asignado_a, { de: k.prioridad, a: prioridad });
  await audit(tx, ctx, { accion: 'caso.prioridad', recurso: 'support_case', recursoId: k.id, resultado: 'EXITO', detalle: { de: k.prioridad, a: prioridad } });
  if (!k.primera_respuesta_en) await enqueue(tx, ctx.tenantId, 'revisar_sla', { case_id: k.id }, { ejecutarEn: new Date(new Date(k.creado_en).getTime() + sla * 60000), claveUnica: `sla:${k.id}:${prioridad}` });
  return { ok: true };
}

/** Respuesta humana desde el panel, nunca desde un canal personal. */
export async function humanReply(tx: Tx, ctx: Ctx, conversationId: string, texto: string, nota = false) {
  requirePerm(ctx, 'conversation:reply');
  requireWritable(ctx);
  if (!isUuid(conversationId)) throw notFound();
  const t = texto.trim();
  if (!t) throw invalid('El mensaje está vacío.');
  if (t.length > 4000) throw invalid('El mensaje supera 4.000 caracteres.');
  const v = (await tx.query(`SELECT * FROM conversation WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
  if (!v) throw notFound();
  let k = (await tx.query(`SELECT * FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO' ORDER BY creado_en DESC LIMIT 1 FOR UPDATE`, [conversationId])).rows[0];
  if (k && k.asignado_a && k.asignado_a !== ctx.actor.id && !esSupervisor(ctx)) throw notFound();
  if (!nota && v.canal === 'WHATSAPP' && !ventanaAbierta(v.ultimo_mensaje_cliente_en)) {
    throw new AppError('CONFLICT', 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se puede escribir con una plantilla aprobada.');
  }
  if (!nota && !k) {
    // Intervención directa: la IA calla y queda un radicado a nombre de quien responde.
    if (!can(ctx, 'case:create')) throw new AppError('FORBIDDEN', 'Tu rol no puede tomar conversaciones que atiende la IA.');
    const r = await escalate(tx, ctx, conversationId, `Intervención de ${ctx.actor.nombre}`, 'MEDIA', { asignarA: ctx.actor.id });
    k = (await tx.query(`SELECT * FROM support_case WHERE id=$1`, [r.case_id])).rows[0];
  }
  const r = await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'HUMAN', contenido: t, autor_user_id: ctx.actor.id, tipo: nota ? 'NOTA_INTERNA' : 'TEXTO' });
  if (!nota) {
    // Mientras una persona atiende, la IA no le habla al cliente (solo asiste al asesor).
    await tx.query(`UPDATE conversation SET control='HUMANO', estado='ESCALADA' WHERE id=$1`, [v.id]);
    if (k && k.estado !== 'EN_ATENCION') {
      exigirTransicion(k.estado, 'EN_ATENCION');
      await registrarEvento(tx, ctx, k, 'responder', k.estado, 'EN_ATENCION', k.asignado_a ?? ctx.actor.id);
    }
    if (k) {
      await tx.query(
        `UPDATE support_case SET estado='EN_ATENCION', asignado_a=coalesce(asignado_a,$2), tomado_en=coalesce(tomado_en, now()), primera_respuesta_en=coalesce(primera_respuesta_en, now()) WHERE id=$1`,
        [k.id, ctx.actor.id],
      );
    }
  }
  await audit(tx, ctx, { accion: nota ? 'conversacion.nota' : 'conversacion.responder', recurso: 'conversation', recursoId: v.id, resultado: 'EXITO' });
  return r;
}

/**
 * Respuesta del soporte de Omnegia al cliente de una empresa. Solo existe si la empresa compartió la
 * conversación con permiso para responder y el acceso sigue vigente: se comprueba aquí, dentro de la
 * transacción de la empresa, aunque la ruta ya lo haya verificado. Sale por el canal de la empresa
 * marcada como «Soporte de Omnegia» y no cambia el responsable del radicado.
 */
export async function respuestaSoporte(tx: Tx, ctx: Ctx, conversationId: string, texto: string, operador: string) {
  if (!isUuid(conversationId)) throw notFound();
  const t = texto.trim();
  if (!t) throw invalid('El mensaje está vacío.');
  if (t.length > 4000) throw invalid('El mensaje supera 4.000 caracteres.');
  const g = (await tx.query(
    `SELECT id FROM acceso_soporte WHERE conversation_id=$1 AND puede_responder AND revocado_en IS NULL AND expira_en > now() ORDER BY expira_en DESC LIMIT 1 FOR UPDATE`, [conversationId])).rows[0];
  if (!g) throw new AppError('FORBIDDEN', 'La empresa no autorizó a soporte a responder esta conversación o el acceso venció.');
  const v = (await tx.query(`SELECT * FROM conversation WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
  if (!v) throw notFound();
  if (v.estado === 'CERRADA') throw new AppError('CONFLICT', 'La empresa cerró esta conversación.');
  if (v.canal === 'WHATSAPP' && !ventanaAbierta(v.ultimo_mensaje_cliente_en)) {
    throw new AppError('CONFLICT', 'Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla de la empresa.');
  }
  const r = await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'HUMAN', contenido: t, autor_user_id: null, metadatos: { soporte_omnegia: true, operador } });
  // Con una persona al frente la IA no contesta; el radicado conserva su responsable.
  await tx.query(`UPDATE conversation SET control='HUMANO', estado='ESCALADA' WHERE id=$1`, [v.id]);
  await tx.query(`UPDATE support_case SET primera_respuesta_en=coalesce(primera_respuesta_en, now()) WHERE conversation_id=$1 AND estado <> 'CERRADO'`, [v.id]);
  await audit(tx, ctx, { accion: 'soporte.respuesta_enviada', recurso: 'conversation', recursoId: v.id, resultado: 'EXITO', detalle: { operador } });
  return r;
}

/** Envía una plantilla aprobada (única vía fuera de la ventana de 24 horas). */
export async function sendTemplateFromPanel(tx: Tx, ctx: Ctx, conversationId: string, clave: string, variables: Record<string, string>) {
  requirePerm(ctx, 'conversation:reply');
  requireWritable(ctx);
  if (!isUuid(conversationId)) throw notFound();
  const v = (await tx.query(`SELECT v.*, c.nombre FROM conversation v JOIN customer c ON c.id=v.customer_id WHERE v.id=$1`, [conversationId])).rows[0];
  if (!v) throw notFound();
  const tpl = (await tx.query(`SELECT * FROM message_template WHERE clave=$1`, [clave])).rows[0];
  if (!tpl) throw notFound();
  if (tpl.categoria !== 'UTILIDAD') throw invalid('Desde una conversación solo se envían plantillas de utilidad.');
  const faltan = (tpl.variables as string[]).filter((k) => !String(variables?.[k] ?? '').trim());
  if (faltan.length) throw invalid(`Completa: ${faltan.join(', ')}.`, { faltan });
  const contenido = String(tpl.cuerpo).replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => String(variables?.[k] ?? '').slice(0, 200));
  const r = await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'HUMAN', autor_user_id: ctx.actor.id, tipo: 'PLANTILLA', contenido, metadatos: { plantilla: clave, variables } });
  await audit(tx, ctx, { accion: 'conversacion.plantilla', recurso: 'conversation', recursoId: v.id, resultado: 'EXITO', detalle: { plantilla: clave } });
  return r;
}

export async function closeCase(tx: Tx, ctx: Ctx, conversationId: string, motivo: string) {
  requirePerm(ctx, 'case:manage');
  requireWritable(ctx);
  if (!motivo?.trim()) throw invalid('Indica el motivo de cierre.');
  if (!isUuid(conversationId)) throw notFound();
  const v = (await tx.query(`SELECT id, estado FROM conversation WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
  if (!v) throw notFound();
  if (v.estado === 'CERRADA') throw new AppError('CONFLICT', 'La conversación ya está cerrada.');
  const k = (await tx.query(`SELECT * FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO' ORDER BY creado_en DESC LIMIT 1 FOR UPDATE`, [conversationId])).rows[0];
  if (k) {
    if (k.asignado_a && k.asignado_a !== ctx.actor.id && !esSupervisor(ctx)) throw notFound();
    exigirTransicion(k.estado, 'CERRADO');
    await tx.query(`UPDATE support_case SET estado='CERRADO', cerrado_en=now(), motivo_cierre=$2 WHERE id=$1`, [k.id, motivo.slice(0, 300)]);
    await registrarEvento(tx, ctx, k, 'cerrar', k.estado, 'CERRADO', k.asignado_a, { motivo: motivo.slice(0, 300) });
    await publish(tx, ctx, 'caso_cerrado', { case_id: k.id, radicado: k.radicado });
  }
  await tx.query(`UPDATE conversation SET estado='CERRADA', control='AI', resuelta_por=$2 WHERE id=$1`, [conversationId, k ? 'PERSONA' : 'AGENTE']);
  await audit(tx, ctx, { accion: 'caso.cerrar', recurso: 'conversation', recursoId: conversationId, resultado: 'EXITO', detalle: { motivo, radicado: k?.radicado } });
  return { ok: true };
}

/** Devolver el control a la IA: el radicado se cierra como «devuelto al agente». */
export async function returnToAi(tx: Tx, ctx: Ctx, conversationId: string) {
  requirePerm(ctx, 'case:manage');
  requireWritable(ctx);
  if (!isUuid(conversationId)) throw notFound();
  const v = (await tx.query(`SELECT id, control FROM conversation WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
  if (!v) throw notFound();
  if (v.control === 'AI') throw new AppError('CONFLICT', 'La IA ya está atendiendo esta conversación.');
  const k = (await tx.query(`SELECT * FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO' FOR UPDATE`, [conversationId])).rows[0];
  if (k) {
    if (k.asignado_a && k.asignado_a !== ctx.actor.id && !esSupervisor(ctx)) throw notFound();
    await tx.query(`UPDATE support_case SET estado='CERRADO', cerrado_en=now(), motivo_cierre='Devuelto al agente de IA' WHERE id=$1`, [k.id]);
    await registrarEvento(tx, ctx, k, 'devolver_ia', k.estado, 'CERRADO', k.asignado_a);
  }
  await tx.query(`UPDATE conversation SET control='AI', estado='ABIERTA' WHERE id=$1`, [conversationId]);
  await audit(tx, ctx, { accion: 'conversacion.devolver_ia', recurso: 'conversation', recursoId: conversationId, resultado: 'EXITO' });
  return { ok: true };
}

/** Reapertura dentro del plazo: vuelve a la persona que lo atendía (o a quien reabre). */
export async function reopenCase(tx: Tx, ctx: Ctx, caseId: string, motivo: string) {
  requirePerm(ctx, 'case:manage');
  requireWritable(ctx);
  if (!motivo?.trim()) throw invalid('Indica por qué se reabre.');
  const k = await loadCase(tx, caseId);
  if (k.estado !== 'CERRADO') throw new AppError('CONFLICT', 'El radicado no está cerrado.');
  if (!k.cerrado_en || Date.now() - new Date(k.cerrado_en).getTime() > PLAZO_REAPERTURA_MS) {
    throw new AppError('CONFLICT', 'Pasaron más de 7 días desde el cierre: escala de nuevo la conversación para abrir un radicado nuevo.');
  }
  const otro = (await tx.query(`SELECT radicado FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO'`, [k.conversation_id])).rows[0];
  if (otro) throw new AppError('CONFLICT', `La conversación ya tiene abierto el radicado ${otro.radicado}.`);
  const responsable = k.asignado_a ?? ctx.actor.id;
  exigirTransicion('CERRADO', 'ASIGNADO');
  await tx.query(`UPDATE support_case SET estado='ASIGNADO', asignado_a=$2, cerrado_en=NULL, motivo_cierre=NULL, reaperturas=reaperturas+1 WHERE id=$1`, [k.id, responsable]);
  await tx.query(`UPDATE conversation SET estado='ESCALADA', control='HUMANO', resuelta_por=NULL, actualizado_en=now() WHERE id=$1`, [k.conversation_id]);
  await registrarEvento(tx, ctx, k, 'reabrir', 'CERRADO', 'ASIGNADO', responsable, { motivo: motivo.slice(0, 300) });
  await audit(tx, ctx, { accion: 'caso.reabrir', recurso: 'support_case', recursoId: k.id, resultado: 'EXITO', detalle: { motivo } });
  return { ok: true, conversation_id: k.conversation_id };
}
