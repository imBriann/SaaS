import { reserveSlug } from './subdomain.js';
import { SECTOR_CATALOG } from './sectors.js';
import type { Tx } from '../db/index.js';
import type { SectorTemplate } from '../templates/schema.js';
import { loadTemplates, MODULOS } from '../templates/index.js';
import { PLANES } from './planRules.js';
import { deriveTheme, type TemaTenant } from './theme.js';
import { auditPlatform } from '../core/audit.js';
import { hashPassword, token, uuidv7, slugify } from '../lib/util.js';
import { config, urlEmpresa } from '../config.js';
import { encolarDocumentos } from '../documentos/servicio.js';
import { encolarCorreo } from '../email/servicio.js';
import * as plantillas from '../email/plantillas.js';
import { reembolsoBloqueaServicio } from '../modules/reembolsoBloqueo.js';
import type { Personalizacion } from './personalization.js';

/**
 * Aprovisionamiento (PRO-SW-002 fig. 10). Todo ocurre en UNA transacción: un fallo
 * a mitad no deja un tenant a medio crear. Se ejecuta en contexto de plataforma
 * porque el tenant todavía no existe.
 */

/** Textos sugeridos para enviar a aprobación de Meta (categoría «utilidad»), uno por tipo de aviso proactivo. */
export const PLANTILLAS_PROACTIVAS = [
  { clave: 'recordatorio_cita', tipo: 'RECORDATORIO', cuerpo: 'Hola {{cliente}}, te recordamos tu cita de {{servicio}} el {{fecha}} a las {{hora}} con {{recurso}}. Responde 1 para confirmar, 2 para reprogramar o 3 para cancelar.' },
  { clave: 'seguimiento_cita', tipo: 'SEGUIMIENTO', cuerpo: 'Hola {{cliente}}, gracias por tu visita. ¿Cómo te fue con tu {{servicio}}? Si quieres, te agendamos la próxima.' },
  { clave: 'pago_pendiente', tipo: 'PAGO_PENDIENTE', cuerpo: 'Hola {{cliente}}, tu compra #{{numero}} por {{total}} sigue pendiente de pago. Puedes pagarla aquí: {{enlace}}' },
  { clave: 'cupo_lista_espera', tipo: 'LISTA_ESPERA', cuerpo: 'Hola {{cliente}}, se liberó un cupo de {{servicio}} el {{fecha}} a las {{hora}}. Responde SÍ para tomarlo.' },
  { clave: 'reprogramar_inasistencia', tipo: 'INASISTENCIA', cuerpo: 'Hola {{cliente}}, te esperábamos para tu cita de {{servicio}}. ¿Quieres que te busquemos otro horario?' },
] as const;

