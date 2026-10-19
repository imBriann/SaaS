# Compra y activación de números de WhatsApp desde Omnegia

Fecha: 19 de octubre de 2026. Este documento resume la investigación, lo implementado, lo probado y lo que falta para vender números reales.

**Resumen honesto.** El flujo está completo de punta a punta: selección, requisitos regulatorios, resumen con precios, pago con Wompi, compra del número, registro con Meta, verificación por llamada, conexión con el asistente de IA, mensualidades y cancelación. Funciona en simulación y lo cubren 33 pruebas automáticas. **Ninguna operación se ha validado contra Telnyx ni Meta reales**, porque este entorno no tiene credenciales. Las llamadas a esas APIs siguen su documentación oficial, y las pruebas comprueban la forma de cada petición y la interpretación de cada respuesta. Para vender en producción hacen falta los pasos de la sección 9.

---

## 1. Proveedor recomendado: Telnyx

| Criterio | Telnyx | Twilio | Vonage | Meta directo |
|---|---|---|---|---|
| Números de Colombia por API | Sí: tipos `local`, `national`, `mobile` y `toll_free` según la cobertura del país (`GET /v2/country_coverage/countries/CO`) | Sí: local y gratuito (`+571800`), con *Regulatory Bundle* | Sí, en autoservicio, pero los números de voz **solo se pueden usar con la Voice API de Vonage** | **No.** Meta no vende ni asigna números: exige un número propio que reciba SMS o llamadas |
| Precio real en la búsqueda | **Sí**: `cost_information.upfront_cost` y `monthly_cost` en cada resultado | No: hay que consultar aparte la Pricing API | No documentado en la búsqueda | — |
| Reserva antes de comprar | **Sí**: 30 minutos, ampliable (`/v2/number_reservations`) | No | No | — |
| Requisitos regulatorios por API | Sí: `regulatory_requirements`, `documents`, `addresses` y `requirement_groups` | Sí, con Bundles | Parcial | — |
| Webhooks firmados | Ed25519 (`telnyx-signature-ed25519`) | HMAC | JWT | — |
| Atender la llamada de verificación | TeXML, con transcripción integrada (`<Transcription>`) | TwiML (`<Record>`/`<Gather>`) | NCCO | — |

**Por qué Telnyx.** Es el único de los tres que devuelve el precio real dentro de la búsqueda y permite reservar el número antes del pago, dos cosas que exige el flujo. Además resuelve los requisitos regulatorios por API y transcribe la llamada en la misma aplicación de voz. Twilio es una alternativa viable: la abstracción `ProveedorNumeros` (`server/src/numeros/proveedor.ts`) permite añadirlo con un adaptador, sin tocar la máquina de estados. Vonage queda descartado para este flujo: su restricción de uso solo con la Voice API impide recibir la llamada de verificación de Meta fuera de su plataforma. Meta directo no es una opción, porque no suministra números.

**Compatibilidad con WhatsApp: qué se verificó en la documentación de Meta.** Un número es apto si tiene indicativo de país y de área, si recibe **SMS o llamada de voz** y si no está en la aplicación personal de WhatsApp. Para números fijos y VoIP, Meta marca la verificación **por voz como «Standard»** y el SMS como «Not recommended». Los números detrás de un IVR no sirven, porque la llamada de registro no puede navegar el menú. Por eso:

- Omnegia solo ofrece números **con voz**. El número se asigna a una aplicación TeXML de Omnegia que atiende la llamada de Meta, la transcribe y extrae el código.
- **No se ofrecen números gratuitos (01 8000).** Suelen no recibir llamadas internacionales, y la de Meta lo es. Es una decisión prudente, no una prohibición documentada de Meta.

