import type { Database, Tx } from '../db/index.js';
import { systemCtx, type Ctx } from '../core/context.js';
import { audit } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { zonaDe } from '../core/tenant.js';
import { cop, uuidv7 } from '../lib/util.js';
import { addDays, formatFechaLarga, hhmmToMin, localToUtc, minToHhmm, todayLocal, utcToLocal } from '../lib/time.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { addMessage, getOrOpenConversation, ventanaAbierta } from './conversations.js';
import { ajustesIA } from '../ai/politica.js';
import { ajustesAgenda, huecos } from './agendaMotor.js';
import { cambiarEstadoCita, insertAppointment } from './agenda.js';

/**
 * La IA actúa por su cuenta: recordatorios de cita, segundo aviso, seguimiento después de la cita, venta sin
 * pagar, inasistencias, lista de espera y aprobaciones vencidas.
 *
 * Restricción real de WhatsApp (obligatoria): fuera de las 24 horas desde el último mensaje del cliente, Meta
 * solo admite plantillas aprobadas, y la cuenta de Omnegia aún no tiene plantillas aprobadas ni método de pago
 * para mensajes iniciados por la empresa. Por eso cada aviso:
 *   1. dentro de la ventana → mensaje normal por WhatsApp;
 *   2. fuera → plantilla aprobada de ese tipo, si la empresa la tiene;
 *   3. si no → correo, si el cliente tiene correo;
 *   4. si no → queda «no enviado: fuera de ventana» y el panel lo muestra.
 * Nunca se intenta texto libre fuera de la ventana (Meta lo rechaza y baja la calidad del número).
 */
export type TipoAviso = 'RECORDATORIO' | 'SEGUIMIENTO' | 'PAGO_PENDIENTE' | 'LISTA_ESPERA' | 'INASISTENCIA' | 'CAMBIO_CITA';
export const MOTIVO_FUERA_DE_VENTANA = 'No enviado: fuera de la ventana de 24 horas, sin plantilla aprobada ni correo del cliente.';

export interface Aviso {
  tipo: TipoAviso;
  referencia: string;
  customerId: string;
  appointmentId?: string | null;
  texto: string;
  variables: Record<string, string>;
  asunto: string;
  metadatos?: Record<string, unknown>;
}

export interface ResultadoAviso { canal: 'WHATSAPP' | 'PLANTILLA' | 'CORREO' | 'NINGUNO'; estado: 'ENVIADO' | 'NO_ENVIADO'; motivo?: string; repetido?: boolean; mensaje_id?: string | null }

