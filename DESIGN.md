---
name: Omnegia
description: Planos, espacio y luz para un negocio conectado.
colors:
  acento: "#5847df"
  ink: "#111827"
  lavender: "#c5bfff"
  lienzo: "#f3f4f8"
  superficie: "#ffffff"
  superficie-2: "#f2f3f8"
  superficie-3: "#e8eaf1"
  borde: "#e0e3eb"
  borde-2: "#bdc3d1"
  borde-3: "#8a93a6"
  tinta: "#182238"
  tinta-2: "#414d63"
  tinta-3: "#5e6a80"
  tinta-4: "#6c768b"
  ok: "#1d6b40"
  ok-tinte: "#e5f2ea"
  atencion: "#7f5300"
  atencion-tinte: "#fbf0d9"
  error: "#ad1f2b"
  error-tinte: "#fbe9ea"
  persona: "#24508c"
  persona-tinte: "#e7eef8"
typography:
  display:
    fontFamily: "Outfit, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(64px, 6.2vw, 90px)"
    fontWeight: 450
    lineHeight: 1.04
    letterSpacing: "-0.04em"
  headline:
    fontSize: "clamp(30px, 3.2vw, 44px)"
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: "-0.035em"
  title:
    fontSize: "32px"
    fontWeight: 500
    letterSpacing: "-0.03em"
  card-title:
    fontSize: "15px"
    fontWeight: 550
    lineHeight: 1.35
    letterSpacing: "-0.005em"
  body:
    fontFamily: "Outfit, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    lineHeight: 1.5
  label:
    fontSize: "12px"
    fontWeight: 500
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 500
    letterSpacing: "0"
rounded:
  r-sm: "6px"
  r: "9px"
  r-lg: "14px"
  public-control: "7px"
  panel-card: "12px"
  r-pildora: "999px"
spacing:
  control-gap: "8px"
  public-mobile-margin: "24px"
  public-tablet-margin: "32px"
  public-section: "94px"
  public-section-tablet: "65px"
  public-section-mobile: "55px"
components:
  button-primary:
    backgroundColor: "{colors.acento}"
    textColor: "{colors.superficie}"
    rounded: "{rounded.r}"
    padding: "0 14px"
  button-secondary:
    backgroundColor: "{colors.superficie}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.r}"
    padding: "0 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.tinta}"
    rounded: "{rounded.r}"
    padding: "0 14px"
  button-subtle:
    backgroundColor: "transparent"
    textColor: "{colors.tinta-2}"
    rounded: "{rounded.r}"
    padding: "0 14px"
  button-danger:
    backgroundColor: "{colors.superficie}"
    textColor: "{colors.error}"
    rounded: "{rounded.r}"
    padding: "0 14px"
  button-hero:
    backgroundColor: "#c5beff"
    textColor: "#21164e"
    rounded: "{rounded.public-control}"
    padding: "0 24px"
  input:
    backgroundColor: "{colors.superficie}"
    textColor: "{colors.tinta}"
    rounded: "{rounded.r}"
    padding: "0 12px"
  panel-nav:
    textColor: "#505268"
    rounded: "{rounded.public-control}"
  chip:
    backgroundColor: "{colors.superficie}"
    textColor: "{colors.tinta-2}"
    rounded: "{rounded.r-pildora}"
    padding: "0 10px"
  panel-card:
    backgroundColor: "{colors.superficie}"
    rounded: "{rounded.panel-card}"
---

# Design System: Omnegia

## Adaptación japonesa y móvil

`web/src/japanese.css`, cargado después de `omnegia.css`, define la adaptación transversal vigente: fondo papel `#f6f5f1`, tinta `#242e31`, superficies neutras cálidas, bordes finos y radios de 3–5 px. Se conservan Outfit, los archivos de marca y el acento de cada empresa. Esta capa se aplica a todas las páginas públicas y a los paneles de empresa y operador mediante sus componentes compartidos.

En móvil las tarjetas de producto se apilan con ilustración superior, las tablas etiquetadas se leen como registros y los controles principales tienen un mínimo de 48 px. La navegación inferior respeta el área segura. Las comprobaciones de anchura incluyen 320, 390, 768 y 1440 px.

