-- =====================================================================
-- 013 · Pagos de las ventas
--
-- Un solo registro para cómo se pagó cada venta: efectivo, transferencia o
-- datáfono (los registra una persona del negocio) y pasarela (lo confirma
-- Wompi con su evento firmado). No hay pagos parciales ni abonos: una venta
-- queda pagada con UN pago vigente por su total. Un pago no se borra: se anula
-- con motivo y queda el historial. Aditiva: no cambia ventas existentes.
-- =====================================================================

CREATE TABLE order_payment (
  id                     uuid PRIMARY KEY,
  tenant_id              uuid NOT NULL REFERENCES tenant(id),
  order_id               uuid NOT NULL,
  metodo                 text NOT NULL CHECK (metodo IN ('EFECTIVO','TRANSFERENCIA','DATAFONO','PASARELA')),
  -- Valor aplicado a la venta (su total).
  monto                  numeric(14,2) NOT NULL CHECK (monto > 0),
  -- Efectivo: lo que entregó el cliente y el cambio devuelto.
  recibido               numeric(14,2),
  cambio                 numeric(14,2) NOT NULL DEFAULT 0 CHECK (cambio >= 0),
  -- Comprobante de la transferencia, aprobación del datáfono o referencia de la pasarela.
  referencia             text,
  payment_link_id        uuid,
  -- EXCEDENTE: la pasarela confirmó un pago de una venta que ya estaba pagada (hay que devolverlo).
  estado                 text NOT NULL DEFAULT 'REGISTRADO' CHECK (estado IN ('REGISTRADO','ANULADO','EXCEDENTE')),
  origen                 text NOT NULL CHECK (origen IN ('PANEL','PASARELA')),
  registrado_por         uuid,
  registrado_por_nombre  text NOT NULL,
  clave_idempotencia     text,
  creado_en              timestamptz NOT NULL DEFAULT now(),
  anulado_en             timestamptz,
  anulado_por            uuid,
  anulado_por_nombre     text,
  motivo_anulacion       text,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id),
  CONSTRAINT order_payment_recibido CHECK (recibido IS NULL OR (metodo = 'EFECTIVO' AND recibido >= monto)),
  CONSTRAINT order_payment_cambio CHECK ((recibido IS NULL AND cambio = 0) OR (recibido IS NOT NULL AND cambio = recibido - monto)),
  CONSTRAINT order_payment_anulacion CHECK (estado <> 'ANULADO' OR (anulado_en IS NOT NULL AND motivo_anulacion IS NOT NULL))
);
-- Un pago vigente por venta: pulsar dos veces, o registrarla otra vez desde otro equipo, no la paga doble.
CREATE UNIQUE INDEX ux_order_payment_vigente ON order_payment (tenant_id, order_id) WHERE estado = 'REGISTRADO';
CREATE UNIQUE INDEX ux_order_payment_clave ON order_payment (tenant_id, clave_idempotencia) WHERE clave_idempotencia IS NOT NULL;
CREATE INDEX ix_order_payment_dia ON order_payment (tenant_id, creado_en);
CREATE INDEX ix_order_payment_venta ON order_payment (tenant_id, order_id);

ALTER TABLE order_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_payment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_payment USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT ON order_payment TO app_rt, app_platform;
-- Solo se anula: ni el monto ni el método se reescriben después de registrados.
GRANT UPDATE (estado, anulado_en, anulado_por, anulado_por_nombre, motivo_anulacion) ON order_payment TO app_rt, app_platform;
REVOKE DELETE ON order_payment FROM app_rt, app_platform;

-- Métodos que cada negocio acepta en el mostrador. Sin fila: efectivo y transferencia activos.
CREATE TABLE payment_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES tenant(id),
  efectivo         boolean NOT NULL DEFAULT true,
  transferencia    boolean NOT NULL DEFAULT true,
  datafono         boolean NOT NULL DEFAULT false,
  actualizado_en   timestamptz NOT NULL DEFAULT now(),
  actualizado_por  text
);
ALTER TABLE payment_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_settings USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON payment_settings TO app_rt, app_platform;

-- Ventas ya pagadas por la pasarela: su pago queda en el mismo registro (los reportes por método las incluyen).
INSERT INTO order_payment (id, tenant_id, order_id, metodo, monto, referencia, payment_link_id, estado, origen, registrado_por_nombre, creado_en)
SELECT gen_random_uuid(), l.tenant_id, l.order_id, 'PASARELA', coalesce(l.monto, o.total), l.referencia, l.id, 'REGISTRADO', 'PASARELA', 'Pasarela de pagos', l.actualizado_en
FROM payment_link l JOIN "order" o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
WHERE l.estado = 'PAGADO' AND o.estado_pago = 'PAGADA'
  AND l.id = (SELECT l2.id FROM payment_link l2 WHERE l2.tenant_id = l.tenant_id AND l2.order_id = l.order_id AND l2.estado = 'PAGADO' ORDER BY l2.actualizado_en LIMIT 1);

-- Permisos nuevos para los roles existentes: quien registra ventas registra su pago; quien anula ventas anula pagos.
INSERT INTO role_permission (tenant_id, role_id, permiso)
SELECT rp.tenant_id, rp.role_id, 'payment:register' FROM role_permission rp JOIN role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
WHERE rp.permiso = 'order:create' AND NOT r.es_agente
ON CONFLICT DO NOTHING;
INSERT INTO role_permission (tenant_id, role_id, permiso)
SELECT rp.tenant_id, rp.role_id, 'payment:void' FROM role_permission rp JOIN role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
WHERE rp.permiso = 'order:void' AND NOT r.es_agente
ON CONFLICT DO NOTHING;