/** Envía (o registra como no enviado) un aviso proactivo. Idempotente por tipo y referencia. */
export async function avisar(tx: Tx, ctx: Ctx, a: Aviso): Promise<ResultadoAviso> {
  const previo = (await tx.query(`SELECT canal, estado, motivo FROM aviso_proactivo WHERE tipo=$1 AND referencia=$2`, [a.tipo, a.referencia])).rows[0];
  if (previo) return { ...previo, repetido: true };
  const c = (await tx.query(`SELECT id, nombre, email, telefono FROM customer WHERE id=$1 AND eliminado_en IS NULL`, [a.customerId])).rows[0];
  let r: ResultadoAviso;
  if (!c) r = { canal: 'NINGUNO', estado: 'NO_ENVIADO', motivo: 'El cliente ya no existe.' };
  else {
    const conv = (await tx.query(`SELECT id, ultimo_mensaje_cliente_en FROM conversation WHERE customer_id=$1 AND canal='WHATSAPP' ORDER BY actualizado_en DESC LIMIT 1`, [c.id])).rows[0];
    const plantilla = (await tx.query(
      `SELECT clave, variables FROM message_template WHERE tipo_proactivo=$1 AND estado_aprobacion='APROBADA' AND nombre_proveedor IS NOT NULL LIMIT 1`, [a.tipo])).rows[0];
    if (conv && ventanaAbierta(conv.ultimo_mensaje_cliente_en)) {
      const m = await addMessage(tx, ctx, { conversation_id: conv.id, remitente: 'AI', contenido: a.texto, metadatos: { proactivo: a.tipo, ...(a.metadatos ?? {}) } });
      r = { canal: 'WHATSAPP', estado: 'ENVIADO', mensaje_id: m.id };
    } else if (plantilla && c.telefono) {
      const v = conv ?? (await getOrOpenConversation(tx, ctx, c.id, 'WHATSAPP'));
      const cuerpo = a.texto;
      const m = await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'AI', tipo: 'PLANTILLA', contenido: cuerpo, metadatos: { plantilla: plantilla.clave, variables: a.variables, proactivo: a.tipo, ...(a.metadatos ?? {}) } });
      r = { canal: 'PLANTILLA', estado: 'ENVIADO', mensaje_id: m.id };
    } else if (c.email) {
      const t = (await tx.query(`SELECT nombre FROM tenant LIMIT 1`)).rows[0];
      await encolarCorreo(tx, { tenantId: ctx.tenantId, para: c.email, conversationId: conv?.id ?? null, clave: `aviso:${ctx.tenantId}:${a.tipo}:${a.referencia}`, correo: plantillas.avisoCliente({ cliente: c.nombre, empresa: t?.nombre ?? 'El negocio', asunto: a.asunto, texto: a.texto }) });
      r = { canal: 'CORREO', estado: 'ENVIADO', motivo: 'Fuera de la ventana de 24 horas de WhatsApp: se envió por correo.' };
    } else {
      r = { canal: 'NINGUNO', estado: 'NO_ENVIADO', motivo: MOTIVO_FUERA_DE_VENTANA };
    }
  }
  await tx.query(`INSERT INTO aviso_proactivo (id, tenant_id, tipo, referencia, customer_id, appointment_id, canal, estado, motivo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [uuidv7(), ctx.tenantId, a.tipo, a.referencia.slice(0, 200), c?.id ?? null, a.appointmentId ?? null, r.canal, r.estado, r.motivo ?? null]);
  return r;
}

// ---------------------------------------------------------------------------
// Horario de atención del negocio (para decir cuándo responderá una persona)
// ---------------------------------------------------------------------------
export async function horarioNegocio(tx: Tx, ahora = new Date()): Promise<{ abierto: boolean; proxima: string | null }> {
  const zona = await zonaDe(tx);
  const recursos = (await tx.query(`SELECT horario FROM resource WHERE activo`)).rows;
  if (!recursos.length) return { abierto: true, proxima: null };
  const hoy = utcToLocal(ahora, zona).fecha;
  for (let i = 0; i < 8; i++) {
    const fecha = addDays(hoy, i);
    const dia = utcToLocal(localToUtc(fecha, '12:00', zona), zona).dia;
    const rangos = recursos.map((r: any) => r.horario?.[dia]).filter(Boolean) as [string, string][];
    if (!rangos.length) continue;
    const abre = Math.min(...rangos.map((x) => hhmmToMin(x[0])));
    const cierra = Math.max(...rangos.map((x) => hhmmToMin(x[1])));
    const a = localToUtc(fecha, minToHhmm(abre), zona).getTime();
    const b = localToUtc(fecha, minToHhmm(cierra), zona).getTime();
    if (i === 0 && ahora.getTime() >= a && ahora.getTime() < b) return { abierto: true, proxima: null };
    if (ahora.getTime() < a) return { abierto: false, proxima: `${i === 0 ? 'hoy' : i === 1 ? 'mañana' : `el ${formatFechaLarga(fecha)}`} a las ${minToHhmm(abre)}` };
  }
  return { abierto: false, proxima: null };
}

// ---------------------------------------------------------------------------
// Ciclo proactivo (lo encola el trabajador cada pocos minutos)
// ---------------------------------------------------------------------------
const etiqueta = (horas: number) => (horas >= 24 ? (horas % 24 === 0 ? `${horas / 24 === 1 ? 'mañana' : `en ${horas / 24} días`}` : `en ${horas} horas`) : `en ${horas} ${horas === 1 ? 'hora' : 'horas'}`);

async function recordatorios(tx: Tx, ctx: Ctx) {
  const aj = await ajustesIA(tx);
  const zona = await zonaDe(tx);
  const horas = [...aj.recordatorios_horas].filter((h) => h > 0 && h <= 168).sort((a, b) => b - a);
  if (!horas.length) return 0;
  const max = horas[0];
  const citas = (await tx.query(
    `SELECT a.id, a.inicio, a.estado, a.recordatorios, a.customer_id, c.nombre AS cliente, p.nombre AS servicio, r.nombre AS recurso
     FROM appointment a JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     WHERE a.estado IN ('RESERVADA','CONFIRMADA') AND a.inicio > now() AND a.inicio <= now() + ($1 || ' hours')::interval`, [String(max)])).rows;
  let n = 0;
  for (const a of citas) {
    const faltan = (new Date(a.inicio).getTime() - Date.now()) / 3_600_000;
    // El recordatorio que toca ahora: el menor umbral que ya se cruzó y no se ha enviado.
    const toca = horas.filter((h) => faltan <= h).sort((x, y) => x - y)[0];
    if (toca === undefined) continue;
    const clave = `r${toca}`;
    if (a.recordatorios?.[clave]) continue;
    // Segundo aviso solo si el cliente todavía no confirmó.
    const esSegundo = toca !== max && Object.keys(a.recordatorios ?? {}).some((k) => k.startsWith('r'));
    if (esSegundo && a.estado === 'CONFIRMADA') { await marcar(tx, a.id, clave, { omitido: 'ya confirmada' }); continue; }
    const l = utcToLocal(new Date(a.inicio), zona);
    const cuando = l.fecha === todayLocal(zona) ? `hoy a las ${l.hora}` : `el ${formatFechaLarga(l.fecha)} a las ${l.hora}`;
    const texto = `${esSegundo ? 'Te recordamos de nuevo' : 'Hola'} ${String(a.cliente).split(' ')[0]}, tu cita de *${a.servicio}* es ${cuando} con ${a.recurso}.` +
      (a.estado === 'CONFIRMADA' ? ' Si necesitas cambiarla, responde *2* para reprogramar o *3* para cancelar.' : ' Responde *1* para confirmar, *2* para reprogramar o *3* para cancelar.');
    const r = await avisar(tx, ctx, {
      tipo: 'RECORDATORIO', referencia: `${a.id}:${clave}:${new Date(a.inicio).getTime()}`, customerId: a.customer_id, appointmentId: a.id, texto,
      asunto: `Recordatorio de tu cita de ${a.servicio}`, variables: { cliente: String(a.cliente).split(' ')[0], servicio: a.servicio, fecha: formatFechaLarga(l.fecha), hora: l.hora, recurso: a.recurso },
      metadatos: { recordatorio_cita: a.id },
    });
    await marcar(tx, a.id, clave, { canal: r.canal, estado: r.estado, motivo: r.motivo ?? null, en: new Date().toISOString(), etiqueta: etiqueta(toca) });
    n++;
  }
  return n;
}
const marcar = (tx: Tx, id: string, clave: string, v: Record<string, unknown>) =>
  tx.query(`UPDATE appointment SET recordatorios = recordatorios || jsonb_build_object($2::text, $3::jsonb) WHERE id=$1`, [id, clave, JSON.stringify(v)]);

/** Cita pasada sin marcar: «No asistió» (o se pregunta al negocio) y se invita al cliente a reprogramar. */
async function inasistencias(tx: Tx, ctx: Ctx) {
  const aj = await ajustesAgenda(tx);
  const citas = (await tx.query(
    `SELECT a.id, a.customer_id, a.recordatorios, c.nombre AS cliente, p.nombre AS servicio FROM appointment a JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id
     WHERE a.estado IN ('RESERVADA','CONFIRMADA') AND a.fin < now() - ($1 || ' minutes')::interval AND a.fin > now() - interval '3 days'`, [String(aj.inasistencia_min)])).rows;
  for (const a of citas) {
    if (aj.inasistencia_accion === 'PREGUNTAR') {
      if (a.recordatorios?.inasistencia) continue;
      await marcar(tx, a.id, 'inasistencia', { preguntado: true, en: new Date().toISOString() });
      await audit(tx, ctx, { accion: 'agenda.cita.sin_marcar', recurso: 'appointment', recursoId: a.id, resultado: 'EXITO', detalle: { accion: 'preguntar_al_negocio' } });
      continue;
    }
    await cambiarEstadoCita(tx, ctx, a.id, 'NO_ASISTIO', 'AUTOMATICA');
    await avisar(tx, ctx, {
      tipo: 'INASISTENCIA', referencia: a.id, customerId: a.customer_id, appointmentId: a.id,
      texto: `Hola ${String(a.cliente).split(' ')[0]}, te esperábamos para tu cita de *${a.servicio}*. ¿Quieres que te busque otro horario? Escríbeme el día y la hora que prefieras.`,
      asunto: `¿Reprogramamos tu cita de ${a.servicio}?`, variables: { cliente: String(a.cliente).split(' ')[0], servicio: a.servicio },
    });
  }
  return citas.length;
}

/** Después de la cita: agradecimiento y, si el servicio se repite, la oferta del siguiente. */
async function seguimientos(tx: Tx, ctx: Ctx) {
  const aj = await ajustesIA(tx);
  if (!aj.seguimiento_horas) return 0;
  const citas = (await tx.query(
    `SELECT a.id, a.customer_id, a.fin, c.nombre AS cliente, p.nombre AS servicio, p.repetir_cada_semanas FROM appointment a JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id
     WHERE a.estado='ATENDIDA' AND a.fin < now() - ($1 || ' hours')::interval AND a.fin > now() - interval '2 days'
       AND NOT (a.recordatorios ? 'seguimiento')`, [String(aj.seguimiento_horas)])).rows;
  for (const a of citas) {
    const siguiente = a.repetir_cada_semanas ? ` Tu próximo ${String(a.servicio).toLowerCase()} toca en unas ${a.repetir_cada_semanas} semanas: si quieres, te lo agendo de una vez.` : '';
    const r = await avisar(tx, ctx, {
      tipo: 'SEGUIMIENTO', referencia: a.id, customerId: a.customer_id, appointmentId: a.id,
      texto: `Gracias por venir, ${String(a.cliente).split(' ')[0]}. ¿Cómo te fue con tu ${String(a.servicio).toLowerCase()}?${siguiente}`,
      asunto: `Gracias por tu visita`, variables: { cliente: String(a.cliente).split(' ')[0], servicio: a.servicio, semanas: String(a.repetir_cada_semanas ?? '') },
    });
    await marcar(tx, a.id, 'seguimiento', { canal: r.canal, estado: r.estado, en: new Date().toISOString() });
  }
  return citas.length;
}

/** Venta iniciada y no pagada: un recordatorio con el enlace antes de que venza. */
async function pagosPendientes(tx: Tx, ctx: Ctx) {
  const aj = await ajustesIA(tx);
  if (!aj.recordar_pago) return 0;
  const enlaces = (await tx.query(
    `SELECT l.id, l.url, l.monto, l.expira_en, o.customer_id, o.numero, c.nombre AS cliente FROM payment_link l JOIN "order" o ON o.id=l.order_id JOIN customer c ON c.id=o.customer_id
     WHERE l.estado='ABIERTO' AND l.expira_en > now() AND l.expira_en < now() + interval '6 hours' AND l.creado_en < now() - interval '1 hour' AND o.estado_pago <> 'PAGADA'`)).rows;
  for (const l of enlaces) {
    await avisar(tx, ctx, {
      tipo: 'PAGO_PENDIENTE', referencia: l.id, customerId: l.customer_id,
      texto: `Hola ${String(l.cliente).split(' ')[0]}, tu compra #${l.numero} por ${cop(Number(l.monto))} sigue pendiente de pago. Puedes pagarla aquí antes de que venza el enlace: ${l.url}`,
      asunto: `Tu compra #${l.numero} está pendiente de pago`, variables: { cliente: String(l.cliente).split(' ')[0], numero: String(l.numero), total: cop(Number(l.monto)), enlace: l.url },
    });
  }
  return enlaces.length;
}

