import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { api, ApiError, cop, descargarDocumentos, guardar, irAEmpresa } from '../api';
import { PublicoLayout, useBorrador } from '../pages/public/Publico';
import { faseRecibo, reciboEnCurso, type FaseRecibo } from '../pages/public/recibo';
import { useFaseMinima } from '../pages/public/ritmo';
import { Campo, CodigoOtp, useCuentaAtras } from './ui';
import { ReciboImpresion } from './ReciboImpresion';
import { Icon } from './icons';
import { AiOrb } from './AiOrb';
import { CreationTheater } from './CreationTheater';

const RECEIPT_ORDER = ['validando', 'generando', 'listo'] as const;
const RECEIPT_TIME: Partial<Record<FaseRecibo, number>> = { validando: 300, generando: 1500 };
const CREATION: Record<string, { title: string; detail: string; orb: OrbState }> = {
  en_cola: { title: 'Tu espacio empieza a tomar forma.', detail: 'La solicitud está guardada. Estamos preparando el análisis de tu negocio.', orb: 'connecting' },
  analizando: { title: 'La IA está pensando en tu negocio.', detail: 'Analiza tu descripción y las funciones elegidas para personalizar tu espacio.', orb: 'solving' },
  aplicando: { title: 'Estamos dando forma a tu espacio.', detail: 'Guardamos la configuración, tu catálogo y las herramientas de tu empresa.', orb: 'weaving' },
  completado: { title: 'Tu negocio ya tiene su lugar.', detail: 'Abriendo tu espacio con tus datos y tu configuración.', orb: 'shaping' },
};
const STEPS = [
  ['empresa_creada', 'Empresa y suscripción'], ['plantilla_aplicada', 'Herramientas y permisos'],
  ['catalogo_importado', 'Catálogo'], ['administrador_creado', 'Tu acceso'],
  ['tema_generado', 'Identidad visual'], ['subdominio_asignado', 'Dirección del espacio'],
] as const;

function ReturnRecovery({ recovery }: { recovery: any }) {
  if (recovery.cargando) return <p className="sec" role="status">Consultando la confirmación de Wompi…</p>;
  if (recovery.error || !recovery.alta) return <>
    <p className="sec">{recovery.error || 'Todavía no encontramos la confirmación de esta alta. Si acabas de pagar, puede tardar unos minutos.'}</p>
    <div className="fila envolver"><Link className="btn" to="/recuperar">Recuperar mi acceso</Link><Link className="btn sutil" to="/ayuda">Necesito ayuda</Link></div>
  </>;
  return <>
    <p className="sec">{recovery.pago === 'APROBADO' ? 'Tu pago está confirmado.' : 'La confirmación del pago está pendiente.'} Continúa desde el enlace del correo para recuperar tu configuración.</p>
    <p>{recovery.enviado ? <>Enviamos el enlace a <b>{recovery.correo}</b>. Revisa también el correo no deseado.</> : 'No pudimos enviarte el enlace. Contacta con soporte para recuperar el alta.'}</p>
    <Link className="btn sutil" to="/ayuda">Necesito ayuda</Link>
  </>;
}

