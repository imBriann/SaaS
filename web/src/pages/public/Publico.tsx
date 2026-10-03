import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, cop, guardar, leer, slugDelHost } from '../../api';
import { Campo, Estado, CicloFiscal, useAccion, Vacio } from '../../components/ui';
import { Quote } from '../../components/Quote';
import { Experience, FeatureBuilder } from '../../components/Experience';
import { Icon } from '../../components/icons';

export function PublicoLayout({ children, paso, transparente }: { children: ReactNode; paso?: number; transparente?: boolean }) {
  const pasos = ['Tu negocio', 'Funciones', 'Datos', 'Catálogo', 'Propuesta', 'Listo'];
  return (
    <div className="publico">
      <header className={`nav ${transparente ? 'transparente' : ''}`}>
        <Link to="/bienvenida" className="marca-logo"><i />Plataforma</Link>
        {paso === undefined ? (
          <>
            <nav className="enlaces" aria-label="Sitio">
              <a className="nav-item" href="/bienvenida#como">Cómo funciona</a>
              <a className="nav-item" href="/bienvenida#confianza">Cómo te ayuda</a>
              <a className="nav-item" href="/bienvenida#funciones">Funciones</a>
            </nav>
            <div className="fila" style={{ gap: 12 }}>
              <Link to="/entrar" className="btn fantasma">Entrar</Link>
              <Link to="/empezar" className="btn primario" style={{ marginLeft: 20 }}>Crear mi plataforma</Link>
            </div>
          </>
        ) : (
          <span className="borrador" style={{ marginLeft: 'auto' }}>
            {paso < 5 ? <><Icon n="reloj" className="" size={14} /> Guardado como borrador · aún no existe ninguna empresa</> : <><Icon n="ok" className="" size={14} /> Pago verificado</>}
          </span>
        )}
      </header>
      {paso !== undefined && (
        <div className="centro" style={{ paddingBottom: 0, paddingTop: 8 }}>
          <div className="pasos-onb" aria-label={`Paso ${paso + 1} de ${pasos.length}`}>
            {pasos.map((p, i) => <span key={p} className={`p ${i === paso ? 'on' : i < paso ? 'hecho' : ''}`}><b>{i < paso ? '✓' : i + 1}</b>{p}</span>)}
          </div>
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
  useEffect(() => { if (tk) api.get(`/api/onboarding/borradores/${tk}`).then(setD).catch(() => guardar('borrador', null)); }, [tk]);
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
        <form className="tarjeta col" style={{ gap: 20, padding: 32 }} onSubmit={enviar}>
          <span className="eyebrow">DISEÑA TU PLATAFORMA CON IA</span><h1 className="onb-titulo">Primero, hablemos de ti.</h1>
          <p className="sec">Con tus palabras: qué vendes, cuántos son y cómo atienden hoy. Con eso proponemos una configuración; tú corriges lo que haga falta.</p>
          <textarea aria-label="Describe tu negocio" maxLength={2000} className="input" style={{ minHeight: 160, fontSize: 16 }} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Ej.: Tengo una barbería en Cúcuta con tres barberos. Nos escriben unos 20 mensajes al día por WhatsApp para pedir turno y necesito empezar a facturar electrónico." />
          <div className="fila entre"><span className="tenue">{texto.length}/2000</span><button className="btn primario" disabled={ocupado || texto.trim().length < 15}>{ocupado ? 'Analizando…' : d ? 'Volver a analizar' : 'Analizar mi negocio'}</button></div>
        </form>
        {!c ? (
          <div className="contenedor"><Vacio titulo="Aquí verás la propuesta">Describe lo que haces. Te recomendaremos funciones y verás cuánto suman antes de continuar.</Vacio></div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <section className="tarjeta">
              <div className="cab"><h2 className="titulo-tarjeta">Lo que entendimos</h2>
                <span className="chip" style={{ marginLeft: 'auto' }}>✧ Recomendación para ti</span></div>
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
            <section className="decision">
              <div className="cuerpo col" style={{ gap: 16 }}>
                <Quote quote={d.cotizacion} loading={ocupado} />
                <h2 className="titulo-tarjeta">Un sistema a la medida de tu operación.</h2>
                <p className="sec">Selecciona arriba las funciones que necesitas. La propuesta se define según esas funciones, tu equipo y el volumen de uso.</p>
                <button className="btn primario" disabled={ocupado} onClick={() => nav('/empezar/datos')}>Continuar con mi configuración <Icon n="flecha" className="" size={15} /></button>
              </div>
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
    if (file.size > 200_000) return alert('El logotipo debe pesar menos de 200 KB.');
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
        <div className="tarjeta col" style={{ gap: 20, padding: 32 }}>
          <h1 className="onb-titulo">Datos del negocio</h1>
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
          <p className="tenue">Nada de esto ha creado aún tu empresa: se guarda como borrador hasta el pago.</p>
        </div>
        <div className="tarjeta col" style={{ gap: 20, padding: 32 }}>
          <span className="etiqueta">Identidad visual</span>
          <label className="btn" style={{ alignSelf: 'flex-start' }}><Icon n="subir" className="" size={14} /> Subir logotipo<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && subirLogo(e.target.files[0])} /></label>
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
              <div className="fila" style={{ gap: 6 }}>{[tema.acento, tema.acento_sobre_oscuro, '#1e1e2a', '#171721'].map((c: string) => <span key={c} title={c} style={{ width: 28, height: 28, borderRadius: 6, background: c, border: '1px solid var(--linea-2)' }} />)}</div>
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
        <div className="fila entre"><h1 className="onb-titulo">Tu catálogo</h1><button className="btn sutil" onClick={() => nav('/empezar/pago')}>Omitir: usar el catálogo de ejemplo del sector</button></div>
        {!prev && !manual && (
          <div className="grid g3">
            <label className="tarjeta pilar" style={{ cursor: 'pointer' }}>
              <Icon n="subir" size={22} /><b className="titulo-tarjeta">Subir mi hoja de cálculo</b>
              <span className="sec">.xlsx o .csv. Detectamos las columnas aunque vengan desordenadas; tú confirmas antes de guardar.</span>
              <input type="file" accept=".xlsx,.csv" hidden onChange={(e) => e.target.files?.[0] && subir(e.target.files[0])} />
              {ocupado && <span className="tenue">Leyendo el archivo…</span>}
            </label>
            <button className="tarjeta pilar" style={{ textAlign: 'left', cursor: 'pointer', border: 0, color: 'inherit' }} onClick={() => setManual([{ tipo: 'SERVICIO', nombre: '', precio: '', duracion_min: 30, categoria: '' }])}>
              <Icon n="facturacion" size={22} /><b className="titulo-tarjeta">Escribirlo a mano</b><span className="sec">Pocos productos o servicios: agrégalos aquí mismo.</span>
            </button>
            <a className="tarjeta pilar" href="/api/onboarding/plantilla-catalogo.xlsx" style={{ color: 'inherit', textDecoration: 'none' }}>
              <Icon n="inventario" size={22} /><b className="titulo-tarjeta">Descargar plantilla</b><span className="sec">Llénala y súbela después.</span>
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
                      <td><select className="input" style={{ padding: '2px 6px' }} value={f.tipo} onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, tipo: e.target.value } : x)))}><option>SERVICIO</option><option>PRODUCTO</option></select></td>
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
                <div key={i} className="grid" style={{ gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr', gap: 8 }}>
                  <select className="input" value={f.tipo} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, tipo: e.target.value } : x)))}><option>SERVICIO</option><option>PRODUCTO</option></select>
                  <input className="input" placeholder="Nombre" value={f.nombre} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, nombre: e.target.value } : x)))} />
                  <input className="input" placeholder="Precio" inputMode="numeric" value={f.precio} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, precio: e.target.value.replace(/\D/g, '') } : x)))} />
                  <input className="input" placeholder="Minutos" inputMode="numeric" value={f.duracion_min ?? ''} disabled={f.tipo !== 'SERVICIO'} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, duracion_min: e.target.value } : x)))} />
                  <input className="input" placeholder="Categoría" value={f.categoria} onChange={(e) => setManual(manual.map((x, j) => (j === i ? { ...x, categoria: e.target.value } : x)))} />
                </div>
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
    <span className="eyebrow">TU CONFIGURACIÓN ESTÁ LISTA</span>
    <h1>Todo listo para<br /><em>dar el siguiente paso.</em></h1>
    <p>Esta es la plataforma de {d.negocio?.nombre}. Revisa las funciones y el desglose antes de continuar.</p>
    <Quote quote={d.cotizacion} />
    <p className="tenue">Estás en una demostración. La activación usa una pasarela simulada, sin tarjeta ni cobros reales.</p>
    {d.demo_checkout_disponible && <button className="btn primario" disabled={ocupado} onClick={activate}>{ocupado ? 'Preparando…' : 'Probar activación de mi plataforma ↗'}</button>}
    {d.estado === 'BORRADOR' && <Link className="btn" to="/empezar">Ajustar funciones</Link>}
  </section></PublicoLayout>;
}

