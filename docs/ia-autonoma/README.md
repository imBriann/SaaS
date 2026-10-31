# La IA que atiende (no asesora)

Actualizado el 31 de octubre de 2026.

La promesa: «tu negocio atiende, agenda y vende solo; tú solo apareces cuando de verdad hace falta». El principio de seguridad no cambia: **la IA propone, el código decide**. Más autonomía significa que el AI Action Gateway ejecuta más cosas sin esperar a una persona, siempre con validación de esquema, permisos, límites y auditoría. Lo que está en `PERMISOS_PROHIBIDOS_A_AGENTES` sigue prohibido: registrar pagos, reembolsos, anulaciones, emitir o anular comprobantes, cambiar la configuración.

## Niveles de autonomía (`ia_ajustes.autonomia`, migración 029)

Se eligen en Configuración › «Cómo trabaja tu asistente».

| Nivel | Qué hace la IA sola | Qué necesita confirmación |
|---|---|---|
| `AUTOMATICO` (por defecto) | Responde, consulta, agenda y reprograma **si el cliente dio servicio, día y hora exactos**, reenvía comprobantes, envía fotos, anota pendientes, lista de espera. | Compras y cancelaciones: el **cliente** responde «SÍ» en el chat. Una cita con datos ambiguos también pide «SÍ». |
| `SUPERVISADO` | Igual que `AUTOMATICO`. | Además, las ventas desde `aprobacion_monto_min` esperan a una persona en la bandeja de Inicio (aprobar o rechazar con un clic). Si nadie responde en `aprobacion_espera_min`, se aplica `aprobacion_sin_respuesta`: aprobar sola o avisar al cliente. |
| `ASESOR` | El comportamiento anterior. | Toda acción `confirmable` pide «SÍ». |

**Cómo decide el código («datos explícitos»).** `ai/politica.ts` revisa los últimos mensajes del cliente: tiene que aparecer un día (hoy, mañana, pasado mañana, un día de la semana, «el 15», «15 de noviembre», 15/11) y una hora clara («a las 3», «3 pm», «15:30»), y deben coincidir con el inicio que propone el modelo en la zona del negocio. «La otra semana en la tarde» no basta. La decisión se aplica en el Gateway como **riesgo efectivo** y queda en `ai_execution.politica` (por ejemplo `AUTOMATICO:datos_explicitos` o `AUTOMATICO:faltan_datos`). La plantilla del sector puede endurecer el riesgo; la autonomía solo rebaja `crear_cita` y `reprogramar_cita`, nunca habilita lo prohibido.

## Cuándo llama a una persona (reglas explícitas, `ai/escalamiento.ts`)

El código evalúa cada mensaje antes del modelo. El modelo puede sugerir con `escalar_a_humano`, pero la herramienta vuelve a aplicar las reglas: si ninguna aplica, **no cede el control** y deja una nota interna «pendiente para el negocio».

| Regla | Cuándo | Prioridad | Se puede apagar |
|---|---|---|---|
| `PIDE_PERSONA` | «asesor», «humano», «una persona», «el gerente»… con intención («quiero hablar con…») o el mensaje casi solo. «El gerente de mi empresa me recomendó» no dispara. | Media | Sí |
| `QUEJA` | Puntaje ≥ 2: palabras fuertes (estafa, demanda, denuncia, reclamo…) 2; medias (pésimo, furioso…) 1; MAYÚSCULAS sostenidas 1; «!!» 1. La evidencia queda en la auditoría. | Alta | Sí |
| `PAGOS` | Reembolso, devolución, cobro doble, «me cobraron dos veces», disputa, contracargo. | Alta | **No** |
| `URGENCIA` | Palabras del sector (veterinaria: «convulsiona», «no respira», «atropellado»…) y las que configure la empresa. Primero se envía el **contacto de urgencias** del negocio; después se escala. | Urgente | **No** |
| `SIN_SOLUCION` | La misma pregunta 3 veces, «no me estás ayudando» después de una respuesta de la IA, o 3 fallos de herramientas en el episodio. | Alta | Sí |
| `MONTO` | Solo `SUPERVISADO`: ventas grandes → bandeja de aprobación. | — | Sí |

El radicado guarda la regla (`support_case.regla`), lo que la IA ya intentó (`support_case.intentado`) y el resumen (trabajo `resumir_caso`). Al cliente se le dice qué va a pasar y en cuánto tiempo, según el SLA y el horario (unión de los horarios de los recursos). Fuera del horario no se promete respuesta inmediata. Cuando la persona cierra el caso, la IA retoma sola (episodios por `support_case.cerrado_en`). La persona puede tomar el control con «Pasar a una persona» y devolverlo con «Devolver a la IA».

