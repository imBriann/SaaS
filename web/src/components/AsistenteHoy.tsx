import { Link } from 'react-router-dom';
import { api, hora } from '../api';
import { useSesion } from './Layout';
import { useAccion, useApi } from './ui';
import { Icon } from './icons';

/**
 * Inicio · lo que hizo tu asistente hoy. Lo único que pide acción va arriba y resaltado (conversaciones que
 * esperan a una persona, aprobaciones, avisos que no salieron y pendientes anotados); lo demás no pide nada.
 */
export function AsistenteHoy() {
  const { puede } = useSesion();
  const { data, recargar } = useApi<any>(() => api.get('/api/t/ia/hoy'), [], { cada: 30000 });
  const { data: aprob, recargar: recargarAprob } = useApi<any[]>(() => (puede('order:create') ? api.get('/api/t/ia/aprobaciones') : Promise.resolve([])), [], { cada: 30000 });
  const { run, ocupado } = useAccion();
  if (!data) return null;
  const decidir = async (id: string, aprobar: boolean) => {
    const r = await run(() => api.post(`/api/t/ia/aprobaciones/${id}`, { aprobar }), aprobar ? 'Aprobada: el cliente ya recibió la confirmación' : 'Rechazada: le avisamos al cliente');
    if (r) { recargar(); recargarAprob(); }
  };
  const acciones = [
    data.esperan_persona > 0 && { to: '/conversaciones', t: `${data.esperan_persona} ${data.esperan_persona === 1 ? 'conversación espera' : 'conversaciones esperan'} a una persona`, i: 'persona' },
    data.avisos_no_enviados > 0 && { to: '/agenda', t: `${data.avisos_no_enviados} ${data.avisos_no_enviados === 1 ? 'aviso no salió' : 'avisos no salieron'} (fuera de la ventana de WhatsApp)`, i: 'alerta' },
    data.pendientes_anotados > 0 && { to: '/conversaciones', t: `${data.pendientes_anotados} ${data.pendientes_anotados === 1 ? 'pendiente anotado' : 'pendientes anotados'} por tu asistente`, i: 'nota' },
  ].filter(Boolean) as { to: string; t: string; i: string }[];
  return (
    <section className="tarjeta asistente-hoy" aria-label="Lo que hizo tu asistente hoy">
      <div className="cuerpo col" style={{ gap: 12 }}>
        {(aprob?.length ?? 0) > 0 && (
          <div className="aviso" role="status"><Icon n="alerta" className="" size={16} />
            <div className="col" style={{ gap: 8, flex: 1, minWidth: 0 }}>
              <b>{aprob!.length === 1 ? 'Una venta espera tu aprobación' : `${aprob!.length} ventas esperan tu aprobación`}</b>
              {aprob!.map((p) => (
                <div key={p.id} className="fila entre envolver" style={{ gap: 8 }}>
                  <span className="peq-txt" style={{ minWidth: 0 }}>{p.cliente}: {p.resumen} <span className="tenue">· vence {hora(p.expira_en)}</span></span>
                  <span className="fila" style={{ gap: 6 }}><button className="btn peq primario" disabled={ocupado} onClick={() => decidir(p.id, true)}>Aprobar</button><button className="btn peq" disabled={ocupado} onClick={() => decidir(p.id, false)}>Rechazar</button></span>
                </div>
              ))}
            </div>
          </div>
        )}
        {acciones.map((a) => <Link key={a.t} to={a.to} className="aviso enlace-bloque" style={{ textDecoration: 'none', color: 'inherit' }}><Icon n={a.i} className="" size={16} /><span>{a.t}</span></Link>)}
        <div className="asistente-cifras">
          <span><b>{data.conversaciones_atendidas}</b> conversaciones atendidas</span>
          {data.citas_agendadas !== null && <span><b>{data.citas_agendadas}</b> citas agendadas</span>}
          {data.ventas_registradas !== null && <span><b>{data.ventas_registradas}</b> ventas registradas</span>}
          {data.resuelto_sin_persona_pct !== null && <span><b>{data.resuelto_sin_persona_pct}%</b> resuelto sin una persona</span>}
        </div>
        {!acciones.length && !(aprob?.length) && <span className="tenue peq-txt">Nada espera por ti. Tu asistente sigue atendiendo.</span>}
      </div>
    </section>
  );
}
