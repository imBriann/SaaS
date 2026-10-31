import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable, can } from '../core/context.js';
import { auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { registrarIncidente } from '../core/incidentes.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { aCentavos } from '../lib/money.js';
import { cop, decrypt, encrypt, hmacHex, isUuid, safeEqual, token, uuidv7 } from '../lib/util.js';
import { config, urlEmpresa } from '../config.js';
import { checkoutUrl, cuentaPlataforma } from '../adapters/payments.js';
import { setResolverToken } from '../adapters/channel.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { encolarDocumentos } from '../documentos/servicio.js';
import { elegibleWhatsApp, ErrorProveedor, NumeroNoDisponible, proveedorNumeros, type NumeroDisponible, type Orden, type ProveedorNumeros, type Requisito, type TipoNumero, type ValorRequisito } from './proveedor.js';
import { cargosMeta, cotizar, tasaUsdCop, type Cotizacion } from './tarifas.js';
import { codigoDeTranscripcion, ErrorMeta, metaOnboarding, metaPlataforma, type DatosNumeroMeta, type MetaOnboarding } from './meta.js';
import { PAISES_PROPIO, vistaPropio } from './propio.js';

/**
 * Contratación de un número de WhatsApp desde Omnegia: máquina de estados persistente.
 *
 *   SELECCION_NUMERO → CONFIRMACION_PENDIENTE → PAGO_PENDIENTE → PAGO_CONFIRMADO
 *     → APROVISIONANDO_NUMERO → NUMERO_APROVISIONADO                        (proveedor telefónico)
 *     → REGISTRO_WHATSAPP_PENDIENTE → VERIFICACION_PENDIENTE → CONEXION_PENDIENTE → CONECTADO   (Meta)
 *   Fallos: APROVISIONAMIENTO_FALLIDO, CONEXION_FALLIDA. Cierre: CANCELACION_PENDIENTE → CANCELADO.
 *
 * Reglas:
 *  - Cada transición es un UPDATE condicionado al estado de origen y deja un evento (numero_evento).
 *    Repetir un webhook o un trabajo no repite efectos.
 *  - Toda llamada al proveedor o a Meta la hace el trabajador, con turno exclusivo (bloqueo_hasta).
 *  - El precio se congela al elegir el número; el navegador solo confirma lo que el servidor mostró.
 *  - Nada se muestra como comprado o conectado hasta que el proveedor o Meta lo confirman.
 */
export type Estado =
  | 'SELECCION_NUMERO' | 'CONFIRMACION_PENDIENTE' | 'PAGO_PENDIENTE' | 'PAGO_CONFIRMADO'
  | 'APROVISIONANDO_NUMERO' | 'NUMERO_APROVISIONADO' | 'REGISTRO_WHATSAPP_PENDIENTE' | 'VERIFICACION_PENDIENTE'
  | 'CONEXION_PENDIENTE' | 'CONECTADO' | 'APROVISIONAMIENTO_FALLIDO' | 'CONEXION_FALLIDA' | 'CANCELACION_PENDIENTE' | 'CANCELADO'
  // Origen PROPIO («Usar mi propio número», ver ./propio.ts): sin pago ni proveedor telefónico.
  | 'NUMERO_INGRESADO' | 'CODIGO_ENVIADO' | 'CODIGO_VERIFICADO' | 'REGISTRADO';

const ANTES_DEL_PAGO: Estado[] = ['SELECCION_NUMERO', 'CONFIRMACION_PENDIENTE', 'PAGO_PENDIENTE'];
/** Con mensualidad en curso: el número ya se compró (el primer mes cuenta desde la compra, no desde el pago). */
const CON_MENSUALIDAD: Estado[] = ['NUMERO_APROVISIONADO', 'REGISTRO_WHATSAPP_PENDIENTE', 'VERIFICACION_PENDIENTE', 'CONEXION_PENDIENTE', 'CONECTADO', 'CONEXION_FALLIDA'];
/** Se puede adelantar el registro con Meta mientras el proveedor aprovisiona el número. */
const ADMITE_META: Estado[] = ['PAGO_CONFIRMADO', 'APROVISIONANDO_NUMERO', 'NUMERO_APROVISIONADO', 'REGISTRO_WHATSAPP_PENDIENTE', 'CONEXION_FALLIDA'];
const MINUTOS_RESERVA = 30;
const MINUTOS_LLAMADA = 10;
const MAX_LLAMADAS = 4;
const MAX_INTENTOS_CONEXION = 6;
const LIMITE_DOCUMENTO = 4 * 1024 * 1024;

export const SISTEMA = { tipo: 'SISTEMA' as const, id: null, nombre: 'Números de WhatsApp' };
export type Fila = Record<string, any>;

export const actorDe = (ctx: Ctx) => ctx.actor;
export const nombreActor = (a: { tipo: string; nombre: string }) => `${a.tipo}:${a.nombre}`.slice(0, 120);

// ---------------------------------------------------------------------------
// Transiciones
// ---------------------------------------------------------------------------
export interface Mover {
  de?: Estado[];
  subestado?: string | null;
  accion?: string | null;
  campos?: Record<string, unknown>;
  detalle?: Record<string, unknown>;
  actor?: { tipo: Ctx['actor']['tipo']; id: string | null; nombre: string };
  origen?: string;
  correlacion?: string;
}

/** Objetos a jsonb; fechas y listas (text[]) tal cual. */
const aParametro = (v: unknown) => (v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v);

/** Transición condicionada: solo ocurre si la fila sigue en un estado de origen permitido. */
export async function mover(tx: Tx, c: Fila, a: Estado, tipo: string, o: Mover = {}): Promise<Fila | null> {
  const de = o.de ?? [c.estado];
  const sets = ['estado=$3', 'actualizado_en=now()'];
  const params: unknown[] = [c.id, de, a];
  if (o.subestado !== undefined) { params.push(o.subestado); sets.push(`subestado=$${params.length}`); }
  if (o.accion !== undefined) { params.push(o.accion); sets.push(`accion_cliente=$${params.length}`); }
  for (const [k, v] of Object.entries(o.campos ?? {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error('campo inválido');
    params.push(aParametro(v));
    sets.push(`${k}=$${params.length}`);
  }
  const f = (await tx.query(`UPDATE numero_contratacion SET ${sets.join(', ')} WHERE id=$1 AND estado = ANY($2::text[]) RETURNING *`, params)).rows[0];
  if (!f) return null;
  const actor = o.actor ?? SISTEMA;
  await tx.query(`INSERT INTO numero_evento (id, contratacion_id, tenant_id, de, a, tipo, detalle, actor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uuidv7(), c.id, c.tenant_id, c.estado, a, tipo, JSON.stringify(o.detalle ?? {}), nombreActor(actor)]);
  await auditPlatform(tx, c.tenant_id, actor, o.origen ?? 'TRABAJADOR', o.correlacion ?? c.id, {
    accion: `numero.${tipo}`, recurso: 'numero_contratacion', recursoId: c.id, resultado: a.endsWith('FALLIDO') || a.endsWith('FALLIDA') ? 'ERROR' : 'EXITO',
    detalle: { de: c.estado, a, subestado: o.subestado ?? f.subestado ?? null, ...(o.detalle ?? {}) },
  });
  return f;
}

/** Cambio de datos sin cambio de estado (también queda en la bitácora si lleva tipo). */
export async function anotar(tx: Tx, c: Fila, campos: Record<string, unknown>, tipo?: string, detalle: Record<string, unknown> = {}) {
  const sets = ['actualizado_en=now()'];
  const params: unknown[] = [c.id];
  for (const [k, v] of Object.entries(campos)) {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error('campo inválido');
    params.push(aParametro(v));
    sets.push(`${k}=$${params.length}`);
  }
  const f = (await tx.query(`UPDATE numero_contratacion SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params)).rows[0];
  if (tipo) await tx.query(`INSERT INTO numero_evento (id, contratacion_id, tenant_id, de, a, tipo, detalle, actor) VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
    [uuidv7(), c.id, c.tenant_id, f.estado, tipo, JSON.stringify(detalle), nombreActor(SISTEMA)]);
  return f;
}

export const cargar = async (tx: Tx, id: string, bloquear = false) =>
  (await tx.query(`SELECT * FROM numero_contratacion WHERE id=$1 ${bloquear ? 'FOR UPDATE' : ''}`, [id])).rows[0] as Fila | undefined;

/** Contratación de la empresa (la RLS la limita a su tenant aunque se pase otro id). */
async function propia(db: Database, ctx: Ctx, id: string): Promise<Fila> {
  if (!isUuid(id)) throw notFound();
  const c = await db.withTenant(ctx.tenantId, async (tx) => (await tx.query(`SELECT * FROM numero_contratacion WHERE id=$1`, [id])).rows[0]);
  if (!c) throw notFound();
  return c;
}

const permisoCompra = async (db: Database, ctx: Ctx) => db.withTenant(ctx.tenantId, async () => { requirePerm(ctx, 'subscription:manage', 'numero_contratacion'); requireWritable(ctx); });

// ---------------------------------------------------------------------------
// Credenciales cifradas
// ---------------------------------------------------------------------------
export async function credencial(tx: Tx, id: string) {
  const r = (await tx.query(`SELECT * FROM numero_credencial WHERE contratacion_id=$1`, [id])).rows[0];
  const des = (v: string | null) => { try { return v ? decrypt(config.appKey, v) : null; } catch { return null; } };
  return { token: des(r?.token_cifrado ?? null), pin: des(r?.pin_cifrado ?? null), codigo: des(r?.codigo_cifrado ?? null), codigoEn: r?.codigo_en ?? null };
}
export async function guardarCredencial(tx: Tx, c: Fila, v: { token?: string | null; pin?: string | null; codigo?: string | null }) {
  const enc = (x: string | null | undefined) => (x == null ? null : encrypt(config.appKey, x));
  await tx.query(`INSERT INTO numero_credencial (contratacion_id, tenant_id) VALUES ($1,$2) ON CONFLICT (contratacion_id) DO NOTHING`, [c.id, c.tenant_id]);
  if (v.token !== undefined) await tx.query(`UPDATE numero_credencial SET token_cifrado=$2, actualizado_en=now() WHERE contratacion_id=$1`, [c.id, enc(v.token)]);
  if (v.pin !== undefined) await tx.query(`UPDATE numero_credencial SET pin_cifrado=$2, actualizado_en=now() WHERE contratacion_id=$1`, [c.id, enc(v.pin)]);
  if (v.codigo !== undefined) await tx.query(`UPDATE numero_credencial SET codigo_cifrado=$2, codigo_en=CASE WHEN $2::text IS NULL THEN NULL ELSE now() END, actualizado_en=now() WHERE contratacion_id=$1`, [c.id, enc(v.codigo)]);
}

/** Token de negocio por número, para el canal (caché corta; el token nunca sale del servidor). */
export const cacheTokens = new Map<string, { t: string | null; en: number }>();
export function instalarResolverToken(db: Database) {
  setResolverToken(async (pid) => {
    const c = cacheTokens.get(pid);
    if (c && Date.now() - c.en < 5 * 60_000) return c.t;
    const t = await db.withPlatform(async (tx) => {
      const f = (await tx.query(`SELECT k.token_cifrado FROM numero_contratacion n JOIN numero_credencial k ON k.contratacion_id=n.id
                                 WHERE n.phone_number_id=$1 AND n.estado IN ('CONEXION_PENDIENTE','CONECTADO','CANCELACION_PENDIENTE') LIMIT 1`, [pid])).rows[0];
      try { return f?.token_cifrado ? decrypt(config.appKey, f.token_cifrado) : null; } catch { return null; }
    });
    cacheTokens.set(pid, { t, en: Date.now() });
    return t;
  });
}

// ---------------------------------------------------------------------------
// Disponibilidad comercial
// ---------------------------------------------------------------------------
const NOMBRE_TIPO: Record<TipoNumero, string> = { local: 'Fijo local', mobile: 'Móvil', national: 'Nacional', toll_free: 'Gratuito (01 8000)' };
const NOMBRE_PAIS: Record<string, string> = { CO: 'Colombia', MX: 'México', PE: 'Perú', CL: 'Chile', EC: 'Ecuador', US: 'Estados Unidos' };
export const INDICATIVO: Record<string, string> = { CO: '57', MX: '52', PE: '51', CL: '56', EC: '593', US: '1' };

export const MOTIVO_PROXIMAMENTE = 'La compra de números nuevos estará disponible próximamente. Mientras tanto, conecta tu propio número: solo necesitas recibir un SMS.';

/** Con NUMEROS_COMPRA_HABILITADA=0 la compra no se inicia ni se paga (lo ya pagado sigue su curso). */
function exigirCompraHabilitada() {
  if (!config.numeros.compraHabilitada) throw new AppError('CONFLICT', MOTIVO_PROXIMAMENTE, { proximamente: true });
}

/** ¿Se puede vender ahora? Devuelve el motivo en lenguaje claro si no. */
async function bloqueoVenta(p: ProveedorNumeros | null): Promise<string | null> {
  if (!config.numeros.compraHabilitada) return MOTIVO_PROXIMAMENTE;
  if (!p) return 'La compra de números está pendiente de conectar con el proveedor. Mientras tanto, puedes conectar un número propio.';
  if (!cuentaPlataforma()) return 'Los pagos en línea están pendientes de conectar.';
  if (p.entorno === 'real' && !config.numeros.comercial.confirmadas && !config.simuladores) return 'Los precios de los números aún no están confirmados por Omnegia. Mientras tanto, puedes conectar un número propio.';
  return null;
}

export async function contratacionViva(tx: Tx, tenantId: string) {
  return (await tx.query(`SELECT * FROM numero_contratacion WHERE tenant_id=$1 AND estado <> 'CANCELADO' ORDER BY creado_en DESC LIMIT 1`, [tenantId])).rows[0] as Fila | undefined;
}

export async function opciones(db: Database, ctx: Ctx) {
  await db.withTenant(ctx.tenantId, async () => { if (!can(ctx, 'subscription:manage') && !can(ctx, 'tenant:configure')) requirePerm(ctx, 'subscription:manage'); });
  const p = await proveedorNumeros();
  const motivo = await bloqueoVenta(p);
  const { t, plan, viva } = await db.withPlatform(async (tx) => ({
    t: (await tx.query(`SELECT nombre, whatsapp_phone_number_id, whatsapp_estado, whatsapp_numero_visible FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0],
    plan: (await tx.query(`SELECT p.nombre, p.precio_mensual, s.estado, s.periodo_fin FROM subscription s JOIN plan p ON p.codigo=s.plan_codigo WHERE s.tenant_id=$1`, [ctx.tenantId])).rows[0],
    viva: await contratacionViva(tx, ctx.tenantId),
  }));
  const propioConectado = !!t?.whatsapp_phone_number_id && t.whatsapp_estado === 'CONECTADO' && (!viva || viva.phone_number_id !== t.whatsapp_phone_number_id);
  const mp = metaPlataforma();
  const paises = [];
  for (const pais of config.numeros.paises) {
    let tipos: { tipo: TipoNumero; nombre: string; caracteristicas: string[]; reservable: boolean; elegible: boolean; motivo: string }[] = [];
    let error: string | null = null;
    if (p) {
      try {
        const cob = await p.cobertura(pais);
        tipos = (cob?.tipos ?? []).map((x) => { const e = elegibleWhatsApp(x); return { tipo: x.tipo, nombre: NOMBRE_TIPO[x.tipo], caracteristicas: x.caracteristicas, reservable: x.reservable, elegible: e.ok, motivo: e.motivo }; });
      } catch (e) { error = e instanceof ErrorProveedor ? 'No pudimos consultar la cobertura del proveedor. Intenta de nuevo en unos minutos.' : 'No pudimos consultar la cobertura.'; }
    }
    paises.push({ pais, nombre: NOMBRE_PAIS[pais] ?? pais, indicativo: INDICATIVO[pais] ?? null, tipos, error });
  }
  return {
    disponible: !motivo && !propioConectado && !viva,
    motivo: motivo ?? (propioConectado ? `Ya tienes un número propio conectado (${t.whatsapp_numero_visible ?? 'verificado'}). No necesitas contratar otro: no te cobraremos una mensualidad duplicada.` : viva ? 'Ya tienes una contratación en curso.' : null),
    proveedor: p ? { nombre: p.nombre === 'telnyx' ? 'Telnyx' : 'Simulación', entorno: p.entorno } : null,
    paises,
    plan: plan ? { nombre: plan.nombre, precio_mensual: Number(plan.precio_mensual), estado: plan.estado, periodo_fin: plan.periodo_fin } : null,
    meta: cargosMeta(),
    propio: {
      conectado: propioConectado, numero: t?.whatsapp_numero_visible ?? null,
      // «Usar mi propio número»: Omnegia registra el número en su cuenta de WhatsApp Business.
      disponible: !!mp && !propioConectado && !viva,
      motivo: !mp ? 'La conexión con WhatsApp está pendiente de configurar en Omnegia. Escribe a soporte.' : null,
      simulado: !!mp?.meta.simulado,
      nombre: t?.nombre ?? null,
      paises: PAISES_PROPIO,
    },
    compra_habilitada: config.numeros.compraHabilitada,
    contratacion_id: viva?.id ?? null,
  };
}

