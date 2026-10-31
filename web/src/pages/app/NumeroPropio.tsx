import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, fechaHora, type ApiError } from '../../api';
import { Escritura } from '../../components/Layout';
import { Campo, Tarjeta, useAccion } from '../../components/ui';
import { Icon } from '../../components/icons';
import { MarcaExito } from '../../components/Movimiento';
import { AiOrb } from '../../components/AiOrb';

/**
 * «Usar mi propio número»: la empresa escribe su número, recibe un código por SMS y queda conectada a la
 * IA sin entrar a Meta. Cada paso refleja el estado del servidor; si se cierra la página, al volver se
 * retoma donde quedó. Los mensajes de error ya vienen traducidos por el servidor (nunca el texto de Meta).
 */
type C = any;
type Pais = { pais: string; nombre: string; indicativo: string };

const PASOS = ['Tu número', 'Código', 'Listo'];
const hora = (d: string) => new Date(d).toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit' });
export const formatoPropio = (n: string) => {
  const m = /^\+57(\d{3})(\d{3})(\d{4})$/.exec(n);
  return m ? `+57 ${m[1]} ${m[2]} ${m[3]}` : n.replace(/^(\+\d{1,3})(\d{3})(\d{3})(\d+)$/, '$1 $2 $3 $4');
};

function Pasos({ actual }: { actual: number }) {
  return (
    <ol className="num-pasos" aria-label={`Paso ${actual + 1} de ${PASOS.length}`}>
      {PASOS.map((p, i) => <li key={p} className={i < actual ? 'hecho' : i === actual ? 'on' : ''} aria-current={i === actual ? 'step' : undefined}><b>{i < actual ? <Icon n="ok" className="" size={12} /> : i + 1}</b><span>{p}</span></li>)}
    </ol>
  );
}

/** Lleva el foco al título del paso cuando el paso cambia (teclado y lectores de pantalla). */
function useFocoTitulo(clave: string) {
  const ref = useRef<HTMLHeadingElement>(null);
  const previa = useRef(clave);
  useEffect(() => { if (previa.current !== clave) ref.current?.focus(); previa.current = clave; }, [clave]);
  return ref;
}

const Fallo = ({ error }: { error: ApiError | null }) => error ? <div className="bloqueado num-fallo" role="alert"><Icon n="alerta" className="" size={16} /><span>{error.message}</span></div> : null;

