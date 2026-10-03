-- =====================================================================
-- Plataforma SaaS Inteligente Multi-Tenant — esquema físico
-- Deriva de PRO-SW-002 §11 (modelo E-R) y §15 (diseño físico).
--
-- Decisiones fijadas (PRO-SW-002 §15):
--   * Base única, esquema único, tenant_id + RLS (barrera 2).
--   * FK compuestas (tenant_id, x_id): tercera barrera, gratuita.
--   * uuid v7 generado por la aplicación.
--   * tenant_id como primera columna de todo índice de negocio.
--   * Borrado lógico (eliminado_en) en entidades de negocio.
--   * Auditoría append-only: el rol de la aplicación no tiene UPDATE/DELETE.
--   * Dinero numeric(14,2) + moneda. Tiempo timestamptz (UTC).
--   * jsonb solo para plantilla, tema, argumentos y respuestas de proveedor.
--
-- Roles de base de datos:
--   app_rt        rol de ejecución por petición. Sujeto a RLS. Nunca BYPASSRLS.
--   app_platform  rol de plataforma (resolución de tenant, autenticación,
--                 aprovisionamiento, cola de trabajos). BYPASSRLS explícito y
--                 acotado: solo lo usa código marcado withPlatform().
-- =====================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rt') THEN
    CREATE ROLE app_rt NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform NOLOGIN BYPASSRLS;
  END IF;
  -- El usuario de conexión debe poder asumir ambos roles con SET LOCAL ROLE.
  EXECUTE format('GRANT app_rt, app_platform TO %I', current_user);
END $$;

-- Contexto de tenant de la transacción en curso; NULL si no está fijado.
CREATE OR REPLACE FUNCTION app_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------
-- PLATAFORMA (globales, sin tenant_id)
-- ---------------------------------------------------------------------
CREATE TABLE plan (
  codigo              text PRIMARY KEY,               -- esencial | negocio | pro
  nombre              text NOT NULL,
  precio_mensual      numeric(14,2) NOT NULL,
  moneda              char(3) NOT NULL DEFAULT 'COP',
  cuota_tokens_ia     bigint NOT NULL,
  cuota_mensajes      bigint NOT NULL,
  cuota_documentos    bigint NOT NULL,
  max_usuarios        int NOT NULL,
  modulos             text[] NOT NULL,
  politica_excedente  text NOT NULL CHECK (politica_excedente IN ('LIMITAR','EXCEDENTE')),
  precio_excedente_1k_tokens numeric(14,2) NOT NULL DEFAULT 0,
  orden               int NOT NULL
);

CREATE TABLE module (
  codigo       text PRIMARY KEY,
  nombre       text NOT NULL,
  descripcion  text NOT NULL
);

CREATE TABLE sector_template (
  sector      text NOT NULL,
  version     text NOT NULL,
  contenido   jsonb NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (sector, version)
);

