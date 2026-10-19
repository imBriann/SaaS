import { config } from '../config.js';

/**
 * Puerto del proveedor de numeración. Cada adaptador implementa SOLO lo que su API oficial
 * permite: si no reserva, `reservar` devuelve null y el flujo vuelve a comprobar la
 * disponibilidad justo antes de comprar.
 *
 * Comprar un número no activa WhatsApp: eso ocurre después, con Meta (ver ./meta.ts).
 */
export type TipoNumero = 'local' | 'mobile' | 'national' | 'toll_free';
export type Caracteristica = 'voice' | 'sms' | 'mms' | 'fax' | 'emergency';

export interface NumeroDisponible {
  numero: string;
  pais: string;
  tipo: TipoNumero;
  localidad: string | null;
  region: string | null;
  caracteristicas: Caracteristica[];
  reservable: boolean;
  /** Costo del proveedor tal como lo informa su API, en su moneda (Telnyx: USD). */
  costo: { activacion: number; mensual: number; moneda: string };
}

export interface TipoCubierto { tipo: TipoNumero; caracteristicas: Caracteristica[]; reservable: boolean }
export interface Cobertura { pais: string; tipos: TipoCubierto[] }

export type CampoRequisito = 'textual' | 'address' | 'document';
export interface Requisito {
  id: string;
  nombre: string;
  descripcion: string;
  ejemplo: string | null;
  campo: CampoRequisito;
  criterios: Record<string, unknown>;
}

export interface Direccion {
  nombre: string; apellido: string; empresa: string; direccion: string; complemento?: string;
  ciudad: string; departamento?: string; codigoPostal?: string; telefono?: string;
}
export type ValorRequisito =
  | { id: string; campo: 'textual'; valor: string }
  | { id: string; campo: 'address'; direccion: Direccion }
  | { id: string; campo: 'document'; archivo: { nombre: string; base64: string } };

export interface Reserva { id: string; expiraEn: Date }

export type EstadoOrden = 'pendiente' | 'exito' | 'fallo' | 'cancelada';
export type EstadoRequisitos = 'pendiente' | 'en_revision' | 'rechazado' | 'aprobado' | null;
export interface Orden { id: string; estado: EstadoOrden; requisitos: EstadoRequisitos; vence: string | null }

/** Error del proveedor: `reintentable` distingue un fallo temporal de uno definitivo. */
export class ErrorProveedor extends Error {
  constructor(message: string, public reintentable: boolean, public codigo?: string, public http?: number) { super(message); }
}
/** El número ya no se puede comprar (lo tomó otro cliente o salió del inventario). */
export class NumeroNoDisponible extends ErrorProveedor {
  constructor() { super('El número ya no está disponible en el proveedor.', false, 'NO_DISPONIBLE'); }
}

export interface ProveedorNumeros {
  nombre: string;
  /** 'real' = API del proveedor. 'simulado' = inventario de demostración, nunca en producción. */
  entorno: 'real' | 'simulado';
  cobertura(pais: string): Promise<Cobertura | null>;
  buscar(f: { pais: string; tipo: TipoNumero; localidad?: string; contiene?: string; limite?: number }): Promise<NumeroDisponible[]>;
  /** Vuelve a consultar un número concreto en el inventario (antes de reservar y antes de comprar). */
  consultar(numero: string, pais: string, tipo: TipoNumero): Promise<NumeroDisponible | null>;
  /** null = este proveedor no reserva o el número no es reservable. */
  reservar(numero: string): Promise<Reserva | null>;
  requisitos(pais: string, tipo: TipoNumero): Promise<Requisito[]>;
  enviarRequisitos(pais: string, tipo: TipoNumero, valores: ValorRequisito[], referencia: string): Promise<{ grupoId: string }>;
  ordenar(numero: string, o: { grupoId: string | null; referencia: string }): Promise<Orden>;
  /** Idempotencia: una orden ya creada con esta referencia (p. ej. si el proceso cayó tras pedirla). */
  ordenPorReferencia(referencia: string): Promise<Orden | null>;
  consultarOrden(id: string): Promise<Orden>;
  /** Identificador del número ya comprado en la cuenta (para configurarlo o liberarlo). */
  idDelNumero(numero: string): Promise<string | null>;
  liberar(numeroId: string): Promise<void>;
}

let reemplazo: ProveedorNumeros | null = null;
let cache: { clave: string; p: ProveedorNumeros | null } | null = null;

/** Proveedor según la configuración (o el de las pruebas). null = pendiente de conectar. */
export async function proveedorNumeros(): Promise<ProveedorNumeros | null> {
  if (reemplazo) return reemplazo;
  const clave = config.numeros.proveedor;
  if (cache?.clave === clave) return cache.p;
  let p: ProveedorNumeros | null = null;
  if (clave === 'telnyx') p = new (await import('./telnyx.js')).TelnyxNumeros();
  else if (clave === 'simulado' && config.simuladores) p = new (await import('./simulado.js')).SimuladorNumeros();
  cache = { clave, p };
  return p;
}
export const setProveedorNumeros = (p: ProveedorNumeros | null) => { reemplazo = p; };

/**
 * Elegibilidad para WhatsApp Business Platform de un número del proveedor. Meta exige un número
 * con indicativo de país y de área que reciba SMS o una llamada de voz sin menú (IVR). Los
 * gratuitos (01 8000) suelen no recibir llamadas internacionales —la de verificación de Meta lo
 * es— y por eso no se ofrecen.
 *
 * La activación automática usa la llamada de voz: el número se conecta a la aplicación TeXML de
 * Omnegia, que atiende y transcribe el código. Un número sin voz no se ofrece en este flujo
 * (recibir el SMS exigiría otro perfil del proveedor que no está implementado).
 */
export function elegibleWhatsApp(n: Pick<NumeroDisponible, 'tipo' | 'caracteristicas'>): { ok: boolean; metodo: 'VOICE' | null; motivo: string } {
  if (n.tipo === 'toll_free') return { ok: false, metodo: null, motivo: 'Los números gratuitos no reciben de forma confiable la llamada internacional de verificación de Meta.' };
  if (n.caracteristicas.includes('voice')) return { ok: true, metodo: 'VOICE', motivo: 'Recibe llamadas: Meta dicta el código en una llamada que Omnegia atiende por ti.' };
  return { ok: false, metodo: null, motivo: 'No recibe llamadas: la verificación automática de Meta no podría completarse.' };
}
