-- Perfil de la persona: teléfono y foto propios, y cambio de correo confirmado con un código enviado al correo nuevo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS telefono text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS foto_data_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS correo_pendiente text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS actualizado_en timestamptz;
ALTER TABLE otp_code DROP CONSTRAINT IF EXISTS otp_code_proposito_check;
ALTER TABLE otp_code ADD CONSTRAINT otp_code_proposito_check CHECK (proposito IN ('VERIFICAR_CORREO','ACCESO_PLATAFORMA','CAMBIAR_CORREO'));
GRANT SELECT (foto_data_url) ON users TO app_rt;
