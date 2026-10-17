import { z } from 'zod';
import type { Database } from '../db/index.js';
import { config, origenRetorno } from '../config.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { aCentavos } from '../lib/money.js';
import { consultarTransaccionWompi, cuentaPlataforma, mediosPagoWompi } from '../adapters/payments.js';
import {
  aceptacionWompi, bancosPse, crearTransaccionWompi, leerTransaccionWompi, METODOS_DIRECTOS, type AccionPago, type DatosMetodo,
} from '../adapters/wompiDirecto.js';
import { procesarEventoPago } from '../modules/billing.js';
import { quoteClassification } from './pricing.js';
import { ofertaAlta, puedeContratar } from './oferta.js';
import { startCheckout } from './service.js';

/**
 * Pago con formulario propio. Reutiliza el pago pendiente que crea `startCheckout` (misma referencia, mismo monto,
 * mismas validaciones: correo verificado, datos, aceptación legal) y solo cambia cómo se cobra: en vez de enviar a la
 * persona al checkout de Wompi, se crea la transacción por API. La confirmación sigue siendo la de siempre:
 * el evento firmado de Wompi o la consulta servidor a servidor; el navegador nunca confirma un pago.
 */
const NOMBRE_METODO: Record<string, string> = {
  CARD: 'Tarjeta de crédito o débito', NEQUI: 'Nequi', PSE: 'PSE (cuenta de ahorros o corriente)', BANCOLOMBIA_TRANSFER: 'Botón Bancolombia', BANCOLOMBIA_QR: 'QR Bancolombia',
};

async function cargarBorrador(db: Database, tk: string) {
  if (!tk || tk.length < 20) throw notFound();
  const d = await db.withPlatform(async (tx) => (await tx.query(`SELECT token, estado, clasificacion, recomendacion, negocio FROM onboarding_draft WHERE token=$1`, [tk])).rows[0]);
  if (!d) throw notFound();
  return d;
}

/** Qué se puede ofrecer. Sin confirmación de Wompi para la cuenta, no se promete ningún método: queda el checkout de Wompi. */
export async function configPagoDirecto(db: Database, tk: string) {
  const d = await cargarBorrador(db, tk);
  const cuenta = cuentaPlataforma();
  if (!cuenta || !puedeContratar()) return { disponible: false as const };
  if (cuenta.proveedor === 'simulada') {
    return { disponible: true as const, simulado: true as const, metodos: METODOS_DIRECTOS.map((codigo) => ({ codigo, nombre: NOMBRE_METODO[codigo] })), bancos: [{ codigo: '1007', nombre: 'Banco de pruebas' }] };
  }
  const monto = ofertaAlta((d.recomendacion?.cotizacion ?? quoteClassification(d.clasificacion)).total).monto;
  const medios = await mediosPagoWompi(cuenta, monto);
  const metodos = medios.medios.filter((m) => (METODOS_DIRECTOS as readonly string[]).includes(m.codigo)).map((m) => ({ codigo: m.codigo, nombre: NOMBRE_METODO[m.codigo] ?? m.nombre }));
  const aceptacion = metodos.length ? await aceptacionWompi(cuenta) : null;
  if (!metodos.length || !aceptacion) return { disponible: false as const };
  return {
    disponible: true as const, simulado: false as const, entorno: cuenta.entorno, api: cuenta.entorno === 'produccion' ? 'https://production.wompi.co/v1' : 'https://sandbox.wompi.co/v1',
    llave_publica: cuenta.llavePublica, metodos,
    // Solo los enlaces: los tokens de aceptación se piden en el servidor al cobrar y solo si la persona aceptó.
    aceptacion: { terminos: aceptacion.terminos.permalink, datos: aceptacion.datos.permalink },
    bancos: metodos.some((m) => m.codigo === 'PSE') ? await bancosPse(cuenta) : [],
  };
}

