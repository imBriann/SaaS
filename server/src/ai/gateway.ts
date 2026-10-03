import type { Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { audit } from '../core/audit.js';
import { PERMISOS_PROHIBIDOS_A_AGENTES, type Permiso } from '../core/permissions.js';
import { AppError } from '../lib/errors.js';
import { uuidv7 } from '../lib/util.js';
import { ORDEN_RIESGO, TOOL_MAP, type NivelRiesgo, type ToolDef, type ToolRuntime } from './registry.js';

/**
 * AI Action Gateway (PRO-SW-002 fig. 07b).
 *
 * Cuatro comprobaciones entre la propuesta del modelo y la ejecución, y una sola
 * salida hacia los datos. TODA llamada intentada queda registrada en
 * ai_execution y en auditoría, se haya permitido o no.
 *
 *   1. Registro:  la herramienta existe, está en el catálogo del agente, habilitada
 *                 para el tenant y su módulo está activo.
 *   2. Esquema:   los argumentos validan contra el contrato (estricto: un campo
 *                 extra como tenant_id invalida la llamada).
 *   3. Permiso:   el rol del agente tiene el permiso requerido; los permisos
 *                 prohibidos a agentes y el nivel «crítica» se niegan siempre.
 *   4. Contexto:  límite por conversación, riesgo efectivo (confirmación) y
 *                 pertenencia de los recursos al tenant (vía RLS: «no encontrado»).
 */

export interface AgentProfile {
  id: string;
  configuracion: 'atencion' | 'asistente' | 'copiloto';
  herramientas: string[];
  permisos: ReadonlySet<string>;
  roleKey: string;
  prompt_base?: string;
}

export type Decision = 'PERMITIDA' | 'DENEGADA' | 'PENDIENTE_CONFIRMACION' | 'CONFIRMADA' | 'ERROR';

export interface GatewayResult {
  decision: Decision;
  executionId: string;
  herramienta: string;
  resultado?: Record<string, unknown>;
  motivo?: string;
  comprobacion?: 1 | 2 | 3 | 4;
  pendingActionId?: string;
  resumen?: string;
  riesgo?: NivelRiesgo;
}

async function toolEnabled(tx: Tx, nombre: string): Promise<boolean> {
  const r = (await tx.query(`SELECT habilitada FROM ai_tool_setting WHERE herramienta=$1`, [nombre])).rows[0];
  return r ? r.habilitada : true;
}

async function moduleActive(tx: Tx, modulo: string): Promise<boolean> {
  const always = ['soporte', 'suscripcion', 'clientes', 'conversaciones'];
  if (always.includes(modulo)) return true;
  const r = (await tx.query(`SELECT activo FROM tenant_module WHERE modulo=$1`, [modulo])).rows[0];
  return !!r?.activo;
}

/** Riesgo efectivo: la plantilla de sector puede endurecer el nivel, nunca rebajarlo. */
export async function effectiveRisk(tx: Tx, t: ToolDef): Promise<NivelRiesgo> {
  const r = (await tx.query(
    `SELECT st.contenido->'politica_riesgo'->>$1 AS nivel FROM tenant te JOIN sector_template st ON st.sector=te.sector AND st.version=te.sector_version LIMIT 1`,
    [t.nombre],
  )).rows[0];
  const plantilla = r?.nivel as NivelRiesgo | undefined;
  if (plantilla && ORDEN_RIESGO[plantilla] > ORDEN_RIESGO[t.riesgo]) return plantilla;
  return t.riesgo;
}

/** Herramientas visibles para el modelo: se filtran ANTES de que el modelo vea nada (fig. 07a). */
export async function visibleTools(tx: Tx, agent: AgentProfile, hasCustomer: boolean): Promise<ToolDef[]> {
  const out: ToolDef[] = [];
  for (const nombre of agent.herramientas) {
    const t = TOOL_MAP.get(nombre);
    if (!t) continue;
    if (t.riesgo === 'critica') continue;
    if (!agent.permisos.has(t.permiso) || PERMISOS_PROHIBIDOS_A_AGENTES.includes(t.permiso as Permiso)) continue;
    if (t.requiereCliente && !hasCustomer) continue;
    if (!(await toolEnabled(tx, nombre)) || !(await moduleActive(tx, t.modulo))) continue;
    out.push(t);
  }
  return out;
}

interface Record_ {
  decision: Decision;
  motivo?: string;
  comprobacion?: number;
  resultado?: Record<string, unknown>;
  riesgo?: string;
  permiso?: string;
  version?: string;
  confirmadoPor?: string;
  pendingId?: string;
  ms?: number;
}

async function record(tx: Tx, ctx: Ctx, agent: AgentProfile, conversationId: string | null, nombre: string, args: unknown, r: Record_): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO ai_execution (id, tenant_id, agent_id, configuracion, conversation_id, herramienta, version_herramienta, argumentos,
       nivel_riesgo, permiso_requerido, decision, motivo_denegacion, comprobacion_fallida, confirmado_por, resultado, pending_action_id, duracion_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id, ctx.tenantId, agent.id, agent.configuracion, conversationId, nombre.slice(0, 80), r.version ?? null,
      JSON.stringify(args ?? {}).slice(0, 4000), r.riesgo ?? null, r.permiso ?? null, r.decision, r.motivo ?? null,
      r.comprobacion ?? null, r.confirmadoPor ?? null, r.resultado ? JSON.stringify(r.resultado) : null, r.pendingId ?? null, r.ms ?? null,
    ],
  );
  await audit(tx, ctx, {
    accion: `ia.herramienta.${nombre.slice(0, 60)}`,
    recurso: 'ai_execution',
    recursoId: id,
    resultado: r.decision === 'DENEGADA' ? (r.motivo === 'recurso_no_encontrado' ? 'NO_ENCONTRADO' : 'DENEGADO') : r.decision === 'ERROR' ? 'ERROR' : 'PERMITIDO',
    detalle: { agente: agent.configuracion, decision: r.decision, motivo: r.motivo, comprobacion: r.comprobacion, riesgo: r.riesgo, permiso: r.permiso, conversacion: conversationId },
  });
  return id;
}

