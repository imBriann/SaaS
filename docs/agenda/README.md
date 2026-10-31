# Agenda automática y calendario

Actualizado el 31 de octubre de 2026.

## Modelo (migración 029)

- **Servicios** (`product`): `duracion_min`, `buffer_antes_min`, `buffer_despues_min`, `recursos_permitidos` (quién lo presta; vacío = cualquier recurso de tipo PROFESIONAL), `recursos_secundarios` (un segundo recurso que debe estar libre a la vez, por ejemplo groomer + mesa) y `repetir_cada_semanas` (seguimiento).
- **Recursos** (`resource`): `color`, `tipo` (`PROFESIONAL` o `ESPACIO`), `descanso` diario y horario por día.
- **Excepciones** (`resource_excepcion`): vacaciones, festivos propios y bloqueos con motivo, para un recurso o para todo el negocio.
- **Festivos de Colombia** (`lib/festivos.ts`): fijos, ley Emiliani (al lunes siguiente) y los que dependen de la Pascua. Se aplican con `agenda_ajustes.usar_festivos`.
- **Citas** (`appointment`): `confirmada_en`, `recordatorios`, `reprogramada_desde`, `canal_confirmacion`, `motivo_cancelacion`, `recurso_secundario_id`, `serie_id`. Origen `AGENTE`, `PANEL` o `AUTOMATIZACION` (lista de espera y recurrencias).
- **Series** (`appointment_serie`): «cada N semanas», hasta una fecha o un número de citas.
- **Lista de espera** (`lista_espera`): servicio, rango de fechas, franjas (mañana, tarde, noche), estado y orden de llegada.
- **Política** (`agenda_ajustes`): anticipación mínima, horizonte, horas para cancelar o reprogramar por el chat, confirmación al crear o por el cliente, regla de asignación, inasistencia y minutos para responder una oferta.

## Motor de disponibilidad (`modules/agendaMotor.ts`)

Una sola función, `huecos()`, la usan la IA, el panel y las automatizaciones:

> horario del recurso − descanso − excepciones − festivos − citas vivas con sus buffers − anticipación mínima, dentro del horizonte, en la zona horaria del negocio.

- **Asignación automática** cuando el cliente no pide a nadie: el primero libre, repartir la carga del día o el preferido del cliente según su historial.
- **Sugerencias:** si el horario pedido no está, los 3 huecos más cercanos (uno por hora), no una lista larga.
- **Doble reserva imposible:**
  1. bloqueo transaccional por agenda (`pg_advisory_xact_lock`) en el código;
  2. restricción de exclusión `EXCLUDE USING gist (tenant_id WITH =, resource_id WITH =, tstzrange(inicio, fin) WITH &&)` sobre citas vivas, y otra igual para el segundo recurso.
  PGlite carga la extensión `btree_gist` (`@electric-sql/pglite/contrib/btree_gist`) y PostgreSQL la trae en contrib, así que la restricción existe en los dos motores. Si un PostgreSQL no tuviera `btree_gist`, o hubiera citas solapadas antiguas, la migración no falla: queda solo el bloqueo transaccional (lo avisa con un NOTICE).
  - Los buffers no entran en la restricción de la base (dependen del servicio); los hace cumplir el motor.

## Automatizaciones

Confirmación según la política; recordatorios (ver `docs/ia-autonoma`); lista de espera al cancelar o mover; inasistencia; citas recurrentes; reprogramación y cancelación por el cliente desde el chat (`reprogramar_cita`, `cancelar_cita`, respuestas rápidas al recordatorio) respetando `horas_cancelacion`.

## Calendario del panel (`web/src/pages/app/Agenda.tsx`)

Construido en casa, sin librería: las opciones maduras (FullCalendar, react-big-calendar) traen su propio sistema de estilos y dependencias que habría que adaptar a `DESIGN.md`; el calendario propio usa directamente los tokens de color de la empresa y se carga solo al abrir la Agenda (paquete aparte).

- Vistas Día (columnas por recurso; en celular un recurso a la vez), Semana, Mes y Lista. «Hoy», flechas y selector de fecha.
- Línea de la hora actual; horas fuera de horario atenuadas; bloqueos, descansos y festivos rayados con su motivo.
- Arrastrar para mover y estirar el borde para cambiar la duración: pasa por el mismo motor; si choca, vuelve a su lugar con un aviso y las alternativas. Al moverla, «Avisar al cliente» (marcado por defecto; respeta la ventana de 24 horas).
- Crear con un clic en un hueco: panel lateral con cliente (buscador o nuevo), servicio, recurso (o automático), fecha, hora (el fin se calcula solo) y nota.
- Color por servicio o por recurso; el estado se ve con forma y etiqueta (reservada con borde punteado, cancelada tachada, etc.), no solo con color.
- Distintivos «Agendada por la IA» y «Automatización».
- Detalle en panel lateral: cliente, notas, historial, enlace a la conversación de WhatsApp, avisos enviados o no enviados (con motivo) y acciones rápidas.
- Filtros por recurso y servicio, búsqueda por cliente, resumen del día (citas, huecos libres, ocupación por recurso), bloqueos y reglas de la agenda desde la misma pantalla.
- Con teclado: cada cita es un botón; Enter abre el detalle, donde está «Reprogramar».

## Pruebas

`server/test/agenda-automatica.test.ts`: festivos (Pascua, Emiliani, fijos) y un lunes festivo sin huecos; dos pedidos simultáneos del mismo hueco (uno gana, el otro recibe hasta 3 alternativas); la exclusión de la base rechaza un solapamiento insertado a mano; buffers; servicio de dos recursos (solo con ambos libres, y la cita ocupa los dos); zona horaria en el cambio de día; mover y estirar; lista de espera que llena un cupo cancelado; inasistencia; serie cada 4 semanas; aislamiento entre empresas.
