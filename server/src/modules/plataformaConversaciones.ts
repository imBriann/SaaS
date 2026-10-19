import type { Database, Tx } from '../db/index.js';
import { config } from '../config.js';
import { enqueue } from '../core/events.js';
import { registrarIncidente } from '../core/incidentes.js';
import { channel, type EstadoEntrante } from '../adapters/channel.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { AppError } from '../lib/errors.js';
import { clasificarError } from '../lib/depurar.js';
import { uuidv7 } from '../lib/util.js';
import { requestPasswordReset } from './auth.js';
import { ETIQUETA_CATEGORIA } from './soporte.js';
import { ventanaAbierta } from './conversations.js';
import {
  ASUNTO_TEMA, RETENCION_DIAS_PLATAFORMA, TEXTOS, decidir, reconocerTelefono, textoDerivacion,
  type ComercioReconocido, type Decision, type EstadoDialogo,
} from './plataformaBot.js';
import type { MensajeCanal } from './channelInbound.js';

/**
 * Conversaciones del número de WhatsApp de Omnegia.
 *
 * Cada mensaje se guarda (sin duplicados) y lo procesa el trabajador: el asistente responde con el
 * estado del diálogo, ejecuta la recuperación de contraseña cuando corresponde o deriva a una persona
 * creando una solicitud de soporte (SOP-…) con el resumen del caso. Mientras una persona atiende, el
 * asistente calla; como mucho envía un aviso de espera cada AVISO_ESPERA_MS si nadie ha respondido.
 *
 * Retención: RETENCION_DIAS_PLATAFORMA días después del último mensaje (trabajo «mantenimiento»).
 */
export const AVISO_ESPERA_MS = 4 * 3600_000;
export { RETENCION_DIAS_PLATAFORMA };

const ASISTENTE = 'asistente-whatsapp';

