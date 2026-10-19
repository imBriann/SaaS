# A · Informe de auditoría

## 1. Método

1. Inspección del repositorio: servidor Fastify con TypeScript, base PostgreSQL con RLS (PGlite en desarrollo) y web React 19 con Vite.
2. Comprobaciones iniciales: typecheck y suite de pruebas. La línea base era de 348 pruebas.
3. Reproducción de cada caso del encargo con pruebas automáticas antes de corregirlo.
4. Revisión visual con Playwright (Chromium sin interfaz) contra un servidor local aislado: base PGlite desechable y todos los terceros simulados. Nunca contra producción.

## 2. Hallazgos y causa raíz

| # | Hallazgo | Causa raíz | Impacto | Severidad |
|---|---|---|---|---|
| H1 | El WhatsApp de Omnegia respondía siempre «Hola Brian. Te reconozco: este número figura como contacto de 4 comercios…» y remitía a soporte. | `redactarRespuesta` no guardaba estado: cada mensaje se trataba como el primero, e incluía los nombres de las empresas asociadas al teléfono. | Repetición, filtración de qué empresas usa un número y ningún problema resuelto. | Alta (privacidad y experiencia) |
| H2 | El teléfono se usaba como prueba de identidad. | El reconocimiento por teléfono se presentaba como autenticación. | Riesgo de suplantación. | Alta |
| H3 | No había paso a una persona: sin radicado, sin bandeja y sin forma de que el equipo respondiera por WhatsApp. | No existía el modelo de conversación de la plataforma. | Casos sin cierre. | Alta |
| H4 | Bucle de consentimiento en el agente de las empresas. | El aviso se repetía mientras el cliente no respondía «sí». | El cliente no lograba ser atendido. | Media |
| H5 | El operador no tenía ninguna vía autorizada para ver una conversación sobre la que una empresa pedía ayuda. | El diseño de privacidad era correcto (sin acceso), pero faltaba un mecanismo de autorización explícita. | El soporte trabajaba a ciegas. | Media |
| H6 | Solo había cobro por pasarela. | Faltaba el modelo de pago manual. | Los negocios de mostrador no podían registrar el efectivo ni calcular el cambio. | Alta (requisito obligatorio) |
| H7 | Servicio «12» a $12, 30 min y sin categoría. | No se validaba que el nombre tuviera letras ni se revisaba la calidad del catálogo. | Datos de prueba visibles para el agente y los clientes. | Media |
| H8 | El asistente del panel no permitía confirmar acciones ni mostraba avance real. | Acciones confirmables solo pensadas para el canal WhatsApp. | Acciones imposibles de completar desde el panel. | Media |
| H9 | Textos legales desactualizados respecto a las conversaciones de WhatsApp. | La función cambió y el texto no. | Incumplimiento de transparencia (Ley 1581 de 2012). | Media |
| H10 | **Producción (19 de octubre):** el bot no respondía ningún mensaje. | Se comparaban fechas leídas por node-pg (milisegundos) contra `timestamptz` (microsegundos). El propio mensaje parecía «posterior» y se descartaba. PGlite no lo reproduce. | Canal de Omnegia sin respuesta. | Crítica |
| H11 | El soporte de las empresas dependía siempre de una persona. | No había triaje automático. | Esperas largas por problemas que los datos de la cuenta ya explican. | Media |
| H12 | Una conversación derivada sin respuesta humana no figuraba como «por responder». | El aviso automático del bot contaba como respuesta. | Casos invisibles para el equipo. | Media |

## 3. Matriz pantalla por pantalla

