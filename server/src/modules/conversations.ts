import type { Tx } from '../db/index.js';
import { type Ctx, can, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { enqueue, publish } from '../core/events.js';
import { addUsage } from '../core/usage.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';

export type Remitente = 'CUSTOMER' | 'AI' | 'SYSTEM' | 'HUMAN';
export type Prioridad = 'BAJA' | 'MEDIA' | 'ALTA' | 'URGENTE';

const VENTANA_SERVICIO_MS = 24 * 3600 * 1000;

export async function getOrOpenConversation(tx: Tx, ctx: Ctx, customerId: string, canal: 'WHATSAPP' | 'WEB') {
  const c = (await tx.query(
    `SELECT * FROM conversation WHERE customer_id=$1 AND canal=$2 ORDER BY actualizado_en DESC LIMIT 1`,
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
    tipo?: 'TEXTO' | 'NOTA_INTERNA' | 'DOCUMENTO' | 'PLANTILLA';
    metadatos?: Record<string, unknown>;
    id_externo?: string | null;
    autor_user_id?: string | null;
  },
) {
  const conv = (await tx.query(`SELECT id, canal FROM conversation WHERE id=$1`, [m.conversation_id])).rows[0];
  if (!conv) throw notFound();
  const tipo = m.tipo ?? 'TEXTO';
  const saliente = m.remitente !== 'CUSTOMER' && tipo !== 'NOTA_INTERNA';
  const id = uuidv7();
  const r = await tx.query(
    `INSERT INTO message (id, tenant_id, conversation_id, remitente, autor_user_id, canal, tipo, contenido, metadatos, id_externo, estado_entrega)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING id`,
    [id, ctx.tenantId, conv.id, m.remitente, m.autor_user_id ?? null, conv.canal, tipo, m.contenido, JSON.stringify(m.metadatos ?? {}), m.id_externo ?? null, saliente ? 'PENDIENTE' : 'N/A'],
  );
  if (!r.rows[0]) return { id: null, duplicado: true }; // reenvío del mismo mensaje del canal
  await tx.query(
    `UPDATE conversation SET actualizado_en=now() ${m.remitente === 'CUSTOMER' ? ', ultimo_mensaje_cliente_en=now()' : ''} WHERE id=$1`,
    [conv.id],
  );
  if (tipo !== 'NOTA_INTERNA') await addUsage(tx, ctx.tenantId, 'mensajes', 1);
  if (saliente) await enqueue(tx, ctx.tenantId, 'enviar_mensaje', { message_id: id }, { claveUnica: `msg:${id}` });
  return { id, duplicado: false };
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------
export async function listInbox(tx: Tx, ctx: Ctx, filtro: string = 'todas') {
  requirePerm(ctx, 'conversation:read');
  const params: unknown[] = [];
  const where: string[] = [];
  if (filtro === 'escaladas') where.push(`v.estado='ESCALADA'`);
  if (filtro === 'ia') where.push(`v.control='AI' AND v.estado='ABIERTA'`);
  if (filtro === 'cerradas') where.push(`v.estado='CERRADA'`);
  if (filtro === 'mias') { params.push(ctx.actor.id); where.push(`k.asignado_a = $${params.length}`); }
  // Asesor sin supervisión: solo sus casos y la cola sin asignar (PRO-SW-003 §4).
  if (!can(ctx, 'case:supervise') && !can(ctx, 'tenant:configure')) {
    params.push(ctx.actor.id);
    where.push(`(k.asignado_a = $${params.length} OR (k.estado = 'EN_COLA'))`);
  }
  const rows = (await tx.query(
    `SELECT v.id, v.canal, v.estado, v.control, v.resuelta_por, v.actualizado_en, v.ultimo_mensaje_cliente_en,
            c.id AS customer_id, c.nombre AS cliente, c.telefono,
            (SELECT contenido FROM message m WHERE m.conversation_id=v.id AND m.tipo<>'NOTA_INTERNA' ORDER BY creado_en DESC LIMIT 1) AS ultimo,
            (SELECT count(*)::int FROM ai_execution e WHERE e.conversation_id=v.id AND e.decision IN ('PERMITIDA','CONFIRMADA')) AS ia_ejecutadas,
            (SELECT count(*)::int FROM ai_execution e WHERE e.conversation_id=v.id AND e.decision='DENEGADA') AS ia_bloqueadas,
            k.id AS case_id, k.radicado, k.prioridad, k.estado AS estado_caso, k.sla_vence_en, k.primera_respuesta_en,
            u.nombre AS asignado
     FROM conversation v JOIN customer c ON c.id=v.customer_id
     LEFT JOIN LATERAL (SELECT * FROM support_case s WHERE s.conversation_id=v.id ORDER BY creado_en DESC LIMIT 1) k ON true
     LEFT JOIN users u ON u.id = k.asignado_a
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY v.actualizado_en DESC LIMIT 200`,
    params,
  )).rows;
  const contadores = (await tx.query(
    `SELECT count(*) FILTER (WHERE estado='ABIERTA' AND control='AI')::int AS ia,
            count(*) FILTER (WHERE estado='ESCALADA')::int AS escaladas,
            count(*) FILTER (WHERE estado='CERRADA')::int AS cerradas,
            count(*)::int AS todas FROM conversation`,
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
  if (caso && !can(ctx, 'case:supervise') && !can(ctx, 'tenant:configure') && caso.asignado_a && caso.asignado_a !== ctx.actor.id) {
    throw notFound();
  }
  const mensajes = (await tx.query(
    `SELECT m.id, m.remitente, m.tipo, m.contenido, m.metadatos, m.estado_entrega, m.creado_en, u.nombre AS autor
     FROM message m LEFT JOIN users u ON u.id=m.autor_user_id WHERE m.conversation_id=$1 ORDER BY m.creado_en`, [id])).rows;
  const ejecuciones = (await tx.query(`SELECT * FROM ai_execution WHERE conversation_id=$1 ORDER BY creado_en`, [id])).rows;
  const pendientes = (await tx.query(`SELECT id, herramienta, resumen, expira_en FROM pending_action WHERE conversation_id=$1 AND estado='PENDIENTE' AND expira_en > now()`, [id])).rows;
  const ventas = (await tx.query(
    `SELECT o.id, o.numero, o.total, o.creado_en, f.estado AS estado_fiscal FROM "order" o
     LEFT JOIN fiscal_document f ON f.order_id=o.id AND f.tipo='FACTURA' WHERE o.customer_id=$1 ORDER BY o.creado_en DESC LIMIT 5`, [v.customer_id])).rows
    .map((o) => ({ ...o, total: Number(o.total) }));
  const citas = (await tx.query(
    `SELECT a.id, a.inicio, a.estado, p.nombre AS servicio FROM appointment a JOIN product p ON p.id=a.product_id
     WHERE a.customer_id=$1 ORDER BY a.inicio DESC LIMIT 5`, [v.customer_id])).rows;
  const ventanaAbierta = v.ultimo_mensaje_cliente_en ? Date.now() - new Date(v.ultimo_mensaje_cliente_en).getTime() < VENTANA_SERVICIO_MS : false;
  return { ...v, caso, mensajes, ejecuciones, pendientes, ventas, citas, ventana_abierta: ventanaAbierta };
}

// ---------------------------------------------------------------------------
// Escalamiento y radicados (PRO-SW-001 §14.2)
// ---------------------------------------------------------------------------
async function nextRadicado(tx: Tx, tenantId: string): Promise<string> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`rad:${tenantId}`]);
  const y = new Date().getUTCFullYear();
  const n = Number((await tx.query(`SELECT count(*)::int AS n FROM support_case WHERE radicado LIKE $1`, [`RAD-${y}-%`])).rows[0].n) + 1;
  return `RAD-${y}-${String(n).padStart(5, '0')}`;
}

/** Motor de asignación: disponibilidad, carga y habilidades (PRO-SW-001 §14.2). */
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

export async function escalate(
  tx: Tx,
  ctx: Ctx,
  conversationId: string,
  motivo: string,
  prioridad: Prioridad = 'MEDIA',
) {
  requirePerm(ctx, 'case:create');
  const v = (await tx.query(`SELECT id, estado FROM conversation WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
  if (!v) throw notFound();
  const abierto = (await tx.query(`SELECT id, radicado FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO'`, [conversationId])).rows[0];
  if (abierto) return { case_id: abierto.id, radicado: abierto.radicado, existente: true, asignado: null };
  const sla = Number((await tx.query(`SELECT minutos_primera_respuesta FROM sla_policy WHERE prioridad=$1`, [prioridad])).rows[0]?.minutos_primera_respuesta ?? 60);
  const radicado = await nextRadicado(tx, ctx.tenantId);
  const asignado = await pickAgent(tx);
  const id = uuidv7();
  await tx.query(
    `INSERT INTO support_case (id, tenant_id, radicado, conversation_id, motivo, prioridad, estado, asignado_a, sla_vence_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval)`,
    [id, ctx.tenantId, radicado, conversationId, motivo.slice(0, 500), prioridad, asignado ? 'ASIGNADO' : 'EN_COLA', asignado, String(sla)],
  );
  await tx.query(`UPDATE conversation SET estado='ESCALADA', control='HUMANO', actualizado_en=now() WHERE id=$1`, [conversationId]);
  await audit(tx, ctx, { accion: 'caso.escalar', recurso: 'support_case', recursoId: id, resultado: 'EXITO', detalle: { radicado, motivo, prioridad, asignado } });
  await publish(tx, ctx, 'caso_escalado', { case_id: id, radicado, prioridad, asignado });
  await enqueue(tx, ctx.tenantId, 'resumir_caso', { case_id: id }, { claveUnica: `resumen:${id}` });
  if (!asignado) {
    // Nadie disponible: el caso queda en cola y se revisa al vencer el SLA.
    await enqueue(tx, ctx.tenantId, 'revisar_sla', { case_id: id }, { ejecutarEn: new Date(Date.now() + sla * 60000), claveUnica: `sla:${id}` });
  }
  return { case_id: id, radicado, existente: false, asignado };
}

async function loadCaseForAction(tx: Tx, ctx: Ctx, caseId: string) {
  if (!isUuid(caseId)) throw notFound();
  const k = (await tx.query(`SELECT * FROM support_case WHERE id=$1 FOR UPDATE`, [caseId])).rows[0];
  if (!k) throw notFound();
  if (k.asignado_a && k.asignado_a !== ctx.actor.id && !can(ctx, 'case:supervise')) throw notFound();
  return k;
}

export async function takeCase(tx: Tx, ctx: Ctx, caseId: string) {
  requirePerm(ctx, 'case:manage');
  requireWritable(ctx);
  const k = await loadCaseForAction(tx, ctx, caseId);
  if (k.estado === 'CERRADO') throw new AppError('CONFLICT', 'El caso ya está cerrado.');
  await tx.query(`UPDATE support_case SET asignado_a=$2, estado=CASE WHEN estado='EN_COLA' THEN 'ASIGNADO' ELSE estado END WHERE id=$1`, [caseId, ctx.actor.id]);
  await audit(tx, ctx, { accion: 'caso.tomar', recurso: 'support_case', recursoId: caseId, resultado: 'EXITO' });
  return { ok: true };
}

export async function reassignCase(tx: Tx, ctx: Ctx, caseId: string, userId: string) {
  requirePerm(ctx, 'case:supervise');
  requireWritable(ctx);
  if (!isUuid(userId)) throw notFound();
  const k = await loadCaseForAction(tx, ctx, caseId);
  const member = (await tx.query(`SELECT user_id FROM user_tenant WHERE user_id=$1 AND activo`, [userId])).rows[0];
  if (!member) throw notFound();
  await tx.query(`UPDATE support_case SET asignado_a=$2, estado=CASE WHEN estado='EN_COLA' THEN 'ASIGNADO' ELSE estado END WHERE id=$1`, [k.id, userId]);
  await audit(tx, ctx, { accion: 'caso.reasignar', recurso: 'support_case', recursoId: k.id, resultado: 'EXITO', detalle: { de: k.asignado_a, a: userId } });
  return { ok: true };
}

/** Respuesta humana desde el panel, nunca desde un canal personal (PRO-SW-003 §12). */
export async function humanReply(tx: Tx, ctx: Ctx, conversationId: string, texto: string, nota = false) {
  requirePerm(ctx, 'conversation:reply');
  requireWritable(ctx);
  if (!isUuid(conversationId)) throw notFound();
  const t = texto.trim();
  if (!t) throw invalid('El mensaje está vacío.');
  const v = (await tx.query(`SELECT * FROM conversation WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
  if (!v) throw notFound();
  const k = (await tx.query(`SELECT * FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO' ORDER BY creado_en DESC LIMIT 1`, [conversationId])).rows[0];
  if (k && k.asignado_a && k.asignado_a !== ctx.actor.id && !can(ctx, 'case:supervise')) throw notFound();
  if (!nota && v.canal === 'WHATSAPP') {
    const abierta = v.ultimo_mensaje_cliente_en && Date.now() - new Date(v.ultimo_mensaje_cliente_en).getTime() < VENTANA_SERVICIO_MS;
    if (!abierta) throw new AppError('CONFLICT', 'Pasaron más de 24 horas desde el último mensaje del cliente: solo se puede escribir con una plantilla aprobada.');
  }
  const r = await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'HUMAN', contenido: t, autor_user_id: ctx.actor.id, tipo: nota ? 'NOTA_INTERNA' : 'TEXTO' });
  if (!nota) {
    // Si una persona responde, la IA deja de hablarle al cliente (pasa a asistir al asesor).
    await tx.query(`UPDATE conversation SET control='HUMANO', estado=CASE WHEN estado='CERRADA' THEN 'ABIERTA' ELSE estado END WHERE id=$1`, [v.id]);
    if (k) {
      await tx.query(
        `UPDATE support_case SET estado='EN_ATENCION', asignado_a=coalesce(asignado_a,$2), primera_respuesta_en=coalesce(primera_respuesta_en, now()) WHERE id=$1`,
        [k.id, ctx.actor.id],
      );
    }
  }
  await audit(tx, ctx, { accion: nota ? 'conversacion.nota' : 'conversacion.responder', recurso: 'conversation', recursoId: v.id, resultado: 'EXITO' });
  return r;
}

export async function closeCase(tx: Tx, ctx: Ctx, conversationId: string, motivo: string) {
  requirePerm(ctx, 'case:manage');
  requireWritable(ctx);
  if (!motivo?.trim()) throw invalid('Indica el motivo de cierre.');
  if (!isUuid(conversationId)) throw notFound();
  const v = (await tx.query(`SELECT id FROM conversation WHERE id=$1`, [conversationId])).rows[0];
  if (!v) throw notFound();
  const k = (await tx.query(`SELECT * FROM support_case WHERE conversation_id=$1 AND estado <> 'CERRADO' ORDER BY creado_en DESC LIMIT 1`, [conversationId])).rows[0];
  if (k) {
    if (k.asignado_a && k.asignado_a !== ctx.actor.id && !can(ctx, 'case:supervise')) throw notFound();
    await tx.query(`UPDATE support_case SET estado='CERRADO', cerrado_en=now(), motivo_cierre=$2 WHERE id=$1`, [k.id, motivo]);
    await publish(tx, ctx, 'caso_cerrado', { case_id: k.id, radicado: k.radicado });
  }
  await tx.query(`UPDATE conversation SET estado='CERRADA', control='AI', resuelta_por=$2 WHERE id=$1`, [conversationId, k ? 'PERSONA' : 'AGENTE']);
  await audit(tx, ctx, { accion: 'caso.cerrar', recurso: 'conversation', recursoId: conversationId, resultado: 'EXITO', detalle: { motivo, radicado: k?.radicado } });
  return { ok: true };
}

/** Devolver el control a la IA sin cerrar (el asesor terminó su parte). */
export async function returnToAi(tx: Tx, ctx: Ctx, conversationId: string) {
  requirePerm(ctx, 'case:manage');
  requireWritable(ctx);
  if (!isUuid(conversationId)) throw notFound();
  const r = await tx.query(`UPDATE conversation SET control='AI', estado='ABIERTA' WHERE id=$1 RETURNING id`, [conversationId]);
  if (!r.rows[0]) throw notFound();
  await tx.query(`UPDATE support_case SET estado='CERRADO', cerrado_en=now(), motivo_cierre='Devuelto al agente de IA' WHERE conversation_id=$1 AND estado <> 'CERRADO'`, [conversationId]);
  await audit(tx, ctx, { accion: 'conversacion.devolver_ia', recurso: 'conversation', recursoId: conversationId, resultado: 'EXITO' });
  return { ok: true };
}
