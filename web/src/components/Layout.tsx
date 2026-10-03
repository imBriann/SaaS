import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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
export function Menu({ boton, children, izquierda }: { boton: (abrir: () => void, abierto: boolean) => ReactNode; children: (cerrar: () => void) => ReactNode; izquierda?: boolean }) {
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
      {abierto && <div className={`menu-panel ${izquierda ? 'izq' : ''}`} role="menu">{children(() => setAbierto(false))}</div>}
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
  const enGobierno = [...gobierno.map((g) => g.to), '/simulador'].some((r) => loc.pathname.startsWith(r));
  const iniciales = data.usuario.nombre.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const salir = async () => { await api.post('/api/auth/logout'); guardar('empresa', null); window.location.href = '/entrar'; };

  return (
    <SesionCtx.Provider value={{ s: data, puede, recargar }}>
      <div className="app">
        <header className="barra-sup">
          <Link to="/" className="tenant" aria-label={`${t.nombre}, inicio`}>
            <span className="marca-negocio">{t.logo_data_url ? <img src={t.logo_data_url} alt="" /> : t.tema?.monograma ?? t.nombre.slice(0, 2)}</span>
            <b>{t.nombre}</b>
          </Link>

          <div className="centro-nav">
          <nav className="nav-app" aria-label="Operación">
            {OPERACION.filter(visible).map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'activo' : ''}`}>
                <Icon n={i.n} className="" size={18} />{i.t}{i.n === 'conversaciones' && escaladas > 0 && <span className="cont" aria-label={`${escaladas} con una persona`}>{escaladas}</span>}
              </NavLink>
            ))}
          </nav>
            {(gobierno.length > 0 || piloto) && (
              <Menu izquierda boton={(abrir, abierto) => (
                <button className={`nav-item ${enGobierno ? 'activo' : ''}`} onClick={abrir} aria-expanded={abierto} aria-haspopup="menu">
                  Administración <Icon n="abajo" className="" size={14} />
                </button>
              )}>
                {() => <>
                  {gobierno.map((i) => <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? 'activo' : '')} role="menuitem"><Icon n={i.n} className="" size={16} /> {i.t}</NavLink>)}
                  {piloto && <>
                    <div className="sep" />
                    <span className="grupo">Piloto</span>
                    <NavLink to="/simulador" className={({ isActive }) => (isActive ? 'activo' : '')} role="menuitem"><Icon n="simulador" className="" size={16} /> Simulador de WhatsApp</NavLink>
                  </>}
                </>}
              </Menu>
            )}
          </div>

          <div className="derecha">
            <Menu boton={(abrir, abierto) => <button className="avatar" onClick={abrir} aria-expanded={abierto} aria-label="Tu cuenta">{iniciales}</button>}>
              {(cerrar) => <>
                <div style={{ padding: '10px 12px 6px' }}>
                  <div style={{ fontWeight: 480 }}>{data.usuario.nombre}</div>
                  <div className="tenue" style={{ fontSize: 13 }}>{data.usuario.rol_nombre} · {t.slug}</div>
                </div>
                {data.consumo && <div style={{ padding: '10px 12px 12px' }}><Medidor c={data.consumo.tokens_ia} etiqueta="Consumo de IA del mes" oscuro /></div>}
                <div className="sep" />
                {!slugDelHost() && <button className="opcion" onClick={() => { cerrar(); nav('/empresas'); }}><Icon n="plataforma" className="" size={16} /> Cambiar de empresa</button>}
                <button className="opcion" onClick={salir}><Icon n="salir" className="" size={16} /> Cerrar sesión</button>
              </>}
            </Menu>
          </div>
        </header>
        {data.solo_lectura && <div className="aviso-banda">La suscripción está suspendida: puedes consultar y exportar tus datos, pero no registrar cambios. El canal de WhatsApp está pausado.</div>}
        <main className="pagina">
          <Outlet />
        </main>
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