const Busqueda = z.object({
  pais: z.string().regex(/^[A-Z]{2}$/),
  tipo: z.enum(['local', 'mobile', 'national', 'toll_free']),
  localidad: z.string().trim().max(60).optional(),
  contiene: z.string().regex(/^\d{1,10}$/, 'Escribe solo dígitos.').optional().or(z.literal('').transform(() => undefined)),
});

function ofertaDe(n: NumeroDisponible, q: Cotizacion) {
  const e = elegibleWhatsApp(n);
  return {
    numero: n.numero, pais: n.pais, tipo: n.tipo, tipo_nombre: NOMBRE_TIPO[n.tipo], localidad: n.localidad, region: n.region,
    caracteristicas: n.caracteristicas, reservable: n.reservable, elegible: e.ok, elegibilidad: e.motivo,
    precio: { hoy: q.total_hoy, mensual: q.total_mensual, activacion: q.numero.activacion, gestion: q.gestion_activacion, iva_regimen: q.iva.regimen },
  };
}

export async function buscar(db: Database, ctx: Ctx, query: unknown) {
  await db.withTenant(ctx.tenantId, async () => requirePerm(ctx, 'subscription:manage'));
  exigirCompraHabilitada();
  const f = Busqueda.parse(query);
  if (!config.numeros.paises.includes(f.pais)) throw invalid('Ese país todavía no está disponible.');
  const p = await proveedorNumeros();
  const motivo = await bloqueoVenta(p);
  if (motivo || !p) throw new AppError('CONFLICT', motivo ?? 'No disponible.');
  const tasa = await tasaUsdCop();
  if (!tasa) throw new AppError('CONFLICT', 'No pudimos obtener la tasa de cambio oficial (TRM) para calcular el precio en pesos. Intenta de nuevo en unos minutos.');
  let lista: NumeroDisponible[];
  try { lista = await p.buscar({ ...f, limite: 12 }); } catch (e) {
    throw new AppError('CONFLICT', e instanceof ErrorProveedor && e.codigo === 'CREDENCIAL' ? 'El proveedor de números no está disponible en este momento.' : 'No pudimos consultar los números disponibles. Intenta de nuevo en unos minutos.');
  }
  const numeros = lista.map((n) => ofertaDe(n, cotizar(n, p, tasa))).filter((x) => x.elegible);
  let requisitos: Requisito[] = [];
  try { requisitos = await p.requisitos(f.pais, f.tipo); } catch { /* se vuelven a pedir al elegir */ }
  return {
    numeros, simulado: p.entorno === 'simulado',
    tasa: { valor: tasa.valor, fuente: tasa.fuente, vigente_desde: tasa.vigente_desde },
    margen_pct: config.numeros.comercial.margenPct,
    requisitos: requisitos.map(({ id, nombre, descripcion, campo }) => ({ id, nombre, descripcion, campo })),
    reserva: p.entorno === 'simulado' ? true : lista.some((n) => n.reservable),
  };
}

// ---------------------------------------------------------------------------
// Selección, requisitos y confirmación
// ---------------------------------------------------------------------------
export async function seleccionar(db: Database, ctx: Ctx, body: unknown) {
  await permisoCompra(db, ctx);
  exigirCompraHabilitada();
  const b = z.object({ numero: z.string().regex(/^\+[1-9]\d{6,14}$/), pais: z.string().regex(/^[A-Z]{2}$/), tipo: z.enum(['local', 'mobile', 'national', 'toll_free']) }).parse(body);
  const op = await opciones(db, ctx);
  if (!op.disponible) throw new AppError('CONFLICT', op.motivo ?? 'No disponible.');
  const p = (await proveedorNumeros())!;
  const tasa = await tasaUsdCop();
  if (!tasa) throw new AppError('CONFLICT', 'No pudimos obtener la tasa de cambio oficial (TRM). Intenta de nuevo en unos minutos.');
  // El número y su costo se vuelven a consultar al proveedor: nada de lo que envía el navegador fija el precio.
  const n = await p.consultar(b.numero, b.pais, b.tipo).catch(() => null);
  if (!n) throw new AppError('CONFLICT', 'Ese número ya no está disponible. Elige otro de la lista.');
  const e = elegibleWhatsApp(n);
  if (!e.ok) throw new AppError('CONFLICT', e.motivo);
  let reserva: { id: string; expiraEn: Date } | null = null;
  if (n.reservable) {
    try { reserva = await p.reservar(n.numero); } catch (err) {
      if (err instanceof NumeroNoDisponible) throw new AppError('CONFLICT', 'Otro cliente acaba de tomar ese número. Elige otro de la lista.');
      // Sin reserva se sigue: el número se vuelve a comprobar justo antes de comprarlo.
    }
  }
  const requisitos = await p.requisitos(n.pais, n.tipo).catch(() => null);
  if (requisitos === null) throw new AppError('CONFLICT', 'No pudimos consultar los requisitos del número. Intenta de nuevo en unos minutos.');
  const cot = cotizar(n, p, tasa);
  const t = await db.withPlatform(async (tx) => (await tx.query(`SELECT nombre FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]);
  const id = uuidv7();
  return db.withPlatform(async (tx) => {
    try {
      await tx.query(
        `INSERT INTO numero_contratacion (id, tenant_id, estado, subestado, accion_cliente, proveedor, entorno, pais, tipo_numero, numero_e164, localidad, caracteristicas, cotizacion,
                                          reserva_id, reserva_expira_en, requisitos, nombre_visible, creado_por)
         VALUES ($1,$2,'SELECCION_NUMERO',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, ctx.tenantId, requisitos.length ? 'requisitos_pendientes' : null, requisitos.length ? 'requisitos' : 'confirmar', p.nombre, p.entorno, n.pais, n.tipo, n.numero, n.localidad,
          n.caracteristicas, JSON.stringify(cot), reserva?.id ?? null, reserva?.expiraEn.toISOString() ?? null,
          JSON.stringify({ lista: requisitos, estado: requisitos.length ? 'pendiente' : 'no_aplica' }), String(t?.nombre ?? '').slice(0, 80) || null, ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null]);
    } catch (err) {
      if (/ux_numero_contratacion_vigente/.test(String((err as Error).message))) throw new AppError('CONFLICT', 'Ya tienes una contratación en curso.');
      if (/ux_numero_contratacion_numero/.test(String((err as Error).message))) throw new AppError('CONFLICT', 'Ese número ya está en otra contratación. Elige otro.');
      throw err;
    }
    const c = (await tx.query(`SELECT * FROM numero_contratacion WHERE id=$1`, [id])).rows[0];
    await tx.query(`INSERT INTO numero_evento (id, contratacion_id, tenant_id, de, a, tipo, detalle, actor) VALUES ($1,$2,$3,NULL,'SELECCION_NUMERO','numero_elegido',$4,$5)`,
      [uuidv7(), id, ctx.tenantId, JSON.stringify({ reservado: !!reserva, requisitos: requisitos.length }), nombreActor(actorDe(ctx))]);
    await auditPlatform(tx, ctx.tenantId, actorDe(ctx), 'PANEL', ctx.correlacion, { accion: 'numero.numero_elegido', recurso: 'numero_contratacion', recursoId: id, resultado: 'EXITO', detalle: { pais: n.pais, tipo: n.tipo, total_hoy: cot.total_hoy, total_mensual: cot.total_mensual } });
    // Sin requisitos documentales se pasa directo al resumen de compra.
    const f = requisitos.length ? c : await mover(tx, c, 'CONFIRMACION_PENDIENTE', 'listo_para_confirmar', { accion: 'confirmar', actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion });
    return vista(tx, f!);
  });
}

