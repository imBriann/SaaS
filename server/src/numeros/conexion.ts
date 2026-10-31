import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import type { Database } from '../db/index.js';
import { type Ctx, can, requirePerm, requireWritable } from '../core/context.js';
import { audit, auditPlatform } from '../core/audit.js';
import { registrarIncidente } from '../core/incidentes.js';
import { AppError, invalid } from '../lib/errors.js';
import { config } from '../config.js';
import { addMessage, ventanaAbierta } from '../modules/conversations.js';
import { metaPlataforma, motivoRegistro } from './meta.js';
import { desconectar as desconectarPropio, mensaje } from './propio.js';
import { cacheTokens, contratacionViva, MOTIVO_PROXIMAMENTE } from './servicio.js';

/**
 * «Conectar WhatsApp» en el panel de la empresa: una sola pantalla con el estado siempre visible y en lenguaje
 * simple, «Probar conexión» y «Desconectar». La empresa nunca escribe identificadores de Meta: el número llega
 * por «Usar mi propio número» (propio.ts) o lo asigna el equipo de Omnegia (plataforma.ts).
 *
 * Estados: SIN_CONECTAR · ESPERANDO_CODIGO · CONECTANDO · CONECTADO · DESCONECTADO · NECESITA_ATENCION.
 */
export const MOTIVO_CUENTA_PROPIA = 'Conectar la cuenta de WhatsApp Business de tu empresa estará disponible próximamente: exige que Omnegia complete su verificación como proveedor tecnológico de Meta. Mientras tanto, usa tu propio número: solo necesitas recibir un SMS.';

async function leer(db: Database, ctx: Ctx) {
  await db.withTenant(ctx.tenantId, async () => { if (!can(ctx, 'tenant:configure') && !can(ctx, 'subscription:manage')) requirePerm(ctx, 'tenant:configure'); });
  return db.withPlatform(async (tx) => ({
    t: (await tx.query(`SELECT nombre, whatsapp_phone_number_id AS pid, whatsapp_estado, whatsapp_numero_visible, whatsapp_diagnostico, whatsapp_verificado_en FROM tenant WHERE id=$1`, [ctx.tenantId])).rows[0],
    viva: await contratacionViva(tx, ctx.tenantId),
    ultima: (await tx.query(`SELECT estado, origen, liberado_en, cancelado_en FROM numero_contratacion WHERE tenant_id=$1 ORDER BY creado_en DESC LIMIT 1`, [ctx.tenantId])).rows[0],
  }));
}

