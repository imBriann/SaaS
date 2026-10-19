import { config } from '../config.js';
import { MARCA } from '../brand.js';

/**
 * Plantillas de correo. Cada función devuelve asunto, HTML y texto plano.
 *
 * Diseño compatible con clientes de correo: tablas, estilos en línea, ancho máximo
 * de 600 px, sin fuentes ni scripts externos. El logotipo es el icono real de la
 * marca (web/public/marca/icono-192.png) servido desde APP_PUBLIC_URL; si la URL no
 * es https (desarrollo) se usa un monograma en texto. Todo dato dinámico se escapa.
 * El asunto nunca contiene códigos ni enlaces.
 */
export interface CorreoRenderizado { tipo: string; asunto: string; html: string; texto: string }

const C = {
  primario: MARCA.colorPrimario,
  primarioOscuro: '#2E2391',
  tinta: '#0F172A',
  texto: '#334155',
  tenue: '#64748B',
  borde: '#E2E8F0',
  fondo: '#F4F3FB',
  suave: '#F1EFFE',
  bordeSuave: '#DCD7FD',
};
const FUENTE = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const sinSaltos = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** Solo se enlaza a la propia plataforma o a https. Cualquier otra URL se descarta. */
export function urlSegura(url: string): string | null {
  try {
    const u = new URL(url);
    const propias = [config.publicUrl, config.apiPublicUrl].map((x) => new URL(x).origin);
    if (propias.includes(u.origin) || u.protocol === 'https:') return u.toString();
  } catch { /* URL inválida */ }
  return null;
}

const primerNombre = (n?: string | null) => (n ?? '').trim().split(/\s+/)[0] || '';

interface Bloques {
  tipo: string;
  asunto: string;
  /** Texto de vista previa en la bandeja (oculto en el cuerpo). */
  previa: string;
  titulo: string;
  saludo?: string;
  parrafos: string[];
  codigo?: { valor: string; minutos: number };
  boton?: { texto: string; url: string };
  detalles?: [string, string][];
  /** Qué hacer si la persona no pidió esta acción. */
  noFuiste?: string;
  /** Empresa en cuyo nombre se envía (contexto de tenant). */
  empresa?: string | null;
}

function cabecera(): string {
  const logo = config.publicUrl.startsWith('https://')
    ? `<img src="${esc(config.publicUrl)}/marca/icono-192.png" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px">`
    : `<div style="width:36px;height:36px;line-height:36px;border-radius:9px;background:${C.primario};color:#ffffff;font-weight:700;font-size:18px;text-align:center;font-family:${FUENTE}">${esc(MARCA.nombre.slice(0, 1))}</div>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:10px;vertical-align:middle">${logo}</td>
<td style="vertical-align:middle;font-family:${FUENTE};font-size:20px;font-weight:700;color:${C.tinta};letter-spacing:-0.2px">${esc(MARCA.nombre)}</td>
</tr></table>`;
}

