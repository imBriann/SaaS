import { cloneElement, createContext, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api, fecha, guardar, setZona, slugDelHost, tenantSlug } from '../api';
import { useApi, Medidor, Cargando, Modal, Campo, useAccion, CodigoOtp, useCuentaAtras, useToast } from './ui';
import { Icon } from './icons';
import { MARCA } from '../brand';
import { WorkspaceBirth } from './WorkspaceBirth';

export interface Sesion {
  usuario: { id: string; nombre: string; rol: string; rol_nombre: string; email: string | null; correo_verificado: boolean };
  tenant: any;
  modulos: string[];
  permisos: string[];
  solo_lectura: boolean;
  consumo: any;
  simuladores: boolean;
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

/** Tema del tenant: el único color de acción del panel sale del logotipo del negocio. */
function aplicarTema(tema: any) {
  const r = document.documentElement.style;
  if (!tema) return;
  r.setProperty('--acento', tema.acento);
  r.setProperty('--acento-claro', tema.acento);
  r.setProperty('--sobre-acento', tema.texto_sobre_acento ?? '#ffffff');
}

type Item = { to: string; n: string; t: string; permiso?: string; modulo?: string; movil?: boolean };
const OPERACION: Item[] = [
  { to: '/', n: 'inicio', t: 'Inicio', movil: true },
  { to: '/conversaciones', n: 'conversaciones', t: 'Conversaciones', permiso: 'conversation:read', modulo: 'conversaciones', movil: true },
  { to: '/agenda', n: 'agenda', t: 'Agenda', permiso: 'appointment:read', modulo: 'agenda', movil: true },
  { to: '/ventas', n: 'ventas', t: 'Ventas', permiso: 'order:read', modulo: 'ventas', movil: true },
  { to: '/clientes', n: 'clientes', t: 'Clientes', permiso: 'customer:read' },
  { to: '/inventario', n: 'inventario', t: 'Catálogo', permiso: 'catalog:read' },
  { to: '/facturacion', n: 'facturacion', t: 'Facturación', permiso: 'invoice:read', modulo: 'facturacion' },
];
const GOBIERNO: Item[] = [
  { to: '/ia', n: 'ia', t: 'Centro de IA', permiso: 'ai:read', modulo: 'ia' },
  { to: '/configuracion', n: 'configuracion', t: 'Configuración', permiso: 'tenant:configure' },
  { to: '/suscripcion', n: 'suscripcion', t: 'Suscripción', permiso: 'subscription:manage' },
  { to: '/auditoria', n: 'auditoria', t: 'Auditoría', permiso: 'audit:read' },
  { to: '/soporte', n: 'soporte', t: 'Soporte' },
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

function CambiarContrasena({ onCerrar }: { onCerrar: () => void }) {
  const [f, setF] = useState({ actual: '', nueva: '', repetir: '' });
  const { run, ocupado } = useAccion();
  const distintas = f.repetir.length > 0 && f.nueva !== f.repetir;
  return (
    <Modal titulo="Cambiar contraseña" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || f.nueva.length < 10 || f.nueva !== f.repetir || !f.actual} onClick={async () => { const r = await run(() => api.post('/api/auth/cambiar-contrasena', { actual: f.actual, nueva: f.nueva }), 'Contraseña actualizada. Cerramos tus otras sesiones.'); if (r) onCerrar(); }}>Guardar</button></>}>
      <Campo etiqueta="Contraseña actual"><input className="input" type="password" autoComplete="current-password" value={f.actual} onChange={(e) => setF({ ...f, actual: e.target.value })} /></Campo>
      <Campo etiqueta="Nueva contraseña" ayuda="mínimo 10 caracteres"><input className="input" type="password" autoComplete="new-password" value={f.nueva} onChange={(e) => setF({ ...f, nueva: e.target.value })} /></Campo>
      <Campo etiqueta="Repite la nueva contraseña" error={distintas ? 'No coincide con la nueva contraseña.' : undefined}><input className="input" type="password" autoComplete="new-password" value={f.repetir} onChange={(e) => setF({ ...f, repetir: e.target.value })} /></Campo>
      <p className="tenue peq-txt">Al cambiarla se cierran tus sesiones en otros dispositivos.</p>
    </Modal>
  );
}

