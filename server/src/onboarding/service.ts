import { config } from '../config.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { emitirOtp } from '../modules/otp.js';
import { validarContrasena } from '../modules/auth.js';
import { quoteClassification } from './pricing.js';
import { z } from 'zod';
import type { Database } from '../db/index.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { hashPassword, slugify, token, uuidv7 } from '../lib/util.js';
import { auditPlatform } from '../core/audit.js';
import { classifyBusiness, sanitizeClassification, type Clasificacion } from './classifier.js';
import { recommendPlan } from './planRules.js';
import { applyMapping, inferMapping, readSheet, CAMPOS_DESTINO, type Hoja, type Mapeo } from './importer.js';
import { deriveTheme } from './theme.js';
import { checkoutUrl, cuentaPlataforma, normalizarEventoSimulado, verifyWebhook } from '../adapters/payments.js';
import { aprovisionarConReintento, procesarEventoPago } from '../modules/billing.js';
import { aCentavos } from '../lib/money.js';
import { nitValido } from '../adapters/fiscal.js';

/**
 * Onboarding inteligente (PRO-SW-001 §13). Todo se persiste como BORRADOR con
 * token; nada crea un tenant hasta el webhook de pago verificado (D-04).
 * Principio rector: la IA propone, el código decide, el humano corrige.
 */

/**
 * Las tarifas de la cotización son de demostración hasta que el operador confirme
 * las comerciales (TARIFAS_CONFIRMADAS=1). Sin pasarela no se puede contratar.
 */
export function puedeContratar(): boolean {
  return !!cuentaPlataforma() && (config.simuladores || process.env.TARIFAS_CONFIRMADAS === '1');
}

function publicDraft(d: any) {
  return {
    cotizacion: d.recomendacion?.cotizacion ?? quoteClassification(d.clasificacion),
    pago_disponible: puedeContratar(),
    pasarela: cuentaPlataforma()?.proveedor ?? null,
    error_aprovisionamiento: d.error_aprovisionamiento ?? null,
    token: d.token, estado: d.estado, descripcion: d.descripcion, clasificacion: d.clasificacion, recomendacion: d.recomendacion,
    plan_codigo: d.plan_codigo, negocio: d.negocio, tema: d.tema, logo_data_url: d.logo_data_url,
    catalogo: d.catalogo, import_mapping: d.import_mapping,
    hoja_pendiente: d.hoja_pendiente ? { encabezados: d.hoja_pendiente.hoja.encabezados, filas: d.hoja_pendiente.hoja.filas.length, mapeo: d.hoja_pendiente.mapeo } : null,
    etapas: d.etapas, creado_en: d.creado_en,
  };
}

