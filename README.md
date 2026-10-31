# Omnegia

Plataforma multiempresa para negocios: WhatsApp con IA y paso a una persona con radicados, clientes, agenda, ventas, inventario, cobros, facturación, suscripciones y un panel interno para el operador de Omnegia.

- `server/`: Fastify 5 + TypeScript, PostgreSQL (o PGlite para desarrollo), trabajador en segundo plano.
- `web/`: React 19 + Vite. En producción el servidor sirve el panel compilado.
- `docs/auditoria-2026-10/`: informes de la auditoría de octubre de 2026 (resumen ejecutivo, hallazgos, cambios, pruebas, permisos, integraciones y configuración).

## 1. Requisitos e instalación

Necesitas Node 22 o superior (probado con Node 26). En desarrollo no hace falta PostgreSQL: sin `DATABASE_URL`, el servidor usa PGlite (PostgreSQL en WASM, con las mismas políticas de seguridad).

```bash
npm run instalar     # dependencias de server/ y web/
npm run dev          # API en :3000 y panel en http://localhost:5173
```

La primera ejecución crea la base en `server/data/pglite` y carga datos de demostración. Para empezar de cero: `npm run reset`. Para limpiar empresas conservando la tuya (`npm run reiniciar`) o dejar todo en blanco, también en PostgreSQL (`npm run borrar-todo`), ver [docs/reinicio-de-datos](docs/reinicio-de-datos/README.md).

| Cuenta | Contraseña | Qué es |
|---|---|---|
| admin@elparche.test | demo-parche-2026 | Administradora de Barbería El Parche |
| laura@elparche.test | demo-equipo-2026 | Recepción (recibe los casos escalados) |
| admin@fuerzanorte.test | demo-fuerza-2026 | Administrador del gimnasio y supervisor en la barbería |
| plataforma@saas.test | demo-plataforma-2026 | Operador de Omnegia (rol ADMIN) |
| soporte@saas.test | demo-soporte-2026 | Operador de Omnegia (rol SOPORTE) |

Las cuentas del operador piden un código de seis dígitos enviado por correo. En desarrollo el correo no sale de la máquina: cada mensaje queda como `.html` y `.txt` en `server/.buzon-dev/`. Esa carpeta está fuera del repositorio.

## 2. Variables de entorno

Copia `server/.env.example` a `server/.env`. Nunca subas `.env` al repositorio. En producción (`NODE_ENV=production`), el servidor no arranca si falta algo obligatorio y nunca activa un simulador por falta de credenciales.

