-- =====================================================================
-- 029 · La IA atiende sola y agenda automática
--
--  * ia_ajustes: nivel de autonomía de la IA (AUTOMATICO por defecto), reglas de escalamiento,
--    contacto de urgencias y recordatorios. La IA propone, el código decide: la política vive aquí y
--    la aplica el AI Action Gateway, no el prompt.
--  * agenda_ajustes: anticipación, horizonte, horas para cancelar, confirmación, asignación de recurso,
--    festivos de Colombia, inasistencia y lista de espera.
--  * Servicios con buffers, recursos permitidos y segundo recurso; recursos con color, tipo y descanso;
--    excepciones de horario; series de citas; lista de espera; avisos proactivos (con la ventana de 24 h).
--  * Doble reserva imposible: restricción de exclusión (btree_gist) sobre el recurso y el intervalo de
--    las citas vivas, además del bloqueo por agenda en el código. Si el motor no tiene btree_gist,
--    queda solo el bloqueo transaccional (ver docs/agenda).
-- =====================================================================

CREATE TABLE ia_ajustes (
  tenant_id               uuid PRIMARY KEY REFERENCES tenant(id),
  autonomia               text NOT NULL DEFAULT 'AUTOMATICO' CHECK (autonomia IN ('AUTOMATICO','SUPERVISADO','ASESOR')),
  -- SUPERVISADO: ventas de la IA desde este monto esperan la aprobación de una persona.
  aprobacion_monto_min    numeric(14,2) CHECK (aprobacion_monto_min IS NULL OR aprobacion_monto_min > 0),
  aprobacion_espera_min   int NOT NULL DEFAULT 30 CHECK (aprobacion_espera_min BETWEEN 5 AND 1440),
  aprobacion_sin_respuesta text NOT NULL DEFAULT 'AVISAR' CHECK (aprobacion_sin_respuesta IN ('APROBAR','AVISAR')),
  reglas_escalamiento     text[] NOT NULL DEFAULT '{PIDE_PERSONA,QUEJA,PAGOS,URGENCIA,SIN_SOLUCION,MONTO}',
  palabras_urgencia       text[] NOT NULL DEFAULT '{}',
  contacto_urgencias      text CHECK (contacto_urgencias IS NULL OR length(contacto_urgencias) <= 300),
  recordatorios_horas     int[] NOT NULL DEFAULT '{24,2}',
  seguimiento_horas       int NOT NULL DEFAULT 3 CHECK (seguimiento_horas BETWEEN 0 AND 168),
  recordar_pago           boolean NOT NULL DEFAULT true,
  actualizado_en          timestamptz NOT NULL DEFAULT now(),
  actualizado_por         text
);

CREATE TABLE agenda_ajustes (
  tenant_id            uuid PRIMARY KEY REFERENCES tenant(id),
  anticipacion_min     int NOT NULL DEFAULT 15 CHECK (anticipacion_min BETWEEN 0 AND 10080),
  horizonte_dias       int NOT NULL DEFAULT 60 CHECK (horizonte_dias BETWEEN 1 AND 365),
  horas_cancelacion    int NOT NULL DEFAULT 2 CHECK (horas_cancelacion BETWEEN 0 AND 168),
  confirmacion         text NOT NULL DEFAULT 'CLIENTE' CHECK (confirmacion IN ('AL_CREAR','CLIENTE')),
  asignacion           text NOT NULL DEFAULT 'PRIMERO_LIBRE' CHECK (asignacion IN ('PRIMERO_LIBRE','REPARTIR','PREFERIDO')),
  usar_festivos        boolean NOT NULL DEFAULT true,
  inasistencia_min     int NOT NULL DEFAULT 30 CHECK (inasistencia_min BETWEEN 5 AND 1440),
  inasistencia_accion  text NOT NULL DEFAULT 'MARCAR' CHECK (inasistencia_accion IN ('MARCAR','PREGUNTAR')),
  espera_oferta_min    int NOT NULL DEFAULT 30 CHECK (espera_oferta_min BETWEEN 5 AND 1440),
  actualizado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_por      text
);

