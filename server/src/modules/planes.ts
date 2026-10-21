import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { cop, token, uuidv7 } from '../lib/util.js';
import { aCentavos } from '../lib/money.js';
import { urlEmpresa } from '../config.js';
import { checkoutUrl, cuentaPlataforma } from '../adapters/payments.js';
import { PLANES, caracteristicasPlan } from '../onboarding/planRules.js';
import { encolarDocumentos } from '../documentos/servicio.js';

/**
 * Planes de la empresa: catálogo con precio mensual y anual, cambio de plan con prorrateo y su historial
 * de pagos para los recibos.
 *
 * Reglas del cambio (todas visibles antes de confirmar):
 *   - Subir de plan en el mismo ciclo: se activa al pagar la diferencia por los días que quedan del periodo;
 *     el periodo no cambia y el próximo cobro ya es el del plan nuevo.
 *   - Pasar de mensual a anual: empieza un año desde hoy; lo que queda del mes pagado se descuenta.
 *   - Bajar de plan o volver a mensual: queda programado para la próxima renovación (no hay devoluciones
 *     parciales) y se puede deshacer hasta entonces.
 *   - Con la suscripción vencida, cambiar de plan es renovar con el plan elegido: se paga completo.
 * Nada se cobra solo: todo cobro pasa por un checkout que la persona aprueba.
 */
export type Ciclo = 'MENSUAL' | 'ANUAL';
const CICLO = z.enum(['MENSUAL', 'ANUAL']);
/** ciclo_suscripcion (worker/jobs.ts): 2 días de pago pendiente y luego 7 de gracia antes de solo lectura. */
export const DIAS_GRACIA = 7;
/** Un ajuste menor que esto no se cobra (Omnegia lo asume): no vale un checkout. */
const CARGO_MINIMO = 2_000;
const ESTANDAR = new Set(PLANES.map((p) => p.codigo as string));
const SIEMPRE_ACTIVOS = ['soporte', 'suscripcion', 'clientes', 'conversaciones'];
const MODULO_TEXTO: Record<string, string> = { inventario: 'Inventario y existencias', facturacion: 'Factura electrónica DIAN', comisiones: 'Comisiones del equipo', membresias: 'Membresías', agenda: 'Agenda con recordatorios', ventas: 'Ventas y caja del día' };
const redondear = (n: number) => Math.round(n / 100) * 100;

interface FilaPlan { codigo: string; nombre: string; descripcion?: string; precio_mensual: number | string; precio_anual?: number | string | null; cuota_tokens_ia: number | string; cuota_mensajes: number | string; cuota_documentos: number | string; max_usuarios: number; modulos: string[]; politica_excedente: string; precio_excedente_1k_tokens: number | string; orden: number }

/** Precio de un plan para esta empresa: el pactado (si lo conserva en su plan actual) o el del catálogo. */
export function preciosDe(p: Pick<FilaPlan, 'precio_mensual' | 'precio_anual'>, pactado?: number | string | null) {
  if (pactado != null) return { mensual: Number(pactado), anual: Number(pactado) * 10 };
  return { mensual: Number(p.precio_mensual), anual: Number(p.precio_anual ?? Number(p.precio_mensual) * 10) };
}

/** Lo que incluye un plan (las mismas frases que ve quien contrata por primera vez). */
export function caracteristicas(p: FilaPlan): string[] {
  return caracteristicasPlan(p);
}

async function suscripcionDe(tx: Tx, tenantId: string, bloquear = false) {
  const s = (await tx.query(
    `SELECT s.*, t.slug, t.email_contacto, t.nombre AS negocio, p.nombre AS plan_nombre, p.precio_mensual, p.precio_anual, p.max_usuarios, p.modulos
     FROM subscription s JOIN tenant t ON t.id=s.tenant_id JOIN plan p ON p.codigo=s.plan_codigo WHERE s.tenant_id=$1 ${bloquear ? 'FOR UPDATE OF s' : ''}`, [tenantId])).rows[0];
  if (!s) throw notFound();
  return s;
}

async function planDe(tx: Tx, codigo: string): Promise<FilaPlan> {
  if (!ESTANDAR.has(codigo)) throw invalid('Ese plan no existe.');
  const p = (await tx.query(`SELECT * FROM plan WHERE codigo=$1`, [codigo])).rows[0];
  if (!p) throw invalid('Ese plan no existe.');
  return p;
}

