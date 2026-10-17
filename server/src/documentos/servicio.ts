import JSZip from 'jszip';
import type { Database, Tx } from '../db/index.js';
import { config, urlEmpresa } from '../config.js';
import { enqueue } from '../core/events.js';
import { auditPlatform } from '../core/audit.js';
import { registrarIncidente } from '../core/incidentes.js';
import { AppError, notFound } from '../lib/errors.js';
import { cop, uuidv7 } from '../lib/util.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { calcularValores, generarPdf, type DatosComprobante } from './comprobante.js';
import { cifrarRecuperable, firmarEnlace, normalizarDocumento, sha256Hex, verificarEnlace, ITERACIONES_CIFRADO } from './proteccion.js';
import { estadoFacturacionPlataforma, proveedorFiscalPlataforma } from './fiscalPlataforma.js';
import { TIPOS_DOCUMENTO } from '../onboarding/facturacion.js';
import { decrypt } from '../lib/util.js';

/**
 * Documentos de cada pago aprobado a la plataforma.
 *
 *  1. Tras el alta (o la renovación) se encola la generación: comprobante PDF protegido con
 *     el número de documento del contratante y un ZIP sin contraseña que lo contiene.
 *  2. La factura electrónica solo se emite si la facturación de la plataforma está habilitada
 *     y verificada; si no, la obligación queda registrada como pendiente (una por pago).
 *  3. Al validarse una factura se regenera el ZIP (nueva versión) con su PDF y su XML cifrado.
 *
 * Todo es idempotente: un registro por pago, el ZIP se guarda y se reutiliza, y los correos
 * llevan una clave única por pago.
 */
export const LIMITE_ADJUNTO_BYTES = 7 * 1024 * 1024;
/** Días durante los que el portador del borrador (quien pagó) puede descargar sin sesión. */
export const DIAS_DESCARGA_BORRADOR = 30;

const SISTEMA = { tipo: 'SISTEMA' as const, id: null, nombre: 'Documentos' };

/** Crea (una sola vez) el registro del documento de un pago aprobado y encola su generación. */
export async function encolarDocumentos(tx: Tx, paymentId: string, motivo = 'inicial') {
  const doc = await asegurarDocumento(tx, paymentId);
  await enqueue(tx, null, 'generar_documentos_pago', { payment_id: paymentId }, { claveUnica: `docs:${paymentId}:${motivo}:${doc.version}`, maxIntentos: 5 });
  return doc;
}

async function asegurarDocumento(tx: Tx, paymentId: string) {
  await tx.query(
    `INSERT INTO documento_pago (id, payment_id, tenant_id, numero)
     SELECT $1, p.id, p.tenant_id, 'CP-' || lpad(nextval('comprobante_pago_seq')::text, 6, '0') FROM payment p
     WHERE p.id=$2 AND p.estado='APROBADO' AND NOT EXISTS (SELECT 1 FROM documento_pago WHERE payment_id=$2)
     ON CONFLICT (payment_id) DO NOTHING`, [uuidv7(), paymentId]);
  const doc = (await tx.query(`SELECT * FROM documento_pago WHERE payment_id=$1`, [paymentId])).rows[0];
  if (!doc) throw new AppError('CONFLICT', 'El pago no está aprobado.');
  return doc;
}

const ETIQUETA_FISCAL: Record<string, string> = {
  PENDIENTE_CONFIGURACION: 'Facturación electrónica pendiente de configuración',
  EN_PROCESO: 'Factura electrónica en trámite',
  VALIDADA: 'Factura electrónica validada por la DIAN',
  RECHAZADA: 'Factura electrónica rechazada · en revisión',
  NO_APLICA: 'No aplica',
};
export const etiquetaFiscal = (e: string) => ETIQUETA_FISCAL[e] ?? e;

