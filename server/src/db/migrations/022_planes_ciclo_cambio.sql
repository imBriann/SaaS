-- 022 · Planes: pago anual, cambio de plan por la empresa y precio pactado.
-- * plan.precio_anual: 12 meses por el precio de 10. plan.descripcion: para quién es.
-- * subscription.ciclo: MENSUAL o ANUAL (lo decide el último pago).
-- * subscription.precio_pactado: precio mensual que conserva una empresa que ya pagaba cuando subieron los
--   precios del catálogo; vale mientras siga en su plan (al cambiar de plan pasa al precio vigente).
-- * subscription.cambio_programado: bajar de plan o volver a mensual se aplica en la próxima renovación.
-- * payment.ciclo / payment.cambio_plan: condiciones congeladas del checkout (renovación o cambio prorrateado).
-- * payment.metodo_pago / metodo_detalle: cómo pagó (tarjeta, PSE, Nequi…) para el recibo; nunca datos de tarjeta.
ALTER TABLE plan ADD COLUMN IF NOT EXISTS precio_anual numeric(14,2);
ALTER TABLE plan ADD COLUMN IF NOT EXISTS descripcion text NOT NULL DEFAULT '';

ALTER TABLE subscription ADD COLUMN IF NOT EXISTS ciclo text NOT NULL DEFAULT 'MENSUAL' CHECK (ciclo IN ('MENSUAL','ANUAL'));
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS precio_pactado numeric(14,2);
ALTER TABLE subscription ADD COLUMN IF NOT EXISTS cambio_programado jsonb;
-- Las empresas que ya existen conservan su precio mensual actual (se corre antes de actualizar el catálogo).
UPDATE subscription s SET precio_pactado = p.precio_mensual
  FROM plan p WHERE p.codigo = s.plan_codigo AND s.precio_pactado IS NULL AND s.modalidad = 'COMERCIAL';

ALTER TABLE payment ADD COLUMN IF NOT EXISTS ciclo text CHECK (ciclo IN ('MENSUAL','ANUAL'));
ALTER TABLE payment ADD COLUMN IF NOT EXISTS cambio_plan jsonb;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS metodo_pago text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS metodo_detalle text;

ALTER TABLE subscription_period ADD COLUMN IF NOT EXISTS ciclo text;
