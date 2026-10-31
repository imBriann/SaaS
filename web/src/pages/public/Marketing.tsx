import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PublicoLayout } from './Publico';
import { Closing, MODULE_COPY } from '../../components/MarketingExperience';
import { Icon } from '../../components/icons';
import { api, cop } from '../../api';
import { SelectorPlanes, type CicloPlan, type PlanVista } from '../../components/facturacion/SelectorPlanes';
import { Cargando, ErrorCarga, useApi } from '../../components/ui';
import { MARCA } from '../../brand';

export function Producto() {
  const { data, error, recargar } = useApi<any>(() => api.get('/api/publico/modulos'), []);
  return <PublicoLayout transparente>
    <section className="public-intro"><div><h1>Un negocio.<br /><span>Muchas piezas. Un sistema.</span></h1><p>Conecta la atención y la operación con los módulos que tu empresa necesita. Empieza con clientes y catálogo; añade lo que te ayude a trabajar.</p><Link className="btn primario grande" to="/planes">Ver los planes <Icon n="flecha" size={18} className="" /></Link></div><div className="intro-symbol" aria-hidden="true"><Icon n="plataforma" size={130} className="" /></div></section>
    <section className="om-section product-catalog" aria-label="Módulos disponibles">{error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={6} /> : data.modulos.map((m: any) => <article key={m.id} id={m.id} className="product-row"><Icon n={m.icono} size={30} className="" /><div><h2>{MODULE_COPY[m.id]?.nombre ?? m.nombre}</h2><span>{m.precio === 0 ? 'Incluido en tu espacio' : m.id === 'facturacion' ? 'Entorno de pruebas' : 'Módulo opcional'}</span></div><div><h3>{MODULE_COPY[m.id]?.beneficio}</h3><p>{MODULE_COPY[m.id]?.detalle ?? m.descripcion}</p></div><Link to="/planes" aria-label={`Ver planes con ${MODULE_COPY[m.id]?.nombre ?? m.nombre}`}><Icon n="flecha" className="" size={22} /></Link></article>)}</section>
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

/**
 * Planes en el sitio público (sin iniciar sesión): el mismo selector del panel con los precios reales del
 * catálogo. Elegir un plan lleva al alta con ese plan y ciclo; el cobro lo calcula el servidor.
 */
export function Planes() {
  const { data, error, recargar } = useApi<any>(() => api.get('/api/publico/planes'), []);
  const [ciclo, setCiclo] = useState<CicloPlan>('MENSUAL');
  const nav = useNavigate();
  const elegir = (p: PlanVista) => {
    try { sessionStorage.setItem('plan_elegido', JSON.stringify({ plan: p.codigo, ciclo })); } catch { /* sin almacenamiento: se elige en el alta */ }
    nav('/empezar');
  };
  const inst = data?.modalidad;
  return <PublicoLayout transparente>
    <section className="matiz matiz-publico" aria-label="Planes de Omnegia">
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={6} /> : (
        <SelectorPlanes planes={data.planes} ciclo={ciclo} onCiclo={setCiclo}
          subtitulo="Atención por WhatsApp con IA, agenda, ventas y más en un solo lugar. Sin permanencia: pagas mes a mes, o el año con 2 meses gratis."
          accion={(p) => <button type="button" className="btn-plan" onClick={() => elegir(p)}>{`Empezar con ${p.nombre}`}<Icon n="derecha" className="" size={15} /></button>}
          pie={<p className="matiz-ayuda">{inst ? `Hoy la contratación es en modalidad institucional: ${cop(inst.precio)} por ${inst.acceso_dias} días de acceso. Los precios de los planes son la referencia comercial.` : data.simuladores ? 'Entorno de demostración · los pagos son de prueba' : data.contratacion ? 'Precios en pesos colombianos. Antes de pagar revisas tu plan, tus datos y el valor exacto.' : 'La contratación en línea está pendiente de habilitar.'}</p>} />
      )}
    </section>
    <section className="om-section plan-conditions"><h2>Antes de continuar</h2><dl>
      <div><dt>Puedes cambiar de plan</dt><dd>Durante el registro la IA te sugiere el plan que encaja con tu negocio; tú decides. Después, cambias desde tu panel cuando quieras.</dd></div>
      <div><dt>Creación después del pago</dt><dd>El panel se crea cuando el servidor confirma el pago con la pasarela. Un borrador no es una empresa activa.</dd></div>
      <div><dt>Sin cobros automáticos</dt><dd>Cada renovación la apruebas tú. WhatsApp, IA y cobros en línea dependen de sus proveedores y de la configuración de tu empresa.</dd></div>
    </dl></section>
    <Closing />
  </PublicoLayout>;
}

