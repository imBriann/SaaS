import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, cop, guardar, leer, slugDelHost } from '../../api';
import { debeConsultar, faseCierre, pasosCumplidos, type FaseCierre } from './cierre';
import { Campo, Cargando, ErrorCarga, Estado, CicloFiscal, useAccion, Vacio, CodigoOtp, useCuentaAtras } from '../../components/ui';
import { Quote } from '../../components/Quote';
import { MarketingExperience } from '../../components/MarketingExperience';
import { SiteHeader, SiteFooter } from '../../components/SiteChrome';
import { WorkspaceAssembly } from '../../components/SystemScene';
import { Icon } from '../../components/icons';
import { MARCA } from '../../brand';

/** Estado del alta visible en la cabecera: borrador, pago verificado y aprovisionamiento no se confunden. */
export type EstadoAlta = { tono: 'neutro' | 'warn' | 'ok' | 'err'; icono: string; texto: string };
const BORRADOR: EstadoAlta = { tono: 'neutro', icono: 'reloj', texto: 'Borrador guardado · tu panel aún no existe' };

/** `hechos`: pasos realmente cumplidos; por defecto, los anteriores al actual. */
export function PublicoLayout({ children, paso, hechos, transparente, estado, notaAlta }: { children: ReactNode; paso?: number; hechos?: number; transparente?: boolean; estado?: EstadoAlta; notaAlta?: string }) {
  const pasos = ['Tu negocio', 'Funciones', 'Datos', 'Catálogo', 'Propuesta y pago', 'Tu panel'];
  const n = hechos ?? paso ?? 0;
  const e = estado ?? (paso === 0 ? { tono: 'neutro', icono: 'nota', texto: 'Empieza con una descripción de tu negocio' } : BORRADOR);
  const pasosRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const actual = pasosRef.current?.querySelector<HTMLElement>('[aria-current="step"]');
    if (actual && pasosRef.current) pasosRef.current.scrollLeft = Math.max(0, actual.offsetLeft - pasosRef.current.offsetLeft - 15);
  }, [paso]);
  return (
    <div className={`publico ${transparente ? 'marketing' : ''} ${paso !== undefined ? 'onboarding' : ''}`}>
      <a className="saltar" href="#public-content">Saltar al contenido</a>
      {paso === undefined ? <SiteHeader oscuro={transparente} /> : <header className="nav onboarding-nav">
        <Link to="/bienvenida" className="marca-logo" aria-label={`${MARCA.nombre}, inicio`}><img src={MARCA.logo} alt={MARCA.nombre} width={132} height={40} /></Link>
        <span className={`estado ${e.tono} borrador`} role="status"><Icon n={e.icono} className="" />{e.texto}</span>
      </header>}
      {paso !== undefined && (
        <div className="centro" style={{ paddingBottom: 0, paddingTop: 8 }}>
          <ol ref={pasosRef} className="pasos-onb" aria-label={n >= pasos.length ? 'Alta completada' : `Paso ${paso + 1} de ${pasos.length}`}>
            {pasos.map((p, i) => <li key={p} className={`p ${i < n ? 'hecho' : i === paso ? 'on' : ''}`} aria-current={i === paso && i >= n ? 'step' : undefined}><b>{i < n ? <Icon n="ok" className="" size={12} /> : i + 1}</b>{p}{i < n && <span className="sr"> (hecho)</span>}</li>)}
          </ol>
        </div>
      )}
      <main id="public-content" tabIndex={-1}>{transparente ? children : <div className="centro">{children}</div>}</main>
      {transparente && <SiteFooter />}
      {paso !== undefined && <div className="onboarding-help"><Link to="/ayuda"><Icon n="soporte" size={16} className="" />Ayuda con la configuración</Link><span>{notaAlta ?? 'Tu información se guarda como borrador al continuar.'}</span></div>}
    </div>
  );
}

