-- =====================================================================
-- 003 · Correo transaccional, códigos de un solo uso y panel del operador
-- Aditiva: se aplica sobre bases creadas con 001 y 002 sin perder datos.
-- =====================================================================

-- ---------------------------------------------------------------- identidad
-- Correo verificado y rol de plataforma (independiente de los roles de empresa).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verificado_en timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS rol_plataforma text CHECK (rol_plataforma IN ('ADMIN','SOPORTE'));
-- Cuentas existentes: ya operaban con su correo; no se les exige verificar de nuevo.
UPDATE users SET email_verificado_en = coalesce(contrasena_cambiada_en, creado_en) WHERE email_verificado_en IS NULL AND password_hash IS NOT NULL;
UPDATE users SET rol_plataforma = 'ADMIN' WHERE es_admin_plataforma AND rol_plataforma IS NULL;
-- La sesión registra si se completó el segundo factor (obligatorio para el operador).
ALTER TABLE session ADD COLUMN IF NOT EXISTS segundo_factor boolean NOT NULL DEFAULT false;

-- Códigos de un solo uso. Se guarda un HMAC del código (clave del servidor), nunca el código.
CREATE TABLE IF NOT EXISTS otp_code (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id),
  proposito      text NOT NULL CHECK (proposito IN ('VERIFICAR_CORREO','ACCESO_PLATAFORMA')),
  codigo_hash    text NOT NULL,
  desafio_hash   text,
  ip_hash        text,
  intentos       int NOT NULL DEFAULT 0,
  max_intentos   int NOT NULL DEFAULT 5,
  expira_en      timestamptz NOT NULL,
  usado_en       timestamptz,
  invalidado_en  timestamptz,
  creado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_otp_usuario ON otp_code (user_id, proposito, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_otp_desafio ON otp_code (desafio_hash) WHERE desafio_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_otp_ip ON otp_code (ip_hash, creado_en DESC);

-- ---------------------------------------------------------------- correo saliente
ALTER TABLE email_outbox ALTER COLUMN cuerpo_html DROP NOT NULL;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'general';
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS cuerpo_texto text;
-- Correos con códigos o enlaces de acceso: el contenido va cifrado y se borra al enviarse.
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS sensible boolean NOT NULL DEFAULT false;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS contenido_cifrado text;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS responder_a text;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS caduca_en timestamptz;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS clave_idempotencia text;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS proveedor text;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS intentos int NOT NULL DEFAULT 0;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS ultimo_intento_en timestamptz;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS aceptado_en timestamptz;
ALTER TABLE email_outbox ADD COLUMN IF NOT EXISTS entregado_en timestamptz;
ALTER TABLE email_outbox DROP CONSTRAINT IF EXISTS email_outbox_estado_check;
-- ENVIADO = aceptado por el proveedor (no implica entrega). ENTREGADO solo llega por webhook.
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_estado_check CHECK (estado IN ('PENDIENTE','ENVIADO','ENTREGADO','REBOTADO','QUEJA','FALLIDO'));
CREATE UNIQUE INDEX IF NOT EXISTS ux_email_clave ON email_outbox (clave_idempotencia) WHERE clave_idempotencia IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_email_proveedor ON email_outbox (id_proveedor) WHERE id_proveedor IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_email_estado ON email_outbox (estado, creado_en);

-- ---------------------------------------------------------------- consumo técnico de IA (sin contenido)
CREATE TABLE IF NOT EXISTS ia_consumo (
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  dia              date NOT NULL,
  modelo           text NOT NULL,
  llamadas         int NOT NULL DEFAULT 0,
  errores          int NOT NULL DEFAULT 0,
  tokens_entrada   bigint NOT NULL DEFAULT 0,
  tokens_salida    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, dia, modelo)
);

