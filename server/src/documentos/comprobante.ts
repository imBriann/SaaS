import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { MARCA } from '../brand.js';
import { cop } from '../lib/util.js';

/**
 * Representación PDF del pago: comprobante sin validez fiscal o, solo cuando la DIAN validó
 * la factura electrónica, su representación gráfica con número autorizado, CUFE y QR.
 * El PDF se protege con contraseña (AES-256): el número de documento del contratante.
 */
export interface DatosComprobante {
  numero: string;
  referencia: string;
  transaccionId: string | null;
  fechaPago: Date;
  generadoEn: Date;
  emisor: { razonSocial?: string; tipoDocumento?: string; numeroDocumento?: string; direccion?: string; ciudad?: string; correo?: string; telefono?: string };
  contratante: { nombre: string; tipoDocumentoNombre: string; numeroDocumento: string; dv: string | null; email: string; telefono: string; direccion: string; ciudad: string; departamento: string | null };
  servicio: { concepto: string; empresa: string | null; direccion: string | null; modalidad: 'COMERCIAL' | 'INSTITUCIONAL'; accesoDias: number | null; vigenteHasta: Date | null };
  valores: Valores;
  fiscal: { estado: 'PENDIENTE_CONFIGURACION' | 'EN_PROCESO' | 'VALIDADA' | 'RECHAZADA' | 'NO_APLICA'; numero?: string | null; cufe?: string | null; qr?: string | null; validadaEn?: Date | null };
}

export interface Valores { total: number; base: number | null; iva: number | null; ivaPct: number | null; regimen: 'RESPONSABLE' | 'NO_RESPONSABLE' | 'PENDIENTE' }

/** Impuestos según el régimen configurado del emisor. Precio con IVA incluido; cálculo en centavos. */
export function calcularValores(total: number, responsableIva: '1' | '0' | null, ivaPct: number): Valores {
  if (responsableIva === '1') {
    const totalC = Math.round(total * 100);
    const baseC = Math.round(totalC / (1 + ivaPct / 100));
    return { total, base: baseC / 100, iva: (totalC - baseC) / 100, ivaPct, regimen: 'RESPONSABLE' };
  }
  if (responsableIva === '0') return { total, base: total, iva: 0, ivaPct: null, regimen: 'NO_RESPONSABLE' };
  return { total, base: null, iva: null, ivaPct: null, regimen: 'PENDIENTE' };
}

const COLOR = { marca: MARCA.colorPrimario, tinta: MARCA.colorTexto, tenue: '#5B6475', borde: '#E3E6EC', fondo: '#F6F7FB', aviso: '#8A5A00', avisoFondo: '#FDF4DF', ok: '#1D6B40', okFondo: '#E5F2EA' };
const RUTA_LOGO = join(dirname(fileURLToPath(import.meta.url)), '../../assets/omnegia-logo.png');
const LOGO = existsSync(RUTA_LOGO) ? readFileSync(RUTA_LOGO) : null;

