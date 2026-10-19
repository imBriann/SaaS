-- 017 · Asistente del panel: agenda de un rango en una sola consulta.
-- «¿Qué citas hay esta semana?» ya no exige una consulta por día; los recibos quedan agrupados.
UPDATE ai_agent SET herramientas = herramientas || ARRAY['agenda_periodo']
WHERE configuracion = 'asistente' AND 'citas_del_dia' = ANY(herramientas) AND NOT ('agenda_periodo' = ANY(herramientas));
