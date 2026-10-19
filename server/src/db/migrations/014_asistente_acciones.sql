-- =====================================================================
-- 014 · Acciones del asistente del panel que esperan confirmación
--
-- El asistente puede proponer cambios en el catálogo (crear o editar un ítem).
-- La propuesta queda pendiente y solo se ejecuta cuando la MISMA persona la
-- confirma con un botón en su conversación; vence a los 15 minutos. Las
-- acciones del agente de WhatsApp siguen ligadas a su conversación.
-- =====================================================================

ALTER TABLE pending_action ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE pending_action ADD COLUMN IF NOT EXISTS hilo_id uuid;
ALTER TABLE pending_action ADD COLUMN IF NOT EXISTS solicitado_por uuid REFERENCES users(id);
ALTER TABLE pending_action ADD CONSTRAINT pending_action_origen CHECK (conversation_id IS NOT NULL OR solicitado_por IS NOT NULL);
ALTER TABLE pending_action ADD CONSTRAINT pending_action_hilo_fk FOREIGN KEY (tenant_id, hilo_id) REFERENCES asistente_hilo (tenant_id, id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS ix_pending_action_solicitante ON pending_action (tenant_id, solicitado_por, estado) WHERE solicitado_por IS NOT NULL;

-- El asistente de las empresas existentes puede proponer cambios de catálogo (la persona siempre confirma
-- y sus propios permisos se vuelven a comprobar al confirmar: quien no edita el catálogo no puede usarlo).
UPDATE ai_agent SET herramientas = herramientas || ARRAY['crear_item_catalogo', 'editar_item_catalogo']
WHERE configuracion = 'asistente' AND NOT ('crear_item_catalogo' = ANY(herramientas));
INSERT INTO role_permission (tenant_id, role_id, permiso)
SELECT r.tenant_id, r.id, 'catalog:write' FROM role r WHERE r.clave = 'agente_asistente' AND r.es_agente
ON CONFLICT DO NOTHING;
