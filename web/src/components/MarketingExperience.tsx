import { Link } from 'react-router-dom';
import { Icon } from './icons';
import { SystemScene } from './SystemScene';
import { ProductTour } from './ProductTour';
import { SupportExplorer } from './SupportExplorer';

export const MODULE_COPY: Record<string, { nombre: string; beneficio: string; detalle: string }> = {
  conversaciones: { nombre: 'Conversaciones', beneficio: 'Cada conversación, con contexto.', detalle: 'Reúne los mensajes de WhatsApp y el historial del cliente. Tu equipo puede continuar la atención cuando haga falta.' },
  agenda: { nombre: 'Agenda', beneficio: 'Dale orden a cada día.', detalle: 'Organiza las citas, los servicios y la disponibilidad de quienes atienden.' },
  ventas: { nombre: 'Ventas', beneficio: 'Sigue cada pedido.', detalle: 'Registra ventas, consulta su estado y lleva el seguimiento de lo que falta por cobrar.' },
  inventario: { nombre: 'Inventario', beneficio: 'Ten claro con qué cuentas.', detalle: 'Consulta existencias y movimientos. Identifica los productos que están por debajo del mínimo.' },
  clientes: { nombre: 'Clientes', beneficio: 'Conoce mejor a tus clientes.', detalle: 'Organiza sus datos y consulta su historial con tu negocio desde el panel.' },
  catalogo: { nombre: 'Catálogo', beneficio: 'Tu oferta, organizada.', detalle: 'Administra productos y servicios. Carga tu catálogo desde un archivo o completa los datos a mano.' },
  ia: { nombre: 'Asistente IA', beneficio: 'Ayuda con límites claros.', detalle: 'Consulta información y utiliza herramientas habilitadas para tu empresa, según permisos y confirmaciones.' },
  facturacion: { nombre: 'Facturación', beneficio: 'Documentos con seguimiento.', detalle: 'Consulta documentos y sus estados. Actualmente opera en pruebas, sin validez fiscal; la emisión real requiere un proveedor conectado.' },
};

