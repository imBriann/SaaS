import { config } from '../config.js';
import { Database } from './index.js';
import { ensurePlatformCatalog } from '../onboarding/provisioning.js';

/** Aplica las migraciones pendientes y el catálogo de planes y plantillas. No carga datos de demostración. */
const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
try {
  const nueva = await db.migrate();
  await db.withPlatform((tx) => ensurePlatformCatalog(tx));
  console.log(`${nueva ? 'Base creada' : 'Base actualizada'}. Migraciones aplicadas: ${(await db.migrations()).join(', ')}`);
} finally {
  await db.close();
}