function boton(texto: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px"><tr>
<td bgcolor="${C.primario}" style="border-radius:10px;background:${C.primario}">
<a href="${esc(url)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 26px;font-family:${FUENTE};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px">${esc(texto)}</a>
</td></tr></table>`;
}

function render(b: Bloques): CorreoRenderizado {
  const url = b.boton ? urlSegura(b.boton.url) : null;
  const soporte = config.correo.responderA || config.correo.buzonSoporte;
  const firma = b.empresa ? `Enviado por ${b.empresa} con ${MARCA.nombre}.` : `${MARCA.nombre} · ${MARCA.lema}`;
  const p = (t: string) => `<p style="margin:0 0 14px;font-family:${FUENTE};font-size:15px;line-height:1.6;color:${C.texto}">${esc(t)}</p>`;

  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(b.asunto)}</title></head>
<body style="margin:0;padding:0;background:${C.fondo};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(b.previa)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.fondo}" style="background:${C.fondo}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px">
<tr><td style="padding:0 8px 18px">${cabecera()}</td></tr>
<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid ${C.borde};border-radius:16px;overflow:hidden">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td height="4" bgcolor="${C.primario}" style="height:4px;line-height:4px;font-size:0;background:${C.primario}">&nbsp;</td></tr>
<tr><td style="padding:30px 32px 8px">
<h1 style="margin:0 0 16px;font-family:${FUENTE};font-size:22px;line-height:1.3;font-weight:700;color:${C.tinta}">${esc(b.titulo)}</h1>
${b.saludo ? p(b.saludo) : ''}
${b.parrafos.map(p).join('\n')}
${b.codigo ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px"><tr>
<td align="center" bgcolor="${C.suave}" style="background:${C.suave};border:1px solid ${C.bordeSuave};border-radius:14px;padding:22px 12px">
<div style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;font-size:36px;line-height:1;font-weight:700;letter-spacing:10px;color:${C.primarioOscuro};padding-left:10px">${esc(b.codigo.valor)}</div>
<div style="margin-top:12px;font-family:${FUENTE};font-size:13px;color:${C.tenue}">Vence en ${b.codigo.minutos} minutos · Úsalo una sola vez</div>
</td></tr></table>` : ''}
${url && b.boton ? `${boton(b.boton.texto, url)}
<p style="margin:12px 0 18px;font-family:${FUENTE};font-size:12px;line-height:1.5;color:${C.tenue};word-break:break-all">Si el botón no funciona, copia y pega este enlace en tu navegador:<br><a href="${esc(url)}" style="color:${C.primario}">${esc(url)}</a></p>` : ''}
${b.detalles?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px;border-top:1px solid ${C.borde}">
${b.detalles.map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.borde};font-family:${FUENTE};font-size:13px;color:${C.tenue};width:42%">${esc(k)}</td><td style="padding:10px 0;border-bottom:1px solid ${C.borde};font-family:${FUENTE};font-size:14px;color:${C.tinta};font-weight:600">${esc(v)}</td></tr>`).join('\n')}
</table>` : ''}
</td></tr>
${b.noFuiste ? `<tr><td style="padding:0 32px 26px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#F8FAFC" style="background:#F8FAFC;border-radius:10px;padding:14px 16px;font-family:${FUENTE};font-size:13px;line-height:1.55;color:${C.tenue}"><strong style="color:${C.texto}">¿No fuiste tú?</strong> ${esc(b.noFuiste)}</td>
</tr></table></td></tr>` : '<tr><td style="padding:0 0 12px"></td></tr>'}
</table></td></tr>
<tr><td style="padding:20px 12px 8px;font-family:${FUENTE};font-size:12px;line-height:1.6;color:${C.tenue};text-align:center">
${esc(firma)}<br>
${soporte ? `¿Dudas? Responde a este correo o escríbenos a <a href="mailto:${esc(soporte)}" style="color:${C.primario};text-decoration:none">${esc(soporte)}</a>.<br>` : ''}
Este es un mensaje automático sobre tu cuenta. Nunca te pediremos tu contraseña ni tus códigos.
</td></tr>
</table></td></tr></table></body></html>`;

  const texto = [
    MARCA.nombre.toUpperCase(),
    '',
    b.titulo,
    '',
    ...(b.saludo ? [b.saludo, ''] : []),
    ...b.parrafos.flatMap((x) => [x, '']),
    ...(b.codigo ? [`Tu código: ${b.codigo.valor}`, `Vence en ${b.codigo.minutos} minutos y solo sirve una vez.`, ''] : []),
    ...(url && b.boton ? [`${b.boton.texto}: ${url}`, ''] : []),
    ...(b.detalles?.length ? [...b.detalles.map(([k, v]) => `${k}: ${v}`), ''] : []),
    ...(b.noFuiste ? [`¿No fuiste tú? ${b.noFuiste}`, ''] : []),
    '—',
    firma,
    ...(soporte ? [`¿Dudas? Responde a este correo o escribe a ${soporte}.`] : []),
    'Nunca te pediremos tu contraseña ni tus códigos.',
  ].join('\n');

  return { tipo: b.tipo, asunto: sinSaltos(b.asunto).slice(0, 200), html, texto };
}

const NO_FUISTE_CODIGO = 'Ignora este mensaje: sin el código nadie puede continuar. Si recibes varios que no pediste, cambia tu contraseña y avísanos respondiendo a este correo.';

// ------------------------------------------------------------------ autenticación y seguridad
export const codigoVerificacion = (o: { nombre: string; codigo: string; minutos: number }) => render({
  tipo: 'verificacion_correo', asunto: `Confirma tu correo en ${MARCA.nombre}`,
  previa: 'Tu código para confirmar tu correo.', titulo: 'Confirma tu correo',
  saludo: `Hola ${primerNombre(o.nombre)},`, parrafos: ['Escribe este código en el panel para confirmar que este correo es tuyo.'],
  codigo: { valor: o.codigo, minutos: o.minutos }, noFuiste: NO_FUISTE_CODIGO,
});

export const codigoAcceso = (o: { nombre: string; codigo: string; minutos: number }) => render({
  tipo: 'codigo_acceso', asunto: `Tu código de acceso a ${MARCA.nombre}`,
  previa: 'Código de verificación para terminar de iniciar sesión.', titulo: 'Termina de iniciar sesión',
  saludo: `Hola ${primerNombre(o.nombre)},`, parrafos: ['Tu cuenta tiene acceso a la administración de la plataforma, así que pedimos un segundo paso. Escribe este código en la pantalla de inicio de sesión.'],
  codigo: { valor: o.codigo, minutos: o.minutos },
  noFuiste: 'Alguien escribió tu contraseña correctamente. Cámbiala de inmediato desde «¿Olvidaste tu contraseña?» y avísanos respondiendo a este correo.',
});

export const recuperarContrasena = (o: { nombre: string; url: string; minutos: number }) => render({
  tipo: 'recuperar_contrasena', asunto: `Restablece tu contraseña de ${MARCA.nombre}`,
  previa: 'Enlace para crear una contraseña nueva.', titulo: 'Restablece tu contraseña',
  saludo: `Hola ${primerNombre(o.nombre)},`, parrafos: [`Recibimos una solicitud para restablecer tu contraseña. El enlace vence en ${o.minutos} minutos y solo sirve una vez.`],
  boton: { texto: 'Crear una contraseña nueva', url: o.url },
  noFuiste: 'Ignora este correo: tu contraseña no cambia mientras no uses el enlace.',
});

