import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type ApiError } from '../api';
import { Campo, CodigoOtp, useAccion } from './ui';
import { Icon } from './icons';
import { AiOrb } from './AiOrb';
import { LogoError, pesoLegible, prepararLogo } from '../lib/logo';

/**
 * Datos del negocio en el alta. Cuatro grupos con estado propio (completo, pendiente u opcional):
 * negocio y dirección web, acceso del administrador (con verificación del correo), contacto y
 * ubicación con datos tributarios. Lo escrito se conserva en el navegador si se vuelve atrás; el
 * servidor valida todo de nuevo (formato, disponibilidad del subdominio, teléfono, territorio).
 */
type Pais = { codigo: string; nombre: string; bandera: string; indicativo: string | null };
type Lugar = { codigo: string; nombre: string };
type EstadoGrupo = 'completo' | 'pendiente' | 'opcional' | 'error';

const ETIQUETA_GRUPO: Record<EstadoGrupo, string> = { completo: 'Completo', pendiente: 'Pendiente', opcional: 'Opcional', error: 'Revisar' };

function Grupo({ n, id, titulo, para, estado, children, plegable = false }: { n: number; id: string; titulo: string; para: string; estado: EstadoGrupo; children: ReactNode; plegable?: boolean }) {
  if (plegable) return <details className={`grupo-datos grupo-optional ${estado}`} id={id} open={estado === 'error' ? true : undefined}>
    <summary><div><h2>{titulo}</h2><p>{para}</p></div><Icon n="derecha" size={18} /></summary>
    <div className="grupo-cuerpo">{children}</div>
  </details>;
  return (
    <section className={`grupo-datos ${estado}`} id={id} aria-labelledby={`${id}-t`} style={{ ['--i' as any]: n }}>
      <header>
        <span className="grupo-n" aria-hidden="true">{estado === 'completo' ? <Icon n="ok" className="" size={13} /> : n}</span>
        <div><h2 id={`${id}-t`}>{titulo}</h2><p>{para}</p></div>
        <span className={`grupo-estado ${estado}`}>{ETIQUETA_GRUPO[estado]}</span>
      </header>
      <div className="grupo-cuerpo">{children}</div>
    </section>
  );
}

/** Grupo al que pertenece un mensaje de error del servidor, para señalarlo en su sitio. */
const grupoDeError = (m: string) => (/tel[eé]fono|indicativo/i.test(m) ? 'contacto' : /NIT|DV|direcci[oó]n|municipio|departamento|pa[ií]s|territori/i.test(m) ? 'ubicacion' : /correo|c[oó]digo/i.test(m) ? 'acceso' : /subdominio|direcci[oó]n web|nombre/i.test(m) ? 'negocio' : null);

