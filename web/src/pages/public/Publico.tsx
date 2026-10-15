import { ImportSummary } from '../../components/ImportSummary';
import { ImportarCatalogo } from '../../components/ImportarCatalogo';
import { AnalisisEnCurso, PropuestaIA } from '../../components/PropuestaIA';
import { RegistrationData } from '../../components/RegistrationData';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, cop, descargarDocumentos, guardar, irAEmpresa, leer, slugDelHost } from '../../api';
import { debeConsultar, faseCierre, pasosCumplidos, type FaseCierre } from './cierre';
import { faseRecibo, reciboEnCurso, type FaseRecibo } from './recibo';
import { useFaseMinima, useRevelado } from './ritmo';
import { ReciboImpresion } from '../../components/ReciboImpresion';
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

/** Llave del borrador recibida en el enlace del correo (#borrador=…). El fragmento nunca llega al servidor. */
function llaveDelEnlace(): string | null {
  const m = /(?:^#|&)borrador=([\w-]{20,64})(?:&|$)/.exec(window.location.hash);
  if (!m) return null;
  guardar('borrador', m[1]);
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
  return m[1];
}

export function useBorrador() {
  const [tk] = useState(() => llaveDelEnlace() ?? (sessionStorage.getItem('descripcion_inicial') ? null : leer('borrador')));
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

/** Pistas de escritura: indican qué datos ayudan a la IA y si el texto parece mencionarlos (no son confirmaciones). */
const PISTAS: [string, RegExp][] = [
  ['Qué vendes o qué servicio das', /\b(vend|ofrec|servicio|tienda|negocio|barber|veterin|restaur|academ|taller|consultor|clinica|cafe|panader|gimnas|almac|distribu)/i],
  ['Cuántas personas atienden', /\b(\d+|solo yo|yo sol[oa]|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s*(person|emplead|barber|medic|auxiliar|asesor|trabajador|vendedor|estilist|socio|colaborador)?|\batiendo yo\b/i],
  ['Cuántos mensajes o clientes recibes', /\b\d+\s*(mensaje|chat|conversaci|cliente|pedido|cita)/i],
  ['Si necesitas facturar electrónicamente', /factur|dian/i],
];

export function Describir() {
  const nav = useNavigate();
  const { d, setD, error: errorBorrador, recargar: recargarBorrador } = useBorrador();
  const [texto, setTexto] = useState('');
  const analisis = useAccion();
  const edicion = useAccion();
  useEffect(() => { if (d?.descripcion && !texto) setTexto(d.descripcion); }, [d]); // eslint-disable-line

  const analizar = async (descripcion: string) => {
    const r = await analisis.run(() => api.post(d ? `/api/onboarding/borradores/${d.token}/analizar` : '/api/onboarding/borradores', { descripcion }));
    if (r) {
      guardar('borrador', r.token);
      const stored = sessionStorage.getItem('funciones_elegidas');
      if (stored) {
        const updated = await edicion.run(() => api.patch(`/api/onboarding/borradores/${r.token}`, { clasificacion: { modulos_sugeridos: JSON.parse(stored) } }));
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
  const cambiar = async (cambios: Record<string, unknown>) => {
    const r = await edicion.run(() => api.patch(`/api/onboarding/borradores/${d.token}`, { clasificacion: cambios }));
    if (r) setD(r);
  };
  const c = d?.clasificacion;
  const largo = texto.trim().length;
  const cambioTexto = !!d && texto.trim() !== (d.descripcion ?? '').trim();
  const actividadLista = !!c?.sector && (c.sector !== 'otro' ? !!c.tipo_negocio : !!c.otro_descripcion);

  return (
    <PublicoLayout paso={d ? 1 : 0}>
      {errorBorrador && <ErrorCarga error={errorBorrador} reintentar={recargarBorrador} />}
      <div className="describir">
        <form className="describir-texto" onSubmit={enviar}>
          <span className="ia-etiqueta"><Icon n="ia" className="" size={14} />Configuración asistida por IA</span>
          <h1 className="onb-titulo">Cuéntanos de tu negocio con tus palabras.</h1>
          <p className="sec">La IA de {MARCA.nombre} lee lo que escribas, te propone una configuración y tú decides qué se queda. Nada se confirma sin ti.</p>
          <label className="campo"><span>Describe tu negocio</span>
            <textarea maxLength={2000} className="input describir-area" value={texto} onChange={(e) => setTexto(e.target.value)} disabled={analisis.ocupado}
              placeholder="Ej.: Tengo una barbería en Cúcuta con tres barberos. Nos escriben unos 20 mensajes al día por WhatsApp para pedir turno y necesito empezar a facturar electrónicamente." aria-describedby="desc-ayuda desc-pistas" />
          </label>
          <ul className="describir-pistas" id="desc-pistas" aria-label="Lo que ayuda a la IA">
            {PISTAS.map(([p, re]) => { const ok = re.test(texto); return <li key={p} className={ok ? 'on' : ''}><span aria-hidden="true">{ok ? <Icon n="ok" className="" size={12} /> : null}</span>{p}<span className="sr">{ok ? ' (mencionado)' : ''}</span></li>; })}
          </ul>
          <div className="fila entre envolver" style={{ gap: 12 }}>
            <span className="tenue peq-txt" id="desc-ayuda">{largo < 15 ? `Escribe al menos 15 caracteres (${largo}/15).` : cambioTexto ? 'Cambiaste la descripción: vuelve a analizar para actualizar la propuesta. Tus respuestas se conservan.' : `${texto.length}/2000`}</span>
            <button className="btn primario" disabled={analisis.ocupado || largo < 15 || (!!d && !cambioTexto)}>{analisis.ocupado ? 'Analizando…' : d ? 'Volver a analizar' : 'Analizar mi negocio'}</button>
          </div>
          {analisis.error && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{analisis.error.message}</p>}
        </form>

        <div className="describir-resultado">
          {analisis.ocupado ? <AnalisisEnCurso /> : !c ? (
            <aside className="onboarding-intro"><img src={MARCA.isologo} width={56} height={56} alt="" /><h2>Una frase basta para empezar.</h2>
              <p>Con tu descripción la IA propone actividad, equipo, volumen de conversaciones, facturación y funciones.</p>
              <ol><li>La IA interpreta lo que escribiste</li><li>Sugiere una configuración con sus razones</li><li>Tú confirmas o corriges cada dato</li></ol>
              <span>Tu espacio se crea solo después de confirmar el pago.</span></aside>
          ) : (
            <>
              <PropuestaIA c={c} ocupado={edicion.ocupado} cambiar={cambiar} />
              <section className="col" style={{ gap: 12 }} aria-label="Estimación">
                <Quote quote={d.cotizacion} loading={edicion.ocupado} modalidad={d.modalidad} />
                <button className="btn primario grande" disabled={edicion.ocupado || !actividadLista} onClick={() => nav('/empezar/datos')}>Continuar con los datos del negocio <Icon n="flecha" className="" size={16} /></button>
                {!actividadLista && <p className="tenue peq-txt" style={{ margin: 0 }}>Elige tu actividad en la propuesta para continuar.</p>}
              </section>
            </>
          )}
        </div>
      </div>
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- SCR-004
export function Datos() {
  const { d, setD, cargando, error, recargar } = useBorrador();
  return <PublicoLayout paso={2}>{error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando ? <Cargando filas={6} /> : d ? <RegistrationData d={d} setD={setD} /> : <Vacio titulo="No hay un borrador activo" accion={<Link className="btn primario" to="/empezar">Empezar</Link>} />}</PublicoLayout>;
}

export function Catalogo() {
  const nav = useNavigate();
  const { d, setD, cargando, error, recargar } = useBorrador();
  const [modo, setModo] = useState<'inicio' | 'archivo' | 'manual'>('inicio');
  const [resumen, setResumen] = useState<any>(null);
  const [manual, setManual] = useState<any[]>([{ tipo: 'SERVICIO', nombre: '', precio: '', duracion_min: 30, categoria: '' }]);
  const { run, ocupado } = useAccion();
  if (cargando) return <PublicoLayout paso={3}><Cargando /></PublicoLayout>;
  if (error) return <PublicoLayout paso={3}><ErrorCarga error={error} reintentar={recargar} /></PublicoLayout>;
  if (!d) return <PublicoLayout paso={3}><Vacio titulo="No hay un borrador activo" accion={<Link className="btn primario" to="/empezar">Empezar</Link>} /></PublicoLayout>;

  const guardado = (borrador: any, r: any) => { setD(borrador); setResumen(r); setModo('inicio'); };
  const guardarManual = async () => {
    const filas = manual.filter((f) => f.nombre.trim()).map((f, i) => ({ ...f, fila: i + 1, precio: Number(f.precio || 0), duracion_min: f.tipo === 'SERVICIO' ? Number(f.duracion_min) || null : null }));
    const r = await run(() => api.post(`/api/onboarding/borradores/${d.token}/catalogo/confirmar`, { filas, origen: 'manual', duplicados: 'omitir' }));
    if (r) guardado(r, r.resumen);
  };
  const cambiarManual = (i: number, k: string, v: string) => setManual(manual.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  return (
    <PublicoLayout paso={3}>
      <div className="col" style={{ gap: 22, marginTop: 32 }}>
        <header className="fila entre envolver" style={{ gap: 12, alignItems: 'flex-end' }}>
          <div className="col" style={{ gap: 6 }}>
            <h1 className="onb-titulo">Tu catálogo</h1>
            <p className="sec" style={{ margin: 0 }}>Tus productos y servicios, con precio. Puedes importarlos ahora o hacerlo después desde el panel.</p>
          </div>
          <button className="btn sutil" onClick={() => nav('/empezar/pago')}>{d.catalogo?.length ? 'Continuar al pago' : 'Lo haré después'} <Icon n="flecha" className="" size={14} /></button>
        </header>
        {d.catalogo?.length > 0 && !resumen && <p className="estado ok" style={{ alignSelf: 'flex-start', height: 'auto', padding: '6px 10px' }}><Icon n="ok" className="" />Tu borrador tiene {d.catalogo.length} {d.catalogo.length === 1 ? 'ítem' : 'ítems'}.</p>}
        {resumen && <ImportSummary resumen={resumen} draft onContinue={() => nav('/empezar/pago')} onOtro={() => { setResumen(null); setModo('archivo'); }} />}

        {!resumen && modo === 'inicio' && (
          <div className="opciones-catalogo">
            <button type="button" className="opcion-cat principal" onClick={() => setModo('archivo')}>
              <span className="module-icon"><Icon n="subir" className="" size={20} /></span><b className="titulo-tarjeta">Importar mi hoja de cálculo</b>
              <span className="sec">Excel (.xlsx) o .csv. Detectamos las columnas y revisas cada fila antes de guardar.</span>
            </button>
            <button type="button" className="opcion-cat" onClick={() => setModo('manual')}>
              <span className="module-icon"><Icon n="nota" className="" size={20} /></span><b className="titulo-tarjeta">Escribirlo a mano</b><span className="sec">Si son pocos productos o servicios.</span>
            </button>
            <a className="opcion-cat" href="/api/onboarding/plantilla-catalogo.xlsx">
              <span className="module-icon"><Icon n="descargar" className="" size={20} /></span><b className="titulo-tarjeta">Descargar la plantilla</b><span className="sec">Llénala con tus datos y súbela después.</span>
            </a>
          </div>
        )}
        {!resumen && modo === 'archivo' && <><button className="btn sutil peq" style={{ alignSelf: 'flex-start' }} onClick={() => setModo('inicio')}><Icon n="atras" className="" size={14} />Otras opciones</button><ImportarCatalogo d={d} onGuardado={guardado} /></>}
        {!resumen && modo === 'manual' && (
          <section className="tarjeta">
            <div className="cab"><h2 className="titulo-tarjeta">Escribe tus productos y servicios</h2><button className="btn sutil peq" style={{ marginLeft: 'auto' }} onClick={() => setModo('inicio')}>Otras opciones</button></div>
            <div className="cuerpo col">
              {manual.map((f, i) => (
                <fieldset key={i} className="fila-manual">
                  <legend className="sr">Ítem {i + 1}</legend>
                  <select className="input" aria-label={`Tipo del ítem ${i + 1}`} value={f.tipo} onChange={(e) => cambiarManual(i, 'tipo', e.target.value)}><option value="SERVICIO">Servicio</option><option value="PRODUCTO">Producto</option></select>
                  <input className="input" aria-label={`Nombre del ítem ${i + 1}`} placeholder="Nombre" value={f.nombre} onChange={(e) => cambiarManual(i, 'nombre', e.target.value)} />
                  <input className="input" aria-label={`Precio del ítem ${i + 1} en pesos`} placeholder="Precio" inputMode="numeric" value={f.precio} onChange={(e) => cambiarManual(i, 'precio', e.target.value.replace(/\D/g, ''))} />
                  <input className="input" aria-label={`Duración del ítem ${i + 1} en minutos`} placeholder="Minutos" inputMode="numeric" value={f.duracion_min ?? ''} disabled={f.tipo !== 'SERVICIO'} onChange={(e) => cambiarManual(i, 'duracion_min', e.target.value.replace(/\D/g, ''))} />
                  <input className="input" aria-label={`Categoría del ítem ${i + 1}`} placeholder="Categoría" value={f.categoria} onChange={(e) => cambiarManual(i, 'categoria', e.target.value)} />
                </fieldset>
              ))}
              <div className="fila entre envolver" style={{ gap: 8 }}>
                <button className="btn" onClick={() => setManual([...manual, { tipo: 'SERVICIO', nombre: '', precio: '', duracion_min: 30, categoria: '' }])}>Agregar otro</button>
                <button className="btn primario" disabled={ocupado || !manual.some((f) => f.nombre.trim())} onClick={guardarManual}>{ocupado ? 'Guardando…' : 'Guardar en el borrador'}</button>
              </div>
            </div>
          </section>
        )}
      </div>
    </PublicoLayout>
  );
}

// ---------------------------------------------------------------- datos de facturación
const TIPOS_DOC: [string, string][] = [['CC', 'Cédula de ciudadanía'], ['CE', 'Cédula de extranjería'], ['NIT', 'NIT'], ['PP', 'Pasaporte'], ['PPT', 'Permiso por protección temporal'], ['DE', 'Documento extranjero']];

/** Datos del contratante para el comprobante y la facturación. El número completo nunca vuelve del servidor. */
function FormFacturacion({ d, onGuardado }: { d: any; onGuardado: (r: any) => void }) {
  const v = d.facturacion ?? { completa: false, datos: {} };
  const base = v.datos ?? {};
  const [editando, setEditando] = useState(!v.completa);
  const [f, setF] = useState<any>({ nombre: base.nombre ?? '', tipo_documento: base.tipo_documento ?? 'CC', numero_documento: base.numero_sugerido ?? '', dv: base.dv ?? '', email: base.email ?? '', telefono: base.telefono ?? '', direccion: base.direccion ?? '', ciudad: base.ciudad ?? '', departamento: base.departamento ?? '' });
  const [err, setErr] = useState<{ campo?: string; mensaje: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const cambiar = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const guardarDatos = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null); setGuardando(true);
    const cuerpo: any = { ...f, dv: f.tipo_documento === 'NIT' ? f.dv : null, departamento: f.departamento || null };
    if (!cuerpo.numero_documento) delete cuerpo.numero_documento; // se conserva el guardado
    try {
      const r = await api.patch(`/api/onboarding/borradores/${d.token}`, { facturacion: cuerpo });
      onGuardado(r); setEditando(false); setF({ ...f, numero_documento: '' });
    } catch (e2) {
      const x = e2 as any;
      setErr({ campo: x.details?.campo, mensaje: x.message });
    } finally { setGuardando(false); }
  };
  if (!editando && v.completa) return (
    <section className="tarjeta" aria-label="Datos de facturación">
      <div className="cab"><h2 className="titulo-tarjeta">Datos de facturación</h2><button className="btn sutil peq" style={{ marginLeft: "auto" }} onClick={() => setEditando(true)}>Editar</button></div>
      <dl className="resumen-pago sin-borde">
        <div><dt>Contratante</dt><dd>{base.nombre}</dd></div>
        <div><dt>Documento</dt><dd>{base.tipo_documento_nombre ?? base.tipo_documento} {base.documento_mascara}{base.dv ? `-${base.dv}` : ''}</dd></div>
        <div><dt>Correo</dt><dd>{base.email}</dd></div>
        <div><dt>Teléfono</dt><dd>{base.telefono}</dd></div>
        <div><dt>Dirección</dt><dd>{[base.direccion, base.ciudad, base.departamento].filter(Boolean).join(', ')}</dd></div>
      </dl>
    </section>
  );
  return (
    <form className="tarjeta" onSubmit={guardarDatos} aria-label="Datos de facturación">
      <div className="cab"><h2 className="titulo-tarjeta">Datos de facturación</h2>{v.sugerida && <span className="tenue peq-txt">Completamos lo que ya nos diste</span>}</div>
      <div className="cuerpo col" style={{ gap: 12 }}>
        <Campo etiqueta="Nombre completo o razón social" error={err?.campo === 'nombre' ? err.mensaje : undefined}><input className="input" value={f.nombre} onChange={cambiar('nombre')} autoComplete="name" required /></Campo>
        <div className="form-fila">
          <Campo etiqueta="Tipo de documento"><select className="input" value={f.tipo_documento} onChange={cambiar('tipo_documento')}>{TIPOS_DOC.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></Campo>
          <Campo etiqueta="Número" ayuda={v.completa ? `guardado ${base.documento_mascara}; vacío para conservarlo` : 'sin puntos ni espacios'} error={err?.campo === 'numero_documento' ? err.mensaje : undefined}>
            <input className="input mono" value={f.numero_documento} onChange={cambiar('numero_documento')} inputMode={['CC', 'NIT', 'PPT'].includes(f.tipo_documento) ? 'numeric' : 'text'} autoComplete="off" required={!v.completa} />
          </Campo>
          {f.tipo_documento === 'NIT' && <Campo etiqueta="DV" error={err?.campo === 'dv' ? err.mensaje : undefined}><input className="input mono campo-dv" maxLength={1} inputMode="numeric" value={f.dv ?? ''} onChange={cambiar('dv')} required /></Campo>}
        </div>
        <div className="form-fila">
          <Campo etiqueta="Correo para el comprobante"><input className="input" type="email" value={f.email} onChange={cambiar('email')} autoComplete="email" required /></Campo>
          <Campo etiqueta="Teléfono"><input className="input" type="tel" value={f.telefono} onChange={cambiar('telefono')} autoComplete="tel" required /></Campo>
        </div>
        <Campo etiqueta="Dirección"><input className="input" value={f.direccion} onChange={cambiar('direccion')} autoComplete="street-address" required /></Campo>
        <div className="form-fila">
          <Campo etiqueta="Ciudad"><input className="input" value={f.ciudad} onChange={cambiar('ciudad')} autoComplete="address-level2" required /></Campo>
          <Campo etiqueta="Departamento" ayuda="opcional"><input className="input" value={f.departamento ?? ''} onChange={cambiar('departamento')} autoComplete="address-level1" /></Campo>
        </div>
        {err && !err.campo && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{err.mensaje}</p>}
        <p className="tenue peq-txt">Tu número de documento será la contraseña de los documentos de tu pago. Lo guardamos cifrado y no volvemos a mostrarlo completo.</p>
        <div className="fila" style={{ gap: 8 }}>
          <button className="btn primario" disabled={guardando}>{guardando ? 'Guardando…' : 'Guardar datos de facturación'}</button>
          {v.completa && <button type="button" className="btn sutil" onClick={() => setEditando(false)}>Cancelar</button>}
        </div>
      </div>
    </form>
  );
}

/** Medios de pago confirmados por Wompi para la cuenta; si no los informa, no se promete ninguno. */
function MediosPago() {
  const [m, setM] = useState<any>(null);
  useEffect(() => { api.get('/api/publico/medios-pago').then(setM).catch(() => setM({ fuente: 'no_confirmado', medios: [] })); }, []);
  if (!m) return null;
  return <p className="tenue peq-txt" style={{ margin: 0 }}>
    {m.fuente === 'wompi' && m.medios.length ? <>Medios habilitados por Wompi para este pago: <b>{m.medios.map((x: any) => x.nombre).join(', ')}</b>.</> : 'Wompi te mostrará en su página los medios de pago habilitados para este comercio.'}
  </p>;
}

// ---------------------------------------------------------------- SCR-007
export function Pago() {
  const { d, setD, cargando, error, recargar } = useBorrador();
  const { run, ocupado } = useAccion();
  const [acepto, setAcepto] = useState(false);
  const nav = useNavigate();
  const activate = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${d.token}/pago`, { retorno: window.location.origin }));
    if (!r) return;
    // Ya estaba pagado: no hay un segundo cobro, se va directo al estado del alta.
    if (r.ya_pagado || !r.url) nav('/empezar/listo');
    else irA(r.url);
  };
  if (error) return <PublicoLayout paso={4}><ErrorCarga error={error} reintentar={recargar} /></PublicoLayout>;
  if (cargando) return <PublicoLayout paso={4}><Cargando filas={5} /></PublicoLayout>;
  if (!d) return <PublicoLayout paso={4}><Vacio titulo="Primero configura tu negocio" accion={<Link className="btn primario" to="/empezar">Empezar</Link>} /></PublicoLayout>;
  const o = d.oferta;
  const institucional = o?.modalidad === 'INSTITUCIONAL';
  const real = d.pasarela === 'wompi';
  const textoBoton = ocupado ? 'Preparando…' : d.pasarela === 'simulada' ? 'Ir al pago de prueba' : `Pagar ${cop(o?.monto ?? d.cotizacion.total)} con Wompi`;
  return <PublicoLayout paso={4}><section className="proposal-summary">
    <h1 className="onb-titulo">Revisa tu propuesta</h1>
    <p className="sec">Esta es la plataforma de {d.negocio?.nombre ?? 'tu negocio'}. Revisa las funciones y el desglose antes de continuar.</p>
    <Quote quote={d.cotizacion} modalidad={d.modalidad} />
    {institucional && <dl className="resumen-pago" aria-label="Resumen de la contratación">
      <div><dt>Modalidad</dt><dd>Institucional</dd></div>
      <div><dt>Valor a pagar hoy</dt><dd>{cop(o.monto)} COP</dd></div>
      <div><dt>Vigencia</dt><dd>{o.acceso_dias} días desde la creación de tu espacio</dd></div>
      <div><dt>Renovación</dt><dd>Manual · sin cobros automáticos</dd></div>
      <div><dt>Precio comercial de referencia</dt><dd>{cop(o.monto_referencia)} / mes · no se cobra</dd></div>
      <div><dt>Pasarela</dt><dd>Wompi · cobro real</dd></div>
    </dl>}
    {(d.facturacion_requerida || d.facturacion?.completa) && <FormFacturacion d={d} onGuardado={setD} />}
    {real && <p className="nota-fiscal peq-txt" role="note"><Icon n="info" className="" size={16} /><span>{d.facturacion_electronica?.habilitada
      ? 'Recibirás la factura electrónica de tu pago cuando la DIAN la valide.'
      : 'La facturación electrónica está pendiente de configuración: recibirás un comprobante de pago en PDF, sin validez fiscal. La factura que corresponda se emitirá aparte.'}</span></p>}
    {d.pasarela === 'simulada' && <div className="aviso peq-txt"><Icon n="info" className="" size={16} />Estás en una demostración: la activación usa una pasarela simulada, sin tarjeta ni cobros reales.</div>}
    {real && d.pago_disponible && <div className="aviso peq-txt" role="note"><Icon n="alerta" className="" size={16} /><span>Este es un <b>cobro real</b> de {cop(o?.monto ?? d.cotizacion.total)} COP, no una simulación. El pago se hace en el sitio seguro de Wompi; Omnegia no ve ni guarda los datos de tu tarjeta.</span></div>}
    {!d.pago_disponible && <div className="aviso peq-txt"><Icon n="info" className="" size={16} />La contratación en línea todavía no está habilitada. Escríbenos y activamos tu espacio contigo.</div>}
    {real && d.pago_disponible && <label className="acepto-cobro">
      <input type="checkbox" checked={acepto} onChange={(e) => setAcepto(e.target.checked)} />
      <span>Entiendo que se hará un cobro real de {cop(o?.monto ?? d.cotizacion.total)} COP{institucional ? ` por ${o.acceso_dias} días de acceso, sin renovación automática` : ''}.</span>
    </label>}
    <div className="fila envolver" style={{ gap: 8 }}>
      {d.pago_disponible && <button className="btn primario grande" disabled={ocupado || (real && !acepto) || (d.facturacion_requerida && !d.facturacion?.completa)} onClick={activate}>{textoBoton}</button>}
      {d.estado === 'BORRADOR' && <Link className="btn grande" to="/empezar">Ajustar funciones</Link>}
    </div>
    {real && <MediosPago />}
    {d.facturacion_requerida && !d.facturacion?.completa && <p className="tenue peq-txt" style={{ margin: 0 }}>Guarda tus datos de facturación para continuar con el pago.</p>}
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
    const x = await run(() => api.post(`/api/onboarding/borradores/${leer('borrador')}/pago`, { retorno: window.location.origin }));
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
              : <div className="cp-fila vacia" style={{ ['--i' as any]: 0 }}><span>Podrás añadir productos y servicios desde tu panel</span></div>}
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
  const [q] = useSearchParams();
  const idRetorno = q.get('id');

  const [rescate, setRescate] = useState<any>(null);
  // Wompi vuelve con ?id=<transacción>. El navegador solo aporta el id: el servidor consulta a Wompi.
  // Sin la llave del borrador en este navegador, el servidor confirma el pago y envía el enlace para continuar al correo verificado.
  useEffect(() => {
    if (!idRetorno || !/^[\w-]{3,80}$/.test(idRetorno)) return;
    if (!tk) {
      setRescate({ cargando: true });
      api.post('/api/onboarding/retorno', { id: idRetorno }).then(setRescate).catch((e) => setRescate({ error: (e as Error).message }));
      return;
    }
    api.get(`/api/pagos/verificar?id=${encodeURIComponent(idRetorno)}`).catch(() => {}).finally(() => setConsulta((n) => n + 1));
  }, [idRetorno]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tk) return;
    let vivo = true;
    let t = 0;
    const tick = async () => {
      try {
        const s = await api.get(`/api/onboarding/borradores/${tk}/estado`);
        if (!vivo) return;
        setSt(s); setError(null);
        const f = faseCierre(tk, s, null);
        // También mientras se preparan el comprobante y el ZIP, para que el recibo avance solo.
        if ((debeConsultar(f) && !s.error_aprovisionamiento) || (f === 'listo' && reciboEnCurso(faseRecibo(s)))) t = window.setTimeout(tick, 1500);
      } catch (e) { if (vivo) setError(e as ApiError); }
    };
    tick();
    return () => { vivo = false; clearTimeout(t); };
  }, [tk, consulta]);

  const fase = faseCierre(tk, st, error);
  const enRescate = fase === 'sin_borrador' && !!rescate;
  const falloCreacion = fase === 'confirmando' && !!st?.error_aprovisionamiento;
  const listo = fase === 'listo';
  const pago = st?.pago;
  const necesitaCrear = listo && st.requiere_contrasena && !creada;

  const irAPagar = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${tk}/pago`, { retorno: window.location.origin }));
    if (r) irA(r.url);
  };
  const reciboReal = faseRecibo(st);
  // El recibo sostiene «validando» y «generando» lo suficiente para verse; la descarga no espera a la animación.
  const recibo = useFaseMinima<FaseRecibo>(reciboReal, ORDEN_RECIBO, MINIMOS_RECIBO);
  const [errDocs, setErrDocs] = useState('');
  const [bajando, setBajando] = useState(false);
  const bajarDocumentos = async () => {
    setErrDocs(''); setBajando(true);
    try { await descargarDocumentos(() => api.post(`/api/onboarding/borradores/${tk}/documentos/enlace`)); }
    catch (e2) { setErrDocs((e2 as Error).message); }
    finally { setBajando(false); }
  };
  const reintentarDocumentos = async () => {
    const r = await run(() => api.post(`/api/onboarding/borradores/${tk}/documentos/reintentar`));
    if (r) setConsulta((n) => n + 1);
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
      guardar('borrador', null);
      irAEmpresa(emp.slug, '/', nav);
    } finally { setEntrando(false); }
  };

  const titulo: Record<FaseCierre, string> = {
    sin_borrador: 'No hay un alta en curso', cargando: 'Consultando tu alta…', error: 'No pudimos consultar el estado de tu alta',
    sin_pago: 'Aún no has iniciado el pago', pendiente: 'Esperando la confirmación del pago', rechazado: 'La pasarela rechazó el pago',
    confirmando: 'Pago confirmado. Estamos creando tu panel', listo: `${st?.tenant?.nombre ?? 'Tu negocio'} ya tiene su panel`,
  };
  const hechos = enRescate && rescate?.alta ? (rescate.creada ? 6 : rescate.pago === 'APROBADO' ? 5 : 4) : pasosCumplidos(fase, d);

  return (
    <PublicoLayout paso={Math.min(hechos, 5)} hechos={hechos} estado={falloCreacion ? { tono: 'err', icono: 'alerta', texto: 'Creación detenida · tu pago está confirmado' } : enRescate ? { tono: rescate?.pago === 'APROBADO' ? 'ok' : 'neutro', icono: rescate?.pago === 'APROBADO' ? 'ok' : 'reloj', texto: rescate?.pago === 'APROBADO' ? 'Pago confirmado · continúa desde tu correo' : 'Confirmando el pago con Wompi' } : CABECERA[fase]} notaAlta={listo ? 'Tu espacio está creado. Puedes continuar desde tu panel.' : falloCreacion ? 'Tu pago está confirmado. Reintenta la creación con tu configuración guardada.' : fase === 'confirmando' ? 'Tu pago está confirmado. Estamos preparando tu espacio.' : fase === 'error' ? 'Tu configuración se conserva. Reintenta la consulta del estado.' : enRescate ? 'Tu alta se conserva en el servidor. Continúa con el enlace que enviamos a tu correo.' : fase === 'sin_borrador' ? 'Describe tu negocio para empezar a configurar tu espacio.' : fase === 'cargando' ? 'Estamos consultando el estado de tu configuración.' : 'Tu borrador se conserva mientras se confirma el pago.'}>
      {(fase === 'confirmando' || fase === 'listo') && <WorkspaceAssembly nombre={st?.tenant?.nombre ?? d?.negocio?.nombre ?? 'Tu negocio'} modulos={listo ? st?.panel?.modulos ?? [] : d?.cotizacion?.modulos ?? []} listo={listo} error={!!st?.error_aprovisionamiento} />}
      <div className={`cierre ${fase === 'sin_borrador' ? 'solo' : ''}`}>
        <section className="tarjeta col cierre-estado" aria-live="polite">
          <h1 className="onb-titulo">{falloCreacion ? 'Tu pago está confirmado. La creación necesita un reintento.' : enRescate ? (rescate?.alta ? 'Tu pago y tu alta están a salvo' : 'Confirmando tu pago') : titulo[fase]}</h1>
          {fase === 'sin_borrador' && (rescate ? <RescateAlta r={rescate} /> : <><p className="sec">{error ? 'No encontramos el borrador guardado en este navegador.' : 'Describe tu negocio para preparar una propuesta.'}</p><Link className="btn primario" style={{ alignSelf: 'flex-start' }} to="/empezar">Empezar</Link></>)}
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
            <p className="sec">La pasarela todavía no ha confirmado el pago de <b>{cop(pago.monto)} COP</b>{pago.modalidad === 'INSTITUCIONAL' ? ` (modalidad institucional, ${pago.acceso_dias} días de acceso)` : ''} <span className="mono">(ref. {pago.referencia})</span>. Volvemos a consultar cada pocos segundos; tu panel no se crea hasta que Wompi lo confirme.</p>
            <button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={irAPagar}>{ocupado ? 'Preparando…' : 'Volver a la pasarela'}</button>
          </>}
          {fase === 'rechazado' && <>
            <p className="sec">{pago?.estado === 'ANULADO' ? 'La pasarela anuló la transacción' : 'La pasarela no aprobó el pago'}: no se hizo ningún cobro y tu panel no se creó. Tu borrador sigue guardado.</p>
            <div className="fila envolver" style={{ gap: 8 }}>
              <button className="btn primario" disabled={ocupado} onClick={irAPagar}>{ocupado ? 'Preparando…' : 'Intentar el pago de nuevo'}</button>
              <Link className="btn" to="/empezar/pago">Revisar la propuesta</Link>
            </div>
          </>}
          {(fase === 'confirmando' || fase === 'listo') && <CreacionEspacio etapas={st?.etapas ?? []} listo={listo} error={st?.error_aprovisionamiento ?? null} onReintentar={reintentarAlta} ocupado={ocupado} />}
          {listo && <>
            <p className="sec">Tu espacio de trabajo <b>{st.tenant.nombre}</b> está creado. Entra para revisar tus módulos y completar las conexiones pendientes.</p>
            <section className="col" style={{ gap: 10 }} aria-label="Recibo y documentos del pago">
              <ReciboImpresion fase={recibo} numero={st.documentos?.numero} monto={st.pago?.monto} concepto={st.pago?.modalidad === 'INSTITUCIONAL' ? `Acceso institucional ${st.pago?.acceso_dias ?? ''} días` : 'Plan Omnegia'}
                empresa={st.tenant?.nombre} fiscal={st.documentos?.estado_fiscal_texto} validez={!!st.documentos?.validez_fiscal} />
              <div className="fila envolver" style={{ gap: 8 }}>
                <button className="btn primario" disabled={reciboReal !== 'listo' || bajando} onClick={bajarDocumentos}><Icon n="descargar" className="" size={16} />{bajando ? 'Preparando la descarga…' : 'Descargar documentos (.zip)'}</button>
                {recibo === 'pendiente' && st.documentos?.estado !== 'SIN_DATOS' && <button className="btn" disabled={ocupado} onClick={reintentarDocumentos}>Reintentar la generación</button>}
              </div>
              {errDocs && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{errDocs}</p>}
              {recibo === 'listo' && <p className="tenue peq-txt" style={{ margin: 0 }}>El .zip se abre sin contraseña. Cada documento pide tu número de documento de facturación, sin puntos, espacios ni guiones. También te lo enviamos por correo.</p>}
              {st.documentos?.estado === 'SIN_DATOS' && <p className="tenue peq-txt" style={{ margin: 0 }}>Este pago no tiene datos de facturación, así que no generamos documentos. Escríbenos si necesitas un soporte del pago.</p>}
            </section>
            {st.acceso && <dl className="resumen-pago" aria-label="Tu acceso">
              {st.acceso.monto_pagado != null && <div><dt>Pago confirmado</dt><dd>{cop(st.acceso.monto_pagado)} COP{st.acceso.referencia ? ` · ref. ${st.acceso.referencia}` : ''}</dd></div>}
              {st.acceso.modalidad && <div><dt>Modalidad</dt><dd>{st.acceso.modalidad === 'INSTITUCIONAL' ? 'Institucional · sin cobros automáticos' : 'Comercial · mensual'}</dd></div>}
              {st.acceso.vigente_hasta && <div><dt>Acceso hasta</dt><dd>{new Date(st.acceso.vigente_hasta).toLocaleDateString('es-CO', { timeZone: 'America/Bogota', day: 'numeric', month: 'long', year: 'numeric' })}</dd></div>}
              {st.acceso.url && <div><dt>Dirección</dt><dd><a href={st.acceso.url} className="mono">{st.acceso.url.replace(/^https?:\/\//, '')}</a></dd></div>}
            </dl>}
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
    if (r.empresas.length === 1 && !r.usuario.rol_plataforma) { irAEmpresa(r.empresas[0].slug, next ?? '/', nav); return; }
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
          <button key={e.id} className="btn fila" style={{ justifyContent: 'flex-start', height: 'auto', padding: '10px 14px', gap: 12 }} onClick={() => irAEmpresa(e.slug, volver ?? '/', nav)}>
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

/**
 * Vuelta de la pasarela en un navegador sin la llave del alta. Nada se perdió: el pago lo confirma el
 * servidor con Wompi, la empresa se crea igual, y el enlace para continuar llega al correo verificado.
 */
function RescateAlta({ r }: { r: any }) {
  if (r.cargando) return <><p className="sec">Confirmando tu pago con Wompi…</p><Cargando filas={2} /></>;
  if (r.error || !r.alta) return (
    <div className="col" style={{ gap: 10 }}>
      <p className="sec">{r.error ? `No pudimos confirmar el pago todavía: ${r.error}` : r.estado === 'DESCONOCIDO' ? 'Wompi todavía no confirma esta transacción. Si ya pagaste, la confirmación llega en unos minutos y no se pierde.' : 'Esta transacción no corresponde a un alta de Omnegia.'}</p>
      <p className="tenue peq-txt">Si tu empresa ya se creó, puedes entrar con «¿Olvidaste tu contraseña?» usando el correo de administrador.</p>
      <div className="fila envolver" style={{ gap: 8 }}><Link className="btn primario" to="/recuperar">Recuperar mi acceso</Link><Link className="btn" to="/empezar">Empezar un alta nueva</Link></div>
    </div>
  );
  const pagado = r.pago === 'APROBADO';
  return (
    <div className="rescate col" style={{ gap: 12 }}>
      <p className={`estado ${pagado ? 'ok' : 'warn'}`} style={{ alignSelf: 'flex-start', height: 'auto', padding: '4px 10px' }}><Icon n={pagado ? 'ok' : 'reloj'} className="" />{pagado ? 'Pago confirmado por Wompi' : 'Pago pendiente de confirmación'}</p>
      <p className="sec" style={{ margin: 0 }}>
        {r.creada ? <>El espacio de <b>{r.empresa}</b> ya está creado.</> : pagado ? <>Estamos creando el espacio de <b>{r.empresa}</b>.</> : <>El alta de <b>{r.empresa}</b> sigue guardada.</>}{' '}
        Abriste esta página en un navegador o dirección distinta a la del alta, así que por seguridad no mostramos aquí sus datos.
      </p>
      {r.enviado
        ? <p className="nota-fiscal peq-txt" style={{ margin: 0 }}><Icon n="correo" className="" size={16} /><span>Te enviamos un enlace a <b>{r.correo}</b> para continuar donde ibas: definir tu contraseña y descargar tus documentos. Revisa también el correo no deseado.</span></p>
        : <p className="tenue peq-txt" style={{ margin: 0 }}>Este alta no tiene un correo verificado. Escríbenos y te ayudamos a recuperarla.</p>}
      <div className="fila envolver" style={{ gap: 8 }}>
        {r.creada && <Link className="btn" to="/recuperar">Ya tengo cuenta: recuperar acceso</Link>}
        <Link className="btn sutil" to="/ayuda">Necesito ayuda</Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- creación del espacio
const ORDEN_RECIBO = ['validando', 'generando', 'listo'] as const satisfies readonly FaseRecibo[];
const MINIMOS_RECIBO: Partial<Record<FaseRecibo, number>> = { validando: 1400, generando: 2600 };
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
  // Las etapas confirmadas aparecen de una en una para poder leerlas; nunca se muestra una que el servidor no registró.
  const confirmadas = ORDEN_ETAPAS.filter((e) => hechas.has(e)).length;
  const vistas = useRevelado(confirmadas, 620);
  const terminado = listo && vistas >= ORDEN_ETAPAS.length;
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
          const hecha = hechas.has(e) && i < vistas;
          const fallo = !!error && !hechas.has(e) && ORDEN_ETAPAS.find((x) => !hechas.has(x)) === e;
          // «En curso»: la siguiente etapa ya confirmada que todavía se está presentando.
          const curso = !hecha && !fallo && i === vistas && hechas.has(e);
          return (
            <li key={e} className={hecha ? 'hecha' : fallo ? 'fallo' : curso ? 'curso' : ''} style={{ ['--i' as any]: i }}>
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
    if (s) irAEmpresa(r.slug, '/', nav);
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
