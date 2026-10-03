import { rmSync } from 'node:fs';
import { config } from '../config.js';
import { Database } from '../db/index.js';
import { seedDemo } from './demo.js';

/** Reinicia la base local (PGlite) y carga los datos de demostración. */
if (process.argv.includes('--reset')) {
  if (config.databaseUrl) {
    console.error('--reset solo aplica a la base local PGlite. Para PostgreSQL, recrea la base manualmente.');
    process.exit(1);
  }
  rmSync(config.dataDir, { recursive: true, force: true });
}
const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
if (!(await db.migrate())) {
  console.log('La base ya existe. Usa «npm run reset» para empezar de cero.');
} else {
  const r = await seedDemo(db);
  console.log(`Listo. Entra a http://${r.slug}.localhost:5173 con ${r.email} / ${r.password}`);
}
await db.close();
