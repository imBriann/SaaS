import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { enmascararTelefono, isUuid } from '../lib/util.js';

export { enmascararTelefono };
import { ventanaAbierta } from './conversations.js';
import { revisarContenido } from './soporte.js';
import { verificarWhatsapp } from './channelStatus.js';
import { agregarMensajePlataforma, auditarConversacion } from './plataformaConversaciones.js';
import { auditar, exigir, type Operador } from './operador.js';

/**
 * Atención por WhatsApp desde el panel del operador.
 *
 *  - Conversaciones del número de Omnegia: son de Omnegia, así que el equipo las lee completas, las toma,
 *    las asigna, responde y cierra. Cada acción queda en la auditoría del operador.
 *  - Atención de las empresas: solo indicadores (abiertas, escaladas, tiempos, entregas fallidas). El rol
 *    app_operador no tiene permiso sobre el texto, el cliente ni su teléfono: la base lo rechaza.
 *  - Lectura autorizada: si una empresa comparte una conversación con soporte, se lee con el rol
 *    app_soporte, cuyas políticas exigen el acceso vigente fila por fila. Queda evidencia en ambos lados.
 *
 * Las lecturas usan el rol del operador; las escrituras sobre el canal propio las ejecuta el servidor con
 * el rol de plataforma después de comprobar el permiso, porque encolan el envío a WhatsApp.
 */
const VISTAS = ['activas', 'pendientes', 'sin_asignar', 'mias', 'ia', 'cerradas', 'todas'] as const;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Espera a una persona del equipo: se pasó a una persona y nadie del equipo ha respondido todavía, o la
 * persona volvió a escribir después de la última respuesta del equipo. Los avisos automáticos del
 * asistente («una persona te responde pronto») no cuentan como respuesta.
 */
const PENDIENTE_SQL = `(c.estado <> 'CERRADA' AND c.control='HUMANO' AND (c.primera_respuesta_humana_en IS NULL OR (c.ultimo_mensaje_cliente_en IS NOT NULL AND c.ultimo_mensaje_cliente_en > coalesce(
  (SELECT max(m.creado_en) FROM plataforma_mensaje m WHERE m.conversacion_id=c.id AND m.remitente='OPERADOR' AND m.tipo='TEXTO'), '-infinity'::timestamptz))))`;