export const contrasenaCambiada = (o: { nombre: string; urlRecuperar: string; cuando: string }) => render({
  tipo: 'contrasena_cambiada', asunto: `Tu contraseña de ${MARCA.nombre} cambió`,
  previa: 'Confirmación de cambio de contraseña.', titulo: 'Tu contraseña cambió',
  saludo: `Hola ${primerNombre(o.nombre)},`, parrafos: ['La contraseña de tu cuenta se cambió correctamente. Por seguridad, cerramos las demás sesiones abiertas.'],
  detalles: [['Fecha', o.cuando]],
  boton: { texto: 'Recuperar mi cuenta', url: o.urlRecuperar },
  noFuiste: 'Recupera tu cuenta ahora con el botón de arriba y responde a este correo para que revisemos el acceso.',
});

export const avisoSeguridad = (o: { nombre: string; motivo: 'intentos_fallidos' | 'sesiones_cerradas'; minutos?: number; urlRecuperar: string }) => render({
  tipo: `aviso_${o.motivo}`,
  asunto: o.motivo === 'intentos_fallidos' ? 'Bloqueamos intentos de acceso a tu cuenta' : 'Cerraste la sesión en todos tus dispositivos',
  previa: 'Aviso de seguridad de tu cuenta.',
  titulo: o.motivo === 'intentos_fallidos' ? 'Bloqueamos intentos de acceso' : 'Sesiones cerradas',
  saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: o.motivo === 'intentos_fallidos'
    ? [`Hubo varios intentos fallidos de iniciar sesión con tu correo. Pausamos el acceso durante ${o.minutos ?? 15} minutos para protegerte.`, 'Si fuiste tú y no recuerdas la contraseña, puedes restablecerla.']
    : ['Se cerró la sesión de tu cuenta en todos los dispositivos. Tendrás que volver a entrar con tu contraseña.'],
  boton: { texto: 'Restablecer mi contraseña', url: o.urlRecuperar },
  noFuiste: o.motivo === 'intentos_fallidos' ? 'Tu contraseña sigue a salvo mientras nadie la conozca. Si usas la misma en otros sitios, cámbiala.' : 'Restablece tu contraseña de inmediato y responde a este correo.',
});

// ------------------------------------------------------------------ gestión del SaaS
export const bienvenida = (o: { nombre: string; empresa: string; urlPanel: string }) => render({
  tipo: 'bienvenida', asunto: `Bienvenido a ${MARCA.nombre}: ${o.empresa} ya tiene su espacio`,
  previa: 'Tu espacio está listo. Estos son los primeros pasos.', titulo: `${o.empresa} ya está en ${MARCA.nombre}`,
  saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: ['Tu espacio está listo. Para empezar a atender, te recomendamos:', '1. Confirmar tu correo con el código que te enviamos aparte.', '2. Conectar el número de WhatsApp del negocio.', '3. Revisar el catálogo, los horarios y a tu equipo.'],
  boton: { texto: 'Abrir mi panel', url: o.urlPanel },
});

export const invitacion = (o: { nombre: string; invitador: string; empresa: string; rol: string; url: string; dias: number }) => render({
  tipo: 'invitacion', asunto: `${o.invitador} te invitó a ${o.empresa}`,
  previa: `Únete al equipo de ${o.empresa}.`, titulo: `Te invitaron a ${o.empresa}`,
  saludo: `Hola ${primerNombre(o.nombre)},`, parrafos: [`${o.invitador} te invitó a trabajar en ${o.empresa} con el rol «${o.rol}».`, `La invitación vence en ${o.dias} días y solo sirve una vez.`],
  boton: { texto: 'Aceptar la invitación', url: o.url }, empresa: o.empresa,
  noFuiste: 'Si no conoces a esta empresa, ignora este correo: no se creará ninguna cuenta.',
});

export const incorporacion = (o: { nombre: string; miembro: string; empresa: string; rol: string; urlEquipo: string }) => render({
  tipo: 'incorporacion', asunto: `${o.miembro} se unió a ${o.empresa}`,
  previa: 'Una persona aceptó tu invitación.', titulo: 'Tu equipo creció',
  saludo: `Hola ${primerNombre(o.nombre)},`, parrafos: [`${o.miembro} aceptó tu invitación y ya tiene acceso a ${o.empresa} con el rol «${o.rol}».`],
  boton: { texto: 'Ver el equipo', url: o.urlEquipo }, empresa: o.empresa,
});