La escena de módulos mantiene el relieve en móvil. Sus piezas son botones seleccionables: la elevación responde a la selección del módulo o de Atención, Operación y Control. Las piezas «respiran» con un bucle suave de 7 s que usa la propiedad `translate`, distinta de la `transform` de la selección, de modo que el bucle y la transición conviven sin pisarse; no hay controles de pausa ni vista simple. La preferencia de movimiento reducido ofrece una cuadrícula plana interactiva, sin bucle. El contenido cambia por acción del usuario y la explicación seleccionada se anuncia de forma discreta a lectores de pantalla.

Las medidas y colores del registro anterior que contradigan esta sección quedan sustituidos por esta adaptación.

## Overview

**Creative North Star: "Planos, espacio y luz"**

Omnegia organiza la interfaz mediante planos claros, separadores finos y campos de tinta azul. La inspiración japonesa contemporánea aparece en el ritmo de las divisiones y el espacio alrededor del contenido. La marca existente aporta identidad; sus archivos en `web/public/marca` siguen siendo la autoridad visual.

Las páginas públicas combinan titulares amplios con relieve modular. El panel conserva esos materiales con mayor densidad, tablas y navegación contextual. La profundidad explica conexiones y estados; las acciones y el contenido siguen disponibles en la alternativa plana.

**Key Characteristics:**
- Tinta azul, blancos fríos y lavanda con acento violeta.
- Outfit local, jerarquía amplia en público y compacta en operación.
- Planos delimitados, bordes finos y profundidad localizada.
- Estados legibles, foco visible y movimiento reducido.

Registro derivado de `web/src/main.tsx`, `styles.css`, `studio.css` y `omnegia.css`, en ese orden de cascada; muestras de `SystemScene.tsx`, `SiteChrome.tsx`, `Layout.tsx`, `ui.tsx`, `Experience.tsx`, `MarketingExperience.tsx` y las páginas públicas. El contrato de superficie permanece en `.impeccable/surface-briefs/omnegia.md`. Este documento describe el código; no sustituye el veredicto visual.

## Colors

La paleta combina un fondo frío discreto con violeta de acción y tinta profunda para las superficies expresivas.

### Primary
- **Violeta de acción** (`acento`): botones, enlaces y selección pública. En el panel, `Layout.tsx` aplica el acento y el texto sobre acento enviados por el tema de la empresa; el valor del frontmatter es el valor público por defecto.
- **Lavanda** (`lavender`): referencia cromática de los planos expresivos; sus variaciones locales de iluminación y el botón del héroe permanecen en el componente, sin convertir cada matiz en un token global.

### Neutral
- **Tinta profunda** (`ink`): introducciones, escena de módulos y ensamblaje.
- **Lienzo y superficies**: fondos del área de trabajo, tarjetas y agrupaciones.
- **Tintas de contenido**: texto principal, secundario y auxiliar.
- **Bordes**: separación suave, controles y mayor definición en interacción.

Los estados heredados conservan verde de éxito, ámbar de atención, rojo de error y azul de atención humana, junto a sus tintes. Se acompañan de texto o iconografía. Los colores cian y coral de la identidad no constituyen una segunda paleta de acción para el panel.

**The Acento contextual Rule.** La acción pública usa el violeta de Omnegia; la acción del panel respeta el tema de la empresa.

## Typography

**Display Font:** Outfit con la pila de reserva del frontmatter.
**Body Font:** Outfit, servida desde `/fonts/outfit-variable.ttf` con `font-display: swap` y rango variable 100–900.
**Label/Mono Font:** las etiquetas usan Outfit; los identificadores y el código conservan la pila mono declarada en el frontmatter. La declaración de JetBrains Mono no implica que se descargue esa familia.

La misma familia conecta expresión y trabajo: peso moderado, titulares ajustados y cifras tabulares donde se comparan cantidades.

### Hierarchy
- **Display:** titular del héroe; a 900px baja a 60px y a 600px usa `clamp(48px, 12.6vw, 70px)` con interlínea 1.02.
- **Headline:** títulos de sección pública; en móvil se fijan en 34px.
- **Title:** cabecera del panel; baja a 28px a 600px.
- **Card-title:** encabezados compactos del panel.
- **Body:** base global; los párrafos públicos usan también 15–18px e interlíneas 1.65–1.8 según contexto. Las introducciones limitan su ancho mediante medidas en `ch` o píxeles, sin una medida única universal.
- **Label:** etiquetas auxiliares. Los textos de navegación y controles suelen usar 13–14px.

