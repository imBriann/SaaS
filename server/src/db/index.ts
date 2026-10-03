import { readFileSync, mkdirSync } from 'node:fs';
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
  close(): Promise<void>;
}

class PgliteEngine implements Engine {
  constructor(private db: PGlite) {}
  transaction<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.transaction(async (t) =>
      fn({ query: async (sql, params) => ({ rows: (await t.query(sql, params as any[])).rows as any[] }) }),
    );
  }
  async exec(sql: string) { await this.db.exec(sql); }
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
  async close() { await this.pool.end(); }
}

// numeric y bigint llegan como texto desde pg; se convierten en los mapeadores.
pg.types.setTypeParser(20, (v) => Number(v));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Database {
  private constructor(private engine: Engine) {}

  static async open(opts: { url?: string; dataDir?: string } = {}): Promise<Database> {
    if (opts.url) {
      return new Database(new PgEngine(new pg.Pool({ connectionString: opts.url, max: 10 })));
    }
    if (opts.dataDir && opts.dataDir !== 'memory://') mkdirSync(opts.dataDir, { recursive: true });
    const db = new PGlite(opts.dataDir && opts.dataDir !== 'memory://' ? opts.dataDir : undefined);
    await db.waitReady;
    return new Database(new PgliteEngine(db));
  }

  async migrate(): Promise<boolean> {
    const done = await this.engine.transaction(async (tx) => {
      const r = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='tenant'`,
      );
      return r.rows[0].n > 0;
    });
    if (done) return false;
    const here = dirname(fileURLToPath(import.meta.url));
    await this.engine.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
    return true;
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

  /** Transacción sin rol ni contexto: solo pruebas de seguridad. */
  raw<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.engine.transaction(fn);
  }

  close() { return this.engine.close(); }
}
