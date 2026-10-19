import type { Database } from '../db/index.js';
import { config } from '../config.js';
import { normalizeText } from '../lib/util.js';

/**
 * Asistente del número de WhatsApp de Omnegia (WHATSAPP_PLATFORM_PHONE_NUMBER_ID).
 *
 * No es el agente de ningún comercio: atiende a quien le escribe a Omnegia (dueños, equipos y
 * personas interesadas). Es un gestor de diálogo con estado: recuerda el tema en curso, no repite el
 * saludo, distingue un primer contacto de una conversación que sigue, detecta la insistencia y deriva a
 * una persona cuando no puede resolver.
 *
 * Reglas de privacidad: conocer el teléfono NO es autenticar. El asistente nunca dice a qué comercios
 * está vinculado un número, ni el plan, el estado de la suscripción u otro dato de una cuenta. Lo que
 * explica sale de pantallas y comportamientos verificados en el código (ver TEXTOS) y la única acción
 * que ejecuta por su cuenta es la recuperación de contraseña, que responde igual exista o no la cuenta.
 *
 * `decidir` es una función pura: la persistencia, el envío y la derivación los hace
 * plataformaConversaciones.ts.
 */
export interface ComercioReconocido { id: string; nombre: string; slug: string; plan: string | null; suscripcion: string | null }

export const soloDigitos = (t: string) => String(t ?? '').replace(/\D/g, '');

/**
 * Comercios cuyo teléfono de contacto coincide con el número que escribe. Coincidencia exacta; solo si el
 * comercio guardó un número sin indicativo (10 dígitos o menos) se compara por la terminación.
 * Se usa para dar contexto al equipo de Omnegia, nunca para responderle a quien escribe.
 */