const Direccion = z.object({
  nombre: z.string().trim().min(1).max(60), apellido: z.string().trim().min(1).max(60), empresa: z.string().trim().min(1).max(120),
  direccion: z.string().trim().min(4).max(160), complemento: z.string().trim().max(80).optional(), ciudad: z.string().trim().min(2).max(60),
  departamento: z.string().trim().max(60).optional(), codigoPostal: z.string().trim().max(12).optional(), telefono: z.string().trim().max(20).optional(),
});
const Archivo = z.object({ nombre: z.string().trim().min(1).max(120).regex(/\.(pdf|png|jpe?g)$/i, 'Sube un PDF, PNG o JPG.'), base64: z.string().min(16) });

export async function enviarRequisitos(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permisoCompra(db, ctx);
  exigirCompraHabilitada();
  const c = await propia(db, ctx, id);
  if (c.estado !== 'SELECCION_NUMERO') throw new AppError('CONFLICT', 'Los requisitos de este número ya se enviaron.');
  const lista: Requisito[] = c.requisitos?.lista ?? [];
  const entrada = z.record(z.string(), z.unknown()).parse((body as any)?.valores ?? {});
  const valores: ValorRequisito[] = lista.map((r) => {
    const v = entrada[r.id];
    if (r.campo === 'textual') {
      const s = z.string().trim().min(1, `Completa «${r.nombre}».`).max(Number(r.criterios?.max_length) || 300).safeParse(v);
      if (!s.success) throw invalid(s.error.issues[0].message, { requisito: r.id });
      return { id: r.id, campo: 'textual', valor: s.data };
    }
    if (r.campo === 'address') {
      const s = Direccion.safeParse(v);
      if (!s.success) throw invalid(`Completa la dirección de «${r.nombre}».`, { requisito: r.id });
      return { id: r.id, campo: 'address', direccion: s.data };
    }
    const s = Archivo.safeParse(v);
    if (!s.success) throw invalid(s.error.issues[0]?.message ?? `Adjunta «${r.nombre}».`, { requisito: r.id });
    if (Buffer.byteLength(s.data.base64, 'base64') > LIMITE_DOCUMENTO) throw invalid('Cada documento puede pesar hasta 4 MB.', { requisito: r.id });
    return { id: r.id, campo: 'document', archivo: s.data };
  });
  const p = await proveedorNumeros();
  if (!p || p.nombre !== c.proveedor) throw new AppError('CONFLICT', 'El proveedor de este número no está disponible.');
  let grupo: { grupoId: string };
  try { grupo = await p.enviarRequisitos(c.pais, c.tipo_numero, valores, c.id); } catch {
    throw new AppError('CONFLICT', 'El proveedor no recibió los requisitos. Revisa los datos e intenta de nuevo.');
  }
  return db.withPlatform(async (tx) => {
    const f = await mover(tx, c, 'CONFIRMACION_PENDIENTE', 'requisitos_enviados', {
      de: ['SELECCION_NUMERO'], subestado: null, accion: 'confirmar', actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion,
      // Solo se guardan los identificadores del proveedor y el estado, nunca el documento ni la dirección.
      campos: { grupo_requisitos_id: grupo.grupoId, requisitos: { lista: lista.map(({ id, nombre, campo }) => ({ id, nombre, campo })), estado: 'enviados', enviados_en: new Date().toISOString() } },
      detalle: { requisitos: lista.length },
    });
    if (!f) throw new AppError('CONFLICT', 'La contratación cambió mientras enviabas los requisitos. Recarga la página.');
    return vista(tx, f);
  });
}

/** Si la reserva venció, se vuelve a consultar el número y su precio antes de cobrar. */
async function revalidar(db: Database, c: Fila): Promise<{ c: Fila; cambio: boolean }> {
  const vigente = c.reserva_expira_en && new Date(c.reserva_expira_en).getTime() > Date.now() + 2 * 60_000;
  const reciente = !c.reserva_id && Date.now() - new Date(c.cotizacion.creada_en).getTime() < MINUTOS_RESERVA * 60_000;
  if (vigente || reciente) return { c, cambio: false };
  const p = await proveedorNumeros();
  const tasa = await tasaUsdCop();
  if (!p || !tasa) throw new AppError('CONFLICT', 'No pudimos confirmar el precio en este momento. Intenta de nuevo en unos minutos.');
  const n = await p.consultar(c.numero_e164, c.pais, c.tipo_numero).catch(() => undefined);
  if (n === undefined) throw new AppError('CONFLICT', 'No pudimos confirmar la disponibilidad del número. Intenta de nuevo en unos minutos.');
  if (!n) {
    await db.withPlatform(async (tx) => { await mover(tx, c, 'CANCELADO', 'numero_ya_no_disponible', { de: ANTES_DEL_PAGO, subestado: 'numero_no_disponible', accion: 'elegir_otro', campos: { cancelado_en: new Date() } }); });
    throw new AppError('CONFLICT', 'El número que elegiste ya no está disponible. No se hizo ningún cobro: elige otro.', { elegir_otro: true });
  }
  let reserva: { id: string; expiraEn: Date } | null = null;
  if (n.reservable) reserva = await p.reservar(n.numero).catch(() => null);
  const cot = cotizar(n, p, tasa);
  const cambio = cot.total_hoy !== c.cotizacion.total_hoy || cot.total_mensual !== c.cotizacion.total_mensual;
  const f = await db.withPlatform((tx) => anotar(tx, c, { cotizacion: cot, reserva_id: reserva?.id ?? null, reserva_expira_en: reserva?.expiraEn ?? null }, cambio ? 'precio_actualizado' : undefined, cambio ? { antes: c.cotizacion.total_hoy, ahora: cot.total_hoy } : {}));
  return { c: f, cambio };
}

const Confirmacion = z.object({
  total_hoy: z.number().int().positive(), total_mensual: z.number().int().positive(),
  acepto_cargo: z.literal(true, { message: 'Confirma el cargo de hoy.' }),
  acepto_mensualidad: z.literal(true, { message: 'Confirma la mensualidad del número.' }),
  acepto_condiciones: z.literal(true, { message: 'Acepta las condiciones de renovación y cancelación.' }),
});
const VERSION_CONDICIONES = 'numeros-2026-10';

