-- 018 · Avisos del panel: qué conversaciones tiene cada persona sin leer.
-- Se marca al abrir la conversación; el contador del menú cuenta las que tienen mensajes del
-- cliente posteriores a esa lectura (o que esperan respuesta de una persona).
CREATE TABLE conversation_lectura (
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  user_id          uuid NOT NULL REFERENCES users(id),
  conversation_id  uuid NOT NULL,
  leido_en         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, conversation_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversation (tenant_id, id)
);
ALTER TABLE conversation_lectura ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_lectura FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_lectura USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON conversation_lectura TO app_rt, app_platform;
REVOKE DELETE ON conversation_lectura FROM app_rt;
CREATE INDEX IF NOT EXISTS ix_conv_cliente_reciente ON conversation (tenant_id, ultimo_mensaje_cliente_en DESC);
