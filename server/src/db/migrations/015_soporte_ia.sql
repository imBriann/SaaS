-- Soporte con IA: antes de abrir una solicitud, el asistente de soporte revisa la cuenta con datos reales
-- y las guías verificadas. Cada intento queda registrado: lo que propuso, si lo resolvió o si pasó al equipo.

CREATE TABLE soporte_intento_ia (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  user_id       uuid NOT NULL REFERENCES users(id),
  categoria     text NOT NULL,
  prioridad     text NOT NULL,
  asunto        text NOT NULL,
  descripcion   text NOT NULL,
  respuesta     text,
  hallazgos     jsonb NOT NULL DEFAULT '[]',
  guias         text[] NOT NULL DEFAULT '{}',
  motor         text NOT NULL,
  -- PROPUESTO: la IA dio una respuesta y espera a que la persona diga si le sirvió.
  -- RESUELTO: la persona confirmó. ESCALADO: pasó al equipo (por regla, por la IA o por la persona).
  resultado     text NOT NULL DEFAULT 'PROPUESTO' CHECK (resultado IN ('PROPUESTO','RESUELTO','ESCALADO')),
  motivo_escalamiento text,
  ticket_id     uuid REFERENCES soporte_ticket(id) ON DELETE SET NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  cerrado_en    timestamptz
);
CREATE INDEX ix_soporte_ia_tenant ON soporte_intento_ia (tenant_id, creado_en DESC);
ALTER TABLE soporte_intento_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE soporte_intento_ia FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON soporte_intento_ia USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON soporte_intento_ia TO app_rt, app_platform;
REVOKE DELETE ON soporte_intento_ia FROM app_rt, app_platform;

-- El operador solo ve cifras: categoría y resultado, nunca lo que la empresa escribió ni la respuesta.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT (id, tenant_id, categoria, resultado, motivo_escalamiento, ticket_id, creado_en) ON soporte_intento_ia TO app_operador;
    CREATE POLICY operador_metadatos ON soporte_intento_ia FOR SELECT TO app_operador USING (true);
  END IF;
END $$;