export const cambioAcceso = (o: { nombre: string; empresa: string; rolAnterior?: string | null; rolNuevo?: string | null; desactivado?: boolean; reactivado?: boolean; urlPanel: string }) => render({
  tipo: 'cambio_acceso',
  asunto: o.desactivado ? `Tu acceso a ${o.empresa} fue retirado` : `Tus permisos en ${o.empresa} cambiaron`,
  previa: 'Cambio en tus permisos.', titulo: o.desactivado ? 'Tu acceso fue retirado' : 'Tus permisos cambiaron',
  saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: o.desactivado
    ? [`Un administrador de ${o.empresa} retiró tu acceso. Ya no puedes entrar a su panel.`]
    : o.reactivado ? [`Un administrador de ${o.empresa} volvió a darte acceso.`] : [`Un administrador de ${o.empresa} cambió tu rol.`],
  detalles: o.rolNuevo && o.rolAnterior !== o.rolNuevo ? [['Rol anterior', o.rolAnterior ?? '—'], ['Rol nuevo', o.rolNuevo]] : undefined,
  boton: o.desactivado ? undefined : { texto: 'Abrir el panel', url: o.urlPanel }, empresa: o.empresa,
  noFuiste: 'Si crees que es un error, habla con el administrador de la empresa.',
});

const ESTADOS_SUSCRIPCION: Record<string, [string, string]> = {
  PAGO_PENDIENTE: ['Tu suscripción venció', 'Renueva el pago para seguir sin interrupciones. Por ahora todo funciona con normalidad.'],
  EN_GRACIA: ['Tu suscripción está en periodo de gracia', 'Si no se registra el pago antes de la fecha indicada, la cuenta pasará a solo lectura y el canal de WhatsApp se pausará.'],
  SUSPENDIDA: ['Tu suscripción está suspendida', 'Tu equipo puede consultar y exportar los datos, pero no registrar cambios. El agente dejó de atender por WhatsApp. Al pagar, todo se reactiva.'],
};

export const suscripcion = (o: { empresa: string; estado: string; graciaHasta?: string | null; url: string }) => {
  const [titulo, texto] = ESTADOS_SUSCRIPCION[o.estado] ?? ['Cambio en tu suscripción', 'El estado de tu suscripción cambió.'];
  return render({
    tipo: `suscripcion_${o.estado.toLowerCase()}`, asunto: `${titulo} — ${o.empresa}`, previa: texto, titulo, parrafos: [texto],
    detalles: [['Empresa', o.empresa], ...(o.graciaHasta ? [['Fecha límite', o.graciaHasta] as [string, string]] : [])],
    boton: { texto: 'Ver la suscripción', url: o.url },
  });
};

export const pagoRecibido = (o: { empresa: string; monto: string; referencia: string; periodoFin: string; url: string; modalidad?: 'COMERCIAL' | 'INSTITUCIONAL'; documentos?: DocumentosCorreo | null; urlReembolso?: string }) => render({
  tipo: 'pago_recibido', asunto: `Recibimos tu pago — ${o.empresa}`, previa: 'Confirmación de pago de tu suscripción.',
  titulo: 'Pago recibido', parrafos: ['Gracias. Registramos el pago de tu suscripción.', ...(o.modalidad === 'INSTITUCIONAL' ? ['Es un pago único de la modalidad institucional: no hay cobros automáticos.'] : []), ...parrafosDocumentos(o.documentos), ...(o.urlReembolso ? [`¿Necesitas retractarte o pedir un reembolso? Hazlo en ${o.urlReembolso} con la referencia de este correo.`] : []),],
  detalles: [['Empresa', o.empresa], ...(o.modalidad ? [['Modalidad', o.modalidad === 'INSTITUCIONAL' ? 'Institucional' : 'Comercial'] as [string, string]] : []), ['Valor', o.monto], ['Referencia', o.referencia], ['Activa hasta', o.periodoFin]],
  boton: { texto: 'Ver la suscripción', url: o.url },
});

/** Pago de la activación o de la mensualidad de un número de WhatsApp (separado de la suscripción). */
export const pagoNumeroRecibido = (o: { empresa: string; monto: string; referencia: string; numero: string; cargo: 'ACTIVACION' | 'MENSUALIDAD'; cubreHasta: string | null; url: string; documentos?: DocumentosCorreo | null; urlReembolso?: string }) => render({
  tipo: 'pago_numero', asunto: `Recibimos tu pago del número de WhatsApp — ${o.empresa}`, previa: o.cargo === 'ACTIVACION' ? 'Estamos activando tu número.' : 'Tu número sigue activo.',
  titulo: 'Pago recibido',
  parrafos: [
    o.cargo === 'ACTIVACION' ? 'Gracias. Ya estamos asignando tu número y preparando su conexión con WhatsApp. Te avisaremos en el panel de cada paso; el número aparecerá como conectado solo cuando Meta lo confirme.' : 'Gracias. Registramos la mensualidad de tu número de WhatsApp.',
    'Este cargo corresponde al número; es independiente de tu plan de Omnegia y de lo que Meta cobra por mensaje.',
    ...parrafosDocumentos(o.documentos), ...(o.urlReembolso ? [`¿Necesitas pedir un reembolso? Hazlo en ${o.urlReembolso} con la referencia de este correo.`] : []),
  ],
  detalles: [['Empresa', o.empresa], ['Número', o.numero], ['Concepto', o.cargo === 'ACTIVACION' ? 'Activación y primer mes' : 'Mensualidad'], ['Valor', o.monto], ['Referencia', o.referencia], ...(o.cubreHasta ? [['Cubre hasta', o.cubreHasta] as [string, string]] : [])],
  boton: { texto: 'Ver mi número', url: o.url },
});