CREATE TABLE tenant (
  id                        uuid PRIMARY KEY,
  slug                      text NOT NULL UNIQUE,
  nombre                    text NOT NULL,
  nit                       text,
  ciudad                    text,
  email_contacto            text,
  telefono                  text,
  sector                    text NOT NULL,
  sector_version            text NOT NULL,
  plan_codigo               text NOT NULL REFERENCES plan(codigo),
  whatsapp_phone_number_id  text UNIQUE,
  tema                      jsonb NOT NULL,
  logo_data_url             text,
  zona_horaria              text NOT NULL DEFAULT 'America/Bogota',
  creado_en                 timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    uuid PRIMARY KEY,
  email                 text NOT NULL UNIQUE,
  nombre                text NOT NULL,
  password_hash         text,
  es_admin_plataforma   boolean NOT NULL DEFAULT false,
  creado_en             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  id          text PRIMARY KEY,                 -- sha256 del token opaco
  user_id     uuid NOT NULL REFERENCES users(id),
  expira_en   timestamptz NOT NULL,
  creado_en   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE onboarding_draft (
  token           text PRIMARY KEY,
  estado          text NOT NULL DEFAULT 'BORRADOR'
                  CHECK (estado IN ('BORRADOR','PAGO_INICIADO','APROVISIONADO')),
  descripcion     text NOT NULL,
  clasificacion   jsonb NOT NULL,     -- CLASSIFICATION_RESULT validado
  recomendacion   jsonb NOT NULL,     -- plan + regla aplicada + explicación
  plan_codigo     text NOT NULL REFERENCES plan(codigo),
  negocio         jsonb NOT NULL DEFAULT '{}'::jsonb,
  tema            jsonb,
  logo_data_url   text,
  catalogo        jsonb,              -- filas ya confirmadas por el usuario
  import_mapping  jsonb,              -- mapeo usado (se lleva a auditoría)
  hoja_pendiente  jsonb,              -- archivo leído, a la espera de confirmación
  tenant_id       uuid REFERENCES tenant(id),
  password_token  text,
  etapas          jsonb NOT NULL DEFAULT '[]'::jsonb,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment (
  id            uuid PRIMARY KEY,
  tenant_id     uuid REFERENCES tenant(id),
  draft_token   text REFERENCES onboarding_draft(token),
  referencia    text NOT NULL UNIQUE,
  concepto      text NOT NULL,
  monto         numeric(14,2) NOT NULL,
  moneda        char(3) NOT NULL DEFAULT 'COP',
  estado        text NOT NULL CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO')),
  creado_en     timestamptz NOT NULL DEFAULT now()
);

-- Idempotencia del webhook (PRO-SW-002 fig. 10, amenaza T5).
CREATE TABLE provisioning_event (
  event_id      text PRIMARY KEY,
  tipo          text NOT NULL,
  referencia    text NOT NULL,
  payload       jsonb NOT NULL,
  resultado     text NOT NULL,
  recibido_en   timestamptz NOT NULL DEFAULT now()
);

-- Cola de trabajos del proceso trabajador (PRO-SW-002 fig. 03).
CREATE TABLE job (
  id            uuid PRIMARY KEY,
  tenant_id     uuid REFERENCES tenant(id),
  tipo          text NOT NULL,
  payload       jsonb NOT NULL,
  estado        text NOT NULL DEFAULT 'PENDIENTE'
                CHECK (estado IN ('PENDIENTE','EN_CURSO','HECHO','FALLIDO')),
  intentos      int NOT NULL DEFAULT 0,
  max_intentos  int NOT NULL DEFAULT 5,
  ejecutar_en   timestamptz NOT NULL DEFAULT now(),
  ultimo_error  text,
  clave_unica   text UNIQUE,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_job_pendiente ON job (estado, ejecutar_en);

-- ---------------------------------------------------------------------
-- IDENTIDAD Y ACCESO (con tenant_id)
-- ---------------------------------------------------------------------
CREATE TABLE role (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  clave       text NOT NULL,                  -- administrador, barbero, recepcion, agente_atencion...
  nombre      text NOT NULL,
  es_agente   boolean NOT NULL DEFAULT false, -- rol que asume un agente de IA
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, clave)
);

CREATE TABLE role_permission (
  tenant_id   uuid NOT NULL,
  role_id     uuid NOT NULL,
  permiso     text NOT NULL,
  PRIMARY KEY (tenant_id, role_id, permiso),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);

CREATE TABLE user_tenant (
  user_id       uuid NOT NULL REFERENCES users(id),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  role_id       uuid NOT NULL,
  activo        boolean NOT NULL DEFAULT true,
  disponible    boolean NOT NULL DEFAULT true,    -- para el motor de asignación
  habilidades   text[] NOT NULL DEFAULT '{}',
  creado_en     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);

CREATE TABLE tenant_module (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  modulo      text NOT NULL REFERENCES module(codigo),
  activo      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, modulo)
);

CREATE TABLE subscription (
  tenant_id         uuid PRIMARY KEY REFERENCES tenant(id),
  plan_codigo       text NOT NULL REFERENCES plan(codigo),
  estado            text NOT NULL CHECK (estado IN ('ACTIVA','PAGO_PENDIENTE','EN_GRACIA','SUSPENDIDA','CANCELADA')),
  periodo_inicio    timestamptz NOT NULL,
  periodo_fin       timestamptz NOT NULL,
  gracia_hasta      timestamptz,
  actualizado_en    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_record (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  periodo     char(7) NOT NULL,                 -- AAAA-MM
  metrica     text NOT NULL CHECK (metrica IN ('tokens_ia','mensajes','documentos','plantillas_marketing')),
  cantidad    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, periodo, metrica)
);

-- ---------------------------------------------------------------------
-- NEGOCIO
-- ---------------------------------------------------------------------
CREATE TABLE customer (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  nombre              text NOT NULL,
  telefono            text,
  email               text,
  tipo_documento      text CHECK (tipo_documento IN ('CC','NIT','CE','PP')),
  numero_documento    text,
  consentimiento_en   timestamptz,
  consentimiento_via  text,
  notas               text,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  eliminado_en        timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX ux_customer_tenant_tel ON customer (tenant_id, telefono) WHERE telefono IS NOT NULL AND eliminado_en IS NULL;
CREATE INDEX ix_customer_tenant_nombre ON customer (tenant_id, nombre);

-- Recursos agendables (barberos, cabinas, entrenadores...)
CREATE TABLE resource (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  nombre      text NOT NULL,
  user_id     uuid REFERENCES users(id),
  horario     jsonb NOT NULL,     -- {"lun":["09:00","19:00"], ...}
  activo      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id)
);

CREATE TABLE product (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  tipo            text NOT NULL CHECK (tipo IN ('PRODUCTO','SERVICIO')),
  nombre          text NOT NULL,
  categoria       text,
  precio          numeric(14,2) NOT NULL CHECK (precio >= 0),
  moneda          char(3) NOT NULL DEFAULT 'COP',
  iva_pct         numeric(5,2) NOT NULL DEFAULT 0,
  duracion_min    int,
  controla_stock  boolean NOT NULL DEFAULT false,
  stock           numeric(14,2) NOT NULL DEFAULT 0,
  stock_minimo    numeric(14,2) NOT NULL DEFAULT 0,
  sku             text,
  activo          boolean NOT NULL DEFAULT true,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  eliminado_en    timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX ix_product_tenant_nombre ON product (tenant_id, nombre);

CREATE TABLE stock_movement (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  product_id    uuid NOT NULL,
  tipo          text NOT NULL CHECK (tipo IN ('ENTRADA','SALIDA','AJUSTE')),
  cantidad      numeric(14,2) NOT NULL,
  motivo        text NOT NULL,
  order_id      uuid,
  actor         text NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
CREATE INDEX ix_stock_tenant_prod ON stock_movement (tenant_id, product_id, creado_en DESC);

CREATE TABLE appointment (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  customer_id   uuid NOT NULL,
  product_id    uuid NOT NULL,
  resource_id   uuid NOT NULL,
  inicio        timestamptz NOT NULL,
  fin           timestamptz NOT NULL,
  estado        text NOT NULL CHECK (estado IN ('RESERVADA','CONFIRMADA','CANCELADA','ATENDIDA','NO_ASISTIO')),
  origen        text NOT NULL CHECK (origen IN ('AGENTE','PANEL')),
  notas         text,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id)  REFERENCES product  (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resource (tenant_id, id)
);
CREATE INDEX ix_appt_tenant_inicio ON appointment (tenant_id, inicio);
CREATE INDEX ix_appt_tenant_recurso ON appointment (tenant_id, resource_id, inicio);

CREATE TABLE "order" (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  numero          int NOT NULL,
  customer_id     uuid NOT NULL,
  estado          text NOT NULL CHECK (estado IN ('BORRADOR','CONFIRMADA','ANULADA')),
  origen          text NOT NULL CHECK (origen IN ('AGENTE','PANEL')),
  subtotal        numeric(14,2) NOT NULL,
  impuestos       numeric(14,2) NOT NULL,
  total           numeric(14,2) NOT NULL,
  moneda          char(3) NOT NULL DEFAULT 'COP',
  estado_pago     text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado_pago IN ('PENDIENTE','PAGADA','NO_APLICA')),
  conversation_id uuid,
  appointment_id  uuid,
  creado_por      text NOT NULL,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  eliminado_en    timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, numero),
  -- La FK compuesta impide referenciar un cliente de OTRO tenant (PRO-SW-002 §15.1).
  CONSTRAINT fk_customer_same_tenant FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id)
);
CREATE INDEX ix_order_tenant_creado ON "order" (tenant_id, creado_en DESC);
CREATE INDEX ix_order_tenant_cliente ON "order" (tenant_id, customer_id);