/** Ofertas de lista de espera vencidas: el cupo pasa al siguiente de la lista. */
async function ofertasVencidas(db: Database, tenantId: string, correlacion: string) {
  const vencidas = await db.withTenant(tenantId, async (tx) => (await tx.query(
    `UPDATE lista_espera SET estado='ESPERANDO', oferta = oferta || '{"vencida": true}'::jsonb
     WHERE estado='OFRECIDA' AND (oferta->>'expira_en')::timestamptz < now() RETURNING id, oferta`)).rows);
  for (const v of vencidas) await ofrecerCupo(db, tenantId, { inicio: v.oferta.inicio, product_id: v.oferta.product_id, resource_id: v.oferta.resource_id, excluir: [...(v.oferta.ofrecidos ?? []), v.id] }, correlacion);
  return vencidas.length;
}

/** Aprobaciones del negocio (SUPERVISADO) que nadie respondió a tiempo: se aplica la regla configurada. */
async function aprobacionesVencidas(db: Database, tenantId: string, correlacion: string) {
  const { decidirAprobacion } = await import('../ai/aprobaciones.js');
  const ids = await db.withTenant(tenantId, async (tx) => (await tx.query(`SELECT id FROM pending_action WHERE tipo='NEGOCIO' AND estado='PENDIENTE' AND expira_en <= now()`)).rows.map((r: any) => r.id as string));
  for (const id of ids) await decidirAprobacion(db, tenantId, id, null, correlacion);
  return ids.length;
}