/** Información de los documentos del pago para el correo. Nunca incluye la contraseña. */
export interface DocumentosCorreo { numero: string; adjunto: boolean; disponible: boolean; estadoFiscal: string; urlPanel: string }

const parrafosDocumentos = (d: DocumentosCorreo | null | undefined): string[] => {
  if (!d) return [];
  return [
    d.adjunto
      ? `Adjuntamos un archivo .zip con tus documentos (${d.numero}). El .zip se abre sin contraseña; cada documento que contiene está protegido de forma individual.`
      : d.disponible
        ? `Tus documentos (${d.numero}) están disponibles para descargar desde tu panel, en Suscripción.`
        : 'Tus documentos se están preparando; podrás descargarlos desde tu panel, en Suscripción.',
    'Para abrir cada documento usa tu número de documento registrado para la facturación, solo con números y letras: sin puntos, espacios ni guiones (si es un NIT, sin el dígito de verificación). Por seguridad no lo escribimos en este correo.',
    `Estado fiscal: ${d.estadoFiscal}. El comprobante acredita el pago; solo una factura electrónica validada por la DIAN tiene validez fiscal.`,
  ];
};

/** Confirmación del alta pagada: monto real, modalidad, vigencia, acceso al subdominio y documentos. */
export const altaConfirmada = (o: { empresa: string; modalidad: 'COMERCIAL' | 'INSTITUCIONAL'; monto: string; referencia: string; vigenteHasta: string; urlEmpresa: string; documentos?: DocumentosCorreo | null; urlReembolso?: string }) => render({
  tipo: 'alta_confirmada', asunto: `Tu espacio en Omnegia está listo — ${o.empresa}`, previa: 'Confirmamos tu pago y creamos tu espacio de trabajo.',
  titulo: 'Pago confirmado y espacio creado',
  parrafos: [
    `Wompi confirmó tu pago de ${o.monto} COP y creamos el espacio de ${o.empresa}.`,
    o.modalidad === 'INSTITUCIONAL'
      ? 'Contrataste la modalidad institucional: fue un pago único. No guardamos datos de tu tarjeta ni hacemos cobros automáticos; antes del vencimiento te contaremos cómo continuar.'
      : 'Tu plan es mensual. Te avisaremos antes de cada vencimiento.',
    ...parrafosDocumentos(o.documentos),
    ...(o.urlReembolso ? [`¿Necesitas retractarte o pedir un reembolso? Hazlo en ${o.urlReembolso} con la referencia de este correo.`] : []),
    'Si es tu primera vez, define tu contraseña de acceso desde la página de tu alta para entrar.',
  ],
  detalles: [['Empresa', o.empresa], ['Modalidad', o.modalidad === 'INSTITUCIONAL' ? 'Institucional' : 'Comercial'], ['Valor pagado', `${o.monto} COP`], ['Referencia', o.referencia], ['Acceso hasta', o.vigenteHasta], ['Dirección', o.urlEmpresa], ...(o.documentos ? [['Comprobante', o.documentos.numero] as [string, string]] : [])],
  boton: { texto: 'Abrir mi espacio', url: o.urlEmpresa },
});

/** Enlace para volver al alta (definir contraseña, documentos). Lleva una llave: solo al correo verificado. */
export const continuarAlta = (o: { nombre: string; empresa: string; url: string }) => render({
  tipo: 'continuar_alta', asunto: `Continúa con tu espacio en Omnegia — ${o.empresa}`, previa: 'Vuelve a la página de tu alta para entrar a tu panel.',
  titulo: 'Continúa donde ibas',
  parrafos: [
    `${o.nombre ? `Hola, ${o.nombre}. ` : ''}Con este enlace vuelves a la página del alta de ${o.empresa}: ahí ves el estado del pago, descargas tus documentos y defines tu contraseña.`,
    'Es personal: no lo reenvíes. Si no pediste esto, puedes ignorar el mensaje.',
  ],
  boton: { texto: 'Continuar mi alta', url: o.url },
});

/** Factura electrónica validada por la DIAN (solo cuando existe una de verdad). */
export const facturaDisponible = (o: { empresa: string; numero: string; referencia: string; adjunto: boolean; url: string }) => render({
  tipo: 'factura_electronica', asunto: `Tu factura electrónica ${o.numero} — ${o.empresa}`, previa: 'La DIAN validó la factura electrónica de tu pago.',
  titulo: 'Factura electrónica disponible',
  parrafos: [
    `La DIAN validó la factura electrónica ${o.numero} correspondiente a tu pago ${o.referencia}.`,
    o.adjunto ? 'Adjuntamos un .zip (se abre sin contraseña) con su representación en PDF y el XML cifrado; las instrucciones están en el archivo LEEME.txt.' : 'Puedes descargarla desde tu panel, en Suscripción.',
    'Para abrir cada documento usa tu número de documento registrado para la facturación, sin puntos, espacios ni guiones (si es un NIT, sin el dígito de verificación).',
  ],
  detalles: [['Empresa', o.empresa], ['Factura', o.numero], ['Referencia de pago', o.referencia]],
  boton: { texto: 'Ver mis documentos', url: o.url },
});

