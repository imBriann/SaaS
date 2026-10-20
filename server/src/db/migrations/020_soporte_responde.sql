-- 020 · Soporte de Omnegia que responde al cliente, solo con permiso explícito de la empresa
--
-- Al compartir una conversación, la empresa elige «solo leer» o «leer y responder». Con el segundo, el
-- equipo de soporte puede escribirle al cliente desde el panel del operador mientras el acceso esté
-- vigente; cada respuesta sale por el WhatsApp de la empresa marcada como «Soporte de Omnegia» y queda
-- en la auditoría de ambos lados. Retirar el acceso corta también las respuestas.
ALTER TABLE acceso_soporte ADD COLUMN IF NOT EXISTS puede_responder boolean NOT NULL DEFAULT false;

-- El soporte reconoce en el hilo sus propias respuestas (marca en los metadatos del mensaje).
GRANT SELECT (metadatos) ON message TO app_soporte;
