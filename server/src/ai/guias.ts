/**
 * Guías en pantalla: el asistente elige UNA de esta lista y el panel mueve a la IA por los botones reales,
 * paso a paso. Los pasos (ruta, elemento señalado y texto) viven en web/src/components/ia/guias.ts junto a
 * los atributos data-guia de cada pantalla; aquí solo está lo que el modelo necesita para escoger y lo que
 * el servidor necesita para no ofrecer una guía que el rol no puede seguir. Una prueba comprueba que ambas
 * listas tengan los mismos identificadores y que cada elemento señalado exista en la interfaz.
 */
export const IDS_GUIA = [
  'recorrido_panel', 'registrar_venta', 'registrar_pago', 'agendar_cita', 'nuevo_cliente',
  'nuevo_item_catalogo', 'importar_catalogo', 'responder_conversacion', 'invitar_persona', 'numero_whatsapp',
] as const;
export type IdGuia = (typeof IDS_GUIA)[number];

export const GUIAS: Record<IdGuia, { titulo: string; para: string; permiso?: string; modulo?: string }> = {
  recorrido_panel: { titulo: 'Recorrido por el panel', para: 'conocer el panel: dónde está cada sección y qué hace' },
  registrar_venta: { titulo: 'Registrar una venta', para: 'registrar una venta y cobrarla', permiso: 'order:create', modulo: 'ventas' },
  registrar_pago: { titulo: 'Cobrar una venta pendiente', para: 'registrar el pago de una venta que quedó por cobrar', permiso: 'payment:register', modulo: 'ventas' },
  agendar_cita: { titulo: 'Agendar una cita', para: 'agendar una cita en una franja libre', permiso: 'appointment:create', modulo: 'agenda' },
  nuevo_cliente: { titulo: 'Añadir un cliente', para: 'crear un cliente con sus datos de contacto y documento', permiso: 'customer:write' },
  nuevo_item_catalogo: { titulo: 'Crear un producto o servicio', para: 'crear un producto o servicio en el catálogo', permiso: 'catalog:write' },
  importar_catalogo: { titulo: 'Importar el catálogo', para: 'cargar muchos productos a la vez desde Excel o CSV', permiso: 'catalog:write' },
  responder_conversacion: { titulo: 'Responder una conversación', para: 'responder a un cliente de WhatsApp desde el panel', permiso: 'conversation:reply' },
  invitar_persona: { titulo: 'Invitar a alguien del equipo', para: 'dar acceso al panel a otra persona con un rol', permiso: 'user:manage' },
  numero_whatsapp: { titulo: 'Conectar el número de WhatsApp', para: 'conectar el número propio o adquirir uno nuevo para WhatsApp', permiso: 'tenant:configure' },
};

/** Normaliza para comparar sin tildes ni mayúsculas. */
const normal = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Qué guía corresponde a una pregunta «¿cómo hago…?». El orden importa: lo más específico primero. */
const PATRONES: [RegExp, IdGuia][] = [
  [/recorrido|conocer el panel|como funciona (el|este) panel|tour/, 'recorrido_panel'],
  [/(registr|cobr)\w* (un |el )?pago|cobrar (una |la )?venta|venta (pendiente|por cobrar)/, 'registrar_pago'],
  [/(registr|hag|hace|crea|anot|ingres)\w* (una |la |mis |las )?ventas?|\bvender\b/, 'registrar_venta'],
  [/(agend|reserv|crea|program)\w* (una |la )?cita|\bagendar\b/, 'agendar_cita'],
  [/import/, 'importar_catalogo'],
  [/(anad|agreg|crea|registr|subo|subir)\w* (un |una |el |la |nuevo |nueva )?(producto|servicio|item)/, 'nuevo_item_catalogo'],
  [/(anad|agreg|crea|registr)\w* (un |el |nuevo )?cliente/, 'nuevo_cliente'],
  [/numero|conect\w* (el |mi )?whatsapp/, 'numero_whatsapp'],
  [/respond|contest|atiend\w* (una |la |un )?(conversacion|cliente|chat)/, 'responder_conversacion'],
  [/invit|dar acceso|agreg\w* (a )?(alguien|una persona)/, 'invitar_persona'],
];

/** Una pregunta de «cómo se hace» que alguna guía cubre (o null). */
export function detectarGuia(pregunta: string): IdGuia | null {
  const t = normal(pregunta);
  if (!/\b(como|ensena|ensename|muestrame|guia|paso a paso|donde|recorrido|tour|explicame|ayudame a)\b/.test(t)) return null;
  return PATRONES.find(([re]) => re.test(t))?.[1] ?? null;
}