| Área | Variables |
|---|---|
| Base | `APP_PUBLIC_URL` (https en producción), `API_PUBLIC_URL`, `BASE_DOMAIN`, `DATABASE_URL`, `APP_KEY` (32+ caracteres: `openssl rand -base64 48`) |
| Correo | `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM_NAME`, `EMAIL_FROM_ADDRESS`, `EMAIL_REPLY_TO`, `EMAIL_SUPPORT_INBOX`, `EMAIL_OTP_EXPIRY_MINUTES`, `RESEND_WEBHOOK_SECRET` |
| SMTP alternativo | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` |
| WhatsApp (Meta) | `WHATSAPP_PLATFORM_PHONE_NUMBER_ID` (número de Omnegia: reconoce los teléfonos de los comercios), `WHATSAPP_PLATFORM_WABA_ID` (WABA de Omnegia donde se registran los números propios), `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION`, `WHATSAPP_WABA_LIMITE_NUMEROS` (2 con el portafolio de Meta sin verificar), `WHATSAPP_CUENTA_PROPIA_HABILITADA` (0: «Próximamente») |
| IA (Claude) | `ANTHROPIC_API_KEY`, `LLM_MODEL` (por defecto `claude-opus-5-5`), `IA_PRECIO_ENTRADA_USD_MTOK`, `IA_PRECIO_SALIDA_USD_MTOK` |
| Pagos (Wompi) | `WOMPI_ENTORNO`, `WOMPI_LLAVE_PUBLICA`, `WOMPI_LLAVE_PRIVADA`, `WOMPI_SECRETO_INTEGRIDAD`, `WOMPI_SECRETO_EVENTOS`, `WOMPI_3DS`, `WOMPI_3DS_SANDBOX`, `TARIFAS_CONFIRMADAS`, `MODO_INSTITUCIONAL`, `PRECIO_INSTITUCIONAL_COP`, `ACCESO_INSTITUCIONAL_DIAS` |
| Documentos de pago y zona legal | `EMISOR_RAZON_SOCIAL`, `EMISOR_NUMERO_DOCUMENTO`, `EMISOR_DIRECCION`, `EMISOR_CIUDAD`, `EMISOR_CORREO`, `EMISOR_TELEFONO` (también identifican a Omnegia en `/legal`), `EMISOR_RESPONSABLE_IVA`, `IVA_PCT`, `FACTURACION_ELECTRONICA_PLATAFORMA` (nunca automática) y `FACTURACION_*` |
| Facturación de las empresas | `FACTURACION_DIAN_HABILITADA` (0 por defecto: factura DIAN en «Próximamente»; las empresas generan comprobantes de venta internos), `FISCAL_PROVIDER` |
| Sesiones | `SESION_DIAS`, `SESION_INACTIVIDAD_HORAS`, `LOGIN_MAX_INTENTOS`, `LOGIN_VENTANA_MIN` |

El panel muestra el estado de cada integración en Configuración › Integraciones. El operador lo ve en su panel, en Integraciones. `GET /api/salud/listo` responde 200 solo si la base está disponible y las migraciones están aplicadas.

## 3. Correo transaccional

Zoho Mail recibe la correspondencia humana en `soporte@brianacevedo.dev`. Resend envía lo automático: códigos, recuperación de contraseña, invitaciones, avisos y tickets. No uses el SMTP de Zoho para envíos automáticos: su política no lo permite, y el servidor rechaza `SMTP_HOST` con Zoho al arrancar.

**Clave de API.** En resend.com, entra a API Keys, pulsa Create API Key y elige permiso «Sending access». Ponla en `RESEND_API_KEY`.

**Registros DNS que debe verificar el propietario del dominio.** Añade el dominio en Resend › Domains y copia exactamente los registros que muestre:

| Registro | Nombre | Para qué |
|---|---|---|
| TXT | `resend._domainkey` | Firma DKIM de Resend |
| MX | `send` | Dirección de retorno de Resend (subdominio, no toca la raíz) |
| TXT | `send` | SPF de Resend para ese subdominio |
| TXT | `_dmarc` | Política DMARC. Para empezar, `v=DMARC1; p=none; rua=mailto:soporte@brianacevedo.dev` |

No modifiques los registros MX de la raíz: son de Zoho y siguen recibiendo. Tampoco crees un segundo SPF en la raíz: el de Zoho se queda como está. Espera a que Resend marque el dominio como «Verified» antes de enviar.

**Estados de entrega (opcional, recomendado).** En Resend › Webhooks, crea uno hacia `https://<tu-api>/api/webhooks/correo` con los eventos `email.delivered`, `email.bounced`, `email.complained`, `email.failed` y `email.suppressed`. Copia su secreto `whsec_…` en `RESEND_WEBHOOK_SECRET`. Sin webhook, un correo queda como «aceptado por el proveedor», que no es lo mismo que entregado.

**Prueba de envío.**

```bash
cd server
npm run correo:prueba -- tu-correo@dominio.com
```

El comando imprime el id que devuelve el proveedor, o el código del fallo. Revisa la bandeja de entrada para confirmar la entrega. Si respondes ese correo, la respuesta llega a `EMAIL_REPLY_TO`.

**Cambiar de proveedor o de remitente** no requiere tocar el código:

- Otro remitente: cambia `EMAIL_FROM_NAME` y `EMAIL_FROM_ADDRESS`, verifica ese dominio en el proveedor y reinicia.
- SMTP transaccional (Postmark, SES, Mailgun…): `EMAIL_PROVIDER=smtp` con `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER` y `SMTP_PASSWORD`.
- Desarrollo sin envíos reales: `EMAIL_PROVIDER=fake`.

Cómo funciona el envío:

- Cada correo pasa por una bandeja de salida en la base y lo entrega el trabajador, con reintentos y una clave de idempotencia por correo.
- Los correos con códigos o enlaces de acceso se guardan cifrados y su contenido se borra en cuanto el proveedor los acepta.
- Los fallos quedan con un código seguro (credencial, dominio no verificado, límite, destinatario) y nunca se muestran como éxito.
- Las respuestas que se den desde Zoho no se sincronizan con el panel: eso requeriría una integración de entrada aparte.

## 4. Otras integraciones