export async function listarConversaciones(db: Database, op: Operador, q: any) {
  exigir(op, 'conversaciones:ver');
  const vista = (VISTAS as readonly string[]).includes(String(q?.vista)) ? String(q.vista) : 'activas';
  const empresa = isUuid(q?.empresa) ? q.empresa : null;
  const responsable = q?.responsable === 'nadie' ? 'nadie' : isUuid(q?.responsable) ? q.responsable : null;
  const desde = FECHA.test(String(q?.desde ?? '')) ? `${q.desde}T00:00:00-05:00` : null;
  const hasta = FECHA.test(String(q?.hasta ?? '')) ? `${q.hasta}T23:59:59.999-05:00` : null;
  const texto = String(q?.q ?? '').trim().slice(0, 60);
  const digitos = texto.replace(/\D/g, '');
  return db.withOperador(async (tx) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (vista === 'activas') where.push(`c.estado <> 'CERRADA'`);
    if (vista === 'pendientes') where.push(`c.control='HUMANO' AND ${PENDIENTE_SQL}`);
    if (vista === 'sin_asignar') where.push(`c.control='HUMANO' AND c.estado <> 'CERRADA' AND c.asignado_a IS NULL`);
    if (vista === 'mias') { params.push(op.user.id); where.push(`c.asignado_a = $${params.length} AND c.estado <> 'CERRADA'`); }
    if (vista === 'ia') where.push(`c.control='AI' AND c.estado='ABIERTA'`);
    if (vista === 'cerradas') where.push(`c.estado='CERRADA'`);
    if (empresa) { params.push(empresa); where.push(`(c.tenant_relacionado = $${params.length} OR $${params.length} = ANY(c.empresas_relacionadas))`); }
    if (responsable === 'nadie') where.push('c.asignado_a IS NULL');
    else if (responsable) { params.push(responsable); where.push(`c.asignado_a = $${params.length}`); }
    if (desde) { params.push(desde); where.push(`c.ultimo_mensaje_en >= $${params.length}`); }
    if (hasta) { params.push(hasta); where.push(`c.ultimo_mensaje_en <= $${params.length}`); }
    if (texto) {
      params.push(`%${texto}%`);
      const p = params.length;
      const cond = [`c.nombre_perfil ILIKE $${p}`, `k.numero ILIKE $${p}`];
      if (digitos.length >= 4) { params.push(`%${digitos}%`); cond.push(`regexp_replace(c.telefono, '\\D', '', 'g') LIKE $${params.length}`); }
      where.push(`(${cond.join(' OR ')})`);
    }
    const filas = (await tx.query(
      `SELECT c.id, c.telefono, c.nombre_perfil, c.estado, c.control, c.asignado_a, e.nombre AS asignado, c.tenant_relacionado, t.nombre AS empresa,
              cardinality(c.empresas_relacionadas) AS n_empresas, c.ultimo_mensaje_en, c.ultimo_mensaje_cliente_en, c.escalada_en, c.primera_respuesta_humana_en,
              k.numero AS ticket, k.estado AS ticket_estado, k.prioridad AS ticket_prioridad, ${PENDIENTE_SQL} AS pendiente,
              (SELECT count(*)::int FROM plataforma_mensaje m WHERE m.conversacion_id=c.id AND m.estado_entrega='FALLIDO') AS fallidos,
              (SELECT m.contenido FROM plataforma_mensaje m WHERE m.conversacion_id=c.id AND m.tipo <> 'NOTA_INTERNA' ORDER BY m.creado_en DESC LIMIT 1) AS ultimo,
              (SELECT m.remitente FROM plataforma_mensaje m WHERE m.conversacion_id=c.id AND m.tipo <> 'NOTA_INTERNA' ORDER BY m.creado_en DESC LIMIT 1) AS ultimo_de
       FROM plataforma_conversacion c LEFT JOIN operador_equipo e ON e.id=c.asignado_a LEFT JOIN tenant t ON t.id=c.tenant_relacionado
       LEFT JOIN soporte_ticket k ON k.id=c.ticket_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY (c.control='HUMANO' AND ${PENDIENTE_SQL}) DESC, c.ultimo_mensaje_en DESC NULLS LAST LIMIT 200`, params)).rows;
    const contadores = (await tx.query(
      `SELECT count(*) FILTER (WHERE c.estado <> 'CERRADA')::int AS activas,
              count(*) FILTER (WHERE c.control='HUMANO' AND ${PENDIENTE_SQL})::int AS pendientes,
              count(*) FILTER (WHERE c.control='HUMANO' AND c.estado <> 'CERRADA' AND c.asignado_a IS NULL)::int AS sin_asignar,
              count(*) FILTER (WHERE c.asignado_a = $1 AND c.estado <> 'CERRADA')::int AS mias,
              count(*) FILTER (WHERE c.control='AI' AND c.estado='ABIERTA')::int AS ia,
              count(*) FILTER (WHERE c.estado='CERRADA')::int AS cerradas,
              count(*)::int AS todas
       FROM plataforma_conversacion c`, [op.user.id])).rows[0];
    const equipo = (await tx.query(`SELECT id, nombre, rol_plataforma AS rol FROM operador_equipo ORDER BY nombre`)).rows;
    const empresas = (await tx.query(
      `SELECT DISTINCT t.id, t.nombre FROM plataforma_conversacion c JOIN tenant t ON t.id = c.tenant_relacionado OR t.id = ANY(c.empresas_relacionadas) ORDER BY t.nombre LIMIT 200`)).rows;
    const ahora = Date.now();
    return {
      vista, contadores, equipo, empresas,
      conversaciones: filas.map((c: any) => ({
        id: c.id, telefono: enmascararTelefono(c.telefono), nombre: c.nombre_perfil, estado: c.estado, control: c.control,
        asignado_a: c.asignado_a, asignado: c.asignado, empresa: c.empresa, empresa_id: c.tenant_relacionado, varias_empresas: c.n_empresas > 1,
        ticket: c.ticket, ticket_estado: c.ticket_estado, prioridad: c.ticket_prioridad,
        pendiente: !!c.pendiente && c.control === 'HUMANO', fallidos: c.fallidos,
        espera_min: c.pendiente && c.control === 'HUMANO' && c.ultimo_mensaje_cliente_en ? Math.max(0, Math.round((ahora - new Date(c.ultimo_mensaje_cliente_en).getTime()) / 60000)) : null,
        ultimo: c.ultimo ? String(c.ultimo).slice(0, 140) : null, ultimo_de: c.ultimo_de,
        ultimo_mensaje_en: c.ultimo_mensaje_en, escalada_en: c.escalada_en,
      })),
    };
  });
}

