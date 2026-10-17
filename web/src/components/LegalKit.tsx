import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { api } from '../api';
import { PublicoLayout } from '../pages/public/Publico';
import { Campo, useAccion } from './ui';
import { Icon } from './icons';

/** Documentos de la zona legal, en el orden en que se muestran. */
export const DOCUMENTOS = [
  { ruta: '/terminos', titulo: 'Términos y condiciones', corto: 'Términos', detalle: 'Las reglas del servicio: contratación, pago, vigencia, retracto, uso de la IA y responsabilidades.' },
  { ruta: '/privacidad', titulo: 'Política de tratamiento de datos personales', corto: 'Privacidad', detalle: 'Qué datos tratamos, para qué, con quién, durante cuánto tiempo y cómo ejercer tus derechos de hábeas data.' },
  { ruta: '/eliminacion-de-datos', titulo: 'Eliminación de datos de usuario', corto: 'Eliminar mis datos', detalle: 'Cómo pedir que suprimamos, consultemos o corrijamos tus datos, y qué pasa con tu solicitud.' },
  { ruta: '/cookies', titulo: 'Cookies y almacenamiento', corto: 'Cookies', detalle: 'Qué guardamos en tu navegador y para qué.' },
  { ruta: '/consumidor', titulo: 'Derechos del consumidor y PQR', corto: 'Consumidor y PQR', detalle: 'Retracto, reversión del pago, y cómo radicar una petición, queja o reclamo.' },
] as const;

export interface InfoLegal {
  version: string;
  vigente_desde: string;
  responsable: { razon_social: string | null; documento: string | null; direccion: string | null; ciudad: string | null; correo: string | null; telefono: string | null; completo: boolean };
}

/** Versión vigente de los textos y datos del responsable, tal como los publica el operador. */
export function useLegal() {
  const [info, setInfo] = useState<InfoLegal | null>(null);
  useEffect(() => { let vivo = true; api.get('/api/publico/legal').then((r) => { if (vivo) setInfo(r); }).catch(() => {}); return () => { vivo = false; }; }, []);
  return info;
}

export const fechaLarga = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric' });

/** Fuente oficial de una norma citada. */
export function Fuente({ href, children }: { href: string; children: ReactNode }) {
  return <li><a href={href} target="_blank" rel="noopener noreferrer">{children}<Icon n="derecha" size={13} className="" /></a></li>;
}

/** Identificación de quien presta el servicio (Decreto 1377 de 2013 art. 13; Ley 1480 de 2011 art. 50 a). Nunca se rellena lo que falta. */
export function Identificacion({ info }: { info: InfoLegal | null }) {
  const r = info?.responsable;
  const fila = (k: string, v: string | null | undefined) => <div key={k}><dt>{k}</dt><dd>{v ?? <span className="legal-pendiente">Pendiente de publicar</span>}</dd></div>;
  return <div className="legal-id">
    <dl>
      {fila('Nombre o razón social', r?.razon_social)}
      {fila('Identificación', r?.documento)}
      {fila('Dirección', r ? [r.direccion, r.ciudad].filter(Boolean).join(', ') || null : null)}
      {fila('Correo electrónico', r?.correo)}
      {fila('Teléfono', r?.telefono)}
    </dl>
    {r && !r.completo && <p className="legal-nota"><Icon n="info" size={15} className="" />Estamos completando la publicación de estos datos de identificación. Mientras tanto, escríbenos a {r.correo ? <a href={`mailto:${r.correo}`}>{r.correo}</a> : 'nuestro canal de soporte'}.</p>}
  </div>;
}

export interface Seccion { id: string; titulo: string; cuerpo: ReactNode }

/**
 * Plantilla de un documento legal: encabezado con versión, índice lateral, secciones numeradas y navegación
 * entre documentos. Pensada para leerse: columna angosta, tamaño de texto cómodo y buen contraste.
 */
