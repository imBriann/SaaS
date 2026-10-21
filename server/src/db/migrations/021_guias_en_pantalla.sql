-- 021 · Asistente del panel: guías en pantalla.
-- «¿Cómo registro una venta?» ya no se responde solo con texto: el asistente elige una guía y el panel
-- lleva a la IA por los botones reales. La herramienta es de lectura y no toca datos del negocio.
UPDATE ai_agent SET herramientas = herramientas || ARRAY['mostrar_guia']
WHERE configuracion = 'asistente' AND 'ayuda_plataforma' = ANY(herramientas) AND NOT ('mostrar_guia' = ANY(herramientas));