export async function confirmar(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permisoCompra(db, ctx);
  exigirCompraHabilitada();
  const b = Confirmacion.safeParse(body);
  if (!b.success) throw invalid(b.error.issues[0]?.message ?? 'Confirma las condiciones.');
  let c = await propia(db, ctx, id);
  if (!['CONFIRMACION_PENDIENTE', 'PAGO_PENDIENTE'].includes(c.estado)) throw new AppError('CONFLICT', c.estado === 'SELECCION_NUMERO' ? 'Primero envía los requisitos del número.' : 'Esta contratación ya no admite pagos.');
  const cuenta = cuentaPlataforma();
  if (!cuenta) throw new AppError('CONFLICT', 'Los pagos en línea están pendientes de conectar.');
  const r = await revalidar(db, c);
  c = r.c;
  // Lo que se cobra es exactamente lo que el cliente vio y aceptó.
  if (r.cambio || b.data.total_hoy !== c.cotizacion.total_hoy || b.data.total_mensual !== c.cotizacion.total_mensual) {
    throw new AppError('CONFLICT', 'El precio cambió desde que lo viste. Revisa el nuevo resumen antes de pagar.', { contratacion: await db.withPlatform((tx) => vista(tx, c)) });
  }
  const t = await db.withPlatform(async (tx) => (await tx.query(`SELECT slug, nombre, email_contacto FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]);
  const cot: Cotizacion = c.cotizacion;
  const concepto = `Número de WhatsApp ${c.numero_e164}: activación y primer mes`;
  const entorno = cuenta.proveedor === 'wompi' ? cuenta.entorno : null;
  return db.withPlatform(async (tx) => {
    const fila = await cargar(tx, c.id, true);
    if (!fila || !['CONFIRMACION_PENDIENTE', 'PAGO_PENDIENTE'].includes(fila.estado)) throw new AppError('CONFLICT', 'Esta contratación ya no admite pagos.');
    // Idempotencia: el mismo checkout vigente se reutiliza; nunca se generan dos cobros abiertos.
    let pago = (await tx.query(
      `SELECT referencia, expira_en FROM payment WHERE numero_contratacion_id=$1 AND cargo_numero='ACTIVACION' AND estado='PENDIENTE' AND monto=$2 AND proveedor=$3
         AND (expira_en IS NULL OR expira_en > now() + interval '5 minutes') ORDER BY creado_en DESC LIMIT 1`, [c.id, cot.total_hoy, cuenta.proveedor])).rows[0];
    if (!pago) {
      await tx.query(`UPDATE payment SET estado='REEMPLAZADO', actualizado_en=now() WHERE numero_contratacion_id=$1 AND estado='PENDIENTE'`, [c.id]);
      const fact = (await tx.query(`SELECT facturacion, documento_cifrado, facturacion_huella FROM payment WHERE tenant_id=$1 AND facturacion IS NOT NULL ORDER BY creado_en DESC LIMIT 1`, [ctx.tenantId])).rows[0];
      pago = { referencia: `NUM-${token(9)}`, expira_en: new Date(Date.now() + 60 * 60_000).toISOString() };
      await tx.query(
        `INSERT INTO payment (id, tenant_id, referencia, concepto, monto, estado, proveedor, modalidad, entorno, expira_en, numero_contratacion_id, cargo_numero, facturacion, documento_cifrado, facturacion_huella)
         VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6,'COMERCIAL',$7,$8,$9,'ACTIVACION',$10,$11,$12)`,
        [uuidv7(), ctx.tenantId, pago.referencia, concepto, cot.total_hoy, cuenta.proveedor, entorno, pago.expira_en, c.id,
          fact?.facturacion ? JSON.stringify(fact.facturacion) : null, fact?.documento_cifrado ?? null, fact?.facturacion_huella ?? null]);
    }
    const aceptacion = { version: VERSION_CONDICIONES, total_hoy: cot.total_hoy, total_mensual: cot.total_mensual, por: ctx.actor.id, nombre: ctx.actor.nombre, en: new Date().toISOString(), referencia: pago.referencia };
    if (fila.estado === 'CONFIRMACION_PENDIENTE') {
      await mover(tx, fila, 'PAGO_PENDIENTE', 'pago_iniciado', { subestado: null, accion: 'pagar', campos: { aceptacion }, actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion, detalle: { referencia: pago.referencia, monto: cot.total_hoy } });
    } else await anotar(tx, fila, { aceptacion });
    const volver = `${urlEmpresa(t.slug)}/whatsapp/numero`;
    const url = checkoutUrl(cuenta, { referencia: pago.referencia, montoCentavos: aCentavos(cot.total_hoy), redirectUrl: volver, expiraEn: cuenta.proveedor === 'wompi' ? new Date(pago.expira_en) : undefined, concepto, cliente: { email: t.email_contacto, nombre: t.nombre } });
    return { referencia: pago.referencia, monto: cot.total_hoy, url, proveedor: cuenta.proveedor };
  });
}

// ---------------------------------------------------------------------------
// Eventos de pago (desde billing.procesarEventoPago, dentro de su transacción)
// ---------------------------------------------------------------------------
const unMesDespues = (d: Date) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + 1); return x; };

export async function pagoNumeroAprobado(tx: Tx, pago: Fila, correlacion: string) {
  const c = await cargar(tx, pago.numero_contratacion_id, true);
  if (!c) return;
  const actor = { tipo: 'SISTEMA' as const, id: null, nombre: 'Pasarela' };
  if (pago.cargo_numero === 'ACTIVACION') {
    if (!['PAGO_PENDIENTE', 'CONFIRMACION_PENDIENTE'].includes(c.estado)) {
      // Pagó dos veces o pagó una contratación ya cancelada: se registra y se escala para reembolso.
      await registrarIncidente(tx, { codigo: 'NUMERO_PAGO_SIN_CONTRATACION', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: 'pago_activacion', proveedor: c.proveedor } });
      await anotar(tx, c, {}, 'pago_sobrante', { referencia: pago.referencia });
      return;
    }
    // El primer mes empieza cuando el proveedor entrega el número (ver evaluarOrden).
    await mover(tx, c, 'PAGO_CONFIRMADO', 'pago_confirmado', { subestado: null, accion: c.waba_id ? null : 'registro_meta', actor, origen: 'WEBHOOK', correlacion, detalle: { referencia: pago.referencia, monto: Number(pago.monto) } });
    await enqueue(tx, c.tenant_id, 'numero_aprovisionar', { contratacion_id: c.id }, { claveUnica: `num-aprov:${c.id}:${c.intentos}`, maxIntentos: 8 });
  } else {
    // Mensualidad: extiende desde el fin vigente (o desde hoy si ya venció).
    const base = c.periodo_fin && new Date(c.periodo_fin) > new Date() ? new Date(c.periodo_fin) : new Date();
    const fin = unMesDespues(base);
    await tx.query(`UPDATE payment SET cubre_hasta=$2 WHERE id=$1`, [pago.id, fin]);
    const vuelve = c.estado === 'CANCELACION_PENDIENTE' && c.subestado === 'impago' && !c.liberado_en;
    if (vuelve) await mover(tx, c, c.phone_number_id && c.conectado_en ? 'CONECTADO' : 'NUMERO_APROVISIONADO', 'mensualidad_reactiva', { subestado: null, accion: null, campos: { periodo_fin: fin, gracia_hasta: null }, actor, origen: 'WEBHOOK', correlacion, detalle: { referencia: pago.referencia } });
    else if (c.estado === 'CANCELADO') {
      await registrarIncidente(tx, { codigo: 'NUMERO_PAGO_SIN_CONTRATACION', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: 'pago_mensualidad', proveedor: c.proveedor } });
      return;
    } else await anotar(tx, c, { periodo_fin: fin, gracia_hasta: null }, 'mensualidad_pagada', { referencia: pago.referencia, hasta: fin.toISOString().slice(0, 10) });
  }
  // Comprobante del pago (sin validez fiscal mientras la facturación electrónica no esté habilitada).
  await encolarDocumentos(tx, pago.id);
}

export async function pagoNumeroNoAprobado(tx: Tx, pago: Fila, estado: string, correlacion: string) {
  const c = await cargar(tx, pago.numero_contratacion_id, true);
  if (!c) return;
  if (estado === 'PENDIENTE') {
    if (c.estado === 'PAGO_PENDIENTE' && c.subestado !== 'pago_en_proceso') await anotar(tx, c, { subestado: 'pago_en_proceso' }, 'pago_en_proceso', { referencia: pago.referencia });
    return;
  }
  if (pago.cargo_numero !== 'ACTIVACION' || c.estado !== 'PAGO_PENDIENTE') return;
  const otro = (await tx.query(`SELECT 1 FROM payment WHERE numero_contratacion_id=$1 AND estado='PENDIENTE' AND id<>$2 LIMIT 1`, [c.id, pago.id])).rows[0];
  if (otro) return;
  await mover(tx, c, 'CONFIRMACION_PENDIENTE', 'pago_rechazado', { subestado: estado === 'ANULADO' ? 'pago_anulado' : 'pago_rechazado', accion: 'confirmar', actor: { tipo: 'SISTEMA', id: null, nombre: 'Pasarela' }, origen: 'WEBHOOK', correlacion, detalle: { referencia: pago.referencia } });
}

// ---------------------------------------------------------------------------
// Trabajador: aprovisionamiento del número
// ---------------------------------------------------------------------------
/** Turno exclusivo para hablar con terceros sobre una contratación. */
export async function tomarTurno(db: Database, id: string): Promise<Fila | null> {
  return db.withPlatform(async (tx) => (await tx.query(
    `UPDATE numero_contratacion SET bloqueo_hasta=now() + interval '3 minutes' WHERE id=$1 AND (bloqueo_hasta IS NULL OR bloqueo_hasta < now()) RETURNING *`, [id])).rows[0] ?? null);
}
export const soltarTurno = (db: Database, id: string) => db.withPlatform((tx) => tx.query(`UPDATE numero_contratacion SET bloqueo_hasta=NULL WHERE id=$1`, [id]));

async function fallarAprovisionamiento(db: Database, c: Fila, subestado: string, mensaje: string, correlacion: string) {
  await db.withPlatform(async (tx) => {
    const f = await mover(tx, c, 'APROVISIONAMIENTO_FALLIDO', 'aprovisionamiento_fallido', {
      de: ['PAGO_CONFIRMADO', 'APROVISIONANDO_NUMERO'], subestado, accion: subestado === 'numero_no_disponible' ? 'elegir_otro' : 'contactar_soporte',
      campos: { ultimo_error: mensaje.slice(0, 300) }, correlacion,
    });
    if (f) await registrarIncidente(tx, { codigo: 'NUMERO_APROVISIONAMIENTO_FALLIDO', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: subestado, proveedor: c.proveedor } });
  });
}

export async function aprovisionar(db: Database, id: string, correlacion: string): Promise<void | 'reintentar'> {
  const c0 = await tomarTurno(db, id);
  if (!c0) return 'reintentar';
  try {
    if (!['PAGO_CONFIRMADO', 'APROVISIONANDO_NUMERO'].includes(c0.estado)) return;
    let c: Fila = c0;
    if (c.estado === 'PAGO_CONFIRMADO') {
      c = (await db.withPlatform((tx) => mover(tx, c0, 'APROVISIONANDO_NUMERO', 'aprovisionamiento_iniciado', { subestado: 'comprobando_disponibilidad', correlacion }))) ?? c0;
    }
    const p = await proveedorNumeros();
    if (!p || p.nombre !== c.proveedor) throw new Error('El proveedor del número no está disponible en este momento.');
    let orden: Orden | null = c.orden_id ? await p.consultarOrden(c.orden_id) : await p.ordenPorReferencia(c.id);
    if (!orden) {
      // Segunda comprobación de disponibilidad y de costo antes de comprar.
      const vigente = c.reserva_expira_en && new Date(c.reserva_expira_en).getTime() > Date.now();
      if (!vigente) {
        const n = await p.consultar(c.numero_e164, c.pais, c.tipo_numero);
        if (!n) return fallarAprovisionamiento(db, c, 'numero_no_disponible', 'El número ya no estaba disponible al comprarlo.', correlacion);
        const pagado = c.cotizacion.costo_proveedor;
        if (n.costo.moneda !== pagado.moneda || n.costo.activacion > pagado.activacion || n.costo.mensual > pagado.mensual) {
          return fallarAprovisionamiento(db, c, 'precio_cambio', 'El costo del proveedor subió después del pago.', correlacion);
        }
      }
      try {
        orden = await p.ordenar(c.numero_e164, { grupoId: c.grupo_requisitos_id, referencia: c.id });
      } catch (e) {
        if (e instanceof NumeroNoDisponible) return fallarAprovisionamiento(db, c, 'numero_no_disponible', e.message, correlacion);
        if (e instanceof ErrorProveedor && !e.reintentable) return fallarAprovisionamiento(db, c, 'error_proveedor', e.message, correlacion);
        throw e;
      }
      c = await db.withPlatform((tx) => anotar(tx, c, { orden_id: orden!.id, subestado: 'orden_creada' }, 'orden_creada', { orden: orden!.estado }));
    }
    return await evaluarOrden(db, p, c, orden, correlacion);
  } finally {
    await soltarTurno(db, id);
  }
}

async function evaluarOrden(db: Database, p: ProveedorNumeros, c: Fila, orden: Orden, correlacion: string): Promise<void | 'reintentar'> {
  if (orden.estado === 'fallo' || orden.estado === 'cancelada') {
    return fallarAprovisionamiento(db, c, orden.estado === 'cancelada' ? 'orden_cancelada' : 'orden_fallida', 'El proveedor no completó la orden del número.', correlacion);
  }
  if (orden.estado === 'pendiente') {
    const sub = orden.requisitos === 'rechazado' ? 'requisitos_rechazados' : orden.requisitos === 'pendiente' ? 'requisitos_incompletos' : 'documentos_en_revision';
    await db.withPlatform(async (tx) => {
      if (c.subestado !== sub) {
        await anotar(tx, c, { subestado: sub, accion_cliente: sub === 'documentos_en_revision' ? null : 'contactar_soporte' }, sub, { vence: orden.vence });
        if (sub !== 'documentos_en_revision') await registrarIncidente(tx, { codigo: 'NUMERO_REQUISITOS_RECHAZADOS', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: sub, proveedor: c.proveedor } });
      }
      // Respaldo del webhook del proveedor: se vuelve a consultar cada 30 minutos.
      await enqueue(tx, c.tenant_id, 'numero_seguimiento', { contratacion_id: c.id }, { claveUnica: `num-seg:${c.id}:${Math.floor(Date.now() / 1_800_000)}`, ejecutarEn: new Date(Date.now() + 30 * 60_000), maxIntentos: 3 });
    });
    return;
  }
  // Orden completada: el número existe en la cuenta del proveedor.
  const numeroId = c.numero_proveedor_id ?? (await p.idDelNumero(c.numero_e164));
  if (!numeroId) return 'reintentar';
  await db.withPlatform(async (tx) => {
    const ahora = new Date();
    const fin = unMesDespues(ahora);
    const f = await mover(tx, c, 'NUMERO_APROVISIONADO', 'numero_aprovisionado', { de: ['APROVISIONANDO_NUMERO'], subestado: null, campos: { numero_proveedor_id: numeroId, periodo_inicio: ahora, periodo_fin: fin }, correlacion });
    if (!f) return;
    await tx.query(`UPDATE payment SET cubre_hasta=$2 WHERE numero_contratacion_id=$1 AND cargo_numero='ACTIVACION' AND estado='APROBADO'`, [c.id, fin]);
    await siguientePasoWhatsApp(tx, f, correlacion);
  });
}

/** Con el número comprado: si el cliente ya hizo el registro con Meta, se verifica; si no, se le pide. */
async function siguientePasoWhatsApp(tx: Tx, c: Fila, correlacion: string) {
  const cred = await credencial(tx, c.id);
  if (c.waba_id && cred.token) {
    const f = await mover(tx, c, 'VERIFICACION_PENDIENTE', 'verificacion_iniciada', { de: ['NUMERO_APROVISIONADO', 'REGISTRO_WHATSAPP_PENDIENTE'], subestado: 'preparando', accion: null, correlacion });
    if (f) await encolarWhatsApp(tx, f, 'inicio');
  } else {
    await mover(tx, c, 'REGISTRO_WHATSAPP_PENDIENTE', 'registro_meta_pendiente', { de: ['NUMERO_APROVISIONADO'], subestado: null, accion: 'registro_meta', correlacion });
  }
}

const encolarWhatsApp = (tx: Tx, c: Fila, motivo: string, ejecutarEn?: Date) =>
  enqueue(tx, c.tenant_id, 'numero_whatsapp', { contratacion_id: c.id }, { claveUnica: `num-wa:${c.id}:${motivo}:${Date.now()}`, ejecutarEn, maxIntentos: 10 });

export async function seguimientoOrden(db: Database, id: string, correlacion: string): Promise<void | 'reintentar'> {
  const c = await db.withPlatform((tx) => cargar(tx, id));
  if (!c || c.estado !== 'APROVISIONANDO_NUMERO') return;
  if (!c.orden_id) return aprovisionar(db, id, correlacion);
  const turno = await tomarTurno(db, id);
  if (!turno) return 'reintentar';
  try {
    const p = await proveedorNumeros();
    if (!p || p.nombre !== c.proveedor) return 'reintentar';
    return await evaluarOrden(db, p, turno, await p.consultarOrden(c.orden_id), correlacion);
  } finally { await soltarTurno(db, id); }
}

// ---------------------------------------------------------------------------
// Registro con Meta (Embedded Signup) y verificación
// ---------------------------------------------------------------------------
export async function vincularMeta(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permisoCompra(db, ctx);
  const b = z.object({ code: z.string().min(8).max(2000), waba_id: z.string().regex(/^(\d{5,25}|sim-waba-[\w-]{3,40})$/, 'Cuenta de WhatsApp no válida.'), nombre_visible: z.string().trim().min(3).max(80).optional() }).parse(body);
  const c = await propia(db, ctx, id);
  if (!ADMITE_META.includes(c.estado)) throw new AppError('CONFLICT', 'Este paso no corresponde al estado actual de la contratación.');
  const meta = metaOnboarding();
  if (!meta) throw new AppError('CONFLICT', 'El registro integrado de Meta está pendiente de configurar en Omnegia. Escribe a soporte.');
  if (meta.simulado !== (c.entorno === 'simulado')) throw new AppError('CONFLICT', 'El registro de Meta no corresponde al entorno de este número.');
  let tk: string;
  try {
    tk = await meta.intercambiarCodigo(b.code);
    if (!(await meta.wabaAccesible(b.waba_id, tk))) throw new ErrorMeta('La cuenta de WhatsApp no corresponde al acceso concedido.', false);
  } catch (e) {
    throw new AppError('CONFLICT', e instanceof ErrorMeta ? `${e.message} Repite el registro con Meta.` : 'No pudimos confirmar el registro con Meta. Inténtalo de nuevo.');
  }
  return db.withPlatform(async (tx) => {
    const f0 = await cargar(tx, c.id, true);
    if (!f0 || !ADMITE_META.includes(f0.estado)) throw new AppError('CONFLICT', 'Este paso no corresponde al estado actual de la contratación.');
    await guardarCredencial(tx, f0, { token: tk });
    let f = await anotar(tx, f0, { waba_id: b.waba_id, nombre_visible: b.nombre_visible ?? f0.nombre_visible, whatsapp: { ...f0.whatsapp, suscrito: false, meta_en: new Date().toISOString() }, accion_cliente: f0.accion_cliente === 'registro_meta' ? null : f0.accion_cliente }, 'registro_meta_completado');
    await auditPlatform(tx, ctx.tenantId, actorDe(ctx), 'PANEL', ctx.correlacion, { accion: 'numero.registro_meta', recurso: 'numero_contratacion', recursoId: c.id, resultado: 'EXITO', detalle: { waba: b.waba_id } });
    if (f.estado === 'NUMERO_APROVISIONADO') await siguientePasoWhatsApp(tx, f, ctx.correlacion);
    else if (f.estado === 'REGISTRO_WHATSAPP_PENDIENTE' || f.estado === 'CONEXION_FALLIDA') {
      f = (await mover(tx, f, 'VERIFICACION_PENDIENTE', 'verificacion_iniciada', { de: ['REGISTRO_WHATSAPP_PENDIENTE', 'CONEXION_FALLIDA'], subestado: 'preparando', accion: null, actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion, campos: { verificacion: {} } })) ?? f;
      await encolarWhatsApp(tx, f, 'meta');
    }
    return vista(tx, f);
  });
}

/** Firma del enlace de la transcripción: solo Telnyx conoce la URL de cada contratación. */
export const firmaVoz = (id: string) => hmacHex(config.appKey, `voz:${id}`).slice(0, 32);

/** Código dictado por Meta en la llamada (transcripción de la aplicación TeXML). */
export async function capturarCodigo(db: Database, id: string, transcripcion: string, origen = 'llamada') {
  const codigo = codigoDeTranscripcion(transcripcion);
  if (!codigo) return { ok: false as const };
  return db.withPlatform(async (tx) => {
    const c = await cargar(tx, id, true);
    if (!c || c.estado !== 'VERIFICACION_PENDIENTE') return { ok: false as const };
    await guardarCredencial(tx, c, { codigo });
    // El código nunca va en la bitácora ni en la auditoría.
    const f = await anotar(tx, c, { subestado: 'codigo_recibido', accion_cliente: null }, 'codigo_recibido', { origen });
    await encolarWhatsApp(tx, f, 'codigo');
    return { ok: true as const };
  });
}

export async function codigoManual(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permisoCompra(db, ctx);
  const b = z.object({ codigo: z.string().regex(/^\d{3}-?\d{3}$/, 'El código tiene 6 dígitos.') }).parse(body);
  const c = await propia(db, ctx, id);
  if (c.estado !== 'VERIFICACION_PENDIENTE') throw new AppError('CONFLICT', 'El número no está esperando un código.');
  const r = await capturarCodigo(db, id, b.codigo.replace('-', ''), 'cliente');
  if (!r.ok) throw new AppError('CONFLICT', 'El número no está esperando un código.');
  return db.withPlatform(async (tx) => vista(tx, (await cargar(tx, id))!));
}

export async function pedirOtraLlamada(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permisoCompra(db, ctx);
  const b = z.object({ reenviar_a: z.string().regex(/^\+[1-9]\d{6,14}$/, 'Escribe el celular con indicativo, por ejemplo +573001234567.').nullable().optional() }).parse(body ?? {});
  const c = await propia(db, ctx, id);
  if (c.estado !== 'VERIFICACION_PENDIENTE') throw new AppError('CONFLICT', 'El número no está esperando una llamada de verificación.');
  const v = c.verificacion ?? {};
  if ((v.llamadas ?? 0) >= MAX_LLAMADAS) throw new AppError('CONFLICT', 'Meta limita las llamadas de verificación. Escribe a soporte para continuar.');
  if (v.solicitado_en && Date.now() - new Date(v.solicitado_en).getTime() < 60_000) throw new AppError('CONFLICT', 'Espera un minuto antes de pedir otra llamada.');
  return db.withPlatform(async (tx) => {
    const f0 = await cargar(tx, id, true);
    await guardarCredencial(tx, f0!, { codigo: null });
    const f = await anotar(tx, f0!, { verificacion: { ...f0!.verificacion, pedir_otra: true, reenviar_a: b.reenviar_a ?? null }, subestado: 'preparando', accion_cliente: null }, 'nueva_llamada', { reenvio: !!b.reenviar_a });
    await encolarWhatsApp(tx, f, 'llamada');
    return vista(tx, f);
  });
}

export async function reintentarConexion(db: Database, ctx: Ctx, id: string) {
  await permisoCompra(db, ctx);
  const c = await propia(db, ctx, id);
  if (c.estado !== 'CONEXION_FALLIDA') throw new AppError('CONFLICT', 'No hay una conexión fallida que reintentar.');
  return db.withPlatform(async (tx) => {
    const cred = await credencial(tx, id);
    if (!cred.token) {
      const f = await mover(tx, c, 'REGISTRO_WHATSAPP_PENDIENTE', 'reintento', { subestado: null, accion: 'registro_meta', actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion });
      return vista(tx, f!);
    }
    const destino: Estado = c.whatsapp?.verificado ? 'CONEXION_PENDIENTE' : 'VERIFICACION_PENDIENTE';
    const f = await mover(tx, c, destino, 'reintento', { subestado: 'preparando', accion: null, actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion, campos: { whatsapp: { ...c.whatsapp, intentos_conexion: 0 }, verificacion: c.whatsapp?.verificado ? c.verificacion : {} } });
    await encolarWhatsApp(tx, f!, 'reintento');
    return vista(tx, f!);
  });
}

async function fallarConexion(db: Database, c: Fila, mensaje: string, correlacion: string, accion = 'reintentar') {
  await db.withPlatform(async (tx) => {
    const f = await mover(tx, c, 'CONEXION_FALLIDA', 'conexion_fallida', { de: ['VERIFICACION_PENDIENTE', 'CONEXION_PENDIENTE'], subestado: 'meta_rechazo', accion, campos: { ultimo_error: mensaje.slice(0, 300) }, correlacion });
    if (f) await registrarIncidente(tx, { codigo: 'NUMERO_CONEXION_FALLIDA', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: 'whatsapp', proveedor: c.proveedor } });
  });
}

export const pinNuevo = () => String(randomInt(100000, 1_000_000));

/** Trabajador: lleva el número de «comprado» a «conectado» con la Graph API, paso a paso y sin repetir. */
export async function pasoWhatsApp(db: Database, id: string, correlacion: string): Promise<void | 'reintentar'> {
  const c0 = await tomarTurno(db, id);
  if (!c0) return 'reintentar';
  let c: Fila = c0;
  try {
    if (!['VERIFICACION_PENDIENTE', 'CONEXION_PENDIENTE'].includes(c.estado)) return;
    const meta = metaOnboarding();
    if (!meta) return fallarConexion(db, c, 'El registro integrado de Meta no está configurado en el servidor.', correlacion, 'contactar_soporte');
    const cred = await db.withPlatform((tx) => credencial(tx, id));
    if (!cred.token || !c.waba_id) {
      await db.withPlatform((tx) => mover(tx, c, 'REGISTRO_WHATSAPP_PENDIENTE', 'registro_meta_pendiente', { de: ['VERIFICACION_PENDIENTE', 'CONEXION_PENDIENTE'], accion: 'registro_meta', subestado: null, correlacion }));
      return;
    }
    const tk = cred.token;
    const wa = { ...(c.whatsapp ?? {}) };
    const guardarWa = async (extra: Record<string, unknown> = {}) => { c = await db.withPlatform((tx) => anotar(tx, c, { whatsapp: wa, ...extra })); };
    if (!wa.suscrito) { await meta.suscribirApp(c.waba_id, tk); wa.suscrito = true; await guardarWa(); }
    if (!c.phone_number_id) {
      const cc = INDICATIVO[c.pais] ?? '';
      const nacional = c.numero_e164.replace(/^\+/, '').slice(cc.length);
      let pid: string | null = null;
      try { pid = await meta.agregarNumero(c.waba_id, tk, { cc, numero: nacional, nombre: c.nombre_visible ?? 'Mi negocio' }); } catch (e) {
        // Si el número ya estaba en la WABA (reintento tras una caída), se recupera su identificador.
        pid = await meta.buscarNumero(c.waba_id, tk, c.numero_e164).catch(() => null);
        if (!pid) throw e;
      }
      await guardarWa({ phone_number_id: pid });
    }
    if (c.estado === 'VERIFICACION_PENDIENTE') {
      const v = { ...(c.verificacion ?? {}) };
      if (wa.verificado) {
        c = (await db.withPlatform((tx) => mover(tx, c, 'CONEXION_PENDIENTE', 'numero_verificado', { subestado: 'registrando', accion: null, correlacion }))) ?? c;
      } else if (cred.codigo) {
        const ok = await meta.verificarCodigo(c.phone_number_id, tk, cred.codigo);
        await db.withPlatform((tx) => guardarCredencial(tx, c, { codigo: null }));
        if (!ok) {
          v.fallos = (v.fallos ?? 0) + 1;
          c = await db.withPlatform((tx) => anotar(tx, c, { verificacion: v, subestado: 'codigo_incorrecto', accion_cliente: 'verificacion_manual' }, 'codigo_incorrecto'));
          return;
        }
        wa.verificado = true;
        await guardarWa();
        c = (await db.withPlatform((tx) => mover(tx, c, 'CONEXION_PENDIENTE', 'numero_verificado', { subestado: 'registrando', accion: null, correlacion }))) ?? c;
      } else if (!v.solicitado_en || v.pedir_otra) {
        await meta.solicitarCodigo(c.phone_number_id, tk);
        Object.assign(v, { solicitado_en: new Date().toISOString(), llamadas: (v.llamadas ?? 0) + 1, pedir_otra: false });
        c = await db.withPlatform((tx) => anotar(tx, c, { verificacion: v, subestado: 'esperando_llamada', accion_cliente: null }, 'llamada_solicitada', { llamada: v.llamadas, reenvio: !!v.reenviar_a }));
        const dictado = meta.simulado ? meta.llamadaSimulada?.() : null;
        if (dictado) {
          // Simulación: no hay llamada real; se transcribe la que Meta haría.
          await soltarTurno(db, id);
          await capturarCodigo(db, id, dictado, 'simulacion');
        }
        return;
      } else {
        if (Date.now() - new Date(v.solicitado_en).getTime() > MINUTOS_LLAMADA * 60_000 && c.accion_cliente !== 'verificacion_manual') {
          await db.withPlatform((tx) => anotar(tx, c, { subestado: 'sin_codigo', accion_cliente: 'verificacion_manual' }, 'llamada_sin_codigo'));
        }
        return;
      }
    }
    if (c.estado !== 'CONEXION_PENDIENTE') return;
    if (!wa.registrado) {
      const pin = cred.pin ?? pinNuevo();
      if (!cred.pin) await db.withPlatform((tx) => guardarCredencial(tx, c, { pin }));
      await meta.registrar(c.phone_number_id, tk, pin);
      wa.registrado = true;
      await guardarWa();
    }
    // Se vincula a la empresa y se comprueba en Meta antes de mostrarlo como conectado.
    const d = await meta.consultar(c.phone_number_id, tk);
    const operativo = d.estado === 'CONNECTED' && d.verificacion !== 'NOT_VERIFIED';
    await db.withPlatform(async (tx) => {
      await vincularEmpresa(tx, c, d, operativo, meta.simulado);
      wa.estado_meta = d.estado; wa.estado_nombre = d.estadoNombre; wa.calidad = d.calidad;
      if (operativo) {
        await mover(tx, c, 'CONECTADO', 'whatsapp_conectado', { de: ['CONEXION_PENDIENTE'], subestado: null, accion: 'prueba', campos: { whatsapp: wa, conectado_en: new Date(), ultimo_error: null }, correlacion, detalle: { estado_nombre: d.estadoNombre } });
      } else {
        wa.intentos_conexion = (wa.intentos_conexion ?? 0) + 1;
        const f = await anotar(tx, c, { whatsapp: wa, subestado: 'esperando_meta' }, 'conexion_en_espera', { estado: d.estado });
        if (wa.intentos_conexion < MAX_INTENTOS_CONEXION) await encolarWhatsApp(tx, f, 'espera', new Date(Date.now() + 2 * 60_000));
        c = f;
      }
    });
    if (!operativo && (wa.intentos_conexion ?? 0) >= MAX_INTENTOS_CONEXION) return fallarConexion(db, c, `Meta reporta el número como ${d.estado ?? 'no conectado'}.`, correlacion);
  } catch (e) {
    if (e instanceof ErrorMeta) {
      if (e.codigo === 190 || e.codigo === 200) {
        await db.withPlatform((tx) => mover(tx, c, 'REGISTRO_WHATSAPP_PENDIENTE', 'acceso_meta_vencido', { de: ['VERIFICACION_PENDIENTE', 'CONEXION_PENDIENTE'], subestado: 'acceso_vencido', accion: 'registro_meta', campos: { ultimo_error: e.message }, correlacion }));
        return;
      }
      if (!e.reintentable) return fallarConexion(db, c, e.message, correlacion);
    }
    throw e;
  } finally {
    await soltarTurno(db, id);
  }
}

/**
 * Deja el número en la empresa: desde aquí channelInbound enruta sus mensajes a la IA de este tenant.
 * Solo se marca CONECTADO (o SIMULADO) cuando Meta lo reporta operativo.
 */
export async function vincularEmpresa(tx: Tx, c: Fila, d: DatosNumeroMeta, operativo: boolean, simulado: boolean) {
  const diagnostico = { ok: operativo, numero: d.numero, nombre: d.nombre, calidad: d.calidad, estado_nombre: d.estadoNombre, comprobado: new Date().toISOString() };
  await tx.query(
    `UPDATE tenant SET whatsapp_phone_number_id=$2, whatsapp_estado=$3, whatsapp_numero_visible=coalesce($4, whatsapp_numero_visible), whatsapp_diagnostico=$5,
       whatsapp_verificado_en=CASE WHEN $6 THEN now() ELSE whatsapp_verificado_en END WHERE id=$1`,
    [c.tenant_id, c.phone_number_id, operativo ? (simulado ? 'SIMULADO' : 'CONECTADO') : 'PENDIENTE_VERIFICAR', simulado ? c.numero_e164 : d.numero ?? c.numero_e164, JSON.stringify(diagnostico), operativo]);
  cacheTokens.delete(c.phone_number_id);
}

/** Primer mensaje recibido en el número conectado: la prueba de punta a punta (llega y lo atiende la IA). */
export async function marcarPrueba(db: Database, tenantId: string, de: string) {
  await db.withPlatform(async (tx) => {
    const c = (await tx.query(`SELECT * FROM numero_contratacion WHERE tenant_id=$1 AND estado='CONECTADO' AND prueba_recibida_en IS NULL FOR UPDATE`, [tenantId])).rows[0];
    if (c) await anotar(tx, c, { prueba_recibida_en: new Date(), accion_cliente: null }, 'prueba_recibida', { de: `···${de.slice(-4)}` });
  });
}

// ---------------------------------------------------------------------------
// Cambio de número tras un fallo, renovación y cancelación
// ---------------------------------------------------------------------------
export async function elegirOtro(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permisoCompra(db, ctx);
  const b = z.object({ numero: z.string().regex(/^\+[1-9]\d{6,14}$/) }).parse(body);
  const c = await propia(db, ctx, id);
  if (c.estado !== 'APROVISIONAMIENTO_FALLIDO' || c.subestado !== 'numero_no_disponible') throw new AppError('CONFLICT', 'Solo puedes cambiar de número si el que pagaste no se pudo comprar.');
  const p = await proveedorNumeros();
  const tasa = await tasaUsdCop();
  if (!p || p.nombre !== c.proveedor || !tasa) throw new AppError('CONFLICT', 'No pudimos consultar el proveedor. Intenta de nuevo en unos minutos.');
  const n = await p.consultar(b.numero, c.pais, c.tipo_numero).catch(() => null);
  if (!n || !elegibleWhatsApp(n).ok) throw new AppError('CONFLICT', 'Ese número no está disponible. Elige otro.');
  const cot = cotizar(n, p, tasa);
  // Lo ya pagado cubre el nuevo número solo si no cuesta más, hoy ni cada mes.
  if (cot.total_hoy > c.cotizacion.total_hoy || cot.total_mensual > c.cotizacion.total_mensual) throw new AppError('CONFLICT', 'Ese número cuesta más que el que pagaste. Elige uno de igual o menor precio, o pide el reembolso.');
  const reserva = n.reservable ? await p.reservar(n.numero).catch(() => null) : null;
  return db.withPlatform(async (tx) => {
    const congelada = { ...c.cotizacion, costo_proveedor: n.costo, numero_original: c.numero_e164 };
    const f = await mover(tx, c, 'PAGO_CONFIRMADO', 'numero_reemplazado', {
      de: ['APROVISIONAMIENTO_FALLIDO'], subestado: null, accion: c.waba_id ? null : 'registro_meta', actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion,
      campos: { numero_e164: n.numero, localidad: n.localidad, caracteristicas: n.caracteristicas, cotizacion: congelada, reserva_id: reserva?.id ?? null, reserva_expira_en: reserva?.expiraEn ?? null, orden_id: null, intentos: c.intentos + 1, ultimo_error: null },
    });
    if (!f) throw new AppError('CONFLICT', 'La contratación cambió. Recarga la página.');
    await enqueue(tx, c.tenant_id, 'numero_aprovisionar', { contratacion_id: c.id }, { claveUnica: `num-aprov:${c.id}:${f.intentos}`, maxIntentos: 8 });
    return vista(tx, f);
  });
}

export async function renovar(db: Database, ctx: Ctx, id: string) {
  await permisoCompra(db, ctx);
  const c = await propia(db, ctx, id);
  const cuenta = cuentaPlataforma();
  if (!cuenta) throw new AppError('CONFLICT', 'Los pagos en línea están pendientes de conectar.');
  if (!c.periodo_fin || (!CON_MENSUALIDAD.includes(c.estado) && !(c.estado === 'CANCELACION_PENDIENTE' && c.subestado === 'impago' && !c.liberado_en))) throw new AppError('CONFLICT', 'Este número no admite renovación.');
  if (c.periodo_fin && new Date(c.periodo_fin).getTime() - Date.now() > 10 * 86_400_000) throw new AppError('CONFLICT', 'La mensualidad se puede pagar desde 10 días antes del vencimiento.');
  const t = await db.withPlatform(async (tx) => (await tx.query(`SELECT slug, nombre, email_contacto FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0]);
  const monto = Number(c.cotizacion.total_mensual);
  const concepto = `Mensualidad del número de WhatsApp ${c.numero_e164}`;
  return db.withPlatform(async (tx) => {
    let pago = (await tx.query(`SELECT referencia, expira_en FROM payment WHERE numero_contratacion_id=$1 AND cargo_numero='MENSUALIDAD' AND estado='PENDIENTE' AND monto=$2 AND proveedor=$3 AND (expira_en IS NULL OR expira_en > now() + interval '5 minutes') LIMIT 1`, [c.id, monto, cuenta.proveedor])).rows[0];
    if (!pago) {
      const fact = (await tx.query(`SELECT facturacion, documento_cifrado, facturacion_huella FROM payment WHERE tenant_id=$1 AND facturacion IS NOT NULL ORDER BY creado_en DESC LIMIT 1`, [ctx.tenantId])).rows[0];
      pago = { referencia: `NUM-${token(9)}`, expira_en: new Date(Date.now() + 60 * 60_000).toISOString() };
      await tx.query(
        `INSERT INTO payment (id, tenant_id, referencia, concepto, monto, estado, proveedor, modalidad, entorno, expira_en, numero_contratacion_id, cargo_numero, facturacion, documento_cifrado, facturacion_huella)
         VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6,'COMERCIAL',$7,$8,$9,'MENSUALIDAD',$10,$11,$12)`,
        [uuidv7(), ctx.tenantId, pago.referencia, concepto, monto, cuenta.proveedor, cuenta.proveedor === 'wompi' ? cuenta.entorno : null, pago.expira_en, c.id,
          fact?.facturacion ? JSON.stringify(fact.facturacion) : null, fact?.documento_cifrado ?? null, fact?.facturacion_huella ?? null]);
      await auditPlatform(tx, ctx.tenantId, actorDe(ctx), 'PANEL', ctx.correlacion, { accion: 'numero.mensualidad_checkout', recurso: 'numero_contratacion', recursoId: c.id, resultado: 'EXITO', detalle: { referencia: pago.referencia, monto } });
    }
    const url = checkoutUrl(cuenta, { referencia: pago.referencia, montoCentavos: aCentavos(monto), redirectUrl: `${urlEmpresa(t.slug)}/whatsapp/numero`, expiraEn: cuenta.proveedor === 'wompi' ? new Date(pago.expira_en) : undefined, concepto, cliente: { email: t.email_contacto, nombre: t.nombre } });
    return { referencia: pago.referencia, monto, url, proveedor: cuenta.proveedor };
  });
}

