-- =====================================================================
-- 033 · Cambiar de número de WhatsApp sin quedarse sin número
--
--  es_cambio    : esta conexión reemplaza a un número que ya estaba conectado.
--  reemplaza_id : la conexión anterior (propia). Se desconecta SOLO cuando esta queda conectada; si esta falla, la
--                 anterior sigue funcionando. Mientras dura el cambio puede haber dos filas vivas por empresa
--                 (la conectada y la nueva); al completarse, reemplaza_id vuelve a NULL.
-- =====================================================================
ALTER TABLE numero_contratacion ADD COLUMN IF NOT EXISTS es_cambio boolean NOT NULL DEFAULT false;
ALTER TABLE numero_contratacion ADD COLUMN IF NOT EXISTS reemplaza_id uuid;

DROP INDEX IF EXISTS ux_numero_contratacion_vigente;
CREATE UNIQUE INDEX ux_numero_contratacion_vigente ON numero_contratacion (tenant_id) WHERE estado <> 'CANCELADO' AND reemplaza_id IS NULL;
CREATE UNIQUE INDEX ux_numero_contratacion_cambio ON numero_contratacion (tenant_id) WHERE estado <> 'CANCELADO' AND reemplaza_id IS NOT NULL;