export async function ensurePlatformCatalog(tx: Tx): Promise<void> {
  for (const p of PLANES) {
    await tx.query(
      `INSERT INTO plan (codigo, nombre, precio_mensual, cuota_tokens_ia, cuota_mensajes, cuota_documentos, max_usuarios, modulos, politica_excedente, precio_excedente_1k_tokens, orden, precio_anual, descripcion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre, precio_mensual=EXCLUDED.precio_mensual, precio_anual=EXCLUDED.precio_anual, descripcion=EXCLUDED.descripcion, cuota_tokens_ia=EXCLUDED.cuota_tokens_ia,
         cuota_mensajes=EXCLUDED.cuota_mensajes, cuota_documentos=EXCLUDED.cuota_documentos, max_usuarios=EXCLUDED.max_usuarios, modulos=EXCLUDED.modulos,
         politica_excedente=EXCLUDED.politica_excedente, precio_excedente_1k_tokens=EXCLUDED.precio_excedente_1k_tokens, orden=EXCLUDED.orden`,
      [p.codigo, p.nombre, p.precio_mensual, p.cuota_tokens_ia, p.cuota_mensajes, p.cuota_documentos, p.max_usuarios, p.modulos, p.politica_excedente, p.precio_excedente_1k_tokens, p.orden, p.precio_anual, p.descripcion],
    );
  }
  for (const [codigo, m] of Object.entries(MODULOS)) {
    await tx.query(`INSERT INTO module (codigo, nombre, descripcion) VALUES ($1,$2,$3) ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre, descripcion=EXCLUDED.descripcion`, [codigo, m.nombre, m.descripcion]);
  }
  for (const t of loadTemplates()) {
    // Una versión publicada es inmutable: se inserta una vez y no se sobrescribe.
    await tx.query(`INSERT INTO sector_template (sector, version, contenido) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [t.sector, t.version, JSON.stringify(t)]);
  }
}

export async function latestTemplate(tx: Tx, sector: string): Promise<SectorTemplate | null> {
  const rows = (await tx.query(`SELECT version, contenido FROM sector_template WHERE sector=$1`, [sector])).rows;
  if (!rows.length) return null;
  rows.sort((a: any, b: any) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  return rows[0].contenido;
}

export interface CatalogRow {
  tipo: 'PRODUCTO' | 'SERVICIO';
  nombre: string;
  categoria?: string | null;
  precio: number;
  iva_pct?: number;
  duracion_min?: number | null;
  controla_stock?: boolean;
  stock?: number | null;
  stock_minimo?: number;
  sku?: string | null;
}

export interface NuevoTenant {
  nombre: string;
  slug: string;
  nit?: string | null;
  ciudad?: string | null;
  email: string;
  telefono?: string | null;
  plan: string;
  sector: string;
  admin: { nombre: string; email: string; password?: string; passwordHash?: string; correoVerificadoEn?: string };
  personalizacion?: Personalizacion | null;
  tema?: TemaTenant | null;
  logo_data_url?: string | null;
  catalogo?: CatalogRow[] | null;
  recursos?: string[] | null;
  /** Actividad real elegida en el alta (puede no tener plantilla propia). */
  actividad?: { sector: string; tipo_negocio?: string | null; descripcion?: string | null; adicionales?: { sector: string; tipo_negocio: string }[] } | null;
  whatsapp_phone_number_id?: string | null;
  /** Términos del pago que activa la empresa. Sin ellos: un mes comercial (demostración y semillas). */
  suscripcion?: TerminosSuscripcion | null;
}

export interface TerminosSuscripcion {
  modalidad: 'COMERCIAL' | 'INSTITUCIONAL';
  /** Días de acceso; null = un mes calendario. */
  accesoDias: number | null;
  precioPagado: number;
  montoReferencia: number | null;
  paymentId: string | null;
  /** Pago anual: 12 meses (sin días de acceso). */
  ciclo?: 'MENSUAL' | 'ANUAL';
}

/** Condiciones que quedan registradas con cada periodo pagado. */
export function condicionesPeriodo(t: Pick<TerminosSuscripcion, 'modalidad' | 'accesoDias' | 'precioPagado' | 'montoReferencia'>, extra: Record<string, unknown> = {}) {
  return {
    modalidad: t.modalidad, monto_pagado: t.precioPagado, monto_referencia: t.montoReferencia, acceso_dias: t.accesoDias,
    renovacion_automatica: false, cobro_automatico: false,
    ...(t.modalidad === 'INSTITUCIONAL' ? { continuidad: 'Renovación manual al precio institucional vigente; el paso al plan comercial exige aceptación expresa.' } : {}),
    ...extra,
  };
}

async function uniqueSlug(tx: Tx, slug: string): Promise<string> {
  const base = slugify(slug);
  const reservados = ['www', 'app', 'api', 'admin', 'plataforma', 'mail', 'soporte'];
  let s = reservados.includes(base) ? `${base}-negocio` : base;
  for (let i = 2; (await tx.query(`SELECT 1 FROM tenant WHERE slug=$1`, [s])).rows.length; i++) s = `${base}-${i}`;
  return s;
}

export async function createTenantFromTemplate(tx: Tx, d: NuevoTenant, etapa: (e: string) => Promise<void> = async () => {}) {
  if(!SECTOR_CATALOG.some(s=>s.id===d.sector))throw new Error('Sector desconocido');
  // Sectores sin plantilla propia usan la plantilla general (neutral), nunca la de otra actividad.
  const tpl = await latestTemplate(tx, d.sector) ?? await latestTemplate(tx, 'general');
  if (!tpl) throw new Error(`No existe plantilla para el sector ${d.sector}`);
  const plan = (await tx.query(`SELECT * FROM plan WHERE codigo=$1`, [d.plan])).rows[0];
  if (!plan) throw new Error('Plan inexistente');

  const tenantId = uuidv7();
  const slug = await uniqueSlug(tx, d.slug || d.nombre);
  const tema = d.tema ?? deriveTheme(null, d.nombre);
  await tx.query(
    `INSERT INTO tenant (id, slug, nombre, nit, ciudad, email_contacto, telefono, sector, sector_version, plan_codigo, tema, logo_data_url, whatsapp_phone_number_id, whatsapp_estado, registro_datos)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $13::text IS NULL THEN 'SIN_CONFIGURAR' WHEN $13::text LIKE 'sim-%' THEN 'SIMULADO' ELSE 'PENDIENTE_VERIFICAR' END, $14)`,
    // tenant.sector = plantilla aplicada (la política de riesgo y el escalamiento se resuelven con ella);
    // la actividad real queda en registro_datos para mostrarla y describir el negocio a los agentes.
    [tenantId, slug, d.nombre, d.nit ?? null, d.ciudad ?? null, d.email, d.telefono ?? null, tpl.sector, tpl.version, d.plan, JSON.stringify(tema), d.logo_data_url ?? null, d.whatsapp_phone_number_id ?? null,
      JSON.stringify({ actividad: d.actividad ?? { sector: d.sector }, ...(d.personalizacion ? { inicio_ia: d.personalizacion } : {}) })],
  );
  await etapa('empresa_creada');

  // La vigencia corre desde la activación (ahora), no desde el pago ni la cotización.
  const ahora = new Date();
  const s = d.suscripcion;
  const fin = new Date(ahora);
  if (s?.accesoDias) fin.setTime(ahora.getTime() + s.accesoDias * 86_400_000);
  else fin.setUTCMonth(fin.getUTCMonth() + (s?.ciclo === 'ANUAL' ? 12 : 1));
  const ciclo = s?.accesoDias ? 'MENSUAL' : s?.ciclo ?? 'MENSUAL';
  const condiciones = s ? condicionesPeriodo(s) : null;
  await tx.query(
    `INSERT INTO subscription (tenant_id, plan_codigo, estado, periodo_inicio, periodo_fin, modalidad, precio_pagado, condiciones, ciclo) VALUES ($1,$2,'ACTIVA',$3,$4,$5,$6,$7,$8)`,
    [tenantId, d.plan, ahora.toISOString(), fin.toISOString(), s?.modalidad ?? 'COMERCIAL', s?.precioPagado ?? null, condiciones ? JSON.stringify(condiciones) : null, ciclo]);
  if (s) {
    await tx.query(
      `INSERT INTO subscription_period (id, tenant_id, payment_id, modalidad, plan_codigo, monto_pagado, monto_referencia, periodo_inicio, periodo_fin, condiciones, ciclo) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [uuidv7(), tenantId, s.paymentId, s.modalidad, d.plan, s.precioPagado, s.montoReferencia, ahora.toISOString(), fin.toISOString(), JSON.stringify(condiciones), ciclo]);
  }

  // Módulos: los de la plantilla que el plan incluye.
  for (const m of [...new Set([...tpl.modulos, ...(plan.modulos as string[])])]) {
    await tx.query(`INSERT INTO tenant_module (tenant_id, modulo, activo) VALUES ($1,$2,$3)`, [tenantId, m, (plan.modulos as string[]).includes(m)]);
  }
  await etapa('plantilla_aplicada');

  // Roles y permisos por defecto.
  const roleIds: Record<string, string> = {};
  for (const r of tpl.roles) {
    const id = uuidv7();
    roleIds[r.clave] = id;
    await tx.query(`INSERT INTO role (id, tenant_id, clave, nombre, es_agente) VALUES ($1,$2,$3,$4,$5)`, [id, tenantId, r.clave, r.nombre, r.es_agente]);
    for (const p of r.permisos) await tx.query(`INSERT INTO role_permission (tenant_id, role_id, permiso) VALUES ($1,$2,$3)`, [tenantId, id, p]);
  }
  // Autonomía de la IA (AUTOMATICO por defecto) y política de la agenda (029).
  await tx.query(`INSERT INTO ia_ajustes (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenantId]);
  await tx.query(`INSERT INTO agenda_ajustes (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`, [tenantId]);
  await tx.query(`INSERT INTO sla_policy (tenant_id, prioridad, minutos_primera_respuesta) SELECT $1, k, v::int FROM jsonb_each_text($2::jsonb) AS x(k, v)`, [tenantId, JSON.stringify(tpl.sla_minutos)]);

  // Agentes (una runtime, varias configuraciones).
  for (const a of tpl.agentes) {
    await tx.query(`INSERT INTO ai_agent (id, tenant_id, configuracion, role_id, prompt_base, herramientas) VALUES ($1,$2,$3,$4,$5,$6)`, [uuidv7(), tenantId, a.configuracion, roleIds[a.rol], a.prompt_base, a.herramientas]);
  }
  for (const m of tpl.plantillas_mensaje) {
    // Variables en el orden en que aparecen: así se envían como parámetros {{1}}, {{2}}… a Meta.
    const variables = [...new Set([...m.cuerpo.matchAll(/\{\{(\w+)\}\}/g)].map((x) => x[1]))];
    await tx.query(`INSERT INTO message_template (tenant_id, clave, categoria, cuerpo, variables) VALUES ($1,$2,$3,$4,$5)`, [tenantId, m.clave, m.categoria, m.cuerpo, variables]);
  }
  // Plantillas por tipo de aviso proactivo: quedan NO_REGISTRADA hasta que Meta las apruebe (docs/ia-autonoma).
  for (const m of PLANTILLAS_PROACTIVAS) {
    const variables = [...new Set([...m.cuerpo.matchAll(/\{\{(\w+)\}\}/g)].map((x) => x[1]))];
    await tx.query(`INSERT INTO message_template (tenant_id, clave, categoria, cuerpo, variables, tipo_proactivo) VALUES ($1,$2,'UTILIDAD',$3,$4,$5) ON CONFLICT (tenant_id, clave) DO UPDATE SET tipo_proactivo=EXCLUDED.tipo_proactivo`,
      [tenantId, m.clave, m.cuerpo, variables, m.tipo]);
  }
  for (const r of tpl.reglas_automatizacion) {
    await tx.query(`INSERT INTO automation_rule (id, tenant_id, evento, condicion, accion, parametros) VALUES ($1,$2,$3,$4,$5,$6)`, [uuidv7(), tenantId, r.evento, JSON.stringify(r.condicion), r.accion, JSON.stringify(r.parametros)]);
  }
  // Resolución de facturación (en el piloto la entrega el proveedor tecnológico).
  await tx.query(
    `INSERT INTO fiscal_resolution (tenant_id, prefijo, numero_desde, numero_hasta, siguiente, resolucion) VALUES ($1,'FE',1000,50000,1000,$2)`,
    [tenantId, `Resolución de habilitación de pruebas ${new Date().getUTCFullYear()}`],
  );

  // Recursos agendables.
  // La agenda necesita al menos un recurso para reservar. Sin recursos indicados se crea uno neutro
  // («Agenda principal»), nunca un empleado inventado: el equipo se configura después del alta.
  const horario = tpl.recursos_ejemplo[0]?.horario ?? {};
  const recursos = d.recursos?.length ? d.recursos.map((n) => ({ nombre: n, horario })) : d.recursos ? [{ nombre: 'Agenda principal', horario }] : tpl.recursos_ejemplo;
  for (const r of recursos) await tx.query(`INSERT INTO resource (id, tenant_id, nombre, horario) VALUES ($1,$2,$3,$4)`, [uuidv7(), tenantId, r.nombre, JSON.stringify(r.horario)]);

  // Catálogo: el importado por el usuario o, si no hay, el de ejemplo (editable).
  const catalogo: CatalogRow[] = d.catalogo ?? tpl.catalogo_ejemplo;
  for (const c of catalogo) {
    const controla = c.tipo === 'PRODUCTO' && (c.controla_stock ?? c.stock != null);
    await tx.query(
      `INSERT INTO product (id, tenant_id, tipo, nombre, categoria, precio, iva_pct, duracion_min, controla_stock, stock, stock_minimo, sku) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [uuidv7(), tenantId, c.tipo, c.nombre, c.categoria ?? null, c.precio, c.iva_pct ?? 0, c.tipo === 'SERVICIO' ? c.duracion_min ?? null : null, controla, controla ? c.stock ?? 0 : 0, c.stock_minimo ?? 0, c.sku ?? null],
    );
  }
  await etapa('catalogo_importado');

  // Administrador. Una misma identidad puede pertenecer a varios negocios (USER_TENANT).
  let user = (await tx.query(`SELECT id FROM users WHERE email=$1`, [d.admin.email.toLowerCase()])).rows[0];
  let passwordToken: string | null = null;
  if (!user) {
    user = { id: uuidv7() };
    await tx.query(`INSERT INTO users (id, email, nombre, password_hash, email_verificado_en) VALUES ($1,$2,$3,$4,$5)`, [user.id, d.admin.email.toLowerCase(), d.admin.nombre, d.admin.passwordHash ?? (d.admin.password ? hashPassword(d.admin.password) : null), d.admin.correoVerificadoEn ?? null]);
    if (!d.admin.password && !d.admin.passwordHash) passwordToken = token(24);
  }
  await tx.query(`INSERT INTO user_tenant (user_id, tenant_id, role_id) VALUES ($1,$2,$3)`, [user.id, tenantId, roleIds[tpl.rol_administrador]]);
  // Quien hace el alta es el propietario: un rango por encima del administrador.
  await tx.query(`UPDATE tenant SET propietario_id=$2 WHERE id=$1`, [tenantId, user.id]);
  await etapa('administrador_creado');
  await etapa('tema_generado');
  await etapa('subdominio_asignado');
  return { tenantId, slug, userId: user.id, passwordToken, roleIds };
}