/** Correo sin confirmar: se pide un código de seis dígitos enviado a ese correo. */
function AvisoCorreo({ s, onVerificado }: { s: Sesion; onVerificado: () => void }) {
  const [abierto, setAbierto] = useState(false);
  return (
    <>
      <div className="aviso-banda" role="status">
        <Icon n="correo" className="" size={16} />
        <span>Confirma tu correo{s.usuario.email ? <> <b>{s.usuario.email}</b></> : ''} para invitar a tu equipo y recibir los avisos de seguridad de tu cuenta.</span>
        <button className="btn peq primario" onClick={() => setAbierto(true)}>Confirmar correo</button>
      </div>
      {abierto && <VerificarCorreo email={s.usuario.email} onCerrar={() => setAbierto(false)} onVerificado={() => { setAbierto(false); onVerificado(); }} />}
    </>
  );
}

/**
 * El código pudo llegar ya (al crear la cuenta): el campo se muestra de inmediato y
 * pedir uno nuevo es una acción secundaria, con la misma espera que aplica el servidor.
 */
export function VerificarCorreo({ email, onCerrar, onVerificado }: { email: string | null; onCerrar: () => void; onVerificado: () => void }) {
  const [codigo, setCodigo] = useState('');
  const [destino, setDestino] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const toast = useToast();
  const espera = useCuentaAtras();
  const llamar = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setOcupado(true); setError(null);
    try { return await fn(); } catch (e) {
      const s = ((e as any).details as any)?.espera_segundos;
      if (s) espera.iniciar(s); else setError(e as Error);
      return undefined;
    } finally { setOcupado(false); }
  };
  const enviar = async () => {
    const r = await llamar(() => api.post('/api/auth/verificacion/enviar'));
    if (r?.ya_verificado) { toast('Tu correo ya estaba confirmado.'); return onVerificado(); }
    if (r) { setDestino(r.destino); setCodigo(''); espera.iniciar(60); toast('Te enviamos un código nuevo.'); }
  };
  const confirmar = async () => {
    const r = await llamar(() => api.post('/api/auth/verificacion/confirmar', { codigo }));
    if (r) { toast('Correo confirmado.'); onVerificado(); }
  };
  return (
    <Modal titulo="Confirma tu correo" onCerrar={onCerrar} pie={<>
      <button className="btn" disabled={ocupado || espera.restante > 0} onClick={enviar}>{espera.restante > 0 ? `Código nuevo en ${espera.restante} s` : 'Enviarme un código nuevo'}</button>
      <button className="btn primario" disabled={ocupado || codigo.length !== 6} onClick={confirmar}>{ocupado ? 'Comprobando…' : 'Confirmar'}</button>
    </>}>
      <p className="sec">Escribe el código de seis dígitos que enviamos a <b>{destino ?? email ?? 'tu correo'}</b>. Si no lo encuentras, revisa la carpeta de spam o pide uno nuevo: cada código vence a los pocos minutos y solo sirve una vez.</p>
      <CodigoOtp valor={codigo} onCambio={setCodigo} autoFocus />
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
  );
}

/** Aviso del estado de la suscripción: qué pasa y qué hacer, con el pago a un clic. */
function AvisoSuscripcion({ s, puede }: { s: Sesion; puede: (p: string) => boolean }) {
  const { run, ocupado } = useAccion();
  const estado = s.tenant.suscripcion;
  if (!['PAGO_PENDIENTE', 'EN_GRACIA', 'SUSPENDIDA'].includes(estado)) return null;
  const pagar = async () => { const r = await run(() => api.post('/api/t/suscripcion/pagar')); if (r?.url) window.location.assign(r.url.startsWith(window.location.origin) ? r.url.replace(window.location.origin, '') : r.url); };
  const textos: Record<string, string> = {
    PAGO_PENDIENTE: `Tu suscripción venció${s.tenant.periodo_fin ? ` el ${fecha(s.tenant.periodo_fin)}` : ''}. Todo sigue funcionando; renueva para evitar interrupciones.`,
    EN_GRACIA: 'Tu suscripción está en periodo de gracia. Si no se registra el pago, la cuenta pasará a solo lectura y el agente dejará de atender WhatsApp.',
    SUSPENDIDA: 'La suscripción está suspendida: puedes consultar y exportar tus datos, pero no registrar cambios. El canal de WhatsApp está pausado.',
  };
  return (
    <div className={`aviso-banda ${estado === 'SUSPENDIDA' ? 'grave' : ''}`} role="status" id={estado === 'SUSPENDIDA' ? AVISO_SOLO_LECTURA : undefined}>
      <Icon n={estado === 'SUSPENDIDA' ? 'candado' : 'reloj'} className="" size={16} />
      <span>{textos[estado]}</span>
      {puede('subscription:manage') ? <button className="btn peq primario" disabled={ocupado} onClick={pagar}>{ocupado ? 'Preparando…' : estado === 'SUSPENDIDA' ? 'Pagar y reactivar' : 'Renovar ahora'}</button> : <span className="peq-txt">Avisa a quien administra la empresa.</span>}
    </div>
  );
}

