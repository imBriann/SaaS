import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config } from '../config.js';
import { Database } from './index.js';

/**
 * Respaldo y restauración de la base PGlite (desarrollo o instalación de un solo
 * equipo). En PostgreSQL se usan las herramientas del motor: pg_dump / pg_restore.
 *
 *   npm run respaldo -- crear  [archivo.tar.gz]
 *   npm run respaldo -- restaurar archivo.tar.gz   (PGLITE_DIR debe estar vacío o no existir)
 */
const [accion, archivo] = process.argv.slice(2);
if (config.databaseUrl) {
  console.log('Con DATABASE_URL (PostgreSQL) usa:\n  pg_dump --format=custom --no-owner "$DATABASE_URL" > respaldo.dump\n  pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" respaldo.dump');
  process.exit(0);
}
if (accion === 'crear') {
  // Con el servidor apagado: PGlite admite un solo proceso a la vez.
  const db = await Database.open({ dataDir: config.dataDir });
  const datos = await db.respaldoPglite();
  await db.close();
  const destino = archivo ?? `respaldo-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
  writeFileSync(destino, datos);
  console.log(`Respaldo creado: ${destino} (${Math.round(datos.length / 1024)} KB)`);
} else if (accion === 'restaurar' && archivo) {
  if (existsSync(config.dataDir) && readdirSync(config.dataDir).length) {
    console.error(`${config.dataDir} no está vacío. Muévelo o bórralo antes de restaurar (no se sobrescribe nada).`);
    process.exit(1);
  }
  await Database.restaurarPglite(config.dataDir, readFileSync(archivo));
  const db = await Database.open({ dataDir: config.dataDir });
  await db.migrate();
  console.log(`Restaurado en ${config.dataDir}. Migraciones: ${(await db.migrations()).join(', ')}`);
  await db.close();
} else {
  console.log('Uso: npm run respaldo -- crear [archivo] | npm run respaldo -- restaurar <archivo>');
  process.exit(1);
}
