import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, can, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { allQuotas } from '../core/usage.js';
import { PERMISOS, PERMISOS_PROHIBIDOS_A_AGENTES } from '../core/permissions.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { hashPassword, isUuid, token, uuidv7 } from '../lib/util.js';
import { localToUtc, todayLocal, utcToLocal, addDays } from '../lib/time.js';
import { TOOLS } from '../ai/registry.js';
import { effectiveRisk } from '../ai/gateway.js';
import { deriveTheme } from '../onboarding/theme.js';
import { MODULOS } from '../templates/index.js';
import { gatewayAccount } from './payments.js';

// ---------------------------------------------------------------------------
// Sesión del panel: quién soy, en qué empresa, qué puedo hacer (P1)
// ---------------------------------------------------------------------------
export async function me(tx: Tx, ctx: Ctx) {
  const t = (await tx.query(
    `SELECT t.id, t.slug, t.nombre, t.nit, t.ciudad, t.sector, t.sector_version, t.plan_codigo, t.tema, t.logo_data_url, t.zona_horaria, t.email_contacto,
            t.whatsapp_phone_number_id, p.nombre AS plan_nombre, s.estado AS suscripcion, st.contenido->'widgets_panel' AS widgets, st.contenido->>'etiqueta_recurso' AS etiqueta_recurso
     FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo LEFT JOIN subscription s ON s.tenant_id=t.id
     LEFT JOIN sector_template st ON st.sector=t.sector AND st.version=t.sector_version WHERE t.id=$1`,
    [ctx.tenantId],
  )).rows[0];
  const modulos = (await tx.query(`SELECT modulo FROM tenant_module WHERE activo`)).rows.map((r) => r.modulo);
  const rol = (await tx.query(`SELECT nombre FROM role WHERE clave=$1`, [ctx.roleKey])).rows[0]?.nombre;
  return {
    usuario: { id: ctx.actor.id, nombre: ctx.actor.nombre, rol: ctx.roleKey, rol_nombre: rol },
    tenant: t, modulos, permisos: [...ctx.permisos], solo_lectura: !!ctx.soloLectura,
    consumo: can(ctx, 'usage:read') ? await allQuotas(tx, ctx.tenantId) : null,
  };
}