**The Una familia Rule.** Usar Outfit para títulos y lectura; reservar la pila mono para datos que necesitan alineación o identificación técnica.

## Layout

Las secciones públicas comparten ancho máximo de 1240px. Su ritmo vertical y márgenes adaptativos están en `spacing`; a 901–1340px los bloques principales dejan 40px laterales. El contenido alterna columnas asimétricas, filas delimitadas y grupos de tres módulos. A 600px se apila; las tarjetas editoriales conservan una pequeña columna visual lateral.

La navegación pública pasa a menú desplegable a 900px. El panel parte de una columna lateral de 240px y un área flexible; conserva adaptaciones heredadas a 1360, 1180, 1000 y 760px. A 760px las cuadrículas operativas se apilan y las tablas permiten desplazamiento horizontal. El alta pasa a una columna a 900px y reduce sus márgenes a 20px en móvil.

No existe una escala global de espaciado en variables CSS. Los pasos documentados son medidas reutilizadas de la implementación, no una retícula matemática impuesta retrospectivamente.

## Elevation & Depth

El sistema combina superficies tonales y bordes con sombras suaves. Las tarjetas del panel emplean una sombra apenas perceptible; menús y ventanas elevadas conservan la sombra emergente heredada. La escena pública usa perspectiva CSS, caras iluminadas y sombras difusas para explicar módulos conectados. Es una excepción expresiva con geometría propia, no una receta para cada tarjeta.

### Shadow Vocabulary
- **Tarjeta de panel:** `0 3px 10px -8px #25345050`.
- **Control base:** `0 1px 2px rgba(27, 27, 25, 0.05)`.
- **Emergente:** `0 12px 32px -8px rgba(27, 27, 25, 0.18), 0 2px 6px rgba(27, 27, 25, 0.06)`.

**The Relieve con alternativa Rule.** La escena conserva selección y explicación en la cuadrícula plana de movimiento reducido y en el fallback de CSS 3D; la profundidad no condiciona el acceso al contenido.

## Shapes

Controles rectangulares con esquinas suaves, tarjetas más amplias y píldoras para filtros. Los radios base conviven con el radio específico de tarjeta del panel y de control público documentados arriba. Las líneas de un píxel ordenan tablas, navegación y secciones. Círculos, órbitas y caras tridimensionales pertenecen a ilustraciones o controles concretos; no se convierten en contenedores universales.

## Components

### Buttons
Controles compactos de peso medio. La base comparte mínimo de 42px y separación interior de 8px. Primario usa el acento contextual; secundario usa superficie clara; fantasma conserva borde sin fondo; sutil retira borde y sombra; peligro comunica acción destructiva mediante rojo. El héroe tiene variante lavanda de mínimo 54px. Hover cambia fondo o borde; pulsación aplica escala 0.97; deshabilitado reduce opacidad y bloquea el cursor. El foco general tiene contorno de 3px y separación de 4px.

### Chips
Filtros y estados breves con borde, radio de píldora y mínimo de 28px. Selección usa tinte de acento y texto más profundo; conserva contenido textual. Los chips de módulos del ensamblaje tienen una forma local más rectangular y muestran confirmación solo cuando el espacio está listo.

### Cards / Containers
Las tarjetas operativas usan superficie blanca, borde suave y sombra de panel. El contenedor no impone un relleno universal: cabecera, cuerpo y tablas mantienen su propia densidad. Las tarjetas editoriales recortan su ilustración en la parte superior o lateral; las opciones seleccionadas de planes usan fondo lavanda y borde reforzado.

### Inputs / Fields
Superficie clara, borde intermedio y mínimo de 42px; en móvil el texto sube a 16px. El foco cambia el borde al acento y añade un halo de 3px al 12%. El placeholder usa tinta auxiliar. Deshabilitado adopta fondo secundario. Valores inferidos usan borde discontinuo; datos faltantes usan atención, con ayuda textual desde los componentes de formulario.

### Navigation
La cabecera pública es adhesiva y admite fondo claro u oscuro, con ruta activa subrayada. El menú móvil cierra con Escape, navegación y pulsación exterior. El panel presenta contexto de empresa y filas de navegación; la activa usa tinte del acento contextual y peso 600. Sus controles aumentan de tamaño en móvil.