export async function estado(db: Database, ctx: Ctx) {
  const { t, viva, ultima } = await leer(db, ctx);
  const nombre = t?.whatsapp_diagnostico?.nombre ?? t?.nombre ?? null;
  const numero = t?.whatsapp_numero_visible ?? null;
  let e: { estado: string; texto: string; que_hacer: string | null };
  if (viva?.origen === 'PROPIO' && ['NUMERO_INGRESADO', 'CODIGO_ENVIADO'].includes(viva.estado)) {
    e = { estado: 'ESPERANDO_CODIGO', texto: 'Esperando el código', que_hacer: `Escribe el código de 6 dígitos que llegó por SMS (o llamada) al ${viva.numero_e164}.` };
  } else if (viva?.origen === 'PROPIO' && ['CODIGO_VERIFICADO', 'REGISTRADO'].includes(viva.estado)) {
    e = { estado: 'CONECTANDO', texto: 'Conectando con WhatsApp…', que_hacer: null };
  } else if (viva?.estado === 'CONEXION_FALLIDA') {
    e = { estado: 'NECESITA_ATENCION', texto: 'Necesita atención', que_hacer: viva.ultimo_error ?? 'La conexión no se completó. Cancélala y vuelve a intentarlo, o escribe a soporte.' };
  } else if (t?.whatsapp_estado === 'CONECTADO' || t?.whatsapp_estado === 'SIMULADO') {
    e = { estado: 'CONECTADO', texto: `Conectado: ${numero ?? 'tu número'}${nombre ? ` · ${nombre}` : ''}${t.whatsapp_estado === 'SIMULADO' ? ' (simulación)' : ''}`, que_hacer: null };
  } else if (t?.pid && ['PENDIENTE_REGISTRO', 'PENDIENTE_VERIFICAR', 'ERROR'].includes(t.whatsapp_estado)) {
    e = {
      estado: 'NECESITA_ATENCION', texto: 'Necesita atención',
      que_hacer: t.whatsapp_estado === 'PENDIENTE_REGISTRO'
        ? 'Tu número está verificado pero falta activarlo en WhatsApp. El equipo de Omnegia ya puede hacerlo; si en unas horas sigue así, escribe a soporte.'
        : t.whatsapp_diagnostico?.error ?? 'No pudimos comprobar tu número con WhatsApp. Pulsa «Probar conexión» más tarde o escribe a soporte.',
    };
  } else if (t?.whatsapp_estado === 'DESCONECTADO' || (ultima?.estado === 'CANCELADO' && ultima?.liberado_en)) {
    e = { estado: 'DESCONECTADO', texto: 'Desconectado', que_hacer: 'Tus clientes ya no reciben respuestas por WhatsApp. Conecta un número para volver a atenderlos.' };
  } else {
    e = { estado: 'SIN_CONECTAR', texto: 'Sin conectar', que_hacer: 'Conecta tu propio número: escribes el número, recibes un código por SMS y listo.' };
  }
  const conectado = e.estado === 'CONECTADO';
  return {
    ...e, numero: conectado || e.estado === 'NECESITA_ATENCION' ? numero : null, nombre: conectado ? nombre : null,
    simulado: t?.whatsapp_estado === 'SIMULADO', verificado_en: t?.whatsapp_verificado_en ?? null,
    puede_probar: conectado, puede_desconectar: conectado || e.estado === 'NECESITA_ATENCION' || e.estado === 'ESPERANDO_CODIGO' || e.estado === 'CONECTANDO',
    contratacion_id: viva?.id ?? null,
    opciones: {
      propio: { disponible: !!metaPlataforma() && !conectado && !viva },
      compra: { proximamente: !config.numeros.compraHabilitada, motivo: config.numeros.compraHabilitada ? null : MOTIVO_PROXIMAMENTE },
      cuenta_propia: { proximamente: !config.whatsapp.cuentaPropiaHabilitada, motivo: config.whatsapp.cuentaPropiaHabilitada ? null : MOTIVO_CUENTA_PROPIA },
    },
  };
}

/**
 * Mensaje de prueba al celular que indique la persona. Sin plantillas aprobadas, WhatsApp solo deja escribir a
 * quien escribió en las últimas 24 horas: si no, se explica cómo abrir la ventana.
 */
export async function probar(db: Database, ctx: Ctx, body: unknown) {
  await db.withTenant(ctx.tenantId, async () => { requirePerm(ctx, 'tenant:configure'); requireWritable(ctx); });
  const crudo = String((body as any)?.telefono ?? '').trim();
  const pais = String((body as any)?.pais ?? 'CO').toUpperCase() as CountryCode;
  const tel = parsePhoneNumberFromString(crudo.replace(/[^\d+]/g, ''), pais);
  if (!tel || !tel.isValid()) throw invalid('Escribe el celular al que quieres enviar la prueba (por ejemplo, 300 123 4567).');
  const e164 = tel.number as string;
  const { t } = await leer(db, ctx);
  if (!t?.pid || !['CONECTADO', 'SIMULADO'].includes(t.whatsapp_estado)) throw new AppError('CONFLICT', 'Primero conecta tu número de WhatsApp.');
  const r = await db.withTenant(ctx.tenantId, async (tx) => {
    const conv = (await tx.query(
      `SELECT v.id, v.ultimo_mensaje_cliente_en FROM conversation v JOIN customer c ON c.id=v.customer_id
       WHERE v.canal='WHATSAPP' AND regexp_replace(coalesce(c.telefono, ''), '\\D', '', 'g') = $1 ORDER BY v.actualizado_en DESC LIMIT 1`, [e164.replace(/\D/g, '')])).rows[0];
    if (!conv || !ventanaAbierta(conv.ultimo_mensaje_cliente_en)) return null;
    const m = await addMessage(tx, ctx, {
      conversation_id: conv.id, remitente: 'HUMAN', tipo: 'TEXTO', autor_user_id: ctx.actor.tipo === 'USUARIO' ? ctx.actor.id : null,
      contenido: `✅ Prueba de conexión de ${t.nombre}: este número de WhatsApp está conectado a Omnegia y listo para atender.`,
      metadatos: { prueba_conexion: true },
    });
    await audit(tx, ctx, { accion: 'canal.probar', recurso: 'tenant', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { destino: `···${e164.slice(-4)}` } });
    return m;
  });
  if (!r) {
    throw new AppError('CONFLICT', `Desde ese celular, escribe primero un mensaje (por ejemplo «hola») a tu número de WhatsApp${t.whatsapp_numero_visible ? ` (${t.whatsapp_numero_visible})` : ''} y vuelve a pulsar «Probar conexión». WhatsApp solo permite responder durante las 24 horas siguientes al último mensaje del cliente.`, { motivo: 'FUERA_DE_VENTANA' });
  }
  return { ok: true, mensaje: `Enviamos el mensaje de prueba al ···${e164.slice(-4)}. Si llega, la conexión funciona.` };
}

