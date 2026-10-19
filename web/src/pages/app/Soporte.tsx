import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fechaHora, hace } from '../../api';
import { Cabecera } from '../../components/Layout';
import { Campo, Cargando, ErrorCarga, Estado, Modal, Tarjeta, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { MARCA } from '../../brand';
import { AiOrb } from '../../components/AiOrb';
import { Markdown } from '../../components/Markdown';
import { escalon, MarcaExito } from '../../components/Movimiento';

/**
 * Soporte de la plataforma: la empresa escribe al equipo de Omnegia. Lo que se
 * cuente aquí es lo único que el equipo de soporte verá de la empresa (además de
 * los datos de su suscripción), por eso se advierte no incluir claves ni datos de
 * clientes. Las respuestas llegan al panel y por correo.
 */
export const CATEGORIAS: [string, string][] = [
  ['CUENTA', 'Cuenta y acceso'], ['FACTURACION', 'Suscripción y pagos'], ['WHATSAPP', 'WhatsApp'], ['IA', 'Asistente de IA'], ['TECNICO', 'Problema técnico'], ['OTRO', 'Otro'],
];
const NOMBRE_CATEGORIA = Object.fromEntries(CATEGORIAS);
const ESTADO_TICKET: Record<string, string> = { ABIERTO: 'Abierto', EN_PROCESO: 'En proceso', ESPERANDO_CLIENTE: 'Esperando tu respuesta', RESUELTO: 'Resuelto', CERRADO: 'Cerrado' };

export const AVISO_DATOS = 'No incluyas contraseñas, claves de API, códigos de verificación, números de tarjeta ni datos de tus clientes. El equipo de soporte nunca te los pedirá.';

export function Soporte() {
  const { data, error, cargando, recargar } = useApi<any>(() => api.get('/api/t/soporte'), []);
  const [nuevo, setNuevo] = useState(false);
  const nav = useNavigate();
  return (
    <>
      <Cabecera titulo="Soporte" sub={`El asistente revisa tu cuenta al instante; si no lo resuelve, el equipo de ${MARCA.nombre} te responde aquí y por correo.`}>
        <button className="btn primario" onClick={() => setNuevo(true)}><Icon n="mas" className="" size={16} />Pedir ayuda</button>
      </Cabecera>
      <section className="support-guide sop-guia">
        <div className="sop-guia-orbe"><AiOrb state="breathing" size={64} /></div>
        <div><h2>Cuéntanos qué pasa y lo revisamos contigo.</h2><p>El asistente de soporte mira tu suscripción, WhatsApp, la IA, la facturación y los cobros con los datos reales de tu cuenta, y te dice qué hacer. Los cobros dudosos, la seguridad y lo urgente van directo a una persona.</p>
          {data?.asistente?.resueltas > 0 && <p className="sop-cifra"><Icon n="ok" className="" size={14} />Resolvió {data.asistente.resueltas} {data.asistente.resueltas === 1 ? 'consulta' : 'consultas'} de tu empresa sin esperar (90 días).</p>}</div>
        <div className="col" style={{ gap: 8 }}><button className="btn primario" onClick={() => setNuevo(true)}><Icon n="ia" className="" size={16} />Pedir ayuda</button><Link to="/ayuda" className="btn">Guías de ayuda <Icon n="flecha" size={16} className="" /></Link></div>
      </section>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando && !data ? <Cargando /> : (
        <Tarjeta sinCuerpo>
          {!data.tickets.length ? <div className="cuerpo"><Vacio titulo="Aún no tienes solicitudes">Cuando el asistente pase un caso al equipo, o escribas directo, verás aquí su estado y las respuestas.</Vacio></div> : (
            <div className="tabla-wrap"><table className="tabla tabla-movil">
              <thead><tr><th>Radicado</th><th>Asunto</th><th>Categoría</th><th>Estado</th><th>Última actividad</th></tr></thead>
              <tbody className="entra-escalonado">{data.tickets.map((t: any, i: number) => (
                <tr key={t.id} className="enlace-fila" style={escalon(i)} onClick={() => nav(`/soporte/${t.id}`)}>
                  <td data-etiqueta="Radicado"><Link to={`/soporte/${t.id}`} className="mono">{t.numero}</Link></td>
                  <td data-etiqueta="Asunto">{t.asunto}</td>
                  <td data-etiqueta="Categoría">{NOMBRE_CATEGORIA[t.categoria] ?? t.categoria}</td>
                  <td data-etiqueta="Estado"><Estado v={t.estado} texto={ESTADO_TICKET[t.estado]} /></td>
                  <td data-etiqueta="Última actividad">{hace(t.actualizado_en)}</td>
                </tr>))}
              </tbody></table></div>
          )}
        </Tarjeta>
      )}
      {nuevo && <NuevaSolicitud onCerrar={() => setNuevo(false)} onCreada={(id) => { setNuevo(false); nav(`/soporte/${id}`); }} />}
    </>
  );
}