export async function reconocerTelefono(db: Database, telefono: string): Promise<ComercioReconocido[]> {
  const d = soloDigitos(telefono);
  if (d.length < 7) return [];
  const filas = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT t.id, t.nombre, t.slug, t.plan_codigo AS plan, s.estado AS suscripcion
       FROM tenant t LEFT JOIN subscription s ON s.tenant_id = t.id
      WHERE t.telefono IS NOT NULL AND (
            regexp_replace(t.telefono, '\\D', '', 'g') = $1
         OR (length(regexp_replace(t.telefono, '\\D', '', 'g')) BETWEEN 7 AND 10 AND $1 LIKE '%' || regexp_replace(t.telefono, '\\D', '', 'g')))
      ORDER BY t.creado_en`, [d])).rows);
  return filas as ComercioReconocido[];
}

// ---------------------------------------------------------------------------
// Análisis del mensaje
// ---------------------------------------------------------------------------
export type Tema = 'ACCESO' | 'SUSCRIPCION' | 'WHATSAPP' | 'PLANES' | 'FUNCIONES' | 'ALTA' | 'DATOS' | 'IA' | 'OTRO';
export type SubAcceso = 'CONTRASENA' | 'BLOQUEO' | 'CODIGO' | 'EMPRESA' | 'OTRO';

export interface Analisis {
  saludo: boolean;
  gracias: boolean;
  despedida: boolean;
  resuelto: boolean;
  si: boolean;
  no: boolean;
  humano: boolean;
  frustracion: boolean;
  /** Pide ayuda sin decir con qué («tengo un problema», «ayuda»). */
  ayudaGenerica: boolean;
  /** Es una pregunta concreta («¿tienen…?», «¿cómo…?»). */
  pregunta: boolean;
  tema: Tema | null;
  subAcceso: SubAcceso | null;
  correo: string | null;
  opcion: number | null;
  /** Quiere dictar su contraseña por aquí (se le advierte). */
  comparteClave: boolean;
}

const CORREO = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export function analizar(textoOriginal: string): Analisis {
  const t = normalizeText(textoOriginal ?? '').replace(/[¡!¿?.,;:()"'«»*_~]/g, ' ').replace(/\s+/g, ' ').trim();
  const palabras = t ? t.split(' ').length : 0;
  const corto = palabras <= 5;
  const correo = (textoOriginal ?? '').match(CORREO)?.[0]?.toLowerCase() ?? null;
  const opcionM = t.match(/^(?:opcion |la |el )?([1-5])$/);

  const subAcceso: SubAcceso | null =
    /(olvide|olvido|no recuerdo|perdi|cambiar|restablecer|recuperar|nueva) (mi |la )?(contrasena|clave)|contrasena (incorrecta|errada|mala|no sirve)|clave (incorrecta|errada)|correo o contrasena|usuario o contrasena|contrasena/.test(t) ? 'CONTRASENA'
      : /demasiados intentos|bloquead|bloqueo|me bloqueo|intentos fallidos/.test(t) ? 'BLOQUEO'
        : /codigo|no me llega (el )?(correo|mensaje)|no llega (el )?correo|verificacion/.test(t) ? 'CODIGO'
          : /no (veo|aparece|sale) (mi |la )?empresa|no encontramos eso|no tengo acceso|sin acceso|no existe (la |mi )?empresa|esta direccion no existe|me sacaron|quitaron (el )?acceso/.test(t) ? 'EMPRESA'
            : null;

  const acceso = !!subAcceso
    || /(no (puedo|logro|consigo|me deja) (entrar|ingresar|acceder|iniciar|loguear|abrir)|error (al|para) (entrar|ingresar|acceder|iniciar)|(acceder|entrar|ingresar) a (mi|la) cuenta|inicio de sesion|iniciar sesion|login|mi cuenta|no (entra|abre) (la cuenta|el panel)|recuperar (mi )?(cuenta|acceso))/.test(t);

  const tema: Tema | null = acceso ? 'ACCESO'
    : /(borrar|eliminar|suprimir|actualizar) (mis |los )?datos|habeas data|datos personales|tratamiento de datos/.test(t) ? 'DATOS'
      : /(suscripci|renovar|renovacion|pagar (el|mi) plan|cobro|cobraron|me cobr|reembolso|retracto|devolucion|mi pago|el pago|wompi|vencid|suspendid|comprobante)/.test(t) ? 'SUSCRIPCION'
        : /(whatsapp|phone number id|webhook|meta business|conectar (el |mi )?numero|vincular (el |mi )?numero)/.test(t) ? 'WHATSAPP'
          : /(el bot|la ia|asistente (de|del) (mi )?negocio|agente (de|del) (mi )?negocio|centro de ia|no responde (el|la) (bot|ia|asistente))/.test(t) ? 'IA'
            : /(crear (una |mi )?cuenta|registrarme|registro|quiero (empezar|contratar|probar|usar omnegia|el servicio|adquirir)|como (me registro|empiezo|contrato)|abrir (una )?cuenta)/.test(t) ? 'ALTA'
              : /(precio|precios|cuanto (cuesta|vale|cobran)|planes?|tarifa|costo|mensualidad)/.test(t) ? 'PLANES'
                : /(que (hace|es|ofrece|incluye|tiene) omnegia|para que sirve|sirve para|modulos?|funcion(es|alidades)|agenda|inventario|facturacion|catalogo|ventas|reportes?|comisiones|como funciona)/.test(t) ? 'FUNCIONES'
                  : null;

  return {
    saludo: /^(hola|holi|ola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|que tal|saludos|alo)\b/.test(t),
    gracias: /\b(gracias|muchas gracias|mil gracias|te agradezco|agradecid)/.test(t),
    despedida: /\b(chao|adios|hasta luego|hasta pronto|nos vemos|eso es todo|nada mas)\b/.test(t),
    resuelto: /\b(ya (pude|entre|ingrese|funciono|quedo|esta|lo solucione|se soluciono|me llego|llego)|funciono|solucionado|resuelto|perfecto ya|listo ya)\b/.test(t),
    si: corto && /^(si|sii+|claro|dale|ok|okay|okey|de acuerdo|por favor|porfa|correcto|exacto|afirmativo|bueno|vale|hagale|listo|si por favor|si gracias)\b/.test(t),
    no: corto && /^(no|nop|nope|negativo|todavia no|aun no|tampoco|no gracias|no me llego|no funciono|nada)\b/.test(t),
    humano: /\b(asesor|asesora|humano|una persona|persona real|alguien (real|del equipo|de soporte)|agente (real|humano)|hablar con (alguien|una persona|soporte|un asesor)|soporte tecnico|operador|llamar|llamada)\b/.test(t),
    frustracion: /(no me (ayudas|ayuda|sirve|sirves|entiendes|estas ayudando|has ayudado|resuelves)|no sirves|ya te dije|otra vez lo mismo|siempre lo mismo|lo mismo de antes|pesimo|terrible|no entiendes|nadie me (ayuda|responde)|me tienen cansad|que mal servicio|eres un robot|respuesta automatica|no me estas entendiendo)/.test(t),
    ayudaGenerica: !acceso && /\b(ayuda|ayudame|ayudenme|tengo un (problema|error|inconveniente)|necesito ayuda|me pueden ayudar|me puedes ayudar|falla|no funciona)\b/.test(t),
    pregunta: /[?¿]/.test(textoOriginal ?? '') || /^(que|como|cuando|donde|cual|cuales|cuanto|cuantos|por que|tienen|hay|puedo|se puede|ustedes)\b/.test(t),
    tema,
    subAcceso,
    correo,
    opcion: opcionM ? Number(opcionM[1]) : null,
    comparteClave: /\b(mi (contrasena|clave) es|la (contrasena|clave) es)\b/.test(t),
  };
}

// ---------------------------------------------------------------------------
// Estado del diálogo (vive en plataforma_conversacion.contexto; nunca guarda contenido)
// ---------------------------------------------------------------------------
export type Esperando = 'correo' | 'opcion_acceso' | 'detalle_acceso' | 'confirmar_enlace' | 'confirmar_resuelto' | 'confirmar_humano' | 'tema' | null;

export interface EstadoDialogo {
  /** Ya se presentó en este episodio. */
  saludado?: boolean;
  /** Ya avisó del tratamiento de datos (una vez por número). */
  aviso?: boolean;
  /** Ya conversó antes con este número (para saludar «de nuevo»). */
  visto?: boolean;
  tema?: Tema | null;
  sub?: SubAcceso | null;
  esperando?: Esperando;
  /** Respuestas en el tema actual sin que se resuelva. */
  intentos?: number;
  /** Veces que la persona dijo que una solución no le funcionó. */
  fallos?: number;
  /** Veces que la persona insistió o expresó molestia en este episodio. */
  insistencias?: number;
  /** Preguntas de aclaración seguidas sin tema. */
  aclaraciones?: number;
  /** Clave de la última respuesta: nunca se envía la misma dos veces seguidas. */
  ultima?: string | null;
  /** Normalización del último mensaje de la persona (detecta repeticiones). */
  ultimoTexto?: string | null;
  correoEnviado?: boolean;
  archivoAvisado?: boolean;
  /** Último aviso automático mientras espera a una persona. */
  avisoEsperaEn?: string | null;
}

export type Accion =
  | { tipo: 'recuperar_acceso'; correo: string }
  | { tipo: 'escalar'; categoria: CategoriaSoporte; prioridad: 'NORMAL' | 'ALTA'; motivo: string };

export type CategoriaSoporte = 'CUENTA' | 'FACTURACION' | 'WHATSAPP' | 'IA' | 'TECNICO' | 'OTRO';

export interface Decision {
  texto: string;
  /** Identifica la respuesta (metadatos y antirrepetición). */
  clave: string;
  estado: EstadoDialogo;
  accion?: Accion;
  intencion: string;
}

export interface EntradaDialogo {
  texto: string;
  tipo: 'TEXTO' | 'MEDIA' | 'NO_SOPORTADO';
  /** Nombre de perfil de WhatsApp (puede venir vacío). */
  nombre: string;
  estado: EstadoDialogo;
  /** El número coincide con el contacto de algún comercio (solo cambia el tono, nunca revela cuál). */
  conocido: boolean;
  /** Radicado abierto de este episodio, si ya se derivó. */
  radicado?: string | null;
}

// ---------------------------------------------------------------------------
// Textos verificados (cada afirmación corresponde a una pantalla o regla del código)
// ---------------------------------------------------------------------------
const url = () => config.publicUrl;
const primerNombre = (n: string) => {
  const p = (n ?? '').trim().split(/\s+/)[0] ?? '';
  return /^[\p{L}][\p{L}'-]{0,29}$/u.test(p) ? p.charAt(0).toUpperCase() + p.slice(1) : '';
};

export const RETENCION_DIAS_PLATAFORMA = 90;

export const TEXTOS = {
  aviso: () => `Guardamos esta conversación solo para atenderte y la eliminamos ${RETENCION_DIAS_PLATAFORMA} días después del último mensaje. Más detalles: ${url()}/privacidad`,
  menu: 'Puedo ayudarte a *recuperar el acceso* a tu cuenta, resolver dudas de *pagos y suscripción*, *conectar WhatsApp*, explicarte *qué incluye Omnegia* o pasarte con *una persona del equipo*. ¿Qué necesitas?',
  accesoOpciones: [
    'Entiendo: tienes un problema para entrar a tu cuenta. Para darte la solución correcta, dime qué te aparece (responde con el número):',
    '1. «Correo o contraseña incorrectos», u olvidaste tu contraseña',
    '2. «Demasiados intentos fallidos»',
    '3. No te llega un código al correo',
    '4. Entras, pero no ves tu empresa o dice «No encontramos eso»',
    '5. Otra cosa (cuéntamela con tus palabras)',
  ].join('\n'),
  pedirCorreo: 'Te ayudo a crear una contraseña nueva. Escríbeme el *correo con el que entras* a Omnegia y te envío un enlace seguro. Nunca te pediré tu contraseña.',
  pedirCorreoOtraVez: 'Necesito el correo con el que entras a Omnegia (por ejemplo, nombre@tuempresa.com) para enviarte el enlace.',
  enlaceEnviado: (correo: string) => `Listo. Si *${correo}* tiene una cuenta en Omnegia, en unos minutos te llega un correo con un enlace para crear una contraseña nueva. El enlace vence en 60 minutos y sirve una sola vez; revisa también spam o promociones.\n\nCuando la cambies, entra en ${url()}/entrar. ¿Pudiste entrar? Respóndeme *sí* o *no*.`,
  enlaceNoValido: 'Ese correo no parece válido. Escríbelo completo, por ejemplo nombre@tuempresa.com.',
  bloqueo: () => `Por seguridad, después de varios intentos fallidos el ingreso se bloquea durante ${config.login.ventanaMin} minutos. Puedes esperar ese tiempo e intentar de nuevo, o crear una contraseña nueva ahora mismo. ¿Quieres que te envíe el enlace? (*sí* / *no*)`,
  bloqueoEsperar: () => `De acuerdo. Pasados ${config.login.ventanaMin} minutos, entra de nuevo en ${url()}/entrar. ¿Pudiste entrar? (*sí* / *no*)`,
  codigo: () => `Los códigos llegan al correo de tu cuenta, vencen en ${config.correo.otpMinutos} minutos y puedes pedir uno nuevo cada minuto desde la misma pantalla. Revisa spam o promociones y que el correo esté bien escrito. ¿Ya te llegó? (*sí* / *no*)`,
  empresa: () => `Eso pasa cuando tu usuario ya no tiene acceso a esa empresa (por ejemplo, si cambiaron tu rol o retiraron tu acceso) o cuando la dirección de la empresa está mal escrita. Entra en ${url()}/entrar con tu correo: allí ves las empresas a las que tienes acceso. Si la tuya no aparece, pide a quien administra tu empresa que te invite de nuevo desde *Configuración › Equipo y comisiones*.\n\nSi la suscripción está suspendida, igual puedes entrar en modo de solo lectura. ¿Pudiste entrar? (*sí* / *no*)`,
  pedirDetalle: 'Cuéntame qué mensaje exacto ves en la pantalla (puedes copiarlo) y en qué paso aparece.',
  sinSolucion: 'No tengo una solución verificada para ese caso y prefiero no inventarte una. ¿Te paso con una persona del equipo de Omnegia? (*sí* / *no*)',
  noLlegoEnlace: 'El enlace puede tardar unos minutos; revisa spam o promociones. Por seguridad solo se envían 3 enlaces por hora. Si sigue sin llegar, una persona del equipo puede revisarlo contigo. ¿Te paso con ella? (*sí* / *no*)',
  noResuelto: 'Lamento que no haya funcionado. Una persona del equipo puede revisarlo contigo. ¿Te paso con ella? (*sí* / *no*)',
  resuelto: '¡Qué bien que ya quedó! Si necesitas algo más, escríbeme por aquí.',
  noGracias: 'De acuerdo. Si más adelante quieres hablar con una persona, escribe *asesor*.',
  gracias: '¡Con gusto! Si necesitas algo más, escríbeme por aquí.',
  despedida: '¡Hasta pronto! Aquí estaré si necesitas algo.',
  noClave: 'Por seguridad, no compartas tu contraseña por este chat: nadie de Omnegia te la pedirá. Si la olvidaste, te envío un enlace para crear una nueva.',
  archivo: 'Por este chat todavía no puedo ver imágenes, audios ni documentos. ¿Me cuentas por escrito qué necesitas?',
  suscripcion: () => [
    'Sobre pagos y suscripción:',
    '• En tu panel, en *Suscripción*, ves tu plan, el periodo y el estado, y puedes pagar o renovar con Wompi. No hay cobros automáticos.',
    '• Si la suscripción está suspendida, tu equipo puede entrar en modo de solo lectura y exportar; al pagar se reactiva.',
    '• Los comprobantes de tus pagos están en *Suscripción › Documentos de tus pagos*.',
    `• Para un retracto o una devolución: ${url()}/consumidor#reembolso`,
    'Por seguridad, por este chat no consulto datos de tu cuenta. ¿Quieres que una persona del equipo lo revise contigo? (*sí* / *no*)',
  ].join('\n'),
  whatsapp: [
    'Para conectar el WhatsApp de tu negocio:',
    '1. En tu panel, entra a *Configuración › WhatsApp*.',
    '2. Escribe el identificador del número (*Phone number ID*) que Meta muestra junto a tu número; no es el número de teléfono.',
    '3. Pulsa *Probar conexión*: te dice si Meta responde o qué falta.',
    'En esa misma pantalla están la URL del webhook y las plantillas de mensajes. Si algo no funciona, escribe *asesor* y te paso con el equipo.',
  ].join('\n'),
  ia: 'Si el asistente de tu negocio no responde a tus clientes, revisa tres cosas en tu panel: en *Centro de IA*, que el asistente de atención esté activo; en *Suscripción*, el consumo de IA del mes (al agotarse, las conversaciones pasan a tu equipo); y en *Conversaciones*, si una persona tomó el chat: la IA no contesta hasta que lo devuelvas con *Devolver a la IA*. ¿Te paso con una persona para revisarlo? (*sí* / *no*)',
  planes: () => `Los planes, los módulos y sus precios están en ${url()}/planes. El valor exacto de tu configuración lo ves antes de pagar, al crear tu espacio en ${url()}/empezar. No hay cobros automáticos: cada periodo se paga de forma explícita. ¿Quieres saber qué incluye algún módulo?`,
  funciones: () => `Omnegia reúne en un solo panel la atención por WhatsApp con un asistente de IA (y paso a una persona con radicado), clientes, catálogo, agenda, ventas y cobros, inventario, comisiones del equipo y permisos por rol. Cada negocio elige sus módulos. La facturación electrónica requiere conectar un proveedor autorizado por la DIAN (hoy solo existe el entorno de pruebas, sin validez fiscal). Más detalle en ${url()}/producto. ¿Sobre qué parte quieres saber más?`,
  alta: () => `Para crear tu espacio entra en ${url()}/empezar: describes tu negocio, eliges los módulos, revisas el valor y pagas; al confirmarse el pago se crea tu panel. Si tienes dudas antes de empezar, cuéntame cuáles.`,
  datos: () => `Puedes consultar, corregir o pedir que eliminemos tus datos en ${url()}/eliminacion-de-datos. Nuestra política de tratamiento de datos está en ${url()}/privacidad.`,
  noSe: 'No tengo información verificada sobre eso y prefiero no inventarte una respuesta. ¿Te paso con una persona del equipo de Omnegia? (*sí* / *no*)',
  aclarar: 'Cuéntame con un poco más de detalle qué pasa o qué necesitas.',
  escalada: (radicado: string) => `Te paso con una persona del equipo de Omnegia. Tu radicado es *${radicado}*: con él puedes hacer seguimiento. Te escribirán por este mismo chat y no tendrás que repetir lo que ya me contaste.`,
  esperaPersona: (radicado: string | null | undefined) => `${radicado ? `Tu solicitud *${radicado}* sigue abierta` : 'Tu solicitud sigue abierta'} y el equipo ya tiene tu mensaje. Te responderán por este mismo chat.`,
  reconocerMolestia: 'Entiendo tu molestia y quiero resolverlo contigo.',
  insistir: 'Entiendo que necesitas una solución. Vamos paso a paso.',
};

