import { config } from './config.js';
import { Database } from './db/index.js';
import { buildApp } from './http/app.js';
import { startWorker } from './worker/jobs.js';
import { ensurePlatformCatalog } from './onboarding/provisioning.js';
import { seedDemo } from './seed/demo.js';

const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
const creada = await db.migrate();
await db.withPlatform((tx) => ensurePlatformCatalog(tx));
if (creada && config.dev) {
  const r = await seedDemo(db);
  console.log(`Datos de demostración creados: ${r.slug} (${r.email} / ${r.password})`);
}

const app = await buildApp(db, { logger: false });
const stopWorker = startWorker(db);
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`Servidor en http://localhost:${config.port} · modelo: ${config.llm.provider} (${config.llm.model}) · base: ${config.databaseUrl ? 'PostgreSQL' : 'PGlite ' + config.dataDir}`);

const cerrar = async () => {
  stopWorker();
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