/** Lo que el asistente revisa mientras trabaja (la lista real llega del servidor). */
const AREAS_REVISION: [string, string][] = [['suscripcion', 'Tu suscripción'], ['whatsapp', 'La conexión de WhatsApp'], ['ia', 'El agente de IA y su cuota'], ['mensajes', 'Los mensajes enviados'], ['facturacion', 'La facturación electrónica'], ['cobros', 'Los cobros'], ['correo', 'Tu correo']];
const ICONO_NIVEL: Record<string, string> = { ok: 'ok', aviso: 'alerta', error: 'x' };

type Paso = 'escribir' | 'revisando' | 'propuesta' | 'resuelto' | 'escalado';

/**
 * Pedir ayuda: primero el asistente de soporte revisa la cuenta con datos reales y las guías verificadas.
 * Si encuentra la causa, la explica con el atajo a la pantalla donde se arregla. Si no puede, o el caso lo
 * atiende una persona (cobros, seguridad, urgencias…), abre la solicitud al equipo con el diagnóstico.
 */
function NuevaSolicitud({ onCerrar, onCreada }: { onCerrar: () => void; onCreada: (id: string) => void }) {
  const [f, setF] = useState({ categoria: 'TECNICO', prioridad: 'NORMAL', asunto: '', descripcion: '' });
  const [paso, setPaso] = useState<Paso>('escribir');
  const [r, setR] = useState<any>(null);
  const [comentario, setComentario] = useState('');
  const [verTodo, setVerTodo] = useState(false);
  const [noSirvio, setNoSirvio] = useState(false);
  const { run, ocupado, error, limpiarError } = useAccion();
  const listo = f.asunto.trim().length >= 5 && f.descripcion.trim().length >= 20;
  const directo = async () => {
    const t = await run(() => api.post('/api/t/soporte', f), 'Solicitud enviada. Te avisaremos por correo.', { silencioso: true });
    if (t) onCreada(t.id);
  };
  const buscar = async () => {
    setPaso('revisando');
    // La revisión dura lo que tarda el servidor; se muestra al menos un instante para que se lea qué se revisa.
    const [res] = await Promise.all([run(() => api.post('/api/t/soporte/asistente', f), undefined, { silencioso: true }), new Promise((ok) => setTimeout(ok, 1600))]);
    if (!res) { setPaso('escribir'); return; }
    setR(res);
    setPaso(res.resultado === 'ESCALADO' ? 'escalado' : 'propuesta');
  };
  const resuelto = async () => { if (await run(() => api.post(`/api/t/soporte/asistente/${r.id}/resuelto`), undefined, { silencioso: true })) setPaso('resuelto'); };
  const escalar = async () => {
    const t = await run(() => api.post(`/api/t/soporte/asistente/${r.id}/escalar`, { comentario: comentario.trim() || null }), undefined, { silencioso: true });
    if (t) { setR({ ...r, escalamiento: { motivo: 'no_resuelto', explicacion: 'Le pasé tu caso al equipo.', ticket: t.ticket } }); setPaso('escalado'); }
  };
  const problemas = (r?.revisiones ?? []).filter((x: any) => x.relevante && x.nivel !== 'ok');
  const resto = (r?.revisiones ?? []).filter((x: any) => !(x.relevante && x.nivel !== 'ok'));

  const pie = paso === 'escribir' ? <>
    <button className="btn sutil" style={{ marginRight: 'auto' }} disabled={!listo || ocupado} onClick={directo} title="Sin revisión automática">Enviar directo al equipo</button>
    <button className="btn" onClick={onCerrar}>Cancelar</button>
    <button className="btn primario" disabled={!listo || ocupado} onClick={buscar}><Icon n="ia" className="" size={16} />Buscar solución</button>
  </> : paso === 'propuesta' ? <>
    <button className="btn" style={{ marginRight: 'auto' }} disabled={ocupado} onClick={() => setNoSirvio(true)}>No, sigue sin resolverse</button>
    <button className="btn primario" disabled={ocupado} onClick={resuelto}><Icon n="ok" className="" size={16} />Sí, se resolvió</button>
  </> : paso === 'revisando' ? undefined : <button className="btn primario" onClick={() => (paso === 'escalado' && r?.escalamiento?.ticket ? onCreada(r.escalamiento.ticket.id) : onCerrar())}>{paso === 'escalado' ? 'Ver mi solicitud' : 'Listo'}</button>;

  return (
    <Modal titulo={paso === 'escribir' ? '¿En qué te ayudamos?' : paso === 'revisando' ? 'Revisando tu cuenta' : paso === 'propuesta' ? 'Esto encontré' : paso === 'resuelto' ? 'Resuelto' : 'Tu caso está con el equipo'} className="modal-soporte" onCerrar={onCerrar} pie={pie}>
      {paso === 'escribir' && <>
        <div className="sop-intro"><AiOrb state="breathing" size={20} /><span>El asistente de soporte revisa tu cuenta al instante y te dice qué pasa. Si no puede resolverlo, lo pasa al equipo de {MARCA.nombre} con el diagnóstico.</span></div>
        <p className="aviso peq-txt" role="note"><Icon n="candado" className="" size={16} />{AVISO_DATOS}</p>
        <div className="grid g2">
          <Campo etiqueta="Categoría"><select className="input" value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })}>{CATEGORIAS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Campo>
          <Campo etiqueta="Prioridad"><select className="input" value={f.prioridad} onChange={(e) => setF({ ...f, prioridad: e.target.value })}>
            <option value="BAJA">Baja: una consulta</option><option value="NORMAL">Normal</option><option value="ALTA">Alta: afecta la operación</option><option value="URGENTE">Urgente: el negocio está detenido</option>
          </select></Campo>
        </div>
        <Campo etiqueta="Asunto"><input className="input" maxLength={120} value={f.asunto} onChange={(e) => setF({ ...f, asunto: e.target.value })} placeholder="Ej.: No llegan los mensajes de WhatsApp" /></Campo>
        <Campo etiqueta="Qué pasó" ayuda="Qué intentabas hacer, qué esperabas y qué ocurrió. Mínimo 20 caracteres.">
          <textarea className="input" rows={5} maxLength={4000} value={f.descripcion} onChange={(e) => { setF({ ...f, descripcion: e.target.value }); limpiarError(); }} />
        </Campo>
        {f.prioridad === 'URGENTE' && <p className="tenue peq-txt">Lo urgente lo atiende una persona directamente: el asistente solo adjunta el diagnóstico.</p>}
        {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
      </>}

      {paso === 'revisando' && (
        <div className="sop-revisando" aria-live="polite">
          <AiOrb state="searching" size={64} large label="El asistente está revisando tu cuenta" />
          <ul className="sop-areas">{AREAS_REVISION.map(([k, t], i) => <li key={k} style={escalon(i, 10)}><span className="sop-punto" aria-hidden="true" />{t}</li>)}</ul>
        </div>
      )}

      {paso === 'propuesta' && r && <>
        <div className="sop-respuesta">
          <div className="sop-quien"><AiOrb state="breathing" size={20} /><b>Asistente de soporte</b>{r.confianza && <span className="tenue peq-txt">· {r.confianza === 'alta' ? 'encontré la causa en tu cuenta' : 'según tu cuenta y las guías'}</span>}</div>
          <Markdown texto={r.respuesta} />
          {r.pasos?.length > 0 && <ol className="sop-pasos">{r.pasos.map((p: string, i: number) => <li key={i} style={escalon(i)}>{p}</li>)}</ol>}
        </div>
        {problemas.length > 0 && (
          <ul className="sop-revisiones entra-escalonado">
            {problemas.map((x: any, i: number) => <Revision key={x.codigo} x={x} i={i} onIr={onCerrar} />)}
          </ul>
        )}
        {resto.length > 0 && <>
          <button type="button" className="btn peq sutil" style={{ alignSelf: 'flex-start' }} aria-expanded={verTodo} onClick={() => setVerTodo(!verTodo)}>{verTodo ? 'Ocultar' : `Ver todo lo que revisé (${resto.length})`}</button>
          <div className={`plegable ${verTodo ? 'abierto' : ''}`} inert={!verTodo}><div><ul className="sop-revisiones compacta">{resto.map((x: any, i: number) => <Revision key={x.codigo} x={x} i={i} onIr={onCerrar} />)}</ul></div></div>
        </>}
        {noSirvio && (
          <div className="sop-no-sirvio">
            <Campo etiqueta="¿Qué sigue pasando?" ayuda="opcional, ayuda al equipo"><textarea className="input" rows={3} maxLength={1000} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="Ej.: ya vinculé el número y los clientes siguen sin recibir respuesta" autoFocus /></Campo>
            <button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={escalar}>{ocupado ? 'Enviando…' : 'Pasar mi caso al equipo'}</button>
          </div>
        )}
        {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
      </>}

      {paso === 'resuelto' && (
        <div className="cobro-exito" role="status">
          <MarcaExito />
          <h3>¡Qué bien que se resolvió!</h3>
          <p className="sec" style={{ margin: 0 }}>Si vuelve a pasar, aquí estamos. No se abrió ninguna solicitud.</p>
        </div>
      )}

      {paso === 'escalado' && r?.escalamiento && (
        <div className="cobro-exito" role="status">
          <MarcaExito tono="neutro" />
          <h3>Radicado {r.escalamiento.ticket?.numero}</h3>
          <p className="sec" style={{ margin: 0, maxWidth: '46ch' }}>{r.escalamiento.explicacion} Una persona del equipo de {MARCA.nombre} te responde aquí y por correo.</p>
          {problemas.length > 0 && <p className="tenue peq-txt" style={{ margin: 0 }}>Adjunté lo que revisé en tu cuenta para que no tengas que repetirlo.</p>}
        </div>
      )}
    </Modal>
  );
}

