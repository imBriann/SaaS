# Ventas · mejoras futuras

## Dos medios de pago en una misma venta (no implementado)

Hoy una venta se paga **completa con un solo medio** o queda «por cobrar». No hay abonos ni pagos combinados
(por ejemplo, 30.000 en efectivo y el resto por transferencia). La interfaz no ofrece esa opción.

Por qué no se hizo en esta entrega: el modelo garantiza un único pago vigente por venta
(`ux_order_payment_vigente` en `order_payment`) y de esa regla dependen la anulación de pagos, la caja del día,
el estado `estado_pago` y la conciliación con la pasarela. Combinar medios exige:

1. Migración: quitar el índice único y permitir varios `REGISTRADO` cuya suma cubra el total; estado `PARCIAL`.
2. `registrarPago`: aceptar montos parciales (con el cambio solo sobre la parte en efectivo).
3. Anulación: anular un pago parcial devuelve la venta a `PARCIAL` o `POR_COBRAR`.
4. Caja del día y exportes: sumar por pago, no por venta.
5. Enlaces de pago: cobrar solo el saldo pendiente.
6. Pruebas en PostgreSQL real de concurrencia (dos pagos simultáneos que juntos superan el total).
