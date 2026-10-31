import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Cabecera, Escritura, useSesion } from '../../components/Layout';
import { Cargando, ErrorCarga, Estado, Tarjeta, useAccion, useApi } from '../../components/ui';
import { Icon } from '../../components/icons';
import { ComoTrabaja } from '../../components/ComoTrabaja';
import { CambiarNumero, ConectarEnLinea } from '../../components/ConectarWhatsApp';
import { formatoPropio } from './NumeroPropio';

/** ¿La empresa tiene un número de WhatsApp conectado (real o de demostración)? */
export const useNumeroConectado = () => {
  const { s } = useSesion();
  return !!s.tenant.whatsapp_phone_number_id && ['CONECTADO', 'SIMULADO'].includes(s.tenant.whatsapp_estado);
};

const CALIDAD: Record<string, string> = { GREEN: 'Alta', YELLOW: 'Media', RED: 'Baja', UNKNOWN: 'Sin dato' };

/**
 * Estado de bienvenida de Conversaciones cuando aún no hay número ni conversaciones: en lugar de una bandeja
 * vacía, la conexión («Usar mi propio número») ocurre en esta misma pantalla. El simulador sigue disponible,
 * marcado como demostración.
 */
export function Bienvenida() {
  const { s, puede, recargar } = useSesion();
  const [conectado, setConectado] = useState(false);
  return (
    <div className="cv-bienvenida contenido">
      <header className="col" style={{ gap: 6, maxWidth: 640 }}>
        <h1 className="titulo" style={{ margin: 0 }}>Conecta tu WhatsApp para que tu asistente empiece a atender</h1>
        <p className="sec" style={{ margin: 0 }}>Escribe tu número, recibe un código por SMS y listo. Cuando un cliente te escriba, aquí verás la conversación y a tu asistente respondiendo.</p>
      </header>
      {puede('tenant:configure') ? (
        <div className="col" style={{ maxWidth: 720, gap: 12 }}>
          {/* Al conectar se queda aquí, en «Listo» (con el mensaje de prueba); la bandeja se abre cuando la persona quiera. */}
          <ConectarEnLinea onConectado={() => setConectado(true)} />
          {conectado && <button className="btn primario grande" style={{ alignSelf: 'flex-start' }} onClick={recargar}>Ver mis conversaciones</button>}
        </div>
      ) : (
        <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>Quien administra la empresa debe conectar el número de WhatsApp. Pídeselo y vuelve aquí.</span></div>
      )}
      {s.simuladores && puede('conversation:read') && (
        <Tarjeta nivel={3} titulo={<span className="fila" style={{ gap: 8 }}>Probar sin número <span className="estado warn">Demostración</span></span>}>
          <p className="sec peq-txt" style={{ marginTop: 0 }}>Mientras conectas el número real, puedes ver cómo responde tu asistente con el simulador. Los mensajes no salen a WhatsApp.</p>
          <Link className="btn" to="/simulador"><Icon n="simulador" className="" size={16} />Abrir el simulador</Link>
        </Tarjeta>
      )}
    </div>
  );
}

/** Conversaciones › Configuración: número, cómo trabaja el asistente, horario, urgencias y reglas de escalamiento. */
export function ConfigConversaciones({ onVolver }: { onVolver: () => void }) {
  const { s, puede, recargar: recargarSesion } = useSesion();
  const conectado = useNumeroConectado();
  const cfg = useApi<any>(() => (puede('tenant:configure') ? api.get('/api/t/configuracion') : Promise.resolve(null)), []);
  const [diag, setDiag] = useState<any>(null);
  const [cambiar, setCambiar] = useState(false);
  const { run, ocupado } = useAccion();
  const t = cfg.data?.tenant;
  const probar = async () => { const r = await run(() => api.post('/api/t/configuracion/whatsapp/verificar')); if (r) { setDiag(r); cfg.recargar(); recargarSesion(); } };
  const diagOk = diag && ['CONECTADO', 'SIMULADO'].includes(diag.estado);
  const numero = s.tenant.whatsapp_numero_visible ? formatoPropio(s.tenant.whatsapp_numero_visible) : null;
  return (
    <div className="cv-config">
      <Cabecera titulo="Configuración de Conversaciones" sub="Cómo atiende tu asistente por WhatsApp y cuándo te llama a ti.">
        <button className="btn" onClick={onVolver}><Icon n="atras" className="" size={16} />Volver a las conversaciones</button>
      </Cabecera>
      <div className="contenido col" style={{ gap: 16 }}>
        {cfg.error && <ErrorCarga error={cfg.error} reintentar={cfg.recargar} />}
        <Tarjeta titulo="Número de WhatsApp" acciones={<Estado v={conectado ? 'CONECTADO' : 'PENDIENTE'} texto={conectado ? 'Conectado' : 'Sin conectar'} />}>
          {!cfg.data && puede('tenant:configure') && !cfg.error ? <Cargando filas={2} /> : (
            <div className="col" style={{ gap: 12 }}>
              {conectado
                ? <span>Tus clientes te escriben al <b>{numero ?? 'número conectado'}</b>{t?.whatsapp_diagnostico?.nombre ? <> · nombre visible: <b>{t.whatsapp_diagnostico.nombre}</b></> : null}.</span>
                : <span className="sec">Todavía no hay un número conectado. Conéctalo desde Conversaciones para que tu asistente empiece a responder.</span>}
              {conectado && t?.whatsapp_diagnostico?.calidad && <span className="tenue peq-txt">Calidad del número según WhatsApp: <b>{CALIDAD[t.whatsapp_diagnostico.calidad] ?? t.whatsapp_diagnostico.calidad}</b></span>}
              <div className="fila envolver" style={{ gap: 8 }}>
                {s.tenant.whatsapp_phone_number_id && <Escritura permiso="tenant:configure"><button className="btn" disabled={ocupado} onClick={probar}>{ocupado ? 'Probando…' : 'Probar conexión'}</button></Escritura>}
                {conectado && <Escritura permiso="tenant:configure"><button className="btn" onClick={() => setCambiar(true)}>Cambiar de número</button></Escritura>}
                {!conectado && <button className="btn primario" onClick={onVolver}>Conectar WhatsApp</button>}
              </div>
              {diag && <div className={diagOk ? 'aviso exito' : 'aviso'} role="status"><Icon n={diagOk ? 'ok' : 'alerta'} className="" size={16} /><span>{diag.mensaje}</span></div>}
            </div>
          )}
        </Tarjeta>
        <Tarjeta nivel={3} titulo="Horario de atención">
          <p className="sec peq-txt" style={{ marginTop: 0 }}>Los horarios de tu equipo definen cuándo se pueden agendar citas y cuándo atienden personas. Fuera de ellos, tu asistente sigue respondiendo según las reglas de abajo.</p>
          <Link className="btn" to="/configuracion?tab=equipo">Ver y editar horarios</Link>
        </Tarjeta>
        {puede('tenant:configure') ? <ComoTrabaja /> : <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>Solo quien administra la empresa puede cambiar cómo trabaja el asistente.</span></div>}
      </div>
      {cambiar && <CambiarNumero actual={numero} onCerrar={() => setCambiar(false)} onHecho={() => { cfg.recargar(); recargarSesion(); }} />}
    </div>
  );
}
