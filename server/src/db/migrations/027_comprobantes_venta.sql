-- =====================================================================
-- 027 · Comprobantes de venta internos (sin validez fiscal)
--
-- Documento que la empresa entrega a su cliente y conserva como soporte interno de una venta
-- confirmada. NO es una factura electrónica: el PDF, el correo y el WhatsApp llevan la leyenda
-- «Documento no válido como factura electrónica de venta ante la DIAN. Soporte interno de la
-- operación.» La facturación DIAN sigue en el código, apagada (FACTURACION_DIAN_HABILITADA=0).
--
--  * Consecutivo sin huecos por empresa: comprobante_consecutivo (UPDATE … RETURNING en la misma
--    transacción que crea el comprobante; si algo falla, se revierte también el número).
--  * Idempotencia: un solo comprobante EMITIDO por venta.
--  * Anular no borra: queda el registro con motivo, quién y cuándo. Nadie tiene DELETE.
-- =====================================================================

CREATE TABLE comprobante_consecutivo (
  tenant_id   uuid PRIMARY KEY REFERENCES tenant(id),
  prefijo     text NOT NULL DEFAULT 'CV' CHECK (prefijo ~ '^[A-Z0-9]{1,6}$'),
  siguiente   bigint NOT NULL DEFAULT 1 CHECK (siguiente >= 1)
);

-- Datos con que la empresa aparece en el PDF y su régimen de IVA (solo RESPONSABLE desglosa el IVA).
CREATE TABLE comprobante_ajustes (
  tenant_id         uuid PRIMARY KEY REFERENCES tenant(id),
  regimen_iva       text NOT NULL DEFAULT 'PENDIENTE' CHECK (regimen_iva IN ('RESPONSABLE','NO_RESPONSABLE','PENDIENTE')),
  nombre_comercial  text,
  documento         text,
  direccion         text,
  telefono          text,
  correo            text,
  pie               text CHECK (pie IS NULL OR length(pie) <= 600),
  actualizado_en    timestamptz NOT NULL DEFAULT now(),
  actualizado_por   text
);

CREATE TABLE comprobante_venta (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  order_id           uuid NOT NULL,
  numero             text NOT NULL,
  estado             text NOT NULL DEFAULT 'EMITIDO' CHECK (estado IN ('EMITIDO','ANULADO')),
  -- Datos del cliente congelados al emitir (un cambio posterior en su ficha no altera el comprobante).
  cliente_nombre     text NOT NULL,
  cliente_documento  text,
  cliente_telefono   text,
  cliente_correo     text,
  -- Líneas congeladas: [{descripcion, cantidad, precio_unitario, descuento, subtotal, iva_pct}].
  lineas             jsonb NOT NULL,
  subtotal           numeric(14,2) NOT NULL,
  descuento          numeric(14,2) NOT NULL DEFAULT 0,
  impuestos          numeric(14,2) NOT NULL DEFAULT 0,
  total              numeric(14,2) NOT NULL CHECK (total > 0),
  moneda             char(3) NOT NULL DEFAULT 'COP',
  regimen_iva        text NOT NULL CHECK (regimen_iva IN ('RESPONSABLE','NO_RESPONSABLE','PENDIENTE')),
  -- Emisor congelado (nombre comercial, documento, dirección, teléfono, correo, pie).
  emisor             jsonb NOT NULL DEFAULT '{}'::jsonb,
  notas              text CHECK (notas IS NULL OR length(notas) <= 500),
  medio_pago         text,
  emitido_por        text NOT NULL,
  emitido_por_id     uuid,
  emitido_en         timestamptz NOT NULL DEFAULT now(),
  anulado_en         timestamptz,
  anulado_por        text,
  motivo_anulacion   text,
  -- Registro de entregas: [{canal: CORREO|WHATSAPP|DESCARGA, destino, estado, en}].
  entregas           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Enlace público de verificación y descarga (token aleatorio, no adivinable).
  token_publico      text NOT NULL UNIQUE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, numero),
  CONSTRAINT fk_comprobante_order_same_tenant FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id),
  CONSTRAINT comprobante_anulacion CHECK ((estado = 'ANULADO') = (anulado_en IS NOT NULL AND motivo_anulacion IS NOT NULL))
);
CREATE UNIQUE INDEX ux_comprobante_emitido_por_venta ON comprobante_venta (tenant_id, order_id) WHERE estado = 'EMITIDO';
CREATE INDEX ix_comprobante_tenant_emitido ON comprobante_venta (tenant_id, emitido_en DESC);
CREATE INDEX ix_comprobante_tenant_order ON comprobante_venta (tenant_id, order_id);

