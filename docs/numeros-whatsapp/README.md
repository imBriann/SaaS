# Compra y activación de números de WhatsApp desde Omnegia

> **Actualización del 24 de octubre de 2026.** La forma principal de conectar WhatsApp es ahora «Usar mi propio número» (sección 10): SMS y listo, sin entrar a Meta. La compra con Telnyx queda en el código, intacta, y se muestra como «Próximamente» mientras `NUMEROS_COMPRA_HABILITADA=0`.

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

---

## 10. Usar mi propio número (forma principal desde el 24 de octubre de 2026)

**Resumen honesto.** Es la forma principal de conectar WhatsApp. La empresa escribe su número, recibe un código por SMS (o una llamada), lo escribe en Omnegia y queda conectada a la IA. **Nunca entra a Meta, Facebook ni Meta Developers.** El flujo funciona en simulación y lo cubren pruebas automáticas, pero **no se ha validado contra Meta real**: este entorno no tiene el token ni la WABA de producción. La compra de números con Telnyx sigue en el código, sin cambios, y el panel la muestra como «Próximamente» mientras `NUMEROS_COMPRA_HABILITADA=0`.

### Cómo funciona

El número se registra dentro de la cuenta de WhatsApp Business (WABA) **de Omnegia**, no en una cuenta de la empresa. Omnegia usa el token del usuario del sistema que ya tiene (`WHATSAPP_ACCESS_TOKEN`) y la WABA de `WHATSAPP_PLATFORM_WABA_ID`. Cada llamada sigue la [guía oficial de registro de números](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/registering-phone-numbers/):

| Paso | Llamada a la Graph API | Estado en Omnegia |
|---|---|---|
| 1. La empresa escribe país y número, y acepta el aviso | `POST /{WABA}/phone_numbers` con `cc`, `phone_number` y `verified_name` (el nombre del negocio) → `id` | `NUMERO_INGRESADO` |
| 2. Código | `POST /{id}/request_code?code_method=SMS&language=es` («Prefiero una llamada» usa `VOICE`) | `CODIGO_ENVIADO` |
| 3. La empresa escribe el código | `POST /{id}/verify_code?code=…` | `CODIGO_VERIFICADO` |
| 4. Registro | `POST /{id}/register` con `messaging_product=whatsapp` y un PIN de 6 dígitos generado por el servidor, guardado cifrado con `APP_KEY` en `numero_credencial` | `REGISTRADO` |
| 5. Comprobación y vinculación | `GET /{id}?fields=…`. Con `status=CONNECTED`, se guarda `phone_number_id` en el tenant | `CONECTADO` |
| Desconectar | `POST /{id}/deregister` y se libera el `phone_number_id` | `CANCELADO` |

Si falla, el estado pasa a `CONEXION_FALLIDA`. Es la misma tabla `numero_contratacion`, con `origen='PROPIO'`: sin pago, sin Telnyx y sin cotización (migración `026_numero_propio.sql`). El registro y la conexión se intentan en la misma petición. Si Meta tarda o limita, el trabajador reintenta (`numero_propio`) y la empresa ve «Conectando…».

**Mensajes entrantes.** Meta envía los webhooks a la app suscrita a la WABA (`subscribed_apps`). Como todos los números quedan en la WABA de Omnegia, sus mensajes llegan a `/api/webhooks/whatsapp` sin configurar nada por empresa. `channelInbound` resuelve la empresa por `tenant.whatsapp_phone_number_id` y los entrega a su IA, igual que antes. El canal responde con el token de la plataforma.

**Reglas y seguridad.**
- Permiso `tenant:configure`. Recepción no puede. Cada consulta pasa por la RLS del tenant.
- Máximo 5 intentos de código por proceso. Al quinto fallo se cierra el proceso y hay un bloqueo de 60 minutos. Máximo 3 reenvíos por hora, con 60 s de espera entre uno y otro.
- Meta no documenta cuánto dura el código: Omnegia lo da por vencido a los 10 minutos y pide otro.
- Cada intento queda en `numero_evento` y en la auditoría, sin el código ni el PIN.
- Una empresa con un número conectado (por este flujo o en Configuración › WhatsApp) no puede iniciar otro.
- Si Meta responde que la WABA alcanzó su límite de números, se crea el incidente `NUMERO_LIMITE_WABA` (gravedad crítica) para el operador.
- Un proceso abandonado antes de verificar se cierra solo a las 48 horas.

