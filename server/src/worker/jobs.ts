import type { Database, Tx } from '../db/index.js';
import { systemCtx, type Ctx } from '../core/context.js';
import { audit, auditPlatform } from '../core/audit.js';
import { enqueue } from '../core/events.js';
import { channel } from '../adapters/channel.js';
import { emailProvider } from '../adapters/email.js';
import { handleCustomerMessage, summarizeCase } from '../ai/runtime.js';
import { createInvoiceForOrder, emitDocument } from '../modules/fiscal.js';
import { addMessage, getOrOpenConversation } from '../modules/conversations.js';
import { config } from '../config.js';
import { cop, uuidv7 } from '../lib/util.js';
import { formatFechaLarga, utcToLocal } from '../lib/time.js';

/**
 * Proceso trabajador (PRO-SW-002 fig. 03). Toda llamada saliente a un tercero
 * sale de aquí, con reintentos y retroceso exponencial.
 */
type Handler = (db: Database, tenantId: string | null, payload: any, job: any) => Promise<void | 'reintentar'>;

export function render(cuerpo: string, vars: Record<string, string>): string {
  return cuerpo.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

async function sendTemplate(tx: Tx, ctx: Ctx, customerId: string, clave: string, vars: Record<string, string>) {
  const tpl = (await tx.query(`SELECT cuerpo FROM message_template WHERE clave=$1`, [clave])).rows[0];
  const c = (await tx.query(`SELECT telefono FROM customer WHERE id=$1`, [customerId])).rows[0];
  if (!tpl || !c?.telefono) return false;
  const v = await getOrOpenConversation(tx, ctx, customerId, 'WHATSAPP');
  await addMessage(tx, ctx, { conversation_id: v.id, remitente: 'SYSTEM', tipo: 'PLANTILLA', contenido: render(tpl.cuerpo, vars), metadatos: { plantilla: clave } });
  return true;
}

async function queueEmail(tx: Tx, ctx: Ctx, para: string, asunto: string, html: string, extra: { conversation_id?: string | null; adjunto_ref?: string | null } = {}) {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO email_outbox (id, tenant_id, para, asunto, cuerpo_html, adjunto_ref, estado, conversation_id) VALUES ($1,$2,$3,$4,$5,$6,'PENDIENTE',$7)`,
    [id, ctx.tenantId, para, asunto, html, extra.adjunto_ref ?? null, extra.conversation_id ?? null],
  );
  await enqueue(tx, ctx.tenantId, 'enviar_correo', { email_id: id }, { claveUnica: `mail:${id}` });
  return id;
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
// Reglas declarativas de automatización (PRO-SW-001 §18)
// ---------------------------------------------------------------------------
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
        await enqueue(tx, ctx.tenantId, 'recordatorio', { appointment_id: p.appointment_id, plantilla: rule.parametros.plantilla }, { ejecutarEn: cuando, claveUnica: `rec:${p.appointment_id}` });
      }
      return;
    }
    case 'emitir_factura': {
      const activo = (await tx.query(`SELECT activo FROM tenant_module WHERE modulo='facturacion'`)).rows[0]?.activo;
      if (activo && p.order_id) await createInvoiceForOrder(tx, { ...ctx, actor: { tipo: 'SISTEMA', id: null, nombre: 'Módulo de documentos fiscales' } }, p.order_id);
      return;
    }
    case 'notificar_admin': {
      const t = (await tx.query(`SELECT email_contacto, nombre FROM tenant LIMIT 1`)).rows[0];
      if (!t?.email_contacto) return;
      const detalle = Object.entries(p).filter(([k]) => !k.endsWith('_id')).map(([k, v]) => `<li><b>${k}</b>: ${String(v)}</li>`).join('');
      await queueEmail(tx, ctx, t.email_contacto, `${rule.parametros.asunto ?? 'Aviso'} — ${t.nombre}`, `<p>${rule.parametros.asunto ?? 'Aviso'}</p><ul>${detalle}</ul><p>Revísalo en el panel.</p>`);
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
  procesar_mensaje: async (db, tenantId, p) => { await handleCustomerMessage(db, tenantId!, p.conversation_id); },

  enviar_mensaje: async (db, tenantId, p) => {
    const info = await db.withTenant(tenantId!, async (tx) =>
      (await tx.query(
        `SELECT m.id, m.contenido, m.canal, m.estado_entrega, c.telefono, t.whatsapp_phone_number_id
         FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN customer c ON c.id=v.customer_id JOIN tenant t ON t.id=m.tenant_id
         WHERE m.id=$1`, [p.message_id])).rows[0]);
    if (!info || info.estado_entrega === 'ENTREGADO' || !info.telefono) return;
    const r = await channel(info.canal).sendText(info.whatsapp_phone_number_id, info.telefono.replace('+', ''), info.contenido);
    if (!r.ok) return 'reintentar';
    await db.withTenant(tenantId!, (tx) => tx.query(`UPDATE message SET estado_entrega=$2, metadatos = metadatos || $3::jsonb WHERE id=$1`, [p.message_id, r.simulado ? 'ENTREGADO' : 'ENVIADO', JSON.stringify({ id_externo_salida: r.idExterno })]));
  },

  emitir_documento: async (db, tenantId, p, job) => {
    const r = await db.withTenant(tenantId!, (tx) => emitDocument(tx, systemCtx(tenantId!, job.id, 'Módulo de documentos fiscales'), p.fiscal_document_id, p.motivo));
    if (r === 'REINTENTAR') return 'reintentar';
  },

  entregar_documento: async (db, tenantId, p, job) => {
    await db.withTenant(tenantId!, async (tx) => {
      const ctx = systemCtx(tenantId!, job.id, 'Entrega de documentos');
      const d = (await tx.query(
        `SELECT f.*, o.customer_id, o.conversation_id, c.nombre, c.email, c.telefono, t.nombre AS negocio
         FROM fiscal_document f JOIN "order" o ON o.id=f.order_id JOIN customer c ON c.id=o.customer_id JOIN tenant t ON t.id=f.tenant_id WHERE f.id=$1`,
        [p.fiscal_document_id])).rows[0];
      if (!d) return;
      const enlace = `${config.publicUrl.replace(/\/$/, '')}/api/publico/documentos/${d.token_publico}`;
      const vars = { cliente: d.nombre.split(' ')[0], numero: d.numero, total: cop(Number(d.total)), enlace };
      let wa = 'NO_APLICA', mail = 'NO_APLICA';
      if (d.telefono) {
        const plantilla = d.tipo === 'FACTURA' ? 'factura_enviada' : null;
        const ok = plantilla
          ? await sendTemplate(tx, ctx, d.customer_id, plantilla, vars)
          : await sendTemplate(tx, ctx, d.customer_id, 'factura_enviada', { ...vars, numero: `${d.numero} (nota crédito)` });
        wa = ok ? 'ENVIADO' : 'FALLIDO';
      }
      if (d.email) {
        await queueEmail(tx, ctx, d.email, `${d.tipo === 'FACTURA' ? 'Factura electrónica' : 'Nota crédito'} ${d.numero} — ${d.negocio}`,
          `<p>Hola ${vars.cliente},</p><p>Adjuntamos tu ${d.tipo === 'FACTURA' ? 'factura electrónica' : 'nota crédito'} <b>${d.numero}</b> por <b>${vars.total}</b>, validada por la DIAN.</p><p>CUFE: <code>${d.cufe}</code></p><p><a href="${enlace}">Ver documento</a></p>`,
          { conversation_id: d.conversation_id, adjunto_ref: d.id });
        mail = 'PENDIENTE';
      }
      await tx.query(`UPDATE fiscal_document SET entrega_whatsapp=$2, entrega_email=$3, estado=CASE WHEN $2='ENVIADO' OR $3='PENDIENTE' THEN 'ENTREGADO' ELSE estado END WHERE id=$1`, [d.id, wa, mail]);
      await audit(tx, ctx, { accion: 'documento.entregar', recurso: 'fiscal_document', recursoId: d.id, resultado: 'EXITO', detalle: { whatsapp: wa, correo: mail } });
    });
  },

  enviar_correo: async (db, tenantId, p) => {
    const m = await db.withTenant(tenantId!, async (tx) => (await tx.query(`SELECT * FROM email_outbox WHERE id=$1`, [p.email_id])).rows[0]);
    if (!m || m.estado === 'ENTREGADO') return;
    const r = await emailProvider().send({ para: m.para, asunto: m.asunto, html: m.cuerpo_html });
    await db.withTenant(tenantId!, async (tx) => {
      await tx.query(`UPDATE email_outbox SET estado=$2, id_proveedor=$3, actualizado_en=now() WHERE id=$1`, [m.id, r.ok ? 'ENTREGADO' : 'FALLIDO', r.id ?? null]);
      if (m.adjunto_ref) await tx.query(`UPDATE fiscal_document SET entrega_email=$2 WHERE id=$1`, [m.adjunto_ref, r.ok ? 'ENTREGADO' : 'FALLIDO']);
      // El estado del envío queda también en la conversación del cliente (PRO-SW-001 §16.3).
      if (m.conversation_id) {
        await addMessage(tx, systemCtx(tenantId!, m.id, 'Correo'), { conversation_id: m.conversation_id, remitente: 'SYSTEM', tipo: 'NOTA_INTERNA', contenido: `Correo «${m.asunto}» a ${m.para}: ${r.ok ? 'entregado' : 'falló (' + r.error + ')'}`, metadatos: { correo: m.id } });
      }
    });
    if (!r.ok && !/inválida/.test(r.error ?? '')) return 'reintentar';
  },

  resumir_caso: async (db, tenantId, p) => { await summarizeCase(db, tenantId!, p.case_id); },

  revisar_sla: async (db, tenantId, p, job) => {
    await db.withTenant(tenantId!, async (tx) => {
      const k = (await tx.query(`SELECT * FROM support_case WHERE id=$1`, [p.case_id])).rows[0];
      if (!k || k.primera_respuesta_en || k.estado === 'CERRADO') return;
      const ctx = systemCtx(tenantId!, job.id, 'Motor de asignación');
      // Siguiente nivel: se notifica al administrador del tenant.
      const t = (await tx.query(`SELECT email_contacto, nombre FROM tenant LIMIT 1`)).rows[0];
      if (t?.email_contacto) await queueEmail(tx, ctx, t.email_contacto, `SLA vencido en ${k.radicado}`, `<p>El radicado <b>${k.radicado}</b> (${k.prioridad}) superó su tiempo de primera respuesta sin ser atendido.</p>`);
      await audit(tx, ctx, { accion: 'caso.sla_vencido', recurso: 'support_case', recursoId: k.id, resultado: 'EXITO', detalle: { radicado: k.radicado } });
    });
  },

  recordatorio: async (db, tenantId, p, job) => {
    await db.withTenant(tenantId!, async (tx) => {
      const d = await appointmentVars(tx, p.appointment_id);
      if (!d || !['RESERVADA', 'CONFIRMADA'].includes(d.a.estado)) return;
      await sendTemplate(tx, systemCtx(tenantId!, job.id, 'Recordatorios'), d.a.customer_id, p.plantilla, d.vars);
    });
  },

  /**
   * Cierre por inactividad: una conversación atendida solo por la IA, sin caso
   * abierto ni acción pendiente y sin mensajes del cliente en 12 h, se da por
   * resuelta por el agente (indicador «resueltas sin intervención humana»).
   */
  cerrar_inactivas: async (db) => {
    await db.withPlatform((tx) => tx.query(
      `UPDATE conversation v SET estado='CERRADA', resuelta_por='AGENTE'
       WHERE v.estado='ABIERTA' AND v.control='AI' AND v.ultimo_mensaje_cliente_en < now() - interval '12 hours'
         AND NOT EXISTS (SELECT 1 FROM support_case k WHERE k.conversation_id=v.id AND k.estado <> 'CERRADO')
         AND NOT EXISTS (SELECT 1 FROM pending_action p WHERE p.conversation_id=v.id AND p.estado='PENDIENTE' AND p.expira_en > now())`,
    ));
  },

  ciclo_suscripcion: async (db) => {
    // ACTIVA vencida → PAGO_PENDIENTE → EN_GRACIA (7 días) → SUSPENDIDA (PRO-SW-001 §17.1).
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
         RETURNING tenant_id, estado`,
      )).rows;
      for (const c of cambios) {
        await auditPlatform(tx, c.tenant_id, { tipo: 'SISTEMA', id: null, nombre: 'Ciclo de suscripción' }, 'TRABAJADOR', uuidv7(), { accion: `suscripcion.${c.estado.toLowerCase()}`, resultado: 'EXITO' });
        if (c.estado === 'SUSPENDIDA') {
          await tx.query(`INSERT INTO domain_event (id, tenant_id, tipo, payload, actor) VALUES ($1,$2,'suscripcion_suspendida','{}','SISTEMA:ciclo')`, [uuidv7(), c.tenant_id]);
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
    const rows = (await tx.query(
      `SELECT * FROM job WHERE estado='PENDIENTE' AND ejecutar_en <= now() ORDER BY ejecutar_en LIMIT $1 FOR UPDATE SKIP LOCKED`, [limite])).rows;
    if (rows.length) await tx.query(`UPDATE job SET estado='EN_CURSO', intentos = intentos + 1 WHERE id = ANY($1::uuid[])`, [rows.map((r: any) => r.id)]);
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
      error = (e as Error).message ?? String(e);
      resultado = 'reintentar';
      if (process.env.NODE_ENV !== 'test') console.error(`[trabajador] ${j.tipo} falló:`, error);
    }
    const intentos = j.intentos + 1;
    await db.withPlatform((tx) => {
      if (resultado !== 'reintentar') return tx.query(`UPDATE job SET estado='HECHO', ultimo_error=NULL WHERE id=$1`, [j.id]);
      const agotado = intentos >= j.max_intentos;
      const espera = Math.min(3600, 5 * 2 ** intentos); // retroceso exponencial
      return tx.query(
        `UPDATE job SET estado=$2, ultimo_error=$3, ejecutar_en = now() + ($4 || ' seconds')::interval WHERE id=$1`,
        [j.id, agotado ? 'FALLIDO' : 'PENDIENTE', error ?? 'reintento solicitado', String(espera)],
      );
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

export function startWorker(db: Database) {
  let parar = false;
  let ultimoCiclo = 0;
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
        });
      }
    } catch (e) {
      console.error('[trabajador]', (e as Error).message);
    }
    setTimeout(tick, config.workerIntervalMs);
  };
  setTimeout(tick, 200);
  return () => { parar = true; };
}