/** Evidencia en la auditoría del operador (acciones del asistente y de las personas sobre la conversación). */
export async function auditarConversacion(tx: Tx, e: { conversacionId: string; accion: string; actorId?: string | null; actorEmail?: string; tenantId?: string | null; motivo?: string | null; resultado?: 'EXITO' | 'DENEGADO' | 'ERROR' | 'SIN_CAMBIOS'; correlacion?: string | null; detalle?: Record<string, string | number | boolean | null> }) {
  await tx.query(
    `INSERT INTO auditoria_plataforma (id, actor_id, actor_email, accion, recurso, recurso_id, tenant_id, motivo, resultado, correlacion, detalle)
     VALUES ($1,$2,$3,$4,'plataforma_conversacion',$5,$6,$7,$8,$9,$10)`,
    [uuidv7(), e.actorId ?? null, e.actorEmail ?? ASISTENTE, e.accion, e.conversacionId, e.tenantId ?? null, e.motivo ?? null, e.resultado ?? 'EXITO', e.correlacion ?? null, JSON.stringify(e.detalle ?? {})]);
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------
/** Mensaje que llega al número de Omnegia: se guarda y se encola su procesamiento. */
export async function recibirPlataforma(db: Database, m: MensajeCanal, correlacion: string): Promise<string> {
  const telefono = m.from.startsWith('+') ? m.from : `+${m.from}`;
  return db.withPlatform(async (tx) => {
    // Un reenvío del mismo mensaje no reabre ni duplica nada.
    if ((await tx.query(`SELECT 1 FROM plataforma_mensaje WHERE id_externo=$1`, [m.id])).rows[0]) return 'duplicado';
    await tx.query(
      `INSERT INTO plataforma_conversacion (id, telefono, phone_number_id, nombre_perfil) VALUES ($1,$2,$3,$4) ON CONFLICT (telefono) DO NOTHING`,
      [uuidv7(), telefono, m.phoneNumberId, (m.nombre ?? '').slice(0, 80) || null]);
    const conv = (await tx.query(`SELECT * FROM plataforma_conversacion WHERE telefono=$1 FOR UPDATE`, [telefono])).rows[0];
    if (conv.estado === 'CERRADA') {
      // Un episodio nuevo en el mismo hilo: el asistente vuelve al frente y no repite el aviso de datos.
      const previo = (conv.contexto ?? {}) as EstadoDialogo;
      await tx.query(
        `UPDATE plataforma_conversacion SET estado='ABIERTA', control='AI', asignado_a=NULL, tomado_en=NULL, ticket_id=NULL, escalada_en=NULL,
           primera_respuesta_humana_en=NULL, cerrada_en=NULL, motivo_cierre=NULL, contexto=$2 WHERE id=$1`,
        [conv.id, JSON.stringify({ visto: true, aviso: !!previo.aviso })]);
      await auditarConversacion(tx, { conversacionId: conv.id, accion: 'plataforma.conversacion.reabierta', correlacion, detalle: { motivo: 'nuevo_mensaje' } });
    }
    const tipo = m.tipo ?? 'TEXTO';
    const id = uuidv7();
    const ocurrido = m.ocurridoEn ?? new Date();
    const r = await tx.query(
      `INSERT INTO plataforma_mensaje (id, conversacion_id, remitente, tipo, contenido, metadatos, id_externo, ocurrido_en)
       VALUES ($1,$2,'CLIENTE',$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
      [id, conv.id, tipo, String(m.texto ?? '').slice(0, 4000), JSON.stringify(m.media ? { media: { tipo: m.media.tipo, mime: m.media.mime, nombreArchivo: m.media.nombreArchivo } } : {}), m.id, ocurrido.toISOString()]);
    if (!r.rows[0]) return 'duplicado';
    await tx.query(
      `UPDATE plataforma_conversacion SET ultimo_mensaje_cliente_en = GREATEST(coalesce(ultimo_mensaje_cliente_en, $2), $2), ultimo_mensaje_en=now(),
         nombre_perfil=coalesce(nullif($3, ''), nombre_perfil), phone_number_id=$4, actualizado_en=now() WHERE id=$1`,
      [conv.id, ocurrido.toISOString(), (m.nombre ?? '').slice(0, 80), m.phoneNumberId]);
    await enqueue(tx, null, 'procesar_plataforma', { conversacion_id: conv.id, mensaje_id: id }, { claveUnica: `pproc:${id}`, maxIntentos: 3 });
    return 'plataforma_aceptado';
  });
}

/** Agrega un mensaje al hilo. Los salientes (asistente u operador) se entregan por el trabajador. */
export async function agregarMensajePlataforma(tx: Tx, m: {
  conversacionId: string; remitente: 'ASISTENTE' | 'OPERADOR' | 'SISTEMA'; contenido: string; tipo?: 'TEXTO' | 'NOTA_INTERNA';
  metadatos?: Record<string, unknown>; autorId?: string | null; autorNombre?: string | null;
}) {
  const tipo = m.tipo ?? 'TEXTO';
  const saliente = m.remitente !== 'SISTEMA' && tipo !== 'NOTA_INTERNA';
  const id = uuidv7();
  await tx.query(
    `INSERT INTO plataforma_mensaje (id, conversacion_id, remitente, autor_user_id, autor_nombre, tipo, contenido, metadatos, estado_entrega, ocurrido_en)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [id, m.conversacionId, m.remitente, m.autorId ?? null, m.autorNombre ?? null, tipo, m.contenido.slice(0, 4096), JSON.stringify(m.metadatos ?? {}), saliente ? 'PENDIENTE' : 'N/A']);
  await tx.query(`UPDATE plataforma_conversacion SET ultimo_mensaje_en=now(), actualizado_en=now() WHERE id=$1`, [m.conversacionId]);
  if (saliente) await enqueue(tx, null, 'enviar_plataforma', { mensaje_id: id }, { claveUnica: `penv:${id}`, maxIntentos: 6 });
  return id;
}

// ---------------------------------------------------------------------------
// Procesamiento (trabajador)
// ---------------------------------------------------------------------------
type Preparado =
  | { omitir: true }
  | { omitir: false; conv: any; texto: string; tipo: 'TEXTO' | 'MEDIA' | 'NO_SOPORTADO' };

export async function procesarPlataforma(db: Database, conversacionId: string, mensajeId: string, correlacion: string): Promise<void> {
  const prep: Preparado = await db.withPlatform(async (tx) => {
    const conv = (await tx.query(`SELECT * FROM plataforma_conversacion WHERE id=$1 FOR UPDATE`, [conversacionId])).rows[0];
    const msg = (await tx.query(`SELECT id, creado_en FROM plataforma_mensaje WHERE id=$1 AND conversacion_id=$2`, [mensajeId, conversacionId])).rows[0];
    if (!conv || !msg) return { omitir: true };
    // Ráfaga: responde el trabajo del último mensaje (su lectura incluye a los anteriores).
    const posterior = (await tx.query(`SELECT 1 FROM plataforma_mensaje WHERE conversacion_id=$1 AND remitente='CLIENTE' AND creado_en > $2 LIMIT 1`, [conversacionId, msg.creado_en])).rows[0];
    if (posterior) return { omitir: true };
    // Reintento de un trabajo que ya respondió: nada que hacer.
    const respondido = (await tx.query(`SELECT 1 FROM plataforma_mensaje WHERE conversacion_id=$1 AND remitente IN ('ASISTENTE','OPERADOR') AND creado_en > $2 LIMIT 1`, [conversacionId, msg.creado_en])).rows[0];
    if (respondido) return { omitir: true };

    if (conv.control === 'HUMANO') {
      // Una persona atiende: el asistente calla. Si nadie ha respondido, un aviso de espera como mucho cada 4 horas.
      const estado = (conv.contexto ?? {}) as EstadoDialogo;
      const ultimo = estado.avisoEsperaEn ? Date.parse(estado.avisoEsperaEn) : 0;
      if (!conv.primera_respuesta_humana_en && conv.estado !== 'CERRADA' && Date.now() - ultimo > AVISO_ESPERA_MS) {
        const radicado = conv.ticket_id ? (await tx.query(`SELECT numero FROM soporte_ticket WHERE id=$1`, [conv.ticket_id])).rows[0]?.numero : null;
        await agregarMensajePlataforma(tx, { conversacionId, remitente: 'ASISTENTE', contenido: TEXTOS.esperaPersona(radicado), metadatos: { intencion: 'espera_persona', clave: 'espera_persona' } });
        await tx.query(`UPDATE plataforma_conversacion SET contexto = contexto || $2::jsonb WHERE id=$1`, [conversacionId, JSON.stringify({ avisoEsperaEn: new Date().toISOString() })]);
      }
      return { omitir: true };
    }
    // Lo que la persona escribió desde la última respuesta (una ráfaga se lee junta).
    const pendientes = (await tx.query(
      `SELECT tipo, contenido FROM plataforma_mensaje WHERE conversacion_id=$1 AND remitente='CLIENTE'
         AND creado_en > coalesce((SELECT max(creado_en) FROM plataforma_mensaje WHERE conversacion_id=$1 AND remitente IN ('ASISTENTE','OPERADOR')), '-infinity'::timestamptz)
       ORDER BY coalesce(ocurrido_en, creado_en), creado_en`, [conversacionId])).rows as { tipo: string; contenido: string }[];
    const textos = pendientes.filter((p) => p.tipo === 'TEXTO').map((p) => p.contenido.trim()).filter(Boolean);
    const tipo = textos.length ? 'TEXTO' : ((pendientes.at(-1)?.tipo ?? 'TEXTO') as 'TEXTO' | 'MEDIA' | 'NO_SOPORTADO');
    return { omitir: false, conv, texto: textos.join('\n').slice(0, 2000), tipo };
  });
  if (prep.omitir) return;

  const comercios = await reconocerTelefono(db, prep.conv.telefono);
  const d = decidir({ texto: prep.texto, tipo: prep.tipo, nombre: prep.conv.nombre_perfil ?? '', estado: (prep.conv.contexto ?? {}) as EstadoDialogo, conocido: comercios.length > 0 });

  // Acción con efectos fuera de la conversación: la recuperación de acceso real (respuesta uniforme).
  let texto = d.texto;
  let estado = d.estado;
  if (d.accion?.tipo === 'recuperar_acceso') {
    try {
      await requestPasswordReset(db, d.accion.correo, correlacion);
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      texto = TEXTOS.enlaceNoValido;
      estado = { ...estado, esperando: 'correo', correoEnviado: false };
    }
  }

  await db.withPlatform(async (tx) => {
    const conv = (await tx.query(`SELECT * FROM plataforma_conversacion WHERE id=$1 FOR UPDATE`, [conversacionId])).rows[0];
    // Si una persona tomó el chat mientras se decidía, la respuesta automática se descarta.
    if (!conv || conv.control === 'HUMANO') {
      if (conv) await auditarConversacion(tx, { conversacionId, accion: 'plataforma.respuesta_descartada', correlacion, resultado: 'SIN_CAMBIOS', detalle: { motivo: 'persona_al_frente' } });
      return;
    }
    if (d.accion?.tipo === 'escalar') {
      const numero = await derivar(tx, conv, d, comercios, correlacion);
      texto = textoDerivacion(d, numero, !(conv.contexto ?? {}).aviso);
      estado = { ...estado, aviso: true, ultima: 'escalar', avisoEsperaEn: new Date().toISOString() };
    }
    if (texto) {
      await agregarMensajePlataforma(tx, { conversacionId, remitente: 'ASISTENTE', contenido: texto, metadatos: { intencion: d.intencion, clave: d.clave, accion: d.accion?.tipo ?? null, tema: estado.tema ?? null } });
    }
    await tx.query(
      `UPDATE plataforma_conversacion SET contexto=$2, empresas_relacionadas=$3::uuid[], tenant_relacionado=coalesce(tenant_relacionado, $4), actualizado_en=now() WHERE id=$1`,
      [conversacionId, JSON.stringify(estado), comercios.map((c) => c.id), comercios.length === 1 ? comercios[0].id : null]);
  });
}

/** Resumen que recibe el equipo: lo que se intentó y lo que dijo la persona, sin que tenga que repetirlo. */
async function resumenDelCaso(tx: Tx, conv: any, d: Decision, comercios: ComercioReconocido[]): Promise<string> {
  const ultimos = (await tx.query(
    `SELECT contenido FROM plataforma_mensaje WHERE conversacion_id=$1 AND remitente='CLIENTE' AND tipo='TEXTO' ORDER BY creado_en DESC LIMIT 4`, [conv.id])).rows
    .reverse().map((r: any) => `• «${String(r.contenido).replace(/\s+/g, ' ').slice(0, 280)}»`);
  const estado = d.estado;
  const intentado = (await tx.query(
    `SELECT DISTINCT metadatos->>'clave' AS clave FROM plataforma_mensaje WHERE conversacion_id=$1 AND remitente='ASISTENTE' AND metadatos ? 'clave'`, [conv.id])).rows
    .map((r: any) => r.clave).filter((c: string) => c && !['menu', 'aclarar', 'escalar'].includes(c));
  return [
    `Solicitud recibida por WhatsApp desde ${conv.telefono}${conv.nombre_perfil ? ` (perfil: ${conv.nombre_perfil})` : ''}.`,
    `Motivo de la derivación: ${d.accion?.tipo === 'escalar' ? d.accion.motivo : '—'}`,
    `Tema: ${estado.tema ? ASUNTO_TEMA[estado.tema] : 'sin identificar'}${estado.sub ? ` (${estado.sub.toLowerCase()})` : ''}.`,
    intentado.length ? `Lo que ya intentó el asistente: ${intentado.join(', ')}.` : 'El asistente no alcanzó a proponer una solución.',
    ultimos.length ? `Últimos mensajes de la persona:\n${ultimos.join('\n')}` : '',
    comercios.length
      ? `Identidad SIN verificar: el teléfono coincide con el contacto de ${comercios.length === 1 ? 'una empresa' : `${comercios.length} empresas`} (ver la conversación en el panel del operador). No compartas datos de cuentas sin verificar a la persona.`
      : 'El teléfono no coincide con el contacto de ninguna empresa.',
  ].filter(Boolean).join('\n');
}

/** Deriva a una persona: crea (o reutiliza) la solicitud de soporte y deja la conversación esperando al equipo. */
async function derivar(tx: Tx, conv: any, d: Decision, comercios: ComercioReconocido[], correlacion: string): Promise<string> {
  if (d.accion?.tipo !== 'escalar') throw new Error('derivar sin acción');
  let ticket = conv.ticket_id ? (await tx.query(`SELECT id, numero, estado FROM soporte_ticket WHERE id=$1`, [conv.ticket_id])).rows[0] : null;
  if (!ticket || ['RESUELTO', 'CERRADO'].includes(ticket.estado)) {
    const n = (await tx.query(`SELECT nextval('soporte_ticket_seq') AS n`)).rows[0].n;
    const id = uuidv7();
    const numero = `SOP-${String(n).padStart(6, '0')}`;
    const tema = d.estado.tema ?? 'OTRO';
    const asunto = `WhatsApp · ${ASUNTO_TEMA[tema]}`;
    const relacionado = comercios.length === 1 ? comercios[0].id : null;
    const solicitante = (conv.nombre_perfil ?? '').trim() || `WhatsApp ${conv.telefono}`;
    await tx.query(
      `INSERT INTO soporte_ticket (id, numero, tenant_id, creado_por, solicitante_nombre, solicitante_email, categoria, prioridad, asunto, canal, conversacion_id, tenant_relacionado, solicitante_telefono)
       VALUES ($1,$2,NULL,NULL,$3,NULL,$4,$5,$6,'WHATSAPP',$7,$8,$9)`,
      [id, numero, solicitante.slice(0, 120), d.accion.categoria, d.accion.prioridad, asunto, conv.id, relacionado, conv.telefono]);
    const resumen = await resumenDelCaso(tx, conv, d, comercios);
    const correoId = await encolarCorreo(tx, {
      tenantId: null, para: config.correo.buzonSoporte,
      correo: plantillas.ticketInterno({
        numero, empresa: relacionado ? `${comercios[0].nombre} (según el teléfono, sin verificar)` : comercios.length ? 'Varias empresas (según el teléfono, sin verificar)' : 'Sin empresa identificada',
        empresaId: relacionado ?? '—', categoria: ETIQUETA_CATEGORIA[d.accion.categoria], prioridad: d.accion.prioridad, asunto, descripcion: resumen,
        solicitante: `${solicitante} · WhatsApp ${conv.telefono}`, urlOperador: `${config.publicUrl}/operador/conversaciones/${conv.id}`,
      }),
    });
    await tx.query(`INSERT INTO soporte_mensaje (id, tenant_id, ticket_id, autor_tipo, autor_nombre, cuerpo, correo_id) VALUES ($1,NULL,$2,'SISTEMA','Asistente de WhatsApp',$3,$4)`,
      [uuidv7(), id, resumen, correoId]);
    ticket = { id, numero, estado: 'ABIERTO' };
  }
  await tx.query(
    `UPDATE plataforma_conversacion SET estado='ESCALADA', control='HUMANO', ticket_id=$2, escalada_en=now(), primera_respuesta_humana_en=NULL, actualizado_en=now() WHERE id=$1`,
    [conv.id, ticket.id]);
  await agregarMensajePlataforma(tx, { conversacionId: conv.id, remitente: 'SISTEMA', tipo: 'NOTA_INTERNA', contenido: `Derivada al equipo de Omnegia · ${ticket.numero} · ${d.accion.motivo}`, metadatos: { evento: 'derivada', ticket: ticket.numero } });
  await auditarConversacion(tx, { conversacionId: conv.id, accion: 'plataforma.conversacion.derivada', correlacion, tenantId: comercios.length === 1 ? comercios[0].id : null, motivo: d.accion.motivo.slice(0, 300),
    detalle: { ticket: ticket.numero, categoria: d.accion.categoria, prioridad: d.accion.prioridad } });
  return ticket.numero;
}

// ---------------------------------------------------------------------------
// Entrega por WhatsApp (trabajador)
// ---------------------------------------------------------------------------
const ultimoIntento = (job: any) => Number(job.intentos ?? 0) + 1 >= Number(job.max_intentos ?? 6);

export async function enviarPlataforma(db: Database, mensajeId: string, job: any): Promise<void | 'reintentar'> {
  const info = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT m.id, m.contenido, m.estado_entrega, c.telefono, c.phone_number_id, c.ultimo_mensaje_cliente_en
     FROM plataforma_mensaje m JOIN plataforma_conversacion c ON c.id=m.conversacion_id WHERE m.id=$1`, [mensajeId])).rows[0]);
  if (!info || info.estado_entrega !== 'PENDIENTE') return;
  const fallar = (motivo: string) => db.withPlatform((tx) => tx.query(`UPDATE plataforma_mensaje SET estado_entrega='FALLIDO', error_entrega=$2 WHERE id=$1`, [mensajeId, motivo]));
  if (!ventanaAbierta(info.ultimo_mensaje_cliente_en)) return void (await fallar('Pasaron más de 24 horas desde el último mensaje de la persona: WhatsApp solo admite plantillas aprobadas.'));
  const r = await channel('WHATSAPP').sendText(info.phone_number_id, String(info.telefono).replace('+', ''), info.contenido);
  if (!r.ok) {
    if (r.reintentable && !ultimoIntento(job)) {
      await db.withPlatform((tx) => tx.query(`UPDATE plataforma_mensaje SET error_entrega=$2 WHERE id=$1`, [mensajeId, `Reintentando: ${r.error}`]));
      return 'reintentar';
    }
    await fallar(r.error ?? 'WhatsApp no aceptó el mensaje.');
    const clase = clasificarError(r.error);
    await db.withPlatform((tx) => registrarIncidente(tx, { codigo: clase === 'CREDENCIAL' ? 'WHATSAPP_CREDENCIAL' : 'WHATSAPP_ENVIO_FALLIDO', servicio: 'whatsapp_plataforma', detalle: { tipo_trabajo: 'enviar_plataforma', clase_error: clase, intentos: Number(job.intentos ?? 0) + 1 } }));
    return;
  }
  await db.withPlatform((tx) => tx.query(
    `UPDATE plataforma_mensaje SET estado_entrega=$2, id_externo_salida=$3, error_entrega=NULL WHERE id=$1 AND estado_entrega='PENDIENTE'`,
    [mensajeId, r.simulado ? 'SIMULADO' : 'ENVIADO', r.idExterno ?? null]));
}

const RANGO: Record<string, number> = { PENDIENTE: 0, SIMULADO: 1, ENVIADO: 1, ENTREGADO: 2, LEIDO: 3, FALLIDO: 1 };

/** Estados de entrega de Meta para mensajes del número de Omnegia (llegan desordenados: solo avanzan). */
export async function aplicarEstadoPlataforma(tx: Tx, s: Pick<EstadoEntrante, 'idExterno' | 'estado' | 'error'>): Promise<boolean> {
  const m = (await tx.query(`SELECT id, estado_entrega FROM plataforma_mensaje WHERE id_externo_salida=$1 FOR UPDATE`, [s.idExterno])).rows[0];
  if (!m) return false;
  const actual = m.estado_entrega as string;
  const avanza = s.estado === 'FALLIDO' ? RANGO[actual] < 2 && actual !== 'FALLIDO' : RANGO[s.estado] > RANGO[actual] || actual === 'FALLIDO';
  if (avanza) await tx.query(`UPDATE plataforma_mensaje SET estado_entrega=$2, error_entrega=$3 WHERE id=$1`, [m.id, s.estado, s.estado === 'FALLIDO' ? s.error ?? 'WhatsApp no pudo entregar el mensaje.' : null]);
  return true;
}

export async function recibirEstadoPlataforma(db: Database, s: EstadoEntrante, correlacion: string): Promise<'aplicado' | 'diferido'> {
  return db.withPlatform(async (tx) => {
    if (await aplicarEstadoPlataforma(tx, s)) return 'aplicado';
    await enqueue(tx, null, 'aplicar_estado_plataforma', { ...s, correlacion }, { claveUnica: `pestado:${s.idExterno}:${s.estado}`, ejecutarEn: new Date(Date.now() + 20_000), maxIntentos: 5 });
    return 'diferido';
  });
}

// ---------------------------------------------------------------------------
// Mantenimiento
// ---------------------------------------------------------------------------
/** Cierra los hilos atendidos solo por el asistente que llevan 12 horas quietos. */
export async function cerrarInactivasPlataforma(tx: Tx) {
  const cerradas = (await tx.query(
    `UPDATE plataforma_conversacion SET estado='CERRADA', cerrada_en=now(), motivo_cierre='Sin actividad', actualizado_en=now()
     WHERE estado='ABIERTA' AND control='AI' AND ultimo_mensaje_en < now() - interval '12 hours' RETURNING id`)).rows;
  for (const c of cerradas) await auditarConversacion(tx, { conversacionId: c.id, accion: 'plataforma.conversacion.cerrada', motivo: 'Sin actividad durante 12 horas' });
  return cerradas.length;
}

/** Borra las conversaciones (y sus mensajes) cuyo último mensaje supera el plazo de conservación. */
export async function purgarPlataforma(tx: Tx) {
  return (await tx.query(
    `DELETE FROM plataforma_conversacion WHERE coalesce(ultimo_mensaje_en, creado_en) < now() - ($1 || ' days')::interval RETURNING id`,
    [String(RETENCION_DIAS_PLATAFORMA)])).rows.length;
}
