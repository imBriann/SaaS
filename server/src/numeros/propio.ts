import { z } from 'zod';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { Database, Tx } from '../db/index.js';
import { type Ctx, requirePerm, requireWritable } from '../core/context.js';
import { auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { registrarIncidente } from '../core/incidentes.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { isUuid, uuidv7 } from '../lib/util.js';
import { metaPlataforma, motivoRegistro, type MetaDePlataforma, type MotivoRegistro } from './meta.js';
import {
  actorDe, anotar, cacheTokens, cargar, contratacionViva, credencial, guardarCredencial, mover, nombreActor, pinNuevo,
  soltarTurno, tomarTurno, vincularEmpresa, type Estado, type Fila,
} from './servicio.js';

/**
 * «Usar mi propio número»: la empresa escribe su número, recibe un código por SMS (o llamada) y queda
 * conectada a la IA. Nunca entra a Meta: Omnegia registra el número en SU cuenta de WhatsApp Business
 * (WHATSAPP_PLATFORM_WABA_ID) con el token del usuario del sistema (WHATSAPP_ACCESS_TOKEN).
 *
 *   NUMERO_INGRESADO → CODIGO_ENVIADO → CODIGO_VERIFICADO → REGISTRADO → CONECTADO
 *   Fallo: CONEXION_FALLIDA. Desconexión o abandono: CANCELADO.
 *
 * Graph API (developers.facebook.com › WhatsApp › registro de números):
 *   POST /{waba}/phone_numbers  {cc, phone_number, verified_name}   → id del número
 *   POST /{id}/request_code?code_method=SMS|VOICE&language=es
 *   POST /{id}/verify_code?code=…
 *   POST /{id}/register         {messaging_product: 'whatsapp', pin}  (PIN de 6 dígitos, cifrado con APP_KEY)
 *   POST /{id}/deregister       (al desconectar)
 *
 * Los mensajes del número llegan al webhook de la app sin configuración por empresa: la app está suscrita a
 * la WABA de Omnegia (subscribed_apps) y channelInbound resuelve la empresa por tenant.whatsapp_phone_number_id.
 * El canal habla con Meta con el token de la plataforma (este flujo no guarda token por empresa).
 */
const MAX_INTENTOS_CODIGO = 5;
const MAX_REENVIOS_HORA = 3;
const ESPERA_REENVIO_S = 60;
/** Meta no documenta la vigencia del código: Omnegia lo da por vencido a los 10 minutos y pide otro. */
const VIGENCIA_CODIGO_MIN = 10;
const BLOQUEO_MIN = 60;
const MAX_ESPERAS_META = 6;
const ANTES_DE_VERIFICAR: Estado[] = ['NUMERO_INGRESADO', 'CODIGO_ENVIADO'];

/** Países que se ofrecen en el paso 1 (Colombia primero). Meta acepta cualquier número con indicativo. */
export const PAISES_PROPIO: { pais: CountryCode; nombre: string; indicativo: string }[] = [
  { pais: 'CO', nombre: 'Colombia', indicativo: '57' }, { pais: 'MX', nombre: 'México', indicativo: '52' },
  { pais: 'PE', nombre: 'Perú', indicativo: '51' }, { pais: 'EC', nombre: 'Ecuador', indicativo: '593' },
  { pais: 'CL', nombre: 'Chile', indicativo: '56' }, { pais: 'AR', nombre: 'Argentina', indicativo: '54' },
  { pais: 'VE', nombre: 'Venezuela', indicativo: '58' }, { pais: 'PA', nombre: 'Panamá', indicativo: '507' },
  { pais: 'CR', nombre: 'Costa Rica', indicativo: '506' }, { pais: 'GT', nombre: 'Guatemala', indicativo: '502' },
  { pais: 'US', nombre: 'Estados Unidos', indicativo: '1' }, { pais: 'ES', nombre: 'España', indicativo: '34' },
];

const hora = (d: Date | string) => new Date(d).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: 'numeric', minute: '2-digit' });