// ---------------------------------------------------------------------------
// Paso 1 · país y número
// ---------------------------------------------------------------------------
export function PasoNumero({ paises, nombre, onCreada }: { paises: Pais[]; nombre: string | null; onCreada: (c: C) => void }) {
  const [pais, setPais] = useState(paises[0]?.pais ?? 'CO');
  const [numero, setNumero] = useState('');
  const [visible, setVisible] = useState(nombre ?? '');
  const [acepto, setAcepto] = useState(false);
  const { run, ocupado, error } = useAccion();
  const ind = paises.find((p) => p.pais === pais)?.indicativo ?? '';
  const digitos = numero.replace(/\D/g, '');
  // Comprobación rápida en el navegador; la validación real (y la de Meta) ocurre en el servidor.
  const formatoOk = pais === 'CO' ? /^(3\d{9}|60\d{8})$/.test(digitos) : digitos.length >= 6 && digitos.length <= 14;
  const aviso = digitos.length >= 3 && !formatoOk ? (pais === 'CO' ? 'En Colombia un celular tiene 10 dígitos y empieza por 3.' : 'Revisa que el número esté completo.') : undefined;
  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    if (!formatoOk || !acepto) return;
    const r = await run(() => api.post('/api/t/numeros/propio', { pais, numero: digitos, acepto_aviso: true, nombre_visible: visible.trim() || undefined }), undefined, { silencioso: true });
    if (r) onCreada(r);
  };
  return (
    <div className="col num-entra" style={{ gap: 16 }}>
      <Pasos actual={0} />
      <Tarjeta titulo="¿Qué número quieres conectar?">
        <form className="col num-propio-form" style={{ gap: 14 }} onSubmit={enviar} noValidate>
          <div className="num-propio-numero">
            <Campo etiqueta="País">
              <select className="input" value={pais} onChange={(e) => setPais(e.target.value)}>
                {paises.map((p) => <option key={p.pais} value={p.pais}>{p.nombre} (+{p.indicativo})</option>)}
              </select>
            </Campo>
            <Campo etiqueta="Número de celular" error={aviso}>
              <span className="num-prefijo">
                <span className="mono" aria-hidden="true">+{ind}</span>
                <input className="input mono" inputMode="tel" autoComplete="tel-national" value={numero} onChange={(e) => setNumero(e.target.value.replace(/[^\d ]/g, '').slice(0, 18))}
                  placeholder={pais === 'CO' ? '300 123 4567' : 'Número sin el indicativo'} aria-invalid={!!aviso} aria-label={`Número de celular, indicativo +${ind}`} />
              </span>
            </Campo>
          </div>
          <Campo etiqueta="Nombre que verán tus clientes" ayuda="Meta lo revisa: usa el nombre real de tu negocio">
            <input className="input" value={visible} onChange={(e) => setVisible(e.target.value)} maxLength={80} minLength={3} />
          </Campo>
          <div className="aviso num-propio-aviso" role="note">
            <Icon n="alerta" className="" size={18} />
            <span><b>Este número dejará de funcionar en la app de WhatsApp de tu celular.</b> Desde ahora lo atenderá tu asistente en Omnegia. Te recomendamos un chip nuevo solo para el negocio.</span>
          </div>
          <label className="num-check">
            <input type="checkbox" checked={acepto} onChange={(e) => setAcepto(e.target.checked)} />
            <span>Entiendo que este número dejará de funcionar en la app de WhatsApp de mi celular.</span>
          </label>
          <Fallo error={error} />
          <div className="fila envolver" style={{ justifyContent: 'space-between', gap: 10 }}>
            <span className="tenue peq-txt">Sin costo en Omnegia. No necesitas cuenta de Meta ni de Facebook.</span>
            <Escritura permiso="tenant:configure">
              <button className="btn primario grande" disabled={!formatoOk || !acepto || visible.trim().length < 3 || ocupado}>
                {ocupado ? <><span className="num-girando" aria-hidden="true" />Enviando el código…</> : <>Enviarme el código<Icon n="flecha" className="" size={16} /></>}
              </button>
            </Escritura>
          </div>
        </form>
      </Tarjeta>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pasos 2 y 3
// ---------------------------------------------------------------------------
export function Propio({ c, onCambio, recargar }: { c: C; onCambio: (c: C) => void; recargar: () => void }) {
  const paso = ['NUMERO_INGRESADO', 'CODIGO_ENVIADO'].includes(c.estado) ? 1 : 2;
  return (
    <div className="col" style={{ gap: 16 }}>
      <Pasos actual={c.estado === 'CONECTADO' ? 3 : paso} />
      {c.simulado && <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>Simulación: no se habla con Meta. El código válido es <b className="mono">123456</b>.</span></div>}
      <div key={c.estado} className="num-entra">
        {paso === 1 ? <PasoCodigo c={c} onCambio={onCambio} recargar={recargar} />
          : c.estado === 'CONECTADO' ? <Listo c={c} onCambio={onCambio} />
          : c.estado === 'CONEXION_FALLIDA' ? <Fallida c={c} onCambio={onCambio} />
          : <Conectando c={c} />}
      </div>
    </div>
  );
}

/** Segundos que faltan para poder pedir otro código, contados en el navegador desde lo que dijo el servidor. */
function useCuentaAtras(segundos: number, clave: string) {
  const [resta, setResta] = useState(segundos);
  useEffect(() => {
    setResta(segundos);
    if (segundos <= 0) return;
    const fin = Date.now() + segundos * 1000;
    const t = setInterval(() => { const r = Math.max(0, Math.ceil((fin - Date.now()) / 1000)); setResta(r); if (!r) clearInterval(t); }, 250);
    return () => clearInterval(t);
  }, [segundos, clave]);
  return resta;
}

function PasoCodigo({ c, onCambio, recargar }: { c: C; onCambio: (c: C) => void; recargar: () => void }) {
  const v = c.verificacion;
  const [codigo, setCodigo] = useState('');
  const verificar = useAccion();
  const reenviar = useAccion();
  const cancelar = useAccion();
  const resta = useCuentaAtras(v.espera_s, v.enviado_en ?? '');
  const bloqueo = c.bloqueo_hasta as string | null;
  const sinEnviar = c.estado === 'NUMERO_INGRESADO';
  const voz = v.metodo === 'VOICE';
  const titulo = useFocoTitulo(`${c.estado}:${v.enviado_en}`);
  const entrada = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!sinEnviar) entrada.current?.focus(); }, [sinEnviar]);

  const enviarCodigo = async (valor = codigo) => {
    if (valor.length !== 6 || verificar.ocupado) return;
    const r = await verificar.run(() => api.post(`/api/t/numeros/propio/${c.id}/verificar`, { codigo: valor }), undefined, { silencioso: true });
    if (r) onCambio(r);
    else { setCodigo(''); recargar(); entrada.current?.focus(); }
  };
  const pedir = async (metodo: 'SMS' | 'VOICE') => {
    const r = await reenviar.run(() => api.post(`/api/t/numeros/propio/${c.id}/reenviar`, { metodo }), metodo === 'VOICE' ? 'Te llamaremos en un momento.' : 'Te enviamos un código nuevo.', { silencioso: true });
    if (r) { onCambio(r); setCodigo(''); verificar.limpiarError(); } else recargar();
  };
  const cambiarNumero = async () => { const r = await cancelar.run(() => api.post(`/api/t/numeros/propio/${c.id}/desconectar`, {})); if (r) onCambio(r); };
  const error = verificar.error ?? reenviar.error ?? cancelar.error;
  const puedeReenviar = !bloqueo && resta <= 0 && v.reenvios_restantes > 0 && !reenviar.ocupado;

  return (
    <Tarjeta className="num-panel num-codigo">
      <div className="col" style={{ gap: 16 }}>
        <div className="num-sms" aria-hidden="true">
          <span className="num-sms-tel"><Icon n="telefono" className="" size={22} /></span>
          {!sinEnviar && <span className="num-sms-burbuja">{voz ? '• • •' : '123 456'}</span>}
        </div>
        <div className="col" style={{ gap: 4 }}>
          <h2 ref={titulo} tabIndex={-1} className="num-propio-titulo">{sinEnviar ? 'No pudimos enviar el código' : voz ? 'Te vamos a llamar' : 'Te enviamos un código por SMS'}</h2>
          <p className="sec">
            {sinEnviar ? 'Pide el código otra vez para continuar.' : voz ? <>Contesta la llamada al <b className="mono">{formatoPropio(c.numero)}</b>: una voz te dictará 6 dígitos.</> : <>Lo enviamos al <b className="mono">{formatoPropio(c.numero)}</b>. Puede tardar hasta un minuto.</>}
            {' '}<Escritura permiso="tenant:configure"><button type="button" className="enlace num-enlace-boton" disabled={cancelar.ocupado} onClick={cambiarNumero}>Usar otro número</button></Escritura>
          </p>
        </div>
        {bloqueo && <div className="bloqueado" role="alert"><Icon n="candado" className="" size={16} /><span>Por seguridad, pausamos los intentos. Podrás seguir a las {hora(bloqueo)}.</span></div>}
        {!sinEnviar && (
          <form className="col" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); enviarCodigo(); }}>
            <Campo etiqueta="Código de 6 dígitos" ayuda={v.intentos_restantes < 5 ? `te ${v.intentos_restantes === 1 ? 'queda 1 intento' : `quedan ${v.intentos_restantes} intentos`}` : 'vale 10 minutos'}>
              <input ref={entrada} className="input codigo-otp num-codigo-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} placeholder="••••••"
                value={codigo} disabled={!!bloqueo || verificar.ocupado} aria-invalid={!!verificar.error}
                onChange={(e) => { const x = e.target.value.replace(/\D/g, '').slice(0, 6); setCodigo(x); if (x.length === 6) enviarCodigo(x); }} />
            </Campo>
            <Escritura permiso="tenant:configure">
              <button className="btn primario grande" disabled={codigo.length !== 6 || !!bloqueo || verificar.ocupado}>{verificar.ocupado ? <><span className="num-girando" aria-hidden="true" />Comprobando…</> : 'Conectar mi número'}</button>
            </Escritura>
          </form>
        )}
        <Fallo error={error} />
        <div className="num-reenvio">
          <Escritura permiso="tenant:configure">
            <button type="button" className="btn" disabled={!puedeReenviar} onClick={() => pedir('SMS')} aria-describedby="num-reenvio-ayuda">
              <Icon n="refrescar" className="" size={15} />{sinEnviar ? 'Enviar el código' : 'Reenviar código'}
              {resta > 0 && <span className="num-cuenta mono" aria-hidden="true">{resta}s</span>}
            </button>
          </Escritura>
          <Escritura permiso="tenant:configure">
            <button type="button" className="btn sutil" disabled={!puedeReenviar} onClick={() => pedir('VOICE')}><Icon n="telefono" className="" size={15} />Prefiero una llamada</button>
          </Escritura>
          <span id="num-reenvio-ayuda" className="tenue peq-txt" aria-live="polite">
            {resta > 0 ? `Podrás pedir otro en ${resta} segundos.` : v.reenvios_restantes > 0 ? `Puedes pedir ${v.reenvios_restantes === 1 ? '1 código más' : `${v.reenvios_restantes} códigos más`} esta hora.` : 'Ya pediste los códigos permitidos esta hora.'}
          </span>
        </div>
      </div>
    </Tarjeta>
  );
}

