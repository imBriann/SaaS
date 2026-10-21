-- Asistente de IA del sitio público y contacto con un asesor comercial.
-- Las solicitudes al asesor entran a la bandeja de soporte del operador (canal WEB, categoría COMERCIAL).
ALTER TABLE soporte_ticket DROP CONSTRAINT IF EXISTS soporte_ticket_canal_check;
ALTER TABLE soporte_ticket ADD CONSTRAINT soporte_ticket_canal_check CHECK (canal IN ('PANEL','WHATSAPP','WEB'));
ALTER TABLE soporte_ticket DROP CONSTRAINT IF EXISTS soporte_ticket_origen_check;
ALTER TABLE soporte_ticket ADD CONSTRAINT soporte_ticket_origen_check CHECK (canal IN ('WHATSAPP','WEB') OR (tenant_id IS NOT NULL AND creado_por IS NOT NULL AND solicitante_email IS NOT NULL));
ALTER TABLE soporte_ticket DROP CONSTRAINT IF EXISTS soporte_ticket_categoria_check;
ALTER TABLE soporte_ticket ADD CONSTRAINT soporte_ticket_categoria_check CHECK (categoria IN ('CUENTA','FACTURACION','WHATSAPP','IA','TECNICO','OTRO','COMERCIAL'));
ALTER TABLE soporte_ticket ADD COLUMN IF NOT EXISTS ip_hash text;
CREATE INDEX IF NOT EXISTS ix_ticket_web_ip ON soporte_ticket (ip_hash, creado_en) WHERE canal = 'WEB';

-- Uso del asistente público: solo cifras (para el límite por visitante y el costo), nunca lo que se escribió.
CREATE TABLE IF NOT EXISTS asistente_web_uso (
  id         uuid PRIMARY KEY,
  ip_hash    text NOT NULL,
  tokens     integer NOT NULL DEFAULT 0,
  motor      text,
  resultado  text NOT NULL CHECK (resultado IN ('IA','RESPALDO','LIMITE')),
  creado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_asistente_web_ip ON asistente_web_uso (ip_hash, creado_en);
GRANT SELECT, INSERT, DELETE ON asistente_web_uso TO app_platform;
REVOKE ALL ON asistente_web_uso FROM app_rt;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN GRANT SELECT ON asistente_web_uso TO app_operador; END IF;
END $$;
