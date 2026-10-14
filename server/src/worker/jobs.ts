import type { Database, Tx } from '../db/index.js';
import { systemCtx, type Ctx } from '../core/context.js';
import { audit, auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { encolarCorreo, procesarCorreo, mensajeFallo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { registrarIncidente } from '../core/incidentes.js';
import { clasificarError, depurar } from '../lib/depurar.js';
import { channel } from '../adapters/channel.js';
import { fiscalProvider } from '../adapters/fiscal.js';
import { handleCustomerMessage, summarizeCase } from '../ai/runtime.js';
import { createInvoiceForOrder, emitDocument } from '../modules/fiscal.js';
import { addMessage, getOrOpenConversation, ventanaAbierta } from '../modules/conversations.js';
import { applyDeliveryStatus } from '../modules/channelInbound.js';
import { verificarWhatsapp } from '../modules/channelStatus.js';
import { aprovisionarConReintento } from '../modules/billing.js';
import { config } from '../config.js';
import { cop, uuidv7 } from '../lib/util.js';
import { formatFechaLarga, utcToLocal } from '../lib/time.js';

/**
 * Proceso trabajador. Toda llamada saliente a un tercero sale de aquí, con
 * reintentos limitados y retroceso exponencial. Un trabajo que se interrumpe a
 * mitad (caída del proceso) vuelve a la cola pasados 10 minutos.
 */
type Handler = (db: Database, tenantId: string | null, payload: any, job: any) => Promise<void | 'reintentar'>;

export function render(cuerpo: string, vars: Record<string, string>): string {
  return cuerpo.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

const ultimoIntento = (job: any) => Number(job.intentos ?? 0) + 1 >= Number(job.max_intentos ?? 5);

async function sendTemplate(tx: Tx, ctx: Ctx, customerId: string, clave: string, vars: Record<string, string>, extra: Record<string, unknown> = {}) {
  const tpl = (await tx.query(`SELECT cuerpo FROM message_template WHERE clave=$1`, [clave])).rows[0];
  const c = (await tx.query(`SELECT telefono FROM customer WHERE id=$1`, [customerId])).rows[0];
  if (!tpl || !c?.telefono) return false;
  const v = await getOrOpenConversation(tx, ctx, customerId, 'WHATSAPP');
  await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'SYSTEM', tipo: 'PLANTILLA', contenido: render(tpl.cuerpo, vars), metadatos: { plantilla: clave, variables: vars, ...extra } });
  return true;
}

async function appointmentVars(tx: Tx, id: string) {
  const a = (await tx.query(
    `SELECT a.inicio, a.customer_id, a.estado, c.nombre AS cliente, p.nombre AS servicio, r.nombre AS recurso, t.zona_horaria
     FROM appointment a JOIN customer c ON c.id=a.customer_id JOIN product p ON p.id=a.product_id JOIN resource r ON r.id=a.resource_id
     JOIN tenant t ON t.id=a.tenant_id WHERE a.id=$1`, [id])).rows[0];
  if (!a) return null;
  const l = utcToLocal(new Date(a.inicio), a.zona_horaria);
  return { a, vars: { cliente: a.cliente.split(' ')[0], servicio: a.servicio, recurso: a.recurso, fecha: formatFechaLarga(l.fecha), hora: l.hora } };
}

// ---------------------------------------------------------------------------
// Reglas declarativas de automatización
// ---------------------------------------------------------------------------
const ETIQUETAS: Record<string, string> = { nombre: 'Producto', stock: 'Quedan', minimo: 'Mínimo', numero: 'Documento', motivo: 'Motivo' };

async function runRule(tx: Tx, ctx: Ctx, rule: any, ev: any) {
  const p = ev.payload;
  switch (rule.accion) {
    case 'enviar_plantilla': {
      if (ev.tipo.startsWith('cita_') && p.appointment_id) {
        const d = await appointmentVars(tx, p.appointment_id);
        if (d) await sendTemplate(tx, ctx, d.a.customer_id, rule.parametros.plantilla, d.vars);
      }
      return;
    }
    case 'programar_recordatorio': {
      const a = (await tx.query(`SELECT inicio FROM appointment WHERE id=$1`, [p.appointment_id])).rows[0];
      if (!a) return;
      const cuando = new Date(new Date(a.inicio).getTime() - Number(rule.parametros.horas_antes ?? 24) * 3600000);
      if (cuando.getTime() > Date.now()) {
        await enqueue(tx, ctx.tenantId, 'recordatorio', { appointment_id: p.appointment_id, plantilla: rule.parametros.plantilla, inicio: a.inicio }, { ejecutarEn: cuando, claveUnica: `rec:${p.appointment_id}:${new Date(a.inicio).getTime()}` });
      }
      return;
    }
    case 'emitir_factura': {
      const activo = (await tx.query(`SELECT activo FROM tenant_module WHERE modulo='facturacion'`)).rows[0]?.activo;
      if (!activo || fiscalProvider().nombre === 'ninguno' || !p.order_id) return;
      await createInvoiceForOrder(tx, { ...ctx, actor: { tipo: 'SISTEMA', id: null, nombre: 'Facturación automática' } }, p.order_id);
      return;
    }
    case 'notificar_admin': {
      const t = (await tx.query(`SELECT email_contacto, nombre FROM tenant LIMIT 1`)).rows[0];
      if (!t?.email_contacto) return;
      const asunto = String(rule.parametros.asunto ?? 'Aviso');
      const detalle = Object.entries(p).filter(([k]) => !k.endsWith('_id')).map(([k, v]) => `${ETIQUETAS[k] ?? k}: ${String(v)}`);
      await encolarCorreo(tx, { tenantId: ctx.tenantId, para: t.email_contacto, correo: plantillas.alertaNegocio({ empresa: t.nombre, titulo: asunto, lineas: detalle, url: config.publicUrl }) });
      return;
    }
    case 'crear_tarea':
      await audit(tx, ctx, { accion: 'automatizacion.tarea', resultado: 'EXITO', detalle: { evento: ev.tipo, parametros: rule.parametros } });
      return;
  }
}

export async function dispatchEvents(db: Database, limite = 50): Promise<number> {
  const eventos = await db.withPlatform(async (tx) =>
    (await tx.query(`SELECT * FROM domain_event WHERE NOT procesado ORDER BY creado_en LIMIT $1 FOR UPDATE SKIP LOCKED`, [limite])).rows,
  );
  for (const ev of eventos) {
    await db.withTenant(ev.tenant_id, async (tx) => {
      const ctx: Ctx = { ...systemCtx(ev.tenant_id, ev.id, 'Automatización') };
      const reglas = (await tx.query(`SELECT * FROM automation_rule WHERE evento=$1 AND activa`, [ev.tipo])).rows;
      for (const r of reglas) {
        const ok = Object.entries(r.condicion ?? {}).every(([k, v]) => ev.payload?.[k] === v);
        if (!ok) continue;
        await tx.query('SAVEPOINT regla');
        try {
          await runRule(tx, ctx, r, ev);
          await tx.query('RELEASE SAVEPOINT regla');
        } catch (e) {
          await tx.query('ROLLBACK TO SAVEPOINT regla');
          await audit(tx, ctx, { accion: `automatizacion.${r.accion}`, resultado: 'ERROR', detalle: { evento: ev.tipo, error: (e as Error).message } });
        }
      }
    });
    await db.withPlatform((tx) => tx.query(`UPDATE domain_event SET procesado=true WHERE id=$1`, [ev.id]));
  }
  return eventos.length;
}

// ---------------------------------------------------------------------------
// Manejadores de trabajos
// ---------------------------------------------------------------------------
export const HANDLERS: Record<string, Handler> = {
  procesar_mensaje: async (db, tenantId, p) => { await handleCustomerMessage(db, tenantId!, p.conversation_id, undefined, p.message_id); },

  /**
   * Entrega por el canal. Fuera de la ventana de 24 horas solo sale una plantilla
   * aprobada en Meta; un texto libre se marca FALLIDO con el motivo, sin reintentos.
   */
  enviar_mensaje: async (db, tenantId, p, job) => {
    const info = await db.withTenant(tenantId!, async (tx) =>
      (await tx.query(
        `SELECT m.id, m.contenido, m.canal, m.tipo, m.metadatos, m.estado_entrega, c.telefono, v.ultimo_mensaje_cliente_en, t.whatsapp_phone_number_id,
                mt.nombre_proveedor, mt.idioma, mt.variables, mt.estado_aprobacion
         FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN customer c ON c.id=v.customer_id JOIN tenant t ON t.id=m.tenant_id
         LEFT JOIN message_template mt ON mt.clave = m.metadatos->>'plantilla'
         WHERE m.id=$1`, [p.message_id])).rows[0]);
    if (!info || info.estado_entrega !== 'PENDIENTE') return;
    const documento = info.metadatos?.documento as string | undefined;
    const reflejar = (tx: Tx, estado: string) => (documento ? tx.query(
      `UPDATE fiscal_document SET entrega_whatsapp=$2, estado=CASE WHEN $2 IN ('ENVIADO','SIMULADO') AND estado='VALIDADO' THEN 'ENTREGADO' ELSE estado END WHERE id=$1`, [documento, estado]) : Promise.resolve());
    const fallar = (motivo: string) => db.withTenant(tenantId!, async (tx) => {
      await tx.query(`UPDATE message SET estado_entrega='FALLIDO', error_entrega=$2 WHERE id=$1`, [p.message_id, motivo]);
      await reflejar(tx, 'FALLIDO');
    });
    if (!info.telefono) return void (await fallar('El cliente no tiene teléfono registrado.'));
    const to = String(info.telefono).replace('+', '');
    const ventana = info.canal !== 'WHATSAPP' || ventanaAbierta(info.ultimo_mensaje_cliente_en);
    const ch = channel(info.canal);
    let r;
    if (info.tipo === 'PLANTILLA' && info.estado_aprobacion === 'APROBADA' && info.nombre_proveedor) {
      const vars = (info.metadatos?.variables ?? {}) as Record<string, string>;
      r = await ch.sendTemplate(info.whatsapp_phone_number_id, to, { nombre: info.nombre_proveedor, idioma: info.idioma ?? config.whatsapp.idiomaPlantillas, parametros: (info.variables as string[]).map((k) => String(vars[k] ?? '')) });
    } else if (ventana) {
      r = await ch.sendText(info.whatsapp_phone_number_id, to, info.contenido);
    } else {
      return void (await fallar(info.tipo === 'PLANTILLA'
        ? 'Fuera de la ventana de 24 horas: esta plantilla no está registrada como aprobada en Meta (Configuración › WhatsApp › Plantillas).'
        : 'Fuera de la ventana de 24 horas: WhatsApp solo admite plantillas aprobadas.'));
    }
    if (!r.ok) {
      if (r.reintentable && !ultimoIntento(job)) {
        await db.withTenant(tenantId!, (tx) => tx.query(`UPDATE message SET error_entrega=$2 WHERE id=$1`, [p.message_id, `Reintentando: ${r.error}`]));
        return 'reintentar';
      }
      await fallar(r.error ?? 'WhatsApp no aceptó el mensaje.');
      // El operador ve el código técnico; nunca el mensaje, el teléfono ni el texto del proveedor.
      const clase = clasificarError(r.error);
      await db.withPlatform((tx) => registrarIncidente(tx, { codigo: clase === 'CREDENCIAL' ? 'WHATSAPP_CREDENCIAL' : 'WHATSAPP_ENVIO_FALLIDO', servicio: 'whatsapp', tenantId, detalle: { tipo_trabajo: 'enviar_mensaje', clase_error: clase, intentos: Number(job.intentos ?? 0) + 1 } }));
      return;
    }
    await db.withTenant(tenantId!, async (tx) => {
      await tx.query(
        `UPDATE message SET estado_entrega=$2, id_externo_salida=$3, error_entrega=NULL WHERE id=$1 AND estado_entrega='PENDIENTE'`,
        [p.message_id, r.simulado ? 'SIMULADO' : 'ENVIADO', r.idExterno ?? null]);
      await reflejar(tx, r.simulado ? 'SIMULADO' : 'ENVIADO');
    });
  },

  aplicar_estado_entrega: async (db, tenantId, p) => {
    const ok = await db.withTenant(tenantId!, (tx) => applyDeliveryStatus(tx, p));
    if (!ok) return 'reintentar';
  },

  verificar_whatsapp: async (db, tenantId, _p, job) => { await verificarWhatsapp(db, tenantId!, job.id); },

  emitir_documento: async (db, tenantId, p, job) => {
    const r = await db.withTenant(tenantId!, (tx) => emitDocument(tx, systemCtx(tenantId!, job.id, 'Facturación electrónica'), p.fiscal_document_id, p.motivo));
    if (r === 'REINTENTAR') {
      if (!ultimoIntento(job)) return 'reintentar';
      // Sin respuesta del proveedor tras varios intentos: queda visible como pendiente con el motivo.
      await db.withTenant(tenantId!, (tx) => audit(tx, systemCtx(tenantId!, job.id, 'Facturación electrónica'), { accion: 'factura.sin_respuesta', recurso: 'fiscal_document', recursoId: p.fiscal_document_id, resultado: 'ERROR' }));
    }
  },

  entregar_documento: async (db, tenantId, p, job) => {
    await db.withTenant(tenantId!, async (tx) => {
      const ctx = systemCtx(tenantId!, job.id, 'Entrega de documentos');
      const d = (await tx.query(
        `SELECT f.*, o.customer_id, o.conversation_id, c.nombre, c.email, c.telefono, t.nombre AS negocio
         FROM fiscal_document f JOIN "order" o ON o.id=f.order_id JOIN customer c ON c.id=o.customer_id JOIN tenant t ON t.id=f.tenant_id WHERE f.id=$1`,
        [p.fiscal_document_id])).rows[0];
      if (!d) return;
      const enlace = `${config.apiPublicUrl}/api/publico/documentos/${d.token_publico}`;
      const vars = { cliente: d.nombre.split(' ')[0], numero: d.tipo === 'FACTURA' ? d.numero : `${d.numero} (nota crédito)`, total: cop(Number(d.total)), enlace };
      const prueba = d.proveedor_fiscal === 'sandbox';
      let wa = 'NO_APLICA', mail = 'NO_APLICA';
      // «PENDIENTE» hasta que el canal confirme: el resultado real lo escribe enviar_mensaje.
      if (d.telefono) wa = (await sendTemplate(tx, ctx, d.customer_id, 'factura_enviada', vars, { documento: d.id })) ? 'PENDIENTE' : 'FALLIDO';
      if (d.email) {
        await encolarCorreo(tx, {
          tenantId: ctx.tenantId, para: d.email, conversationId: d.conversation_id, adjuntoRef: d.id,
          correo: plantillas.documentoFiscal({ cliente: d.nombre, empresa: d.negocio, tipoDoc: d.tipo === 'FACTURA' ? 'Factura electrónica' : 'Nota crédito', numero: d.numero, total: vars.total, prueba, url: enlace }),
        });
        mail = 'PENDIENTE';
      }
      await tx.query(`UPDATE fiscal_document SET entrega_whatsapp=$2, entrega_email=$3 WHERE id=$1`, [d.id, wa, mail]);
      await audit(tx, ctx, { accion: 'documento.entregar', recurso: 'fiscal_document', recursoId: d.id, resultado: 'EXITO', detalle: { whatsapp: wa, correo: mail } });
    });
  },

  enviar_correo: async (db, tenantId, p, job) => {
    const r = await procesarCorreo(db, tenantId, p.email_id, { ultimo: ultimoIntento(job), trabajoId: job.id });
    if (r.estado === 'PENDIENTE') return 'reintentar';
    const m = r.correo;
    if (!tenantId || !m || r.estado === 'OMITIDO') return;
    await db.withTenant(tenantId, async (tx) => {
      if (m.adjunto_ref) await tx.query(`UPDATE fiscal_document SET entrega_email=$2, estado=CASE WHEN $2='ENVIADO' AND estado='VALIDADO' THEN 'ENTREGADO' ELSE estado END WHERE id=$1`, [m.adjunto_ref, r.estado === 'ENVIADO' ? 'ENVIADO' : 'FALLIDO']);
      // El estado del envío queda también en la conversación del cliente, como nota interna.
      if (m.conversation_id) {
        await addMessage(tx, systemCtx(tenantId, m.id, 'Correo'), { conversation_id: m.conversation_id, remitente: 'SYSTEM', tipo: 'NOTA_INTERNA', contenido: `Correo «${m.asunto}» a ${m.para}: ${r.estado === 'ENVIADO' ? 'aceptado por el proveedor' : 'no se pudo enviar (' + mensajeFallo(r.codigo) + ')'}`, metadatos: { correo: m.id } });
      }
    });
  },

  resumir_caso: async (db, tenantId, p) => { await summarizeCase(db, tenantId!, p.case_id); },

  revisar_sla: async (db, tenantId, p, job) => {
    await db.withTenant(tenantId!, async (tx) => {
      const k = (await tx.query(`SELECT * FROM support_case WHERE id=$1`, [p.case_id])).rows[0];
      if (!k || k.primera_respuesta_en || k.estado === 'CERRADO' || new Date(k.sla_vence_en) > new Date(Date.now() + 1000)) return;
      const ctx = systemCtx(tenantId!, job.id, 'Tiempos de respuesta');
      const t = (await tx.query(`SELECT email_contacto, nombre FROM tenant LIMIT 1`)).rows[0];
      if (t?.email_contacto) {
        await encolarCorreo(tx, { tenantId: ctx.tenantId, para: t.email_contacto, correo: plantillas.radicadoSinRespuesta({ empresa: t.nombre, radicado: k.radicado, prioridad: k.prioridad, asignado: !!k.asignado_a, url: `${config.publicUrl}/conversaciones/${k.conversation_id}` }) });
      }
      await audit(tx, ctx, { accion: 'caso.sla_vencido', recurso: 'support_case', recursoId: k.id, resultado: 'EXITO', detalle: { radicado: k.radicado } });
    });
  },

  recordatorio: async (db, tenantId, p, job) => {
    await db.withTenant(tenantId!, async (tx) => {
      const d = await appointmentVars(tx, p.appointment_id);
      // Si la cita se reprogramó o canceló, el recordatorio viejo no sale.
      if (!d || !['RESERVADA', 'CONFIRMADA'].includes(d.a.estado)) return;
      if (p.inicio && new Date(p.inicio).getTime() !== new Date(d.a.inicio).getTime()) return;
      await sendTemplate(tx, systemCtx(tenantId!, job.id, 'Recordatorios'), d.a.customer_id, p.plantilla, d.vars);
    });
  },

  reintentar_aprovisionamiento: async (db, _t, p, job) => { await aprovisionarConReintento(db, p.draft_token, job.id); },

  /** Cierre por inactividad: atendida solo por la IA, sin caso ni acción pendiente y quieta 12 h. */
  cerrar_inactivas: async (db) => {
    await db.withPlatform((tx) => tx.query(
      `UPDATE conversation v SET estado='CERRADA', resuelta_por='AGENTE'
       WHERE v.estado='ABIERTA' AND v.control='AI' AND v.ultimo_mensaje_cliente_en < now() - interval '12 hours'
         AND NOT EXISTS (SELECT 1 FROM support_case k WHERE k.conversation_id=v.id AND k.estado <> 'CERRADO')
         AND NOT EXISTS (SELECT 1 FROM pending_action p WHERE p.conversation_id=v.id AND p.estado='PENDIENTE' AND p.expira_en > now())`,
    ));
  },

  mantenimiento: async (db) => {
    await db.withPlatform(async (tx) => {
      await tx.query(`UPDATE pending_action SET estado='EXPIRADA' WHERE estado='PENDIENTE' AND expira_en < now()`);
      await tx.query(`UPDATE payment_link SET estado='EXPIRADO', actualizado_en=now() WHERE estado='ABIERTO' AND expira_en < now()`);
      await tx.query(`UPDATE invitation SET estado='EXPIRADA' WHERE estado='PENDIENTE' AND expira_en < now()`);
      await tx.query(`DELETE FROM session WHERE expira_en < now() OR ultimo_uso < now() - ($1 || ' hours')::interval`, [String(config.sesion.inactividadHoras)]);
      await tx.query(`DELETE FROM login_attempt WHERE creado_en < now() - interval '2 days'`);
      await tx.query(`DELETE FROM password_reset WHERE expira_en < now() - interval '7 days'`);
      await tx.query(`DELETE FROM job WHERE estado='HECHO' AND creado_en < now() - interval '14 days'`);
      // Códigos de un solo uso vencidos y contenido de correos sensibles que ya no sirven.
      await tx.query(`DELETE FROM otp_code WHERE creado_en < now() - interval '1 day'`);
      await tx.query(`UPDATE email_outbox SET estado=CASE WHEN estado='PENDIENTE' THEN 'FALLIDO' ELSE estado END, error=CASE WHEN estado='PENDIENTE' THEN 'CADUCADO' ELSE error END,
                        contenido_cifrado=NULL WHERE sensible AND contenido_cifrado IS NOT NULL AND caduca_en < now()`);
      await tx.query(`DELETE FROM metrica_http WHERE minuto < now() - interval '30 days'`);
    });
  },

  ciclo_suscripcion: async (db) => {
    // ACTIVA vencida → PAGO_PENDIENTE → EN_GRACIA (7 días) → SUSPENDIDA.
    await db.withPlatform(async (tx) => {
      const cambios = (await tx.query(
        `UPDATE subscription SET estado = CASE
            WHEN estado='ACTIVA' AND periodo_fin < now() THEN 'PAGO_PENDIENTE'
            WHEN estado='PAGO_PENDIENTE' AND periodo_fin < now() - interval '2 days' THEN 'EN_GRACIA'
            WHEN estado='EN_GRACIA' AND gracia_hasta < now() THEN 'SUSPENDIDA'
            ELSE estado END,
          gracia_hasta = CASE WHEN estado='PAGO_PENDIENTE' AND periodo_fin < now() - interval '2 days' THEN now() + interval '7 days' ELSE gracia_hasta END,
          actualizado_en = now()
         WHERE (estado='ACTIVA' AND periodo_fin < now()) OR (estado='PAGO_PENDIENTE' AND periodo_fin < now() - interval '2 days') OR (estado='EN_GRACIA' AND gracia_hasta < now())
         RETURNING tenant_id, estado, gracia_hasta`,
      )).rows;
      for (const c of cambios) {
        await auditPlatform(tx, c.tenant_id, { tipo: 'SISTEMA', id: null, nombre: 'Ciclo de suscripción' }, 'TRABAJADOR', uuidv7(), { accion: `suscripcion.${c.estado.toLowerCase()}`, resultado: 'EXITO' });
        if (c.estado === 'SUSPENDIDA') {
          await tx.query(`INSERT INTO domain_event (id, tenant_id, tipo, payload, actor) VALUES ($1,$2,'suscripcion_suspendida','{}','SISTEMA:ciclo')`, [uuidv7(), c.tenant_id]);
        }
        const t = (await tx.query(`SELECT nombre, email_contacto FROM tenant WHERE id=$1`, [c.tenant_id])).rows[0];
        if (t?.email_contacto) {
          await encolarCorreo(tx, { tenantId: null, para: t.email_contacto, clave: `suscripcion:${c.tenant_id}:${c.estado}:${new Date().toISOString().slice(0, 10)}`,
            correo: plantillas.suscripcion({ empresa: t.nombre, estado: c.estado, graciaHasta: c.gracia_hasta ? new Date(c.gracia_hasta).toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }) : null, url: `${config.publicUrl}/suscripcion` }) });
        }
      }
    });
  },
};

