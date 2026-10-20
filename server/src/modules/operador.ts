import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { CATALOGO_INCIDENTES } from '../core/incidentes.js';
import { CUBETAS_MS, inicioProceso, percentil } from '../core/metricas.js';
import { encolarCorreo, mensajeFallo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { enmascararTelefono, isUuid, periodo, uuidv7 } from '../lib/util.js';
import { config, integraciones } from '../config.js';
import type { SessionUser } from './auth.js';
import { ETIQUETA_CATEGORIA, revisarContenido } from './soporte.js';

/**
 * Panel interno del operador de Omnegia.
 *
 * Toda consulta corre con el rol app_operador (db.withOperador): sin BYPASSRLS y con
 * privilegios por columna sobre las tablas comerciales y técnicas. No hay acceso a
 * clientes, conversaciones, mensajes, citas, ventas, inventario, facturas, cuentas de
 * cobro de los comercios, sesiones, contraseñas ni secretos: la base lo rechaza
 * aunque el código lo intente. Cada respuesta se arma con una lista explícita de
 * campos; nada se recupera para luego ocultarse en el navegador.
 *
 * Estas son restricciones de la aplicación. Quien administra la infraestructura (el
 * usuario propietario de la base de datos) conserva sus privilegios.
 */
export type PermisoOperador = 'plataforma:ver' | 'empresas:gestionar' | 'planes:gestionar' | 'trabajos:reintentar' | 'incidentes:gestionar' | 'soporte:gestionar' | 'reembolsos:gestionar'
  | 'conversaciones:ver' | 'conversaciones:atender' | 'conversaciones:asignar' | 'atencion:ver_empresas' | 'atencion:leer_autorizadas' | 'atencion:responder_autorizadas' | 'integraciones:verificar';
/**
 * ADMIN administra la relación comercial y el equipo; SOPORTE atiende. Ninguno opera los negocios: no hay
 * permisos para tocar catálogo, precios, ventas ni inventario de una empresa.
 */
export const PERMISOS_OPERADOR: Record<'ADMIN' | 'SOPORTE', PermisoOperador[]> = {
  ADMIN: ['plataforma:ver', 'empresas:gestionar', 'planes:gestionar', 'trabajos:reintentar', 'incidentes:gestionar', 'soporte:gestionar', 'reembolsos:gestionar',
    'conversaciones:ver', 'conversaciones:atender', 'conversaciones:asignar', 'atencion:ver_empresas', 'atencion:leer_autorizadas', 'atencion:responder_autorizadas', 'integraciones:verificar'],
  SOPORTE: ['plataforma:ver', 'incidentes:gestionar', 'soporte:gestionar', 'conversaciones:ver', 'conversaciones:atender', 'atencion:ver_empresas', 'atencion:leer_autorizadas', 'atencion:responder_autorizadas', 'integraciones:verificar'],
};

export interface Operador { user: SessionUser; correlacion: string }

export function exigir(op: Operador, permiso: PermisoOperador) {
  const rol = op.user.rol_plataforma;
  if (!rol || !PERMISOS_OPERADOR[rol].includes(permiso)) throw new AppError('FORBIDDEN', 'Tu rol de operador no permite esta acción.', { permiso });
}

/** Registro de auditoría del operador (append-only; sin datos privados de los negocios). */
export async function auditar(tx: Tx, op: Operador, e: { accion: string; recurso?: string; recursoId?: string | null; tenantId?: string | null; motivo?: string | null; resultado: 'EXITO' | 'DENEGADO' | 'ERROR' | 'SIN_CAMBIOS'; detalle?: Record<string, string | number | boolean | null> }) {
  await tx.query(
    `INSERT INTO auditoria_plataforma (id, actor_id, actor_email, accion, recurso, recurso_id, tenant_id, motivo, resultado, correlacion, detalle)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [uuidv7(), op.user.id, op.user.email, e.accion, e.recurso ?? null, e.recursoId ?? null, e.tenantId ?? null, e.motivo ?? null, e.resultado, op.correlacion, JSON.stringify(e.detalle ?? {})]);
}

// ------------------------------------------------------------------ periodo
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
export function periodoConsulta(q: any) {
  const hoy = new Date();
  const hasta = FECHA.test(String(q?.hasta ?? '')) ? new Date(`${q.hasta}T23:59:59.999Z`) : hoy;
  const desde = FECHA.test(String(q?.desde ?? '')) ? new Date(`${q.desde}T00:00:00Z`) : new Date(hasta.getTime() - 29 * 86_400_000);
  if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || desde > hasta) throw invalid('El periodo no es válido.');
  if (hasta.getTime() - desde.getTime() > 366 * 86_400_000) throw invalid('El periodo máximo es de un año.');
  return { desde, hasta, texto: { desde: desde.toISOString().slice(0, 10), hasta: hasta.toISOString().slice(0, 10) } };
}

const n = (v: unknown) => Number(v ?? 0);

async function metricasHttp(tx: Tx, desde: Date, hasta: Date) {
  const filas = (await tx.query(`SELECT clase, n, suma_ms, hist FROM metrica_http WHERE minuto BETWEEN $1 AND $2`, [desde, hasta])).rows;
  const hist = Array(CUBETAS_MS.length + 1).fill(0);
  let total = 0, e5 = 0, e4 = 0, suma = 0;
  for (const f of filas) {
    total += f.n; suma += Number(f.suma_ms);
    if (f.clase === 5) e5 += f.n;
    if (f.clase === 4) e4 += f.n;
    (f.hist as number[]).forEach((x, i) => { hist[i] += Number(x); });
  }
  return {
    total, errores_5xx: e5, errores_4xx: e4,
    latencia_media_ms: total ? Math.round(suma / total) : null,
    p95_ms: percentil(hist, 0.95),
    disponibilidad: total ? Math.round((1 - e5 / total) * 10000) / 100 : null,
  };
}

async function estadoCola(tx: Tx) {
  const filas = (await tx.query(`SELECT estado, count(*)::int AS n, count(*) FILTER (WHERE intentos > 0)::int AS con_reintentos FROM job GROUP BY estado`)).rows;
  const viejo = (await tx.query(`SELECT extract(epoch FROM now() - min(ejecutar_en))::int AS s FROM job WHERE estado='PENDIENTE' AND ejecutar_en <= now()`)).rows[0]?.s;
  const de = (e: string) => filas.find((f: any) => f.estado === e);
  return {
    pendientes: de('PENDIENTE')?.n ?? 0, en_curso: de('EN_CURSO')?.n ?? 0, fallidos: de('FALLIDO')?.n ?? 0,
    reintentando: de('PENDIENTE')?.con_reintentos ?? 0, espera_mas_antigua_s: viejo ?? 0,
  };
}

// ------------------------------------------------------------------ resumen
export async function resumen(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const p = periodoConsulta(q);
  return db.withOperador(async (tx) => {
    const estados = (await tx.query(`SELECT coalesce(s.estado,'SIN_SUSCRIPCION') AS estado, count(*)::int AS n FROM tenant t LEFT JOIN subscription s ON s.tenant_id=t.id GROUP BY 1`)).rows;
    const por_estado: Record<string, number> = { ACTIVA: 0, PAGO_PENDIENTE: 0, EN_GRACIA: 0, SUSPENDIDA: 0, CANCELADA: 0, SIN_SUSCRIPCION: 0 };
    for (const e of estados) por_estado[e.estado] = e.n;
    const altas = (await tx.query(`SELECT count(*)::int AS n FROM tenant WHERE creado_en BETWEEN $1 AND $2`, [p.desde, p.hasta])).rows[0].n;
    const bajas = (await tx.query(`SELECT count(*)::int AS n FROM subscription WHERE estado='CANCELADA' AND actualizado_en BETWEEN $1 AND $2`, [p.desde, p.hasta])).rows[0].n;
    const serie = (await tx.query(
      `SELECT to_char(creado_en AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS dia, count(*)::int AS altas FROM tenant WHERE creado_en BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [p.desde, p.hasta])).rows;
    const pagos = (await tx.query(`SELECT estado, count(*)::int AS n, coalesce(sum(monto),0)::float AS monto FROM payment WHERE creado_en BETWEEN $1 AND $2 GROUP BY estado`, [p.desde, p.hasta])).rows;
    const pago = (e: string) => ({ n: pagos.find((x: any) => x.estado === e)?.n ?? 0, monto: pagos.find((x: any) => x.estado === e)?.monto ?? 0 });
    const mrr = (await tx.query(`SELECT coalesce(sum(pl.precio_mensual),0)::float AS v FROM subscription s JOIN plan pl ON pl.codigo=s.plan_codigo WHERE s.estado IN ('ACTIVA','PAGO_PENDIENTE','EN_GRACIA')`)).rows[0].v;
    const modulos = (await tx.query(
      `SELECT m.codigo, m.nombre, count(tm.tenant_id) FILTER (WHERE tm.activo)::int AS empresas FROM module m LEFT JOIN tenant_module tm ON tm.modulo=m.codigo GROUP BY m.codigo, m.nombre ORDER BY 3 DESC, 2`)).rows;
    const ia = (await tx.query(
      `SELECT coalesce(sum(llamadas),0)::int AS llamadas, coalesce(sum(errores),0)::int AS errores, coalesce(sum(tokens_entrada),0)::bigint AS entrada, coalesce(sum(tokens_salida),0)::bigint AS salida
       FROM ia_consumo WHERE dia BETWEEN $1::date AND $2::date`, [p.texto.desde, p.texto.hasta])).rows[0];
    const tokensMes = (await tx.query(`SELECT coalesce(sum(cantidad),0)::bigint AS n FROM usage_record WHERE metrica='tokens_ia' AND periodo=$1`, [periodo()])).rows[0].n;
    const precios = config.ia.precioEntradaMTok && config.ia.precioSalidaMTok;
    const incidentes = (await tx.query(`SELECT gravedad, count(*)::int AS n FROM incidente WHERE estado <> 'RESUELTO' GROUP BY gravedad`)).rows;
    const soporte = (await tx.query(`SELECT count(*)::int AS n FROM soporte_ticket WHERE estado IN ('ABIERTO','EN_PROCESO')`)).rows[0].n;
    return {
      periodo: p.texto,
      empresas: { total: Object.values(por_estado).reduce((a, b) => a + b, 0), por_estado, altas_periodo: altas, bajas_periodo: bajas },
      serie_altas: serie.map((r: any) => ({ dia: r.dia, altas: r.altas })),
      ingresos: { moneda: 'COP', aprobados: pago('APROBADO'), pendientes: pago('PENDIENTE'), rechazados: pago('RECHAZADO'), mrr_estimado: mrr },
      modulos: modulos.map((m: any) => ({ codigo: m.codigo, nombre: m.nombre, empresas: m.empresas })),
      ia: {
        llamadas: ia.llamadas, errores: ia.errores, tokens_entrada: n(ia.entrada), tokens_salida: n(ia.salida), tokens_mes_actual: n(tokensMes),
        costo_estimado_usd: precios ? Math.round(((n(ia.entrada) / 1e6) * config.ia.precioEntradaMTok! + (n(ia.salida) / 1e6) * config.ia.precioSalidaMTok!) * 100) / 100 : null,
        precios_configurados: !!precios,
      },
      solicitudes: await metricasHttp(tx, p.desde, p.hasta),
      cola: await estadoCola(tx),
      incidentes_abiertos: Object.fromEntries(['CRITICA', 'ALTA', 'MEDIA', 'BAJA'].map((g) => [g, incidentes.find((i: any) => i.gravedad === g)?.n ?? 0])),
      soporte_abiertos: soporte,
    };
  });
}

