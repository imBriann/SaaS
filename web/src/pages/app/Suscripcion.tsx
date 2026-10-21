import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { api, cop, descargarDocumentos, fecha, fechaCompleta, num } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { Cargando, ErrorCarga, useApi } from '../../components/ui';
import { Icon } from '../../components/icons';
import { AnilloGracia, AvisoDeshacer, BarraDias, Cascada, CodigoBarras, Confeti, Impresora, Pila, Rodillo } from '../../components/facturacion/piezas';
import { DocumentosPagos, NumeroContratado, SuscripcionClasica } from './Gobierno';
import { type Aviso, type Catalogo, type Ciclo, type Resultado, fechaCobro, irACheckout, textoConfirmar, textoResultado, tono, useCambioPlan } from './suscripcion/cambio';
import '../../facturacion.css';
import { sonar } from '../../lib/sonido';

const DIA = 86_400_000;
const VENCIDA = ['PAGO_PENDIENTE', 'EN_GRACIA', 'SUSPENDIDA'];

/** Lee ?ref= del retorno del checkout. Wompi añade ?id=<transacción> a la dirección de retorno. */
function leerRetorno(q: URLSearchParams) {
  const crudo = q.get('ref') ?? '';
  const [ref, resto] = crudo.split('?');
  const id = q.get('id') ?? new URLSearchParams(resto ?? '').get('id');
  return /^SUB-[A-Za-z0-9_-]{4,40}$/.test(ref) ? { ref, id: id && /^[\w-]{3,80}$/.test(id) ? id : null } : null;
}

/**
 * Suscripción: Cuenta (plan, cambio con prorrateo, uso y recibos), Gracia (cuando el periodo venció) y
 * Caja (al volver del checkout). Todo sale de la suscripción y los pagos reales de la empresa.
 */
export function Suscripcion() {
  const [q, setQ] = useSearchParams();
  const retorno = leerRetorno(q);
  const info = useApi<any>(() => api.get('/api/t/suscripcion'), []);
  if (retorno) return <Caja referencia={retorno.ref} idTransaccion={retorno.id} onSalir={() => { setQ({}, { replace: true }); info.recargar(); }} />;
  if (info.error) return <><Cabecera titulo="Suscripción" /><div className="contenido"><ErrorCarga error={info.error} reintentar={info.recargar} /></div></>;
  if (!info.data) return <><Cabecera titulo="Suscripción" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  if (info.data.suscripcion.modalidad === 'INSTITUCIONAL') return <SuscripcionClasica />;
  return <Panel info={info.data} recargar={info.recargar} />;
}

