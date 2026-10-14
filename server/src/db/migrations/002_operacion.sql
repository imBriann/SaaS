-- =====================================================================
-- 002 · Acceso, canal, cobros, radicados y consistencia operativa
-- Aditiva e idempotente donde es posible: se aplica sobre bases creadas
-- con 001 sin perder datos.
-- =====================================================================

-- ---------------------------------------------------------------- acceso
ALTER TABLE session ADD COLUMN IF NOT EXISTS ultimo_uso timestamptz NOT NULL DEFAULT now();
ALTER TABLE session ADD COLUMN IF NOT EXISTS agente text;
CREATE INDEX IF NOT EXISTS ix_session_usuario ON session (user_id);
CREATE INDEX IF NOT EXISTS ix_session_expira ON session (expira_en);

ALTER TABLE users ADD COLUMN IF NOT EXISTS contrasena_cambiada_en timestamptz;

-- Intentos de inicio de sesión (límite por correo e IP). Solo plataforma.
CREATE TABLE IF NOT EXISTS login_attempt (
  clave      text NOT NULL,
  exito      boolean NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_login_attempt ON login_attempt (clave, creado_en DESC);

-- Recuperación de acceso: se guarda el hash del token, nunca el token.
CREATE TABLE IF NOT EXISTS password_reset (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  expira_en   timestamptz NOT NULL,
  usado_en    timestamptz,
  creado_en   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_reset_usuario ON password_reset (user_id);

-- Invitaciones al equipo: aceptación con token, expiración y revocación.
CREATE TABLE IF NOT EXISTS invitation (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  email         text NOT NULL,
  nombre        text NOT NULL,
  role_id       uuid NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  estado        text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','ACEPTADA','REVOCADA','EXPIRADA')),
  expira_en     timestamptz NOT NULL,
  invitado_por  uuid,
  aceptada_en   timestamptz,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_invitation_pendiente ON invitation (tenant_id, lower(email)) WHERE estado = 'PENDIENTE';

-- ---------------------------------------------------------------- tenant: canal y límites
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS whatsapp_numero_visible text;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS whatsapp_estado text NOT NULL DEFAULT 'SIN_CONFIGURAR';
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS whatsapp_diagnostico jsonb;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS whatsapp_verificado_en timestamptz;
-- Tope mensual de tokens de IA fijado por el negocio (no puede superar la cuota del plan).
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS ia_tope_mensual bigint;
UPDATE tenant SET whatsapp_estado = CASE WHEN whatsapp_phone_number_id LIKE 'sim-%' THEN 'SIMULADO' WHEN whatsapp_phone_number_id IS NOT NULL THEN 'PENDIENTE_VERIFICAR' ELSE 'SIN_CONFIGURAR' END
 WHERE whatsapp_estado = 'SIN_CONFIGURAR';

-- ---------------------------------------------------------------- mensajes
ALTER TABLE message DROP CONSTRAINT IF EXISTS message_tipo_check;
ALTER TABLE message ADD CONSTRAINT message_tipo_check CHECK (tipo IN ('TEXTO','NOTA_INTERNA','DOCUMENTO','PLANTILLA','MEDIA','NO_SOPORTADO'));
ALTER TABLE message DROP CONSTRAINT IF EXISTS message_estado_entrega_check;
ALTER TABLE message ADD CONSTRAINT message_estado_entrega_check CHECK (estado_entrega IN ('N/A','PENDIENTE','ENVIADO','ENTREGADO','LEIDO','FALLIDO','SIMULADO'));
ALTER TABLE message ADD COLUMN IF NOT EXISTS id_externo_salida text;
ALTER TABLE message ADD COLUMN IF NOT EXISTS error_entrega text;
-- Momento informado por el proveedor (ordena mensajes que llegan retrasados o desordenados).
ALTER TABLE message ADD COLUMN IF NOT EXISTS ocurrido_en timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS ux_msg_externo_salida ON message (tenant_id, id_externo_salida) WHERE id_externo_salida IS NOT NULL;

-- Plantillas aprobadas por Meta: nombre registrado, idioma y orden de variables.
ALTER TABLE message_template ADD COLUMN IF NOT EXISTS nombre_proveedor text;
ALTER TABLE message_template ADD COLUMN IF NOT EXISTS idioma text NOT NULL DEFAULT 'es';
ALTER TABLE message_template ADD COLUMN IF NOT EXISTS variables text[] NOT NULL DEFAULT '{}';
ALTER TABLE message_template ADD COLUMN IF NOT EXISTS estado_aprobacion text NOT NULL DEFAULT 'NO_REGISTRADA';
-- Variables en el orden en que aparecen en el cuerpo ({{1}}, {{2}}… en Meta).
UPDATE message_template mt SET variables = ARRAY(
  SELECT v FROM (SELECT m[1] AS v, min(o) AS o FROM regexp_matches(mt.cuerpo, '\{\{(\w+)\}\}', 'g') WITH ORDINALITY AS t(m, o) GROUP BY m[1]) s ORDER BY o
) WHERE variables = '{}';

-- Correos de plataforma (recuperación de acceso) no pertenecen a un tenant.
ALTER TABLE email_outbox ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS error text;

-- ---------------------------------------------------------------- ventas y cobros
ALTER TABLE order_item ADD COLUMN IF NOT EXISTS descuento_pct numeric(5,2) NOT NULL DEFAULT 0;
ALTER TABLE order_item ADD COLUMN IF NOT EXISTS descuento numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS descuento numeric(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "order" ADD COLUMN IF NOT EXISTS motivo_anulacion text;

ALTER TABLE merchant_gateway_account ADD COLUMN IF NOT EXISTS llave_publica text;
ALTER TABLE merchant_gateway_account ADD COLUMN IF NOT EXISTS secreto_integridad_cifrado text;
ALTER TABLE merchant_gateway_account ADD COLUMN IF NOT EXISTS secreto_eventos_cifrado text;
ALTER TABLE merchant_gateway_account ADD COLUMN IF NOT EXISTS webhook_token text;
ALTER TABLE merchant_gateway_account ADD COLUMN IF NOT EXISTS entorno text NOT NULL DEFAULT 'sandbox';
CREATE UNIQUE INDEX IF NOT EXISTS ux_gateway_webhook ON merchant_gateway_account (webhook_token) WHERE webhook_token IS NOT NULL;

ALTER TABLE payment_link ADD COLUMN IF NOT EXISTS proveedor text NOT NULL DEFAULT 'simulada';
ALTER TABLE payment_link ADD COLUMN IF NOT EXISTS monto numeric(14,2);
ALTER TABLE payment_link ADD COLUMN IF NOT EXISTS expira_en timestamptz;
ALTER TABLE payment_link ADD COLUMN IF NOT EXISTS transaccion_id text;
ALTER TABLE payment_link ADD COLUMN IF NOT EXISTS ultimo_estado_proveedor text;
ALTER TABLE payment_link ADD COLUMN IF NOT EXISTS actualizado_en timestamptz NOT NULL DEFAULT now();
UPDATE payment_link l SET monto = o.total FROM "order" o WHERE o.id = l.order_id AND l.monto IS NULL;

ALTER TABLE payment ADD COLUMN IF NOT EXISTS proveedor text NOT NULL DEFAULT 'simulada';
ALTER TABLE payment ADD COLUMN IF NOT EXISTS transaccion_id text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS actualizado_en timestamptz NOT NULL DEFAULT now();

-- Proveedor que emitió cada documento: «sandbox» nunca tiene validez fiscal.
ALTER TABLE fiscal_document ADD COLUMN IF NOT EXISTS proveedor_fiscal text NOT NULL DEFAULT 'sandbox';

-- ---------------------------------------------------------------- alta (aprovisionamiento recuperable)
ALTER TABLE onboarding_draft ADD COLUMN IF NOT EXISTS cierre jsonb;
ALTER TABLE onboarding_draft ADD COLUMN IF NOT EXISTS error_aprovisionamiento text;
ALTER TABLE onboarding_draft ADD COLUMN IF NOT EXISTS intentos_aprovisionamiento int NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------- radicados: historial de transiciones
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS reaperturas int NOT NULL DEFAULT 0;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS tomado_en timestamptz;
CREATE TABLE IF NOT EXISTS case_event (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  case_id       uuid NOT NULL,
  accion        text NOT NULL,
  de_estado     text,
  a_estado      text NOT NULL,
  actor_tipo    text NOT NULL,
  actor_nombre  text NOT NULL,
  asignado_a    uuid,
  detalle       jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, case_id) REFERENCES support_case (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS ix_case_event ON case_event (tenant_id, case_id, creado_en);

-- ---------------------------------------------------------------- índices de consultas frecuentes
CREATE INDEX IF NOT EXISTS ix_payment_link_estado ON payment_link (estado, expira_en);
CREATE INDEX IF NOT EXISTS ix_message_conv_ocurrido ON message (conversation_id, ocurrido_en);
CREATE INDEX IF NOT EXISTS ix_customer_tenant_doc ON customer (tenant_id, numero_documento) WHERE numero_documento IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_job_tipo ON job (tipo, estado);

-- ---------------------------------------------------------------- seguridad de las tablas nuevas
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitation','case_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON login_attempt, password_reset, invitation, case_event TO app_platform;
GRANT SELECT, INSERT, UPDATE ON invitation TO app_rt;
GRANT SELECT, INSERT ON case_event TO app_rt;
REVOKE ALL ON login_attempt, password_reset FROM app_rt;
-- El historial de radicados es evidencia: solo inserción.
REVOKE UPDATE, DELETE ON case_event FROM app_rt, app_platform;