export function DocumentoLegal({ ruta, resumen, secciones, fuentes, children }: { ruta: string; resumen: ReactNode; secciones: Seccion[]; fuentes?: ReactNode; children?: ReactNode }) {
  const info = useLegal();
  const doc = DOCUMENTOS.find((d) => d.ruta === ruta)!;
  useEffect(() => { document.title = `${doc.titulo} · Omnegia`; }, [doc.titulo]);
  return <PublicoLayout transparente>
    <section className="legal-hero">
      <div>
        <nav className="legal-migas" aria-label="Zona legal"><Link to="/legal">Zona legal</Link><Icon n="derecha" size={13} className="" /><span aria-current="page">{doc.corto}</span></nav>
        <h1>{doc.titulo}</h1>
        <p className="legal-version">{info ? <>Versión {info.version} · vigente desde el {fechaLarga(info.vigente_desde)}</> : 'Cargando la versión vigente…'}</p>
      </div>
      <aside className="legal-resumen" aria-label="En pocas palabras"><h2>En pocas palabras</h2>{resumen}</aside>
    </section>
    <div className="legal-cuerpo">
      <nav className="legal-indice" aria-label="Contenido de este documento">
        <h2>Contenido</h2>
        <ol>{secciones.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.titulo}</a></li>)}</ol>
      </nav>
      <article className="legal-texto">
        {secciones.map((s, i) => <section key={s.id} id={s.id} aria-labelledby={`${s.id}-t`}><h2 id={`${s.id}-t`}><span aria-hidden="true">{i + 1}.</span> {s.titulo}</h2>{s.cuerpo}</section>)}
        {children}
        {fuentes && <section className="legal-fuentes" aria-labelledby="fuentes-t"><h2 id="fuentes-t">Normas en las que se apoya</h2><p>Enlaces a las fuentes oficiales o a compilaciones públicas de cada norma.</p><ul>{fuentes}</ul></section>}
        <section className="legal-otros" aria-label="Otros documentos legales"><h2>Otros documentos</h2>
          <ul>{DOCUMENTOS.filter((d) => d.ruta !== ruta).map((d) => <li key={d.ruta}><NavLink to={d.ruta}>{d.titulo}</NavLink></li>)}</ul>
        </section>
      </article>
    </div>
  </PublicoLayout>;
}

// ------------------------------------------------------------------ solicitudes (datos personales y PQR)

const TIPOS_DATOS: [string, string, string][] = [
  ['SUPRESION', 'Eliminar mis datos', 'Pides que suprimamos tus datos personales o revocamos tu autorización.'],
  ['CONSULTA', 'Consultar mis datos', 'Quieres saber qué datos tenemos tuyos y el uso que les damos.'],
  ['RECTIFICACION', 'Corregir o actualizar mis datos', 'Algún dato tuyo está incompleto, desactualizado o es incorrecto.'],
  ['REVOCATORIA', 'Revocar mi autorización', 'Dejas sin efecto la autorización que diste para tratar tus datos.'],
];
const CALIDADES: [string, string][] = [
  ['USUARIO_PLATAFORMA', 'Administro o trabajo en una empresa que usa Omnegia'],
  ['CLIENTE_DE_COMERCIO', 'Soy cliente de un comercio que usa Omnegia'],
  ['OTRA', 'Otra situación (por ejemplo, me escribieron al WhatsApp de Omnegia o empecé un registro)'],
];

interface Recibida { radicado: string; dias_habiles: number; vence_en: string; tipo: string }