const Celular = z.string().regex(/^3\d{9}$/, 'Escribe tu celular de 10 dígitos, empezando por 3.');
const Cuerpo = z.object({
  retorno: z.string().max(200).optional(),
  acepta_wompi: z.literal(true, { error: 'Para pagar debes aceptar los términos y la autorización de datos de Wompi.' }),
  cliente: z.object({ nombre: z.string().trim().min(2, 'Escribe tu nombre.').max(80), telefono: z.string().regex(/^\d{7,15}$/, 'Escribe un teléfono válido, solo números.') }),
  pago: z.discriminatedUnion('metodo', [
    z.object({
      metodo: z.literal('CARD'), token: z.string().regex(/^tok_[A-Za-z0-9_]{6,100}$/, 'No pudimos leer los datos de la tarjeta. Inténtalo de nuevo.'),
      cuotas: z.number().int().min(1).max(36),
      navegador: z.object({
        browser_color_depth: z.string().max(4), browser_screen_height: z.string().max(6), browser_screen_width: z.string().max(6),
        browser_language: z.string().max(35), browser_user_agent: z.string().max(500), browser_tz: z.string().max(6),
      }),
    }),
    z.object({ metodo: z.literal('NEQUI'), celular: Celular }),
    z.object({
      metodo: z.literal('PSE'), tipo_persona: z.union([z.literal(0), z.literal(1)]), tipo_documento: z.enum(['CC', 'NIT']),
      documento: z.string().regex(/^\d{5,15}$/, 'Escribe el documento solo con números.'), banco: z.string().regex(/^\d{1,6}$/, 'Elige tu banco.'),
    }),
    z.object({ metodo: z.literal('BANCOLOMBIA_TRANSFER') }),
    z.object({ metodo: z.literal('BANCOLOMBIA_QR') }),
  ]),
});

function aDatos(p: z.infer<typeof Cuerpo>['pago'], ip: string): DatosMetodo {
  switch (p.metodo) {
    case 'CARD': return { metodo: 'CARD', token: p.token, cuotas: p.cuotas, navegador: p.navegador };
    case 'NEQUI': return { metodo: 'NEQUI', celular: p.celular };
    case 'PSE': return { metodo: 'PSE', tipoPersona: p.tipo_persona, tipoDocumento: p.tipo_documento, documento: p.documento, banco: p.banco, ip: /^[\d.:a-f]{3,45}$/i.test(ip) ? ip : undefined };
    default: return { metodo: p.metodo };
  }
}

export async function iniciarPagoDirecto(db: Database, tk: string, body: unknown, ctx: { ip: string; correlacion: string }) {
  const p = Cuerpo.safeParse(body);
  if (!p.success) throw invalid(p.error.issues[0]?.message ?? 'Revisa los datos del pago.');
  const b = p.data;
  const cuenta = cuentaPlataforma();
  if (!cuenta) throw new AppError('CONFLICT', 'El pago en línea todavía no está habilitado.');
  // Crea (o reutiliza) el pago pendiente con todas las validaciones del checkout normal.
  const r: any = await startCheckout(db, tk, ctx.correlacion, b.retorno);
  if (r.ya_pagado) return { ya_pagado: true as const };
  if (cuenta.proveedor === 'simulada') {
    await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'SISTEMA', id: null, nombre: 'Pagos' }, 'API', ctx.correlacion, { accion: 'pago.directo_iniciado', resultado: 'EXITO', detalle: { referencia: r.referencia, metodo: b.pago.metodo, proveedor: 'simulada' } }));
    return { referencia: r.referencia as string, simulado: true as const, estado: 'PENDIENTE', accion: { tipo: 'simulado' } as { tipo: 'simulado' } };
  }
  const d = await cargarBorrador(db, tk);
  const email = String(d.negocio?.email ?? '');
  const aceptacion = await aceptacionWompi(cuenta);
  if (!aceptacion) throw new AppError('CONFLICT', 'No pudimos conectar con Wompi para iniciar el pago. Intenta de nuevo o paga en el sitio seguro de Wompi.');
  const origen = origenRetorno(b.retorno);
  const redirectUrl = `${origen && (cuenta.entorno !== 'produccion' || origen.startsWith('https://')) ? origen : config.publicUrl}/empezar/listo`;
  const res = await crearTransaccionWompi(cuenta, {
    referencia: r.referencia, montoCentavos: aCentavos(r.monto), descripcion: 'Omnegia', redirectUrl, aceptacion,
    cliente: { email, nombre: b.cliente.nombre, telefono: b.cliente.telefono }, datos: aDatos(b.pago, ctx.ip),
  });
  if (!res.ok) throw new AppError(res.reintentable ? 'CONFLICT' : 'VALIDATION', res.mensaje);
  // Constancia sin datos de pago: ni el token de la tarjeta ni documentos.
  await db.withPlatform((tx) => auditPlatform(tx, null, { tipo: 'SISTEMA', id: null, nombre: 'Pagos' }, 'API', ctx.correlacion, {
    accion: 'pago.directo_iniciado', resultado: 'EXITO', detalle: { referencia: r.referencia, metodo: b.pago.metodo, transaccion: res.transaccion.id, monto: Number(r.monto) },
  }));
  return { referencia: r.referencia as string, transaccion_id: res.transaccion.id, estado: res.transaccion.estado, accion: res.transaccion.accion };
}

