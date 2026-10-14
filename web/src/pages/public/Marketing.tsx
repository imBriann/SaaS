import { Link } from 'react-router-dom';
import { PublicoLayout } from './Publico';
import { FeatureBuilder } from '../../components/Experience';
import { Closing, MODULE_COPY } from '../../components/MarketingExperience';
import { Icon } from '../../components/icons';
import { api } from '../../api';
import { Cargando, ErrorCarga, useApi } from '../../components/ui';
import { MARCA } from '../../brand';

export function Producto() {
  const { data, error, recargar } = useApi<any>(() => api.get('/api/publico/modulos'), []);
  return <PublicoLayout transparente>
    <section className="public-intro"><div><h1>Un negocio.<br /><span>Muchas piezas. Un sistema.</span></h1><p>Conecta la atención y la operación con los módulos que tu empresa necesita. Empieza con clientes y catálogo; añade lo que te ayude a trabajar.</p><Link className="btn primario grande" to="/planes">Elegir mis módulos <Icon n="flecha" size={18} className="" /></Link></div><div className="intro-symbol" aria-hidden="true"><Icon n="plataforma" size={130} className="" /></div></section>
    <section className="om-section product-catalog" aria-label="Módulos disponibles">{error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={6} /> : data.modulos.map((m: any) => <article key={m.id} id={m.id} className="product-row"><Icon n={m.icono} size={30} className="" /><div><h2>{MODULE_COPY[m.id]?.nombre ?? m.nombre}</h2><span>{m.precio === 0 ? 'Incluido en tu espacio' : m.id === 'facturacion' ? 'Entorno de pruebas' : 'Módulo opcional'}</span></div><div><h3>{MODULE_COPY[m.id]?.beneficio}</h3><p>{MODULE_COPY[m.id]?.detalle ?? m.descripcion}</p></div><Link to="/planes#seleccion" aria-label={`Configurar ${MODULE_COPY[m.id]?.nombre ?? m.nombre}`}><Icon n="flecha" className="" size={22} /></Link></article>)}</section>
    <section className="om-section integration-note"><Icon n="integraciones" size={28} className="" /><div><h2>Las conexiones también importan.</h2><p>WhatsApp, IA y cobros necesitan una integración configurada. Revisa su estado en el panel. La facturación electrónica real requiere conectar un proveedor; los documentos de prueba no tienen validez fiscal.</p></div></section><Closing />
  </PublicoLayout>;
}

/** Contenido institucional editable; no se atribuyen historia, equipo ni promesas sin confirmar. */
const NOSOTROS = { proposito: 'Un lugar para conectar lo que ocurre en tu negocio.', mision: null as string | null, vision: null as string | null };
export function Nosotros() {
  return <PublicoLayout transparente><section className="public-intro about-intro"><div><h1>El negocio es tuyo.<br /><span>El espacio, también.</span></h1><p>Omnegia es una plataforma para reunir atención, clientes y operación. Su punto de partida es concreto: entender cómo trabaja cada negocio y configurar las herramientas que necesita.</p></div><img className="about-mark" src={MARCA.isologo} alt="" /></section>
    <section className="om-section about-purpose"><h2>{NOSOTROS.proposito}</h2><p>Conversaciones, agenda, ventas y catálogo comparten un espacio de trabajo. La tecnología acompaña la operación con permisos claros y la posibilidad de acudir a una persona.</p></section>
    <section className="om-section institutional"><article><h2>Misión</h2><p>{NOSOTROS.mision ?? 'Estamos definiendo nuestra misión institucional. La publicaremos aquí cuando esté confirmada.'}</p>{!NOSOTROS.mision && <span>Contenido por definir</span>}</article><article><h2>Visión</h2><p>{NOSOTROS.vision ?? 'Estamos definiendo nuestra visión de largo plazo. Este espacio se actualizará con la declaración oficial.'}</p>{!NOSOTROS.vision && <span>Contenido por definir</span>}</article></section><Closing />
  </PublicoLayout>;
}

