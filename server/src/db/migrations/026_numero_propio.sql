-- 026 · «Usar mi propio número»
--
-- La empresa escribe su número, recibe un código por SMS (o llamada) y Omnegia lo registra en la cuenta de
-- WhatsApp Business de la plataforma. Reutiliza la máquina de estados de numero_contratacion con un origen
-- PROPIO: sin pago, sin proveedor telefónico y sin cotización.
--
--   NUMERO_INGRESADO → CODIGO_ENVIADO → CODIGO_VERIFICADO → REGISTRADO → CONECTADO
--   Fallo: CONEXION_FALLIDA. Desconexión o abandono: CANCELADO.

ALTER TABLE numero_contratacion ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'COMPRA' CHECK (origen IN ('COMPRA','PROPIO'));
-- Bloqueo temporal tras agotar los intentos de código o los reenvíos (distinto del turno del trabajador).
ALTER TABLE numero_contratacion ADD COLUMN IF NOT EXISTS bloqueo_cliente_hasta timestamptz;

ALTER TABLE numero_contratacion DROP CONSTRAINT IF EXISTS numero_contratacion_estado_check;
ALTER TABLE numero_contratacion ADD CONSTRAINT numero_contratacion_estado_check CHECK (estado IN (
  'SELECCION_NUMERO','CONFIRMACION_PENDIENTE','PAGO_PENDIENTE','PAGO_CONFIRMADO',
  'APROVISIONANDO_NUMERO','NUMERO_APROVISIONADO',
  'REGISTRO_WHATSAPP_PENDIENTE','VERIFICACION_PENDIENTE','CONEXION_PENDIENTE','CONECTADO',
  'APROVISIONAMIENTO_FALLIDO','CONEXION_FALLIDA','CANCELACION_PENDIENTE','CANCELADO',
  'NUMERO_INGRESADO','CODIGO_ENVIADO','CODIGO_VERIFICADO','REGISTRADO'));

-- Un número propio no tiene cotización; una compra la sigue exigiendo.
ALTER TABLE numero_contratacion ALTER COLUMN cotizacion DROP NOT NULL;
ALTER TABLE numero_contratacion ADD CONSTRAINT numero_contratacion_cotizacion_compra CHECK (origen = 'PROPIO' OR cotizacion IS NOT NULL);
-- Los estados del flujo propio solo existen con origen PROPIO.
ALTER TABLE numero_contratacion ADD CONSTRAINT numero_contratacion_estados_propio CHECK (
  origen = 'PROPIO' OR estado NOT IN ('NUMERO_INGRESADO','CODIGO_ENVIADO','CODIGO_VERIFICADO','REGISTRADO'));

-- La RLS de numero_contratacion (tenant_isolation, 016) cubre las columnas nuevas. El operador ve el origen
-- para atender incidentes, sin el número ni las credenciales.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_operador') THEN
    GRANT SELECT (origen, bloqueo_cliente_hasta) ON numero_contratacion TO app_operador;
  END IF;
END $$;
