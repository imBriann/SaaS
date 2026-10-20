# E · Estado de integraciones

Estado del código y de las comprobaciones hechas desde este entorno. «Verificado» significa probado aquí; lo que depende de credenciales reales de terceros no se afirma como funcional.

| Integración | Estado en el código | Verificado aquí | Pendiente o riesgo |
|---|---|---|---|
| WhatsApp Cloud API — número de cada empresa | Envío y recepción, firma de webhooks, plantillas, ventana de 24 horas y estados de entrega | Con webhooks firmados por un secreto local y el canal simulado | Probar con un número real; la verificación usa la Graph API |
| WhatsApp Cloud API — número de Omnegia | Asistente híbrido: el gestor de reglas atiende lo delicado (contraseñas, recuperación de acceso, pedir una persona) y Claude responde lo informativo con la conversación completa y una base de conocimiento armada con los datos del sistema (módulos y tarifas, niveles, guías, reembolsos, páginas). Derivación a persona y bandeja del operador | Pruebas en PGlite y PostgreSQL y webhooks firmados en local. Evaluado con Claude real (Haiku) sobre una base en memoria. Bug de producción del 19 de octubre corregido | En Render: `WHATSAPP_PLATFORM_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` y `WHATSAPP_ACCESS_TOKEN`. Los mensajes descartados por el bug no se responden de forma retroactiva |
| Registro integrado de Meta (Embedded Signup) | Implementado para **números contratados en Omnegia** (v4, `only_waba_sharing`). Un número propio se sigue conectando a mano con el Phone number ID | Solo simulado | Requiere app de Meta con Facebook Login for Business, `config_id` v4 y estado de Tech Provider |
| Números de WhatsApp contratados (Telnyx) y registro integrado de Meta | Compra, requisitos, pago, verificación por llamada, conexión, mensualidad y liberación ([detalle](../numeros-whatsapp/README.md)) | Con inventario y Meta simulados: 33 pruebas | Credenciales de Telnyx, aplicación TeXML y estado de Tech Provider con Embedded Signup v4 |
| Claude (Anthropic) | Agente, asistente, copiloto, alta y soporte con IA; salidas validadas con esquemas | Solo con el simulador determinista | Requiere `ANTHROPIC_API_KEY`; el costo del soporte se registra como consumo técnico de Omnegia |
| Wompi — suscripciones | Pagos, webhook firmado y reembolsos | Con la pasarela simulada | Producción con llaves reales |
| Wompi — cobros de cada empresa | Enlace de pago, conciliación y pago de más (EXCEDENTE) | Simulada | Cada empresa vincula su cuenta en Configuración › Cobros |
| Cobros manuales (efectivo, transferencia, datáfono) | Registro interno: no mueven dinero | **Sí** | — |
| Facturación electrónica | Entorno de pruebas propio (sin validez ante la DIAN) | Sí, como pruebas | Conectar un proveedor tecnológico habilitado |
| Correo (Resend envía, Zoho recibe) | Códigos, avisos, tickets y estados de entrega | Con el proveedor falso | Dominio verificado en Resend |
| PostgreSQL (Supabase) | Migraciones 001–015 atómicas | **PostgreSQL embebido real: 268 pruebas** | La migración 015 corre al desplegar |