-- Un comprobante anulado no vuelve a EMITIDO y sus datos congelados no cambian.
CREATE OR REPLACE FUNCTION comprobante_solo_anular() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado = 'ANULADO' AND NEW.estado <> 'ANULADO' THEN
    RAISE EXCEPTION 'Un comprobante anulado no se puede reactivar';
  END IF;
  IF NEW.numero <> OLD.numero OR NEW.total <> OLD.total OR NEW.lineas <> OLD.lineas OR NEW.order_id <> OLD.order_id
     OR NEW.tenant_id <> OLD.tenant_id OR NEW.cliente_nombre <> OLD.cliente_nombre OR NEW.emitido_en <> OLD.emitido_en THEN
    RAISE EXCEPTION 'Los datos de un comprobante emitido no se modifican';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tg_comprobante_solo_anular BEFORE UPDATE ON comprobante_venta FOR EACH ROW EXECUTE FUNCTION comprobante_solo_anular();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['comprobante_consecutivo','comprobante_ajustes','comprobante_venta'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;

REVOKE ALL ON comprobante_consecutivo, comprobante_ajustes, comprobante_venta FROM app_rt;
GRANT SELECT, INSERT, UPDATE ON comprobante_consecutivo, comprobante_ajustes TO app_rt;
-- El rol de ejecución inserta y lee; solo actualiza lo que cambia al anular y el registro de entregas.
GRANT SELECT, INSERT ON comprobante_venta TO app_rt;
GRANT UPDATE (estado, anulado_en, anulado_por, motivo_anulacion, entregas) ON comprobante_venta TO app_rt;
-- La plataforma resuelve el enlace público (token) sin contexto de empresa: solo lectura.
REVOKE ALL ON comprobante_consecutivo, comprobante_ajustes, comprobante_venta FROM app_platform;
GRANT SELECT ON comprobante_venta, comprobante_ajustes TO app_platform;
-- El operador de Omnegia no ve comprobantes: son datos privados de cada negocio.

-- Permisos para los roles existentes (la misma regla que las plantillas):
--  · consultar: quien consulta ventas o documentos (incluidos los agentes de IA de lectura);
--  · generar y reenviar: quien hoy puede emitir la factura de una venta o configura la empresa (no los agentes);
--  · reenviar (IA): el agente de atención, solo al cliente con el que conversa;
--  · anular: solo administración (la propiedad de la empresa ya los tiene todos).
INSERT INTO role_permission (tenant_id, role_id, permiso)
SELECT DISTINCT rp.tenant_id, rp.role_id, 'comprobante:read' FROM role_permission rp
WHERE rp.permiso IN ('order:read', 'invoice:read')
ON CONFLICT DO NOTHING;
INSERT INTO role_permission (tenant_id, role_id, permiso)
SELECT DISTINCT rp.tenant_id, rp.role_id, x.p FROM role_permission rp JOIN role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
CROSS JOIN (VALUES ('comprobante:issue'), ('comprobante:send')) AS x(p)
WHERE rp.permiso IN ('invoice:issue', 'tenant:configure') AND NOT r.es_agente
ON CONFLICT DO NOTHING;
INSERT INTO role_permission (tenant_id, role_id, permiso)
SELECT r.tenant_id, r.id, 'comprobante:send' FROM role r WHERE r.clave = 'agente_atencion' AND r.es_agente
ON CONFLICT DO NOTHING;
INSERT INTO role_permission (tenant_id, role_id, permiso)
SELECT DISTINCT rp.tenant_id, rp.role_id, 'comprobante:void' FROM role_permission rp JOIN role r ON r.tenant_id = rp.tenant_id AND r.id = rp.role_id
WHERE rp.permiso = 'tenant:configure' AND NOT r.es_agente
ON CONFLICT DO NOTHING;

-- La IA de atención consulta y reenvía comprobantes del cliente con el que conversa (nunca los emite ni anula).
UPDATE ai_agent SET herramientas = herramientas || ARRAY['consultar_comprobantes', 'reenviar_comprobante']
WHERE configuracion = 'atencion' AND NOT ('consultar_comprobantes' = ANY(herramientas));