// ------------------------------------------------------------------ empresas
const CAMPOS_EMPRESA = `t.id, t.slug, t.nombre, t.sector, t.email_contacto, t.plan_codigo, (SELECT pl.nombre FROM plan pl WHERE pl.codigo=t.plan_codigo) AS plan_nombre, t.creado_en, t.whatsapp_estado, s.estado, s.periodo_fin,
  (SELECT count(*)::int FROM tenant_module tm WHERE tm.tenant_id=t.id AND tm.activo) AS modulos_activos,
  (SELECT count(*)::int FROM user_tenant ut WHERE ut.tenant_id=t.id AND ut.activo) AS usuarios_activos`;

const filaEmpresa = (r: any) => ({
  id: r.id, slug: r.slug, nombre: r.nombre, sector: r.sector, contacto_email: r.email_contacto, plan: r.plan_codigo, plan_nombre: r.plan_nombre,
  estado: r.estado ?? 'SIN_SUSCRIPCION', periodo_fin: r.periodo_fin, creado_en: r.creado_en, whatsapp_estado: r.whatsapp_estado,
  modulos_activos: r.modulos_activos, usuarios_activos: r.usuarios_activos,
});

export async function listarEmpresas(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const texto = String(q?.q ?? '').trim().slice(0, 80);
  const estado = String(q?.estado ?? '');
  const pagina = Math.max(1, Number(q?.pagina) || 1);
  const porPagina = Math.min(200, Math.max(1, Number(q?.por_pagina) || 25));
  return db.withOperador(async (tx) => {
    const filtro = `WHERE ($1 = '' OR t.nombre ILIKE '%' || $1 || '%' OR t.slug ILIKE '%' || $1 || '%' OR t.id::text = $1)
                      AND ($2 = '' OR coalesce(s.estado,'SIN_SUSCRIPCION') = $2)`;
    const total = (await tx.query(`SELECT count(*)::int AS n FROM tenant t LEFT JOIN subscription s ON s.tenant_id=t.id ${filtro}`, [texto, estado])).rows[0].n;
    const filas = (await tx.query(
      `SELECT ${CAMPOS_EMPRESA} FROM tenant t LEFT JOIN subscription s ON s.tenant_id=t.id ${filtro} ORDER BY t.creado_en DESC LIMIT $3 OFFSET $4`,
      [texto, estado, porPagina, (pagina - 1) * porPagina])).rows;
    return { empresas: filas.map(filaEmpresa), total, pagina, por_pagina: porPagina };
  });
}

