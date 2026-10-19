import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, cop, fechaCompleta, fechaHora, type ApiError } from '../../api';
import { Cabecera, Escritura } from '../../components/Layout';
import { Campo, Cargando, ErrorCarga, Estado, Tarjeta, useAccion, useApi, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { Contador, MarcaExito, escalon } from '../../components/Movimiento';
import { AiOrb } from '../../components/AiOrb';
import { irA } from '../public/Publico';

/**
 * Número de WhatsApp contratado desde Omnegia: elegir, revisar el precio, pagar y acompañar la
 * activación real. Todo estado viene del servidor; esta pantalla nunca da por hecho un paso que el
 * servidor no confirmó, y se puede cerrar en cualquier momento sin perder el progreso.
 */
type C = any;

const ESPERA: string[] = ['PAGO_PENDIENTE', 'PAGO_CONFIRMADO', 'APROVISIONANDO_NUMERO', 'NUMERO_APROVISIONADO', 'VERIFICACION_PENDIENTE', 'CONEXION_PENDIENTE'];
const ANTES_DEL_PAGO = ['SELECCION_NUMERO', 'CONFIRMACION_PENDIENTE', 'PAGO_PENDIENTE'];

export const formatoNumero = (n: string) => {
  const m = /^\+57(\d{3})(\d{3})(\d{4})$/.exec(n);
  return m ? `+57 ${m[1]} ${m[2]} ${m[3]}` : n.replace(/^(\+\d{1,3})(\d{3})(\d{3})(\d+)$/, '$1 $2 $3 $4');
};
const CARACTERISTICA: Record<string, string> = { voice: 'Llamadas', sms: 'SMS', mms: 'MMS', fax: 'Fax', emergency: 'Emergencias' };

export function NumeroWhatsApp() {
  const [q, setQ] = useSearchParams();
  const { data, error, cargando, recargar, setData } = useApi<{ contratacion: C | null }>(() => api.get('/api/t/numeros/contratacion'), []);
  const c = data?.contratacion ?? null;
  const vivo = c && c.estado !== 'CANCELADO';
  const sondear = !!c && (ESPERA.includes(c.estado) || (c.estado === 'CONECTADO' && !c.prueba_recibida_en));
  useEffect(() => {
    if (!sondear) return;
    const t = setInterval(recargar, 4000);
    return () => clearInterval(t);
  }, [sondear]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vuelta de Wompi (?id=transacción): el servidor consulta el pago; la URL no prueba nada.
  const verificado = useRef(false);
  useEffect(() => {
    const id = q.get('id');
    if (verificado.current || (!id && !q.get('ref'))) return;
    verificado.current = true;
    (async () => {
      if (id) { try { setData(await api.post('/api/t/numeros/pago/verificar', { id })); } catch { /* el sondeo seguirá consultando */ } }
      setQ({}, { replace: true });
      recargar();
    })();
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const actualizar = (r: any) => setData(r && 'contratacion' in r ? r : { contratacion: r });

  return (
    <>
      <Cabecera titulo="Número de WhatsApp" sub="Contrata un número nuevo y Omnegia lo deja conectado a tu asistente de IA." />
      <div className="contenido numeros">
        {error ? <ErrorCarga error={error} reintentar={recargar} /> : cargando && !data ? <Cargando filas={6} /> : !vivo ? (
          <Inicio previa={c} onCreada={actualizar} />
        ) : ANTES_DEL_PAGO.includes(c.estado) ? (
          <Contratacion c={c} onCambio={actualizar} recargar={recargar} />
        ) : (
          <>
            <Activacion c={c} onCambio={actualizar} recargar={recargar} />
            {c.periodo_inicio && <Gestion c={c} onCambio={actualizar} />}
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Paso 0 · tipo de conexión y selección del número
// ---------------------------------------------------------------------------
function Inicio({ previa, onCreada }: { previa: C | null; onCreada: (c: C) => void }) {
  const { data: op, error, recargar } = useApi<any>(() => api.get('/api/t/numeros/opciones'), []);
  const [modo, setModo] = useState<'propio' | 'nuevo' | null>(null);
  if (error) return <ErrorCarga error={error} reintentar={recargar} />;
  if (!op) return <Cargando filas={4} />;
  return (
    <div className="col num-inicio" style={{ gap: 16 }}>
      {previa?.estado === 'CANCELADO' && previa.accion_cliente === 'reembolso' && <Reembolso c={previa} />}
      {previa?.estado === 'CANCELADO' && previa.subestado === 'numero_no_disponible' && <div className="aviso" role="status"><Icon n="info" className="" size={16} />El número que elegiste ya no estaba disponible y no se hizo ningún cobro. Elige otro.</div>}
      <div className="num-opciones" role="group" aria-label="Cómo quieres conectar WhatsApp">
        <TarjetaOpcion activa={modo === 'propio'} icono="conversaciones" titulo="Ya tengo un número" texto="Conecta el número de WhatsApp Business que ya usa tu negocio. Sin costo adicional." onClick={() => setModo(modo === 'propio' ? null : 'propio')} />
        <TarjetaOpcion activa={modo === 'nuevo'} icono="telefono" titulo="Necesito un número nuevo" texto="Elige un número, revisa el precio y Omnegia se encarga de comprarlo y activarlo." onClick={() => setModo(modo === 'nuevo' ? null : 'nuevo')} destacada />
      </div>
      <div className={`plegable ${modo === 'propio' ? 'abierto' : ''}`} aria-hidden={modo !== 'propio'}>
        <div>
          <Tarjeta titulo="Conectar tu propio número">
            <div className="col" style={{ gap: 10 }}>
              <p className="sec">Tu número debe estar en una cuenta de WhatsApp Business de Meta y no usarse en la aplicación de WhatsApp personal. No pagas mensualidad de número en Omnegia.</p>
              <Link className="btn primario" to="/configuracion?tab=canal" tabIndex={modo === 'propio' ? 0 : -1}>Ir a Configuración › WhatsApp<Icon n="flecha" className="" size={16} /></Link>
            </div>
          </Tarjeta>
        </div>
      </div>
      <div className={`plegable ${modo === 'nuevo' ? 'abierto' : ''}`} aria-hidden={modo !== 'nuevo'}>
        <div>{modo === 'nuevo' && (op.disponible ? <Selector op={op} onElegido={onCreada} /> : <NoDisponible op={op} />)}</div>
      </div>
    </div>
  );
}

function TarjetaOpcion({ activa, icono, titulo, texto, onClick, destacada }: { activa: boolean; icono: string; titulo: string; texto: string; onClick: () => void; destacada?: boolean }) {
  return (
    <button type="button" className={`num-opcion ${activa ? 'on' : ''} ${destacada ? 'destacada' : ''}`} aria-expanded={activa} onClick={onClick}>
      <span className="num-opcion-ico" aria-hidden="true"><Icon n={icono} className="" size={22} /></span>
      <span className="num-opcion-txt"><b>{titulo}</b><span>{texto}</span></span>
      <Icon n="abajo" className="num-opcion-flecha" size={18} />
    </button>
  );
}

function NoDisponible({ op }: { op: any }) {
  return (
    <Tarjeta titulo="La compra de números no está disponible">
      <div className="col" style={{ gap: 10 }}>
        <div className="bloqueado"><Icon n="info" className="" size={16} /><span>{op.motivo}</span></div>
        {op.contratacion_id ? <span className="sec">Recarga la página para ver tu contratación.</span> : <span className="sec">Puedes conseguir un número compatible con WhatsApp Business (que reciba llamadas o SMS y no esté en la aplicación personal) y conectarlo en <Link className="enlace" to="/configuracion?tab=canal">Configuración › WhatsApp</Link>.</span>}
      </div>
    </Tarjeta>
  );
}

/** Señal de disponibilidad: late mientras se consulta el inventario real y se aquieta con el resultado. */
function Senal({ buscando, cantidad }: { buscando: boolean; cantidad: number | null }) {
  return (
    <div className={`num-senal ${buscando ? 'buscando' : ''}`} aria-live="polite">
      <span className="num-senal-ondas" aria-hidden="true"><i /><i /><i /><Icon n="telefono" className="" size={20} /></span>
      <span className="num-senal-txt">{buscando ? 'Consultando números disponibles con el proveedor…' : cantidad === null ? 'Elige el tipo de número' : cantidad === 0 ? 'No hay números disponibles con ese filtro' : <><b><Contador valor={cantidad} /></b> {cantidad === 1 ? 'número disponible' : 'números disponibles'} ahora</>}</span>
    </div>
  );
}

function Selector({ op, onElegido, reemplazo }: { op: any; onElegido: (c: C) => void; reemplazo?: { id: string; tope: { hoy: number; mensual: number } } }) {
  const paises = op.paises.filter((p: any) => p.tipos.some((t: any) => t.elegible));
  const [pais, setPais] = useState(paises[0]?.pais ?? 'CO');
  const tiposPais = op.paises.find((p: any) => p.pais === pais)?.tipos ?? [];
  const [tipo, setTipo] = useState<string>(tiposPais.find((t: any) => t.elegible)?.tipo ?? 'local');
  const [localidad, setLocalidad] = useState('');
  const [contiene, setContiene] = useState('');
  const [filtro, setFiltro] = useState({ localidad: '', contiene: '' });
  const [elegido, setElegido] = useState<string | null>(null);
  const { run, ocupado } = useAccion();
  const consulta = new URLSearchParams({ pais, tipo, ...(filtro.localidad ? { localidad: filtro.localidad } : {}), ...(filtro.contiene ? { contiene: filtro.contiene } : {}) }).toString();
  const { data: d, error, cargando, recargar } = useApi<any>(() => api.get(`/api/t/numeros/disponibles?${consulta}`), [consulta]);
  const numeros = (d?.numeros ?? []).filter((n: any) => !reemplazo || (n.precio.hoy <= reemplazo.tope.hoy && n.precio.mensual <= reemplazo.tope.mensual));
  const sel = numeros.find((n: any) => n.numero === elegido);
  useEffect(() => { setElegido(null); }, [consulta]);
  const continuar = async () => {
    if (!sel) return;
    const r = reemplazo
      ? await run(() => api.post(`/api/t/numeros/contrataciones/${reemplazo.id}/otro-numero`, { numero: sel.numero }), 'Número cambiado. Lo estamos comprando.')
      : await run(() => api.post('/api/t/numeros/contrataciones', { numero: sel.numero, pais, tipo }));
    if (r) onElegido(r);
  };
  return (
    <div className="col" style={{ gap: 14 }}>
      {d?.simulado && <div className="aviso" role="note"><Icon n="alerta" className="" size={16} /><span><b>Inventario de demostración.</b> Estos números y valores son de prueba: no se compra ningún número real ni se cobra dinero real.</span></div>}
      <Tarjeta titulo={reemplazo ? 'Elige otro número (sin pagar de nuevo)' : 'Elige tu número'} acciones={op.proveedor && <span className="tenue peq-txt">Proveedor: {op.proveedor.nombre}</span>}>
        <div className="col" style={{ gap: 14 }}>
          <div className="num-filtros">
            <Campo etiqueta="País">
              <select className="input" value={pais} onChange={(e) => { setPais(e.target.value); const t = op.paises.find((p: any) => p.pais === e.target.value)?.tipos.find((x: any) => x.elegible); if (t) setTipo(t.tipo); }}>
                {op.paises.map((p: any) => <option key={p.pais} value={p.pais} disabled={!p.tipos.some((t: any) => t.elegible)}>{p.nombre}{p.indicativo ? ` (+${p.indicativo})` : ''}</option>)}
              </select>
            </Campo>
            <fieldset className="num-tipos">
              <legend>Tipo de número</legend>
              {tiposPais.map((t: any) => (
                <label key={t.tipo} className={`num-tipo ${tipo === t.tipo ? 'on' : ''} ${t.elegible ? '' : 'no'}`} title={t.motivo}>
                  <input type="radio" name="tipo-numero" value={t.tipo} checked={tipo === t.tipo} disabled={!t.elegible} onChange={() => setTipo(t.tipo)} />
                  <span>{t.nombre}</span>
                  {!t.elegible && <small>No apto para WhatsApp</small>}
                </label>
              ))}
            </fieldset>
            <form className="num-busqueda" onSubmit={(e) => { e.preventDefault(); setFiltro({ localidad: localidad.trim(), contiene: contiene.replace(/\D/g, '') }); }}>
              <Campo etiqueta="Ciudad (opcional)"><input className="input" value={localidad} onChange={(e) => setLocalidad(e.target.value)} placeholder="Bogotá" maxLength={60} /></Campo>
              <Campo etiqueta="Que contenga (opcional)"><input className="input mono" inputMode="numeric" value={contiene} onChange={(e) => setContiene(e.target.value)} placeholder="555" maxLength={10} /></Campo>
              <button className="btn"><Icon n="buscar" className="" size={16} />Buscar</button>
            </form>
          </div>
          <Senal buscando={cargando} cantidad={d ? numeros.length : null} />
          {error ? <ErrorCarga error={error as ApiError} reintentar={recargar} /> : (
            <fieldset className="num-lista" aria-busy={cargando} disabled={cargando}>
              <legend className="sr">Números disponibles</legend>
              {numeros.map((n: any, i: number) => (
                <label key={n.numero} className={`num-item ${elegido === n.numero ? 'on' : ''}`} style={escalon(i)}>
                  <input type="radio" name="numero" value={n.numero} checked={elegido === n.numero} onChange={() => setElegido(n.numero)} />
                  <span className="num-item-cab">
                    <b className="mono">{formatoNumero(n.numero)}</b>
                    <span className="tenue peq-txt">{[n.localidad, n.region].filter(Boolean).join(' · ') || n.tipo_nombre}</span>
                  </span>
                  <span className="num-chips">
                    {n.caracteristicas.map((x: string) => <span key={x} className="chip">{CARACTERISTICA[x] ?? x}</span>)}
                    <span className="chip ok" title={n.elegibilidad}><Icon n="ok" className="" size={12} />Apto para WhatsApp</span>
                  </span>
                  <span className="num-item-precio">
                    <span><b>{cop(n.precio.mensual)}</b><small> al mes</small></span>
                    <small className="tenue">Hoy {cop(n.precio.hoy)} (activación y primer mes)</small>
                  </span>
                  <span className="num-item-check" aria-hidden="true"><Icon n="ok" className="" size={14} /></span>
                </label>
              ))}
            </fieldset>
          )}
          {d && d.requisitos?.length > 0 && !reemplazo && (
            <div className="num-requisitos-previa">
              <span className="peq-txt"><Icon n="candado" className="" size={14} /> Para este tipo de número el proveedor pide, por regulación:</span>
              <ul>{d.requisitos.map((r: any) => <li key={r.id}>{r.nombre}</li>)}</ul>
            </div>
          )}
          {d?.tasa && <span className="tenue peq-txt">Precios en pesos con la {d.tasa.fuente === 'TRM' ? `TRM oficial (${d.tasa.vigente_desde})` : 'tasa configurada por Omnegia'}: {cop(d.tasa.valor)} por dólar. {d.margen_pct > 0 ? `Incluyen el margen de Omnegia (${d.margen_pct} %).` : 'Omnegia no suma margen al costo del número.'}</span>}
          <div className="fila" style={{ justifyContent: 'flex-end' }}>
            <Escritura permiso="subscription:manage">
              <button className="btn primario grande num-continuar" disabled={!sel || ocupado} onClick={continuar}>{ocupado ? 'Reservando…' : sel ? `Continuar con ${formatoNumero(sel.numero)}` : 'Elige un número'}<Icon n="flecha" className="" size={16} /></button>
            </Escritura>
          </div>
        </div>
      </Tarjeta>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pasos 1–3 · requisitos, resumen y pago
// ---------------------------------------------------------------------------
const PASOS = ['Número', 'Requisitos', 'Resumen', 'Pago', 'Activación'];
function Pasos({ actual }: { actual: number }) {
  return (
    <ol className="num-pasos" aria-label={`Paso ${actual + 1} de ${PASOS.length}`}>
      {PASOS.map((p, i) => <li key={p} className={i < actual ? 'hecho' : i === actual ? 'on' : ''} aria-current={i === actual ? 'step' : undefined}><b>{i < actual ? <Icon n="ok" className="" size={12} /> : i + 1}</b><span>{p}</span></li>)}
    </ol>
  );
}

function Contratacion({ c, onCambio, recargar }: { c: C; onCambio: (c: C) => void; recargar: () => void }) {
  const paso = c.estado === 'SELECCION_NUMERO' ? 1 : c.estado === 'CONFIRMACION_PENDIENTE' ? 2 : 3;
  const { run, ocupado } = useAccion();
  const cambiar = async () => { const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}/cancelar`, {}), 'Puedes elegir otro número.'); if (r) recargar(); };
  return (
    <div className="col" style={{ gap: 16 }}>
      <Pasos actual={paso} />
      <div key={c.estado} className="num-entra">
        {c.estado === 'SELECCION_NUMERO' ? <Requisitos c={c} onCambio={onCambio} /> : <Resumen c={c} onCambio={onCambio} />}
      </div>
      <div className="fila envolver" style={{ gap: 8 }}>
        <Escritura permiso="subscription:manage"><button className="btn sutil" disabled={ocupado} onClick={cambiar}><Icon n="atras" className="" size={16} />Elegir otro número</button></Escritura>
        <span className="tenue peq-txt">Hasta que pagues no se cobra nada{c.reserva_expira_en ? ` · el número está reservado hasta las ${new Date(c.reserva_expira_en).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}` : ''}.</span>
      </div>
    </div>
  );
}

const leerArchivo = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = () => rej(new Error('No se pudo leer el archivo.'));
  r.readAsDataURL(f);
});

function Requisitos({ c, onCambio }: { c: C; onCambio: (c: C) => void }) {
  const [valores, setValores] = useState<Record<string, any>>({});
  const { run, ocupado } = useAccion();
  const toast = useToast();
  const set = (id: string, v: any) => setValores((x) => ({ ...x, [id]: v }));
  const enviar = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}/requisitos`, { valores }), 'Requisitos enviados al proveedor.');
    if (r) onCambio(r);
  };
  return (
    <Tarjeta titulo={`Requisitos para ${formatoNumero(c.numero)}`}>
      <form className="col" style={{ gap: 14 }} onSubmit={enviar}>
        <p className="sec">La regulación de telecomunicaciones exige identificar al titular del número. Omnegia envía estos datos directamente al proveedor ({c.proveedor}) y solo guarda la referencia del envío, no tus documentos.</p>
        {c.requisitos.lista.map((r: any) => (
          <div key={r.id} className="num-req">
            {r.campo === 'textual' && <Campo etiqueta={r.nombre} ayuda={r.descripcion}><input className="input" required value={valores[r.id] ?? ''} onChange={(e) => set(r.id, e.target.value)} placeholder={r.ejemplo ?? ''} maxLength={300} /></Campo>}
            {r.campo === 'address' && (
              <fieldset className="num-direccion">
                <legend>{r.nombre}</legend>
                <span className="tenue peq-txt">{r.descripcion}</span>
                <div className="grid g2">
                  {([['nombre', 'Nombre del responsable'], ['apellido', 'Apellido'], ['empresa', 'Razón social o nombre del negocio'], ['direccion', 'Dirección'], ['ciudad', 'Ciudad'], ['departamento', 'Departamento']] as const).map(([k, l]) => (
                    <Campo key={k} etiqueta={l}><input className="input" required={k !== 'departamento'} value={valores[r.id]?.[k] ?? ''} onChange={(e) => set(r.id, { ...(valores[r.id] ?? {}), [k]: e.target.value })} /></Campo>
                  ))}
                </div>
              </fieldset>
            )}
            {r.campo === 'document' && (
              <Campo etiqueta={r.nombre} ayuda={`${r.descripcion} PDF, PNG o JPG de hasta 4 MB.`}>
                <input className="input" type="file" required accept=".pdf,.png,.jpg,.jpeg" onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 4 * 1024 * 1024) { toast('El archivo pesa más de 4 MB.', true); e.target.value = ''; return; }
                  set(r.id, { nombre: f.name, base64: await leerArchivo(f) });
                }} />
              </Campo>
            )}
          </div>
        ))}
        <div className="fila" style={{ justifyContent: 'flex-end' }}>
          <Escritura permiso="subscription:manage"><button className="btn primario" disabled={ocupado}>{ocupado ? 'Enviando al proveedor…' : 'Enviar y ver el resumen'}<Icon n="flecha" className="" size={16} /></button></Escritura>
        </div>
      </form>
    </Tarjeta>
  );
}

function Linea({ etiqueta, valor, detalle, fuerte }: { etiqueta: ReactNode; valor: ReactNode; detalle?: ReactNode; fuerte?: boolean }) {
  return <div className={`num-linea ${fuerte ? 'fuerte' : ''}`}><span>{etiqueta}{detalle && <small>{detalle}</small>}</span><b>{valor}</b></div>;
}

function Resumen({ c, onCambio }: { c: C; onCambio: (c: C) => void }) {
  const q = c.cotizacion;
  const { data: op } = useApi<any>(() => api.get('/api/t/numeros/opciones'), []);
  const [acepto, setAcepto] = useState({ cargo: false, mensualidad: false, condiciones: false });
  const [fase, setFase] = useState<'idle' | 'enviando' | 'redirigiendo'>('idle');
  const { run } = useAccion();
  const todos = acepto.cargo && acepto.mensualidad && acepto.condiciones;
  const pagar = async () => {
    setFase('enviando');
    const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}/confirmar`, { total_hoy: q.total_hoy, total_mensual: q.total_mensual, acepto_cargo: true, acepto_mensualidad: true, acepto_condiciones: true }));
    if (!r) {
      setFase('idle');
      // Si el precio cambió, el servidor devuelve el resumen nuevo: se muestra y se vuelve a pedir la confirmación.
      try { const nuevo = (await api.get('/api/t/numeros/contratacion')).contratacion; if (nuevo) { onCambio(nuevo); setAcepto({ cargo: false, mensualidad: false, condiciones: false }); } } catch { /* sin cambios */ }
      return;
    }
    setFase('redirigiendo');
    irA(r.url);
  };
  const ivaTexto = q.iva.regimen === 'RESPONSABLE' ? `IVA ${q.iva.pct} %` : q.iva.regimen === 'NO_RESPONSABLE' ? 'Omnegia no es responsable de IVA' : 'Régimen de IVA del emisor pendiente de configuración: no se suma IVA';
  return (
    <div className="num-resumen">
      <Tarjeta titulo="Resumen de la compra" className="num-resumen-principal">
        <div className="col" style={{ gap: 16 }}>
          {c.simulado && <div className="aviso" role="note"><Icon n="alerta" className="" size={16} />Simulación: no se compra un número real ni se cobra dinero real.</div>}
          {c.subestado === 'pago_rechazado' && <div className="bloqueado" role="alert"><Icon n="x" className="" size={16} />El pago anterior fue rechazado. No se hizo ningún cobro: puedes intentarlo de nuevo.</div>}
          <div className="num-resumen-numero">
            <span className="num-resumen-ico" aria-hidden="true"><Icon n="telefono" className="" size={20} /></span>
            <span><b className="mono">{formatoNumero(c.numero)}</b><span className="tenue peq-txt">{c.tipo_nombre}{c.localidad ? ` · ${c.localidad}` : ''} · {c.caracteristicas.map((x: string) => CARACTERISTICA[x] ?? x).join(', ')} · Proveedor {c.proveedor}</span></span>
          </div>
          <div className="num-precios">
            <div className="num-precio hoy">
              <span className="peq-txt">Pagas hoy</span>
              <b><Contador valor={q.total_hoy} formato={(n) => cop(n)} /></b>
              <small>Activación y primer mes del número</small>
            </div>
            <div className="num-precio mes">
              <span className="peq-txt">Luego, cada mes</span>
              <b>{cop(q.total_mensual)}</b>
              <small>Mensualidad del número · sin cobros automáticos</small>
            </div>
          </div>
          <div className="num-desglose">
            <h3 className="peq-txt">Lo que pagas hoy a Omnegia</h3>
            <Linea etiqueta="Activación del número" detalle={`Costo del proveedor ${q.costo_proveedor.activacion} ${q.costo_proveedor.moneda}`} valor={cop(q.numero.activacion)} />
            <Linea etiqueta="Primer mes del número" detalle={`Costo del proveedor ${q.costo_proveedor.mensual} ${q.costo_proveedor.moneda} al mes`} valor={cop(q.numero.mensual)} />
            {q.gestion_activacion > 0 && <Linea etiqueta="Gestión de la activación (Omnegia)" valor={cop(q.gestion_activacion)} />}
            <Linea etiqueta="Impuestos" detalle={ivaTexto} valor={q.iva.hoy ? cop(q.iva.hoy) : '—'} />
            <Linea etiqueta="Total hoy" valor={cop(q.total_hoy)} fuerte />
            <p className="tenue peq-txt">
              Conversión con {q.tasa.fuente === 'TRM' ? `la TRM oficial del ${q.tasa.vigente_desde}` : q.tasa.fuente === 'CONFIGURADA' ? 'la tasa fijada por Omnegia' : 'la moneda del proveedor'} ({cop(q.tasa.valor)} por dólar){q.tasa.colchon_pct ? ` más ${q.tasa.colchon_pct} % de cobertura cambiaria` : ''}.
              {q.margen_pct > 0 ? ` Incluye el margen de Omnegia (${q.margen_pct} %): ${cop(q.margen.activacion + q.margen.mensual)} hoy y ${cop(q.margen.mensual)} cada mes.` : ' Omnegia no suma margen sobre el costo del número.'}
            </p>
          </div>
          <div className="num-separados">
            <div><Icon n="suscripcion" className="" size={16} /><span><b>Tu plan de Omnegia{op?.plan ? ` (${op.plan.nombre})` : ''}</b>{op?.plan ? `: ${cop(op.plan.precio_mensual)} al mes, ` : ': '}se paga aparte en Suscripción. Esta compra no lo cambia.</span></div>
            <div><Icon n="conversaciones" className="" size={16} /><span><b>Cargos de Meta (variables)</b>: {op?.meta.gratis ?? 'Responder dentro de las 24 horas a tus clientes no tiene cargo de Meta.'} {op?.meta.variable} {op?.meta.tarifas ? `Referencia: ${op.meta.tarifas.map((t: any) => `${t.categoria} ${cop(t.cop)}`).join(' · ')} por mensaje.` : ''} <a className="enlace" href={op?.meta.fuente} target="_blank" rel="noreferrer">Tarifa oficial de Meta</a>.</span></div>
          </div>
        </div>
      </Tarjeta>
      <Tarjeta titulo="Condiciones" className="num-resumen-condiciones">
        <div className="col" style={{ gap: 12 }}>
          <ul className="num-condiciones">
            <li><b>Renovación.</b> {c.condiciones.renovacion}</li>
            <li><b>Si no se paga.</b> {c.condiciones.gracia}</li>
            <li><b>Cancelación.</b> {c.condiciones.cancelacion}</li>
            <li><b>Reembolso.</b> {c.condiciones.reembolso}</li>
            <li><b>Activación.</b> Comprar el número y activar WhatsApp son pasos distintos. Tendrás que iniciar sesión en Meta para crear o elegir tu cuenta de WhatsApp Business; Meta puede revisar el nombre visible de tu negocio.</li>
          </ul>
          <label className="num-check"><input type="checkbox" checked={acepto.cargo} onChange={(e) => setAcepto({ ...acepto, cargo: e.target.checked })} /><span>Autorizo el cargo de hoy por <b>{cop(q.total_hoy)}</b>.</span></label>
          <label className="num-check"><input type="checkbox" checked={acepto.mensualidad} onChange={(e) => setAcepto({ ...acepto, mensualidad: e.target.checked })} /><span>Entiendo que el número cuesta <b>{cop(q.total_mensual)} al mes</b> y que debo pagarlo cada mes para conservarlo.</span></label>
          <label className="num-check"><input type="checkbox" checked={acepto.condiciones} onChange={(e) => setAcepto({ ...acepto, condiciones: e.target.checked })} /><span>Acepto las condiciones de renovación, cancelación y reembolso.</span></label>
          <Escritura permiso="subscription:manage">
            <button className={`btn primario grande num-pagar ${fase}`} disabled={!todos || fase !== 'idle'} onClick={pagar} aria-describedby="num-pagar-ayuda">
              <span className="num-pagar-txt">{fase === 'enviando' ? 'Preparando el pago seguro…' : fase === 'redirigiendo' ? 'Abriendo la pasarela…' : c.pago_pendiente ? `Continuar el pago de ${cop(q.total_hoy)}` : `Pagar ${cop(q.total_hoy)}`}</span>
              {fase !== 'idle' ? <span className="num-girando" aria-hidden="true" /> : <Icon n="candado" className="" size={16} />}
            </button>
          </Escritura>
          <span id="num-pagar-ayuda" className="tenue peq-txt">Pagas en la página segura de Wompi; Omnegia no ve ni guarda los datos de tu tarjeta. El número se compra solo cuando Wompi nos confirma el pago.</span>
        </div>
      </Tarjeta>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pasos 4–5 · activación por etapas reales
// ---------------------------------------------------------------------------
const TEXTO_SUB: Record<string, string> = {
  pago_en_proceso: 'Wompi está procesando el pago (algunos medios tardan unos minutos).',
  comprobando_disponibilidad: 'Comprobando que el número sigue disponible.',
  orden_creada: 'Orden de compra enviada al proveedor.',
  documentos_en_revision: 'El proveedor está revisando los documentos. Puede tardar algunos días hábiles; te avisaremos.',
  requisitos_rechazados: 'El proveedor rechazó un documento. Nuestro equipo ya fue alertado y te contactará para corregirlo.',
  requisitos_incompletos: 'El proveedor pide información adicional. Nuestro equipo te contactará.',
  preparando: 'Preparando la verificación con Meta.',
  esperando_llamada: 'Meta está llamando al número para dictar el código. Omnegia atiende la llamada y lo lee por ti.',
  codigo_recibido: 'Código recibido. Verificándolo con Meta.',
  codigo_incorrecto: 'Meta no aceptó el código. Pide otra llamada o escribe el código.',
  sin_codigo: 'La llamada no trajo un código legible.',
  registrando: 'Registrando el número en WhatsApp Business Platform.',
  esperando_meta: 'Meta todavía no reporta el número como conectado. Lo volvemos a consultar en unos minutos.',
  acceso_vencido: 'El acceso concedido en Meta venció. Repite el registro con Meta.',
};

function Activacion({ c, onCambio, recargar }: { c: C; onCambio: (c: C) => void; recargar: () => void }) {
  const actual = c.etapas.findIndex((e: any) => e.estado !== 'hecho');
  const conectado = c.estado === 'CONECTADO';
  const anunciado = useRef<string>('');
  const [anuncio, setAnuncio] = useState('');
  useEffect(() => {
    const clave = `${c.estado}:${c.subestado}:${c.accion_cliente}`;
    if (anunciado.current && anunciado.current !== clave) {
      const e = c.etapas[actual];
      setAnuncio(e ? `${e.titulo}: ${e.estado === 'accion' ? 'requiere tu acción' : e.estado === 'error' ? 'no se completó' : 'en curso'}` : 'Todas las etapas completadas');
    }
    anunciado.current = clave;
  }, [c.estado, c.subestado, c.accion_cliente]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col" style={{ gap: 16 }}>
      <Pasos actual={c.prueba_recibida_en ? 5 : 4} />
      {c.simulado && <div className="aviso" role="note"><Icon n="alerta" className="" size={16} />Simulación: ningún paso habla con un proveedor real ni con Meta.</div>}
      <div className="num-activacion">
        <Tarjeta titulo={conectado ? 'Tu número está conectado' : c.estado === 'CANCELACION_PENDIENTE' ? 'Cancelación programada' : 'Activando tu número'} acciones={<span className="mono peq-txt">{formatoNumero(c.numero)}</span>}>
          <ol className="num-etapas">
            {c.etapas.map((e: any, i: number) => (
              <li key={e.clave} className={`num-etapa ${e.estado} ${i === actual ? 'actual' : ''}`} style={{ '--i': i } as CSSProperties}>
                <span className="num-etapa-marca" aria-hidden="true">{e.estado === 'hecho' ? <svg viewBox="0 0 24 24" width="14" height="14"><path d="M5 12l5 5L20 7" /></svg> : e.estado === 'error' ? <Icon n="x" className="" size={14} /> : e.estado === 'accion' ? <Icon n="alerta" className="" size={13} /> : <i />}</span>
                <span className="num-etapa-txt">
                  <b>{e.titulo}</b>
                  <span className="sr"> — {e.estado === 'hecho' ? 'completada' : e.estado === 'en_curso' ? 'en curso' : e.estado === 'accion' ? 'requiere tu acción' : e.estado === 'error' ? 'con error' : 'pendiente'}</span>
                  {i === actual && c.subestado && TEXTO_SUB[c.subestado] && <small>{TEXTO_SUB[c.subestado]}</small>}
                </span>
              </li>
            ))}
          </ol>
          <div className="sr" aria-live="polite">{anuncio}</div>
        </Tarjeta>
        <div className="col" style={{ gap: 12 }} key={`${c.estado}:${c.accion_cliente}`}>
          <PanelAccion c={c} onCambio={onCambio} recargar={recargar} />
        </div>
      </div>
    </div>
  );
}

function PanelAccion({ c, onCambio, recargar }: { c: C; onCambio: (c: C) => void; recargar: () => void }) {
  const { run, ocupado } = useAccion();
  const post = async (ruta: string, cuerpo: unknown = {}, ok?: string) => { const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}${ruta}`, cuerpo), ok); if (r) onCambio(r); return r; };
  const nav = useNavigate();

  if (c.estado === 'CONECTADO') return <Conectado c={c} />;
  if (c.estado === 'CANCELACION_PENDIENTE') return null;
  if (c.estado === 'APROVISIONAMIENTO_FALLIDO') {
    return (
      <Tarjeta titulo="No pudimos comprar el número" className="num-panel err">
        <div className="col" style={{ gap: 10 }}>
          <p className="sec">{c.subestado === 'numero_no_disponible' ? 'El número se vendió a otra persona antes de completar la compra. Tu pago está confirmado: elige otro número de igual o menor precio sin pagar de nuevo, o pide el reembolso.' : c.subestado === 'precio_cambio' ? 'El proveedor subió el costo del número después de tu pago. No compramos a un precio distinto del que aceptaste: el equipo de Omnegia ya fue alertado.' : 'El proveedor no completó la compra. El equipo de Omnegia ya fue alertado.'}</p>
          {c.accion_cliente === 'elegir_otro' && <ReemplazoNumero c={c} onCambio={onCambio} />}
          <Reembolso c={c} compacto />
        </div>
      </Tarjeta>
    );
  }
  if (c.estado === 'CONEXION_FALLIDA') {
    return (
      <Tarjeta titulo="La activación en WhatsApp no se completó" className="num-panel err">
        <div className="col" style={{ gap: 10 }}>
          <p className="sec">Tu número está comprado y pagado. {c.ultimo_error ?? 'Meta no confirmó la activación.'}</p>
          <div className="fila envolver" style={{ gap: 8 }}>
            <Escritura permiso="subscription:manage"><button className="btn primario" disabled={ocupado} onClick={() => post('/reintentar', {}, 'Reintentando la activación.')}>Reintentar la activación</button></Escritura>
            <Link className="btn" to="/soporte">Escribir a soporte</Link>
          </div>
        </div>
      </Tarjeta>
    );
  }
  const puedeMeta = ['PAGO_CONFIRMADO', 'APROVISIONANDO_NUMERO', 'REGISTRO_WHATSAPP_PENDIENTE'].includes(c.estado) && !c.whatsapp.vinculado;
  return (
    <>
      {c.estado === 'PAGO_PENDIENTE' && <PagoPendiente c={c} />}
      {puedeMeta && <RegistroMeta c={c} onCambio={onCambio} adelantado={c.estado !== 'REGISTRO_WHATSAPP_PENDIENTE'} />}
      {c.estado === 'VERIFICACION_PENDIENTE' && <Verificacion c={c} post={post} ocupado={ocupado} />}
      <Tarjeta titulo="Puedes cerrar esta página" className="num-panel">
        <div className="col" style={{ gap: 8 }}>
          <span className="sec">Omnegia sigue trabajando en el servidor aunque cierres el navegador. Cuando vuelvas, verás el estado real de cada etapa; si necesitamos algo de ti, te escribimos al correo.</span>
          <div className="fila envolver" style={{ gap: 8 }}>
            <button className="btn" onClick={() => nav('/')}>Volver al panel</button>
            <button className="btn sutil" onClick={recargar}><Icon n="reloj" className="" size={14} />Consultar ahora</button>
          </div>
        </div>
      </Tarjeta>
    </>
  );
}

function PagoPendiente({ c }: { c: C }) {
  const { run, ocupado } = useAccion();
  const q = c.cotizacion;
  const abrir = async () => {
    const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}/confirmar`, { total_hoy: q.total_hoy, total_mensual: q.total_mensual, acepto_cargo: true, acepto_mensualidad: true, acepto_condiciones: true }));
    if (r) irA(r.url);
  };
  return (
    <Tarjeta titulo="Esperando la confirmación del pago" className="num-panel">
      <div className="col" style={{ gap: 8 }}>
        <span className="sec">Confirmamos el pago directamente con Wompi. Si no lo terminaste, puedes retomarlo: no se generará un segundo cobro.</span>
        <Escritura permiso="subscription:manage"><button className="btn primario" disabled={ocupado} onClick={abrir}>Continuar el pago de {cop(q.total_hoy)}</button></Escritura>
      </div>
    </Tarjeta>
  );
}

// --- Registro integrado de Meta (Embedded Signup v4, sin pantalla de número)
declare global { interface Window { FB?: any; fbAsyncInit?: () => void } }
let sdk: Promise<any> | null = null;
function cargarSdk(appId: string, version: string): Promise<any> {
  if (window.FB) return Promise.resolve(window.FB);
  sdk ??= new Promise((res, rej) => {
    window.fbAsyncInit = () => { window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version }); res(window.FB); };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/es_LA/sdk.js';
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => { sdk = null; rej(new Error('No se pudo cargar el inicio de sesión de Meta. Revisa tu conexión o desactiva el bloqueador de contenido.')); };
    document.body.appendChild(s);
  });
  return sdk;
}

function registroMeta(cfg: { app_id: string; config_id: string; version: string }): Promise<{ code: string; waba_id: string }> {
  return cargarSdk(cfg.app_id, cfg.version).then((FB) => new Promise((resolve, reject) => {
    let code: string | null = null;
    let waba: string | null = null;
    let fin = false;
    const limpiar = () => { fin = true; window.removeEventListener('message', escuchar); };
    const intentar = () => { if (!fin && code && waba) { limpiar(); resolve({ code, waba_id: waba }); } };
    function escuchar(ev: MessageEvent) {
      try { if (!/(^|\.)facebook\.com$/.test(new URL(ev.origin).hostname)) return; } catch { return; }
      let d: any = ev.data;
      try { if (typeof d === 'string') d = JSON.parse(d); } catch { return; }
      if (d?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (d.event === 'CANCEL') { limpiar(); reject(new Error(d.data?.current_step ? 'Cerraste el registro de Meta antes de terminar.' : 'Registro de Meta cancelado.')); return; }
      if (d.event === 'ERROR') { limpiar(); reject(new Error(d.data?.error_message ?? 'Meta informó un error en el registro.')); return; }
      if (d.data?.waba_id) { waba = String(d.data.waba_id); intentar(); }
    }
    window.addEventListener('message', escuchar);
    FB.login((r: any) => {
      code = r?.authResponse?.code ?? null;
      if (!code) { limpiar(); reject(new Error('No se completó el inicio de sesión en Meta.')); return; }
      intentar();
      setTimeout(() => { if (!fin) { limpiar(); reject(new Error('Meta no informó la cuenta de WhatsApp elegida. Intenta de nuevo.')); } }, 8000);
    }, { config_id: cfg.config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: 'only_waba_sharing', sessionInfoVersion: '3' } });
  }));
}

function RegistroMeta({ c, onCambio, adelantado }: { c: C; onCambio: (c: C) => void; adelantado: boolean }) {
  const [nombre, setNombre] = useState(c.nombre_visible ?? '');
  const { run, ocupado } = useAccion();
  const toast = useToast();
  const cfg = c.registro_meta;
  const iniciar = async () => {
    if (!cfg) return;
    let datos: { code: string; waba_id: string };
    if (cfg.simulado) datos = { code: `sim-${Math.random().toString(36).slice(2, 12)}`, waba_id: `sim-waba-${Math.random().toString(36).slice(2, 8)}` };
    else {
      try { datos = await registroMeta(cfg); } catch (e) { toast((e as Error).message, true); return; }
    }
    const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}/meta`, { ...datos, nombre_visible: nombre.trim() || undefined }), 'Registro con Meta confirmado.');
    if (r) onCambio(r);
  };
  return (
    <Tarjeta titulo={adelantado ? 'Adelanta el registro con Meta' : 'Conecta tu cuenta de Meta'} className={`num-panel ${adelantado ? '' : 'accion'}`}>
      <div className="col" style={{ gap: 10 }}>
        <p className="sec">{adelantado ? 'Mientras el proveedor entrega el número, puedes dejar listo este paso.' : 'Este paso es tuyo: Meta pide que el dueño del negocio inicie sesión y acepte sus condiciones.'} Se abrirá una ventana de Meta para crear o elegir tu portafolio comercial y tu cuenta de WhatsApp Business. No te pedirá el número: Omnegia lo agrega y lo verifica después.</p>
        <Campo etiqueta="Nombre visible en WhatsApp" ayuda="Meta lo revisa; debe corresponder a tu negocio.">
          <input className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} maxLength={80} minLength={3} />
        </Campo>
        {!cfg ? <div className="bloqueado"><Icon n="info" className="" size={16} />El registro integrado de Meta aún no está configurado en Omnegia. Escribe a soporte para continuar.</div> : (
          <Escritura permiso="subscription:manage">
            <button className="btn primario num-meta" disabled={ocupado || nombre.trim().length < 3} onClick={iniciar}>{ocupado ? 'Confirmando con Meta…' : cfg.simulado ? 'Simular el registro con Meta' : 'Continuar con Meta'}<Icon n="flecha" className="" size={16} /></button>
          </Escritura>
        )}
      </div>
    </Tarjeta>
  );
}