/** Reúne lo necesario para los documentos de un pago (solo plataforma). */
async function datosPago(tx: Tx, paymentId: string) {
  const p = (await tx.query(`SELECT * FROM payment WHERE id=$1`, [paymentId])).rows[0];
  if (!p || p.estado !== 'APROBADO') return null;
  const doc = await asegurarDocumento(tx, paymentId);
  const t = p.tenant_id ? (await tx.query(`SELECT id, nombre, slug FROM tenant WHERE id=$1`, [p.tenant_id])).rows[0] : null;
  const periodo = (await tx.query(`SELECT periodo_fin FROM subscription_period WHERE payment_id=$1`, [paymentId])).rows[0];
  return { p, doc, t, vigenteHasta: periodo?.periodo_fin ? new Date(periodo.periodo_fin) : null };
}

function leeme(o: { numero: string; pdf: string; xml?: { nombre: string; original: string; huella: string } | null; estadoFiscal: string; cufe?: string | null }) {
  const soporte = config.documentos.emisor.correo ?? config.correo.buzonSoporte;
  return [
    `Documentos de tu pago a Omnegia · ${o.numero}`,
    '',
    'Este archivo .zip se abre sin contraseña. Cada documento que contiene está protegido de forma individual.',
    '',
    `- ${o.pdf}`,
    '  Ábrelo con cualquier lector de PDF: te pedirá una contraseña.',
    '  La contraseña es tu número de documento registrado para la facturación, solo con números y letras:',
    '  sin puntos, espacios, guiones ni otros separadores. Si es un NIT, sin el dígito de verificación.',
    ...(o.xml ? [
      '',
      `- ${o.xml.nombre}`,
      '  XML de la factura electrónica, cifrado sin modificar el original (su firma digital queda intacta).',
      '  Para recuperarlo, con OpenSSL (incluido en macOS, Linux y Git para Windows) y la misma contraseña:',
      `    openssl enc -d -aes-256-cbc -pbkdf2 -iter ${ITERACIONES_CIFRADO} -md sha256 -in ${o.xml.nombre} -out ${o.xml.original}`,
      `  Huella SHA-256 del XML original, para comprobar que quedó idéntico: ${o.xml.huella}`,
    ] : []),
    '',
    `Estado fiscal: ${etiquetaFiscal(o.estadoFiscal)}.${o.cufe ? ` CUFE: ${o.cufe}` : ''}`,
    ...(o.estadoFiscal === 'VALIDADA' ? [] : ['El comprobante acredita el pago recibido. NO es una factura electrónica ni tiene validez fiscal.']),
    '',
    `Omnegia nunca te pedirá esta contraseña por correo ni por teléfono. Soporte: ${soporte}`,
    '',
  ].join('\r\n');
}

/**
 * Genera (o regenera) el ZIP del pago. Idempotente: si ya hay un ZIP listo para el estado
 * fiscal vigente, no hace nada.
 */
