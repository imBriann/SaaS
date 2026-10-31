# Imágenes del catálogo y punto de venta

Actualizado el 31 de octubre de 2026.

## Modelo (migración 030)

`producto_imagen`: `product_id` (FK compuesta con `tenant_id`), `orden`, `origen` (`SUBIDA`, `BUSQUEDA_IA`, `URL`), `url` externa y/o `ruta_archivo` propia, `miniatura`, `fuente` (página de origen), `licencia`, `autor`, `atribucion`, `estado` (`ACTIVA`, `PENDIENTE_APROBACION`, `ROTA`) y `verificada_en`. RLS con `FORCE`. Solo las `ACTIVA` se muestran en el punto de venta o se envían a clientes.

## Subir (manual)

- JPG, PNG o WebP, verificando el **tipo real** por la firma del archivo (un «.png» que es un ejecutable se rechaza).
- Tamaño máximo `IMAGENES_MAX_MB`, redimensionada a `IMAGENES_ANCHO_MAX`, convertida a WebP con miniatura de 320 px y **sin metadatos EXIF** (pueden traer la ubicación). Se usa `sharp`, que no copia EXIF, XMP ni ICC salvo que se pida.
- Adaptador de almacenamiento (`lib/almacen.ts`): disco (`IMAGENES_DIR`) hoy, con interfaz lista para un almacenamiento de objetos.
- URL pública `API_PUBLIC_URL/api/publico/imagenes/…`: debe ser https, porque la Cloud API de WhatsApp envía la imagen por enlace. Solo sirve archivos de imágenes `ACTIVA` y las rutas llevan identificadores aleatorios. El panel usa una ruta con sesión (`/api/t/catalogo/imagenes/:id/archivo`), sujeta a la RLS.
- `npm run borrar-todo` también vacía `IMAGENES_DIR`.

## La IA busca la imagen

Botón «Buscar imagen con IA» en la ficha, y «Completar imágenes que faltan» (10 productos por vez) en el catálogo. La IA arma la consulta (nombre, marca y presentación), el adaptador `BuscadorImagenes` trae candidatas y la IA elige las mejores por pertinencia. Sin modelo, se usa el nombre y las primeras candidatas.

### Proveedor elegido y costos (verificados el 31 de octubre de 2026)

| Proveedor | Costo y cupo | Licencia y uso | Cómo se asigna |
|---|---|---|---|
| **Openverse** (por defecto) | Gratis; anónimo con límite de solicitudes, más cupo registrando una aplicación. | Se piden solo licencias abiertas con **uso comercial** (`license_type=commercial`). Hay que mostrar la atribución cuando la licencia lo exige (CC BY…). | **Automática**, con copia propia, autor, licencia, atribución y fuente. |
| Pexels (opcional, `PEXELS_API_KEY`) | Gratis: 200 solicitudes por hora y 20.000 al mes por defecto. | Licencia de Pexels, uso comercial permitido; piden enlazar a Pexels y dar crédito al fotógrafo cuando sea posible. Fotos genéricas: útiles para servicios. | Automática. |
| Brave Search (opcional, `BRAVE_SEARCH_API_KEY`) | De pago: unos US$5 por 1.000 consultas, con US$5 de crédito al mes (≈ 1.000 gratis). Brave eliminó el plan gratuito en 2026. | Búsqueda web general: la foto suele ser del fabricante o de una tienda. | **`PENDIENTE_APROBACION`**: solo enlace y miniatura propia para el panel. |

No se hace scraping de Google ni de otros buscadores: viola sus condiciones y se rompe.

Las condiciones de Openverse y Pexels se tomaron de su documentación pública. Para Brave no pude abrir la página oficial de precios: las cifras salen de fuentes de terceros de 2026. Hay que confirmarlas antes de activarlo.

### Derechos de autor

- Licencia abierta → se asigna sola, guardando autor, licencia, atribución y fuente.
- Web general → pendiente. En la ficha, la empresa la aprueba con un clic y la interfaz le recuerda en una línea que debe tener derecho a usarla (por ejemplo, porque distribuye el producto). Hasta entonces no se envía a clientes.
- Siempre se guarda la página de origen.
- Enlace frente a copia: con licencia abierta se guarda copia propia (los enlaces externos se rompen); sin ella, solo enlace y miniatura. El trabajo diario `revisar_imagenes` comprueba los enlaces externos y marca `ROTA` los que fallan. El panel muestra «Enlace roto» y «Buscar imagen con IA» propone el reemplazo.

### Seguridad de las descargas (`lib/descargaSegura.ts`)

Solo https; sin credenciales en la URL; sin localhost ni `.local`/`.internal`; sin IP privadas, de loopback, enlace local (incluida 169.254.169.254), CGNAT, multicast ni sus equivalentes IPv6. La IP se valida **al conectar** (función `lookup`), así que un cambio de DNS no la salta. Cada redirección se vuelve a validar (máximo 3), con límite de tiempo y de tamaño, y se comprueba que el contenido sea realmente una imagen.

## En la conversación

`enviar_imagen_producto` (riesgo `reversible`, máximo 4 por conversación): la IA envía la foto cuando el cliente pregunta por un producto o pide verlo. Solo imágenes `ACTIVA` del propio negocio y solo dentro de la ventana de 24 horas; fuera, explica que WhatsApp no lo permite. Se envía como imagen por enlace de la Cloud API y el panel la muestra en la conversación.

## Punto de venta («Vender»)

Cuadrícula con imagen, buscador, categorías como pestañas y carrito lateral con cantidades y descuento por línea o total. Cliente por buscador o «cliente de mostrador». Medio de pago y total grande. Al confirmar: se registra la venta, se descuenta el inventario y, si la empresa lo activó en Configuración › Comprobantes, el **sistema** genera el comprobante (regla del negocio, no decisión de la IA) y se ofrece enviarlo por WhatsApp o correo. El listado de ventas muestra el estado del pago, el origen (IA o panel) y el comprobante; las ventas de la IA aparecen con su distintivo (la lista se actualiza sola).

## Pruebas

`server/test/imagenes.test.ts`: ejecutable disfrazado de PNG rechazado; EXIF eliminado (WebP con miniatura); SSRF bloqueado (http, 127.0.0.1, 169.254.169.254, localhost, IP privadas, IPv6 local, puertos); búsqueda con licencia abierta asignada sola; búsqueda web pendiente que no se sirve ni se envía hasta aprobarla; envío por WhatsApp solo dentro de la ventana; aislamiento entre empresas; venta de mostrador con descuento total y comprobante automático.
