# Precios de los planes de Omnegia (octubre de 2026)

Evaluación de costos reales y precio recomendado de cada plan. Los valores son en pesos colombianos (COP).
Lo que la empresa paga por la plataforma son las cifras de `server/src/onboarding/planRules.ts`; este
documento explica de dónde salen.

## 1. Lo que cuesta atender a una empresa

| Concepto | Supuesto | Costo unitario |
|---|---|---|
| **IA del agente de WhatsApp** (`claude-opus-5-5`, configurado por defecto) | Medido en el código: cada llamada envía ~1.800 caracteres de instrucciones, 11 herramientas (~5.200 caracteres) y el historial ≈ 2.600 tokens. Una respuesta usa ~1,5 llamadas con pensamiento adaptativo: ~4.300 tokens de entrada y ~700 de salida. El prefijo es más corto que el mínimo cacheable del modelo, así que no aprovecha la caché. | US$4 / US$20 por millón de tokens → **≈ US$0,031 ≈ COP 100 por respuesta** (TRM ≈ 3.200). La cuota cuenta ~5.000 tokens por respuesta → **≈ COP 20 por cada 1.000 tokens** de cuota. |
| Mensajes de WhatsApp (Meta, Colombia) | Las respuestas de servicio son gratis hasta 1.000 por número al mes desde el 1 oct 2026; después, tarifa de utilidad. Recordatorios con plantilla: utilidad. | Utilidad ≈ US$0,0008 ≈ **COP 2,6** por mensaje. Marketing ≈ US$0,0125 ≈ COP 40 (no incluido en el plan). |
| Factura electrónica DIAN | Proveedor tecnológico habilitado, precio mayorista por documento (referencia de mercado COP 150–300 por factura con distribución). | **COP 120** por documento (cotizar con el proveedor antes de producción). |
| Cobro de la mensualidad (Wompi) | Tarifa general. | 2,65 % + COP 700 + IVA por transacción (≈ 4 % de una mensualidad). |
| Infraestructura y soporte por empresa | Base de datos, servidores, correo, monitoreo y atención de soporte, prorrateados. | COP 18.000 (Esencial) · 25.000 (Negocio) · 40.000 (Pro) al mes. |

**El costo que manda es la IA.** Con el modelo configurado, cada respuesta automática cuesta unos COP 100.
Si en algún momento se decide usar `claude-sonnet-5-5` para las respuestas rutinarias (US$2 / US$10 por
millón), el costo baja a unos COP 50 por respuesta; con `claude-haiku-5-5` (US$0,10 / US$0,50), a menos de
COP 5. Es una decisión de calidad y negocio que no se toma aquí: los precios de abajo asumen el modelo
actual. Con uso real, `ia_consumo` registra tokens de entrada y salida por modelo y día, y permite recalcular
estas cifras con datos medidos.

## 2. El problema de los precios actuales

| Plan | Precio actual | Cuota de IA | Respuestas de IA que alcanzan (~5.000 tokens c/u) |
|---|---|---|---|
| Esencial | 79.000 | 400.000 tokens | **~80 al mes** |
| Negocio | 149.000 | 1.500.000 tokens | ~300 al mes |
| Pro | 289.000 | 5.000.000 tokens | ~1.000 al mes |

Una barbería con movimiento recibe entre 300 y 800 mensajes de clientes al mes: con Esencial la IA dejaría
de responder en la primera semana. Las cuotas no corresponden al producto que se vende (atención por
WhatsApp con IA), y subirlas sin ajustar el precio dejaría el plan Negocio con margen negativo.

## 3. Precios recomendados

Margen bruto objetivo: ~60 % con un uso típico (40 % de la cuota) y nunca negativo con la cuota completa.
En mensajes se cuenta que la mitad son salientes y que los primeros 1.000 de servicio de cada número son gratis.
El anual cobra 10 meses y da 12 (2 meses gratis, 16,7 % de descuento).

| Plan | Mensual | Anual (12 meses) | Personas | IA al mes | Mensajes | Documentos DIAN | Excedente de IA |
|---|---|---|---|---|---|---|---|
| **Esencial** | **99.000** | 990.000 | 2 | 2.000.000 tokens (~400 respuestas) | 1.500 | — | Se limita |
| **Negocio** | **229.000** | 2.290.000 | 6 | 6.000.000 tokens (~1.200 respuestas) | 5.000 | 300 | Se limita |
| **Pro** | **549.000** | 5.490.000 | 20 | 12.000.000 tokens (~2.400 respuestas) | 15.000 | 1.000 | COP 30 por 1.000 tokens |

