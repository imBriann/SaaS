import { useState } from 'react';
import { api, fechaCompleta, fechaHora, guardar, hace, urlPrincipal } from '../api';
import { Campo, Cargando, ErrorCarga, useAccion, useApi } from './ui';
import { Icon } from './icons';
import { MARCA } from '../brand';

const AVISO_DATOS = 'No incluyas contraseñas, claves, códigos de verificación, números de tarjeta ni datos de tus clientes: el equipo de soporte nunca te los pedirá.';
const ESTADO: Record<string, string> = { ABIERTO: 'Abierta', EN_PROCESO: 'En revisión', ESPERANDO_CLIENTE: 'Esperando tu respuesta', RESUELTO: 'Resuelta', CERRADO: 'Cerrada' };

/**
 * Empresa con la suscripción cancelada: el panel se cierra, pero los datos se conservan. Desde aquí se pide
 * la reactivación (la revisa el equipo de la plataforma, que decidió la cancelación) y se habla con soporte.
 */
export function Cancelada() {
  const estado = useApi<any>(() => api.get('/api/t/cancelada'), []);
  const tickets = useApi<any>(() => api.get('/api/t/soporte'), [], { cada: 15000 });
  const [abierto, setAbierto] = useState<string | null>(null);
  const [escribir, setEscribir] = useState(false);
  const salir = async () => { await api.post('/api/auth/logout').catch(() => {}); guardar('empresa', null); window.location.href = '/entrar'; };
  const recargar = () => { estado.recargar(); tickets.recargar(); };

  if (estado.error) return <div className="cancelada"><ErrorCarga error={estado.error} reintentar={estado.recargar} /></div>;
  if (!estado.data) return <div className="cancelada"><Cargando filas={4} /></div>;
  const e = estado.data;
  return (
    <div className="cancelada">
      <section className="tarjeta cancelada-cab">
        <span className="cancelada-ico" aria-hidden="true"><Icon n="candado" className="" size={22} /></span>
        <h1>La suscripción de {e.empresa} está cancelada</h1>
        <p>El panel y el asistente de WhatsApp están detenidos{e.desde ? ` desde el ${fechaCompleta(e.desde)}` : ''}. <b>Tus datos no se borraron</b>: clientes, ventas, citas y documentos siguen guardados.</p>
        <p className="tenue">Para volver a usarla, pide la reactivación. El equipo de {MARCA.nombre} revisa el motivo de la cancelación y te responde aquí y por correo.</p>
        <Reactivar e={e} onHecho={(id) => { recargar(); setAbierto(id); }} />
        <div className="cancelada-acc">
          <button type="button" className="btn" onClick={() => setEscribir((v) => !v)}><Icon n="soporte" className="" size={15} />Hablar con soporte</button>
          <a className="btn sutil" href={urlPrincipal('/empresas')}><Icon n="plataforma" className="" size={15} />Ir a otra empresa</a>
          <button type="button" className="btn sutil" onClick={salir}><Icon n="salir" className="" size={15} />Cerrar sesión</button>
        </div>
      </section>

      {escribir && <NuevoMensaje onCreado={(id) => { setEscribir(false); recargar(); setAbierto(id); }} onCancelar={() => setEscribir(false)} />}

      <section className="tarjeta cancelada-tickets" aria-labelledby="cancelada-tickets-t">
        <h2 id="cancelada-tickets-t">Tus solicitudes a soporte</h2>
        {tickets.error ? <ErrorCarga error={tickets.error} reintentar={tickets.recargar} /> : !tickets.data ? <Cargando filas={2} /> : !tickets.data.tickets.length
          ? <p className="tenue">Todavía no hay solicitudes. Pide la reactivación o escríbenos.</p>
          : <ul>{tickets.data.tickets.map((t: any) => (
              <li key={t.id}>
                <button type="button" className={`cancelada-ticket ${abierto === t.id ? 'on' : ''}`} aria-expanded={abierto === t.id} onClick={() => setAbierto(abierto === t.id ? null : t.id)}>
                  <span className="mono">{t.numero}</span><b>{t.asunto}</b><span className="cancelada-estado">{ESTADO[t.estado] ?? t.estado}</span><small>{hace(t.actualizado_en)}</small>
                </button>
                {abierto === t.id && <Hilo id={t.id} />}
              </li>
            ))}</ul>}
      </section>
    </div>
  );
}