/** Detalle completo. Abrirlo (`registrar`) queda en la auditoría porque muestra el número completo. */
export async function verConversacion(db: Database, op: Operador, id: string, registrar = false) {
  exigir(op, 'conversaciones:ver');
  if (!isUuid(id)) throw notFound();
  return db.withOperador(async (tx) => {
    const c = (await tx.query(
      `SELECT c.*, e.nombre AS asignado FROM plataforma_conversacion c LEFT JOIN operador_equipo e ON e.id=c.asignado_a WHERE c.id=$1`, [id])).rows[0];
    if (!c) throw notFound();
    const mensajes = (await tx.query(
      `SELECT id, remitente, autor_nombre, tipo, contenido, metadatos, estado_entrega, error_entrega, coalesce(ocurrido_en, creado_en) AS creado_en
       FROM plataforma_mensaje WHERE conversacion_id=$1 ORDER BY coalesce(ocurrido_en, creado_en), creado_en`, [id])).rows;
    const ticket = c.ticket_id ? (await tx.query(`SELECT id, numero, estado, prioridad, categoria, asunto, creado_en FROM soporte_ticket WHERE id=$1`, [c.ticket_id])).rows[0] ?? null : null;
    const anteriores = (await tx.query(`SELECT id, numero, estado, asunto, creado_en FROM soporte_ticket WHERE conversacion_id=$1 AND id IS DISTINCT FROM $2 ORDER BY creado_en DESC LIMIT 10`, [id, c.ticket_id])).rows;
    const ids = [...new Set([c.tenant_relacionado, ...(c.empresas_relacionadas ?? [])].filter(Boolean))];
    const empresas = ids.length ? (await tx.query(`SELECT id, nombre, slug FROM tenant WHERE id = ANY($1::uuid[]) ORDER BY nombre`, [ids])).rows : [];
    // Abrir queda registrado antes de leer el historial: quien la abre ve su propia apertura.
    if (registrar) await auditar(tx, op, { accion: 'plataforma.conversacion.abrir', recurso: 'plataforma_conversacion', recursoId: id, tenantId: c.tenant_relacionado, resultado: 'EXITO' });
    const historial = (await tx.query(
      `SELECT accion, actor_email, motivo, resultado, detalle, creado_en FROM auditoria_plataforma WHERE recurso='plataforma_conversacion' AND recurso_id=$1 ORDER BY creado_en`, [id])).rows;
    const equipo = (await tx.query(`SELECT id, nombre, rol_plataforma AS rol FROM operador_equipo ORDER BY nombre`)).rows;
    const estado = c.contexto ?? {};
    return {
      id: c.id, telefono: c.telefono, nombre: c.nombre_perfil, estado: c.estado, control: c.control,
      asignado_a: c.asignado_a, asignado: c.asignado, tomado_en: c.tomado_en, escalada_en: c.escalada_en, primera_respuesta_humana_en: c.primera_respuesta_humana_en,
      ultimo_mensaje_cliente_en: c.ultimo_mensaje_cliente_en, cerrada_en: c.cerrada_en, motivo_cierre: c.motivo_cierre, creado_en: c.creado_en,
      ventana_abierta: ventanaAbierta(c.ultimo_mensaje_cliente_en),
      tema: estado.tema ?? null,
      empresa_relacionada: c.tenant_relacionado, empresas, ticket, tickets_anteriores: anteriores,
      mensajes: mensajes.map((m: any) => ({ id: m.id, remitente: m.remitente, autor: m.autor_nombre, tipo: m.tipo, contenido: m.contenido, estado_entrega: m.estado_entrega, error_entrega: m.error_entrega, creado_en: m.creado_en, intencion: m.metadatos?.intencion ?? null })),
      historial: historial.map((h: any) => ({ accion: h.accion, actor: h.actor_email, motivo: h.motivo, resultado: h.resultado, detalle: h.detalle, fecha: h.creado_en })),
      equipo,
    };
  });
}