const csv = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Exportación con exactamente los mismos campos permitidos que el listado. */
export async function exportarEmpresas(db: Database, op: Operador) {
  exigir(op, 'plataforma:ver');
  const filas = await db.withOperador(async (tx) => (await tx.query(`SELECT ${CAMPOS_EMPRESA} FROM tenant t LEFT JOIN subscription s ON s.tenant_id=t.id ORDER BY t.creado_en`)).rows.map(filaEmpresa));
  const columnas = ['id', 'slug', 'nombre', 'sector', 'contacto_email', 'plan', 'plan_nombre', 'estado', 'periodo_fin', 'creado_en', 'whatsapp_estado', 'modulos_activos', 'usuarios_activos'] as const;
  await db.withOperador((tx) => auditar(tx, op, { accion: 'empresas.exportar', recurso: 'tenant', resultado: 'EXITO', detalle: { filas: filas.length } }));
  return '﻿' + [columnas.join(','), ...filas.map((f) => columnas.map((c) => csv((f as any)[c])).join(','))].join('\n');
}

export async function verEmpresa(db: Database, op: Operador, id: string) {
  exigir(op, 'plataforma:ver');
  if (!isUuid(id)) throw notFound();
  return db.withOperador(async (tx) => {
    const r = (await tx.query(`SELECT ${CAMPOS_EMPRESA}, s.periodo_inicio, s.gracia_hasta FROM tenant t LEFT JOIN subscription s ON s.tenant_id=t.id WHERE t.id=$1`, [id])).rows[0];
    if (!r) throw notFound();
    const plan = (await tx.query(`SELECT codigo, nombre, precio_mensual::float AS precio, cuota_tokens_ia, cuota_mensajes, cuota_documentos, max_usuarios, modulos FROM plan WHERE codigo=$1`, [r.plan_codigo])).rows[0];
    const uso = (await tx.query(`SELECT metrica, cantidad FROM usage_record WHERE tenant_id=$1 AND periodo=$2`, [id, periodo()])).rows;
    const usoDe = (m: string) => n(uso.find((u: any) => u.metrica === m)?.cantidad);
    const modulos = (await tx.query(
      `SELECT m.codigo, m.nombre, coalesce(tm.activo, false) AS activo FROM module m LEFT JOIN tenant_module tm ON tm.modulo=m.codigo AND tm.tenant_id=$1 ORDER BY m.nombre`, [id])).rows;
    const pagos = (await tx.query(`SELECT referencia, concepto, monto::float AS monto, moneda, estado, creado_en FROM payment WHERE tenant_id=$1 ORDER BY creado_en DESC LIMIT 12`, [id])).rows;
    const correos = (await tx.query(`SELECT estado, count(*)::int AS n FROM email_outbox WHERE tenant_id=$1 AND creado_en > now() - interval '30 days' GROUP BY estado`, [id])).rows;
    const incidentes = (await tx.query(`SELECT count(*)::int AS n FROM incidente WHERE tenant_id=$1 AND estado <> 'RESUELTO'`, [id])).rows[0].n;
    const tickets = (await tx.query(`SELECT count(*)::int AS n FROM soporte_ticket WHERE tenant_id=$1 AND estado NOT IN ('RESUELTO','CERRADO')`, [id])).rows[0].n;
    return {
      empresa: { ...filaEmpresa(r), periodo_inicio: r.periodo_inicio, gracia_hasta: r.gracia_hasta },
      limites: plan ? {
        plan: { codigo: plan.codigo, nombre: plan.nombre, precio_mensual: plan.precio },
        uso_mes: { tokens_ia: usoDe('tokens_ia'), mensajes: usoDe('mensajes'), documentos: usoDe('documentos') },
        cuotas: { tokens_ia: n(plan.cuota_tokens_ia), mensajes: n(plan.cuota_mensajes), documentos: n(plan.cuota_documentos), usuarios: plan.max_usuarios },
        usuarios_activos: r.usuarios_activos,
      } : null,
      modulos: modulos.map((m: any) => ({ codigo: m.codigo, nombre: m.nombre, activo: m.activo, incluido_en_plan: !!plan?.modulos?.includes(m.codigo) })),
      pagos: pagos.map((p: any) => ({ referencia: p.referencia, concepto: p.concepto, monto: p.monto, moneda: p.moneda, estado: p.estado, fecha: p.creado_en })),
      tecnico: {
        whatsapp_estado: r.whatsapp_estado,
        correos_30_dias: Object.fromEntries(correos.map((c: any) => [c.estado, c.n])),
        incidentes_abiertos: incidentes, tickets_abiertos: tickets,
      },
    };
  });
}

const Motivo = z.string().trim().min(10, 'Explica el motivo (al menos 10 caracteres).').max(300, 'El motivo es demasiado largo.');

/** Datos de contacto para avisar a la empresa (fuera de la transacción del operador). */
async function avisarEmpresa(db: Database, op: Operador, tenantId: string, tipo: Parameters<typeof plantillas.avisoAdministrativo>[0]['tipo'], motivo: string, accion: string, detalles?: [string, string][]) {
  await db.withPlatform(async (tx) => {
    const t = (await tx.query(`SELECT nombre, email_contacto FROM tenant WHERE id=$1`, [tenantId])).rows[0];
    // Transparencia: la empresa ve en su propia auditoría lo que hizo la plataforma.
    await auditPlatform(tx, tenantId, { tipo: 'PLATAFORMA', id: op.user.id, nombre: 'Equipo de la plataforma' }, 'PLATAFORMA', op.correlacion, { accion, resultado: 'EXITO', detalle: { motivo } });
    if (t?.email_contacto) await encolarCorreo(tx, { tenantId: null, para: t.email_contacto, correo: plantillas.avisoAdministrativo({ empresa: t.nombre, tipo, motivo, detalles, url: config.publicUrl }) });
  });
}

/** Suspender, reactivar o cancelar. Reversible: no borra datos. Exige escribir el subdominio para confirmar. */
export async function cambiarEstado(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'empresas:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ estado: z.enum(['ACTIVA', 'SUSPENDIDA', 'CANCELADA'], 'Estado no válido.'), motivo: Motivo, confirmacion: z.string().trim() }).parse(body);
  const r = await db.withOperador(async (tx) => {
    const t = (await tx.query(`SELECT t.id, t.slug, s.estado FROM tenant t JOIN subscription s ON s.tenant_id=t.id WHERE t.id=$1 FOR UPDATE OF s`, [id])).rows[0];
    if (!t) throw notFound();
    if (d.confirmacion !== t.slug) {
      await auditar(tx, op, { accion: 'empresa.estado', recurso: 'tenant', recursoId: id, tenantId: id, motivo: d.motivo, resultado: 'DENEGADO', detalle: { razon: 'confirmacion_incorrecta' } });
      return { error: 'Para confirmar, escribe exactamente el subdominio de la empresa.' };
    }
    if (t.estado === d.estado) {
      await auditar(tx, op, { accion: 'empresa.estado', recurso: 'tenant', recursoId: id, tenantId: id, motivo: d.motivo, resultado: 'SIN_CAMBIOS', detalle: { estado: d.estado } });
      return { sin_cambios: true, anterior: t.estado };
    }
    await tx.query(
      `UPDATE subscription SET estado=$2, gracia_hasta=NULL, actualizado_en=now(),
         periodo_fin = CASE WHEN $2='ACTIVA' AND periodo_fin < now() THEN now() + interval '1 month' ELSE periodo_fin END
       WHERE tenant_id=$1`, [id, d.estado]);
    await auditar(tx, op, { accion: 'empresa.estado', recurso: 'tenant', recursoId: id, tenantId: id, motivo: d.motivo, resultado: 'EXITO', detalle: { anterior: t.estado, nuevo: d.estado } });
    return { anterior: t.estado };
  });
  // Un 409 tras confirmar el registro de auditoría (la denegación queda escrita).
  if ('error' in r && r.error) throw new AppError('CONFLICT', r.error);
  if ('sin_cambios' in r && r.sin_cambios) return { ok: true, estado: d.estado, sin_cambios: true };
  await avisarEmpresa(db, op, id, d.estado, d.motivo, `plataforma.estado_${d.estado.toLowerCase()}`);
  return { ok: true, estado: d.estado, anterior: r.anterior };
}

