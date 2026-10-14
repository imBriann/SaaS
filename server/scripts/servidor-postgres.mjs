// Arranca el servidor contra un PostgreSQL real temporal (embedded-postgres) con datos
// de demostración. Sirve para medir con el motor de producción en una máquina sin PostgreSQL.
// Uso: node scripts/servidor-postgres.mjs   (Ctrl+C detiene ambos)
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { default: EmbeddedPostgres } = await import('embedded-postgres');
const dir = mkdtempSync(join(tmpdir(), 'pg-servidor-'));
const port = 55432;
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
await pg.initialise();
await pg.start();
await pg.createDatabase('omnegia');
console.log(`PostgreSQL temporal en el puerto ${port}`);
const srv = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/main.ts'], { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, DATABASE_URL: `postgres://postgres:postgres@localhost:${port}/omnegia`, LLM_PROVIDER: 'mock' } });
const parar = async () => { srv.kill(); await pg.stop(); rmSync(dir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', parar);
srv.on('exit', parar);
