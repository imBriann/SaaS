-- El pago y la creación se separan solo para el nuevo registro. Las altas antiguas
-- conservan su contrato; la contraseña nunca se guarda en texto ni se devuelve.
ALTER TABLE onboarding_draft ADD COLUMN creacion_diferida boolean NOT NULL DEFAULT false;
ALTER TABLE onboarding_draft ADD COLUMN creacion jsonb NOT NULL DEFAULT '{"estado":"pendiente"}'::jsonb;
ALTER TABLE onboarding_draft ADD COLUMN password_hash_inicial text;
ALTER TABLE onboarding_draft ADD COLUMN personalizacion jsonb;
