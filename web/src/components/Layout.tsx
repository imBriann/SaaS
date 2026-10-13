import { cloneElement, createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, guardar, slugDelHost, tenantSlug } from '../api';
import { useApi, Medidor, Cargando } from './ui';
import { Icon } from './icons';

export interface Sesion {
  usuario: { id: string; nombre: string; rol: string; rol_nombre: string };
  tenant: any;
  modulos: string[];
  permisos: string[];
  solo_lectura: boolean;
  consumo: any;
}
const SesionCtx = createContext<{ s: Sesion; puede: (p: string) => boolean; recargar: () => void } | null>(null);
export const useSesion = () => useContext(SesionCtx)!;

export const AVISO_SOLO_LECTURA = 'aviso-solo-lectura';
const MOTIVO_SOLO_LECTURA = 'Suscripción suspendida: solo lectura. Consulta el estado en Suscripción.';
/**
 * Acción de escritura: sin permiso del rol o con el módulo apagado no se muestra; con la
 * suscripción suspendida se ve deshabilitada y enlazada al aviso que explica por qué.
 * Solo evita ofrecer lo que el servidor rechazará: la autorización sigue en el servidor.
 */
export function Escritura({ permiso, modulo, children }: { permiso: string; modulo?: string; children: ReactElement<any> }) {
  const { s, puede } = useSesion();
  if (!puede(permiso) || (modulo && !s.modulos.includes(modulo))) return null;
  if (!s.solo_lectura) return children;
  return cloneElement(children, { disabled: true, onClick: undefined, title: MOTIVO_SOLO_LECTURA, 'aria-describedby': AVISO_SOLO_LECTURA, 'data-solo-lectura': '' });
}

/**
 * Tema del tenant (D-07): el único color de acción del panel sale del logotipo.
 * `acento` rellena la acción principal; `acento_sobre_oscuro` es su versión
 * legible sobre el lienzo oscuro (enlaces, estados activos, tintes).
 */
function aplicarTema(tema: any) {
  const r = document.documentElement.style;
  if (!tema) return;
  r.setProperty('--acento', tema.acento);
  // The workspace now uses light surfaces; the dark button shade is readable on them.
  r.setProperty('--acento-claro', tema.acento);
  r.setProperty('--sobre-acento', tema.texto_sobre_acento ?? '#ffffff');
}

type Item = { to: string; n: string; t: string; permiso?: string; modulo?: string };
const OPERACION: Item[] = [
  { to: '/', n: 'inicio', t: 'Inicio' },
  { to: '/conversaciones', n: 'conversaciones', t: 'Conversaciones', permiso: 'conversation:read', modulo: 'conversaciones' },
  { to: '/clientes', n: 'clientes', t: 'Clientes', permiso: 'customer:read' },
  { to: '/ventas', n: 'ventas', t: 'Ventas', permiso: 'order:read', modulo: 'ventas' },
  { to: '/agenda', n: 'agenda', t: 'Agenda', permiso: 'appointment:read', modulo: 'agenda' },
  { to: '/inventario', n: 'inventario', t: 'Catálogo', permiso: 'catalog:read' },
  { to: '/facturacion', n: 'facturacion', t: 'Facturación', permiso: 'invoice:read', modulo: 'facturacion' },
];
const GOBIERNO: Item[] = [
  { to: '/ia', n: 'ia', t: 'Centro de IA', permiso: 'ai:read', modulo: 'ia' },
  { to: '/configuracion', n: 'configuracion', t: 'Configuración', permiso: 'tenant:configure' },
  { to: '/suscripcion', n: 'suscripcion', t: 'Suscripción', permiso: 'subscription:manage' },
  { to: '/auditoria', n: 'auditoria', t: 'Auditoría', permiso: 'audit:read' },
];

/** Menú desplegable accesible: se cierra al elegir, con Escape o al hacer clic fuera. */
export function Menu({ boton, children, izquierda, arriba }: { boton: (abrir: () => void, abierto: boolean) => ReactNode; children: (cerrar: () => void) => ReactNode; izquierda?: boolean; arriba?: boolean }) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setAbierto(false), [loc.pathname]);
  useEffect(() => {
    if (!abierto) return;
    const fuera = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setAbierto(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setAbierto(false);
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fuera); document.removeEventListener('keydown', esc); };
  }, [abierto]);
  return (
    <div className="menu" ref={ref}>
      {boton(() => setAbierto((v) => !v), abierto)}
      {abierto && <div className={`menu-panel ${izquierda ? 'izq' : ''} ${arriba ? 'arriba' : ''}`} role="menu">{children(() => setAbierto(false))}</div>}
    </div>
  );
}