const TEXTO_CONECTANDO: Record<string, string> = {
  registrando: 'Activando tu número en WhatsApp…',
  conectando: 'Uniendo tu número con tu asistente de IA…',
  esperando_meta: 'WhatsApp está terminando de activar el número. Suele tardar unos minutos; puedes cerrar esta página.',
  reintentando: 'WhatsApp tardó en responder. Lo intentamos de nuevo por ti en un momento.',
  esperando_limite: 'WhatsApp nos pidió esperar un poco. Terminaremos la conexión solos; puedes cerrar esta página.',
};

function Conectando({ c }: { c: C }) {
  const titulo = useFocoTitulo(c.subestado ?? '');
  return (
    <Tarjeta className="num-panel num-final">
      <div className="col" style={{ gap: 14, alignItems: 'center', textAlign: 'center' }} role="status">
        <div className="num-union" aria-hidden="true">
          <span className="num-union-nodo"><Icon n="telefono" className="" size={22} /></span>
          <svg className="num-union-linea esperando" viewBox="0 0 160 24" preserveAspectRatio="none"><path d="M2 12 C 50 -4, 110 28, 158 12" /></svg>
          <span className="num-union-ia"><AiOrb state="connecting" size={64} label="Asistente de IA" /></span>
        </div>
        <h2 ref={titulo} tabIndex={-1} className="num-final-titulo">Conectando…</h2>
        <p className="sec">{TEXTO_CONECTANDO[c.subestado] ?? 'Estamos conectando tu número con tu asistente.'}</p>
      </div>
    </Tarjeta>
  );
}

