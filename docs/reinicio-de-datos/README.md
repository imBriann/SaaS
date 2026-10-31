# Reiniciar los datos: `reset`, `reiniciar` y `borrar-todo`

Actualizado el 30 de octubre de 2026. Los tres comandos se ejecutan dentro de `server/` (`npm run <comando> -- <opciones>`).

| Comando | Qué hace | Base | Cuándo usarlo |
|---|---|---|---|
| `npm run reset` | Borra la carpeta de PGlite (`PGLITE_DIR`), migra y carga la demostración. | Solo PGlite local. Con `DATABASE_URL` se niega. | Desarrollo: volver al estado de demostración en tu equipo. |
| `npm run reiniciar -- --conservar correo` | Borra todas las empresas **salvo** las de las cuentas indicadas, con sus datos y las cuentas que quedan sin empresa. Las cuentas del operador no se tocan. Simulacro por defecto; `--aplicar --respaldo archivo.json` para borrar. | PGlite y PostgreSQL | Limpiar empresas de prueba conservando la tuya y el operador. |
| `npm run borrar-todo` | Deja **todas** las tablas de datos vacías, como recién instaladas, y vacía las carpetas de archivos de la app. Conserva el esquema y la tabla de migraciones. | PGlite y PostgreSQL | Empezar de cero de verdad: sin empresas, sin cuentas (tampoco del operador), sin auditoría. Irreversible. |

## `borrar-todo` en detalle

```bash
cd server
npm run borrar-todo                                                    # simulacro: no borra nada
npm run borrar-todo -- --aplicar --respaldo respaldo-2026-10-30.json   # pide escribir BORRAR TODO
npm run borrar-todo -- --aplicar --respaldo r.json --confirmar "BORRAR TODO"   # para scripts
npm run borrar-todo -- --aplicar --sin-respaldo --con-demo             # vacía y carga la demostración
NODE_ENV=production npm run borrar-todo -- --produccion                # en producción, además --produccion
```

Con PGlite, **apaga antes el servidor** (PGlite admite un solo proceso a la vez).

**Qué borra.** Todas las tablas del esquema `public` salvo `schema_migrations`: empresas, usuarios, sesiones, clientes, catálogo, ventas, pagos, comprobantes, documentos fiscales, conversaciones, mensajes, agenda, números, credenciales, eventos, cola de trabajos, incidentes, uso, auditoría, avisos… La lista sale del catálogo (`pg_tables`), no de una lista escrita a mano: una tabla que agregue una migración futura también se vacía. Un solo `TRUNCATE … RESTART IDENTITY CASCADE` en una transacción, con el usuario dueño del esquema. Los consecutivos (comprobantes, resoluciones, numeración de pagos) viven en tablas y vuelven a empezar. También vacía la carpeta de correos de desarrollo (`EMAIL_FAKE_DIR` o `server/.buzon-dev/`): es la única carpeta de archivos que usa la app, porque logos, catálogos importados y PDF se guardan en la base. Nunca toca `node_modules`, el código, `.env` ni `data/`.

**Seguridad.**
1. Simulacro por defecto: muestra la base (motor, host y nombre, sin contraseña), las filas por tabla y las carpetas que vaciaría.
2. Con `--aplicar` hay que escribir exactamente `BORRAR TODO` (o pasar `--confirmar "BORRAR TODO"`). Cualquier otra cosa cancela.
3. Con `--aplicar` exige `--respaldo archivo.json` o `--sin-respaldo` explícito. El respaldo se escribe dentro de la transacción, antes del `TRUNCATE`: si no se puede escribir, no se borra nada. No lleva contraseñas, tokens, PIN, códigos ni sesiones (se omiten esas tablas y columnas).
4. Con `NODE_ENV=production` exige además `--produccion` y no admite `--con-demo`.
5. Si algo falla a mitad, la transacción se revierte entera y el mensaje dice «No se borró nada».

**Auditoría (DD-09).** Las tablas de auditoría son de solo inserción para los roles de la aplicación. El borrado total es la **única excepción**: explícita, con frase de confirmación y respaldo, y la ejecuta el dueño del esquema desde la consola. No deja una fila de auditoría porque el resultado debe ser una base vacía; el respaldo y la salida de la consola son la evidencia.

**Lo que NO borra** (y lo repite al terminar):
- **Meta / WhatsApp:** los números siguen agregados y registrados en la WABA de Omnegia (por ejemplo, el +57 322 750 0767 de Patitas del Zulia). No se llama a `deregister`. Después del borrado aparecen «sin asignar» en el panel del operador › Números de WhatsApp y se reasignan desde ahí.
- **Wompi, correo y proveedor de IA:** las transacciones y los registros de esos servicios no se tocan.
- La configuración: `.env` y las variables de entorno.

**Después.** Crea la cuenta del operador con `npm run operador -- --email tu@correo` (sin ella nadie entra al panel de plataforma). Al arrancar, el servidor repone el catálogo de planes y plantillas. Con `--con-demo` la demostración queda cargada al instante.

**Pruebas.** `server/test/borrar-todo.test.ts`, siempre sobre una base temporal: el simulacro no cambia filas ni archivos; sin la frase exacta no borra; un fallo antes de borrar revierte todo; con `--aplicar` todas las tablas quedan en 0 y las migraciones intactas; una tabla creada por una migración de prueba también se vacía; el respaldo no lleva credenciales; y después se crea el operador, se inicia sesión y se carga una empresa nueva. En `NODE_ENV=production` sin `--produccion` se niega.