function Verificacion({ c, post, ocupado }: { c: C; post: (r: string, b?: unknown, ok?: string) => Promise<any>; ocupado: boolean }) {
  const [codigo, setCodigo] = useState('');
  const [reenviar, setReenviar] = useState('');
  const manual = c.accion_cliente === 'verificacion_manual';
  const quedan = c.verificacion.max_llamadas - c.verificacion.llamadas;
  return (
    <Tarjeta titulo={manual ? 'Necesitamos tu ayuda con el código' : 'Verificando el número con Meta'} className={`num-panel ${manual ? 'accion' : ''}`}>
      <div className="col" style={{ gap: 12 }}>
        {!manual ? (
          <div className="num-llamada" role="status"><span className="pulso ia" aria-hidden="true" /><span className="sec">{TEXTO_SUB[c.subestado] ?? 'Verificando…'}</span></div>
        ) : <p className="sec">{TEXTO_SUB[c.subestado] ?? 'La verificación necesita tu intervención.'} Puedes pedir otra llamada, reenviarla a tu celular para escuchar el código o escribirlo si ya lo tienes.</p>}
        {manual && (
          <>
            <form className="fila envolver" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); post('/verificacion/codigo', { codigo }, 'Código enviado a Meta.'); }}>
              <Campo etiqueta="Código de 6 dígitos"><input className="input mono" inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/[^\d-]/g, '').slice(0, 7))} placeholder="123456" /></Campo>
              <Escritura permiso="subscription:manage"><button className="btn primario" disabled={ocupado || codigo.replace('-', '').length !== 6}>Verificar</button></Escritura>
            </form>
            <form className="fila envolver" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); post('/verificacion/llamada', { reenviar_a: reenviar.trim() || null }, reenviar ? 'Meta volverá a llamar y la llamada se pasará a tu celular.' : 'Meta volverá a llamar al número.'); }}>
              <Campo etiqueta="Reenviar la llamada a mi celular (opcional)" ayuda={`Te quedan ${Math.max(0, quedan)} llamadas`}><input className="input mono" inputMode="tel" value={reenviar} onChange={(e) => setReenviar(e.target.value)} placeholder="+573001234567" /></Campo>
              <Escritura permiso="subscription:manage"><button className="btn" disabled={ocupado || quedan <= 0}>Pedir otra llamada</button></Escritura>
            </form>
          </>
        )}
      </div>
    </Tarjeta>
  );
}

