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

## 3. Arquitectura

```
WhatsApp → agente de atención → gateway (permisos, riesgo, aislamiento)
  → comercio/herramientas.ts → pedidos.ts ("order" en BORRADOR)
  → cobros.ts (commerce_payment, referencia CP-…)
      · manual: PENDIENTE_CONFIRMACION → una persona confirma en el panel
      · Wompi:  cola cobro_comercio_crear → POST /transactions (Nequi)
                o checkout web firmado (tarjeta, PSE, Bancolombia)
Wompi → POST /api/webhooks/wompi (firma) → billing.procesarEventoPago → CP- → cobros.procesarEventoCobro
  → GET /transactions/{id} (fuente de verdad)
  → aplicarResultado, en una sola transacción de BD: cobro + pedido + ledger + avisos en cola
```

- **Servicio independiente:** `src/comercio/` (metodos, precios, pedidos, cobros, ledger, avisos, operador). Las suscripciones siguen en `modules/billing.ts` y `modules/planes.ts`; solo comparten el cliente de Wompi (`adapters/`), sin cambiar su comportamiento.
- **El tenant nunca viene del webhook:** se resuelve por la referencia `CP-…` guardada en Omnegia.
- **Revisión periódica:** cada 3 minutos se consultan a Wompi los cobros en línea abiertos (por si un webhook se perdió).

## 4. Flujo de compra por WhatsApp

1. El cliente pregunta; la IA usa `consultar_catalogo` o `consultar_precio` (precios oficiales).
2. `crear_pedido` / `agregar_al_pedido`: pedido en `BORRADOR`, precios congelados en `order_item` y configuración de precios congelada en `"order".precio_config`.
3. `elegir_entrega`: recoger o domicilio (con dirección).
4. `calcular_total`: total oficial e importe del cobro. En modo institucional la IA muestra la explicación tal cual.
5. `medios_de_pago` → `elegir_medio_pago` (solo los que la empresa activó).
6. Nequi: `pedir_celular_nequi` (el número del **comprador**, no la cuenta de recaudo).
7. `generar_cobro` (riesgo `confirmable`): el cliente recibe el resumen con el **importe exacto** (y, con Nequi, los enlaces de los términos y de la autorización de datos de Wompi) y responde «SÍ».
8. Se espera la confirmación real (Wompi o el negocio). «Ya pagué» no cambia nada; `estado_pedido` lo explica.
9. Aprobado → pedido `PAGADO` (la orden pasa a `CONFIRMADA` y descuenta inventario) y avisos al cliente y al negocio.

## 5. Métodos de pago

| Modalidad | Medios | Quién confirma |
|---|---|---|
| Manual (`MANUAL`) | Nequi, Daviplata, Bre-B, QR o cuenta bancaria del negocio | Una persona del panel con `payment:register`, con motivo. Puede rechazar o pedir otro comprobante. El comprobante del cliente nunca confirma por sí solo |
| En línea (`MANAGED`) | Nequi por API; tarjeta, PSE y Bancolombia por checkout web firmado | Solo Wompi, consultado servidor a servidor |

**Limitaciones de los pagos manuales:** Omnegia no puede verificar una transferencia a Nequi, Daviplata, Bre-B, QR o cuenta bancaria, porque no hay integración que lo confirme. El estado depende de que una persona del negocio revise su cuenta.

## 6. Proceso de Nequi

1. El cliente confirma el importe → `commerce_payment` en `PENDIENTE_PAGO` (importe congelado) y trabajo en cola.
2. El trabajo pide los tokens de aceptación (`GET /merchants/info`) y crea la transacción (`POST /transactions` con llave privada, firma de integridad y `payment_method: { type: NEQUI, phone_number }`). Reintenta si Wompi falla; agotados los intentos, el cobro queda en `ERROR` y se avisa.
3. Con la transacción creada: `PROCESANDO` y aviso «esperando a la entidad financiera».
4. El cliente aprueba o rechaza en la app de Nequi.
5. Webhook `transaction.updated` → firma verificada → consulta a Wompi → `PAGADO`, `RECHAZADO` o `ERROR`.

