import { config, integraciones, validarConfiguracion } from './config.js';
import { Database } from './db/index.js';
import { buildApp } from './http/app.js';
import { startWorker } from './worker/jobs.js';
import { ensurePlatformCatalog } from './onboarding/provisioning.js';
import { seedDemo } from './seed/demo.js';
import { MARCA } from './brand.js';
import { iniciarVolcadoMetricas } from './core/metricas.js';

const { errores, avisos } = validarConfiguracion();
for (const a of avisos) console.warn(`[configuración] ${a}`);
if (errores.length) {
  for (const e of errores) console.error(`[configuración] ${e}`);
  if (!config.dev) {
    console.error('El servidor no arranca con la configuración incompleta. Revisa server/.env (ver README › Variables de entorno).');
    process.exit(1);
  }
}

const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
const creada = await db.migrate();
await db.withPlatform((tx) => ensurePlatformCatalog(tx));
// Los datos de demostración solo se cargan solos en desarrollo y sobre una base nueva.
if (creada && config.dev && process.env.SIN_DEMO !== '1') {
  const r = await seedDemo(db);
  console.log(`Datos de demostración creados: ${r.slug} (${r.email})`);
}

const app = await buildApp(db);
const stopWorker = process.env.SIN_TRABAJADOR === '1' ? async () => {} : startWorker(db);
const stopMetricas = iniciarVolcadoMetricas(db);
await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`${MARCA.nombre} en http://localhost:${config.port} · base: ${config.databaseUrl ? 'PostgreSQL' : 'PGlite ' + config.dataDir} · ${config.dev ? 'desarrollo' : 'producción'}`);
for (const i of integraciones()) console.log(`  · ${i.nombre}: ${i.estado === 'conectado' ? 'conectado' : i.estado === 'simulado' ? 'SIMULADO' : 'PENDIENTE DE CONECTAR'} — ${i.detalle}`);

// Apagado ordenado: deja de aceptar peticiones, espera la ronda del trabajador y cierra la base.
let cerrando = false;
const cerrar = async (senal: string) => {
  if (cerrando) return;
  cerrando = true;
  console.log(`Recibido ${senal}: cerrando…`);
  const limite = setTimeout(() => { console.error('El cierre tardó demasiado; se fuerza la salida.'); process.exit(1); }, 15_000);
  try {
    await app.close();
    await stopWorker();
    await stopMetricas();
    await db.close();
  } finally {
    clearTimeout(limite);
    process.exit(0);
  }
};
process.on('SIGINT', () => void cerrar('SIGINT'));
process.on('SIGTERM', () => void cerrar('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('[proceso] promesa rechazada sin manejar:', (e as Error)?.message ?? e));
