import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { MARCA } from '../brand.js';
import { COLOR, fechaHora, pesos, type Valores } from './comprobante.js';

/**
 * PDF del comprobante de venta que una empresa entrega a su cliente: soporte interno de la operación,
 * SIN validez fiscal. Usa la marca de la empresa (logo y color del tema) y los mismos estilos que el
 * comprobante de pago de la plataforma (comprobante.ts). Nunca lleva CUFE ni QR fiscal: el QR, si lo
 * hay, abre la página pública de verificación interna del comprobante.
 */

/** Leyenda obligatoria, visible y no editable, del PDF, el correo y el WhatsApp del comprobante de venta. */
export const LEYENDA_COMPROBANTE = 'Documento no válido como factura electrónica de venta ante la DIAN. Soporte interno de la operación.';
export const TITULO_COMPROBANTE = 'Comprobante de venta';

export interface LineaComprobante { descripcion: string; cantidad: number; precio_unitario: number; descuento: number; subtotal: number }

export interface DatosComprobanteVenta {
  numero: string;
  estado: 'EMITIDO' | 'ANULADO';
  emitidoEn: Date;
  anuladoEn?: Date | null;
  motivoAnulacion?: string | null;
  venta: number;
  empresa: { nombre: string; documento?: string | null; direccion?: string | null; telefono?: string | null; correo?: string | null; logo?: Buffer | null; color?: string | null };
  cliente: { nombre: string; documento?: string | null; telefono?: string | null; correo?: string | null };
  lineas: LineaComprobante[];
  subtotal: number;
  descuento: number;
  impuestos: number;
  total: number;
  regimen: Valores['regimen'];
  medioPago?: string | null;
  notas?: string | null;
  pie?: string | null;
  /** Enlace público de verificación (va como QR). */
  urlVerificacion?: string | null;
}

/** Logotipo de la empresa (data URL PNG o JPEG; pdfkit no lee WebP: sin logo se escribe el nombre). */
export function logoDeDataUrl(dataUrl: string | null | undefined): Buffer | null {
  const m = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUrl ?? '');
  return m ? Buffer.from(m[2], 'base64') : null;
}

const colorValido = (c: string | null | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c : COLOR.marca);

