import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, guardar, type ApiError } from '../api';
import { PublicoLayout, useBorrador } from '../pages/public/Publico';
import { AiOrb } from './AiOrb';
import { AiVoice } from './AiVoice';
import { PropuestaIA, TAMANOS, VOLUMENES } from './PropuestaIA';
import { Quote } from './Quote';
import { ErrorCarga } from './ui';
import { Icon } from './icons';

/** Preguntas de respaldo cuando el modelo no formuló una propia para el dato que falta. */
const PREGUNTAS_BASE: Record<string, string> = {
  actividad: '¿A qué se dedica tu negocio exactamente?',
  tamano: '¿Cuántas personas atenderán a tus clientes?',
  volumen_conv_mes: '¿Más o menos cuántas conversaciones con clientes recibes al mes?',
  factura_electronica: '¿Necesitas emitir factura electrónica a tus clientes?',
};

/** Lo que la IA ya entendió, en una línea legible a partir de los valores validados por el servidor. */
function resumen(c: any) {
  const partes = [
    c.sector === 'otro' ? c.otro_descripcion || null : c.tipo_negocio ? `${c.tipo_negocio}${c.actividades_adicionales?.length ? ` y también ${c.actividades_adicionales.map((a: any) => a.tipo_negocio).join(', ')}` : ''}` : null,
    TAMANOS.find(([v]) => v === c.tamano)?.[1]?.toLowerCase(),
    c.volumen_conv_mes ? `${VOLUMENES.find(([v]) => v === c.volumen_conv_mes)?.[1]} en conversaciones` : null,
    c.factura_electronica === true ? 'con factura electrónica' : c.factura_electronica === false ? 'sin factura electrónica por ahora' : null,
  ].filter(Boolean);
  return partes.length ? `Entendí: ${partes.join(' · ')}.` : '';
}

/** El primer dato que falta, con la pregunta del modelo si la hizo. */
function primeraPregunta(c: any) {
  const actividad = c.sector && (c.sector === 'otro' ? c.otro_descripcion : c.tipo_negocio);
  if (!actividad) return c.preguntas?.tipo_negocio || c.preguntas?.sector || PREGUNTAS_BASE.actividad;
  for (const campo of ['tamano', 'volumen_conv_mes', 'factura_electronica']) if (c[campo] == null) return c.preguntas?.[campo] || PREGUNTAS_BASE[campo];
  return null;
}

