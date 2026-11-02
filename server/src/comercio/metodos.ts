import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { audit } from '../core/audit.js';
import { invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { config } from '../config.js';
import { cuentaPlataforma } from '../adapters/payments.js';

/**
 * Métodos de pago de los pedidos por WhatsApp (docs/pagos-whatsapp.md):
 *  - Pago manual: la empresa registra sus datos (Nequi, Daviplata, Bre-B, QR, cuenta) y confirma cada pago a mano.
 *  - Pago en línea: cobro con la cuenta Wompi del proyecto; solo si el operador habilitó PAYMENTS_LIVE_ENABLED.
 * El modo de precios y el importe fijo son del operador (variables del servidor): aquí solo se informan.
 */
export const TIPOS_CUENTA = ['NEQUI', 'DAVIPLATA', 'BREB', 'QR', 'CUENTA_BANCARIA'] as const;
export const NOMBRE_TIPO: Record<(typeof TIPOS_CUENTA)[number], string> = { NEQUI: 'Nequi', DAVIPLATA: 'Daviplata', BREB: 'Llave Bre-B', QR: 'Código QR', CUENTA_BANCARIA: 'Cuenta bancaria' };
/** Medios de Wompi que se ofrecen por WhatsApp: Nequi directo; tarjeta, PSE y Bancolombia en el checkout web firmado. */
export const MEDIOS_EN_LINEA = ['NEQUI', 'CHECKOUT'] as const;

/** ¿Hay cobro en línea real posible en este servidor? */
export function enLineaDisponible(): { ok: boolean; motivo: string | null } {
  if (!config.comercio.liveEnabled) return { ok: false, motivo: 'Los pagos en línea están apagados en Omnegia (PAYMENTS_LIVE_ENABLED).' };
  const c = cuentaPlataforma();
  if (c?.proveedor !== 'wompi' || c.entorno !== 'produccion') return { ok: false, motivo: 'La cuenta de Wompi del proyecto no está en producción.' };
  return { ok: true, motivo: null };
}

/** Modo de precios vigente (lo fija el operador; las empresas solo lo ven). */
export function modoPrecios() {
  return { modo: config.comercio.pricingMode, cargo_fijo_cop: config.comercio.pricingMode === 'institutional_test' ? config.comercio.testChargeCop : null, pagos_reales: config.comercio.liveEnabled };
}

export async function ajustes(tx: Tx) {
  const s = (await tx.query(`SELECT pago_manual, pago_en_linea, actualizado_en, actualizado_por FROM payment_settings LIMIT 1`)).rows[0];
  const cuentas = (await tx.query(`SELECT * FROM merchant_payment_account ORDER BY activo DESC, creado_en`)).rows.map(vistaCuenta);
  const linea = enLineaDisponible();
  return {
    pago_manual: !!s?.pago_manual, pago_en_linea: !!s?.pago_en_linea,
    en_linea_disponible: linea.ok, motivo_en_linea: linea.motivo,
    precios: modoPrecios(), cuentas, actualizado_en: s?.actualizado_en ?? null, actualizado_por: s?.actualizado_por ?? null,
  };
}

export async function verAjustes(tx: Tx, ctx: Ctx) {
  requirePerm(ctx, 'order:read');
  return ajustes(tx);
}

const AjustesInput = z.object({ pago_manual: z.boolean(), pago_en_linea: z.boolean() }).strict();

export async function guardarAjustes(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = AjustesInput.parse(body ?? {});
  const antes = await ajustes(tx);
  if (d.pago_manual && !antes.cuentas.some((c) => c.activo)) throw invalid('Para activar el pago manual, agrega primero al menos un dato de pago (por ejemplo, tu Nequi).');
  if (d.pago_en_linea && !antes.en_linea_disponible) throw invalid(antes.motivo_en_linea ?? 'El pago en línea no está disponible.');
  await tx.query(
    `INSERT INTO payment_settings (tenant_id, pago_manual, pago_en_linea, actualizado_en, actualizado_por) VALUES ($1,$2,$3, now(), $4)
     ON CONFLICT (tenant_id) DO UPDATE SET pago_manual=EXCLUDED.pago_manual, pago_en_linea=EXCLUDED.pago_en_linea, actualizado_en=now(), actualizado_por=EXCLUDED.actualizado_por`,
    [ctx.tenantId, d.pago_manual, d.pago_en_linea, ctx.actor.nombre]);
  await audit(tx, ctx, { accion: 'pagos.ajustes', recurso: 'payment_settings', resultado: 'EXITO', detalle: { antes: { pago_manual: antes.pago_manual, pago_en_linea: antes.pago_en_linea }, despues: d } });
  return ajustes(tx);
}

export function vistaCuenta(r: any) {
  return { id: r.id, tipo: r.tipo, tipo_nombre: NOMBRE_TIPO[r.tipo as keyof typeof NOMBRE_TIPO] ?? r.tipo, titular: r.titular, valor: r.valor, banco: r.banco, tipo_cuenta: r.tipo_cuenta, instrucciones: r.instrucciones, activo: r.activo };
}

const CuentaInput = z.object({
  tipo: z.enum(TIPOS_CUENTA, 'Elige el tipo de dato de pago.'),
  titular: z.string().trim().min(2, 'Escribe el nombre del titular.').max(120),
  valor: z.string().trim().min(3, 'Escribe el número, la llave o el enlace.').max(120),
  banco: z.string().trim().max(80).optional().nullable(),
  tipo_cuenta: z.enum(['AHORROS', 'CORRIENTE']).optional().nullable(),
  instrucciones: z.string().trim().max(500).optional().nullable(),
  activo: z.boolean().optional(),
}).strict().superRefine((d, c) => {
  const digitos = d.valor.replace(/\D/g, '');
  if ((d.tipo === 'NEQUI' || d.tipo === 'DAVIPLATA') && !/^3\d{9}$/.test(digitos)) c.addIssue({ code: 'custom', path: ['valor'], message: 'Escribe el celular de 10 dígitos (empieza por 3).' });
  if (d.tipo === 'CUENTA_BANCARIA' && (!d.banco || !/^\d{6,20}$/.test(digitos))) c.addIssue({ code: 'custom', path: ['valor'], message: 'Escribe el banco y el número de la cuenta.' });
  if (d.tipo === 'QR' && !/^https:\/\/\S+$/.test(d.valor)) c.addIssue({ code: 'custom', path: ['valor'], message: 'Pega el enlace https de la imagen o la página del QR.' });
});

export async function crearCuenta(tx: Tx, ctx: Ctx, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  const d = CuentaInput.parse(body ?? {});
  const id = uuidv7();
  await tx.query(`INSERT INTO merchant_payment_account (id, tenant_id, tipo, titular, valor, banco, tipo_cuenta, instrucciones, activo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, ctx.tenantId, d.tipo, d.titular, d.valor, d.banco ?? null, d.tipo_cuenta ?? null, d.instrucciones ?? null, d.activo ?? true]);
  await audit(tx, ctx, { accion: 'pagos.cuenta_manual.crear', recurso: 'merchant_payment_account', recursoId: id, resultado: 'EXITO', detalle: { tipo: d.tipo } });
  return vistaCuenta((await tx.query(`SELECT * FROM merchant_payment_account WHERE id=$1`, [id])).rows[0]);
}

export async function editarCuenta(tx: Tx, ctx: Ctx, id: string, body: unknown) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const d = CuentaInput.parse(body ?? {});
  const r = (await tx.query(
    `UPDATE merchant_payment_account SET tipo=$2, titular=$3, valor=$4, banco=$5, tipo_cuenta=$6, instrucciones=$7, activo=$8, actualizado_en=now() WHERE id=$1 RETURNING *`,
    [id, d.tipo, d.titular, d.valor, d.banco ?? null, d.tipo_cuenta ?? null, d.instrucciones ?? null, d.activo ?? true])).rows[0];
  if (!r) throw notFound();
  await audit(tx, ctx, { accion: 'pagos.cuenta_manual.editar', recurso: 'merchant_payment_account', recursoId: id, resultado: 'EXITO', detalle: { tipo: d.tipo, activo: r.activo } });
  return vistaCuenta(r);
}

export async function borrarCuenta(tx: Tx, ctx: Ctx, id: string) {
  requirePerm(ctx, 'tenant:configure');
  requireWritable(ctx);
  if (!isUuid(id)) throw notFound();
  const r = (await tx.query(`DELETE FROM merchant_payment_account WHERE id=$1 RETURNING tipo`, [id])).rows[0];
  if (!r) throw notFound();
  await audit(tx, ctx, { accion: 'pagos.cuenta_manual.borrar', recurso: 'merchant_payment_account', recursoId: id, resultado: 'EXITO', detalle: { tipo: r.tipo } });
  return { ok: true };
}

/** Medios que la IA puede ofrecer a un cliente ahora mismo (lo que la empresa activó y el servidor permite). */
export async function mediosHabilitados(tx: Tx) {
  const a = await ajustes(tx);
  const medios: { clave: string; nombre: string; modalidad: 'MANUAL' | 'MANAGED' }[] = [];
  if (a.pago_en_linea && a.en_linea_disponible) {
    medios.push({ clave: 'NEQUI', nombre: 'Nequi (te llega una solicitud de pago a la app)', modalidad: 'MANAGED' });
    medios.push({ clave: 'CHECKOUT', nombre: 'Tarjeta, PSE o Bancolombia (enlace seguro de Wompi)', modalidad: 'MANAGED' });
  }
  if (a.pago_manual) for (const c of a.cuentas.filter((x) => x.activo)) medios.push({ clave: c.tipo, nombre: `${c.tipo_nombre} del negocio (transferencia que el negocio confirma)`, modalidad: 'MANUAL' });
  return { medios, precios: a.precios };
}