export async function cambiarPlan(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'empresas:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ plan: z.string().trim().min(1), motivo: Motivo, confirmacion: z.string().trim() }).parse(body);
  const r = await db.withOperador(async (tx) => {
    const t = (await tx.query(`SELECT id, slug, plan_codigo FROM tenant WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!t) throw notFound();
    const plan = (await tx.query(`SELECT codigo, nombre FROM plan WHERE codigo=$1`, [d.plan])).rows[0];
    if (!plan) throw invalid('Ese plan no existe.');
    if (d.confirmacion !== t.slug) {
      await auditar(tx, op, { accion: 'empresa.plan', recurso: 'tenant', recursoId: id, tenantId: id, motivo: d.motivo, resultado: 'DENEGADO', detalle: { razon: 'confirmacion_incorrecta' } });
      return { error: 'Para confirmar, escribe exactamente el subdominio de la empresa.' };
    }
    if (t.plan_codigo === plan.codigo) {
      await auditar(tx, op, { accion: 'empresa.plan', recurso: 'tenant', recursoId: id, tenantId: id, motivo: d.motivo, resultado: 'SIN_CAMBIOS', detalle: { plan: plan.codigo } });
      return { sin_cambios: true };
    }
    await tx.query(`UPDATE tenant SET plan_codigo=$2 WHERE id=$1`, [id, plan.codigo]);
    await tx.query(`UPDATE subscription SET plan_codigo=$2, actualizado_en=now() WHERE tenant_id=$1`, [id, plan.codigo]);
    await auditar(tx, op, { accion: 'empresa.plan', recurso: 'tenant', recursoId: id, tenantId: id, motivo: d.motivo, resultado: 'EXITO', detalle: { anterior: t.plan_codigo, nuevo: plan.codigo } });
    return { anterior: t.plan_codigo, nombre: plan.nombre };
  });
  if ('error' in r && r.error) throw new AppError('CONFLICT', r.error);
  if ('sin_cambios' in r && r.sin_cambios) return { ok: true, sin_cambios: true };
  await avisarEmpresa(db, op, id, 'PLAN', d.motivo, 'plataforma.plan_cambiado', [['Plan nuevo', (r as any).nombre]]);
  return { ok: true, plan: d.plan };
}

export async function cambiarModulo(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'empresas:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ modulo: z.string().trim().min(1), activo: z.boolean(), motivo: Motivo }).parse(body);
  const r = await db.withOperador(async (tx) => {
    const t = (await tx.query(`SELECT id FROM tenant WHERE id=$1`, [id])).rows[0];
    if (!t) throw notFound();
    const m = (await tx.query(`SELECT codigo, nombre FROM module WHERE codigo=$1`, [d.modulo])).rows[0];
    if (!m) throw invalid('Ese módulo no existe.');
    const actual = (await tx.query(`SELECT activo FROM tenant_module WHERE tenant_id=$1 AND modulo=$2 FOR UPDATE`, [id, d.modulo])).rows[0];
    if ((actual?.activo ?? false) === d.activo) {
      await auditar(tx, op, { accion: 'empresa.modulo', recurso: 'tenant_module', recursoId: d.modulo, tenantId: id, motivo: d.motivo, resultado: 'SIN_CAMBIOS', detalle: { activo: d.activo } });
      return { sin_cambios: true, nombre: m.nombre };
    }
    await tx.query(`INSERT INTO tenant_module (tenant_id, modulo, activo) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, modulo) DO UPDATE SET activo=EXCLUDED.activo`, [id, d.modulo, d.activo]);
    await auditar(tx, op, { accion: 'empresa.modulo', recurso: 'tenant_module', recursoId: d.modulo, tenantId: id, motivo: d.motivo, resultado: 'EXITO', detalle: { activo: d.activo } });
    return { nombre: m.nombre };
  });
  if (!('sin_cambios' in r)) await avisarEmpresa(db, op, id, 'MODULO', d.motivo, 'plataforma.modulo_cambiado', [[r.nombre, d.activo ? 'Activado' : 'Desactivado']]);
  return { ok: true, sin_cambios: 'sin_cambios' in r };
}

// ------------------------------------------------------------------ suscripciones y planes
export async function suscripciones(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const p = periodoConsulta(q);
  return db.withOperador(async (tx) => {
    const planes = (await tx.query(
      `SELECT pl.codigo, pl.nombre, pl.precio_mensual::float AS precio, pl.cuota_tokens_ia, pl.cuota_mensajes, pl.cuota_documentos, pl.max_usuarios,
              count(s.tenant_id) FILTER (WHERE s.estado IN ('ACTIVA','PAGO_PENDIENTE','EN_GRACIA'))::int AS vigentes,
              count(s.tenant_id)::int AS total
       FROM plan pl LEFT JOIN subscription s ON s.plan_codigo=pl.codigo GROUP BY pl.codigo ORDER BY pl.orden`)).rows;
    const proximas = (await tx.query(
      `SELECT t.id, t.nombre, s.plan_codigo, s.estado, s.periodo_fin, s.gracia_hasta FROM subscription s JOIN tenant t ON t.id=s.tenant_id
       WHERE (s.estado='ACTIVA' AND s.periodo_fin < now() + interval '14 days') OR s.estado IN ('PAGO_PENDIENTE','EN_GRACIA')
       ORDER BY s.periodo_fin LIMIT 50`)).rows;
    const mensual = (await tx.query(
      `SELECT mes, sum(altas)::int AS altas, sum(bajas)::int AS bajas FROM (
         SELECT to_char(creado_en AT TIME ZONE 'America/Bogota','YYYY-MM') AS mes, 1 AS altas, 0 AS bajas FROM tenant WHERE creado_en BETWEEN $1 AND $2
         UNION ALL
         SELECT to_char(actualizado_en AT TIME ZONE 'America/Bogota','YYYY-MM'), 0, 1 FROM subscription WHERE estado='CANCELADA' AND actualizado_en BETWEEN $1 AND $2
       ) x GROUP BY mes ORDER BY mes`, [p.desde, p.hasta])).rows;
    const pagos = (await tx.query(
      `SELECT p.referencia, p.concepto, p.monto::float AS monto, p.moneda, p.estado, p.proveedor, p.creado_en, t.nombre AS empresa, p.tenant_id
       FROM payment p LEFT JOIN tenant t ON t.id=p.tenant_id WHERE p.creado_en BETWEEN $1 AND $2 ORDER BY p.creado_en DESC LIMIT 100`, [p.desde, p.hasta])).rows;
    return {
      periodo: p.texto,
      planes: planes.map((x: any) => ({ codigo: x.codigo, nombre: x.nombre, precio_mensual: x.precio, cuotas: { tokens_ia: n(x.cuota_tokens_ia), mensajes: n(x.cuota_mensajes), documentos: n(x.cuota_documentos), usuarios: x.max_usuarios }, empresas_vigentes: x.vigentes, empresas_total: x.total })),
      por_renovar: proximas.map((x: any) => ({ empresa_id: x.id, empresa: x.nombre, plan: x.plan_codigo, estado: x.estado, periodo_fin: x.periodo_fin, gracia_hasta: x.gracia_hasta })),
      evolucion: mensual.map((x: any) => ({ mes: x.mes, altas: x.altas, bajas: x.bajas })),
      pagos: pagos.map((x: any) => ({ referencia: x.referencia, concepto: x.concepto, monto: x.monto, moneda: x.moneda, estado: x.estado, proveedor: x.proveedor, fecha: x.creado_en, empresa: x.empresa, empresa_id: x.tenant_id })),
    };
  });
}

export async function editarPlan(db: Database, op: Operador, codigo: string, body: any) {
  exigir(op, 'planes:gestionar');
  const entero = (min: number) => z.number().int().min(min).max(1e12);
  const d = z.object({ cuota_tokens_ia: entero(0), cuota_mensajes: entero(0), cuota_documentos: entero(0), max_usuarios: entero(1).max(10_000), motivo: Motivo }).parse(body);
  return db.withOperador(async (tx) => {
    const antes = (await tx.query(`SELECT cuota_tokens_ia, cuota_mensajes, cuota_documentos, max_usuarios FROM plan WHERE codigo=$1 FOR UPDATE`, [codigo])).rows[0];
    if (!antes) throw notFound();
    await tx.query(`UPDATE plan SET cuota_tokens_ia=$2, cuota_mensajes=$3, cuota_documentos=$4, max_usuarios=$5 WHERE codigo=$1`, [codigo, d.cuota_tokens_ia, d.cuota_mensajes, d.cuota_documentos, d.max_usuarios]);
    await auditar(tx, op, { accion: 'plan.limites', recurso: 'plan', recursoId: codigo, motivo: d.motivo, resultado: 'EXITO', detalle: {
      tokens_antes: n(antes.cuota_tokens_ia), tokens_nuevo: d.cuota_tokens_ia, mensajes_antes: n(antes.cuota_mensajes), mensajes_nuevo: d.cuota_mensajes,
      documentos_antes: n(antes.cuota_documentos), documentos_nuevo: d.cuota_documentos, usuarios_antes: antes.max_usuarios, usuarios_nuevo: d.max_usuarios } });
    return { ok: true };
  });
}

// ------------------------------------------------------------------ salud del sistema
/** Trabajos que se pueden reintentar sin duplicar efectos, con la razón. */
export const REINTENTABLES: Record<string, string> = {
  enviar_correo: 'Se reenvía con la misma clave de idempotencia: un correo ya aceptado por el proveedor no se envía otra vez.',
  verificar_whatsapp: 'Solo consulta el estado del número en Meta.',
  reintentar_aprovisionamiento: 'El alta es idempotente: no crea un segundo espacio ni cobra de nuevo.',
  aplicar_estado_entrega: 'Los estados de entrega solo avanzan: aplicarlo dos veces no cambia nada.',
  aplicar_estado_plataforma: 'Los estados de entrega solo avanzan: aplicarlo dos veces no cambia nada.',
  mantenimiento: 'Limpieza idempotente.',
  cerrar_inactivas: 'Solo cierra conversaciones que ya cumplen la condición.',
  ciclo_suscripcion: 'Solo aplica transiciones vencidas; cada aviso tiene clave única por día.',
};
export const NO_REINTENTABLES: Record<string, string> = {
  enviar_mensaje: 'WhatsApp no ofrece idempotencia: reintentar podría duplicar el mensaje al cliente.',
  emitir_documento: 'Podría emitir una factura duplicada ante la autoridad tributaria.',
  entregar_documento: 'Podría reenviar la factura al cliente.',
  procesar_mensaje: 'Podría responder dos veces al cliente.',
  enviar_plataforma: 'WhatsApp no ofrece idempotencia: reintentar podría duplicar el mensaje.',
  procesar_plataforma: 'Podría responder dos veces a quien escribió al número de Omnegia.',
  recordatorio: 'Podría enviar dos recordatorios de la misma cita.',
  resumir_caso: 'Consume IA y no es necesario para la operación.',
  revisar_sla: 'Se vuelve a programar solo cuando corresponde.',
};

export async function salud(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const p = periodoConsulta({ desde: q?.desde, hasta: q?.hasta, ...(q?.desde ? {} : { desde: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) }) });
  const base = await db.ping();
  const migraciones = base ? await db.migrations().catch(() => []) : [];
  return db.withOperador(async (tx) => {
    const rutas = (await tx.query(
      `SELECT metodo, ruta, sum(n)::int AS n, sum(n) FILTER (WHERE clase=5)::int AS e5, sum(n) FILTER (WHERE clase=4)::int AS e4, sum(suma_ms)::float AS suma, max(max_ms)::int AS max,
              array_agg(hist) AS hists
       FROM metrica_http WHERE minuto BETWEEN $1 AND $2 GROUP BY metodo, ruta ORDER BY 3 DESC LIMIT 40`, [p.desde, p.hasta])).rows;
    const serie = (await tx.query(
      `SELECT to_char(date_trunc('hour', minuto) AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD HH24:00') AS hora, sum(n)::int AS n, coalesce(sum(n) FILTER (WHERE clase=5),0)::int AS e5,
              round(sum(suma_ms)::numeric / nullif(sum(n),0))::int AS media
       FROM metrica_http WHERE minuto BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [p.desde, p.hasta])).rows;
    const porTipo = (await tx.query(
      `SELECT tipo, count(*) FILTER (WHERE estado='PENDIENTE')::int AS pendientes, count(*) FILTER (WHERE estado='EN_CURSO')::int AS en_curso,
              count(*) FILTER (WHERE estado='FALLIDO')::int AS fallidos, count(*) FILTER (WHERE estado='PENDIENTE' AND intentos>0)::int AS reintentando
       FROM job GROUP BY tipo ORDER BY 4 DESC, 2 DESC`)).rows;
    const fallidos = (await tx.query(`SELECT id, tipo, tenant_id, intentos, max_intentos, ejecutar_en FROM job WHERE estado='FALLIDO' ORDER BY ejecutar_en DESC LIMIT 50`)).rows;
    const sumarHist = (hs: number[][]) => hs.reduce((acc, h) => acc.map((x, i) => x + Number(h[i] ?? 0)), Array(CUBETAS_MS.length + 1).fill(0));
    return {
      periodo: p.texto,
      proceso: { version: config.version, inicio: inicioProceso.toISOString(), activo_s: Math.round((Date.now() - inicioProceso.getTime()) / 1000), node: process.version, entorno: config.dev ? 'desarrollo' : 'producción' },
      base: { disponible: base, migraciones },
      solicitudes: await metricasHttp(tx, p.desde, p.hasta),
      rutas: rutas.map((r: any) => ({ metodo: r.metodo, ruta: r.ruta, n: r.n, errores_5xx: r.e5 ?? 0, errores_4xx: r.e4 ?? 0, media_ms: r.n ? Math.round(r.suma / r.n) : null, p95_ms: percentil(sumarHist(r.hists), 0.95), max_ms: r.max })),
      serie: serie.map((s: any) => ({ hora: s.hora, n: s.n, errores_5xx: s.e5, media_ms: s.media })),
      cola: { ...(await estadoCola(tx)), por_tipo: porTipo },
      trabajos_fallidos: fallidos.map((j: any) => ({ id: j.id, tipo: j.tipo, empresa_id: j.tenant_id, intentos: j.intentos, fecha: j.ejecutar_en, reintentable: j.tipo in REINTENTABLES, razon: REINTENTABLES[j.tipo] ?? NO_REINTENTABLES[j.tipo] ?? 'Tipo sin reintento manual.' })),
    };
  });
}