| Pantalla | Problema | Impacto | Solución | Archivos | Pruebas |
|---|---|---|---|---|---|
| Ventas › Registrar venta | No se podía cobrar en el momento ni crear el cliente desde la venta. | Doble trabajo en el mostrador. | Componente de cobro (método, recibido, cambio en vivo, montos rápidos) y alta rápida de cliente. | `web/src/components/Cobro.tsx`, `pages/app/Negocio.tsx` | `pagos-ventas.test.ts`, recorrido visual |
| Ventas › Detalle | No se podía registrar ni anular un pago. | Sin trazabilidad del dinero. | Tarjeta «Pagos» con historial, anulación con motivo y aviso de pago de más. | `Negocio.tsx`, `server/src/modules/pagosVentas.ts` | Ídem |
| Ventas › Caja del día | No existía. | Sin cierre de caja. | Cobrado por método, arqueo del efectivo y detalle por pago. | Ídem | Ídem |
| Configuración › Cobros | No se podían elegir los métodos de pago. | — | Interruptores por método y estado de la pasarela. | `pages/app/Gobierno.tsx` | Ídem |
| Catálogo | Datos de prueba sin detectar. | Información errónea para los clientes. | «Por revisar», validación de nombres y aviso de precio sospechoso. | `Negocio.tsx`, `modules/catalog.ts` | `catalogo-asistente.test.ts` |
| Conversaciones (empresa) | Sin forma de pedir ayuda sobre una conversación concreta. | — | «Compartir con soporte» por tiempo limitado y revocable, mostrando cuándo se leyó. Formato de WhatsApp en los mensajes. | `pages/app/Conversaciones.tsx`, `modules/conversations.ts` | `plataforma-whatsapp.test.ts` |
| Asistente IA | Faltaba confirmación, avance real y bloques de código. | — | Rediseño completo. | `pages/app/Asistente.tsx`, `components/Markdown.tsx` | `catalogo-asistente.test.ts` |
| Soporte (empresa) | Solo formulario. | Esperas largas. | Asistente de soporte con revisión real y escalamiento; la empresa puede marcar su solicitud como resuelta. | `pages/app/Soporte.tsx`, `modules/soporteIA.ts` | `soporte-ia.test.ts` |
| Inicio (empresa) | Tablero estático. | Lo importante del día no destacaba. | Pulso en vivo, «Cobrado hoy» y animaciones. | `pages/app/Inicio.tsx`, `components/Pulso.tsx` | Recorrido visual |
| Operador › Conversaciones | No existía. | — | Bandeja global de WhatsApp. | `pages/operador/Atencion.tsx`, `modules/operadorAtencion.ts` | `plataforma-whatsapp.test.ts`, `operador.test.ts` |
| Operador › Atención de las empresas | No existía. | — | Indicadores sin contenido y lectura autorizada. | Ídem | Ídem |
| Operador › Soporte | No distinguía canales ni mostraba el trabajo del asistente. | — | Filtro por canal, solicitudes de WhatsApp y cifras del asistente de soporte. | `Operador.tsx`, `modules/operador.ts` | `operador.test.ts`, `soporte-ia.test.ts` |
| Operador › Resumen | Tablero estático. | — | Pulso de la plataforma (ingreso recurrente, salud, incidentes, cola). | `Operador.tsx` | Recorrido visual |
| Operador › Empresa | No se podía verificar el WhatsApp de una empresa. | — | Botón «Verificar WhatsApp», que solo consulta el estado en Meta. | `Operador.tsx`, `operadorAtencion.ts` | `operador.test.ts` |
| Páginas legales | Texto desactualizado. | Transparencia. | Privacidad, términos y eliminación de datos actualizados; nueva versión legal. | `pages/public/Legal.tsx`, `server/src/legal/index.ts` | `legal.test.ts` |

## 4. Decisiones de negocio documentadas

- **Sin abonos:** una venta se paga completa o queda por cobrar. El producto no maneja pagos parciales y la base lo garantiza con un único pago vigente por venta.
- **Un pago de pasarela no se anula desde el panel:** si hubo devolución en Wompi, se anula la venta.
- **El operador global no edita productos, precios, inventario ni ventas de las empresas.** Solo administra la relación comercial y el soporte.
- **Soporte con IA:** el costo de sus llamadas lo asume Omnegia y no se descuenta de la cuota de IA de la empresa.
- **Retención:** las conversaciones con el WhatsApp de Omnegia se eliminan 90 días después del último mensaje.