const fechaHora = (d: Date) => d.toLocaleString('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
const fecha = (d: Date) => d.toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric' });
/** Pesos con centavos solo cuando los hay (p. ej. la base y el IVA de un precio con IVA incluido). */
const pesos = (n: number) => (Number.isInteger(n) ? `${cop(n)} COP` : `$${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} COP`);

export async function generarPdf(d: DatosComprobante, contrasena: string): Promise<Buffer> {
  if (!contrasena) throw new Error('Falta la contraseña del PDF');
  const validada = d.fiscal.estado === 'VALIDADA' && !!d.fiscal.cufe && !!d.fiscal.numero;
  const qr = validada && d.fiscal.qr ? await QRCode.toBuffer(d.fiscal.qr, { type: 'png', margin: 1, width: 300, errorCorrectionLevel: 'M' }) : null;
  const doc = new PDFDocument({
    size: 'LETTER', margins: { top: 48, bottom: 48, left: 52, right: 52 },
    userPassword: contrasena,
    // Contraseña de propietario aleatoria y desechable: nadie puede quitar las restricciones.
    ownerPassword: randomBytes(24).toString('base64url'),
    pdfVersion: '1.7ext3',
    permissions: { printing: 'highResolution', copying: true, modifying: false, annotating: false, fillingForms: false, contentAccessibility: true, documentAssembly: false },
    info: { Title: validada ? `Factura electrónica ${d.fiscal.numero}` : `Comprobante de pago ${d.numero}`, Author: MARCA.nombre, Subject: d.servicio.concepto, Creator: MARCA.nombre },
    lang: 'es-CO',
  });
  const partes: Buffer[] = [];
  doc.on('data', (b: Buffer) => partes.push(b));
  const fin = new Promise<Buffer>((ok, mal) => { doc.on('end', () => ok(Buffer.concat(partes))); doc.on('error', mal); });

  const izq = doc.page.margins.left;
  const ancho = doc.page.width - izq - doc.page.margins.right;

  // ---- Cabecera
  if (LOGO) doc.image(LOGO, izq, 44, { height: 30 });
  else doc.font('Helvetica-Bold').fontSize(20).fillColor(COLOR.marca).text(MARCA.nombre, izq, 46);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLOR.tinta)
    .text(validada ? 'Factura electrónica de venta' : 'Comprobante de pago', izq, 44, { width: ancho, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(COLOR.tenue)
    .text(validada ? `No. ${d.fiscal.numero}` : `No. ${d.numero}`, izq, 64, { width: ancho, align: 'right' });
  doc.moveTo(izq, 90).lineTo(izq + ancho, 90).lineWidth(2).strokeColor(COLOR.marca).stroke();

  // ---- Estado fiscal (siempre visible)
  let y = 104;
  const banda = (texto: string, detalle: string, color: string, fondo: string) => {
    doc.roundedRect(izq, y, ancho, 46, 6).fill(fondo);
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(color).text(texto, izq + 14, y + 9, { width: ancho - 28 });
    doc.font('Helvetica').fontSize(9).fillColor(color).text(detalle, izq + 14, y + 25, { width: ancho - 28 });
    y += 58;
  };
  if (validada) banda('Factura electrónica validada por la DIAN', `Validada el ${fechaHora(d.fiscal.validadaEn ?? d.generadoEn)}. Consulta el documento con el CUFE o el código QR.`, COLOR.ok, COLOR.okFondo);
  else banda('DOCUMENTO SIN VALIDEZ FISCAL · No es una factura electrónica',
    d.fiscal.estado === 'RECHAZADA' ? 'La factura electrónica fue rechazada y está en revisión. Este comprobante solo acredita el pago recibido.'
      : 'La facturación electrónica está pendiente de configuración. Este comprobante acredita el pago recibido; la factura que corresponda se emitirá aparte.',
    COLOR.aviso, COLOR.avisoFondo);

  // ---- Emisor y contratante
  const columna = (titulo: string, lineas: (string | null | undefined)[], x: number, w: number) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.tenue).text(titulo.toUpperCase(), x, y, { width: w, characterSpacing: 0.6 });
    let yy = y + 15;
    for (const l of lineas.filter(Boolean) as string[]) {
      doc.font(yy === y + 15 ? 'Helvetica-Bold' : 'Helvetica').fontSize(yy === y + 15 ? 10.5 : 9.5).fillColor(COLOR.tinta).text(l, x, yy, { width: w });
      yy = doc.y + 2;
    }
    return yy;
  };
  const e = d.emisor;
  const c = d.contratante;
  const mitad = (ancho - 24) / 2;
  const yEmisor = columna('Emisor', [
    e.razonSocial ?? MARCA.nombre,
    e.numeroDocumento ? `${e.tipoDocumento ?? 'NIT'} ${e.numeroDocumento}` : 'Identificación del emisor pendiente de configuración',
    [e.direccion, e.ciudad].filter(Boolean).join(' · ') || null, e.correo, e.telefono,
  ], izq, mitad);
  const yContratante = columna('Contratante', [
    c.nombre, `${c.tipoDocumentoNombre} ${c.numeroDocumento}${c.dv ? `-${c.dv}` : ''}`,
    [c.direccion, c.ciudad, c.departamento].filter(Boolean).join(' · '), c.email, c.telefono,
  ], izq + mitad + 24, mitad);
  y = Math.max(yEmisor, yContratante) + 14;

  // ---- Operación
  const filas: [string, string][] = [
    ['Referencia de pago', d.referencia],
    ['Transacción Wompi', d.transaccionId ?? 'No disponible'],
    ['Fecha y hora del pago', fechaHora(d.fechaPago)],
    ...(validada ? [['Fecha de validación DIAN', fechaHora(d.fiscal.validadaEn ?? d.generadoEn)] as [string, string]] : []),
  ];
  doc.roundedRect(izq, y, ancho, filas.length * 20 + 14, 6).fill(COLOR.fondo);
  let yy = y + 9;
  for (const [k, v] of filas) {
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.tenue).text(k, izq + 14, yy, { width: 170 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR.tinta).text(v, izq + 190, yy, { width: ancho - 204 });
    yy += 20;
  }
  y = yy + 18;

  // ---- Detalle del servicio
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.tenue).text('DESCRIPCIÓN', izq, y, { characterSpacing: 0.6 });
  doc.text('VALOR', izq, y, { width: ancho, align: 'right', characterSpacing: 0.6 });
  y += 14;
  doc.moveTo(izq, y).lineTo(izq + ancho, y).lineWidth(0.8).strokeColor(COLOR.borde).stroke();
  y += 10;
  const s = d.servicio;
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(COLOR.tinta).text(s.concepto, izq, y, { width: ancho - 140 });
  doc.text(pesos(d.valores.total), izq, y, { width: ancho, align: 'right' });
  y = doc.y + 4;
  const detalles = [
    s.modalidad === 'INSTITUCIONAL' ? `Modalidad institucional · pago único${s.accesoDias ? ` por ${s.accesoDias} días de acceso` : ''} · sin renovación ni cobros automáticos` : 'Plan comercial mensual',
    s.empresa ? `Empresa: ${s.empresa}${s.direccion ? ` (${s.direccion})` : ''}` : null,
    s.vigenteHasta ? `Acceso vigente hasta el ${fecha(s.vigenteHasta)}` : null,
  ].filter(Boolean) as string[];
  for (const l of detalles) { doc.font('Helvetica').fontSize(9).fillColor(COLOR.tenue).text(l, izq, y, { width: ancho - 140 }); y = doc.y + 2; }
  y += 10;
  doc.moveTo(izq, y).lineTo(izq + ancho, y).lineWidth(0.8).strokeColor(COLOR.borde).stroke();
  y += 10;

  // ---- Totales
  const v = d.valores;
  const total = (k: string, val: string, fuerte = false) => {
    doc.font(fuerte ? 'Helvetica-Bold' : 'Helvetica').fontSize(fuerte ? 12 : 9.5).fillColor(fuerte ? COLOR.tinta : COLOR.tenue).text(k, izq + ancho - 300, y, { width: 170, align: 'right' });
    doc.text(val, izq + ancho - 120, y, { width: 120, align: 'right' });
    y = doc.y + 5;
  };
  if (v.regimen === 'RESPONSABLE') { total('Base gravable', pesos(v.base!)); total(`IVA (${v.ivaPct}%) incluido`, pesos(v.iva!)); }
  else if (v.regimen === 'NO_RESPONSABLE') total('IVA', 'No aplica');
  total('Total pagado', pesos(v.total), true);
  const notaImpuestos = v.regimen === 'NO_RESPONSABLE' ? 'El emisor no es responsable de IVA.'
    : v.regimen === 'PENDIENTE' ? 'Impuestos: el régimen tributario del emisor está pendiente de configuración; no se discriminan impuestos en este comprobante.' : null;
  if (notaImpuestos) { doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.tenue).text(notaImpuestos, izq, y + 2, { width: ancho, align: 'right' }); y = doc.y; }
  y += 12;

  // ---- Datos fiscales (solo con factura validada)
  if (validada) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.tenue).text('CUFE', izq, y, { characterSpacing: 0.6 });
    doc.font('Courier').fontSize(7.5).fillColor(COLOR.tinta).text(d.fiscal.cufe!, izq, y + 13, { width: ancho - 120 });
    if (qr) doc.image(qr, izq + ancho - 100, y, { width: 100 });
    y += 110;
  }

  // ---- Pie
  const pie = doc.page.height - doc.page.margins.bottom - 34;
  doc.moveTo(izq, pie).lineTo(izq + ancho, pie).lineWidth(0.6).strokeColor(COLOR.borde).stroke();
  doc.font('Helvetica').fontSize(8).fillColor(COLOR.tenue)
    .text(`${MARCA.nombre} · ${MARCA.lema} · Generado el ${fechaHora(d.generadoEn)}${validada ? '' : ' · Documento sin validez fiscal'} · Pago procesado por Wompi; ${MARCA.nombre} no almacena datos de tarjetas.`, izq, pie + 8, { width: ancho, align: 'center' });
  doc.end();
  return fin;
}