/** Final: el número y el asistente quedan unidos; la línea se dibuja una vez y el mensaje de prueba la recorre. */
function Conectado({ c }: { c: C }) {
  const probado = !!c.prueba_recibida_en;
  const wa = `https://wa.me/${c.numero.replace(/\D/g, '')}?text=${encodeURIComponent('Hola, estoy probando mi número con Omnegia')}`;
  return (
    <Tarjeta className="num-panel ok num-final">
      <div className="col" style={{ gap: 14, alignItems: 'center', textAlign: 'center' }}>
        <div className={`num-union ${probado ? 'probado' : ''}`} aria-hidden="true">
          <span className="num-union-nodo"><Icon n="telefono" className="" size={22} /></span>
          <svg className="num-union-linea" viewBox="0 0 160 24" preserveAspectRatio="none"><path d="M2 12 C 50 -4, 110 28, 158 12" /></svg>
          {probado && <span className="num-union-mensaje" />}
          <span className="num-union-ia"><AiOrb state={probado ? 'breathing' : 'connecting'} size={64} label="Asistente de IA" /></span>
        </div>
        {probado ? (
          <>
            <MarcaExito tamano={58} />
            <h3 className="num-final-titulo">Todo funciona</h3>
            <p className="sec">Recibimos tu mensaje de prueba ({fechaHora(c.prueba_recibida_en)}) y tu asistente de IA lo está atendiendo. Tus clientes ya pueden escribirte a <b className="mono">{formatoNumero(c.numero)}</b>.</p>
            <Link className="btn primario" to="/conversaciones">Ver la conversación</Link>
          </>
        ) : (
          <>
            <h3 className="num-final-titulo">Meta confirmó tu número</h3>
            <p className="sec">Para terminar, escríbele desde tu celular a <b className="mono">{formatoNumero(c.numero)}</b>. Cuando llegue tu mensaje lo verás aquí y el asistente responderá.</p>
            <a className="btn primario" href={wa} target="_blank" rel="noreferrer">Enviar un mensaje de prueba<Icon n="enviar" className="" size={16} /></a>
            {c.whatsapp.estado_nombre && c.whatsapp.estado_nombre !== 'APPROVED' && <span className="tenue peq-txt">Meta está revisando el nombre visible ({c.whatsapp.estado_nombre === 'PENDING_REVIEW' ? 'en revisión' : c.whatsapp.estado_nombre}). Mientras tanto, tus clientes verán el número.</span>}
          </>
        )}
      </div>
    </Tarjeta>
  );
}