export function PanelLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const slug = tenantSlug();
  const { data, error, recargar } = useApi<Sesion>(() => api.get('/api/t/yo'), [slug]);
  useEffect(() => { if (data) aplicarTema(data.tenant.tema); }, [data]);
  const inbox = useApi<any>(() => (data && data.permisos.includes('conversation:read') ? api.get('/api/t/conversaciones?filtro=escaladas') : Promise.resolve(null)), [data?.tenant?.id], { cada: 15000 });
  // Navegación en cajón (móvil): se cierra al cambiar de ruta o con Escape.
  const [navAbierta, setNavAbierta] = useState(false);
  useEffect(() => setNavAbierta(false), [loc.pathname]);
  useEffect(() => {
    if (!navAbierta) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNavAbierta(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [navAbierta]);

  if (!slug) return <Navigate to="/entrar" replace />;
  if (error?.status === 401) return <Navigate to={`/entrar?volver=${encodeURIComponent(loc.pathname)}`} replace />;
  if (error?.status === 404) {
    return (
      <div className="publico" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="tarjeta pad col" style={{ maxWidth: 440, gap: 16 }}>
          <div className="bloqueado"><Icon n="candado" className="" size={16} /> No encontramos eso.</div>
          <p className="sec">Esta empresa no existe o tu cuenta no tiene acceso a ella.</p>
          <button className="btn" onClick={() => { guardar('empresa', null); nav('/empresas'); }}>Elegir otra empresa</button>
        </div>
      </div>
    );
  }
  if (!data) return <div className="pagina"><Cargando filas={6} /></div>;

  const puede = (p: string) => data.permisos.includes(p);
  const visible = (i: Item) => (!i.permiso || puede(i.permiso)) && (!i.modulo || data.modulos.includes(i.modulo));
  const t = data.tenant;
  const escaladas = inbox.data?.contadores?.escaladas ?? 0;
  const gobierno = GOBIERNO.filter(visible);
  const piloto = puede('conversation:read');
  const iniciales = data.usuario.nombre.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const salir = async () => { await api.post('/api/auth/logout'); guardar('empresa', null); window.location.href = '/entrar'; };
  const marca = <span className="marca-negocio" aria-hidden="true">{t.logo_data_url ? <img src={t.logo_data_url} alt="" /> : t.tema?.monograma ?? t.nombre.slice(0, 2)}</span>;
  const enlace = (i: Item) => (
    <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'activo' : ''}`}>
      <Icon n={i.n} className="" size={18} />{i.t}{i.n === 'conversaciones' && escaladas > 0 && <span className="cont" aria-label={`${escaladas} con una persona`}>{escaladas}</span>}
    </NavLink>
  );

  return (
    <SesionCtx.Provider value={{ s: data, puede, recargar }}>
      <div className={`app ${navAbierta ? 'nav-abierta' : ''}`}>
        <header className="barra-movil">
          <button className="btn sutil icono" onClick={() => setNavAbierta(true)} aria-expanded={navAbierta} aria-controls="nav-lateral" aria-label="Abrir menú"><Icon n="menu" className="" size={20} /></button>
          <Link to="/" className="contexto" aria-label={`${t.nombre}, inicio`}>{marca}<span className="contexto-txt"><b>{t.nombre}</b></span></Link>
          {escaladas > 0 && piloto && <Link to="/conversaciones" className="estado info" aria-label={`${escaladas} conversaciones con una persona`}><Icon n="persona" className="" />{escaladas}</Link>}
        </header>

        <aside className="lateral" id="nav-lateral" aria-label="Navegación del panel">
          {/* Contexto visible (P1). El servidor valida la pertenencia: esto solo informa. */}
          <Link to="/" className="contexto" aria-label={`${t.nombre}, inicio`}>
            {marca}
            <span className="contexto-txt"><b>{t.nombre}</b><span>{data.usuario.rol_nombre}</span></span>
          </Link>
          <nav className="nav-grupo" aria-label="Operación">
            <span className="nav-titulo">Operación</span>
            {OPERACION.filter(visible).map(enlace)}
          </nav>
          {(gobierno.length > 0 || piloto) && (
            <nav className="nav-grupo" aria-label="Gobierno">
              <span className="nav-titulo">Gobierno</span>
              {gobierno.map(enlace)}
              {piloto && (
                <NavLink to="/simulador" className={({ isActive }) => `nav-item ${isActive ? 'activo' : ''}`}>
                  <Icon n="simulador" className="" size={18} />Simulador<span className="marca-piloto">Piloto</span>
                </NavLink>
              )}
            </nav>
          )}
          <div className="cuenta">
            <Menu arriba boton={(abrir, abierto) => (
              <button className="cuenta-btn" onClick={abrir} aria-expanded={abierto} aria-haspopup="menu" aria-label={`Tu cuenta: ${data.usuario.nombre}`}>
                <span className="avatar">{iniciales}</span>
                <span><b className="cortar">{data.usuario.nombre}</b><small className="cortar">{t.slug}</small></span>
                <Icon n="arriba_abajo" className="" size={16} />
              </button>
            )}>
              {(cerrar) => <>
                <div className="bloque">
                  <div style={{ fontWeight: 600 }}>{data.usuario.nombre}</div>
                  <div className="tenue peq-txt">{data.usuario.rol_nombre} · {t.slug}</div>
                </div>
                {data.consumo && <div className="bloque"><Medidor c={data.consumo.tokens_ia} etiqueta="Consumo de IA del mes" oscuro /></div>}
                <div className="sep" />
                {!slugDelHost() && <button className="opcion" role="menuitem" onClick={() => { cerrar(); nav('/empresas'); }}><Icon n="plataforma" className="" size={16} /> Cambiar de empresa</button>}
                <button className="opcion" role="menuitem" onClick={salir}><Icon n="salir" className="" size={16} /> Cerrar sesión</button>
              </>}
            </Menu>
          </div>
        </aside>
        <div className="velo-nav" onClick={() => setNavAbierta(false)} aria-hidden="true" />

        <div className="marco">
          {data.solo_lectura && <div className="aviso-banda" role="status" id={AVISO_SOLO_LECTURA}><Icon n="candado" className="" size={16} /><span>La suscripción está suspendida: puedes consultar y exportar tus datos, pero no registrar cambios. El canal de WhatsApp está pausado.{puede('subscription:manage') && <> <Link to="/suscripcion">Ver la suscripción</Link></>}</span></div>}
          <main className="pagina">
            <Outlet />
          </main>
        </div>
      </div>
    </SesionCtx.Provider>
  );
}

export function Cabecera({ titulo, sub, children }: { titulo: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="cabecera">
      <div><h1 className="titulo">{titulo}</h1>{sub && <div className="sub">{sub}</div>}</div>
      {children && <div className="acciones">{children}</div>}
    </header>
  );
}
