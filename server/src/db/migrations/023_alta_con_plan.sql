-- El alta cobra un plan estándar (esencial, negocio o pro) en ciclo mensual o anual.
-- plan_elegido: la persona eligió el plan (la recomendación de la IA ya no lo reemplaza).
ALTER TABLE onboarding_draft ADD COLUMN IF NOT EXISTS ciclo text NOT NULL DEFAULT 'MENSUAL' CHECK (ciclo IN ('MENSUAL','ANUAL'));
ALTER TABLE onboarding_draft ADD COLUMN IF NOT EXISTS plan_elegido boolean NOT NULL DEFAULT false;