export type EstadoDirecto = 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | 'ANULADO' | 'ERROR';
const ESTADO: Record<string, EstadoDirecto> = { PENDING: 'PENDIENTE', APPROVED: 'APROBADO', DECLINED: 'RECHAZADO', VOIDED: 'ANULADO', ERROR: 'ERROR' };

/**
 * Estado del intento de pago. Solo se consulta una transacción de este borrador: la referencia de Wompi debe ser
 * una de las suyas. Un estado final se procesa igual que el retorno del checkout (idempotente), que es lo que
 * aprueba el pago y activa el alta.
 */
export async function estadoPagoDirecto(db: Database, tk: string, transaccionId: unknown, correlacion: string): Promise<{ estado: EstadoDirecto; accion: AccionPago | { tipo: 'simulado' }; mensaje: string | null }> {
  await cargarBorrador(db, tk);
  const pagos = await db.withPlatform(async (tx) => (await tx.query(`SELECT referencia, estado FROM payment WHERE draft_token=$1 ORDER BY creado_en DESC`, [tk])).rows as { referencia: string; estado: string }[]);
  if (!pagos.length) throw notFound();
  if (pagos.some((x) => x.estado === 'APROBADO')) return { estado: 'APROBADO', accion: { tipo: 'final' }, mensaje: null };
  const cuenta = cuentaPlataforma();
  if (cuenta?.proveedor === 'simulada') return { estado: pagos[0].estado === 'RECHAZADO' ? 'RECHAZADO' : 'PENDIENTE', accion: { tipo: 'simulado' }, mensaje: null };
  if (!cuenta) throw new AppError('CONFLICT', 'El pago en línea todavía no está habilitado.');
  const id = String(transaccionId ?? '');
  const tx = await leerTransaccionWompi(cuenta, id);
  if (!tx || !pagos.some((x) => x.referencia === tx.referencia)) throw notFound();
  if (tx.estado !== 'PENDING') {
    const ev = await consultarTransaccionWompi(cuenta, id);
    if (ev) await procesarEventoPago(db, ev, correlacion, 'retorno');
    const aprobado = await db.withPlatform(async (t) => (await t.query(`SELECT 1 FROM payment WHERE draft_token=$1 AND estado='APROBADO'`, [tk])).rows.length > 0);
    if (tx.estado === 'APPROVED' && !aprobado) return { estado: 'PENDIENTE', accion: { tipo: 'esperar', mensaje: 'Recibimos tu pago y lo estamos confirmando…' }, mensaje: null };
    return { estado: ESTADO[tx.estado], accion: { tipo: 'final' }, mensaje: tx.estado === 'APPROVED' ? null : tx.mensaje };
  }
  return { estado: 'PENDIENTE', accion: tx.accion, mensaje: null };
}
