-- =====================================================================
-- 032 · Nota por línea en la venta del punto de venta
--  (por ejemplo, «sin cebolla» o «corte bajo en los lados»). Es texto libre del mostrador; no cambia importes.
-- =====================================================================
ALTER TABLE order_item ADD COLUMN IF NOT EXISTS nota text CHECK (nota IS NULL OR length(nota) <= 200);