export async function cancelar(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permisoCompra(db, ctx);
  const b = z.object({ motivo: z.string().trim().max(300).optional(), revertir: z.boolean().optional() }).parse(body ?? {});
  const c = await propia(db, ctx, id);
  return db.withPlatform(async (tx) => {
    const a = { actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion };
    if (b.revertir) {
      if (c.estado !== 'CANCELACION_PENDIENTE' || c.subestado !== 'solicitada' || c.liberado_en) throw new AppError('CONFLICT', 'No hay una cancelación que revertir.');
      const previo = (c.verificacion?.estado_previo as Estado | undefined) ?? 'CONECTADO';
      const f = await mover(tx, c, previo, 'cancelacion_revertida', { subestado: null, accion: null, campos: { cancelacion_solicitada_en: null }, ...a });
      return vista(tx, f!);
    }
    if (ANTES_DEL_PAGO.includes(c.estado)) {
      // Sin pago no hay nada que liberar: la reserva del proveedor vence sola.
      await tx.query(`UPDATE payment SET estado='REEMPLAZADO', actualizado_en=now() WHERE numero_contratacion_id=$1 AND estado='PENDIENTE'`, [c.id]);
      const f = await mover(tx, c, 'CANCELADO', 'cancelada_antes_del_pago', { subestado: 'abandonada', accion: null, campos: { cancelado_en: new Date(), cancelacion_solicitada_en: new Date() }, detalle: { motivo: b.motivo ? 'indicado' : 'sin_motivo' }, ...a });
      return vista(tx, f!);
    }
    if (c.estado === 'APROVISIONAMIENTO_FALLIDO' && !c.numero_proveedor_id) {
      // El número nunca se compró: no hay mensualidad que mantener. El reembolso se pide por la vía legal.
      const f = await mover(tx, c, 'CANCELADO', 'cancelada_sin_numero', { subestado: 'reembolso_disponible', accion: 'reembolso', campos: { cancelado_en: new Date(), cancelacion_solicitada_en: new Date() }, ...a });
      return vista(tx, f!);
    }
    if (c.estado === 'CANCELACION_PENDIENTE' || c.estado === 'CANCELADO') throw new AppError('CONFLICT', 'La cancelación ya está en curso.');
    // Con el número pagado: el servicio sigue hasta el fin del periodo pagado y entonces se libera.
    const f = await mover(tx, c, 'CANCELACION_PENDIENTE', 'cancelacion_solicitada', { subestado: 'solicitada', accion: null, campos: { cancelacion_solicitada_en: new Date(), verificacion: { ...c.verificacion, estado_previo: c.estado } }, detalle: { efectiva: c.periodo_fin }, ...a });
    return vista(tx, f!);
  });
}

