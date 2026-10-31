import { api, cop } from '../api';
import { Cifra, Tarjeta, useApi } from './ui';

/**
 * Informes · métricas de la IA que atiende (evidencia para la tesis): conversaciones resueltas sin persona,
 * primera respuesta, citas y ventas de la IA frente al panel, escalamientos por regla, avisos enviados frente a
 * no enviados (por la ventana de 24 horas) e inasistencia con y sin recordatorio.
 */
const seg = (s: number | null) => (s == null ? '—' : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);

export function MetricasIA({ desde, hasta }: { desde: string; hasta: string }) {
  const { data } = useApi<any>(() => api.get(`/api/t/ia/metricas?desde=${desde}&hasta=${hasta}`), [desde, hasta]);
  if (!data) return null;
  return (
    <Tarjeta titulo="Tu asistente en este periodo">
      <div className="col" style={{ gap: 14 }}>
        <div className="kpis">
          <Cifra etiqueta="Resueltas sin una persona" valor={pct(data.conversaciones.pct_sin_persona)} />
          <Cifra etiqueta="Primera respuesta (mediana)" valor={seg(data.primera_respuesta_s.mediana)} />
          <Cifra etiqueta="Citas: IA / panel / automáticas" valor={`${data.citas.ia} / ${data.citas.panel} / ${data.citas.automatizacion}`} />
          <Cifra etiqueta="Ventas de la IA" valor={`${data.ventas.ia} · ${cop(data.ventas.monto_ia)}`} />
        </div>
        <div className="grid g3" style={{ alignItems: 'start' }}>
          <section><h4 className="peq-txt tenue">Cuándo llamó a una persona</h4>
            {!data.escalamientos.length ? <p className="tenue peq-txt">Ninguna vez.</p> : <ul className="lista">{data.escalamientos.map((e: any) => <li key={e.regla} className="fila entre peq-txt"><span>{e.nombre}</span><b>{e.n}</b></li>)}</ul>}
          </section>
          <section><h4 className="peq-txt tenue">Avisos por su cuenta</h4>
            <ul className="lista"><li className="fila entre peq-txt"><span>Enviados</span><b>{data.avisos.enviados}</b></li><li className="fila entre peq-txt"><span>No enviados (fuera de la ventana de 24 h)</span><b>{data.avisos.no_enviados}</b></li></ul>
          </section>
          <section><h4 className="peq-txt tenue">Inasistencia</h4>
            <ul className="lista">
              <li className="fila entre peq-txt"><span>Con recordatorio ({data.inasistencia.con_recordatorio_citas} citas)</span><b>{pct(data.inasistencia.con_recordatorio_pct)}</b></li>
              <li className="fila entre peq-txt"><span>Sin recordatorio ({data.inasistencia.sin_recordatorio_citas} citas)</span><b>{pct(data.inasistencia.sin_recordatorio_pct)}</b></li>
            </ul>
          </section>
        </div>
      </div>
    </Tarjeta>
  );
}
