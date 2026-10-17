import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { MARCA } from '../brand';
import { Icon } from './icons';

export function SiteHeader({ oscuro = false }: { oscuro?: boolean }) {
  const [abierto, setAbierto] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const area = useRef<HTMLElement>(null);
  const location = useLocation();
  useEffect(() => { setAbierto(false); }, [location.pathname]);
  useEffect(() => {
    if (!abierto) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAbierto(false); toggle.current?.focus(); } };
    const outside = (e: PointerEvent) => { if (!area.current?.contains(e.target as Node)) setAbierto(false); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [abierto]);
  return <header ref={area} className={`site-header ${oscuro ? 'on-ink' : ''} ${abierto ? 'is-open' : ''}`}>
    <Link to="/bienvenida" className="site-brand" aria-label="Omnegia, inicio"><img src={oscuro ? MARCA.logoNegativo : MARCA.logo} alt="Omnegia" width="144" height="40" /></Link>
    <nav id="site-navigation" className="site-navigation" aria-label="Sitio público">
      <NavLink to="/producto">Producto</NavLink><NavLink to="/nosotros">Nosotros</NavLink><NavLink to="/planes">Planes</NavLink>
      <NavLink className="mobile-help" to="/ayuda">Ayuda</NavLink>
    </nav>
    <div className="site-actions"><NavLink to="/ayuda" className="desktop-help">Ayuda</NavLink><Link to="/entrar" className="site-login">Entrar <Icon n="derecha" size={14} className="" /></Link><Link to="/empezar" className="btn primario site-start">Crear mi espacio <Icon n="flecha" size={15} className="" /></Link></div>
    <button ref={toggle} type="button" className="site-menu" aria-expanded={abierto} aria-controls="site-navigation" aria-label={abierto ? 'Cerrar menú' : 'Abrir menú'} onClick={() => setAbierto(!abierto)}><Icon n={abierto ? 'x' : 'menu'} size={22} className="" /></button>
  </header>;
}

export function SiteFooter() {
  return <footer className="site-footer">
    <div className="footer-main"><div className="footer-brand"><Link to="/bienvenida"><img src={MARCA.logoNegativo} alt="Omnegia, inicio" width="160" height="44" /></Link><p>Todo tu negocio.<br />Un solo lugar.</p></div>
      <nav aria-label="Producto"><h2>La plataforma</h2><Link to="/producto">Producto y módulos</Link><Link to="/planes">Planes y configuración</Link><Link to="/nosotros">Nosotros</Link></nav>
      <nav aria-label="Ayuda y acceso"><h2>Estamos cerca</h2><Link to="/ayuda">Centro de ayuda</Link><Link to="/soporte">Solicitar atención humana</Link><Link to="/entrar">Entrar a mi empresa</Link></nav>
      <div className="footer-contact"><h2>Conversemos</h2><a href="mailto:soporte@brianacevedo.dev">soporte@brianacevedo.dev <Icon n="flecha" className="" size={15} /></a><p>Para consultas de tu cuenta, abre una solicitud desde el panel.</p></div>
    </div>
    <nav className="footer-legal" aria-label="Zona legal"><h2>Legal</h2><Link to="/terminos">Términos y condiciones</Link><Link to="/privacidad">Política de privacidad</Link><Link to="/eliminacion-de-datos">Eliminación de datos</Link><Link to="/cookies">Cookies</Link><Link to="/consumidor">Derechos del consumidor y PQR</Link><a href="https://www.sic.gov.co" target="_blank" rel="noopener noreferrer">Superintendencia de Industria y Comercio</a></nav>
    <div className="footer-bottom"><span>© {new Date().getFullYear()} Omnegia</span><span>Hecho para el día a día de tu negocio.</span><Link to="/legal">Zona legal</Link></div>
  </footer>;
}
