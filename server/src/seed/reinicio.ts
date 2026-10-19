import type { Database, Tx } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { uuidv7 } from '../lib/util.js';

/**
 * Reinicio de la plataforma: borra todas las empresas salvo las de las cuentas que se conservan,
 * con sus datos, y las cuentas que quedan sin ninguna empresa. Las cuentas del operador de Omnegia
 * no se tocan.
 *
 * Todo ocurre en UNA transacción con el usuario dueño del esquema (las tablas tienen RLS forzada y
 * algunas son de solo inserción para los roles de la aplicación). Sin `aplicar`, la transacción se
 * ejecuta completa y se revierte: el simulacro cuenta exactamente lo que se borraría.
 *
 * Las tablas se descubren en el catálogo: toda tabla con `tenant_id`, toda columna que apunte a
 * `tenant(id)` y toda columna que apunte a `users(id)` (opcional → se deja en NULL; obligatoria → se
 * borra la fila). El orden lo resuelve la propia base: una sentencia que choca con una llave foránea
 * se reintenta después de las demás.
 */
export interface OpcionesReinicio {
  /** Correos cuyas empresas se conservan (y las propias cuentas). */
  conservar: string[];
  aplicar: boolean;
  /** Borrar aunque una empresa tenga un número telefónico real contratado y vigente. */
  permitirNumerosReales?: boolean;
  correlacion?: string;
}

export interface ResultadoReinicio {
  aplicado: boolean;
  conservadas: { slug: string; nombre: string }[];
  borradas: { slug: string; nombre: string; creado_en: string; miembros: string[] }[];
  cuentasConservadas: string[];
  cuentasBorradas: string[];
  filas: Record<string, number>;
  respaldo: Record<string, unknown[]>;
}

class Simulacro extends Error {
  constructor(public resultado: ResultadoReinicio) { super('simulacro'); }
}

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

interface Sentencia { clave: string; sql: string; params: unknown[]; respaldar: boolean }

async function ejecutarEnOrden(tx: Tx, sentencias: Sentencia[], filas: Record<string, number>, respaldo: Record<string, unknown[]>) {
  let pendientes = sentencias;
  let ultimoError = '';
  while (pendientes.length) {
    const siguen: Sentencia[] = [];
    for (const s of pendientes) {
      await tx.query('SAVEPOINT reinicio');
      try {
        const rows = (await tx.query(s.sql, s.params)).rows;
        await tx.query('RELEASE SAVEPOINT reinicio');
        filas[s.clave] = (filas[s.clave] ?? 0) + rows.length;
        if (s.respaldar && rows.length) (respaldo[s.clave] ??= []).push(...rows);
      } catch (e: any) {
        await tx.query('ROLLBACK TO SAVEPOINT reinicio');
        // 23503: otra fila todavía apunta a esta; se reintenta cuando se hayan borrado las demás.
        if (e?.code !== '23503') throw e;
        ultimoError = e.message;
        siguen.push(s);
      }
    }
    if (siguen.length === pendientes.length) throw new Error(`No se pudo resolver el orden de borrado: ${ultimoError}`);
    pendientes = siguen;
  }
}