// ---------------------------------------------------------------------------
// Bucle del trabajador
// ---------------------------------------------------------------------------
export async function runJobsOnce(db: Database, limite = 20): Promise<number> {
  const jobs = await db.withPlatform(async (tx) => {
    // Trabajos que quedaron «en curso» por una caída del proceso vuelven a la cola.
    await tx.query(`UPDATE job SET estado='PENDIENTE' WHERE estado='EN_CURSO' AND ejecutar_en < now() - interval '10 minutes'`);
    const rows = (await tx.query(
      `SELECT * FROM job WHERE estado='PENDIENTE' AND ejecutar_en <= now() ORDER BY ejecutar_en LIMIT $1 FOR UPDATE SKIP LOCKED`, [limite])).rows;
    if (rows.length) await tx.query(`UPDATE job SET estado='EN_CURSO', ejecutar_en=now() WHERE id = ANY($1::uuid[])`, [rows.map((r: any) => r.id)]);
    return rows;
  });
  for (const j of jobs) {
    const h = HANDLERS[j.tipo];
    let resultado: void | 'reintentar' = undefined;
    let error: string | null = null;
    try {
      if (!h) throw new Error(`Tipo de trabajo desconocido: ${j.tipo}`);
      resultado = await h(db, j.tenant_id, j.payload, j);
    } catch (e) {
      // El texto de un error puede traer datos de un proveedor: se depura antes de guardarlo o registrarlo.
      error = depurar((e as Error)?.message ?? e);
      resultado = 'reintentar';
      // En la consola solo la clase del error; el detalle (ya depurado) solo con LOG_NIVEL=debug.
      if (!config.test) console.error(`[trabajador] ${j.tipo} (${j.id}) falló [${clasificarError((e as Error)?.message ?? e)}] intento ${j.intentos + 1}/${j.max_intentos}${config.logNivel === 'debug' ? `: ${error}` : ''}`);
    }
    const intentos = j.intentos + 1;
    await db.withPlatform(async (tx) => {
      if (resultado !== 'reintentar') return tx.query(`UPDATE job SET estado='HECHO', intentos=$2, ultimo_error=NULL WHERE id=$1`, [j.id, intentos]);
      const agotado = intentos >= j.max_intentos;
      const espera = Math.min(3600, 5 * 2 ** intentos); // retroceso exponencial
      await tx.query(
        `UPDATE job SET estado=$2, intentos=$5, ultimo_error=$3, ejecutar_en = now() + ($4 || ' seconds')::interval WHERE id=$1`,
        [j.id, agotado ? 'FALLIDO' : 'PENDIENTE', (error ?? 'reintento solicitado').slice(0, 500), String(espera), intentos],
      );
      // Un trabajo que agota sus reintentos se vuelve un incidente para el operador (solo código y clase).
      if (agotado && j.tipo !== 'enviar_correo') {
        const clase = clasificarError(error);
        const codigo = j.tipo === 'reintentar_aprovisionamiento' ? 'APROVISIONAMIENTO_FALLIDO'
          : j.tipo === 'enviar_mensaje' ? (clase === 'CREDENCIAL' ? 'WHATSAPP_CREDENCIAL' : 'WHATSAPP_ENVIO_FALLIDO')
          : clase === 'CREDENCIAL' ? 'TRABAJO_CREDENCIAL' : clase === 'TIEMPO_AGOTADO' ? 'TRABAJO_TIEMPO_AGOTADO' : clase === 'LIMITE' ? 'TRABAJO_LIMITE' : 'TRABAJO_FALLIDO';
        await registrarIncidente(tx, { codigo, servicio: j.tipo, tenantId: j.tenant_id, trabajoId: j.id, detalle: { tipo_trabajo: j.tipo, intentos, clase_error: clase } });
      }
    });
  }
  return jobs.length;
}