CREATE TABLE order_item (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  order_id      uuid NOT NULL,
  product_id    uuid NOT NULL,
  descripcion   text NOT NULL,
  cantidad      numeric(14,2) NOT NULL CHECK (cantidad > 0),
  precio_unit   numeric(14,2) NOT NULL,
  iva_pct       numeric(5,2) NOT NULL,
  total         numeric(14,2) NOT NULL,
  FOREIGN KEY (tenant_id, order_id)   REFERENCES "order" (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
CREATE INDEX ix_item_tenant_order ON order_item (tenant_id, order_id);

-- Cuenta de pasarela PROPIA del comercio (RF-024, ADR-09).
CREATE TABLE merchant_gateway_account (
  tenant_id       uuid PRIMARY KEY REFERENCES tenant(id),
  proveedor       text NOT NULL,
  cuenta_id       text NOT NULL,
  llave_cifrada   text NOT NULL,
  vinculado_en    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_link (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  order_id      uuid NOT NULL,
  referencia    text NOT NULL UNIQUE,
  url           text NOT NULL,
  estado        text NOT NULL CHECK (estado IN ('ABIERTO','PAGADO','EXPIRADO')),
  creado_en     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- COMUNICACIÓN
-- ---------------------------------------------------------------------
CREATE TABLE conversation (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  customer_id     uuid NOT NULL,
  canal           text NOT NULL CHECK (canal IN ('WHATSAPP','WEB')),
  estado          text NOT NULL CHECK (estado IN ('ABIERTA','ESCALADA','CERRADA')),
  control         text NOT NULL CHECK (control IN ('AI','HUMANO')),
  resuelta_por    text CHECK (resuelta_por IN ('AGENTE','PERSONA')),
  ultimo_mensaje_cliente_en timestamptz,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id)
);
CREATE INDEX ix_conv_bandeja ON conversation (tenant_id, customer_id, actualizado_en DESC);
CREATE INDEX ix_conv_tenant_act ON conversation (tenant_id, actualizado_en DESC);

-- La conversación es una secuencia de eventos, no un texto final (PRO-SW-001 §14.1).
CREATE TABLE message (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  conversation_id   uuid NOT NULL,
  remitente         text NOT NULL CHECK (remitente IN ('CUSTOMER','AI','SYSTEM','HUMAN')),
  autor_user_id     uuid,
  canal             text NOT NULL,
  tipo              text NOT NULL DEFAULT 'TEXTO' CHECK (tipo IN ('TEXTO','NOTA_INTERNA','DOCUMENTO','PLANTILLA')),
  contenido         text NOT NULL,
  metadatos         jsonb NOT NULL DEFAULT '{}'::jsonb,
  id_externo        text,
  estado_entrega    text NOT NULL DEFAULT 'N/A' CHECK (estado_entrega IN ('N/A','PENDIENTE','ENVIADO','ENTREGADO','FALLIDO')),
  creado_en         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversation (tenant_id, id)
);
CREATE INDEX ix_msg_conv ON message (conversation_id, creado_en);
CREATE UNIQUE INDEX ux_msg_externo ON message (tenant_id, id_externo) WHERE id_externo IS NOT NULL;

CREATE TABLE sla_policy (
  tenant_id               uuid NOT NULL REFERENCES tenant(id),
  prioridad               text NOT NULL CHECK (prioridad IN ('BAJA','MEDIA','ALTA','URGENTE')),
  minutos_primera_respuesta int NOT NULL,
  PRIMARY KEY (tenant_id, prioridad)
);

CREATE TABLE support_case (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  radicado            text NOT NULL,
  conversation_id     uuid NOT NULL,
  motivo              text NOT NULL,
  prioridad           text NOT NULL CHECK (prioridad IN ('BAJA','MEDIA','ALTA','URGENTE')),
  estado              text NOT NULL CHECK (estado IN ('EN_COLA','ASIGNADO','EN_ATENCION','CERRADO')),
  asignado_a          uuid REFERENCES users(id),
  resumen_ia          text,
  sla_vence_en        timestamptz NOT NULL,
  primera_respuesta_en timestamptz,
  cerrado_en          timestamptz,
  motivo_cierre       text,
  creado_en           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, radicado),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversation (tenant_id, id)
);
CREATE INDEX ix_case_cola ON support_case (tenant_id, estado, prioridad, creado_en);

CREATE TABLE message_template (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  clave       text NOT NULL,
  categoria   text NOT NULL CHECK (categoria IN ('UTILIDAD','MARKETING','AUTENTICACION')),
  cuerpo      text NOT NULL,
  PRIMARY KEY (tenant_id, clave)
);

CREATE TABLE email_outbox (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  para          text NOT NULL,
  asunto        text NOT NULL,
  cuerpo_html   text NOT NULL,
  adjunto_ref   text,
  estado        text NOT NULL CHECK (estado IN ('PENDIENTE','ENVIADO','ENTREGADO','REBOTADO','FALLIDO')),
  id_proveedor  text,
  conversation_id uuid,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- INTELIGENCIA ARTIFICIAL
-- ---------------------------------------------------------------------
CREATE TABLE ai_agent (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  configuracion   text NOT NULL CHECK (configuracion IN ('atencion','asistente','copiloto')),
  role_id         uuid NOT NULL,
  prompt_base     text NOT NULL,
  herramientas    text[] NOT NULL,
  activo          boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, configuracion),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);

-- Interruptor por herramienta y por tenant (Centro de IA).
CREATE TABLE ai_tool_setting (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  herramienta   text NOT NULL,
  habilitada    boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, herramienta)
);

-- Acciones que esperan confirmación explícita del humano.
CREATE TABLE pending_action (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  conversation_id   uuid NOT NULL,
  agent_id          uuid NOT NULL,
  herramienta       text NOT NULL,
  argumentos        jsonb NOT NULL,
  resumen           text NOT NULL,
  estado            text NOT NULL CHECK (estado IN ('PENDIENTE','CONFIRMADA','RECHAZADA','EXPIRADA')),
  expira_en         timestamptz NOT NULL,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversation (tenant_id, id)
);

-- Registro de ejecuciones: guarda decisión y motivo, no solo éxitos (PRO-SW-002 fig. 11).
-- Solo inserción, igual que la auditoría.
CREATE TABLE ai_execution (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  agent_id            uuid,
  configuracion       text NOT NULL,
  conversation_id     uuid,
  herramienta         text NOT NULL,
  version_herramienta text,
  argumentos          jsonb NOT NULL,
  nivel_riesgo        text,
  permiso_requerido   text,
  decision            text NOT NULL CHECK (decision IN ('PERMITIDA','DENEGADA','PENDIENTE_CONFIRMACION','CONFIRMADA','RECHAZADA_POR_CLIENTE','ERROR')),
  motivo_denegacion   text,
  comprobacion_fallida smallint,           -- 1..4 según PRO-SW-002 fig. 07b
  confirmado_por      text,
  resultado           jsonb,
  pending_action_id   uuid,
  duracion_ms         int,
  creado_en           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_aiexec_tenant_creado ON ai_execution (tenant_id, creado_en DESC);
CREATE INDEX ix_aiexec_tenant_decision ON ai_execution (tenant_id, decision);
CREATE INDEX ix_aiexec_conv ON ai_execution (tenant_id, conversation_id, creado_en);

-- ---------------------------------------------------------------------
-- AUTOMATIZACIÓN Y EVENTOS
-- ---------------------------------------------------------------------
CREATE TABLE automation_rule (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  evento        text NOT NULL,
  condicion     jsonb NOT NULL DEFAULT '{}'::jsonb,
  accion        text NOT NULL,
  parametros    jsonb NOT NULL DEFAULT '{}'::jsonb,
  activa        boolean NOT NULL DEFAULT true,
  origen        text NOT NULL DEFAULT 'PLANTILLA'
);

CREATE TABLE domain_event (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  tipo          text NOT NULL,
  payload       jsonb NOT NULL,
  actor         text NOT NULL,
  procesado     boolean NOT NULL DEFAULT false,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_event_pend ON domain_event (procesado, creado_en);

-- ---------------------------------------------------------------------
-- FACTURACIÓN ELECTRÓNICA
-- ---------------------------------------------------------------------
CREATE TABLE fiscal_resolution (
  tenant_id     uuid PRIMARY KEY REFERENCES tenant(id),
  prefijo       text NOT NULL,
  numero_desde  int NOT NULL,
  numero_hasta  int NOT NULL,
  siguiente     int NOT NULL,
  resolucion    text NOT NULL
);

-- Entidad con estado propio, no un campo de la orden (PRO-SW-002 fig. 09).
CREATE TABLE fiscal_document (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  tipo              text NOT NULL CHECK (tipo IN ('FACTURA','NOTA_CREDITO')),
  numero            text NOT NULL,
  order_id          uuid NOT NULL,
  documento_ref_id  uuid,
  estado            text NOT NULL CHECK (estado IN ('PENDIENTE','ENVIADO','VALIDADO','RECHAZADO','ENTREGADO')),
  cufe              text,
  motivo_rechazo    text,
  total             numeric(14,2) NOT NULL,
  moneda            char(3) NOT NULL DEFAULT 'COP',
  entrega_whatsapp  text NOT NULL DEFAULT 'PENDIENTE',
  entrega_email     text NOT NULL DEFAULT 'PENDIENTE',
  token_publico     text NOT NULL UNIQUE,
  intentos          int NOT NULL DEFAULT 0,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  validado_en       timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, numero),
  FOREIGN KEY (tenant_id, order_id) REFERENCES "order" (tenant_id, id)
);
CREATE INDEX ix_fiscal_tenant_estado ON fiscal_document (tenant_id, estado);

CREATE TABLE provider_transaction (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  fiscal_document_id uuid NOT NULL,
  operacion         text NOT NULL,
  solicitud         jsonb NOT NULL,
  respuesta         jsonb,
  exito             boolean NOT NULL,
  creado_en         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, fiscal_document_id) REFERENCES fiscal_document (tenant_id, id)
);

-- ---------------------------------------------------------------------
-- TRANSVERSAL: AUDITORÍA (append-only, amenaza T10)
-- ---------------------------------------------------------------------
CREATE TABLE audit_event (
  id            uuid PRIMARY KEY,
  tenant_id     uuid REFERENCES tenant(id),
  actor_tipo    text NOT NULL CHECK (actor_tipo IN ('USUARIO','AGENTE','SISTEMA','CLIENTE','PLATAFORMA','ANONIMO')),
  actor_id      text,
  actor_nombre  text,
  accion        text NOT NULL,
  recurso       text,
  recurso_id    text,
  resultado     text NOT NULL CHECK (resultado IN ('PERMITIDO','DENEGADO','NO_ENCONTRADO','ERROR','EXITO')),
  origen        text NOT NULL,
  correlacion   text,
  detalle       jsonb NOT NULL DEFAULT '{}'::jsonb,
  creado_en     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_tenant_creado ON audit_event (tenant_id, creado_en DESC);
CREATE INDEX ix_audit_tenant_accion ON audit_event (tenant_id, accion);

-- =====================================================================
-- ROW-LEVEL SECURITY (barrera 2)
-- ENABLE + FORCE en toda tabla con tenant_id. FORCE no es opcional:
-- sin él, el propietario de la tabla ignora la política (PRO-SW-002 §4.1).
-- =====================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'role','role_permission','user_tenant','tenant_module','subscription','usage_record',
    'customer','resource','product','stock_movement','appointment','order','order_item',
    'merchant_gateway_account','payment_link','conversation','message','sla_policy',
    'support_case','message_template','email_outbox','ai_agent','ai_tool_setting',
    'pending_action','ai_execution','automation_rule','domain_event','fiscal_resolution',
    'fiscal_document','provider_transaction','audit_event'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;

-- El registro de tenants también se aísla: desde un contexto solo se ve el propio.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant USING (id = app_tenant());

-- El rol de ejecución solo encola (y ve) trabajos de su propio tenant.
ALTER TABLE job ENABLE ROW LEVEL SECURITY;
ALTER TABLE job FORCE ROW LEVEL SECURITY;
CREATE POLICY job_tenant ON job USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());

-- =====================================================================
-- PRIVILEGIOS
-- =====================================================================
GRANT USAGE ON SCHEMA public TO app_rt, app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rt, app_platform;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rt, app_platform;
GRANT EXECUTE ON FUNCTION app_tenant() TO app_rt, app_platform;

-- El rol de ejecución no ve tablas de plataforma sensibles.
REVOKE ALL ON users, session, onboarding_draft, provisioning_event, job, payment FROM app_rt;
GRANT SELECT (id, email, nombre) ON users TO app_rt;
-- SELECT es necesario para ON CONFLICT; la RLS limita la lectura a los trabajos del propio tenant.
GRANT SELECT, INSERT ON job TO app_rt;
-- Catálogos globales: solo lectura para el rol de ejecución.
REVOKE INSERT, UPDATE, DELETE ON plan, module, sector_template, tenant FROM app_rt;

-- Solo inserción: la aplicación no puede alterar la evidencia (T10).
REVOKE UPDATE, DELETE ON audit_event, ai_execution FROM app_rt, app_platform;