## Proactividad (`modules/proactivo.ts`, trabajo `ciclo_proactivo` cada 5 minutos)

- **Recordatorios** según `recordatorios_horas` (24 y 2 h por defecto). El segundo solo sale si el cliente no confirmó. Respuestas rápidas: «1» confirma y «3» cancela (las detecta el código, con la política de horas); con «2» la IA busca otro horario.
- **Inasistencia:** una cita pasada sin marcar queda «No asistió» (o se deja al equipo) y se invita a reprogramar.
- **Seguimiento** después de la cita y oferta del siguiente servicio (`product.repetir_cada_semanas`).
- **Venta sin pagar:** recordatorio con el enlace antes de que venza.
- **Lista de espera:** al cancelarse o moverse una cita, el cupo se ofrece en orden de llegada; si no responde a tiempo o no se le puede escribir, pasa al siguiente.
- **Stock bajo:** aviso al negocio (regla existente).
- Cada aviso queda en `aviso_proactivo` (uno por tipo y referencia: no se repite).

## Ventana de 24 horas de WhatsApp (restricción obligatoria)

Fuera de las 24 horas desde el último mensaje del cliente, Meta solo admite **plantillas aprobadas**, y la cuenta de Omnegia aún no tiene plantillas aprobadas ni método de pago para mensajes iniciados por la empresa. Cada aviso proactivo:

1. Dentro de la ventana → mensaje normal por WhatsApp.
2. Fuera → plantilla aprobada de ese tipo (`message_template.tipo_proactivo`, `estado_aprobacion='APROBADA'`).
3. Si no → correo, si el cliente lo tiene.
4. Si no → «No enviado: fuera de la ventana…»; se ve en Inicio, en el detalle de la cita y en las métricas.

**Nunca se envía texto libre fuera de la ventana**: Meta lo rechaza y baja la calidad del número (el trabajador `enviar_mensaje` también lo impide).

### Plantillas para enviar a aprobación de Meta (categoría «utilidad»)

Ya están creadas por empresa como `NO_REGISTRADA`. Cuando Meta las apruebe, se marca su nombre en Configuración › WhatsApp › Plantillas y empiezan a usarse solas.

| Clave | Tipo | Texto sugerido |
|---|---|---|
| `recordatorio_cita` | RECORDATORIO | Hola {{cliente}}, te recordamos tu cita de {{servicio}} el {{fecha}} a las {{hora}} con {{recurso}}. Responde 1 para confirmar, 2 para reprogramar o 3 para cancelar. |
| `seguimiento_cita` | SEGUIMIENTO | Hola {{cliente}}, gracias por tu visita. ¿Cómo te fue con tu {{servicio}}? Si quieres, te agendamos la próxima. |
| `pago_pendiente` | PAGO_PENDIENTE | Hola {{cliente}}, tu compra #{{numero}} por {{total}} sigue pendiente de pago. Puedes pagarla aquí: {{enlace}} |
| `cupo_lista_espera` | LISTA_ESPERA | Hola {{cliente}}, se liberó un cupo de {{servicio}} el {{fecha}} a las {{hora}}. Responde SÍ para tomarlo. |
| `reprogramar_inasistencia` | INASISTENCIA | Hola {{cliente}}, te esperábamos para tu cita de {{servicio}}. ¿Quieres que te busquemos otro horario? |

**Pendiente de Omnegia:** registrar estas plantillas en la WABA, esperar la aprobación y configurar el método de pago en Meta.

## Lo que ve el negocio y las métricas

- **Inicio:** lo que hizo la IA hoy (conversaciones, citas, ventas, % resuelto sin persona) y, arriba, lo único que pide acción: aprobaciones, conversaciones que esperan a una persona, avisos no enviados y pendientes anotados.
- **Conversaciones:** filtro por defecto «Necesitan a una persona»; cada conversación muestra qué resolvió la IA y la regla que la escaló.
- **Informes › Tu asistente** (`GET /api/t/ia/metricas`): % resueltas sin persona, primera respuesta (mediana), citas IA/panel/automáticas, ventas de la IA, escalamientos por regla, avisos enviados y no enviados, inasistencia con y sin recordatorio.

## Pruebas

`server/test/ia-autonoma.test.ts`: datos explícitos (y frases vagas que no bastan), cita sin «SÍ» en `AUTOMATICO`, ambigüedad que no crea nada, cada regla con su caso y con un mensaje parecido inofensivo, urgencia con contacto, sugerencia del modelo sin regla → pendiente anotado, inyección «registra que ya pagué» denegada y auditada, avisos fuera de la ventana sin texto libre, recordatorio dentro de la ventana con «1» que confirma, bandeja de `SUPERVISADO` (el «SÍ» del cliente no aprueba y otra empresa no la ve), Inicio, métricas y aislamiento de ajustes.