// ---------------------------------------------------------------------------
// Panel de inicio (SCR-009): cifras operativas, lo que requiere atención, hilo vivo
// ---------------------------------------------------------------------------
export async function dashboard(tx: Tx, ctx: Ctx) {
  const hoy = todayLocal();
  const desde = localToUtc(hoy, '00:00').toISOString();
  const hasta = localToUtc(addDays(hoy, 1), '00:00').toISOString();
  const semana = localToUtc(addDays(hoy, -6), '00:00').toISOString();
  const cifras = (await tx.query(
    `SELECT
       (SELECT coalesce(sum(total),0) FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2) AS ventas_hoy,
       (SELECT count(*)::int FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2) AS n_ventas_hoy,
       (SELECT coalesce(sum(total),0) FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $3) AS ventas_semana,
       (SELECT count(*)::int FROM appointment WHERE inicio >= $1 AND inicio < $2 AND estado <> 'CANCELADA') AS citas_hoy,
       (SELECT count(*)::int FROM appointment WHERE inicio >= $1 AND inicio < $2 AND estado <> 'CANCELADA' AND origen='AGENTE') AS citas_hoy_ia,
       (SELECT count(*)::int FROM conversation WHERE estado <> 'CERRADA') AS conversaciones_abiertas,
       (SELECT count(*)::int FROM conversation WHERE estado='ESCALADA') AS escaladas,
       (SELECT count(*)::int FROM customer WHERE creado_en >= $3) AS clientes_nuevos,
       (SELECT count(*)::int FROM conversation WHERE resuelta_por='AGENTE' AND actualizado_en >= $3) AS resueltas_ia_semana`,
    [desde, hasta, semana],
  )).rows[0];
  const atencion: any[] = [];
  if (can(ctx, 'invoice:read')) {
    for (const f of (await tx.query(
      `SELECT f.id, f.numero, f.motivo_rechazo, o.id AS order_id, o.numero AS orden FROM fiscal_document f JOIN "order" o ON o.id=f.order_id WHERE f.estado='RECHAZADO' ORDER BY f.creado_en DESC LIMIT 5`,
    )).rows) atencion.push({ tipo: 'factura_rechazada', nivel: 'error', titulo: `La DIAN rechazó la factura ${f.numero} (venta #${f.orden})`, detalle: f.motivo_rechazo, accion: { etiqueta: 'Corregir', ruta: `/ventas/${f.order_id}` } });
  }
  if (can(ctx, 'conversation:read')) {
    for (const k of (await tx.query(
      `SELECT k.radicado, k.prioridad, k.sla_vence_en, k.estado, k.conversation_id, c.nombre FROM support_case k JOIN conversation v ON v.id=k.conversation_id JOIN customer c ON c.id=v.customer_id
       WHERE k.estado IN ('EN_COLA','ASIGNADO') AND k.primera_respuesta_en IS NULL ORDER BY k.sla_vence_en LIMIT 5`,
    )).rows) atencion.push({ tipo: 'caso', nivel: new Date(k.sla_vence_en) < new Date() ? 'error' : 'info', titulo: `${k.radicado} · ${k.nombre} espera respuesta humana`, detalle: `Prioridad ${k.prioridad.toLowerCase()} · SLA ${new Date(k.sla_vence_en) < new Date() ? 'vencido' : 'vence ' + utcToLocal(new Date(k.sla_vence_en)).hora}`, accion: { etiqueta: 'Atender', ruta: `/conversaciones/${k.conversation_id}` } });
  }
  if (can(ctx, 'inventory:read')) {
    for (const p of (await tx.query(`SELECT nombre, stock, stock_minimo FROM product WHERE controla_stock AND eliminado_en IS NULL AND stock <= stock_minimo LIMIT 5`)).rows)
      atencion.push({ tipo: 'stock', nivel: 'warn', titulo: `${p.nombre}: quedan ${Number(p.stock)}`, detalle: `Mínimo ${Number(p.stock_minimo)}`, accion: { etiqueta: 'Reponer', ruta: '/inventario' } });
  }
  const pend = (await tx.query(`SELECT count(*)::int AS n FROM pending_action WHERE estado='PENDIENTE' AND expira_en > now()`)).rows[0].n;
  if (pend) atencion.push({ tipo: 'confirmacion', nivel: 'warn', titulo: `${pend} acción(es) de IA esperan confirmación del cliente`, detalle: 'Se ejecutan solo si el cliente responde SÍ', accion: { etiqueta: 'Ver', ruta: '/ia' } });

  const hilo = can(ctx, 'conversation:read') ? (await tx.query(
    `(SELECT 'mensaje' AS kind, m.id, m.creado_en, m.remitente, m.contenido AS texto, NULL::text AS herramienta, NULL::text AS decision, NULL::text AS riesgo, NULL::text AS permiso, NULL::text AS motivo, m.conversation_id, c.nombre AS cliente
       FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN customer c ON c.id=v.customer_id WHERE m.tipo <> 'NOTA_INTERNA' ORDER BY m.creado_en DESC LIMIT 12)
     UNION ALL
     (SELECT 'recibo', e.id, e.creado_en, 'AI', NULL, e.herramienta, e.decision, e.nivel_riesgo, e.permiso_requerido, e.motivo_denegacion, e.conversation_id, NULL
       FROM ai_execution e WHERE e.configuracion='atencion' ORDER BY e.creado_en DESC LIMIT 8)
     ORDER BY creado_en DESC LIMIT 14`,
  )).rows.reverse() : [];
  const agenda = can(ctx, 'appointment:read') ? (await tx.query(
    `SELECT a.id, a.inicio, a.estado, a.origen, c.nombre AS cliente, p.nombre AS servicio, r.nombre AS recurso FROM appointment a
     JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     WHERE a.inicio >= $1 AND a.inicio < $2 AND a.estado <> 'CANCELADA' ORDER BY a.inicio LIMIT 12`, [desde, hasta])).rows
    .map((a) => ({ ...a, hora: utcToLocal(new Date(a.inicio)).hora })) : [];
  const fiscal = can(ctx, 'invoice:read') ? (await tx.query(
    `SELECT count(*) FILTER (WHERE TRUE)::int AS ventas,
            count(*) FILTER (WHERE estado IN ('ENVIADO','VALIDADO','ENTREGADO'))::int AS emitidas,
            count(*) FILTER (WHERE estado IN ('VALIDADO','ENTREGADO'))::int AS validadas,
            count(*) FILTER (WHERE estado='ENTREGADO')::int AS entregadas,
            count(*) FILTER (WHERE estado='RECHAZADO')::int AS rechazadas
     FROM fiscal_document WHERE tipo='FACTURA' AND creado_en >= $1`, [desde])).rows[0] : null;
  const ingresos = (await tx.query(
    `SELECT to_char(creado_en AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS dia, sum(total)::float AS total
     FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 GROUP BY 1 ORDER BY 1`, [semana])).rows;
  const ocupacion = can(ctx, 'appointment:read') ? (await tx.query(
    `SELECT r.nombre, count(a.id)::int AS citas FROM resource r LEFT JOIN appointment a ON a.resource_id=r.id AND a.inicio >= $1 AND a.inicio < $2 AND a.estado <> 'CANCELADA'
     WHERE r.activo GROUP BY r.nombre ORDER BY r.nombre`, [desde, hasta])).rows : [];
  return {
    fecha: hoy,
    cifras: { ...cifras, ventas_hoy: Number(cifras.ventas_hoy), ventas_semana: Number(cifras.ventas_semana) },
    atencion, hilo, agenda, fiscal, ingresos, ocupacion,
    consumo: can(ctx, 'usage:read') ? await allQuotas(tx, ctx.tenantId) : null,
  };
}

