import { config, validarCorreo } from '../config.js';
import { crearProveedor } from './proveedores.js';
import { validarDestinatario } from './servicio.js';
import { pruebaConfiguracion } from './plantillas.js';
import { token } from '../lib/util.js';

/**
 * Envío de prueba de la configuración de correo, sin pasar por la base:
 *   npm run correo:prueba -- tu-correo@dominio.com
 * Usa EMAIL_PROVIDER y el remitente configurados. Imprime el id que devuelve el
 * proveedor (aceptado) o el código del fallo. «Aceptado» no significa entregado:
 * revisa la bandeja (y el panel del proveedor) para confirmar la entrega.
 */
const para = validarDestinatario(process.argv[2]);
if (!para) {
  console.error('Uso: npm run correo:prueba -- destinatario@dominio.com');
  process.exit(2);
}
const errores = validarCorreo();
if (errores.length) {
  for (const e of errores) console.error(`[configuración] ${e}`);
  process.exit(1);
}
const proveedor = crearProveedor();
const correo = pruebaConfiguracion({ proveedor: proveedor.nombre });
console.log(`Proveedor: ${proveedor.nombre} · Remitente: ${config.correo.remitenteNombre} <${config.correo.remitenteDireccion}> · Responder a: ${config.correo.responderA}`);
const r = await proveedor.enviar({ para, asunto: correo.asunto, html: correo.html, texto: correo.texto, tipo: correo.tipo, responderA: config.correo.responderA, claveIdempotencia: `prueba-${token(12)}` });
if (r.ok) {
  console.log(`Aceptado por el proveedor. Id: ${r.idProveedor}`);
  if (proveedor.nombre === 'fake') console.log('Proveedor de prueba: el correo no salió de este equipo.');
} else {
  console.error(`No se envió: ${r.codigo}${r.reintentable ? ' (temporal)' : ''}`);
  process.exit(1);
}