/** Catálogo para la empresa: los planes estándar, cuál tiene, su ciclo y si hay un cambio programado. */
export async function planesDisponibles(tx: Tx, tenantId: string) {
  const s = await suscripcionDe(tx, tenantId);
  const planes = (await tx.query(`SELECT * FROM plan WHERE codigo = ANY($1::text[]) ORDER BY orden`, [[...ESTANDAR]])).rows as FilaPlan[];
  return {
    actual: s.plan_codigo, ciclo: s.ciclo as Ciclo, estado: s.estado, modalidad: s.modalidad, cambio_programado: s.cambio_programado ?? null,
    planes: planes.map((p) => {
      const actual = p.codigo === s.plan_codigo;
      const precios = preciosDe(p, actual ? s.precio_pactado : null);
      return {
        codigo: p.codigo, nombre: p.nombre, descripcion: p.descripcion ?? '', mensual: precios.mensual, anual: precios.anual,
        anual_por_mes: Math.round(precios.anual / 12), ahorro_anual: precios.mensual * 12 - precios.anual,
        catalogo: preciosDe(p), pactado: actual && s.precio_pactado != null,
        caracteristicas: caracteristicas(p), destacado: p.codigo === 'negocio', actual,
        cuotas: { tokens_ia: Number(p.cuota_tokens_ia), mensajes: Number(p.cuota_mensajes), documentos: Number(p.cuota_documentos), usuarios: p.max_usuarios },
      };
    }),
  };
}

export interface Cotizacion {
  tipo: 'SIN_CAMBIO' | 'INMEDIATO' | 'PROGRAMADO' | 'RENOVAR';
  de: { plan: string; nombre: string; ciclo: Ciclo; precio: number };
  a: { plan: string; nombre: string; ciclo: Ciclo; precio: number };
  /** Días que quedan del periodo pagado y su total (base del prorrateo). */
  dias_restantes: number; dias_periodo: number;
  /** Valor no usado del periodo actual que se descuenta (solo al pasar a anual). */
  credito: number;
  /** Lo que se cobraría ahora (0 si no se cobra). */
  cargo: number;
  aplica_desde: string;
  proximo_cobro: { fecha: string; monto: number };
  modulos_que_se_apagan: string[];
  bloqueo: string | null;
  explicacion: string;
}