function ReemplazoNumero({ c, onCambio }: { c: C; onCambio: (c: C) => void }) {
  const { data: op } = useApi<any>(() => api.get('/api/t/numeros/opciones'), []);
  const [abierto, setAbierto] = useState(false);
  const opciones = useMemo(() => (op ? { ...op, paises: op.paises.filter((p: any) => p.pais === c.pais).map((p: any) => ({ ...p, tipos: p.tipos.map((t: any) => ({ ...t, elegible: t.elegible && t.tipo === c.tipo })) })) } : null), [op, c.pais, c.tipo]);
  if (!abierto) return <Escritura permiso="subscription:manage"><button className="btn primario" onClick={() => setAbierto(true)}>Elegir otro número</button></Escritura>;
  return opciones ? <Selector op={opciones} onElegido={onCambio} reemplazo={{ id: c.id, tope: { hoy: c.cotizacion.total_hoy, mensual: c.cotizacion.total_mensual } }} /> : <Cargando filas={3} />;
}

function Reembolso({ c, compacto }: { c: C; compacto?: boolean }) {
  const ref = c.pagos?.find((p: any) => p.cargo_numero === 'ACTIVACION' && p.estado === 'APROBADO')?.referencia;
  if (!ref) return null;
  const texto = <>Para pedir el reembolso, usa la referencia <b className="mono">{ref}</b> en <a className="enlace" href="/consumidor#reembolso">Protección al consumidor › Reembolsos</a>. Una persona del equipo revisa el caso dentro del plazo legal.</>;
  return compacto ? <span className="tenue peq-txt">{texto}</span> : <div className="aviso" role="status"><Icon n="info" className="" size={16} /><span>{texto}</span></div>;
}

