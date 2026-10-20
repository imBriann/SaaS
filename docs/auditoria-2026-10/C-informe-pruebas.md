# C · Informe de pruebas

Todas las cifras corresponden a ejecuciones reales del 18 y 19 de octubre de 2026.

## Automáticas

| Ejecución | Resultado |
|---|---|
| `npm test` (PGlite, servidor) | **420 de 420** en 29 archivos (la línea base era de 348) |
| `npm run test:postgres` (PostgreSQL embebido real) | **268 de 268** en 17 archivos, incluidos WhatsApp, agente, pagos, catálogo y soporte |
| `tsc --noEmit` del servidor y de la web | Sin errores |
| `npm run build` (web) | Correcto |

### Casos exigidos por el encargo

| Caso | Prueba |
|---|---|
| Saludo inicial único; sin repetir presentación en tres mensajes del mismo problema | `plataforma-whatsapp`: «saludo y continuidad» |
| Insistencia y petición de asesor | «insistencia», «pide una persona» |
| Error de acceso: pide el detalle, usa la recuperación real y comprueba | «error de acceso…» |
| Número con varias empresas: no revela nombres | «número asociado a varias empresas» |
| Intento de obtener datos de otra empresa | «no revela datos de cuentas» |
| Conversación transferida: sin respuestas automáticas indebidas | «con una persona al frente, el asistente no contesta» |
| Efectivo con cambio, insuficiente, inválido, duplicado, digital, reportes, permisos, aislamiento y persistencia | `pagos-ventas` (15 casos) |
| Catálogo «12», duplicados, revisión sin borrar y acción de IA con confirmación | `catalogo-asistente` (12 casos) |
| Soporte: resuelve con datos reales, escala por regla y por la persona, y aísla entre empresas | `soporte-ia` (11 casos) |

### Fallo encontrado solo en PostgreSQL

Las pruebas del WhatsApp pasaban en PGlite y fallaban en PostgreSQL (17 casos) por la precisión de las fechas. Tras la corrección pasan en ambos. Por eso las pruebas nuevas quedaron incluidas en `test:postgres`.

### Propietario y varias empresas (19 de octubre de 2026)

| Ejecución | Resultado |
|---|---|
| `npm test` (PGlite) | 471 de 472 en la primera pasada: `catalogo-asistente` quitaba un permiso a la administradora demo, que ahora es propietaria. Se ajustó la prueba para usar una administradora no propietaria y el archivo pasó 12 de 12 |
| `npm run test:postgres` | **277 de 277** en 18 archivos, incluido `propietario` |
| `propietario.test.ts` (9 casos) | Varias empresas por cuenta, permisos completos del propietario, protección frente a otro administrador, cesión con contraseña y reinicio (simulacro, negativas y aplicado) |
| Recorrido visual del selector, la cortina de cambio, Configuración y teléfono | 9 de 9, sin errores de consola |

### Rediseño del asistente, conversaciones y tableros (19 de octubre de 2026)

| Comprobación | Resultado |
|---|---|
| Foco tras la respuesta del asistente | Teléfono: ya no vuelve al cuadro de texto (no abre el teclado). Portátil: sigue enfocado |
| Interacciones (enviar con Enter, Shift+Enter, nota interna, menú de acciones, panel de detalles, búsqueda, preguntas de seguimiento; en el teléfono Enter salta de línea, barras ocultas en el chat y volver a la bandeja) | 14 de 14 |
| Recorrido de 52 páginas (empresa y operador, escritorio y 390 px) | 0 errores, 0 desbordes |

## Recorridos visuales (Playwright, servidor local aislado)

| Recorrido | Comprobaciones | Resultado |
|---|---|---|
| Cobro, pagos, caja, cobros, catálogo, inicio, conversación compartida, asistente, WhatsApp de Omnegia, operador y móvil | 33 | 33 correctas; los ajustes de diseño detectados se corrigieron |
| Segunda pasada sobre lo corregido, incluido movimiento reducido | 18 | 18 correctas |
| Soporte con IA (propuesta, no sirvió, escalado, cobro dudoso, resuelto) | 10 | 10 correctas |
| Todas las páginas de empresa (15) y operador (11), en escritorio y móvil (390 px) | 52 páginas | 0 errores de página, 0 desbordes horizontales y 0 avisos de error visibles |

## Lo que no se pudo probar aquí

- Envío real por WhatsApp Cloud API: el canal se simuló con webhooks firmados con un secreto local.
- Respuestas de Claude en producción: en local se usa el simulador determinista; las respuestas reales dependen de `ANTHROPIC_API_KEY`.
- Wompi en producción y la DIAN.