export async function cicloProactivo(db: Database, correlacion: string, soloTenant?: string) {
  const tenants = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT t.id FROM tenant t JOIN subscription s ON s.tenant_id=t.id WHERE s.estado NOT IN ('SUSPENDIDA','CANCELADA') ${soloTenant ? 'AND t.id=$1' : ''}`, soloTenant ? [soloTenant] : [])).rows.map((r: any) => r.id as string));
  const total = { recordatorios: 0, inasistencias: 0, seguimientos: 0, pagos: 0, ofertas: 0, aprobaciones: 0 };
  for (const tenantId of tenants) {
    try {
      await db.withTenant(tenantId, async (tx) => {
        const ctx = systemCtx(tenantId, correlacion, 'Asistente (avisos automáticos)');
        total.recordatorios += await recordatorios(tx, ctx);
        total.inasistencias += await inasistencias(tx, ctx);
        total.seguimientos += await seguimientos(tx, ctx);
        total.pagos += await pagosPendientes(tx, ctx);
      });
      total.ofertas += await ofertasVencidas(db, tenantId, correlacion);
      total.aprobaciones += await aprobacionesVencidas(db, tenantId, correlacion);
    } catch (e) {
      console.error(`[proactivo ${tenantId}]`, (e as Error).message);
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Lista de espera
// ---------------------------------------------------------------------------
const franjaDe = (hora: string) => (hhmmToMin(hora) < 12 * 60 ? 'MANANA' : hhmmToMin(hora) < 18 * 60 ? 'TARDE' : 'NOCHE');

/**
 * Se liberó un cupo (cancelación o reprogramación): se ofrece en orden al primero de la lista que encaje
 * (servicio, fechas, franja y recurso). Si no se le puede escribir (ventana cerrada, sin plantilla ni correo)
 * o no responde en N minutos, pasa al siguiente.
 */
export async function ofrecerCupo(db: Database, tenantId: string, cupo: { inicio: string; product_id: string; resource_id?: string | null; excluir?: string[] }, correlacion: string) {
  return db.withTenant(tenantId, async (tx) => {
    const ctx = systemCtx(tenantId, correlacion, 'Asistente (lista de espera)');
    const zona = await zonaDe(tx);
    const ini = new Date(cupo.inicio);
    if (ini.getTime() < Date.now() + 30 * 60_000) return null;
    const l = utcToLocal(ini, zona);
    // ¿Sigue libre? (otra persona pudo tomarlo).
    const libres = await huecos(tx, { productId: cupo.product_id, fecha: l.fecha, resourceId: cupo.resource_id ?? null, limite: 500 });
    const slot = libres.find((s) => new Date(s.inicio).getTime() === ini.getTime());
    if (!slot) return null;
    const aj = await ajustesAgenda(tx);
    const candidatos = (await tx.query(
      `SELECT le.*, c.nombre AS cliente, p.nombre AS servicio FROM lista_espera le JOIN customer c ON c.id=le.customer_id JOIN product p ON p.id=le.product_id
       WHERE le.estado='ESPERANDO' AND le.product_id=$1 AND le.desde <= $2 AND le.hasta >= $2 AND $3 = ANY(le.franjas)
         AND (le.resource_id IS NULL OR le.resource_id=$4) AND NOT (le.id = ANY($5::uuid[])) ORDER BY le.creado_en`,
      [cupo.product_id, l.fecha, franjaDe(l.hora), slot.recurso_id, cupo.excluir ?? []])).rows;
    const ofrecidos = [...(cupo.excluir ?? [])];
    for (const le of candidatos) {
      ofrecidos.push(le.id);
      const expira = new Date(Date.now() + aj.espera_oferta_min * 60_000);
      const r = await avisar(tx, ctx, {
        tipo: 'LISTA_ESPERA', referencia: `${le.id}:${ini.getTime()}`, customerId: le.customer_id,
        texto: `¡Buenas noticias, ${String(le.cliente).split(' ')[0]}! Se liberó un cupo de *${le.servicio}* el ${formatFechaLarga(l.fecha)} a las ${l.hora} con ${slot.recurso}. Responde *SÍ* en los próximos ${aj.espera_oferta_min} minutos para tomarlo.`,
        asunto: `Se liberó un cupo de ${le.servicio}`, variables: { cliente: String(le.cliente).split(' ')[0], servicio: le.servicio, fecha: formatFechaLarga(l.fecha), hora: l.hora },
        metadatos: { oferta_lista_espera: le.id },
      });
      if (r.estado !== 'ENVIADO' || r.canal === 'CORREO') continue; // por correo no se puede responder «SÍ» a tiempo: siguiente
      await tx.query(`UPDATE lista_espera SET estado='OFRECIDA', oferta=$2 WHERE id=$1`,
        [le.id, JSON.stringify({ inicio: ini.toISOString(), product_id: cupo.product_id, resource_id: slot.recurso_id, recurso: slot.recurso, expira_en: expira.toISOString(), ofrecidos })]);
      await audit(tx, ctx, { accion: 'agenda.lista_espera.oferta', recurso: 'lista_espera', recursoId: le.id, resultado: 'EXITO', detalle: { inicio: ini.toISOString() } });
      await enqueue(tx, tenantId, 'ciclo_proactivo_tenant', {}, { ejecutarEn: new Date(expira.getTime() + 5_000), claveUnica: `oferta-vence:${le.id}:${ini.getTime()}` });
      return { lista_espera_id: le.id };
    }
    return null;
  });
}

/** El cliente responde «SÍ» a una oferta vigente de la lista de espera: se agenda (origen AUTOMATIZACION). */
export async function aceptarOferta(tx: Tx, ctx: Ctx, customerId: string) {
  const le = (await tx.query(`SELECT * FROM lista_espera WHERE customer_id=$1 AND estado='OFRECIDA' AND (oferta->>'expira_en')::timestamptz > now() ORDER BY creado_en LIMIT 1 FOR UPDATE`, [customerId])).rows[0];
  if (!le) return null;
  await tx.query('SAVEPOINT oferta');
  try {
    const cita = await insertAppointment(tx, ctx, { customer_id: customerId, product_id: le.product_id, resource_id: le.oferta.resource_id, inicio: le.oferta.inicio }, 'AUTOMATIZACION');
    await tx.query('RELEASE SAVEPOINT oferta');
    await tx.query(`UPDATE lista_espera SET estado='ASIGNADA', appointment_id=$2 WHERE id=$1`, [le.id, cita.id]);
    await audit(tx, ctx, { accion: 'agenda.lista_espera.asignada', recurso: 'lista_espera', recursoId: le.id, resultado: 'EXITO', detalle: { appointment_id: cita.id } });
    return { ok: true as const, cita };
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT oferta');
    await tx.query(`UPDATE lista_espera SET estado='ESPERANDO', oferta = oferta || '{"perdida": true}'::jsonb WHERE id=$1`, [le.id]);
    return { ok: false as const };
  }
}

/** Respuesta rápida a un recordatorio («1» confirmo, «2» reprogramar, «3» cancelar) en las últimas 48 horas. */
export async function recordatorioVigente(tx: Tx, conversationId: string) {
  const m = (await tx.query(
    `SELECT metadatos->>'recordatorio_cita' AS cita FROM message WHERE conversation_id=$1 AND remitente='AI' AND metadatos ? 'recordatorio_cita' AND creado_en > now() - interval '48 hours'
     ORDER BY creado_en DESC LIMIT 1`, [conversationId])).rows[0];
  if (!m?.cita) return null;
  return (await tx.query(`SELECT a.id, a.inicio, a.estado, p.nombre AS servicio FROM appointment a JOIN product p ON p.id=a.product_id WHERE a.id=$1 AND a.estado IN ('RESERVADA','CONFIRMADA') AND a.inicio > now()`, [m.cita])).rows[0] ?? null;
}

