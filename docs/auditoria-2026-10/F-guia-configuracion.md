# F · Guía de configuración

No incluye valores secretos: solo nombres de variables y pasos.

## 1. Desplegar

1. Subir `main` y dejar que Render construya. Las migraciones `012`–`019` se aplican al arrancar (cada una en su transacción). Requieren que el usuario de la base pueda crear roles (`app_soporte`), como ya ocurría con `app_operador`.
2. Comprobar `GET /api/salud`.
3. Antes de cada entrega de servidor, ejecutar `npm run test:postgres`: PGlite no reproduce algunos comportamientos de PostgreSQL.

## 2. Variables nuevas o que vale la pena revisar

| Variable | Para qué |
|---|---|
| `WHATSAPP_PLATFORM_PHONE_NUMBER_ID` | Identificador del número de WhatsApp de Omnegia. Sin ella, ese número no se atiende |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` | Firma de webhooks, envío y verificación con Meta |
| `ANTHROPIC_API_KEY`, `LLM_PROVIDER=anthropic` | IA real (agentes, asistente y soporte) |
| `IA_PRECIO_ENTRADA_USD_MTOK`, `IA_PRECIO_SALIDA_USD_MTOK` | Estimación del costo técnico en el panel del operador |
| `EMAIL_SUPPORT_INBOX` | Recibe las solicitudes, incluidas las que escala el asistente |

No hay variables nuevas para cobros ni para el soporte con IA.

## 3. Pasos por empresa (desde su panel)

1. **Configuración › Cobros:** elegir los métodos aceptados (efectivo y transferencia vienen activos; el datáfono, apagado) y vincular Wompi si se usarán enlaces de pago.
2. **Configuración › WhatsApp:** pegar el Phone number ID y usar «Verificar conexión».
3. **Catálogo:** revisar la tarjeta «Por revisar».

## 4. Panel del operador

- Crear cuentas de operador con `npm run operador -- --email <correo>` en la Shell de Render. Nunca desde un equipo local contra producción.
- «Conversaciones» atiende el WhatsApp de Omnegia; «Atención de las empresas» muestra cifras y las conversaciones que una empresa comparta.

## 5. Reiniciar la plataforma (borrar empresas de prueba)

`npm run reiniciar -- --conservar <correo>` borra todas las empresas salvo aquellas a las que pertenece ese correo, con todos sus datos, y las cuentas que quedan sin empresa. Las cuentas del operador nunca se borran.

- Sin `--aplicar` es un **simulacro**: ejecuta todo dentro de una transacción y la revierte, e imprime qué se borraría.
- Con `--aplicar --respaldo <archivo.json>` escribe primero el respaldo (sin contraseñas ni sesiones) y luego borra.
- Se niega si la cuenta a conservar no existe o si alguna empresa tiene un número telefónico real vigente (`--permitir-numeros-reales` para forzarlo, después de cancelarlo en el proveedor).
- No toca Wompi ni Meta: los cobros ya hechos siguen en la pasarela.

## 6. Desarrollo local aislado

- Servidor: `PGLITE_DIR=<carpeta temporal> DATABASE_URL= LLM_PROVIDER=mock EMAIL_PROVIDER=fake RESEND_API_KEY= npx tsx src/main.ts`, con las llaves de Wompi vacías. Las variables del proceso ganan al `.env`.
- Web: `npm run dev` en `web/` (puerto 5173).
- Demo: `admin@elparche.test` / `demo-parche-2026`. Operador: `plataforma@saas.test`, con código por correo.