export function Planes() {
  const estado = useApi<any>(() => api.get('/api/publico/estado'), []);
  return <PublicoLayout transparente><section className="public-intro plans-intro"><div><h1>Solo las piezas<br /><span>que necesitas.</span></h1><p>Explora la configuración de tu empresa y revisa cada concepto antes de continuar. Clientes y catálogo están incluidos en la base.</p></div><div className="pricing-disclosure"><Icon n="info" size={24} className="" /><h2>Una estimación transparente.</h2><p>Los importes del configurador son tarifas de demostración, no una oferta comercial. Precios definitivos e impuestos pendientes de confirmación.</p>{estado.error ? <p role="status">No pudimos comprobar la disponibilidad de contratación. Puedes reintentar al continuar.</p> : estado.data && <span>{estado.data.simuladores ? 'Entorno de demostración · sin cobros reales' : estado.data.contratacion ? 'La contratación se revisa en el siguiente paso' : 'Contratación en línea pendiente de habilitar'}</span>}</div></section><FeatureBuilder /><section className="om-section plan-conditions"><h2>Antes de continuar</h2><dl><div><dt>Una configuración revisable</dt><dd>Puedes revisar los módulos y tus datos antes de ir a la pasarela.</dd></div><div><dt>Creación después del pago</dt><dd>El panel se crea cuando el servidor confirma el pago. Un borrador no es una empresa activa.</dd></div><div><dt>Servicios que requieren conexión</dt><dd>WhatsApp, IA, cobros y emisión fiscal dependen de sus proveedores y de la configuración de tu empresa.</dd></div></dl></section></PublicoLayout>;
}

const PREGUNTAS = [
  ['¿Cómo empiezo?', 'Describe tu negocio en Crear mi espacio. Revisa las funciones sugeridas, completa tus datos y carga tu catálogo. Verás la propuesta antes de continuar al pago.'],
  ['¿Qué puede hacer el asistente?', 'El asistente del panel consulta datos de tu empresa con las herramientas disponibles y tus permisos. Sus respuestas incluyen recibos cuando ejecuta herramientas. La atención por WhatsApp depende de los módulos y las conexiones habilitadas.'],
  ['¿Y si el asistente no resuelve mi consulta?', 'Puedes abrir una solicitud en Soporte. El equipo de Omnegia recibe el asunto y la descripción que envíes; podrás seguir el estado, leer la respuesta y contestar desde el panel. No se adjunta automáticamente tu conversación con la IA.'],
  ['¿Cómo conecto WhatsApp?', 'En Configuración, abre WhatsApp, completa la información de tu número y utiliza Probar conexión. El resultado indica si la conexión está lista o necesita una corrección.'],
  ['¿Puedo importar mi catálogo?', 'Sí. Durante la configuración puedes cargar un archivo de productos o servicios, revisar sus columnas y confirmar la vista previa. También puedes completarlo manualmente.'],
  ['¿La facturación ya tiene validez fiscal?', 'El proyecto dispone de facturación en entorno de pruebas. Los documentos de ese entorno no tienen validez fiscal. La emisión real requiere conectar un proveedor tecnológico.'],
];
export function Ayuda() {
  return <PublicoLayout transparente><section className="public-intro help-intro"><div><h1>Un poco de ayuda.<br /><span>Un siguiente paso claro.</span></h1><p>Encuentra cómo empezar, qué puede hacer el asistente y cómo contactar con una persona.</p></div><Link to="/soporte" className="help-human"><Icon n="persona" className="" size={32} /><h2>Hablar con el equipo</h2><p>Abre una solicitud desde tu empresa. Recibirás un radicado para seguir la atención en el panel.</p><span>Ir a soporte <Icon n="flecha" size={18} className="" /></span><small>Requiere iniciar sesión</small></Link></section>
    <section className="om-section help-content"><div><h2>Respuestas<br />para avanzar.</h2><p>Guías de las funciones disponibles en Omnegia.</p></div><div className="help-faq">{PREGUNTAS.map(([q, a]) => <details key={q}><summary>{q}<Icon n="mas" className="" size={18} /></summary><p>{a}</p></details>)}</div></section>
    <section className="om-section support-explained"><h2>Así continúa tu solicitud.</h2><ol className="support-statuses"><li><strong>Abierta</strong><p>La solicitud quedó registrada.</p></li><li><strong>En proceso</strong><p>El equipo está atendiendo el caso.</p></li><li><strong>Esperando tu respuesta</strong><p>Hay información que necesitamos de ti.</p></li><li><strong>Resuelta o cerrada</strong><p>Consulta la respuesta y el estado del caso.</p></li></ol><p>El estado se actualiza según la atención real. Las respuestas quedan en el panel y se notifican por correo.</p></section>
    <section className="om-section data-note" id="datos"><Icon n="candado" size={26} className="" /><div><h2>Tu información, con cuidado.</h2><p>El acceso al panel depende de tu empresa y tus permisos. Comparte con soporte solo lo necesario para explicar el problema; no incluyas contraseñas, códigos de acceso ni datos de tus clientes.</p><p>Para consultas sobre tu cuenta o tus datos, escribe a <a href="mailto:soporte@brianacevedo.dev">soporte@brianacevedo.dev</a>.</p></div></section>
  </PublicoLayout>;
}