-- ---------------------------------------------------------------- servicios y recursos
ALTER TABLE product ADD COLUMN IF NOT EXISTS buffer_antes_min int NOT NULL DEFAULT 0 CHECK (buffer_antes_min BETWEEN 0 AND 240);
ALTER TABLE product ADD COLUMN IF NOT EXISTS buffer_despues_min int NOT NULL DEFAULT 0 CHECK (buffer_despues_min BETWEEN 0 AND 240);
-- NULL = cualquier recurso activo puede prestarlo.
ALTER TABLE product ADD COLUMN IF NOT EXISTS recursos_permitidos uuid[];
-- Servicio que exige a la vez un segundo recurso (p. ej. groomer + mesa): uno de estos debe estar libre.
ALTER TABLE product ADD COLUMN IF NOT EXISTS recursos_secundarios uuid[];
-- Seguimiento: se ofrece repetir el servicio en N semanas (próxima vacuna, próximo baño).
ALTER TABLE product ADD COLUMN IF NOT EXISTS repetir_cada_semanas int CHECK (repetir_cada_semanas IS NULL OR repetir_cada_semanas BETWEEN 1 AND 104);

ALTER TABLE resource ADD COLUMN IF NOT EXISTS color text CHECK (color IS NULL OR color ~ '^#[0-9a-fA-F]{6}$');
ALTER TABLE resource ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'PROFESIONAL' CHECK (tipo IN ('PROFESIONAL','ESPACIO'));
-- Descanso diario: {"inicio":"13:00","fin":"14:00"}.
ALTER TABLE resource ADD COLUMN IF NOT EXISTS descanso jsonb;

-- Vacaciones, festivos propios y bloqueos de horas. resource_id NULL = todo el negocio.
CREATE TABLE resource_excepcion (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  resource_id  uuid,
  desde        timestamptz NOT NULL,
  hasta        timestamptz NOT NULL,
  motivo       text NOT NULL CHECK (length(motivo) BETWEEN 2 AND 160),
  creado_por   text NOT NULL,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta > desde),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES resource (tenant_id, id)
);
CREATE INDEX ix_resource_excepcion ON resource_excepcion (tenant_id, desde, hasta);

-- ---------------------------------------------------------------- citas
ALTER TABLE appointment DROP CONSTRAINT IF EXISTS appointment_origen_check;
ALTER TABLE appointment ADD CONSTRAINT appointment_origen_check CHECK (origen IN ('AGENTE','PANEL','AUTOMATIZACION'));
ALTER TABLE appointment ADD COLUMN IF NOT EXISTS confirmada_en timestamptz;
-- Avisos enviados o no (por la ventana de 24 h): {"r24": {...}, "r2": {...}, "seguimiento": {...}}.
ALTER TABLE appointment ADD COLUMN IF NOT EXISTS recordatorios jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE appointment ADD COLUMN IF NOT EXISTS reprogramada_desde timestamptz;
ALTER TABLE appointment ADD COLUMN IF NOT EXISTS canal_confirmacion text CHECK (canal_confirmacion IS NULL OR canal_confirmacion IN ('WHATSAPP','PANEL','AUTOMATICA','WEB'));
ALTER TABLE appointment ADD COLUMN IF NOT EXISTS motivo_cancelacion text;
ALTER TABLE appointment ADD COLUMN IF NOT EXISTS recurso_secundario_id uuid;
ALTER TABLE appointment ADD COLUMN IF NOT EXISTS serie_id uuid;
ALTER TABLE appointment ADD CONSTRAINT fk_appt_recurso_secundario FOREIGN KEY (tenant_id, recurso_secundario_id) REFERENCES resource (tenant_id, id);
CREATE INDEX IF NOT EXISTS ix_appt_tenant_fin ON appointment (tenant_id, fin) WHERE estado IN ('RESERVADA','CONFIRMADA');