## 7. Webhooks e idempotencia

- URL: la misma que ya está configurada en el panel de Wompi para la cuenta del proyecto, `https://<API_PUBLIC_URL>/api/webhooks/wompi`.
- Firma inválida → 401 y auditoría. Un evento de otro ambiente se ignora.
- Siempre se consulta la transacción a Wompi y se verifican referencia, transacción, moneda (`COP`) e importe congelado. Cualquier diferencia → `EN_REVISION` + fila en `payment_reconciliation`, sin aprobar.
- Idempotencia por el estado **consultado** (`wompi:<transacción>:<estado>` en `payment_event`), por el índice único del ledger (cobro, tipo) y por los avisos únicos (tipo, referencia). Un evento repetido no duplica movimientos ni avisos. Si no se pudo consultar a Wompi, el webhook responde 500 para que Wompi reintente.

## 8. Modelo de datos (migración 034)

`"order"` (+ `pedido_estado`, `entrega`, `direccion_entrega`, `precio_config`, `medio_pago`), `order_item` (precios congelados; ya existía), `payment_settings` (+ `pago_manual`, `pago_en_linea`), `merchant_payment_account`, `commerce_payment`, `payment_event`, `financial_ledger` (solo inserción, con disparador) y `payment_reconciliation`. FORCE RLS en todas, FK compuestas `(tenant_id, id)`, índices con `tenant_id` primero y UUID v7.

No se implementa dispersión: no hay tablas `settlement_*`.

## 9. Variables de entorno

| Variable | Defecto | Efecto |
|---|---|---|
| `PAYMENTS_LIVE_ENABLED` | `false` | Habilita los cobros reales en línea. Con `true` exige `PAGOS_PROVEEDOR=wompi`, `WOMPI_ENTORNO=produccion` y las 4 credenciales de producción; con llaves de sandbox el servidor **no arranca** |
| `COMMERCE_PRICING_MODE` | `institutional_test` | `institutional_test` u `official` |
| `COMMERCE_TEST_CHARGE_COP` | `1500` | Importe fijo del modo institucional (entero, mínimo 1.500) |

El servidor arranca en Render con las variables actuales más estas en sus valores por defecto (prueba `test/arranque-render.test.ts`).

## 10. Modo institucional ($1.500) y modo oficial

- **Institucional:** el cliente ve el precio oficial de cada producto y el total oficial; se cobra exactamente `COMMERCE_TEST_CHARGE_COP` por pedido (150.000 centavos con el valor inicial), sin importar el total. El mensaje lo explica: «Este pedido participa en el modo de demostración institucional de Omnegia…». **Es un cobro real** si los pagos reales están habilitados: el modo de precios no es el ambiente de Wompi.
- **Oficial:** se cobra el total oficial completo.
- **Precio del catálogo frente a importe cobrado:** el catálogo nunca se modifica. `commerce_payment` guarda el total oficial, el importe cobrado, el modo, el importe fijo usado, el importe reportado por Wompi, la comisión y el neto. Cambiar el modo global no altera pedidos ni cobros anteriores (configuración congelada).
- Solo el operador de Omnegia cambia el modo (variables del servidor). La empresa lo ve como aviso; la IA y los clientes no pueden cambiarlo.

## 11. Seguridad

- El navegador y la IA nunca envían importes: los esquemas de las herramientas los rechazan y los endpoints los ignoran.
- `payment:register` y `payment:void` siguen prohibidos a los agentes, y ninguna herramienta los usa.
- Un pedido de otro cliente o de otra empresa es «no encontrado» (404 en el panel).
- Las llaves solo viven en el servidor; las respuestas del panel no las incluyen (hay una prueba). Del celular de Nequi solo se guardan los 4 últimos dígitos.
- Ledger de solo inserción: la app no tiene `UPDATE`/`DELETE`, y un disparador lo impide incluso al dueño del esquema.
- Toda acción manual y de conciliación queda auditada con persona, fecha y motivo.

## 12. Conciliación

