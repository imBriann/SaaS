import { randomBytes } from 'node:crypto';
import type { Database } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { hashPassword, uuidv7 } from '../lib/util.js';

/**
 * Crea o restablece una cuenta del panel del operador (no pertenece a ninguna empresa) con una contraseña temporal
 * aleatoria y cierra sus sesiones abiertas. La usan `npm run operador` y las pruebas del borrado total.
 */
export async function crearOperador(db: Database, o: { email: string; rol: 'ADMIN' | 'SOPORTE'; nombre?: string }) {
  const email = o.email.trim().toLowerCase();
  const nombre = o.nombre ?? (o.rol === 'ADMIN' ? 'Administración Omnegia' : 'Soporte Omnegia');
  const temporal = randomBytes(15).toString('base64url');
  const r = await db.withPlatform(async (tx) => {
    const existente = (await tx.query(`SELECT id FROM users WHERE email=$1`, [email])).rows[0];
    const id = existente?.id ?? uuidv7();
    if (existente) {
      await tx.query(`UPDATE users SET rol_plataforma=$2, es_admin_plataforma=$3, password_hash=$4 WHERE id=$1`, [id, o.rol, o.rol === 'ADMIN', hashPassword(temporal)]);
      await tx.query(`DELETE FROM session WHERE user_id=$1`, [id]);
    } else {
      await tx.query(`INSERT INTO users (id, email, nombre, password_hash, es_admin_plataforma, rol_plataforma) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, email, nombre, hashPassword(temporal), o.rol === 'ADMIN', o.rol]);
    }
    await auditPlatform(tx, null, { tipo: 'SISTEMA', id: null, nombre: 'Consola' }, 'CLI', uuidv7(), {
      accion: existente ? 'operador.restablecer' : 'operador.crear', recurso: 'users', recursoId: id, resultado: 'EXITO', detalle: { rol: o.rol },
    });
    return { creado: !existente, id };
  });
  return { ...r, email, temporal };
}