export function RegistrationStart() {
  const nav = useNavigate();
  const { d, setD, cargando, error: errorBorrador, recargar } = useBorrador();
  const [texto, setTexto] = useState(() => {
    try { return sessionStorage.getItem('descripcion_inicial') ?? ''; } catch { return ''; }
  });
  const [ocupado, setOcupado] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState('');
  const [conexion, setConexion] = useState<{ disponible: boolean; simulado: boolean } | null>(null);
  // En el teléfono el panel de la IA va arriba y fijo; se puede plegar a una línea.
  const [plegado, setPlegado] = useState(false);
  const [novedad, setNovedad] = useState(false);
  const ultima = useRef('');
  const enCurso = useRef(false);
  const tocado = useRef(false);
  const vigente = useRef(true);
  const textoActual = useRef(texto);
  textoActual.current = texto;

  useEffect(() => {
    vigente.current = true;
    try { sessionStorage.removeItem('descripcion_inicial'); } catch { /* no storage */ }
    api.get('/api/onboarding/ia/estado').then(setConexion).catch(() => setConexion(null));
    return () => { vigente.current = false; };
  }, []);
  useEffect(() => {
    if (d?.descripcion && !tocado.current && !textoActual.current) {
      ultima.current = d.descripcion.trim(); setTexto(d.descripcion);
    }
  }, [d]);

  const analizar = async (descripcion: string) => {
    const value = descripcion.trim();
    if (enCurso.current || value.length < 15) return;
    enCurso.current = true; ultima.current = value; setOcupado(true); setError('');
    try {
      let r = await api.post(d ? `/api/onboarding/borradores/${d.token}/analizar` : '/api/onboarding/borradores', { descripcion: value, creacion_diferida: true });
      guardar('borrador', r.token);
      let elegidas: string[] | null = null;
      try { const raw = sessionStorage.getItem('funciones_elegidas'); if (raw) elegidas = JSON.parse(raw); } catch { /* no saved selection */ }
      if (Array.isArray(elegidas)) {
        r = await api.patch(`/api/onboarding/borradores/${r.token}`, { clasificacion: { modulos_sugeridos: elegidas } });
        sessionStorage.removeItem('funciones_elegidas');
      }
      if (vigente.current) setD(r);
    } catch (e) { if (vigente.current) setError((e as Error).message); }
    finally { enCurso.current = false; if (vigente.current) setOcupado(false); }
  };
  // Se analiza en cada pausa al escribir. Las peticiones van en serie: sin resultados viejos ni borradores duplicados.
  useEffect(() => {
    const value = texto.trim();
    if (cargando || ocupado || guardando || value.length < 15 || value === ultima.current || value === d?.descripcion?.trim()) return;
    const timer = window.setTimeout(() => analizar(value), 1200);
    return () => window.clearTimeout(timer);
  }, [texto, ocupado, guardando, cargando, d?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const enviar = (e: FormEvent) => { e.preventDefault(); analizar(texto); };
  const cambiar = async (cambios: Record<string, unknown>) => {
    if (guardando || !d) return;
    setGuardando(true); setError('');
    try { setD(await api.patch(`/api/onboarding/borradores/${d.token}`, { clasificacion: cambios })); }
    catch (e) { setError((e as ApiError).message); }
    finally { setGuardando(false); }
  };

  // La propuesta anterior se conserva (atenuada) mientras la descripción cambia: nada desaparece de golpe.
  const c = d?.clasificacion ?? null;
  const actual = !!c && texto.trim() === d?.descripcion?.trim();
  const listo = actual && !!c?.sector && (c.sector === 'otro' ? !!c.otro_descripcion : !!c.tipo_negocio);
  const largo = texto.trim().length;
  const fallback = c?.motor === 'reglas';
  const pregunta = c && actual ? primeraPregunta(c) : null;

  const mensaje = error ? 'No pude terminar el análisis. Revisa tu conexión y vuelve a intentarlo cuando quieras.'
    : ocupado ? 'Estoy leyendo tu descripción: busco tu actividad, tu equipo, tus conversaciones y si necesitas facturar.'
    : !largo ? 'Hola. Cuéntame qué vendes o qué servicio ofreces, y armo tu espacio contigo.'
    : largo < 15 ? 'Te leo. Cuéntame un poco más de tu negocio.'
    : c && !actual ? 'Veo cambios en tu descripción. En cuanto hagas una pausa, actualizo la propuesta.'
    : !c ? 'Te leo. En cuanto hagas una pausa, analizo lo que escribiste.'
    : [fallback ? 'Hice una lectura básica porque la IA no respondió a tiempo.' : '', resumen(c),
      pregunta ? `${pregunta} Puedes escribirlo arriba o elegirlo en la propuesta.` : 'Tengo todo listo. Si deseas agregar algo más adelante, escríbelo aquí y lo tengo en cuenta.'].filter(Boolean).join(' ');
  const orbe = error ? 'breathing' : ocupado ? 'solving' : c && actual ? (pregunta ? 'listening' : 'shaping') : largo ? 'listening' : 'breathing';
  // Si llega un mensaje nuevo con el panel plegado, el orbe lo señala hasta que se abra.
  const ultimoMensaje = useRef(mensaje);
  useEffect(() => {
    if (mensaje === ultimoMensaje.current) return;
    ultimoMensaje.current = mensaje;
    if (plegado) setNovedad(true);
  }, [mensaje, plegado]);
  const alternarPanel = () => { setPlegado(v => !v); setNovedad(false); };
  const estadoConexion = ocupado ? 'Analizando con IA en este momento' : conexion?.simulado ? 'Modo de demostración · IA simulada' : conexion?.disponible ? 'IA conectada · lista para analizar' : 'Analizaremos al enviar tu descripción';

  return <PublicoLayout paso={d ? 1 : 0}>
    {errorBorrador && <ErrorCarga error={errorBorrador} reintentar={recargar} />}
    <div className={`registration-start ${c ? 'has-result' : ''}`}>
      <form className="registration-prompt" onSubmit={enviar}>
        <h1>Tu negocio empieza<br />con tus palabras.</h1>
        <p className="registration-lead">Cuéntanos qué haces y cómo trabajas. La IA organiza tu espacio; tú ajustas lo que quieras.</p>
        <div className={`registration-composer ${ocupado ? 'is-working' : ''}`}>
          <label htmlFor="business-description">¿Qué vendes o qué servicio ofreces?</label>
          <textarea id="business-description" maxLength={2000} value={texto} onChange={e => { tocado.current = true; setTexto(e.target.value); }}
            placeholder="Tengo una barbería en Cúcuta, somos tres barberos y atendemos por turnos. Recibimos unas 20 conversaciones al día por WhatsApp y necesito facturar electrónicamente."
            aria-describedby="description-help" />
          <div className="composer-footer">
            <span id="description-help">{ocupado ? 'Analizando tu descripción…' : actual ? 'Análisis guardado' : largo >= 15 ? 'Analizo en cada pausa al escribir' : 'Una frase de al menos 15 caracteres'}</span>
            <button type="submit" className="composer-send" disabled={ocupado || cargando || largo < 15 || actual} aria-label={error ? 'Reintentar análisis' : 'Analizar ahora'}>
              {ocupado ? <AiOrb state="working" size={20} theme="dark" label="Analizando" /> : <Icon n="flecha" size={19} />}
            </button>
          </div>
        </div>
        {error && <p className="bloqueado" role="alert">{error} <button type="button" className="enlace" disabled={ocupado} onClick={() => analizar(texto)}>Reintentar</button></p>}
        <p className="registration-saving"><Icon n="candado" size={15} />Puedes cambiar la propuesta antes de pagar.</p>
      </form>

      <aside className={`registration-ai ${ocupado ? 'is-working' : ''} ${c ? 'is-compact' : ''} ${plegado ? 'is-folded' : ''} ${mensaje.length > 150 ? 'is-long' : ''}`} aria-busy={ocupado} aria-label="Asistente de Omnegia">
        <div className="registration-orb-stage"><span className="orb-halo" aria-hidden="true" /><span className="orb-halo" aria-hidden="true" />
          <AiOrb large theme="dark" state={orbe} label={ocupado ? 'Análisis en curso' : 'Asistente de Omnegia'} />
          {novedad && <span className="ai-novedad"><span className="sr">Mensaje nuevo de la IA</span></span>}</div>
        <div className="registration-ai-copy" onClick={plegado ? alternarPanel : undefined}><AiVoice texto={mensaje} /></div>
        <div className="registration-ai-status"><span className={ocupado ? 'ai-status-dot active' : 'ai-status-dot live'} />{estadoConexion}</div>
        <button type="button" className="registration-ai-toggle" aria-expanded={!plegado} onClick={alternarPanel}>
          <Icon n={plegado ? 'abajo' : 'arriba'} size={16} className="" /><span className="sr">{plegado ? 'Mostrar el mensaje de la IA' : 'Minimizar el mensaje de la IA'}</span>
        </button>
      </aside>
      <div className="registration-response">
        {c && <div className={`registration-proposal ${actual ? '' : 'is-stale'}`} aria-busy={!actual}>
          <PropuestaIA c={c} ocupado={guardando || !actual} cambiar={cambiar} />
          {fallback && actual && <button type="button" className="btn" onClick={() => analizar(texto)} disabled={ocupado}>Volver a intentar con IA</button>}
          <Quote quote={d.cotizacion} loading={guardando || !actual} modalidad={d.modalidad} />
          <button type="button" className="btn primario grande registration-continue" disabled={guardando || !listo} onClick={() => nav('/empezar/datos')}>Continuar con esta configuración <Icon n="flecha" size={17} /></button>
          {actual && !listo && <p className="tenue peq-txt">Completa tu actividad para continuar. Lo demás se puede ajustar después.</p>}
        </div>}
      </div>
    </div>
  </PublicoLayout>;
}