### Márgenes (mensual)

| Plan | Costo con uso típico (40 %) | Margen típico | Costo con la cuota llena | Margen con la cuota llena |
|---|---|---|---|---|
| Esencial | 16.000 IA + 18.000 infra + 4.000 cobro = 38.000 | **62 %** | 40.000 + 18.000 + 4.000 = 62.000 | 37 % |
| Negocio | 48.000 + 14.400 DIAN + 25.000 + 8.100 cobro = 95.500 | **58 %** | 120.000 + 36.000 + 3.900 WA + 25.000 + 8.100 = 193.000 | 16 % |
| Pro | 96.000 + 48.000 + 5.200 WA + 40.000 + 18.100 = 207.300 | **62 %** | 240.000 + 120.000 + 16.900 + 40.000 + 18.100 = 435.000 | 21 % |

El excedente de Pro (COP 30 por 1.000 tokens frente a un costo de ~20) conserva un 33 % de margen sobre lo
que pase de la cuota. Esencial y Negocio no generan cobros adicionales: al llegar al tope, el agente pasa
las conversaciones al equipo.

### Frente al mercado colombiano (2026)

- Agenda para barberías y salones: COP 22.000–100.000 al mes, sin agente de IA (CERG Suite, Gestabiz, Febepos; AgendaPro desde US$19 con WhatsApp aparte).
- Facturación electrónica sola: Alegra COP 25.900–199.900; Siigo desde ~COP 10.000 solo facturación.
- POS con WhatsApp: COP 49.900 (200 mensajes) a 199.900 (2.000 mensajes), sin IA.

Esencial (99.000) queda en el rango de una agenda con WhatsApp, pero incluye el agente que responde y
agenda solo. Negocio (229.000) cuesta lo que una facturación electrónica de gama alta y suma agenda,
inventario, comisiones y la IA. Pro es para equipos grandes y alto volumen.

## 4. Cómo se aplica

- Las empresas que ya pagan **conservan su precio mensual** mientras sigan en su plan (`subscription.precio_pactado`); reciben las cuotas nuevas desde ya. Si cambian de plan, pasan al precio vigente.
- Las nuevas empresas ven y pagan los precios de esta tabla desde el registro.
- **Pago anual**: 12 meses por el precio de 10. Se elige al renovar o al cambiar de plan; la renovación anual extiende el periodo 12 meses.

### Cambio de plan (Suscripción › Plan actual o Suscripción › Planes)

El servidor calcula el valor exacto (`server/src/modules/planes.ts`); el navegador solo elige plan y ciclo y envía el
cargo que vio: si cambió, no se cobra y se muestra la cotización vigente.

| Cambio | Qué pasa | Cobro |
|---|---|---|
| Subir de plan, mismo ciclo | Se activa al confirmarse el pago; el periodo no cambia | Diferencia × días que quedan / días del periodo |
| Mensual → anual | Empieza un año desde hoy | Precio anual − lo no usado del mes pagado |
| Bajar de plan o anual → mensual | Queda programado para la próxima renovación; se puede deshacer | Nada hoy (no hay devoluciones parciales) |
| Con la suscripción vencida | Renovar directamente con el plan elegido | Precio completo del plan |

Los ajustes menores de COP 2.000 no se cobran. Bajar de plan exige no tener más personas con acceso de las que
permite el plan nuevo. Los módulos que el plan nuevo no incluye se apagan; los datos se conservan. Nada se cobra
de forma automática: todo cobro pasa por un checkout que la empresa aprueba, y el plan cambia solo cuando la
pasarela confirma el pago.

- Antes de producción: confirmar con el proveedor DIAN el precio por documento y con Wompi la tarifa negociada; revisar con contabilidad el tratamiento de IVA de los servicios en la nube.

Fuentes: tarifas de Meta por país (formbeep.com, whatsgrowai.com, oct 2026), tarifas Wompi (Bancolombia, Enter.co, Cambio, sep 2026), TRM (Portafolio, oct 2026), precios de Alegra (alegra.com/colombia/precios), comparativas de software para salones (gestabiz.com, turnito.app, cergsuite.com, febepos.com, poscolombia.com), precios de Claude (documentación de Anthropic, oct 2026).
