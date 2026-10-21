import { writeFileSync } from 'node:fs';
import { config } from '../config.js';
import { Database } from '../db/index.js';
import { reiniciarEmpresas } from './reinicio.js';

/**
 * Reinicia la plataforma: borra todas las empresas salvo las de las cuentas indicadas.
 *
 *   npm run reiniciar -- --conservar admin@dominio.com                      (simulacro: no borra nada)
 *   npm run reiniciar -- --conservar admin@dominio.com --aplicar --respaldo archivo.json
 *
 * Sin --aplicar la transacción se ejecuta completa y se revierte. Con --aplicar exige un archivo de
 * respaldo: ahí quedan las filas borradas (sin contraseñas ni sesiones) por si hay que recuperar algo.
 */
const args = process.argv.slice(2);
const valores = (k: string) => args.flatMap((a, i) => (a === `--${k}` && args[i + 1] ? args[i + 1].split(',') : []));
const conservar = valores('conservar');
const aplicar = args.includes('--aplicar');
const respaldo = valores('respaldo')[0];
if (!conservar.length || (aplicar && !respaldo)) {
  console.error('Uso: npm run reiniciar -- --conservar correo[,correo] [--aplicar --respaldo archivo.json] [--permitir-numeros-reales]');
  process.exit(1);
}

const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
try {
  console.log(`Base: ${config.databaseUrl ? 'PostgreSQL (DATABASE_URL)' : `PGlite en ${config.dataDir}`}`);
  const opciones = { conservar, permitirNumerosReales: args.includes('--permitir-numeros-reales') };
  const guardar = (x: Awaited<ReturnType<typeof reiniciarEmpresas>>) =>
    writeFileSync(respaldo!, JSON.stringify({ fecha: new Date().toISOString(), aplicado: x.aplicado, conservadas: x.conservadas, borradas: x.borradas, filas: x.respaldo }, null, 1));
  // El respaldo se escribe ANTES de borrar (con el simulacro) y se reemplaza con lo realmente borrado.
  if (aplicar) guardar(await reiniciarEmpresas(db, { ...opciones, aplicar: false }));
  const r = await reiniciarEmpresas(db, { ...opciones, aplicar });
  console.log(`\nSe conservan ${r.conservadas.length} empresa(s):`);
  for (const t of r.conservadas) console.log(`  ✓ ${t.slug} — ${t.nombre}`);
  console.log(`\n${r.aplicado ? 'Se borraron' : 'Se borrarían'} ${r.borradas.length} empresa(s):`);
  for (const t of r.borradas) console.log(`  ✗ ${t.slug} — ${t.nombre} (creada ${t.creado_en.slice(0, 10)}; ${t.miembros.join(', ') || 'sin personas'})`);
  console.log(`\nCuentas que ${r.aplicado ? 'se borraron' : 'se borrarían'} (${r.cuentasBorradas.length}): ${r.cuentasBorradas.join(', ') || 'ninguna'}`);
  console.log(`Cuentas que se conservan (${r.cuentasConservadas.length}): ${r.cuentasConservadas.join(', ')}`);
  console.log('\nFilas por tabla:');
  for (const [k, n] of Object.entries(r.filas).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${k}`);
  if (r.aplicado) {
    guardar(r);
    console.log(`\nListo. Respaldo de lo borrado en ${respaldo}`);
  } else {
    console.log('\nSimulacro: no se borró nada. Repite con --aplicar --respaldo <archivo> para borrar.');
  }
} catch (e: any) {
  console.error(`\nNo se hizo ningún cambio: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
