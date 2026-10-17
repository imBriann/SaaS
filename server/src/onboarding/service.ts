import { config, origenRetorno, urlEmpresa } from '../config.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { emitirOtp } from '../modules/otp.js';
import { validarContrasena } from '../modules/auth.js';
import { quoteClassification } from './pricing.js';
import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { hashPassword, slugify, token, uuidv7 } from '../lib/util.js';
import { auditPlatform } from '../core/audit.js';
import { aceptacionVigente, LEGAL } from '../legal/index.js';
import { classifyBusiness, MAX_ACTIVIDADES_ADICIONALES, sanitizeClassification, type Clasificacion } from './classifier.js';
import { recommendPlan } from './planRules.js';
import { applyMapping, inferMapping, readSheet, CAMPOS_DESTINO, type Hoja, type Mapeo } from './importer.js';
import { deriveTheme } from './theme.js';
import { checkoutUrl, cuentaPlataforma, normalizarEventoSimulado, verifyWebhook } from '../adapters/payments.js';
import { aprovisionarConReintento, conciliarReferencia, MINUTOS_CHECKOUT, procesarEventoPago, verificarRetorno } from '../modules/billing.js';
import { ofertaAlta, puedeContratar, resumenModalidad } from './oferta.js';
import { facturacionPublica, huellaFacturacion, prepararFacturacion, vistaFacturacion, type FacturacionGuardada } from './facturacion.js';
import { requisitosFacturacion } from '../documentos/fiscalPlataforma.js';
import { estadoDocumentosBorrador } from '../documentos/servicio.js';
import { aCentavos } from '../lib/money.js';
import { nitValido } from '../adapters/fiscal.js';
import { sectorTypes } from './sectors.js';
import { normalizePhone, validateLocation } from './location.js';
import { domainInfo, reserveSlug, validSlug } from './subdomain.js';
import { imageSize } from 'image-size';

/**
 * Onboarding inteligente (PRO-SW-001 §13). Todo se persiste como BORRADOR con
 * token; nada crea un tenant hasta el webhook de pago verificado (D-04).
 * Principio rector: la IA propone, el código decide, el humano corrige.
 */

/**
 * Las tarifas comerciales son de demostración hasta que el operador las confirme
 * (TARIFAS_CONFIRMADAS=1). Con MODO_INSTITUCIONAL=1 se cobra el precio institucional
 * y la contratación depende solo de que Wompi de producción esté completo.
 */
export { puedeContratar };

function publicDraft(d: any) {
  const cotizacion = d.recomendacion?.cotizacion ?? quoteClassification(d.clasificacion);
  const oferta = ofertaAlta(cotizacion.total);
  return {
    dominio: domainInfo(),
    correo_verificado: !!d.email_verificado_en && d.email_verificado === d.negocio?.email,
    aceptacion_legal: d.aceptacion_legal ? { version: d.aceptacion_legal.version, aceptado_en: d.aceptacion_legal.aceptado_en, vigente: aceptacionVigente(d.aceptacion_legal) } : null,
    legal_version: LEGAL.version,
    cotizacion,
    // Lo que se cobraría hoy al pagar (calculado en el servidor; el navegador no lo envía).
    oferta: { modalidad: oferta.modalidad, monto: oferta.monto, monto_referencia: oferta.montoReferencia, acceso_dias: oferta.accesoDias, concepto: oferta.concepto },
    modalidad: resumenModalidad(),
    pago_disponible: puedeContratar(),
    pasarela: cuentaPlataforma()?.proveedor ?? null,
    // Datos del contratante (documento enmascarado) y si la facturación electrónica está configurada.
    facturacion: vistaFacturacion(d.negocio),
    facturacion_requerida: cuentaPlataforma()?.proveedor === 'wompi',
    facturacion_electronica: { habilitada: requisitosFacturacion().length === 0 },
    error_aprovisionamiento: d.error_aprovisionamiento ?? null,
    token: d.token, estado: d.estado, creacion_diferida: !!d.creacion_diferida, creacion: d.creacion, descripcion: d.descripcion, clasificacion: d.clasificacion, recomendacion: d.recomendacion,
    plan_codigo: d.plan_codigo, negocio: sinFacturacion(d.negocio), tema: d.tema, logo_data_url: d.logo_data_url,
    catalogo: d.catalogo, import_mapping: d.import_mapping,
    hoja_pendiente: d.hoja_pendiente ? { encabezados: d.hoja_pendiente.hoja.encabezados, filas: d.hoja_pendiente.hoja.filas.length, mapeo: d.hoja_pendiente.mapeo } : null,
    etapas: d.etapas, creado_en: d.creado_en,
  };
}