function Panel({ info, recargar }: { info: any; recargar: () => void }) {
  const catalogo = useApi<Catalogo>(() => api.get('/api/t/suscripcion/planes'), [info]);
  const movs = useApi<any>(() => api.get('/api/t/suscripcion/movimientos'), [info]);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const loc = useLocation();
  const nav = useNavigate();
  const s = info.suscripcion;
  const ultimo = movs.data?.pagos?.find((p: any) => p.metodo_detalle || p.metodo_pago);

  const deshacer = async () => {
    try { await api.del('/api/t/suscripcion/cambio'); setAviso({ id: Date.now(), texto: 'Listo: conservas tu plan actual' }); recargar(); }
    catch (e) { setAviso({ id: Date.now(), texto: (e as Error).message }); }
  };
  const { recargar: recargarSesion } = useSesion();
  const alCambiar = (r: Resultado) => {
    setAviso({ id: Date.now(), texto: textoResultado(r), accion: r.tipo === 'PROGRAMADO' ? { texto: 'Deshacer', fn: deshacer } : undefined });
    recargar();
    if (r.tipo === 'APLICADO') recargarSesion();
  };
  // Un cambio hecho desde la pantalla de planes llega con su resultado.
  useEffect(() => {
    const r = (loc.state as any)?.resultado as Resultado | undefined;
    if (r) { alCambiar(r); nav('.', { replace: true, state: null }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Cabecera titulo="Suscripción" sub={<span className="fact-ruta">Espacio de trabajo · Plan y pagos</span>}>
        {ultimo && <span className="fact-metodo"><Icon n="moneda" className="" size={15} /><span><small>Último pago con</small><b className="mono">{ultimo.metodo_detalle ?? metodoTexto(ultimo.metodo_pago)}</b></span></span>}
      </Cabecera>
      <div className="contenido fact">
        {VENCIDA.includes(s.estado) && <Gracia info={info} catalogo={catalogo.data} />}
        {!info.pagos_en_linea && <p className="aviso peq-txt"><Icon n="info" className="" size={14} />El pago en línea está pendiente de conectar. Escríbenos para renovar o cambiar de plan.</p>}
        <div className="cuenta-grid">
          <PlanActual info={info} catalogo={catalogo.data} onCambio={alCambiar} onDeshacer={deshacer} />
          <div className="cuenta-lado">
            <Uso info={info} />
            <Recibos movs={movs.data} error={movs.error} />
          </div>
        </div>
        <DocumentosPagos />
        <NumeroContratado />
      </div>
      <AvisoDeshacer aviso={aviso} onCerrar={() => setAviso(null)} />
    </>
  );
}

function metodoTexto(m?: string | null) {
  return ({ CARD: 'Tarjeta', PSE: 'PSE', NEQUI: 'Nequi', BANCOLOMBIA_TRANSFER: 'Bancolombia', SIMULADA: 'Pasarela de prueba' } as Record<string, string>)[m ?? ''] ?? m ?? 'Pasarela de pagos';
}

// =================================================================== Cuenta: plan actual y cambio
function PlanActual({ info, catalogo, onCambio, onDeshacer }: { info: any; catalogo: Catalogo | null; onCambio: (r: Resultado) => void; onDeshacer: () => void }) {
  const s = info.suscripcion;
  const cicloActual: Ciclo = s.ciclo ?? 'MENSUAL';
  const [ciclo, setCiclo] = useState<Ciclo>(cicloActual);
  const [elegido, setElegido] = useState<string>(s.plan_codigo);
  const cambio = useCambioPlan(onCambio);
  const reducido = useReducedMotion();
  const fin = new Date(s.periodo_fin).getTime();
  const totalDias = Math.max(1, Math.round((fin - new Date(s.periodo_inicio).getTime()) / DIA));
  const quedan = Math.max(0, Math.ceil((fin - Date.now()) / DIA));
  const planes = catalogo?.planes ?? [];
  const actual = planes.find((p) => p.actual);
  const destino = planes.find((p) => p.codigo === elegido) ?? actual;
  const hayCambio = elegido !== s.plan_codigo || ciclo !== cicloActual;
  const precioActual = cicloActual === 'ANUAL' ? s.precio_anual : s.precio_mensual;
  const prog = s.cambio_programado;

  useEffect(() => { setElegido(s.plan_codigo); setCiclo(cicloActual); cambio.limpiar(); }, [s.plan_codigo, cicloActual, prog?.plan]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hayCambio) cambio.cotizar(elegido, ciclo); else cambio.limpiar(); }, [elegido, ciclo]); // eslint-disable-line react-hooks/exhaustive-deps

  const c = hayCambio ? cambio.cot : null;
  const proximo = c ? c.proximo_cobro : { fecha: s.periodo_fin, monto: info.renovacion?.monto ?? precioActual };
  const fraccion = c ? Math.min(1, c.dias_restantes / Math.max(1, c.dias_periodo)) : quedan / totalDias;
  const t = tono(s.plan_codigo);

  return (
    <section className="tarjeta cuenta-plan" aria-labelledby="plan-actual-tit">
      <div className="cuenta-plan-cab">
        <span className="plan-icono" style={{ '--plan-c2': t.c2 } as CSSProperties} aria-hidden="true"><Icon n="grafica" className="" size={20} /></span>
        <div>
          <span className="sobretitulo">Plan actual</span>
          <h2 id="plan-actual-tit">{s.plan_nombre} <small>{cop(precioActual)} {cicloActual === 'ANUAL' ? 'al año' : 'al mes'}</small></h2>
          {s.precio_pactado != null && <span className="tenue peq-txt">Conservas tu precio de cuando empezaste</span>}
        </div>
        <div className="cuenta-renueva">
          <span>{VENCIDA.includes(s.estado) ? <>Venció el <b>{fecha(s.periodo_fin)}</b></> : <>Se renueva el <b>{fechaCobro(s.periodo_fin)}</b> · quedan <b>{quedan}</b> de {totalDias} días</>}</span>
          <BarraDias inicio={s.periodo_inicio} fin={s.periodo_fin} />
        </div>
      </div>

      {prog && (
        <div className="cambio-programado" role="status">
          <Icon n="reloj" className="" size={15} />
          <span>Cambiarás a <b>{prog.nombre}{prog.ciclo === 'ANUAL' ? ' anual' : ''}</b> el {fechaCobro(prog.desde)} · {cop(prog.precio)}</span>
          <button type="button" className="btn peq" onClick={onDeshacer}>Deshacer</button>
        </div>
      )}

      <div className="cuenta-ciclo">
        <div className="pastilla-ciclo peq" role="radiogroup" aria-label="Forma de pago">
          {(['MENSUAL', 'ANUAL'] as Ciclo[]).map((x) => (
            <button key={x} type="button" role="radio" aria-checked={ciclo === x} className={ciclo === x ? 'on' : ''} onClick={() => setCiclo(x)}>
              {ciclo === x && <motion.span layoutId="ciclo-cuenta" className="pastilla-fondo" transition={reducido ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 30 }} />}
              <span>{x === 'MENSUAL' ? 'Mensual' : 'Anual'}</span>
            </button>
          ))}
        </div>
        <span className="chip-gratis peq">Anual: 2 meses gratis</span>
        <Link to="/suscripcion/planes" className="cuenta-comparar">Comparar planes <Icon n="derecha" className="" size={13} /></Link>
      </div>

      {!catalogo ? <Cargando filas={2} /> : (
        <div className="mini-planes" role="radiogroup" aria-label="Plan">
          {planes.map((p) => {
            const precio = ciclo === 'ANUAL' ? p.anual_por_mes : p.mensual;
            return (
              <button key={p.codigo} type="button" role="radio" aria-checked={elegido === p.codigo} className={`mini-plan ${elegido === p.codigo ? 'elegido' : ''} ${p.actual ? 'actual' : ''}`} onClick={() => setElegido(p.codigo)}>
                {p.actual && <span className="chip-actual">• Actual</span>}
                <b>{p.nombre}</b>
                <span className="mini-precio"><Rodillo texto={cop(precio)} alMontar={false} /><small>/mes</small></span>
                <span className="tenue">{p.cuotas.usuarios} personas · {num(Math.floor(p.cuotas.tokens_ia / 5000 / 50) * 50)} respuestas IA</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="cuenta-ajuste">
        <div>
          <span className="sobretitulo">Ajuste por el cambio</span>
          <div className="ajuste-barra" aria-hidden="true"><motion.span initial={false} animate={{ scaleX: fraccion }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} /></div>
          <dl className="ajuste-lineas">
            {c && c.tipo !== 'SIN_CAMBIO' ? <>
              <div><dt><i className="punto azul" />{c.tipo === 'PROGRAMADO' ? `${c.a.nombre} desde el ${fechaCobro(c.aplica_desde)}` : c.tipo === 'RENOVAR' ? `Renovación con ${c.a.nombre}` : `${c.a.nombre} · ${c.dias_restantes} días que quedan`}</dt><dd>{cop(c.cargo + c.credito)}</dd></div>
              {c.credito > 0 && <div><dt><i className="punto" />Descuento del mes pagado</dt><dd>−{cop(c.credito)}</dd></div>}
              <div className="total"><dt>Pagas hoy</dt><dd>{cop(c.cargo)}</dd></div>
            </> : <>
              <div><dt><i className="punto azul" />Plan {s.plan_nombre}</dt><dd>{cop(precioActual)}</dd></div>
              <div><dt><i className="punto" />Sin ajuste</dt><dd>{cop(0)}</dd></div>
            </>}
          </dl>
        </div>
        <div className="cuenta-proximo">
          <span className="sobretitulo">Próximo cobro · {fechaCobro(proximo.fecha)}</span>
          <Rodillo texto={cop(proximo.monto)} className="proximo-cifra" alMontar={false} />
          <p className="tenue peq-txt">{cambio.cargando ? 'Calculando…' : c ? c.explicacion : VENCIDA.includes(s.estado) ? 'Pendiente: renueva para seguir con todo activo.' : prog ? `Ya con tu cambio a ${prog.nombre}. Nada se cobra solo.` : 'Tu cobro de siempre, sin cambios. Nada se cobra solo.'}</p>
        </div>
      </div>

      {destino && <Cascada items={destino.caracteristicas} clave={`${destino.codigo}-cuenta`} className="dos-col ambar" retraso={0.05} />}

      {c?.modulos_que_se_apagan?.length ? <p className="aviso peq-txt"><Icon n="alerta" className="" size={14} />Con {c.a.nombre} se apagan: {c.modulos_que_se_apagan.join(', ')}. Tus datos se conservan.</p> : null}
      {c?.bloqueo && <p className="aviso-err peq-txt" role="alert">{c.bloqueo}</p>}
      {cambio.error && <p className="aviso-err peq-txt" role="alert">{cambio.error}</p>}

      <div className="cuenta-confirmar">
        <button type="button" className="btn-ambar" disabled={!c || c.tipo === 'SIN_CAMBIO' || !!c.bloqueo || cambio.enviando || cambio.cargando || !info.pagos_en_linea && c.cargo > 0} onClick={cambio.confirmar}>
          <Icon n="ok" className="" size={16} />{cambio.enviando ? 'Preparando…' : c ? textoConfirmar(c) : 'Sin cambios'}
        </button>
        <span className="tenue peq-txt">{c && c.tipo !== 'SIN_CAMBIO' ? (c.cargo > 0 ? 'Pagas en la pasarela segura; el plan cambia cuando el pago se confirma.' : c.tipo === 'PROGRAMADO' ? 'No se cobra nada hoy y puedes deshacerlo antes de la fecha.' : 'Sin cobro: el cambio se aplica de inmediato.') : 'Elige otro plan o forma de pago para ver cuánto cambia tu cobro.'}</span>
      </div>
    </section>
  );
}

// =================================================================== Uso del periodo
function Uso({ info }: { info: any }) {
  const ia = info.consumo?.tokens_ia;
  const s = info.suscripcion;
  const usado = ia?.usado ?? 0, cuota = ia?.cuota ?? 0;
  const pct = cuota ? Math.min(100, (usado / cuota) * 100) : 0;
  const quedan = Math.max(0, Math.floor((cuota - usado) / 5000));
  const m = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toLocaleString('es-CO', { maximumFractionDigits: 1 })} M` : n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n));
  return (
    <section className="tarjeta cuenta-uso" aria-labelledby="uso-tit">
      <div className="fila entre"><h2 id="uso-tit">Uso del mes</h2><span className="tenue peq-txt">IA del agente</span></div>
      <div className="uso-cifra"><b>{m(usado)}</b><span>de {m(cuota)} tokens</span><span className="chip-pct">{Math.round(pct)} %</span></div>
      <div className="uso-barra" aria-hidden="true"><motion.span initial={{ scaleX: 0 }} animate={{ scaleX: pct / 100 }} transition={{ type: 'spring', stiffness: 90, damping: 20 }} /></div>
      <p className="uso-nota"><span className="cascada-check" aria-hidden="true"><Icon n="ok" className="" size={11} /></span>
        {cuota ? <>Con {s.plan_nombre} te quedan unas <b>{num(quedan)}</b> respuestas de IA este mes.</> : 'Tu plan no incluye IA.'}
        {ia?.agotada && s.politica_excedente === 'LIMITAR' ? ' La cuota se agotó: las conversaciones pasan a tu equipo.' : ''}
      </p>
      <div className="uso-mini">
        {[['mensajes', 'Mensajes de WhatsApp'], ['documentos', 'Facturas electrónicas']].map(([k, et]) => {
          const x = info.consumo?.[k];
          if (!x) return null;
          return <div key={k}><span>{et}</span><b>{num(x.usado)}{x.cuota ? ` / ${num(x.cuota)}` : ''}</b>{x.cuota ? <i style={{ '--p': `${Math.min(100, x.porcentaje ?? 0)}%` } as CSSProperties} /> : null}</div>;
        })}
      </div>
    </section>
  );
}

// =================================================================== Recibos de los pagos
function Recibos({ movs, error }: { movs: any; error: any }) {
  const [sel, setSel] = useState<any>(null);
  const [bajando, setBajando] = useState(false);
  const reducido = useReducedMotion();
  const bajar = async (id: string) => {
    setBajando(true);
    try { await descargarDocumentos(() => api.post(`/api/t/suscripcion/documentos/${id}/enlace`)); } catch { /* el aviso lo muestra la tabla de documentos */ } finally { setBajando(false); }
  };
  return (
    <section className="tarjeta cuenta-recibos" aria-labelledby="recibos-tit">
      <AnimatePresence mode="wait" initial={false}>
        {!sel ? (
          <motion.div key="lista" initial={reducido ? false : { opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.2 }}>
            <div className="fila entre"><h2 id="recibos-tit">Pagos</h2><span className="tenue peq-txt">Últimos pagos a Omnegia</span></div>
            {error ? <ErrorCarga error={error} /> : !movs ? <Cargando filas={3} /> : (
              <ul className="recibos">
                {movs.pagos.length === 0 && <li className="tenue peq-txt" style={{ padding: '10px 4px' }}>Aún no hay pagos registrados en línea.</li>}
                {movs.pagos.map((p: any) => (
                  <li key={p.id}>
                    <button type="button" className="recibo-fila" onClick={() => setSel(p)}>
                      <span className="recibo-ico" aria-hidden="true"><Icon n="documento" className="" size={15} /></span>
                      <span className="recibo-txt"><b>{fecha(p.verificado_en ?? p.creado_en)}</b><small className="mono">{p.documento ?? p.referencia}</small></span>
                      <span className="recibo-monto">{cop(p.monto)}</span>
                      <span className="chip-estado pagada">Pagado</span>
                      <Icon n="derecha" className="" size={14} />
                    </button>
                  </li>
                ))}
                {movs.proximo && (
                  <li><div className="recibo-fila prox">
                    <span className="recibo-ico" aria-hidden="true"><Icon n="reloj" className="" size={15} /></span>
                    <span className="recibo-txt"><b>{fechaCobro(movs.proximo.fecha)}</b><small>Próximo cobro · {movs.proximo.plan}</small></span>
                    <span className="recibo-monto">{cop(movs.proximo.monto)}</span>
                    <span className="chip-estado programada">Por pagar</span>
                  </div></li>
                )}
              </ul>
            )}
          </motion.div>
        ) : (
          <motion.div key="detalle" initial={reducido ? false : { opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.2 }}>
            <div className="fila entre recibo-barra">
              <button type="button" className="btn peq fantasma" onClick={() => setSel(null)}><Icon n="atras" className="" size={14} />Pagos</button>
              {sel.documento_id && sel.documento_estado === 'LISTO'
                ? <button type="button" className="btn peq" disabled={bajando} onClick={() => bajar(sel.documento_id)}><Icon n="descargar" className="" size={14} />{bajando ? 'Preparando…' : 'Descargar'}</button>
                : <span className="tenue peq-txt">{!sel.documento_id ? 'Sin documento todavía' : sel.documento_estado === 'SIN_DATOS' ? 'Sin datos de facturación' : 'Documentos en preparación'}</span>}
            </div>
            <Impresora clave={sel.id} sello="Pagado">
              <TicketPago p={sel} />
            </Impresora>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/** Contenido del recibo de un pago aprobado (datos del pago, nada más). */
function TicketPago({ p, encabezado = 'Recibo' }: { p: any; encabezado?: string }) {
  const cp = p.cambio_plan;
  return (
    <div className="ticket-cuerpo">
      <span className="ticket-sobre">{encabezado}</span>
      <b className="ticket-num">{p.documento ?? p.referencia}</b>
      <span className="ticket-tenue">{fechaCompleta(p.verificado_en ?? p.creado_en)}</span>
      {p.periodo_inicio && <span className="ticket-tenue">Periodo {fecha(p.periodo_inicio)} – {fechaCobro(p.periodo_fin)}</span>}
      <hr />
      <div className="ticket-linea"><span>{p.concepto}<small>{p.plan_nombre ? `Plan ${p.plan_nombre}${p.ciclo === 'ANUAL' ? ' · anual' : p.ciclo === 'MENSUAL' ? ' · mensual' : ''}` : ''}</small></span><span>{cop(cp ? cp.cargo + (cp.credito ?? 0) : p.monto)}</span></div>
      {cp?.credito > 0 && <div className="ticket-linea"><span>Descuento por días no usados</span><span>−{cop(cp.credito)}</span></div>}
      {cp && !cp.credito && cp.dias_restantes != null && <div className="ticket-linea tenue"><span>Diferencia por {cp.dias_restantes} días</span><span /></div>}
      <hr />
      <div className="ticket-total"><span>Total</span><b>{cop(p.monto)}</b></div>
      <span className="ticket-tenue">Pagado con {p.metodo_detalle ?? metodoTexto(p.metodo_pago)}</span>
      <CodigoBarras valor={p.referencia} />
      <span className="ticket-ref mono">{p.referencia}</span>
    </div>
  );
}

// =================================================================== Gracia: el periodo venció
function Gracia({ info, catalogo }: { info: any; catalogo: Catalogo | null }) {
  const s = info.suscripcion;
  const [sel, setSel] = useState('vencida');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const prog = s.cambio_programado;
  // Precios de la renovación: los del plan programado (si hay) o los del plan actual con su precio pactado.
  const plan = catalogo?.planes.find((p) => p.codigo === (prog?.plan ?? s.plan_codigo));
  const desde = Math.max(Date.now(), new Date(s.periodo_fin).getTime());
  const hasta = (meses: number) => { const d = new Date(desde); d.setMonth(d.getMonth() + meses); return d; };
  const opciones = useMemo(() => [
    { id: 'vencida', tipo: 'vencida' as const },
    ...(plan ? [
      { id: 'MENSUAL', tipo: 'renovar' as const, ciclo: 'MENSUAL' as Ciclo, monto: plan.mensual, hasta: hasta(1) },
      { id: 'ANUAL', tipo: 'renovar' as const, ciclo: 'ANUAL' as Ciclo, monto: plan.anual, hasta: hasta(12) },
    ] : []),
  ], [plan?.codigo, plan?.mensual, plan?.anual, s.periodo_fin]); // eslint-disable-line react-hooks/exhaustive-deps
  const elegida = opciones.find((o) => o.id === sel);
  const gracia = info.gracia;
  const anillo = s.estado === 'EN_GRACIA' && gracia ? { total: gracia.dias_total, restantes: gracia.dias_restantes } : s.estado === 'SUSPENDIDA' ? { total: 7, restantes: 0 } : { total: 7, restantes: 7 };
  const chip = { PAGO_PENDIENTE: 'Pago pendiente', EN_GRACIA: 'Periodo de gracia', SUSPENDIDA: 'Solo lectura' }[s.estado as string];
  const titulo = { PAGO_PENDIENTE: 'Tu suscripción está pendiente de pago', EN_GRACIA: 'Renueva antes de que se pause tu cuenta', SUSPENDIDA: 'Tu cuenta está en solo lectura' }[s.estado as string];
  const texto = s.estado === 'PAGO_PENDIENTE'
    ? `Tu periodo pagado terminó el ${fechaCompleta(s.periodo_fin)}. Omnegia no cobra nada de forma automática: todo sigue funcionando y, si no renuevas en unos días, empieza un periodo de gracia de 7 días.`
    : s.estado === 'EN_GRACIA'
      ? `Tu periodo terminó el ${fechaCompleta(s.periodo_fin)}. No hacemos cobros automáticos: renueva antes del ${fechaCompleta(gracia?.hasta ?? s.gracia_hasta)} y todo sigue igual.`
      : 'Tus datos están a salvo: puedes consultarlos y exportarlos. Al pagar se reactiva todo de inmediato.';

  const pagar = async () => {
    if (elegida?.tipo !== 'renovar') return;
    setEnviando(true); setError('');
    try {
      const r = await api.post<any>('/api/t/suscripcion/pagar', { ciclo: elegida.ciclo });
      if (r?.url) irACheckout(r.url); else setEnviando(false);
    } catch (e) { setError((e as Error).message); setEnviando(false); }
  };

  return (
    <section className="gracia" aria-labelledby="gracia-tit">
      <div className="gracia-izq">
        <span className="chip-fallo"><i aria-hidden="true" />{chip}</span>
        <h2 id="gracia-tit">{titulo}</h2>
        <p>{texto}</p>
        <div className="gracia-renovar">
          <div className="fila entre"><h3>¿Cómo quieres renovar?</h3><span className="tenue peq-txt">Plan {prog?.nombre ?? s.plan_nombre}</span></div>
          {!plan ? <Cargando filas={2} /> : (
            <Pila items={opciones} seleccion={sel} onSeleccion={setSel} etiqueta="Forma de renovar" className="pila-gracia"
              render={(o, frente) => o.tipo === 'vencida' ? (
                <span className="tarjeta-pago gris">
                  <span className="tp-chip" aria-hidden="true" />
                  <span className="tp-sello">Vencida</span>
                  <span className="tp-num">Plan {s.plan_nombre}</span>
                  <span className="tp-pie"><span>Venció el {fecha(s.periodo_fin)}</span></span>
                </span>
              ) : (
                <span className={`tarjeta-pago ${o.ciclo === 'ANUAL' ? 'dorada' : 'negra'}`}>
                  <span className="tp-marca">{o.ciclo === 'ANUAL' ? 'Anual · 2 meses gratis' : 'Mensual'}</span>
                  <span className="tp-chip" aria-hidden="true" />
                  <span className="tp-num"><Rodillo texto={cop(o.monto)} alMontar={frente} /></span>
                  <span className="tp-pie"><span>Cubre hasta el {fechaCobro(o.hasta)}</span><span aria-hidden="true">{frente ? '●' : ''}</span></span>
                </span>
              )} />
          )}
          <div className="gracia-accion">
            <button type="button" className="btn-negro" disabled={elegida?.tipo !== 'renovar' || enviando || !info.pagos_en_linea} onClick={pagar}>
              {enviando ? 'Abriendo la pasarela…' : elegida?.tipo === 'renovar' ? `Pagar ${cop(elegida.monto)}` : 'Elige cómo renovar'}
            </button>
            <span className="tenue peq-txt">{elegida?.tipo === 'renovar' ? `Se cobrarán ${cop(elegida.monto)} ahora en la pasarela segura y tu plan sigue hasta el ${fechaCobro(elegida.hasta)}.` : 'Toca una opción de la pila: mensual o anual.'}</span>
          </div>
          {error && <p className="aviso-err peq-txt" role="alert">{error}</p>}
        </div>
      </div>
      <div className="gracia-der">
        <AnilloGracia total={anillo.total} restantes={anillo.restantes} texto={anillo.restantes === 1 ? 'día de gracia' : 'días de gracia'} />
        <h3 className="sobretitulo">{s.estado === 'SUSPENDIDA' ? 'Lo que está en pausa' : 'Lo que se pausa si no hay pago'}</h3>
        <ul className="pausa">
          {info.solo_lectura.pausa.map((x: string, i: number) => (
            <li key={x} className={s.estado === 'SUSPENDIDA' ? 'pausado' : i === 0 ? 'primero' : ''}>
              <span className="pausa-ico" aria-hidden="true">{s.estado === 'SUSPENDIDA' ? '❚❚' : <Icon n="ok" className="" size={11} />}</span>{x}
              {i === 0 && s.estado !== 'SUSPENDIDA' && <small>lo primero</small>}
            </li>
          ))}
        </ul>
        <p className="tenue peq-txt">Siempre se conserva: {info.solo_lectura.conserva.join(' · ').toLowerCase()}.</p>
      </div>
    </section>
  );
}

// =================================================================== Caja: al volver del checkout
function Caja({ referencia, idTransaccion, onSalir }: { referencia: string; idTransaccion: string | null; onSalir: () => void }) {
  const [pago, setPago] = useState<any>(null);
  const [error, setError] = useState('');
  const [agotado, setAgotado] = useState(false);
  const [fase, setFase] = useState(0);
  const [disparo, setDisparo] = useState(0);
  const [frente, setFrente] = useState('metodo');
  const reducido = useReducedMotion();

  // El navegador solo trae la referencia (y el id de Wompi): el estado lo confirma el servidor con la pasarela.
  useEffect(() => {
    let vivo = true;
    let t = 0;
    let intentos = 0;
    const consultar = async () => {
      try {
        const p = await api.get<any>(`/api/t/suscripcion/pagos/${encodeURIComponent(referencia)}`);
        if (!vivo) return;
        setPago(p);
        if (p.estado === 'PENDIENTE' && ++intentos < 30) t = window.setTimeout(consultar, 2000);
        else if (p.estado === 'PENDIENTE') setAgotado(true);
      } catch (e) { if (vivo) setError((e as Error).message); }
    };
    (idTransaccion ? api.get(`/api/pagos/verificar?id=${encodeURIComponent(idTransaccion)}`).catch(() => {}) : Promise.resolve()).finally(consultar);
    return () => { vivo = false; window.clearTimeout(t); };
  }, [referencia, idTransaccion]);

  const aprobado = pago?.estado === 'APROBADO';
  // Con el pago aprobado cambian el plan y sus módulos: el menú y los permisos del panel se vuelven a leer.
  const { recargar: recargarSesion } = useSesion();
  useEffect(() => { if (aprobado) recargarSesion(); }, [aprobado]); // eslint-disable-line react-hooks/exhaustive-deps
  // Orden: sello → el recibo empieza a imprimirse → confeti.
  useEffect(() => {
    if (!aprobado) return;
    if (reducido) { setFase(2); return; }
    const a = window.setTimeout(() => { setFase(1); sonar('sello'); }, 150);
    const b = window.setTimeout(() => setFase(2), 650);
    const c = window.setTimeout(() => setDisparo(Date.now()), 900);
    return () => { window.clearTimeout(a); window.clearTimeout(b); window.clearTimeout(c); };
  }, [aprobado, reducido]);

  const rechazado = pago && ['RECHAZADO', 'ERROR', 'ANULADO', 'REEMPLAZADO', 'VENCIDO'].includes(pago.estado);
  useEffect(() => { if (rechazado) sonar('error'); }, [rechazado]);
  const metodo = pago?.metodo_detalle ?? metodoTexto(pago?.metodo_pago);
  const [marca, ultimos] = (() => { const m = /^(.*?)\s*•+\s*(\d{4})$/.exec(metodo ?? ''); return m ? [m[1], m[2]] : [metodo, null]; })();
  const prueba = pago?.proveedor && pago.proveedor !== 'wompi';

  return (
    <div className="fx-caja">
      <Confeti disparo={disparo} />
      <div className="fx-caja-escena">
        <div className="fx-caja-recibo">
          {aprobado && fase >= 2 ? (
            <Impresora clave={referencia} tono="claro">
              <div className="ticket-cuerpo centrado">
                <span className="ticket-ok" aria-hidden="true"><Icon n="ok" className="" size={16} /></span>
                <b className="ticket-titulo">Pago aprobado</b>
                <span className="ticket-tenue">Referencia <span className="mono">{pago.referencia}</span></span>
                <hr />
                <div className="ticket-linea"><span>{pago.concepto}</span><span>{cop(pago.cambio_plan ? pago.cambio_plan.cargo + (pago.cambio_plan.credito ?? 0) : pago.monto)}</span></div>
                {pago.cambio_plan?.credito > 0 && <div className="ticket-linea"><span>Descuento por días no usados</span><span>−{cop(pago.cambio_plan.credito)}</span></div>}
                {pago.periodo_inicio && <div className="ticket-linea tenue"><span>Periodo</span><span>{fecha(pago.periodo_inicio)} – {fechaCobro(pago.periodo_fin)}</span></div>}
                <hr className="doble" />
                <div className="ticket-total"><span>Total</span><b>{cop(pago.monto)}</b></div>
                {pago.periodo_fin && <span className="ticket-chip">Tu plan sigue activo hasta el {fechaCobro(pago.periodo_fin)}</span>}
                <span className="ticket-tenue">Pagado con {metodo}</span>
                <CodigoBarras valor={pago.referencia} />
                <span className="ticket-gracias">Gracias por confiar en Omnegia</span>
              </div>
            </Impresora>
          ) : (
            <div className="impresora impresora-claro espera">
              <div className="impresora-ranura" aria-hidden="true"><span className={`impresora-luz ${rechazado ? 'roja' : ''}`} /></div>
              <div className="fx-caja-espera" role="status">
                {error ? <><b>No encontramos este pago</b><span>{error}</span></>
                  : rechazado ? <><b>El pago no se aprobó</b><span>La pasarela no confirmó el cobro y no se cambió nada en tu plan. Puedes intentarlo de nuevo.</span></>
                    : agotado ? <><b>La confirmación está tardando</b><span>Si ya pagaste, la pasarela nos avisará en unos minutos y verás el recibo en Suscripción.</span></>
                      : <><b>Confirmando tu pago…</b><span>Estamos consultando el estado del cobro directamente con la pasarela.</span></>}
              </div>
            </div>
          )}
        </div>
        <div className="fx-caja-panel">
          <div className="fila entre"><h1>Pago</h1><span className="chip-seguro"><Icon n="candado" className="" size={12} />{prueba ? 'Pasarela de prueba' : 'Pago seguro'}</span></div>
          <Pila items={[{ id: 'metodo' }, { id: 'plan' }]} seleccion={frente} onSeleccion={setFrente} etiqueta="Detalle del pago" className="pila-caja"
            render={(it) => it.id === 'metodo' ? (
              <span className="tarjeta-pago negra lineas">
                <span className="tp-marca">{pago ? marca : 'Pasarela'}</span>
                <span className="tp-chip" aria-hidden="true" />
                <span className="tp-num">{ultimos ? `•••• ${ultimos}` : pago ? (prueba ? 'Prueba' : 'Wompi') : '••••'}</span>
                <span className="tp-pie"><span>{pago?.verificado_en ? fecha(pago.verificado_en) : 'Pendiente'}</span><span aria-hidden="true">)))</span></span>
              </span>
            ) : (
              <span className="tarjeta-pago gris">
                <span className="tp-marca">Omnegia</span>
                <span className="tp-num">{pago?.plan_nombre ? `Plan ${pago.plan_nombre}` : 'Suscripción'}</span>
                <span className="tp-pie"><span>{pago?.ciclo === 'ANUAL' ? 'Anual' : 'Mensual'}</span><span>{pago ? cop(pago.monto) : ''}</span></span>
              </span>
            )} />
          <p className="fx-caja-medio">{pago ? <>{marca}{ultimos ? <span className="mono"> · •••• {ultimos}</span> : null}</> : '…'}</p>
          <AnimatePresence>
            {aprobado && fase >= 1 && (
              <motion.div className="sello-dorado" initial={reducido ? { opacity: 0 } : { scale: 0, opacity: 0 }} animate={reducido ? { opacity: 1 } : { scale: [0, 1.15, 1], opacity: 1 }} transition={{ duration: reducido ? 0.2 : 0.5, times: [0, 0.7, 1] }}>
                <span aria-hidden="true"><Icon n="ok" className="" size={22} /></span>
                <b>Pago aprobado</b>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="fx-caja-acciones">
            <button type="button" className="btn primario" onClick={onSalir}>{aprobado ? 'Ver mi suscripción' : 'Volver a Suscripción'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