// ---------------------------------------------------------------- SCR-001
export function Landing() {
  return (
    <PublicoLayout transparente>
      <MarketingExperience />
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- SCR-002 / SCR-003
const SECTORES: Record<string, string> = { barberia: 'Barbería', gimnasio: 'Gimnasio', restaurante: 'Restaurante', taller: 'Taller', servicios: 'Servicios con cita', otro: 'Otro' };
const TAMANOS: Record<string, string> = { unipersonal: 'Solo yo', '2_5': '2 a 5 personas', '6_15': '6 a 15 personas', mas_15: 'Más de 15' };
const VOLUMENES: Record<string, string> = { bajo: 'Menos de 300 conversaciones/mes', medio: '300 a 1.500 /mes', alto: 'Más de 1.500 /mes' };
const MODULOS = ['clientes', 'catalogo', 'ventas', 'agenda', 'inventario', 'facturacion', 'conversaciones', 'ia'];

export function useBorrador() {
  const [tk] = useState(() => sessionStorage.getItem('descripcion_inicial') ? null : leer('borrador'));
  const [d, setD] = useState<any>(null);
  const [cargando, setCargando] = useState(!!tk);
  const [error, setError] = useState<ApiError | null>(null);
  const [intento, setIntento] = useState(0);
  // Un fallo de red conserva el borrador y permite reintentar la consulta.
  useEffect(() => {
    if (!tk) return;
    let activo = true; setCargando(true); setError(null);
    api.get(`/api/onboarding/borradores/${tk}`).then(r => { if (activo) setD(r); }).catch((e: ApiError) => {
      if (!activo) return;
      if (e.status === 404) guardar('borrador', null); else setError(e);
    }).finally(() => { if (activo) setCargando(false); });
    return () => { activo = false; };
  }, [tk, intento]);
  return { tk, d, setD, cargando, error, recargar: () => setIntento(n => n + 1) };
}

export function Describir() {
  const nav = useNavigate();
  const { d, setD, error: errorBorrador, recargar: recargarBorrador } = useBorrador();
  const [texto, setTexto] = useState('');
  const [planes, setPlanes] = useState<any[]>([]);
  const { run, ocupado } = useAccion();
  useEffect(() => { api.get('/api/publico/planes').then(setPlanes).catch(() => setPlanes([])); }, []);
  useEffect(() => { if (d?.descripcion && !texto) setTexto(d.descripcion); }, [d]); // eslint-disable-line

  const analizar = async (descripcion: string) => {
    const r = await run(() => api.post('/api/onboarding/borradores', { descripcion }));
    if (r) {
      guardar('borrador', r.token);
      const stored = sessionStorage.getItem('funciones_elegidas');
      if (stored) {
        const updated = await run(() => api.patch(`/api/onboarding/borradores/${r.token}`, { clasificacion: { modulos_sugeridos: JSON.parse(stored) } }));
        if (updated) { setD(updated); sessionStorage.removeItem('funciones_elegidas'); } else setD(r);
      } else setD(r);
    }
  };
  const enviar = (e: FormEvent) => { e.preventDefault(); analizar(texto); };
  // Llega desde la captura del héroe: se analiza sin pedir la misma frase dos veces.
  useEffect(() => {
    let inicial = '';
    try { inicial = sessionStorage.getItem('descripcion_inicial') ?? ''; sessionStorage.removeItem('descripcion_inicial'); } catch { /* sin almacenamiento */ }
    if (inicial.trim()) { setTexto(inicial); if (inicial.trim().length >= 15) analizar(inicial); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const corregir = async (campo: string, valor: unknown) => {
    const r = await run(() => api.patch(`/api/onboarding/borradores/${d.token}`, { clasificacion: { [campo]: valor } }));
    if (r) setD(r);
  };
  const c = d?.clasificacion;
  const plan = planes.find((p) => p.codigo === d?.plan_codigo);

  return (
    <PublicoLayout paso={d ? 1 : 0}>
      {errorBorrador && <ErrorCarga error={errorBorrador} reintentar={recargarBorrador} />}
      <div className="grid g-main onboarding-layout" style={{ alignItems: 'start', marginTop: 32, gap: 24 }}>
        <form className="tarjeta col" style={{ gap: 16, padding: 28 }} onSubmit={enviar}>
          <h1 className="onb-titulo">Primero, hablemos de tu negocio.</h1>
          <p className="sec">Con tus palabras: qué vendes, cuántos son y cómo atienden hoy. Con eso proponemos una configuración; tú corriges lo que haga falta.</p>
          <label className="campo"><span>Describe tu negocio</span>
            <textarea maxLength={2000} className="input" style={{ minHeight: 160, fontSize: 16 }} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ej.: Tengo una barbería en Cúcuta con tres barberos. Nos escriben unos 20 mensajes al día por WhatsApp para pedir turno y necesito empezar a facturar electrónico." aria-describedby="desc-ayuda" />
          </label>
          <div className="fila entre envolver"><span className="tenue peq-txt" id="desc-ayuda">{texto.trim().length < 15 ? `Escribe al menos 15 caracteres (${texto.trim().length}/15).` : `${texto.length}/2000`}</span><button className="btn primario" disabled={ocupado || texto.trim().length < 15}>{ocupado ? 'Analizando…' : d ? 'Volver a analizar' : 'Analizar mi negocio'}</button></div>
        </form>
        {!c ? (
          <aside className="onboarding-intro"><img src={MARCA.isologo} width={70} height={70} alt="" /><h2>Empieza con tu negocio.<br />El resto toma forma.</h2><p>Una descripción es suficiente para empezar a organizar tu espacio.</p><ol><li>Revisa las funciones sugeridas</li><li>Añade tu identidad y catálogo</li><li>Confirma la propuesta antes de pagar</li></ol><span>El panel se crea después de confirmar el pago.</span></aside>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <section className="tarjeta">
              <div className="cab"><h2 className="titulo-tarjeta">Lo que entendimos</h2>
                <span className="estado ia" style={{ marginLeft: 'auto' }}><Icon n="ia" className="" />Propuesta de la IA · puedes corregirla</span></div>
              <div className="cuerpo col" style={{ gap: 16 }}>
                {!c.prellenar && <span className="estado warn" style={{ alignSelf: 'flex-start' }}><Icon n="alerta" className="" />No estamos seguros: revisa cada campo.</span>}
                <Campo etiqueta="Sector"><select disabled={ocupado} className={`input ${c.corregido_por_usuario ? '' : 'inferido'}`} value={c.sector ?? ''} onChange={(e) => corregir('sector', e.target.value)}><option value="" disabled>Elige…</option>{Object.entries(SECTORES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
                <div className="grid g2" style={{ gap: 12 }}>
                  <Campo etiqueta="Equipo"><select disabled={ocupado} className="input inferido" value={c.tamano ?? ''} onChange={(e) => corregir('tamano', e.target.value)}><option value="" disabled>Elige…</option>{Object.entries(TAMANOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
                  <Campo etiqueta="Conversaciones"><select disabled={ocupado} className="input inferido" value={c.volumen_conv_mes ?? ''} onChange={(e) => corregir('volumen_conv_mes', e.target.value)}><option value="" disabled>Elige…</option>{Object.entries(VOLUMENES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
                </div>
                <label className="fila sec"><input disabled={ocupado} type="checkbox" checked={!!c.factura_electronica} onChange={(e) => corregir('factura_electronica', e.target.checked)} /> Necesito factura electrónica ante la DIAN</label>
                <div className="col" style={{ gap: 8 }}>
                  <span className="etiqueta">Módulos</span>
                  <div className="fila envolver" style={{ gap: 6 }}>{MODULOS.map((m) => (
                    <button key={m} type="button" disabled={ocupado || ['clientes', 'catalogo'].includes(m)} className={`chip ${d.cotizacion.modulos.includes(m) ? 'on' : ''}`} aria-pressed={d.cotizacion.modulos.includes(m)}
                      onClick={() => corregir('modulos_sugeridos', c.modulos_sugeridos.includes(m) ? c.modulos_sugeridos.filter((x: string) => x !== m) : [...c.modulos_sugeridos, m])}>{{clientes:"Clientes",catalogo:"Catálogo",ventas:"Ventas",agenda:"Agenda",inventario:"Inventario",facturacion:"Facturación",conversaciones:"WhatsApp",ia:"Asistente IA"}[m] ?? m}</button>
                  ))}</div>
                </div>
                {c.justificacion && <p className="tenue">«{c.justificacion}»</p>}
              </div>
            </section>
            <section className="col" style={{ gap: 12 }} aria-label="Estimación">
              <Quote quote={d.cotizacion} loading={ocupado} />
              <button className="btn primario grande" disabled={ocupado} onClick={() => nav('/empezar/datos')}>Continuar con mis datos <Icon n="flecha" className="" size={16} /></button>
            </section>
          </div>
        )}
      </div>
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- SCR-004
async function coloresDominantes(src: string): Promise<string[]> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const cv = document.createElement('canvas');
  cv.width = cv.height = 48;
  const cx = cv.getContext('2d')!;
  cx.drawImage(img, 0, 0, 48, 48);
  const px = cx.getImageData(0, 0, 48, 48).data;
  const cuenta = new Map<string, number>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const q = [px[i], px[i + 1], px[i + 2]].map((v) => Math.min(255, Math.round(v / 24) * 24));
    const k = '#' + q.map((v) => v.toString(16).padStart(2, '0')).join('');
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
}

export function Datos() {
  const nav = useNavigate();
  const { d, setD, cargando, error, recargar } = useBorrador();
  const [f, setF] = useState<any>({});
  const [faltan, setFaltan] = useState<string[]>([]);
  const [errLogo, setErrLogo] = useState('');
  const { run, ocupado } = useAccion();
  useEffect(() => { if (d) setF({ ...d.negocio, recursos: (d.negocio.recursos ?? []).join(', ') }); }, [d?.token]); // eslint-disable-line
  if (error) return <PublicoLayout paso={2}><ErrorCarga error={error} reintentar={recargar} /></PublicoLayout>;
  if (cargando) return <PublicoLayout paso={2}><Cargando filas={6} /></PublicoLayout>;
  if (!d) return <PublicoLayout paso={2}><Vacio titulo="No hay un borrador activo" accion={<Link className="btn primario" to="/empezar">Empezar</Link>} /></PublicoLayout>;
  const factura = d.clasificacion.factura_electronica;

  const guardarDatos = async (extra: any = {}) => {
    const negocio = { ...f, recursos: String(f.recursos ?? '').split(',').map((s: string) => s.trim()).filter(Boolean) };
    for (const k of Object.keys(negocio)) if (negocio[k] === '') delete negocio[k];
    return run(() => api.patch(`/api/onboarding/borradores/${d.token}`, { negocio, ...extra }));
  };
  const subirLogo = async (file: File) => {
    if (file.size > 200_000) return setErrLogo(`El logotipo pesa ${Math.round(file.size / 1000)} KB. Sube uno de menos de 200 KB (PNG, JPG, WEBP o SVG).`);
    setErrLogo('');
    const url = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(file); });
    const colores = await coloresDominantes(url).catch(() => []);
    const r = await guardarDatos({ logo_data_url: url, colores_logo: colores });
    if (r) setD(r);
  };
  const seguir = async () => {
    const r = await guardarDatos();
    if (!r) return;
    setD(r);
    const req = ['nombre', 'email', ...(factura ? ['nit'] : [])].filter((k) => !r.negocio[k]);
    setFaltan(req);
    if (!req.length) nav('/empezar/catalogo');
  };
  const inp = (k: string, ph = '', type = 'text') => (
    <input className={`input ${faltan.includes(k) ? 'falta' : ''}`} type={type} required={['nombre', 'email'].includes(k) || (factura && k === 'nit')} aria-invalid={faltan.includes(k) || undefined} value={f[k] ?? ''} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
  );
  const tema = d.tema;
  return (
    <PublicoLayout paso={2}>
      <div className="grid g-main onboarding-layout" style={{ alignItems: 'start', marginTop: 32, gap: 24 }}>
        <form className="tarjeta col" style={{ gap: 20, padding: 28 }} onSubmit={e => { e.preventDefault(); seguir(); }}>
          <h1 className="onb-titulo">Datos del negocio</h1>
          {faltan.length > 0 && <div className="aviso" role="alert"><Icon n="alerta" className="" size={16} />Completa los campos marcados para continuar: {faltan.map((k) => ({ nombre: 'nombre del negocio', email: 'correo del administrador', nit: 'NIT' }[k] ?? k)).join(', ')}.</div>}
          <div className="grid g2">
            <Campo etiqueta="Nombre del negocio">{inp('nombre', 'Barbería El Parche')}</Campo>
            <Campo etiqueta="Subdominio" ayuda={`${f.slug || 'tu-negocio'}.localhost`}>{inp('slug', 'elparche')}</Campo>
            <Campo etiqueta="Correo del administrador">{inp('email', 'tu@correo.com', 'email')}</Campo>
            <Campo etiqueta="Tu nombre">{inp('responsable')}</Campo>
            <Campo etiqueta="NIT con dígito de verificación" ayuda={factura ? 'necesario para facturar' : 'opcional'} error={faltan.includes('nit') ? 'Sin un NIT válido no podemos emitir tus facturas.' : undefined}>{inp('nit', '901456789-3')}</Campo>
            <Campo etiqueta="Ciudad">{inp('ciudad', 'Cúcuta')}</Campo>
            <Campo etiqueta="Teléfono">{inp('telefono', '+57…')}</Campo>
            <Campo etiqueta="Personas que atienden" ayuda="separadas por coma">{inp('recursos', 'Andrés, Camilo, Julián')}</Campo>
          </div>
          <div className="fila entre"><Link to="/empezar" className="btn sutil">Atrás</Link><button type="submit" className="btn primario" disabled={ocupado}>Continuar <Icon n="flecha" className="" size={14} /></button></div>
          <p className="tenue peq-txt">Nada de esto ha creado aún tu empresa: se guarda como borrador hasta el pago.</p>
        </form>
        <div className="tarjeta col" style={{ gap: 16, padding: 28 }}>
          <h2 className="titulo-tarjeta">Identidad visual</h2>
          <label className="btn upload-brand" style={{ alignSelf: 'flex-start' }}><Icon n="subir" className="" size={16} /> Subir logotipo<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="sr" onChange={(e) => e.target.files?.[0] && subirLogo(e.target.files[0])} /></label>
          {errLogo && <span className="campo"><span className="error" role="alert">{errLogo}</span></span>}
          {tema ? (
            <div className="col">
              <div className="fila" style={{ gap: 12 }}>
                <div style={{ width: 56, height: 56, borderRadius: 12, background: tema.acento, color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 500, overflow: 'hidden' }}>
                  {d.logo_data_url ? <img src={d.logo_data_url} alt="Logotipo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : tema.monograma}
                </div>
                <div className="col" style={{ gap: 2 }}>
                  <span className="mono">{tema.acento}</span>
                  <span className="tenue">Contraste {tema.contraste.acento_blanco}:1 {tema.ajustado ? '· ajustado para ser legible' : ''}</span>
                </div>
              </div>
              <div className="fila" style={{ gap: 6 }}>{[['Acción', tema.acento], ['Selección', `color-mix(in srgb, ${tema.acento} 9%, #fff)`], ['Tarjeta', 'var(--superficie)'], ['Lienzo', 'var(--lienzo)']].map(([n, c]) => <span key={n} title={n} aria-label={n} style={{ width: 28, height: 28, borderRadius: 6, background: c, border: '1px solid var(--borde-2)' }} />)}</div>
              <span className="tenue">Tu panel usará este color. {tema.origen === 'monograma' ? 'Sin logotipo, generamos un monograma.' : ''}</span>
            </div>
          ) : <span className="tenue">Escribe el nombre o sube tu logotipo para ver la paleta.</span>}
        </div>
      </div>
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- SCR-005 / SCR-006
export function Catalogo() {
  const nav = useNavigate();
  const { d, setD, cargando, error, recargar } = useBorrador();
  const [prev, setPrev] = useState<any>(null);
  const [filas, setFilas] = useState<any[]>([]);
  const [manual, setManual] = useState<any[] | null>(null);
  const { run, ocupado } = useAccion();
  if (cargando) return <PublicoLayout paso={3}><Cargando /></PublicoLayout>;
  if (error) return <PublicoLayout paso={3}><ErrorCarga error={error} reintentar={recargar} /></PublicoLayout>;
  if (!d) return <PublicoLayout paso={3}><Vacio titulo="No hay un borrador activo" accion={<Link className="btn primario" to="/empezar">Empezar</Link>} /></PublicoLayout>;

  const subir = async (file: File) => {
    const r = await run(() => api.upload(`/api/onboarding/borradores/${d.token}/catalogo/archivo`, file));
    if (r) { setPrev(r); setFilas(r.filas.map((f: any) => ({ ...f, incluir: true }))); }
  };
  const cambiarMapeo = async (col: string, campo: string) => {
    const mapeo = prev.mapeo.map((m: any) => (m.columna === col ? { ...m, campo, confianza: 1 } : m.campo === campo && campo !== 'ignorar' ? { ...m, campo: 'ignorar' } : m));
    const r = await run(() => api.post(`/api/onboarding/borradores/${d.token}/catalogo/vista-previa`, { mapeo }));
    if (r) { setPrev({ ...prev, mapeo, filas: r.filas, error: null }); setFilas(r.filas.map((f: any) => ({ ...f, incluir: true }))); }
  };
  const confirmar = async (origen: 'archivo' | 'manual', fuente: any[]) => {
    const payload = fuente.filter((f) => f.incluir !== false && f.nombre && f.precio !== null && f.precio !== '').map((f) => ({
      tipo: f.tipo, nombre: f.nombre, categoria: f.categoria || null, precio: Number(f.precio), iva_pct: Number(f.iva_pct ?? 0),
      duracion_min: f.tipo === 'SERVICIO' ? Number(f.duracion_min || 30) : null, stock: f.stock === '' || f.stock === null || f.stock === undefined ? null : Number(f.stock),
    }));
    const r = await run(() => api.post(`/api/onboarding/borradores/${d.token}/catalogo/confirmar`, { filas: payload, mapeo: prev?.mapeo, origen }), `${payload.length} ítems guardados en el borrador`);
    if (r) { setD(r); nav('/empezar/pago'); }
  };
  const revisar = filas.filter((f) => f.estado === 'REVISAR').length;

  return (
    <PublicoLayout paso={3}>
      <div className="col" style={{ gap: 24, marginTop: 32 }}>
        <div className="fila entre envolver" style={{ gap: 12 }}><h1 className="onb-titulo">Tu catálogo</h1><button className="btn sutil" onClick={() => nav('/empezar/pago')}>Omitir: usar el catálogo de ejemplo del sector</button></div>
        {!prev && !manual && (
          <div className="opciones-catalogo">
            <label className="opcion-cat principal">
              <span className="module-icon"><Icon n="subir" className="" size={20} /></span><b className="titulo-tarjeta">Subir mi hoja de cálculo</b>
              <span className="sec">.xlsx o .csv. Detectamos las columnas aunque vengan desordenadas; tú confirmas antes de guardar.</span>
              <input type="file" accept=".xlsx,.csv" className="sr" onChange={(e) => e.target.files?.[0] && subir(e.target.files[0])} />
              <span className="btn primario" aria-hidden="true">{ocupado ? 'Leyendo el archivo…' : 'Elegir archivo'}</span>
            </label>
            <button type="button" className="opcion-cat" onClick={() => setManual([{ tipo: 'SERVICIO', nombre: '', precio: '', duracion_min: 30, categoria: '' }])}>
              <span className="module-icon"><Icon n="facturacion" className="" size={20} /></span><b className="titulo-tarjeta">Escribirlo a mano</b><span className="sec">Pocos productos o servicios: agrégalos aquí mismo.</span>
            </button>
            <a className="opcion-cat" href="/api/onboarding/plantilla-catalogo.xlsx">
              <span className="module-icon"><Icon n="inventario" className="" size={20} /></span><b className="titulo-tarjeta">Descargar plantilla</b><span className="sec">Llénala y súbela después.</span>
            </a>
          </div>
        )}
        {d.catalogo && !prev && !manual && <div className="estado ok" style={{ alignSelf: 'flex-start', padding: '6px 10px' }}><Icon n="ok" className="" />Ya confirmaste {d.catalogo.length} ítems.</div>}

        {prev && (
          <>
            <section className="tarjeta">
              <div className="cab"><h2 className="titulo-tarjeta">Correspondencia de columnas</h2><span className="tenue" style={{ marginLeft: 'auto' }}>{prev.archivo} · hoja «{prev.hoja}» · encabezado en la fila {prev.fila_encabezado}</span></div>
              <div className="cuerpo fila envolver" style={{ gap: 12 }}>
                {prev.mapeo.map((m: any) => (
                  <label key={m.columna} className="campo" style={{ minWidth: 150 }}>
                    <span>«{m.columna}» <span className="ayuda">{Math.round(m.confianza * 100)}%</span></span>
                    <select className={`input ${m.confianza < 0.8 && m.campo !== 'ignorar' ? 'falta' : ''}`} value={m.campo} onChange={(e) => cambiarMapeo(m.columna, e.target.value)}>
                      {Object.entries({ nombre: 'Nombre', precio: 'Precio', categoria: 'Categoría', tipo: 'Tipo', duracion_min: 'Duración en minutos', stock: 'Existencias', iva_pct: 'IVA (%)', sku: 'Código del producto', ignorar: 'No importar' }).map(([c, etiqueta]) => <option key={c} value={c}>{etiqueta}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              {prev.error && <div className="cuerpo"><div className="bloqueado">{prev.error}</div></div>}
            </section>
            <section className="tarjeta">
              <div className="cab"><h2 className="titulo-tarjeta">Vista previa</h2><span className="tenue">{filas.length} filas · {revisar} para revisar</span></div>
              <div className="tabla-wrap" style={{ maxHeight: 420 }}>
                <table className="tabla">
                  <thead><tr><th /><th>Fila</th><th>Nombre</th><th>Tipo</th><th className="num">Precio</th><th>Duración</th><th>Estado</th></tr></thead>
                  <tbody>{filas.map((f, i) => (
                    <tr key={i}>
                      <td><input type="checkbox" checked={f.incluir} onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, incluir: e.target.checked } : x)))} aria-label={`Incluir fila ${f.fila}`} /></td>
                      <td className="mono tenue">{f.fila}</td>
                      <td>{f.nombre}</td>
                      <td><select className="input" aria-label={`Tipo de la fila ${f.fila}`} value={f.tipo} onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, tipo: e.target.value } : x)))}><option value="SERVICIO">Servicio</option><option value="PRODUCTO">Producto</option></select></td>
                      <td className="num">{f.precio === null ? <input className="input falta" style={{ width: 110 }} placeholder="Corrige" onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, precio_corregido: e.target.value } : x)))} /> : cop(f.precio)}</td>
                      <td>{f.tipo === 'SERVICIO' ? `${f.duracion_min ?? 30} min` : '—'}</td>
                      <td>{f.estado === 'OK' ? <Estado v="EXITO" texto="Listo" /> : <span className="estado warn" title={f.problemas.join(' · ')}><Icon n="alerta" className="" />{f.problemas[0]}</span>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="cuerpo fila entre">
                <button className="btn sutil" onClick={() => { setPrev(null); setFilas([]); }}>Cargar otro archivo</button>
                <button className="btn primario" disabled={ocupado || !filas.length} onClick={() => confirmar('archivo', filas.map((f) => ({ ...f, precio: f.precio ?? (f.precio_corregido ? Number(String(f.precio_corregido).replace(/\D/g, '')) : null) })))}>
                  Confirmar e importar {filas.filter((f) => f.incluir).length} ítems
                </button>
              </div>
            </section>
            <p className="tenue">Nada se guarda hasta que confirmes. El mapeo que uses quedará registrado en la auditoría de tu empresa.</p>
          </>
        )}

        {manual && (
          <section className="tarjeta">
            <div className="cab"><h2 className="titulo-tarjeta">Alta manual</h2></div>
            <div className="cuerpo col">
              {manual.map((f, i) => (
                <fieldset key={i} className="fila-manual">
                  <legend className="sr">Ítem {i + 1}</legend>
                  <select className="input" aria-label={`Tipo del ítem ${i + 1}`} value={f.tipo} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, tipo: e.target.value } : x)))}><option value="SERVICIO">Servicio</option><option value="PRODUCTO">Producto</option></select>
                  <input className="input" aria-label={`Nombre del ítem ${i + 1}`} placeholder="Nombre" value={f.nombre} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)))} />
                  <input className="input" aria-label={`Precio del ítem ${i + 1} en pesos`} placeholder="Precio" inputMode="numeric" value={f.precio} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, precio: e.target.value.replace(/\D/g, '') } : x)))} />
                  <input className="input" aria-label={`Duración del ítem ${i + 1} en minutos`} placeholder="Minutos" inputMode="numeric" value={f.duracion_min ?? ''} disabled={f.tipo !== 'SERVICIO'} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, duracion_min: e.target.value } : x)))} />
                  <input className="input" aria-label={`Categoría del ítem ${i + 1}`} placeholder="Categoría" value={f.categoria} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, categoria: e.target.value } : x)))} />
                </fieldset>
              ))}
              <div className="fila entre">
                <button className="btn" onClick={() => setManual([...manual, { tipo: 'SERVICIO', nombre: '', precio: '', duracion_min: 30, categoria: '' }])}>Agregar otro</button>
                <button className="btn primario" disabled={ocupado} onClick={() => confirmar('manual', manual)}>Guardar catálogo</button>
              </div>
            </div>
          </section>
        )}
      </div>
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- SCR-007
export function Pago() {
  const { d, cargando, error, recargar } = useBorrador();
  const { run, ocupado } = useAccion();
  const activate = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${d.token}/pago`));
    if (r) irA(r.url);
  };
  if (error) return <PublicoLayout paso={4}><ErrorCarga error={error} reintentar={recargar} /></PublicoLayout>;
  if (cargando) return <PublicoLayout paso={4}><Cargando filas={5} /></PublicoLayout>;
  if (!d) return <PublicoLayout paso={4}><Vacio titulo="Primero configura tu negocio" accion={<Link className="btn primario" to="/empezar">Empezar</Link>} /></PublicoLayout>;
  return <PublicoLayout paso={4}><section className="proposal-summary">
    <h1 className="onb-titulo">Revisa tu propuesta</h1>
    <p className="sec">Esta es la plataforma de {d.negocio?.nombre ?? 'tu negocio'}. Revisa las funciones y el desglose antes de continuar.</p>
    <Quote quote={d.cotizacion} />
    {d.pasarela === 'simulada' && <div className="aviso peq-txt"><Icon n="info" className="" size={16} />Estás en una demostración: la activación usa una pasarela simulada, sin tarjeta ni cobros reales.</div>}
    {!d.pago_disponible && <div className="aviso peq-txt"><Icon n="info" className="" size={16} />La contratación en línea todavía no está habilitada. Escríbenos y activamos tu espacio contigo.</div>}
    <div className="fila envolver" style={{ gap: 8 }}>
      {d.pago_disponible && <button className="btn primario grande" disabled={ocupado} onClick={activate}>{ocupado ? 'Preparando…' : d.pasarela === 'simulada' ? 'Ir al pago de prueba' : 'Pagar con Wompi'}</button>}
      {d.estado === 'BORRADOR' && <Link className="btn grande" to="/empezar">Ajustar funciones</Link>}
    </div>
    <p className="tenue peq-txt">Tu panel se crea solo después de que la pasarela confirme el pago. Si cierras la página, no pasa nada: la confirmación llega igual.</p>
  </section></PublicoLayout>;
}

/** Va a una URL de pago: interna (pasarela simulada) o externa (checkout de Wompi). */
export function irA(url: string) {
  const u = new URL(url, window.location.origin);
  if (u.origin === window.location.origin || /localhost(:\d+)?$/.test(u.host)) window.location.assign(u.pathname + u.search);
  else window.location.assign(url);
}

/** Pasarela simulada: representa el checkout alojado del proveedor de pagos. */
export function Pasarela() {
  const [q] = useSearchParams();
  const ref = q.get('ref') ?? '';
  const monto = Number(q.get('monto') ?? 0);
  const alta = ref.startsWith('SUB-') && !!leer('borrador');
  const [res, setRes] = useState<any>(null);
  const [resultado, setResultado] = useState<string | null>(null);
  const { run, ocupado } = useAccion();
  const nav = useNavigate();
  const pagar = async (r: 'aprobado' | 'rechazado', entregas = 1) => {
    const x = await run(() => api.post('/api/pasarela/simular', { ref, resultado: r, entregas }));
    if (!x) return;
    setRes(x); setResultado(r);
    // La respuesta de la pasarela no prueba nada: la página de destino consulta el estado real en el servidor.
    if (r === 'aprobado' && alta) nav('/empezar/listo', { replace: true });
    else if (r === 'aprobado' && q.get('volver')) { const v = new URL(q.get('volver')!, window.location.origin); nav(`${v.pathname}?ref=${encodeURIComponent(ref)}`, { replace: true }); }
  };
  const reintentar = async () => {
    const x = await run(() => api.post(`/api/onboarding/borradores/${leer('borrador')}/pago`));
    if (x) irA(x.url);
  };
  return (
    <div className="publico" style={{ display: 'grid', placeItems: 'center', padding: 16, background: 'var(--lienzo)' }}>
      <main className="tarjeta col" style={{ width: 'min(420px, 100%)', gap: 14, padding: 28 }}>
        <span className="estado warn" style={{ alignSelf: 'flex-start' }}><Icon n="alerta" className="" />Pasarela simulada · entorno de pruebas</span>
        <h1 className="titulo-tarjeta" style={{ fontSize: 16 }}>{q.get('concepto') ?? (q.get('cuenta') ? `Cobro de ${q.get('cuenta')}` : 'Pago')}</h1>
        <span className="cifra">{cop(monto)}</span>
        <span className="mono tenue">Ref. {ref}</span>
        {resultado === 'rechazado' ? (
          <div className="col" style={{ gap: 12 }} role="status">
            <div className="bloqueado"><Icon n="x" className="" size={16} />La pasarela simulada respondió que el pago fue rechazado. No se hizo ningún cobro{alta ? ' y tu panel no se creó' : ''}.</div>
            {alta && <>
              <button className="btn primario grande" disabled={ocupado} onClick={reintentar}>{ocupado ? 'Preparando…' : 'Intentar el pago de nuevo'}</button>
              <Link className="btn" to="/empezar/listo">Ver el estado de mi alta</Link>
            </>}
          </div>
        ) : <>
          <Campo etiqueta="Tarjeta de prueba" ayuda="no se procesa ningún cobro real"><input className="input mono" defaultValue="4242 4242 4242 4242" readOnly /></Campo>
          <button className="btn primario grande" disabled={ocupado || !!res} onClick={() => pagar('aprobado')}>{ocupado ? 'Procesando…' : 'Pagar'}</button>
          <div className="fila envolver" style={{ gap: 6 }}>
            <button className="btn peq" disabled={ocupado || !!res} onClick={() => pagar('rechazado')}>Simular rechazo</button>
            <button className="btn peq" disabled={ocupado || !!res} onClick={() => pagar('aprobado', 3)} title="La pasarela reintenta el webhook: debe crearse UN solo panel">Aprobar con webhook ×3</button>
          </div>
        </>}
        {res && <div className="col" style={{ gap: 4 }}>{res.entregas.map((e: any, i: number) => <span key={i} className="mono tenue" style={{ fontSize: 12 }}>webhook #{i + 1}: {e.status} {e.body.duplicado ? '· duplicado ignorado' : e.body.ok ? '· procesado' : JSON.stringify(e.body)}</span>)}</div>}
        {res && resultado === 'aprobado' && !ref.startsWith('SUB-') && <span className="sec">La pasarela respondió. El cobro se concilia en el panel del comercio.</span>}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------- SCR-008
const ETAPAS: Record<string, string> = {
  pago_verificado: 'Pago verificado', empresa_creada: 'Espacio de trabajo creado', plantilla_aplicada: 'Plantilla del sector aplicada', catalogo_importado: 'Catálogo cargado',
  administrador_creado: 'Administrador creado', tema_generado: 'Colores aplicados', subdominio_asignado: 'Subdominio asignado',
};
const MODULO_UI: Record<string, [string, string]> = {
  conversaciones: ['Conversaciones', 'conversaciones'], clientes: ['Clientes', 'clientes'], ventas: ['Ventas', 'ventas'], agenda: ['Agenda', 'agenda'],
  catalogo: ['Catálogo', 'inventario'], inventario: ['Inventario', 'inventario'], facturacion: ['Facturación', 'facturacion'], ia: ['Centro de IA', 'ia'], comisiones: ['Comisiones', 'suscripcion'],
};
const ORDEN_MODULOS = ['conversaciones', 'clientes', 'ventas', 'agenda', 'catalogo', 'inventario', 'facturacion', 'ia', 'comisiones'];

const CABECERA: Record<FaseCierre, EstadoAlta> = {
  sin_borrador: { tono: 'neutro', icono: 'info', texto: 'No hay un alta en curso' },
  cargando: { tono: 'neutro', icono: 'reloj', texto: 'Consultando el estado del alta…' },
  error: { tono: 'err', icono: 'alerta', texto: 'No pudimos consultar el estado' },
  sin_pago: { tono: 'neutro', icono: 'reloj', texto: 'Borrador guardado · pago sin iniciar' },
  pendiente: { tono: 'warn', icono: 'reloj', texto: 'Pago pendiente de confirmación' },
  rechazado: { tono: 'err', icono: 'x', texto: 'Pago rechazado · tu panel no se creó' },
  confirmando: { tono: 'warn', icono: 'reloj', texto: 'Pago confirmado · creando tu panel' },
  listo: { tono: 'ok', icono: 'ok', texto: 'Panel creado' },
};

/** Representación del panel con los datos reales del alta: nombre, logotipo o monograma, colores, módulos y catálogo. */
function PanelPersonalizado({ d, st, real, fase }: { d: any; st: any; real: boolean; fase: FaseCierre }) {
  const p = real ? st.panel : null;
  const nombre: string = real ? st.tenant.nombre : d?.negocio?.nombre ?? 'Tu negocio';
  const tema = real ? p.tema : d?.tema;
  const logo: string | null = real ? p.logo_data_url : d?.logo_data_url;
  const monograma = tema?.monograma ?? nombre.split(/\s+/).map((x) => x[0]).join('').slice(0, 2).toUpperCase();
  const acento = tema?.acento ?? 'var(--tinta-3)';
  const modulos: string[] = (real ? p.modulos : d?.cotizacion?.modulos ?? []).slice().sort((a: string, b: string) => ORDEN_MODULOS.indexOf(a) - ORDEN_MODULOS.indexOf(b));
  const cat = real ? p.catalogo : { origen: d?.catalogo?.length ? 'propio' : 'ejemplo', total: d?.catalogo?.length ?? 0, muestra: (d?.catalogo ?? []).slice(0, 4) };
  const conPrecio = cat.muestra.length > 0;
  return (
    <figure className={`cierre-panel ${real ? 'real' : 'previa'}`} key={real ? 'real' : 'previa'} style={{ ['--t-acento' as any]: acento, ['--t-sobre' as any]: tema?.texto_sobre_acento ?? '#fff' }}>
      <div className="cp-ventana" aria-hidden="true">
        <div className="cp-lado">
          <div className="cp-marca"><span className="cp-logo">{logo ? <img src={logo} alt="" /> : monograma}</span><b>{nombre}</b></div>
          <ul className="cp-nav">
            <li className="on" style={{ ['--i' as any]: 0 }}><Icon n="inicio" className="" size={14} /><span>Inicio</span></li>
            {modulos.map((m, i) => <li key={m} style={{ ['--i' as any]: i + 1 }}><Icon n={MODULO_UI[m]?.[1] ?? 'plataforma'} className="" size={14} /><span>{MODULO_UI[m]?.[0] ?? m}</span></li>)}
          </ul>
        </div>
        <div className="cp-main">
          <div className="cp-cab"><b>Inicio</b>{modulos.includes('ventas') && <span className="cp-btn">Nueva venta</span>}</div>
          <div className="cp-cat">
            <span className="cp-tit">Catálogo{cat.origen === 'ejemplo' && <span className="cp-ej">Ejemplo del sector</span>}</span>
            {conPrecio ? cat.muestra.map((x: any, i: number) => <div key={i} className="cp-fila" style={{ ['--i' as any]: i }}><span>{x.nombre}</span><b>{cop(x.precio)}</b></div>)
              : <div className="cp-fila vacia" style={{ ['--i' as any]: 0 }}><span>Se cargará el catálogo de ejemplo de tu sector</span></div>}
          </div>
        </div>
      </div>
      <figcaption className="cp-leyenda">
        <span className="cp-nota">{real ? 'Tu panel, con los datos confirmados al crear tu espacio.' : fase === 'confirmando' ? st?.error_aprovisionamiento ? 'Vista previa de tu configuración. El pago está confirmado; reintenta la creación para preparar tu panel.' : 'Vista previa de tu configuración. El pago está confirmado y estamos preparando tu panel.' : fase === 'error' ? 'Vista previa de tu configuración guardada. Reintenta la consulta para conocer el estado actual de tu panel.' : 'Vista previa con los datos de tu borrador. El panel se crea cuando la pasarela confirme el pago.'}</span>
        <ul>
          <li><Icon n="persona" className="" size={15} /><span><b>{nombre}</b>{logo ? 'Con tu logotipo' : `Monograma «${monograma}»: no subiste logotipo`}</span></li>
          <li><span className="cp-muestra" style={{ background: acento }} /><span><b className="mono">{tema?.acento ?? 'Sin color aún'}</b>{tema ? (tema.origen === 'logotipo' ? 'Color tomado de tu logotipo' : 'Color derivado de tu monograma') : 'Escribe el nombre en Datos para generarlo'}</span></li>
          <li><Icon n="plataforma" className="" size={15} /><span><b>{modulos.length} módulos {real ? 'habilitados' : 'incluidos en tu propuesta'}</b>{real ? 'Los que quedaron activos al crear tu panel' : 'Se habilitan al crear el panel'}</span></li>
          <li><Icon n="inventario" className="" size={15} /><span><b>{cat.origen === 'ejemplo' ? 'Catálogo de ejemplo del sector' : 'Tu catálogo'}</b>{real ? `${cat.total} ítems${cat.origen === 'ejemplo' ? ', editables desde el panel' : ''}` : cat.origen === 'ejemplo' ? 'Lo podrás editar desde el panel' : `${cat.total} ítems confirmados`}</span></li>
        </ul>
      </figcaption>
    </figure>
  );
}

export function Aprovisionamiento() {
  const { tk, d } = useBorrador();
  const [st, setSt] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [consulta, setConsulta] = useState(0);
  const [pw, setPw] = useState('');
  const [creada, setCreada] = useState(false);
  const [errAcceso, setErrAcceso] = useState('');
  const [entrando, setEntrando] = useState(false);
  const { run, ocupado } = useAccion();
  const nav = useNavigate();

  useEffect(() => {
    if (!tk) return;
    let vivo = true;
    let t = 0;
    const tick = async () => {
      try {
        const s = await api.get(`/api/onboarding/borradores/${tk}/estado`);
        if (!vivo) return;
        setSt(s); setError(null);
        if (debeConsultar(faseCierre(tk, s, null)) && !s.error_aprovisionamiento) t = window.setTimeout(tick, 1500);
      } catch (e) { if (vivo) setError(e as ApiError); }
    };
    tick();
    return () => { vivo = false; clearTimeout(t); };
  }, [tk, consulta]);

  const fase = faseCierre(tk, st, error);
  const falloCreacion = fase === 'confirmando' && !!st?.error_aprovisionamiento;
  const listo = fase === 'listo';
  const pago = st?.pago;
  const necesitaCrear = listo && st.requiere_contrasena && !creada;

  const irAPagar = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${tk}/pago`));
    if (r) irA(r.url);
  };
  const reintentarAlta = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${tk}/reintentar`));
    if (r) setConsulta((n) => n + 1);
  };
  const entrar = async (e: FormEvent) => {
    e.preventDefault();
    if (entrando) return;
    setEntrando(true); setErrAcceso('');
    const conClaveNueva = necesitaCrear || creada;
    try {
      if (necesitaCrear) {
        try { await api.post(`/api/onboarding/borradores/${tk}/contrasena`, { password: pw }); }
        catch (e2) {
          // 409: ya estaba definida (p. ej. otra pestaña). Se pasa directamente a iniciar sesión.
          if ((e2 as ApiError).status !== 409) { setErrAcceso(`No pudimos guardar tu contraseña: ${(e2 as Error).message}`); return; }
        }
        setCreada(true);
      }
      let r: any;
      try { r = await api.post('/api/auth/login', { email: st.email, password: pw }); }
      catch (e2) {
        setErrAcceso(conClaveNueva
          ? `Tu contraseña quedó guardada, pero no pudimos iniciar sesión (${(e2 as Error).message}). Vuelve a intentarlo: no hace falta crearla otra vez.`
          : `No pudimos iniciar sesión: ${(e2 as Error).message}`);
        return;
      }
      const emp = r.empresas?.find((x: any) => x.slug === st.tenant.slug);
      if (!emp) { setErrAcceso('Iniciaste sesión, pero esta cuenta no tiene acceso al panel recién creado. Revisa el correo con el que entras.'); return; }
      guardar('empresa', emp.slug);
      guardar('borrador', null);
      nav('/');
    } finally { setEntrando(false); }
  };

  const titulo: Record<FaseCierre, string> = {
    sin_borrador: 'No hay un alta en curso', cargando: 'Consultando tu alta…', error: 'No pudimos consultar el estado de tu alta',
    sin_pago: 'Aún no has iniciado el pago', pendiente: 'Esperando la confirmación del pago', rechazado: 'La pasarela rechazó el pago',
    confirmando: 'Pago confirmado. Estamos creando tu panel', listo: `${st?.tenant?.nombre ?? 'Tu negocio'} ya tiene su panel`,
  };
  const hechos = pasosCumplidos(fase, d);

  return (
    <PublicoLayout paso={Math.min(hechos, 5)} hechos={hechos} estado={falloCreacion ? { tono: 'err', icono: 'alerta', texto: 'Creación detenida · tu pago está confirmado' } : CABECERA[fase]} notaAlta={listo ? 'Tu espacio está creado. Puedes continuar desde tu panel.' : falloCreacion ? 'Tu pago está confirmado. Reintenta la creación con tu configuración guardada.' : fase === 'confirmando' ? 'Tu pago está confirmado. Estamos preparando tu espacio.' : fase === 'error' ? 'Tu configuración se conserva. Reintenta la consulta del estado.' : fase === 'sin_borrador' ? 'Describe tu negocio para empezar a configurar tu espacio.' : fase === 'cargando' ? 'Estamos consultando el estado de tu configuración.' : 'Tu borrador se conserva mientras se confirma el pago.'}>
      {(fase === 'confirmando' || fase === 'listo') && <WorkspaceAssembly nombre={st?.tenant?.nombre ?? d?.negocio?.nombre ?? 'Tu negocio'} modulos={listo ? st?.panel?.modulos ?? [] : d?.cotizacion?.modulos ?? []} listo={listo} error={!!st?.error_aprovisionamiento} />}
      <div className={`cierre ${fase === 'sin_borrador' ? 'solo' : ''}`}>
        <section className="tarjeta col cierre-estado" aria-live="polite">
          <h1 className="onb-titulo">{falloCreacion ? 'Tu pago está confirmado. La creación necesita un reintento.' : titulo[fase]}</h1>
          {fase === 'sin_borrador' && <><p className="sec">{error ? 'No encontramos el borrador guardado en este navegador.' : 'Describe tu negocio para preparar una propuesta.'}</p><Link className="btn primario" style={{ alignSelf: 'flex-start' }} to="/empezar">Empezar</Link></>}
          {fase === 'cargando' && <Cargando filas={3} />}
          {fase === 'error' && <>
            <div className="aviso" role="alert"><Icon n="alerta" className="" size={16} /><span>{error?.message}. Esto solo afecta a la consulta del estado; vuelve a intentarlo.</span></div>
            <button className="btn primario" style={{ alignSelf: 'flex-start' }} onClick={() => { setError(null); setConsulta((n) => n + 1); }}>Reintentar la consulta</button>
          </>}
          {fase === 'sin_pago' && <>
            <p className="sec">Tu borrador está guardado. El panel se crea solo después de que la pasarela confirme el pago.</p>
            <Link className="btn primario" style={{ alignSelf: 'flex-start' }} to="/empezar/pago">Revisar la propuesta y pagar</Link>
          </>}
          {fase === 'pendiente' && <>
            <p className="sec">La pasarela todavía no ha confirmado el pago de <b>{cop(pago.monto)}</b> <span className="mono">(ref. {pago.referencia})</span>. Volvemos a consultar cada pocos segundos.</p>
            <button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={irAPagar}>{ocupado ? 'Preparando…' : 'Volver a la pasarela'}</button>
          </>}
          {fase === 'rechazado' && <>
            <p className="sec">No se hizo ningún cobro y tu panel no se creó. Tu borrador sigue guardado.</p>
            <div className="fila envolver" style={{ gap: 8 }}>
              <button className="btn primario" disabled={ocupado} onClick={irAPagar}>{ocupado ? 'Preparando…' : 'Intentar el pago de nuevo'}</button>
              <Link className="btn" to="/empezar/pago">Revisar la propuesta</Link>
            </div>
          </>}
          {(fase === 'confirmando' || fase === 'listo') && <CreacionEspacio etapas={st?.etapas ?? []} listo={listo} error={st?.error_aprovisionamiento ?? null} onReintentar={reintentarAlta} ocupado={ocupado} />}
          {listo && <>
            <p className="sec">Tu espacio de trabajo <b>{st.tenant.nombre}</b> está creado. Entra para revisar tus módulos y completar las conexiones pendientes.</p>
            <form className="decision col" style={{ gap: 14, padding: 20 }} onSubmit={entrar}>
              {necesitaCrear
                ? <Campo etiqueta={`Crea tu contraseña para ${st.email}`} ayuda="mínimo 10 caracteres"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Campo>
                : <Campo etiqueta={`Contraseña de ${st.email}`}><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Campo>}
              {errAcceso && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{errAcceso}</p>}
              <button className="btn primario" disabled={entrando || (necesitaCrear ? pw.length < 10 : !pw)}>{entrando ? 'Entrando…' : errAcceso && creada ? 'Volver a intentar entrar' : 'Entrar a mi panel'}</button>
            </form>

          </>}
          {fase !== 'sin_borrador' && <p className="tenue peq-txt">Si la pasarela repite la notificación del pago, no se crea un segundo panel: cada pago se procesa una sola vez.</p>}
        </section>
        {fase !== 'sin_borrador' && (listo ? st.panel : d) && <PanelPersonalizado d={d} st={st} real={listo && !!st.panel} fase={fase} />}
      </div>
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- acceso
export function Entrar() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [demo, setDemo] = useState(false);
  // Segundo paso (solo cuentas del operador de la plataforma): código enviado al correo.
  const [paso2, setPaso2] = useState<{ desafio: string; destino: string; minutos: number } | null>(null);
  const [codigo, setCodigo] = useState('');
  const espera = useCuentaAtras();
  useEffect(() => { api.get('/api/publico/estado').then((r) => setDemo(!!r.simuladores)).catch(() => {}); }, []);
  const entrar = (r: any) => {
    const next = q.get('volver');
    if (slugDelHost()) return nav(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
    if (r.usuario.rol_plataforma && r.usuario.segundo_factor && !r.empresas.length) return nav('/operador');
    if (r.empresas.length === 1 && !r.usuario.rol_plataforma) { guardar('empresa', r.empresas[0].slug); return nav(next?.startsWith('/') && !next.startsWith('//') ? next : '/'); }
    nav(next?.startsWith('/') && !next.startsWith('//') ? `/empresas?volver=${encodeURIComponent(next)}` : '/empresas');
  };
  const enviar = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return; setBusy(true); setErr('');
    try {
      const r = await api.post('/api/auth/login', { email, password: pw });
      if (r.segundo_factor) { setPaso2({ desafio: r.desafio, destino: r.destino, minutos: r.minutos }); setCodigo(''); espera.iniciar(60); return; }
      entrar(r);
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  const verificar = async (e: FormEvent) => {
    e.preventDefault(); if (busy || !paso2) return; setBusy(true); setErr('');
    try { entrar(await api.post('/api/auth/login/codigo', { desafio: paso2.desafio, codigo })); }
    catch (e2) { setErr((e2 as Error).message); if ((e2 as ApiError).status === 409) setCodigo(''); } finally { setBusy(false); }
  };
  const reenviar = async () => {
    if (!paso2 || espera.restante > 0) return;
    setErr('');
    try { const r = await api.post('/api/auth/login/codigo/reenviar', { desafio: paso2.desafio }); setPaso2({ ...paso2, destino: r.destino, minutos: r.minutos }); espera.iniciar(60); }
    catch (e2) { setErr((e2 as Error).message); const s = ((e2 as ApiError).details as any)?.espera_segundos; if (s) espera.iniciar(s); }
  };
  if (paso2) return <PublicoLayout><div className="auth-layout solo">
    <form className="auth-form col" onSubmit={verificar} aria-labelledby="titulo-codigo">
      <h1 id="titulo-codigo">Revisa tu correo</h1>
      <p className="sec">Tu cuenta administra la plataforma, así que pedimos un segundo paso. Escribe el código que enviamos a <b>{paso2.destino}</b>. Vence en {paso2.minutos} minutos.</p>
      <CodigoOtp valor={codigo} onCambio={setCodigo} autoFocus />
      {err && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{err}</p>}
      <button className="btn primario grande" disabled={busy || codigo.length !== 6}>{busy ? 'Comprobando…' : 'Entrar'}</button>
      <div className="fila" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <button type="button" className="btn sutil peq" disabled={espera.restante > 0} onClick={reenviar}>{espera.restante > 0 ? `Reenviar código en ${espera.restante} s` : 'Reenviar código'}</button>
        <button type="button" className="btn sutil peq" onClick={() => { setPaso2(null); setPw(''); setErr(''); }}>Usar otra cuenta</button>
      </div>
      <p className="tenue peq-txt">Nunca te pediremos este código por teléfono ni por chat.</p>
    </form>
  </div></PublicoLayout>;
  return <PublicoLayout><div className="auth-layout">
    <form className="auth-form col" onSubmit={enviar} aria-labelledby="titulo-entrar">
      <h1 id="titulo-entrar">Entra a tu negocio</h1>
      {slugDelHost() ? <span className="estado neutro" style={{ alignSelf: 'flex-start' }}><Icon n="plataforma" className="" />Negocio: {slugDelHost()}</span> : <p className="sec">Si trabajas en varias empresas, eliges una después de entrar.</p>}
      <Campo etiqueta="Correo"><input className="input" type="email" placeholder="tu@negocio.com" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required /></Campo>
      <Campo etiqueta="Contraseña"><div className="password-field"><input className="input" aria-label="Contraseña" type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" required /><button type="button" className="btn sutil peq" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={show} onClick={() => setShow(v => !v)}>{show ? 'Ocultar' : 'Mostrar'}</button></div></Campo>
      {q.get('vencida') && !err && <p role="status" className="aviso peq-txt"><Icon n="reloj" className="" size={16} />Tu sesión terminó por seguridad. Entra de nuevo para seguir donde ibas.</p>}
      {err && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{err}</p>}
      <button className="btn primario grande" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      <p className="auth-register"><Link to="/recuperar">¿Olvidaste tu contraseña?</Link></p>
      <p className="auth-register">¿Tu negocio aún no tiene su espacio? <Link to="/empezar">Crear mi espacio</Link></p>
      {demo && <details className="demo-accounts"><summary>Usar una cuenta de demostración</summary><p>Correo <span className="mono">admin@elparche.test</span><br />Contraseña <span className="mono">demo-parche-2026</span></p></details>}
    </form>
    <section className="auth-story" aria-label="Qué encontrarás en tu panel">
      <h2>Lo que te espera en tu panel</h2>
      <ul>
        <li><Icon n="conversaciones" className="" size={20} /><span><b>Conversaciones de WhatsApp</b>La IA atiende y una persona del equipo entra al mismo hilo cuando hace falta.</span></li>
        <li><Icon n="agenda" className="" size={20} /><span><b>Agenda y ventas</b>Cada cita y cada venta quedan conectadas con su cliente.</span></li>
        <li><Icon n="facturacion" className="" size={20} /><span><b>Documentos y seguimiento</b>Consulta tus documentos y sus estados. La facturación actual opera en pruebas, sin validez fiscal.</span></li>
      </ul>
    </section>
  </div></PublicoLayout>;
}

export function Empresas() {
  const nav = useNavigate();
  const [q] = useSearchParams();
  const volver = q.get('volver');
  const [s, setS] = useState<any>(null);
  useEffect(() => { api.get('/api/auth/sesion').then(setS).catch(() => nav('/entrar')); }, [nav]);
  if (!s) return null;
  return (
    <PublicoLayout>
      <div className="tarjeta col" style={{ maxWidth: 480, margin: '48px auto', gap: 12, padding: 28 }}>
        <h1 className="onb-titulo" style={{ fontSize: 24 }}>Hola, {s.usuario.nombre.split(' ')[0]}. ¿En qué empresa vas a trabajar?</h1>
        <p className="tenue">Tu rol puede ser distinto en cada una. Elegir una empresa solo cambia lo que ves: el servidor valida tu acceso.</p>
        {s.empresas.length === 0 && !s.usuario.rol_plataforma && <Vacio titulo="Tu cuenta no pertenece a ninguna empresa">Pide a un administrador que te invite, o crea tu plataforma.</Vacio>}
        {s.empresas.map((e: any) => (
          <button key={e.id} className="btn fila" style={{ justifyContent: 'flex-start', height: 'auto', padding: '10px 14px', gap: 12 }} onClick={() => { guardar('empresa', e.slug); nav(volver?.startsWith('/') && !volver.startsWith('//') ? volver : '/'); }}>
            <span style={{ width: 32, height: 32, borderRadius: 8, background: e.tema?.acento ?? 'var(--tinta-3)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 13, flex: 'none' }} aria-hidden="true">{e.tema?.monograma}</span>
            <span style={{ textAlign: 'left', minWidth: 0 }}><b>{e.nombre}</b><br /><span className="tenue peq-txt">{e.rol} · {e.slug}.localhost</span></span>
            <Icon n="derecha" className="" size={16} />
          </button>
        ))}
        {s.usuario.rol_plataforma && s.usuario.segundo_factor && <Link className="btn" to="/operador">Panel del operador de {MARCA.nombre}</Link>}
      </div>
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- creación del espacio
const ORDEN_ETAPAS = ['pago_verificado', 'empresa_creada', 'plantilla_aplicada', 'catalogo_importado', 'administrador_creado', 'tema_generado', 'subdominio_asignado'];
const DETALLE_ETAPA: Record<string, string> = {
  pago_verificado: 'La pasarela confirmó el pago con su firma',
  empresa_creada: 'Tu empresa y su suscripción',
  plantilla_aplicada: 'Roles, permisos, agentes y reglas de tu sector',
  catalogo_importado: 'Tus productos y servicios',
  administrador_creado: 'Tu acceso como administrador',
  tema_generado: 'Los colores de tu marca en el panel',
  subdominio_asignado: 'La dirección de tu panel',
};

/**
 * Creación del espacio con las etapas que registró el servidor. Una etapa se marca
 * como hecha solo si figura en el registro; mientras el servidor trabaja, la
 * siguiente se muestra «en curso» y las demás pendientes. Si el alta falló, se
 * muestra dónde y se ofrece reintentar (el pago ya está confirmado).
 */
function CreacionEspacio({ etapas, listo, error, onReintentar, ocupado }: { etapas: { etapa: string; en: string }[]; listo: boolean; error: string | null; onReintentar: () => void; ocupado: boolean }) {
  const hechas = new Set(etapas.map((e) => e.etapa));
  if (!hechas.has('pago_verificado')) hechas.add('pago_verificado'); // fase «confirmando»: el pago ya está aprobado
  // La animación acompaña el registro, sin retrasar ni inventar el estado visible.
  const terminado = listo;
  return (
    <div className={`creacion ${terminado ? 'terminada' : ''}`} aria-live="polite">
      <div className="creacion-cab">
        {!terminado && !error ? <img src={MARCA.cargando} alt="" width={44} height={48} className="creacion-loader" /> : <span className={`creacion-sello ${error ? 'error' : ''}`}><Icon n={error ? 'alerta' : 'ok'} className="" size={22} /></span>}
        <span className="col" style={{ gap: 2 }}>
          <b>{error ? 'La creación se detuvo' : terminado ? 'Tu espacio está listo' : 'Creando tu espacio de trabajo'}</b>
          <span className="tenue peq-txt">{error ? 'Tu pago está confirmado y no se cobrará otra vez.' : terminado ? 'Todo quedó registrado.' : 'Esperando la confirmación de los siguientes pasos.'}</span>
        </span>
      </div>
      <ol className="creacion-etapas">
        {ORDEN_ETAPAS.map((e, i) => {
          const hecha = hechas.has(e);
          const fallo = !!error && !hechas.has(e) && ORDEN_ETAPAS.find((x) => !hechas.has(x)) === e;
          const curso = false; // El servidor no publica una etapa activa; las restantes siguen pendientes.
          return (
            <li key={e} className={hecha ? 'hecha' : fallo ? 'fallo' : curso ? 'curso' : ''}>
              <span className="punto" aria-hidden="true">{hecha ? <Icon n="ok" className="" size={12} /> : fallo ? <Icon n="x" className="" size={12} /> : null}</span>
              <span className="col" style={{ gap: 0 }}><b>{ETAPAS[e]}</b><span className="tenue peq-txt">{DETALLE_ETAPA[e]}</span></span>
              <span className="sr">{hecha ? '(hecho)' : fallo ? '(falló)' : curso ? '(en curso)' : '(pendiente)'}</span>
            </li>
          );
        })}
      </ol>
      {error && <div className="col" style={{ gap: 8 }}><p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error}</p><button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={onReintentar}>{ocupado ? 'Reintentando…' : 'Reintentar la creación'}</button></div>}
    </div>
  );
}

// ---------------------------------------------------------------- recuperación de acceso
export function Recuperar() {
  const [email, setEmail] = useState('');
  const [enviado, setEnviado] = useState(false);
  const { run, ocupado } = useAccion();
  return <PublicoLayout><div className="auth-layout solo">
    <form className="auth-form col" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/api/auth/recuperar', { email })); if (r) setEnviado(true); }}>
      <h1>Recupera tu acceso</h1>
      {enviado ? <>
        <p className="aviso exito" role="status"><Icon n="ok" className="" size={16} />Si <b>{email}</b> tiene una cuenta, le enviamos un enlace para crear una contraseña nueva. Vence en 60 minutos.</p>
        <p className="sec peq-txt">¿No llega? Revisa el correo no deseado o espera unos minutos antes de pedirlo otra vez.</p>
        <Link className="btn" to="/entrar">Volver a entrar</Link>
      </> : <>
        <p className="sec">Escribe el correo con el que entras. Te enviaremos un enlace de un solo uso.</p>
        <Campo etiqueta="Correo"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></Campo>
        <button className="btn primario grande" disabled={ocupado || !email}>{ocupado ? 'Enviando…' : 'Enviar enlace'}</button>
        <p className="auth-register"><Link to="/entrar">Volver a entrar</Link></p>
      </>}
    </form>
  </div></PublicoLayout>;
}

export function Restablecer() {
  const [q] = useSearchParams();
  const tk = q.get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [listo, setListo] = useState(false);
  const { run, ocupado, error } = useAccion();
  return <PublicoLayout><div className="auth-layout solo">
    <form className="auth-form col" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/api/auth/restablecer', { token: tk, password: pw }), undefined, { silencioso: true }); if (r) setListo(true); }}>
      <h1>Crea una contraseña nueva</h1>
      {!tk ? <p className="bloqueado"><Icon n="alerta" className="" size={16} />El enlace está incompleto. Pide uno nuevo.</p> : listo ? <>
        <p className="aviso exito" role="status"><Icon n="ok" className="" size={16} />Contraseña actualizada. Cerramos tus sesiones abiertas en otros dispositivos.</p>
        <Link className="btn primario grande" to="/entrar">Entrar</Link>
      </> : <>
        {error && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}{error.status === 409 && <> <Link to="/recuperar">Pedir otro enlace</Link></>}</p>}
        <Campo etiqueta="Nueva contraseña" ayuda="mínimo 10 caracteres"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Campo>
        <Campo etiqueta="Repítela" error={pw2 && pw !== pw2 ? 'No coincide.' : undefined}><input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Campo>
        <button className="btn primario grande" disabled={ocupado || pw.length < 10 || pw !== pw2}>{ocupado ? 'Guardando…' : 'Guardar contraseña'}</button>
      </>}
    </form>
  </div></PublicoLayout>;
}

// ---------------------------------------------------------------- invitación al equipo
export function Invitacion() {
  const [q] = useSearchParams();
  const nav = useNavigate();
  const tk = q.get('token') ?? '';
  const [info, setInfo] = useState<any>(null);
  const [errInfo, setErrInfo] = useState('');
  const [pw, setPw] = useState('');
  const { run, ocupado, error } = useAccion();
  useEffect(() => { if (tk) api.get(`/api/invitaciones/${tk}`).then(setInfo).catch((e) => setErrInfo(e.status === 404 ? 'Este enlace de invitación no es válido.' : e.message)); }, [tk]);
  const aceptar = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post(`/api/invitaciones/${tk}/aceptar`, { password: pw }), undefined, { silencioso: true });
    if (!r) return;
    const s = await run(() => api.post('/api/auth/login', { email: r.email, password: pw }));
    if (s) { guardar('empresa', r.slug); nav('/'); }
  };
  return <PublicoLayout><div className="auth-layout solo">
    <div className="auth-form col">
      {!tk || errInfo ? <><h1>Invitación</h1><p className="bloqueado"><Icon n="alerta" className="" size={16} />{errInfo || 'El enlace está incompleto.'}</p></>
        : !info ? <Cargando filas={3} />
        : info.estado !== 'PENDIENTE' ? <>
          <h1>Invitación a {info.empresa}</h1>
          <p className="bloqueado"><Icon n="alerta" className="" size={16} />{info.estado === 'ACEPTADA' ? 'Esta invitación ya se usó.' : info.estado === 'EXPIRADA' ? 'La invitación venció. Pide a quien te invitó que la reenvíe.' : 'La invitación fue retirada.'}</p>
          <Link className="btn" to="/entrar">Ir a entrar</Link>
        </> : <form className="col" style={{ gap: 16 }} onSubmit={aceptar}>
          <h1>Únete a {info.empresa}</h1>
          <p className="sec">Hola, {info.nombre.split(' ')[0]}. Te invitaron con el rol <b>{info.rol}</b>, usando el correo <span className="mono">{info.email}</span>.</p>
          {error && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</p>}
          <Campo etiqueta={info.cuenta_existente ? 'Tu contraseña actual' : 'Crea tu contraseña'} ayuda={info.cuenta_existente ? 'ya tienes cuenta: confirma que eres tú' : 'mínimo 10 caracteres'}><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={info.cuenta_existente ? 'current-password' : 'new-password'} /></Campo>
          <button className="btn primario grande" disabled={ocupado || (info.cuenta_existente ? !pw : pw.length < 10)}>{ocupado ? 'Entrando…' : 'Aceptar y entrar'}</button>
        </form>}
    </div>
  </div></PublicoLayout>;
}

// ---------------------------------------------------------------- retorno del pago
/**
 * Resultado de un pago. La URL trae el id de la transacción (Wompi) o la referencia
 * (pasarela simulada); el servidor confirma con la pasarela. Nada se da por pagado
 * por haber llegado a esta página.
 */
export function ResultadoPago() {
  const [q] = useSearchParams();
  const id = q.get('id');
  const ref = q.get('ref');
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState('');
  const [intento, setIntento] = useState(0);
  useEffect(() => {
    if (!id) return;
    let vivo = true;
    api.get(`/api/pagos/verificar?id=${encodeURIComponent(id)}`).then((x) => { if (vivo) setR(x); }).catch((e) => { if (vivo) setErr(e.message); });
    return () => { vivo = false; };
  }, [id, intento]);
  const pendiente = r && ['DESCONOCIDO', 'PENDIENTE'].includes(r.estado);
  useEffect(() => { if (!pendiente || intento > 10) return; const t = setTimeout(() => setIntento((n) => n + 1), 4000); return () => clearTimeout(t); }, [pendiente, intento]);
  const textos: Record<string, [string, string, string]> = {
    APROBADO: ['ok', 'Pago confirmado', 'La pasarela confirmó el pago. Ya quedó registrado.'],
    RECHAZADO: ['err', 'El pago no se aprobó', 'No se hizo ningún cobro. Puedes intentarlo de nuevo con otro medio de pago.'],
    ANULADO: ['err', 'El pago fue anulado', 'No quedó ningún cobro activo.'],
    ERROR: ['err', 'La pasarela reportó un error', 'No se hizo ningún cobro. Intenta de nuevo en unos minutos.'],
    PENDIENTE: ['warn', 'Pago en proceso', 'Tu banco aún no confirma el pago. Te avisaremos cuando llegue la confirmación; puedes cerrar esta página.'],
    DESCONOCIDO: ['warn', 'Esperando la confirmación', 'Aún no recibimos la confirmación de la pasarela. Puedes cerrar esta página: el pago se registra solo cuando la pasarela lo confirma.'],
  };
  const [tono, titulo, texto] = ref && !id ? ['warn', 'Volviste de la pasarela', 'Estamos esperando la confirmación del pago. Se registrará en cuanto la pasarela la envíe.'] : r ? textos[r.estado] ?? textos.DESCONOCIDO : ['neutro', 'Consultando el pago…', ''];
  return <PublicoLayout><div className="auth-layout solo">
    <div className="auth-form col" aria-live="polite">
      <h1>{titulo}</h1>
      {!id && !ref ? <p className="bloqueado"><Icon n="alerta" className="" size={16} />No recibimos los datos del pago.</p> : err ? <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{err}</p>
        : !r && id ? <Cargando filas={2} /> : <p className={tono === 'ok' ? 'aviso exito' : tono === 'err' ? 'bloqueado' : 'aviso'}><Icon n={tono === 'ok' ? 'ok' : tono === 'err' ? 'x' : 'reloj'} className="" size={16} />{texto}</p>}
      {r?.referencia && <span className="tenue peq-txt mono">Referencia {r.referencia}</span>}
      <div className="fila envolver" style={{ gap: 8 }}>
        {leer('borrador') && <Link className="btn primario" to="/empezar/listo">Ver mi alta</Link>}
        <Link className="btn" to="/">Ir al panel</Link>
      </div>
    </div>
  </div></PublicoLayout>;
}
