ALTER TABLE user_tenant ADD COLUMN nombre_visible text;
CREATE TABLE commission_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenant(id), activo boolean NOT NULL DEFAULT false,
 informes boolean NOT NULL DEFAULT false, frecuencia text NOT NULL DEFAULT 'mensual' CHECK(frecuencia IN ('diaria','semanal','quincenal','mensual')),
 reglas jsonb NOT NULL DEFAULT '[]', version int NOT NULL DEFAULT 1
);
CREATE TABLE commission_entry (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenant(id), order_id uuid NOT NULL,
 user_id uuid NOT NULL, product_id uuid NOT NULL, base numeric(14,2) NOT NULL,
 porcentaje numeric(5,2) NOT NULL CHECK(porcentaje>=0 AND porcentaje<=100), comision numeric(14,2) NOT NULL,
 version int NOT NULL, creado_en timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,order_id) REFERENCES "order"(tenant_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES product(tenant_id,id)
);
-- El informe recorre las comisiones por venta y por persona dentro de cada empresa.
CREATE INDEX commission_entry_venta ON commission_entry (tenant_id, order_id);
CREATE INDEX commission_entry_persona ON commission_entry (tenant_id, user_id);
ALTER TABLE commission_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY cs_tenant ON commission_settings USING(tenant_id=app_tenant()) WITH CHECK(tenant_id=app_tenant());
ALTER TABLE commission_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY ce_tenant ON commission_entry USING(tenant_id=app_tenant()) WITH CHECK(tenant_id=app_tenant());
GRANT SELECT,INSERT,UPDATE ON commission_settings TO app_rt,app_platform;
GRANT SELECT,INSERT ON commission_entry TO app_rt,app_platform;