// ---------------------------------------------------------------------------
// Gestión: número, renovación, pagos y cancelación
// ---------------------------------------------------------------------------
function Gestion({ c, onCambio }: { c: C; onCambio: (c: C) => void }) {
  const { run, ocupado } = useAccion();
  const [confirmar, setConfirmar] = useState(false);
  const diasRestantes = c.periodo_fin ? Math.ceil((new Date(c.periodo_fin).getTime() - Date.now()) / 86_400_000) : null;
  const renovar = async () => { const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}/renovar`)); if (r) irA(r.url); };
  const cancelar = async (revertir = false) => { const r = await run(() => api.post(`/api/t/numeros/contrataciones/${c.id}/cancelar`, { revertir }), revertir ? 'La cancelación quedó sin efecto.' : 'Cancelación programada.'); if (r) { onCambio(r); setConfirmar(false); } };
  const activacion = c.pagos.find((p: any) => p.cargo_numero === 'ACTIVACION' && p.estado === 'APROBADO');
  return (
    <div className="grid g2 num-gestion">
      <Tarjeta titulo="Tu número contratado" acciones={<Estado v={c.estado === 'CONECTADO' ? 'CONECTADO' : c.estado === 'CANCELACION_PENDIENTE' ? 'PENDIENTE' : 'PENDIENTE_VERIFICAR'} texto={c.estado === 'CONECTADO' ? 'Conectado' : c.estado === 'CANCELACION_PENDIENTE' ? 'Se cancela al fin del mes' : 'En activación'} />}>
        <dl className="num-datos">
          <div><dt>Número</dt><dd className="mono">{formatoNumero(c.numero)}</dd></div>
          <div><dt>Proveedor</dt><dd>{c.proveedor}</dd></div>
          <div><dt>Contratado el</dt><dd>{fechaCompleta(c.periodo_inicio)}</dd></div>
          <div><dt>{c.estado === 'CANCELACION_PENDIENTE' ? 'Activo hasta' : 'Próxima renovación'}</dt><dd>{c.periodo_fin ? fechaCompleta(c.periodo_fin) : '—'}{diasRestantes !== null && diasRestantes >= 0 && <small className="tenue"> · en {diasRestantes} {diasRestantes === 1 ? 'día' : 'días'}</small>}</dd></div>
          <div><dt>Cargo inicial</dt><dd>{activacion ? cop(activacion.monto) : '—'}</dd></div>
          <div><dt>Mensualidad del número</dt><dd>{cop(c.cotizacion.total_mensual)}</dd></div>
          <div><dt>Mensajes de WhatsApp</dt><dd className="sec peq-txt">Variables: los cobra Meta por plantilla enviada. Las respuestas dentro de 24 h no tienen cargo.</dd></div>
          <div><dt>Facturación</dt><dd>{c.gracia_hasta ? <span className="estado warn"><Icon n="alerta" className="" />Mensualidad vencida · se libera el {fechaCompleta(c.gracia_hasta)}</span> : <span className="estado ok"><Icon n="ok" className="" />Al día</span>}</dd></div>
        </dl>
        <div className="fila envolver" style={{ gap: 8, marginTop: 12 }}>
          {c.estado !== 'CANCELACION_PENDIENTE' && <Escritura permiso="subscription:manage"><button className="btn primario" disabled={ocupado || (diasRestantes !== null && diasRestantes > 10)} onClick={renovar} title={diasRestantes !== null && diasRestantes > 10 ? 'Disponible desde 10 días antes del vencimiento' : undefined}>Pagar la mensualidad</button></Escritura>}
          {c.estado === 'CANCELACION_PENDIENTE'
            ? <Escritura permiso="subscription:manage"><button className="btn" disabled={ocupado} onClick={() => cancelar(true)}>Mantener mi número</button></Escritura>
            : <Escritura permiso="subscription:manage"><button className="btn peligro" disabled={ocupado} onClick={() => setConfirmar(true)}>Cancelar el número</button></Escritura>}
        </div>
        {confirmar && (
          <div className="num-confirmar" role="alertdialog" aria-labelledby="num-cancelar-t">
            <b id="num-cancelar-t">¿Cancelar el número {formatoNumero(c.numero)}?</b>
            <span className="sec peq-txt">{c.condiciones.cancelacion} Después se libera en el proveedor y en WhatsApp; un número liberado puede no recuperarse. Tu plan de Omnegia no cambia.</span>
            <div className="fila" style={{ gap: 8 }}><button className="btn peligro" disabled={ocupado} onClick={() => cancelar()}>Sí, cancelar al fin del mes</button><button className="btn" onClick={() => setConfirmar(false)}>No</button></div>
          </div>
        )}
        {c.estado !== 'CANCELACION_PENDIENTE' && diasRestantes !== null && diasRestantes > 10 && <p className="tenue peq-txt" style={{ marginTop: 8 }}>La mensualidad se puede pagar desde 10 días antes del vencimiento.</p>}
        <p className="tenue peq-txt" style={{ marginTop: 10 }}>No hay cobros automáticos. Para cambiar de número, cancela este y contrata otro; tu plan de Omnegia se gestiona en <Link className="enlace" to="/suscripcion">Suscripción</Link>.</p>
      </Tarjeta>
      <Tarjeta titulo="Historial de pagos del número" sinCuerpo>
        {c.pagos.length === 0 ? <p className="cuerpo sec">Sin pagos todavía.</p> : (
          <div className="tabla-wrap">
            <table className="tabla tabla-movil">
              <thead><tr><th>Fecha</th><th>Concepto</th><th>Estado</th><th className="num">Valor</th></tr></thead>
              <tbody>{c.pagos.map((p: any) => (
                <tr key={p.referencia}>
                  <td data-etiqueta="Fecha">{fechaHora(p.verificado_en ?? p.creado_en)}</td>
                  <td data-etiqueta="Concepto">{p.cargo_numero === 'ACTIVACION' ? 'Activación y primer mes' : 'Mensualidad'}{p.cubre_hasta && <small className="tenue"> · hasta {fechaCompleta(p.cubre_hasta)}</small>}<br /><span className="mono tenue peq-txt">{p.referencia}</span></td>
                  <td data-etiqueta="Estado"><Estado v={p.estado === 'APROBADO' ? 'PAGADO' : p.estado} /></td>
                  <td data-etiqueta="Valor" className="num">{cop(p.monto)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="cuerpo tenue peq-txt">Los comprobantes de cada pago están en <Link className="enlace" to="/suscripcion">Suscripción › Documentos</Link>.</p>
      </Tarjeta>
    </div>
  );
}