- La comisión de Wompi no viene en la transacción: el recaudo queda `PENDIENTE_COMISION`. El operador la registra desde **Operador › Recaudos** con el reporte de Wompi (`AJUSTE_COMISION` en el libro; el cobro guarda comisión y neto).
- Las discrepancias se ven en **Ventas › Pagos** y en **Operador › Recaudos**, y el operador las cierra con motivo. Ningún pago se aprueba a mano desde Omnegia.
- La empresa exporta su libro en CSV (`/api/t/pagos/historial.csv`).

## 13. Pruebas

`test/comercio-precios.unit.test.ts`, `test/pagos-comercio.test.ts`, `test/pagos-comercio-cobros.test.ts` y los casos nuevos de `test/arranque-render.test.ts`. Cubren:

- Precios: 80.000 y 200.000 → 1.500; varios productos → un solo cobro; modo oficial → total; configuración congelada.
- Aislamiento por empresa y FORCE RLS.
- Webhook: repetido, firma inválida, referencia, importe o moneda incorrectos, pendiente, rechazado y aprobado.
- Avisos sin duplicar y «ya pagué».
- Credenciales no expuestas, ledger inmutable y conciliación.
- Fallas de Wompi con reintentos, pagos reales apagados por defecto y sandbox rechazado con pagos reales.

Wompi siempre se simula: la suite no hace transacciones reales. Las pruebas de suscripciones y de cobros `PL-` siguen en verde.

## 14. Recaudo propio frente a recaudo para terceros

Esta versión **recauda en la cuenta Wompi del proyecto institucional** y no distribuye fondos a terceros. Para que negocios reales vendan, cada uno debe cobrar con **su propia cuenta** (Wompi del comercio, como ya permite «Vincular cuenta de cobros», o un esquema de subcomercios). Recaudar a nombre de terceros y luego dispersar exige cumplir la regulación colombiana aplicable antes de activarlo.

## 15. Primera prueba real: lista de verificación (en este orden)

> Nada de esto se ha probado con dinero real. No se puede afirmar que Nequi funciona en producción hasta completar esta lista con una transacción autorizada por Brian.

1. **Confirmar con Wompi** el monto mínimo por transacción de Nequi (la documentación no lo publica) y que la cuenta del proyecto tiene Nequi habilitado.
2. **Credenciales de producción en Render:** `PAGOS_PROVEEDOR=wompi`, `WOMPI_ENTORNO=produccion`, `WOMPI_LLAVE_PUBLICA` (`pub_prod_…`), `WOMPI_LLAVE_PRIVADA` (`prv_prod_…`), `WOMPI_SECRETO_INTEGRIDAD` y `WOMPI_SECRETO_EVENTOS`. Ya existen para las suscripciones: revisa que sean las de producción.
3. **URL del webhook en el panel de Wompi** (Desarrolladores › URL de eventos): `https://<API_PUBLIC_URL>/api/webhooks/wompi`, la misma de las suscripciones.
4. **Desplegar** con la migración 034 y comprobar `/api/salud/listo`.
5. **`PAYMENTS_LIVE_ENABLED=true`** en Render, con `COMMERCE_PRICING_MODE=institutional_test` y `COMMERCE_TEST_CHARGE_COP=1500`. Redesplegar; si arranca, la configuración es coherente.
6. En el panel de la empresa de prueba: **Ventas › Métodos de pago** → activar «Pago en línea».
7. Desde un celular con Nequi: escribir al WhatsApp del negocio, pedir un producto, elegir recoger, elegir Nequi, dar el celular y el correo, y responder «SÍ» al resumen de **$1.500**.
8. Aprobar la notificación en la app de Nequi.
9. Verificar:
   - el mensaje «¡Tu pago fue confirmado!» en WhatsApp;
   - **Ventas › Pedidos** en «Aprobado»;
   - **Ventas › Pagos** con el importe reportado de $1.500;
   - **Operador › Recaudos** con el recaudo;
   - el correo al negocio.
10. Con el reporte de Wompi, registrar la comisión real en **Operador › Recaudos**.