/** Mensaje para la empresa según la causa. Nunca incluye el texto de Meta. */
export function mensaje(m: MotivoRegistro, x: { nombre?: string | null; quedan?: number; hasta?: Date | string | null } = {}): string {
  switch (m) {
    case 'NUMERO_EN_USO': return 'Este número todavía está activo en la app de WhatsApp o en otra cuenta. En tu celular abre WhatsApp › Ajustes › Cuenta › Eliminar mi cuenta (guarda antes una copia de tus chats si la necesitas), espera unos minutos y vuelve a intentarlo.';
    case 'NUMERO_INVALIDO': return 'WhatsApp no reconoce ese número. Revisa el país y que esté completo: en Colombia, los celulares tienen 10 dígitos y empiezan por 3.';
    case 'CODIGO_INCORRECTO': return x.quedan ? `El código no coincide. Revisa el SMS e inténtalo de nuevo: te ${x.quedan === 1 ? 'queda 1 intento' : `quedan ${x.quedan} intentos`}.` : 'El código no coincide.';
    case 'CODIGO_VENCIDO': return 'Ese código ya venció. Pide uno nuevo con «Reenviar código».';
    case 'DEMASIADOS_INTENTOS': return `Hiciste demasiados intentos. Por seguridad, podrás volver a intentarlo ${x.hasta ? `a las ${hora(x.hasta)}` : 'en una hora'}.`;
    case 'LIMITE_NUMEROS': return 'En este momento no podemos conectar más números. Ya avisamos al equipo de Omnegia para resolverlo y te escribiremos: no tienes que hacer nada más.';
    case 'NOMBRE_RECHAZADO': return `WhatsApp no aceptó «${x.nombre ?? 'el nombre'}» como nombre visible. Usa el nombre real de tu negocio, sin la palabra «WhatsApp», sin emojis y sin escribirlo todo en mayúsculas.`;
    case 'PIN_EXISTENTE': return 'Este número tiene activada la verificación en dos pasos de otra cuenta de WhatsApp. Desactívala en la app (Ajustes › Cuenta › Verificación en dos pasos) o pide a tu proveedor anterior que la quite, y vuelve a intentarlo.';
    case 'ACCESO': return 'La conexión de Omnegia con WhatsApp necesita una revisión. Ya avisamos al equipo; intenta de nuevo más tarde.';
    case 'TEMPORAL': return 'WhatsApp no respondió a tiempo. Intenta de nuevo en un momento.';
    default: return 'No pudimos completar este paso con WhatsApp. Intenta de nuevo o escribe a soporte.';
  }
}
const conflicto = (motivo: MotivoRegistro, x: Parameters<typeof mensaje>[1] = {}, extra: Record<string, unknown> = {}) =>
  new AppError('CONFLICT', mensaje(motivo, x), { motivo, ...extra });

/** Bitácora + auditoría de un paso sin cambio de estado. Nunca lleva el código ni el PIN. */
async function evento(tx: Tx, c: Fila, tipo: string, detalle: Record<string, unknown>, ctx?: Ctx, resultado: 'EXITO' | 'ERROR' | 'DENEGADO' = 'EXITO') {
  const actor = ctx ? actorDe(ctx) : { tipo: 'SISTEMA' as const, id: null, nombre: 'Números de WhatsApp' };
  await tx.query(`INSERT INTO numero_evento (id, contratacion_id, tenant_id, de, a, tipo, detalle, actor) VALUES ($1,$2,$3,$4,$4,$5,$6,$7)`,
    [uuidv7(), c.id, c.tenant_id, c.estado, tipo, JSON.stringify(detalle), nombreActor(actor)]);
  await auditPlatform(tx, c.tenant_id, actor, ctx ? 'PANEL' : 'TRABAJADOR', ctx?.correlacion ?? c.id, { accion: `numero.${tipo}`, recurso: 'numero_contratacion', recursoId: c.id, resultado, detalle });
}

const conCtx = (ctx: Ctx) => ({ actor: actorDe(ctx), origen: 'PANEL', correlacion: ctx.correlacion });

async function permiso(db: Database, ctx: Ctx) {
  await db.withTenant(ctx.tenantId, async () => { requirePerm(ctx, 'tenant:configure', 'numero_contratacion'); requireWritable(ctx); });
}

async function propiaPropio(db: Database, ctx: Ctx, id: string): Promise<Fila> {
  if (!isUuid(id)) throw notFound();
  // La RLS limita la consulta al tenant de la sesión aunque se envíe el id de otra empresa.
  const c = await db.withTenant(ctx.tenantId, async (tx) => (await tx.query(`SELECT * FROM numero_contratacion WHERE id=$1 AND origen='PROPIO'`, [id])).rows[0]);
  if (!c) throw notFound();
  return c;
}

function plataforma(c?: Fila): MetaDePlataforma {
  const mp = metaPlataforma();
  if (!mp) throw new AppError('CONFLICT', 'La conexión con WhatsApp está pendiente de configurar en Omnegia. Escribe a soporte.');
  if (c && mp.meta.simulado !== (c.entorno === 'simulado')) throw new AppError('CONFLICT', 'Este proceso se inició en otro entorno. Empieza de nuevo.');
  return mp;
}

/** Turno exclusivo: dos pestañas no pueden pedir códigos o verificar a la vez. */
async function conTurno<T>(db: Database, id: string, f: () => Promise<T>): Promise<T> {
  if (!(await tomarTurno(db, id))) throw new AppError('CONFLICT', 'Estamos terminando tu solicitud anterior. Espera unos segundos.');
  try { return await f(); } finally { await soltarTurno(db, id); }
}

function bloqueado(c: Fila) {
  if (c.bloqueo_cliente_hasta && new Date(c.bloqueo_cliente_hasta) > new Date()) throw conflicto('DEMASIADOS_INTENTOS', { hasta: c.bloqueo_cliente_hasta }, { bloqueo_hasta: c.bloqueo_cliente_hasta });
}

async function alertarLimite(tx: Tx, c: Fila, correlacion: string) {
  await registrarIncidente(tx, { codigo: 'NUMERO_LIMITE_WABA', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: 'numero_propio', proveedor: 'meta' } });
}

// ---------------------------------------------------------------------------
// Paso 1 · número
// ---------------------------------------------------------------------------
const Inicio = z.object({
  pais: z.string().regex(/^[A-Z]{2}$/),
  numero: z.string().trim().min(4).max(24),
  acepto_aviso: z.literal(true, { message: 'Confirma que entiendes que el número dejará de funcionar en la app de WhatsApp del celular.' }),
  nombre_visible: z.string().trim().min(3, 'El nombre visible debe tener al menos 3 caracteres.').max(80).optional(),
  /** Cambiar de número: el actual sigue funcionando hasta que el nuevo quede conectado. */
  cambio: z.boolean().optional(),
});