export async function reiniciarEmpresas(db: Database, o: OpcionesReinicio): Promise<ResultadoReinicio> {
  const correos = [...new Set(o.conservar.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  if (!correos.length) throw new Error('Indica al menos una cuenta que se conserva (--conservar correo).');
  try {
    return await db.raw(async (tx) => {
      const yo = (await tx.query(`SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`)).rows[0];
      if (!yo?.ok) throw new Error('El usuario de la base no puede saltarse la RLS: el reinicio debe correr con el dueño del esquema.');

      const cuentas = (await tx.query(`SELECT id, email FROM users WHERE email = ANY($1)`, [correos])).rows;
      const faltan = correos.filter((c) => !cuentas.some((u) => u.email === c));
      if (faltan.length) throw new Error(`No existe la cuenta ${faltan.join(', ')}. No se borra nada.`);
      const idsConservar = cuentas.map((u) => u.id);

      // La columna del propietario llega con la migración 019; antes de aplicarla basta la pertenencia.
      const conPropietario = (await tx.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant' AND column_name='propietario_id'`)).rows.length > 0;
      const conservadas = (await tx.query(
        `SELECT id, slug, nombre FROM tenant t WHERE ${conPropietario ? 't.propietario_id = ANY($1) OR' : ''}
            EXISTS (SELECT 1 FROM user_tenant ut WHERE ut.tenant_id = t.id AND ut.user_id = ANY($1)) ORDER BY nombre`, [idsConservar])).rows;
      const idsEmpresasConservar = conservadas.map((t) => t.id);
      const borradas = (await tx.query(
        `SELECT t.id, t.slug, t.nombre, t.creado_en,
                coalesce((SELECT array_agg(u.email ORDER BY u.email) FROM user_tenant ut JOIN users u ON u.id = ut.user_id WHERE ut.tenant_id = t.id), '{}') AS miembros
         FROM tenant t WHERE NOT (t.id = ANY($1)) ORDER BY t.creado_en`, [idsEmpresasConservar])).rows;
      const idsBorrar = borradas.map((t) => t.id);

      // Un número real contratado sigue facturándose en el proveedor aunque se borre la empresa.
      const hayNumeros = (await tx.query(`SELECT to_regclass('public.numero_contratacion') IS NOT NULL AS ok`)).rows[0].ok;
      if (hayNumeros && !o.permitirNumerosReales) {
        const vivos = (await tx.query(
          `SELECT t.slug, n.numero_e164, n.estado FROM numero_contratacion n JOIN tenant t ON t.id = n.tenant_id
           WHERE n.tenant_id = ANY($1) AND n.entorno = 'real' AND n.estado <> 'CANCELADO'`, [idsBorrar])).rows;
        if (vivos.length) throw new Error(`Hay números reales vigentes (${vivos.map((v) => `${v.slug}: ${v.numero_e164} ${v.estado}`).join('; ')}). Cancélalos en el proveedor o usa --permitir-numeros-reales.`);
      }

      const cuentasBorrar = (await tx.query(
        `SELECT id, email FROM users u WHERE u.rol_plataforma IS NULL AND NOT u.es_admin_plataforma AND NOT (u.id = ANY($1))
           AND NOT EXISTS (SELECT 1 FROM user_tenant ut WHERE ut.user_id = u.id AND ut.tenant_id = ANY($2)) ORDER BY email`,
        [idsConservar, idsEmpresasConservar])).rows;
      const idsCuentas = cuentasBorrar.map((u) => u.id);
      const cuentasConservadas = (await tx.query(`SELECT email FROM users WHERE NOT (id = ANY($1)) ORDER BY email`, [idsCuentas])).rows.map((u) => u.email);

      // Sentencias descubiertas en el catálogo.
      const conTenant = (await tx.query(
        `SELECT c.table_name AS tabla FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
         WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'tenant'
         ORDER BY 1`)).rows.map((r) => r.tabla as string);
      const llaves = (await tx.query(
        `SELECT cl.relname AS tabla, a.attname AS columna, ref.relname AS destino, a.attnotnull AS obligatoria
         FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_namespace ns ON ns.oid = cl.relnamespace
         JOIN pg_class ref ON ref.oid = k.confrelid JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
         WHERE k.contype = 'f' AND ns.nspname = 'public' AND ref.relname IN ('tenant', 'users') AND array_length(k.conkey, 1) = 1`)).rows;

      const sentencias: Sentencia[] = [];
      for (const tabla of conTenant) {
        sentencias.push({ clave: tabla, sql: `DELETE FROM ${ident(tabla)} WHERE tenant_id = ANY($1::uuid[]) RETURNING *`, params: [idsBorrar], respaldar: true });
      }
      for (const k of llaves) {
        if (k.destino === 'tenant' && k.columna !== 'tenant_id') {
          sentencias.push({ clave: k.tabla, sql: `DELETE FROM ${ident(k.tabla)} WHERE ${ident(k.columna)} = ANY($1::uuid[]) RETURNING *`, params: [idsBorrar], respaldar: true });
        }
        if (k.destino === 'users') {
          sentencias.push(k.obligatoria
            ? { clave: k.tabla, sql: `DELETE FROM ${ident(k.tabla)} WHERE ${ident(k.columna)} = ANY($1::uuid[]) RETURNING *`, params: [idsCuentas], respaldar: k.tabla !== 'session' && k.tabla !== 'otp_code' && k.tabla !== 'password_reset' }
            : { clave: `${k.tabla}.${k.columna}=NULL`, sql: `UPDATE ${ident(k.tabla)} SET ${ident(k.columna)} = NULL WHERE ${ident(k.columna)} = ANY($1::uuid[]) RETURNING 1`, params: [idsCuentas], respaldar: false });
        }
      }
      sentencias.push({ clave: 'tenant', sql: `DELETE FROM tenant WHERE id = ANY($1::uuid[]) RETURNING *`, params: [idsBorrar], respaldar: true });
      // Las credenciales no se guardan en el respaldo.
      sentencias.push({ clave: 'users', sql: `DELETE FROM users WHERE id = ANY($1::uuid[]) RETURNING id, email, nombre, creado_en`, params: [idsCuentas], respaldar: true });

      const filas: Record<string, number> = {};
      const respaldo: Record<string, unknown[]> = {};
      await ejecutarEnOrden(tx, sentencias, filas, respaldo);
      for (const k of Object.keys(filas)) if (!filas[k]) delete filas[k];

      const resultado: ResultadoReinicio = {
        aplicado: o.aplicar,
        conservadas: conservadas.map(({ slug, nombre }) => ({ slug, nombre })),
        borradas: borradas.map(({ slug, nombre, creado_en, miembros }) => ({ slug, nombre, creado_en: new Date(creado_en).toISOString(), miembros })),
        cuentasConservadas, cuentasBorradas: cuentasBorrar.map((u) => u.email), filas, respaldo,
      };
      if (!o.aplicar) throw new Simulacro(resultado);
      await auditPlatform(tx, null, { tipo: 'SISTEMA', id: null, nombre: 'Consola' }, 'CLI', o.correlacion ?? uuidv7(), {
        accion: 'plataforma.reinicio', resultado: 'EXITO',
        detalle: { empresas_borradas: borradas.length, cuentas_borradas: idsCuentas.length, conservadas: resultado.conservadas.map((t) => t.slug) },
      });
      return resultado;
    });
  } catch (e) {
    if (e instanceof Simulacro) return e.resultado;
    throw e;
  }
}