- **WhatsApp:** en Meta, registra el webhook `https://<tu-api>/api/webhooks/whatsapp` con `WHATSAPP_VERIFY_TOKEN`. Las empresas no escriben identificadores: conectan su número con «Usar mi propio número» o el operador se lo asigna desde **Números de WhatsApp** (lista en vivo de la WABA, asignación, registro en la API con PIN cifrado). Fuera de la ventana de 24 horas solo salen plantillas aprobadas en Meta. Ver [docs/numeros-whatsapp](docs/numeros-whatsapp/README.md), sección 11.
- **Usar mi propio número (forma principal):** en `/whatsapp/numero` la empresa escribe su número, recibe un código por SMS y queda conectada a la IA, sin entrar a Meta. Omnegia registra el número en su propia WABA (`WHATSAPP_PLATFORM_WABA_ID`, obligatoria en producción si hay `WHATSAPP_ACCESS_TOKEN`).
- **Números de WhatsApp contratados (Telnyx + Meta), «Próximamente»:** con `NUMEROS_COMPRA_HABILITADA=1` una empresa puede comprar un número desde `/whatsapp/numero` y Omnegia lo verifica y conecta. Configuración, costos, restricciones y pruebas en [docs/numeros-whatsapp](docs/numeros-whatsapp/README.md).
- **IA:** con `ANTHROPIC_API_KEY`, el agente usa Claude. Sin ella, en producción las conversaciones pasan a una persona.
- **Wompi:** las altas y renovaciones usan las llaves de la plataforma. URL de eventos: `https://<tu-api>/api/webhooks/wompi`. Cada comercio conecta su propia cuenta para cobrar a sus clientes. `TARIFAS_CONFIRMADAS=1` solo cuando los precios comerciales estén definidos.
- **Facturación electrónica DIAN, «Próximamente»:** apagada con `FACTURACION_DIAN_HABILITADA=0` (sus rutas responden 409). Mientras tanto, cada empresa genera **comprobantes de venta** internos, sin validez fiscal y con su leyenda. Ver [docs/comprobantes](docs/comprobantes/README.md).
- **La IA que atiende:** por defecto resuelve sola citas, ventas y dudas, y solo pasa a una persona por reglas explícitas (pide una persona, queja, pagos, urgencia, sin solución). Los avisos proactivos respetan la ventana de 24 horas de WhatsApp. Ver [docs/ia-autonoma](docs/ia-autonoma/README.md), [docs/agenda](docs/agenda/README.md) (motor de disponibilidad y calendario) y [docs/imagenes](docs/imagenes/README.md) (fotos del catálogo, proveedor y derechos, punto de venta).

## 5. Panel del operador de Omnegia

Está en `/operador`. Sus secciones son Resumen, Empresas, Suscripciones, Salud del sistema, Incidentes, Integraciones, Soporte y Auditoría.

- Exige una cuenta con rol de plataforma (`ADMIN` o `SOPORTE`) y segundo factor por correo en cada inicio de sesión.
- Las consultas corren con un rol de base de datos propio (`app_operador`), sin `BYPASSRLS` y con privilegios por columna. Ese rol no puede leer clientes, conversaciones, mensajes, citas, ventas, inventario, facturas, cuentas de cobro de los comercios, sesiones, contraseñas ni secretos: la base lo rechaza.
- Los incidentes guardan un código, una descripción de catálogo y detalles técnicos de una lista permitida. Nunca guardan el texto de un proveedor o una excepción.
- Solo se reintentan trabajos idempotentes. Mensajes de WhatsApp, facturas y cobros no se reintentan desde el panel.
- Suspender, cancelar o cambiar el plan exige un motivo y escribir el subdominio. Nada borra datos, y todo queda en una auditoría de solo inserción.
- Son restricciones de la aplicación. Quien administra la infraestructura (el usuario dueño de la base) conserva sus privilegios. Limita ese acceso por separado.

Para dar el rol a una persona, usa una consulta en la base: `UPDATE users SET rol_plataforma='ADMIN' WHERE email='…'`. El panel no ofrece esa acción a propósito.

## 6. Pruebas

```bash
cd server
npm test                 # suite completa sobre PGlite
npm run test:postgres    # archivos críticos sobre PostgreSQL 18 real (embebido, se descarga solo)
npm run typecheck
cd ../web && npm run build
```

Las pruebas usan proveedores falsos y servidores locales (un HTTP con la forma de la API de Resend y un SMTP mínimo): no envían correos reales.

## 7. Producción

1. Crea la base en UTF8 con `CREATE DATABASE omnegia ENCODING 'UTF8' TEMPLATE template0;`. La primera migración crea los roles y necesita un superusuario.
2. Aplica las migraciones con `cd server && npm run migrar`. También se aplican al arrancar.
3. Compila con `npm run build`, en la raíz.
4. Arranca con `NODE_ENV=production npm start`, detrás de https y con DNS comodín `*.tu-dominio`.

Respaldo: con PostgreSQL usa `pg_dump -Fc` y `pg_restore`. Con PGlite, `npm run respaldo -- crear` y `npm run respaldo -- restaurar <archivo>`.

Errores frecuentes:

- «codificación … debe ser UTF8»: la base se creó con otra codificación. Créala de nuevo como en el paso 1.
- «APP_KEY es obligatoria»: falta la clave o tiene menos de 32 caracteres.
- Cookies que no persisten: `APP_PUBLIC_URL` debe usar https en producción.
- Correos FALLIDO con `REMITENTE_NO_VERIFICADO`: el dominio aún no está verificado en Resend.

Prueba de carga: `node server/scripts/carga.mjs http://localhost:3000 15 20` (15 segundos por caso, 20 clientes concurrentes).