const sinFacturacion = (n: any) => { if (!n?.facturacion) return n; const { facturacion: _f, ...resto } = n; return resto; };

async function loadDraft(db: Database, tk: string) {
  if (!tk || tk.length < 20) throw notFound();
  const d = await db.withPlatform(async (tx) => (await tx.query(`SELECT * FROM onboarding_draft WHERE token=$1`, [tk])).rows[0]);
  if (!d) throw notFound();
  return d;
}

function editable(d: any) {
  if (d.estado !== 'BORRADOR') throw new AppError('CONFLICT', 'Este borrador ya no se puede modificar.');
}

export async function createDraft(db: Database, descripcion: string, creacionDiferida = false) {
  const texto = String(descripcion ?? '').trim();
  if (texto.length < 15) throw invalid('Cuéntanos un poco más de tu negocio (al menos una frase).');
  if (texto.length > 2000) throw invalid('La descripción es demasiado larga.');
  const c = await classifyBusiness(texto);
  const rec = recommendPlan(c);
  const tk = token(24);
  const negocio = { recursos: [] as string[] };
  await db.withPlatform((tx) =>
    tx.query(
      `INSERT INTO onboarding_draft (token, descripcion, clasificacion, recomendacion, plan_codigo, negocio, creacion_diferida) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [tk, texto, JSON.stringify(c), JSON.stringify(rec), rec.plan, JSON.stringify(negocio), creacionDiferida === true],
    ),
  );
  return publicDraft(await loadDraft(db, tk));
}

export const getDraft = async (db: Database, tk: string) => publicDraft(await loadDraft(db, tk));

const NegocioSchema = z.object({
  nombre: z.string().trim().min(2).max(80).optional(),
  slug: z.string().trim().max(40).optional(),
  nit: z.string().regex(/^\d{5,15}$|^$/, 'NIT: escribe entre 5 y 15 números, sin puntos ni guiones.').optional().nullable(),
  nit_dv: z.string().regex(/^\d?$/, 'El DV es un solo número.').optional().nullable(),
  pais: z.string().max(2).optional(),
  departamento: z.string().max(60).optional(),
  municipio: z.string().max(100).optional(),
  direccion: z.string().trim().max(200).optional(),
  telefono_pais: z.string().max(2).optional(),
  telefono_nacional: z.string().max(25).optional(),
  ciudad: z.string().trim().max(60).optional().nullable(),
  email: z.email().transform(s => s.toLowerCase()).optional(),
  telefono: z.string().trim().max(20).optional().nullable(),
  responsable: z.string().trim().max(80).optional(),
  recursos: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
});

const PatchSchema = z.object({
  clasificacion: z.record(z.string(), z.unknown()).optional(),
  plan_codigo: z.enum(['esencial', 'negocio', 'pro']).optional(),
  negocio: NegocioSchema.optional(),
  colores_logo: z.array(z.string()).max(12).optional(),
  logo_data_url: z.string().max(300_000).regex(/^data:image\/(png|jpeg|webp);base64,/).optional().nullable(),
  /** Datos de facturación del contratante (se validan en facturacion.ts). */
  facturacion: z.record(z.string(), z.unknown()).optional(),
});

export async function updateDraft(db: Database, tk: string, body: unknown) {
  return db.withPlatform(async tx => {
    await tx.query('SELECT token FROM onboarding_draft WHERE token=$1 FOR UPDATE', [tk]);
    const scoped = { withPlatform: (fn: any) => fn(tx) } as Database;
    return updateDraftLocked(scoped, tk, body);
  });
}
async function updateDraftLocked(db: Database, tk: string, body: unknown) {
  const d = await loadDraft(db, tk);
  const p = PatchSchema.parse(body);
  // Los datos de facturación se pueden corregir hasta que la empresa exista (también con un pago en curso:
  // el checkout pendiente deja de valer y se genera otro con los datos nuevos).
  const soloFacturacion = Object.keys(p).length === 1 && !!p.facturacion;
  if (soloFacturacion && d.estado !== 'APROVISIONADO') {
    const f = prepararFacturacion(p.facturacion, d.negocio?.facturacion ?? null);
    await db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET negocio = negocio || jsonb_build_object('facturacion', $2::jsonb), actualizado_en=now() WHERE token=$1`, [tk, JSON.stringify(f)]));
    return publicDraft(await loadDraft(db, tk));
  }
  editable(d);
  let clasificacion: Clasificacion = d.clasificacion;
  let recomendacion = d.recomendacion;
  let plan = d.plan_codigo;
  if (p.clasificacion) {
    // Corrección humana: se revalida igual que la salida del modelo y se vuelve a aplicar la tabla de reglas.
    const corrections = { ...p.clasificacion };
    // Activar o quitar la función de facturación responde la pregunta fiscal; confirmar la lista sin tocarla no la responde.
    if (Array.isArray(corrections.modulos_sugeridos) && corrections.factura_electronica === undefined) {
      const antes = (d.clasificacion.modulos_sugeridos ?? []).includes('facturacion');
      const ahora = corrections.modulos_sugeridos.includes('facturacion');
      if (antes !== ahora) corrections.factura_electronica = ahora;
    }
    if (typeof corrections.factura_electronica === 'boolean' && !Array.isArray(corrections.modulos_sugeridos)) {
      const modules = (d.clasificacion.modulos_sugeridos as string[]).filter(m => m !== 'facturacion');
      corrections.modulos_sugeridos = corrections.factura_electronica ? [...modules, 'facturacion'] : modules;
    }
    const campos = ['sector','tipo_negocio','actividades_adicionales','tamano','volumen_conv_mes','factura_electronica','modulos_sugeridos','otro_descripcion'];
    for (const k of Object.keys(corrections)) if (!campos.includes(k)) delete corrections[k];
    if ('actividades_adicionales' in corrections) {
      const lista = corrections.actividades_adicionales;
      // Solo se aceptan tipos del catálogo (sin «Otros») y, a lo sumo, tres; no se descarta nada en silencio.
      const validas = Array.isArray(lista) && lista.length <= MAX_ACTIVIDADES_ADICIONALES
        && lista.every((a: any) => a && a.sector !== 'otro' && sectorTypes(a.sector).includes(a.tipo_negocio));
      if (!validas) throw invalid(`Las actividades adicionales deben ser tipos del catálogo, hasta ${MAX_ACTIVIDADES_ADICIONALES}.`);
      corrections.actividades_adicionales = lista.map((a: any) => ({ sector: a.sector, tipo_negocio: a.tipo_negocio }));
    }
    if (corrections.sector && corrections.sector !== d.clasificacion.sector && !('tipo_negocio' in corrections)) corrections.tipo_negocio = null;
    const merged = { ...d.clasificacion, ...corrections, confianza: 1 };
    if (merged.tipo_negocio && !sectorTypes(merged.sector).includes(merged.tipo_negocio)) throw invalid('El tipo de negocio no corresponde al sector.');
    const s = sanitizeClassification(merged);
    for (const k of Object.keys(corrections)) if (k !== 'otro_descripcion' && corrections[k] != null && (s as any)[k] == null) throw invalid(`Revisa el campo ${k}.`);
    const confirmados = [...new Set([...(d.clasificacion.confirmados ?? []), ...Object.keys(corrections).filter(k => corrections[k] != null)])].filter(k => (s as any)[k] != null);
    clasificacion = { ...s, confirmados, motor: d.clasificacion.motor, analisis: d.clasificacion.analisis, otro_descripcion: String(merged.otro_descripcion ?? '').slice(0,160),
      estados: Object.fromEntries(campos.map(k => [k, (s as any)[k] == null ? 'pendiente' : confirmados.includes(k) ? 'confirmado' : 'sugerido'])),
      conflictos: (d.clasificacion.conflictos ?? []).filter((x: any) => !Object.keys(corrections).includes(x.campo)), justificacion: d.clasificacion.justificacion, tokens: d.clasificacion.tokens,
      // La evidencia deja de aplicar en lo que la persona cambió con su propio valor.
      evidencia: Object.fromEntries(Object.entries((d.clasificacion.evidencia ?? {}) as Record<string, string>).filter(([k]) => !(k in corrections) || JSON.stringify(corrections[k]) === JSON.stringify(d.clasificacion[k]))),
      // Las preguntas solo siguen para lo que aún está pendiente.
      preguntas: Object.fromEntries(Object.entries((d.clasificacion.preguntas ?? {}) as Record<string, string>).filter(([k]) => (s as any)[k] == null)) };
    recomendacion = recommendPlan(clasificacion);
    plan = recomendacion.plan;
  }
  if (p.plan_codigo) plan = p.plan_codigo;
  const negocio = { ...d.negocio, ...(p.negocio ?? {}) };
  if (p.facturacion) negocio.facturacion = prepararFacturacion(p.facturacion, d.negocio?.facturacion ?? null);
  if (p.negocio?.nombre && !d.negocio?.slug && !p.negocio.slug) negocio.slug = slugify(p.negocio.nombre);
  if (negocio.slug && !validSlug(negocio.slug)) throw invalid('El nombre de tu dirección debe tener 3–40 letras minúsculas, números o guiones interiores y no estar reservado.');
  if (p.negocio?.email && p.negocio.email !== d.negocio.email) await db.withPlatform(tx => tx.query('UPDATE onboarding_draft SET email_verificado=NULL,email_verificado_en=NULL WHERE token=$1',[tk]));
  normalizePhone(negocio);
  validateLocation(negocio);
  let tema = d.tema;
  let logo = d.logo_data_url;
  if (p.logo_data_url !== undefined) logo = p.logo_data_url;
  if(p.logo_data_url) {
    try { const bytes=Buffer.from(p.logo_data_url.split(',')[1],'base64'); const size=imageSize(bytes);
      if(bytes.length>200000||!['png','jpg','webp'].includes(size.type??'')||size.width<32||size.height<32||size.width>4096||size.height>4096) throw new Error();
    } catch { throw invalid('No pudimos usar este logotipo. Vuelve a subirlo: se ajusta solo al cargarlo.'); }
  }
  if (p.colores_logo || p.logo_data_url !== undefined || (p.negocio?.nombre && !d.tema)) {
    tema = deriveTheme(p.colores_logo ?? [], negocio.nombre ?? 'Negocio');
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
export async function uploadCatalog(db: Database, tk: string, buf: Buffer, filename: string, sheetName?: string) {
  const d = await loadDraft(db, tk);
  editable(d);
  if (buf.length > 5 * 1024 * 1024) throw invalid('El archivo supera 5 MB.');
  const hoja = await readSheet(buf, filename, sheetName);
  const { mapeo } = await inferMapping(hoja);
  const porDefecto = d.clasificacion.sector === 'restaurante' || d.clasificacion.sector === 'taller' ? 'PRODUCTO' : 'SERVICIO';
  let filas: ReturnType<typeof applyMapping> = [];
  let error: string | null = null;
  try { filas = applyMapping(hoja, mapeo, porDefecto); } catch (e) { error = (e as Error).message; }
  await db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET hoja_pendiente=$2, actualizado_en=now() WHERE token=$1`, [tk, JSON.stringify({ hoja, mapeo, archivo: filename })]));
  // muestra: primeras filas tal como vienen en el archivo, para reconocer cada columna al mapearla.
  return { archivo: filename, hoja: hoja.hoja, hojas: hoja.hojas, fila_encabezado: hoja.filaEncabezado, encabezados: hoja.encabezados, muestra: hoja.filas.slice(0, 3), mapeo, filas, error, total: hoja.filas.length };
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
  fila: z.number().int().optional(),
  incluir: z.boolean().optional(),
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
 return db.withPlatform(async tx=>{
  const d=(await tx.query('SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE',[tk])).rows[0];
  if(!d)throw notFound(); editable(d);
  const b = z.object({ filas: z.array(z.any()).min(1,'No hay registros para guardar.').max(2000), duplicados:z.enum(['omitir','actualizar']), mapeo: MapeoInput.optional(), origen: z.enum(['archivo', 'manual']) }).parse(body);
  const rows:any[]=[...(d.catalogo??[])], reporte:any[]=[];
  const key=(f:any)=>String(f.sku||f.nombre).normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
  let importados=0,omitidos=0,rechazados=0;
  for(const [i,raw] of b.filas.entries()){
    const fila=raw.fila??i+1;
    if(raw.incluir===false){omitidos++;reporte.push({fila,estado:'OMITIDO',motivo:'Excluido al revisar'});continue;}
    const valid=FilaConfirmada.safeParse(raw);
    if(!valid.success){rechazados++;reporte.push({fila,estado:'RECHAZADO',motivo:valid.error.issues.map(x=>`${x.path.join('.')}: ${x.message}`).join('; ')});continue;}
    const f=valid.data, index=rows.findIndex(x=>key(x)===key(f)||x.nombre.toLocaleLowerCase()===f.nombre.toLocaleLowerCase());
    if(index>=0&&b.duplicados==='omitir'){omitidos++;reporte.push({fila,estado:'OMITIDO',motivo:'Ya existe en el borrador'});continue;}
    if(index>=0)rows[index]=f;else rows.push(f);
    importados++;reporte.push({fila,estado:'GUARDADO',motivo:index>=0?'Actualizado en el borrador':'Añadido al borrador'});
  }
  if(rows.length>2000)throw invalid('El catálogo admite hasta 2000 registros.');
  const mapping = b.origen === 'archivo'
    ? { archivo: d.hoja_pendiente?.archivo??d.import_mapping?.archivo, inferido: d.hoja_pendiente?.mapeo, confirmado: b.mapeo, filas: rows.length, confirmado_en: new Date().toISOString() }
    : { origen: 'manual', filas: b.filas.length };
  const resumen={importados,omitidos,rechazados,reporte};
  await tx.query(`UPDATE onboarding_draft SET catalogo=$2, import_mapping=$3, actualizado_en=now() WHERE token=$1`, [tk, JSON.stringify(rows), JSON.stringify({...mapping,resumen})]);
  return {...publicDraft({...d,catalogo:rows,import_mapping:{...mapping,resumen}}),resumen};
 });
}

// ---------------------------------------------------------------------------
// Pago y aprovisionamiento
// ---------------------------------------------------------------------------
export async function startCheckout(db: Database, tk: string, correlacion = uuidv7(), retorno?: unknown) {
  const d = await loadDraft(db, tk);
  const cuenta = cuentaPlataforma();
  if (!cuenta || !puedeContratar()) throw new AppError('CONFLICT', 'La contratación en línea todavía no está habilitada. Escríbenos y te ayudamos a activar tu espacio.');
  // La modalidad institucional cobra dinero real: nunca con la pasarela simulada ni en pruebas.
  if (config.institucional.activo && (cuenta.proveedor !== 'wompi' || cuenta.entorno !== 'produccion')) throw new AppError('CONFLICT', 'El pago institucional no está habilitado.');
  if (d.estado === 'APROVISIONADO') throw new AppError('CONFLICT', 'Esta empresa ya fue creada.');
  const n = d.negocio ?? {};
  const faltan: string[] = [];
  if (!n.nombre) faltan.push('nombre');
  if (!n.email) faltan.push('email');
  if (!n.slug) faltan.push('subdominio');
  if (!d.email_verificado_en || d.email_verificado !== n.email) faltan.push('correo_verificado');
  if (d.clasificacion?.factura_electronica && (!n.nit || !n.nit_dv || !nitValido(`${n.nit}-${n.nit_dv}`))) faltan.push('nit');
  // Teléfono y ubicación del comercio son obligatorios siempre; el NIT, solo si necesita facturación electrónica.
  if (!n.telefono) faltan.push('telefono');
  if (!n.pais || !n.departamento || !n.municipio || !n.direccion) faltan.push('direccion');
  if (!aceptacionVigente(d.aceptacion_legal)) faltan.push('aceptacion_legal');
  const facturacion: FacturacionGuardada | null = n.facturacion?.documento_cifrado ? n.facturacion : null;
  if (cuenta.proveedor === 'wompi' && !facturacion) faltan.push('facturacion');
  if (faltan.length) throw new AppError('VALIDATION', 'Faltan datos para continuar.', { faltan });
  const entorno = cuenta.proveedor === 'wompi' ? cuenta.entorno : null;
  // Wompi devuelve al mismo origen donde empezó el alta; en producción solo https (si no, el dominio público).
  const origen = origenRetorno(retorno);
  const urlRetorno = `${origen && (entorno !== 'produccion' || origen.startsWith('https://')) ? origen : config.publicUrl}/empezar/listo`;
  const huella = facturacion ? huellaFacturacion(facturacion) : null;
  const r = await db.withPlatform(async (tx) => {
    const slugTomado = (await tx.query(`SELECT 1 FROM tenant WHERE slug=$1`, [n.slug])).rows[0];
    if (slugTomado) throw new AppError('CONFLICT', 'Ese subdominio ya está en uso. Elige otro.', { faltan: ['subdominio'] });
    // Lock the draft so concurrent clicks cannot create different checkouts.
    const locked = (await tx.query(`SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE`, [tk])).rows[0];
    if (JSON.stringify(locked.negocio) !== JSON.stringify(d.negocio) || locked.email_verificado !== locked.negocio.email) throw new AppError('CONFLICT','Los datos cambiaron. Revisa el registro antes de pagar.');
    await reserveSlug(tx, n.slug, tk, MINUTOS_CHECKOUT);
    if (locked.estado === 'APROVISIONADO') throw new AppError('CONFLICT', 'Esta empresa ya fue creada.');
    // Ya pagado: nunca se genera un segundo cobro para la misma alta.
    const aprobado = (await tx.query(`SELECT referencia, monto, modalidad FROM payment WHERE draft_token=$1 AND estado='APROBADO' LIMIT 1`, [tk])).rows[0];
    if (aprobado) return { ya_pagado: true as const, referencia: aprobado.referencia as string, monto: Number(aprobado.monto), modalidad: aprobado.modalidad as string };
    // Términos vigentes, calculados aquí: modalidad, monto, referencia comercial y vigencia.
    const quote = quoteClassification(locked.clasificacion);
    const oferta = ofertaAlta(quote.total);
    const urlDe = (referencia: string, monto: number, expira: Date | undefined) => checkoutUrl(cuenta, {
      referencia, montoCentavos: aCentavos(monto), redirectUrl: urlRetorno, expiraEn: cuenta.proveedor === 'wompi' ? expira : undefined,
      concepto: oferta.concepto, cliente: { email: n.email, nombre: n.nombre },
    });
    // Un checkout pendiente solo se reutiliza si sus términos coinciden exactamente con los vigentes
    // (mismo monto, modalidad, pasarela y ambiente) y no está por vencer. Los demás dejan de ofrecerse.
    const pendientes = (await tx.query(`SELECT * FROM payment WHERE draft_token=$1 AND estado='PENDIENTE' ORDER BY creado_en DESC`, [tk])).rows;
    const vigente = pendientes.find((p: any) =>
      p.modalidad === oferta.modalidad && aCentavos(p.monto) === aCentavos(oferta.monto)
      && (p.monto_referencia == null || aCentavos(p.monto_referencia) === aCentavos(oferta.montoReferencia))
      && p.proveedor === cuenta.proveedor && (p.entorno ?? null) === entorno && (p.acceso_dias ?? null) === oferta.accesoDias
      && (!p.expira_en || new Date(p.expira_en).getTime() > Date.now() + 5 * 60_000)
      && (p.expira_en || cuenta.proveedor !== 'wompi')
      && (p.facturacion_huella ?? null) === huella);
    for (const p of pendientes.filter((x: any) => x !== vigente)) {
      await tx.query(`UPDATE payment SET estado='REEMPLAZADO', actualizado_en=now() WHERE id=$1 AND estado='PENDIENTE'`, [p.id]);
      await auditPlatform(tx, null, { tipo: 'SISTEMA', id: null, nombre: 'Pagos' }, 'API', correlacion, { accion: 'pago.checkout_reemplazado', resultado: 'EXITO', detalle: { referencia: p.referencia, monto: Number(p.monto), modalidad: p.modalidad } });
    }
    if (vigente) {
      const expira = vigente.expira_en ? new Date(vigente.expira_en) : undefined;
      return { referencia: vigente.referencia as string, monto: Number(vigente.monto), modalidad: vigente.modalidad as string, acceso_dias: vigente.acceso_dias ?? null, expira_en: expira?.toISOString() ?? null, url: urlDe(vigente.referencia, Number(vigente.monto), expira) };
    }
    const institucional = oferta.modalidad === 'INSTITUCIONAL';
    const code = `${institucional ? 'institucional' : 'modular'}-${uuidv7()}`;
    // Snapshot the entitlements; precio_mensual keeps the commercial reference. Existing plans and other tenants stay intact.
    await tx.query(
      `INSERT INTO plan (codigo,nombre,precio_mensual,cuota_tokens_ia,cuota_mensajes,cuota_documentos,max_usuarios,modulos,politica_excedente,precio_excedente_1k_tokens,orden)
       SELECT $1,$5,$2,cuota_tokens_ia,cuota_mensajes,cuota_documentos,max_usuarios,$3::text[],politica_excedente,precio_excedente_1k_tokens,99 FROM plan WHERE codigo=$4
       ON CONFLICT (codigo) DO NOTHING`,
      [code, quote.total, quote.modulos, locked.plan_codigo, institucional ? 'Institucional' : 'A medida (demo)'],
    );
    const referencia = `SUB-${token(9)}`;
    const expira = new Date(Date.now() + MINUTOS_CHECKOUT * 60_000);
    await tx.query(
      `INSERT INTO payment (id,draft_token,referencia,concepto,monto,estado,proveedor,modalidad,monto_referencia,acceso_dias,plan_codigo,entorno,expira_en,facturacion,documento_cifrado,facturacion_huella)
       VALUES ($1,$2,$3,$4,$5,'PENDIENTE',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [uuidv7(), tk, referencia, oferta.concepto, oferta.monto, cuenta.proveedor, oferta.modalidad, oferta.montoReferencia, oferta.accesoDias, code, entorno, expira.toISOString(),
        facturacion ? JSON.stringify(facturacionPublica(facturacion)) : null, facturacion?.documento_cifrado ?? null, huella],
    );
    await tx.query(`UPDATE onboarding_draft SET estado='PAGO_INICIADO', plan_codigo=$2, recomendacion=$3, actualizado_en=now() WHERE token=$1`,
      [tk, code, JSON.stringify({ ...locked.recomendacion, cotizacion: quote })]);
    await auditPlatform(tx, null, { tipo: 'SISTEMA', id: null, nombre: 'Pagos' }, 'API', correlacion, {
      accion: 'pago.checkout_creado', resultado: 'EXITO',
      detalle: { referencia, modalidad: oferta.modalidad, monto: oferta.monto, monto_centavos: aCentavos(oferta.monto), monto_referencia: oferta.montoReferencia, acceso_dias: oferta.accesoDias, proveedor: cuenta.proveedor, entorno },
    });
    return { referencia, monto: oferta.monto, modalidad: oferta.modalidad, acceso_dias: oferta.accesoDias, expira_en: expira.toISOString(), url: urlDe(referencia, oferta.monto, expira) };
  });
  // Si ya estaba pagado, se asegura el alta (idempotente) y no se devuelve ningún enlace de pago.
  if ('ya_pagado' in r) {
    await aprovisionarConReintento(db, tk, correlacion);
    return { ...r, url: null };
  }
  return r;
}