export function RegistrationData({ d, setD }: { d: any; setD: (d: any) => void }) {
  const nav = useNavigate();
  const clave = `alta-datos:${d.token}`;
  const [f, setF] = useState<any>(() => {
    let local = {};
    try { local = JSON.parse(sessionStorage.getItem(clave) || '{}'); } catch { /* sin almacenamiento */ }
    // Colombia como punto de partida del producto (no se deduce del dispositivo); se puede cambiar.
    return { pais: 'CO', telefono_pais: 'CO', ...d.negocio, ...local };
  });
  const [paises, setPaises] = useState<Pais[]>([]);
  const [divisiones, setDivisiones] = useState<Lugar[]>([]);
  const [ciudades, setCiudades] = useState<Lugar[]>([]);
  const [disponibilidad, setDisponibilidad] = useState<any>(null);
  const [codigo, setCodigo] = useState('');
  const [enviado, setEnviado] = useState(false);
  const [espera, setEspera] = useState(0);
  const [aviso, setAviso] = useState<{ grupo: string | null; texto: string; tono: 'ok' | 'warn' | 'err' } | null>(null);
  const { run, ocupado } = useAccion();
  const verificado = d.correo_verificado && (f.email ?? '').toLowerCase() === d.negocio.email;
  const factura = !!d.clasificacion?.factura_electronica;
  const dominio = d.dominio ?? {};

  useEffect(() => { try { sessionStorage.setItem(clave, JSON.stringify(f)); } catch { /* sin almacenamiento */ } }, [f, clave]);
  useEffect(() => { api.get('/api/onboarding/catalogos').then((r) => setPaises(r.paises)).catch(() => setAviso({ grupo: null, texto: 'No pudimos cargar el catálogo de países. Recarga la página para intentarlo de nuevo.', tono: 'err' })); }, []);
  useEffect(() => {
    let vivo = true; setDivisiones([]);
    if (f.pais) api.get(`/api/onboarding/territorios?pais=${f.pais}`).then((r) => { if (vivo) setDivisiones(r); }).catch(() => {});
    return () => { vivo = false; };
  }, [f.pais]);
  useEffect(() => {
    let vivo = true; setCiudades([]);
    if (f.pais && f.departamento) api.get(`/api/onboarding/territorios?pais=${f.pais}&departamento=${encodeURIComponent(f.departamento)}`).then((r) => { if (vivo) setCiudades(r); }).catch(() => {});
    return () => { vivo = false; };
  }, [f.pais, f.departamento]);
  useEffect(() => {
    let vivo = true; setDisponibilidad(null);
    const t = window.setTimeout(() => {
      if (f.slug) api.get(`/api/onboarding/subdominio?slug=${encodeURIComponent(f.slug)}&tk=${d.token}`).then((r) => { if (vivo) setDisponibilidad(r); }).catch(() => { if (vivo) setDisponibilidad({ error: true }); });
    }, 350);
    return () => { vivo = false; clearTimeout(t); };
  }, [f.slug, d.token]);
  useEffect(() => { if (!espera) return; const t = window.setTimeout(() => setEspera((s) => s - 1), 1000); return () => clearTimeout(t); }, [espera]);

  const cambiar = (k: string, v: string) => setF((s: any) => ({ ...s, [k]: v, ...(k === 'pais' ? { departamento: '', municipio: '', ciudad: '' } : {}), ...(k === 'departamento' ? { municipio: '', ciudad: '' } : {}) }));
  const slugDe = (nombre: string) => nombre.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const fallo = (e: unknown) => { const m = (e as ApiError)?.message ?? 'No pudimos guardar.'; setAviso({ grupo: grupoDeError(m), texto: m, tono: 'err' }); };

  const guardarDatos = async () => {
    const negocio = { ...f };
    for (const k of ['email', 'nombre', 'slug']) if (!negocio[k]) delete negocio[k];
    try { const r = await api.patch(`/api/onboarding/borradores/${d.token}`, { negocio }); setD(r); return r; } catch (e) { fallo(e); return null; }
  };
  const enviarCodigo = async () => {
    setAviso(null);
    if (!(await guardarDatos())) return;
    try {
      const r = await api.post(`/api/onboarding/borradores/${d.token}/correo/enviar`);
      setEnviado(true); setEspera(r.espera_segundos);
      setAviso({ grupo: 'acceso', texto: `Enviamos un código a ${r.email}. Vence en ${r.minutos} minutos; revisa también el correo no deseado.`, tono: 'ok' });
    } catch (e) {
      // Límite de reenvío: se muestra la espera real que indica el servidor.
      const s = (e as ApiError).details?.espera_segundos;
      if (s) { setEspera(s); setEnviado(true); }
      fallo(e);
    }
  };
  const verificar = async () => {
    try {
      await api.post(`/api/onboarding/borradores/${d.token}/correo/verificar`, { codigo });
      setD(await api.get(`/api/onboarding/borradores/${d.token}`));
      // El recuadro «Correo verificado» ya lo indica: sin mensaje adicional.
      setCodigo(''); setAviso(null);
    } catch (e) { fallo(e); }
  };
  const continuar = async (e: FormEvent) => {
    e.preventDefault(); setAviso(null);
    const r = await run(guardarDatos, undefined, { silencioso: true });
    if (!r) return;
    if (!r.correo_verificado) { setAviso({ grupo: 'acceso', texto: 'Confirma el código que enviamos a tu correo antes de continuar.', tono: 'warn' }); document.getElementById('acceso')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    const falta = (g: string, texto: string) => { setAviso({ grupo: g, texto, tono: 'warn' }); document.getElementById(g)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    if (!r.negocio.telefono) return falta('contacto', 'Escribe el teléfono de contacto de tu negocio para continuar.');
    if (!r.negocio.pais || !r.negocio.departamento || !r.negocio.municipio || !r.negocio.direccion) return falta('ubicacion', 'Completa el país, el departamento, el municipio y la dirección de tu negocio para continuar.');
    if (factura && (!r.negocio.nit || !r.negocio.nit_dv)) return falta('ubicacion', 'Escribe el NIT y su dígito de verificación para continuar.');
    // El servidor vuelve a comprobar la dirección al confirmar.
    const a = await api.get(`/api/onboarding/subdominio?slug=${encodeURIComponent(r.negocio.slug)}&tk=${d.token}`).catch(() => null);
    if (a && !a.disponible) { setAviso({ grupo: 'negocio', texto: 'Esa dirección web ya no está disponible. Elige otra.', tono: 'err' }); return; }
    nav('/empezar/catalogo');
  };

  const paisTel = paises.find((p) => p.codigo === f.telefono_pais);
  const estados: Record<string, EstadoGrupo> = useMemo(() => {
    const negocio: EstadoGrupo = f.nombre && f.slug && disponibilidad?.disponible !== false ? 'completo' : 'pendiente';
    const acceso: EstadoGrupo = f.email && verificado ? 'completo' : 'pendiente';
    const contacto: EstadoGrupo = d.negocio.telefono && f.telefono_nacional ? 'completo' : 'pendiente';
    // La ubicación del comercio siempre es obligatoria; el NIT, solo si necesita facturación electrónica.
    const ubicacion: EstadoGrupo = f.pais && f.departamento && f.municipio && f.direccion && (!factura || (f.nit && f.nit_dv)) ? 'completo' : 'pendiente';
    const r: Record<string, EstadoGrupo> = { negocio, acceso, contacto, ubicacion };
    if (aviso?.tono === 'err' && aviso.grupo) r[aviso.grupo] = 'error';
    return r;
  }, [f, disponibilidad, verificado, factura, d.negocio.telefono, aviso]);
  const requeridos = ['negocio', 'acceso', 'contacto', 'ubicacion'];
  const listos = requeridos.filter((g) => estados[g] === 'completo').length;
  const avisoEn = (g: string) => aviso && aviso.grupo === g && !(aviso.tono === 'warn' && estados[g] === 'completo') && <p className={aviso.tono === 'err' ? 'bloqueado' : aviso.tono === 'warn' ? 'aviso' : 'estado ok'} role={aviso.tono === 'err' ? 'alert' : 'status'}>{aviso.texto}</p>;
  const direccion = dominio.dominio && !dominio.local ? `${f.slug || 'tu-negocio'}.${dominio.dominio}` : `${f.slug || 'tu-negocio'}.localhost`;

  return (
    <div className="registro">
      <form className="registro-form" onSubmit={continuar} noValidate>
        <header className="registro-cab">
          <h1 className="onb-titulo">Ahora, dale tu identidad.</h1>
          <p className="sec">El nombre de tu negocio, un correo para entrar, un teléfono de contacto y la ubicación del negocio. Todo es necesario para crear tu espacio.</p>
          <div className="registration-context"><AiOrb state="breathing" label="Configuración guardada" /><p><strong>{d.clasificacion?.tipo_negocio ?? 'Tu negocio'}, con sus funciones preparadas.</strong>{d.clasificacion?.motor === 'ia' ? 'La IA organizó tu configuración. ' : 'Tu configuración está guardada. '}Añade tu marca y verifica tu correo para continuar.</p></div>
          <div className="registro-progreso" aria-label={`${listos} de ${requeridos.length} grupos obligatorios completos`}>
            <div className="registro-barra"><span style={{ transform: `scaleX(${listos / requeridos.length})` }} /></div>
            <span className="tenue peq-txt">{listos} de {requeridos.length} grupos obligatorios completos</span>
          </div>
          {aviso && !aviso.grupo && <p className="bloqueado" role="alert">{aviso.texto}</p>}
        </header>

        <Grupo n={1} id="negocio" titulo="Tu negocio y su dirección web" para="El nombre que verán tus clientes y la dirección donde entrarás a tu panel." estado={estados.negocio}>
          <Campo etiqueta="Nombre comercial">
            <input className="input" value={f.nombre ?? ''} maxLength={80} autoComplete="organization" onChange={(e) => cambiar('nombre', e.target.value)} onBlur={() => { if (!f.slug && f.nombre) cambiar('slug', slugDe(f.nombre)); }} />
          </Campo>
          <Campo etiqueta="Dirección de tu panel" ayuda="escribe solo el nombre; el resto lo ponemos nosotros">
            <div className="subdominio">
              <input className="input mono" value={f.slug ?? ''} maxLength={40} autoCapitalize="none" spellCheck={false} aria-describedby="subdominio-estado"
                onChange={(e) => cambiar('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="tu-negocio" />
              <span className="subdominio-sufijo">.{dominio.dominio && !dominio.local ? dominio.dominio : 'localhost'}</span>
            </div>
          </Campo>
          <div id="subdominio-estado" className="subdominio-estado" aria-live="polite">
            {dominio.local && <span className="estado neutro">Dirección local de desarrollo</span>}
            {!dominio.dominio && !dominio.local && <span className="estado warn">El dominio de producción está pendiente de configurar</span>}
            {f.slug && (disponibilidad?.error ? <span className="tenue">No pudimos comprobar la disponibilidad; se comprobará al continuar.</span>
              : !disponibilidad ? <span className="tenue">Comprobando disponibilidad…</span>
              : disponibilidad.disponible ? <span className="estado ok"><Icon n="ok" className="" size={13} />{direccion} está disponible</span>
              : <span className="estado warn">{disponibilidad.valido ? 'Esa dirección ya está ocupada.' : 'Usa de 3 a 40 letras minúsculas, números o guiones (sin empezar ni terminar en guion). Algunos nombres están reservados.'}</span>)}
            {disponibilidad?.alternativas?.length > 0 && <div className="fila envolver" style={{ gap: 6 }}><span className="tenue peq-txt">Disponibles:</span>{disponibilidad.alternativas.map((s: string) => <button className="btn peq" type="button" key={s} onClick={() => cambiar('slug', s)}>{s}</button>)}</div>}
          </div>
          {avisoEn('negocio')}
        </Grupo>

        <Grupo n={2} id="acceso" titulo="Tu acceso como administrador" para="Confirmamos que el correo es tuyo antes de crear la empresa. Ahí llegan tus documentos y avisos." estado={estados.acceso}>
          <div className="grid g2">
            <Campo etiqueta="Tu nombre" ayuda="opcional"><input className="input" value={f.responsable ?? ''} maxLength={80} autoComplete="name" onChange={(e) => cambiar('responsable', e.target.value)} /></Campo>
            <Campo etiqueta="Correo del administrador">
              <input className="input" type="email" value={f.email ?? ''} autoComplete="email"
                onChange={(e) => { cambiar('email', e.target.value.trim()); setEnviado(false); setCodigo(''); }} />
            </Campo>
          </div>
          {verificado ? (
            <p className="verificacion ok"><Icon n="ok" className="" size={16} />Correo verificado. <button type="button" className="enlace" onClick={() => { cambiar('email', ''); setEnviado(false); }}>Usar otro correo</button></p>
          ) : (
            <div className="verificacion">
              {!enviado ? <button className="btn" type="button" disabled={ocupado || !f.email || espera > 0} onClick={enviarCodigo}>{espera > 0 ? `Puedes pedir otro en ${espera} s` : 'Enviar código de verificación'}</button> : (
                <>
                  <CodigoOtp valor={codigo} onCambio={setCodigo} autoFocus />
                  <div className="fila envolver" style={{ gap: 8 }}>
                    <button type="button" className="btn primario" disabled={codigo.length !== 6} onClick={verificar}>Confirmar código</button>
                    <button type="button" className="btn sutil" disabled={espera > 0 || ocupado} onClick={enviarCodigo}>{espera > 0 ? `Reenviar en ${espera} s` : 'Enviar otro código'}</button>
                  </div>
                  <p className="tenue peq-txt">¿El correo está mal? Corrígelo arriba y pide un código nuevo.</p>
                </>
              )}
            </div>
          )}
          {avisoEn('acceso')}
        </Grupo>

        <Grupo n={3} id="contacto" titulo="Teléfono de contacto del negocio" para="Obligatorio. Con este número reconocemos a tu comercio cuando nos escribes y te avisamos de tu cuenta." estado={estados.contacto}>
          <div className="telefono">
            <Campo etiqueta="País del teléfono">
              <select className="input bandera-select" value={f.telefono_pais ?? ''} aria-required="true" onChange={(e) => cambiar('telefono_pais', e.target.value)}>
                {paises.filter((p) => p.indicativo).map((p) => <option key={p.codigo} value={p.codigo}>{p.bandera} {p.nombre} ({p.indicativo})</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Número">
              <div className="telefono-numero">
                <span className="telefono-prefijo" aria-hidden="true"><span className="bandera">{paisTel?.bandera}</span>{paisTel?.indicativo ?? '+'}</span>
                <input className="input" type="tel" inputMode="tel" autoComplete="tel-national" aria-required="true" maxLength={20} value={f.telefono_nacional ?? ''} placeholder={f.telefono_pais === 'CO' ? '300 123 4567' : ''}
                  aria-label={`Número sin indicativo${paisTel?.indicativo ? ` (${paisTel.indicativo})` : ''}`} onChange={(e) => cambiar('telefono_nacional', e.target.value.replace(/[^\d\s()-]/g, ''))} />
              </div>
            </Campo>
          </div>
          {d.negocio.telefono && <p className="tenue peq-txt">Guardado como <span className="mono">{d.negocio.telefono}</span>.</p>}
          {avisoEn('contacto')}
        </Grupo>

        <Grupo n={4} id="ubicacion" titulo={factura ? 'Ubicación y datos tributarios' : 'Ubicación del negocio'} estado={estados.ubicacion}
          para={factura ? 'Necesarios para preparar la facturación electrónica: identificación tributaria y dirección del establecimiento.' : 'Obligatoria: el país, el departamento, el municipio y la dirección donde atiendes. Aparece en tus documentos y nos identifica tu comercio.'}>
          {factura && (
            <div className="nit">
              <Campo etiqueta="NIT" ayuda="solo números, sin puntos ni guiones">
                <input className="input mono" inputMode="numeric" maxLength={15} value={f.nit ?? ''} onChange={(e) => cambiar('nit', e.target.value.replace(/\D/g, ''))} placeholder="900123456" />
              </Campo>
              <span className="nit-guion" aria-hidden="true">–</span>
              <Campo etiqueta="DV" ayuda="dígito de verificación">
                <input className="input mono nit-dv" inputMode="numeric" maxLength={1} value={f.nit_dv ?? ''} onChange={(e) => cambiar('nit_dv', e.target.value.replace(/\D/g, ''))} placeholder="7" />
              </Campo>
              <p className="tenue peq-txt nit-ayuda">El DV es el número que aparece después del guion en tu RUT. Lo comprobamos con el cálculo oficial antes de pagar.</p>
            </div>
          )}
          <div className="grid g2">
            <Campo etiqueta="País">
              <select className="input bandera-select" value={f.pais ?? ''} onChange={(e) => cambiar('pais', e.target.value)}>
                <option value="">Selecciona el país</option>
                {paises.map((p) => <option key={p.codigo} value={p.codigo}>{p.bandera} {p.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta={f.pais === 'CO' ? 'Departamento' : 'División territorial'}>
              <select className="input" disabled={!f.pais || !divisiones.length} value={f.departamento ?? ''} onChange={(e) => cambiar('departamento', e.target.value)}>
                <option value="">{f.pais ? (divisiones.length ? 'Selecciona' : 'Cargando…') : 'Primero elige el país'}</option>
                {divisiones.map((v) => <option value={v.codigo} key={v.codigo}>{v.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta={f.pais === 'CO' ? 'Municipio' : 'Ciudad'}>
              <select className="input" disabled={!f.departamento || !ciudades.length} value={f.municipio ?? ''} onChange={(e) => cambiar('municipio', e.target.value)}>
                <option value="">{f.departamento ? (ciudades.length ? 'Selecciona' : 'Cargando…') : 'Primero elige el departamento'}</option>
                {ciudades.map((v) => <option value={v.codigo} key={v.codigo}>{v.nombre}</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Dirección exacta" ayuda="incluye local, piso u otra referencia">
              <input className="input" autoComplete="street-address" maxLength={200} value={f.direccion ?? ''} onChange={(e) => cambiar('direccion', e.target.value)} placeholder="Calle 10 # 5-20, local 2" />
            </Campo>
          </div>
          <p className="tenue peq-txt">{f.pais === 'CO' ? 'Departamentos y municipios del catálogo DIVIPOLA del DANE. ' : ''}Comprobamos que la ciudad pertenezca a la región elegida; la dirección queda pendiente de confirmar y no se ha validado ante la DIAN.</p>
          {avisoEn('ubicacion')}
        </Grupo>

        <footer className="registro-pie">
          <Link to="/empezar" className="btn sutil">Volver a la propuesta</Link>
          <button type="submit" className="btn primario grande" disabled={ocupado}>{ocupado ? 'Guardando…' : 'Guardar y continuar'}</button>
        </footer>
        <p className="tenue peq-txt">Tus datos quedan guardados. Después del pago podrás crear tu espacio con IA.</p>
        <p className="tenue peq-txt aviso-datos">Recogemos estos datos para crear y operar tu cuenta, verificar tu identidad y atenderte. Sus finalidades, tus derechos y cómo ejercerlos están en la <Link to="/privacidad" target="_blank">Política de tratamiento de datos</Link>. Antes de pagar te pediremos tu autorización expresa.</p>
      </form>
      <IdentidadMarca d={d} setD={setD} nombre={f.nombre} />
    </div>
  );
}

/**
 * «¿Cómo quieres que tus clientes reconozcan tu negocio?»: nombre, logotipo opcional y color de las
 * acciones, con la marca aplicada a componentes reales del panel. El servidor ajusta el color para
 * que el texto sea legible (contraste AA) y lo informa.
 */
const SUGERIDOS = ['#5847DF', '#1F6F5C', '#B4541D', '#2B5AA8', '#8C3B6E', '#3F4A3C'];

function IdentidadMarca({ d, setD, nombre }: { d: any; setD: (d: any) => void; nombre?: string }) {
  const [color, setColor] = useState(d.tema?.acento ?? '#5847DF');
  const [error, setError] = useState('');
  const [nota, setNota] = useState('');
  const [arrastrando, setArrastrando] = useState(false);
  const { run, ocupado } = useAccion();
  useEffect(() => { if (d.tema?.acento) setColor(d.tema.acento); }, [d.tema?.acento]);
  const aplicar = async (extra: any) => {
    setError('');
    const r = await run(() => api.patch(`/api/onboarding/borradores/${d.token}`, extra), undefined, { silencioso: true }).catch(() => null);
    if (r) setD(r); else setError('No pudimos aplicar el cambio. Inténtalo de nuevo.');
  };
  const subir = async (archivo: File) => {
    setError(''); setNota('');
    try {
      // Se reduce y se comprime aquí mismo: la persona sube lo que tenga, sin límite de peso ni de formato que le estorbe.
      const l = await prepararLogo(archivo);
      await aplicar({ logo_data_url: l.dataUrl, colores_logo: l.colores });
      setNota(l.optimizado && l.bytes < l.bytesOriginal ? `Ajustamos tu logotipo por ti: de ${pesoLegible(l.bytesOriginal)} a ${pesoLegible(l.bytes)}.` : '');
    } catch (e) { setError(e instanceof LogoError ? e.message : 'No pudimos leer esta imagen. Prueba exportarla de nuevo como PNG o JPG.'); }
  };
  const tema = d.tema ?? {};
  const acento = tema.acento ?? color;
  const titulo = nombre || d.negocio?.nombre || 'Tu negocio';
  const monograma = titulo.split(/\s+/).map((x: string) => x[0]).join('').slice(0, 2).toUpperCase();

  return (
    <aside className="identidad" aria-labelledby="identidad-t">
      <h2 id="identidad-t">¿Cómo quieres que tus clientes reconozcan tu negocio?</h2>
      <p className="sec">Tu nombre, tu logotipo y un color aparecerán en el panel, en los correos y en los documentos. El logotipo es opcional y el color es una sugerencia que puedes cambiar.</p>
      <figure className="identidad-vista" style={{ ['--m' as any]: acento, ['--m-sobre' as any]: tema.texto_sobre_acento ?? '#fff' }} aria-label="Vista previa de tu marca">
        <div className="identidad-lado">
          <div className="identidad-logo">{d.logo_data_url ? <img src={d.logo_data_url} alt="" /> : <span>{monograma}</span>}<b>{titulo}</b></div>
          <span className="identidad-nav on">Inicio</span><span className="identidad-nav">Agenda</span><span className="identidad-nav">Ventas</span>
        </div>
        <div className="identidad-main">
          <div className="fila entre"><b>Hoy</b><span className="identidad-boton">Nueva venta</span></div>
          <div className="identidad-fila"><span>Corte y lavado</span><span className="identidad-chip">Confirmada</span></div>
          <div className="identidad-fila"><span>Total del día</span><b>$245.000</b></div>
        </div>
      </figure>
      <p className="tenue peq-txt" style={{ margin: 0 }}>Así se verá tu marca en botones, menús y estados del panel.</p>

      <div className={`identidad-subir ${arrastrando ? 'sobre' : ''}`} onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }} onDragLeave={() => setArrastrando(false)}
        onDrop={(e) => { e.preventDefault(); setArrastrando(false); const a = e.dataTransfer.files[0]; if (a && !ocupado) subir(a); }}>
        <Icon n="subir" className="" size={18} />
        <span><b>{d.logo_data_url ? 'Cambiar logotipo' : 'Sube tu logotipo'}</b> · arrástralo aquí o
          <label className="enlace"> elige un archivo<input className="sr" type="file" accept="image/*" disabled={ocupado} onChange={(e) => { const a = e.target.files?.[0]; if (a) subir(a); e.target.value = ''; }} /></label></span>
        <small className="tenue">PNG, JPG, WEBP, GIF o SVG · de cualquier peso: lo ajustamos por ti</small>
      </div>
      {error && <p className="bloqueado" role="alert">{error}</p>}
      {nota && !error && <p className="estado ok" role="status"><Icon n="ok" className="" size={13} />{nota}</p>}

      <fieldset className="identidad-colores">
        <legend>Color de las acciones</legend>
        <div className="fila envolver" style={{ gap: 8 }}>
          {SUGERIDOS.map((c) => <button key={c} type="button" className={`identidad-muestra ${acento.toLowerCase() === c.toLowerCase() ? 'on' : ''}`} style={{ background: c }} aria-label={`Usar el color ${c}`} aria-pressed={acento.toLowerCase() === c.toLowerCase()} disabled={ocupado} onClick={() => aplicar({ colores_logo: [c] })} />)}
          <label className="identidad-propio"><span className="sr">Elegir otro color</span><input type="color" value={color} onChange={(e) => setColor(e.target.value)} onBlur={() => color.toLowerCase() !== acento.toLowerCase() && aplicar({ colores_logo: [color] })} /></label>
        </div>
        <p className="tenue peq-txt">{tema.ajustado ? 'Ajustamos un poco el tono para que el texto de los botones se lea bien.' : 'Comprobamos el contraste de cada color para que todo se lea bien.'}</p>
      </fieldset>
      <div className="fila envolver" style={{ gap: 8 }}>
        <button type="button" className="btn sutil peq" disabled={ocupado} onClick={() => aplicar({ colores_logo: ['#5847DF'] })}>Restaurar la propuesta accesible</button>
        {d.logo_data_url && <button type="button" className="btn sutil peq" disabled={ocupado} onClick={() => aplicar({ logo_data_url: null })}>Continuar sin logotipo</button>}
      </div>
    </aside>
  );
}