async function loadDraft(db: Database, tk: string) {
  if (!tk || tk.length < 20) throw notFound();
  const d = await db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM onboarding_draft WHERE token=$1`, [tk])).rows[0]);
  if (!d) throw notFound();
  return d;
}

function editable(d: any) {
  if (d.estado !== 'BORRADOR') throw new AppError('CONFLICT', 'Este borrador ya no se puede modificar.');
}

export async function createDraft(db: Database, descripcion: string) {
  const texto = String(descripcion ?? '').trim();
  if (texto.length < 15) throw invalid('Cuéntanos un poco más de tu negocio (al menos una frase).');
  if (texto.length > 2000) throw invalid('La descripción es demasiado larga.');
  const c = await classifyBusiness(texto);
  const rec = recommendPlan(c);
  const tk = token(24);
  const negocio = { recursos: [] as string[] };
  await db.withPlatform((tx) =>
    tx.query(
      `INSERT INTO onboarding_draft (token, descripcion, clasificacion, recomendacion, plan_codigo, negocio) VALUES ($1,$2,$3,$4,$5,$6)`,
      [tk, texto, JSON.stringify(c), JSON.stringify(rec), rec.plan, JSON.stringify(negocio)],
    ),
  );
  return publicDraft(await loadDraft(db, tk));
}

export const getDraft = async (db: Database, tk: string) => publicDraft(await loadDraft(db, tk));

const NegocioSchema = z.object({
  nombre: z.string().trim().min(2).max(80).optional(),
  slug: z.string().trim().max(40).optional(),
  nit: z.string().trim().max(20).optional().nullable(),
  ciudad: z.string().trim().max(60).optional().nullable(),
  email: z.email().optional(),
  telefono: z.string().trim().max(20).optional().nullable(),
  responsable: z.string().trim().max(80).optional(),
  recursos: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const PatchSchema = z.object({
  clasificacion: z.record(z.string(), z.unknown()).optional(),
  plan_codigo: z.enum(['esencial', 'negocio', 'pro']).optional(),
  negocio: NegocioSchema.optional(),
  colores_logo: z.array(z.string()).max(12).optional(),
  logo_data_url: z.string().max(300_000).regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,/).optional().nullable(),
});

export async function updateDraft(db: Database, tk: string, body: unknown) {
  const d = await loadDraft(db, tk);
  editable(d);
  const p = PatchSchema.parse(body);
  let clasificacion: Clasificacion = d.clasificacion;
  let recomendacion = d.recomendacion;
  let plan = d.plan_codigo;
  if (p.clasificacion) {
    // Corrección humana: se revalida igual que la salida del modelo y se vuelve a aplicar la tabla de reglas.
    const corrections = { ...p.clasificacion };
    if (Array.isArray(corrections.modulos_sugeridos) && corrections.factura_electronica === undefined) corrections.factura_electronica = corrections.modulos_sugeridos.includes('facturacion');
    if (typeof corrections.factura_electronica === 'boolean' && !Array.isArray(corrections.modulos_sugeridos)) {
      const modules = (d.clasificacion.modulos_sugeridos as string[]).filter(m => m !== 'facturacion');
      corrections.modulos_sugeridos = corrections.factura_electronica ? [...modules, 'facturacion'] : modules;
    }
    const s = sanitizeClassification({ ...d.clasificacion, ...corrections, confianza: 1 });
    clasificacion = { ...s, justificacion: d.clasificacion.justificacion, tokens: d.clasificacion.tokens, corregido_por_usuario: true } as any;
    recomendacion = recommendPlan(clasificacion);
    plan = recomendacion.plan;
  }
  if (p.plan_codigo) plan = p.plan_codigo;
  const negocio = { ...d.negocio, ...(p.negocio ?? {}) };
  if (p.negocio?.nombre && !d.negocio?.slug && !p.negocio.slug) negocio.slug = slugify(p.negocio.nombre);
  if (negocio.slug) negocio.slug = slugify(negocio.slug);
  let tema = d.tema;
  let logo = d.logo_data_url;
  if (p.logo_data_url !== undefined) logo = p.logo_data_url;
  if (p.colores_logo || p.logo_data_url !== undefined || (p.negocio?.nombre && !d.tema)) {
    tema = deriveTheme(logo ? p.colores_logo ?? [] : [], negocio.nombre ?? 'Negocio');
  }
  await db.withPlatform((tx) =>
    tx.query(
      `UPDATE onboarding_draft SET clasificacion=$2, recomendacion=$3, plan_codigo=$4, negocio=$5, tema=$6, logo_data_url=$7, actualizado_en=now() WHERE token=$1`,
      [tk, JSON.stringify(clasificacion), JSON.stringify(recomendacion), plan, JSON.stringify(negocio), tema ? JSON.stringify(tema) : null, logo],
    ),
  );
  return publicDraft(await loadDraft(db, tk));
}

// ---------------------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------------------
export async function uploadCatalog(db: Database, tk: string, buf: Buffer, filename: string) {
  const d = await loadDraft(db, tk);
  editable(d);
  if (buf.length > 5 * 1024 * 1024) throw invalid('El archivo supera 5 MB.');
  const hoja = await readSheet(buf, filename);
  const { mapeo } = await inferMapping(hoja);
  const porDefecto = d.clasificacion.sector === 'restaurante' || d.clasificacion.sector === 'taller' ? 'PRODUCTO' : 'SERVICIO';
  let filas: ReturnType<typeof applyMapping> = [];
  let error: string | null = null;
  try { filas = applyMapping(hoja, mapeo, porDefecto); } catch (e) { error = (e as Error).message; }
  await db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET hoja_pendiente=$2, actualizado_en=now() WHERE token=$1`, [tk, JSON.stringify({ hoja, mapeo, archivo: filename })]));
  return { archivo: filename, hoja: hoja.hoja, fila_encabezado: hoja.filaEncabezado, encabezados: hoja.encabezados, mapeo, filas, error, total: hoja.filas.length };
}