export function MarketingExperience() {
  const titulos: Record<string, string> = { conversaciones: 'Conversaciones con contexto.', agenda: 'Una agenda más clara.', ventas: 'Ventas bajo control.' };
  return <>
    <section className="om-hero" aria-labelledby="hero-title">
      <div className="hero-lattice" aria-hidden="true" />
      <div className="om-hero-inner"><div className="om-hero-copy">
        <h1 id="hero-title">Tu negocio,<br />en su mejor<br /><span>forma.</span></h1>
        <p>Conecta tus conversaciones, tu agenda y tus ventas. Atiende a tus clientes y organiza el trabajo de tu equipo desde un solo lugar.</p>
        <Link className="btn primario hero-primary" to="/empezar">Crear mi espacio <Icon n="flecha" size={19} className="" /></Link>
        <span className="hero-assurance">Elige tus módulos y revisa la propuesta antes de contratar.</span>
      </div><SystemScene /></div>
      <div className="hero-baseline"><span>Todo tu negocio. Un solo lugar.</span><ProductTour /></div>
    </section>
    <section className="om-section om-how" id="como">
      <div className="section-heading"><h2>De conocer tu negocio.<br /><span>A ponerlo en marcha.</span></h2><p>Cuéntanos cómo trabajas. Configura las herramientas que necesitas y revisa la propuesta a tu ritmo.</p></div>
      <ol className="how-steps">
        <li><span className="step-index">01</span><h3>Cuéntanos cómo trabajas.</h3><p>Describe lo que ofreces y cómo atiendes a tus clientes. Revisa y ajusta las funciones sugeridas.</p><Icon n="nota" size={28} className="" /></li>
        <li><span className="step-index">02</span><h3>Configura tu espacio.</h3><p>Elige los módulos, completa tus datos y carga tu catálogo. Revisa el detalle de la estimación antes de continuar.</p><Icon n="plataforma" size={28} className="" /></li>
        <li><span className="step-index">03</span><h3>Prepara tu operación.</h3><p>Cuando se confirma el pago, se crea tu panel. Entra y configura las conexiones que tu empresa necesita.</p><Icon n="flecha" size={28} className="" /></li>
      </ol>
    </section>
    <section className="om-modules" id="funciones"><div className="om-section">
      <div className="section-heading"><h2>Lo que tu negocio necesita.<br /><span>Conectado.</span></h2><div><p>Empieza con clientes y catálogo. Añade atención, agenda y ventas según la forma de trabajar de tu equipo.</p><Link className="text-link" to="/producto">Conocer todos los módulos <Icon n="flecha" size={18} className="" /></Link></div></div>
      <div className="module-editorial">{['conversaciones', 'agenda', 'ventas'].map((id, i) => <Link to={`/producto#${id}`} className={`module-story module-story-${i}`} key={id}>
        <div className="module-art" aria-hidden="true">{id === 'conversaciones' ? <><span className="art-message">WhatsApp</span><span className="art-message second"><Icon n="persona" size={18} className="" />Tu equipo</span><span className="art-connection" /></> : id === 'agenda' ? <div className="art-calendar"><span>L</span><span>M</span><span>M</span><span>J</span><span>V</span>{Array.from({ length: 15 }, (_, j) => <i key={j} className={[2, 6, 8, 12].includes(j) ? 'selected' : ''} />)}</div> : <div className="art-order"><Icon n="ventas" size={24} className="" /><span>Pedido</span><i /><i /><span className="order-state">Seguimiento de pago <Icon n="flecha" size={14} className="" /></span></div>}</div>
        <div className="module-story-copy"><h3>{titulos[id]}</h3><p>{MODULE_COPY[id].detalle}</p><Icon n="flecha" size={20} className="module-arrow" /></div>
      </Link>)}</div>
    </div></section>
    <section className="om-trust" id="confianza"><div className="om-section trust-inner">
      <div className="trust-copy"><h2>Tu negocio avanza.<br /><span>El control sigue contigo.</span></h2><p>La confianza se construye en cada acceso, cada permiso y cada acción que puedes revisar.</p><dl className="trust-list">
        <div><dt><Icon n="candado" size={21} className="" />Un espacio para tu empresa</dt><dd>Tu equipo consulta los datos y las herramientas de la empresa a la que tiene acceso.</dd></div>
        <div><dt><Icon n="clientes" size={21} className="" />Cada persona, con sus permisos</dt><dd>Los roles definen quién puede consultar, crear o modificar información.</dd></div>
        <div><dt><Icon n="auditoria" size={21} className="" />Acciones que dejan un registro</dt><dd>Revisa los recibos del asistente y consulta sus acciones en la auditoría de tu empresa.</dd></div>
      </dl></div>
      <div className="trust-preview" role="img" aria-label="Ejemplo ilustrativo: el asistente consulta la agenda con permiso y la acción queda registrada. Los permisos dependen del rol asignado.">
        <div className="trust-preview-head"><span><Icon n="plataforma" size={19} className="" />Tu empresa</span><Icon n="candado" size={18} className="" /></div>
        <div className="trust-access"><span className="trust-avatar"><Icon n="persona" size={25} className="" /></span><div><strong>Tu equipo</strong><span>Acceso según su rol</span></div><span className="trust-access-badge"><Icon n="ok" size={14} className="" />Con permiso</span></div>
        <div className="trust-receipt"><span className="trust-receipt-icon"><Icon n="ia" size={26} className="" /></span><span>Asistente de tu empresa</span><strong>Consultar la agenda</strong><div className="trust-check"><Icon n="ok" size={16} className="" />Permiso verificado</div><div className="trust-check"><Icon n="nota" size={16} className="" />Recibo de la herramienta</div><div className="trust-receipt-bottom"><span>Acción registrada</span><Icon n="auditoria" size={21} className="" /></div></div>
        <span className="trust-preview-note">Ejemplo ilustrativo de permisos y auditoría</span>
      </div>
    </div></section>
    <section className="om-support"><div className="om-section support-inner"><div><h2>Ayuda para el día a día.<br /><span>Personas para acompañarte.</span></h2><p>Consulta al asistente desde tu panel. Si necesitas ayuda del equipo de Omnegia, abre una solicitud y sigue las respuestas y el estado de tu caso en el mismo lugar.</p><Link to="/ayuda" className="text-link">Conocer las opciones de ayuda <Icon n="flecha" size={18} className="" /></Link></div><SupportExplorer /></div></section>
    <Closing />
  </>;
}

export function Closing() {
  return <section className="om-section om-closing"><h2>Dale a tu negocio<br />su propio espacio.</h2><div><p>Cuéntanos cómo trabajas y encuentra<br />las herramientas para tu próximo paso.</p><Link className="btn primario grande" to="/empezar">Configurar mi negocio <Icon n="flecha" size={18} className="" /></Link></div></section>;
}
