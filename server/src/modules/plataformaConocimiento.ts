import type { Database } from '../db/index.js';
import { config } from '../config.js';
import { MODULE_CATALOG } from '../onboarding/pricing.js';
import { MODULOS } from '../templates/index.js';
import { AYUDA } from '../ai/registry.js';
import { RETENCION_DIAS_PLATAFORMA } from './plataformaBot.js';

/**
 * Base de conocimiento del asistente del WhatsApp de Omnegia. Se arma en cada respuesta con las mismas
 * fuentes que usan el sitio y el panel (catálogo de módulos y sus tarifas, niveles de uso en la base,
 * guías verificadas del panel, reglas de reembolso y la configuración vigente), así que nunca queda
 * desactualizada respecto a lo que la persona ve. Nada de aquí es dato de una cuenta.
 */
const cop = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
const BASE_CONFIGURADOR = 29000;
const nombreModulo = (id: string) => MODULE_CATALOG.find((m) => m.id === id)?.nombre ?? MODULOS[id]?.nombre ?? id;

/** Páginas públicas a las que el asistente puede llevar a la persona (lista cerrada). */
export function paginas(): { ruta: string; para: string }[] {
  const u = config.publicUrl;
  return [
    { ruta: `${u}/producto`, para: 'qué es Omnegia y un recorrido por sus funciones' },
    { ruta: `${u}/planes`, para: 'configurador de módulos con el valor estimado' },
    { ruta: `${u}/empezar`, para: 'crear una empresa (alta guiada con IA)' },
    { ruta: `${u}/entrar`, para: 'iniciar sesión' },
    { ruta: `${u}/recuperar`, para: 'crear una contraseña nueva' },
    { ruta: `${u}/ayuda`, para: 'centro de ayuda' },
    { ruta: `${u}/consumidor#reembolso`, para: 'retracto, devoluciones y derechos del consumidor' },
    { ruta: `${u}/privacidad`, para: 'política de tratamiento de datos' },
    { ruta: `${u}/terminos`, para: 'términos y condiciones' },
    { ruta: `${u}/eliminacion-de-datos`, para: 'consultar, corregir o eliminar datos personales' },
  ];
}