export async function generarPdfVenta(d: DatosComprobanteVenta, o: { comprimir?: boolean } = {}): Promise<Buffer> {
  const acento = colorValido(d.empresa.color);
  const anulado = d.estado === 'ANULADO';
  const qr = d.urlVerificacion ? await QRCode.toBuffer(d.urlVerificacion, { type: 'png', margin: 1, width: 240, errorCorrectionLevel: 'M' }) : null;
  const doc = new PDFDocument({
    size: 'LETTER', margins: { top: 48, bottom: 48, left: 52, right: 52 }, compress: o.comprimir ?? true,
    info: { Title: `${TITULO_COMPROBANTE} ${d.numero}`, Author: d.empresa.nombre, Subject: LEYENDA_COMPROBANTE, Creator: MARCA.nombre },
    lang: 'es-CO',
  });
  const partes: Buffer[] = [];
  doc.on('data', (b: Buffer) => partes.push(b));
  const fin = new Promise<Buffer>((ok, mal) => { doc.on('end', () => ok(Buffer.concat(partes))); doc.on('error', mal); });
  const izq = doc.page.margins.left;
  const ancho = doc.page.width - izq - doc.page.margins.right;

  // ---- Cabecera: marca de la empresa, título y número
  let conLogo = false;
  if (d.empresa.logo) { try { doc.image(d.empresa.logo, izq, 42, { fit: [150, 40] }); conLogo = true; } catch { conLogo = false; } }
  if (!conLogo) doc.font('Helvetica-Bold').fontSize(17).fillColor(acento).text(d.empresa.nombre, izq, 46, { width: ancho / 2 });
  doc.font('Helvetica-Bold').fontSize(15).fillColor(COLOR.tinta).text(TITULO_COMPROBANTE, izq, 44, { width: ancho, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(COLOR.tenue).text(`No. ${d.numero} · ${fechaHora(d.emitidoEn)}`, izq, 64, { width: ancho, align: 'right' });
  doc.moveTo(izq, 90).lineTo(izq + ancho, 90).lineWidth(2).strokeColor(acento).stroke();

  // ---- Leyenda (siempre) y marca de anulación
  let y = 102;
  doc.roundedRect(izq, y, ancho, 34, 6).fill(COLOR.avisoFondo);
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLOR.aviso).text(LEYENDA_COMPROBANTE, izq + 12, y + 10, { width: ancho - 24 });
  y += 44;
  if (anulado) {
    doc.roundedRect(izq, y, ancho, 40, 6).fill('#FBE4E4');
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#9B1C1C').text('ANULADO', izq + 12, y + 7, { width: ancho - 24 });
    doc.font('Helvetica').fontSize(8.5).fillColor('#9B1C1C')
      .text(`${d.anuladoEn ? `El ${fechaHora(d.anuladoEn)}` : 'Anulado'}${d.motivoAnulacion ? ` · Motivo: ${d.motivoAnulacion}` : ''}`, izq + 12, y + 24, { width: ancho - 24 });
    y += 50;
  }

  // ---- Empresa y cliente
  const columna = (titulo: string, lineas: (string | null | undefined)[], x: number, w: number) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.tenue).text(titulo.toUpperCase(), x, y, { width: w, characterSpacing: 0.6 });
    let yy = y + 15;
    (lineas.filter(Boolean) as string[]).forEach((l, i) => {
      doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 0 ? 10.5 : 9.5).fillColor(COLOR.tinta).text(l, x, yy, { width: w });
      yy = doc.y + 2;
    });
    return yy;
  };
  const mitad = (ancho - 24) / 2;
  const e = d.empresa;
  const c = d.cliente;
  const yE = columna('Vendido por', [e.nombre, e.documento, e.direccion, e.telefono, e.correo], izq, mitad);
  const yC = columna('Cliente', [c.nombre, c.documento, c.telefono, c.correo], izq + mitad + 24, mitad);
  y = Math.max(yE, yC) + 14;

  // ---- Detalle
  const x = { cant: izq + ancho - 300, unit: izq + ancho - 240, desc: izq + ancho - 160, sub: izq + ancho - 90 };
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR.tenue);
  doc.text('DESCRIPCIÓN', izq, y, { width: 220 });
  doc.text('CANT.', x.cant, y, { width: 50, align: 'right' });
  doc.text('VALOR UNIT.', x.unit, y, { width: 75, align: 'right' });
  doc.text('DESC.', x.desc, y, { width: 65, align: 'right' });
  doc.text('SUBTOTAL', x.sub, y, { width: 90, align: 'right' });
  y += 13;
  doc.moveTo(izq, y).lineTo(izq + ancho, y).lineWidth(0.8).strokeColor(COLOR.borde).stroke();
  y += 7;
  for (const l of d.lineas) {
    if (y > doc.page.height - 220) { doc.addPage(); y = doc.page.margins.top; }
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.tinta).text(l.descripcion, izq, y, { width: ancho - 310 });
    const yFila = doc.y;
    doc.text(String(l.cantidad), x.cant, y, { width: 50, align: 'right' });
    doc.text(pesos(l.precio_unitario), x.unit, y, { width: 75, align: 'right' });
    doc.text(l.descuento ? `−${pesos(l.descuento)}` : '—', x.desc, y, { width: 65, align: 'right' });
    doc.text(pesos(l.subtotal), x.sub, y, { width: 90, align: 'right' });
    y = Math.max(yFila, doc.y) + 6;
  }
  doc.moveTo(izq, y).lineTo(izq + ancho, y).lineWidth(0.8).strokeColor(COLOR.borde).stroke();
  y += 10;

  // ---- Totales: el IVA solo se desglosa si la empresa se configuró como responsable de IVA
  const total = (k: string, val: string, fuerte = false) => {
    doc.font(fuerte ? 'Helvetica-Bold' : 'Helvetica').fontSize(fuerte ? 12 : 9.5).fillColor(fuerte ? COLOR.tinta : COLOR.tenue).text(k, izq + ancho - 320, y, { width: 190, align: 'right' });
    doc.text(val, izq + ancho - 120, y, { width: 120, align: 'right' });
    y = doc.y + 5;
  };
  if (d.descuento > 0) total('Descuentos aplicados', `−${pesos(d.descuento)}`);
  if (d.regimen === 'RESPONSABLE') { total('Base', pesos(d.subtotal)); total('IVA incluido', pesos(d.impuestos)); }
  total('Total', pesos(d.total), true);
  if (d.medioPago) total('Medio de pago', d.medioPago);
  y += 8;
  const yBloque = y;
  if (d.notas) {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(COLOR.tenue).text('NOTAS', izq, y, { characterSpacing: 0.6 });
    doc.font('Helvetica').fontSize(9.5).fillColor(COLOR.tinta).text(d.notas, izq, y + 13, { width: ancho - 130 });
    y = doc.y + 8;
  }
  doc.font('Helvetica').fontSize(8.5).fillColor(COLOR.tenue).text(`Venta #${d.venta}`, izq, y, { width: ancho - 130 });
  if (qr) {
    const yQr = Math.min(yBloque, doc.page.height - doc.page.margins.bottom - 160);
    doc.image(qr, izq + ancho - 96, yQr, { width: 96 });
    doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.tenue).text('Verifica este comprobante', izq + ancho - 116, yQr + 98, { width: 136, align: 'center' });
  }

  // ---- Pie: texto libre de la empresa (p. ej. política de cambios) y la leyenda otra vez
  const pie = doc.page.height - doc.page.margins.bottom - 50;
  // El pie se escribe dentro del margen inferior: sin esto pdfkit abriría una página nueva.
  doc.page.margins.bottom = 0;
  doc.moveTo(izq, pie).lineTo(izq + ancho, pie).lineWidth(0.6).strokeColor(COLOR.borde).stroke();
  if (d.pie) doc.font('Helvetica').fontSize(8).fillColor(COLOR.tinta).text(d.pie, izq, pie + 6, { width: ancho, align: 'center', height: 20, ellipsis: true });
  doc.font('Helvetica').fontSize(7.5).fillColor(COLOR.tenue).text(`${LEYENDA_COMPROBANTE} Generado con ${MARCA.nombre}.`, izq, pie + (d.pie ? 28 : 10), { width: ancho, align: 'center', lineBreak: true });
  doc.end();
  return fin;
}