-- Citas recurrentes («cada 4 semanas»): fin por fecha o por número de citas.
CREATE TABLE appointment_serie (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  customer_id   uuid NOT NULL,
  product_id    uuid NOT NULL,
  resource_id   uuid,
  cada_semanas  int NOT NULL CHECK (cada_semanas BETWEEN 1 AND 52),
  hasta         date,
  max_citas     int CHECK (max_citas IS NULL OR max_citas BETWEEN 2 AND 52),
  estado        text NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA','TERMINADA','CANCELADA')),
  creado_por    text NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta IS NOT NULL OR max_citas IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
ALTER TABLE appointment ADD CONSTRAINT fk_appt_serie FOREIGN KEY (tenant_id, serie_id) REFERENCES appointment_serie (tenant_id, id);

-- Lista de espera: en orden de llegada; al liberarse un cupo se ofrece al primero que encaje.
CREATE TABLE lista_espera (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  customer_id    uuid NOT NULL,
  product_id     uuid NOT NULL,
  resource_id    uuid,
  desde          date NOT NULL,
  hasta          date NOT NULL,
  franjas        text[] NOT NULL DEFAULT '{MANANA,TARDE,NOCHE}',
  estado         text NOT NULL DEFAULT 'ESPERANDO' CHECK (estado IN ('ESPERANDO','OFRECIDA','ASIGNADA','VENCIDA','CANCELADA')),
  oferta         jsonb,
  appointment_id uuid,
  creado_por     text NOT NULL,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  CHECK (hasta >= desde),
  CHECK (franjas <@ ARRAY['MANANA','TARDE','NOCHE']),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customer (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
CREATE INDEX ix_lista_espera ON lista_espera (tenant_id, estado, creado_en);

-- Avisos que la IA envía por su cuenta. Uno por tipo y referencia (idempotente). NO_ENVIADO = fuera de la
-- ventana de 24 h sin plantilla aprobada ni correo: se muestra en el panel.
CREATE TABLE aviso_proactivo (
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  tipo           text NOT NULL CHECK (tipo IN ('RECORDATORIO','SEGUIMIENTO','PAGO_PENDIENTE','LISTA_ESPERA','INASISTENCIA','CAMBIO_CITA','STOCK','APROBACION')),
  referencia     text NOT NULL,
  customer_id    uuid,
  appointment_id uuid,
  canal          text NOT NULL CHECK (canal IN ('WHATSAPP','PLANTILLA','CORREO','NINGUNO','NEGOCIO')),
  estado         text NOT NULL CHECK (estado IN ('ENVIADO','NO_ENVIADO')),
  motivo         text,
  creado_en      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tipo, referencia)
);
CREATE INDEX ix_aviso_proactivo ON aviso_proactivo (tenant_id, creado_en DESC);

-- Plantillas por tipo de aviso proactivo (se activan cuando Meta las apruebe).
ALTER TABLE message_template ADD COLUMN IF NOT EXISTS tipo_proactivo text CHECK (tipo_proactivo IS NULL OR tipo_proactivo IN ('RECORDATORIO','SEGUIMIENTO','PAGO_PENDIENTE','LISTA_ESPERA','INASISTENCIA'));

-- ---------------------------------------------------------------- gateway y radicados
-- Política con la que se decidió cada acción de la IA (autonomía, riesgo efectivo).
ALTER TABLE ai_execution ADD COLUMN IF NOT EXISTS politica text;
-- Aprobación del negocio (SUPERVISADO) frente a confirmación del cliente.
ALTER TABLE pending_action ADD COLUMN IF NOT EXISTS tipo text NOT NULL DEFAULT 'CLIENTE' CHECK (tipo IN ('CLIENTE','NEGOCIO'));
ALTER TABLE pending_action ADD COLUMN IF NOT EXISTS decidido_por text;
-- Regla de escalamiento que disparó el radicado y lo que la IA ya había intentado.
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS regla text;
ALTER TABLE support_case ADD COLUMN IF NOT EXISTS intentado text;

-- ---------------------------------------------------------------- seguridad
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ia_ajustes','agenda_ajustes','resource_excepcion','appointment_serie','lista_espera','aviso_proactivo'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON ia_ajustes, agenda_ajustes, appointment_serie, lista_espera TO app_rt, app_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON resource_excepcion TO app_rt, app_platform;
-- El registro de avisos es evidencia (métricas de la tesis): solo inserción.
GRANT SELECT, INSERT ON aviso_proactivo TO app_rt, app_platform;

-- ---------------------------------------------------------------- doble reserva imposible
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'btree_gist no disponible: la agenda queda protegida solo por el bloqueo transaccional';
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    BEGIN
      ALTER TABLE appointment ADD CONSTRAINT ex_appt_recurso_libre EXCLUDE USING gist
        (tenant_id WITH =, resource_id WITH =, tstzrange(inicio, fin, '[)') WITH &&) WHERE (estado IN ('RESERVADA','CONFIRMADA'));
      ALTER TABLE appointment ADD CONSTRAINT ex_appt_secundario_libre EXCLUDE USING gist
        (tenant_id WITH =, recurso_secundario_id WITH =, tstzrange(inicio, fin, '[)') WITH &&) WHERE (estado IN ('RESERVADA','CONFIRMADA') AND recurso_secundario_id IS NOT NULL);
    EXCEPTION WHEN exclusion_violation THEN
      -- Bases con citas solapadas de antes: no se bloquea el despliegue; queda el bloqueo del código.
      RAISE NOTICE 'Hay citas solapadas existentes: la restricción de exclusión no se creó';
    END;
  END IF;
END $$;

-- ---------------------------------------------------------------- empresas existentes
INSERT INTO ia_ajustes (tenant_id) SELECT id FROM tenant ON CONFLICT DO NOTHING;
INSERT INTO agenda_ajustes (tenant_id) SELECT id FROM tenant ON CONFLICT DO NOTHING;
-- Herramientas nuevas del agente de atención (reprogramar su propia cita y lista de espera).
UPDATE ai_agent SET herramientas = herramientas || ARRAY['reprogramar_cita', 'unirse_lista_espera', 'anotar_pendiente', 'enviar_imagen_producto']
WHERE configuracion = 'atencion' AND NOT ('reprogramar_cita' = ANY(herramientas));

-- Plantillas por tipo de aviso proactivo (NO_REGISTRADA hasta que Meta las apruebe; textos en docs/ia-autonoma).
INSERT INTO message_template (tenant_id, clave, categoria, cuerpo, variables, tipo_proactivo)
SELECT t.id, x.clave, 'UTILIDAD', x.cuerpo, x.variables, x.tipo FROM tenant t CROSS JOIN (VALUES
  ('recordatorio_cita', 'RECORDATORIO', 'Hola {{cliente}}, te recordamos tu cita de {{servicio}} el {{fecha}} a las {{hora}} con {{recurso}}. Responde 1 para confirmar, 2 para reprogramar o 3 para cancelar.', ARRAY['cliente','servicio','fecha','hora','recurso']),
  ('seguimiento_cita', 'SEGUIMIENTO', 'Hola {{cliente}}, gracias por tu visita. ¿Cómo te fue con tu {{servicio}}? Si quieres, te agendamos la próxima.', ARRAY['cliente','servicio']),
  ('pago_pendiente', 'PAGO_PENDIENTE', 'Hola {{cliente}}, tu compra #{{numero}} por {{total}} sigue pendiente de pago. Puedes pagarla aquí: {{enlace}}', ARRAY['cliente','numero','total','enlace']),
  ('cupo_lista_espera', 'LISTA_ESPERA', 'Hola {{cliente}}, se liberó un cupo de {{servicio}} el {{fecha}} a las {{hora}}. Responde SÍ para tomarlo.', ARRAY['cliente','servicio','fecha','hora']),
  ('reprogramar_inasistencia', 'INASISTENCIA', 'Hola {{cliente}}, te esperábamos para tu cita de {{servicio}}. ¿Quieres que te busquemos otro horario?', ARRAY['cliente','servicio'])
) AS x(clave, tipo, cuerpo, variables)
ON CONFLICT (tenant_id, clave) DO UPDATE SET tipo_proactivo = EXCLUDED.tipo_proactivo;
