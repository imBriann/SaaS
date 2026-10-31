import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, cop, num } from '../../api';
import { Cargando, ErrorCarga, Modal, useAccion, useApi, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { SelectorPlanes } from '../../components/facturacion/SelectorPlanes';
import { type Catalogo, type Ciclo, type PlanCat, fechaCobro, textoConfirmar, useCambioPlan } from './suscripcion/cambio';
import '../../facturacion.css';

/** Cambio de plan desde el panel: el cargo exacto lo calcula el servidor y se muestra antes de confirmar. */
export function Planes() {
  const { data, error, recargar } = useApi<Catalogo>(() => api.get('/api/t/suscripcion/planes'), []);
  const info = useApi<any>(() => api.get('/api/t/suscripcion'), []);
  const toast = useToast();
  const { run, ocupado } = useAccion();
  const [solicitud, setSolicitud] = useState<PlanCat | null>(null);
  const [enviada, setEnviada] = useState<string | null>(null);
  const [cicloElegido, setCiclo] = useState<Ciclo | null>(null);
  const [hoja, setHoja] = useState(false);
  const nav = useNavigate();
  const cambio = useCambioPlan((r) => nav('/suscripcion', { state: { resultado: r } }));
  const ciclo: Ciclo = cicloElegido ?? data?.ciclo ?? 'MENSUAL';

  // Por qué el cambio no se puede hacer en línea (si no, null). Nunca se deshabilita sin explicar.
  const institucional = data?.modalidad === 'INSTITUCIONAL';
  const sinPagoEnLinea = info.data ? !info.data.pagos_en_linea : false;
  const motivoSolicitud = institucional
    ? 'Tu empresa está en la modalidad institucional: el cambio de plan lo hace el equipo de Omnegia contigo.'
    : sinPagoEnLinea ? 'El pago en línea aún no está conectado en esta cuenta, así que el cambio con cobro lo hace el equipo de Omnegia contigo.' : null;
  const actual = data?.planes.find((x) => x.actual);

  const elegir = async (p: PlanCat) => {
    if (institucional) { setSolicitud(p); return; }
    const c = await cambio.cotizar(p.codigo, ciclo);
    if (c) { if (sinPagoEnLinea && c.cargo > 0) { setSolicitud(p); cambio.limpiar(); } else setHoja(true); }
  };
  const solicitar = async () => {
    if (!solicitud) return;
    const r = await run(() => api.post('/api/t/suscripcion/solicitar-cambio', { plan: solicitud.codigo, ciclo }));
    if (r) { setEnviada(r.mensaje); setSolicitud(null); toast(r.mensaje); }
  };
  const accion = (p: PlanCat) => {
    const esActual = p.actual && ciclo === data?.ciclo;
    if (esActual && data?.estado !== 'ACTIVA') return <Link to="/suscripcion" className="btn-plan">Renovar tu plan<Icon n="derecha" className="" size={15} /></Link>;
    return <>
      <button type="button" className="btn-plan" disabled={esActual || cambio.cargando} onClick={() => elegir(p)}>
        {esActual ? 'Es tu plan actual' : institucional ? `Solicitar ${p.nombre}` : p.actual ? `Pasar a ${ciclo === 'ANUAL' ? 'anual' : 'mensual'}` : `Elegir ${p.nombre}`}
        {!esActual && <Icon n="derecha" className="" size={15} />}
      </button>
      {cambio.error && !hoja && <p className="aviso-err peq-txt" role="alert">{cambio.error}</p>}
    </>;
  };

  return (
    <div className="matiz">
      <div className="matiz-volver"><Link to="/suscripcion" className="btn peq fantasma"><Icon n="atras" className="" size={14} />Suscripción</Link></div>
      {motivoSolicitud && <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>{motivoSolicitud} Elige el plan que quieres y pulsa «Solicitar el cambio».</span></div>}
      {enviada && <div className="aviso exito" role="status"><Icon n="ok" className="" size={16} /><span>{enviada}</span></div>}
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <div className="tarjeta"><Cargando filas={6} /></div> : (
        <SelectorPlanes planes={data.planes} ciclo={ciclo} onCiclo={setCiclo} accion={(p) => accion(p as PlanCat)} pausarTeclado={hoja}
          subtitulo="Cambia de plan cuando quieras, sin permanencia. Antes de pagar ves el valor exacto y nada se cobra solo."
          pie={data.cambio_programado && <p className="matiz-ayuda">Tienes un cambio programado a {data.cambio_programado.nombre} desde el {fechaCobro(data.cambio_programado.desde)}. Puedes deshacerlo en Suscripción.</p>} />
      )}

      {solicitud && (
        <Modal titulo={`Solicitar el cambio a ${solicitud.nombre}`} onCerrar={() => setSolicitud(null)}
          pie={<><button type="button" className="btn" onClick={() => setSolicitud(null)}>Cancelar</button><button type="button" className="btn primario" disabled={ocupado} onClick={solicitar}>{ocupado ? 'Enviando…' : 'Solicitar el cambio'}</button></>}>
          <div className="resumen-cambio">
            <p>{motivoSolicitud ?? 'Pide el cambio al equipo de Omnegia.'}</p>
            <QueCambia actual={actual} destino={solicitud} />
            <p className="tenue peq-txt">Al solicitar, abrimos un caso con el equipo de Omnegia; te escribimos al correo de tu cuenta. No se cobra ni se cambia nada hasta que lo confirmes con ellos.</p>
          </div>
        </Modal>
      )}
      {hoja && cambio.cot && (
        <Modal titulo={cambio.cot.tipo === 'SIN_CAMBIO' ? 'Sin cambios' : `Cambiar a ${cambio.cot.a.nombre}${cambio.cot.a.ciclo === 'ANUAL' ? ' anual' : ''}`} onCerrar={() => { setHoja(false); cambio.limpiar(); }}
          pie={<>
            <button type="button" className="btn" onClick={() => { setHoja(false); cambio.limpiar(); }}>Cancelar</button>
            <button type="button" className="btn primario" disabled={cambio.enviando || !!cambio.cot.bloqueo || cambio.cot.tipo === 'SIN_CAMBIO'} onClick={cambio.confirmar}>{cambio.enviando ? 'Preparando…' : textoConfirmar(cambio.cot)}</button>
          </>}>
          <ResumenCambio c={cambio.cot} />
          <QueCambia actual={actual} destino={data?.planes.find((x) => x.codigo === cambio.cot!.a.plan)} cot={cambio.cot} />
          {cambio.error && <p className="aviso-err peq-txt" role="alert" style={{ marginTop: 10 }}>{cambio.error}</p>}
        </Modal>
      )}
    </div>
  );
}

