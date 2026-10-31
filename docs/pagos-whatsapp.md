# Pagos de comercio por WhatsApp

> **Nota legal (léase primero).** En esta versión los pagos en línea llegan a la **cuenta Wompi del proyecto
> institucional de Omnegia**. No hay recaudo ni dispersión de dinero para terceros. Antes de usarlo con negocios
> reales, **cada comercio debe cobrar con su propia cuenta** (cuenta conectada o subcomercio): recaudar dinero a
> nombre de terceros tiene implicaciones regulatorias en Colombia (actividad de recaudo y pagos, obligaciones
> tributarias y de prevención de lavado). Mientras tanto, el módulo es una demostración institucional con cobros
> reales controlados.

## 1. Lo que ya existía y cómo se relaciona (Fase 1)

| Pedido original («Commerce Payments») | En el repositorio | Decisión |
|---|---|---|
| `orders`, `order_items` | `"order"` y `order_item` (ventas del panel y de la IA). `"order".estado` ya admite `BORRADOR` | **Se extiende** `"order"`: un pedido de WhatsApp nace en `BORRADOR` (no cuenta como venta ni mueve inventario) y se confirma al pagarse. Columnas nuevas: entrega, dirección, configuración de precios congelada, estado del pedido. No se crea una tabla paralela |
| `commerce_payments` | `payment` es de **suscripciones** (referencias `SUB-`/`NUM-`); `payment_link` + `order_payment` son cobros con la cuenta propia del comercio (`PL-`) | **Tabla nueva** `commerce_payment` (referencias `CP-`). Mezclarla con `payment` rompería la separación con las suscripciones |
| `payment_events` | `provisioning_event` (idempotencia del webhook de la plataforma) | **Tabla nueva** `payment_event` para los eventos de `CP-` (con el tenant resuelto por Omnegia) |
| `financial_ledger`, `payment_reconciliation` | No existen | **Nuevas.** El ledger es solo de inserción (un disparador impide editar o borrar) |
| `payment_settings` | Existe (efectivo, transferencia, datáfono del punto de venta) | **Se extiende** con `pago_manual` y `pago_en_linea` |
| `merchant_payment_accounts` | `merchant_gateway_account` es la cuenta Wompi propia del comercio (llave cifrada) | **Tabla nueva** `merchant_payment_account` para los datos de pago manual (Nequi, Daviplata, Bre-B, QR, cuenta bancaria) |
| Cliente Wompi | `adapters/payments.ts` (firma de integridad, verificación de eventos, consulta de transacciones) y `adapters/wompiDirecto.ts` (tokens de aceptación con `GET /merchants/info`, `POST /transactions` con NEQUI/PSE/CARD/BANCOLOMBIA_TRANSFER) | **Se reutiliza sin cambiar su comportamiento.** El servicio de comercio (`modules/pagosComercio.ts`) es independiente del de suscripciones (`modules/billing.ts`) |
| Webhook `transaction.updated` | `POST /api/webhooks/wompi` (cuenta de la plataforma) ya enruta por prefijo: `PL-` → cobros de ventas | Wompi envía **todos** los eventos de una cuenta a una sola URL. Como los cobros de comercio usan la misma cuenta del proyecto, el mismo webhook enruta `CP-` → `pagosComercio`. No hace falta configurar otra URL en Wompi |
| Herramientas del agente | `consultar_catalogo`, `consultar_precio`, `registrar_venta`, `generar_enlace_pago` | Se reutilizan `consultar_catalogo` (buscar) y `consultar_precio` (detalle). Nuevas, en español: `crear_pedido`, `agregar_al_pedido`, `calcular_total`, `elegir_entrega`, `medios_de_pago`, `elegir_medio_pago`, `pedir_celular_nequi`, `generar_cobro`, `estado_pedido` |
| Notificaciones | `modules/proactivo.ts › avisar`: ventana de 24 h → plantilla aprobada → correo → «no enviado» visible | **Se reutiliza** con tipos nuevos de aviso (`PAGO_CONFIRMADO`, `PAGO_RECHAZADO`, `PAGO_EN_ESPERA`) |
| Confirmación del cliente | Gateway de IA: riesgo `confirmable` pide «SÍ» al cliente con el resumen de la acción | `generar_cobro` es `confirmable` y su resumen incluye el **importe exacto** que se cobrará |
| Permisos | `payment:register` y `payment:void` están en `PERMISOS_PROHIBIDOS_A_AGENTES` | Se mantienen. El agente crea pedidos (`order:create`) y cobros (`payment:link`), nunca aprueba ni registra pagos |
| Interfaz | Sección **Ventas** con pestañas Vender / Historial / Comprobantes | Se añaden pestañas **Pedidos**, **Pagos** (transacciones e historial financiero) y **Métodos de pago**. El modo de precios es del operador: panel del operador › Recaudos |

