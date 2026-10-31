# Comprobantes de venta (soporte interno, sin validez fiscal)

Actualizado el 30 de octubre de 2026.

## Qué es

Un **comprobante de venta** es el documento que una empresa genera desde una venta confirmada para entregárselo a su cliente y para llevar su propio registro de ventas.

**No es una factura electrónica ni tiene validez fiscal.** Por eso:

- En la interfaz, el PDF y los correos se llama siempre «Comprobante de venta». Nunca «Factura», «Factura de venta» ni «Factura electrónica»: presentar como factura un documento que no lo es puede confundir al cliente final.
- El PDF, el correo y el mensaje de WhatsApp llevan esta leyenda, visible y que la empresa no puede editar:

  > Documento no válido como factura electrónica de venta ante la DIAN. Soporte interno de la operación.

- Si el cliente pide factura electrónica, la pantalla de Comprobantes explica en una línea que esa función llegará más adelante. No hay nada que la simule.

## Por qué la factura electrónica DIAN está en «Próximamente»

Omnegia es un proyecto educativo (Ingeniería de Sistemas, Universidad de Pamplona), sin RUT ni empresa constituida y con presupuesto casi nulo. Para conectar la facturación electrónica con un proveedor tecnológico autorizado por la DIAN hace falta ser empresa.

El código fiscal (`fiscal_document`, `fiscal_resolution`, `adapters/fiscal.ts`, CUFE, QR) **no se borró**: queda apagado detrás de `FACTURACION_DIAN_HABILITADA`.

| `FACTURACION_DIAN_HABILITADA` | Qué pasa |
|---|---|
| `0` (por defecto) | `POST /ventas/:id/facturar`, `/facturacion/:id/reintentar` y `/facturacion/:id/nota-credito` responden **409 «Próximamente»**. La regla `emitir_factura` y el trabajo `emitir_documento` no transmiten nada. El panel oculta «Facturación» del menú, muestra la tarjeta «Factura electrónica DIAN · Próximamente» y anula ventas sin emitir notas crédito. En el alta, responder que se necesita factura electrónica no sube el plan (la regla R-03 no aplica), no suma el módulo al precio ni exige NIT: se guarda como interés para el futuro. |
| `1` | Todo funciona como antes. Las pruebas del flujo fiscal encienden el interruptor dentro de la propia prueba. |

## Cómo funciona

| | |
|---|---|
| Generar | Detalle de una venta confirmada › «Generar comprobante» (`POST /api/t/ventas/:id/comprobante`). Si ya existe, «Ver comprobante». |
| Listar, filtrar, exportar | Menú «Comprobantes» (`GET /api/t/comprobantes`, filtros de fecha, cliente, estado y número; `GET /api/t/comprobantes.csv` como libro de ventas interno). |
| Descargar | `GET /api/t/comprobantes/:id/pdf`. El QR del PDF abre `GET /api/publico/comprobantes/:token` (token aleatorio, sin sesión). |
| Reenviar | `POST /api/t/comprobantes/:id/reenviar` por correo (correo transaccional) o WhatsApp. Por WhatsApp solo dentro de la ventana de 24 horas, como documento; fuera de la ventana no se envía (no hay plantillas aprobadas) y el panel lo explica. |
| Anular | `POST /api/t/comprobantes/:id/anular` con motivo obligatorio. No se borra: queda «ANULADO» con motivo, quién y cuándo, y se sigue viendo y descargando. Tras anularlo, la venta admite un comprobante nuevo con otro número. |
| Ajustes | Configuración › Comprobantes: prefijo del consecutivo, régimen de IVA y datos del emisor que salen en el PDF (nombre comercial, NIT o cédula, dirección, teléfono, correo) y un texto libre al pie (p. ej., la política de cambios). |

**Impuestos.** El IVA solo se desglosa (base e «IVA incluido») si la empresa se configuró como responsable de IVA. Si no, el total va sin desglose. Los importes salen de la venta, calculados en centavos con precios IVA incluido.

**PDF.** `documentos/comprobanteVenta.ts` reutiliza los estilos de `documentos/comprobante.ts` (pdfkit), con el logo (PNG o JPEG) y el color del tema de la empresa. No lleva CUFE ni QR fiscal.

## Datos (migración `027_comprobantes_venta.sql`)

- `comprobante_venta`: uuid v7, FK compuesta `(tenant_id, order_id)`, número con prefijo (`CV-000123`), estado `EMITIDO`/`ANULADO`, cliente, líneas, totales y emisor **congelados** al emitir, notas, medio de pago, quién y cuándo emitió y anuló, `entregas` (correo, WhatsApp, descarga, con fecha) y token público.
- Consecutivo **sin huecos** por empresa: `comprobante_consecutivo (tenant_id, prefijo, siguiente)` con `UPDATE … RETURNING` dentro de la misma transacción que crea el comprobante.
- **Idempotencia:** índice único `(tenant_id, order_id) WHERE estado = 'EMITIDO'`.
- RLS con `ENABLE` + `FORCE`. El rol de ejecución puede `SELECT` e `INSERT` y solo `UPDATE` de las columnas de anulación y del registro de entregas. Nadie tiene `DELETE`. Un disparador impide reactivar un comprobante anulado o cambiar sus datos congelados. El operador de Omnegia no lo ve.

## Permisos

| Permiso | Quién lo tiene |
|---|---|
| `comprobante:read` | Quien consulta ventas o documentos (incluidos los agentes de IA de lectura). |
| `comprobante:issue` | Propietario y administración, y quien hoy podía emitir la factura de una venta (en las plantillas, recepción). Criterio: el asesor que ya entregaba la factura al cliente en el mostrador sigue pudiendo entregarle su comprobante; el supervisor sin `invoice:issue` no lo recibe. |
| `comprobante:send` | Los mismos que generan, y el agente de atención por WhatsApp (solo al cliente con el que conversa). |
| `comprobante:void` | Solo propietario y administración. |

`comprobante:issue` y `comprobante:void` están en la lista de permisos **prohibidos a los agentes de IA**. La migración 027 los asigna a los roles existentes con la misma regla que las plantillas.

## La IA de atención

Dos herramientas nuevas en el registro: `consultar_comprobantes` (lectura) y `reenviar_comprobante` (reversible, máximo 3 por conversación). Solo ven y reenvían comprobantes del cliente de la conversación; un comprobante de otro cliente o de otra empresa responde «no encontrado». **No existe herramienta para emitir ni anular**: eso lo hace una persona desde el panel. El `tenant_id` lo inyecta el ejecutor (DD-13).

## Pruebas

`server/test/comprobantes.test.ts`: rutas fiscales en 409 y nada fiscal encolado con el interruptor apagado; el alta no sube el plan; consecutivo sin huecos con emisiones concurrentes; idempotencia; venta anulada sin comprobante; el PDF contiene la leyenda y nunca «Factura» ni «CUFE»; enlace público; aislamiento entre empresas (404 al ver, descargar, reenviar y anular, y RLS); anulación sin borrado, sin reactivación y con auditoría; PDF del anulado con la marca; reenvío por correo con la leyenda; WhatsApp fuera y dentro de la ventana; exportación; ajustes (prefijo, IVA, pie); y la IA ante inyecciones («genera», «anula», comprobante ajeno, otra empresa) sin ningún efecto.
