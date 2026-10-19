-- =====================================================================
-- 012 · Atención por WhatsApp desde el panel del operador
--
--  1. Conversaciones del número de WhatsApp de Omnegia (antes no se guardaban):
--     el asistente recuerda el hilo, una persona del equipo puede tomarlo y
--     queda la trazabilidad. Se conservan PLATAFORMA_RETENCION_DIAS (90) días
--     después del último mensaje (ver modules/plataformaConversaciones.ts).
--  2. Solicitudes de soporte nacidas en WhatsApp (sin empresa verificada).
--  3. Supervisión de la atención de las empresas SIN contenido: el rol del
--     operador lee solo columnas de estado (nunca el texto, el cliente ni su
--     teléfono).
--  4. Acceso de soporte autorizado por la empresa: un rol aparte (app_soporte)
--     lee una conversación concreta solo mientras la empresa lo permita.
-- Aditiva: no borra ni reescribe datos existentes.
-- =====================================================================

-- ---------------------------------------------------------------- canal propio de Omnegia
CREATE TABLE plataforma_conversacion (
  id                          uuid PRIMARY KEY,
  telefono                    text NOT NULL UNIQUE,            -- un hilo por número (se reabre si vuelve a escribir)
  phone_number_id             text NOT NULL,                   -- número de Omnegia que recibió el mensaje
  nombre_perfil               text,
  estado                      text NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA','ESCALADA','CERRADA')),
  control                     text NOT NULL DEFAULT 'AI' CHECK (control IN ('AI','HUMANO')),
  asignado_a                  uuid REFERENCES users(id),
  tomado_en                   timestamptz,
  -- Empresa cuyo teléfono de contacto coincide con el número (sin verificar identidad).
  tenant_relacionado          uuid REFERENCES tenant(id),
  -- Todas las empresas con ese teléfono de contacto: contexto para el equipo, nunca para quien escribe.
  empresas_relacionadas       uuid[] NOT NULL DEFAULT '{}',
  -- Estado del diálogo (tema, paso, intentos). Nunca guarda contenido de mensajes.
  contexto                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ticket_id                   uuid REFERENCES soporte_ticket(id),
  escalada_en                 timestamptz,
  primera_respuesta_humana_en timestamptz,
  ultimo_mensaje_cliente_en   timestamptz,
  ultimo_mensaje_en           timestamptz,
  cerrada_en                  timestamptz,
  motivo_cierre               text,
  creado_en                   timestamptz NOT NULL DEFAULT now(),
  actualizado_en              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_plat_conv_bandeja ON plataforma_conversacion (estado, ultimo_mensaje_en DESC);
CREATE INDEX ix_plat_conv_asignado ON plataforma_conversacion (asignado_a) WHERE asignado_a IS NOT NULL;

CREATE TABLE plataforma_mensaje (
  id                 uuid PRIMARY KEY,
  conversacion_id    uuid NOT NULL REFERENCES plataforma_conversacion(id) ON DELETE CASCADE,
  remitente          text NOT NULL CHECK (remitente IN ('CLIENTE','ASISTENTE','OPERADOR','SISTEMA')),
  autor_user_id      uuid REFERENCES users(id),
  autor_nombre       text,
  tipo               text NOT NULL DEFAULT 'TEXTO' CHECK (tipo IN ('TEXTO','NOTA_INTERNA','MEDIA','NO_SOPORTADO')),
  contenido          text NOT NULL,
  -- Intención detectada, paso del flujo y acción ejecutada (sin datos sensibles).
  metadatos          jsonb NOT NULL DEFAULT '{}'::jsonb,
  id_externo         text,
  id_externo_salida  text,
  estado_entrega     text NOT NULL DEFAULT 'N/A' CHECK (estado_entrega IN ('N/A','PENDIENTE','ENVIADO','ENTREGADO','LEIDO','FALLIDO','SIMULADO')),
  error_entrega      text,
  ocurrido_en        timestamptz,
  creado_en          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_plat_msg_externo ON plataforma_mensaje (id_externo) WHERE id_externo IS NOT NULL;
CREATE UNIQUE INDEX ux_plat_msg_salida ON plataforma_mensaje (id_externo_salida) WHERE id_externo_salida IS NOT NULL;
CREATE INDEX ix_plat_msg_conv ON plataforma_mensaje (conversacion_id, creado_en);

-- Datos de Omnegia (no de una empresa): sin tenant_id ni RLS. El rol de ejecución de las empresas no los ve.
-- El panel del operador los lee con su rol; las escrituras (responder, tomar, cerrar) las hace el servidor
-- con el rol de plataforma después de comprobar el permiso del operador, porque encolan el envío a WhatsApp.
GRANT SELECT, INSERT, UPDATE, DELETE ON plataforma_conversacion, plataforma_mensaje TO app_platform;
REVOKE ALL ON plataforma_conversacion, plataforma_mensaje FROM app_rt;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT ON plataforma_conversacion, plataforma_mensaje TO app_operador;
  END IF;
END $$;

-- ---------------------------------------------------------------- soporte nacido en WhatsApp
-- Una solicitud por WhatsApp no tiene empresa ni usuario verificados: la empresa
-- relacionada se guarda aparte (no es la llave de aislamiento) y la empresa no la ve en su panel.
ALTER TABLE soporte_ticket ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE soporte_ticket ALTER COLUMN creado_por DROP NOT NULL;
ALTER TABLE soporte_ticket ALTER COLUMN solicitante_email DROP NOT NULL;
ALTER TABLE soporte_ticket ADD COLUMN IF NOT EXISTS canal text NOT NULL DEFAULT 'PANEL';
ALTER TABLE soporte_ticket ADD COLUMN IF NOT EXISTS conversacion_id uuid REFERENCES plataforma_conversacion(id) ON DELETE SET NULL;
ALTER TABLE soporte_ticket ADD COLUMN IF NOT EXISTS tenant_relacionado uuid REFERENCES tenant(id);
ALTER TABLE soporte_ticket ADD COLUMN IF NOT EXISTS solicitante_telefono text;
ALTER TABLE soporte_ticket DROP CONSTRAINT IF EXISTS soporte_ticket_canal_check;
ALTER TABLE soporte_ticket ADD CONSTRAINT soporte_ticket_canal_check CHECK (canal IN ('PANEL','WHATSAPP'));
-- Una solicitud del panel siempre tiene empresa y autor.
ALTER TABLE soporte_ticket DROP CONSTRAINT IF EXISTS soporte_ticket_origen_check;
ALTER TABLE soporte_ticket ADD CONSTRAINT soporte_ticket_origen_check CHECK (canal = 'WHATSAPP' OR (tenant_id IS NOT NULL AND creado_por IS NOT NULL AND solicitante_email IS NOT NULL));
ALTER TABLE soporte_mensaje ALTER COLUMN tenant_id DROP NOT NULL;
-- El resumen con que el asistente abre una solicitud de WhatsApp lo firma el sistema.
ALTER TABLE soporte_mensaje DROP CONSTRAINT IF EXISTS soporte_mensaje_autor_tipo_check;
ALTER TABLE soporte_mensaje ADD CONSTRAINT soporte_mensaje_autor_tipo_check CHECK (autor_tipo IN ('EMPRESA','OPERADOR','SISTEMA'));
CREATE INDEX IF NOT EXISTS ix_ticket_conversacion ON soporte_ticket (conversacion_id) WHERE conversacion_id IS NOT NULL;

-- Historial de cada conversación del operador: se consulta por recurso.
CREATE INDEX IF NOT EXISTS ix_aud_plat_recurso ON auditoria_plataforma (recurso, recurso_id, creado_en);

-- Equipo de Omnegia (nombres de quien atiende). Vista con los derechos de su dueño: el operador
-- solo ve personas con rol de plataforma, nunca el directorio de usuarios de las empresas.
CREATE VIEW operador_equipo AS SELECT id, nombre, email, rol_plataforma FROM users WHERE rol_plataforma IS NOT NULL;
REVOKE ALL ON operador_equipo FROM PUBLIC;
GRANT SELECT ON operador_equipo TO app_platform;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN GRANT SELECT ON operador_equipo TO app_operador; END IF;
END $$;

-- ---------------------------------------------------------------- supervisión sin contenido
-- El operador ve el estado de la atención de cada empresa (abiertas, escaladas, tiempos,
-- entregas fallidas) pero no el texto, el cliente, su teléfono ni el motivo del radicado.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT (id, tenant_id, canal, estado, control, resuelta_por, ultimo_mensaje_cliente_en, creado_en, actualizado_en) ON conversation TO app_operador;
    GRANT SELECT (id, tenant_id, radicado, conversation_id, prioridad, estado, asignado_a, sla_vence_en, primera_respuesta_en, tomado_en, cerrado_en, creado_en) ON support_case TO app_operador;
    GRANT SELECT (id, tenant_id, conversation_id, remitente, tipo, estado_entrega, ocurrido_en, creado_en) ON message TO app_operador;
  END IF;
END $$;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversation','support_case','message'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'operador_metadatos') THEN
      EXECUTE format('CREATE POLICY operador_metadatos ON %I FOR SELECT TO app_operador USING (true)', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------- acceso de soporte autorizado por la empresa
CREATE TABLE acceso_soporte (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  conversation_id      uuid NOT NULL,
  otorgado_por         uuid NOT NULL REFERENCES users(id),
  otorgado_por_nombre  text NOT NULL,
  motivo               text NOT NULL,
  ticket_numero        text,
  expira_en            timestamptz NOT NULL,
  revocado_en          timestamptz,
  revocado_por_nombre  text,
  creado_en            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversation (tenant_id, id)
);
CREATE INDEX ix_acceso_soporte_conv ON acceso_soporte (tenant_id, conversation_id, expira_en DESC);
ALTER TABLE acceso_soporte ENABLE ROW LEVEL SECURITY;
ALTER TABLE acceso_soporte FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON acceso_soporte USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON acceso_soporte TO app_rt, app_platform;
REVOKE DELETE ON acceso_soporte FROM app_rt, app_platform;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT ON acceso_soporte TO app_operador;
    CREATE POLICY operador ON acceso_soporte FOR SELECT TO app_operador USING (true);
  END IF;
END $$;

-- Rol de lectura autorizada. Sin BYPASSRLS: cada fila exige un acceso vigente de la empresa.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_soporte') THEN
    CREATE ROLE app_soporte NOLOGIN;
  END IF;
  EXECUTE format('GRANT app_soporte TO %I', current_user);
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_soporte;
GRANT USAGE ON SCHEMA public TO app_soporte;
GRANT EXECUTE ON FUNCTION app_tenant() TO app_soporte;

GRANT SELECT ON acceso_soporte TO app_soporte;
CREATE POLICY soporte_vigente ON acceso_soporte FOR SELECT TO app_soporte USING (revocado_en IS NULL AND expira_en > now());

GRANT SELECT (id, tenant_id, customer_id, canal, estado, control, resuelta_por, ultimo_mensaje_cliente_en, creado_en, actualizado_en) ON conversation TO app_soporte;
CREATE POLICY soporte_autorizado ON conversation FOR SELECT TO app_soporte USING (
  EXISTS (SELECT 1 FROM acceso_soporte g WHERE g.tenant_id = conversation.tenant_id AND g.conversation_id = conversation.id AND g.revocado_en IS NULL AND g.expira_en > now()));

GRANT SELECT (id, tenant_id, conversation_id, remitente, tipo, contenido, estado_entrega, error_entrega, ocurrido_en, creado_en) ON message TO app_soporte;
CREATE POLICY soporte_autorizado ON message FOR SELECT TO app_soporte USING (
  EXISTS (SELECT 1 FROM acceso_soporte g WHERE g.tenant_id = message.tenant_id AND g.conversation_id = message.conversation_id AND g.revocado_en IS NULL AND g.expira_en > now()));

GRANT SELECT (id, tenant_id, radicado, conversation_id, motivo, prioridad, estado, sla_vence_en, primera_respuesta_en, cerrado_en, creado_en) ON support_case TO app_soporte;
CREATE POLICY soporte_autorizado ON support_case FOR SELECT TO app_soporte USING (
  EXISTS (SELECT 1 FROM acceso_soporte g WHERE g.tenant_id = support_case.tenant_id AND g.conversation_id = support_case.conversation_id AND g.revocado_en IS NULL AND g.expira_en > now()));

GRANT SELECT (id, tenant_id, nombre, telefono) ON customer TO app_soporte;
CREATE POLICY soporte_autorizado ON customer FOR SELECT TO app_soporte USING (
  EXISTS (SELECT 1 FROM acceso_soporte g JOIN conversation v ON v.tenant_id = g.tenant_id AND v.id = g.conversation_id
          WHERE g.tenant_id = customer.tenant_id AND v.customer_id = customer.id AND g.revocado_en IS NULL AND g.expira_en > now()));

GRANT SELECT (id, nombre) ON tenant TO app_soporte;
CREATE POLICY soporte_autorizado ON tenant FOR SELECT TO app_soporte USING (
  EXISTS (SELECT 1 FROM acceso_soporte g WHERE g.tenant_id = tenant.id AND g.revocado_en IS NULL AND g.expira_en > now()));