/** Drena eventos y trabajos hasta que no quede nada listo (pruebas y demostraciones). */
export async function drain(db: Database, maxRondas = 30) {
  for (let i = 0; i < maxRondas; i++) {
    const n = (await dispatchEvents(db)) + (await runJobsOnce(db));
    if (n === 0) return;
  }
}

/** Arranca el bucle; la función devuelta lo detiene esperando a que termine la ronda en curso. */
export function startWorker(db: Database): () => Promise<void> {
  let parar = false;
  let ultimoCiclo = 0;
  let enCurso: Promise<void> = Promise.resolve();
  let temporizador: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (parar) return;
    try {
      await dispatchEvents(db);
      await runJobsOnce(db);
      if (Date.now() - ultimoCiclo > 60_000) {
        ultimoCiclo = Date.now();
        const hora = new Date().toISOString().slice(0, 13);
        await db.withPlatform(async (tx) => {
          await enqueue(tx, null, 'ciclo_suscripcion', {}, { claveUnica: `ciclo:${hora}` });
          await enqueue(tx, null, 'cerrar_inactivas', {}, { claveUnica: `inactivas:${hora}` });
          await enqueue(tx, null, 'mantenimiento', {}, { claveUnica: `mant:${hora}` });
        });
      }
    } catch (e) {
      console.error('[trabajador]', (e as Error).message);
    }
    if (!parar) temporizador = setTimeout(() => { enCurso = tick(); }, config.workerIntervalMs);
  };
  temporizador = setTimeout(() => { enCurso = tick(); }, 200);
  return async () => { parar = true; clearTimeout(temporizador); await enCurso; };
}