/** Calcula, sin cambiar nada, qué pasaría al elegir otro plan o ciclo. */
export async function cotizar(tx: Tx, tenantId: string, plan: string, cicloPedido: string, bloquear = false): Promise<Cotizacion> {
  const ciclo = CICLO.parse(cicloPedido);
  const s = await suscripcionDe(tx, tenantId, bloquear);
  if (s.modalidad !== 'COMERCIAL') throw new AppError('CONFLICT', 'Tu empresa está en la modalidad institucional: el cambio de plan se hace con el equipo de Omnegia.');
  const destino = await planDe(tx, plan);
  const mismo = destino.codigo === s.plan_codigo;
  const cicloActual = s.ciclo as Ciclo;
  const actual = preciosDe(s, s.precio_pactado);
  const nuevo = preciosDe(destino, mismo ? s.precio_pactado : null);
  const precioActual = cicloActual === 'ANUAL' ? actual.anual : actual.mensual;
  const precioNuevo = ciclo === 'ANUAL' ? nuevo.anual : nuevo.mensual;
  const ahora = Date.now();
  const ini = new Date(s.periodo_inicio).getTime(), fin = new Date(s.periodo_fin).getTime();
  const total = Math.max(1, fin - ini);
  const resta = Math.min(1, Math.max(0, (fin - ahora) / total));
  const diasPeriodo = Math.max(1, Math.round(total / 86_400_000));
  const diasRestantes = Math.max(0, Math.ceil((fin - ahora) / 86_400_000));
  const usuarios = (await tx.query(`SELECT count(*)::int AS n FROM user_tenant WHERE tenant_id=$1 AND activo`, [tenantId])).rows[0].n;
  const apagan = (s.modulos as string[]).filter((m) => !destino.modulos.includes(m) && !SIEMPRE_ACTIVOS.includes(m)).map((m) => MODULO_TEXTO[m] ?? m);
  const base = {
    de: { plan: s.plan_codigo, nombre: s.plan_nombre, ciclo: cicloActual, precio: precioActual },
    a: { plan: destino.codigo, nombre: destino.nombre, ciclo, precio: precioNuevo },
    dias_restantes: diasRestantes, dias_periodo: diasPeriodo, credito: 0, cargo: 0, modulos_que_se_apagan: apagan,
    bloqueo: usuarios > destino.max_usuarios ? `Tienes ${usuarios} personas con acceso y el plan ${destino.nombre} permite ${destino.max_usuarios}. Retira accesos en Configuración antes de cambiar.` : null,
  };
  const enAnios = (n: number) => { const d = new Date(ahora); d.setFullYear(d.getFullYear() + n); return d.toISOString(); };
  if (mismo && ciclo === cicloActual) {
    return { ...base, tipo: 'SIN_CAMBIO', aplica_desde: new Date(ahora).toISOString(), proximo_cobro: { fecha: new Date(fin).toISOString(), monto: precioNuevo }, explicacion: 'Es tu plan de siempre: tu próximo cobro no cambia.' };
  }
  if (s.estado !== 'ACTIVA') {
    return { ...base, tipo: 'RENOVAR', cargo: precioNuevo, aplica_desde: new Date(ahora).toISOString(),
      proximo_cobro: { fecha: ciclo === 'ANUAL' ? enAnios(1) : new Date(ahora + 30 * 86_400_000).toISOString(), monto: precioNuevo },
      explicacion: `Tu suscripción está pendiente de pago: al pagar ${cop(precioNuevo)} se renueva directamente con el plan ${destino.nombre}.` };
  }
  if (cicloActual === 'MENSUAL' && ciclo === 'ANUAL') {
    const credito = redondear(precioActual * resta);
    let cargo = Math.max(0, redondear(precioNuevo - credito));
    if (cargo < CARGO_MINIMO) cargo = 0;
    return { ...base, tipo: 'INMEDIATO', credito, cargo, aplica_desde: new Date(ahora).toISOString(), proximo_cobro: { fecha: enAnios(1), monto: precioNuevo },
      explicacion: `Empiezas un año del plan ${destino.nombre} hoy. Descontamos ${cop(credito)} por los ${diasRestantes} días que te quedan del mes pagado.` };
  }
  if (ciclo === cicloActual && precioNuevo > precioActual) {
    let cargo = redondear((precioNuevo - precioActual) * resta);
    if (cargo < CARGO_MINIMO) cargo = 0;
    return { ...base, tipo: 'INMEDIATO', cargo, aplica_desde: new Date(ahora).toISOString(), proximo_cobro: { fecha: new Date(fin).toISOString(), monto: precioNuevo },
      explicacion: cargo ? `Pagas solo la diferencia por los ${diasRestantes} días que quedan del periodo. Desde tu próxima renovación pagas ${cop(precioNuevo)}.` : `El ajuste por los días que quedan es tan pequeño que no se cobra. Desde tu próxima renovación pagas ${cop(precioNuevo)}.` };
  }
  return { ...base, tipo: 'PROGRAMADO', aplica_desde: new Date(fin).toISOString(), proximo_cobro: { fecha: new Date(fin).toISOString(), monto: precioNuevo },
    explicacion: `Sigues con ${s.plan_nombre} hasta el fin del periodo que ya pagaste; el cambio se aplica en tu próxima renovación. Puedes deshacerlo antes.` };
}

/**
 * Cambia el plan de la empresa y ajusta sus módulos: apaga lo que el plan nuevo no incluye y enciende lo que
 * trae de nuevo, también si ya existía apagado (de un plan anterior). Lo que ambos planes incluyen conserva
 * el interruptor que la empresa eligió.
 */
async function ponerPlan(tx: Tx, tenantId: string, destino: FilaPlan) {
  const previos: string[] = (await tx.query(`SELECT p.modulos FROM tenant t JOIN plan p ON p.codigo=t.plan_codigo WHERE t.id=$1`, [tenantId])).rows[0]?.modulos ?? [];
  const nuevos = destino.modulos.filter((m) => !previos.includes(m));
  await tx.query(`UPDATE tenant SET plan_codigo=$2 WHERE id=$1`, [tenantId, destino.codigo]);
  await tx.query(`UPDATE subscription SET plan_codigo=$2, precio_pactado=NULL, cambio_programado=NULL, actualizado_en=now() WHERE tenant_id=$1`, [tenantId, destino.codigo]);
  await tx.query(`UPDATE tenant_module SET activo=false WHERE tenant_id=$1 AND NOT (modulo = ANY($2::text[])) AND NOT (modulo = ANY($3::text[]))`, [tenantId, destino.modulos, SIEMPRE_ACTIVOS]);
  await tx.query(`INSERT INTO tenant_module (tenant_id, modulo, activo) SELECT $1, m.codigo, true FROM module m WHERE m.codigo = ANY($2::text[]) ON CONFLICT (tenant_id, modulo) DO NOTHING`, [tenantId, destino.modulos]);
  if (nuevos.length) await tx.query(`UPDATE tenant_module SET activo=true WHERE tenant_id=$1 AND modulo = ANY($2::text[])`, [tenantId, nuevos]);
}