/** Formulario público con radicado, fecha y hora (Ley 1581 de 2012 arts. 14 y 15; Ley 1480 de 2011 art. 50 g). */
export function FormularioSolicitud({ modo }: { modo: 'datos' | 'pqr' }) {
  const [f, setF] = useState({ tipo: modo === 'pqr' ? 'PQR' : 'SUPRESION', calidad: 'OTRA', nombre: '', email: '', telefono: '', comercio: '', detalle: '' });
  const [recibida, setRecibida] = useState<Recibida | null>(null);
  const { run, ocupado, error: errorAccion, limpiarError } = useAccion();
  const cambiar = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const enviar = async (e: FormEvent) => {
    e.preventDefault(); limpiarError();
    const r = await run(() => api.post('/api/publico/solicitudes-datos', { ...f, telefono: f.telefono || undefined, comercio: f.comercio || undefined }), undefined, { silencioso: true });
    if (r) setRecibida(r);
  };
  const mensaje = errorAccion?.message;
  if (recibida) return <div className="legal-recibida" role="status">
    <Icon n="ok" size={22} className="" />
    <div>
      <h3>Recibimos tu solicitud</h3>
      <p>Tu radicado es <strong className="mono">{recibida.radicado}</strong>. Te enviamos un correo con este número. Verificaremos que seas la persona titular antes de actuar.</p>
      <p>La ley nos da {recibida.dias_habiles} días hábiles para responderte; nuestra meta interna es hacerlo a más tardar el {fechaLarga(recibida.vence_en)}. Guarda el radicado: con él y tu correo puedes consultar el estado.</p>
    </div>
  </div>;
  return <form className="legal-form" onSubmit={enviar} noValidate>
    {modo === 'datos' && <fieldset className="legal-tipos">
      <legend>¿Qué necesitas?</legend>
      {TIPOS_DATOS.map(([v, n, d]) => <label key={v} className={f.tipo === v ? 'on' : ''}><input type="radio" name="tipo" value={v} checked={f.tipo === v} onChange={() => cambiar('tipo', v)} /><span><b>{n}</b><small>{d}</small></span></label>)}
    </fieldset>}
    {modo === 'datos' && <Campo etiqueta="¿Cuál es tu relación con Omnegia?">
      <select className="input" value={f.calidad} onChange={(e) => cambiar('calidad', e.target.value)}>{CALIDADES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select>
    </Campo>}
    <div className="grid g2">
      <Campo etiqueta="Tu nombre"><input className="input" value={f.nombre} maxLength={120} autoComplete="name" onChange={(e) => cambiar('nombre', e.target.value)} /></Campo>
      <Campo etiqueta="Tu correo" ayuda="te respondemos aquí"><input className="input" type="email" value={f.email} maxLength={254} autoComplete="email" onChange={(e) => cambiar('email', e.target.value.trim())} /></Campo>
      <Campo etiqueta="Teléfono" ayuda="opcional"><input className="input" type="tel" inputMode="tel" value={f.telefono} maxLength={25} autoComplete="tel" onChange={(e) => cambiar('telefono', e.target.value.replace(/[^\d\s()+-]/g, ''))} /></Campo>
      <Campo etiqueta={modo === 'datos' ? 'Comercio o empresa' : 'Empresa o referencia de tu pago'} ayuda="opcional"><input className="input" value={f.comercio} maxLength={120} onChange={(e) => cambiar('comercio', e.target.value)} /></Campo>
    </div>
    <Campo etiqueta={modo === 'datos' ? 'Cuéntanos tu solicitud' : 'Cuéntanos tu petición, queja o reclamo'} ayuda={`${f.detalle.length}/2000`}>
      <textarea className="input legal-detalle" rows={5} maxLength={2000} value={f.detalle} onChange={(e) => cambiar('detalle', e.target.value)}
        placeholder={modo === 'datos' ? 'Ej.: quiero que eliminen mi número y mi nombre de las bases de datos del comercio «Café Aurora».' : 'Ej.: pagué el 12 de octubre y no recibí el correo de confirmación.'} />
    </Campo>
    <p className="legal-aviso">No incluyas contraseñas, números de tarjeta ni códigos de acceso. Usaremos estos datos solo para atender tu solicitud, conforme a la <Link to="/privacidad">Política de tratamiento de datos</Link>.</p>
    {mensaje && <p className="bloqueado" role="alert">{mensaje}</p>}
    <button className="btn primario grande" type="submit" disabled={ocupado}>{ocupado ? 'Enviando…' : modo === 'datos' ? 'Enviar solicitud' : 'Radicar'}</button>
  </form>;
}

/** Consulta del estado con radicado y correo. Responde igual si algo no coincide. */
export function ConsultaSolicitud() {
  const [radicado, setRadicado] = useState('');
  const [email, setEmail] = useState('');
  const [estado, setEstado] = useState<any>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const NOMBRE_ESTADO: Record<string, string> = { RECIBIDA: 'Recibida', EN_TRAMITE: 'En trámite', RESUELTA: 'Resuelta', RECHAZADA: 'Rechazada' };
  const consultar = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setEstado(null); setOcupado(true);
    try { setEstado(await api.post('/api/publico/solicitudes-datos/consulta', { radicado, email })); }
    catch { setError('No encontramos una solicitud con ese radicado y ese correo. Revisa que estén tal como los recibiste.'); }
    finally { setOcupado(false); }
  };
  return <form className="legal-form legal-consulta" onSubmit={consultar} noValidate>
    <div className="grid g2">
      <Campo etiqueta="Radicado"><input className="input mono" value={radicado} maxLength={20} placeholder="SD-2026-000123" onChange={(e) => setRadicado(e.target.value.toUpperCase())} /></Campo>
      <Campo etiqueta="Correo con el que la enviaste"><input className="input" type="email" value={email} maxLength={254} autoComplete="email" onChange={(e) => setEmail(e.target.value.trim())} /></Campo>
    </div>
    <button className="btn" type="submit" disabled={ocupado || !radicado || !email}>{ocupado ? 'Consultando…' : 'Consultar estado'}</button>
    {error && <p className="bloqueado" role="alert">{error}</p>}
    {estado && <p className="estado ok" role="status"><Icon n="ok" size={14} className="" /><span>Solicitud <b className="mono">{estado.radicado}</b>: <b>{NOMBRE_ESTADO[estado.estado] ?? estado.estado}</b>. Fecha objetivo de respuesta: {fechaLarga(estado.vence_en)}.</span></p>}
  </form>;
}