## 2. Wompi: lo confirmado en la documentación oficial (31-oct-2026)

Fuentes: [Métodos de pago](https://docs.wompi.co/docs/colombia/metodos-de-pago/), [Transacciones](https://docs.wompi.co/docs/colombia/transacciones/), [Eventos](https://docs.wompi.co/docs/colombia/eventos/), [Widget y checkout](https://docs.wompi.co/docs/colombia/widget-checkout-web/), [Tokens de aceptación](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/).

- **Nequi:** `POST /v1/transactions` con `payment_method: { type: "NEQUI", phone_number: "<10 dígitos>" }`. El cliente aprueba una notificación en la app; el estado se consulta con `GET /v1/transactions/{id}` hasta que deja de ser `PENDING` (`APPROVED`, `DECLINED`, `ERROR`).
- **Campos obligatorios de la transacción:** `acceptance_token`, `amount_in_cents`, `currency`, `customer_email`, `payment_method`, `reference`, `signature`.
- **Tokens de aceptación:** `GET /v1/merchants/info` con la cabecera `x-merchant-public-key`. `presigned_acceptance.acceptance_token` va en `acceptance_token` y `presigned_personal_data_auth.acceptance_token` en `accept_personal_auth`. El cliente debe aceptar ambos documentos (se le envían sus enlaces). El endpoint antiguo `GET /merchants/:llave` deja de existir el **31-oct-2026**; el repositorio ya usa el nuevo.
- **Autorización:** la página de transacciones indica usar la **llave privada** como Bearer en `POST /transactions` y en `GET /transactions/{id}`. El módulo de comercio crea las transacciones con la llave privada.
- **Firma de integridad:** SHA-256 de `<referencia><monto en centavos><moneda><secreto de integridad>` (con fecha de expiración entre moneda y secreto si se usa).
- **Eventos:** se concatenan los valores de `signature.properties` (en orden), luego `timestamp` y el secreto de eventos; SHA-256; se compara con `signature.checksum` (o la cabecera `X-Event-Checksum`). Responder `200`; Wompi reintenta 3 veces en 24 horas.
- **PSE:** banco (`/v1/pse/financial_institutions`), `user_type`, `user_legal_id_type`, `user_legal_id`, `financial_institution_code`, `payment_description`; redirección a `payment_method.extra.async_payment_url`.
- **Tarjetas:** exigen tokenizar en el navegador (`/v1/tokens/cards`). Por WhatsApp no se piden datos de tarjeta: tarjeta, PSE y Bancolombia se pagan en el **checkout web de Wompi** (enlace firmado).
- **Comisión de Wompi:** el objeto de la transacción no la incluye. Se guarda `null` y la conciliación la completa con el reporte del panel de Wompi.

### Monto mínimo por transacción

**La documentación oficial no publica un monto mínimo.** Fuentes de terceros (agregadores) citan **1.500 COP** para tarjetas y piden que Bancolombia Transfer sea **mayor** que 1.500 COP. Por eso:

- `COMMERCE_TEST_CHARGE_COP` admite como mínimo **1.500** (el mismo piso que ya usa la modalidad institucional de suscripciones, que cobra 1.500 COP en producción).
- Con 1.500 exactos, **Bancolombia Transfer podría rechazarse**: el modo institucional no lo ofrece salvo que el cobro sea mayor que 1.500.
- Confírmalo con soporte de Wompi antes de la primera prueba real.
