import type { Tx } from '../db/index.js';
import type { SectorTemplate } from '../templates/schema.js';
import { loadTemplates, MODULOS } from '../templates/index.js';
import { PLANES } from './planRules.js';
import { deriveTheme, type TemaTenant } from './theme.js';
import { auditPlatform } from '../core/audit.js';
import { hashPassword, token, uuidv7, slugify } from '../lib/util.js';

/**
 * Aprovisionamiento (PRO-SW-002 fig. 10). Todo ocurre en UNA transacción: un fallo
 * a mitad no deja un tenant a medio crear. Se ejecuta en contexto de plataforma
 * porque el tenant todavía no existe.
 */

export async function ensurePlatformCatalog(tx: Tx): Promise<void> {
  for (const p of PLANES) {
    await tx.query(
      `INSERT INTO plan (codigo, nombre, precio_mensual, cuota_tokens_ia, cuota_mensajes, cuota_documentos, max_usuarios, modulos, politica_excedente, precio_excedente_1k_tokens, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (codigo) DO UPDATE SET nombre=EXCLUDED.nombre, precio_mensual=EXCLUDED.precio_mensual, cuota_tokens_ia=EXCLUDED.cuota_tokens_ia,
         cuota_mensajes=EXCLUDED.cuota_mensajes, cuota_documentos=EXCLUDED.cuota_documentos, max_usuarios=EXCLUDED.max_usuarios, modulos=EXCLUDED.modulos,
         politica_excedente=EXCLUDED.politica_excedente, precio_excedente_1k_tokens=EXCLUDED.precio_excedente_1k_tokens, orden=EXCLUDED.orden`,
      [p.codigo, p.nombre, p.precio_mensual, p.cuota_tokens_ia, p.cuota_mensajes, p.cuota_documentos, p.max_usuarios, p.modulos, p.politica_excedente, p.precio_excedente_1k_tokens, p.orden],
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
  admin: { nombre: string; email: string; password?: string };
  tema?: TemaTenant | null;
  logo_data_url?: string | null;
  catalogo?: CatalogRow[] | null;
  recursos?: string[] | null;
  whatsapp_phone_number_id?: string | null;
}

async function uniqueSlug(tx: Tx, slug: string): Promise<string> {
  const base = slugify(slug);
  const reservados = ['www', 'app', 'api', 'admin', 'plataforma', 'mail', 'soporte'];
  let s = reservados.includes(base) ? `${base}-negocio` : base;
  for (let i = 2; (await tx.query(`SELECT 1 FROM tenant WHERE slug=$1`, [s])).rows.length; i++) s = `${base}-${i}`;
  return s;
}

export async function createTenantFromTemplate(tx: Tx, d: NuevoTenant, etapa: (e: string) => Promise<void> = async () => {}) {
  const tpl = await latestTemplate(tx, d.sector);
  if (!tpl) throw new Error(`No existe plantilla para el sector ${d.sector}`);
  const plan = (await tx.query(`SELECT * FROM plan WHERE codigo=$1`, [d.plan])).rows[0];
  if (!plan) throw new Error('Plan inexistente');

  const tenantId = uuidv7();
  const slug = await uniqueSlug(tx, d.slug || d.nombre);
  const tema = d.tema ?? deriveTheme(null, d.nombre);
  await tx.query(
    `INSERT INTO tenant (id, slug, nombre, nit, ciudad, email_contacto, telefono, sector, sector_version, plan_codigo, tema, logo_data_url, whatsapp_phone_number_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tenantId, slug, d.nombre, d.nit ?? null, d.ciudad ?? null, d.email, d.telefono ?? null, tpl.sector, tpl.version, d.plan, JSON.stringify(tema), d.logo_data_url ?? null, d.whatsapp_phone_number_id ?? null],
  );
  await etapa('empresa_creada');

  const ahora = new Date();
  const fin = new Date(ahora); fin.setUTCMonth(fin.getUTCMonth() + 1);
  await tx.query(`INSERT INTO subscription (tenant_id, plan_codigo, estado, periodo_inicio, periodo_fin) VALUES ($1,$2,'ACTIVA',$3,$4)`, [tenantId, d.plan, ahora.toISOString(), fin.toISOString()]);

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
  await tx.query(`INSERT INTO sla_policy (tenant_id, prioridad, minutos_primera_respuesta) SELECT $1, k, v::int FROM jsonb_each_text($2::jsonb) AS x(k, v)`, [tenantId, JSON.stringify(tpl.sla_minutos)]);

  // Agentes (una runtime, varias configuraciones).
  for (const a of tpl.agentes) {
    await tx.query(`INSERT INTO ai_agent (id, tenant_id, configuracion, role_id, prompt_base, herramientas) VALUES ($1,$2,$3,$4,$5,$6)`, [uuidv7(), tenantId, a.configuracion, roleIds[a.rol], a.prompt_base, a.herramientas]);
  }
  for (const m of tpl.plantillas_mensaje) {
    await tx.query(`INSERT INTO message_template (tenant_id, clave, categoria, cuerpo) VALUES ($1,$2,$3,$4)`, [tenantId, m.clave, m.categoria, m.cuerpo]);
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
  const recursos = d.recursos?.length ? d.recursos.map((n) => ({ nombre: n, horario: tpl.recursos_ejemplo[0]?.horario ?? {} })) : tpl.recursos_ejemplo;
  for (const r of recursos) await tx.query(`INSERT INTO resource (id, tenant_id, nombre, horario) VALUES ($1,$2,$3,$4)`, [uuidv7(), tenantId, r.nombre, JSON.stringify(r.horario)]);

  // Catálogo: el importado por el usuario o, si no hay, el de ejemplo (editable).
  const catalogo: CatalogRow[] = d.catalogo?.length ? d.catalogo : tpl.catalogo_ejemplo;
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
    await tx.query(`INSERT INTO users (id, email, nombre, password_hash) VALUES ($1,$2,$3,$4)`, [user.id, d.admin.email.toLowerCase(), d.admin.nombre, d.admin.password ? hashPassword(d.admin.password) : null]);
    if (!d.admin.password) passwordToken = token(24);
  }
  await tx.query(`INSERT INTO user_tenant (user_id, tenant_id, role_id) VALUES ($1,$2,$3)`, [user.id, tenantId, roleIds[tpl.rol_administrador]]);
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
  const n = d.negocio ?? {};
  const etapas: { etapa: string; en: string }[] = [{ etapa: 'pago_verificado', en: new Date().toISOString() }];
  const r = await createTenantFromTemplate(
    tx,
    {
      nombre: n.nombre, slug: n.slug || n.nombre, nit: n.nit, ciudad: n.ciudad, email: n.email, telefono: n.telefono,
      plan: d.plan_codigo, sector: d.clasificacion.sector && d.clasificacion.sector !== 'otro' ? d.clasificacion.sector : 'barberia',
      admin: { nombre: n.responsable || n.nombre, email: n.email },
      tema: d.tema, logo_data_url: d.logo_data_url, catalogo: d.catalogo, recursos: n.recursos,
    },
    async (e) => { etapas.push({ etapa: e, en: new Date().toISOString() }); },
  );
  await tx.query(
    `UPDATE onboarding_draft SET estado='APROVISIONADO', tenant_id=$2, password_token=$3, etapas=$4, actualizado_en=now() WHERE token=$1`,
    [draftToken, r.tenantId, r.passwordToken, JSON.stringify(etapas)],
  );
  await tx.query(`UPDATE payment SET tenant_id=$2 WHERE draft_token=$1`, [draftToken, r.tenantId]);
  await auditPlatform(tx, r.tenantId, { tipo: 'SISTEMA', id: null, nombre: 'Aprovisionamiento' }, 'WEBHOOK', correlacion, {
    accion: 'tenant.aprovisionar', recurso: 'tenant', recursoId: r.tenantId, resultado: 'EXITO',
    detalle: { plan: d.plan_codigo, sector: d.clasificacion.sector, import_mapping: d.import_mapping, filas_catalogo: d.catalogo?.length ?? 0, recomendacion: d.recomendacion },
  });
  return { tenantId: r.tenantId, slug: r.slug, yaExistia: false };
}