// ---------------------------------------------------------------------------
// Centro de IA (SCR-016)
// ---------------------------------------------------------------------------
export async function aiCenter(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'ai:read');
  const agentes = (await tx.query(
    `SELECT a.id, a.configuracion, a.herramientas, a.prompt_base, a.activo, r.clave AS rol, r.nombre AS rol_nombre,
            coalesce(array_agg(rp.permiso) FILTER (WHERE rp.permiso IS NOT NULL), '{}') AS permisos
     FROM ai_agent a JOIN role r ON r.id=a.role_id LEFT JOIN role_permission rp ON rp.role_id=r.id GROUP BY a.id, r.clave, r.nombre ORDER BY a.configuracion`,
  )).rows;
  const settings = new Map((await tx.query(`SELECT herramienta, habilitada FROM ai_tool_setting`)).rows.map((r) => [r.herramienta, r.habilitada]));
  const uso = new Map((await tx.query(
    `SELECT herramienta, count(*) FILTER (WHERE decision IN ('PERMITIDA','CONFIRMADA'))::int AS ejecutadas, count(*) FILTER (WHERE decision='DENEGADA')::int AS denegadas
     FROM ai_execution WHERE creado_en > now() - interval '30 days' GROUP BY herramienta`,
  )).rows.map((r) => [r.herramienta, r]));
  const herramientas = [];
  for (const t of TOOLS) {
    herramientas.push({
      nombre: t.nombre, version: t.version, modulo: t.modulo, descripcion: t.descripcion, permiso: t.permiso,
      riesgo_declarado: t.riesgo, riesgo_efectivo: await effectiveRisk(tx, t), efectos: t.efectos, limite: t.limitePorConversacion ?? null,
      habilitada: settings.get(t.nombre) ?? true, prohibida_a_agentes: PERMISOS_PROHIBIDOS_A_AGENTES.includes(t.permiso as any) || t.riesgo === 'critica',
      agentes: agentes.filter((a) => a.herramientas.includes(t.nombre)).map((a) => a.configuracion),
      uso: uso.get(t.nombre) ?? { ejecutadas: 0, denegadas: 0 },
    });
  }
  const metricas = (await tx.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE decision IN ('PERMITIDA','CONFIRMADA'))::int AS ejecutadas,
            count(*) FILTER (WHERE decision='DENEGADA')::int AS denegadas,
            (SELECT count(*)::int FROM pending_action WHERE estado='PENDIENTE' AND expira_en > now()) AS pendientes,
            count(*) FILTER (WHERE decision='RECHAZADA_POR_CLIENTE')::int AS rechazadas,
            count(*) FILTER (WHERE decision='ERROR')::int AS errores
     FROM ai_execution WHERE creado_en > now() - interval '30 days'`,
  )).rows[0];
  const porComprobacion = (await tx.query(`SELECT comprobacion_fallida AS c, motivo_denegacion AS motivo, count(*)::int AS n FROM ai_execution WHERE decision='DENEGADA' GROUP BY 1,2 ORDER BY 3 DESC`)).rows;
  return { agentes, herramientas, metricas, por_comprobacion: porComprobacion, consumo: await allQuotas(tx, ctx.tenantId) };
}

export async function aiExecutions(tx: Tx, ctx: Ctx, filtro: { decision?: string; herramienta?: string } = {}) {
  requirePerm(ctx, 'ai:read');
  const where: string[] = [];
  const params: unknown[] = [];
  if (filtro.decision) { params.push(filtro.decision); where.push(`e.decision=$${params.length}`); }
  if (filtro.herramienta) { params.push(filtro.herramienta); where.push(`e.herramienta=$${params.length}`); }
  return (await tx.query(
    `SELECT e.*, c.nombre AS cliente FROM ai_execution e LEFT JOIN conversation v ON v.id=e.conversation_id LEFT JOIN customer c ON c.id=v.customer_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY e.creado_en DESC LIMIT 200`, params)).rows;
}

export async function toggleTool(tx: Tx, ctx: Ctx, herramienta: string, habilitada: boolean) {
  requirePerm(ctx, 'ai:configure');
  requireWritable(ctx);
  if (!TOOLS.some((t) => t.nombre === herramienta)) throw notFound();
  await tx.query(
    `INSERT INTO ai_tool_setting (tenant_id, herramienta, habilitada) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, herramienta) DO UPDATE SET habilitada=EXCLUDED.habilitada`,
    [ctx.tenantId, herramienta, habilitada],
  );
  await audit(tx, ctx, { accion: 'ia.herramienta.interruptor', recurso: 'ai_tool_setting', recursoId: herramienta, resultado: 'EXITO', detalle: { habilitada } });
  return { herramienta, habilitada };
}

export async function toggleAgent(tx: Tx, ctx: Ctx, configuracion: string, activo: boolean) {
  requirePerm(ctx, 'ai:configure');
  requireWritable(ctx);
  const r = await tx.query(`UPDATE ai_agent SET activo=$2 WHERE configuracion=$1 RETURNING id`, [configuracion, activo]);
  if (!r.rows[0]) throw notFound();
  await audit(tx, ctx, { accion: 'ia.agente.interruptor', recurso: 'ai_agent', recursoId: r.rows[0].id, resultado: 'EXITO', detalle: { configuracion, activo } });
  return { configuracion, activo };
}

// ---------------------------------------------------------------------------
// Configuración (SCR-018): personas, roles, módulos, identidad, canal, pasarela
// ---------------------------------------------------------------------------
export async function settings(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'tenant:configure');
  const personas = (await tx.query(
    `SELECT u.id, u.nombre, u.email, r.clave AS rol, r.nombre AS rol_nombre, ut.activo, ut.disponible, ut.creado_en
     FROM user_tenant ut JOIN users u ON u.id=ut.user_id JOIN role r ON r.id=ut.role_id ORDER BY ut.creado_en`,
  )).rows;
  const roles = (await tx.query(
    `SELECT r.id, r.clave, r.nombre, r.es_agente, coalesce(array_agg(rp.permiso ORDER BY rp.permiso) FILTER (WHERE rp.permiso IS NOT NULL), '{}') AS permisos
     FROM role r LEFT JOIN role_permission rp ON rp.role_id=r.id GROUP BY r.id ORDER BY r.es_agente, r.nombre`,
  )).rows;
  const modulos = (await tx.query(
    `SELECT m.modulo, m.activo, (m.modulo = ANY(p.modulos)) AS incluido_en_plan FROM tenant_module m JOIN tenant t ON t.id=m.tenant_id JOIN plan p ON p.codigo=t.plan_codigo ORDER BY m.modulo`,
  )).rows.map((m) => ({ ...m, nombre: MODULOS[m.modulo]?.nombre ?? m.modulo, descripcion: MODULOS[m.modulo]?.descripcion ?? '' }));
  const t = (await tx.query(`SELECT nombre, slug, nit, ciudad, email_contacto, telefono, tema, logo_data_url, whatsapp_phone_number_id FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0];
  const recursos = (await tx.query(`SELECT id, nombre, horario, activo FROM resource ORDER BY nombre`)).rows;
  return { tenant: t, personas, roles, modulos, recursos, catalogo_permisos: PERMISOS, pasarela: await gatewayAccount(tx, ctx) };
}

