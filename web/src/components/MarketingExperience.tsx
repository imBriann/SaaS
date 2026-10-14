import { Link } from 'react-router-dom';
import { Icon } from './icons';
import { SystemScene } from './SystemScene';

export const MODULE_COPY: Record<string, { nombre: string; beneficio: string; detalle: string }> = {
  conversaciones: { nombre: 'Conversaciones', beneficio: 'La atención tiene un lugar.', detalle: 'Reúne los mensajes de WhatsApp y el historial. Tu equipo retoma la conversación cuando se necesita una persona.' },
  agenda: { nombre: 'Agenda', beneficio: 'Dale orden a cada día.', detalle: 'Organiza las citas, los servicios y la disponibilidad de quienes atienden.' },
  ventas: { nombre: 'Ventas', beneficio: 'Sigue cada pedido.', detalle: 'Registra ventas, consulta su estado y lleva el seguimiento de lo que falta por cobrar.' },
  inventario: { nombre: 'Inventario', beneficio: 'Sabe con qué cuentas.', detalle: 'Consulta existencias, movimientos y alertas de productos bajo mínimo.' },
  clientes: { nombre: 'Clientes', beneficio: 'Conoce a quien vuelve.', detalle: 'Mantén un directorio de clientes y consulta su historial desde el panel.' },
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
        <p>Conversaciones, agenda y ventas conectadas. Un espacio para atender mejor y llevar tu negocio con claridad.</p>
        <Link className="btn primario hero-primary" to="/empezar">Crear mi espacio <Icon n="flecha" size={19} className="" /></Link>
        <span className="hero-assurance">Configura primero. Revisa antes de contratar.</span>
      </div><SystemScene /></div>
      <div className="hero-baseline"><span>Todo tu negocio. Un solo lugar.</span><a href="#como">Descubre cómo funciona <Icon n="abajo" size={16} className="" /></a></div>
    </section>
    <section className="om-section om-how" id="como">
      <div className="section-heading"><h2>De tu idea.<br /><span>A tu día a día.</span></h2><p>Empieza con lo que necesitas hoy. Omnegia organiza la configuración; tú revisas cada decisión.</p></div>
      <ol className="how-steps">
        <li><span className="step-index">01</span><h3>Cuéntanos qué haces.</h3><p>Describe tu negocio y revisa la propuesta de funciones. Puedes corregirla.</p><Icon n="nota" size={28} className="" /></li>
        <li><span className="step-index">02</span><h3>Hazlo tuyo.</h3><p>Elige módulos, añade tus datos y carga tu catálogo. Conoce la estimación antes de seguir.</p><Icon n="plataforma" size={28} className="" /></li>
        <li><span className="step-index">03</span><h3>Entra a tu espacio.</h3><p>Tras confirmar el pago, se prepara tu panel. Completa las conexiones pendientes desde Configuración.</p><Icon n="flecha" size={28} className="" /></li>
      </ol>
    </section>
    <section className="om-modules" id="funciones"><div className="om-section">
      <div className="section-heading"><h2>Las piezas correctas.<br /><span>Trabajando juntas.</span></h2><div><p>Una plataforma modular para tu operación. Clientes y catálogo forman la base de tu espacio.</p><Link className="text-link" to="/producto">Explorar todos los módulos <Icon n="flecha" size={18} className="" /></Link></div></div>
      <div className="module-editorial">{['conversaciones', 'agenda', 'ventas'].map((id, i) => <Link to={`/producto#${id}`} className={`module-story module-story-${i}`} key={id}>
        <div className="module-art" aria-hidden="true">{id === 'conversaciones' ? <><span className="art-message">WhatsApp</span><span className="art-message second"><Icon n="persona" size={18} className="" />Tu equipo</span><span className="art-connection" /></> : id === 'agenda' ? <div className="art-calendar"><span>L</span><span>M</span><span>M</span><span>J</span><span>V</span>{Array.from({ length: 15 }, (_, j) => <i key={j} className={[2, 6, 8, 12].includes(j) ? 'selected' : ''} />)}</div> : <div className="art-order"><Icon n="ventas" size={24} className="" /><span>Pedido</span><i /><i /><span className="order-state">Seguimiento de pago <Icon n="flecha" size={14} className="" /></span></div>}</div>
        <div className="module-story-copy"><h3>{titulos[id]}</h3><p>{MODULE_COPY[id].detalle}</p><Icon n="flecha" size={20} className="module-arrow" /></div>
      </Link>)}</div>
    </div></section>
    <section className="om-section om-trust" id="confianza"><div className="trust-seal" aria-hidden="true"><Icon n="auditoria" size={72} className="" /><span>Tu negocio<br />tiene el control.</span></div><div><h2>La confianza también<br />se construye por dentro.</h2><dl className="trust-list">
      <div><dt>Un espacio para cada empresa</dt><dd>Los datos y las herramientas se consultan dentro de la empresa a la que tienes acceso.</dd></div>
      <div><dt>Permisos para cada persona</dt><dd>Los roles determinan quién puede consultar, crear o modificar información.</dd></div>
      <div><dt>Acciones que puedes revisar</dt><dd>Las ejecuciones del asistente muestran sus recibos y quedan en el registro de auditoría.</dd></div>
    </dl></div></section>
    <section className="om-support"><div className="om-section support-inner"><div><h2>Tecnología que ayuda.<br /><span>Personas cuando hacen falta.</span></h2><p>El asistente trabaja con las herramientas y permisos disponibles. Si necesitas acompañamiento, abre una solicitud al equipo de Omnegia y sigue su estado desde tu panel.</p><Link to="/ayuda" className="text-link">Conoce cómo te acompañamos <Icon n="flecha" size={18} className="" /></Link></div><div className="support-path" aria-label="Flujo de asistencia"><span><Icon n="ia" size={22} className="" />Asistente de tu empresa</span><i aria-hidden="true" /><span><Icon n="persona" size={22} className="" />Atención humana</span><small>Solicitud · seguimiento · respuesta</small></div></div></section>
    <Closing />
  </>;
}

export function Closing() {
  return <section className="om-section om-closing"><h2>Haz espacio<br />para lo que sigue.</h2><div><p>Tu negocio tiene su forma de trabajar.<br />Empecemos por conocerla.</p><Link className="btn primario grande" to="/empezar">Configurar mi negocio <Icon n="flecha" size={18} className="" /></Link></div></section>;
}
