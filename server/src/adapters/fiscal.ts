import { sha384, token } from '../lib/util.js';

/**
 * Puerto del proveedor tecnológico de facturación electrónica (PRO-SW-001 §16.1,
 * ADR-08). El dominio solo conoce esta interfaz; el proveedor concreto (Facele,
 * Factus, Alegra, Siigo...) se decide en el punto go/no-go 3.
 */
export interface DocumentoFiscalSolicitud {
  tipo: 'FACTURA' | 'NOTA_CREDITO';
  numero: string;
  fecha: string; // ISO
  emisor: { nit: string; razonSocial: string; ciudad: string | null };
  adquirente: { nombre: string; tipoDocumento: string | null; numeroDocumento: string | null; email: string | null };
  items: { descripcion: string; cantidad: number; precioUnitario: number; ivaPct: number; total: number }[];
  subtotal: number;
  impuestos: number;
  total: number;
  moneda: string;
  documentoReferencia?: { numero: string; cufe: string | null; motivo: string };
}

export type RespuestaProveedor =
  | { ok: true; cufe: string; codigo: string; mensaje: string; crudo: Record<string, unknown> }
  | { ok: false; reintentable: boolean; codigo: string; mensaje: string; crudo: Record<string, unknown> };

export interface FiscalProvider {
  nombre: string;
  emitir(doc: DocumentoFiscalSolicitud): Promise<RespuestaProveedor>;
}

/** Dígito de verificación del NIT (algoritmo módulo 11 de la DIAN). */
export function digitoVerificacionNit(nit: string): number {
  const pesos = [71, 67, 59, 53, 47, 43, 41, 37, 29, 23, 19, 17, 13, 7, 3];
  const digits = nit.replace(/\D/g, '').split('').reverse();
  let sum = 0;
  digits.forEach((d, i) => (sum += Number(d) * pesos[pesos.length - 1 - i]));
  const r = sum % 11;
  return r > 1 ? 11 - r : r;
}

export function nitValido(nitConDv: string): boolean {
  const m = nitConDv.replace(/[.\s]/g, '').match(/^(\d{6,15})-?(\d)$/);
  if (!m) return false;
  return digitoVerificacionNit(m[1]) === Number(m[2]);
}

/**
 * Proveedor de pruebas que reproduce las validaciones y respuestas relevantes
 * de un proveedor habilitado: CUFE SHA-384, rechazo por NIT del adquirente o del
 * emisor inválido, y fallos transitorios opcionales para probar reintentos.
 */
export class SandboxFiscalProvider implements FiscalProvider {
  nombre = 'sandbox';
  constructor(private opts: { fallaTransitoria?: () => boolean } = {}) {}

  async emitir(doc: DocumentoFiscalSolicitud): Promise<RespuestaProveedor> {
    const crudo = { proveedor: 'sandbox', recibido: new Date().toISOString(), numero: doc.numero };
    if (this.opts.fallaTransitoria?.()) {
      return { ok: false, reintentable: true, codigo: 'TIMEOUT', mensaje: 'El servicio de la DIAN no respondió a tiempo.', crudo };
    }
    if (!doc.emisor.nit || !nitValido(doc.emisor.nit)) {
      return { ok: false, reintentable: false, codigo: 'FAJ21', mensaje: 'NIT del emisor no válido o sin dígito de verificación.', crudo };
    }
    if (doc.adquirente.tipoDocumento === 'NIT' && (!doc.adquirente.numeroDocumento || !nitValido(doc.adquirente.numeroDocumento))) {
      return {
        ok: false, reintentable: false, codigo: 'FAK24',
        mensaje: `NIT del adquirente no válido: «${doc.adquirente.numeroDocumento ?? ''}». Verifica el dígito de verificación.`,
        crudo,
      };
    }
    if (doc.total <= 0) return { ok: false, reintentable: false, codigo: 'FAU04', mensaje: 'El valor total debe ser mayor que cero.', crudo };
    if (doc.tipo === 'NOTA_CREDITO' && !doc.documentoReferencia?.cufe) {
      return { ok: false, reintentable: false, codigo: 'CBF02', mensaje: 'La nota crédito debe referenciar una factura validada.', crudo };
    }
    const cufe = sha384(
      [doc.numero, doc.fecha, doc.subtotal.toFixed(2), '01', doc.impuestos.toFixed(2), doc.total.toFixed(2), doc.emisor.nit, doc.adquirente.numeroDocumento ?? '222222222222', 'clave-tecnica-sandbox', '2'].join(''),
    );
    return { ok: true, cufe, codigo: '00', mensaje: 'Documento validado por la DIAN', crudo: { ...crudo, trackId: token(12) } };
  }
}

let provider: FiscalProvider = new SandboxFiscalProvider();
export const fiscalProvider = () => provider;
export const setFiscalProvider = (p: FiscalProvider) => (provider = p);
