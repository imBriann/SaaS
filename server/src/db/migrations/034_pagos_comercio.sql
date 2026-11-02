-- =====================================================================
-- 034 · Pagos de comercio por WhatsApp (docs/pagos-whatsapp.md)
--
--  Se EXTIENDE "order": un pedido de WhatsApp nace en BORRADOR (no cuenta como venta ni mueve inventario),
--  guarda la entrega y la configuración de precios congelada, y se confirma cuando el pago se aprueba.
--  Tablas nuevas (todas con FORCE RLS y FK compuestas (tenant_id, id)):
--   · commerce_payment         intentos de cobro (referencia CP-…), importe oficial y cobrado, comisión y neto
--   · payment_event            eventos de Wompi recibidos (idempotencia)
--   · financial_ledger         movimientos financieros: SOLO inserción (un disparador impide editar o borrar)
--   · payment_reconciliation   discrepancias entre Omnegia y Wompi
--   · merchant_payment_account datos de pago manual del negocio (Nequi, Daviplata, Bre-B, QR, cuenta)
--  payment_settings se extiende con los interruptores de pago manual y en línea.
--  Aditiva e idempotente: se puede aplicar sobre producción (hasta la 033) sin tocar datos existentes.
-- =====================================================================

-- ---------------------------------------------------------------- pedidos sobre "order"
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS pedido_estado text;
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS order_pedido_estado_check;
ALTER TABLE "order" ADD CONSTRAINT order_pedido_estado_check CHECK (pedido_estado IS NULL OR pedido_estado IN
  ('ABIERTO','PENDIENTE_PAGO','PROCESANDO','PAGADO','RECHAZADO','ERROR','EN_REVISION','PENDIENTE_CONFIRMACION','CANCELADO'));
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS entrega text;
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS order_entrega_check;
ALTER TABLE "order" ADD CONSTRAINT order_entrega_check CHECK (entrega IS NULL OR entrega IN ('RECOGER','DOMICILIO'));
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS direccion_entrega text;
ALTER TABLE "order" DROP CONSTRAINT IF EXISTS order_direccion_entrega_check;
ALTER TABLE "order" ADD CONSTRAINT order_direccion_entrega_check CHECK (direccion_entrega IS NULL OR length(direccion_entrega) <= 300);
-- Configuración de precios con la que se calculó el cobro (modo, importe fijo): trazabilidad aunque cambie el modo global.
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS precio_config jsonb;
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS medio_pago text;
CREATE INDEX IF NOT EXISTS ix_order_tenant_pedido ON "order" (tenant_id, pedido_estado, creado_en DESC) WHERE pedido_estado IS NOT NULL;