/** Libera el número en el proveedor y en WhatsApp (contratación cancelada o impaga). */
export async function liberar(db: Database, id: string, correlacion: string): Promise<void | 'reintentar'> {
  const c = await tomarTurno(db, id);
  if (!c) return 'reintentar';
  try {
    if (c.estado !== 'CANCELACION_PENDIENTE' || c.liberado_en) return;
    const cred = await db.withPlatform((tx) => credencial(tx, id));
    const meta = metaOnboarding();
    if (meta && cred.token && c.phone_number_id && c.whatsapp?.registrado) await meta.desregistrar(c.phone_number_id, cred.token).catch(() => undefined);
    const p = await proveedorNumeros();
    if (!p || p.nombre !== c.proveedor) throw new Error('Proveedor no disponible para liberar el número.');
    // Una orden que el proveedor completó después de cancelar también se libera.
    const numeroId = c.numero_proveedor_id ?? (c.orden_id ? await p.idDelNumero(c.numero_e164) : null);
    if (!numeroId && c.orden_id && (await p.consultarOrden(c.orden_id).catch(() => null))?.estado === 'pendiente') {
      await db.withPlatform((tx) => registrarIncidente(tx, { codigo: 'NUMERO_LIBERACION_FALLIDA', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: 'orden_pendiente', proveedor: c.proveedor } }));
    }
    if (numeroId) {
      try { await p.liberar(numeroId); } catch (e) {
        if (e instanceof ErrorProveedor && e.reintentable) throw e;
        await db.withPlatform((tx) => registrarIncidente(tx, { codigo: 'NUMERO_LIBERACION_FALLIDA', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { proveedor: c.proveedor } }));
        return;
      }
    }
    await db.withPlatform(async (tx) => {
      await tx.query(`UPDATE tenant SET whatsapp_phone_number_id=NULL, whatsapp_estado='SIN_CONFIGURAR', whatsapp_numero_visible=NULL, whatsapp_diagnostico=NULL, whatsapp_verificado_en=NULL WHERE id=$1 AND whatsapp_phone_number_id=$2`, [c.tenant_id, c.phone_number_id ?? '']);
      await tx.query(`UPDATE numero_credencial SET token_cifrado=NULL, pin_cifrado=NULL, codigo_cifrado=NULL, actualizado_en=now() WHERE contratacion_id=$1`, [id]);
      if (c.phone_number_id) cacheTokens.delete(c.phone_number_id);
      // Sin número entregado no se prestó el servicio: queda disponible el reembolso por la vía legal.
      await mover(tx, c, 'CANCELADO', numeroId ? 'numero_liberado' : 'cancelada_sin_numero', { de: ['CANCELACION_PENDIENTE'], subestado: numeroId ? c.subestado : 'reembolso_disponible', accion: numeroId ? null : 'reembolso', campos: { liberado_en: numeroId ? new Date() : null, cancelado_en: new Date() }, correlacion });
    });
  } finally { await soltarTurno(db, id); }
}