/**
 * Reintento manual. Solo tipos idempotentes; la actualización es condicional
 * (estado FALLIDO → PENDIENTE), así que pulsar dos veces no encola dos ejecuciones.
 */
export async function reintentarTrabajo(db: Database, op: Operador, id: string, motivo?: string) {
  exigir(op, 'trabajos:reintentar');
  if (!isUuid(id)) throw notFound();
  return db.withOperador(async (tx) => {
    const j = (await tx.query(`SELECT id, tipo, estado, tenant_id FROM job WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!j) throw notFound();
    if (!(j.tipo in REINTENTABLES)) {
      await auditar(tx, op, { accion: 'trabajo.reintentar', recurso: 'job', recursoId: id, tenantId: j.tenant_id, motivo, resultado: 'DENEGADO', detalle: { tipo: j.tipo } });
      return { ok: false, reintentado: false, razon: NO_REINTENTABLES[j.tipo] ?? 'Este tipo de trabajo no admite reintento manual.' };
    }
    if (j.tipo === 'enviar_correo') return reintentarCorreo(tx, op, j, motivo);
    if (j.estado !== 'FALLIDO') {
      await auditar(tx, op, { accion: 'trabajo.reintentar', recurso: 'job', recursoId: id, tenantId: j.tenant_id, motivo, resultado: 'SIN_CAMBIOS', detalle: { tipo: j.tipo, estado: j.estado } });
      return { ok: true, reintentado: false, razon: j.estado === 'PENDIENTE' || j.estado === 'EN_CURSO' ? 'Ya está en la cola.' : 'El trabajo ya terminó.' };
    }
    // Un solo intento más: si vuelve a fallar, queda FALLIDO y el incidente suma una ocurrencia.
    await tx.query(`UPDATE job SET estado='PENDIENTE', intentos=greatest(max_intentos-1, 0), ejecutar_en=now() WHERE id=$1 AND estado='FALLIDO'`, [id]);
    await auditar(tx, op, { accion: 'trabajo.reintentar', recurso: 'job', recursoId: id, tenantId: j.tenant_id, motivo, resultado: 'EXITO', detalle: { tipo: j.tipo } });
    return { ok: true, reintentado: true };
  });
}

async function reintentarCorreo(tx: Tx, op: Operador, j: any, motivo?: string) {
  // El operador no lee el payload del trabajo: el correo se identifica por la clave única «mail:<id>».
  const clave = (await tx.query(`SELECT clave_unica FROM job WHERE id=$1`, [j.id])).rows[0]?.clave_unica ?? '';
  const correoId = String(clave).startsWith('mail:') ? String(clave).slice(5) : '';
  const e = isUuid(correoId) ? (await tx.query(`SELECT id, estado, error, sensible, caduca_en FROM email_outbox WHERE id=$1 FOR UPDATE`, [correoId])).rows[0] : null;
  const negar = async (razon: string, resultado: 'DENEGADO' | 'SIN_CAMBIOS' = 'DENEGADO') => {
    await auditar(tx, op, { accion: 'trabajo.reintentar', recurso: 'job', recursoId: j.id, tenantId: j.tenant_id, motivo, resultado, detalle: { tipo: j.tipo, estado_correo: e?.estado ?? null } });
    return { ok: resultado === 'SIN_CAMBIOS', reintentado: false, razon };
  };
  if (!e) return negar('No se encontró el correo asociado.');
  if (e.estado === 'PENDIENTE') return negar('El correo ya está en la cola.', 'SIN_CAMBIOS');
  if (e.estado !== 'FALLIDO') return negar('El proveedor ya aceptó este correo: reenviarlo lo duplicaría.', 'SIN_CAMBIOS');
  if (e.sensible) return negar('Contenía un código o enlace de acceso y se borró por seguridad. La persona debe pedir uno nuevo.');
  if (['DESTINATARIO_INVALIDO', 'CADUCADO'].includes(e.error) || (e.caduca_en && new Date(e.caduca_en) < new Date())) return negar('El destinatario no es válido o el correo ya caducó.');
  const r = await tx.query(`UPDATE email_outbox SET estado='PENDIENTE', error=NULL WHERE id=$1 AND estado='FALLIDO' RETURNING id`, [e.id]);
  if (!r.rows[0]) return negar('El correo ya está en la cola.', 'SIN_CAMBIOS');
  await tx.query(`UPDATE job SET estado='PENDIENTE', intentos=greatest(max_intentos-1, 0), ejecutar_en=now() WHERE id=$1`, [j.id]);
  await auditar(tx, op, { accion: 'trabajo.reintentar', recurso: 'job', recursoId: j.id, tenantId: j.tenant_id, motivo, resultado: 'EXITO', detalle: { tipo: j.tipo } });
  return { ok: true, reintentado: true };
}

// ------------------------------------------------------------------ incidentes
const IncidenteFiltro = (q: any) => ({ estado: String(q?.estado ?? ''), gravedad: String(q?.gravedad ?? ''), servicio: String(q?.servicio ?? '').slice(0, 60) });

const filaIncidente = (i: any) => ({
  id: i.id, codigo: i.codigo, servicio: i.servicio, gravedad: i.gravedad, estado: i.estado,
  descripcion: CATALOGO_INCIDENTES[i.codigo]?.descripcion ?? 'Incidente técnico.',
  accion_sugerida: CATALOGO_INCIDENTES[i.codigo]?.accion ?? null,
  empresa_id: i.tenant_id, trabajo_id: i.trabajo_id, correlacion: i.correlacion, version: i.version, detalle: i.detalle,
  ocurrencias: i.ocurrencias, primera_vez: i.primera_vez, ultima_vez: i.ultima_vez, resuelto_en: i.resuelto_en, nota: i.nota,
  reintentable: !!i.trabajo_id && (i.tipo_trabajo ?? '') in REINTENTABLES && i.estado !== 'RESUELTO',
});

export async function listarIncidentes(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const f = IncidenteFiltro(q);
  const pagina = Math.max(1, Number(q?.pagina) || 1);
  return db.withOperador(async (tx) => {
    const filtro = `WHERE ($1='' OR i.estado=$1) AND ($2='' OR i.gravedad=$2) AND ($3='' OR i.servicio=$3)`;
    const total = (await tx.query(`SELECT count(*)::int AS n FROM incidente i ${filtro}`, [f.estado, f.gravedad, f.servicio])).rows[0].n;
    const filas = (await tx.query(
      `SELECT i.*, j.tipo AS tipo_trabajo FROM incidente i LEFT JOIN job j ON j.id=i.trabajo_id ${filtro}
       ORDER BY (i.estado='RESUELTO'), CASE i.gravedad WHEN 'CRITICA' THEN 0 WHEN 'ALTA' THEN 1 WHEN 'MEDIA' THEN 2 ELSE 3 END, i.ultima_vez DESC LIMIT 50 OFFSET $4`,
      [f.estado, f.gravedad, f.servicio, (pagina - 1) * 50])).rows;
    const servicios = (await tx.query(`SELECT DISTINCT servicio FROM incidente ORDER BY 1`)).rows.map((r: any) => r.servicio);
    return { incidentes: filas.map(filaIncidente), total, pagina, servicios };
  });
}

export async function actualizarIncidente(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'incidentes:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ estado: z.enum(['RECONOCIDO', 'RESUELTO'], 'Estado no válido.'), nota: z.string().trim().max(300).optional() }).parse(body);
  if (d.nota) revisarContenido(d.nota);
  return db.withOperador(async (tx) => {
    const i = (await tx.query(`SELECT id, estado, tenant_id FROM incidente WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!i) throw notFound();
    if (i.estado === 'RESUELTO') throw new AppError('CONFLICT', 'El incidente ya está resuelto.');
    await tx.query(`UPDATE incidente SET estado=$2, nota=coalesce($3, nota), resuelto_en=CASE WHEN $2='RESUELTO' THEN now() ELSE resuelto_en END WHERE id=$1`, [id, d.estado, d.nota ?? null]);
    await auditar(tx, op, { accion: 'incidente.estado', recurso: 'incidente', recursoId: id, tenantId: i.tenant_id, motivo: d.nota ?? null, resultado: 'EXITO', detalle: { anterior: i.estado, nuevo: d.estado } });
    return { ok: true };
  });
}

export async function reintentarIncidente(db: Database, op: Operador, id: string, motivo?: string) {
  exigir(op, 'trabajos:reintentar');
  if (!isUuid(id)) throw notFound();
  const trabajo = await db.withOperador(async (tx) => (await tx.query(`SELECT trabajo_id FROM incidente WHERE id=$1`, [id])).rows[0]);
  if (!trabajo) throw notFound();
  if (!trabajo.trabajo_id) throw new AppError('CONFLICT', 'Este incidente no tiene un trabajo asociado que se pueda reintentar.');
  return reintentarTrabajo(db, op, trabajo.trabajo_id, motivo);
}

// ------------------------------------------------------------------ integraciones
export async function estadoIntegraciones(db: Database, op: Operador) {
  exigir(op, 'plataforma:ver');
  return db.withOperador(async (tx) => {
    const wa = (await tx.query(`SELECT whatsapp_estado AS estado, count(*)::int AS n FROM tenant GROUP BY 1 ORDER BY 2 DESC`)).rows;
    const problemas = (await tx.query(
      `SELECT id, nombre, whatsapp_estado, whatsapp_verificado_en FROM tenant WHERE whatsapp_estado IN ('ERROR','PENDIENTE_VERIFICAR') ORDER BY nombre LIMIT 100`)).rows;
    const correo = (await tx.query(`SELECT estado, count(*)::int AS n FROM email_outbox WHERE creado_en > now() - interval '7 days' GROUP BY estado`)).rows;
    const fallos = (await tx.query(`SELECT error, count(*)::int AS n FROM email_outbox WHERE estado IN ('FALLIDO','REBOTADO') AND creado_en > now() - interval '7 days' GROUP BY error ORDER BY 2 DESC`)).rows;
    const ia = (await tx.query(`SELECT modelo, sum(llamadas)::int AS llamadas, sum(errores)::int AS errores FROM ia_consumo WHERE dia > current_date - 7 GROUP BY modelo`)).rows;
    return {
      plataforma: integraciones().map(({ clave, nombre, estado, detalle, variables }) => ({ clave, nombre, estado, detalle, variables })),
      whatsapp: { por_estado: wa, con_problemas: problemas.map((t: any) => ({ empresa_id: t.id, empresa: t.nombre, estado: t.whatsapp_estado, verificado_en: t.whatsapp_verificado_en })) },
      correo: { por_estado_7_dias: Object.fromEntries(correo.map((c: any) => [c.estado, c.n])), fallos_7_dias: fallos.map((f: any) => ({ codigo: f.error ?? 'SIN_CODIGO', descripcion: mensajeFallo(f.error), n: f.n })) },
      ia: { modelos_7_dias: ia },
    };
  });
}

// ------------------------------------------------------------------ soporte (lado del operador)
export async function listarTickets(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const estado = String(q?.estado ?? '');
  const canal = ['PANEL', 'WHATSAPP'].includes(String(q?.canal)) ? String(q.canal) : '';
  return db.withOperador(async (tx) => ({
    // Las solicitudes de WhatsApp no tienen empresa verificada: se muestra la relacionada por el teléfono, si hay una.
    tickets: (await tx.query(
      `SELECT k.id, k.numero, coalesce(k.tenant_id, k.tenant_relacionado) AS empresa_id, t.nombre AS empresa, k.canal, k.conversacion_id, (k.tenant_id IS NULL) AS sin_verificar,
              k.categoria, k.prioridad, k.estado, k.asunto, k.solicitante_nombre, k.creado_en, k.actualizado_en
       FROM soporte_ticket k LEFT JOIN tenant t ON t.id=coalesce(k.tenant_id, k.tenant_relacionado) WHERE ($1='' OR k.estado=$1) AND ($2='' OR k.canal=$2)
       ORDER BY (k.estado IN ('RESUELTO','CERRADO')), CASE k.prioridad WHEN 'URGENTE' THEN 0 WHEN 'ALTA' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, k.actualizado_en DESC LIMIT 200`, [estado, canal])).rows
      .map((k: any) => ({ id: k.id, numero: k.numero, empresa_id: k.empresa_id, empresa: k.empresa, empresa_sin_verificar: k.sin_verificar && !!k.empresa, canal: k.canal, conversacion_id: k.conversacion_id,
        categoria: k.categoria, categoria_nombre: ETIQUETA_CATEGORIA[k.categoria], prioridad: k.prioridad, estado: k.estado, asunto: k.asunto, solicitante: k.solicitante_nombre, creado_en: k.creado_en, actualizado_en: k.actualizado_en })),
    // Asistente de soporte de las empresas (30 días): solo cifras; el operador no ve lo que escribieron.
    asistente: (await tx.query(
      `SELECT count(*) FILTER (WHERE resultado='RESUELTO')::int AS resueltas, count(*) FILTER (WHERE resultado='ESCALADO')::int AS escaladas, count(*)::int AS total
       FROM soporte_intento_ia WHERE creado_en > now() - interval '30 days'`)).rows[0],
  }));
}

export async function verTicket(db: Database, op: Operador, id: string) {
  exigir(op, 'plataforma:ver');
  if (!isUuid(id)) throw notFound();
  return db.withOperador(async (tx) => {
    const k = (await tx.query(
      `SELECT k.id, k.numero, coalesce(k.tenant_id, k.tenant_relacionado) AS empresa_id, (k.tenant_id IS NULL) AS sin_verificar, t.nombre AS empresa, k.canal, k.conversacion_id, k.solicitante_telefono,
              k.categoria, k.prioridad, k.estado, k.asunto, k.solicitante_nombre, k.solicitante_email, k.creado_en, k.actualizado_en
       FROM soporte_ticket k LEFT JOIN tenant t ON t.id=coalesce(k.tenant_id, k.tenant_relacionado) WHERE k.id=$1`, [id])).rows[0];
    if (!k) throw notFound();
    const mensajes = (await tx.query(`SELECT id, autor_tipo, autor_nombre, cuerpo, creado_en FROM soporte_mensaje WHERE ticket_id=$1 ORDER BY creado_en`, [id])).rows;
    return {
      ticket: { id: k.id, numero: k.numero, empresa_id: k.empresa_id, empresa: k.empresa, empresa_sin_verificar: k.sin_verificar && !!k.empresa, canal: k.canal, conversacion_id: k.conversacion_id,
        solicitante_telefono: k.solicitante_telefono ? enmascararTelefono(k.solicitante_telefono) : null,
        categoria: k.categoria, categoria_nombre: ETIQUETA_CATEGORIA[k.categoria], prioridad: k.prioridad, estado: k.estado, asunto: k.asunto, solicitante: k.solicitante_nombre, solicitante_email: k.solicitante_email, creado_en: k.creado_en, actualizado_en: k.actualizado_en },
      mensajes: mensajes.map((m: any) => ({ id: m.id, autor_tipo: m.autor_tipo, autor: m.autor_nombre, cuerpo: m.cuerpo, fecha: m.creado_en })),
    };
  });
}

export async function responderTicket(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'soporte:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ cuerpo: z.string().trim().min(2, 'Escribe la respuesta.').max(4000), estado: z.enum(['EN_PROCESO', 'ESPERANDO_CLIENTE', 'RESUELTO']).optional() }).parse(body);
  revisarContenido(d.cuerpo);
  const k = await db.withOperador(async (tx) => {
    const k = (await tx.query(`SELECT id, numero, tenant_id, estado, asunto, solicitante_nombre, solicitante_email, canal FROM soporte_ticket WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!k) throw notFound();
    if (k.canal === 'WHATSAPP') throw new AppError('CONFLICT', 'Esta solicitud llegó por WhatsApp: respóndela desde su conversación, así la persona la recibe en el mismo chat.');
    if (k.estado === 'CERRADO') throw new AppError('CONFLICT', 'El ticket está cerrado.');
    await tx.query(`INSERT INTO soporte_mensaje (id, tenant_id, ticket_id, autor_tipo, autor_nombre, cuerpo) VALUES ($1,$2,$3,'OPERADOR',$4,$5)`, [uuidv7(), k.tenant_id, id, 'Soporte de la plataforma', d.cuerpo]);
    await tx.query(`UPDATE soporte_ticket SET estado=$2, actualizado_en=now() WHERE id=$1`, [id, d.estado ?? 'ESPERANDO_CLIENTE']);
    await auditar(tx, op, { accion: 'soporte.responder', recurso: 'soporte_ticket', recursoId: id, tenantId: k.tenant_id, resultado: 'EXITO', detalle: { numero: k.numero, estado: d.estado ?? 'ESPERANDO_CLIENTE' } });
    return k;
  });
  // El aviso por correo sale con el remitente global y responder-a soporte.
  await db.withPlatform((tx) => encolarCorreo(tx, { tenantId: k.tenant_id, para: k.solicitante_email,
    correo: plantillas.ticketRespuesta({ nombre: k.solicitante_nombre, numero: k.numero, asunto: k.asunto, respuesta: d.cuerpo, url: `${config.publicUrl}/soporte/${id}` }) }));
  return { ok: true };
}

export async function actualizarTicket(db: Database, op: Operador, id: string, body: any) {
  exigir(op, 'soporte:gestionar');
  if (!isUuid(id)) throw notFound();
  const d = z.object({ estado: z.enum(['ABIERTO', 'EN_PROCESO', 'ESPERANDO_CLIENTE', 'RESUELTO', 'CERRADO']).optional(), prioridad: z.enum(['BAJA', 'NORMAL', 'ALTA', 'URGENTE']).optional() }).parse(body);
  if (!d.estado && !d.prioridad) throw invalid('Indica el estado o la prioridad.');
  return db.withOperador(async (tx) => {
    const k = (await tx.query(`SELECT id, numero, tenant_id, estado, prioridad FROM soporte_ticket WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!k) throw notFound();
    await tx.query(`UPDATE soporte_ticket SET estado=coalesce($2, estado), prioridad=coalesce($3, prioridad), actualizado_en=now() WHERE id=$1`, [id, d.estado ?? null, d.prioridad ?? null]);
    await auditar(tx, op, { accion: 'soporte.actualizar', recurso: 'soporte_ticket', recursoId: id, tenantId: k.tenant_id, resultado: 'EXITO', detalle: { numero: k.numero, estado: d.estado ?? k.estado, prioridad: d.prioridad ?? k.prioridad } });
    return { ok: true };
  });
}

// ------------------------------------------------------------------ auditoría
export async function auditoria(db: Database, op: Operador, q: any) {
  exigir(op, 'plataforma:ver');
  const antesDe = String(q?.antes ?? '');
  return db.withOperador(async (tx) => ({
    eventos: (await tx.query(
      `SELECT id, actor_email, accion, recurso, recurso_id, tenant_id, motivo, resultado, correlacion, detalle, creado_en FROM auditoria_plataforma
       WHERE ($1='' OR creado_en < $1::timestamptz) ORDER BY creado_en DESC LIMIT 100`, [antesDe])).rows
      .map((e: any) => ({ id: e.id, actor: e.actor_email, accion: e.accion, recurso: e.recurso, recurso_id: e.recurso_id, empresa_id: e.tenant_id, motivo: e.motivo, resultado: e.resultado, correlacion: e.correlacion, detalle: e.detalle, fecha: e.creado_en })),
  }));
}
