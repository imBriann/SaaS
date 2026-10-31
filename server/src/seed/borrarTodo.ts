import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { config } from '../config.js';
import { Database } from '../db/index.js';
import { ensurePlatformCatalog } from '../onboarding/provisioning.js';
import { seedDemo } from './demo.js';
import { borrarTodo, describirBase, FRASE_CONFIRMACION, FUERA_DE_OMNEGIA, validarArgumentos, type ResultadoBorrado } from './borrado.js';

/**
 * Deja Omnegia en blanco: TODAS las tablas de datos vacías (empresas, cuentas, ventas, comprobantes,
 * conversaciones, números, auditoría…) y las carpetas de archivos de la app vacías. Conserva el esquema y
 * la tabla de migraciones. Irreversible.
 *
 *   npm run borrar-todo                                              simulacro: muestra qué borraría
 *   npm run borrar-todo -- --aplicar --respaldo respaldo.json        pide escribir BORRAR TODO
 *   npm run borrar-todo -- --aplicar --respaldo r.json --confirmar "BORRAR TODO"   (scripts)
 *   npm run borrar-todo -- --aplicar --sin-respaldo [--con-demo]
 *   NODE_ENV=production … exige además --produccion (y no admite --con-demo)
 *
 * Con PGlite, apaga antes el servidor (PGlite admite un solo proceso a la vez).
 */
const v = validarArgumentos(process.argv.slice(2));
if ('error' in v) {
  console.error(`${v.error}\n\nUso: npm run borrar-todo [-- --aplicar (--respaldo archivo.json | --sin-respaldo) [--confirmar "${FRASE_CONFIRMACION}"] [--con-demo] [--produccion]]`);
  process.exit(1);
}
const o = v.opciones;
const base = describirBase();

function mostrar(r: ResultadoBorrado) {
  console.log(`\nBase de datos: ${base.motor}${base.host ? ` en ${base.host}` : ''} · ${base.nombre}`);
  console.log(`\nFilas por tabla (${r.tablas.length} tablas de datos; se conserva ${'schema_migrations'}):`);
  for (const t of [...r.tablas].sort((a, b) => b.filas - a.filas)) if (t.filas) console.log(`  ${String(t.filas).padStart(7)}  ${t.tabla}`);
  const vacias = r.tablas.filter((t) => !t.filas).length;
  if (vacias) console.log(`  (${vacias} tablas ya están vacías)`);
  console.log(`  Total: ${r.total} filas`);
  console.log('\nCarpetas de archivos que se vaciarían:');
  if (!r.carpetas.length) console.log('  ninguna');
  for (const c of r.carpetas) console.log(`  ${c.ruta} (${c.archivos} archivos)`);
}

async function confirmar(): Promise<boolean> {
  if (o.confirmacion !== null) return o.confirmacion === FRASE_CONFIRMACION;
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const t = await rl.question(`\nEsto borra TODO y no se puede deshacer. Escribe ${FRASE_CONFIRMACION} para continuar: `);
    return t.trim() === FRASE_CONFIRMACION;
  } finally { rl.close(); }
}

const db = await Database.open({ url: config.databaseUrl, dataDir: config.dataDir });
let codigo = 0;
try {
  if (process.env.NODE_ENV === 'production') console.log(`\n⚠ PRODUCCIÓN · ${base.motor} ${base.host ?? ''} · base «${base.nombre}»`);
  const simulacro = await borrarTodo(db, { aplicar: false });
  mostrar(simulacro);
  if (!o.aplicar) {
    console.log('\nSimulacro: no se borró nada. Repite con --aplicar --respaldo <archivo.json> para borrar.');
  } else if (!(await confirmar())) {
    console.log(`\nCancelado: no se escribió exactamente «${FRASE_CONFIRMACION}». No se borró nada.`);
    codigo = 1;
  } else {
    const r = await borrarTodo(db, {
      aplicar: true, confirmacion: FRASE_CONFIRMACION, conRespaldo: !!o.respaldo,
      // El respaldo se escribe dentro de la transacción, antes del TRUNCATE: si no se puede escribir, no se borra nada.
      antesDeBorrar: (x) => {
        if (!o.respaldo) return;
        writeFileSync(o.respaldo, JSON.stringify({ fecha: new Date().toISOString(), base: x.base, tablas: x.tablas, filas: x.respaldo, nota: 'Sin contraseñas, tokens, PIN, códigos ni sesiones.' }, null, 1));
      },
    });
    console.log(`\nListo: se vaciaron ${r.tablas.length} tablas (${r.total} filas) y ${r.carpetas.length} carpeta(s) de archivos.${o.respaldo ? ` Respaldo en ${o.respaldo}.` : ''}`);
    if (r.errorCarpetas) { console.error(`La base quedó vacía, pero una carpeta no se pudo vaciar: ${r.errorCarpetas}. Bórrala a mano.`); codigo = 1; }
    if (o.conDemo) {
      try {
        await db.withPlatform((tx) => ensurePlatformCatalog(tx));
        const d = await seedDemo(db);
        console.log(`Datos de demostración creados: ${d.slug} (${d.email} / ${d.password}).`);
      } catch (e: any) {
        console.error(`La base quedó vacía, pero la demostración no se pudo cargar: ${e.message}. Ejecuta npm run seed.`);
        codigo = 1;
      }
    }
    console.log('\nLo que NO se borró (sigue igual fuera de Omnegia):');
    for (const l of FUERA_DE_OMNEGIA) console.log(`  · ${l}`);
    console.log('\nSiguiente paso: crea la cuenta del operador con `npm run operador -- --email tu@correo` (sin ella nadie entra al panel de plataforma).');
    console.log('Al arrancar, el servidor repone el catálogo de planes y plantillas.');
  }
} catch (e: any) {
  console.error(`\nNo se borró nada: ${e.message}`);
  codigo = 1;
} finally {
  await db.close();
}
process.exit(codigo);