/** Pasarela simulada: representa el checkout alojado del proveedor de pagos. */
export function Pasarela() {
  const [q] = useSearchParams();
  const ref = q.get('ref') ?? '';
  const monto = Number(q.get('monto') ?? 0);
  const [res, setRes] = useState<any>(null);
  const { run, ocupado } = useAccion();
  const nav = useNavigate();
  const pagar = async (resultado: string, entregas = 1) => {
    const r = await run(() => api.post('/api/pasarela/simular', { ref, resultado, entregas }));
    if (r) {
      setRes(r);
      if (resultado === 'aprobado' && ref.startsWith('SUB-') && leer('borrador')) setTimeout(() => nav('/empezar/listo'), 900);
    }
  };
  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(ellipse at 50% 0%, #252a48, var(--onyx) 70%)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="tarjeta col" style={{ width: 400, gap: 16, padding: 32 }}>
        <span className="etiqueta">Pasarela de pagos · entorno de pruebas</span>
        <b style={{ fontSize: 16 }}>{q.get('concepto') ?? (q.get('cuenta') ? `Cobro de ${q.get('cuenta')}` : 'Pago')}</b>
        <span className="cifra">{cop(monto)}</span>
        <span className="mono tenue">Ref. {ref}</span>
        <input className="input" placeholder="Número de tarjeta de prueba" defaultValue="4242 4242 4242 4242" readOnly aria-label="Tarjeta de prueba" />
        <button className="btn primario grande" disabled={ocupado || !!res} onClick={() => pagar('aprobado')}>Pagar</button>
        <div className="fila envolver">
          <button className="btn peq" disabled={ocupado || !!res} onClick={() => pagar('rechazado')}>Simular rechazo</button>
          <button className="btn peq" disabled={ocupado || !!res} onClick={() => pagar('aprobado', 3)} title="La pasarela reintenta el webhook: debe crearse UNA sola empresa">Aprobar con webhook ×3</button>
        </div>
        {res && <div className="col">{res.entregas.map((e: any, i: number) => <span key={i} className="mono tenue">webhook #{i + 1}: {e.status} {e.body.duplicado ? '· duplicado ignorado' : e.body.ok ? '· procesado' : JSON.stringify(e.body)}</span>)}</div>}
        {res && !ref.startsWith('SUB-') && <span className="sec">Pago conciliado. Puedes cerrar esta ventana.</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- SCR-008
const ETAPAS: Record<string, string> = {
  pago_verificado: 'Pago verificado', empresa_creada: 'Empresa creada', plantilla_aplicada: 'Plantilla del sector aplicada', catalogo_importado: 'Catálogo importado',
  administrador_creado: 'Administrador creado', tema_generado: 'Tema visual generado', subdominio_asignado: 'Subdominio asignado',
};
export function Aprovisionamiento() {
  const { tk } = useBorrador();
  const [st, setSt] = useState<any>(null);
  const [pw, setPw] = useState('');
  const { run, ocupado } = useAccion();
  const nav = useNavigate();
  useEffect(() => {
    if (!tk) return;
    let vivo = true;
    const tick = async () => {
      const s = await api.get(`/api/onboarding/borradores/${tk}/estado`).catch(() => null);
      if (!vivo) return;
      setSt(s);
      if (s?.estado !== 'APROVISIONADO') setTimeout(tick, 1200);
    };
    tick();
    return () => { vivo = false; };
  }, [tk]);
  const listo = st?.estado === 'APROVISIONADO';
  const entrar = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${tk}/contrasena`, { password: pw }));
    if (!r) return;
    await run(() => api.post('/api/auth/login', { email: st.email, password: pw }));
    guardar('empresa', st.tenant.slug);
    guardar('borrador', null);
    nav('/');
  };
  return (
    <PublicoLayout paso={5}>
      <div className="tarjeta col" style={{ maxWidth: 580, margin: '40px auto', gap: 20, padding: 36 }}>
        <h1 className="onb-titulo">{listo ? `¡${st.tenant.nombre} está lista!` : st?.pago?.estado === 'RECHAZADO' ? 'El pago fue rechazado' : 'Estamos creando tu empresa…'}</h1>
        {st?.pago?.estado === 'RECHAZADO' && <Link className="btn primario" to="/empezar/pago">Intentar de nuevo</Link>}
        <div className="col">
          {Object.entries(ETAPAS).map(([k, v]) => {
            const hecha = st?.etapas?.some((e: any) => e.etapa === k);
            return <div key={k} className="fila">{hecha ? <Estado v="EXITO" texto={v} /> : <span className="estado neutro"><Icon n="reloj" className="" />{v}</span>}</div>;
          })}
        </div>
        <p className="tenue">Si la pasarela reintenta la notificación del pago, no se crea una segunda empresa: cada pago se procesa una sola vez.</p>
        {listo && st.requiere_contrasena && (
          <div className="decision col" style={{ gap: 14, padding: 24 }}>
            <Campo etiqueta={`Crea tu contraseña para ${st.email}`} ayuda="mínimo 10 caracteres"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Campo>
            <button className="btn primario" disabled={ocupado || pw.length < 10} onClick={entrar}>Entrar a mi panel</button>
          </div>
        )}
        {listo && !st.requiere_contrasena && <Link className="btn primario" to="/entrar">Iniciar sesión</Link>}
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
    <section className="auth-story"><span className="eyebrow">EL NEGOCIO ES TUYO. EL IMPULSO, TAMBIÉN.</span><h1>Qué bueno<br />tenerte <em>de vuelta.</em></h1><p>Tu equipo, tus clientes y tu siguiente gran idea. Todo empieza en un mismo lugar.</p><div className="auth-stack"><div><span>✧</span><b>Un asistente para avanzar</b><small>Atención con IA y control humano.</small></div><div><span>◷</span><b>Una agenda que te acompaña</b><small>Cada cita, cliente y detalle conectado.</small></div><div><span>↗</span><b>Tu operación, más clara</b><small>Lo importante siempre a la vista.</small></div></div><span className="auth-caption">Menos pendientes. Más posibilidades.</span></section>
    <form className="auth-form col" onSubmit={enviar}><span className="auth-symbol">p.</span><h2>Entra a tu espacio</h2><p className="sec">Vamos a hacer que hoy cuente.</p>
      {slugDelHost() && <span className="chip">Negocio: {slugDelHost()}</span>}
      <Campo etiqueta="Tu correo"><input className="input" aria-label="Tu correo" type="email" placeholder="tu@negocio.com" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" required /></Campo>
      <Campo etiqueta="Contraseña"><div className="password-field"><input className="input" aria-label="Contraseña" type={show ? 'text' : 'password'} placeholder="Tu contraseña" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" required /><button type="button" aria-label={show ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setShow(v => !v)}>{show ? 'Ocultar' : 'Mostrar'}</button></div></Campo>
      {err && <p role="alert" className="bloqueado">{err}</p>}<button className="btn primario" disabled={busy}>{busy ? 'Entrando…' : 'Entrar a mi negocio ↗'}</button>
      <p className="auth-register">¿Tu negocio aún no tiene su espacio?<br /><Link to="/empezar">Crear mi plataforma</Link></p>
      <details className="demo-accounts"><summary>Explorar con una cuenta de demostración</summary><p>admin@elparche.test<br />demo-parche-2026</p></details>
    </form></div></PublicoLayout>;
}

export function Empresas() {
  const nav = useNavigate();
  const [s, setS] = useState<any>(null);
  useEffect(() => { api.get('/api/auth/sesion').then(setS).catch(() => nav('/entrar')); }, [nav]);
  if (!s) return null;
  return (
    <PublicoLayout>
      <div className="tarjeta col" style={{ maxWidth: 480, margin: '72px auto', gap: 14, padding: 36 }}>
        <h1 className="onb-titulo" style={{ fontSize: 26 }}>Hola, {s.usuario.nombre.split(' ')[0]}. ¿En qué empresa vas a trabajar?</h1>
        <p className="tenue">Tu rol puede ser distinto en cada una.</p>
        {s.empresas.map((e: any) => (
          <button key={e.id} className="btn fila" style={{ justifyContent: 'flex-start', height: 'auto', padding: '12px 16px', borderRadius: 16 }} onClick={() => { guardar('empresa', e.slug); nav('/'); }}>
            <span style={{ width: 26, height: 26, borderRadius: 6, background: e.tema?.acento ?? '#555', color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 500, fontSize: 12.5 }}>{e.tema?.monograma}</span>
            <span style={{ textAlign: 'left' }}><b>{e.nombre}</b><br /><span className="tenue">{e.rol} · {e.slug}.localhost</span></span>
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
        <div className="cab"><h1 className="titulo">Tenants de la plataforma</h1><span className="tenue" style={{ marginLeft: 'auto' }}>El administrador del SaaS gobierna; no opera datos de los negocios.</span></div>
        {err ? <div className="cuerpo bloqueado">No encontramos eso.</div> : !t ? null : (
          <table className="tabla"><thead><tr><th>Empresa</th><th>Subdominio</th><th>Sector</th><th>Plan</th><th>Suscripción</th><th className="num">Tokens IA del mes</th><th>Alta</th></tr></thead>
            <tbody>{t.map((x) => <tr key={x.id}><td>{x.nombre}</td><td className="mono">{x.slug}</td><td>{x.sector}</td><td>{x.plan_codigo}</td><td><Estado v={x.estado} /></td><td className="num">{Number(x.tokens_mes).toLocaleString('es-CO')}</td><td>{new Date(x.creado_en).toLocaleDateString('es-CO')}</td></tr>)}</tbody></table>
        )}
      </section>
    </PublicoLayout>
  );
}