export async function generarDocumentosPago(db: Database, paymentId: string, correlacion: string): Promise<{ estado: string; version?: number }> {
  const datos = await db.withPlatform((tx) => datosPago(tx, paymentId));
  if (!datos) return { estado: 'OMITIDO' };
  const { p, doc, t, vigenteHasta } = datos;
  const fiscalEnZip = doc.archivos?.some?.((a: any) => a.tipo === 'FACTURA_PDF');
  if (doc.estado === 'LISTO' && doc.version > 0 && (doc.estado_fiscal !== 'VALIDADA' || fiscalEnZip)) return { estado: 'LISTO', version: doc.version };
  if (!p.facturacion || !p.documento_cifrado) {
    // Pagos previos a los datos de facturación: no se puede proteger el documento con la contraseña acordada.
    await db.withPlatform((tx) => tx.query(`UPDATE documento_pago SET estado='SIN_DATOS', error='Faltan los datos de facturación del contratante.', actualizado_en=now() WHERE id=$1`, [doc.id]));
    return { estado: 'SIN_DATOS' };
  }
  try {
    const numeroDoc = decrypt(config.appKey, p.documento_cifrado);
    const contrasena = normalizarDocumento(numeroDoc);
    const f = p.facturacion;
    const validada = doc.estado_fiscal === 'VALIDADA';
    const datosPdf: DatosComprobante = {
      numero: doc.numero, referencia: p.referencia, transaccionId: p.transaccion_id ?? null,
      fechaPago: new Date(p.verificado_en ?? p.actualizado_en), generadoEn: new Date(),
      emisor: config.documentos.emisor,
      contratante: { nombre: f.nombre, tipoDocumentoNombre: TIPOS_DOCUMENTO[f.tipo_documento as keyof typeof TIPOS_DOCUMENTO] ?? f.tipo_documento, numeroDocumento: numeroDoc, dv: f.dv ?? null, email: f.email, telefono: f.telefono, direccion: f.direccion, ciudad: f.ciudad, departamento: f.departamento ?? null },
      servicio: { concepto: p.concepto, empresa: t?.nombre ?? null, direccion: t ? urlEmpresa(t.slug).replace(/^https?:\/\//, '') : null, modalidad: p.modalidad, accesoDias: p.acceso_dias ?? null, vigenteHasta },
      valores: calcularValores(Number(p.monto), config.documentos.responsableIva, config.documentos.ivaPct),
      fiscal: { estado: doc.estado_fiscal, numero: doc.factura_numero, cufe: doc.cufe, qr: doc.factura_qr, validadaEn: doc.factura_validada_en ? new Date(doc.factura_validada_en) : null },
    };
    const pdf = await generarPdf(datosPdf, contrasena);
    const nombrePdf = validada ? `factura-electronica-${doc.factura_numero}.pdf` : `comprobante-pago-${doc.numero}-sin-validez-fiscal.pdf`;
    const zip = new JSZip();
    const fechaArchivo = new Date();
    zip.file(nombrePdf, pdf, { date: fechaArchivo });
    const archivos: Record<string, unknown>[] = [{ nombre: nombrePdf, tipo: validada ? 'FACTURA_PDF' : 'COMPROBANTE_PDF', proteccion: 'CONTRASENA_PDF_AES256', bytes: pdf.length }];
    let xml: { nombre: string; original: string; huella: string } | null = null;
    if (validada && doc.factura_xml) {
      const original = `factura-electronica-${doc.factura_numero}.xml`;
      xml = { nombre: `${original}.enc`, original, huella: sha256Hex(doc.factura_xml) };
      const cifrado = cifrarRecuperable(Buffer.from(doc.factura_xml), contrasena);
      zip.file(xml.nombre, cifrado, { date: fechaArchivo });
      archivos.push({ nombre: xml.nombre, tipo: 'FACTURA_XML', proteccion: 'CIFRADO_OPENSSL_AES256_PBKDF2', bytes: cifrado.length, sha256_original: xml.huella });
    }
    zip.file('LEEME.txt', leeme({ numero: doc.numero, pdf: nombrePdf, xml, estadoFiscal: doc.estado_fiscal, cufe: validada ? doc.cufe : null }), { date: fechaArchivo });
    archivos.push({ nombre: 'LEEME.txt', tipo: 'INSTRUCCIONES', proteccion: 'NINGUNA' });
    const contenido = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    const r = await db.withPlatform(async (tx) => {
      const u = (await tx.query(
        `UPDATE documento_pago SET estado='LISTO', version=version+1, zip=$2, zip_bytes=$3, zip_sha256=$4, archivos=$5, tenant_id=coalesce(tenant_id, $6),
           error=NULL, generado_en=now(), actualizado_en=now() WHERE id=$1 RETURNING version, tenant_id`,
        [doc.id, contenido, contenido.length, sha256Hex(contenido), JSON.stringify(archivos), p.tenant_id ?? null])).rows[0];
      await auditPlatform(tx, u.tenant_id ?? null, SISTEMA, 'TRABAJADOR', correlacion, {
        accion: validada ? 'documentos.factura_empaquetada' : 'documentos.comprobante_generado', recurso: 'documento_pago', recursoId: doc.id, resultado: 'EXITO',
        detalle: { numero: doc.numero, referencia: p.referencia, version: u.version, estado_fiscal: doc.estado_fiscal, archivos: archivos.map((a) => a.nombre) },
      });
      return u;
    });
    return { estado: 'LISTO', version: r.version };
  } catch (e) {
    await db.withPlatform((tx) => tx.query(
      `UPDATE documento_pago SET estado=CASE WHEN estado='LISTO' THEN estado ELSE 'FALLIDO' END, error='No se pudieron generar los documentos.', intentos=intentos+1, actualizado_en=now() WHERE id=$1`, [doc.id]));
    throw e;
  }
}

/** Correo de confirmación del pago con el ZIP adjunto (una sola vez por pago). */
export async function encolarCorreoPago(tx: Tx, paymentId: string, conDocumentos: boolean) {
  const p = (await tx.query(`SELECT * FROM payment WHERE id=$1`, [paymentId])).rows[0];
  if (!p?.tenant_id) return;
  const t = (await tx.query(`SELECT t.nombre, t.slug, t.email_contacto, s.periodo_fin FROM tenant t JOIN subscription s ON s.tenant_id=t.id WHERE t.id=$1`, [p.tenant_id])).rows[0];
  const doc = (await tx.query(`SELECT id, numero, estado, zip_bytes, estado_fiscal FROM documento_pago WHERE payment_id=$1`, [paymentId])).rows[0];
  const para = p.facturacion?.email ?? t?.email_contacto;
  if (!t || !para) return;
  const adjunto = conDocumentos && doc?.estado === 'LISTO' && doc.zip_bytes <= LIMITE_ADJUNTO_BYTES;
  const documentos = doc ? { numero: doc.numero, adjunto, disponible: doc.estado === 'LISTO', estadoFiscal: etiquetaFiscal(doc.estado_fiscal), urlPanel: `${config.publicUrl}/suscripcion` } : null;
  const periodo = (await tx.query(`SELECT periodo_fin FROM subscription_period WHERE payment_id=$1`, [paymentId])).rows[0];
  const hasta = new Date(periodo?.periodo_fin ?? t.periodo_fin).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' });
  const correo = p.draft_token
    ? plantillas.altaConfirmada({ empresa: t.nombre, modalidad: p.modalidad, monto: cop(Number(p.monto)), referencia: p.referencia, vigenteHasta: hasta, urlEmpresa: urlEmpresa(t.slug), documentos, urlReembolso: `${config.publicUrl}/consumidor#reembolso` })
    : plantillas.pagoRecibido({ empresa: t.nombre, monto: cop(Number(p.monto)), referencia: p.referencia, modalidad: p.modalidad, periodoFin: hasta, url: `${config.publicUrl}/suscripcion`, documentos, urlReembolso: `${config.publicUrl}/consumidor#reembolso` });
  await encolarCorreo(tx, { tenantId: null, para, clave: `pago:${paymentId}`, adjuntoRef: adjunto ? `docpago:${doc.id}` : null, correo });
}

/** Correo con la factura electrónica validada (una vez por pago). */
export async function encolarCorreoFactura(tx: Tx, paymentId: string) {
  const r = (await tx.query(
    `SELECT p.referencia, p.facturacion, t.nombre, t.email_contacto, d.id, d.factura_numero, d.zip_bytes, d.estado FROM payment p JOIN tenant t ON t.id=p.tenant_id
     JOIN documento_pago d ON d.payment_id=p.id WHERE p.id=$1 AND d.estado_fiscal='VALIDADA'`, [paymentId])).rows[0];
  const para = r?.facturacion?.email ?? r?.email_contacto;
  if (!r || !para) return;
  const adjunto = r.estado === 'LISTO' && r.zip_bytes <= LIMITE_ADJUNTO_BYTES;
  await encolarCorreo(tx, { tenantId: null, para, clave: `factura:${paymentId}`, adjuntoRef: adjunto ? `docpago:${r.id}` : null,
    correo: plantillas.facturaDisponible({ empresa: r.nombre, numero: r.factura_numero, referencia: r.referencia, adjunto, url: `${config.publicUrl}/suscripcion` }) });
}

// ---------------------------------------------------------------- facturación electrónica (si está habilitada)
/**
 * Emite la factura electrónica de un pago. No hace nada (y deja la obligación pendiente)
 * si la facturación de la plataforma no está habilitada y verificada.
 */
export async function emitirFacturaPago(db: Database, paymentId: string, correlacion: string): Promise<'PENDIENTE_CONFIGURACION' | 'VALIDADA' | 'RECHAZADA' | 'EN_PROCESO' | 'OMITIDO'> {
  const est = await estadoFacturacionPlataforma();
  if (!est.habilitada) {
    await db.withPlatform((tx) => tx.query(`UPDATE documento_pago SET fiscal_motivo=$2, actualizado_en=now() WHERE payment_id=$1 AND estado_fiscal='PENDIENTE_CONFIGURACION'`, [paymentId, est.motivos[0] ?? null]));
    return 'PENDIENTE_CONFIGURACION';
  }
  const f = config.documentos.facturacion;
  const reservado = await db.withPlatform(async (tx) => {
    const datos = await datosPago(tx, paymentId);
    if (!datos || !datos.p.facturacion || !datos.p.documento_cifrado) return null;
    const { p, doc } = datos;
    if (!['PENDIENTE_CONFIGURACION', 'EN_PROCESO'].includes(doc.estado_fiscal)) return null;
    // Consecutivo dentro del rango autorizado, reservado una sola vez por pago (los reintentos lo reutilizan).
    let consecutivo: number | null = doc.factura_consecutivo;
    if (!consecutivo) {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('factura_plataforma'))`);
      const max = (await tx.query(`SELECT max(factura_consecutivo) AS m FROM documento_pago`)).rows[0].m;
      consecutivo = Math.max(Number(max ?? 0) + 1, f.rangoDesde);
      if (consecutivo > f.rangoHasta) {
        await tx.query(`UPDATE documento_pago SET fiscal_motivo='Se agotó el rango de numeración autorizado.', actualizado_en=now() WHERE id=$1`, [doc.id]);
        await registrarIncidente(tx, { codigo: 'PAGO_REQUIERE_REVISION', servicio: 'facturacion', tenantId: p.tenant_id, correlacion, detalle: { tipo_trabajo: 'facturacion.rango_agotado' } });
        return null;
      }
    }
    await tx.query(`UPDATE documento_pago SET estado_fiscal='EN_PROCESO', factura_consecutivo=$2, actualizado_en=now() WHERE id=$1`, [doc.id, consecutivo]);
    return { p, doc, consecutivo };
  });
  if (!reservado) return 'OMITIDO';
  const { p, doc, consecutivo } = reservado;
  const fa = p.facturacion;
  const v = calcularValores(Number(p.monto), config.documentos.responsableIva, config.documentos.ivaPct);
  const e = config.documentos.emisor;
  const r = await proveedorFiscalPlataforma()!.emitir({
    numeroSecuencial: consecutivo, prefijo: f.prefijo!, fecha: new Date(),
    emisor: { razonSocial: e.razonSocial!, nit: e.numeroDocumento!, direccion: e.direccion!, ciudad: e.ciudad! },
    adquirente: { nombre: fa.nombre, tipoDocumento: fa.tipo_documento, numeroDocumento: decrypt(config.appKey, p.documento_cifrado), dv: fa.dv, email: fa.email, telefono: fa.telefono, direccion: fa.direccion, ciudad: fa.ciudad },
    concepto: p.concepto, base: v.base ?? v.total, iva: v.iva ?? 0, total: v.total, referenciaPago: p.referencia,
  });
  if (r.estado === 'VALIDADA') {
    // Solo una respuesta completa del proveedor cuenta como validada.
    if (!r.numero || !r.cufe || !r.xml) throw new Error('Respuesta de validación incompleta del proveedor fiscal');
    await db.withPlatform(async (tx) => {
      await tx.query(
        `UPDATE documento_pago SET estado_fiscal='VALIDADA', factura_numero=$2, cufe=$3, factura_xml=$4, factura_qr=$5, factura_validada_en=$6, fiscal_motivo=NULL, actualizado_en=now() WHERE id=$1`,
        [doc.id, r.numero, r.cufe, r.xml, r.qr ?? null, (r.validadaEn ?? new Date()).toISOString()]);
      await auditPlatform(tx, p.tenant_id ?? null, SISTEMA, 'TRABAJADOR', correlacion, { accion: 'facturacion.validada', recurso: 'documento_pago', recursoId: doc.id, resultado: 'EXITO', detalle: { numero: r.numero, referencia: p.referencia } });
      await encolarDocumentos(tx, paymentId, 'factura');
    });
    return 'VALIDADA';
  }
  if (r.estado === 'RECHAZADA') {
    await db.withPlatform(async (tx) => {
      await tx.query(`UPDATE documento_pago SET estado_fiscal='RECHAZADA', fiscal_motivo=$2, actualizado_en=now() WHERE id=$1`, [doc.id, (r.motivo ?? 'Rechazada por la DIAN').slice(0, 300)]);
      await registrarIncidente(tx, { codigo: 'PAGO_REQUIERE_REVISION', servicio: 'facturacion', tenantId: p.tenant_id, correlacion, detalle: { tipo_trabajo: 'facturacion.rechazada' } });
    });
    return 'RECHAZADA';
  }
  return 'EN_PROCESO';
}

// ---------------------------------------------------------------- recuperación
/** Pagos aprobados sin documentos (o con la factura pendiente y la facturación ya habilitada). */
export async function recuperarDocumentos(db: Database) {
  const habilitada = (await estadoFacturacionPlataforma()).habilitada;
  return db.withPlatform(async (tx) => {
    const sinDocs = (await tx.query(
      `SELECT p.id FROM payment p LEFT JOIN documento_pago d ON d.payment_id=p.id
       WHERE p.estado='APROBADO' AND p.tenant_id IS NOT NULL AND p.facturacion IS NOT NULL
         AND (d.id IS NULL OR (d.estado IN ('GENERANDO','FALLIDO') AND d.intentos < 8 AND d.actualizado_en < now() - interval '5 minutes'))
       LIMIT 25`)).rows;
    for (const r of sinDocs) await encolarDocumentos(tx, r.id, `recuperacion-${Math.floor(Date.now() / 600_000)}`);
    let fiscales = 0;
    if (habilitada) {
      const pend = (await tx.query(`SELECT payment_id FROM documento_pago WHERE estado_fiscal IN ('PENDIENTE_CONFIGURACION','EN_PROCESO') AND estado='LISTO' LIMIT 25`)).rows;
      for (const r of pend) await enqueue(tx, null, 'emitir_factura_pago', { payment_id: r.payment_id }, { claveUnica: `factura:${r.payment_id}:${Math.floor(Date.now() / 600_000)}`, maxIntentos: 3 });
      fiscales = pend.length;
    }
    return { documentos: sinDocs.length, fiscales };
  });
}

// ---------------------------------------------------------------- descargas
function enlace(doc: any) {
  if (doc.estado !== 'LISTO') throw new AppError('CONFLICT', doc.estado === 'SIN_DATOS' ? 'Este pago no tiene datos de facturación para generar documentos.' : 'Los documentos todavía se están generando.', { estado: doc.estado });
  const { token, expiraEn } = firmarEnlace(doc.id, doc.version);
  return { token, expira_en: expiraEn.toISOString(), numero: doc.numero, version: doc.version };
}

/** Quien pagó (portador del token del borrador) obtiene un enlace temporal mientras dure la ventana. */
export async function enlaceDocumentosBorrador(db: Database, draftToken: string) {
  return db.withPlatform(async (tx) => {
    const r = (await tx.query(
      `SELECT d.* , p.verificado_en FROM payment p JOIN documento_pago d ON d.payment_id=p.id
       WHERE p.draft_token=$1 AND p.estado='APROBADO' ORDER BY p.verificado_en NULLS LAST LIMIT 1`, [draftToken])).rows[0];
    if (!r) throw notFound();
    if (r.verificado_en && Date.now() - new Date(r.verificado_en).getTime() > DIAS_DESCARGA_BORRADOR * 86_400_000) {
      throw new AppError('FORBIDDEN', 'Inicia sesión en tu empresa para descargar tus documentos (Suscripción › Pagos).');
    }
    return enlace(r);
  });
}

/** Un usuario de la empresa con permiso de suscripción: la RLS limita a los documentos propios. */
export async function enlaceDocumentosTenant(tx: Tx, documentoId: string) {
  const r = (await tx.query(`SELECT id, numero, estado, version FROM documento_pago WHERE id=$1`, [documentoId])).rows[0];
  if (!r) throw notFound();
  return enlace(r);
}

export async function documentosTenant(tx: Tx) {
  return (await tx.query(
    `SELECT id, numero, estado, version, zip_bytes, estado_fiscal, factura_numero, generado_en, creado_en FROM documento_pago ORDER BY creado_en DESC LIMIT 50`)).rows
    .map((d: any) => ({ ...d, estado_fiscal_texto: etiquetaFiscal(d.estado_fiscal) }));
}

/** Entrega el ZIP de un enlace válido y vigente (sin exponer dónde se guarda). */
export async function descargarDocumentos(db: Database, token: string) {
  const v = verificarEnlace(token);
  if (!v) throw new AppError('FORBIDDEN', 'El enlace de descarga venció o no es válido. Genera uno nuevo.');
  const d = await db.withPlatform(async (tx) => (await tx.query(`SELECT numero, zip, version FROM documento_pago WHERE id=$1 AND estado='LISTO'`, [v.documentoId])).rows[0]);
  if (!d?.zip) throw notFound();
  if (d.version !== v.version) throw new AppError('CONFLICT', 'Los documentos se actualizaron. Genera un enlace nuevo.');
  return { nombre: `documentos-omnegia-${d.numero}.zip`, contenido: Buffer.from(d.zip) };
}

/** Estado público de los documentos de un borrador (sin contenido). */
export async function estadoDocumentosBorrador(tx: Tx, draftToken: string) {
  const r = (await tx.query(
    `SELECT d.numero, d.estado, d.version, d.estado_fiscal, d.zip_bytes, d.generado_en FROM payment p LEFT JOIN documento_pago d ON d.payment_id=p.id
     WHERE p.draft_token=$1 AND p.estado='APROBADO' ORDER BY p.verificado_en NULLS LAST LIMIT 1`, [draftToken])).rows[0];
  if (!r) return null;
  return {
    estado: r.estado ?? 'PENDIENTE', numero: r.numero ?? null, version: r.version ?? 0, disponible: r.estado === 'LISTO',
    estado_fiscal: r.estado_fiscal ?? 'PENDIENTE_CONFIGURACION', estado_fiscal_texto: etiquetaFiscal(r.estado_fiscal ?? 'PENDIENTE_CONFIGURACION'),
    validez_fiscal: r.estado_fiscal === 'VALIDADA', bytes: r.zip_bytes ?? null,
  };
}

/** Reintento manual tras un fallo (portador del borrador). */
export async function reintentarDocumentosBorrador(db: Database, draftToken: string) {
  return db.withPlatform(async (tx) => {
    const p = (await tx.query(`SELECT id FROM payment WHERE draft_token=$1 AND estado='APROBADO' LIMIT 1`, [draftToken])).rows[0];
    if (!p) throw notFound();
    const d = (await tx.query(`SELECT estado, intentos FROM documento_pago WHERE payment_id=$1`, [p.id])).rows[0];
    if (d?.estado === 'LISTO') return { ok: true, estado: 'LISTO' };
    await encolarDocumentos(tx, p.id, `manual-${(d?.intentos ?? 0)}`);
    return { ok: true, estado: 'GENERANDO' };
  });
}
