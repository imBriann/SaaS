import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { type Ctx, can, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { allQuotas } from '../core/usage.js';
import { zonaDe } from '../core/tenant.js';
import { PERMISOS, PERMISOS_PROHIBIDOS_A_AGENTES } from '../core/permissions.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, verifyPassword } from '../lib/util.js';
import { addDays, rangoDia, todayLocal, utcToLocal, zonaValida } from '../lib/time.js';
import { TOOLS } from '../ai/registry.js';
import { effectiveRisk } from '../ai/gateway.js';
import { deriveTheme } from '../onboarding/theme.js';
import { MODULOS } from '../templates/index.js';
import { gatewayAccount } from './payments.js';
import { listInvitations } from './team.js';
import { config } from '../config.js';
import { ofertaRenovacion } from './billing.js';
import { type Ciclo, DIAS_GRACIA, QUE_SE_PAUSA, preciosDe } from './planes.js';
import { nitValido } from '../adapters/fiscal.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';

// ---------------------------------------------------------------------------
// Sesión del panel: quién soy, en qué empresa, qué puedo hacer
// ---------------------------------------------------------------------------
export async function me(tx: Tx, ctx: Ctx) {
  const t = (await tx.query(
    `SELECT t.id, t.slug, t.nombre, t.nit, t.ciudad, t.sector, t.sector_version, t.plan_codigo, t.tema, t.logo_data_url, t.zona_horaria, t.email_contacto, t.registro_datos,
            t.whatsapp_phone_number_id, t.whatsapp_estado, t.whatsapp_numero_visible, p.nombre AS plan_nombre, s.estado AS suscripcion, s.periodo_fin,
            st.contenido->'widgets_panel' AS widgets, st.contenido->>'etiqueta_recurso' AS etiqueta_recurso
     FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo LEFT JOIN subscription s ON s.tenant_id=t.id
     LEFT JOIN sector_template st ON st.sector=t.sector AND st.version=t.sector_version WHERE t.id=$1`,
    [ctx.tenantId],
  )).rows[0];
  const modulos = (await tx.query(`SELECT modulo FROM tenant_module WHERE activo`)).rows.map((r) => r.modulo);
  const rol = (await tx.query(`SELECT nombre FROM role WHERE clave=$1`, [ctx.roleKey])).rows[0]?.nombre;
  const u = (await tx.query(`SELECT email, email_verificado_en, foto_data_url FROM users WHERE id=$1`, [ctx.actor.id])).rows[0];
  const m = (await tx.query(`SELECT nombre_visible, disponible FROM user_tenant WHERE user_id=$1`, [ctx.actor.id])).rows[0];
  return {
    usuario: { id: ctx.actor.id, nombre: ctx.actor.nombre, rol: ctx.roleKey, rol_nombre: ctx.propietario ? 'Propietario' : rol, propietario: !!ctx.propietario,
      email: u?.email ?? null, correo_verificado: !!u?.email_verificado_en, foto: u?.foto_data_url ?? null,
      nombre_en_empresa: m?.nombre_visible ?? null, disponible: m?.disponible ?? true },
    tenant: { ...t, zona_horaria: zonaValida(t.zona_horaria) }, modulos, permisos: [...ctx.permisos], solo_lectura: !!ctx.soloLectura,
    consumo: can(ctx, 'usage:read') ? await allQuotas(tx, ctx.tenantId) : null,
    simuladores: config.simuladores,
    // Facturación DIAN apagada: el panel la muestra como «Próximamente» y ofrece comprobantes de venta.
    factura_dian: config.fiscal.dianHabilitada,
  };
}

// ---------------------------------------------------------------------------
// Panel de inicio: cifras reales, lo que requiere atención y primeros pasos
// ---------------------------------------------------------------------------
export async function dashboard(tx: Tx, ctx: Ctx) {
  const zona = await zonaDe(tx);
  const hoy = todayLocal(zona);
  const { desde: dHoy, hasta: hHoy } = rangoDia(hoy, zona);
  const desde = dHoy.toISOString();
  const hasta = hHoy.toISOString();
  const semana = rangoDia(addDays(hoy, -6), zona).desde.toISOString();
  const cifras = (await tx.query(
    `SELECT
       (SELECT coalesce(sum(total),0) FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2) AS ventas_hoy,
       (SELECT count(*)::int FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2) AS n_ventas_hoy,
       (SELECT coalesce(sum(total),0) FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $3) AS ventas_semana,
       (SELECT count(*)::int FROM appointment WHERE inicio >= $1 AND inicio < $2 AND estado <> 'CANCELADA') AS citas_hoy,
       (SELECT count(*)::int FROM appointment WHERE inicio >= $1 AND inicio < $2 AND estado <> 'CANCELADA' AND origen='AGENTE') AS citas_hoy_ia,
       (SELECT count(*)::int FROM conversation WHERE estado <> 'CERRADA') AS conversaciones_abiertas,
       (SELECT count(*)::int FROM conversation WHERE estado='ESCALADA') AS escaladas,
       (SELECT count(*)::int FROM customer WHERE creado_en >= $3 AND eliminado_en IS NULL) AS clientes_nuevos,
       (SELECT count(*)::int FROM conversation WHERE resuelta_por='AGENTE' AND actualizado_en >= $3) AS resueltas_ia_semana,
       (SELECT coalesce(sum(total),0) FROM "order" WHERE estado='CONFIRMADA' AND estado_pago <> 'PAGADA') AS por_cobrar`,
    [desde, hasta, semana],
  )).rows[0];
  const atencion: any[] = [];
  // Con la facturación DIAN apagada no hay facturas que rechazar ni ciclo fiscal: nada de eso sale al panel.
  if (config.fiscal.dianHabilitada && can(ctx, 'invoice:read')) {
    for (const f of (await tx.query(
      `SELECT f.id, f.numero, f.motivo_rechazo, o.id AS order_id, o.numero AS orden FROM fiscal_document f JOIN "order" o ON o.id=f.order_id WHERE f.estado='RECHAZADO' ORDER BY f.creado_en DESC LIMIT 5`,
    )).rows) atencion.push({ tipo: 'factura_rechazada', nivel: 'error', titulo: `Factura ${f.numero} rechazada (venta #${f.orden})`, detalle: f.motivo_rechazo, accion: { etiqueta: 'Corregir', ruta: `/ventas/${f.order_id}` } });
  }
  if (can(ctx, 'conversation:read')) {
    for (const k of (await tx.query(
      `SELECT k.radicado, k.prioridad, k.sla_vence_en, k.estado, k.conversation_id, c.nombre, u.nombre AS asignado FROM support_case k JOIN conversation v ON v.id=k.conversation_id
       JOIN customer c ON c.id=v.customer_id LEFT JOIN users u ON u.id=k.asignado_a
       WHERE k.estado IN ('EN_COLA','ASIGNADO') AND k.primera_respuesta_en IS NULL ORDER BY k.sla_vence_en LIMIT 5`,
    )).rows) {
      const vencido = new Date(k.sla_vence_en) < new Date();
      atencion.push({ tipo: 'caso', nivel: vencido ? 'error' : 'info', titulo: `${k.nombre} espera respuesta (${k.radicado})`, detalle: `Prioridad ${k.prioridad.toLowerCase()} · ${k.asignado ? `asignado a ${k.asignado}` : 'sin asignar'} · ${vencido ? 'tiempo de respuesta vencido' : `responder antes de las ${utcToLocal(new Date(k.sla_vence_en), zona).hora}`}`, accion: { etiqueta: 'Atender', ruta: `/conversaciones/${k.conversation_id}` } });
    }
  }
  if (can(ctx, 'inventory:read')) {
    for (const p of (await tx.query(`SELECT nombre, stock, stock_minimo FROM product WHERE controla_stock AND eliminado_en IS NULL AND activo AND stock <= stock_minimo LIMIT 5`)).rows)
      atencion.push({ tipo: 'stock', nivel: 'warn', titulo: `${p.nombre}: quedan ${Number(p.stock)}`, detalle: `El mínimo es ${Number(p.stock_minimo)}`, accion: { etiqueta: 'Reponer', ruta: '/inventario' } });
  }
  const fallidos = can(ctx, 'conversation:read') ? (await tx.query(`SELECT count(*)::int AS n FROM message WHERE estado_entrega='FALLIDO' AND creado_en > now() - interval '2 days'`)).rows[0].n : 0;
  if (fallidos) atencion.push({ tipo: 'entrega', nivel: 'warn', titulo: `${fallidos} mensaje(s) no se pudieron entregar por WhatsApp`, detalle: 'Revisa la conversación: puede que haya pasado la ventana de 24 h o el número no tenga WhatsApp.', accion: { etiqueta: 'Revisar', ruta: '/conversaciones' } });
  if (can(ctx, 'order:read')) {
    // Dinero que entró de más por la pasarela (venta ya pagada o anulada): hay que devolverlo.
    for (const x of (await tx.query(
      `SELECT p.monto, o.id, o.numero FROM order_payment p JOIN "order" o ON o.id=p.order_id WHERE p.estado='EXCEDENTE' ORDER BY p.creado_en DESC LIMIT 5`)).rows) {
      atencion.push({ tipo: 'pago_excedente', nivel: 'error', titulo: `Pago recibido de más en la venta #${x.numero}`, detalle: `La pasarela confirmó ${Math.round(Number(x.monto)).toLocaleString('es-CO')} COP de una venta que ya estaba pagada o anulada. Devuélvelo al cliente desde Wompi.`, accion: { etiqueta: 'Ver venta', ruta: `/ventas/${x.id}` } });
    }
  }
  const pend = (await tx.query(`SELECT count(*)::int AS n FROM pending_action WHERE estado='PENDIENTE' AND expira_en > now()`)).rows[0].n;
  if (pend && can(ctx, 'ai:read')) atencion.push({ tipo: 'confirmacion', nivel: 'info', titulo: `${pend} acción(es) de la IA esperan que el cliente confirme`, detalle: 'Solo se ejecutan si el cliente responde SÍ en los próximos minutos.', accion: { etiqueta: 'Ver', ruta: '/ia' } });

  const hilo = can(ctx, 'conversation:read') ? (await tx.query(
    `(SELECT 'mensaje' AS kind, m.id, coalesce(m.ocurrido_en, m.creado_en) AS creado_en, m.remitente, m.contenido AS texto, NULL::text AS herramienta, NULL::text AS decision, NULL::text AS riesgo, NULL::text AS permiso, NULL::text AS motivo, m.conversation_id, c.nombre AS cliente
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
    .map((a) => ({ ...a, hora: utcToLocal(new Date(a.inicio), zona).hora })) : [];
  const fiscal = config.fiscal.dianHabilitada && can(ctx, 'invoice:read') ? (await tx.query(
    `SELECT (SELECT count(*)::int FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1) AS ventas,
            count(*) FILTER (WHERE estado IN ('ENVIADO','VALIDADO','ENTREGADO'))::int AS emitidas,
            count(*) FILTER (WHERE estado IN ('VALIDADO','ENTREGADO'))::int AS validadas,
            count(*) FILTER (WHERE estado='ENTREGADO')::int AS entregadas,
            count(*) FILTER (WHERE estado='RECHAZADO')::int AS rechazadas
     FROM fiscal_document WHERE tipo='FACTURA' AND creado_en >= $1`, [desde])).rows[0] : null;
  // «Ventas de hoy»: cuántas, cuánto, comprobantes generados y las que hizo la IA.
  const ventasHoy = can(ctx, 'order:read') ? (await tx.query(
    `SELECT count(*)::int AS n, coalesce(sum(total),0)::float AS total, count(*) FILTER (WHERE origen='AGENTE')::int AS ia,
            (SELECT count(*)::int FROM comprobante_venta WHERE emitido_en >= $1 AND emitido_en < $2 AND estado <> 'ANULADO') AS comprobantes
     FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2`, [desde, hasta])).rows[0] : null;
  // Serie de 7 días completa (los días sin ventas valen 0: no se omiten).
  const porDia = new Map((await tx.query(
    `SELECT to_char(creado_en AT TIME ZONE $2, 'YYYY-MM-DD') AS dia, sum(total)::float AS total
     FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 GROUP BY 1`, [semana, zona])).rows.map((r) => [r.dia, Number(r.total)]));
  const ingresos = can(ctx, 'order:read') ? Array.from({ length: 7 }, (_, i) => { const dia = addDays(hoy, i - 6); return { dia, total: porDia.get(dia) ?? 0 }; }) : [];
  const ocupacion = can(ctx, 'appointment:read') ? (await tx.query(
    `SELECT r.nombre, count(a.id)::int AS citas FROM resource r LEFT JOIN appointment a ON a.resource_id=r.id AND a.inicio >= $1 AND a.inicio < $2 AND a.estado <> 'CANCELADA'
     WHERE r.activo GROUP BY r.nombre ORDER BY r.nombre`, [desde, hasta])).rows : [];
  // Lo cobrado hoy por método (por fecha del pago): lo que debería haber en caja y lo que entró por otros medios.
  const cobros = can(ctx, 'order:read') ? (await tx.query(
    `SELECT metodo, count(*)::int AS n, coalesce(sum(monto),0)::float AS total FROM order_payment WHERE estado='REGISTRADO' AND creado_en >= $1 AND creado_en < $2 GROUP BY metodo`, [desde, hasta])).rows : [];
  const cobro = (m: string) => cobros.find((c: any) => c.metodo === m)?.total ?? 0;
  const vivo = await tableroVivo(tx, ctx, hoy, zona);
  return {
    ...vivo,
    fecha: hoy, zona,
    cifras: { ...cifras, ventas_hoy: Number(cifras.ventas_hoy), ventas_semana: Number(cifras.ventas_semana), por_cobrar: Number(cifras.por_cobrar) },
    cobros_hoy: can(ctx, 'order:read') ? { efectivo: cobro('EFECTIVO'), transferencia: cobro('TRANSFERENCIA'), datafono: cobro('DATAFONO'), pasarela: cobro('PASARELA'), total: cobros.reduce((a: number, c: any) => a + c.total, 0), pagos: cobros.reduce((a: number, c: any) => a + c.n, 0) } : null,
    atencion, hilo, agenda, ...(fiscal ? { fiscal } : {}), ventas_hoy: ventasHoy, ingresos, ocupacion,
    pasos: can(ctx, 'tenant:configure') ? await primerosPasos(tx, ctx) : null,
    consumo: can(ctx, 'usage:read') ? await allQuotas(tx, ctx.tenantId) : null,
  };
}

/**
 * Cifras del tablero de Inicio que se arma en vivo: el mes contra el mismo tramo del mes anterior, la
 * semana contra la anterior, la serie de 30 días, la actividad de WhatsApp por hora y los últimos pagos.
 * Todo sale de la base; un día o una hora sin movimiento vale 0 (no se omite ni se rellena).
 */
async function tableroVivo(tx: Tx, ctx: Ctx, hoy: string, zona: string) {
  const ventas = can(ctx, 'order:read');
  const inicioMes = `${hoy.slice(0, 8)}01`;
  const [anio, mes] = [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7))];
  const mesPrevio = mes === 1 ? `${anio - 1}-12-01` : `${anio}-${String(mes - 1).padStart(2, '0')}-01`;
  const diasMesPrevio = new Date(Date.UTC(anio, mes - 1, 0)).getUTCDate();
  // Mismo tramo del mes anterior: del 1 al mismo día de hoy (o al último, si ese mes es más corto).
  const finTramoPrevio = addDays(mesPrevio, Math.min(Number(hoy.slice(8, 10)), diasMesPrevio));
  const d = (f: string) => rangoDia(f, zona).desde.toISOString();
  const [desdeMes, desdePrevio, hastaPrevio, semana, semanaPrevia, hace30, manana] =
    [d(inicioMes), d(mesPrevio), d(finTramoPrevio), d(addDays(hoy, -6)), d(addDays(hoy, -13)), d(addDays(hoy, -29)), d(addDays(hoy, 1))];

  let resumenMes = null;
  let serieMes: { dia: string; total: number }[] = [];
  let pagos: any[] = [];
  if (ventas) {
    const m = (await tx.query(
      `SELECT coalesce(sum(total) FILTER (WHERE creado_en >= $1), 0)::float AS ventas,
              count(*) FILTER (WHERE creado_en >= $1)::int AS n,
              coalesce(sum(total) FILTER (WHERE creado_en >= $2 AND creado_en < $3), 0)::float AS ventas_previo,
              coalesce(sum(total) FILTER (WHERE creado_en >= $4), 0)::float AS semana,
              count(*) FILTER (WHERE creado_en >= $4)::int AS n_semana,
              coalesce(sum(total) FILTER (WHERE creado_en >= $5 AND creado_en < $4), 0)::float AS semana_previa,
              count(*) FILTER (WHERE creado_en >= $5 AND creado_en < $4)::int AS n_semana_previa
       FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= least($2::timestamptz, $5::timestamptz) AND creado_en < $6`,
      [desdeMes, desdePrevio, hastaPrevio, semana, semanaPrevia, manana])).rows[0];
    // Lo cobrado de las ventas de este mes (no lo que entró este mes por ventas anteriores): nunca pasa del 100 %.
    const cobrado = (await tx.query(
      `SELECT coalesce(sum(p.monto), 0)::float AS total FROM order_payment p JOIN "order" o ON o.id=p.order_id
       WHERE p.estado='REGISTRADO' AND o.estado='CONFIRMADA' AND o.creado_en >= $1`, [desdeMes])).rows[0].total;
    resumenMes = { ...m, cobrado, ticket: m.n ? m.ventas / m.n : 0, ticket_semana: m.n_semana ? m.semana / m.n_semana : 0, ticket_semana_previa: m.n_semana_previa ? m.semana_previa / m.n_semana_previa : 0 };
    const porDia = new Map((await tx.query(
      `SELECT to_char(creado_en AT TIME ZONE $2, 'YYYY-MM-DD') AS dia, sum(total)::float AS total FROM "order"
       WHERE estado='CONFIRMADA' AND creado_en >= $1 GROUP BY 1`, [hace30, zona])).rows.map((r) => [r.dia, Number(r.total)]));
    serieMes = Array.from({ length: 30 }, (_, i) => { const dia = addDays(hoy, i - 29); return { dia, total: porDia.get(dia) ?? 0 }; });
    pagos = (await tx.query(
      `SELECT p.id, p.metodo, p.monto::float AS monto, p.estado, p.creado_en, o.id AS order_id, o.numero, c.nombre AS cliente
       FROM order_payment p JOIN "order" o ON o.id=p.order_id JOIN customer c ON c.id=o.customer_id
       ORDER BY p.creado_en DESC LIMIT 5`)).rows;
  }
  const nuevos = new Map((await tx.query(
    `SELECT to_char(creado_en AT TIME ZONE $2, 'YYYY-MM-DD') AS dia, count(*)::int AS n FROM customer
     WHERE creado_en >= $1 AND eliminado_en IS NULL GROUP BY 1`, [semana, zona])).rows.map((r) => [r.dia, r.n]));
  let actividad = null;
  if (can(ctx, 'conversation:read')) {
    // Mensajes de clientes por hora en las últimas 12 horas (la última posición es la hora en curso).
    const porHora = new Map((await tx.query(
      `SELECT floor(extract(epoch FROM (now() - coalesce(ocurrido_en, creado_en))) / 3600)::int AS h, count(*)::int AS n
       FROM message WHERE remitente='CUSTOMER' AND coalesce(ocurrido_en, creado_en) > now() - interval '12 hours' GROUP BY 1`)).rows.map((r) => [r.h, r.n]));
    const hoyMsg = (await tx.query(
      `SELECT count(*) FILTER (WHERE remitente='CUSTOMER')::int AS recibidos, count(*) FILTER (WHERE remitente='AI')::int AS ia
       FROM message WHERE tipo <> 'NOTA_INTERNA' AND creado_en >= $1 AND creado_en < $2`, [d(hoy), manana])).rows[0];
    actividad = { ...hoyMsg, serie: Array.from({ length: 12 }, (_, i) => porHora.get(11 - i) ?? 0) };
  }
  const empresa = (await tx.query(
    `SELECT (SELECT count(*)::int FROM customer WHERE eliminado_en IS NULL) AS clientes,
            (SELECT count(*)::int FROM product WHERE eliminado_en IS NULL AND activo) AS catalogo,
            (SELECT count(*)::int FROM user_tenant WHERE activo) AS equipo`)).rows[0];
  return {
    mes: resumenMes, serie_mes: serieMes, pagos_recientes: pagos, actividad, empresa,
    clientes_serie: Array.from({ length: 7 }, (_, i) => nuevos.get(addDays(hoy, i - 6)) ?? 0),
  };
}

/** Lista de configuración inicial calculada con datos reales (no se marca nada a mano). */
async function primerosPasos(tx: Tx, ctx: Ctx) {
  const r = (await tx.query(
    `SELECT t.whatsapp_estado, t.nit, t.logo_data_url,
       (SELECT count(*)::int FROM product WHERE eliminado_en IS NULL) AS productos,
       (SELECT count(*)::int FROM user_tenant WHERE activo) AS personas,
       (SELECT count(*)::int FROM invitation WHERE estado='PENDIENTE' AND expira_en > now()) AS invitaciones,
       (SELECT count(*)::int FROM resource WHERE activo) AS recursos,
       (SELECT count(*)::int FROM merchant_gateway_account) AS pasarela,
       EXISTS (SELECT 1 FROM audit_event WHERE accion IN ('catalogo.editar','catalogo.crear','catalogo.importar')) AS catalogo_revisado,
       EXISTS (SELECT 1 FROM audit_event WHERE accion IN ('agenda.recurso.editar','agenda.recurso.crear')) AS horarios_revisados
     FROM tenant t WHERE t.id=$1`, [ctx.tenantId])).rows[0];
  const pasos = [
    { clave: 'catalogo', titulo: 'Revisa tus productos y servicios', hecho: r.productos > 0 && r.catalogo_revisado, ruta: '/inventario', detalle: `${r.productos} en el catálogo` },
    { clave: 'horarios', titulo: 'Ajusta horarios de atención', hecho: r.recursos > 0 && r.horarios_revisados, ruta: '/configuracion?tab=equipo', detalle: `${r.recursos} agenda(s) activa(s)` },
    { clave: 'equipo', titulo: 'Invita a tu equipo', hecho: r.personas > 1 || r.invitaciones > 0, ruta: '/configuracion?tab=personas', detalle: `${r.personas} persona(s) con acceso` },
    { clave: 'whatsapp', titulo: 'Conecta tu número de WhatsApp', hecho: ['CONECTADO', 'SIMULADO'].includes(r.whatsapp_estado), ruta: '/configuracion?tab=canal', detalle: r.whatsapp_estado === 'SIMULADO' ? 'Usando el simulador' : r.whatsapp_estado === 'CONECTADO' ? 'Conectado' : 'Sin conectar' },
    { clave: 'cobros', titulo: 'Vincula tu cuenta de cobros', hecho: r.pasarela > 0, ruta: '/configuracion?tab=canal', detalle: r.pasarela > 0 ? 'Vinculada' : 'Sin vincular' },
    { clave: 'identidad', titulo: 'Sube tu logotipo', hecho: !!r.logo_data_url, ruta: '/configuracion?tab=empresa', detalle: r.logo_data_url ? 'Listo' : 'Usando monograma' },
  ];
  return { pasos, completos: pasos.filter((p) => p.hecho).length, total: pasos.length };
}

// ---------------------------------------------------------------------------
// Centro de IA
// ---------------------------------------------------------------------------
export async function aiCenter(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'ai:read');
  const agentes = (await tx.query(
    `SELECT a.id, a.configuracion, a.herramientas, a.prompt_base, a.activo, r.clave AS rol, r.nombre AS rol_nombre,
            coalesce(array_agg(rp.permiso) FILTER (WHERE rp.permiso IS NOT NULL), '{}') AS permisos
     FROM ai_agent a JOIN role r ON r.id=a.role_id LEFT JOIN role_permission rp ON rp.role_id=r.id GROUP BY a.id, r.clave, r.nombre ORDER BY a.configuracion`,
  )).rows.map((a) => ({ ...a, permisos_legibles: (a.permisos as string[]).map((p) => (PERMISOS as any)[p] ?? p) }));
  const settings = new Map((await tx.query(`SELECT herramienta, habilitada FROM ai_tool_setting`)).rows.map((r) => [r.herramienta, r.habilitada]));
  const uso = new Map((await tx.query(
    `SELECT herramienta, count(*) FILTER (WHERE decision IN ('PERMITIDA','CONFIRMADA'))::int AS ejecutadas, count(*) FILTER (WHERE decision='DENEGADA')::int AS denegadas
     FROM ai_execution WHERE creado_en > now() - interval '30 days' GROUP BY herramienta`,
  )).rows.map((r) => [r.herramienta, r]));
  const herramientas = [];
  for (const t of TOOLS) {
    herramientas.push({
      nombre: t.nombre, version: t.version, modulo: t.modulo, descripcion: t.descripcion, permiso: t.permiso, permiso_legible: (PERMISOS as any)[t.permiso] ?? t.permiso,
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
  const tope = (await tx.query(`SELECT ia_tope_mensual FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]?.ia_tope_mensual;
  return { agentes, herramientas, metricas, por_comprobacion: porComprobacion, consumo: await allQuotas(tx, ctx.tenantId), tope_mensual: tope === null || tope === undefined ? null : Number(tope), modelo: config.llm.provider === 'anthropic' ? config.llm.model : config.llm.provider };
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
// Configuración: personas, roles, módulos, identidad, canal, plantillas, cobros
// ---------------------------------------------------------------------------
export async function settings(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'tenant:configure');
  const personas = (await tx.query(
    `SELECT u.id, coalesce(ut.nombre_visible,u.nombre) AS nombre, u.email, r.clave AS rol, r.nombre AS rol_nombre, ut.activo, ut.disponible, ut.creado_en,
            (t.propietario_id = u.id) AS propietario, (u.email_verificado_en IS NOT NULL) AS correo_verificado,
            EXISTS (SELECT 1 FROM role_permission rp WHERE rp.role_id=r.id AND rp.permiso='case:manage') AS atiende_casos
     FROM user_tenant ut JOIN users u ON u.id=ut.user_id JOIN role r ON r.id=ut.role_id JOIN tenant t ON t.id=ut.tenant_id
     ORDER BY (t.propietario_id = u.id) DESC, ut.activo DESC, ut.creado_en`,
  )).rows;
  const roles = (await tx.query(
    `SELECT r.id, r.clave, r.nombre, r.es_agente, coalesce(array_agg(rp.permiso ORDER BY rp.permiso) FILTER (WHERE rp.permiso IS NOT NULL), '{}') AS permisos
     FROM role r LEFT JOIN role_permission rp ON rp.role_id=r.id GROUP BY r.id ORDER BY r.es_agente, r.nombre`,
  )).rows;
  const modulos = (await tx.query(
    `SELECT m.modulo, m.activo, (m.modulo = ANY(p.modulos)) AS incluido_en_plan FROM tenant_module m JOIN tenant t ON t.id=m.tenant_id JOIN plan p ON p.codigo=t.plan_codigo ORDER BY m.modulo`,
  )).rows.map((m) => ({ ...m, nombre: MODULOS[m.modulo]?.nombre ?? m.modulo, descripcion: MODULOS[m.modulo]?.descripcion ?? '' }));
  const t = (await tx.query(
    `SELECT nombre, slug, nit, ciudad, email_contacto, telefono, tema, logo_data_url, zona_horaria, ia_tope_mensual,
            whatsapp_phone_number_id, whatsapp_estado, whatsapp_numero_visible, whatsapp_diagnostico, whatsapp_verificado_en
     FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0];
  const recursos = (await tx.query(`SELECT id, nombre, horario, activo FROM resource ORDER BY activo DESC, nombre`)).rows;
  const plantillas = (await tx.query(`SELECT clave, categoria, cuerpo, nombre_proveedor, idioma, variables, estado_aprobacion FROM message_template ORDER BY clave`)).rows;
  return {
    tenant: { ...t, ia_tope_mensual: t.ia_tope_mensual === null ? null : Number(t.ia_tope_mensual) },
    personas, soy_propietario: !!ctx.propietario, invitaciones: can(ctx, 'user:manage') ? await listInvitations(tx, ctx) : [], roles, modulos, recursos, plantillas,
    catalogo_permisos: PERMISOS, pasarela: await gatewayAccount(tx, ctx),
    // El estado técnico de los proveedores es solo del operador de Omnegia (/operador/integraciones): una empresa no lo ve.
  };
}

export const EmpresaInput = z.object({
  nombre: z.string().trim().min(2, 'El nombre es muy corto.').max(80).optional(),
  nit: z.string().trim().max(20).nullable().optional().refine((v) => !v || nitValido(v), 'NIT no válido: escribe el número con su dígito de verificación (ej. 901456789-3).'),
  ciudad: z.string().trim().max(60).nullable().optional(),
  email_contacto: z.email('Correo no válido.').optional(),
  telefono: z.string().max(20).nullable().optional(),
  zona_horaria: z.string().trim().max(60).optional().refine((v) => !v || zonaValida(v) === v, 'Zona horaria no reconocida (usa el formato America/Bogota).'),
  whatsapp_phone_number_id: z.string().trim().regex(/^(sim-[a-z0-9-]{2,36}|\d{6,30})$/i, 'El identificador del número son solo dígitos (en demostración: sim-<nombre>).').nullable().optional(),
  ia_tope_mensual: z.number().int().min(10_000).max(1_000_000_000).nullable().optional(),
});

/** Validación de los datos de la empresa. La escritura la hace la ruta con el rol de plataforma. */
export async function updateTenantInfo(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = EmpresaInput.parse(body);
  if (d.whatsapp_phone_number_id?.startsWith('sim-') && !config.simuladores) throw invalid('Los números de simulación solo se permiten en el entorno de demostración.');
  // Un número real se conecta con «Usar mi propio número» o lo asigna el equipo de Omnegia: la empresa no escribe
  // identificadores de la cuenta de WhatsApp de la plataforma (podría tomar un número que no es suyo).
  if (d.whatsapp_phone_number_id && !d.whatsapp_phone_number_id.startsWith('sim-')) {
    throw invalid('Conecta tu número desde «Número de WhatsApp › Usar mi propio número»: solo necesitas recibir un código por SMS. No hace falta copiar identificadores de Meta.');
  }
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

export async function updateMember(tx: Tx, ctx: Ctx, userId: string, body: unknown) {
  requirePerm(ctx, 'user:manage');
  requireWritable(ctx);
  if (!isUuid(userId)) throw notFound();
  const d = z.object({ nombre:z.string().trim().min(2).max(80).optional(), rol: z.string().optional(), activo: z.boolean().optional(), disponible: z.boolean().optional() }).parse(body);
  const m = (await tx.query(`SELECT ut.user_id, ut.activo, r.clave, r.nombre AS rol_nombre FROM user_tenant ut JOIN role r ON r.id=ut.role_id WHERE ut.user_id=$1 FOR UPDATE OF ut`, [userId])).rows[0];
  if (!m) throw notFound();
  if (userId === ctx.actor.id && (d.activo === false || (d.rol && d.rol !== m.clave))) throw new AppError('CONFLICT', 'No puedes quitarte tu propio acceso de administración.');
  // El propietario está por encima del administrador: nadie más cambia su rol, su nombre ni su acceso.
  const propietario = (await tx.query(`SELECT propietario_id FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]?.propietario_id;
  if (userId === propietario && userId !== ctx.actor.id && (d.rol !== undefined || d.activo !== undefined || d.nombre !== undefined)) {
    throw new AppError('FORBIDDEN', 'Esta persona es la propietaria de la empresa: solo ella puede cambiar su rol, su nombre o su acceso.', {
      audit: { accion: 'usuario.editar', recurso: 'user', motivo: 'propietario_protegido' },
    });
  }
  if(d.nombre) await tx.query('UPDATE user_tenant SET nombre_visible=$2 WHERE user_id=$1',[userId,d.nombre]);
  let rolNuevo: string | null = null;
  if (d.rol) {
    const r = (await tx.query(`SELECT id, es_agente, nombre FROM role WHERE clave=$1`, [d.rol])).rows[0];
    if (!r || r.es_agente) throw invalid('Rol no válido.');
    await tx.query(`UPDATE user_tenant SET role_id=$2 WHERE user_id=$1`, [userId, r.id]);
    if (d.rol !== m.clave) rolNuevo = r.nombre;
  }
  if (d.activo === true && !m.activo) {
    const plan = (await tx.query(`SELECT p.max_usuarios FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo WHERE t.id=$1`, [ctx.tenantId])).rows[0];
    const n = (await tx.query(`SELECT count(*)::int AS n FROM user_tenant WHERE activo`)).rows[0].n;
    if (n >= plan.max_usuarios) throw new AppError('CONFLICT', `Tu plan permite ${plan.max_usuarios} personas activas.`);
  }
  if (d.activo !== undefined) await tx.query(`UPDATE user_tenant SET activo=$2 WHERE user_id=$1`, [userId, d.activo]);
  if (d.activo === false) {
    // Sus radicados abiertos vuelven a la cola para que nadie quede sin respuesta.
    await tx.query(`UPDATE support_case SET asignado_a=NULL, estado=CASE WHEN estado='ASIGNADO' THEN 'EN_COLA' ELSE estado END WHERE asignado_a=$1 AND estado IN ('ASIGNADO')`, [userId]);
  }
  if (d.disponible !== undefined) await tx.query(`UPDATE user_tenant SET disponible=$2 WHERE user_id=$1`, [userId, d.disponible]);
  // No hay un administrador sin acceso de administración: al menos uno debe conservar user:manage.
  const admins = (await tx.query(`SELECT count(*)::int AS n FROM user_tenant ut JOIN role_permission rp ON rp.role_id=ut.role_id WHERE ut.activo AND rp.permiso='user:manage'`)).rows[0].n;
  if (!admins) throw new AppError('CONFLICT', 'Debe quedar al menos una persona con permiso para administrar el equipo.');
  await audit(tx, ctx, { accion: 'usuario.editar', recurso: 'user', recursoId: userId, resultado: 'EXITO', detalle: d });
  // Cambios importantes de permisos: se avisa a la persona afectada.
  const desactivado = d.activo === false && m.activo;
  const reactivado = d.activo === true && !m.activo;
  if (rolNuevo || desactivado || reactivado) {
    const u = (await tx.query(`SELECT id, email, nombre FROM users WHERE id=$1`, [userId])).rows[0];
    const empresa = (await tx.query(`SELECT nombre FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]?.nombre ?? '';
    if (u) await encolarCorreo(tx, { tenantId: ctx.tenantId, userId: u.id, para: u.email,
      correo: plantillas.cambioAcceso({ nombre: u.nombre, empresa, rolAnterior: m.rol_nombre, rolNuevo, desactivado, reactivado, urlPanel: config.publicUrl }) });
  }
  return { ok: true };
}

/**
 * Cede la propiedad de la empresa a otra persona activa del equipo. Solo el propietario lo hace y
 * confirma con su contraseña. Quien recibe pasa al rol de administración; quien cede se queda como
 * administrador (desde ese momento el nuevo propietario puede cambiarle el rol). El registro de la
 * empresa es de plataforma, así que todo ocurre en una sola transacción de plataforma, filtrada
 * explícitamente por la empresa del contexto.
 */
export async function transferirPropiedad(db: Database, ctx: Ctx, body: unknown) {
  requireWritable(ctx);
  if (!ctx.propietario) {
    throw new AppError('FORBIDDEN', 'Solo el propietario puede ceder la propiedad de la empresa.', {
      audit: { accion: 'empresa.propiedad_ceder', recurso: 'tenant', motivo: 'no_propietario' },
    });
  }
  const d = z.object({ user_id: z.string(), contrasena: z.string().max(200) }).parse(body);
  if (!isUuid(d.user_id)) throw notFound();
  if (d.user_id === ctx.actor.id) throw invalid('Ya eres el propietario de esta empresa.');
  return db.withPlatform(async (tx) => {
    const t = (await tx.query(`SELECT nombre, propietario_id FROM tenant WHERE id=$1 FOR UPDATE`, [ctx.tenantId])).rows[0];
    if (!t || t.propietario_id !== ctx.actor.id) throw new AppError('CONFLICT', 'La propiedad de la empresa cambió. Recarga la página.');
    const yo = (await tx.query(`SELECT email, password_hash FROM users WHERE id=$1`, [ctx.actor.id])).rows[0];
    if (!yo?.password_hash || !verifyPassword(d.contrasena, yo.password_hash)) throw new AppError('VALIDATION', 'La contraseña no es correcta.');
    const m = (await tx.query(
      `SELECT ut.activo, r.es_agente, coalesce(ut.nombre_visible, u.nombre) AS nombre, u.email, u.email_verificado_en
       FROM user_tenant ut JOIN users u ON u.id=ut.user_id JOIN role r ON r.tenant_id=ut.tenant_id AND r.id=ut.role_id
       WHERE ut.tenant_id=$1 AND ut.user_id=$2 FOR UPDATE OF ut`, [ctx.tenantId, d.user_id])).rows[0];
    if (!m) throw notFound();
    if (!m.activo || m.es_agente) throw new AppError('CONFLICT', 'Solo puedes ceder la propiedad a una persona con acceso activo.');
    if (!m.email_verificado_en) throw new AppError('CONFLICT', `${m.nombre} debe confirmar su correo antes de recibir la propiedad.`);
    // Rol de administración de la plantilla: el que gestiona el equipo con más permisos.
    const adminRol = (await tx.query(
      `SELECT r.id, r.clave FROM role r JOIN role_permission rp ON rp.tenant_id=r.tenant_id AND rp.role_id=r.id
       WHERE r.tenant_id=$1 AND NOT r.es_agente
       GROUP BY r.id, r.clave HAVING bool_or(rp.permiso='user:manage') ORDER BY count(*) DESC, r.clave LIMIT 1`, [ctx.tenantId])).rows[0];
    if (adminRol) await tx.query(`UPDATE user_tenant SET role_id=$3 WHERE tenant_id=$1 AND user_id=$2`, [ctx.tenantId, d.user_id, adminRol.id]);
    await tx.query(`UPDATE tenant SET propietario_id=$2 WHERE id=$1`, [ctx.tenantId, d.user_id]);
    await audit(tx, ctx, { accion: 'empresa.propiedad_cedida', recurso: 'user', recursoId: d.user_id, resultado: 'EXITO', detalle: { rol: adminRol?.clave ?? null } });
    await encolarCorreo(tx, { tenantId: ctx.tenantId, userId: d.user_id, para: m.email,
      correo: plantillas.propiedadCedida({ nombre: m.nombre, empresa: t.nombre, recibe: true, otro: ctx.actor.nombre, urlPanel: config.publicUrl }) });
    await encolarCorreo(tx, { tenantId: ctx.tenantId, userId: ctx.actor.id!, para: yo.email,
      correo: plantillas.propiedadCedida({ nombre: ctx.actor.nombre, empresa: t.nombre, recibe: false, otro: m.nombre, urlPanel: config.publicUrl }) });
    return { ok: true, propietario: { id: d.user_id, nombre: m.nombre } };
  });
}

/** Mi disponibilidad para el motor de asignación (cualquier asesor). */
export async function setMyAvailability(tx: Tx, ctx: Ctx, disponible: boolean) {
  requireWritable(ctx);
  await tx.query(`UPDATE user_tenant SET disponible=$2 WHERE user_id=$1`, [ctx.actor.id, disponible]);
  await audit(tx, ctx, { accion: 'usuario.disponibilidad', recurso: 'user', recursoId: ctx.actor.id, resultado: 'EXITO', detalle: { disponible } });
  return { disponible };
}

const PlantillaInput = z.object({
  nombre_proveedor: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'El nombre en Meta usa minúsculas, números y guion bajo.').nullable().optional(),
  idioma: z.string().trim().regex(/^[a-z]{2}(_[A-Z]{2})?$/, 'Código de idioma como es o es_CO.').optional(),
  estado_aprobacion: z.enum(['NO_REGISTRADA', 'APROBADA', 'RECHAZADA', 'PAUSADA']).optional(),
});

/** Registra cómo se llama y en qué estado está la plantilla en el administrador de WhatsApp de Meta. */
export async function updateTemplate(tx: Tx, ctx: Ctx, clave: string, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = PlantillaInput.parse(body);
  if (d.estado_aprobacion === 'APROBADA' && !d.nombre_proveedor) {
    const actual = (await tx.query(`SELECT nombre_proveedor FROM message_template WHERE clave=$1`, [clave])).rows[0];
    if (!actual?.nombre_proveedor) throw invalid('Escribe el nombre con el que Meta aprobó la plantilla.');
  }
  const r = await tx.query(
    `UPDATE message_template SET nombre_proveedor=coalesce($2, nombre_proveedor), idioma=coalesce($3, idioma), estado_aprobacion=coalesce($4, estado_aprobacion) WHERE clave=$1 RETURNING clave`,
    [clave, d.nombre_proveedor ?? null, d.idioma ?? null, d.estado_aprobacion ?? null]);
  if (!r.rows[0]) throw notFound();
  await audit(tx, ctx, { accion: 'canal.plantilla', recurso: 'message_template', recursoId: clave, resultado: 'EXITO', detalle: d });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Suscripción
// ---------------------------------------------------------------------------
export async function subscriptionInfo(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'subscription:manage');
  const s = (await tx.query(
    `SELECT s.*, p.nombre AS plan_nombre, p.precio_mensual, p.precio_anual, p.cuota_tokens_ia, p.cuota_mensajes, p.cuota_documentos, p.max_usuarios, p.politica_excedente, p.precio_excedente_1k_tokens
     FROM subscription s JOIN plan p ON p.codigo=s.plan_codigo WHERE s.tenant_id=$1`, [ctx.tenantId])).rows[0];
  const historico = (await tx.query(`SELECT periodo, metrica, cantidad FROM usage_record ORDER BY periodo DESC, metrica LIMIT 36`)).rows;
  const usuarios = (await tx.query(`SELECT count(*)::int AS n FROM user_tenant WHERE activo`)).rows[0].n;
  // Periodos pagados con su modalidad, monto y condiciones (trazabilidad visible para la empresa).
  const periodos = (await tx.query(`SELECT modalidad, monto_pagado, monto_referencia, periodo_inicio, periodo_fin, condiciones, ciclo FROM subscription_period ORDER BY periodo_inicio DESC LIMIT 24`)).rows
    .map((p: any) => ({ ...p, monto_pagado: Number(p.monto_pagado), monto_referencia: p.monto_referencia == null ? null : Number(p.monto_referencia) }));
  // Lo que paga esta empresa: su precio pactado si lo conserva; si hay un cambio programado, la renovación ya es la del plan nuevo.
  const precios = preciosDe(s, s.precio_pactado);
  const programado = s.modalidad === 'COMERCIAL' ? s.cambio_programado : null;
  const cobro = programado
    ? { modalidad: s.modalidad, precio_mensual: programado.ciclo === 'ANUAL' ? programado.precio / 10 : programado.precio, precio_anual: programado.ciclo === 'ANUAL' ? programado.precio : programado.precio * 10 }
    : { modalidad: s.modalidad, precio_mensual: precios.mensual, precio_anual: precios.anual };
  const ciclo: Ciclo = programado?.ciclo ?? s.ciclo ?? 'MENSUAL';
  const fin = s.estado === 'EN_GRACIA' && s.gracia_hasta ? new Date(s.gracia_hasta).getTime() : null;
  return {
    suscripcion: { ...s, precio_mensual: precios.mensual, precio_anual: precios.anual, precio_catalogo: Number(s.precio_mensual), precio_pagado: s.precio_pagado == null ? null : Number(s.precio_pagado) },
    consumo: await allQuotas(tx, ctx.tenantId), historico, usuarios, periodos,
    pagos_en_linea: config.pagos.proveedor !== 'ninguno',
    // Cómo continuar: lo que se cobraría y si exige aceptar un cambio de modalidad. Nunca es automático.
    renovacion: ofertaRenovacion(cobro, s.modalidad === 'COMERCIAL' ? ciclo : 'MENSUAL'),
    // Periodo de gracia real (ciclo_suscripcion): días que quedan antes de pasar a solo lectura.
    gracia: fin == null ? null : { hasta: s.gracia_hasta, dias_total: DIAS_GRACIA, dias_restantes: Math.max(0, Math.ceil((fin - Date.now()) / 86_400_000)) },
    solo_lectura: QUE_SE_PAUSA,
  };
}

// ---------------------------------------------------------------------------
// Auditoría: solo lectura; el registro no se edita ni se borra
// ---------------------------------------------------------------------------
export async function auditLog(tx: Tx, ctx: Ctx, f: { tipo?: string; resultado?: string; q?: string; limite?: number; pagina?: number }) {
  requirePerm(ctx, 'audit:read');
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.tipo === 'ia') where.push(`accion LIKE 'ia.%'`);
  if (f.tipo === 'seguridad') where.push(`(accion LIKE 'acceso.%' OR accion LIKE 'permiso.%' OR accion LIKE 'sesion.%' OR resultado IN ('DENEGADO','NO_ENCONTRADO'))`);
  if (f.tipo === 'fiscal') where.push(`(accion LIKE 'factura.%' OR accion LIKE 'nota_credito.%' OR accion LIKE 'documento.%')`);
  if (f.tipo === 'configuracion') where.push(`(accion LIKE 'usuario.%' OR accion LIKE 'modulo.%' OR accion LIKE 'tenant.%' OR accion LIKE 'suscripcion.%' OR accion LIKE 'pasarela.%' OR accion LIKE 'canal.%')`);
  if (f.tipo === 'cobros') where.push(`(accion LIKE 'cobro.%' OR accion LIKE 'suscripcion.%')`);
  if (f.resultado && ['EXITO', 'PERMITIDO', 'DENEGADO', 'NO_ENCONTRADO', 'ERROR'].includes(f.resultado)) { params.push(f.resultado); where.push(`resultado=$${params.length}`); }
  if (f.q) { params.push(`%${String(f.q).slice(0, 80)}%`); where.push(`(accion ILIKE $${params.length} OR actor_nombre ILIKE $${params.length} OR recurso_id ILIKE $${params.length} OR correlacion ILIKE $${params.length})`); }
  const limite = Math.min(f.limite ?? 100, 5000);
  const pagina = Math.max(Number(f.pagina) || 1, 1);
  params.push(limite);
  return (await tx.query(
    `SELECT id, actor_tipo, actor_id, actor_nombre, accion, recurso, recurso_id, resultado, origen, correlacion, detalle, creado_en FROM audit_event
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY creado_en DESC LIMIT $${params.length} OFFSET ${(pagina - 1) * limite}`, params)).rows;
}

export function toCsv(rows: any[]): string {
  const cols = ['creado_en', 'actor_tipo', 'actor_nombre', 'accion', 'recurso', 'recurso_id', 'resultado', 'origen', 'correlacion', 'detalle'];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v);
    const seguro = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n;]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}