function Reactivar({ e, onHecho }: { e: any; onHecho: (id: string) => void }) {
  const [mensaje, setMensaje] = useState('');
  const { run, ocupado } = useAccion();
  if (e.solicitud) return (
    <p className="cancelada-solicitud" role="status"><Icon n="reloj" className="" size={15} /><span>Tu solicitud de reactivación <b className="mono">{e.solicitud.numero}</b> está {ESTADO[e.solicitud.estado]?.toLowerCase() ?? 'en revisión'}. Te avisamos por correo apenas el equipo responda.</span></p>
  );
  if (!e.puede_solicitar) return <p className="cancelada-solicitud"><Icon n="info" className="" size={15} /><span>Quien administra la suscripción de la empresa puede pedir la reactivación. Mientras tanto, puedes escribir a soporte.</span></p>;
  return (
    <div className="cancelada-reactivar">
      <Campo etiqueta="Mensaje para el equipo (opcional)" ayuda="Por ejemplo, si ya resolviste lo que motivó la cancelación.">
        <textarea className="input" rows={3} maxLength={2000} value={mensaje} onChange={(ev) => setMensaje(ev.target.value)} />
      </Campo>
      <button type="button" className="btn primario" disabled={ocupado} onClick={async () => { const r = await run(() => api.post('/api/t/cancelada/solicitud', { mensaje }), 'Enviamos tu solicitud de reactivación.'); if (r) onHecho(r.id); }}>
        <Icon n="refrescar" className="" size={15} />{ocupado ? 'Enviando…' : 'Solicitar reactivación'}
      </button>
    </div>
  );
}

function NuevoMensaje({ onCreado, onCancelar }: { onCreado: (id: string) => void; onCancelar: () => void }) {
  const [f, setF] = useState({ asunto: '', descripcion: '' });
  const { run, ocupado } = useAccion();
  const listo = f.asunto.trim().length >= 5 && f.descripcion.trim().length >= 20;
  return (
    <section className="tarjeta cancelada-nuevo" aria-label="Escribir a soporte">
      <h2>Escribir a soporte</h2>
      <p className="tenue peq-txt">{AVISO_DATOS}</p>
      <Campo etiqueta="Asunto"><input className="input" maxLength={120} value={f.asunto} onChange={(ev) => setF({ ...f, asunto: ev.target.value })} /></Campo>
      <Campo etiqueta="¿Qué necesitas?" ayuda="Al menos 20 caracteres."><textarea className="input" rows={4} maxLength={4000} value={f.descripcion} onChange={(ev) => setF({ ...f, descripcion: ev.target.value })} /></Campo>
      <div className="cancelada-acc">
        <button type="button" className="btn" onClick={onCancelar}>Cancelar</button>
        <button type="button" className="btn primario" disabled={!listo || ocupado} onClick={async () => { const r = await run(() => api.post('/api/t/soporte', { categoria: 'CUENTA', prioridad: 'NORMAL', ...f }), 'Enviamos tu mensaje a soporte.'); if (r) onCreado(r.id); }}>{ocupado ? 'Enviando…' : 'Enviar'}</button>
      </div>
    </section>
  );
}

function Hilo({ id }: { id: string }) {
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/soporte/${id}`), [id], { cada: 5000 });
  const [texto, setTexto] = useState('');
  const { run, ocupado } = useAccion();
  if (error) return <ErrorCarga error={error} reintentar={recargar} />;
  if (!data) return <Cargando filas={2} />;
  const cerrado = data.ticket.estado === 'CERRADO';
  return (
    <div className="cancelada-hilo">
      <ol className="hilo-soporte">
        {data.mensajes.map((m: any) => (
          <li key={m.id} className={m.autor_tipo === 'OPERADOR' ? 'de-soporte' : m.autor_tipo === 'SISTEMA' ? 'de-sistema' : 'de-empresa'}>
            <div className="msg-meta"><b>{m.autor_tipo === 'OPERADOR' ? `Soporte de ${MARCA.nombre}` : m.autor_nombre}</b><span className="tenue peq-txt">{fechaHora(m.creado_en)}</span></div>
            <p className="msg-texto">{m.cuerpo}</p>
          </li>
        ))}
      </ol>
      {!cerrado && (
        <div className="cancelada-responder">
          <textarea className="input" rows={2} maxLength={4000} value={texto} onChange={(ev) => setTexto(ev.target.value)} aria-label="Tu respuesta" placeholder="Escribe una respuesta…" />
          <button type="button" className="btn primario" disabled={ocupado || texto.trim().length < 2} onClick={async () => { const r = await run(() => api.post(`/api/t/soporte/${id}/mensajes`, { cuerpo: texto }), 'Respuesta enviada.'); if (r) { setTexto(''); recargar(); } }}>Responder</button>
        </div>
      )}
    </div>
  );
}
