import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Icon } from './icons';

const OPCIONES = [
  { id: 'asistente', icono: 'ia', nombre: 'Asistente de tu empresa', resumen: 'Consulta los datos de tu negocio desde el panel, con tus permisos.' },
  { id: 'equipo', icono: 'persona', nombre: 'Equipo de Omnegia', resumen: 'Abre una solicitud y sigue tu caso hasta que se resuelva.' },
] as const;
type Opcion = typeof OPCIONES[number]['id'];

const retraso = (s: number) => ({ '--d': `${s}s` } as CSSProperties);

function EscenaAsistente() {
  return <>
    <div className="se-bubble se-user se-in" style={retraso(.15)}>¿Qué citas tenemos hoy?</div>
    <div className="se-typing" aria-hidden="true"><i /><i /><i /></div>
    <div className="se-tool se-in" style={retraso(1.7)}>
      <span className="se-tool-name"><Icon n="agenda" size={18} className="" />Consultar la agenda</span>
      <span className="se-tool-ok"><Icon n="ok" size={15} className="" />Permiso verificado</span>
    </div>
    <div className="se-bubble se-bot se-in" style={retraso(2.2)}>
      <strong>Hoy tienes 3 citas</strong>
      <ul>
        <li className="se-in" style={retraso(2.5)}><b>09:00</b>Asesoría · Ana</li>
        <li className="se-in" style={retraso(2.7)}><b>11:00</b>Seguimiento · Luis</li>
        <li className="se-in" style={retraso(2.9)}><b>15:00</b>Asesoría · Ana</li>
      </ul>
    </div>
    <p className="se-foot se-in" style={retraso(3.3)}><Icon n="auditoria" size={18} className="" />Cada herramienta deja un recibo que puedes revisar en la auditoría de tu empresa.</p>
  </>;
}

function EscenaEquipo() {
  return <>
    <div className="se-ticket-top se-in" style={retraso(.1)}>
      <small>Solicitud de ejemplo</small>
      <strong>No logro conectar WhatsApp</strong>
    </div>
    <ol className="se-steps">
      <li className="is-done" style={retraso(.5)}><span className="se-dot"><Icon n="ok" size={15} className="" /></span><div><strong>Abierta</strong><p>La solicitud quedó registrada con su radicado.</p></div></li>
      <li className="is-done" style={retraso(1.3)}><span className="se-dot"><Icon n="ok" size={15} className="" /></span><div><strong>En proceso</strong><p>El equipo está atendiendo el caso.</p></div></li>
      <li className="is-done" style={retraso(2.1)}><span className="se-dot"><Icon n="ok" size={15} className="" /></span><div><strong>Respuesta del equipo</strong>
        <div className="se-team se-in" style={retraso(2.5)}><span className="se-avatar"><Icon n="persona" size={20} className="" /></span><p>Confirma que el número esté habilitado y vuelve a usar «Probar conexión». Si sigue igual, cuéntanos qué mensaje aparece.</p></div>
      </div></li>
      <li className="is-future"><span className="se-dot" /><div><strong>Resuelta o cerrada</strong><p>Consulta la respuesta y el estado del caso.</p></div></li>
    </ol>
    <p className="se-foot se-in" style={retraso(3.3)}><Icon n="correo" size={18} className="" />Las respuestas quedan en tu panel y se notifican por correo.</p>
  </>;
}

/** Los dos caminos de ayuda son pestañas reales: elegir una abre un ejemplo animado. */
export function SupportExplorer() {
  const [id, setId] = useState<Opcion>('asistente');
  const mover = (e: KeyboardEvent, actual: number) => {
    const indice = e.key === 'Home' ? 0 : e.key === 'End' ? OPCIONES.length - 1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (actual + 1) % OPCIONES.length : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (actual - 1 + OPCIONES.length) % OPCIONES.length : null;
    if (indice === null) return;
    e.preventDefault();
    const siguiente = OPCIONES[indice];
    setId(siguiente.id);
    document.getElementById(`se-tab-${siguiente.id}`)?.focus();
  };
  return <div className="support-explorer">
    <div className="se-tabs" role="tablist" aria-label="Opciones de acompañamiento" aria-orientation="vertical">
      {OPCIONES.map((o, i) => {
        const activa = id === o.id;
        return <button type="button" role="tab" key={o.id} id={`se-tab-${o.id}`} aria-selected={activa} aria-controls="se-panel" tabIndex={activa ? 0 : -1} className="se-tab" onClick={() => setId(o.id)} onKeyDown={e => mover(e, i)}>
          <span className="se-tab-icon"><Icon n={o.icono} size={24} className="" /></span>
          <strong>{o.nombre}</strong>
          <small>{o.resumen}</small>
          <span className="se-tab-cta">{activa ? <><i aria-hidden="true" />Viendo el ejemplo</> : <>Ver ejemplo <Icon n="flecha" size={16} className="" /></>}</span>
        </button>;
      })}
    </div>
    <div className="se-stage" role="tabpanel" id="se-panel" aria-labelledby={`se-tab-${id}`}>
      <div className="se-stage-head">
        <span><Icon n={id === 'asistente' ? 'ia' : 'soporte'} size={22} className="" />{id === 'asistente' ? 'Asistente de tu empresa' : 'Soporte de Omnegia'}</span>
        <span className="se-live"><i aria-hidden="true" />Ejemplo ilustrativo</span>
      </div>
      <div className="se-scene" key={id}>{id === 'asistente' ? <EscenaAsistente /> : <EscenaEquipo />}</div>
    </div>
  </div>;
}
