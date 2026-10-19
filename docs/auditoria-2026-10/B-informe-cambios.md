# B · Informe de cambios

## Base de datos (migraciones versionadas y atómicas)

| Migración | Contenido |
|---|---|
| `012_atencion_whatsapp.sql` | `plataforma_conversacion` y `plataforma_mensaje` (conversación del número de Omnegia); `soporte_ticket` con canal WHATSAPP; vista `operador_equipo`; `acceso_soporte` y el rol `app_soporte` con políticas RLS por fila. |
| `013_pagos_ventas.sql` | `order_payment` (método, monto, recibido, cambio con CHECK, idempotencia, anulación) con índice único del pago vigente; `payment_settings`; permisos `payment:register` y `payment:void`. |
| `014_asistente_acciones.sql` | Acciones pendientes del asistente del panel ligadas al hilo y a quien las pidió; herramientas de catálogo. |
| `015_soporte_ia.sql` | `soporte_intento_ia` con RLS por empresa. El operador solo ve columnas sin contenido. |

## Servidor

- **`modules/plataformaBot.ts`**: gestor de diálogo puro (`analizar`, `decidir`) con estado. Usa textos verificados contra la interfaz, evita repetir la misma respuesta, ofrece la recuperación de acceso real y deriva a una persona.
- **`modules/plataformaConversaciones.ts`**: recepción sin duplicados, procesamiento de ráfagas y derivación con solicitud SOP, correo a la bandeja de soporte y resumen del caso. También envío con ventana de 24 horas, estados de entrega, cierre por inactividad y purga a 90 días. **Corrección del 19 de octubre:** las comparaciones de fecha se hacen en SQL.
- **`modules/operadorAtencion.ts`**: bandeja del operador, atención de las empresas, lectura autorizada y verificación de WhatsApp.
- **`modules/pagosVentas.ts`**: registrar y anular pagos, caja del día y cobrado por método.
- **`modules/soporteIA.ts`**: revisión de la cuenta, guías verificadas, reglas de escalamiento, redacción con IA restringida a esas fuentes y paso al equipo con diagnóstico.
- **`modules/catalog.ts`**: validación de nombres y duplicados, y `revisarCatalogo`.
- **`ai/runtime.ts`, `gateway.ts`, `registry.ts`**: consentimiento sin bucle, escalamiento determinista, confirmación de acciones desde el panel y herramientas de catálogo.
- **`ai/llm/mock.ts`**: simulador determinista ampliado (cobros, catálogo, soporte).
- **Rutas:** `/api/t/ventas/*`, `/api/t/cobros/*`, `/api/t/soporte/asistente/*`, `/api/t/conversaciones/:id/acceso-soporte`, `/api/operador/conversaciones/*` y `/api/operador/atencion-empresas/*`.

## Web

- **Componentes nuevos:**
  - `Cobro.tsx`: cobro en el mostrador.
  - `Markdown.tsx`: Markdown seguro, código con resaltado y vista previa aislada.
  - `Movimiento.tsx`: contador de cifras, marca de éxito con destello y entradas escalonadas.
  - `Pulso.tsx`: cabecera viva de los tableros.
- **Páginas:**
  - Ventas, Catálogo, Configuración › Cobros, Conversaciones, Asistente, Soporte e Inicio.
  - Operador: bandeja, atención de las empresas, soporte, empresa y resumen.
- **Estilos:** `cobros.css`, `atencion.css`, `movimiento.css`, `soporte.css`, `dashboard.css` y `markdown.css`. Todos con `prefers-reduced-motion`.

## Pruebas nuevas

`plataforma-whatsapp.test.ts`, `agente-conversacion.test.ts`, `pagos-ventas.test.ts`, `catalogo-asistente.test.ts` y `soporte-ia.test.ts`. Se añadieron a la batería de PostgreSQL real (`scripts/pruebas-postgres.mjs`).