/** Ciclo periódico: avisos de renovación, gracia, liberación, abandonos y llamadas sin código. */
export async function ciclo(db: Database, correlacion: string) {
  const g = config.numeros.graciaDias;
  const r = await db.withPlatform(async (tx) => {
    // Altas abandonadas antes del pago (la reserva del proveedor ya venció).
    const abandonadas = (await tx.query(`SELECT * FROM numero_contratacion WHERE estado IN ('SELECCION_NUMERO','CONFIRMACION_PENDIENTE','NUMERO_INGRESADO','CODIGO_ENVIADO') AND actualizado_en < now() - interval '48 hours' LIMIT 50`)).rows;
    for (const c of abandonadas) await mover(tx, c, 'CANCELADO', 'abandonada', { subestado: 'abandonada', accion: null, campos: { cancelado_en: new Date() }, correlacion });
    const pendientesPago = (await tx.query(`SELECT * FROM numero_contratacion WHERE estado='PAGO_PENDIENTE' AND actualizado_en < now() - interval '72 hours'
                                              AND NOT EXISTS (SELECT 1 FROM payment p WHERE p.numero_contratacion_id=numero_contratacion.id AND p.estado='PENDIENTE' AND (p.expira_en IS NULL OR p.expira_en > now())) LIMIT 50`)).rows;
    for (const c of pendientesPago) await mover(tx, c, 'CANCELADO', 'abandonada', { subestado: 'pago_no_completado', accion: null, campos: { cancelado_en: new Date() }, correlacion });
    // Vencidos: entran en gracia; vencida la gracia, se programa la liberación por impago.
    const vencidos = (await tx.query(`SELECT * FROM numero_contratacion WHERE estado = ANY($1::text[]) AND periodo_fin < now() AND gracia_hasta IS NULL LIMIT 50`, [CON_MENSUALIDAD])).rows;
    for (const c of vencidos) {
      const hasta = new Date(new Date(c.periodo_fin).getTime() + g * 86_400_000);
      await anotar(tx, c, { gracia_hasta: hasta, accion_cliente: 'renovar' }, 'en_gracia', { hasta: hasta.toISOString().slice(0, 10) });
      await avisar(tx, c, 'La mensualidad de tu número de WhatsApp venció', [`Tu número ${c.numero_e164} sigue activo hasta el ${hasta.toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}.`, 'Si no se paga la mensualidad antes de esa fecha, el número se libera y deja de recibir mensajes.'], `gracia:${c.id}:${c.periodo_fin}`);
    }
    const impagos = (await tx.query(`SELECT * FROM numero_contratacion WHERE estado = ANY($1::text[]) AND gracia_hasta < now() LIMIT 50`, [CON_MENSUALIDAD])).rows;
    for (const c of impagos) await mover(tx, c, 'CANCELACION_PENDIENTE', 'impago', { subestado: 'impago', accion: null, campos: { cancelacion_solicitada_en: new Date() }, correlacion });
    // Aviso previo: 5 días antes del vencimiento (una vez por periodo).
    const porVencer = (await tx.query(`SELECT * FROM numero_contratacion WHERE estado = ANY($1::text[]) AND periodo_fin BETWEEN now() AND now() + interval '5 days'`, [CON_MENSUALIDAD])).rows;
    for (const c of porVencer) await avisar(tx, c, 'Se acerca la mensualidad de tu número de WhatsApp', [`La mensualidad de ${c.numero_e164} vence el ${new Date(c.periodo_fin).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' })}: ${cop(Number(c.cotizacion.total_mensual))}.`, 'No hay cobros automáticos: págala desde el panel cuando quieras.'], `previo:${c.id}:${c.periodo_fin}`);
    // Cancelaciones que llegaron a su fecha efectiva, y llamadas de verificación que no trajeron código.
    const aLiberar = (await tx.query(`SELECT id, tenant_id FROM numero_contratacion WHERE estado='CANCELACION_PENDIENTE' AND liberado_en IS NULL AND (subestado='impago' OR periodo_fin IS NULL OR periodo_fin < now()) LIMIT 50`)).rows;
    for (const c of aLiberar) await enqueue(tx, c.tenant_id, 'numero_liberar', { contratacion_id: c.id }, { claveUnica: `num-lib:${c.id}`, maxIntentos: 8 });
    const sinCodigo = (await tx.query(`SELECT id, tenant_id FROM numero_contratacion WHERE estado='VERIFICACION_PENDIENTE' AND subestado='esperando_llamada' AND (verificacion->>'solicitado_en')::timestamptz < now() - ($1 || ' minutes')::interval`, [String(MINUTOS_LLAMADA)])).rows;
    for (const c of sinCodigo) await enqueue(tx, c.tenant_id, 'numero_whatsapp', { contratacion_id: c.id }, { claveUnica: `num-wa:${c.id}:sin-codigo`, maxIntentos: 2 });
    // Recuperación tras una caída o reintentos agotados: se retoma lo que quedó a mitad sin acción del cliente.
    const hora = Math.floor(Date.now() / 3_600_000);
    const detenidas = (await tx.query(
      `SELECT id, tenant_id, estado, orden_id FROM numero_contratacion
        WHERE ((estado='PAGO_CONFIRMADO' AND actualizado_en < now() - interval '15 minutes')
            OR (estado='APROVISIONANDO_NUMERO' AND actualizado_en < now() - interval '1 hour')
            OR (estado IN ('VERIFICACION_PENDIENTE','CONEXION_PENDIENTE','CODIGO_VERIFICADO','REGISTRADO') AND accion_cliente IS NULL AND actualizado_en < now() - interval '30 minutes'))
          AND (bloqueo_hasta IS NULL OR bloqueo_hasta < now()) LIMIT 50`)).rows;
    for (const c of detenidas) {
      const tipo = c.estado === 'PAGO_CONFIRMADO' ? 'numero_aprovisionar' : c.estado === 'APROVISIONANDO_NUMERO' ? 'numero_seguimiento'
        : ['CODIGO_VERIFICADO', 'REGISTRADO'].includes(c.estado) ? 'numero_propio' : 'numero_whatsapp';
      await enqueue(tx, c.tenant_id, tipo, { contratacion_id: c.id }, { claveUnica: `num-rec:${c.id}:${hora}`, maxIntentos: 3 });
    }
    return { abandonadas: abandonadas.length + pendientesPago.length, gracia: vencidos.length, impagos: impagos.length, liberar: aLiberar.length, recuperadas: detenidas.length };
  });
  return r;
}

