import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Database, Tx } from '../db/index.js';
import { config } from '../config.js';

/**
 * Borrado total: deja TODAS las tablas de datos vacías, como recién instaladas, en PGlite o en PostgreSQL.
 *
 *  - Las tablas salen del catálogo (pg_tables del esquema public), no de una lista escrita a mano: una tabla
 *    que agregue una migración futura también se vacía.
 *  - Se conserva solo la tabla de control de migraciones (schema_migrations) y el esquema (tablas, políticas,
 *    roles, funciones y disparadores): el servidor arranca sin volver a migrar y repone el catálogo de planes.
 *  - Un único TRUNCATE … RESTART IDENTITY CASCADE en UNA transacción: o se vacía todo o no se toca nada. Los
 *    consecutivos (comprobantes, resoluciones, numeración de pagos) viven en tablas y vuelven a empezar.
 *  - Lo ejecuta el usuario dueño del esquema. Las tablas de auditoría son de solo inserción para los roles de la
 *    aplicación (DD-09): el borrado total es la ÚNICA excepción, explícita, con frase de confirmación y respaldo.
 *  - Sin `aplicar`, la transacción cuenta filas y se revierte: el simulacro no cambia nada.
 *
 * No toca nada fuera de Omnegia: los números siguen registrados en la WABA (no se llama a deregister), y las
 * transacciones de Wompi, los correos enviados y los registros del proveedor de IA quedan como están.
 */
export const FRASE_CONFIRMACION = 'BORRAR TODO';
export const TABLA_MIGRACIONES = 'schema_migrations';

/** Nunca van al respaldo: sesiones, códigos, intentos de acceso y credenciales cifradas. */
const TABLAS_SIN_RESPALDO = new Set(['session', 'otp_code', 'password_reset', 'login_attempt', 'numero_credencial', 'numero_credencial_plataforma']);
/** Columnas que se quitan del respaldo en cualquier tabla: contraseñas, tokens, PIN, secretos y datos cifrados. */
const COLUMNA_SENSIBLE = /(password|contrasena|_hash$|^hash$|token|secret|secreto|^pin$|^pin_|_pin$|cifrad|llave|api_key|codigo_cifrado)/i;

export interface ResultadoBorrado {
  aplicado: boolean;
  base: { motor: 'PostgreSQL' | 'PGlite'; host: string | null; nombre: string };
  tablas: { tabla: string; filas: number }[];
  total: number;
  carpetas: { ruta: string; archivos: number }[];
  respaldo?: Record<string, unknown[]>;
  /** La base quedó vacía pero alguna carpeta no se pudo vaciar (permisos, archivo abierto…). */
  errorCarpetas?: string;
}

export interface OpcionesBorrado {
  aplicar: boolean;
  /** Obligatoria con aplicar: exactamente «BORRAR TODO». */
  confirmacion?: string;
  /** Incluye las filas (sin credenciales) para el archivo de respaldo. */
  conRespaldo?: boolean;
  /** Se llama dentro de la transacción, con el respaldo, ANTES de borrar: si falla, no se borra nada. */
  antesDeBorrar?: (r: ResultadoBorrado) => void | Promise<void>;
  /** Carpetas a vaciar (por defecto, las de la configuración). */
  carpetas?: string[];
}

class Simulacro extends Error { constructor(public resultado: ResultadoBorrado) { super('simulacro'); } }

const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Base que se usaría, sin contraseña. */
export function describirBase(url = config.databaseUrl, dataDir = config.dataDir): ResultadoBorrado['base'] {
  if (!url) return { motor: 'PGlite', host: null, nombre: resolve(dataDir) };
  try {
    const u = new URL(url);
    return { motor: 'PostgreSQL', host: `${u.hostname}${u.port ? `:${u.port}` : ''}`, nombre: decodeURIComponent(u.pathname.replace(/^\//, '')) || '(predeterminada)' };
  } catch {
    return { motor: 'PostgreSQL', host: '(DATABASE_URL no legible)', nombre: '?' };
  }
}

/**
 * Carpetas de archivos que guarda la app: hoy solo el buzón de correos de desarrollo (EMAIL_FAKE_DIR o
 * server/.buzon-dev). Logos, catálogos importados y PDF viven en la base y se vacían con ella. Por seguridad se
 * descarta cualquier ruta fuera de la carpeta del servidor o que apunte al código, a node_modules o a data/.
 */
export function carpetasDeArchivos(raiz = process.cwd()): string[] {
  // El buzón de correos de desarrollo y el almacenamiento de imágenes del catálogo (IMAGENES_DIR).
  const candidatas = [config.correo.buzonLocal, './.buzon-dev', config.imagenes.dir].filter((x): x is string => !!x);
  const protegidas = ['src', 'node_modules', 'data', 'assets', 'scripts', 'test', '.git'].map((p) => resolve(raiz, p));
  return [...new Set(candidatas.map((c) => resolve(raiz, c)))].filter((c) => {
    const rel = relative(raiz, c);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) && !protegidas.some((p) => c === p || c.startsWith(p + '\\') || c.startsWith(p + '/'));
  });
}

function contarArchivos(dir: string): number {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    n += statSync(p).isDirectory() ? contarArchivos(p) : 1;
  }
  return n;
}

/** Vacía el contenido de cada carpeta (la carpeta queda). */
export function vaciarCarpetas(carpetas: string[]) {
  for (const dir of carpetas) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  }
}

