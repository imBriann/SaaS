-- 016 · Números de WhatsApp contratados desde Omnegia
--
-- Comprar un número (proveedor telefónico) y activar WhatsApp (Meta) son operaciones distintas:
-- la contratación pasa por pago, aprovisionamiento del número y conexión de WhatsApp, y cada
-- etapa queda en su propio estado. Los precios se congelan en la cotización al seleccionar el
-- número; nunca vienen del navegador.

CREATE TABLE numero_contratacion (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL REFERENCES tenant(id),
  estado                    text NOT NULL CHECK (estado IN (
                              'SELECCION_NUMERO','CONFIRMACION_PENDIENTE','PAGO_PENDIENTE','PAGO_CONFIRMADO',
                              'APROVISIONANDO_NUMERO','NUMERO_APROVISIONADO',
                              'REGISTRO_WHATSAPP_PENDIENTE','VERIFICACION_PENDIENTE','CONEXION_PENDIENTE','CONECTADO',
                              'APROVISIONAMIENTO_FALLIDO','CONEXION_FALLIDA','CANCELACION_PENDIENTE','CANCELADO')),
  -- Detalle técnico del estado (p. ej. documentos_en_revision, numero_no_disponible, esperando_llamada).
  subestado                 text,
  -- Qué debe hacer el cliente para avanzar (NULL = nada: el servidor trabaja solo).
  accion_cliente            text,
  proveedor                 text NOT NULL,
  -- 'real' = API del proveedor; 'simulado' = inventario de demostración (nunca en producción).
  entorno                   text NOT NULL CHECK (entorno IN ('real','simulado')),
  pais                      char(2) NOT NULL,
  tipo_numero               text NOT NULL,
  numero_e164               text NOT NULL CHECK (numero_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  localidad                 text,
  caracteristicas           text[] NOT NULL DEFAULT '{}',
  cotizacion                jsonb NOT NULL,
  reserva_id                text,
  reserva_expira_en         timestamptz,
  -- Requisitos regulatorios: solo identificadores del proveedor y estado, nunca el documento.
  requisitos                jsonb NOT NULL DEFAULT '{}'::jsonb,
  grupo_requisitos_id       text,
  orden_id                  text,
  numero_proveedor_id       text,
  waba_id                   text,
  phone_number_id           text,
  nombre_visible            text,
  whatsapp                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  verificacion              jsonb NOT NULL DEFAULT '{}'::jsonb,
  prueba_recibida_en        timestamptz,
  aceptacion                jsonb,
  periodo_inicio            timestamptz,
  periodo_fin               timestamptz,
  gracia_hasta              timestamptz,
  intentos                  int NOT NULL DEFAULT 0,
  ultimo_error              text,
  -- Turno exclusivo del trabajador que habla con el proveedor o con Meta (evita pasos duplicados).
  bloqueo_hasta             timestamptz,
  creado_por                uuid REFERENCES users(id),
  creado_en                 timestamptz NOT NULL DEFAULT now(),
  actualizado_en            timestamptz NOT NULL DEFAULT now(),
  conectado_en              timestamptz,
  cancelacion_solicitada_en timestamptz,
  cancelado_en              timestamptz,
  liberado_en               timestamptz
);
-- Una contratación viva por empresa, y un número no puede estar en dos contrataciones vivas.
CREATE UNIQUE INDEX ux_numero_contratacion_vigente ON numero_contratacion (tenant_id) WHERE estado <> 'CANCELADO';
CREATE UNIQUE INDEX ux_numero_contratacion_numero ON numero_contratacion (numero_e164) WHERE estado <> 'CANCELADO';
CREATE UNIQUE INDEX ux_numero_contratacion_pid ON numero_contratacion (phone_number_id) WHERE phone_number_id IS NOT NULL AND estado <> 'CANCELADO';
CREATE INDEX ix_numero_contratacion_estado ON numero_contratacion (estado, actualizado_en);
ALTER TABLE numero_contratacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE numero_contratacion FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON numero_contratacion USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
-- La empresa lee su contratación; todo cambio lo hace el servidor con el rol de plataforma.
REVOKE ALL ON numero_contratacion FROM app_rt;
GRANT SELECT ON numero_contratacion TO app_rt;
GRANT SELECT, INSERT, UPDATE ON numero_contratacion TO app_platform;
REVOKE DELETE ON numero_contratacion FROM app_platform;

-- Bitácora de la máquina de estados: solo inserción.
CREATE TABLE numero_evento (
  id               uuid PRIMARY KEY,
  contratacion_id  uuid NOT NULL REFERENCES numero_contratacion(id),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  de               text,
  a                text NOT NULL,
  tipo             text NOT NULL,
  detalle          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor            text NOT NULL,
  creado_en        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_numero_evento_contratacion ON numero_evento (contratacion_id, creado_en);
ALTER TABLE numero_evento ENABLE ROW LEVEL SECURITY;
ALTER TABLE numero_evento FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON numero_evento USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
REVOKE ALL ON numero_evento FROM app_rt;
GRANT SELECT ON numero_evento TO app_rt;
GRANT SELECT, INSERT ON numero_evento TO app_platform;
REVOKE UPDATE, DELETE ON numero_evento FROM app_platform;

-- Credenciales de WhatsApp de la empresa (token de negocio, PIN de dos pasos y el código de
-- verificación capturado mientras dura). Cifradas con APP_KEY; el rol de ejecución no las ve.
CREATE TABLE numero_credencial (
  contratacion_id  uuid PRIMARY KEY REFERENCES numero_contratacion(id),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  token_cifrado    text,
  pin_cifrado      text,
  codigo_cifrado   text,
  codigo_en        timestamptz,
  actualizado_en   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE numero_credencial ENABLE ROW LEVEL SECURITY;
ALTER TABLE numero_credencial FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON numero_credencial USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
REVOKE ALL ON numero_credencial FROM app_rt;
GRANT SELECT, INSERT, UPDATE, DELETE ON numero_credencial TO app_platform;

-- Cargos del número: la activación y cada mensualidad son pagos de la plataforma (NUM-…),
-- distintos de la suscripción (SUB-…) y de los cobros del comercio (PL-…).
ALTER TABLE payment ADD COLUMN IF NOT EXISTS numero_contratacion_id uuid REFERENCES numero_contratacion(id);
ALTER TABLE payment ADD COLUMN IF NOT EXISTS cargo_numero text CHECK (cargo_numero IN ('ACTIVACION','MENSUALIDAD'));
ALTER TABLE payment ADD COLUMN IF NOT EXISTS cubre_hasta timestamptz;
CREATE INDEX IF NOT EXISTS ix_payment_numero ON payment (numero_contratacion_id) WHERE numero_contratacion_id IS NOT NULL;

-- El operador ve el estado técnico para atender incidentes, sin datos de la empresa ni credenciales.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT (id, tenant_id, estado, subestado, accion_cliente, proveedor, entorno, pais, tipo_numero, intentos, ultimo_error,
                  creado_en, actualizado_en, conectado_en, periodo_fin, cancelado_en, liberado_en) ON numero_contratacion TO app_operador;
    CREATE POLICY operador_metadatos ON numero_contratacion FOR SELECT TO app_operador USING (true);
    GRANT SELECT (numero_contratacion_id, cargo_numero) ON payment TO app_operador;
  END IF;
END $$;
