import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fechaHora, hace } from '../../api';
import { Cabecera } from '../../components/Layout';
import { Campo, Cargando, ErrorCarga, Estado, Modal, Tarjeta, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { MARCA } from '../../brand';

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
      <Cabecera titulo="Soporte" sub={`Escribe al equipo de ${MARCA.nombre}. Te respondemos aquí y por correo.`}>
        <button className="btn primario" onClick={() => setNuevo(true)}><Icon n="mas" className="" size={16} />Nueva solicitud</button>
      </Cabecera>
      <section className="support-guide"><div><h2>Una persona, con el contexto que compartas.</h2><p>Describe qué intentabas hacer y qué ocurrió. Recibirás un radicado; el estado y las respuestas aparecen aquí. Tu conversación con la IA no se adjunta automáticamente.</p></div><Link to="/ayuda" className="btn">Ver guías de ayuda <Icon n="flecha" size={16} className="" /></Link></section>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando && !data ? <Cargando /> : (
        <Tarjeta sinCuerpo>
          {!data.tickets.length ? <div className="cuerpo"><Vacio titulo="Aún no tienes solicitudes">Cuando abras una, verás aquí su estado y las respuestas del equipo.</Vacio></div> : (
            <div className="tabla-wrap"><table className="tabla tabla-movil">
              <thead><tr><th>Radicado</th><th>Asunto</th><th>Categoría</th><th>Estado</th><th>Última actividad</th></tr></thead>
              <tbody>{data.tickets.map((t: any) => (
                <tr key={t.id} className="enlace-fila" onClick={() => nav(`/soporte/${t.id}`)}>
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

function NuevaSolicitud({ onCerrar, onCreada }: { onCerrar: () => void; onCreada: (id: string) => void }) {
  const [f, setF] = useState({ categoria: 'TECNICO', prioridad: 'NORMAL', asunto: '', descripcion: '' });
  const { run, ocupado, error } = useAccion();
  const listo = f.asunto.trim().length >= 5 && f.descripcion.trim().length >= 20;
  const enviar = async () => {
    const r = await run(() => api.post('/api/t/soporte', f), 'Solicitud enviada. Te avisaremos por correo.', { silencioso: true });
    if (r) onCreada(r.id);
  };
  return (
    <Modal titulo="Nueva solicitud de soporte" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={!listo || ocupado} onClick={enviar}>{ocupado ? 'Enviando…' : 'Enviar solicitud'}</button></>}>
      <p className="aviso peq-txt" role="note"><Icon n="candado" className="" size={16} />{AVISO_DATOS}</p>
      <div className="grid g2">
        <Campo etiqueta="Categoría"><select className="input" value={f.categoria} onChange={(e) => setF({ ...f, categoria: e.target.value })}>{CATEGORIAS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></Campo>
        <Campo etiqueta="Prioridad"><select className="input" value={f.prioridad} onChange={(e) => setF({ ...f, prioridad: e.target.value })}>
          <option value="BAJA">Baja: una consulta</option><option value="NORMAL">Normal</option><option value="ALTA">Alta: afecta la operación</option><option value="URGENTE">Urgente: el negocio está detenido</option>
        </select></Campo>
      </div>
      <Campo etiqueta="Asunto"><input className="input" maxLength={120} value={f.asunto} onChange={(e) => setF({ ...f, asunto: e.target.value })} placeholder="Ej.: No llegan los mensajes de WhatsApp" /></Campo>
      <Campo etiqueta="Qué pasó" ayuda="Qué intentabas hacer, qué esperabas y qué ocurrió. Mínimo 20 caracteres.">
        <textarea className="input" rows={6} maxLength={4000} value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} />
      </Campo>
      {error && <p role="alert" className="bloqueado"><Icon n="alerta" className="" size={16} />{error.message}</p>}
    </Modal>
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
  const responder = async () => {
    const r = await run(() => api.post(`/api/t/soporte/${id}/mensajes`, { cuerpo: texto }), 'Respuesta enviada.', { silencioso: true });
    if (r) { setTexto(''); recargar(); }
  };
  return (
    <>
      <Cabecera titulo={t.asunto} sub={<span className="fila" style={{ gap: 8, flexWrap: 'wrap' }}><span className="mono">{t.numero}</span><span>·</span><span>{NOMBRE_CATEGORIA[t.categoria]}</span><Estado v={t.estado} texto={ESTADO_TICKET[t.estado]} /></span>}>
        <Link className="btn" to="/soporte"><Icon n="atras" className="" size={16} />Todas</Link>
      </Cabecera>
      <div className="col" style={{ gap: 16 }}>
      <Tarjeta titulo="Conversación">
        <ol className="hilo-soporte">
          {data.mensajes.map((m: any) => (
            <li key={m.id} className={m.autor_tipo === 'OPERADOR' ? 'de-soporte' : 'de-empresa'}>
              <div className="msg-meta"><b>{m.autor_tipo === 'OPERADOR' ? `Soporte de ${MARCA.nombre}` : m.autor_nombre}</b><span className="tenue peq-txt">{fechaHora(m.creado_en)}</span></div>
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
