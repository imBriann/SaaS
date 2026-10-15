import { config } from '../config.js';
import { nitValido } from '../adapters/fiscal.js';

/**
 * Facturación electrónica DIAN de los pagos a la plataforma (Omnegia como emisor).
 *
 * Hoy NO hay ningún proveedor tecnológico implementado: el registro está vacío, así que la
 * emisión queda «pendiente de configuración» y solo se entrega un comprobante de pago sin
 * validez fiscal. Nunca se generan XML, CUFE, numeraciones ni estados de aceptación ficticios.
 *
 * Para habilitarla: implementar un adaptador con esta interfaz contra un proveedor autorizado,
 * registrarlo y configurar FACTURACION_ELECTRONICA_PLATAFORMA=1 con emisor y resolución. La
 * emisión se encola aparte del pago: el sistema de pagos no cambia.
 */
export interface DatosEmision {
  numeroSecuencial: number;
  prefijo: string;
  fecha: Date;
  emisor: { razonSocial: string; nit: string; direccion: string; ciudad: string };
  adquirente: { nombre: string; tipoDocumento: string; numeroDocumento: string; dv?: string | null; email: string; telefono: string; direccion: string; ciudad: string };
  concepto: string;
  base: number;
  iva: number;
  total: number;
  referenciaPago: string;
}

export interface ResultadoEmision {
  estado: 'VALIDADA' | 'RECHAZADA' | 'EN_PROCESO';
  /** Número de factura autorizado (prefijo + consecutivo), solo si la DIAN la validó. */
  numero?: string;
  cufe?: string;
  /** XML firmado tal como lo devuelve el proveedor (no se modifica). */
  xml?: Buffer;
  /** Contenido del QR que exige la representación gráfica (URL de consulta DIAN). */
  qr?: string;
  validadaEn?: Date;
  motivo?: string;
}

export interface ProveedorFiscalPlataforma {
  nombre: string;
  /** Comprueba credenciales y habilitación contra el proveedor (sin emitir). */
  verificar(): Promise<{ ok: boolean; motivo?: string }>;
  emitir(d: DatosEmision): Promise<ResultadoEmision>;
}

const registro = new Map<string, ProveedorFiscalPlataforma>();
export const registrarProveedorFiscalPlataforma = (p: ProveedorFiscalPlataforma) => void registro.set(p.nombre, p);
export const retirarProveedorFiscalPlataforma = (nombre: string) => void registro.delete(nombre);

/** Último resultado de verificar() por proveedor: la habilitación exige credenciales comprobadas. */
const verificados = new Map<string, { ok: boolean; motivo?: string; en: number }>();

/** Requisitos locales (sin llamar al proveedor). */
export function requisitosFacturacion(c = config): string[] {
  const f = c.documentos.facturacion;
  const e = c.documentos.emisor;
  const m: string[] = [];
  if (!f.activa) m.push('La facturación electrónica de la plataforma no está activada (FACTURACION_ELECTRONICA_PLATAFORMA).');
  if (!f.proveedor) m.push('Falta el proveedor tecnológico autorizado (FACTURACION_PROVEEDOR).');
  else if (!registro.has(f.proveedor)) m.push(`No hay un adaptador implementado para el proveedor «${f.proveedor}».`);
  if (!e.razonSocial) m.push('Falta la razón social del emisor (EMISOR_RAZON_SOCIAL).');
  if (e.tipoDocumento !== 'NIT' || !e.numeroDocumento || !nitValido(e.numeroDocumento)) m.push('El emisor necesita un NIT válido con dígito de verificación (EMISOR_NUMERO_DOCUMENTO).');
  if (!e.direccion || !e.ciudad) m.push('Faltan la dirección y la ciudad del emisor.');
  if (c.documentos.responsableIva === null) m.push('Falta definir el régimen de IVA del emisor (EMISOR_RESPONSABLE_IVA).');
  if (!f.prefijo || !f.resolucion) m.push('Faltan el prefijo y la resolución de numeración autorizada.');
  if (!Number.isInteger(f.rangoDesde) || !Number.isInteger(f.rangoHasta) || f.rangoDesde < 1 || f.rangoHasta < f.rangoDesde) m.push('El rango de numeración autorizado no es válido.');
  const vigencia = f.vigenciaHasta ? new Date(`${f.vigenciaHasta}T23:59:59-05:00`) : null;
  if (!vigencia || Number.isNaN(vigencia.getTime()) || vigencia.getTime() < Date.now()) m.push('La resolución de numeración no tiene una vigencia válida (FACTURACION_RESOLUCION_VIGENCIA, AAAA-MM-DD).');
  return m;
}

export interface EstadoFacturacion { habilitada: boolean; proveedor: string | null; motivos: string[] }

/** ¿Se puede emitir? Requisitos locales + credenciales verificadas con el proveedor (cacheado 1 hora). */
export async function estadoFacturacionPlataforma(c = config): Promise<EstadoFacturacion> {
  const motivos = requisitosFacturacion(c);
  const nombre = c.documentos.facturacion.proveedor ?? null;
  if (motivos.length || !nombre) return { habilitada: false, proveedor: nombre, motivos };
  const p = registro.get(nombre)!;
  let v = verificados.get(nombre);
  if (!v || Date.now() - v.en > 3600_000) {
    try { v = { ...(await p.verificar()), en: Date.now() }; } catch { v = { ok: false, motivo: 'El proveedor no respondió a la verificación.', en: Date.now() }; }
    verificados.set(nombre, v);
  }
  if (!v.ok) return { habilitada: false, proveedor: nombre, motivos: [v.motivo ?? 'Las credenciales del proveedor no se pudieron verificar.'] };
  return { habilitada: true, proveedor: nombre, motivos: [] };
}

export const proveedorFiscalPlataforma = (c = config) => (c.documentos.facturacion.proveedor ? registro.get(c.documentos.facturacion.proveedor) ?? null : null);
export const olvidarVerificaciones = () => verificados.clear();
