import type { Tx } from '../db/index.js';
import type { Ctx } from '../core/context.js';
import { DIAS } from '../lib/time.js';
import { cop } from '../lib/util.js';

/**
 * Ficha del negocio que el asistente del panel lleva en su contexto.
 *
 * Solo entra lo que sirve para orientarse y que la persona que pregunta ya puede ver con sus permisos:
 * nombre, actividad, ciudad, plan, módulos, catálogo y horarios de atención. NO entra nada
 * sensible: NIT, correos, teléfonos, datos de clientes, llaves o cuentas de pasarela, configuración del
 * canal ni cifras de ventas o consumo (esas se consultan con herramientas, cada vez y con su recibo).
 */
const MAX_ITEMS = 30;
const MAX_NOMBRE = 60;

const corto = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOMBRE);

/** «lun, mar, mie 09:00–19:00; sab 10:00–14:00»: los días con el mismo horario se agrupan. */
function resumirHorario(horario: Record<string, [string, string] | []> | null): string {
  const grupos = new Map<string, string[]>();
  for (const dia of DIAS) {
    const h = horario?.[dia];
    if (!h || h.length < 2) continue;
    const k = `${h[0]}–${h[1]}`;
    grupos.set(k, [...(grupos.get(k) ?? []), dia]);
  }
  return [...grupos].map(([horas, dias]) => `${dias.join(', ')} ${horas}`).join('; ') || 'sin horario definido';
}

export interface DatosNegocio { nombre: string; ciudad: string | null; plan_codigo: string; zona_horaria: string }

export async function fichaDelNegocio(tx: Tx, ctx: Ctx, permisos: ReadonlySet<string>, t: DatosNegocio, actividad: string | null): Promise<string> {
  const puede = (p: string) => permisos.has('*') || permisos.has(p);
  const lineas: string[] = [];

  const plan = (await tx.query(`SELECT nombre FROM plan WHERE codigo=$1`, [t.plan_codigo])).rows[0]?.nombre ?? t.plan_codigo;
  const modulos = (await tx.query(
    `SELECT m.nombre FROM tenant_module tm JOIN module m ON m.codigo=tm.modulo WHERE tm.activo ORDER BY m.nombre`)).rows.map((r: any) => r.nombre);
  const rol = ctx.roleKey ? (await tx.query(`SELECT nombre FROM role WHERE clave=$1`, [ctx.roleKey])).rows[0]?.nombre : null;

  lineas.push(`Negocio: ${corto(t.nombre)}${actividad ? ` — ${corto(actividad)}` : ''}`);
  if (t.ciudad) lineas.push(`Ciudad: ${corto(t.ciudad)} (zona horaria ${t.zona_horaria})`);
  lineas.push(`Plan: ${corto(plan)}. Módulos activos: ${modulos.join(', ') || 'ninguno'}`);
  lineas.push(`Habla contigo: ${corto(ctx.actor.nombre)}${rol ? `, con el rol «${corto(rol)}»` : ''}`);

  if (puede('catalog:read')) {
    const resumen = (await tx.query(
      `SELECT tipo, count(*)::int AS n FROM product WHERE eliminado_en IS NULL AND activo GROUP BY tipo`)).rows as { tipo: string; n: number }[];
    const servicios = resumen.find((r) => r.tipo === 'SERVICIO')?.n ?? 0;
    const productos = resumen.find((r) => r.tipo === 'PRODUCTO')?.n ?? 0;
    const items = (await tx.query(
      `SELECT nombre, categoria, precio, duracion_min FROM product WHERE eliminado_en IS NULL AND activo ORDER BY categoria NULLS LAST, nombre LIMIT $1`, [MAX_ITEMS])).rows;
    lineas.push(`Catálogo: ${servicios} servicios y ${productos} productos activos${servicios + productos > items.length ? ` (se listan los primeros ${items.length})` : ''}`);
    for (const i of items) {
      lineas.push(`- ${corto(i.nombre)}${i.categoria ? ` [${corto(i.categoria)}]` : ''}: ${cop(Number(i.precio))}${i.duracion_min ? `, ${i.duracion_min} min` : ''}`);
    }
  }

  if (puede('appointment:read')) {
    const recursos = (await tx.query(`SELECT nombre, horario FROM resource WHERE activo ORDER BY nombre LIMIT 20`)).rows;
    if (recursos.length) {
      lineas.push('Agenda (personas o espacios que atienden):');
      for (const r of recursos) lineas.push(`- ${corto(r.nombre)}: ${resumirHorario(r.horario)}`);
    }
  }

  return lineas.join('\n');
}