export async function updateTenantInfo(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = z.object({
    nombre: z.string().trim().min(2).max(80).optional(),
    nit: z.string().trim().max(20).nullable().optional(),
    ciudad: z.string().trim().max(60).nullable().optional(),
    email_contacto: z.email().optional(),
    telefono: z.string().max(20).nullable().optional(),
    whatsapp_phone_number_id: z.string().trim().regex(/^[a-z0-9-]{3,40}$/i).nullable().optional(),
  }).parse(body);
  // El registro de tenants es de plataforma: el rol de ejecución no puede escribirlo; se hace con la función de plataforma.
  return { d };
}

export async function updateTheme(tx: Tx, ctx: Ctx, colores: string[], logo: string | null | undefined) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const nombre = (await tx.query(`SELECT nombre FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0].nombre;
  return deriveTheme(logo === null ? [] : colores, nombre);
}

export async function toggleModule(tx: Tx, ctx: Ctx, modulo: string, activo: boolean) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const m = (await tx.query(
    `SELECT m.modulo, (m.modulo = ANY(p.modulos)) AS incluido FROM tenant_module m JOIN tenant t ON t.id=m.tenant_id JOIN plan p ON p.codigo=t.plan_codigo WHERE m.modulo=$1`, [modulo])).rows[0];
  if (!m) throw notFound();
  if (activo && !m.incluido) throw new AppError('CONFLICT', 'Tu plan no incluye este módulo. Cambia de plan en Suscripción.');
  await tx.query(`UPDATE tenant_module SET activo=$2 WHERE modulo=$1`, [modulo, activo]);
  await audit(tx, ctx, { accion: 'modulo.interruptor', recurso: 'tenant_module', recursoId: modulo, resultado: 'EXITO', detalle: { activo } });
  return { modulo, activo };
}

export async function inviteUser(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'user:manage');
  requireWritable(ctx);
  const d = z.object({ email: z.email(), nombre: z.string().trim().min(2).max(80), rol: z.string() }).parse(body);
  const rol = (await tx.query(`SELECT id, es_agente FROM role WHERE clave=$1`, [d.rol])).rows[0];
  if (!rol || rol.es_agente) throw invalid('Rol no válido para una persona.');
  const plan = (await tx.query(`SELECT p.max_usuarios FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo WHERE t.id=$1`, [ctx.tenantId])).rows[0];
  const n = (await tx.query(`SELECT count(*)::int AS n FROM user_tenant WHERE activo`)).rows[0].n;
  if (n >= plan.max_usuarios) throw new AppError('CONFLICT', `Tu plan permite ${plan.max_usuarios} personas. Cambia de plan para invitar más.`);
  return { d, roleId: rol.id };
}

/** Parte de plataforma de la invitación: crear o reutilizar la identidad (tabla users). */
export async function createOrGetUser(tx: Tx, email: string, nombre: string) {
  const e = email.toLowerCase();
  const u = (await tx.query(`SELECT id, password_hash FROM users WHERE email=$1`, [e])).rows[0];
  if (u) return { id: u.id, temporal: null as string | null };
  const temporal = token(9);
  const id = uuidv7();
  await tx.query(`INSERT INTO users (id, email, nombre, password_hash) VALUES ($1,$2,$3,$4)`, [id, e, nombre, hashPassword(temporal)]);
  return { id, temporal };
}

export async function addMembership(tx: Tx, ctx: Ctx, userId: string, roleId: string) {
  const ya = (await tx.query(`SELECT 1 FROM user_tenant WHERE user_id=$1`, [userId])).rows[0];
  if (ya) throw new AppError('CONFLICT', 'Esa persona ya tiene acceso a esta empresa.');
  await tx.query(`INSERT INTO user_tenant (user_id, tenant_id, role_id) VALUES ($1,$2,$3)`, [userId, ctx.tenantId, roleId]);
  await audit(tx, ctx, { accion: 'usuario.invitar', recurso: 'user', recursoId: userId, resultado: 'EXITO' });
}

export async function updateMember(tx: Tx, ctx: Ctx, userId: string, body: unknown) {
  requirePerm(ctx, 'user:manage');
  requireWritable(ctx);
  if (!isUuid(userId)) throw notFound();
  const d = z.object({ rol: z.string().optional(), activo: z.boolean().optional(), disponible: z.boolean().optional() }).parse(body);
  const m = (await tx.query(`SELECT ut.user_id, r.clave FROM user_tenant ut JOIN role r ON r.id=ut.role_id WHERE ut.user_id=$1`, [userId])).rows[0];
  if (!m) throw notFound();
  if (userId === ctx.actor.id && (d.activo === false || (d.rol && d.rol !== m.clave))) throw new AppError('CONFLICT', 'No puedes quitarte tu propio acceso de administración.');
  if (d.rol) {
    const r = (await tx.query(`SELECT id, es_agente FROM role WHERE clave=$1`, [d.rol])).rows[0];
    if (!r || r.es_agente) throw invalid('Rol no válido.');
    await tx.query(`UPDATE user_tenant SET role_id=$2 WHERE user_id=$1`, [userId, r.id]);
  }
  if (d.activo !== undefined) await tx.query(`UPDATE user_tenant SET activo=$2 WHERE user_id=$1`, [userId, d.activo]);
  if (d.disponible !== undefined) await tx.query(`UPDATE user_tenant SET disponible=$2 WHERE user_id=$1`, [userId, d.disponible]);
  await audit(tx, ctx, { accion: 'usuario.editar', recurso: 'user', recursoId: userId, resultado: 'EXITO', detalle: d });
  return { ok: true };
}

/** Mi disponibilidad para el motor de asignación (cualquier asesor). */
export async function setMyAvailability(tx: Tx, ctx: Ctx, disponible: boolean) {
  await tx.query(`UPDATE user_tenant SET disponible=$2 WHERE user_id=$1`, [ctx.actor.id, disponible]);
  return { disponible };
}

// ---------------------------------------------------------------------------
// Suscripción (SCR-019)
// ---------------------------------------------------------------------------
export async function subscriptionInfo(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'subscription:manage');
  const s = (await tx.query(
    `SELECT s.*, p.nombre AS plan_nombre, p.precio_mensual, p.cuota_tokens_ia, p.cuota_mensajes, p.cuota_documentos, p.max_usuarios, p.politica_excedente, p.precio_excedente_1k_tokens
     FROM subscription s JOIN plan p ON p.codigo=s.plan_codigo WHERE s.tenant_id=$1`, [ctx.tenantId])).rows[0];
  const historico = (await tx.query(`SELECT periodo, metrica, cantidad FROM usage_record ORDER BY periodo DESC, metrica LIMIT 36`)).rows;
  const usuarios = (await tx.query(`SELECT count(*)::int AS n FROM user_tenant WHERE activo`)).rows[0].n;
  return { suscripcion: { ...s, precio_mensual: Number(s.precio_mensual) }, consumo: await allQuotas(tx, ctx.tenantId), historico, usuarios };
}

// ---------------------------------------------------------------------------
// Auditoría (SCR-020): solo lectura; el registro no se edita ni se borra
// ---------------------------------------------------------------------------
export async function auditLog(tx: Tx, ctx: Ctx, f: { tipo?: string; resultado?: string; q?: string; limite?: number }) {
  requirePerm(ctx, 'audit:read');
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.tipo === 'ia') where.push(`accion LIKE 'ia.%'`);
  if (f.tipo === 'seguridad') where.push(`(accion LIKE 'acceso.%' OR accion LIKE 'permiso.%' OR resultado IN ('DENEGADO','NO_ENCONTRADO'))`);
  if (f.tipo === 'fiscal') where.push(`(accion LIKE 'factura.%' OR accion LIKE 'nota_credito.%' OR accion LIKE 'documento.%')`);
  if (f.tipo === 'configuracion') where.push(`(accion LIKE 'usuario.%' OR accion LIKE 'modulo.%' OR accion LIKE 'tenant.%' OR accion LIKE 'suscripcion.%' OR accion LIKE 'pasarela.%')`);
  if (f.resultado) { params.push(f.resultado); where.push(`resultado=$${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(accion ILIKE $${params.length} OR actor_nombre ILIKE $${params.length} OR recurso_id ILIKE $${params.length})`); }
  params.push(Math.min(f.limite ?? 200, 2000));
  return (await tx.query(
    `SELECT id, actor_tipo, actor_id, actor_nombre, accion, recurso, recurso_id, resultado, origen, correlacion, detalle, creado_en FROM audit_event
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY creado_en DESC LIMIT $${params.length}`, params)).rows;
}

export function toCsv(rows: any[]): string {
  const cols = ['creado_en', 'actor_tipo', 'actor_nombre', 'accion', 'recurso', 'recurso_id', 'resultado', 'origen', 'correlacion', 'detalle'];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(','))].join('\n');
}