export function validarNumero(pais: string, numero: string) {
  if (!PAISES_PROPIO.some((p) => p.pais === pais)) throw invalid('Elige un país de la lista.');
  const n = parsePhoneNumberFromString(numero.replace(/[^\d+]/g, ''), pais as CountryCode);
  if (!n || !n.isValid()) throw invalid(pais === 'CO' ? 'Revisa el número: en Colombia, un celular tiene 10 dígitos y empieza por 3 (por ejemplo, 300 123 4567).' : 'Revisa el número: no parece completo para ese país.', { motivo: 'NUMERO_INVALIDO' });
  if (n.country && n.country !== pais) throw invalid('El número no corresponde al país elegido.', { motivo: 'NUMERO_INVALIDO' });
  return { e164: n.number as string, cc: n.countryCallingCode as string, nacional: n.nationalNumber as string };
}

export async function iniciar(db: Database, ctx: Ctx, body: unknown) {
  await permiso(db, ctx);
  const b = Inicio.safeParse(body);
  if (!b.success) throw invalid(b.error.issues[0]?.message ?? 'Revisa los datos.');
  const mp = plataforma();
  const n = validarNumero(b.data.pais, b.data.numero);
  const previo = await db.withPlatform(async (tx) => ({
    t: (await tx.query(`SELECT nombre, whatsapp_phone_number_id, whatsapp_estado, whatsapp_numero_visible FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0],
    viva: await contratacionViva(tx, ctx.tenantId),
    bloqueo: (await tx.query(`SELECT max(bloqueo_cliente_hasta) AS hasta FROM numero_contratacion WHERE tenant_id=$1 AND origen='PROPIO' AND bloqueo_cliente_hasta > now()`, [ctx.tenantId])).rows[0]?.hasta ?? null,
  }));
  const { t, viva } = previo;
  // Cambio de número: se parte de un número conectado y el actual NO se toca hasta que el nuevo funcione.
  let reemplazaId: string | null = null;
  if (b.data.cambio) {
    if (viva?.reemplaza_id) {
      if (viva.numero_e164 === n.e164 && viva.estado !== 'CONECTADO') return db.withPlatform((tx) => vistaPropio(tx, viva));
      throw new AppError('CONFLICT', 'Ya hay un cambio de número en curso. Termínalo o cancélalo antes de empezar otro.');
    }
    if (viva && !(viva.estado === 'CONECTADO' && viva.origen === 'PROPIO')) {
      throw new AppError('CONFLICT', viva.estado === 'CONECTADO' ? 'Este número se contrató con Omnegia y se cambia desde su contratación. Escribe a soporte si necesitas ayuda.' : 'Ya tienes una conexión en curso. Termínala o cancélala antes de cambiar de número.');
    }
    if (!viva && !t?.whatsapp_phone_number_id) throw new AppError('CONFLICT', 'No tienes un número conectado para cambiar. Conéctalo primero.');
    if (viva && viva.numero_e164 === n.e164) throw new AppError('CONFLICT', 'Ese ya es tu número conectado.');
    reemplazaId = viva?.id ?? null;
  } else if (viva) {
    // Retomar: el mismo número en curso devuelve el proceso tal como quedó.
    if (viva.origen === 'PROPIO' && viva.numero_e164 === n.e164 && viva.estado !== 'CONECTADO') return db.withPlatform((tx) => vistaPropio(tx, viva));
    throw new AppError('CONFLICT', viva.estado === 'CONECTADO' ? 'Ya tienes un número conectado. Desconéctalo antes de conectar otro.' : 'Ya tienes una conexión en curso. Termínala o cancélala antes de empezar otra.');
  }
  // Un número real ya conectado a mano (Configuración › WhatsApp). Los identificadores sim-… de la demostración no cuentan.
  if (!b.data.cambio && t?.whatsapp_phone_number_id && t.whatsapp_estado === 'CONECTADO') {
    throw new AppError('CONFLICT', `Ya tienes un número conectado (${t.whatsapp_numero_visible ?? 'en Configuración › WhatsApp'}). Desconéctalo antes de conectar otro.`);
  }
  if (previo.bloqueo) throw conflicto('DEMASIADOS_INTENTOS', { hasta: previo.bloqueo }, { bloqueo_hasta: previo.bloqueo });
  const nombre = (b.data.nombre_visible ?? String(t?.nombre ?? '')).slice(0, 80).trim();
  if (nombre.length < 3) throw invalid('Escribe el nombre de tu negocio como quieres que lo vean tus clientes.');
  const id = uuidv7();
  let c: Fila = await db.withPlatform(async (tx) => {
    try {
      await tx.query(
        `INSERT INTO numero_contratacion (id, tenant_id, origen, estado, subestado, accion_cliente, proveedor, entorno, pais, tipo_numero, numero_e164, cotizacion, waba_id, nombre_visible, creado_por, es_cambio, reemplaza_id)
         VALUES ($1,$2,'PROPIO','NUMERO_INGRESADO','agregando',NULL,'meta',$3,$4,'propio',$5,NULL,$6,$7,$8,$9,$10)`,
        [id, ctx.tenantId, mp.meta.simulado ? 'simulado' : 'real', b.data.pais, n.e164, mp.waba, nombre, ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null, !!b.data.cambio, reemplazaId]);
    } catch (err) {
      if (/ux_numero_contratacion_vigente/.test(String((err as Error).message))) throw new AppError('CONFLICT', 'Ya tienes una conexión en curso.');
      if (/ux_numero_contratacion_numero/.test(String((err as Error).message))) throw new AppError('CONFLICT', 'Ese número ya se está conectando en otra cuenta de Omnegia. Si es tuyo, escribe a soporte.');
      throw err;
    }
    const f = (await tx.query(`SELECT * FROM numero_contratacion WHERE id=$1`, [id])).rows[0];
    await tx.query(`INSERT INTO numero_evento (id, contratacion_id, tenant_id, de, a, tipo, detalle, actor) VALUES ($1,$2,$3,NULL,'NUMERO_INGRESADO','numero_ingresado',$4,$5)`,
      [uuidv7(), id, ctx.tenantId, JSON.stringify({ pais: b.data.pais, aviso_aceptado: true }), nombreActor(actorDe(ctx))]);
    await auditPlatform(tx, ctx.tenantId, actorDe(ctx), 'PANEL', ctx.correlacion, { accion: 'numero.numero_ingresado', recurso: 'numero_contratacion', recursoId: id, resultado: 'EXITO', detalle: { origen: 'PROPIO', pais: b.data.pais, aviso_aceptado: true } });
    return f;
  });

  return conTurno(db, id, async () => {
    // 1. Alta del número en la WABA de Omnegia.
    let pid: string;
    try {
      pid = await mp.meta.agregarNumero(mp.waba, mp.token, { cc: n.cc, numero: n.nacional, nombre });
    } catch (e) {
      const motivo = motivoRegistro(e);
      // Ya estaba en la cuenta (un intento anterior): se recupera su identificador y se sigue.
      const recuperado = motivo === 'NUMERO_YA_EN_LA_CUENTA' ? await mp.meta.buscarNumero(mp.waba, mp.token, n.e164).catch(() => null) : null;
      if (!recuperado) {
        await db.withPlatform(async (tx) => {
          await mover(tx, c, 'CANCELADO', 'alta_rechazada', { subestado: motivo.toLowerCase(), accion: null, campos: { cancelado_en: new Date(), ultimo_error: mensaje(motivo, { nombre }) }, detalle: { motivo }, ...conCtx(ctx) });
          if (motivo === 'LIMITE_NUMEROS') await alertarLimite(tx, c, ctx.correlacion);
          if (motivo === 'ACCESO') await registrarIncidente(tx, { codigo: 'WHATSAPP_CREDENCIAL', servicio: 'numeros', tenantId: c.tenant_id, correlacion: ctx.correlacion, detalle: { tipo_trabajo: 'numero_propio' } });
        });
        throw conflicto(motivo, { nombre });
      }
      pid = recuperado;
    }
    c = await db.withPlatform((tx) => anotar(tx, c, { phone_number_id: pid, subestado: null }, 'numero_agregado', {}));
    // 2. Código por SMS.
    return enviar(db, c, mp, 'SMS', ctx, false);
  });
}

// ---------------------------------------------------------------------------
// Paso 2 · código
// ---------------------------------------------------------------------------
/** Pide el código a Meta y deja la cuenta de reenvíos. Si Meta dice que ya está verificado, se sigue al registro. */
async function enviar(db: Database, c: Fila, mp: MetaDePlataforma, metodo: 'SMS' | 'VOICE', ctx: Ctx, reenvio: boolean) {
  const v = { ...(c.verificacion ?? {}) };
  try {
    await mp.meta.solicitarCodigo(c.phone_number_id, mp.token, metodo);
  } catch (e) {
    const motivo = motivoRegistro(e);
    if (motivo === 'YA_VERIFICADO') {
      const f = await db.withPlatform((tx) => mover(tx, c, 'CODIGO_VERIFICADO', 'codigo_verificado', { de: ANTES_DE_VERIFICAR, subestado: 'registrando', accion: null, detalle: { ya_verificado: true }, ...conCtx(ctx) }));
      return conectarYVer(db, f ?? c, mp, ctx.correlacion);
    }
    await db.withPlatform(async (tx) => {
      const campos: Record<string, unknown> = { subestado: 'codigo_no_enviado', ultimo_error: mensaje(motivo) };
      if (motivo === 'DEMASIADOS_INTENTOS') campos.bloqueo_cliente_hasta = new Date(Date.now() + BLOQUEO_MIN * 60_000);
      const f = await anotar(tx, c, campos);
      await evento(tx, f, reenvio ? 'codigo_reenvio_fallido' : 'codigo_no_enviado', { metodo, motivo }, ctx, 'ERROR');
      c = f;
    });
    throw conflicto(motivo, { hasta: c.bloqueo_cliente_hasta }, { bloqueo_hasta: c.bloqueo_cliente_hasta ?? null });
  }
  const ahora = new Date().toISOString();
  Object.assign(v, { metodo, enviado_en: ahora, intentos: v.intentos ?? 0, reenvios: reenvio ? [...(v.reenvios ?? []), ahora] : (v.reenvios ?? []) });
  return db.withPlatform(async (tx) => {
    const a = conCtx(ctx);
    const f = c.estado === 'CODIGO_ENVIADO'
      ? await anotar(tx, c, { verificacion: v, subestado: null, ultimo_error: null })
      : await mover(tx, c, 'CODIGO_ENVIADO', 'codigo_enviado', { de: ANTES_DE_VERIFICAR, subestado: null, accion: 'codigo', campos: { verificacion: v, ultimo_error: null }, detalle: { metodo }, ...a });
    if (c.estado === 'CODIGO_ENVIADO' || reenvio) await evento(tx, f!, reenvio ? 'codigo_reenviado' : 'codigo_enviado', { metodo, reenvio: (v.reenvios ?? []).length }, ctx);
    return vistaPropio(tx, f!);
  });
}

export async function reenviar(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permiso(db, ctx);
  const b = z.object({ metodo: z.enum(['SMS', 'VOICE']).default('SMS') }).parse(body ?? {});
  const c0 = await propiaPropio(db, ctx, id);
  if (!ANTES_DE_VERIFICAR.includes(c0.estado) || !c0.phone_number_id) throw new AppError('CONFLICT', 'Este número ya no está esperando un código.');
  const mp = plataforma(c0);
  return conTurno(db, id, async () => {
    const c = (await db.withPlatform((tx) => cargar(tx, id)))!;
    bloqueado(c);
    const v = c.verificacion ?? {};
    if (v.enviado_en) {
      const falta = ESPERA_REENVIO_S - Math.floor((Date.now() - new Date(v.enviado_en).getTime()) / 1000);
      if (falta > 0) throw new AppError('CONFLICT', `Espera ${falta} segundos antes de pedir otro código.`, { motivo: 'ESPERA', espera_s: falta });
    }
    const recientes = (v.reenvios ?? []).filter((x: string) => Date.now() - new Date(x).getTime() < 3_600_000);
    if (recientes.length >= MAX_REENVIOS_HORA) {
      const hasta = new Date(new Date(recientes[0]).getTime() + 3_600_000);
      await db.withPlatform(async (tx) => { const f = await anotar(tx, c, { bloqueo_cliente_hasta: hasta }); await evento(tx, f, 'reenvios_agotados', { reenvios: recientes.length }, ctx, 'DENEGADO'); });
      throw new AppError('CONFLICT', `Ya pediste ${MAX_REENVIOS_HORA} códigos en la última hora. Podrás pedir otro a las ${hora(hasta)}.`, { motivo: 'DEMASIADOS_INTENTOS', bloqueo_hasta: hasta });
    }
    return enviar(db, c, mp, b.metodo, ctx, true);
  });
}

export async function verificar(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permiso(db, ctx);
  const b = z.object({ codigo: z.string().trim().regex(/^\d{3}[- ]?\d{3}$/, 'El código tiene 6 dígitos.') }).safeParse(body);
  if (!b.success) throw invalid(b.error.issues[0]?.message ?? 'El código tiene 6 dígitos.');
  const codigo = b.data.codigo.replace(/\D/g, '');
  const c0 = await propiaPropio(db, ctx, id);
  if (c0.estado !== 'CODIGO_ENVIADO') throw new AppError('CONFLICT', c0.estado === 'NUMERO_INGRESADO' ? 'Primero pide el código.' : 'Este número ya no está esperando un código.');
  const mp = plataforma(c0);
  return conTurno(db, id, async () => {
    let c = (await db.withPlatform((tx) => cargar(tx, id)))!;
    bloqueado(c);
    const v = { ...(c.verificacion ?? {}) };
    if ((v.intentos ?? 0) >= MAX_INTENTOS_CODIGO) throw conflicto('DEMASIADOS_INTENTOS', { hasta: c.bloqueo_cliente_hasta });
    if (v.enviado_en && Date.now() - new Date(v.enviado_en).getTime() > VIGENCIA_CODIGO_MIN * 60_000) {
      await db.withPlatform((tx) => evento(tx, c, 'codigo_vencido', { origen: 'omnegia' }, ctx, 'DENEGADO'));
      throw conflicto('CODIGO_VENCIDO');
    }
    let ok = false;
    try {
      ok = await mp.meta.verificarCodigo(c.phone_number_id, mp.token, codigo);
    } catch (e) {
      const motivo = motivoRegistro(e);
      await db.withPlatform(async (tx) => {
        const campos: Record<string, unknown> = {};
        if (motivo === 'DEMASIADOS_INTENTOS') campos.bloqueo_cliente_hasta = new Date(Date.now() + BLOQUEO_MIN * 60_000);
        c = Object.keys(campos).length ? await anotar(tx, c, campos) : c;
        await evento(tx, c, motivo === 'CODIGO_VENCIDO' ? 'codigo_vencido' : 'verificacion_fallida', { motivo, origen: 'meta' }, ctx, 'ERROR');
      });
      throw conflicto(motivo, { hasta: c.bloqueo_cliente_hasta });
    }
    if (!ok) {
      v.intentos = (v.intentos ?? 0) + 1;
      const quedan = MAX_INTENTOS_CODIGO - v.intentos;
      await db.withPlatform(async (tx) => {
        if (quedan > 0) {
          c = await anotar(tx, c, { verificacion: v, subestado: 'codigo_incorrecto' });
          await evento(tx, c, 'codigo_incorrecto', { intento: v.intentos, quedan }, ctx, 'DENEGADO');
        } else {
          // Agotó los intentos: la conexión se cierra y queda un bloqueo temporal antes de reintentar.
          const hasta = new Date(Date.now() + BLOQUEO_MIN * 60_000);
          c = (await mover(tx, c, 'CONEXION_FALLIDA', 'intentos_agotados', { subestado: 'demasiados_intentos', accion: 'reiniciar', campos: { verificacion: v, bloqueo_cliente_hasta: hasta, ultimo_error: mensaje('DEMASIADOS_INTENTOS', { hasta }) }, detalle: { intentos: v.intentos }, ...conCtx(ctx) }))!;
        }
      });
      if (quedan <= 0) throw conflicto('DEMASIADOS_INTENTOS', { hasta: c.bloqueo_cliente_hasta }, { bloqueo_hasta: c.bloqueo_cliente_hasta });
      throw conflicto('CODIGO_INCORRECTO', { quedan }, { quedan });
    }
    const f = await db.withPlatform((tx) => mover(tx, c, 'CODIGO_VERIFICADO', 'codigo_verificado', { de: ['CODIGO_ENVIADO'], subestado: 'registrando', accion: null, campos: { verificacion: { ...v, verificado_en: new Date().toISOString() } }, ...conCtx(ctx) }));
    if (!f) throw new AppError('CONFLICT', 'El proceso cambió mientras verificabas. Recarga la página.');
    return conectarYVer(db, f, mp, ctx.correlacion);
  });
}

// ---------------------------------------------------------------------------
// Paso 3 · registro y conexión
// ---------------------------------------------------------------------------
async function conectarYVer(db: Database, c: Fila, mp: MetaDePlataforma, correlacion: string) {
  await registrarYConectar(db, c, mp, correlacion);
  return db.withPlatform(async (tx) => vistaPropio(tx, (await cargar(tx, c.id))!));
}

/** Trabajador (reintentos) y paso 3 del panel. Idempotente: no repite el registro ya hecho. */
export async function conectar(db: Database, id: string, correlacion: string): Promise<void | 'reintentar'> {
  const c = await tomarTurno(db, id);
  if (!c) return 'reintentar';
  try {
    if (c.origen !== 'PROPIO' || !['CODIGO_VERIFICADO', 'REGISTRADO'].includes(c.estado)) return;
    const mp = metaPlataforma();
    if (!mp) return;
    await registrarYConectar(db, c, mp, correlacion);
  } finally { await soltarTurno(db, id); }
}

async function fallar(db: Database, c: Fila, motivo: MotivoRegistro, correlacion: string) {
  await db.withPlatform(async (tx) => {
    const f = await mover(tx, c, 'CONEXION_FALLIDA', 'conexion_fallida', { de: ['CODIGO_VERIFICADO', 'REGISTRADO'], subestado: motivo.toLowerCase(), accion: 'reiniciar', campos: { ultimo_error: mensaje(motivo, { nombre: c.nombre_visible }) }, detalle: { motivo }, correlacion });
    if (!f) return;
    if (motivo === 'LIMITE_NUMEROS') await alertarLimite(tx, c, correlacion);
    else await registrarIncidente(tx, { codigo: 'NUMERO_CONEXION_FALLIDA', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: 'numero_propio', proveedor: 'meta' } });
  });
}

async function registrarYConectar(db: Database, c0: Fila, mp: MetaDePlataforma, correlacion: string) {
  let c = c0;
  const wa = { ...(c.whatsapp ?? {}) };
  try {
    if (!wa.registrado) {
      const cred = await db.withPlatform((tx) => credencial(tx, c.id));
      const pin = cred.pin ?? pinNuevo();
      if (!cred.pin) await db.withPlatform((tx) => guardarCredencial(tx, c, { pin }));
      await mp.meta.registrar(c.phone_number_id, mp.token, pin);
      wa.registrado = true;
      c = (await db.withPlatform((tx) => mover(tx, c, 'REGISTRADO', 'numero_registrado', { de: ['CODIGO_VERIFICADO'], subestado: 'conectando', accion: null, campos: { whatsapp: wa }, correlacion }))) ?? c;
    }
    const d = await mp.meta.consultar(c.phone_number_id, mp.token);
    const operativo = d.estado === 'CONNECTED';
    await db.withPlatform(async (tx) => {
      // En un cambio de número la empresa sigue en el número anterior hasta que el nuevo esté operativo.
      if (!c.es_cambio || operativo) await vincularEmpresa(tx, c, d, operativo, mp.meta.simulado);
      Object.assign(wa, { estado_meta: d.estado, estado_nombre: d.estadoNombre, calidad: d.calidad });
      if (operativo) {
        await mover(tx, c, 'CONECTADO', 'whatsapp_conectado', { de: ['REGISTRADO'], subestado: null, accion: 'prueba', campos: { whatsapp: wa, conectado_en: new Date(), ultimo_error: null }, correlacion, detalle: { estado_nombre: d.estadoNombre } });
      } else {
        wa.intentos_conexion = (wa.intentos_conexion ?? 0) + 1;
        c = await anotar(tx, c, { whatsapp: wa, subestado: 'esperando_meta' }, 'conexion_en_espera', { estado: d.estado });
        if (wa.intentos_conexion < MAX_ESPERAS_META) await enqueue(tx, c.tenant_id, 'numero_propio', { contratacion_id: c.id }, { claveUnica: `num-propio:${c.id}:${wa.intentos_conexion}`, ejecutarEn: new Date(Date.now() + 2 * 60_000), maxIntentos: 5 });
      }
    });
    if (operativo && c.es_cambio) await completarCambio(db, c, mp, correlacion);
    if (!operativo && (wa.intentos_conexion ?? 0) >= MAX_ESPERAS_META) await fallar(db, c, 'OTRO', correlacion);
  } catch (e) {
    const motivo = motivoRegistro(e);
    if (motivo === 'TEMPORAL' || motivo === 'DEMASIADOS_INTENTOS') {
      // Se reintenta solo: la empresa ve «Conectando…» y no tiene que hacer nada.
      await db.withPlatform(async (tx) => {
        const f = await anotar(tx, c, { subestado: motivo === 'TEMPORAL' ? 'reintentando' : 'esperando_limite' }, 'registro_reintento', { motivo });
        await enqueue(tx, f.tenant_id, 'numero_propio', { contratacion_id: f.id }, { claveUnica: `num-propio:${f.id}:r:${Date.now()}`, ejecutarEn: new Date(Date.now() + (motivo === 'TEMPORAL' ? 2 : 60) * 60_000), maxIntentos: 5 });
      });
      return;
    }
    if (motivo === 'ACCESO') await db.withPlatform((tx) => registrarIncidente(tx, { codigo: 'WHATSAPP_CREDENCIAL', servicio: 'numeros', tenantId: c.tenant_id, correlacion, detalle: { tipo_trabajo: 'numero_propio' } }));
    await fallar(db, c, motivo, correlacion);
  }
}

// ---------------------------------------------------------------------------
// Cambio de número: el anterior se desconecta SOLO cuando el nuevo ya quedó conectado
// ---------------------------------------------------------------------------
/**
 * El nuevo número ya funciona (la empresa ya apunta a él). Ahora se desregistra el anterior y se cierra su
 * conexión. Si el desregistro falla, la empresa NO se queda sin número (ya tiene el nuevo): el número viejo queda
 * liberado en Omnegia y se avisa al operador para que lo retire de la cuenta de WhatsApp Business.
 */
async function completarCambio(db: Database, nuevo: Fila, mp: MetaDePlataforma, correlacion: string) {
  const viejo = nuevo.reemplaza_id ? await db.withPlatform((tx) => cargar(tx, nuevo.reemplaza_id)) : null;
  let deregistro: 'hecho' | 'fallido' | 'no_aplica' = 'no_aplica';
  if (viejo && viejo.estado === 'CONECTADO' && viejo.whatsapp?.registrado && viejo.phone_number_id) {
    try { await mp.meta.desregistrar(viejo.phone_number_id, mp.token); deregistro = 'hecho'; } catch { deregistro = 'fallido'; }
  }
  await db.withPlatform(async (tx) => {
    if (viejo && viejo.estado !== 'CANCELADO') {
      await tx.query(`UPDATE numero_credencial SET token_cifrado=NULL, pin_cifrado=NULL, codigo_cifrado=NULL, actualizado_en=now() WHERE contratacion_id=$1`, [viejo.id]);
      if (viejo.phone_number_id) cacheTokens.delete(viejo.phone_number_id);
      // CANCELADO primero: libera el lugar único antes de dejar de marcar esta fila como «reemplazo».
      await mover(tx, viejo, 'CANCELADO', 'numero_reemplazado', { de: [viejo.estado], subestado: 'reemplazado', accion: null, campos: { cancelado_en: new Date(), liberado_en: new Date() }, detalle: { deregister: deregistro, reemplazado_por: nuevo.id }, actor: { tipo: 'SISTEMA', id: null, nombre: 'Cambio de número' }, origen: 'TRABAJADOR', correlacion });
    }
    await tx.query(`UPDATE numero_contratacion SET reemplaza_id=NULL, es_cambio=false WHERE id=$1`, [nuevo.id]);
    await auditPlatform(tx, nuevo.tenant_id, { tipo: 'SISTEMA', id: null, nombre: 'Cambio de número' }, 'TRABAJADOR', correlacion, {
      accion: 'numero.cambio_completado', recurso: 'numero_contratacion', recursoId: nuevo.id, resultado: deregistro === 'fallido' ? 'ERROR' : 'EXITO',
      detalle: { anterior: viejo?.numero_e164 ? `···${String(viejo.numero_e164).slice(-4)}` : 'configurado a mano', nuevo: `···${String(nuevo.numero_e164).slice(-4)}`, deregister: deregistro },
    });
    if (deregistro === 'fallido') await registrarIncidente(tx, { codigo: 'NUMERO_CONEXION_FALLIDA', servicio: 'numeros', tenantId: nuevo.tenant_id, correlacion, detalle: { tipo_trabajo: 'deregister_cambio', proveedor: 'meta' } });
  });
}

// ---------------------------------------------------------------------------
// Cancelar a mitad o desconectar
// ---------------------------------------------------------------------------
export async function desconectar(db: Database, ctx: Ctx, id: string, body: unknown) {
  await permiso(db, ctx);
  const c0 = await propiaPropio(db, ctx, id);
  if (c0.estado === 'CANCELADO') throw new AppError('CONFLICT', 'Este número ya está desconectado.');
  const enUso = ['REGISTRADO', 'CONECTADO'].includes(c0.estado) || !!c0.whatsapp?.registrado;
  // Desconectar un número activo exige confirmación escrita; abandonar a mitad no.
  if (enUso && String((body as any)?.confirmacion ?? '').trim().toUpperCase() !== 'DESCONECTAR') throw invalid('Escribe DESCONECTAR para confirmar.');
  const mp = metaPlataforma();
  return conTurno(db, id, async () => {
    const c = (await db.withPlatform((tx) => cargar(tx, id)))!;
    let deregistro: 'hecho' | 'fallido' | 'no_aplica' = 'no_aplica';
    if (c.whatsapp?.registrado && c.phone_number_id && mp) {
      try { await mp.meta.desregistrar(c.phone_number_id, mp.token); deregistro = 'hecho'; } catch (e) {
        if (motivoRegistro(e) === 'TEMPORAL') throw conflicto('TEMPORAL');
        deregistro = 'fallido';
      }
    }
    return db.withPlatform(async (tx) => {
      if (c.phone_number_id) {
        await tx.query(`UPDATE tenant SET whatsapp_phone_number_id=NULL, whatsapp_estado='SIN_CONFIGURAR', whatsapp_numero_visible=NULL, whatsapp_diagnostico=NULL, whatsapp_verificado_en=NULL WHERE id=$1 AND whatsapp_phone_number_id=$2`, [c.tenant_id, c.phone_number_id]);
        cacheTokens.delete(c.phone_number_id);
      }
      await tx.query(`UPDATE numero_credencial SET token_cifrado=NULL, pin_cifrado=NULL, codigo_cifrado=NULL, actualizado_en=now() WHERE contratacion_id=$1`, [id]);
      if (deregistro === 'fallido') await registrarIncidente(tx, { codigo: 'NUMERO_CONEXION_FALLIDA', servicio: 'numeros', tenantId: c.tenant_id, correlacion: ctx.correlacion, detalle: { tipo_trabajo: 'deregister', proveedor: 'meta' } });
      // CANCELADO libera el phone_number_id (el índice único solo cuenta procesos vivos).
      const f = await mover(tx, c, 'CANCELADO', enUso ? 'numero_desconectado' : 'conexion_cancelada', { de: [c.estado], subestado: enUso ? 'desconectado' : 'cancelada', accion: null, campos: { cancelado_en: new Date(), liberado_en: enUso ? new Date() : null }, detalle: { deregister: deregistro }, ...conCtx(ctx) });
      if (!f) throw new AppError('CONFLICT', 'El proceso cambió. Recarga la página.');
      return vistaPropio(tx, f);
    });
  });
}

// ---------------------------------------------------------------------------
// Vista para el panel
// ---------------------------------------------------------------------------
export async function vistaPropio(tx: Tx, c: Fila) {
  const v = c.verificacion ?? {};
  const ahora = Date.now();
  const desdeEnvio = v.enviado_en ? Math.floor((ahora - new Date(v.enviado_en).getTime()) / 1000) : null;
  const recientes = (v.reenvios ?? []).filter((x: string) => ahora - new Date(x).getTime() < 3_600_000).length;
  const bloqueo = c.bloqueo_cliente_hasta && new Date(c.bloqueo_cliente_hasta).getTime() > ahora ? c.bloqueo_cliente_hasta : null;
  const eventos = (await tx.query(`SELECT de, a, tipo, creado_en FROM numero_evento WHERE contratacion_id=$1 ORDER BY creado_en DESC LIMIT 20`, [c.id])).rows;
  return {
    id: c.id, origen: 'PROPIO' as const, estado: c.estado, subestado: c.subestado, accion_cliente: c.accion_cliente, es_cambio: !!c.es_cambio,
    simulado: c.entorno === 'simulado', numero: c.numero_e164, pais: c.pais, nombre_visible: c.nombre_visible,
    verificacion: {
      metodo: v.metodo ?? null, enviado_en: v.enviado_en ?? null,
      espera_s: desdeEnvio === null ? 0 : Math.max(0, ESPERA_REENVIO_S - desdeEnvio),
      vence_en: v.enviado_en ? new Date(new Date(v.enviado_en).getTime() + VIGENCIA_CODIGO_MIN * 60_000).toISOString() : null,
      intentos_restantes: Math.max(0, MAX_INTENTOS_CODIGO - (v.intentos ?? 0)),
      reenvios_restantes: Math.max(0, MAX_REENVIOS_HORA - recientes),
    },
    bloqueo_hasta: bloqueo,
    whatsapp: { registrado: !!c.whatsapp?.registrado, estado_nombre: c.whatsapp?.estado_nombre ?? null, calidad: c.whatsapp?.calidad ?? null },
    creado_en: c.creado_en, conectado_en: c.conectado_en, prueba_recibida_en: c.prueba_recibida_en, cancelado_en: c.cancelado_en,
    // Mensaje ya traducido por Omnegia (nunca el texto de Meta).
    ultimo_error: c.ultimo_error,
    eventos,
  };
}

