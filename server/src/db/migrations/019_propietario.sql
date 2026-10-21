-- 019 · Propietario de la empresa
--
-- Un rango por encima del administrador: quien creó la empresa (o a quien se le cedió). Siempre
-- tiene todos los permisos de la empresa, y nadie más puede cambiarle el rol, retirarle el acceso
-- ni editar su nombre. Solo el propietario cede la propiedad, confirmando con su contraseña.
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS propietario_id uuid REFERENCES users(id);

-- Empresas existentes: la primera persona activa que administra el equipo (quien hizo el alta).
UPDATE tenant t SET propietario_id = (
  SELECT ut.user_id FROM user_tenant ut
  JOIN role_permission rp ON rp.tenant_id = ut.tenant_id AND rp.role_id = ut.role_id AND rp.permiso = 'user:manage'
  WHERE ut.tenant_id = t.id AND ut.activo
  ORDER BY ut.creado_en, ut.user_id LIMIT 1)
WHERE t.propietario_id IS NULL;

-- El operador de Omnegia no ve quién es el propietario (no tiene GRANT sobre la columna).