function Revision({ x, i, onIr }: { x: any; i: number; onIr: () => void }) {
  return (
    <li className={`sop-revision ${x.nivel}`} style={escalon(i)}>
      <span className="sop-icono" aria-hidden="true"><Icon n={ICONO_NIVEL[x.nivel] ?? 'info'} className="" size={14} /></span>
      <span className="col" style={{ gap: 2, minWidth: 0 }}><b>{x.titulo}</b><span className="peq-txt sec">{x.detalle}</span></span>
      {x.accion && <Link className="btn peq" to={x.accion.ruta} onClick={onIr}>{x.accion.etiqueta}<Icon n="derecha" className="" size={14} /></Link>}
    </li>
  );
}

export function SoporteDetalle() {
  const { id } = useParams();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get(`/api/t/soporte/${id}`), [id]);
  const [texto, setTexto] = useState('');
  const { run, ocupado, error: errEnvio } = useAccion();
  if (error) return <><Cabecera titulo="Soporte" /><ErrorCarga error={error} reintentar={recargar} /></>;
  if (cargando && !data) return <Cargando filas={5} />;
  const t = data.ticket;
  const cerrado = t.estado === 'CERRADO';
  const resuelta = t.estado === 'RESUELTO';
  const marcarResuelta = async () => { if (await run(() => api.post(`/api/t/soporte/${id}/resolver`), 'Marcaste la solicitud como resuelta.')) recargar(); };
  const responder = async () => {
    const r = await run(() => api.post(`/api/t/soporte/${id}/mensajes`, { cuerpo: texto }), 'Respuesta enviada.', { silencioso: true });
    if (r) { setTexto(''); recargar(); }
  };
  return (
    <>
      <Cabecera titulo={t.asunto} sub={<span className="fila" style={{ gap: 8, flexWrap: 'wrap' }}><span className="mono">{t.numero}</span><span>·</span><span>{NOMBRE_CATEGORIA[t.categoria]}</span><Estado v={t.estado} texto={ESTADO_TICKET[t.estado]} /></span>}>
        <Link className="btn" to="/soporte"><Icon n="atras" className="" size={16} />Todas</Link>
        {!cerrado && !resuelta && <button className="btn" disabled={ocupado} onClick={marcarResuelta}><Icon n="ok" className="" size={16} />Ya se resolvió</button>}
      </Cabecera>
      <div className="col" style={{ gap: 16 }}>
      <Tarjeta titulo="Conversación">
        <ol className="hilo-soporte">
          {data.mensajes.map((m: any) => (
            <li key={m.id} className={m.autor_tipo === 'OPERADOR' ? 'de-soporte' : m.autor_tipo === 'SISTEMA' ? 'de-sistema' : 'de-empresa'}>
              <div className="msg-meta"><b className="fila" style={{ gap: 6 }}>{m.autor_tipo === 'SISTEMA' && <Icon n="ia" className="" size={14} />}{m.autor_tipo === 'OPERADOR' ? `Soporte de ${MARCA.nombre}` : m.autor_nombre}</b><span className="tenue peq-txt">{fechaHora(m.creado_en)}</span></div>
              <p className="msg-texto">{m.cuerpo}</p>
            </li>
          ))}
        </ol>
      </Tarjeta>
      {cerrado ? <p className="tenue">Esta solicitud está cerrada. Si necesitas algo más, abre una nueva.</p> : (
        <Tarjeta titulo="Responder">
          <div className="col" style={{ gap: 12 }}>
            <p className="tenue peq-txt">{AVISO_DATOS}</p>
            <textarea className="input" rows={4} maxLength={4000} value={texto} onChange={(e) => setTexto(e.target.value)} aria-label="Tu respuesta" />
            {errEnvio && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{errEnvio.message}</p>}
            <div className="fila"><button className="btn primario" disabled={ocupado || texto.trim().length < 2} onClick={responder}>{ocupado ? 'Enviando…' : 'Enviar respuesta'}</button></div>
          </div>
        </Tarjeta>
      )}
      </div>
    </>
  );
}