/** Aviso previo al vencimiento de un acceso institucional: condiciones de continuidad, sin cobros automáticos. */
export const vencimientoInstitucional = (o: { empresa: string; venceEl: string; renovacion: { modalidad: 'COMERCIAL' | 'INSTITUCIONAL'; monto: string; dias: number | null; disponible: boolean }; url: string }) => render({
  tipo: 'vencimiento_institucional', asunto: `Tu acceso institucional vence el ${o.venceEl} — ${o.empresa}`, previa: 'Condiciones para continuar. No hacemos cobros automáticos.',
  titulo: 'Tu acceso institucional está por vencer',
  parrafos: [
    `El acceso institucional de ${o.empresa} vence el ${o.venceEl}. No haremos ningún cobro automático.`,
    !o.renovacion.disponible
      ? 'Por ahora no hay una modalidad de pago en línea disponible para continuar. Escríbenos y te ayudamos.'
      : o.renovacion.modalidad === 'INSTITUCIONAL'
        ? `Si quieres continuar, puedes renovar ${o.renovacion.dias} días más por ${o.renovacion.monto} (precio institucional vigente) desde la sección Suscripción de tu panel.`
        : `La modalidad institucional terminó. Si quieres continuar, puedes aceptar el plan comercial de ${o.renovacion.monto} al mes desde la sección Suscripción. Nada se cobra sin tu aceptación expresa.`,
    'Si no renuevas, tu información se conserva: la cuenta pasa a solo lectura y exportación tras el periodo de gracia.',
  ],
  detalles: [['Empresa', o.empresa], ['Vence', o.venceEl]],
  boton: { texto: 'Ver la suscripción', url: o.url },
});

const AVISOS: Record<string, [string, string]> = {
  SUSPENDIDA: ['Tu servicio fue suspendido', 'El equipo de la plataforma suspendió el servicio. Tus datos se conservan y puedes consultarlos y exportarlos.'],
  ACTIVA: ['Tu servicio está activo de nuevo', 'El equipo de la plataforma reactivó tu servicio. Todo funciona con normalidad.'],
  CANCELADA: ['Tu servicio fue cancelado', 'El equipo de la plataforma canceló el servicio. Tus datos no se borraron: escríbenos si necesitas recuperarlos o reactivarlo.'],
  PLAN: ['Tu plan cambió', 'El equipo de la plataforma cambió el plan de tu empresa.'],
  MODULO: ['Cambio en los módulos de tu plan', 'El equipo de la plataforma cambió los módulos disponibles para tu empresa.'],
};

export const avisoAdministrativo = (o: { empresa: string; tipo: keyof typeof AVISOS; motivo: string; detalles?: [string, string][]; url: string }) => {
  const [titulo, texto] = AVISOS[o.tipo];
  return render({
    tipo: `aviso_admin_${String(o.tipo).toLowerCase()}`, asunto: `${titulo} — ${o.empresa}`, previa: texto, titulo,
    parrafos: [texto], detalles: [['Empresa', o.empresa], ['Motivo', o.motivo], ...(o.detalles ?? [])],
    boton: o.tipo === 'CANCELADA' ? undefined : { texto: 'Abrir el panel', url: o.url },
    noFuiste: 'Si no esperabas este cambio, responde a este correo y lo revisamos contigo.',
  });
};

// ------------------------------------------------------------------ soporte
export const ticketInterno = (o: { numero: string; empresa: string; empresaId: string; categoria: string; prioridad: string; asunto: string; descripcion: string; solicitante: string; urlOperador: string; respuesta?: boolean }) => render({
  tipo: o.respuesta ? 'soporte_respuesta_empresa' : 'soporte_interno',
  asunto: `[${o.numero}] ${o.respuesta ? 'Nueva respuesta: ' : ''}${o.asunto}`,
  previa: `${o.empresa} · ${o.categoria} · ${o.prioridad}`, titulo: o.respuesta ? `Nueva respuesta en ${o.numero}` : `Nueva solicitud ${o.numero}`,
  parrafos: [o.descripcion],
  detalles: [['Empresa', o.empresa], ['Id. de empresa', o.empresaId], ['Solicitante', o.solicitante], ['Categoría', o.categoria], ['Prioridad', o.prioridad]],
  boton: { texto: 'Abrir en el panel del operador', url: o.urlOperador },
});

export const ticketRecibido = (o: { nombre: string; numero: string; asunto: string; url: string }) => render({
  tipo: 'soporte_recibido', asunto: `Recibimos tu solicitud ${o.numero}`, previa: 'Tu solicitud de soporte quedó registrada.',
  titulo: 'Recibimos tu solicitud', saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: ['Tu solicitud quedó registrada y la revisará el equipo de soporte. Te responderemos en el panel y por correo.', 'Nunca incluyas contraseñas, claves de API ni datos de tarjetas en una solicitud.'],
  detalles: [['Radicado', o.numero], ['Asunto', o.asunto]], boton: { texto: 'Ver la solicitud', url: o.url },
});