function EstadoNombre({ c }: { c: C }) {
  const e = c.whatsapp.estado_nombre;
  if (!e || e === 'APPROVED' || e === 'AVAILABLE_WITHOUT_REVIEW') return null;
  if (e === 'DECLINED') return <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>Meta no aprobó «{c.nombre_visible}» como nombre visible. Tu número sigue funcionando; <Link className="enlace" to="/soporte">escríbenos</Link> y te ayudamos a proponer otro.</span></div>;
  return <p className="tenue peq-txt num-nombre-revision"><Icon n="reloj" className="" size={14} /> Meta está revisando el nombre «{c.nombre_visible}». Mientras tanto tus clientes ven tu número. No tienes que hacer nada.</p>;
}

function Listo({ c, onCambio }: { c: C; onCambio: (c: C) => void }) {
  const probado = !!c.prueba_recibida_en;
  const titulo = useFocoTitulo(probado ? 'probado' : 'listo');
  const wa = `https://wa.me/${c.numero.replace(/\D/g, '')}?text=${encodeURIComponent('Hola, estoy probando mi WhatsApp con Omnegia')}`;
  return (
    <div className="col" style={{ gap: 16 }}>
      <Tarjeta className="num-panel ok num-final">
        <div className="col" style={{ gap: 14, alignItems: 'center', textAlign: 'center' }}>
          <div className={`num-union ${probado ? 'probado' : ''}`} aria-hidden="true">
            <span className="num-union-nodo"><Icon n="telefono" className="" size={22} /></span>
            <svg className="num-union-linea" viewBox="0 0 160 24" preserveAspectRatio="none"><path d="M2 12 C 50 -4, 110 28, 158 12" /></svg>
            {probado && <span className="num-union-mensaje" />}
            <span className="num-union-ia"><AiOrb state="breathing" size={64} label="Asistente de IA" /></span>
          </div>
          <MarcaExito tamano={52} />
          <h2 ref={titulo} tabIndex={-1} className="num-final-titulo">{probado ? 'Todo funciona' : 'Listo, tu WhatsApp ya responde con la IA'}</h2>
          {probado ? (
            <>
              <p className="sec">Recibimos tu mensaje de prueba ({fechaHora(c.prueba_recibida_en)}) y tu asistente lo atendió. Tus clientes ya pueden escribirte a <b className="mono">{formatoPropio(c.numero)}</b>.</p>
              <Link className="btn primario" to="/conversaciones">Ver la conversación</Link>
            </>
          ) : (
            <>
              <p className="sec">Escríbele a <b className="mono">{formatoPropio(c.numero)}</b> desde otro celular y mira cómo responde tu asistente. Verás el mensaje aquí en cuanto llegue.</p>
              <a className="btn primario grande" href={wa} target="_blank" rel="noreferrer">Enviarme un mensaje de prueba<Icon n="enviar" className="" size={16} /></a>
            </>
          )}
          <EstadoNombre c={c} />
        </div>
      </Tarjeta>
      <Desconectar c={c} onCambio={onCambio} />
    </div>
  );
}

