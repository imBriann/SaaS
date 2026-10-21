# Tablero vivo y Omnegia IA

## Construcción en vivo del espacio

Al pagar y crear la empresa, el panel se abre en `/?estreno=1` y el Inicio se arma delante de la persona
(`web/src/components/construccion/Construccion.tsx`). No hay pantalla de carga aparte:

| Fase | Qué se ve |
|------|-----------|
| `shell` | Menú vacío, título que entra desenfocado y Omnegia IA llegando. Dura lo que tarden los datos reales (mínimo 0,5 s). |
| `esqueleto` | Cada tarjeta aparece vacía con su tamaño final, en cascada; la IA las recorre. |
| `revelado` | El contenido real aparece dentro de cada tarjeta, las cifras cuentan y las gráficas se dibujan; los accesos del menú nacen uno por uno. |
| `listo` | La IA se presenta («Muéstrame el panel» abre el recorrido) y se recoge en la pastilla «Preguntar a Omnegia IA». |

- Esqueleto y contenido son la misma caja (`Construible`): el contenido ya está montado y solo se revela, sin saltos de diseño.
- Todas las cifras salen de `GET /api/t/inicio` (mes contra el mismo tramo del mes anterior, semana contra semana, serie de 30 días, mensajes por hora, últimos pagos). Las fases son presentación, nunca progreso inventado.
- **Reconstruir** (para demostraciones): botón ⟳ del chat lateral o `Alt + Shift + R`.
- Con «reducir movimiento» todo aparece directo.

## Chat lateral

La pastilla (o `Ctrl/⌘ + K`) abre el asistente real en un panel derecho; en el escritorio la grilla del
Inicio se reacomoda (4 → 3 columnas) con animación de layout, en el teléfono sube como hoja. Mismos
permisos, recibos, gráficas e informes que la pantalla del asistente. «Preguntar a Omnegia IA sobre esto»
en las tarjetas abre el panel con la pregunta escrita.

## Guías en pantalla

«¿Cómo registro una venta?» → el asistente usa la herramienta `mostrar_guia` y el panel mueve a la IA por
los botones reales, paso a paso (también dentro de formularios abiertos: la capa vive en la capa superior
del navegador).

- Catálogo de pasos: `web/src/components/ia/guias.ts`; cada paso señala un elemento con `data-guia`.
- Lista para el modelo y control de permisos: `server/src/ai/guias.ts`. Una guía que el rol no puede seguir no se ofrece.
- La IA solo **abre** pantallas y formularios por la persona; nunca guarda, cobra ni envía.
- Si un elemento no está (rol, módulo apagado), el paso opcional se salta y uno obligatorio lo avisa.
- `server/test/guias.test.ts` verifica que ambos catálogos coincidan y que cada elemento señalado exista en la interfaz.

Para añadir una guía: el id en `IDS_GUIA` y `GUIAS` del servidor, los pasos en el catálogo web y el
atributo `data-guia` en cada elemento que se señala.

## Interfaz del panel

- **Escritorio:** riel lateral de íconos (activo en círculo negro, nombre al pasar el cursor), barra superior con la pregunta rápida a Omnegia IA (`Ctrl/⌘ + K`), el chat y la campana con lo que espera en Conversaciones. Fondo cálido y tarjetas suaves.
- **Teléfono:** sin cambios de navegación: cabecera móvil, barra inferior y menú «Más».
- «Asistente IA» ya no ocupa un lugar en el menú (la IA está en todas las pantallas); la pantalla completa del asistente se abre desde el chat lateral. Su lugar lo toma **Informes**.

## Informes

`GET /api/t/informes` (los que el rol y los módulos permiten) y `GET /api/t/informes/:tipo?periodo=semana|mes|mes_anterior|rango&desde&hasta` (hasta 92 días; más de 31 se agrupa por semana).
Tipos: ventas, cobros, agenda, clientes e inventario. Los arma el servidor con consultas (sin IA), se validan con el mismo esquema `Informe` del asistente y se muestran en la plantilla de Omnegia con los datos de la empresa, descargables como imagen o PDF. Para un corte distinto, «Pedir a Omnegia IA».

## La cara de Omnegia IA

`OrbeCara` (`web/src/components/ia/OrbeCara.tsx`) con mejillas, boca y brillo en los ojos; parpadea y curiosea sola. Gestos: escuchando (la persona escribe), pensando (consulta), hablando (responde), feliz (terminó), atenta (al pasar el cursor) y confundida (algo falló o no encuentra un botón). `useCaraIA` elige el gesto en una conversación.
