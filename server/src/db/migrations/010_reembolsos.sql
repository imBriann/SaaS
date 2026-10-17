-- Reembolsos y retracto de los pagos a la plataforma (Ley 1480 de 2011 arts. 47, 50 literal h y 51; Ley 2439 de 2024 arts. 3 a 5).
-- La devolución no puede exceder 15 días calendario desde que el consumidor ejerce el derecho: `vence_en` lo hace verificable.
ALTER TABLE payment DROP CONSTRAINT IF EXISTS payment_estado_check;
ALTER TABLE payment ADD CONSTRAINT payment_estado_check CHECK (estado IN ('PENDIENTE','APROBADO','RECHAZADO','ANULADO','REEMPLAZADO','REEMBOLSADO'));

CREATE SEQUENCE reembolso_num;
CREATE TABLE reembolso (
  id                    uuid PRIMARY KEY,
  radicado              text NOT NULL UNIQUE,
  payment_id            uuid NOT NULL REFERENCES payment(id),
  draft_token           text REFERENCES onboarding_draft(token),
  tenant_id             uuid REFERENCES tenant(id),
  motivo                text NOT NULL CHECK (motivo IN ('RETRACTO','NO_ACTIVACION','COBRO_DUPLICADO','COBRO_NO_RECONOCIDO','OTRO')),
  estado                text NOT NULL CHECK (estado IN ('EN_REVISION','APROBADO','REEMBOLSADO','RECHAZADO')),
  solicitante_nombre    text NOT NULL,
  solicitante_email     text NOT NULL,
  medio_preferido       text NOT NULL CHECK (medio_preferido IN ('MISMO_MEDIO','TRANSFERENCIA')),
  detalle               text NOT NULL,
  monto                 numeric(14,2) NOT NULL,
  moneda                char(3) NOT NULL DEFAULT 'COP',
  evaluacion            jsonb NOT NULL DEFAULT '{}',
  decidido_en           timestamptz,
  decidido_por          text,
  decision_motivo       text,
  referencia_devolucion text,
  reembolsado_en        timestamptz,
  vence_en              timestamptz NOT NULL,
  ip_hash               text NOT NULL,
  creado_en             timestamptz NOT NULL DEFAULT now(),
  actualizado_en        timestamptz NOT NULL DEFAULT now()
);
-- Un pago tiene a lo sumo una solicitud viva: evita devolver dos veces lo mismo.
CREATE UNIQUE INDEX ux_reembolso_pago_vivo ON reembolso (payment_id) WHERE estado IN ('EN_REVISION','APROBADO','REEMBOLSADO');
CREATE INDEX ix_reembolso_estado ON reembolso (estado, vence_en);
CREATE INDEX ix_reembolso_borrador ON reembolso (draft_token) WHERE draft_token IS NOT NULL;
CREATE INDEX ix_reembolso_ip ON reembolso (ip_hash, creado_en DESC);

GRANT SELECT, INSERT, UPDATE ON reembolso TO app_platform;
GRANT USAGE, SELECT ON SEQUENCE reembolso_num TO app_platform;
REVOKE ALL ON reembolso FROM app_rt;
-- El operador consulta la cola; las decisiones (que tocan pagos y altas) las ejecuta el servidor con el rol de plataforma.
GRANT SELECT (id, radicado, payment_id, draft_token, tenant_id, motivo, estado, solicitante_nombre, solicitante_email, medio_preferido, detalle, monto, moneda, evaluacion,
              decidido_en, decidido_por, decision_motivo, referencia_devolucion, reembolsado_en, vence_en, creado_en, actualizado_en) ON reembolso TO app_operador;
