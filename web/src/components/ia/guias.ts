/**
 * Guías en pantalla de Omnegia IA. Cada paso señala un elemento real marcado con data-guia en su
 * pantalla; si el elemento no está (rol sin permiso, módulo apagado), el paso opcional se salta y uno
 * obligatorio avisa en vez de señalar al vacío. Los identificadores coinciden con server/src/ai/guias.ts
 * y una prueba del servidor verifica que cada ancla exista en web/src.
 *
 *   ancla   valor de data-guia del elemento que se señala («menu/ventas» = acceso del menú a /ventas).
 *   ruta    pantalla donde vive el elemento; si la persona está en otra, la guía la lleva.
 *   abrir   al pulsar «Siguiente» la IA pulsa ese botón por la persona (solo abre pantallas o
 *           formularios: nunca guarda, cobra ni envía nada).
 */
export interface PasoGuia { ancla: string; titulo: string; texto: string; ruta?: string; abrir?: boolean; opcional?: boolean }
export interface Guia { titulo: string; pasos: PasoGuia[] }

export const GUIAS: Record<string, Guia> = {
  recorrido_panel: {
    titulo: 'Recorrido por el panel',
    pasos: [
      { ancla: 'menu/', titulo: 'Inicio', texto: 'Tu tablero: lo vendido, lo cobrado, la agenda de hoy y lo que espera por ti, con cifras reales que se actualizan solas.', opcional: true },
      { ancla: 'menu/informes', titulo: 'Informes', texto: 'Informes con tus cifras reales y tu marca: ventas, cobros, agenda, clientes e inventario, listos para descargar como imagen o PDF.', opcional: true },
      { ancla: 'menu/conversaciones', titulo: 'Conversaciones', texto: 'Aquí llegan los mensajes de WhatsApp. El número rojo cuenta los que no has leído y late si alguien espera a una persona.', opcional: true },
      { ancla: 'menu/agenda', titulo: 'Agenda', texto: 'Las citas del día por persona. La IA también agenda por WhatsApp y esas citas llevan la marca IA.', opcional: true },
      { ancla: 'menu/ventas', titulo: 'Ventas', texto: 'Registra ventas, cobra en efectivo, transferencia o datáfono y revisa la caja del día.', opcional: true },
      { ancla: 'menu/clientes', titulo: 'Clientes', texto: 'Tus clientes con su historial. Los que escriben por WhatsApp se crean solos.', opcional: true },
      { ancla: 'menu/inventario', titulo: 'Catálogo', texto: 'Productos y servicios con su precio. La IA de WhatsApp los ofrece tal como están aquí.', opcional: true },
      { ancla: 'menu/configuracion', titulo: 'Configuración', texto: 'Tu equipo, horarios, datos de la empresa, WhatsApp y cobros.', opcional: true },
      { ancla: 'ia/pildora', titulo: 'Pregúntame', texto: 'Aquí estoy siempre. Pregúntame por tus cifras o pídeme que te muestre cómo hacer algo y te lo señalo así, paso a paso. Te abro el chat.', abrir: true },
    ],
  },
  registrar_venta: {
    titulo: 'Registrar una venta',
    pasos: [
      { ancla: 'menu/ventas', titulo: 'Ventas', texto: 'Las ventas se registran desde Ventas, en la pestaña «Vender».', opcional: true },
      { ancla: 'ventas/pestana-vender', ruta: '/ventas/vender', titulo: 'Vender', texto: 'Esta pestaña es el punto de venta. Te llevo allí.', abrir: true },
      { ancla: 'venta/cliente', titulo: 'El cliente', texto: 'Elige a un cliente reciente, búscalo por nombre o teléfono (F4) o crea uno nuevo. Si no hace falta, deja «Mostrador».' },
      { ancla: 'venta/items', titulo: 'Qué compró', texto: 'Toca cada producto para agregarlo; mantén presionado para elegir la cantidad. También puedes escribir en el buscador y pulsar Enter.' },
      { ancla: 'venta/cobro', titulo: 'Cómo pagó', texto: 'Elige el método. En efectivo escribe lo que te entregó y calculo el cambio. También puedes dejarla por cobrar.', opcional: true },
      { ancla: 'venta/registrar', titulo: 'Confirmar', texto: 'Revisa el total y pulsa «Cobrar» (F9). Si lo tienes activado, el comprobante se genera solo. Esto lo haces tú: yo no lo pulso.' },
    ],
  },
  registrar_pago: {
    titulo: 'Cobrar una venta pendiente',
    pasos: [
      { ancla: 'ventas/fila', ruta: '/ventas?pago=PENDIENTE', titulo: 'Ventas por cobrar', texto: 'Estas son las ventas que siguen por cobrar. Abro la más reciente.', abrir: true },
      { ancla: 'venta/registrar-pago', titulo: 'Registrar pago', texto: 'Desde el detalle de la venta registras el pago. Lo abro por ti.', abrir: true },
      { ancla: 'pago/metodo', titulo: 'Método', texto: 'Elige cómo pagó. En efectivo escribe lo recibido y el cambio aparece solo; la venta se paga completa.' },
      { ancla: 'pago/confirmar', titulo: 'Confirmar el pago', texto: 'Pulsa «Registrar pago» cuando el dinero esté recibido. Si te equivocas, luego se anula con un motivo.' },
    ],
  },
  agendar_cita: {
    titulo: 'Agendar una cita',
    pasos: [
      { ancla: 'menu/agenda', titulo: 'Agenda', texto: 'Las citas se agendan desde Agenda.', opcional: true },
      { ancla: 'agenda/nueva', ruta: '/agenda', titulo: 'Nueva cita', texto: 'Abre el formulario para agendar en una franja libre. Lo abro por ti.', abrir: true },
      { ancla: 'cita/cliente', titulo: 'El cliente', texto: 'Busca al cliente que va a venir.' },
      { ancla: 'cita/servicio', titulo: 'El servicio', texto: 'Elige el servicio: su duración define qué franjas caben.' },
      { ancla: 'cita/fecha', titulo: 'Día y persona', texto: 'Elige el día y, si quieres, con quién. Abajo aparecen las franjas libres: toca una para reservar.' },
    ],
  },
  nuevo_cliente: {
    titulo: 'Añadir un cliente',
    pasos: [
      { ancla: 'menu/clientes', titulo: 'Clientes', texto: 'Tus clientes viven en Clientes.', opcional: true },
      { ancla: 'clientes/nuevo', ruta: '/clientes', titulo: 'Nuevo cliente', texto: 'Este botón abre la ficha del cliente. La abro por ti.', abrir: true },
      { ancla: 'cliente/nombre', titulo: 'Nombre', texto: 'Escribe el nombre o la razón social. Es lo único obligatorio.' },
      { ancla: 'cliente/contacto', titulo: 'Contacto', texto: 'Con el teléfono lo reconozco cuando escriba por WhatsApp; el correo sirve para enviarle la factura.' },
      { ancla: 'cliente/documento', titulo: 'Documento', texto: 'Si pide factura con sus datos, elige el tipo de documento y escribe el número.' },
      { ancla: 'cliente/guardar', titulo: 'Guardar', texto: 'Pulsa «Guardar» y queda listo para ventas y citas.' },
    ],
  },
  nuevo_item_catalogo: {
    titulo: 'Crear un producto o servicio',
    pasos: [
      { ancla: 'menu/inventario', titulo: 'Catálogo', texto: 'Productos y servicios se crean en Catálogo.', opcional: true },
      { ancla: 'catalogo/nuevo', ruta: '/inventario', titulo: 'Nuevo ítem', texto: 'Abre el formulario del ítem. Lo abro por ti.', abrir: true },
      { ancla: 'item/tipo', titulo: 'Tipo', texto: 'Un servicio lleva duración (para la agenda); un producto lleva existencias.' },
      { ancla: 'item/nombre', titulo: 'Nombre', texto: 'Escríbelo como quieres que lo vean tus clientes: así lo ofrece la IA por WhatsApp.' },
      { ancla: 'item/precio', titulo: 'Precio', texto: 'El precio va con IVA incluido. Elige el IVA al lado.' },
      { ancla: 'item/guardar', titulo: 'Guardar', texto: 'Pulsa «Guardar» y ya se puede vender y agendar.' },
    ],
  },
  importar_catalogo: {
    titulo: 'Importar el catálogo',
    pasos: [
      { ancla: 'catalogo/importar', ruta: '/inventario', titulo: 'Importar', texto: 'Para cargar muchos ítems a la vez usa «Importar». Lo abro por ti.', abrir: true },
      { ancla: 'importar/archivo', titulo: 'Tu archivo', texto: 'Elige un .xlsx o .csv. Debajo hay una plantilla de ejemplo. Antes de guardar revisas fila por fila.' },
    ],
  },
  responder_conversacion: {
    titulo: 'Responder una conversación',
    pasos: [
      { ancla: 'menu/conversaciones', titulo: 'Conversaciones', texto: 'Los mensajes de WhatsApp llegan aquí. El número rojo cuenta los que no has leído.', opcional: true },
      { ancla: 'conv/fila', ruta: '/conversaciones', titulo: 'Elige una', texto: 'Las que tienen punto están sin leer. Abro la primera.', abrir: true },
      { ancla: 'conv/composer', titulo: 'Tu respuesta', texto: 'Escribe aquí. «Nota interna» la ve solo tu equipo; «Sugerir respuesta» te propone un texto que puedes editar.' },
      { ancla: 'conv/enviar', titulo: 'Enviar', texto: 'Pulsa «Enviar» y le llega por WhatsApp. Mientras atiendes tú, la IA no responde en esa conversación.' },
    ],
  },
  invitar_persona: {
    titulo: 'Invitar a alguien del equipo',
    pasos: [
      { ancla: 'config/invitar', ruta: '/configuracion?tab=personas', titulo: 'Invitar', texto: 'En «Personas con acceso» invitas a alguien. Lo abro por ti.', abrir: true },
      { ancla: 'invitar/datos', titulo: 'Sus datos', texto: 'Escribe su nombre y su correo: le llega un enlace para crear su contraseña.' },
      { ancla: 'invitar/rol', titulo: 'Su rol', texto: 'El rol define qué puede ver y hacer. La tabla «Qué puede hacer cada rol» lo detalla.' },
      { ancla: 'invitar/enviar', titulo: 'Enviar', texto: 'Pulsa «Enviar invitación». También podrás copiar el enlace.' },
    ],
  },
  numero_whatsapp: {
    titulo: 'Conectar el número de WhatsApp',
    pasos: [
      { ancla: 'menu/whatsapp/numero', titulo: 'Número de WhatsApp', texto: 'Todo lo del número está aquí.', opcional: true },
      { ancla: 'whatsapp/opciones', ruta: '/whatsapp/numero', titulo: 'Usa tu propio número', texto: 'Escribe tu número, recibe un código por SMS y queda conectado a tu asistente. No necesitas entrar a Meta. Comprar un número nuevo llegará pronto.' },
    ],
  },
};
