import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, cop, guardar, leer, slugDelHost } from '../../api';
import { debeConsultar, faseCierre, pasosCumplidos, type FaseCierre } from './cierre';
import { Campo, Cargando, Estado, CicloFiscal, useAccion, Vacio } from '../../components/ui';
import { Quote } from '../../components/Quote';
import { Experience, FeatureBuilder } from '../../components/Experience';
import { Icon } from '../../components/icons';

/** Estado del alta visible en la cabecera: borrador, pago verificado y aprovisionamiento no se confunden. */
export type EstadoAlta = { tono: 'neutro' | 'warn' | 'ok' | 'err'; icono: string; texto: string };
const BORRADOR: EstadoAlta = { tono: 'neutro', icono: 'reloj', texto: 'Borrador guardado · tu panel aún no existe' };

/** `hechos`: pasos realmente cumplidos; por defecto, los anteriores al actual. */
export function PublicoLayout({ children, paso, hechos, transparente, estado }: { children: ReactNode; paso?: number; hechos?: number; transparente?: boolean; estado?: EstadoAlta }) {
  const pasos = ['Tu negocio', 'Funciones', 'Datos', 'Catálogo', 'Propuesta y pago', 'Tu panel'];
  const n = hechos ?? paso ?? 0;
  const e = estado ?? BORRADOR;
  return (
    <div className="publico">
      <header className={`nav ${transparente ? 'transparente' : ''}`}>
        <Link to="/bienvenida" className="marca-logo"><i aria-hidden="true" />Plataforma</Link>
        {paso === undefined ? (
          <>
            <nav className="enlaces" aria-label="Sitio">
              <a className="nav-item" href="/bienvenida#como">Cómo funciona</a>
              <a className="nav-item" href="/bienvenida#confianza">Control</a>
              <a className="nav-item" href="/bienvenida#funciones">Funciones</a>
            </nav>
            <div className="fila nav-acciones">
              <Link to="/entrar" className="btn sutil">Entrar</Link>
              <Link to="/empezar" className="btn primario">Crear mi plataforma</Link>
            </div>
          </>
        ) : (
          <span className={`estado ${e.tono} borrador`} role="status"><Icon n={e.icono} className="" />{e.texto}</span>
        )}
      </header>
      {paso !== undefined && (
        <div className="centro" style={{ paddingBottom: 0, paddingTop: 8 }}>
          <ol className="pasos-onb" aria-label={n >= pasos.length ? 'Alta completada' : `Paso ${paso + 1} de ${pasos.length}`}>
            {pasos.map((p, i) => <li key={p} className={`p ${i < n ? 'hecho' : i === paso ? 'on' : ''}`} aria-current={i === paso && i >= n ? 'step' : undefined}><b>{i < n ? <Icon n="ok" className="" size={12} /> : i + 1}</b>{p}{i < n && <span className="sr"> (hecho)</span>}</li>)}
          </ol>
        </div>
      )}
      {transparente ? children : <div className="centro">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- SCR-001
export function Landing() {
  return (
    <PublicoLayout transparente>
      <Experience />
      <FeatureBuilder />
      <footer className="pie-legal">Facturación electrónica a través de proveedor tecnológico habilitado por la DIAN. Tratamiento de datos personales conforme a la Ley 1581 de 2012. Entorno de pruebas del piloto.</footer>
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
  // Solo un borrador inexistente se olvida; un fallo de red no borra la referencia.
  useEffect(() => { if (tk) api.get(`/api/onboarding/borradores/${tk}`).then(setD).catch((e) => { if ((e as ApiError).status === 404) guardar('borrador', null); }); }, [tk]);
  return { tk, d, setD };
}

export function Describir() {
  const nav = useNavigate();
  const { d, setD } = useBorrador();
  const [texto, setTexto] = useState('');
  const [planes, setPlanes] = useState<any[]>([]);
  const { run, ocupado } = useAccion();
  useEffect(() => { api.get('/api/publico/planes').then(setPlanes); }, []);
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
          <div className="contenedor"><Vacio titulo="Aquí verás la propuesta">Describe lo que haces. Te recomendaremos funciones y verás cuánto suman antes de continuar.</Vacio></div>
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
  const { d, setD } = useBorrador();
  const [f, setF] = useState<any>({});
  const [faltan, setFaltan] = useState<string[]>([]);
  const [errLogo, setErrLogo] = useState('');
  const { run, ocupado } = useAccion();
  useEffect(() => { if (d) setF({ ...d.negocio, recursos: (d.negocio.recursos ?? []).join(', ') }); }, [d?.token]); // eslint-disable-line
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
    <input className={`input ${faltan.includes(k) ? 'falta' : ''}`} type={type} value={f[k] ?? ''} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
  );
  const tema = d.tema;
  return (
    <PublicoLayout paso={2}>
      <div className="grid g-main onboarding-layout" style={{ alignItems: 'start', marginTop: 32, gap: 24 }}>
        <div className="tarjeta col" style={{ gap: 20, padding: 28 }}>
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
          <div className="fila entre"><Link to="/empezar" className="btn sutil">Atrás</Link><button className="btn primario" disabled={ocupado} onClick={seguir}>Continuar <Icon n="flecha" className="" size={14} /></button></div>
          <p className="tenue peq-txt">Nada de esto ha creado aún tu empresa: se guarda como borrador hasta el pago.</p>
        </div>
        <div className="tarjeta col" style={{ gap: 16, padding: 28 }}>
          <h2 className="titulo-tarjeta">Identidad visual</h2>
          <label className="btn" style={{ alignSelf: 'flex-start' }}><Icon n="subir" className="" size={16} /> Subir logotipo<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && subirLogo(e.target.files[0])} /></label>
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
  const { d, setD } = useBorrador();
  const [prev, setPrev] = useState<any>(null);
  const [filas, setFilas] = useState<any[]>([]);
  const [manual, setManual] = useState<any[] | null>(null);
  const { run, ocupado } = useAccion();
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
                      {['nombre', 'precio', 'categoria', 'tipo', 'duracion_min', 'stock', 'iva_pct', 'sku', 'ignorar'].map((c) => <option key={c} value={c}>{c}</option>)}
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
  const { d } = useBorrador();
  const { run, ocupado } = useAccion();
  const activate = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${d.token}/pago`));
    if (r) window.location.href = r.url.replace(/^https?:\/\/[^/]+/, '');
  };
  if (!d) return <PublicoLayout paso={4}><Vacio titulo="Primero configura tu negocio" accion={<Link className="btn primario" to="/empezar">Empezar</Link>} /></PublicoLayout>;
  return <PublicoLayout paso={4}><section className="proposal-summary">
    <h1 className="onb-titulo">Revisa tu propuesta</h1>
    <p className="sec">Esta es la plataforma de {d.negocio?.nombre ?? 'tu negocio'}. Revisa las funciones y el desglose antes de continuar.</p>
    <Quote quote={d.cotizacion} />
    <div className="aviso peq-txt"><Icon n="info" className="" size={16} />Estás en una demostración. La activación usa una pasarela simulada, sin tarjeta ni cobros reales.</div>
    <div className="fila envolver" style={{ gap: 8 }}>
      {d.demo_checkout_disponible && <button className="btn primario grande" disabled={ocupado} onClick={activate}>{ocupado ? 'Preparando…' : 'Ir al pago de prueba'}</button>}
      {d.estado === 'BORRADOR' && <Link className="btn grande" to="/empezar">Ajustar funciones</Link>}
    </div>
    <p className="tenue peq-txt">Tu panel se crea solo después de que la pasarela confirme el pago.</p>
  </section></PublicoLayout>;
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
    // La respuesta de la pasarela no prueba el alta: el cierre consulta el estado real en el servidor.
    if (r === 'aprobado' && alta) nav('/empezar/listo', { replace: true });
  };
  const reintentar = async () => {
    const x = await run(() => api.post(`/api/onboarding/borradores/${leer('borrador')}/pago`));
    if (x) window.location.assign(x.url.replace(/^https?:\/\/[^/]+/, ''));
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
function PanelPersonalizado({ d, st, real }: { d: any; st: any; real: boolean }) {
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
        <span className="cp-nota">{real ? 'Tu panel, con los datos que guardó el servidor al crearlo.' : 'Vista previa con los datos de tu borrador. El panel se crea cuando la pasarela confirme el pago.'}</span>
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
        if (debeConsultar(faseCierre(tk, s, null))) t = window.setTimeout(tick, 1500);
      } catch (e) { if (vivo) setError(e as ApiError); }
    };
    tick();
    return () => { vivo = false; clearTimeout(t); };
  }, [tk, consulta]);

  const fase = faseCierre(tk, st, error);
  const listo = fase === 'listo';
  const pago = st?.pago;
  const necesitaCrear = listo && st.requiere_contrasena && !creada;

  const irAPagar = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${tk}/pago`));
    if (r) window.location.assign(r.url.replace(/^https?:\/\/[^/]+/, ''));
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
    <PublicoLayout paso={Math.min(hechos, 5)} hechos={hechos} estado={CABECERA[fase]}>
      <div className={`cierre ${fase === 'sin_borrador' ? 'solo' : ''}`}>
        <section className="tarjeta col cierre-estado" aria-live="polite">
          <h1 className="onb-titulo">{titulo[fase]}</h1>
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
          {fase === 'confirmando' && <p className="sec">La pasarela confirmó el pago. Volvemos a consultar cada pocos segundos hasta que el panel figure como creado.</p>}
          {listo && <>
            <p className="sec">Tu espacio de trabajo está en <span className="mono">{st.tenant.slug}.localhost</span>. Entra para empezar a atender.</p>
            <form className="decision col" style={{ gap: 14, padding: 20 }} onSubmit={entrar}>
              {necesitaCrear
                ? <Campo etiqueta={`Crea tu contraseña para ${st.email}`} ayuda="mínimo 10 caracteres"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Campo>
                : <Campo etiqueta={`Contraseña de ${st.email}`}><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></Campo>}
              {errAcceso && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{errAcceso}</p>}
              <button className="btn primario" disabled={entrando || (necesitaCrear ? pw.length < 10 : !pw)}>{entrando ? 'Entrando…' : errAcceso && creada ? 'Volver a intentar entrar' : 'Entrar a mi panel'}</button>
            </form>
            {Array.isArray(st.etapas) && st.etapas.length > 0 && <details className="cierre-etapas"><summary>Qué quedó registrado al crear el panel</summary>
              <ul>{st.etapas.map((e: any) => <li key={e.etapa}><Icon n="ok" className="" size={14} />{ETAPAS[e.etapa] ?? e.etapa}</li>)}</ul></details>}
          </>}
          {fase !== 'sin_borrador' && <p className="tenue peq-txt">Si la pasarela repite la notificación del pago, no se crea un segundo panel: cada pago se procesa una sola vez.</p>}
        </section>
        {fase !== 'sin_borrador' && (listo ? st.panel : d) && <PanelPersonalizado d={d} st={st} real={listo && !!st.panel} />}
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
  const enviar = async (e: FormEvent) => {
    e.preventDefault(); if (busy) return; setBusy(true); setErr('');
    try {
      const r = await api.post('/api/auth/login', { email, password: pw });
      const next = q.get('volver');
      if (slugDelHost()) return nav(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
      if (r.empresas.length === 1) { guardar('empresa', r.empresas[0].slug); return nav('/'); }
      if (!r.empresas.length && r.usuario.es_admin_plataforma) return nav('/plataforma');
      nav('/empresas');
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return <PublicoLayout><div className="auth-layout">
    <form className="auth-form col" onSubmit={enviar} aria-labelledby="titulo-entrar">
      <h1 id="titulo-entrar">Entra a tu negocio</h1>
      {slugDelHost() ? <span className="estado neutro" style={{ alignSelf: 'flex-start' }}><Icon n="plataforma" className="" />Negocio: {slugDelHost()}</span> : <p className="sec">Si trabajas en varias empresas, eliges una después de entrar.</p>}
      <Campo etiqueta="Correo"><input className="input" type="email" placeholder="tu@negocio.com" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required /></Campo>
      <Campo etiqueta="Contraseña"><div className="password-field"><input className="input" type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" required /><button type="button" className="btn sutil peq" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={show} onClick={() => setShow(v => !v)}>{show ? 'Ocultar' : 'Mostrar'}</button></div></Campo>
      {err && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{err}</p>}
      <button className="btn primario grande" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      <p className="auth-register">¿Tu negocio aún no tiene su espacio? <Link to="/empezar">Crear mi plataforma</Link></p>
      <details className="demo-accounts"><summary>Usar una cuenta de demostración</summary><p>Correo <span className="mono">admin@elparche.test</span><br />Contraseña <span className="mono">demo-parche-2026</span></p></details>
    </form>
    <section className="auth-story" aria-label="Qué encontrarás en tu panel">
      <h2>Lo que te espera en tu panel</h2>
      <ul>
        <li><Icon n="conversaciones" className="" size={20} /><span><b>Conversaciones de WhatsApp</b>La IA atiende y una persona del equipo entra al mismo hilo cuando hace falta.</span></li>
        <li><Icon n="agenda" className="" size={20} /><span><b>Agenda y ventas</b>Cada cita y cada venta quedan conectadas con su cliente.</span></li>
        <li><Icon n="facturacion" className="" size={20} /><span><b>Facturación electrónica</b>Sigues cada factura hasta su validación y entrega.</span></li>
      </ul>
    </section>
  </div></PublicoLayout>;
}

export function Empresas() {
  const nav = useNavigate();
  const [s, setS] = useState<any>(null);
  useEffect(() => { api.get('/api/auth/sesion').then(setS).catch(() => nav('/entrar')); }, [nav]);
  if (!s) return null;
  return (
    <PublicoLayout>
      <div className="tarjeta col" style={{ maxWidth: 480, margin: '48px auto', gap: 12, padding: 28 }}>
        <h1 className="onb-titulo" style={{ fontSize: 24 }}>Hola, {s.usuario.nombre.split(' ')[0]}. ¿En qué empresa vas a trabajar?</h1>
        <p className="tenue">Tu rol puede ser distinto en cada una. Elegir una empresa solo cambia lo que ves: el servidor valida tu acceso.</p>
        {s.empresas.length === 0 && <Vacio titulo="Tu cuenta no pertenece a ninguna empresa">Pide a un administrador que te invite, o crea tu plataforma.</Vacio>}
        {s.empresas.map((e: any) => (
          <button key={e.id} className="btn fila" style={{ justifyContent: 'flex-start', height: 'auto', padding: '10px 14px', gap: 12 }} onClick={() => { guardar('empresa', e.slug); nav('/'); }}>
            <span style={{ width: 32, height: 32, borderRadius: 8, background: e.tema?.acento ?? 'var(--tinta-3)', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 13, flex: 'none' }} aria-hidden="true">{e.tema?.monograma}</span>
            <span style={{ textAlign: 'left', minWidth: 0 }}><b>{e.nombre}</b><br /><span className="tenue peq-txt">{e.rol} · {e.slug}.localhost</span></span>
            <Icon n="derecha" className="" size={16} />
          </button>
        ))}
        {s.usuario.es_admin_plataforma && <Link className="btn" to="/plataforma">Administración de la plataforma</Link>}
      </div>
    </PublicoLayout>
  );
}

export function Plataforma() {
  const [t, setT] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api.get('/api/plataforma/tenants').then(setT).catch((e) => setErr(e.message)); }, []);
  return (
    <PublicoLayout>
      <section className="tarjeta" style={{ marginTop: 32 }}>
        <div className="cab"><h1 className="titulo" style={{ fontSize: 20 }}>Empresas de la plataforma</h1><span className="tenue peq-txt">El administrador del SaaS gobierna; no opera datos de los negocios.</span></div>
        {err ? <div className="cuerpo"><div className="bloqueado"><Icon n="candado" className="" size={16} />No encontramos eso.</div></div> : !t ? <Cargando /> : (
          <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Empresa</th><th>Subdominio</th><th>Sector</th><th>Plan</th><th>Suscripción</th><th className="num">Tokens IA del mes</th><th>Alta</th></tr></thead>
            <tbody>{t.map((x) => <tr key={x.id}><td>{x.nombre}</td><td className="mono">{x.slug}</td><td>{x.sector}</td><td>{x.plan_codigo}</td><td><Estado v={x.estado} /></td><td className="num">{Number(x.tokens_mes).toLocaleString('es-CO')}</td><td>{new Date(x.creado_en).toLocaleDateString('es-CO')}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </PublicoLayout>
  );
}