const MapeoInput = z.array(z.object({ columna: z.string(), campo: z.enum(CAMPOS_DESTINO), confianza: z.number().optional() }));

/** Vista previa con un mapeo corregido por el usuario. */
export async function previewCatalog(db: Database, tk: string, mapeoIn: unknown) {
  const d = await loadDraft(db, tk);
  editable(d);
  if (!d.hoja_pendiente) throw new AppError('CONFLICT', 'Primero carga un archivo.');
  const hoja: Hoja = d.hoja_pendiente.hoja;
  const mapeo = MapeoInput.parse(mapeoIn).map((m) => ({ ...m, confianza: m.confianza ?? 1 })) as Mapeo;
  const porDefecto = d.clasificacion.sector === 'restaurante' || d.clasificacion.sector === 'taller' ? 'PRODUCTO' : 'SERVICIO';
  return { filas: applyMapping(hoja, mapeo, porDefecto), mapeo };
}

const FilaConfirmada = z.object({
  tipo: z.enum(['PRODUCTO', 'SERVICIO']),
  nombre: z.string().trim().min(1).max(120),
  categoria: z.string().max(60).nullable().optional(),
  precio: z.number().nonnegative().max(999_999_999),
  iva_pct: z.number().refine((v) => [0, 5, 19].includes(v)).default(0),
  duracion_min: z.number().int().positive().max(600).nullable().optional(),
  stock: z.number().min(0).nullable().optional(),
  sku: z.string().max(40).nullable().optional(),
});

/** Confirmación explícita (D-06). El mapeo usado queda para auditoría. */
export async function confirmCatalog(db: Database, tk: string, body: unknown) {
  const d = await loadDraft(db, tk);
  editable(d);
  const b = z.object({ filas: z.array(FilaConfirmada).max(2000), mapeo: MapeoInput.optional(), origen: z.enum(['archivo', 'manual']) }).parse(body);
  const mapping = b.origen === 'archivo'
    ? { archivo: d.hoja_pendiente?.archivo, inferido: d.hoja_pendiente?.mapeo, confirmado: b.mapeo, filas: b.filas.length, confirmado_en: new Date().toISOString() }
    : { origen: 'manual', filas: b.filas.length };
  await db.withPlatform((tx) =>
    tx.query(`UPDATE onboarding_draft SET catalogo=$2, import_mapping=$3, hoja_pendiente=NULL, actualizado_en=now() WHERE token=$1`, [tk, JSON.stringify(b.filas), JSON.stringify(mapping)]),
  );
  return publicDraft(await loadDraft(db, tk));
}

