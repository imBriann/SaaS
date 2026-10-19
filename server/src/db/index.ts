import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

/**
 * Capa de acceso a datos.
 *
 * Dos únicas puertas de entrada, ambas transaccionales:
 *   - withTenant(tenantId, fn): SET LOCAL ROLE app_rt + SET LOCAL app.tenant_id.
 *     Toda consulta de negocio pasa por aquí; la RLS (barrera 2) actúa aunque
 *     el código olvide un filtro por tenant_id.
 *   - withPlatform(fn): SET LOCAL ROLE app_platform (BYPASSRLS). Reservada a
 *     resolución de tenant, autenticación, aprovisionamiento y cola de trabajos.
 *
 * El motor puede ser PostgreSQL real (DATABASE_URL) o PGlite (Postgres en WASM)
 * para desarrollo y pruebas. Ambos ejecutan el mismo SQL y las mismas políticas.
 */

export interface Tx {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

interface Engine {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  /** Ejecuta un script de varias sentencias dentro de UNA transacción (migraciones). */
  execAtomic(sql: string): Promise<void>;
  close(): Promise<void>;
}

class PgliteEngine implements Engine {
  constructor(public db: PGlite) {}
  transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (t) =>
      fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params as any[])).rows as any[] }) }),
    );
  }
  async exec(sql: string) { await this.db.exec(sql); }
  async execAtomic(sql: string) { await this.db.transaction(async (t) => { await t.exec(sql); }); }
  async close() { await this.db.close(); }
}

class PgEngine implements Engine {
  constructor(private pool: pg.Pool) {}
  async transaction<T>(fn: (tx: Tx) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn({ query: async (sql, params) => ({ rows: (await client.query(sql, params as any[])).rows }) });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async exec(sql: string) { await this.pool.query(sql); }
  async execAtomic(sql: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async close() { await this.pool.end(); }
}

// numeric y bigint llegan como texto desde pg; se convierten en los mapeadores.
pg.types.setTypeParser(20, (v) => Number(v));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Database {
  private constructor(private engine: Engine) {}

  static async open(opts: { url?: string; dataDir?: string } = {}): Promise<Database> {
    if (opts.url) {
      const pool = new pg.Pool({ connectionString: opts.url, max: Number(process.env.DATABASE_POOL_MAX ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
      // Un error en un cliente inactivo no debe tumbar el proceso.
      pool.on('error', (e) => console.error('[base] conexión inactiva con error:', e.message));
      return new Database(new PgEngine(pool));
    }
    if (opts.dataDir && opts.dataDir !== 'memory://') mkdirSync(opts.dataDir, { recursive: true });
    const db = new PGlite(opts.dataDir && opts.dataDir !== 'memory://' ? opts.dataDir : undefined);
    await db.waitReady;
    return new Database(new PgliteEngine(db));
  }

  /**
   * Migraciones versionadas (db/migrations/NNN_nombre.sql), cada una en su propia
   * transacción y registrada en schema_migrations. Devuelve true si la base se creó
   * en esta ejecución (sirve para decidir si se cargan datos de demostración).
   */
  async migrate(): Promise<boolean> {
    // Nombres, mensajes y emojis de WhatsApp exigen UTF-8 en la base.
    const enc = await this.engine.transaction(async (tx) => (await tx.query<{ e: string }>(`SELECT pg_encoding_to_char(encoding) AS e FROM pg_database WHERE datname = current_database()`)).rows[0]?.e);
    if (enc && enc !== 'UTF8') throw new Error(`La base de datos usa la codificación ${enc}; debe ser UTF8. Créala con: CREATE DATABASE nombre ENCODING 'UTF8' TEMPLATE template0;`);
    await this.engine.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, aplicada_en timestamptz NOT NULL DEFAULT now())`);
    const estado = await this.engine.transaction(async (tx) => ({
      base: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='tenant'`)).rows[0].n > 0,
      aplicadas: new Set((await tx.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version)),
    }));
    // Bases creadas antes de existir el registro: el esquema base ya está aplicado.
    if (estado.base && !estado.aplicadas.has('001_base')) {
      await this.engine.exec(`INSERT INTO schema_migrations (version) VALUES ('001_base') ON CONFLICT DO NOTHING`);
      estado.aplicadas.add('001_base');
    }
    const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
    const archivos = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
    for (const f of archivos) {
      const version = f.replace(/\.sql$/, '');
      if (estado.aplicadas.has(version)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await this.engine.execAtomic(`${sql}
;INSERT INTO schema_migrations (version) VALUES ('${version}');`);
    }
    return !estado.base;
  }

  /** Versiones aplicadas (comprobación de salud y pruebas). */
  async migrations(): Promise<string[]> {
    return this.engine.transaction(async (tx) => (await tx.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map((r) => r.version));
  }

  /** Comprobación de disponibilidad de la base (readiness). */
  async ping(): Promise<boolean> {
    try { await this.engine.transaction((tx) => tx.query('SELECT 1')); return true; } catch { return false; }
  }

  /** Transacción con contexto de tenant validado. Sujeta a RLS. */
  withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(tenantId)) throw new Error('withTenant: tenant_id inválido');
    return this.engine.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_rt');
      // set_config con is_local = true equivale a SET LOCAL y admite parámetros.
      await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      return fn(tx);
    });
  }

  /** Transacción de plataforma. BYPASSRLS: usar solo donde no existe contexto de tenant. */
  withPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.engine.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_platform');
      return fn(tx);
    });
  }

  /**
   * Transacción del panel del operador de Omnegia (rol app_operador): sin BYPASSRLS
   * y con privilegios por columna. Una consulta a datos privados de un negocio
   * falla con «permission denied» aunque el código la intente.
   */
  withOperador<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.engine.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_operador');
      return fn(tx);
    });
  }

  /**
   * Lectura de soporte autorizada por una empresa (rol app_soporte): sin BYPASSRLS y con políticas que
   * exigen un acceso vigente (acceso_soporte) para cada fila. Sin autorización, la consulta no devuelve nada.
   */
  withSoporte<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.engine.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE app_soporte');
      return fn(tx);
    });
  }

  /** Script de varias sentencias sin parámetros (mantenimiento y pruebas). */
  execScript(sql: string): Promise<void> {
    return this.engine.exec(sql);
  }

  /** Transacción sin rol ni contexto: pruebas de seguridad y la consola de reinicio (dueño del esquema). */
  raw<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.engine.transaction(fn);
  }

  /** Copia completa de una base PGlite (tar.gz). En PostgreSQL se usa pg_dump. */
  async respaldoPglite(): Promise<Buffer> {
    if (!(this.engine instanceof PgliteEngine)) throw new Error('El respaldo integrado solo aplica a PGlite; en PostgreSQL usa pg_dump (ver README).');
    const blob = await this.engine.db.dumpDataDir('gzip');
    return Buffer.from(await blob.arrayBuffer());
  }

  /** Crea una base PGlite en dataDir a partir de un respaldo (el directorio debe estar vacío). */
  static async restaurarPglite(dataDir: string, respaldo: Buffer): Promise<void> {
    mkdirSync(dataDir, { recursive: true });
    const db = new PGlite(dataDir, { loadDataDir: new Blob([new Uint8Array(respaldo)]) });
    await db.waitReady;
    await db.close();
  }

  close() { return this.engine.close(); }
}