-- ---------------------------------------------------------------- interruptores por empresa
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS pago_manual boolean NOT NULL DEFAULT false;
ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS pago_en_linea boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------- datos de pago manual
CREATE TABLE IF NOT EXISTS merchant_payment_account (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  tipo           text NOT NULL CHECK (tipo IN ('NEQUI','DAVIPLATA','BREB','QR','CUENTA_BANCARIA')),
  titular        text NOT NULL CHECK (length(titular) BETWEEN 2 AND 120),
  valor          text NOT NULL CHECK (length(valor) BETWEEN 3 AND 120),
  banco          text CHECK (banco IS NULL OR length(banco) <= 80),
  tipo_cuenta    text CHECK (tipo_cuenta IS NULL OR tipo_cuenta IN ('AHORROS','CORRIENTE')),
  instrucciones  text CHECK (instrucciones IS NULL OR length(instrucciones) <= 500),
  activo         boolean NOT NULL DEFAULT true,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS ix_merchant_payment_account ON merchant_payment_account (tenant_id, activo);

-- ---------------------------------------------------------------- intentos de cobro
CREATE TABLE IF NOT EXISTS commerce_payment (
  id                    uuid PRIMARY KEY,
  tenant_id             uuid NOT NULL REFERENCES tenant(id),
  order_id              uuid NOT NULL,
  referencia            text NOT NULL UNIQUE CHECK (referencia ~ '^CP-[A-Z0-9-]{6,60}$'),
  modalidad             text NOT NULL CHECK (modalidad IN ('MANAGED','MANUAL')),
  metodo                text NOT NULL CHECK (metodo IN ('NEQUI','PSE','CARD','BANCOLOMBIA_TRANSFER','CHECKOUT','DAVIPLATA','BREB','QR','CUENTA_BANCARIA')),
  estado                text NOT NULL CHECK (estado IN ('PENDIENTE_PAGO','PROCESANDO','PAGADO','RECHAZADO','ERROR','EN_REVISION','PENDIENTE_CONFIRMACION','ANULADO')),
  moneda                char(3) NOT NULL DEFAULT 'COP' CHECK (moneda = 'COP'),
  -- Importes en centavos (enteros): total oficial del pedido e importe que se cobra (congelado al crear).
  total_oficial_centavos bigint NOT NULL CHECK (total_oficial_centavos > 0),
  monto_cobro_centavos  bigint NOT NULL CHECK (monto_cobro_centavos > 0),
  modo_precios          text NOT NULL CHECK (modo_precios IN ('institutional_test','official')),
  cargo_fijo_centavos   bigint CHECK (cargo_fijo_centavos IS NULL OR cargo_fijo_centavos > 0),
  -- Lo que reporta Wompi (null hasta saberlo). La comisión no viene en la transacción: la completa la conciliación.
  monto_reportado_centavos bigint,
  comision_centavos     bigint,
  neto_centavos         bigint,
  entorno               text CHECK (entorno IS NULL OR entorno IN ('sandbox','produccion')),
  transaccion_id        text,
  celular_final         text CHECK (celular_final IS NULL OR celular_final ~ '^\d{4}$'),
  enlace_pago           text CHECK (enlace_pago IS NULL OR enlace_pago ~ '^https://'),
  estado_proveedor      text,
  motivo                text CHECK (motivo IS NULL OR length(motivo) <= 500),
  comprobante_nota      text CHECK (comprobante_nota IS NULL OR length(comprobante_nota) <= 500),
  revisado_por          text,
  revisado_en           timestamptz,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  actualizado_en        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id),
  CONSTRAINT commerce_payment_modo_cargo CHECK ((modo_precios = 'official' AND monto_cobro_centavos = total_oficial_centavos)
    OR (modo_precios = 'institutional_test' AND monto_cobro_centavos = cargo_fijo_centavos))
);
-- Un solo intento abierto por pedido: un doble «sí» o un reintento de red no crea dos cobros.
CREATE UNIQUE INDEX IF NOT EXISTS ux_commerce_payment_abierto ON commerce_payment (tenant_id, order_id) WHERE estado IN ('PENDIENTE_PAGO','PROCESANDO','PENDIENTE_CONFIRMACION');
CREATE UNIQUE INDEX IF NOT EXISTS ux_commerce_payment_transaccion ON commerce_payment (transaccion_id) WHERE transaccion_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_commerce_payment ON commerce_payment (tenant_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_commerce_payment_estado ON commerce_payment (tenant_id, estado);

-- ---------------------------------------------------------------- eventos (idempotencia)
CREATE TABLE IF NOT EXISTS payment_event (
  event_id      text PRIMARY KEY,
  tenant_id     uuid REFERENCES tenant(id),
  referencia    text NOT NULL,
  estado        text NOT NULL,
  resultado     text NOT NULL,
  recibido_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_payment_event ON payment_event (tenant_id, recibido_en DESC);

-- ---------------------------------------------------------------- ledger (solo inserción)
CREATE TABLE IF NOT EXISTS financial_ledger (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  order_id            uuid NOT NULL,
  commerce_payment_id uuid NOT NULL,
  tipo                text NOT NULL CHECK (tipo IN ('RECAUDO','REVERSO','AJUSTE_COMISION')),
  bruto_centavos      bigint NOT NULL,
  comision_centavos   bigint,
  neto_centavos       bigint,
  moneda              char(3) NOT NULL DEFAULT 'COP',
  estado              text NOT NULL CHECK (estado IN ('CONFIRMADO','PENDIENTE_COMISION')),
  transaccion_id      text,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id),
  FOREIGN KEY (tenant_id, commerce_payment_id) REFERENCES commerce_payment (tenant_id, id)
);
-- Un recaudo por intento de cobro: un evento repetido no duplica el movimiento.
CREATE UNIQUE INDEX IF NOT EXISTS ux_financial_ledger_recaudo ON financial_ledger (commerce_payment_id, tipo) WHERE tipo IN ('RECAUDO','REVERSO');
CREATE INDEX IF NOT EXISTS ix_financial_ledger ON financial_ledger (tenant_id, creado_en DESC);

CREATE OR REPLACE FUNCTION ledger_inmutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial_ledger es de solo inserción: no se edita ni se borra (registra un movimiento nuevo)';
END $$;
DROP TRIGGER IF EXISTS tr_ledger_inmutable ON financial_ledger;
CREATE TRIGGER tr_ledger_inmutable BEFORE UPDATE OR DELETE ON financial_ledger FOR EACH ROW EXECUTE FUNCTION ledger_inmutable();

-- ---------------------------------------------------------------- conciliación
CREATE TABLE IF NOT EXISTS payment_reconciliation (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  commerce_payment_id uuid NOT NULL,
  tipo                text NOT NULL CHECK (tipo IN ('MONTO','MONEDA','REFERENCIA','ESTADO','COMISION')),
  esperado            text,
  recibido            text,
  detalle             text CHECK (detalle IS NULL OR length(detalle) <= 500),
  resuelto_en         timestamptz,
  resuelto_por        text,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, commerce_payment_id) REFERENCES commerce_payment (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS ix_payment_reconciliation ON payment_reconciliation (tenant_id, resuelto_en NULLS FIRST, creado_en DESC);

-- ---------------------------------------------------------------- avisos de pago (ventana de 24 h)
ALTER TABLE aviso_proactivo DROP CONSTRAINT IF EXISTS aviso_proactivo_tipo_check;
ALTER TABLE aviso_proactivo ADD CONSTRAINT aviso_proactivo_tipo_check CHECK (tipo IN
  ('RECORDATORIO','SEGUIMIENTO','PAGO_PENDIENTE','LISTA_ESPERA','INASISTENCIA','CAMBIO_CITA','STOCK','APROBACION','PAGO_CONFIRMADO','PAGO_RECHAZADO','PAGO_EN_ESPERA','PAGO_NEGOCIO'));
ALTER TABLE message_template DROP CONSTRAINT IF EXISTS message_template_tipo_proactivo_check;
ALTER TABLE message_template ADD CONSTRAINT message_template_tipo_proactivo_check CHECK (tipo_proactivo IS NULL OR tipo_proactivo IN
  ('RECORDATORIO','SEGUIMIENTO','PAGO_PENDIENTE','LISTA_ESPERA','INASISTENCIA','PAGO_CONFIRMADO','PAGO_RECHAZADO','PAGO_EN_ESPERA'));

-- ---------------------------------------------------------------- RLS y permisos
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['merchant_payment_account','commerce_payment','financial_ledger','payment_reconciliation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;
-- payment_event es de la plataforma (el webhook llega sin empresa: Omnegia la resuelve por la referencia).
ALTER TABLE payment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_event FORCE ROW LEVEL SECURITY;
-- app_platform tiene BYPASSRLS; las empresas solo ven los eventos de sus propios cobros.
DROP POLICY IF EXISTS tenant_isolation ON payment_event;
CREATE POLICY tenant_isolation ON payment_event USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

GRANT SELECT, INSERT, UPDATE, DELETE ON merchant_payment_account TO app_rt;
GRANT SELECT, INSERT, UPDATE ON commerce_payment TO app_rt;
GRANT SELECT, INSERT ON financial_ledger TO app_rt;
GRANT SELECT, INSERT, UPDATE ON payment_reconciliation TO app_rt;
GRANT SELECT, INSERT ON payment_event TO app_rt;
-- La plataforma resuelve referencias del webhook, registra eventos y muestra los recaudos al operador.
GRANT SELECT ON commerce_payment, financial_ledger, payment_reconciliation TO app_platform;
GRANT SELECT, INSERT ON payment_event TO app_platform;

-- ---------------------------------------------------------------- herramientas del agente de atención
-- Solo se ofrecen al cliente si la empresa activa algún método de pago de pedidos (ToolDef.disponible).
UPDATE ai_agent SET herramientas = herramientas || ARRAY['crear_pedido','agregar_al_pedido','calcular_total','elegir_entrega','medios_de_pago','elegir_medio_pago','pedir_celular_nequi','generar_cobro','estado_pedido']
WHERE configuracion = 'atencion' AND 'registrar_venta' = ANY(herramientas) AND NOT ('crear_pedido' = ANY(herramientas));

-- ---------------------------------------------------------------- panel del operador (metadatos, sin datos personales)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    DROP POLICY IF EXISTS operador_metadatos ON commerce_payment;
    CREATE POLICY operador_metadatos ON commerce_payment FOR SELECT TO app_operador USING (true);
    GRANT SELECT (id, tenant_id, referencia, modalidad, metodo, estado, modo_precios, entorno, total_oficial_centavos, monto_cobro_centavos,
                  monto_reportado_centavos, comision_centavos, creado_en) ON commerce_payment TO app_operador;
    DROP POLICY IF EXISTS operador_metadatos ON financial_ledger;
    CREATE POLICY operador_metadatos ON financial_ledger FOR SELECT TO app_operador USING (true);
    GRANT SELECT (commerce_payment_id, tipo, bruto_centavos, estado) ON financial_ledger TO app_operador;
    DROP POLICY IF EXISTS operador_metadatos ON payment_reconciliation;
    CREATE POLICY operador_metadatos ON payment_reconciliation FOR SELECT TO app_operador USING (true);
    GRANT SELECT (id, commerce_payment_id, tipo, esperado, recibido, detalle, resuelto_en, creado_en) ON payment_reconciliation TO app_operador;
  END IF;
END $$;