// ---------------------------------------------------------------------------
// Pago y aprovisionamiento
// ---------------------------------------------------------------------------
export async function startCheckout(db: Database, tk: string) {
  const d = await loadDraft(db, tk);
  const cuenta = cuentaPlataforma();
  if (!cuenta || !puedeContratar()) throw new AppError('CONFLICT', 'La contratación en línea todavía no está habilitada. Escríbenos y te ayudamos a activar tu espacio.');
  if (d.estado === 'APROVISIONADO') throw new AppError('CONFLICT', 'Esta empresa ya fue creada.');
  const n = d.negocio ?? {};
  const faltan: string[] = [];
  if (!n.nombre) faltan.push('nombre');
  if (!n.email) faltan.push('email');
  if (!n.slug) faltan.push('subdominio');
  if (d.clasificacion?.factura_electronica && (!n.nit || !nitValido(n.nit))) faltan.push('nit');
  if (faltan.length) throw new AppError('VALIDATION', 'Faltan datos para continuar.', { faltan });
  return db.withPlatform(async (tx) => {
    const slugTomado = (await tx.query(`SELECT 1 FROM tenant WHERE slug=$1`, [n.slug])).rows[0];
    if (slugTomado) throw new AppError('CONFLICT', 'Ese subdominio ya está en uso. Elige otro.', { faltan: ['subdominio'] });
    // Lock the draft so concurrent clicks cannot create different checkouts.
    const locked = (await tx.query(`SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE`, [tk])).rows[0];
    if (locked.estado === 'APROVISIONADO') throw new AppError('CONFLICT', 'Esta empresa ya fue creada.');
    const previous = (await tx.query(`SELECT referencia, monto FROM payment WHERE draft_token=$1 AND estado='PENDIENTE' ORDER BY creado_en DESC LIMIT 1`, [tk])).rows[0];
    const urlDe = (referencia: string, monto: number) => checkoutUrl(cuenta, { referencia, montoCentavos: aCentavos(monto), redirectUrl: `${config.publicUrl}/empezar/listo`, concepto: 'Omnegia · primer mes', cliente: { email: n.email, nombre: n.nombre } });
    if (previous) return { referencia: previous.referencia, monto: Number(previous.monto), url: urlDe(previous.referencia, Number(previous.monto)) };
    const quote = quoteClassification(locked.clasificacion);
    const code = `modular-${uuidv7()}`;
    // Snapshot the price and entitlements. Existing plans and other tenants stay intact.
    await tx.query(
      `INSERT INTO plan (codigo,nombre,precio_mensual,cuota_tokens_ia,cuota_mensajes,cuota_documentos,max_usuarios,modulos,politica_excedente,precio_excedente_1k_tokens,orden)
       SELECT $1,'A medida (demo)',$2,cuota_tokens_ia,cuota_mensajes,cuota_documentos,max_usuarios,$3::text[],politica_excedente,precio_excedente_1k_tokens,99 FROM plan WHERE codigo=$4
       ON CONFLICT (codigo) DO NOTHING`,
      [code, quote.total, quote.modulos, locked.plan_codigo],
    );
    const referencia = `SUB-${token(9)}`;
    await tx.query(
      `INSERT INTO payment (id,draft_token,referencia,concepto,monto,estado,proveedor) VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6)`,
      [uuidv7(),tk,referencia,'Omnegia · primer mes',quote.total,cuenta.proveedor],
    );
    await tx.query(`UPDATE onboarding_draft SET estado='PAGO_INICIADO', plan_codigo=$2, recomendacion=$3, actualizado_en=now() WHERE token=$1`, [tk,code,JSON.stringify({ ...locked.recomendacion, cotizacion: quote })]);
    return { referencia, monto: quote.total, url: urlDe(referencia, quote.total) };
  });
}

export async function draftStatus(db: Database, tk: string) {
  const d = await loadDraft(db, tk);
  const pago = await db.withPlatform(async (tx) => (await tx.query(`SELECT estado, referencia, monto FROM payment WHERE draft_token=$1 ORDER BY creado_en DESC LIMIT 1`, [tk])).rows[0]);
  // El token público del borrador NO consulta el tenant vivo: solo la instantánea fijada al aprovisionar.
  // Los datos actuales (catálogo, módulos, tema) exigen sesión, pertenencia y permisos en /api/t/*.
  const c = d.cierre;
  // Altas anteriores a la instantánea: solo el subdominio y el nombre, necesarios para entrar.
  const t = c ? { slug: c.slug, nombre: c.nombre }
    : d.tenant_id ? await db.withPlatform(async (tx) => (await tx.query(`SELECT slug, nombre FROM tenant WHERE id=$1`, [d.tenant_id])).rows[0]) : null;
  const panel = c ? { tema: c.tema, logo_data_url: c.logo_data_url, modulos: c.modulos, catalogo: c.catalogo } : null;
  return {
    estado: d.estado, etapas: d.etapas, pago: pago ? { ...pago, monto: Number(pago.monto) } : null,
    error_aprovisionamiento: d.estado === 'APROVISIONADO' ? null : d.error_aprovisionamiento ?? null,
    tenant: t, panel, email: d.negocio?.email ?? null,
    // El portador del token de borrador es quien pagó: puede fijar la contraseña una vez.
    requiere_contrasena: !!d.password_token,
  };
}