export interface CallOptions {
  /** Confirmación explícita del humano detectada por código determinista. */
  confirmacion?: { por: string; pendingActionId: string };
}

export async function evaluateAndExecute(
  rt: ToolRuntime,
  agent: AgentProfile,
  call: { nombre: string; argumentos: unknown },
  opts: CallOptions = {},
): Promise<GatewayResult> {
  const { tx, ctx, conversationId } = rt;
  const t = TOOL_MAP.get(call.nombre);
  const deny = async (comprobacion: 1 | 2 | 3 | 4, motivo: string, extra: Partial<Record_> = {}): Promise<GatewayResult> => {
    const executionId = await record(tx, ctx, agent, conversationId, call.nombre, call.argumentos, {
      decision: 'DENEGADA', motivo, comprobacion, riesgo: t?.riesgo, permiso: t?.permiso, version: t?.version, ...extra,
    });
    return { decision: 'DENEGADA', executionId, herramienta: call.nombre, motivo, comprobacion };
  };

  // 1 · Registro
  if (!t || !agent.herramientas.includes(t.nombre)) return deny(1, 'herramienta_no_registrada_para_el_agente');
  if (!(await toolEnabled(tx, t.nombre))) return deny(1, 'herramienta_deshabilitada');
  if (!(await moduleActive(tx, t.modulo))) return deny(1, 'modulo_inactivo');

  // 2 · Esquema
  const parsed = t.args.safeParse(call.argumentos ?? {});
  if (!parsed.success) {
    return deny(2, 'argumentos_invalidos', { resultado: { errores: parsed.error.issues.slice(0, 5).map((i: any) => `${i.path.join('.')}: ${i.message}`) } });
  }
  if (t.requiereCliente && !rt.customerId) return deny(2, 'sin_cliente_en_contexto');

  // 3 · Permiso
  const riesgo = await effectiveRisk(tx, t);
  if (riesgo === 'critica') return deny(3, 'accion_critica_reservada_a_personas', { riesgo });
  if (PERMISOS_PROHIBIDOS_A_AGENTES.includes(t.permiso as Permiso)) return deny(3, 'permiso_prohibido_a_agentes', { riesgo });
  if (!agent.permisos.has(t.permiso)) return deny(3, 'permiso_ausente', { riesgo });

  // 4 · Contexto y política
  if (t.limitePorConversacion && conversationId) {
    const n = Number((await tx.query(
      `SELECT count(*)::int AS n FROM ai_execution WHERE conversation_id=$1 AND herramienta=$2 AND decision IN ('PERMITIDA','CONFIRMADA')`,
      [conversationId, t.nombre],
    )).rows[0].n);
    if (n >= t.limitePorConversacion) return deny(4, 'limite_por_conversacion', { riesgo });
  }
  if (riesgo === 'confirmable' && !opts.confirmacion) {
    const resumen = t.resumen ? await t.resumen(parsed.data, rt).catch(() => t.descripcion) : t.descripcion;
    const pendingId = uuidv7();
    if (conversationId) {
      await tx.query(`UPDATE pending_action SET estado='EXPIRADA' WHERE conversation_id=$1 AND estado='PENDIENTE'`, [conversationId]);
      await tx.query(
        `INSERT INTO pending_action (id, tenant_id, conversation_id, agent_id, herramienta, argumentos, resumen, estado, expira_en)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDIENTE', now() + interval '30 minutes')`,
        [pendingId, ctx.tenantId, conversationId, agent.id, t.nombre, JSON.stringify(parsed.data), resumen],
      );
    }
    const executionId = await record(tx, ctx, agent, conversationId, t.nombre, parsed.data, {
      decision: 'PENDIENTE_CONFIRMACION', riesgo, permiso: t.permiso, version: t.version, pendingId, resultado: { resumen },
    });
    return { decision: 'PENDIENTE_CONFIRMACION', executionId, herramienta: t.nombre, pendingActionId: pendingId, resumen, riesgo };
  }

  // Ejecución: única salida hacia los datos, aislada en un savepoint.
  const t0 = Date.now();
  await tx.query('SAVEPOINT tool_exec');
  try {
    const resultado = await t.run(parsed.data, rt);
    await tx.query('RELEASE SAVEPOINT tool_exec');
    const decision: Decision = opts.confirmacion ? 'CONFIRMADA' : 'PERMITIDA';
    const executionId = await record(tx, ctx, agent, conversationId, t.nombre, parsed.data, {
      decision, riesgo, permiso: t.permiso, version: t.version, resultado, confirmadoPor: opts.confirmacion?.por,
      pendingId: opts.confirmacion?.pendingActionId, ms: Date.now() - t0,
    });
    return { decision, executionId, herramienta: t.nombre, resultado, riesgo };
  } catch (e) {
    await tx.query('ROLLBACK TO SAVEPOINT tool_exec');
    if (e instanceof AppError && e.code === 'NOT_FOUND') {
      // Un uuid de otro tenant o inexistente: la respuesta no distingue; la auditoría sí.
      return deny(4, 'recurso_no_encontrado', { riesgo });
    }
    const motivo = e instanceof AppError ? e.message : 'error_interno';
    const executionId = await record(tx, ctx, agent, conversationId, t.nombre, parsed.data, {
      decision: 'ERROR', motivo, riesgo, permiso: t.permiso, version: t.version, ms: Date.now() - t0,
    });
    return { decision: 'ERROR', executionId, herramienta: t.nombre, motivo, riesgo };
  }
}