/** Conversación bloqueada para escritura; evita que dos personas actúen a la vez sobre ella. */
async function cargarParaEscribir(tx: Tx, id: string) {
  if (!isUuid(id)) throw notFound();
  const c = (await tx.query(`SELECT * FROM plataforma_conversacion WHERE id=$1 FOR UPDATE`, [id])).rows[0];
  if (!c) throw notFound();
  return c;
}

const nombreDe = async (tx: Tx, userId: string) => (await tx.query(`SELECT nombre FROM operador_equipo WHERE id=$1`, [userId])).rows[0]?.nombre as string | undefined;

/** Tomar la conversación: la persona queda como responsable y el asistente deja de responder. */
export async function tomarConversacion(db: Database, op: Operador, id: string) {
  exigir(op, 'conversaciones:atender');
  return db.withPlatform(async (tx) => {
    const c = await cargarParaEscribir(tx, id);
    if (c.estado === 'CERRADA') throw new AppError('CONFLICT', 'La conversación está cerrada. Si la persona vuelve a escribir, se reabre sola.');
    if (c.asignado_a === op.user.id) return { ok: true, sin_cambios: true };
    if (c.asignado_a && op.user.rol_plataforma !== 'ADMIN') {
      throw new AppError('CONFLICT', `La atiende ${(await nombreDe(tx, c.asignado_a)) ?? 'otra persona'}. Pide a administración que la reasigne.`);
    }
    await tx.query(`UPDATE plataforma_conversacion SET asignado_a=$2, tomado_en=now(), control='HUMANO', estado='ESCALADA', escalada_en=coalesce(escalada_en, now()), actualizado_en=now() WHERE id=$1`, [id, op.user.id]);
    await agregarMensajePlataforma(tx, { conversacionId: id, remitente: 'SISTEMA', tipo: 'NOTA_INTERNA', contenido: `${op.user.nombre} tomó la conversación.`, metadatos: { evento: 'tomada' } });
    await auditarConversacion(tx, { conversacionId: id, accion: 'plataforma.conversacion.tomar', actorId: op.user.id, actorEmail: op.user.email, correlacion: op.correlacion, detalle: { antes: c.asignado_a ?? null } });
    return { ok: true };
  });
}

