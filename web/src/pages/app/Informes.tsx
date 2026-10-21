import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { api, hace, hoyLocal } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { ErrorCarga, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { Informe, type InformeSpec } from '../../components/Visual';
import { OrbeCara } from '../../components/ia/OrbeCara';
import { useIA } from '../../components/ia/contexto';
import { usePuedeIA } from '../../components/ia/PanelIA';

const TIPOS: Record<string, { titulo: string; texto: string; icono: string; pedir: string }> = {
  ventas: { titulo: 'Ventas', texto: 'Lo vendido, por día, y lo que más se vende', icono: 'ventas', pedir: 'Hazme un informe de ventas comparando con el periodo anterior' },
  cobros: { titulo: 'Cobros', texto: 'Lo que entró por cada medio de pago', icono: 'caja', pedir: 'Hazme un informe de cobros por medio de pago' },
  agenda: { titulo: 'Agenda', texto: 'Citas atendidas, faltas y servicios más pedidos', icono: 'agenda', pedir: 'Hazme un informe de la agenda de este mes' },
  clientes: { titulo: 'Clientes', texto: 'Nuevos, recurrentes y quienes más compran', icono: 'clientes', pedir: 'Hazme un informe de clientes de este mes' },
  inventario: { titulo: 'Inventario', texto: 'Existencias, lo que hay que reponer y su valor', icono: 'inventario', pedir: 'Hazme un informe del inventario y qué debo reponer' },
};
const PERIODOS: [string, string][] = [['semana', 'Últimos 7 días'], ['mes', 'Este mes'], ['mes_anterior', 'Mes anterior'], ['rango', 'Elegir fechas']];

/**
 * Informes de la empresa con cifras reales en la plantilla de Omnegia (logo, nombre y colores de la
 * empresa), listos para descargar como imagen o PDF. Los arma el servidor con consultas, sin IA; para
 * uno a medida está Omnegia IA.
 */
export function Informes() {
  const { s } = useSesion();
  const { abrirPanel } = useIA();
  const puedeIA = usePuedeIA();
  const reducido = useReducedMotion();
  const [params, setParams] = useSearchParams();
  const disponibles = useApi<{ tipos: string[] }>(() => api.get('/api/t/informes'), []);
  const tipos = disponibles.data?.tipos ?? [];
  const tipo = tipos.includes(params.get('tipo') ?? '') ? params.get('tipo')! : tipos[0];
  const periodo = PERIODOS.some(([k]) => k === params.get('periodo')) ? params.get('periodo')! : 'mes';
  const [desde, setDesde] = useState(params.get('desde') ?? `${hoyLocal().slice(0, 8)}01`);
  const [hasta, setHasta] = useState(params.get('hasta') ?? hoyLocal());
  const consulta = periodo === 'rango' ? `periodo=rango&desde=${desde}&hasta=${hasta}` : `periodo=${periodo}`;
  const informe = useApi<{ informe: InformeSpec; generado_en: string } | null>(() => (tipo ? api.get(`/api/t/informes/${tipo}?${consulta}`) : Promise.resolve(null)), [tipo, consulta]);
  const cambiar = (k: string, v: string) => { const p = new URLSearchParams(params); p.set(k, v); if (k === 'periodo' && v !== 'rango') { p.delete('desde'); p.delete('hasta'); } setParams(p, { replace: true }); };

  return (
    <>
      <Cabecera titulo="Informes" sub={`Cifras reales de ${s.tenant.nombre}, con su marca, listas para descargar como imagen o PDF.`} />
      <div className="contenido inf-pagina">
        {disponibles.error && <ErrorCarga error={disponibles.error} reintentar={disponibles.recargar} />}
        {disponibles.data && !tipos.length && <Vacio titulo="No hay informes para tu rol">Pide a quien administra la empresa acceso a ventas, agenda, clientes o inventario.</Vacio>}
        {tipos.length > 0 && <>
          <div className="inf-tipos" role="tablist" aria-label="Tipo de informe">
            {tipos.map((t, i) => (
              <motion.button key={t} type="button" role="tab" aria-selected={t === tipo} className={`inf-tipo ${t === tipo ? 'on' : ''}`} onClick={() => cambiar('tipo', t)}
                initial={reducido ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: i * 0.05 }} whileTap={reducido ? undefined : { scale: 0.97 }}>
                <span className="inf-tipo-ico"><Icon n={TIPOS[t].icono} className="" size={18} /></span>
                <span className="inf-tipo-txt"><b>{TIPOS[t].titulo}</b><small>{TIPOS[t].texto}</small></span>
                {t === tipo && <motion.span layoutId="inf-tipo-marca" className="inf-tipo-marca" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />}
              </motion.button>
            ))}
          </div>

          <div className="inf-barra">
            <div className="tabs" role="group" aria-label="Periodo">{PERIODOS.filter(([k]) => tipo !== 'inventario' || k === 'mes').map(([k, v]) => (
              <button key={k} type="button" className={periodo === k || (tipo === 'inventario' && k === 'mes') ? 'on' : ''} aria-pressed={periodo === k} onClick={() => cambiar('periodo', k)} disabled={tipo === 'inventario'}>{tipo === 'inventario' ? 'Existencias de hoy' : v}</button>
            ))}</div>
            {periodo === 'rango' && tipo !== 'inventario' && (
              <span className="inf-fechas">
                <label><span className="sr">Desde</span><input className="input" type="date" value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} /></label>
                <Icon n="derecha" className="" size={14} />
                <label><span className="sr">Hasta</span><input className="input" type="date" value={hasta} min={desde} max={hoyLocal()} onChange={(e) => setHasta(e.target.value)} /></label>
              </span>
            )}
            {informe.data && <span className="tenue peq-txt inf-generado">Generado {hace(informe.data.generado_en)}</span>}
          </div>

          <div className="inf-cuerpo">
            {informe.error && <ErrorCarga error={informe.error} reintentar={informe.recargar} />}
            <AnimatePresence mode="wait">
              {!informe.data && !informe.error ? (
                <motion.div key="cargando" className="inf-esqueleto" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-label="Preparando el informe">
                  <OrbeCara tamano={48} cara="pensando" /><span>Preparando el informe con tus datos…</span>
                </motion.div>
              ) : informe.data && (
                <motion.div key={`${tipo}-${consulta}`} initial={reducido ? false : { opacity: 0, y: 14, filter: 'blur(6px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4 }}>
                  <Informe inf={informe.data.informe} origen="Informe con los datos registrados en el panel" />
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {puedeIA && tipo && (
            <div className="inf-medida">
              <OrbeCara tamano={40} />
              <span><b>¿Necesitas otro corte?</b><small>Pídele a Omnegia IA un informe a medida: otro periodo, una comparación o solo un servicio.</small></span>
              <button type="button" className="btn" onClick={() => abrirPanel(TIPOS[tipo].pedir)}><Icon n="ia" className="" size={15} />Pedir a Omnegia IA</button>
            </div>
          )}
        </>}
      </div>
    </>
  );
}
