-- Aceptación de las condiciones y la política de datos con prueba (Ley 1480 de 2011 art. 49 y 50; Decreto 1377 de 2013 art. 8),
-- y solicitudes de los titulares sobre sus datos (Ley 1581 de 2012 arts. 14 y 15) y peticiones, quejas y reclamos de consumidores
-- con radicado, fecha y hora (Ley 1480 de 2011 art. 50 literal g, según la Ley 2439 de 2024).
ALTER TABLE onboarding_draft ADD COLUMN aceptacion_legal jsonb;

CREATE TABLE solicitud_datos (
  id              uuid PRIMARY KEY,
  radicado        text NOT NULL UNIQUE,
  tipo            text NOT NULL CHECK (tipo IN ('SUPRESION','CONSULTA','RECTIFICACION','REVOCATORIA','PQR')),
  calidad         text NOT NULL CHECK (calidad IN ('USUARIO_PLATAFORMA','CLIENTE_DE_COMERCIO','OTRA')),
  nombre          text NOT NULL,
  email           text NOT NULL,
  telefono        text,
  comercio        text,
  detalle         text NOT NULL,
  estado          text NOT NULL DEFAULT 'RECIBIDA' CHECK (estado IN ('RECIBIDA','EN_TRAMITE','RESUELTA','RECHAZADA')),
  ip_hash         text NOT NULL,
  vence_en        date NOT NULL,
  creado_en       timestamptz NOT NULL DEFAULT now(),
  actualizado_en  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_solicitud_datos_email ON solicitud_datos (lower(email), creado_en DESC);
CREATE INDEX ix_solicitud_datos_ip ON solicitud_datos (ip_hash, creado_en DESC);
CREATE SEQUENCE solicitud_datos_num;

-- Solo la plataforma las ve: contienen datos de personas que aún no son usuarias.
GRANT SELECT, INSERT, UPDATE ON solicitud_datos TO app_platform;
GRANT USAGE, SELECT ON SEQUENCE solicitud_datos_num TO app_platform;
REVOKE ALL ON solicitud_datos FROM app_rt;