**Simulación.** Con `SIMULADORES` (desarrollo), la Meta simulada acepta el código `123456`. Los cuatro últimos dígitos del número fuerzan errores: `0001` número ya en WhatsApp, `0002` límite de la WABA, `0003` nombre rechazado y `0004` número inválido.

### Qué configura Omnegia una sola vez en Meta

1. **WABA de la plataforma.** En el Administrador comercial de Omnegia, la cuenta de WhatsApp Business donde vivirán los números de las empresas. Copia su identificador en `WHATSAPP_PLATFORM_WABA_ID`.
2. **Usuario del sistema.** Su token permanente (`WHATSAPP_ACCESS_TOKEN`) necesita `whatsapp_business_management`, además de `whatsapp_business_messaging`, y acceso a esa WABA.
3. **Suscripción de la app a la WABA** (`POST /{WABA}/subscribed_apps`) y webhook de la app con el campo `messages`. Si el número de Omnegia (`WHATSAPP_PLATFORM_PHONE_NUMBER_ID`) ya recibe mensajes en esa misma WABA, este paso está hecho.
4. **Verificación del negocio de Omnegia.** Sin verificar, el portafolio admite pocos números (la documentación de Meta habla de 2). Verificar el negocio, y pedir más si hace falta, es lo que permite atender a muchas empresas.
5. **Método de pago en la WABA**, porque Meta cobra las plantillas a Omnegia (ver costos).

En producción, si existe `WHATSAPP_ACCESS_TOKEN` y falta `WHATSAPP_PLATFORM_WABA_ID`, **el servidor no arranca**. Configura la variable antes de desplegar.

### Costos

- **Omnegia no cobra mensualidad** por conectar un número propio. Tampoco hay costo de número, porque la empresa pone su chip.
- **Meta cobra a Omnegia,** como dueña de la WABA, las plantillas que inicie el negocio, por mensaje entregado y según su categoría (marketing, utilidad, autenticación).
- **Responder dentro de las 24 horas** siguientes al mensaje del cliente no tiene cargo de Meta.
- Falta una decisión comercial: cómo trasladar a cada empresa el costo de sus plantillas. Hoy no se le factura.

### Riesgos

- **El número deja de funcionar en la app de WhatsApp del celular.** El panel lo advierte y pide confirmarlo. Recomendamos un chip nuevo para el negocio.
- **Revisión del nombre visible.** Meta revisa el nombre (`name_status`). Mientras está `PENDING_REVIEW`, el panel lo muestra sin alarmar. Si Meta lo rechaza (`DECLINED`), pide escribir a soporte.
- **Límite de números de la WABA.** Hasta verificar el negocio de Omnegia, unas pocas empresas agotan el cupo. El incidente avisa al operador.
- **Calidad compartida.** Todos los números viven en la WABA de Omnegia. El mal uso de una empresa (spam, bloqueos) puede afectar a la cuenta y, con ella, a las demás. Conviene vigilar `quality_rating` y tener una política de uso.
- **Titularidad.** Omnegia administra el número en su WABA. Si la empresa se va, el número se desconecta (`deregister`) y puede volver a la app. Revisar con el abogado cómo queda en los términos.
- **Números no se borran por API.** Tras desconectar, el número sigue listado en la WABA (sin registrar). Si se vuelve a conectar, Omnegia intenta recuperar su identificador cuando Meta responde que ya está en la cuenta (2388012); falta confirmar que ese es el código real en este caso.

### Qué quedó sin validar contra Meta real