const CATEGORIA: Record<Tema, CategoriaSoporte> = {
  ACCESO: 'CUENTA', SUSCRIPCION: 'FACTURACION', WHATSAPP: 'WHATSAPP', IA: 'IA', PLANES: 'OTRO', FUNCIONES: 'OTRO', ALTA: 'OTRO', DATOS: 'OTRO', OTRO: 'OTRO',
};
export const ASUNTO_TEMA: Record<Tema, string> = {
  ACCESO: 'Problema de acceso a la cuenta', SUSCRIPCION: 'Pagos y suscripción', WHATSAPP: 'Conexión de WhatsApp', IA: 'Asistente de IA del negocio',
  PLANES: 'Planes y precios', FUNCIONES: 'Información del producto', ALTA: 'Crear una cuenta', DATOS: 'Datos personales', OTRO: 'Solicitud general',
};

// ---------------------------------------------------------------------------
// Decisión
// ---------------------------------------------------------------------------
const MAX_ACLARACIONES = 1;

/** Saludo solo cuando corresponde: primer mensaje del episodio. */
function encabezado(e: EntradaDialogo, estado: EstadoDialogo): string[] {
  if (estado.saludado) return [];
  const nombre = primerNombre(e.nombre);
  const hola = `${estado.visto ? 'Hola de nuevo' : 'Hola'}${nombre ? `, ${nombre}` : ''}.`;
  return [estado.visto ? hola : `${hola} Soy el asistente virtual de Omnegia.`];
}

