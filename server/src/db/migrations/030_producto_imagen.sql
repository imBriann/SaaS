-- =====================================================================
-- 030 · Imágenes del catálogo y punto de venta
--
--  * producto_imagen: fotos subidas por la empresa (SUBIDA), encontradas por la IA en un proveedor con
--    licencia abierta o en la web (BUSQUEDA_IA) o enlazadas (URL). Una imagen de búsqueda web general
--    queda PENDIENTE_APROBACION hasta que la empresa confirme que tiene derecho a usarla; solo las ACTIVA
--    se muestran o se envían a clientes. Siempre se guarda la página de origen, el autor y la licencia.
--  * comprobante_ajustes.auto_al_vender: el sistema genera el comprobante de venta al confirmarse una
--    venta del punto de venta (regla del negocio, no decisión de la IA).
-- =====================================================================

CREATE TABLE producto_imagen (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  product_id    uuid NOT NULL,
  orden         int NOT NULL DEFAULT 0 CHECK (orden BETWEEN 0 AND 50),
  origen        text NOT NULL CHECK (origen IN ('SUBIDA','BUSQUEDA_IA','URL')),
  -- Enlace externo de la imagen (búsqueda o URL) y/o archivo propio en el almacenamiento.
  url           text CHECK (url IS NULL OR url ~ '^https://'),
  ruta_archivo  text CHECK (ruta_archivo IS NULL OR ruta_archivo ~ '^[a-z0-9/_.-]{1,200}$'),
  miniatura     text CHECK (miniatura IS NULL OR miniatura ~ '^[a-z0-9/_.-]{1,200}$'),
  fuente        text CHECK (fuente IS NULL OR length(fuente) <= 1000),
  proveedor     text,
  licencia      text,
  autor         text,
  atribucion    text,
  estado        text NOT NULL DEFAULT 'ACTIVA' CHECK (estado IN ('ACTIVA','PENDIENTE_APROBACION','ROTA')),
  ancho         int,
  alto          int,
  bytes         int,
  verificada_en timestamptz,
  aprobada_por  text,
  creado_por    text NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  CHECK (url IS NOT NULL OR ruta_archivo IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES product (tenant_id, id)
);
CREATE INDEX ix_producto_imagen ON producto_imagen (tenant_id, product_id, orden);
ALTER TABLE producto_imagen ENABLE ROW LEVEL SECURITY;
ALTER TABLE producto_imagen FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON producto_imagen USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON producto_imagen TO app_rt;
-- La plataforma sirve los archivos públicos y revisa enlaces rotos (trabajo periódico).
GRANT SELECT, UPDATE ON producto_imagen TO app_platform;

ALTER TABLE comprobante_ajustes ADD COLUMN IF NOT EXISTS auto_al_vender boolean NOT NULL DEFAULT false;