const ultimoPago = (db: Database, tk: string) => db.withPlatform(async (tx) => (await tx.query(
  // Un pago aprobado manda sobre cualquier checkout posterior; si no, el más reciente que no fue reemplazado.
  `SELECT estado, referencia, monto, modalidad, acceso_dias, monto_referencia, proveedor, creado_en FROM payment WHERE draft_token=$1
   ORDER BY (estado='APROBADO') DESC, (estado='REEMPLAZADO') ASC, creado_en DESC LIMIT 1`, [tk])).rows[0]);

export async function draftStatus(db: Database, tk: string, correlacion = uuidv7()) {
  let d = await loadDraft(db, tk);
  let pago = await ultimoPago(db, tk);
  // Webhook retrasado: tras unos segundos se pregunta a Wompi por la referencia (limitado por pago).
  if (pago?.estado === 'PENDIENTE' && pago.proveedor === 'wompi' && Date.now() - new Date(pago.creado_en).getTime() > 15_000) {
    const r = await conciliarReferencia(db, pago.referencia, correlacion, 20);
    if (r) { d = await loadDraft(db, tk); pago = await ultimoPago(db, tk); }
  }
  // El token público del borrador NO consulta el tenant vivo: solo la instantánea fijada al aprovisionar.
  // Los datos actuales (catálogo, módulos, tema) exigen sesión, pertenencia y permisos en /api/t/*.
  const c = d.cierre;
  // Altas anteriores a la instantánea: solo el subdominio y el nombre, necesarios para entrar.
  const t = c ? { slug: c.slug, nombre: c.nombre }
    : d.tenant_id ? await db.withPlatform(async (tx) => (await tx.query(`SELECT slug, nombre FROM tenant WHERE id=$1`, [d.tenant_id])).rows[0]) : null;
  const panel = c ? { tema: c.tema, logo_data_url: c.logo_data_url, modulos: c.modulos, catalogo: c.catalogo, personalizacion: c.personalizacion ?? null } : null;
  const cuentaExistente = !!d.negocio?.email && await db.withPlatform(async tx => (await tx.query('SELECT 1 FROM users WHERE email=$1', [d.negocio.email])).rows.length > 0);
  return {
    estado: d.estado, etapas: d.etapas,
    creacion_diferida: !!d.creacion_diferida, creacion: d.creacion, cuenta_existente: cuentaExistente,
    // Lo que la IA ya redactó para el inicio: la vista previa lo muestra en cuanto existe, antes de crear la empresa.
    personalizacion: d.personalizacion ? { titulo: d.personalizacion.titulo, descripcion: d.personalizacion.descripcion, prioridades: d.personalizacion.prioridades, motor: d.personalizacion.motor } : null,
    negocio: { nombre: d.negocio?.nombre ?? null, slug: d.negocio?.slug ?? null },
    pago: pago ? {
      estado: pago.estado, referencia: pago.referencia, monto: Number(pago.monto), modalidad: pago.modalidad, acceso_dias: pago.acceso_dias ?? null,
      monto_referencia: pago.monto_referencia == null ? null : Number(pago.monto_referencia), proveedor: pago.proveedor,
    } : null,
    // Dirección y vigencia fijadas al crear el espacio (instantánea, no datos vivos del tenant).
    acceso: d.estado === 'APROVISIONADO' ? c?.acceso ?? (t ? { url: urlEmpresa(t.slug) } : null) : null,
    error_aprovisionamiento: d.estado === 'APROVISIONADO' ? null : d.error_aprovisionamiento ?? null,
    tenant: t, panel, email: d.negocio?.email ?? null,
    // Comprobante y ZIP: estado sin contenido (la descarga exige un enlace temporal).
    documentos: await db.withPlatform((tx) => estadoDocumentosBorrador(tx, tk)),
    // El portador del token de borrador es quien pagó: puede fijar la contraseña una vez.
    requiere_contrasena: d.creacion_diferida && d.estado !== 'APROVISIONADO' ? !cuentaExistente : !!d.password_token,
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

const enmascarar = (correo: string) => correo.replace(/^(.)[^@]*(@.*)$/, '$1•••$2');

/** Correo con el enlace para continuar el alta. Solo al correo de administrador ya verificado. */
async function enviarContinuacion(tx: Tx, d: any, empresa: string | null, clave: string) {
  if (!d.email_verificado) return null;
  await encolarCorreo(tx, { tenantId: null, para: d.email_verificado, sensible: true, clave, caducaEn: new Date(Date.now() + 7 * 86_400_000),
    correo: plantillas.continuarAlta({ nombre: d.negocio?.responsable || d.negocio?.nombre || '', empresa: empresa ?? d.negocio?.nombre ?? 'tu negocio', url: `${config.publicUrl}/empezar/listo#borrador=${d.token}` }) });
  return enmascarar(d.email_verificado);
}

/**
 * Vuelta de la pasarela en un navegador que no tiene la llave del borrador (otro dominio, otro
 * dispositivo, datos borrados). El servidor confirma la transacción con Wompi y, si corresponde a
 * un alta, envía el enlace para continuar al correo verificado del administrador. Nunca devuelve la
 * llave: quien solo conoce el identificador de la transacción no puede tomar el control del alta.
 */
export async function recuperarRetorno(db: Database, transaccionId: string, correlacion: string) {
  if (!/^[\w-]{3,80}$/.test(transaccionId)) throw invalid('Identificador de transacción inválido.');
  const v: any = await verificarRetorno(db, transaccionId, correlacion);
  if (!v.referencia?.startsWith('SUB-')) return { estado: v.estado ?? 'DESCONOCIDO', alta: false };
  return db.withPlatform(async (tx) => {
    const r = (await tx.query(
      `SELECT p.estado AS pago, d.*, t.nombre AS empresa FROM payment p JOIN onboarding_draft d ON d.token=p.draft_token LEFT JOIN tenant t ON t.id=d.tenant_id WHERE p.referencia=$1`, [v.referencia])).rows[0];
    if (!r) return { estado: v.estado, alta: false };
    // Un envío cada 15 minutos por alta, aunque se recargue la página.
    const correo = await enviarContinuacion(tx, r, r.empresa, `retorno:${r.token}:${Math.floor(Date.now() / 900_000)}`);
    return { estado: v.estado, alta: true, pago: r.pago, creada: r.estado === 'APROVISIONADO', empresa: r.empresa ?? r.negocio?.nombre ?? null, correo, enviado: !!correo };
  });
}

export async function reanalyzeDraft(db: Database, tk: string, descripcion: unknown) {
  const texto = z.string().trim().min(15).max(2000).parse(descripcion);
  const propuesta = await classifyBusiness(texto);
  return db.withPlatform(async tx => {
    const d = (await tx.query('SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE',[tk])).rows[0];
    if(!d) throw notFound();
    editable(d);
    const c:any = { ...propuesta, confirmados: d.clasificacion.confirmados ?? [], conflictos: [] };
    for(const k of c.confirmados) {
      if(JSON.stringify(c[k]) !== JSON.stringify(d.clasificacion[k]) && c[k] != null) c.conflictos.push({ campo:k, valor:d.clasificacion[k], sugerencia:c[k] });
      c[k]=d.clasificacion[k]; c.estados[k]='confirmado';
    }
    if(c.tipo_negocio && !sectorTypes(c.sector).includes(c.tipo_negocio)) { c.tipo_negocio=null; c.estados.tipo_negocio='pendiente'; }
    c.otro_descripcion=d.clasificacion.otro_descripcion;
    const rec=recommendPlan(c);
    await tx.query('UPDATE onboarding_draft SET descripcion=$2,clasificacion=$3,recomendacion=$4,plan_codigo=$5,actualizado_en=now() WHERE token=$1',[tk,texto,JSON.stringify(c),JSON.stringify(rec),rec.plan]);
    return publicDraft({...d,descripcion:texto,clasificacion:c,recomendacion:rec,plan_codigo:rec.plan});
  });
}