- **Ninguna llamada se ha hecho contra la Graph API real.** Las pruebas comprueban la forma de cada petición con un `fetch` falso.
- **Idioma del código:** la referencia describe `language` como un código de dos letras (`en`), pero su ejemplo usa `en_US`. Omnegia envía `es`. Falta confirmar que el SMS y la llamada llegan en español (TODO en `meta.ts`).
- **Códigos de error:** Meta documenta `136024` (ya verificado), `133016` y `133008` (demasiados intentos), `133005` (PIN) y `2388012` (ya está en la cuenta). **No documenta** un código para número ya en uso, número inválido, código incorrecto o vencido, límite de números ni nombre rechazado. Para esos casos Omnegia clasifica el texto del error (`motivoRegistro`, TODO en `meta.ts`). Hay que registrar los códigos reales en la primera prueba y reemplazar las heurísticas.
- **Vigencia del código:** Meta no la documenta. Los 10 minutos son una regla de Omnegia.
- **Límite exacto de números** de la WABA de Omnegia y el texto del error cuando se alcanza.
- **Que un número nuevo de la WABA reciba mensajes** en el webhook sin pasos adicionales (es lo esperado según la suscripción por WABA, pero no se probó).
- **Números que venían de otro proveedor** con verificación en dos pasos: se informa `PIN_EXISTENTE`, pero no se probó el caso real.

**Prueba controlada recomendada.** Con un chip nuevo de Omnegia: conectarlo desde una empresa de prueba, anotar cada respuesta de Meta, escribirle desde otro celular, comprobar la respuesta de la IA y desconectarlo. Repetir con un número que siga en la app de WhatsApp, para capturar el error real de «número en uso».

## 11. Vincular el número desde el panel, sin código (desde el 30 de octubre de 2026)

**Decisión.** Omnegia no es todavía empresa constituida ni Tech Provider de Meta. Por eso el **único camino activo** es que el número quede en la WABA de Omnegia (`WHATSAPP_PLATFORM_WABA_ID`) y se vincule a la empresa desde el panel. Nadie toca código, `.env` ni Meta Developers para conectar un número.

| Opción en «Conectar WhatsApp» | Estado | Interruptor |
|---|---|---|
| Usar mi propio número (SMS o llamada) | Activa | — |
| Comprar un número nuevo (Telnyx) | Próximamente | `NUMEROS_COMPRA_HABILITADA=0` |
| Conectar mi propia cuenta de WhatsApp Business (registro integrado) | Próximamente | `WHATSAPP_CUENTA_PROPIA_HABILITADA=0` |

El código de la compra y del registro integrado sigue en el repositorio, apagado.

### Para la empresa: una sola pantalla «Conectar WhatsApp»

- El campo «Identificador del número (phone_number_id)» **ya no aparece**. En demostración queda un bloque «Opciones avanzadas (demostración)», cerrado por defecto, que solo acepta identificadores `sim-…`. La API rechaza un identificador real escrito por la empresa (`PATCH /api/t/configuracion/empresa` responde 400): así una empresa no puede tomar un número de la WABA que no es suyo.
- **Estado siempre visible** (`GET /api/t/numeros/whatsapp`): «Sin conectar», «Esperando el código», «Conectando…», «Conectado: +57 322 750 0767 · Patitas del Zulia», «Desconectado» y «Necesita atención» (con qué hacer).
- **Probar conexión** (`POST /api/t/numeros/whatsapp/probar`): envía un mensaje de prueba al celular que indique la persona. Sin plantillas aprobadas, WhatsApp solo deja escribir a quien escribió en las últimas 24 horas; si no, el panel explica que escriba primero «hola» desde ese celular.
- **Desconectar** (`POST /api/t/numeros/whatsapp/desconectar`, escribiendo DESCONECTAR): hace `deregister` y deja el número libre. Si se conectó con «Usar mi propio número», lo hace ese flujo.
- «Usar mi propio número» termina siempre con `register` y una comprobación `GET /{id}` en `CONNECTED`. Guarda `whatsapp_phone_number_id`, `whatsapp_estado` y `whatsapp_numero_visible` sin que la persona escriba ningún identificador.

### Para el operador: «Números de WhatsApp» (`/operador/numeros`, rol ADMIN)

`numeros/plataforma.ts` y `/api/operador/numeros/*`. Permiso de operador `numeros:gestionar` (solo ADMIN; SOPORTE recibe 403).

