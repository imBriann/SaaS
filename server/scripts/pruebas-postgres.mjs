// Ejecuta las pruebas críticas (aislamiento, acceso entre empresas, migraciones y
// concurrencia) contra un PostgreSQL REAL. Sin DATABASE_URL_PRUEBAS levanta uno
// temporal con embedded-postgres (binarios oficiales); con ella, usa ese servidor
// (en CI, un contenedor postgres:16). La base de pruebas se recrea en cada archivo.
//
// Uso: npm run test:postgres
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ARCHIVOS = process.env.ARCHIVOS ? process.env.ARCHIVOS.split(',') : ['test/isolation.test.ts', 'test/acceso.test.ts', 'test/postgres.test.ts', 'test/negocio.test.ts', 'test/canal.test.ts', 'test/correo.test.ts', 'test/operador.test.ts', 'test/institucional.test.ts', 'test/pagos.test.ts', 'test/documentos.test.ts'];

let url = process.env.DATABASE_URL_PRUEBAS;
let detener = async () => {};
if (!url) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dir = mkdtempSync(join(tmpdir(), 'pg-pruebas-'));
  const port = 54329 + Math.floor(Math.random() * 500);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {} });
  console.log(`Iniciando PostgreSQL real en el puerto ${port}…`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pruebas');
  url = `postgres://postgres:postgres@localhost:${port}/pruebas`;
  detener = async () => { await pg.stop(); rmSync(dir, { recursive: true, force: true }); };
}

const codigo = await new Promise((resolve) => {
  const p = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vitest', 'run', ...ARCHIVOS], {
    stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, DATABASE_URL_PRUEBAS: url },
  });
  p.on('exit', (c) => resolve(c ?? 1));
});
await detener();
process.exit(codigo);
