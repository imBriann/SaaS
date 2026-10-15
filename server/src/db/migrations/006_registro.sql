-- Verificación ligada al borrador: no crea usuarios ni empresas.
CREATE TABLE onboarding_email_code (
 id uuid PRIMARY KEY, draft_token text NOT NULL REFERENCES onboarding_draft(token), email text NOT NULL,
 codigo_hash text NOT NULL, ip_hash text NOT NULL, intentos int NOT NULL DEFAULT 0,
 creado_en timestamptz NOT NULL DEFAULT now(), expira_en timestamptz NOT NULL, usado_en timestamptz, invalidado_en timestamptz
);
CREATE INDEX ix_alta_code ON onboarding_email_code(draft_token, creado_en DESC);
CREATE INDEX ix_alta_code_ip ON onboarding_email_code(ip_hash, creado_en DESC);
ALTER TABLE onboarding_draft ADD COLUMN email_verificado text;
ALTER TABLE onboarding_draft ADD COLUMN email_verificado_en timestamptz;
ALTER TABLE tenant ADD COLUMN registro_datos jsonb NOT NULL DEFAULT '{}';
CREATE TABLE subdomain_reservation (
 slug text PRIMARY KEY, draft_token text NOT NULL REFERENCES onboarding_draft(token), expira_en timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_email_code, subdomain_reservation TO app_platform;