/**
 * Confirma un cambio. El cliente envía el cargo que vio: si cambió (pasó un día, cambió el plan), no se
 * hace nada y se devuelve la cotización nueva. Devuelve lo que pasó: programado, aplicado o un checkout.
 */
export async function confirmarCambio(db: Database, ctx: Ctx, cuerpo: unknown) {
  const b = z.object({ plan: z.string().trim().min(1).max(60), ciclo: CICLO, cargo: z.number().nonnegative() }).parse(cuerpo);
  const actor = { tipo: ctx.actor.tipo, id: ctx.actor.id, nombre: ctx.actor.nombre };
  const r = await db.withPlatform(async (tx) => {
    const c = await cotizar(tx, ctx.tenantId, b.plan, b.ciclo, true);
    if (c.bloqueo) throw new AppError('CONFLICT', c.bloqueo, { cotizacion: c });
    if (c.cargo !== b.cargo && c.tipo !== 'PROGRAMADO' && c.tipo !== 'SIN_CAMBIO') throw new AppError('CONFLICT', `El valor del cambio se actualizó a ${cop(c.cargo)}. Revísalo y confirma de nuevo.`, { cotizacion: c });
    if (c.tipo === 'SIN_CAMBIO') return { tipo: 'SIN_CAMBIO' as const, cotizacion: c };
    if (c.tipo === 'PROGRAMADO' || c.tipo === 'RENOVAR') {
      const programado = { plan: c.a.plan, nombre: c.a.nombre, ciclo: c.a.ciclo, precio: c.a.precio, desde: c.aplica_desde, solicitado_en: new Date().toISOString(), solicitado_por: ctx.actor.nombre };
      await tx.query(`UPDATE subscription SET cambio_programado=$2, actualizado_en=now() WHERE tenant_id=$1`, [ctx.tenantId, JSON.stringify(programado)]);
      await auditPlatform(tx, ctx.tenantId, actor, 'API', ctx.correlacion, { accion: 'suscripcion.cambio_programado', resultado: 'EXITO', detalle: { de: c.de, a: c.a } });
      return { tipo: c.tipo === 'RENOVAR' ? 'RENOVAR' as const : 'PROGRAMADO' as const, cotizacion: c };
    }
    // INMEDIATO
    const destino = await planDe(tx, c.a.plan);
    if (c.cargo === 0) {
      await aplicarCambio(tx, ctx.tenantId, destino, c, null);
      await auditPlatform(tx, ctx.tenantId, actor, 'API', ctx.correlacion, { accion: 'suscripcion.cambio_aplicado', resultado: 'EXITO', detalle: { de: c.de, a: c.a, cargo: 0 } });
      return { tipo: 'APLICADO' as const, cotizacion: c };
    }
    const cuenta = cuentaPlataforma();
    if (!cuenta) throw new AppError('CONFLICT', 'Los pagos en línea están pendientes de conectar. Escribe a soporte para cambiar de plan.');
    const s = await suscripcionDe(tx, ctx.tenantId);
    await tx.query(`UPDATE payment SET estado='REEMPLAZADO', actualizado_en=now() WHERE tenant_id=$1 AND draft_token IS NULL AND estado='PENDIENTE' AND numero_contratacion_id IS NULL`, [ctx.tenantId]);
    const referencia = `SUB-${token(9)}`;
    const expira = new Date(Date.now() + 30 * 60_000);
    const concepto = `Cambio al plan ${c.a.nombre}${c.a.ciclo === 'ANUAL' ? ' anual' : ''}`;
    const fact = (await tx.query(`SELECT facturacion, documento_cifrado, facturacion_huella FROM payment WHERE tenant_id=$1 AND facturacion IS NOT NULL ORDER BY creado_en DESC LIMIT 1`, [ctx.tenantId])).rows[0];
    await tx.query(
      `INSERT INTO payment (id, tenant_id, referencia, concepto, monto, estado, proveedor, modalidad, monto_referencia, plan_codigo, entorno, expira_en, ciclo, cambio_plan, facturacion, documento_cifrado, facturacion_huella)
       VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6,'COMERCIAL',$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [uuidv7(), ctx.tenantId, referencia, concepto, c.cargo, cuenta.proveedor, c.a.precio, c.a.plan, cuenta.proveedor === 'wompi' ? cuenta.entorno : null, expira.toISOString(), c.a.ciclo,
        JSON.stringify({ de: c.de, a: c.a, credito: c.credito, cargo: c.cargo, dias_restantes: c.dias_restantes, periodo_fin: s.periodo_fin }),
        fact?.facturacion ? JSON.stringify(fact.facturacion) : null, fact?.documento_cifrado ?? null, fact?.facturacion_huella ?? null]);
    await auditPlatform(tx, ctx.tenantId, actor, 'API', referencia, { accion: 'suscripcion.cambio_checkout', resultado: 'EXITO', detalle: { referencia, de: c.de, a: c.a, cargo: c.cargo } });
    const url = checkoutUrl(cuenta, { referencia, montoCentavos: aCentavos(c.cargo), redirectUrl: `${urlEmpresa(s.slug)}/suscripcion?ref=${referencia}`, expiraEn: cuenta.proveedor === 'wompi' ? expira : undefined, concepto, cliente: { email: s.email_contacto, nombre: s.negocio } });
    return { tipo: 'PAGO' as const, cotizacion: c, referencia, monto: c.cargo, url };
  });
  return r;
}

/** Deshace un cambio programado (bajar de plan o volver a mensual) antes de que se aplique. */
export async function deshacerCambio(db: Database, ctx: Ctx) {
  return db.withPlatform(async (tx) => {
    const s = await suscripcionDe(tx, ctx.tenantId, true);
    if (!s.cambio_programado) return { deshecho: false };
    await tx.query(`UPDATE subscription SET cambio_programado=NULL, actualizado_en=now() WHERE tenant_id=$1`, [ctx.tenantId]);
    await auditPlatform(tx, ctx.tenantId, { tipo: ctx.actor.tipo, id: ctx.actor.id, nombre: ctx.actor.nombre }, 'API', ctx.correlacion, { accion: 'suscripcion.cambio_deshecho', resultado: 'EXITO', detalle: { programado: s.cambio_programado } });
    return { deshecho: true, plan: s.plan_codigo, ciclo: s.ciclo };
  });
}

/** Aplica un cambio inmediato (pagado o sin cargo): plan, ciclo, periodo y su registro. */
async function aplicarCambio(tx: Tx, tenantId: string, destino: FilaPlan, c: Pick<Cotizacion, 'a' | 'de' | 'cargo' | 'credito'>, pago: { id: string; referencia: string } | null) {
  await ponerPlan(tx, tenantId, destino);
  const nuevoAnio = c.de.ciclo === 'MENSUAL' && c.a.ciclo === 'ANUAL';
  const p = (await tx.query(
    `UPDATE subscription SET ciclo=$2, precio_pagado=$3,
       periodo_inicio = CASE WHEN $4 THEN now() ELSE periodo_inicio END,
       periodo_fin = CASE WHEN $4 THEN now() + interval '12 months' ELSE periodo_fin END, actualizado_en=now()
     WHERE tenant_id=$1 RETURNING periodo_inicio, periodo_fin`, [tenantId, c.a.ciclo, c.a.precio, nuevoAnio])).rows[0];
  if (pago) {
    await tx.query(
      `INSERT INTO subscription_period (id, tenant_id, payment_id, modalidad, plan_codigo, monto_pagado, monto_referencia, periodo_inicio, periodo_fin, condiciones, ciclo)
       VALUES ($1,$2,$3,'COMERCIAL',$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (payment_id) DO NOTHING`,
      [uuidv7(), tenantId, pago.id, destino.codigo, c.cargo, c.a.precio, p.periodo_inicio, p.periodo_fin, JSON.stringify({ cambio_plan: { de: c.de, a: c.a, credito: c.credito, cargo: c.cargo } }), c.a.ciclo]);
  }
}

/** Pago aprobado de un cambio prorrateado: el dinero ya entró, así que el cambio se aplica (y se audita si el estado cambió entre tanto). */
export async function aplicarCambioPagado(tx: Tx, pago: any, correlacion: string) {
  const c = pago.cambio_plan;
  const s = await suscripcionDe(tx, pago.tenant_id, true);
  const destino = await planDe(tx, c.a.plan);
  await aplicarCambio(tx, pago.tenant_id, destino, c, pago);
  const sistema = { tipo: 'SISTEMA' as const, id: null, nombre: 'Pasarela de pagos' };
  if (s.plan_codigo !== c.de.plan || s.ciclo !== c.de.ciclo) {
    await auditPlatform(tx, pago.tenant_id, sistema, 'WEBHOOK', correlacion, { accion: 'suscripcion.cambio_estado_distinto', resultado: 'EXITO', detalle: { referencia: pago.referencia, cotizado_desde: c.de, encontrado: { plan: s.plan_codigo, ciclo: s.ciclo } } });
  }
  await auditPlatform(tx, pago.tenant_id, sistema, 'WEBHOOK', correlacion, { accion: 'suscripcion.cambio_aplicado', resultado: 'EXITO', detalle: { referencia: pago.referencia, de: c.de, a: c.a, cargo: c.cargo } });
  await encolarDocumentos(tx, pago.id);
}

/** Una renovación pagada que trae un plan distinto (cambio programado o renovación con otro plan): lo pone. */
export async function aplicarPlanDeRenovacion(tx: Tx, tenantId: string, planCodigo: string | null) {
  const s = await suscripcionDe(tx, tenantId, true);
  if (!planCodigo || planCodigo === s.plan_codigo) {
    if (s.cambio_programado && s.cambio_programado.plan === s.plan_codigo) await tx.query(`UPDATE subscription SET cambio_programado=NULL WHERE tenant_id=$1`, [tenantId]);
    return;
  }
  await ponerPlan(tx, tenantId, await planDe(tx, planCodigo));
}

/** Pagos aprobados de la empresa a Omnegia (los recibos) y el próximo cobro. */
export async function movimientos(tx: Tx, tenantId: string, proximo: { fecha: string; monto: number; plan: string } | null) {
  const pagos = (await tx.query(
    `SELECT p.id, p.referencia, p.concepto, p.monto::float AS monto, p.verificado_en, p.creado_en, p.plan_codigo, pl.nombre AS plan_nombre, p.ciclo, p.cambio_plan, p.metodo_pago, p.metodo_detalle,
            p.modalidad, p.transaccion_id, p.proveedor, d.id AS documento_id, d.numero AS documento, d.estado AS documento_estado, sp.periodo_inicio, sp.periodo_fin
     FROM payment p LEFT JOIN plan pl ON pl.codigo=p.plan_codigo LEFT JOIN documento_pago d ON d.payment_id=p.id LEFT JOIN subscription_period sp ON sp.payment_id=p.id
     WHERE p.tenant_id=$1 AND p.estado='APROBADO' AND p.numero_contratacion_id IS NULL ORDER BY coalesce(p.verificado_en, p.creado_en) DESC LIMIT 12`, [tenantId])).rows;
  return { pagos, proximo };
}

/** Estado de un pago de la suscripción por su referencia (para la pantalla de pago aprobado al volver del checkout). */
export async function estadoPago(tx: Tx, tenantId: string, referencia: string) {
  if (!/^SUB-[A-Za-z0-9_-]{4,40}$/.test(referencia)) throw notFound();
  const p = (await tx.query(
    `SELECT p.id, p.referencia, p.concepto, p.monto::float AS monto, p.estado, p.verificado_en, p.creado_en, p.plan_codigo, pl.nombre AS plan_nombre, p.ciclo, p.cambio_plan, p.metodo_pago, p.metodo_detalle,
            p.transaccion_id, p.proveedor, sp.periodo_inicio, sp.periodo_fin, d.numero AS documento
     FROM payment p LEFT JOIN plan pl ON pl.codigo=p.plan_codigo LEFT JOIN subscription_period sp ON sp.payment_id=p.id LEFT JOIN documento_pago d ON d.payment_id=p.id
     WHERE p.tenant_id=$1 AND p.referencia=$2`, [tenantId, referencia])).rows[0];
  if (!p) throw notFound();
  return p;
}

/** Qué pasa en solo lectura (es el comportamiento real del bloqueo de escritura): lo que se pausa y lo que se conserva. */
export const QUE_SE_PAUSA = {
  pausa: [
    'Respuestas de la IA por WhatsApp',
    'Registrar ventas, citas y cobros',
    'Emitir facturas electrónicas',
    'Invitar personas y cambiar la configuración',
  ],
  conserva: ['Tus clientes, ventas y conversaciones', 'Ver y exportar tus datos'],
};