export function RegistrationCompletion() {
  const { tk, d } = useBorrador();
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const returnId = query.get('id');
  const [status, setStatus] = useState<any>(null);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const [recovery, setRecovery] = useState<any>(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [accessError, setAccessError] = useState('');
  const [documentError, setDocumentError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [challenge, setChallenge] = useState<{ desafio: string; destino: string; minutos: number } | null>(null);
  const [code, setCode] = useState('');
  const authAttempt = useRef(false);
  const submitLock = useRef(false);
  const authenticated = useRef(false);
  const countdown = useCuentaAtras();

  useEffect(() => {
    if (!returnId || !/^[\w-]{3,80}$/.test(returnId)) return;
    let alive = true;
    if (!tk) {
      setRecovery({ cargando: true });
      api.post('/api/onboarding/retorno', { id: returnId }).then((r) => { if (alive) setRecovery(r); }).catch((e) => { if (alive) setRecovery({ error: e.message }); });
    } else api.get(`/api/pagos/verificar?id=${encodeURIComponent(returnId)}`).catch(() => {}).finally(() => { if (alive) setRevision((n) => n + 1); });
    return () => { alive = false; };
  }, [tk, returnId]);

  useEffect(() => {
    if (!tk) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await api.get(`/api/onboarding/borradores/${tk}/estado`);
        if (!alive) return;
        setStatus(next); setLoadError('');
        const state = next.creacion?.estado;
        if (next.pago?.estado === 'PENDIENTE' || ['en_cola', 'analizando', 'aplicando'].includes(state) || (next.pago?.estado === 'APROBADO' && reciboEnCurso(faseRecibo(next)))) timer = window.setTimeout(poll, 1200);
      } catch (e) { if (alive) setLoadError((e as Error).message); }
    };
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [tk, revision]);

  const paid = status?.pago?.estado === 'APROBADO';
  const ready = status?.estado === 'APROVISIONADO';
  const needsPassword = !!status?.requiere_contrasena;
  const creationError = status?.creacion?.estado === 'error' ? status.creacion.error : status?.error_aprovisionamiento;
  const working = ['en_cola', 'analizando', 'aplicando'].includes(status?.creacion?.estado);
  const creating = !creationError && (working || started) && !challenge;
  const name = status?.tenant?.nombre ?? status?.negocio?.nombre ?? d?.negocio?.nombre ?? 'Tu negocio';
  const email = status?.email ?? d?.negocio?.email ?? '';
  const receiptReal = faseRecibo(status);
  const receipt = useFaseMinima(receiptReal, RECEIPT_ORDER, RECEIPT_TIME);
  const creation = CREATION[ready ? 'completado' : status?.creacion?.estado] ?? CREATION.en_cola;
  const completed = new Set<string>((status?.etapas ?? []).map((s: any) => s.etapa));

  const enterWorkspace = async () => {
    if (!status?.tenant?.slug) throw new Error('Tu espacio todavía no tiene una dirección disponible. Vuelve a consultar el estado.');
    if (status.requiere_contrasena && !status.creacion_diferida) {
      try { await api.post(`/api/onboarding/borradores/${tk}/contrasena`, { password }); }
      catch (e) { if ((e as ApiError).status !== 409) throw e; }
    }
    if (!authenticated.current) {
      const login = await api.post('/api/auth/login', { email, password });
      if (login.segundo_factor) { setChallenge(login); countdown.iniciar(60); setStarted(false); return; }
      if (!login.empresas?.some((company: any) => company.slug === status.tenant.slug)) throw new Error('Esta cuenta no tiene acceso al espacio creado. Revisa el correo del administrador.');
      authenticated.current = true;
    }
    guardar('borrador', null);
    irAEmpresa(status.tenant.slug, '/?estreno=1', (url) => navigate(url, { replace: true }));
  };

  // Se entra al panel cuando el espacio existe y la vista previa terminó de mostrarlo completo.
  const [presentado, setPresentado] = useState(false);
  useEffect(() => {
    if (!ready || !started || !presentado || !password || authAttempt.current || challenge) return;
    authAttempt.current = true;
    setBusy(true);
    enterWorkspace().catch((e) => { setAccessError(e.message); setStarted(false); }).finally(() => setBusy(false));
  }, [ready, started, presentado, password, challenge]); // Auth attempt is explicit and one-shot; failed login requires retry.

  const create = async (event?: FormEvent, confirmedSession = false) => {
    event?.preventDefault();
    if (submitLock.current || working) return;
    submitLock.current = true; setBusy(true); setAccessError(''); authAttempt.current = false;
    try {
      if (ready) { setStarted(true); authAttempt.current = true; await enterWorkspace(); return; }
      const response = await api.post(`/api/onboarding/borradores/${tk}/crear`, confirmedSession ? {} : { password });
      if (response.segundo_factor) { setChallenge(response); setCode(''); countdown.iniciar(60); return; }
      setStatus((s: any) => ({ ...s, creacion: response.creacion, error_aprovisionamiento: null }));
      setStarted(true); setRevision((n) => n + 1);
    } catch (e) { setAccessError((e as Error).message); setStarted(false); }
    finally { setBusy(false); submitLock.current = false; }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !challenge) return;
    setBusy(true); setAccessError('');
    try {
      await api.post('/api/auth/login/codigo', { desafio: challenge.desafio, codigo: code });
      authenticated.current = true; setChallenge(null); setCode('');
      if (ready) { setStarted(true); await enterWorkspace(); } else await create(undefined, true);
    } catch (e) { setAccessError((e as Error).message); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    if (!challenge || countdown.restante > 0 || busy) return;
    setBusy(true); setAccessError('');
    try { const r = await api.post('/api/auth/login/codigo/reenviar', { desafio: challenge.desafio }); setChallenge({ ...challenge, destino: r.destino, minutos: r.minutos }); countdown.iniciar(60); }
    catch (e) { setAccessError((e as Error).message); const wait = (e as ApiError).details?.espera_segundos; if (wait) countdown.iniciar(wait); }
    finally { setBusy(false); }
  };

  const download = async () => {
    setDocumentError(''); setDownloading(true);
    try { await descargarDocumentos(() => api.post(`/api/onboarding/borradores/${tk}/documentos/enlace`)); }
    catch (e) { setDocumentError((e as Error).message); }
    finally { setDownloading(false); }
  };
  const retryDocuments = async () => {
    if (downloading) return;
    setDocumentError(''); setDownloading(true);
    try { await api.post(`/api/onboarding/borradores/${tk}/documentos/reintentar`); setRevision((n) => n + 1); }
    catch (e) { setDocumentError((e as Error).message); }
    finally { setDownloading(false); }
  };
  const payAgain = async () => {
    if (busy) return;
    setBusy(true); setAccessError('');
    try { const r = await api.post(`/api/onboarding/borradores/${tk}/pago`, { retorno: window.location.origin }); if (r.url) window.location.assign(r.url); else setRevision((n) => n + 1); }
    catch (e) { setAccessError((e as Error).message); }
    finally { setBusy(false); }
  };

  const rejected = ['RECHAZADO', 'ANULADO'].includes(status?.pago?.estado);
  const head = !tk ? 'Recupera tu configuración' : loadError ? 'No pudimos consultar tu alta' : !status ? 'Consultando tu pago…' : rejected ? 'El pago no fue aprobado' : !paid ? status.pago?.estado === 'PENDIENTE' ? 'Esperando la confirmación del pago' : 'Tu configuración está guardada' : 'Tu pago está confirmado.';

  return <PublicoLayout paso={paid ? 5 : 4} hechos={ready ? 6 : paid ? 5 : 4}
    estado={{ tono: creationError || loadError ? 'warn' : paid ? 'ok' : 'neutro', icono: paid ? 'ok' : 'reloj', texto: paid ? creating ? 'Preparando tu espacio' : 'Pago confirmado' : 'Confirmación del pago' }}
    notaAlta={paid ? 'Tu pago está guardado. Puedes retomar la creación desde este enlace.' : 'Tu configuración se conserva mientras se confirma el pago.'}>
    {(!paid || !tk || loadError) && <section className="finish-message">
      <ThinkingOrb state={loadError || rejected ? 'breathing' : 'connecting'} size={64} theme="light" paused={!!loadError || rejected} aria-label={head} />
      <h1>{head}</h1>
      {!tk ? recovery ? <ReturnRecovery recovery={recovery} /> : <><p>Continúa desde el enlace que enviamos a tu correo o empieza una nueva configuración.</p><Link className="btn primario" to="/empezar">Empezar</Link></> : loadError ? <><p role="alert">{loadError}</p><button className="btn primario" onClick={() => setRevision((n) => n + 1)}>Reintentar la consulta</button></> : !status ? <p role="status">Estamos consultando el estado real de tu alta.</p> : <>
        <p>{rejected ? 'Tu configuración sigue guardada. Puedes volver a intentar el pago.' : status.pago?.estado === 'PENDIENTE' ? `La pasarela todavía está confirmando ${cop(status.pago.monto)} COP. Consultamos de nuevo automáticamente.` : 'Revisa tu propuesta para continuar con el pago.'}</p>
        {status.pago && <button className="btn primario" disabled={busy} onClick={payAgain}>{busy ? 'Preparando…' : rejected ? 'Intentar el pago de nuevo' : 'Volver a la pasarela'}</button>}
        <Link className="btn sutil" to="/empezar/pago">Revisar la propuesta</Link>
        {accessError && <p role="alert" className="bloqueado">{accessError}</p>}
      </>}
    </section>}
    {paid && tk && !loadError && creating && <CreationTheater d={d} status={status} titulo={creation.title} detalle={creation.detail} orbe={creation.orb} listo={ready}
      pasos={STEPS.map(([clave, nombre]) => ({ clave, nombre, hecho: completed.has(clave) }))}
      aviso={!password && !busy ? 'La creación sigue en curso. Cuando termine, introduce tu contraseña para abrir tu espacio.' : accessError || null}
      onDescargar={download} descargando={downloading} reciboListo={receiptReal === 'listo'}
      enCurso={CREATION.aplicando} onCompleto={() => setPresentado(true)} />}
    {paid && tk && !loadError && !creating && <div className="registration-finish">
      <section className="finish-receipt" aria-labelledby="receipt-title">
        <div className="finish-paid"><Icon n="ok" size={17} className="" />Pago confirmado</div>
        <h1 id="receipt-title">Todo empieza aquí,<br /><span>{name}.</span></h1>
        <p className="finish-lead">Tu recibo primero. Después, damos vida a tu espacio.</p>
        <ReciboImpresion fase={receipt} numero={status.documentos?.numero} monto={status.pago?.monto} empresa={name}
          concepto={status.pago?.modalidad === 'INSTITUCIONAL' ? `Acceso institucional · ${status.pago.acceso_dias} días` : 'Plan Omnegia'}
          fiscal={status.documentos?.estado_fiscal_texto} validez={!!status.documentos?.validez_fiscal} />
        <dl className="finish-payment-meta"><div><dt>Referencia del pago</dt><dd>{status.pago.referencia}</dd></div><div><dt>Correo del administrador</dt><dd>{email}</dd></div></dl>
        <div className="finish-receipt-actions">
          <button type="button" className="btn" disabled={receiptReal !== 'listo' || downloading} onClick={download}><Icon n="descargar" size={16} className="" />{downloading ? 'Preparando…' : 'Descargar documentos'}</button>
          <button type="button" className="btn sutil" onClick={() => window.print()}>Imprimir recibo</button>
        </div>
        {receiptReal === 'pendiente' && status.documentos?.estado !== 'SIN_DATOS' && <button className="enlace" type="button" disabled={downloading} onClick={retryDocuments}>Reintentar documentos</button>}
        {documentError && <p role="alert" className="bloqueado">{documentError}</p>}
        <p className="finish-document-note">{receiptReal === 'listo' ? 'Descarga opcional. El ZIP contiene tus documentos; cada PDF se abre con tu número de documento de facturación, sin puntos ni guiones.' : status.documentos?.estado === 'SIN_DATOS' ? 'No hay datos de facturación para emitir documentos. Tu pago está confirmado y puedes continuar.' : 'Puedes continuar mientras terminamos de preparar los documentos.'}</p>
      </section>

      <section className="finish-creation" aria-labelledby="creation-title" aria-busy={busy}>
        <div className="finish-orb"><AiOrb state={busy ? 'connecting' : challenge ? 'listening' : 'breathing'} size={64} theme="dark" label="Omnegia está lista para crear tu espacio" /></div>
        <>
          <h2 id="creation-title">{challenge ? 'Un último paso para proteger tu cuenta.' : ready ? 'Tu espacio está listo para ti.' : 'Ahora, hagámoslo tuyo.'}</h2>
          <p>{challenge ? `Escribe el código que enviamos a ${challenge.destino}. Vence en ${challenge.minutos} minutos.` : ready ? 'Abre tu espacio con la cuenta del administrador.' : <>La IA preparará el inicio de <strong>{name}</strong> con tus funciones, tus prioridades y tu identidad.</>}</p>
          {creationError && <p className="finish-error" role="alert">{creationError} Tu pago está confirmado; puedes reintentar sin pagar de nuevo.</p>}
          <form className="finish-create-form" onSubmit={challenge ? verify : create}>
            {challenge ? <><CodigoOtp valor={code} onCambio={setCode} autoFocus /><button className="finish-create-button" disabled={busy || code.length !== 6}>{busy ? 'Verificando…' : 'Verificar y continuar'}</button><button type="button" className="finish-resend" disabled={countdown.restante > 0 || busy} onClick={resend}>{countdown.restante ? `Reenviar en ${countdown.restante} s` : 'Reenviar código'}</button></> : <>
              <Campo etiqueta={needsPassword ? 'Crea tu contraseña' : 'Contraseña del administrador'} ayuda={needsPassword ? 'Mínimo 10 caracteres. Será la contraseña para entrar a tu espacio.' : email}>
                <div className="finish-password"><input className="input" type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={needsPassword ? 'new-password' : 'current-password'} minLength={needsPassword ? 10 : undefined} required /><button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword}>{showPassword ? 'Ocultar' : 'Mostrar'}</button></div>
              </Campo>
              {accessError && <p className="finish-error" role="alert">{accessError}</p>}
              <button className="finish-create-button" disabled={busy || (needsPassword ? password.length < 10 : !password)}><ThinkingOrb state={busy ? 'connecting' : 'shaping'} size={20} theme="light" aria-hidden="true" />{busy ? 'Conectando…' : ready ? 'Abrir mi espacio' : creationError ? 'Reintentar con IA' : 'Crear mi espacio con IA'}<Icon n="flecha" size={18} className="" /></button>
              {!needsPassword && <Link className="finish-recover" to="/recuperar">¿Olvidaste tu contraseña?</Link>}
            </>}
          </form>
          {challenge && accessError && <p className="finish-error" role="alert">{accessError}</p>}
          <p className="finish-create-note">{ready ? 'La sesión se abre automáticamente al verificar tu contraseña.' : 'Verás cómo aparece tu espacio y podrás empezar a usarlo ahí mismo.'}</p>
        </>
      </section>
    </div>}
  </PublicoLayout>;
}