| Acción | Llamada a Meta | Qué cambia en Omnegia |
|---|---|---|
| Ver la lista (en vivo) | `GET /{WABA}/phone_numbers?fields=id,display_phone_number,verified_name,status,code_verification_status,name_status,quality_rating,platform_type` | Nada. Se cruza con `tenant.whatsapp_phone_number_id` (asignado o libre) y con los procesos «propio» en curso. El número de `WHATSAPP_PLATFORM_PHONE_NUMBER_ID` sale como **reservado** y no se asigna. |
| Asignar a una empresa (buscador por nombre o subdominio) | Ninguna | `tenant.whatsapp_phone_number_id`, `whatsapp_estado`, `whatsapp_numero_visible`. Un número, una empresa (`UNIQUE` de 001). `channelInbound` resuelve la empresa en cada mensaje: vale desde el siguiente mensaje, sin reiniciar. |
| Registrar en la API (verificado, pero `status ≠ CONNECTED` o `platform_type ≠ CLOUD_API`) | `POST /{id}/register` con PIN aleatorio de 6 dígitos y luego `GET /{id}` hasta ver `CONNECTED` | PIN cifrado con `APP_KEY` en `numero_credencial_plataforma` (migración 028), guardado **antes** de llamar a Meta. |
| Ver PIN | Ninguna | Pide motivo y queda en `auditoria_plataforma` (sin el PIN). |
| Enviar código / verificar (número sin verificar) | `request_code` (SMS o VOICE) y `verify_code` | Nada (auditoría). |
| Agregar número a la WABA | `POST /{WABA}/phone_numbers`. **Antes** se compara con `WHATSAPP_WABA_LIMITE_NUMEROS` (2 con el portafolio sin verificar): si se alcanzó, se explica y **no se llama a Meta**. | Nada (auditoría). |
| Desasignar | Ninguna (no desregistra) | El número queda libre. |
| Desregistrar (escribiendo DESREGISTRAR) | `POST /{id}/deregister` | El número queda libre y la empresa, si la tenía, pasa a «Desconectado». |

**Por qué el PIN no va en `numero_credencial`.** Esa tabla (016) exige una contratación y una empresa. Un número de la WABA puede estar libre, así que su PIN vive en `numero_credencial_plataforma`, solo al alcance del rol de plataforma (ni `app_rt`, ni `app_operador`, ni `app_soporte`).

**El camino manual nunca deja un número a medias.** `verificarWhatsapp` (botón «Comprobar estado» y trabajo `verificar_whatsapp`) pide ahora `status` y `platform_type`. Un número verificado pero no registrado queda `PENDIENTE_REGISTRO`, la empresa ve «Necesita atención» y el operador, «Registrar en la API». Nunca se muestra como conectado.

**Errores de Meta** traducidos con `motivoRegistro` y `mensaje` de `propio.ts`. Ningún token ni PIN aparece en respuestas, registros ni en el frontend.

### Qué debe hacer el operador con el número de Patitas del Zulia

El +57 322 750 0767 (identificador 1444821255372205) se agregó y registró a mano el 30 de octubre desde el Graph API Explorer. No está en el código, las semillas ni las migraciones.

1. Entrar al panel del operador con una cuenta ADMIN › **Números de WhatsApp**.
2. El número aparece «Conectado · sin asignar».
3. **Asignar** › buscar «Patitas» › elegir la empresa › Asignar.
4. Desde ese momento sus mensajes los atiende la IA de Patitas del Zulia. En el panel de la empresa se ve «Conectado: +57 322 750 0767 · Patitas del Zulia». Para comprobarlo, alguien escribe «hola» al número y la empresa usa «Probar conexión» con ese celular.

### Pruebas

`server/test/numeros-waba.test.ts` (Meta simulada): lista en vivo, número reservado, aislamiento (la empresa recibe 404 en `/api/operador/numeros` y 400 si escribe un identificador real), SOPORTE sin permiso, asignación y doble asignación (409 con el nombre de la otra empresa), mensajes que llegan a la empresa asignada sin reiniciar, desasignación sin `deregister`, camino manual con número `PENDING` → `PENDIENTE_REGISTRO` y la acción «registrar», registro con PIN cifrado que no aparece en respuestas, consola ni auditoría, «Ver PIN» con motivo, alta → código → verificación → registro → asignación → desasignación → desregistro, límite de la WABA sin llamar a Meta, y el panel de la empresa (opciones, prueba con ventana de 24 horas y desconexión).

**Sigue sin validar contra Meta real** lo de la sección 10, más el listado `GET /{WABA}/phone_numbers` y el tiempo que tarda un número en pasar a `CONNECTED` después de `register`.