export function PanelLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const slug = tenantSlug();
  const { data, error, recargar } = useApi<Sesion>(() => api.get('/api/t/yo'), [slug]);
  useEffect(() => { if (data) { aplicarTema(data.tenant.tema); setZona(data.tenant.zona_horaria); document.title = `${data.tenant.nombre} · ${MARCA.nombre}`; } }, [data]);
  const inbox = useApi<any>(() => (data && data.permisos.includes('conversation:read') && data.modulos.includes('conversaciones') ? api.get('/api/t/conversaciones?filtro=escaladas') : Promise.resolve(null)), [data?.tenant?.id], { cada: 20000 });
  const [navAbierta, setNavAbierta] = useState(false);
  const [contrasena, setContrasena] = useState(false);
  useEffect(() => setNavAbierta(false), [loc.pathname]);
  useEffect(() => {
    if (!navAbierta) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNavAbierta(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [navAbierta]);

  if (!slug) return <Navigate to={`/entrar?volver=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (error?.status === 401) return <Navigate to={`/entrar?volver=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (error?.status === 404) {
    return (
      <div className="publico" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="tarjeta pad col" style={{ maxWidth: 440, gap: 16 }}>
          <div className="bloqueado"><Icon n="candado" className="" size={16} /> No encontramos eso.</div>
          <p className="sec">Esta empresa no existe o tu cuenta ya no tiene acceso a ella.</p>
          <button className="btn" onClick={() => { guardar('empresa', null); nav('/empresas'); }}>Elegir otra empresa</button>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="publico" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="tarjeta pad col" style={{ maxWidth: 440, gap: 16 }}>
          <div className="aviso" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>
          <button className="btn primario" onClick={recargar}>Reintentar</button>
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
  const piloto = puede('conversation:read') && data.simuladores;
  const iniciales = data.usuario.nombre.split(' ').map((w) => w[0]).slice(0, 2).join('');
  const salir = async (todas = false) => { await api.post(todas ? '/api/auth/logout-todas' : '/api/auth/logout').catch(() => {}); guardar('empresa', null); window.location.href = '/entrar'; };
  const marca = <span className="marca-negocio" aria-hidden="true">{t.logo_data_url ? <img src={t.logo_data_url} alt="" /> : t.tema?.monograma ?? t.nombre.slice(0, 2)}</span>;
  const enlace = (i: Item) => (
    <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `nav-item ${isActive ? 'activo' : ''}`}>
      <Icon n={i.n} className="" size={18} />{i.t}{i.n === 'conversaciones' && escaladas > 0 && <span className="cont" aria-label={`${escaladas} con una persona`}>{escaladas}</span>}
    </NavLink>
  );
  const movil = OPERACION.filter((i) => i.movil && visible(i)).slice(0, 4);

  return (
    <SesionCtx.Provider value={{ s: data, puede, recargar }}>
      <WorkspaceBirth nombre={t.nombre}>
      <div className={`app ${navAbierta ? 'nav-abierta' : ''}`}>
        <a className="saltar" href="#contenido">Saltar al contenido</a>
        <header className="barra-movil">
          <Link to="/" className="contexto" aria-label={`${t.nombre}, inicio`}>{marca}<span className="contexto-txt"><b>{t.nombre}</b><span>{data.usuario.rol_nombre}</span></span></Link>
          {escaladas > 0 && visible(OPERACION[1]) && <Link to="/conversaciones" className="estado info" aria-label={`${escaladas} conversaciones con una persona`}><Icon n="persona" className="" />{escaladas}</Link>}
        </header>

        <aside className="lateral" id="nav-lateral" aria-label="Navegación del panel">
          <Link to="/" className="contexto" aria-label={`${t.nombre}, inicio`}>
            {marca}
            <span className="contexto-txt"><b>{t.nombre}</b><span>{data.usuario.rol_nombre}</span></span>
          </Link>
          <nav className="nav-grupo" aria-label="Operación">
            <span className="nav-titulo">Operación</span>
            {OPERACION.filter(visible).map(enlace)}
          </nav>
          {(gobierno.length > 0 || piloto) && (
            <nav className="nav-grupo" aria-label="Administración de la empresa">
              <span className="nav-titulo">Tu empresa</span>
              {gobierno.map(enlace)}
              {piloto && (
                <NavLink to="/simulador" className={({ isActive }) => `nav-item ${isActive ? 'activo' : ''}`}>
                  <Icon n="simulador" className="" size={18} />Simulador<span className="marca-piloto">Pruebas</span>
                </NavLink>
              )}
            </nav>
          )}
          <div className="cuenta">
            <Menu arriba boton={(abrir, abierto) => (
              <button className="cuenta-btn" onClick={abrir} aria-expanded={abierto} aria-haspopup="menu" aria-label={`Tu cuenta: ${data.usuario.nombre}`}>
                <span className="avatar">{iniciales}</span>
                <span><b>{data.usuario.nombre}</b><small>{t.slug}</small></span>
                <Icon n="arriba_abajo" className="" size={16} />
              </button>
            )}>
              {(cerrar) => <>
                <div className="bloque">
                  <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{data.usuario.nombre}</div>
                  <div className="tenue peq-txt">{data.usuario.rol_nombre} · {t.nombre}</div>
                </div>
                {data.consumo && <div className="bloque"><Medidor c={data.consumo.tokens_ia} etiqueta="Consumo de IA del mes" oscuro /></div>}
                <div className="sep" />
                {!slugDelHost() && <button className="opcion" role="menuitem" onClick={() => { cerrar(); nav('/empresas'); }}><Icon n="plataforma" className="" size={16} /> Cambiar de empresa</button>}
                <button className="opcion" role="menuitem" onClick={() => { cerrar(); setContrasena(true); }}><Icon n="candado" className="" size={16} /> Cambiar contraseña</button>
                <button className="opcion" role="menuitem" onClick={() => salir(false)}><Icon n="salir" className="" size={16} /> Cerrar sesión</button>
                <button className="opcion" role="menuitem" onClick={() => salir(true)}><Icon n="salir" className="" size={16} /> Cerrar sesión en todos los dispositivos</button>
              </>}
            </Menu>
            <a className="firma-marca" href="/bienvenida" aria-label={`${MARCA.nombre}: conoce la plataforma`}><img src={MARCA.icono} alt="" width={16} height={16} />con {MARCA.nombre}</a>
          </div>
        </aside>
        <div className="velo-nav" onClick={() => setNavAbierta(false)} aria-hidden="true" />

        <div className="marco">
          <AvisoSuscripcion s={data} puede={puede} />
          {!data.usuario.correo_verificado && <AvisoCorreo s={data} onVerificado={recargar} />}
          <main className="pagina" id="contenido" tabIndex={-1}>
            <Outlet />
          </main>
        </div>

        <nav className="tabbar" aria-label="Navegación principal">
          {movil.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/'} className={({ isActive }) => `tab ${isActive ? 'activo' : ''}`}>
              <span className="tab-ico"><Icon n={i.n} className="" size={20} />{i.n === 'conversaciones' && escaladas > 0 && <span className="punto" aria-hidden="true" />}</span>
              <span>{i.t}</span>{i.n === 'conversaciones' && escaladas > 0 && <span className="sr"> ({escaladas} con una persona)</span>}
            </NavLink>
          ))}
          <button type="button" className={`tab ${navAbierta ? 'activo' : ''}`} onClick={() => setNavAbierta(true)} aria-expanded={navAbierta} aria-controls="nav-lateral">
            <span className="tab-ico"><Icon n="menu" className="" size={20} /></span><span>Más</span>
          </button>
        </nav>
      </div>
      {contrasena && <CambiarContrasena onCerrar={() => setContrasena(false)} />}
      </WorkspaceBirth>
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