### Escena de módulos y ensamblaje
`SystemScene` enlaza Atención, Operación y Control con botones de estado pulsado y explicación anunciada de forma discreta. Cada módulo del dibujo también es un botón: seleccionarlo actualiza el grupo y muestra su explicación específica. El relieve usa CSS 3D, sin WebGL. La elevación (`transform`) pasa de reposo (12px) a grupo activo (38px) y módulo seleccionado (72px) mediante una transición interrumpible de 500ms con `var(--ease-out)`. Encima, `translate` aporta la entrada escalonada (1300ms) y la respiración continua (16px, 7s, desfasada por pieza) con `animation-composition: add`; así nunca compite con la transición. El indicador se desplaza en 250ms; las explicaciones combinan opacidad en 200ms y desplazamiento en 250ms. El móvil conserva la perspectiva; hasta 900px incluye además un selector legible de módulos en dos columnas, conectado al mismo estado. Movimiento reducido y falta de soporte CSS 3D ofrecen una cuadrícula plana interactiva de tres columnas, sin controles manuales de pausa o vista simple.

`WorkspaceAssembly` muestra nombre, estado debajo y módulos asociados al estado del servidor. La animación de entrada no certifica el resultado de la operación. En movimiento reducido se anulan las animaciones de piezas y ensamblaje, y las transiciones globales se reducen a 0.01ms; la explicación de la escena conserva una transición breve de opacidad (150ms). La escena admite desplazamiento ligado al scroll solo en escritorio compatible y sin preferencia de movimiento reducido.

### Recorrido de producto y confianza
El recorrido se abre desde la acción transparente «Ver video» del héroe, con un círculo de reproducción delineado (32px) y objetivo de al menos 48px; su hover se limita a dispositivos con puntero fino. El diálogo existente adopta una variante de cine: fondo casi negro, cuadro de video 16:9 y cierre accesible, con el título reservado al lector de pantalla. La apertura mantiene un estado inicial explícito durante 160ms: cuadro invisible, desplazado 64px hacia abajo y a escala 0.82, mientras el fondo se oscurece durante 400ms. Después, opacidad, desplazamiento y escala alcanzan su estado final durante 640ms con `var(--ease-out)`; la secuencia completa dura 800ms. Al pasar del estado inicial al abierto comienza la reproducción. La salida dura 240ms, con desplazamiento de 24px y escala 0.94. Movimiento reducido elimina el desplazamiento y la escala y usa opacidad durante 120ms. El reproductor se monta al abrir y superpone únicamente reproducción/pausa, avance y sonido: botones de 44px y deslizadores HTML de rango con área táctil de 44px, sincronizados con el estado real del video. El volumen tiene 76px de ancho y baja a 56px en móvil; el tiempo transcurrido y total es texto auxiliar que se oculta en móvil. No hay menú de ajustes, pantalla completa, descarga, velocidad ni subtítulos; la pista de subtítulos permanece en el archivo sin interfaz adicional. El foco inicial queda en el diálogo y Tab recorre cierre, reproducción, avance, silencio y volumen con la gestión de foco existente. Escape, cierre y pulsación fuera del cuadro pausan y cierran el video; al terminar se restauran el foco y el desplazamiento de página. Si falla la reproducción, un aviso breve con reintento ocupa el propio cuadro. Los ejemplos y las condiciones del producto permanecen dentro del video.

El video se genera con `node scripts/generate-product-tour.mjs`: la escena `scripts/tour/escena.html` (HTML y CSS animados por tiempo, con la fuente y el logo reales) se renderiza fotograma a fotograma y se codifica en VP9. Son 12 capítulos de 10 s a 1280 × 720 y cada uno tiene montaje propio para que el video no se repita: apertura con el logo y plataforma isométrica, ventanas a la derecha o en espejo, escalera de tarjetas flotantes, teléfono con la conversación, plano amplio de la agenda, acercamiento de cámara, panel oscuro del asistente, paneles que se abren como un libro y documento que recibe el sello de prueba. Las transiciones alternan fundido, acercamiento, subida y barrido lateral.