export async function conocimientoOmnegia(db: Database): Promise<string> {
  const planes = await db.withPlatform(async (tx) => (await tx.query(
    `SELECT codigo, nombre, precio_mensual, cuota_tokens_ia, cuota_mensajes, cuota_documentos, max_usuarios, modulos, politica_excedente
     FROM plan WHERE codigo IN ('esencial','negocio','pro') ORDER BY orden`)).rows);
  const demo = !config.pagos.tarifasConfirmadas;
  const inst = config.institucional;

  const modulos = MODULE_CATALOG.map((m) => {
    const requiere = m.dependencias.filter((d) => !['clientes', 'catalogo'].includes(d)).map(nombreModulo);
    const solo = BASE_CONFIGURADOR + m.precio + m.dependencias.reduce((s, d) => s + (MODULE_CATALOG.find((x) => x.id === d)?.precio ?? 0), 0);
    const detalle = MODULOS[m.id]?.descripcion;
    return `- ${m.nombre}: ${m.descripcion}${detalle ? ` (${detalle})` : ''}. ${m.precio ? `${cop(m.precio)} al mes` : 'Incluido en la base'}${requiere.length ? `; requiere ${requiere.join(' y ')}` : ''}.${m.precio ? ` Solo con este módulo: ${cop(solo)} al mes.` : ''}`;
  });
  const otros = Object.entries(MODULOS).filter(([id]) => !MODULE_CATALOG.some((m) => m.id === id)).map(([, m]) => `- ${m.nombre}: ${m.descripcion}.`);

  return `
# Qué es Omnegia
Plataforma colombiana para pequeños negocios: reúne en un solo panel la atención por WhatsApp con un asistente de IA (que pasa a una persona con radicado cuando hace falta), clientes, catálogo, agenda, ventas y cobros (efectivo, transferencia, datáfono y enlace de pago Wompi), inventario, comisiones del equipo, facturación electrónica y permisos por rol. Cada negocio elige sus módulos. Funciona en computador y en el teléfono. Hay un asistente de IA dentro del panel que responde con los datos del negocio y un copiloto que le sugiere respuestas al asesor.

# Módulos y precio del alta (configurador en ${config.publicUrl}/planes)
La base cuesta ${cop(BASE_CONFIGURADOR)} al mes e incluye Clientes y Catálogo. Cada módulo suma su valor; si un módulo requiere otro, el otro se suma también. El total es la base más los módulos elegidos.
${modulos.join('\n')}
${otros.length ? `Otros módulos que puede tener una empresa según su tipo de negocio:\n${otros.join('\n')}` : ''}
${demo ? 'IMPORTANTE: el sitio presenta estas tarifas como de demostración; los precios definitivos e impuestos están pendientes de confirmación. Dilo siempre que des un precio del configurador.' : 'Estas son las tarifas vigentes del configurador.'}
${inst.activo ? `Modalidad vigente para el alta: pago único de ${cop(inst.precioCop)} por ${inst.dias} días de acceso (cobro real con Wompi, sin renovación automática). Los precios del configurador se muestran solo como referencia.` : ''}

# Niveles de uso y renovación mensual
Cada empresa queda en un nivel que fija cuántas personas, mensajes de WhatsApp, uso de IA y documentos incluye al mes. El nivel lo asigna Omnegia según el negocio descrito en el alta. La renovación mensual cobra el valor del nivel asignado; la persona lo ve en Suscripción antes de pagar y nada se cobra solo.
${planes.map((p: any) => `- ${p.nombre}: ${cop(Number(p.precio_mensual))} al mes · hasta ${p.max_usuarios} personas · ${Number(p.cuota_mensajes).toLocaleString('es-CO')} mensajes · ${Number(p.cuota_tokens_ia).toLocaleString('es-CO')} tokens de IA · ${Number(p.cuota_documentos).toLocaleString('es-CO')} documentos fiscales · módulos: ${(p.modulos as string[]).map(nombreModulo).join(', ')}. ${p.politica_excedente === 'EXCEDENTE' ? 'Si se pasa del uso de IA, sigue funcionando y se cobra el excedente.' : 'Si se agota el uso de IA del mes, las conversaciones pasan al equipo hasta el siguiente periodo o hasta ampliarlo.'}`).join('\n')}

# Cómo empezar
En ${config.publicUrl}/empezar la persona describe su negocio con sus palabras, la IA propone los módulos, revisa el valor, acepta los términos y paga con Wompi. Al confirmarse el pago se crea su panel con su propio subdominio y la persona queda como propietaria de la empresa. No hay periodo de prueba: la empresa se crea con el primer pago. Una misma cuenta (correo) puede tener varias empresas y cambiar entre ellas desde el menú del panel.

# Pagos, suscripción y devoluciones
- No hay cobros automáticos: cada periodo se paga de forma explícita desde Suscripción, con Wompi.
- Si la suscripción vence, primero hay periodo de gracia; si se suspende, el equipo puede entrar en modo de solo lectura y exportar sus datos, y el asistente de WhatsApp del negocio se pausa. Al pagar, todo se reactiva.
- Los comprobantes de pago están en Suscripción › Documentos de tus pagos.
- Retracto: dentro de los 5 días hábiles después del pago, si el espacio aún no se creó. También procede devolución si la activación falló o pasaron 30 días sin activarse, y por cobro duplicado. La devolución se hace en máximo 15 días calendario, sin descuentos. No se devuelven periodos ya prestados cuando la empresa decide terminar por su cuenta. Se solicita en ${config.publicUrl}/consumidor#reembolso.

# WhatsApp del negocio
- Conectar un número propio: en el panel, Configuración › WhatsApp, se escribe el Phone number ID que Meta muestra junto al número (no es el número de teléfono) y se pulsa «Probar conexión».
- Contratar un número nuevo: en el panel, sección «Número de WhatsApp», Omnegia gestiona el número y lo deja conectado al asistente de IA.
- El asistente del negocio responde solo dentro de las 24 horas desde el último mensaje del cliente; fuera de esa ventana WhatsApp exige plantillas aprobadas.
- En Conversaciones el asesor ve el hilo, toma el caso, responde, deja notas internas, pide sugerencias a la IA y, en casos difíciles, pide ayuda a Omnegia compartiendo esa conversación (solo lectura o con permiso para responder).

# Guías del panel (verificadas)
${Object.entries(AYUDA).map(([tema, g]) => `- ${tema}: ${g}`).join('\n')}

# Cuenta y acceso
- Para crear una contraseña nueva se usa el enlace de recuperación (vence en 60 minutos, sirve una vez; máximo 3 por hora). Tú puedes enviarlo si la persona te da su correo.
- Tras varios intentos fallidos, el ingreso se bloquea ${config.login.ventanaMin} minutos.
- Los códigos de verificación llegan al correo y vencen en ${config.correo.otpMinutos} minutos.
- Si la persona entra pero no ve su empresa, puede que le hayan retirado el acceso: quien administra la empresa la invita de nuevo desde Configuración › Equipo y comisiones.
- Roles: propietario (por encima del administrador; nadie más puede cambiarle el rol), administrador, supervisor, recepción y otros según el negocio, cada uno con permisos concretos.

# Privacidad y seguridad
- Las conversaciones con este WhatsApp se borran ${RETENCION_DIAS_PLATAFORMA} días después del último mensaje.
- El equipo de Omnegia no puede ver los datos de los clientes de una empresa, salvo una conversación que la empresa comparta con soporte por tiempo limitado.
- Datos personales: ${config.publicUrl}/eliminacion-de-datos. Política: ${config.publicUrl}/privacidad.
- La facturación electrónica hoy funciona en entorno de pruebas (sin validez ante la DIAN) hasta conectar un proveedor autorizado.

# Páginas a las que puedes llevar a la persona (usa estas URL exactas, no inventes otras)
${paginas().map((p) => `- ${p.ruta} — ${p.para}`).join('\n')}
`.trim();
}