function pie(estado: EstadoDialogo): string[] {
  return estado.aviso ? [] : [TEXTOS.aviso()];
}

function escalar(estado: EstadoDialogo, tema: Tema | null | undefined, motivo: string, alta: boolean, intencion: string): Decision {
  const t = tema ?? 'OTRO';
  return {
    // El texto final con el radicado lo completa quien ejecuta la derivación.
    texto: '', clave: 'escalar', intencion,
    estado: { ...estado, esperando: null, intentos: 0 },
    accion: { tipo: 'escalar', categoria: CATEGORIA[t], prioridad: alta ? 'ALTA' : 'NORMAL', motivo },
  };
}

/** Respuesta del tema; cada paso tiene su clave para no repetirse. */
function responderTema(tema: Tema, a: Analisis, estado: EstadoDialogo): { texto: string; clave: string; estado: EstadoDialogo } {
  const base = { ...estado, tema, aclaraciones: 0 };
  switch (tema) {
    case 'ACCESO': {
      const sub = a.subAcceso ?? (a.opcion ? (['CONTRASENA', 'BLOQUEO', 'CODIGO', 'EMPRESA', 'OTRO'] as SubAcceso[])[a.opcion - 1] : null);
      return pasoAcceso(sub, base);
    }
    case 'SUSCRIPCION': return { texto: TEXTOS.suscripcion(), clave: 'suscripcion', estado: { ...base, esperando: 'confirmar_humano' } };
    case 'WHATSAPP': return { texto: TEXTOS.whatsapp, clave: 'whatsapp', estado: { ...base, esperando: null } };
    case 'IA': return { texto: TEXTOS.ia, clave: 'ia', estado: { ...base, esperando: 'confirmar_humano' } };
    case 'PLANES': return { texto: TEXTOS.planes(), clave: 'planes', estado: { ...base, esperando: null } };
    case 'FUNCIONES': return { texto: TEXTOS.funciones(), clave: 'funciones', estado: { ...base, esperando: null } };
    case 'ALTA': return { texto: TEXTOS.alta(), clave: 'alta', estado: { ...base, esperando: null } };
    case 'DATOS': return { texto: TEXTOS.datos(), clave: 'datos', estado: { ...base, esperando: null } };
    default: return { texto: TEXTOS.noSe, clave: 'no_se', estado: { ...base, esperando: 'confirmar_humano' } };
  }
}