const PREGUNTAS = [
  ['¿Cómo empiezo?', 'Describe tu negocio en Crear mi espacio. Revisa las funciones sugeridas, completa tus datos y carga tu catálogo. Verás la propuesta antes de continuar al pago.'],
  ['¿Qué puede hacer el asistente?', 'El asistente del panel consulta datos de tu empresa con las herramientas disponibles y tus permisos. Sus respuestas incluyen recibos cuando ejecuta herramientas. La atención por WhatsApp depende de los módulos y las conexiones habilitadas.'],
  ['¿Y si el asistente no resuelve mi consulta?', 'Puedes abrir una solicitud en Soporte. El equipo de Omnegia recibe el asunto y la descripción que envíes; podrás seguir el estado, leer la respuesta y contestar desde el panel. No se adjunta automáticamente tu conversación con la IA.'],
  ['¿Cómo conecto WhatsApp?', 'En Configuración, abre WhatsApp, completa la información de tu número y utiliza Probar conexión. El resultado indica si la conexión está lista o necesita una corrección.'],
  ['¿Puedo importar mi catálogo?', 'Sí. Durante la configuración puedes cargar un archivo de productos o servicios, revisar sus columnas y confirmar la vista previa. También puedes completarlo manualmente.'],
  ['¿Omnegia emite factura electrónica?', 'Todavía no. Hoy cada venta genera un comprobante de venta en PDF para entregar a tu cliente y llevar tu registro; no es una factura electrónica ante la DIAN. La factura electrónica llegará más adelante, cuando conectemos un proveedor tecnológico autorizado.'],
];
export function Ayuda() {
  return <PublicoLayout transparente><section className="public-intro help-intro"><div><h1>Un poco de ayuda.<br /><span>Un siguiente paso claro.</span></h1><p>Encuentra cómo empezar, qué puede hacer el asistente y cómo contactar con una persona.</p></div><Link to="/soporte" className="help-human"><Icon n="persona" className="" size={32} /><h2>Hablar con el equipo</h2><p>Abre una solicitud desde tu empresa. Recibirás un radicado para seguir la atención en el panel.</p><span>Ir a soporte <Icon n="flecha" size={18} className="" /></span><small>Requiere iniciar sesión</small></Link></section>
    <section className="om-section help-content"><div><h2>Respuestas<br />para avanzar.</h2><p>Guías de las funciones disponibles en Omnegia.</p></div><div className="help-faq">{PREGUNTAS.map(([q, a]) => <details key={q}><summary>{q}<Icon n="mas" className="" size={18} /></summary><p>{a}</p></details>)}</div></section>
    <section className="om-section support-explained"><h2>Así continúa tu solicitud.</h2><ol className="support-statuses"><li><strong>Abierta</strong><p>La solicitud quedó registrada.</p></li><li><strong>En proceso</strong><p>El equipo está atendiendo el caso.</p></li><li><strong>Esperando tu respuesta</strong><p>Hay información que necesitamos de ti.</p></li><li><strong>Resuelta o cerrada</strong><p>Consulta la respuesta y el estado del caso.</p></li></ol><p>El estado se actualiza según la atención real. Las respuestas quedan en el panel y se notifican por correo.</p></section>
    <section className="om-section data-note" id="datos"><Icon n="candado" size={26} className="" /><div><h2>Tu información, con cuidado.</h2><p>El acceso al panel depende de tu empresa y tus permisos. Comparte con soporte solo lo necesario para explicar el problema; no incluyas contraseñas, códigos de acceso ni datos de tus clientes.</p><p>Para consultas sobre tu cuenta o tus datos, escribe a <a href="mailto:soporte@brianacevedo.dev">soporte@brianacevedo.dev</a>.</p></div></section>
  </PublicoLayout>;
}
