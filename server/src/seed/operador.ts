import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { Database } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { hashPassword, uuidv7 } from '../lib/util.js';

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
const nombre = arg('nombre') ?? (rol === 'ADMIN' ? 'Administración Omnegia' : 'Soporte Omnegia');
const temporal = randomBytes(15).toString('base64url');

const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
try {
  const r = await db.withPlatform(async (tx) => {
    const existente = (await tx.query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0];
    const id = existente?.id ?? uuidv7();
    if (existente) {
      await tx.query(`UPDATE users SET rol_plataforma=$2, es_admin_plataforma=$3, password_hash=$4 WHERE id=$1`, [id, rol, rol === 'ADMIN', hashPassword(temporal)]);
      await tx.query(`DELETE FROM session WHERE user_id=$1`, [id]);
    } else {
      await tx.query(`INSERT INTO users (id, email, nombre, password_hash, es_admin_plataforma, rol_plataforma) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, email, nombre, hashPassword(temporal), rol === 'ADMIN', rol]);
    }
    await auditPlatform(tx, null, { tipo: 'SISTEMA', id: null, nombre: 'Consola' }, 'CLI', uuidv7(), {
      accion: existente ? 'operador.restablecer' : 'operador.crear', recurso: 'users', recursoId: id, resultado: 'EXITO', detalle: { rol },
    });
    return { creado: !existente };
  });
  console.log(`\n${r.creado ? 'Cuenta de operador creada' : 'Cuenta de operador restablecida'}: ${email} (${rol})`);
  console.log(`Contraseña temporal (se muestra solo esta vez): ${temporal}`);
  console.log(`Entra en ${config.publicUrl}/entrar · se te pedirá el código enviado a ${email}. Cambia la contraseña después.\n`);
} finally {
  await db.close();
}