La banda sonora es original (`scripts/tour/musica.html`): síntesis con Web Audio a 96 BPM, de modo que cada capítulo dura exactamente 4 compases y cada cambio de sección coincide con el cambio de escena (entrada del pulso, sección B en Atención, respiro en el Asistente, subida en Permisos y acorde final en el cierre). Los clics, avisos y el sello suenan donde la escena marca `data-sfx`. Se graba en Opus y se une al video sin recodificar; el reproductor arranca al 60 % de volumen y permite silenciarlo con el control de sonido del reproductor. `--solo-musica` recompone la música sobre el último video renderizado. Los textos de pantalla salen de `web/src/content/product-tour.json`.

La sección de confianza retoma tinta profunda y lavanda con planos superpuestos, bordes finos y sombra difusa. El recibo ilustrativo hace visibles permisos, herramientas y auditoría; se etiqueta como ejemplo, sin convertir la ilustración en una certificación. En móvil los planos se apilan y la perspectiva del recibo se retira. Esta composición pertenece a la landing y no impone una variante global de tarjeta.

## Do's and Don'ts

### Ayuda para el día a día y legibilidad de la landing
La sección de ayuda abre con una cabecera a todo el ancho: título e introducción ocupan dos columnas en escritorio y se apilan hasta 1000px. Debajo, los dos caminos de ayuda (Asistente de tu empresa y Equipo de Omnegia) son pestañas reales (`SupportExplorer`, `support.css`), apiladas a la izquierda del escenario en escritorio; hasta 760px se colocan una junto a otra sobre el escenario. La elegida usa un degradado de marca y abre un ejemplo animado en un escenario oscuro (conversación con recibo de herramienta, o solicitud con estados y respuesta). La opción inactiva muestra «Ver ejemplo →» para que se lea como acción. Funciona con flechas, Inicio y Fin, y el movimiento reducido muestra el ejemplo ya terminado. Todo se rotula como ejemplo ilustrativo.

La landing se diseña para todas las edades: el texto corrido no baja de 16px (descripciones y explicaciones, 17–19px), las etiquetas y notas no bajan de 14px y los objetivos táctiles miden al menos 44px. Los módulos del relieve usan 14px dentro de la pieza; en pantallas pequeñas el selector de módulos ofrece la versión legible.

### Registro asistido por IA
El registro gira alrededor del orbe de la IA (`thinking-orbs`, envuelto en `AiOrb`). Al cambiar de estado (escuchando, leyendo, resolviendo, listo) el orbe nuevo aparece sobre el anterior con un fundido de 650 ms; nunca salta. La IA habla con una sola «voz» (`AiVoice`): cuando el mensaje cambia, borra lo que sobra y escribe lo nuevo, como en un chat; los lectores de pantalla reciben el mensaje completo. Se analiza en cada pausa al escribir (1,2 s) y la voz resume lo que entendió y pregunta en vivo por el primer dato que falte; cuando no falta nada dice que tiene todo listo. La propuesta anterior se conserva atenuada mientras se reanaliza. Lo detectado queda preseleccionado: no hay confirmaciones por dato, solo «Ajustar».

Tras el pago se muestra primero el recibo (imprimir o descargar). «Crear mi espacio con IA» abre el teatro de creación: el orbe crece y, a su lado, una vista previa del panel del negocio se arma con datos reales (dirección, nombre, marca, funciones, catálogo) y con el título y las prioridades que la IA redacta en el servidor. Lo que aún no existe se muestra como carga en bucle, nunca como hecho. Al terminar, la sesión se abre sola y el panel real nace por partes (`WorkspaceBirth`), con la tarjeta «Preparado por la IA» al inicio.

### Do:
- **Do** conservar los archivos de marca existentes y la familia Outfit local.
- **Do** respetar el acento de cada empresa y acompañar los estados con texto o iconos SVG.
- **Do** mantener la explicación y los controles en la vista plana y con movimiento reducido.
- **Do** derivar los estados de alta de la respuesta del servidor.

### Don't:
- **Don't** convertir la composición específica del héroe en una plantilla obligatoria para todas las pantallas.
- **Don't** sustituir la identidad existente por símbolos decorativos japoneses.
- **Don't** presentar una animación de progreso como confirmación de una operación.

No canonizado: declaraciones heredadas y comentarios de la paleta anterior en `styles.css` y `studio.css` quedan subordinados a la cascada actual; no se reparan en esta documentación. Los tamaños auxiliares de 10–11px y cualquier defecto de legibilidad pendiente no se promueven a una regla tipográfica. No se registran kickers, iconos de glifos ni sombras duras desplazadas como recursos del sistema.