/**
 * Lo que cambia entre el plan actual y el elegido: límites y, al bajar de plan, qué deja de estar disponible y desde
 * cuándo (lo calcula el servidor en la cotización; los datos nunca se borran).
 */
export function QueCambia({ actual, destino, cot }: { actual?: PlanCat; destino?: PlanCat; cot?: NonNullable<ReturnType<typeof useCambioPlan>['cot']> }) {
  if (!actual || !destino || actual.codigo === destino.codigo) return null;
  const fila = (n: string, a: number, b: number, unidad = '') => (a === b ? null : <li key={n}><b>{n}:</b> {num(a)}{unidad} → <b>{num(b)}{unidad}</b>{b < a ? ' (menos)' : ' (más)'}</li>);
  const respuestas = (c: PlanCat['cuotas']) => Math.floor(c.tokens_ia / 5000 / 50) * 50;
  const bajando = destino.mensual < actual.mensual;
  const limites = [fila('Personas con acceso', actual.cuotas.usuarios, destino.cuotas.usuarios), fila('Respuestas de IA al mes', respuestas(actual.cuotas), respuestas(destino.cuotas)), fila('Mensajes al mes', actual.cuotas.mensajes, destino.cuotas.mensajes)].filter(Boolean);
  return (
    <div className="que-cambia">
      <b>Lo que cambia</b>
      {limites.length ? <ul>{limites}</ul> : <p className="tenue peq-txt">Los límites son los mismos.</p>}
      {bajando && (
        <div className="aviso" role="note"><Icon n="alerta" className="" size={16} /><span>
          <b>Al bajar a {destino.nombre}</b>{cot ? <> desde el <b>{fechaCobro(cot.aplica_desde)}</b></> : ' en la fecha que acordemos'}:
          {cot ? (cot.modulos_que_se_apagan.length ? ' dejan de estar disponibles los módulos que se listan arriba.' : ' no se apaga ningún módulo.') : ' el equipo te confirma qué módulos dejan de estar disponibles.'}
          {' '}Tus datos (clientes, ventas, conversaciones) <b>se conservan</b>, pero lo que dependa de esos módulos no se podrá usar hasta que vuelvas a un plan que los incluya.
        </span></div>
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