function pasoAcceso(sub: SubAcceso | null, estado: EstadoDialogo): { texto: string; clave: string; estado: EstadoDialogo } {
  const e = { ...estado, tema: 'ACCESO' as Tema, sub };
  switch (sub) {
    case 'CONTRASENA': return { texto: TEXTOS.pedirCorreo, clave: 'acceso_pedir_correo', estado: { ...e, esperando: 'correo' } };
    case 'BLOQUEO': return { texto: TEXTOS.bloqueo(), clave: 'acceso_bloqueo', estado: { ...e, esperando: 'confirmar_enlace' } };
    case 'CODIGO': return { texto: TEXTOS.codigo(), clave: 'acceso_codigo', estado: { ...e, esperando: 'confirmar_resuelto' } };
    case 'EMPRESA': return { texto: TEXTOS.empresa(), clave: 'acceso_empresa', estado: { ...e, esperando: 'confirmar_resuelto' } };
    case 'OTRO': return { texto: TEXTOS.pedirDetalle, clave: 'acceso_detalle', estado: { ...e, esperando: 'detalle_acceso' } };
    default: return { texto: TEXTOS.accesoOpciones, clave: 'acceso_opciones', estado: { ...e, esperando: 'opcion_acceso' } };
  }
}

/**
 * Decide la respuesta a un mensaje. Orden: seguridad (contraseñas), petición explícita de una persona,
 * molestia o insistencia, lo que el asistente estaba esperando, un tema nuevo, cortesías y aclaración.
 */