/**
 * Materializa un borrador pagado. Idempotente: si el borrador ya fue
 * aprovisionado, no hace nada.
 */
export async function provisionDraft(tx: Tx, draftToken: string, correlacion: string) {
  const d = (await tx.query(`SELECT * FROM onboarding_draft WHERE token=$1 FOR UPDATE`, [draftToken])).rows[0];
  if (!d) throw new Error('Borrador inexistente');
  if (d.estado === 'APROVISIONADO') return { tenantId: d.tenant_id, yaExistia: true };
  // Un pago devuelto por retracto o por falta de activación no abre el servicio.
  if (await reembolsoBloqueaServicio(tx, draftToken)) throw new Error('El pago de esta alta se devuelve: el espacio no se crea.');
  if (d.creacion_diferida && (!d.personalizacion || d.creacion?.estado !== 'aplicando')) throw new Error('La creación asistida todavía no está preparada');
  // El pago aprobado fija el plan y las condiciones (los términos se congelaron al crear el checkout).
  const pago = (await tx.query(
    `SELECT id, referencia, monto, monto_referencia, modalidad, acceso_dias, plan_codigo, ciclo FROM payment WHERE draft_token=$1 AND estado='APROBADO' ORDER BY verificado_en NULLS LAST, creado_en LIMIT 1`, [draftToken])).rows[0];
  const plan = pago?.plan_codigo ?? d.plan_codigo;
  const n = d.negocio ?? {};
  await reserveSlug(tx, n.slug, draftToken, 30);
  const etapas: { etapa: string; en: string }[] = [{ etapa: 'pago_verificado', en: new Date().toISOString() }];
  const r = await createTenantFromTemplate(
    tx,
    {
      nombre: n.nombre, slug: n.slug || n.nombre, nit: n.nit ? `${n.nit}-${n.nit_dv}` : null, ciudad: n.ciudad, email: n.email, telefono: n.telefono,
      plan, sector: d.clasificacion.sector ?? 'otro',
      admin: { nombre: n.responsable || n.nombre, email: n.email, passwordHash: d.password_hash_inicial ?? undefined, correoVerificadoEn: d.creacion_diferida ? d.email_verificado_en : undefined },
      personalizacion: d.personalizacion,
      tema: d.tema, logo_data_url: d.logo_data_url, catalogo: d.catalogo ?? [], recursos: n.recursos ?? [],
      actividad: { sector: d.clasificacion.sector ?? 'otro', tipo_negocio: d.clasificacion.tipo_negocio ?? null, descripcion: d.descripcion || d.clasificacion.otro_descripcion || null,
        adicionales: (d.clasificacion.actividades_adicionales ?? []).map((a: any) => ({ sector: a.sector, tipo_negocio: a.tipo_negocio })) },
      suscripcion: pago ? {
        modalidad: pago.modalidad, accesoDias: pago.acceso_dias ?? null, precioPagado: Number(pago.monto),
        montoReferencia: pago.monto_referencia == null ? null : Number(pago.monto_referencia), paymentId: pago.id, ciclo: pago.ciclo === 'ANUAL' ? 'ANUAL' : 'MENSUAL',
      } : null,
    },
    async (e) => { etapas.push({ etapa: e, en: new Date().toISOString() }); },
  );
  // Instantánea de la configuración efectiva en este momento. El token público del borrador solo
  // puede ver esto: nunca los datos operativos actuales del tenant (esos exigen sesión y permisos).
  const tenant = (await tx.query(`SELECT nombre, slug, tema, logo_data_url FROM tenant WHERE id=$1`, [r.tenantId])).rows[0];
  const modulos = (await tx.query(`SELECT modulo FROM tenant_module WHERE tenant_id=$1 AND activo ORDER BY modulo`, [r.tenantId])).rows.map((x: any) => x.modulo);
  const productos = (await tx.query(`SELECT nombre, tipo, precio FROM product WHERE tenant_id=$1 AND eliminado_en IS NULL ORDER BY creado_en, nombre`, [r.tenantId])).rows;
  const sus = (await tx.query(`SELECT modalidad, periodo_fin FROM subscription WHERE tenant_id=$1`, [r.tenantId])).rows[0];
  const acceso = { url: urlEmpresa(tenant.slug), modalidad: sus.modalidad, vigente_hasta: new Date(sus.periodo_fin).toISOString(), monto_pagado: pago ? Number(pago.monto) : null, referencia: pago?.referencia ?? null };
  const cierre = {
    nombre: tenant.nombre, slug: tenant.slug, tema: tenant.tema, logo_data_url: tenant.logo_data_url, modulos, acceso, personalizacion: d.personalizacion ?? null,
    catalogo: { origen: d.catalogo?.length ? 'propio' : 'vacio', total: productos.length, muestra: productos.slice(0, 4).map((x: any) => ({ ...x, precio: Number(x.precio) })) },
  };
  // Documentos del pago (comprobante y ZIP) y, al terminarlos, el correo de confirmación: en la misma
  // transacción, así que si el alta se revierte no queda nada encolado.
  if (pago) {
    await tx.query('UPDATE documento_pago SET tenant_id=$2 WHERE payment_id=$1 AND tenant_id IS NULL', [pago.id, r.tenantId]);
    await encolarDocumentos(tx, pago.id, d.creacion_diferida ? 'espacio_creado' : 'inicial');
  }
  // Enlace para continuar (definir la contraseña, descargar documentos) aunque se haya cerrado el navegador.
  if (r.passwordToken && d.email_verificado) {
    await encolarCorreo(tx, { tenantId: null, para: d.email_verificado, sensible: true, clave: `continuar:${r.tenantId}`, caducaEn: new Date(Date.now() + 7 * 86_400_000),
      correo: plantillas.continuarAlta({ nombre: n.responsable || n.nombre || '', empresa: tenant.nombre, url: `${config.publicUrl}/empezar/listo#borrador=${draftToken}` }) });
  }
  await tx.query(
    `UPDATE onboarding_draft SET estado='APROVISIONADO', tenant_id=$2, password_token=$3, etapas=$4, cierre=$5, password_hash_inicial=NULL,
      creacion=creacion || '{"estado":"completado","error":null}'::jsonb, actualizado_en=now() WHERE token=$1`,
    [draftToken, r.tenantId, r.passwordToken, JSON.stringify(etapas), JSON.stringify(cierre)],
  );
  await tx.query(`UPDATE payment SET tenant_id=$2 WHERE draft_token=$1`, [draftToken, r.tenantId]);
  await auditPlatform(tx, r.tenantId, { tipo: 'SISTEMA', id: null, nombre: 'Aprovisionamiento' }, 'WEBHOOK', correlacion, {
    accion: 'tenant.aprovisionar', recurso: 'tenant', recursoId: r.tenantId, resultado: 'EXITO',
    detalle: { plan, modalidad: sus.modalidad, referencia: pago?.referencia ?? null, monto_pagado: pago ? Number(pago.monto) : null, vigente_hasta: acceso.vigente_hasta, sector: d.clasificacion.sector, import_mapping: d.import_mapping, filas_catalogo: d.catalogo?.length ?? 0, recomendacion: d.recomendacion },
  });
  return { tenantId: r.tenantId, slug: r.slug, yaExistia: false };
}
