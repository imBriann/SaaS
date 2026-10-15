import { z } from 'zod';
import { config } from '../config.js';
import { decrypt, encrypt, hmacHex } from '../lib/util.js';
import { digitoVerificacionNit } from '../adapters/fiscal.js';
import { invalid } from '../lib/errors.js';
import { normalizarDocumento } from '../documentos/proteccion.js';

/**
 * Datos de facturación del contratante (quien paga a la plataforma). Se piden antes de un
 * cobro real y se congelan en el pago. El número de documento se guarda cifrado con APP_KEY:
 * nunca vuelve completo al navegador (solo enmascarado) ni aparece en registros.
 */
export const TIPOS_DOCUMENTO = {
  CC: 'Cédula de ciudadanía',
  CE: 'Cédula de extranjería',
  NIT: 'NIT',
  PP: 'Pasaporte',
  PPT: 'Permiso por protección temporal',
  DE: 'Documento de identificación extranjero',
} as const;
export type TipoDocumento = keyof typeof TIPOS_DOCUMENTO;

const FORMATO: Record<TipoDocumento, { re: RegExp; ayuda: string }> = {
  CC: { re: /^\d{5,10}$/, ayuda: 'La cédula tiene entre 5 y 10 dígitos.' },
  CE: { re: /^[0-9A-Z]{4,12}$/, ayuda: 'La cédula de extranjería tiene entre 4 y 12 caracteres.' },
  NIT: { re: /^\d{8,10}$/, ayuda: 'El NIT tiene entre 8 y 10 dígitos, sin el dígito de verificación.' },
  PP: { re: /^[0-9A-Z]{5,15}$/, ayuda: 'El pasaporte tiene entre 5 y 15 letras o números.' },
  PPT: { re: /^\d{5,12}$/, ayuda: 'El PPT tiene entre 5 y 12 dígitos.' },
  DE: { re: /^[0-9A-Z]{4,20}$/, ayuda: 'El documento tiene entre 4 y 20 letras o números.' },
};

export const FacturacionInput = z.object({
  nombre: z.string().trim().min(3, 'Escribe el nombre completo o la razón social.').max(120),
  tipo_documento: z.enum(Object.keys(TIPOS_DOCUMENTO) as [TipoDocumento, ...TipoDocumento[]]),
  /** Obligatorio la primera vez; si se omite, se conserva el guardado. */
  numero_documento: z.string().trim().max(30).optional(),
  dv: z.string().trim().max(1).optional().nullable(),
  email: z.email('Escribe un correo válido.'),
  telefono: z.string().trim().max(20).refine((t) => /^\+?[\d\s-]{7,20}$/.test(t) && t.replace(/\D/g, '').length >= 7, 'Escribe un teléfono válido.'),
  direccion: z.string().trim().min(5, 'Escribe la dirección.').max(150),
  ciudad: z.string().trim().min(2, 'Escribe la ciudad.').max(60),
  departamento: z.string().trim().max(60).optional().nullable(),
}).strict();

export interface FacturacionGuardada {
  nombre: string; tipo_documento: TipoDocumento; documento_cifrado: string; documento_mascara: string; dv: string | null;
  email: string; telefono: string; direccion: string; ciudad: string; departamento: string | null;
}

const mascara = (n: string) => `•••• ${n.slice(-4)}`;

/** Valida y prepara para guardar. `previa` permite cambiar otros campos sin reescribir el documento. */
export function prepararFacturacion(entrada: unknown, previa?: FacturacionGuardada | null): FacturacionGuardada {
  const p = FacturacionInput.parse(entrada);
  let numero: string | null = null;
  if (p.numero_documento) numero = normalizarDocumento(p.numero_documento);
  else if (previa?.documento_cifrado && previa.tipo_documento === p.tipo_documento) numero = decrypt(config.appKey, previa.documento_cifrado);
  if (!numero) throw invalid('Escribe el número de documento.', { campo: 'numero_documento' });
  // Un NIT escrito con su dígito de verificación (900123456-7) se separa.
  let dv = p.dv ? p.dv.trim() : null;
  if (p.tipo_documento === 'NIT' && p.numero_documento && /-\s*\d$/.test(p.numero_documento.trim())) {
    dv = p.numero_documento.trim().slice(-1);
    numero = numero.slice(0, -1);
  }
  const f = FORMATO[p.tipo_documento];
  if (!f.re.test(numero)) throw invalid(f.ayuda, { campo: 'numero_documento' });
  if (p.tipo_documento === 'NIT') {
    if (!dv || !/^\d$/.test(dv)) throw invalid('Escribe el dígito de verificación del NIT.', { campo: 'dv' });
    if (digitoVerificacionNit(numero) !== Number(dv)) throw invalid('El dígito de verificación no corresponde al NIT.', { campo: 'dv' });
  } else dv = null;
  return {
    nombre: p.nombre, tipo_documento: p.tipo_documento, documento_cifrado: encrypt(config.appKey, numero), documento_mascara: mascara(numero), dv,
    email: p.email.toLowerCase(), telefono: p.telefono, direccion: p.direccion, ciudad: p.ciudad, departamento: p.departamento || null,
  };
}

export const numeroDocumento = (f: Pick<FacturacionGuardada, 'documento_cifrado'>) => decrypt(config.appKey, f.documento_cifrado);

/** Huella de los datos (incluido el documento) para saber si un checkout pendiente sigue vigente. */
export const huellaFacturacion = (f: FacturacionGuardada) => hmacHex(config.appKey, JSON.stringify([
  f.nombre, f.tipo_documento, numeroDocumento(f), f.dv, f.email, f.telefono, f.direccion, f.ciudad, f.departamento,
]));

/** Copia sin el documento cifrado: lo que viaja al navegador y se congela en el pago. */
export const facturacionPublica = (f: FacturacionGuardada) => {
  const { documento_cifrado: _omitido, ...resto } = f;
  return { ...resto, tipo_documento_nombre: TIPOS_DOCUMENTO[f.tipo_documento] };
};

/** Vista para el formulario: lo guardado o, si no hay, una sugerencia con lo dado en el registro. */
export function vistaFacturacion(negocio: any) {
  const g: FacturacionGuardada | undefined = negocio?.facturacion;
  if (g?.documento_cifrado) return { completa: true, sugerida: false, datos: facturacionPublica(g) };
  const nit = typeof negocio?.nit === 'string' ? negocio.nit.replace(/[.\s]/g, '') : '';
  const m = /^(\d{6,15})-?(\d)$/.exec(nit);
  return {
    completa: false, sugerida: true,
    datos: {
      nombre: negocio?.nombre ?? '', tipo_documento: m ? 'NIT' : 'CC', numero_sugerido: m ? m[1] : '', dv: m ? m[2] : null,
      email: negocio?.email ?? '', telefono: negocio?.telefono ?? '', direccion: '', ciudad: negocio?.ciudad ?? '', departamento: null,
    },
  };
}