/** Respuestas que pueden repetirse sin que signifique que la conversación se atascó. */
const REPETIBLES = new Set(['enlace_reenviado', 'gracias', 'despedida', 'resuelto', 'archivo', 'no_quiere_persona', 'no_quiere_enlace']);

export function decidir(e: EntradaDialogo): Decision {
  const a = analizar(e.texto);
  const previo: EstadoDialogo = { ...e.estado };
  const normal = normalizeText(e.texto).replace(/[¡!¿?.,;:]/g, '').replace(/\s+/g, ' ').trim();
  // Repetir lo mismo es insistencia; una confirmación corta («sí», «no», «1») no lo es.
  const repetido = !!previo.ultimoTexto && normal === previo.ultimoTexto && !a.si && !a.no && !a.opcion && normal.length >= 8;
  const cabeza = encabezado(e, previo);
  const estado: EstadoDialogo = { ...previo, saludado: true, visto: true, ultimoTexto: normal.slice(0, 200) };
  const armar = (cuerpo: string, clave: string, nuevo: EstadoDialogo, intencion: string, accion?: Accion): Decision => {
    // Nunca la misma respuesta dos veces seguidas: si iba a repetirse, se ofrece una persona.
    if (clave === previo.ultima && !REPETIBLES.has(clave)) {
      return {
        texto: [...cabeza, `${TEXTOS.reconocerMolestia} Parece que mi respuesta anterior no te sirvió. ¿Te paso con una persona del equipo? (*sí* / *no*)`].join('\n\n'),
        clave: 'ofrecer_persona_por_repeticion', intencion,
        estado: { ...nuevo, ultima: 'ofrecer_persona_por_repeticion', esperando: 'confirmar_humano', insistencias: (nuevo.insistencias ?? 0) + 1, aviso: true },
      };
    }
    return { texto: [...cabeza, cuerpo, ...pie(previo)].filter(Boolean).join('\n\n'), clave, estado: { ...nuevo, ultima: clave, aviso: true }, intencion, accion };
  };

  // Archivos: no se procesan; se avisa una vez por episodio.
  if (e.tipo !== 'TEXTO') {
    if (previo.archivoAvisado) return { texto: '', clave: 'silencio_archivo', estado, intencion: 'archivo' };
    return armar(TEXTOS.archivo, 'archivo', { ...estado, archivoAvisado: true }, 'archivo');
  }

  // 1. Nunca se reciben contraseñas.
  if (a.comparteClave) return armar(TEXTOS.noClave, 'no_clave', { ...estado, tema: 'ACCESO', sub: 'CONTRASENA', esperando: 'confirmar_enlace' }, 'seguridad');

  // 2. Petición explícita de una persona: se respeta sin pedir explicaciones.
  if (a.humano) return conCabeza(escalar(estado, previo.tema ?? a.tema, 'La persona pidió hablar con alguien del equipo.', false, 'pide_persona'), cabeza);

  // 3. Molestia o insistencia: se reconoce y se cambia de estrategia; a la segunda, se deriva.
  //    Volver a pedir ayuda sin más detalle cuando ya hay un tema en curso también es insistir.
  const insiste = a.frustracion || repetido || (a.ayudaGenerica && !!previo.tema && !a.tema && !a.opcion);
  const insistencias = (previo.insistencias ?? 0) + (insiste ? 1 : 0);
  if (insiste) {
    const tema = previo.tema ?? a.tema;
    // A la segunda insistencia, o ante una queja cuando ya se intentó una solución, se deriva con prioridad.
    if (insistencias >= 2 || (a.frustracion && tema && (previo.intentos ?? 0) >= 1)) {
      return conCabeza(escalar({ ...estado, insistencias }, tema, `La persona insistió o expresó molestia (${insistencias} ${insistencias === 1 ? 'vez' : 'veces'}) sin que el asistente resolviera.`, true, 'insistencia'), cabeza);
    }
    const intro = a.frustracion ? TEXTOS.reconocerMolestia : TEXTOS.insistir;
    const siguiente = tema ? responderTema(tema, a, { ...estado, insistencias }) : null;
    const cuerpo = siguiente
      ? `${intro}\n\n${siguiente.texto}\n\nSi prefieres, escribe *asesor* y te paso con una persona.`
      : `${intro} ${TEXTOS.menu}\nSi prefieres, escribe *asesor* y te paso con una persona.`;
    return armar(cuerpo, siguiente ? `${siguiente.clave}_tras_insistencia` : 'insistencia_menu', { ...(siguiente?.estado ?? { ...estado, esperando: 'tema' }), insistencias, intentos: (previo.intentos ?? 0) + 1 }, a.frustracion ? 'molestia' : 'insistencia');
  }

  // 4. Lo que el asistente estaba esperando.
  switch (previo.esperando) {
    case 'correo': {
      if (a.correo) {
        return armar(TEXTOS.enlaceEnviado(a.correo), previo.correoEnviado ? 'enlace_reenviado' : 'enlace_enviado',
          { ...estado, esperando: 'confirmar_resuelto', correoEnviado: true, intentos: (previo.intentos ?? 0) + 1 }, 'recuperar_acceso', { tipo: 'recuperar_acceso', correo: a.correo });
      }
      if (/@/.test(e.texto)) return armar(TEXTOS.enlaceNoValido, 'correo_no_valido', { ...estado }, 'recuperar_acceso');
      if (/no (se|recuerdo|tengo|me acuerdo)\b/.test(normal)) {
        return armar('Si no recuerdas el correo de tu cuenta, una persona del equipo puede ayudarte a identificarla. ¿Te paso con ella? (*sí* / *no*)', 'sin_correo', { ...estado, esperando: 'confirmar_humano' }, 'recuperar_acceso');
      }
      if (a.no) return armar(TEXTOS.noGracias, 'no_quiere_enlace', { ...estado, esperando: null }, 'rechaza');
      if (!a.tema && !a.saludo) return armar(TEXTOS.pedirCorreoOtraVez, 'pedir_correo_otra_vez', { ...estado, intentos: (previo.intentos ?? 0) + 1 }, 'recuperar_acceso');
      break;
    }
    case 'opcion_acceso': {
      if (a.opcion || a.subAcceso) {
        const p = responderTema('ACCESO', a, estado);
        return armar(p.texto, p.clave, { ...p.estado, intentos: (previo.intentos ?? 0) + 1 }, 'acceso');
      }
      if (!a.tema && !a.saludo && !a.gracias && !a.si && !a.no) {
        // Lo contó con sus palabras: se trata como «otra cosa».
        return armar(TEXTOS.sinSolucion, 'acceso_sin_solucion', { ...estado, sub: 'OTRO', esperando: 'confirmar_humano', intentos: (previo.intentos ?? 0) + 1 }, 'acceso');
      }
      break;
    }
    case 'detalle_acceso': {
      if (a.subAcceso) {
        const p = pasoAcceso(a.subAcceso, estado);
        return armar(p.texto, p.clave, { ...p.estado, intentos: (previo.intentos ?? 0) + 1 }, 'acceso');
      }
      if (!a.tema && !a.si && !a.no) return armar(TEXTOS.sinSolucion, 'acceso_sin_solucion', { ...estado, esperando: 'confirmar_humano', intentos: (previo.intentos ?? 0) + 1 }, 'acceso');
      break;
    }
    case 'confirmar_enlace': {
      if (a.si) return armar(TEXTOS.pedirCorreo, 'acceso_pedir_correo', { ...estado, sub: 'CONTRASENA', esperando: 'correo' }, 'acceso');
      if (a.no) return armar(TEXTOS.bloqueoEsperar(), 'acceso_esperar', { ...estado, esperando: 'confirmar_resuelto' }, 'acceso');
      if (a.correo) {
        return armar(TEXTOS.enlaceEnviado(a.correo), 'enlace_enviado', { ...estado, sub: 'CONTRASENA', esperando: 'confirmar_resuelto', correoEnviado: true }, 'recuperar_acceso', { tipo: 'recuperar_acceso', correo: a.correo });
      }
      break;
    }
    case 'confirmar_resuelto': {
      if (a.si || a.resuelto || a.gracias) return armar(TEXTOS.resuelto, 'resuelto', { ...estado, tema: null, sub: null, esperando: null, intentos: 0, insistencias: 0, fallos: 0 }, 'resuelto');
      if (a.no) {
        const fallos = (previo.fallos ?? 0) + 1;
        // Segunda vez que una solución no funciona: se deriva sin preguntar más.
        if (fallos >= 2) return conCabeza(escalar({ ...estado, fallos }, previo.tema, 'Las soluciones del asistente no funcionaron.', false, 'no_resuelto'), cabeza);
        return armar(previo.correoEnviado ? TEXTOS.noLlegoEnlace : TEXTOS.noResuelto, previo.correoEnviado ? 'no_llego_enlace' : 'no_resuelto',
          { ...estado, esperando: 'confirmar_humano', fallos, intentos: (previo.intentos ?? 0) + 1 }, 'no_resuelto');
      }
      break;
    }
    case 'confirmar_humano': {
      if (a.si) return conCabeza(escalar(estado, previo.tema, 'La persona aceptó que la atienda alguien del equipo.', false, 'acepta_persona'), cabeza);
      if (a.no) return armar(TEXTOS.noGracias, 'no_quiere_persona', { ...estado, esperando: null }, 'rechaza');
      break;
    }
  }

  // 5. Un tema (nuevo o el mismo con más detalle).
  if (a.tema) {
    const mismo = a.tema === previo.tema;
    const p = responderTema(a.tema, a, { ...estado, intentos: mismo ? (previo.intentos ?? 0) : 0 });
    return armar(p.texto, p.clave, { ...p.estado, intentos: (mismo ? (previo.intentos ?? 0) : 0) + 1 }, a.tema.toLowerCase());
  }

  // 6. Cortesías.
  if (a.resuelto && previo.tema) return armar(TEXTOS.resuelto, 'resuelto', { ...estado, tema: null, sub: null, esperando: null, intentos: 0 }, 'resuelto');
  if (a.gracias) return armar(TEXTOS.gracias, 'gracias', { ...estado, esperando: null }, 'gracias');
  if (a.despedida) return armar(TEXTOS.despedida, 'despedida', { ...estado, esperando: null }, 'despedida');
  if (a.saludo && !a.ayudaGenerica) {
    if (!previo.saludado) return armar(TEXTOS.menu, 'menu', { ...estado, esperando: 'tema' }, 'saludo');
    // Ya saludó: no se presenta de nuevo; retoma lo pendiente.
    const retoma = previo.tema && previo.esperando ? `Sigo aquí. ${resumenPendiente(previo)}` : `Sigo aquí. ${TEXTOS.menu}`;
    return armar(retoma, previo.tema ? `retomar_${previo.tema}` : 'saludo_repetido', { ...estado }, 'saludo');
  }

  // 7. Una pregunta concreta que no cubre la información verificada: no se inventa la respuesta.
  if (a.pregunta && !a.ayudaGenerica && !a.saludo) {
    return armar(TEXTOS.noSe, 'no_se', { ...estado, esperando: 'confirmar_humano' }, 'sin_informacion');
  }

  // 8. Sin tema claro: una aclaración y, si sigue sin entenderse, una persona.
  const aclaraciones = (previo.aclaraciones ?? 0) + 1;
  if (aclaraciones > MAX_ACLARACIONES + (a.ayudaGenerica ? 1 : 0)) {
    return armar(TEXTOS.noSe, 'no_se', { ...estado, aclaraciones, esperando: 'confirmar_humano' }, 'ambiguo');
  }
  const cuerpo = a.ayudaGenerica ? `Claro, te ayudo. ${TEXTOS.menu}` : previo.saludado ? TEXTOS.aclarar : TEXTOS.menu;
  return armar(cuerpo, a.ayudaGenerica ? 'ayuda_menu' : previo.saludado ? 'aclarar' : 'menu', { ...estado, aclaraciones, esperando: 'tema' }, 'ambiguo');
}

/** La derivación también lleva el saludo si es el primer mensaje del episodio. */
function conCabeza(d: Decision, cabeza: string[]): Decision {
  return { ...d, texto: cabeza.join('\n\n') };
}

function resumenPendiente(e: EstadoDialogo): string {
  switch (e.esperando) {
    case 'correo': return TEXTOS.pedirCorreoOtraVez;
    case 'opcion_acceso': return 'Dime qué te aparece al intentar entrar (responde con un número del 1 al 5).';
    case 'confirmar_resuelto': return '¿Pudiste resolverlo? (*sí* / *no*)';
    case 'confirmar_humano': return '¿Te paso con una persona del equipo? (*sí* / *no*)';
    case 'confirmar_enlace': return '¿Quieres que te envíe el enlace para crear una contraseña nueva? (*sí* / *no*)';
    default: return TEXTOS.menu;
  }
}

/** Texto final de una derivación: saludo (si toca) + radicado. */
export function textoDerivacion(d: Decision, radicado: string, avisoPendiente: boolean): string {
  return [d.texto, TEXTOS.escalada(radicado), avisoPendiente ? TEXTOS.aviso() : ''].filter(Boolean).join('\n\n');
}
