# D · Matriz de permisos

Todo se comprueba en el servidor: cada ruta exige un permiso concreto (`requirePerm`) y la base aplica aislamiento por empresa con RLS forzada. La interfaz solo oculta lo que el servidor ya rechazaría.

## 1. Propietario de la empresa (rango por encima del administrador)

Cada empresa tiene un propietario (`tenant.propietario_id`): quien hizo el alta o a quien se le cedió.

| Regla | Dónde se aplica |
|---|---|
| Siempre tiene todos los permisos de la empresa, cualquiera sea su rol | `tenantGuard` (servidor) |
| Ningún administrador puede cambiarle el rol, el nombre ni retirarle el acceso (403 y evento de auditoría) | `admin.updateMember` |
| Solo él cede la propiedad, con su contraseña, a una persona activa con correo confirmado; quien la recibe pasa a administrador y quien la cede sigue como administrador | `POST /api/t/configuracion/propietario` (una transacción) |
| Se avisa por correo a los dos | `plantillas.propiedadCedida` |

Una misma cuenta puede pertenecer a varias empresas con un rango distinto en cada una; el selector del panel cambia de empresa y el servidor valida la pertenencia en cada petición.

## 2. Roles de la empresa (plantilla de barbería; las demás plantillas siguen el mismo criterio)

| Permiso | Administrador | Supervisor | Recepción | Barbero |
|---|:-:|:-:|:-:|:-:|
| Configurar empresa (`tenant:configure`), incluidos métodos de cobro y compartir conversaciones con soporte | ✓ | | | |
| Personas y roles (`user:manage`) | ✓ | | | |
| Clientes: ver / editar | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✓ / — |
| Catálogo: ver / editar | ✓ / ✓ | ✓ / — | ✓ / — | ✓ / — |
| Inventario: ver / movimientos | ✓ / ✓ | ✓ / — | ✓ / — | — |
| Ventas: ver / registrar / anular | ✓ / ✓ / ✓ | ✓ / ✓ / — | ✓ / ✓ / — | ✓ / ✓ / — |
| **Registrar pago** (`payment:register`) | ✓ | ✓ | ✓ | ✓ |
| **Anular pago** (`payment:void`) | ✓ | | | |
| Enlace de pago (`payment:link`) | ✓ | | ✓ | |
| Agenda: ver / crear / cancelar | ✓ | ✓ | ✓ | ver y crear |
| Conversaciones: ver / responder | ✓ | ✓ | ✓ | |
| Radicados: crear / atender / supervisar | ✓ | ✓ | crear y atender | |
| Facturas: ver / emitir / nota crédito | ✓ / ✓ / ✓ | ✓ / — / — | ✓ / ✓ / — | |
| Centro de IA: ver / configurar / copiloto | ✓ | ver y copiloto | copiloto | |
| Auditoría | ✓ | | | |
| Suscripción | ✓ | | | |

**Pedir ayuda a Omnegia desde una conversación** (`tenant:configure`): abre la solicitud y comparte solo esa conversación por 24 horas, 3 días o 7 días, en modo «solo leer» o «leer y responder». Se retira cuando se quiera; las notas internas nunca se comparten.

**Soporte de Omnegia:** cualquier persona de la empresa puede abrir una consulta. Solo quien la abrió puede marcarla como resuelta o pasarla al equipo; otra empresa recibe 404.

## 3. Agentes de IA (nunca reciben permisos de dinero, configuración ni auditoría)

| Agente | Puede | Nunca puede (`PERMISOS_PROHIBIDOS_A_AGENTES`) |
|---|---|---|
| Atención por WhatsApp | Consultar catálogo e inventario, agendar y cancelar citas, proponer ventas (el cliente confirma), escalar y generar enlace de pago | Emitir o anular facturas, gestionar personas, configurar la empresa o la IA, ver la auditoría, gestionar la suscripción, anular ventas, **registrar o anular pagos** |
| Asistente del panel | Consultar datos con los permisos de la persona; **crear o editar ítems del catálogo solo con su confirmación** (vence en 15 minutos y vuelve a comprobar los permisos al confirmar) | Lo mismo |
| Copiloto del asesor | Sugerir respuestas y resumir casos | Lo mismo |

## 4. Panel del operador de Omnegia

| Permiso | ADMIN | SOPORTE |
|---|:-:|:-:|
| Ver la plataforma (resumen, empresas, salud, auditoría) | ✓ | ✓ |
| Gestionar empresas (suspender, reactivar, plan, módulos) con motivo y confirmación del subdominio | ✓ | |
| Planes, reintento de trabajos y reembolsos | ✓ | |
| Incidentes y soporte | ✓ | ✓ |
| Conversaciones del WhatsApp de Omnegia: ver y atender | ✓ | ✓ |
| Asignar conversaciones a otra persona | ✓ | |
| Responder una conversación que atiende otra persona | ✓ | solo nota interna |
| Atención de las empresas (solo cifras) | ✓ | ✓ |
| Leer una conversación que la empresa compartió | ✓ | ✓ |
| Responder al cliente en una conversación compartida con «leer y responder» (sale por el WhatsApp de la empresa como «Soporte de Omnegia»; nunca con «solo leer», acceso vencido o retirado) | ✓ | ✓ |
| Verificar el WhatsApp de una empresa con Meta (solo consulta) | ✓ | ✓ |
| Editar productos, precios, inventario o ventas de una empresa | **Nunca** | **Nunca** |

## 5. Roles de la base de datos

| Rol | Uso | Restricción |
|---|---|---|
| `app_rt` | Peticiones de una empresa | RLS por `tenant_id`; nunca BYPASSRLS |
| `app_platform` | Trabajos internos y webhooks | Lógica controlada en el servidor |
| `app_operador` | Panel del operador | Permisos por columna: sin texto de mensajes, clientes ni lo que escribió una empresa al asistente de soporte |
| `app_soporte` | Lectura autorizada | Cada fila exige un `acceso_soporte` vigente de esa empresa y esa conversación |
