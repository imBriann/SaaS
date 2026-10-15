-- =====================================================================
-- 004 · Modalidad institucional y trazabilidad de pagos de la plataforma
-- Solo agrega columnas, restricciones más amplias y una tabla de historial.
-- No borra ni reescribe pagos, planes ni suscripciones existentes.
-- =====================================================================

-- ---------------------------------------------------------------- pagos
-- Términos congelados al crear el checkout: el monto cobrado, la modalidad, el precio
-- comercial de referencia (que NO se cobra en la institucional), la vigencia que compra
-- y el plan que se aprovisiona. El servidor nunca los toma del navegador.
ALTER TABLE payment ADD COLUMN IF NOT EXISTS modalidad text NOT NULL DEFAULT 'COMERCIAL';
ALTER TABLE payment ADD COLUMN IF NOT EXISTS monto_referencia numeric(14,2);
ALTER TABLE payment ADD COLUMN IF NOT EXISTS acceso_dias int;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS plan_codigo text REFERENCES plan(codigo);
ALTER TABLE payment ADD COLUMN IF NOT EXISTS entorno text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS expira_en timestamptz;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS estado_proveedor text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS verificado_en timestamptz;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS consultado_en timestamptz;

ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_modalidad_check;
ALTER TABLE payment ADD CONSTRAINT payment_modalidad_check CHECK (modalidad IN ('COMERCIAL','INSTITUCIONAL'));

-- ANULADO: la pasarela anuló la transacción. REEMPLAZADO: el checkout dejó de ofrecerse
-- (cambió el precio o la modalidad); si aun así llega una aprobación por su monto, se registra.
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_estado_check;
ALTER TABLE payment ADD CONSTRAINT payment_estado_check CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO','ANULADO','REEMPLAZADO'));

-- Una transacción de la pasarela solo puede respaldar un pago.
CREATE UNIQUE INDEX IF NOT EXISTS payment_transaccion_unica ON payment (proveedor, transaccion_id) WHERE transaccion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payment_conciliar ON payment (estado, creado_en) WHERE estado IN ('PENDIENTE','REEMPLAZADO');
CREATE INDEX IF NOT EXISTS payment_borrador ON payment (draft_token) WHERE draft_token IS NOT NULL;

-- ---------------------------------------------------------------- suscripción
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS modalidad text NOT NULL DEFAULT 'COMERCIAL';
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS precio_pagado numeric(14,2);
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS condiciones jsonb;
ALTER TABLE subscription DROP CONSTRAINT IF EXISTS subscription_modalidad_check;
ALTER TABLE subscription ADD CONSTRAINT subscription_modalidad_check CHECK (modalidad IN ('COMERCIAL','INSTITUCIONAL'));

-- Historial de periodos pagados: modalidad, monto, vigencia y condiciones aplicadas.
-- Un pago respalda como máximo un periodo (idempotencia de la activación y la renovación).
CREATE TABLE IF NOT EXISTS subscription_period (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  payment_id       uuid REFERENCES payment(id) UNIQUE,
  modalidad        text NOT NULL CHECK (modalidad IN ('COMERCIAL','INSTITUCIONAL')),
  plan_codigo      text NOT NULL REFERENCES plan(codigo),
  monto_pagado     numeric(14,2) NOT NULL,
  monto_referencia numeric(14,2),
  periodo_inicio   timestamptz NOT NULL,
  periodo_fin      timestamptz NOT NULL,
  condiciones      jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_period_tenant ON subscription_period (tenant_id, periodo_inicio);

ALTER TABLE subscription_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_period FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_period_tenant ON subscription_period;
CREATE POLICY subscription_period_tenant ON subscription_period USING (tenant_id = app_tenant());

-- Evidencia: se inserta y se lee, no se modifica.
GRANT SELECT, INSERT ON subscription_period TO app_platform;
GRANT SELECT ON subscription_period TO app_rt;
REVOKE UPDATE, DELETE ON subscription_period FROM app_rt, app_platform;

-- El operador ve la modalidad de cada suscripción (no datos del pago).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT (modalidad) ON subscription TO app_operador;
  END IF;
END $$;