Fuentes:
- [Meta: números de negocio](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers/)
- [Meta: registro programático](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/registering-phone-numbers/)
- [Meta: omitir la pantalla de número](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/bypass-phone-addition)
- [Meta: Embedded Signup v4](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4)
- [Telnyx: búsqueda](https://developers.telnyx.com/api/numbers/list-available-phone-numbers)
- [Telnyx: reservas](https://developers.telnyx.com/docs/numbers/phone-numbers/number-reservations.md)
- [Telnyx: órdenes](https://developers.telnyx.com/docs/numbers/phone-numbers/number-orders.md)
- [Telnyx: requisitos de Colombia](https://support.telnyx.com/en/articles/5464069-colombia-did-requirements)
- [Telnyx: transcripción con TeXML](https://developers.telnyx.com/docs/voice/programmable-voice/speech-to-text.md)
- [Twilio: requisitos de Colombia](https://www.twilio.com/en-us/guidelines/co/regulatory)
- [Vonage: Colombia, voz](https://api.support.vonage.com/hc/en-us/articles/20115737996188-Colombia-Voice-Features-and-Restrictions)

## 2. Costos comprobados

| Concepto | Valor | Fuente y nivel de certeza |
|---|---|---|
| Telnyx, número local de Colombia | «desde **USD 13,50 al mes**» | Página pública de Telnyx Colombia. El valor exacto de cada número lo da su API (`cost_information`), y es el que usa Omnegia |
| Telnyx, activación (*upfront*) | No publicado para Colombia | Lo informa la API en cada número |
| Twilio, número local de Colombia | USD 17,50 al mes. La misma página muestra también USD 14,00 en otra sección | Página de precios de voz de Twilio para Colombia. La discrepancia no está explicada |
| Twilio, número gratuito | USD 25,00 al mes | Misma página |
| TRM | 3.174,67 COP por USD, vigente desde el 17 de octubre de 2026 | `datos.gov.co`, conjunto `32sa-8pi3` (Superintendencia Financiera), consultado desde este entorno |
| Meta, mensajes | Las respuestas dentro de las 24 horas no tienen cargo. Las plantillas se cobran por mensaje entregado, según su categoría | El valor por categoría para Colombia **no se confirmó** en la tabla oficial: es configurable y, sin configurar, el resumen enlaza la tarifa de Meta |

Ningún precio está escrito en el código ni en el frontend. El precio en pesos se calcula en el servidor, se congela al elegir el número y se vuelve a validar si la reserva vence. Su fórmula:

> costo del proveedor × tasa (TRM o fija) × (1 + colchón cambiario) × (1 + margen), redondeado hacia arriba a la centena. Después se suma el cargo de gestión y, si el emisor es responsable de IVA, el IVA.

## 3. Países y tipos realmente disponibles

- **Lanzamiento:** Colombia (`NUMEROS_PAISES=CO`). Para añadir países basta con la variable: la cobertura, los tipos, los requisitos y los precios se consultan en vivo al proveedor.
- **Tipos:** los que devuelva la cobertura de Telnyx para el país. Solo se ofrecen los que tienen voz y no son gratuitos.
- **No verificado:** el inventario real de Colombia en Telnyx (cuántos números hay y en qué ciudades). Esa consulta exige una cuenta.
- **Requisitos en Colombia según Telnyx:** nombre y apellido del titular o del representante, nombre de la empresa y una dirección. Twilio exige además que la dirección esté en la zona del indicativo. La lista exacta llega de `GET /v2/regulatory_requirements` y el formulario se arma con ella.

## 4. Restricciones de WhatsApp y Meta

- **Comprar un número no activa WhatsApp.** Son dos operaciones con estados distintos.
- **El registro con Meta lo hace el cliente.** Inicia sesión en Meta, crea o elige su portafolio y su cuenta de WhatsApp Business y acepta las condiciones. Omnegia lo integra con Embedded Signup v4 y `featureType: only_waba_sharing`, así Meta no pide el número. Después, Omnegia lo agrega, lo verifica y lo registra por API (`/phone_numbers`, `/request_code?code_method=VOICE`, `/verify_code` y `/register` con PIN). Embedded Signup v2 y v3 dejaron de funcionar el 15 de octubre de 2026: hay que crear la configuración v4.
- **Requisito de Meta:** la app de Omnegia debe ser **Tech Provider**, con Facebook Login for Business y acceso avanzado a `whatsapp_business_management` y `whatsapp_business_messaging`. Los números preverificados exigen ser **Solution Partner**, así que no se usan.
- **Límites:** un portafolio nuevo puede registrar **2 números**; tras verificar el negocio, sube a 20. Meta limita las llamadas de verificación: Omnegia permite 4 por contratación.
- **El nombre visible lo revisa Meta** (`name_status`). Omnegia lo muestra mientras está en revisión.
- **Para mostrar el número como conectado,** Meta tiene que reportarlo como `CONNECTED` en `GET /{id}`. La etapa final exige además un mensaje real recibido.
- **Un número no se puede borrar por API** y tampoco si envió mensajes pagados en los últimos 30 días. Al cancelar, Omnegia hace `deregister` y libera el número en Telnyx.

## 5. Cambios realizados

**Base de datos (`016_numeros.sql`):**
- `numero_contratacion`: máquina de estados, cotización congelada y turno exclusivo del trabajador.
- `numero_evento`: bitácora de solo inserción.
- `numero_credencial`: token de negocio, PIN y código, cifrados con `APP_KEY`. El rol de ejecución no la ve.
- `payment`: columnas `numero_contratacion_id`, `cargo_numero` y `cubre_hasta`.
- RLS en las tres tablas nuevas, columnas de solo metadatos para el operador y prefijo de pagos `NUM-` (activación y mensualidad).

**Backend (`server/src/numeros/`):**
- `proveedor.ts`: abstracción y reglas de elegibilidad.
- `telnyx.ts`: adaptador real, firma Ed25519 y respuesta TeXML.
- `simulado.ts`: inventario de demostración, marcado como tal en la interfaz.
- `tarifas.ts`: modelo comercial con TRM.
- `meta.ts`: Graph API, simulación y extracción del código dictado.
- `servicio.ts`: máquina de estados, pagos, trabajos, ciclo de mensualidades y vista para el panel.

**Integraciones con el sistema existente:**
- `billing.ts`: los pagos `NUM-` usan el mismo webhook de Wompi, con firma, idempotencia, monto exacto y conciliación. No extienden la suscripción.
- `channel.ts`: token de negocio por número.
- `channelInbound.ts`: el primer mensaje recibido completa la prueba.
- `jobs.ts`: trabajos `numero_*` y el ciclo cada 10 minutos.
- Incidentes nuevos para el operador y correo de pago propio del número.

**Rutas:**
- `/api/t/numeros/*` para el panel.
- `/api/webhooks/telnyx`, `/api/webhooks/telnyx/voz` y `/api/webhooks/telnyx/transcripcion`.

**Frontend:**
- `pages/app/NumeroWhatsApp.tsx` y `numeros.css`, en la ruta `/whatsapp/numero`, con entrada en la navegación.
- Accesos desde Configuración › WhatsApp, desde Suscripción (que muestra el cargo separado) y desde el cierre del registro, con la elección «Ya tengo un número / Necesito un número nuevo / Lo decido después».

**Estados.** Se nombran al estilo del proyecto:

| Etapa | Estados |
|---|---|
| Antes del pago | `SELECCION_NUMERO`, `CONFIRMACION_PENDIENTE`, `PAGO_PENDIENTE` |
| Pago | `PAGO_CONFIRMADO` |
| Proveedor | `APROVISIONANDO_NUMERO`, `NUMERO_APROVISIONADO` |
| Meta | `REGISTRO_WHATSAPP_PENDIENTE`, `VERIFICACION_PENDIENTE`, `CONEXION_PENDIENTE`, `CONECTADO` |
| Fallos | `APROVISIONAMIENTO_FALLIDO`, `CONEXION_FALLIDA` |
| Cierre | `CANCELACION_PENDIENTE`, `CANCELADO` |

**Decisiones de diseño:**
- **La compra ocurre dentro del panel, no antes de crear la empresa.** El número tiene que pertenecer a un tenant (aislamiento, titular regulatorio, facturación). El registro ofrece la elección y lleva a ese paso al entrar.
- **Sin cobros automáticos.** Sigue la política vigente de la plataforma: la mensualidad se paga desde el panel con aviso 5 días antes, 7 días de gracia y luego liberación.
- **El primer mes empieza cuando el proveedor entrega el número,** no al pagar. Así los días de revisión de documentos no consumen el mes.
- **Si el número se agota tras el pago,** el cliente elige otro de igual o menor precio sin pagar de nuevo, o pide el reembolso por la vía legal existente.
- **Si el proveedor sube el costo después del pago,** no se compra: queda un incidente para el operador.
- **Fallback de verificación** cuando la transcripción falla: el cliente pide otra llamada, la reenvía a su celular (`<Dial>`) o escribe el código.
- **La corrección automática de documentos rechazados no está implementada.** Hoy se alerta al operador, que corrige en el portal de Telnyx.

## 6. Variables de entorno

Todas están en `server/.env.example`, con su explicación:

- **Telnyx:** `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_TEXML_APP_ID`.
- **Meta:** `META_APP_ID`, `META_ES_CONFIG_ID`. El secreto es el existente `WHATSAPP_APP_SECRET`.
- **Modelo comercial:** `NUMEROS_PAISES`, `NUMEROS_MARGEN_PCT`, `NUMEROS_COLCHON_CAMBIO_PCT`, `NUMEROS_CARGO_ACTIVACION_COP`, `NUMEROS_TASA_USD_COP`, `NUMEROS_GRACIA_DIAS`, `NUMEROS_TARIFAS_CONFIRMADAS`.
- **Tarifas informativas de Meta:** `WHATSAPP_TARIFA_*_COP`.

En producción, el servidor no arranca si falta la llave, la llave pública o la aplicación TeXML de Telnyx. Sin `NUMEROS_TARIFAS_CONFIRMADAS=1` no vende números.

## 7. Configuración externa pendiente

**En Telnyx:**
1. Crear la cuenta y verificarla (KYC).
2. Crear una API key y copiar la Public Key.
3. Crear una aplicación TeXML con Voice URL `https://<api>/api/webhooks/telnyx/voz` (POST).
4. En Notification Settings › Number Orders, configurar el webhook `https://<api>/api/webhooks/telnyx`.
5. Confirmar con `numbering@telnyx.com` los requisitos vigentes de Colombia, en especial si la dirección debe estar en la zona del indicativo, y si los números colombianos reciben llamadas internacionales.

**En Meta:**
1. Obtener el estado de Tech Provider: verificación del negocio y revisión de la app.
2. Crear la configuración de Facebook Login for Business con Embedded Signup y el producto Cloud API (v4).
3. Pedir acceso avanzado a los permisos.
4. Registrar el dominio del panel en los dominios permitidos del SDK de JavaScript.
5. Revisar que la app tenga el webhook `/api/webhooks/whatsapp` con el campo `messages`.

**En lo comercial y lo legal:**
- Definir el margen y el cargo de gestión.
- Confirmar el régimen de IVA (`EMISOR_RESPONSABLE_IVA`).
- Revisar las condiciones de renovación y cancelación con asesoría legal (versión `numeros-2026-10`).
- Revisar la responsabilidad de Omnegia como titular o revendedor del número ante la regulación de telecomunicaciones.

## 8. Pruebas realizadas

`server/test/numeros.test.ts` contiene 18 pruebas de punta a punta sobre PGlite, con inventario simulado y una Meta simulada controlable:

| Escenario | Resultado |
|---|---|
| Compra exitosa: selección, requisitos, pago, número, Meta, verificación por la llamada transcrita, conexión y prueba con respuesta de la IA | ✅ |
| Pago rechazado: vuelve a confirmación, sin orden en el proveedor | ✅ |
| Pago en proceso (`PENDIENTE`) y confirmación posterior | ✅ |
| Número agotado al comprarlo: fallo con alerta, elección de otro número sin segundo cobro | ✅ |
| Error temporal del proveedor: reintento sin orden duplicada | ✅ |
| Error definitivo del proveedor: fallo, alerta y cancelación con reembolso disponible | ✅ |
| Documentos en revisión: webhook del proveedor (duplicado ignorado) y paso directo a verificación cuando ya se registró en Meta | ✅ |
| Verificación pendiente del cliente: llamada sin código, código incorrecto, reenvío de la llamada al celular y código manual | ✅ |
| Fallo de activación en Meta: alerta y reintento exitoso | ✅ |
| Meta todavía no reporta `CONNECTED`: no se muestra conectado; se reintenta | ✅ |
| Reanudación desde otra sesión (navegador cerrado) | ✅ |
| Webhook de pago entregado dos veces: una sola orden y un solo pago aprobado | ✅ |
| Precio manipulado desde el navegador y falta de consentimiento | ✅ rechazados |
| Mensualidad: ventana de 10 días, extensión de un mes y no toca la suscripción | ✅ |
| Cancelación al fin del mes pagado, reversión y liberación en el proveedor y en Meta | ✅ |
| Aislamiento entre empresas y permisos (recepción sin `subscription:manage`) | ✅ |
| Empresa con número propio conectado: no se le vende otro | ✅ |
| Firma Ed25519 válida, inválida y ausente en los webhooks de Telnyx | ✅ |

`server/test/numeros-adaptadores.test.ts` contiene 15 pruebas de la forma exacta de las peticiones a Telnyx y a la Graph API: filtros, cuerpos, errores, que los mensajes no revelen la llave, la firma, TeXML, la extracción del código en cifras y en palabras, el modelo comercial con margen e IVA y la TRM.

La suite completa del servidor, el typecheck de servidor y web y `vite build` pasan. Las pruebas existentes de migraciones y RLS se actualizaron: la de RLS detectó una tabla sin política, y se corrigió.

**Recorrido visual** con Chromium en el servidor de desarrollo, en simulación y con la TRM real: escritorio de 1360 px y móvil de 390 px con movimiento reducido. Recorrió elección, selección, requisitos, resumen, pasarela, activación, registro con Meta, conexión y prueba recibida. No hubo errores de consola ni desplazamiento horizontal.

**No validado:**
- Compras reales en Telnyx: inventario, costos, requisitos de Colombia, órdenes, webhooks reales y su formato de evento.
- La llamada real de Meta y la calidad de la transcripción en español.
- Embedded Signup real.
- Pagos en Wompi de pruebas o de producción para el prefijo `NUM-`. Usan el mismo código ya probado para `SUB-`.
- La prueba con PostgreSQL real (`npm run test:postgres`) no se ejecutó para estos archivos.

## 9. Para habilitar compras reales en producción

1. Completar la sección 7: cuentas, aplicación TeXML, webhooks y estado de Tech Provider con la configuración v4.
2. Configurar las variables de la sección 6 y `NUMEROS_TARIFAS_CONFIRMADAS=1`.
3. **Prueba controlada con Telnyx:** buscar números de Colombia y comparar el `cost_information` con el portal. Comprar **un** número con la empresa de Omnegia y enviar los documentos reales. Confirmar que el webhook `number_order` llega firmado.
4. **Prueba controlada con Meta:** completar Embedded Signup con un portafolio de prueba. Comprobar que la llamada de verificación llega a la aplicación TeXML y que la transcripción entrega el código. Si falla, probar el reenvío al celular y ajustar `transcriptionEngine` o el idioma.
5. Probar el pago en Wompi de pruebas (`WOMPI_ENTORNO=sandbox`) y luego uno real de bajo valor.
6. Liberar el número de prueba y comprobar `DELETE /v2/phone_numbers/{id}` en el portal.
7. Revisar en el panel del operador los incidentes `NUMERO_*` y asignar a una persona responsable.