export async function tablasDeDatos(tx: Tx): Promise<string[]> {
  return (await tx.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> $1 ORDER BY tablename`, [TABLA_MIGRACIONES])).rows.map((r) => r.tablename as string);
}

export async function borrarTodo(db: Database, o: OpcionesBorrado): Promise<ResultadoBorrado> {
  if (o.aplicar && o.confirmacion !== FRASE_CONFIRMACION) throw new Error(`Sin la frase exacta «${FRASE_CONFIRMACION}» no se borra nada.`);
  const carpetas = o.carpetas ?? carpetasDeArchivos();
  let resultado: ResultadoBorrado;
  try {
    resultado = await db.raw(async (tx) => {
      const yo = (await tx.query(`SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user`)).rows[0];
      if (!yo?.ok) throw new Error('El usuario de la base no puede saltarse la RLS: el borrado total debe correr con el dueño del esquema.');
      const tablas = await tablasDeDatos(tx);
      const conteo: ResultadoBorrado['tablas'] = [];
      for (const t of tablas) conteo.push({ tabla: t, filas: Number((await tx.query(`SELECT count(*)::bigint AS n FROM ${ident(t)}`)).rows[0].n) });
      const r: ResultadoBorrado = {
        aplicado: o.aplicar, base: describirBase(), tablas: conteo, total: conteo.reduce((a, x) => a + x.filas, 0),
        carpetas: carpetas.map((c) => ({ ruta: c, archivos: contarArchivos(c) })),
      };
      if (o.conRespaldo) {
        r.respaldo = {};
        for (const { tabla, filas } of conteo) {
          if (!filas || TABLAS_SIN_RESPALDO.has(tabla)) continue;
          r.respaldo[tabla] = (await tx.query(`SELECT * FROM ${ident(tabla)}`)).rows.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => !COLUMNA_SENSIBLE.test(k))));
        }
      }
      if (!o.aplicar) throw new Simulacro(r);
      await o.antesDeBorrar?.(r);
      if (tablas.length) await tx.query(`TRUNCATE ${tablas.map(ident).join(', ')} RESTART IDENTITY CASCADE`);
      return r;
    });
  } catch (e) {
    if (e instanceof Simulacro) return e.resultado;
    throw e;
  }
  // Los archivos se vacían solo cuando la base ya quedó vacía (la transacción terminó bien).
  try { vaciarCarpetas(carpetas); } catch (e) { resultado.errorCarpetas = (e as Error).message; }
  return resultado;
}

export interface ArgumentosBorrado {
  aplicar: boolean;
  confirmacion: string | null;
  respaldo: string | null;
  sinRespaldo: boolean;
  produccion: boolean;
  conDemo: boolean;
}

/** Valida los argumentos de la consola. Devuelve el error en lenguaje claro o las opciones. */
export function validarArgumentos(args: string[], env: NodeJS.ProcessEnv = process.env): { error: string } | { opciones: ArgumentosBorrado } {
  const valor = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
  const conocidos = new Set(['--aplicar', '--confirmar', '--respaldo', '--sin-respaldo', '--produccion', '--con-demo']);
  const raro = args.find((a, i) => a.startsWith('--') && !conocidos.has(a) && !(i > 0 && ['--confirmar', '--respaldo'].includes(args[i - 1])));
  if (raro) return { error: `Opción desconocida: ${raro}` };
  const o: ArgumentosBorrado = {
    aplicar: args.includes('--aplicar'), confirmacion: valor('confirmar'), respaldo: valor('respaldo'),
    sinRespaldo: args.includes('--sin-respaldo'), produccion: args.includes('--produccion'), conDemo: args.includes('--con-demo'),
  };
  const enProduccion = env.NODE_ENV === 'production';
  if (enProduccion && !o.produccion) return { error: 'NODE_ENV=production: el borrado total exige además --produccion. Revisa dos veces la base que se va a vaciar.' };
  if (o.aplicar && !o.respaldo && !o.sinRespaldo) return { error: 'Con --aplicar indica --respaldo archivo.json (recomendado) o, si de verdad no lo quieres, --sin-respaldo.' };
  if (o.respaldo && o.sinRespaldo) return { error: 'Usa --respaldo o --sin-respaldo, no ambos.' };
  if (o.conDemo && enProduccion) return { error: '--con-demo crea cuentas de demostración con contraseñas conocidas: no se permite en producción.' };
  if (o.conDemo && !o.aplicar) return { error: '--con-demo solo tiene sentido con --aplicar.' };
  return { opciones: o };
}

/** Lo que sigue igual fuera de Omnegia después del borrado. */
export const FUERA_DE_OMNEGIA = [
  'Meta / WhatsApp: los números siguen agregados y registrados en la cuenta de WhatsApp Business de Omnegia (por ejemplo, el +57 322 750 0767 de Patitas del Zulia). No se llamó a deregister. Aparecerán «sin asignar» en el panel del operador › Números de WhatsApp y se reasignan desde ahí.',
  'Wompi: las transacciones y los pagos registrados en la pasarela no se tocan.',
  'Correo transaccional (Resend/SMTP): los correos ya enviados y sus registros siguen en el proveedor.',
  'Proveedor de IA: el historial de uso y facturación del proveedor no cambia.',
  'La configuración: server/.env y las variables de entorno quedan iguales.',
];