export const ticketRespuesta = (o: { nombre: string; numero: string; asunto: string; respuesta: string; url: string }) => render({
  tipo: 'soporte_respuesta', asunto: `Respuesta a tu solicitud ${o.numero}`, previa: 'El equipo de soporte respondió tu solicitud.',
  titulo: `Respuesta a ${o.numero}`, saludo: `Hola ${primerNombre(o.nombre)},`, parrafos: [o.respuesta],
  detalles: [['Asunto', o.asunto]], boton: { texto: 'Responder en el panel', url: o.url },
});

// ------------------------------------------------------------------ datos personales (Ley 1581 de 2012)
const fechaLarga = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export const solicitudDatosRecibida = (o: { nombre: string; radicado: string; tipo: string; dias: number; vence: string }) => render({
  tipo: 'datos_solicitud_recibida', asunto: `Recibimos tu solicitud sobre tus datos ${o.radicado}`, previa: 'Tu solicitud sobre datos personales quedó registrada.',
  titulo: 'Recibimos tu solicitud', saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: [
    `Registramos tu solicitud de «${o.tipo}». Antes de actuar verificaremos que seas la persona titular de los datos: responde a este correo si necesitamos algún dato adicional.`,
    `La ley nos da ${o.dias} días hábiles para responderte. Nuestra meta interna es hacerlo a más tardar el ${fechaLarga(o.vence)}.`,
    'Si no hiciste esta solicitud, ignora este mensaje: no se modificará ni se eliminará ningún dato sin esa verificación.',
  ],
  detalles: [['Radicado', o.radicado], ['Tipo', o.tipo]],
});

export const solicitudDatosInterna = (o: { radicado: string; tipo: string; calidad: string; nombre: string; email: string; telefono?: string; comercio?: string; detalle: string; vence: string }) => render({
  tipo: 'datos_solicitud_interna', asunto: `[${o.radicado}] ${o.tipo}`, previa: `${o.nombre} · ${o.tipo}`, titulo: `Solicitud de datos personales ${o.radicado}`,
  parrafos: [o.detalle, 'Verifica la identidad de quien solicita antes de entregar, corregir o eliminar datos. Si los datos son de clientes de un comercio, da traslado al comercio responsable en un máximo de 2 días hábiles (Ley 1581 de 2012, art. 15).'],
  detalles: [['Solicitante', o.nombre], ['Correo', o.email], ['Teléfono', o.telefono || 'No indicado'], ['Calidad', o.calidad], ['Comercio', o.comercio || 'No indicado'], ['Fecha objetivo', fechaLarga(o.vence)]],
});

// ------------------------------------------------------------------ reembolsos y retracto (Ley 1480 de 2011; Ley 2439 de 2024)
export const reembolsoRecibido = (o: { nombre: string; radicado: string; motivo: string; aprobado: boolean; razon: string; monto: string; vence: string; medio: string }) => render({
  tipo: 'reembolso_recibido', asunto: `Recibimos tu solicitud de reembolso ${o.radicado}`, previa: o.aprobado ? 'Tu solicitud fue aprobada.' : 'Tu solicitud quedó registrada.',
  titulo: o.aprobado ? 'Tu solicitud fue aprobada' : 'Recibimos tu solicitud', saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: [
    o.aprobado ? `${o.razon} Te devolveremos ${o.monto}, sin descuentos ni retenciones, a más tardar el ${fechaLarga(o.vence)} (15 días calendario).` : `${o.razon} Te responderemos por este correo. La ley nos da 15 días calendario para devolver el dinero si procede; nuestra meta es hacerlo a más tardar el ${fechaLarga(o.vence)}.`,
    o.aprobado ? 'Tu espacio no se creará con este pago. Cuando hagamos la devolución te lo confirmaremos con la referencia.' : 'Mientras tanto no tienes que hacer nada. Si necesitamos algún dato, te escribiremos aquí.',
    'Nunca te pediremos por correo ni por chat tu clave, tu número de tarjeta completo ni códigos de acceso.',
  ],
  detalles: [['Radicado', o.radicado], ['Motivo', o.motivo], ['Valor', o.monto], ['Devolución por', o.medio]],
});

export const reembolsoInterno = (o: { radicado: string; motivo: string; estado: string; razon: string; referencia: string; monto: string; nombre: string; email: string; medio: string; detalle: string; vence: string; urlOperador: string }) => render({
  tipo: 'reembolso_interno', asunto: `[${o.radicado}] ${o.estado === 'APROBADO' ? 'Reembolso aprobado: devolver' : 'Reembolso por revisar'} ${o.monto}`, previa: `${o.motivo} · ${o.monto}`,
  titulo: `Solicitud de reembolso ${o.radicado}`,
  parrafos: [o.detalle, `Evaluación automática: ${o.razon}`, o.estado === 'APROBADO' ? 'Está aprobada: haz la devolución (en Wompi o por transferencia) y registra su referencia en el panel antes de la fecha límite.' : 'Decide la solicitud en el panel antes de la fecha límite.'],
  detalles: [['Estado', o.estado === 'APROBADO' ? 'Aprobada' : 'En revisión'], ['Motivo', o.motivo], ['Referencia del pago', o.referencia], ['Valor', o.monto], ['Solicitante', o.nombre], ['Correo', o.email], ['Devolver por', o.medio], ['Fecha límite (15 días calendario)', fechaLarga(o.vence)]],
  boton: { texto: 'Abrir en el panel del operador', url: o.urlOperador },
});