async function avisar(tx: Tx, c: Fila, titulo: string, lineas: string[], clave: string) {
  const t = (await tx.query(`SELECT nombre, slug, email_contacto FROM tenant WHERE id=$1`, [c.tenant_id])).rows[0];
  if (!t?.email_contacto) return;
  await encolarCorreo(tx, { tenantId: null, para: t.email_contacto, clave: `numero:${clave}`, correo: plantillas.alertaNegocio({ empresa: t.nombre, titulo, lineas, url: `${urlEmpresa(t.slug)}/whatsapp/numero` }) });
}

// ---------------------------------------------------------------------------
// Webhooks del proveedor
// ---------------------------------------------------------------------------
/** Evento de Telnyx (ya verificado): solo dispara una consulta servidor a servidor de la orden. */
export async function eventoProveedor(db: Database, ev: { id: string; tipo: string; ordenId: string | null; referencia: string | null }, correlacion: string) {
  return db.withPlatform(async (tx) => {
    const nuevo = (await tx.query(`INSERT INTO provisioning_event (event_id, tipo, referencia, payload, resultado) VALUES ($1,$2,$3,'{}','telnyx') ON CONFLICT DO NOTHING RETURNING event_id`, [`telnyx:${ev.id}`, ev.tipo.slice(0, 60), (ev.ordenId ?? ev.referencia ?? '').slice(0, 80)])).rows[0];
    if (!nuevo) return { ok: true, duplicado: true };
    const c = (await tx.query(`SELECT id, tenant_id, estado FROM numero_contratacion WHERE (orden_id=$1 AND $1 IS NOT NULL) OR (id::text=$2 AND $2 IS NOT NULL) LIMIT 1`, [ev.ordenId, ev.referencia && isUuid(ev.referencia) ? ev.referencia : null])).rows[0];
    if (!c) return { ok: true, ignorado: 'orden desconocida' };
    if (c.estado === 'APROVISIONANDO_NUMERO') await enqueue(tx, c.tenant_id, 'numero_seguimiento', { contratacion_id: c.id }, { claveUnica: `num-seg:${c.id}:ev:${ev.id}`, maxIntentos: 5 });
    return { ok: true };
  });
}

/** Llamada entrante al número: si espera verificación, se atiende y se transcribe (o se reenvía). */
export async function llamadaEntrante(db: Database, para: string): Promise<{ id: string; reenviarA: string | null } | null> {
  if (!/^\+[1-9]\d{6,14}$/.test(para)) return null;
  const c = await db.withPlatform(async (tx) => (await tx.query(`SELECT id, verificacion FROM numero_contratacion WHERE numero_e164=$1 AND estado='VERIFICACION_PENDIENTE' LIMIT 1`, [para])).rows[0]);
  return c ? { id: c.id, reenviarA: c.verificacion?.reenviar_a ?? null } : null;
}

export const firmaVozValida = (id: string, k: string) => isUuid(id) && typeof k === 'string' && safeEqual(k, firmaVoz(id));

// ---------------------------------------------------------------------------
// Vista para el panel
// ---------------------------------------------------------------------------
const ETAPAS = [
  { clave: 'pago', titulo: 'Confirmación del pago' },
  { clave: 'numero', titulo: 'Asignación del número' },
  { clave: 'meta', titulo: 'Preparación de la conexión' },
  { clave: 'verificacion', titulo: 'Registro y verificación de WhatsApp' },
  { clave: 'activacion', titulo: 'Activación en Omnegia' },
  { clave: 'prueba', titulo: 'Prueba de funcionamiento' },
] as const;
type EstadoEtapa = 'hecho' | 'en_curso' | 'accion' | 'error' | 'pendiente';

const ORDEN: Estado[] = ['SELECCION_NUMERO', 'CONFIRMACION_PENDIENTE', 'PAGO_PENDIENTE', 'PAGO_CONFIRMADO', 'APROVISIONANDO_NUMERO', 'NUMERO_APROVISIONADO', 'REGISTRO_WHATSAPP_PENDIENTE', 'VERIFICACION_PENDIENTE', 'CONEXION_PENDIENTE', 'CONECTADO'];

/** Cada etapa refleja solo lo que el servidor confirmó; nunca se adelanta un «hecho». */
function etapas(c: Fila) {
  const e = c.estado as Estado;
  const i = ORDEN.indexOf(e);
  const pagado = i >= 3 || ['APROVISIONAMIENTO_FALLIDO', 'CONEXION_FALLIDA'].includes(e) || (e === 'CANCELACION_PENDIENTE' && !!c.periodo_inicio);
  const comprado = !!c.numero_proveedor_id;
  const wa = c.whatsapp ?? {};
  const m: Record<string, EstadoEtapa> = {
    pago: pagado ? 'hecho' : e === 'PAGO_PENDIENTE' ? 'en_curso' : 'pendiente',
    numero: comprado ? 'hecho' : e === 'APROVISIONAMIENTO_FALLIDO' ? 'error' : ['PAGO_CONFIRMADO', 'APROVISIONANDO_NUMERO'].includes(e) ? (c.accion_cliente === 'contactar_soporte' ? 'accion' : 'en_curso') : 'pendiente',
    meta: c.waba_id ? 'hecho' : pagado && c.accion_cliente === 'registro_meta' ? 'accion' : 'pendiente',
    verificacion: wa.verificado ? 'hecho' : e === 'VERIFICACION_PENDIENTE' ? (c.accion_cliente === 'verificacion_manual' ? 'accion' : 'en_curso') : e === 'CONEXION_FALLIDA' && !wa.verificado ? 'error' : 'pendiente',
    activacion: e === 'CONECTADO' || (c.conectado_en && e === 'CANCELACION_PENDIENTE') ? 'hecho' : e === 'CONEXION_PENDIENTE' ? 'en_curso' : e === 'CONEXION_FALLIDA' && wa.verificado ? 'error' : 'pendiente',
    prueba: c.prueba_recibida_en ? 'hecho' : e === 'CONECTADO' ? 'accion' : 'pendiente',
  };
  return ETAPAS.map((x) => ({ ...x, estado: m[x.clave] }));
}

async function vista(tx: Tx, c: Fila) {
  if (c.origen === 'PROPIO') return vistaPropio(tx, c);
  const eventos = (await tx.query(`SELECT de, a, tipo, detalle, creado_en FROM numero_evento WHERE contratacion_id=$1 ORDER BY creado_en DESC LIMIT 40`, [c.id])).rows;
  const pagos = (await tx.query(`SELECT referencia, cargo_numero, monto, estado, creado_en, verificado_en, cubre_hasta FROM payment WHERE numero_contratacion_id=$1 AND estado <> 'REEMPLAZADO' ORDER BY creado_en DESC LIMIT 24`, [c.id])).rows
    .map((p: any) => ({ ...p, monto: Number(p.monto) }));
  const cot: Cotizacion = c.cotizacion;
  const meta = metaOnboarding();
  const pendiente = pagos.find((p: any) => p.estado === 'PENDIENTE' && p.cargo_numero === 'ACTIVACION');
  return {
    id: c.id, estado: c.estado, subestado: c.subestado, accion_cliente: c.accion_cliente,
    proveedor: c.proveedor === 'telnyx' ? 'Telnyx' : 'Simulación', simulado: c.entorno === 'simulado',
    numero: c.numero_e164, pais: c.pais, tipo: c.tipo_numero, tipo_nombre: NOMBRE_TIPO[c.tipo_numero as TipoNumero] ?? c.tipo_numero, localidad: c.localidad,
    caracteristicas: c.caracteristicas, nombre_visible: c.nombre_visible,
    cotizacion: cot,
    requisitos: { estado: c.requisitos?.estado ?? 'no_aplica', lista: (c.requisitos?.lista ?? []).map((r: any) => ({ id: r.id, nombre: r.nombre, descripcion: r.descripcion ?? '', ejemplo: r.ejemplo ?? null, campo: r.campo })) },
    reserva_expira_en: c.reserva_expira_en,
    periodo_inicio: c.periodo_inicio, periodo_fin: c.periodo_fin, gracia_hasta: c.gracia_hasta,
    creado_en: c.creado_en, conectado_en: c.conectado_en, cancelacion_solicitada_en: c.cancelacion_solicitada_en, cancelado_en: c.cancelado_en, liberado_en: c.liberado_en,
    prueba_recibida_en: c.prueba_recibida_en,
    whatsapp: { vinculado: !!c.waba_id, estado_nombre: c.whatsapp?.estado_nombre ?? null, calidad: c.whatsapp?.calidad ?? null, verificado: !!c.whatsapp?.verificado },
    verificacion: { llamadas: c.verificacion?.llamadas ?? 0, max_llamadas: MAX_LLAMADAS, solicitado_en: c.verificacion?.solicitado_en ?? null, reenvio: !!c.verificacion?.reenviar_a },
    ultimo_error: c.ultimo_error,
    etapas: etapas(c), eventos, pagos,
    pago_pendiente: pendiente ? pendiente.referencia : null,
    registro_meta: meta && !meta.simulado ? { app_id: config.meta.appId, config_id: config.meta.configId, version: config.whatsapp.graphVersion } : meta?.simulado ? { simulado: true } : null,
    condiciones: {
      version: VERSION_CONDICIONES,
      renovacion: 'La mensualidad del número se paga cada mes desde el panel. No hay cobros automáticos: te avisamos 5 días antes del vencimiento.',
      gracia: `Si no se paga, el número sigue activo ${config.numeros.graciaDias} días más; después se libera y deja de recibir mensajes. Un número liberado puede no recuperarse.`,
      cancelacion: 'Puedes cancelar cuando quieras: el número sigue activo hasta el fin del mes pagado y no se devuelve la parte no usada de ese mes.',
      reembolso: 'Si pagaste y el número no se pudo comprar o activar, puedes elegir otro número sin pagar de nuevo o pedir el reembolso en la zona de protección al consumidor.',
    },
  };
}

export async function estado(db: Database, ctx: Ctx) {
  await db.withTenant(ctx.tenantId, async () => { if (!can(ctx, 'subscription:manage') && !can(ctx, 'tenant:configure')) requirePerm(ctx, 'subscription:manage'); });
  return db.withPlatform(async (tx) => {
    const c = (await tx.query(`SELECT * FROM numero_contratacion WHERE tenant_id=$1 ORDER BY (estado <> 'CANCELADO') DESC, creado_en DESC LIMIT 1`, [ctx.tenantId])).rows[0];
    return { contratacion: c ? await vista(tx, c) : null };
  });
}

/** Retorno de Wompi al panel: el servidor consulta la transacción; el navegador solo aporta su id. */
export async function verificarPagoRetorno(db: Database, ctx: Ctx, transaccionId: string, verificar: (id: string) => Promise<unknown>) {
  await db.withTenant(ctx.tenantId, async () => requirePerm(ctx, 'subscription:manage'));
  if (!/^[\w-]{3,80}$/.test(transaccionId)) throw invalid('Falta el identificador de la transacción.');
  await verificar(transaccionId);
  return estado(db, ctx);
}

export type { MetaOnboarding };
