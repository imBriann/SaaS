-- =====================================================================
-- 005 · Documentos de los pagos a la plataforma (comprobante, factura electrónica, ZIP)
-- Solo agrega columnas y tablas. No modifica pagos ni documentos existentes.
-- =====================================================================

-- Datos de facturación del contratante congelados en el pago. El número de documento va
-- cifrado con APP_KEY (columna aparte); el JSON no lo contiene.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS facturacion jsonb;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS documento_cifrado text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS facturacion_huella text;

CREATE SEQUENCE IF NOT EXISTS comprobante_pago_seq START 1;

-- Un registro por pago aprobado: idempotencia de la generación y obligación fiscal pendiente.
CREATE TABLE IF NOT EXISTS documento_pago (
  id              uuid PRIMARY KEY,
  payment_id      uuid NOT NULL UNIQUE REFERENCES payment(id),
  tenant_id       uuid REFERENCES tenant(id),
  numero          text NOT NULL UNIQUE,               -- consecutivo interno del comprobante (no es numeración DIAN)
  estado          text NOT NULL DEFAULT 'GENERANDO' CHECK (estado IN ('GENERANDO','LISTO','FALLIDO','SIN_DATOS')),
  version         int NOT NULL DEFAULT 0,             -- sube con cada ZIP generado (p. ej. al validarse la factura)
  zip             bytea,                              -- almacenamiento privado: nunca se expone su ubicación
  zip_bytes       int,
  zip_sha256      text,
  archivos        jsonb NOT NULL DEFAULT '[]'::jsonb, -- nombre, tipo, protección y huella de cada archivo
  estado_fiscal   text NOT NULL DEFAULT 'PENDIENTE_CONFIGURACION'
                  CHECK (estado_fiscal IN ('PENDIENTE_CONFIGURACION','EN_PROCESO','VALIDADA','RECHAZADA','NO_APLICA')),
  factura_consecutivo int UNIQUE,                     -- reservado al iniciar la emisión, dentro del rango autorizado
  factura_numero  text,                               -- solo con factura validada por la DIAN
  cufe            text,
  factura_xml     bytea,                              -- XML firmado tal como lo devuelve el proveedor
  factura_qr      text,
  factura_validada_en timestamptz,
  fiscal_motivo   text,
  error           text,
  intentos        int NOT NULL DEFAULT 0,
  generado_en     timestamptz,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  CHECK (estado_fiscal <> 'VALIDADA' OR (cufe IS NOT NULL AND factura_numero IS NOT NULL AND factura_xml IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS documento_pago_tenant ON documento_pago (tenant_id, creado_en);
CREATE INDEX IF NOT EXISTS documento_pago_pendientes ON documento_pago (estado, estado_fiscal);

-- Cada empresa ve solo los documentos de sus propios pagos.
ALTER TABLE documento_pago ENABLE ROW LEVEL SECURITY;
ALTER TABLE documento_pago FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documento_pago_tenant ON documento_pago;
CREATE POLICY documento_pago_tenant ON documento_pago USING (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE ON documento_pago TO app_platform;
GRANT USAGE, SELECT ON SEQUENCE comprobante_pago_seq TO app_platform;
-- El rol de ejecución solo lee metadatos; el ZIP y el XML se sirven desde la plataforma tras autorizar.
GRANT SELECT (id, payment_id, tenant_id, numero, estado, version, zip_bytes, archivos, estado_fiscal, factura_numero, cufe, generado_en, creado_en) ON documento_pago TO app_rt;
REVOKE DELETE ON documento_pago FROM app_rt, app_platform;