-- ---------------------------------------------------------------- observabilidad
-- Métricas HTTP agregadas por minuto y ruta (plantilla de ruta, nunca la URL con datos).
CREATE TABLE IF NOT EXISTS metrica_http (
  minuto   timestamptz NOT NULL,
  metodo   text NOT NULL,
  ruta     text NOT NULL,
  clase    smallint NOT NULL,
  n        int NOT NULL,
  suma_ms  bigint NOT NULL,
  max_ms   int NOT NULL,
  hist     int[] NOT NULL,
  PRIMARY KEY (minuto, metodo, ruta, clase)
);

-- Incidentes técnicos: código seguro, descripción del catálogo y datos permitidos.
CREATE TABLE IF NOT EXISTS incidente (
  id            uuid PRIMARY KEY,
  codigo        text NOT NULL,
  servicio      text NOT NULL,
  gravedad      text NOT NULL CHECK (gravedad IN ('BAJA','MEDIA','ALTA','CRITICA')),
  estado        text NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO','RECONOCIDO','RESUELTO')),
  huella        text NOT NULL,
  tenant_id     uuid,
  trabajo_id    uuid,
  correlacion   text,
  version       text,
  detalle       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ocurrencias   int NOT NULL DEFAULT 1,
  primera_vez   timestamptz NOT NULL DEFAULT now(),
  ultima_vez    timestamptz NOT NULL DEFAULT now(),
  resuelto_en   timestamptz,
  nota          text
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_incidente_abierto ON incidente (huella) WHERE estado <> 'RESUELTO';
CREATE INDEX IF NOT EXISTS ix_incidente_estado ON incidente (estado, ultima_vez DESC);

-- Auditoría del operador: append-only, sin datos privados de los negocios.
CREATE TABLE IF NOT EXISTS auditoria_plataforma (
  id            uuid PRIMARY KEY,
  actor_id      uuid,
  actor_email   text,
  accion        text NOT NULL,
  recurso       text,
  recurso_id    text,
  tenant_id     uuid,
  motivo        text,
  resultado     text NOT NULL CHECK (resultado IN ('EXITO','DENEGADO','ERROR','SIN_CAMBIOS')),
  correlacion   text,
  detalle       jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_aud_plat ON auditoria_plataforma (creado_en DESC);

-- ---------------------------------------------------------------- soporte de la plataforma (empresa → Omnegia)
CREATE SEQUENCE IF NOT EXISTS soporte_ticket_seq;
CREATE TABLE IF NOT EXISTS soporte_ticket (
  id                  uuid PRIMARY KEY,
  numero              text NOT NULL UNIQUE,
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  creado_por          uuid NOT NULL,
  solicitante_nombre  text NOT NULL,
  solicitante_email   text NOT NULL,
  categoria           text NOT NULL CHECK (categoria IN ('CUENTA','FACTURACION','WHATSAPP','IA','TECNICO','OTRO')),
  prioridad           text NOT NULL CHECK (prioridad IN ('BAJA','NORMAL','ALTA','URGENTE')),
  estado              text NOT NULL DEFAULT 'ABIERTO' CHECK (estado IN ('ABIERTO','EN_PROCESO','ESPERANDO_CLIENTE','RESUELTO','CERRADO')),
  asunto              text NOT NULL,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  actualizado_en      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ticket_tenant ON soporte_ticket (tenant_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_ticket_estado ON soporte_ticket (estado, actualizado_en DESC);
CREATE TABLE IF NOT EXISTS soporte_mensaje (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  ticket_id     uuid NOT NULL REFERENCES soporte_ticket(id),
  autor_tipo    text NOT NULL CHECK (autor_tipo IN ('EMPRESA','OPERADOR')),
  autor_nombre  text NOT NULL,
  cuerpo        text NOT NULL,
  correo_id     uuid,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_ticket_msg ON soporte_mensaje (ticket_id, creado_en);

-- ---------------------------------------------------------------- aislamiento de las tablas nuevas
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ia_consumo','soporte_ticket','soporte_mensaje'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON otp_code, metrica_http, incidente TO app_platform;
GRANT SELECT, INSERT, UPDATE ON ia_consumo, soporte_ticket, soporte_mensaje TO app_platform, app_rt;
GRANT SELECT, INSERT ON auditoria_plataforma TO app_platform;
GRANT USAGE, SELECT ON SEQUENCE soporte_ticket_seq TO app_platform, app_rt;
REVOKE ALL ON otp_code, metrica_http, incidente, auditoria_plataforma FROM app_rt;
GRANT SELECT (email_verificado_en) ON users TO app_rt;

-- =====================================================================
-- Rol del operador de Omnegia (panel interno). Sin BYPASSRLS y con
-- privilegios por columna: solo puede leer lo que el panel necesita para
-- administrar la relación comercial y la salud técnica. No tiene acceso a
-- clientes, conversaciones, mensajes, citas, ventas, inventario, facturas,
-- cuentas de cobro de los comercios, sesiones, contraseñas ni secretos.
-- Es una barrera de la aplicación: quien administra la infraestructura
-- (el usuario propietario de la base) conserva sus privilegios.
-- =====================================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    CREATE ROLE app_operador NOLOGIN;
  END IF;
  EXECUTE format('GRANT app_operador TO %I', current_user);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_operador;
GRANT USAGE ON SCHEMA public TO app_operador;

GRANT SELECT ON plan, module TO app_operador;
GRANT UPDATE (cuota_tokens_ia, cuota_mensajes, cuota_documentos, max_usuarios) ON plan TO app_operador;

GRANT SELECT (id, slug, nombre, sector, plan_codigo, email_contacto, creado_en, whatsapp_estado, whatsapp_verificado_en) ON tenant TO app_operador;
GRANT UPDATE (plan_codigo) ON tenant TO app_operador;
GRANT SELECT (tenant_id, plan_codigo, estado, periodo_inicio, periodo_fin, gracia_hasta, actualizado_en) ON subscription TO app_operador;
GRANT UPDATE (plan_codigo, estado, periodo_fin, gracia_hasta, actualizado_en) ON subscription TO app_operador;
GRANT SELECT, INSERT, UPDATE ON tenant_module TO app_operador;
GRANT SELECT ON usage_record TO app_operador;
GRANT SELECT (tenant_id, activo) ON user_tenant TO app_operador;
GRANT SELECT (id, tenant_id, referencia, concepto, monto, moneda, estado, proveedor, creado_en, actualizado_en) ON payment TO app_operador;
-- clave_unica solo contiene identificadores (p. ej. «mail:<id>»): permite reintentar sin leer el payload.
GRANT SELECT (id, tenant_id, tipo, estado, intentos, max_intentos, ejecutar_en, creado_en, clave_unica) ON job TO app_operador;
GRANT UPDATE (estado, intentos, ejecutar_en) ON job TO app_operador;
GRANT SELECT (id, tenant_id, tipo, estado, proveedor, intentos, error, sensible, caduca_en, creado_en, aceptado_en, entregado_en) ON email_outbox TO app_operador;
GRANT UPDATE (estado, error) ON email_outbox TO app_operador;
GRANT SELECT ON ia_consumo, metrica_http TO app_operador;
GRANT SELECT, UPDATE ON incidente TO app_operador;
GRANT SELECT, INSERT ON auditoria_plataforma TO app_operador;
GRANT SELECT, UPDATE ON soporte_ticket TO app_operador;
GRANT SELECT, INSERT ON soporte_mensaje TO app_operador;
GRANT EXECUTE ON FUNCTION app_tenant() TO app_operador;

-- Las tablas con RLS necesitan una política explícita para el operador.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant','subscription','tenant_module','usage_record','user_tenant','job','email_outbox','ia_consumo','soporte_ticket','soporte_mensaje'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'operador') THEN
      EXECUTE format('CREATE POLICY operador ON %I TO app_operador USING (true) WITH CHECK (true)', t);
    END IF;
  END LOOP;
END $$;

-- Evidencia: nadie la modifica desde la aplicación.
REVOKE UPDATE, DELETE ON auditoria_plataforma FROM app_platform, app_operador, app_rt;
