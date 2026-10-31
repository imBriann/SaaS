import { config } from '../config.js';
import { Database } from '../db/index.js';
import { crearOperador } from './cuentaOperador.js';

/**
 * Crea o restablece una cuenta del panel del operador (no pertenece a ninguna empresa).
 *
 *   npm run operador -- --email admin@dominio.com [--nombre "Nombre"] [--rol ADMIN|SOPORTE]
 *
 * Genera una contraseña temporal aleatoria que se muestra UNA sola vez en esta consola y
 * cierra las sesiones abiertas de esa cuenta. El acceso exige además el código que llega al
 * correo (segundo factor). Cambia la contraseña al entrar.
 */
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const email = (arg('email') ?? '').trim().toLowerCase();
const rol = (arg('rol') ?? 'ADMIN').toUpperCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !['ADMIN', 'SOPORTE'].includes(rol)) {
  console.error('Uso: npm run operador -- --email admin@dominio.com [--nombre "Nombre"] [--rol ADMIN|SOPORTE]');
  process.exit(1);
}

const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
try {
  const r = await crearOperador(db, { email, rol: rol as 'ADMIN' | 'SOPORTE', nombre: arg('nombre') });
  console.log(`\n${r.creado ? 'Cuenta de operador creada' : 'Cuenta de operador restablecida'}: ${email} (${rol})`);
  console.log(`Contraseña temporal (se muestra solo esta vez): ${r.temporal}`);
  console.log(`Entra en ${config.publicUrl}/entrar · se te pedirá el código enviado a ${email}. Cambia la contraseña después.\n`);
} finally {
  await db.close();
}