export async function asignarConversacion(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'conversaciones:asignar');
  const d = z.object({ user_id: z.uuid().nullable() }).parse(body ?? {});
  return db.withPlatform(async (tx) => {
    const c = await cargarParaEscribir(tx, id);
    if (c.estado === 'CERRADA') throw new AppError('CONFLICT', 'La conversación está cerrada.');
    const nombre = d.user_id ? await nombreDe(tx, d.user_id) : null;
    if (d.user_id && !nombre) throw invalid('Esa persona no es del equipo de Omnegia.');
    if ((c.asignado_a ?? null) === d.user_id) return { ok: true, sin_cambios: true };
    await tx.query(
      `UPDATE plataforma_conversacion SET asignado_a=$2, tomado_en=CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END, control='HUMANO', estado='ESCALADA', escalada_en=coalesce(escalada_en, now()), actualizado_en=now() WHERE id=$1`,
      [id, d.user_id]);
    await agregarMensajePlataforma(tx, { conversacionId: id, remitente: 'SISTEMA', tipo: 'NOTA_INTERNA', contenido: d.user_id ? `${op.user.nombre} asignó la conversación a ${nombre}.` : `${op.user.nombre} dejó la conversación sin responsable.`, metadatos: { evento: 'asignada' } });
    await auditarConversacion(tx, { conversacionId: id, accion: 'plataforma.conversacion.asignar', actorId: op.user.id, actorEmail: op.user.email, correlacion: op.correlacion, detalle: { de: c.asignado_a ?? null, a: d.user_id } });
    return { ok: true };
  });
}

const RespuestaInput = z.object({
  texto: z.string().trim().min(1, 'Escribe el mensaje.').max(4000, 'El mensaje supera 4.000 caracteres.'),
  nota: z.boolean().default(false),
});

/** Respuesta de una persona del equipo (sale por WhatsApp) o nota interna (no sale). */
export async function responderConversacion(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'conversaciones:atender');
  const d = RespuestaInput.parse(body ?? {});
  revisarContenido(d.texto);
  return db.withPlatform(async (tx) => {
    const c = await cargarParaEscribir(tx, id);
    if (c.asignado_a && c.asignado_a !== op.user.id && op.user.rol_plataforma !== 'ADMIN' && !d.nota) {
      throw new AppError('CONFLICT', `La atiende ${(await nombreDe(tx, c.asignado_a)) ?? 'otra persona'}. Deja una nota interna o pide que te la reasignen.`);
    }
    if (!d.nota && !ventanaAbierta(c.ultimo_mensaje_cliente_en)) {
      throw new AppError('CONFLICT', 'Pasaron más de 24 horas desde el último mensaje de la persona: WhatsApp no permite escribirle con texto libre. Contáctala por correo si dejó uno, o espera a que vuelva a escribir.');
    }
    const mensaje = await agregarMensajePlataforma(tx, {
      conversacionId: id, remitente: d.nota ? 'SISTEMA' : 'OPERADOR', tipo: d.nota ? 'NOTA_INTERNA' : 'TEXTO', contenido: d.texto,
      autorId: op.user.id, autorNombre: op.user.nombre, metadatos: d.nota ? { evento: 'nota' } : {},
    });
    if (!d.nota) {
      // Responder es tomar: el asistente calla mientras una persona atiende.
      await tx.query(
        `UPDATE plataforma_conversacion SET control='HUMANO', estado='ESCALADA', asignado_a=coalesce(asignado_a, $2), tomado_en=coalesce(tomado_en, now()),
           escalada_en=coalesce(escalada_en, now()), primera_respuesta_humana_en=coalesce(primera_respuesta_humana_en, now()), cerrada_en=NULL, actualizado_en=now() WHERE id=$1`,
        [id, op.user.id]);
      if (c.ticket_id) await tx.query(`UPDATE soporte_ticket SET estado=CASE WHEN estado='ABIERTO' THEN 'EN_PROCESO' ELSE estado END, actualizado_en=now() WHERE id=$1`, [c.ticket_id]);
    }
    await auditarConversacion(tx, { conversacionId: id, accion: d.nota ? 'plataforma.conversacion.nota' : 'plataforma.conversacion.responder', actorId: op.user.id, actorEmail: op.user.email, correlacion: op.correlacion });
    return { ok: true, mensaje_id: mensaje };
  });
}