export const reembolsoDecision = (o: { nombre: string; radicado: string; aprobado: boolean; motivo: string; monto: string; vence: string; medio: string }) => render({
  tipo: 'reembolso_decision', asunto: `${o.aprobado ? 'Aprobamos' : 'Respuesta a'} tu solicitud de reembolso ${o.radicado}`, previa: o.aprobado ? 'Vamos a devolverte el dinero.' : 'Revisamos tu solicitud.',
  titulo: o.aprobado ? 'Aprobamos tu solicitud' : 'Respuesta a tu solicitud', saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: o.aprobado
    ? [`Revisamos tu caso y aprobamos la devolución de ${o.monto}, sin descuentos ni retenciones. La haremos a más tardar el ${fechaLarga(o.vence)} y te confirmaremos con la referencia.`]
    : [`Revisamos tu solicitud y no podemos aprobarla por este motivo: ${o.motivo}`, 'Si no estás de acuerdo, responde a este correo con la información que quieras que revisemos. También puedes acudir a la Superintendencia de Industria y Comercio (www.sic.gov.co), que no exige abogado para reclamaciones de consumo.'],
  detalles: o.aprobado ? [['Radicado', o.radicado], ['Devolución por', o.medio]] : [['Radicado', o.radicado]],
});

export const reembolsoDevuelto = (o: { nombre: string; radicado: string; monto: string; referencia: string; medio: string }) => render({
  tipo: 'reembolso_devuelto', asunto: `Te devolvimos ${o.monto} · ${o.radicado}`, previa: 'La devolución ya salió.', titulo: 'Ya hicimos la devolución', saludo: `Hola ${primerNombre(o.nombre)},`,
  parrafos: ['Registramos la devolución de tu pago. Según tu banco o medio de pago, puede tardar unos días en verse reflejada. Si pasado ese tiempo no la ves, responde a este correo con la referencia.'],
  detalles: [['Radicado', o.radicado], ['Valor devuelto', o.monto], ['Referencia de la devolución', o.referencia], ['Devuelto por', o.medio]],
});

// ------------------------------------------------------------------ avisos del negocio (contexto de tenant)
export const alertaNegocio = (o: { empresa: string; titulo: string; lineas: string[]; url: string }) => render({
  tipo: 'alerta_negocio', asunto: `${o.titulo} — ${o.empresa}`, previa: o.lineas[0] ?? o.titulo, titulo: o.titulo,
  parrafos: [...o.lineas, 'Revísalo en el panel.'], boton: { texto: 'Abrir el panel', url: o.url }, empresa: o.empresa,
});

export const radicadoSinRespuesta = (o: { empresa: string; radicado: string; prioridad: string; asignado: boolean; url: string }) => render({
  tipo: 'radicado_sla', asunto: `Radicado ${o.radicado} sin respuesta`, previa: 'Un cliente espera respuesta de tu equipo.',
  titulo: `${o.radicado} superó su tiempo de respuesta`,
  parrafos: [`El radicado ${o.radicado} (prioridad ${o.prioridad.toLowerCase()}) no ha recibido respuesta de una persona del equipo.`, o.asignado ? 'Está asignado, pero nadie ha respondido todavía.' : 'Nadie lo ha tomado: está en la cola.'],
  boton: { texto: 'Atender ahora', url: o.url }, empresa: o.empresa,
});

export const documentoFiscal = (o: { cliente: string; empresa: string; tipoDoc: string; numero: string; total: string; prueba: boolean; url: string }) => render({
  tipo: 'documento_fiscal', asunto: `${o.tipoDoc} ${o.numero} — ${o.empresa}`, previa: `${o.empresa} te envía tu ${o.tipoDoc.toLowerCase()}.`,
  titulo: `Tu ${o.tipoDoc.toLowerCase()} ${o.numero}`, saludo: `Hola ${primerNombre(o.cliente)},`,
  parrafos: [`${o.empresa} te envía tu ${o.tipoDoc.toLowerCase()} por ${o.total}.`, o.prueba ? 'Este documento se generó en un entorno de pruebas y no tiene validez fiscal.' : 'El documento fue validado por la DIAN.'],
  boton: { texto: 'Ver el documento', url: o.url }, empresa: o.empresa,
});

/** Correo de prueba de configuración (script de envío). */
export const pruebaConfiguracion = (o: { proveedor: string }) => render({
  tipo: 'prueba_configuracion', asunto: `Prueba de envío de ${MARCA.nombre}`, previa: 'Si lees esto, el envío funciona.',
  titulo: 'El correo transaccional funciona',
  parrafos: [`Este mensaje salió por el proveedor «${o.proveedor}» con el remitente configurado. Si respondes, la respuesta llega a la bandeja de soporte.`],
  detalles: [['Remitente', `${config.correo.remitenteNombre} <${config.correo.remitenteDireccion}>`], ['Responder a', config.correo.responderA]],
});
