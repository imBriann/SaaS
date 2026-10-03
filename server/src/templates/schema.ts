import { z } from 'zod';
import { PERMISOS, PERMISOS_PROHIBIDOS_A_AGENTES, type Permiso } from '../core/permissions.js';

/**
 * Esquema formal de la plantilla de sector (artefacto 12 del paquete documental,
 * PRO-SW-001 §10.2 y Anexo B). Una plantilla NO es código: es un archivo de datos
 * versionado que describe cómo queda configurado un tenant de ese sector.
 */
const permiso = z.string().refine((p) => p in PERMISOS, { message: 'permiso desconocido' });
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);
const dia = z.enum(['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom']);
const horario = z.partialRecord(dia, z.tuple([hhmm, hhmm]));
export const NIVELES_RIESGO = ['lectura', 'reversible', 'confirmable', 'critica'] as const;

export const SectorTemplateSchema = z
  .object({
    sector: z.string().regex(/^[a-z_]+$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    nombre: z.string(),
    descripcion: z.string(),
    modulos: z.array(z.string()).min(1),
    roles: z
      .array(
        z.object({
          clave: z.string().regex(/^[a-z_]+$/),
          nombre: z.string(),
          permisos: z.array(permiso),
          es_agente: z.boolean().default(false),
          es_asesor: z.boolean().default(false),
        }),
      )
      .min(1),
    rol_administrador: z.string(),
    recursos_ejemplo: z.array(z.object({ nombre: z.string(), horario })),
    etiqueta_recurso: z.string(),
    catalogo_ejemplo: z.array(
      z.object({
        tipo: z.enum(['PRODUCTO', 'SERVICIO']),
        nombre: z.string(),
        categoria: z.string(),
        precio: z.number().nonnegative(),
        iva_pct: z.number().min(0).max(19).default(0),
        duracion_min: z.number().int().positive().optional(),
        controla_stock: z.boolean().default(false),
        stock: z.number().default(0),
        stock_minimo: z.number().default(0),
      }),
    ),
    plantillas_mensaje: z.array(
      z.object({ clave: z.string(), categoria: z.enum(['UTILIDAD', 'MARKETING', 'AUTENTICACION']), cuerpo: z.string() }),
    ),
    agentes: z.array(
      z.object({
        configuracion: z.enum(['atencion', 'asistente', 'copiloto']),
        rol: z.string(),
        herramientas: z.array(z.string()),
        prompt_base: z.string(),
      }),
    ),
    /** Solo puede ENDURECER el nivel declarado por la herramienta, nunca rebajarlo. */
    politica_riesgo: z.record(z.string(), z.enum(NIVELES_RIESGO)).default({}),
    widgets_panel: z.array(z.string()),
    reglas_automatizacion: z.array(
      z.object({
        evento: z.string(),
        accion: z.enum(['enviar_plantilla', 'emitir_factura', 'programar_recordatorio', 'notificar_admin', 'crear_tarea']),
        parametros: z.record(z.string(), z.unknown()).default({}),
        condicion: z.record(z.string(), z.unknown()).default({}),
      }),
    ),
    sla_minutos: z.object({ BAJA: z.number(), MEDIA: z.number(), ALTA: z.number(), URGENTE: z.number() }),
    escalamiento: z.object({
      palabras_clave: z.array(z.string()),
      prioridad_por_defecto: z.enum(['BAJA', 'MEDIA', 'ALTA', 'URGENTE']),
    }),
  })
  .superRefine((t, ctx) => {
    const claves = new Set(t.roles.map((r) => r.clave));
    if (!claves.has(t.rol_administrador)) ctx.addIssue({ code: 'custom', message: 'rol_administrador no existe' });
    for (const a of t.agentes) {
      const rol = t.roles.find((r) => r.clave === a.rol);
      if (!rol) ctx.addIssue({ code: 'custom', message: `agente ${a.configuracion}: rol ${a.rol} no existe` });
      else if (!rol.es_agente) ctx.addIssue({ code: 'custom', message: `agente ${a.configuracion}: el rol ${a.rol} no es de agente` });
    }
    for (const r of t.roles.filter((r) => r.es_agente)) {
      const prohibidos = r.permisos.filter((p) => PERMISOS_PROHIBIDOS_A_AGENTES.includes(p as Permiso));
      if (prohibidos.length) ctx.addIssue({ code: 'custom', message: `rol de agente ${r.clave} con permisos prohibidos: ${prohibidos.join(', ')}` });
    }
  });

export type SectorTemplate = z.infer<typeof SectorTemplateSchema>;