/** El asistente vuelve a atender (por ejemplo, cuando el caso quedó resuelto y la persona sigue escribiendo). */
export async function devolverAlAsistente(db: Database, op: Operador, id: string) {
  exigir(op, 'conversaciones:atender');
  return db.withPlatform(async (tx) => {
    const c = await cargarParaEscribir(tx, id);
    if (c.control === 'AI') throw new AppError('CONFLICT', 'El asistente ya está atendiendo esta conversación.');
    if (c.estado === 'CERRADA') throw new AppError('CONFLICT', 'La conversación está cerrada.');
    const previo = c.contexto ?? {};
    // Se conserva que ya saludó y avisó; el tema queda en blanco para no retomar algo que resolvió una persona.
    const contexto = { saludado: true, visto: true, aviso: !!previo.aviso };
    await tx.query(`UPDATE plataforma_conversacion SET control='AI', estado='ABIERTA', asignado_a=NULL, tomado_en=NULL, contexto=$2, actualizado_en=now() WHERE id=$1`, [id, JSON.stringify(contexto)]);
    await agregarMensajePlataforma(tx, { conversacionId: id, remitente: 'SISTEMA', tipo: 'NOTA_INTERNA', contenido: `${op.user.nombre} devolvió la conversación al asistente.`, metadatos: { evento: 'devuelta_ia' } });
    await auditarConversacion(tx, { conversacionId: id, accion: 'plataforma.conversacion.devolver_ia', actorId: op.user.id, actorEmail: op.user.email, correlacion: op.correlacion });
    return { ok: true };
  });
}

const CierreInput = z.object({
  motivo: z.string().trim().min(5, 'Escribe el motivo del cierre (mínimo 5 caracteres).').max(300),
  resolver_solicitud: z.boolean().default(false),
});