export async function setInitialPassword(db: Database, tk: string, password: string, ip = 'desconocida') {
  const pw = validarContrasena(password);
  const d = await loadDraft(db, tk);
  if (d.estado !== 'APROVISIONADO' || !d.password_token) throw new AppError('CONFLICT', 'La contraseña ya fue definida. Inicia sesión.');
  await db.withPlatform(async (tx) => {
    const u = (await tx.query(`UPDATE users SET password_hash=$2 WHERE email=$1 RETURNING id, email, nombre, email_verificado_en`, [String(d.negocio.email).toLowerCase(), hashPassword(pw)])).rows[0];
    await tx.query(`UPDATE onboarding_draft SET password_token=NULL WHERE token=$1`, [tk]);
    if (!u) return;
    const t = (await tx.query(`SELECT nombre FROM tenant WHERE id=$1`, [d.tenant_id])).rows[0];
    // Bienvenida y código para confirmar el correo con el que se registró el negocio.
    await encolarCorreo(tx, { tenantId: null, userId: u.id, para: u.email, clave: `bienvenida:${u.id}:${d.tenant_id}`,
      correo: plantillas.bienvenida({ nombre: u.nombre, empresa: t?.nombre ?? d.negocio.nombre ?? '', urlPanel: config.publicUrl }) });
    if (!u.email_verificado_en) {
      const otp = await emitirOtp(tx, { userId: u.id, proposito: 'VERIFICAR_CORREO', ip });
      await encolarCorreo(tx, { tenantId: null, userId: u.id, para: u.email, sensible: true, caducaEn: new Date(Date.now() + otp.minutos * 60_000),
        correo: plantillas.codigoVerificacion({ nombre: u.nombre, codigo: otp.codigo, minutos: otp.minutos }) });
    }
  });
  return { ok: true };
}

/**
 * Webhook de la pasarela simulada (desarrollo y demostración). Resiste duplicados
 * (event_id único), falsificaciones (HMAC antes de cualquier efecto) y llegadas
 * antes que el navegador (el alta no depende de la redirección).
 */
export async function handlePaymentWebhook(db: Database, rawBody: string, firma: string | undefined, correlacion: string) {
  if (!config.simuladores || !verifyWebhook(rawBody, firma)) {
    await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'ANONIMO', id: null, nombre: 'webhook' }, 'WEBHOOK', correlacion, {
      accion: 'webhook.pago.firma_invalida', resultado: 'DENEGADO', detalle: { longitud: rawBody.length },
    }));
    throw new AppError('BAD_SIGNATURE', 'Firma inválida');
  }
  let crudo: unknown;
  try { crudo = JSON.parse(rawBody); } catch { throw invalid('Cuerpo inválido'); }
  const ev = normalizarEventoSimulado(crudo);
  if (!ev) throw invalid('Evento incompleto');
  return procesarEventoPago(db, ev, correlacion, 'simulada');
}

/** Reintento manual del alta cuando el pago está aprobado y el aprovisionamiento falló. */
export async function retryProvisioning(db: Database, tk: string, correlacion: string) {
  const d = await loadDraft(db, tk);
  if (d.estado === 'APROVISIONADO') return { ok: true, ya_existia: true };
  const r = await aprovisionarConReintento(db, tk, correlacion);
  if (!r.tenantId) throw new AppError('CONFLICT', r.error ?? 'No pudimos crear el espacio todavía.');
  return { ok: true };
}