/**
 * Desconectar: deregister en la Cloud API y el número queda libre. Si se conectó con «Usar mi propio número», lo
 * hace ese flujo; si lo asignó el equipo de Omnegia, se desregistra aquí.
 */
export async function desconectar(db: Database, ctx: Ctx, body: unknown) {
  await db.withTenant(ctx.tenantId, async () => { requirePerm(ctx, 'tenant:configure', 'tenant'); requireWritable(ctx); });
  const { t, viva } = await leer(db, ctx);
  if (viva?.origen === 'PROPIO') return { origen: 'PROPIO', contratacion: await desconectarPropio(db, ctx, viva.id, body), estado: await estado(db, ctx) };
  if (viva) throw new AppError('CONFLICT', 'Tienes una contratación de número en curso: gestiónala desde su propia pantalla.');
  if (!t?.pid) throw new AppError('CONFLICT', 'No tienes un número de WhatsApp conectado.');
  if (String((body as any)?.confirmacion ?? '').trim().toUpperCase() !== 'DESCONECTAR') throw invalid('Escribe DESCONECTAR para confirmar.');
  const pid = String(t.pid);
  let deregistro: 'hecho' | 'fallido' | 'no_aplica' = 'no_aplica';
  const mp = metaPlataforma();
  if (!pid.startsWith('sim-') && mp && !mp.meta.simulado) {
    try { await mp.meta.desregistrar(pid, mp.token); deregistro = 'hecho'; } catch (e) {
      const m = motivoRegistro(e);
      if (m === 'TEMPORAL') throw new AppError('CONFLICT', mensaje('TEMPORAL'));
      deregistro = 'fallido';
    }
  } else if (mp?.meta.simulado) {
    await mp.meta.desregistrar(pid, mp.token).catch(() => undefined);
    deregistro = 'hecho';
  }
  await db.withPlatform(async (tx) => {
    await tx.query(`UPDATE tenant SET whatsapp_phone_number_id=NULL, whatsapp_estado='DESCONECTADO', whatsapp_numero_visible=NULL, whatsapp_diagnostico=NULL, whatsapp_verificado_en=NULL WHERE id=$1 AND whatsapp_phone_number_id=$2`, [ctx.tenantId, pid]);
    if (deregistro === 'fallido') await registrarIncidente(tx, { codigo: 'NUMERO_CONEXION_FALLIDA', servicio: 'numeros', tenantId: ctx.tenantId, correlacion: ctx.correlacion, detalle: { tipo_trabajo: 'deregister', proveedor: 'meta' } });
    await auditPlatform(tx, ctx.tenantId, ctx.actor, 'PANEL', ctx.correlacion, { accion: 'canal.desconectar', recurso: 'tenant', recursoId: ctx.tenantId, resultado: 'EXITO', detalle: { deregister: deregistro } });
  });
  cacheTokens.delete(pid);
  return { origen: 'ASIGNADO', deregister: deregistro, estado: await estado(db, ctx) };
}