function Desconectar({ c, onCambio }: { c: C; onCambio: (c: C) => void }) {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState('');
  const { run, ocupado, error } = useAccion();
  const ok = texto.trim().toUpperCase() === 'DESCONECTAR';
  const confirmar = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    const r = await run(() => api.post(`/api/t/numeros/propio/${c.id}/desconectar`, { confirmacion: 'DESCONECTAR' }), 'Número desconectado.', { silencioso: true });
    if (r) onCambio(r);
  };
  return (
    <Tarjeta titulo="Tu número conectado" acciones={<span className="mono peq-txt">{formatoPropio(c.numero)}</span>}>
      <div className="col" style={{ gap: 10 }}>
        <p className="sec peq-txt">Conectado desde el {fechaHora(c.conectado_en)}. Conectarlo no tiene mensualidad en Omnegia; responder a tus clientes dentro de las 24 horas siguientes a su mensaje no tiene costo.</p>
        {!abierto ? (
          <Escritura permiso="tenant:configure"><button className="btn peligro" onClick={() => setAbierto(true)} style={{ alignSelf: 'flex-start' }}>Desconectar este número</button></Escritura>
        ) : (
          <form className="num-confirmar" role="group" aria-labelledby="num-desc-t" onSubmit={confirmar}>
            <b id="num-desc-t">¿Desconectar {formatoPropio(c.numero)}?</b>
            <span className="sec peq-txt">Tu asistente dejará de responder en este número. Podrás usarlo otra vez en la app de WhatsApp de tu celular o conectarlo de nuevo más adelante.</span>
            <Campo etiqueta="Escribe DESCONECTAR para confirmar"><input className="input mono" value={texto} onChange={(e) => setTexto(e.target.value)} autoComplete="off" autoFocus /></Campo>
            <Fallo error={error} />
            <div className="fila envolver" style={{ gap: 8 }}>
              <button className="btn peligro" disabled={!ok || ocupado}>{ocupado ? 'Desconectando…' : 'Sí, desconectar'}</button>
              <button type="button" className="btn" onClick={() => { setAbierto(false); setTexto(''); }}>No, mantenerlo</button>
            </div>
          </form>
        )}
      </div>
    </Tarjeta>
  );
}

function Fallida({ c, onCambio }: { c: C; onCambio: (c: C) => void }) {
  const { run, ocupado, error } = useAccion();
  const bloqueo = c.bloqueo_hasta as string | null;
  const titulo = useFocoTitulo('fallida');
  const reiniciar = async () => { const r = await run(() => api.post(`/api/t/numeros/propio/${c.id}/desconectar`, { confirmacion: 'DESCONECTAR' }), undefined, { silencioso: true }); if (r) onCambio(r); };
  return (
    <Tarjeta className="num-panel err">
      <div className="col" style={{ gap: 12 }}>
        <h2 ref={titulo} tabIndex={-1} className="num-propio-titulo">No pudimos terminar la conexión</h2>
        <p className="sec">{c.ultimo_error ?? 'WhatsApp no confirmó la conexión.'}</p>
        {bloqueo && <p className="tenue peq-txt"><Icon n="reloj" className="" size={14} /> Podrás intentarlo de nuevo a partir de las {hora(bloqueo)}.</p>}
        <Fallo error={error} />
        <div className="fila envolver" style={{ gap: 8 }}>
          <Escritura permiso="tenant:configure"><button className="btn primario" disabled={ocupado} onClick={reiniciar}>Empezar de nuevo</button></Escritura>
          <Link className="btn" to="/soporte">Escribir a soporte</Link>
        </div>
      </div>
    </Tarjeta>
  );
}
