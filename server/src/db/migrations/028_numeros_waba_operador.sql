-- =====================================================================
-- 028 · Números de la WABA de Omnegia administrados por el operador
--
-- El operador ve en vivo los números de la cuenta de WhatsApp Business de Omnegia, los asigna a una
-- empresa eligiéndolos de una lista y, si un número está verificado pero no registrado en la Cloud API,
-- lo registra con un PIN de dos pasos aleatorio.
--
-- numero_credencial (016) guarda el PIN de un número que pertenece a una contratación de una empresa
-- (contratacion_id y tenant_id obligatorios). Un número de la WABA puede estar libre, sin empresa ni
-- contratación, así que su PIN vive aquí: cifrado con APP_KEY y solo al alcance del rol de plataforma.
-- La unicidad «un número, una empresa» ya la garantiza tenant.whatsapp_phone_number_id UNIQUE (001).
-- =====================================================================

CREATE TABLE numero_credencial_plataforma (
  phone_number_id  text PRIMARY KEY CHECK (phone_number_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  pin_cifrado      text NOT NULL,
  registrado_en    timestamptz,
  actualizado_en   timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON numero_credencial_plataforma FROM app_rt;
GRANT SELECT, INSERT, UPDATE ON numero_credencial_plataforma TO app_platform;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    REVOKE ALL ON numero_credencial_plataforma FROM app_operador;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_soporte') THEN
    REVOKE ALL ON numero_credencial_plataforma FROM app_soporte;
  END IF;
END $$;

-- El operador cruza los números de la WABA con la empresa a la que están asignados (sin datos del negocio).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT (whatsapp_phone_number_id, whatsapp_numero_visible) ON tenant TO app_operador;
  END IF;
END $$;
