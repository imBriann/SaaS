-- =====================================================================
-- 031 · Búsqueda de imágenes como proceso con estado
--
--  busqueda_imagen guarda cada búsqueda de fotos de un producto: los pasos (entender, buscar, elegir, descargar),
--  las consultas probadas con su resultado, las candidatas con su miniatura y las descartadas con el motivo.
--  El panel la consulta cada segundo; también sirve para depurar por qué una búsqueda no trajo nada.
--  lote_id agrupa las búsquedas de «Completar imágenes que faltan».
-- =====================================================================

CREATE TABLE IF NOT EXISTS busqueda_imagen (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  product_id   uuid NOT NULL,
  lote_id      uuid,
  modo         text NOT NULL CHECK (modo IN ('MANUAL','AUTO')),
  estado       text NOT NULL DEFAULT 'EN_CURSO' CHECK (estado IN ('EN_CURSO','ESPERA_ELECCION','LISTO','SIN_RESULTADOS','ERROR')),
  consulta     text,
  proveedor    text,
  pasos        jsonb NOT NULL DEFAULT '[]',
  candidatas   jsonb NOT NULL DEFAULT '[]',
  intentos     jsonb NOT NULL DEFAULT '[]',
  descartadas  jsonb NOT NULL DEFAULT '[]',
  resultado    jsonb,
  mensaje      text,
  creado_por   text NOT NULL,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS ix_busqueda_imagen_producto ON busqueda_imagen (tenant_id, product_id, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_busqueda_imagen_lote ON busqueda_imagen (tenant_id, lote_id) WHERE lote_id IS NOT NULL;
ALTER TABLE busqueda_imagen ENABLE ROW LEVEL SECURITY;
ALTER TABLE busqueda_imagen FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON busqueda_imagen;
CREATE POLICY tenant_isolation ON busqueda_imagen USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON busqueda_imagen TO app_rt;