export async function cerrarConversacion(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'conversaciones:atender');
  const d = CierreInput.parse(body ?? {});
  revisarContenido(d.motivo);
  return db.withPlatform(async (tx) => {
    const c = await cargarParaEscribir(tx, id);
    if (c.estado === 'CERRADA') throw new AppError('CONFLICT', 'La conversación ya está cerrada.');
    await tx.query(`UPDATE plataforma_conversacion SET estado='CERRADA', control='AI', cerrada_en=now(), motivo_cierre=$2, actualizado_en=now() WHERE id=$1`, [id, d.motivo]);
    if (d.resolver_solicitud && c.ticket_id) await tx.query(`UPDATE soporte_ticket SET estado='RESUELTO', actualizado_en=now() WHERE id=$1 AND estado NOT IN ('RESUELTO','CERRADO')`, [c.ticket_id]);
    await agregarMensajePlataforma(tx, { conversacionId: id, remitente: 'SISTEMA', tipo: 'NOTA_INTERNA', contenido: `${op.user.nombre} cerró la conversación: ${d.motivo}`, metadatos: { evento: 'cerrada' } });
    await auditarConversacion(tx, { conversacionId: id, accion: 'plataforma.conversacion.cerrar', actorId: op.user.id, actorEmail: op.user.email, motivo: d.motivo, correlacion: op.correlacion, detalle: { solicitud_resuelta: d.resolver_solicitud && !!c.ticket_id } });
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Atención de las empresas: indicadores sin contenido
// ---------------------------------------------------------------------------
export async function atencionEmpresas(db: Database, op: Operador, q: any) {
  exigir(op, 'atencion:ver_empresas');
  const empresa = isUuid(q?.empresa) ? q.empresa : null;
  const soloVencidos = q?.vencidos === '1';
  return db.withOperador(async (tx) => {
    const empresas = (await tx.query(
      `SELECT t.id, t.nombre, t.whatsapp_estado,
              (SELECT count(*)::int FROM conversation v WHERE v.tenant_id=t.id AND v.estado <> 'CERRADA') AS abiertas,
              (SELECT count(*)::int FROM conversation v WHERE v.tenant_id=t.id AND v.estado='ABIERTA' AND v.control='AI') AS con_ia,
              (SELECT count(*)::int FROM conversation v WHERE v.tenant_id=t.id AND v.estado='ESCALADA') AS con_persona,
              (SELECT count(*)::int FROM support_case k WHERE k.tenant_id=t.id AND k.estado IN ('EN_COLA','ASIGNADO','EN_ATENCION') AND k.primera_respuesta_en IS NULL) AS sin_respuesta,
              (SELECT count(*)::int FROM support_case k WHERE k.tenant_id=t.id AND k.estado IN ('EN_COLA','ASIGNADO','EN_ATENCION') AND k.primera_respuesta_en IS NULL AND k.sla_vence_en < now()) AS vencidos,
              (SELECT count(*)::int FROM support_case k WHERE k.tenant_id=t.id AND k.estado='EN_COLA') AS en_cola,
              (SELECT count(*)::int FROM message m WHERE m.tenant_id=t.id AND m.estado_entrega='FALLIDO' AND m.creado_en > now() - interval '2 days') AS fallidos_48h,
              (SELECT max(v.actualizado_en) FROM conversation v WHERE v.tenant_id=t.id) AS ultima_actividad
       FROM tenant t WHERE ($1::uuid IS NULL OR t.id = $1) ORDER BY vencidos DESC, sin_respuesta DESC, abiertas DESC, t.nombre LIMIT 300`, [empresa])).rows;
    const radicados = (await tx.query(
      `SELECT k.id, k.tenant_id, t.nombre AS empresa, k.radicado, k.conversation_id, k.prioridad, k.estado, (k.asignado_a IS NOT NULL) AS asignado,
              k.sla_vence_en, k.creado_en, (k.sla_vence_en < now()) AS vencido,
              (SELECT g.expira_en FROM acceso_soporte g WHERE g.tenant_id=k.tenant_id AND g.conversation_id=k.conversation_id AND g.revocado_en IS NULL AND g.expira_en > now() ORDER BY g.expira_en DESC LIMIT 1) AS acceso_hasta
       FROM support_case k JOIN tenant t ON t.id=k.tenant_id
       WHERE k.estado IN ('EN_COLA','ASIGNADO','EN_ATENCION') AND k.primera_respuesta_en IS NULL
         AND ($1::uuid IS NULL OR k.tenant_id=$1) AND (NOT $2 OR k.sla_vence_en < now())
       ORDER BY k.sla_vence_en LIMIT 150`, [empresa, soloVencidos])).rows;
    const accesos = (await tx.query(
      `SELECT g.id, g.tenant_id, t.nombre AS empresa, g.conversation_id, g.motivo, g.otorgado_por_nombre, g.ticket_numero, g.expira_en, g.creado_en
       FROM acceso_soporte g JOIN tenant t ON t.id=g.tenant_id WHERE g.revocado_en IS NULL AND g.expira_en > now() AND ($1::uuid IS NULL OR g.tenant_id=$1)
       ORDER BY g.creado_en DESC LIMIT 100`, [empresa])).rows;
    const totales = empresas.reduce((a: any, e: any) => ({
      abiertas: a.abiertas + e.abiertas, con_persona: a.con_persona + e.con_persona, sin_respuesta: a.sin_respuesta + e.sin_respuesta,
      vencidos: a.vencidos + e.vencidos, fallidos_48h: a.fallidos_48h + e.fallidos_48h,
    }), { abiertas: 0, con_persona: 0, sin_respuesta: 0, vencidos: 0, fallidos_48h: 0 });
    return { totales, empresas, radicados, accesos };
  });
}

/** Lectura de una conversación de una empresa que la compartió con soporte. Sin acceso vigente: «no encontrado». */
export async function leerConversacionAutorizada(db: Database, op: Operador, conversationId: string) {
  exigir(op, 'atencion:leer_autorizadas');
  if (!isUuid(conversationId)) throw notFound();
  const data = await db.withSoporte(async (tx) => {
    const v = (await tx.query(
      `SELECT v.id, v.tenant_id, v.canal, v.estado, v.control, v.creado_en, v.actualizado_en, c.nombre AS cliente, c.telefono, t.nombre AS empresa
       FROM conversation v JOIN customer c ON c.id=v.customer_id JOIN tenant t ON t.id=v.tenant_id WHERE v.id=$1`, [conversationId])).rows[0];
    if (!v) return null;
    const acceso = (await tx.query(`SELECT motivo, otorgado_por_nombre, ticket_numero, expira_en, creado_en FROM acceso_soporte WHERE conversation_id=$1 ORDER BY expira_en DESC LIMIT 1`, [conversationId])).rows[0];
    const mensajes = (await tx.query(
      `SELECT id, remitente, tipo, contenido, estado_entrega, error_entrega, coalesce(ocurrido_en, creado_en) AS creado_en FROM message WHERE conversation_id=$1 ORDER BY coalesce(ocurrido_en, creado_en), creado_en`,
      [conversationId])).rows;
    const caso = (await tx.query(`SELECT radicado, motivo, prioridad, estado, sla_vence_en, primera_respuesta_en, creado_en FROM support_case WHERE conversation_id=$1 ORDER BY creado_en DESC LIMIT 1`, [conversationId])).rows[0] ?? null;
    // Para diagnosticar basta con el texto: el teléfono del cliente se entrega parcial (minimización).
    return { ...v, telefono: enmascararTelefono(v.telefono), acceso, mensajes, caso };
  });
  if (!data) {
    await db.withOperador((tx) => auditar(tx, op, { accion: 'empresa.conversacion.lectura_autorizada', recurso: 'conversation', recursoId: conversationId, resultado: 'DENEGADO', detalle: { razon: 'sin_acceso_vigente' } }));
    throw notFound();
  }
  // Evidencia en ambos lados: la auditoría del operador y la de la empresa que compartió la conversación.
  await db.withOperador((tx) => auditar(tx, op, { accion: 'empresa.conversacion.lectura_autorizada', recurso: 'conversation', recursoId: conversationId, tenantId: data.tenant_id, resultado: 'EXITO' }));
  await db.withPlatform((tx) => auditPlatform(tx, data.tenant_id, { tipo: 'PLATAFORMA', id: op.user.id, nombre: 'Soporte de Omnegia' }, 'PLATAFORMA', op.correlacion,
    { accion: 'soporte.conversacion_leida', recurso: 'conversation', recursoId: conversationId, resultado: 'EXITO', detalle: { operador: op.user.email } }));
  return data;
}

/** Comprobación del número de WhatsApp de una empresa con Meta (solo consulta su estado; no lee mensajes). */
export async function verificarWhatsappEmpresa(db: Database, op: Operador, tenantId: string) {
  exigir(op, 'integraciones:verificar');
  if (!isUuid(tenantId)) throw notFound();
  const existe = await db.withOperador(async (tx) => (await tx.query(`SELECT id FROM tenant WHERE id=$1`, [tenantId])).rows[0]);
  if (!existe) throw notFound();
  const r = await verificarWhatsapp(db, tenantId, op.correlacion, { tipo: 'PLATAFORMA', id: op.user.id, nombre: 'Soporte de Omnegia' });
  await db.withOperador((tx) => auditar(tx, op, { accion: 'empresa.whatsapp.verificar', recurso: 'tenant', recursoId: tenantId, tenantId, resultado: r.estado === 'ERROR' ? 'ERROR' : 'EXITO', detalle: { estado: r.estado } }));
  return { estado: r.estado, mensaje: r.mensaje };
}
