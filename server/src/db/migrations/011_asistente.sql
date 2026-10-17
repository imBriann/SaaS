-- Hilos del asistente del panel. Cada persona conserva sus conversaciones con la IA y el servidor
-- recompone el contexto en cada pregunta: ya no depende de lo que el navegador reenvíe.
-- Son privados de quien los escribe (la consulta filtra por user_id); el operador de la plataforma no tiene acceso.
CREATE TABLE asistente_hilo (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  titulo          text NOT NULL,
  -- Memoria de los mensajes más antiguos, que ya salieron de la ventana que se envía íntegra al modelo.
  resumen         text,
  resumido_hasta  bigint NOT NULL DEFAULT 0,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX ix_asistente_hilo_usuario ON asistente_hilo (tenant_id, user_id, actualizado_en DESC);

CREATE TABLE asistente_mensaje (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  hilo_id      uuid NOT NULL,
  orden        bigint GENERATED ALWAYS AS IDENTITY,
  rol          text NOT NULL CHECK (rol IN ('user','assistant')),
  contenido    text NOT NULL,
  -- Recibos de las herramientas que usó la respuesta (id, herramienta, decisión, motivo, riesgo).
  ejecuciones  jsonb NOT NULL DEFAULT '[]'::jsonb,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, hilo_id) REFERENCES asistente_hilo (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_asistente_mensaje_hilo ON asistente_mensaje (hilo_id, orden);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['asistente_hilo','asistente_mensaje'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON asistente_hilo, asistente_mensaje TO app_rt, app_platform;
