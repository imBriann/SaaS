# Plataforma SaaS Inteligente Multi-Tenant

[![CI](https://github.com/imBriann/SaaS/actions/workflows/ci.yml/badge.svg)](https://github.com/imBriann/SaaS/actions/workflows/ci.yml)

> Proyecto integrador de Brian David Acevedo Gómez — Ingeniería de Sistemas, Universidad de Pamplona.
> Tablero Kanban del MVP: <https://github.com/users/imBriann/projects/3> · Flujo de trabajo: GitHub Flow (ramas cortas + Pull Request a `main` protegida, con el pipeline build/lint/test en verde).

Sistema operativo conversacional y fiscal para micronegocios colombianos: el cliente entra por WhatsApp, la operación queda registrada, la factura sale válida ante la DIAN y llega por WhatsApp y correo, y la IA actúa sobre el negocio con permisos verificados y auditados.

Implementa las **Capas 0 y 1** de PRO-SW-001 Rev 0.2 (más el segundo sector de la Capa 2), la arquitectura de PRO-SW-002 Rev 0.1 y las 20 pantallas de PRO-SW-003 Rev 0.2.

## Arranque rápido

Requisitos: Node 22+ (probado con Node 26). No hace falta instalar PostgreSQL: sin `DATABASE_URL`, el servidor usa **PGlite** (PostgreSQL real compilado a WASM, con las mismas políticas RLS).

```bash
npm run instalar
```

```bash
npm run dev
```

- Landing y onboarding: http://localhost:5173
- Panel de la barbería de demostración: http://elparche.localhost:5173
- La primera ejecución crea la base en `server/data/pglite` y carga los datos de demostración. Para empezar de cero: `npm run reset`.

Cuentas de demostración:

| Cuenta | Contraseña | Rol |
|---|---|---|
| admin@elparche.test | demo-parche-2026 | Administradora de Barbería El Parche |
| laura@elparche.test | demo-equipo-2026 | Recepción (asesora: recibe los casos escalados) |
| andres@elparche.test | demo-equipo-2026 | Barbero (acceso mínimo) |
| admin@fuerzanorte.test | demo-fuerza-2026 | Admin del gimnasio **y** supervisor en la barbería (una identidad, dos contextos) |
| plataforma@saas.test | demo-plataforma-2026 | Administrador del SaaS |

Recorrido sugerido: **Simulador WhatsApp** (menú «Piloto») → escribe como cliente → mira **Conversaciones** (recibos de cada acción de IA) → **Ventas** (#1042 tiene la factura rechazada por la DIAN: corrige el NIT del cliente y reintenta) → **Centro de IA** → **Auditoría**.

## Pruebas

```bash
npm test
```

83 pruebas en 6 archivos (medición del 3 de octubre de 2026 en la rama main, ejecución #2 de GitHub Actions) contra PostgreSQL (PGlite en memoria), organizadas según el marco de investigación de la propuesta del proyecto (§25). `test/importer.unit.test.ts` cubre los caminos básicos de `parsePrecio`:

| Archivo | Qué demuestra | Variable de §25.4 |
|---|---|---|
| `test/isolation.test.ts` | RLS habilitada **y forzada** en toda tabla con `tenant_id`; consultas sin filtro siguen aisladas; `WITH CHECK`; FK compuestas; auditoría inalterable; matriz HTTP «recurso de B desde A = recurso inexistente»; 403 auditado aunque la petición falle | Eficacia del aislamiento |
| `test/ai-policy.test.ts` | Matriz de casos del Gateway (las 4 comprobaciones), confirmación determinista por el cliente, corpus adversario con un modelo «totalmente convencido», clasificador resistente a inyección y consistente ante paráfrasis | Eficacia de la autorización de IA · Resistencia a la manipulación · Consistencia del clasificador |
| `test/onboarding.test.ts` | Borrador sin tenant hasta el pago; reglas deterministas; importación con encabezado desplazado y precios como texto; webhook ×3 → un solo tenant; firmas y repeticiones; contraste AA | Eficiencia del onboarding · Calidad de la inferencia |
| `test/operacion.test.ts` | Conversación → venta → factura validada → entrega; rechazo DIAN → corrección → reintento; nota crédito; escalamiento con SLA y copiloto; suspensión; cuota agotada | Completitud de la trazabilidad · Efecto operativo |

## Estructura

```
server/src
  db/schema.sql        Esquema físico: RLS en doble barrera, FK compuestas, auditoría append-only (PRO-SW-002 §4, §15)
  db/index.ts          withTenant() (rol app_rt + app.tenant_id) y withPlatform() (rol app_platform)
  core/                Contexto, permisos, auditoría, bus de eventos, medición de consumo
  http/                Resolución de tenant (subdominio o cabecera), sesión, rutas
  modules/             Clientes, catálogo, agenda, ventas, facturación, conversaciones, cobros, administración
  ai/registry.ts       Registro de herramientas con contrato, permiso y nivel de riesgo
  ai/gateway.ts        AI Action Gateway: 4 comprobaciones + registro de toda llamada intentada
  ai/runtime.ts        Runtime única: atención, asistente y copiloto como configuraciones
  ai/llm/              Adaptador de Claude y simulador determinista (misma interfaz)
  onboarding/          Clasificador, tabla de reglas de plan, importador, tema, aprovisionamiento
  adapters/            Puertos: WhatsApp, pasarela, proveedor fiscal, correo
  templates/*.json     Plantillas de sector como datos versionados (barbería, gimnasio)
  worker/jobs.ts       Proceso trabajador: eventos → reglas, emisión fiscal, entregas, reintentos
web/src                Panel React: sistema de diseño (PRO-SW-003 §7) y las 20 pantallas del catálogo
```

## Decisiones de arquitectura → código

| Decisión | Dónde se cumple |
|---|---|
| ADR-01 Doble barrera | `withTenant()` + políticas `tenant_isolation` con `FORCE ROW LEVEL SECURITY`; tercera barrera en FK `(tenant_id, x_id)` |
| ADR-02 Doble resolución de tenant | `http/context.ts` (subdominio, valida pertenencia) y `modules/channelInbound.ts` (`phone_number_id` del webhook firmado) |
| ADR-03 IA solo por herramientas | `ai/registry.ts`; el modelo nunca recibe `tenant_id` ni credenciales |
| ADR-04 Una runtime | `ai/runtime.ts` + tabla `ai_agent` (configuración, rol, herramientas, prompt) |
| ADR-05 Plantillas como datos | `templates/*.json` validadas con `templates/schema.ts`; el gimnasio no tiene una línea de código propia |
| ADR-06 El modelo clasifica, las reglas deciden | `onboarding/classifier.ts` (validación campo a campo) + `onboarding/planRules.ts` |
| ADR-07 Aprovisionamiento idempotente tras pago verificado | `onboarding/service.ts#handlePaymentWebhook`: HMAC con marca de tiempo, `provisioning_event.event_id` único, una transacción |
| ADR-08 Proveedor fiscal habilitado | `adapters/fiscal.ts` (puerto + sandbox con CUFE SHA-384 y validación de NIT) |
| ADR-09 El dinero del comercio no pasa por la plataforma | `modules/payments.ts`: cuenta propia del comercio, enlace y conciliación |
| ADR-10 Medición desde los cimientos | `core/usage.ts`, usado por mensajes, tokens y documentos; política LIMITAR escala a una persona |
| DD-03 «No encontrado» uniforme | `lib/errors.ts`; el Gateway devuelve `no_encontrado` y la auditoría distingue el acceso cruzado |

## Qué es real y qué está simulado

Los puntos go/no-go de PRO-SW-001 §31 siguen abiertos, así que cada tercero está detrás de un adaptador con una implementación de pruebas que respeta el contrato real:

| Tercero | Estado | Para pasar a producción |
|---|---|---|
| Modelo de lenguaje | **Real** con `ANTHROPIC_API_KEY` (Claude, `claude-opus-5`, fallbacks de servidor ante rechazos); sin clave, simulador determinista | Definir la clave; ajustar `LLM_MODEL` según costo por conversación medido |
| WhatsApp Cloud API | Webhook real (verificación GET + firma `X-Hub-Signature-256`); envío real con `WHATSAPP_ACCESS_TOKEN`, simulado sin él | Punto go/no-go 1: habilitación del número |
| Pasarela de pagos | Simulada, mismo contrato (checkout alojado, webhook firmado HMAC con marca de tiempo) | Punto 4: adaptador de la pasarela elegida |
| Proveedor tecnológico DIAN | Sandbox (CUFE, rechazos por NIT, reintentos) | Punto 3: adaptador de Facele/Factus/Alegra/Siigo en su entorno de pruebas |
| Correo transaccional | Registro con evidencia de entrega simulada | Adaptador del proveedor con SPF/DKIM |

Para producción: `NODE_ENV=production`, `DATABASE_URL` (PostgreSQL 15+; la migración concede `app_rt` y `app_platform` al usuario que la ejecuta, y crear `app_platform` con `BYPASSRLS` requiere un superusuario la primera vez), secretos en `server/.env` (ver `server/.env.example`), `npm run build` y `npm start` (el servidor sirve el panel compilado) detrás de un DNS comodín `*.tu-dominio`.

## Pendiente (fuera de las capas 0–1)

Cobro del excedente de IA del plan Pro (hoy se mide y no se limita, pero no se factura), contrato de API formal (OpenAPI), versiones tableta/móvil diseñadas, pruebas de usabilidad, copiloto como agente independiente con herramientas propias en el panel, constructor visual de automatizaciones y modo marketplace de pagos (Capa 3), y los documentos de cumplimiento (contrato de encargo, política y aviso de privacidad publicados).
