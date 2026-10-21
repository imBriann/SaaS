import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, cop } from '../../api';
import { Cargando, ErrorCarga, Modal, useApi } from '../../components/ui';
import { Icon } from '../../components/icons';
import { SelectorPlanes } from '../../components/facturacion/SelectorPlanes';
import { type Catalogo, type Ciclo, type PlanCat, fechaCobro, textoConfirmar, useCambioPlan } from './suscripcion/cambio';
import '../../facturacion.css';

/** Cambio de plan desde el panel: el cargo exacto lo calcula el servidor y se muestra antes de confirmar. */
export function Planes() {
  const { data, error, recargar } = useApi<Catalogo>(() => api.get('/api/t/suscripcion/planes'), []);
  const [cicloElegido, setCiclo] = useState<Ciclo | null>(null);
  const [hoja, setHoja] = useState(false);
  const nav = useNavigate();
  const cambio = useCambioPlan((r) => nav('/suscripcion', { state: { resultado: r } }));
  const ciclo: Ciclo = cicloElegido ?? data?.ciclo ?? 'MENSUAL';

  const elegir = async (p: PlanCat) => {
    const c = await cambio.cotizar(p.codigo, ciclo);
    if (c) setHoja(true);
  };
  const accion = (p: PlanCat) => {
    const esActual = p.actual && ciclo === data?.ciclo;
    if (esActual && data?.estado !== 'ACTIVA') return <Link to="/suscripcion" className="btn-plan">Renovar tu plan<Icon n="derecha" className="" size={15} /></Link>;
    return <>
      <button type="button" className="btn-plan" disabled={esActual || cambio.cargando} onClick={() => elegir(p)}>
        {esActual ? 'Es tu plan actual' : p.actual ? `Pasar a ${ciclo === 'ANUAL' ? 'anual' : 'mensual'}` : `Elegir ${p.nombre}`}
        {!esActual && <Icon n="derecha" className="" size={15} />}
      </button>
      {cambio.error && !hoja && <p className="aviso-err peq-txt" role="alert">{cambio.error}</p>}
    </>;
  };

  return (
    <div className="matiz">
      <div className="matiz-volver"><Link to="/suscripcion" className="btn peq fantasma"><Icon n="atras" className="" size={14} />Suscripción</Link></div>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <div className="tarjeta"><Cargando filas={6} /></div> : (
        <SelectorPlanes planes={data.planes} ciclo={ciclo} onCiclo={setCiclo} accion={(p) => accion(p as PlanCat)} pausarTeclado={hoja}
          subtitulo="Cambia de plan cuando quieras, sin permanencia. Antes de pagar ves el valor exacto y nada se cobra solo."
          pie={data.cambio_programado && <p className="matiz-ayuda">Tienes un cambio programado a {data.cambio_programado.nombre} desde el {fechaCobro(data.cambio_programado.desde)}. Puedes deshacerlo en Suscripción.</p>} />
      )}

      {hoja && cambio.cot && (
        <Modal titulo={cambio.cot.tipo === 'SIN_CAMBIO' ? 'Sin cambios' : `Cambiar a ${cambio.cot.a.nombre}${cambio.cot.a.ciclo === 'ANUAL' ? ' anual' : ''}`} onCerrar={() => { setHoja(false); cambio.limpiar(); }}
          pie={<>
            <button type="button" className="btn" onClick={() => { setHoja(false); cambio.limpiar(); }}>Cancelar</button>
            <button type="button" className="btn primario" disabled={cambio.enviando || !!cambio.cot.bloqueo || cambio.cot.tipo === 'SIN_CAMBIO'} onClick={cambio.confirmar}>{cambio.enviando ? 'Preparando…' : textoConfirmar(cambio.cot)}</button>
          </>}>
          <ResumenCambio c={cambio.cot} />
          {cambio.error && <p className="aviso-err peq-txt" role="alert" style={{ marginTop: 10 }}>{cambio.error}</p>}
        </Modal>
      )}
    </div>
  );
}

/** Lo que pasaría con el cambio, tal como lo calculó el servidor. */
export function ResumenCambio({ c }: { c: NonNullable<ReturnType<typeof useCambioPlan>['cot']> }) {
  return (
    <div className="resumen-cambio">
      <p>{c.explicacion}</p>
      <dl className="resumen-pago">
        <div><dt>Hoy pagas</dt><dd className="cifra">{cop(c.cargo)}</dd></div>
        {c.credito > 0 && <div><dt>Descuento por días no usados</dt><dd className="cifra">−{cop(c.credito)}</dd></div>}
        <div><dt>{c.tipo === 'PROGRAMADO' ? 'Se aplica el' : 'Desde'}</dt><dd>{fechaCobro(c.aplica_desde)}</dd></div>
        <div><dt>Próximo cobro</dt><dd className="cifra">{cop(c.proximo_cobro.monto)} · {fechaCobro(c.proximo_cobro.fecha)}</dd></div>
      </dl>
      {c.modulos_que_se_apagan.length > 0 && <p className="aviso peq-txt"><Icon n="alerta" className="" size={14} />Se apagan: {c.modulos_que_se_apagan.join(', ')}. Tus datos se conservan.</p>}
      {c.bloqueo && <p className="aviso-err peq-txt" role="alert">{c.bloqueo}</p>}
      {c.cargo > 0 && <p className="tenue peq-txt">El pago se hace en la pasarela segura; tu plan cambia cuando la pasarela confirma el pago.</p>}
    </div>
  );
}
