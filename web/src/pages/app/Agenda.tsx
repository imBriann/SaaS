import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, cop, fechaLarga, hoyLocal, zona } from '../../api';
import { Cabecera, Escritura, useSesion } from '../../components/Layout';
import { Campo, Cargando, Confirmar, ErrorCarga, Modal, useAccion, useApi, useRetardo, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';

/**
 * Calendario de la agenda. Construido en casa (sin librería) para no inflar el paquete y usar los tokens de
 * color de la empresa. Vistas Día (columnas por recurso), Semana, Mes y Lista (celular). Arrastrar mueve una cita
 * y estirar su borde cambia la duración: el cambio pasa por el mismo motor de disponibilidad del servidor; si
 * choca, vuelve a su lugar con un aviso. El estado se ve con forma y etiqueta, no solo con color.
 */
type Vista = 'dia' | 'semana' | 'mes' | 'lista';
const VISTAS: [Vista, string][] = [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes'], ['lista', 'Lista']];
const ESTADO: Record<string, { t: string; i: string; c: string }> = {
  RESERVADA: { t: 'Reservada', i: 'reloj', c: 'reservada' }, CONFIRMADA: { t: 'Confirmada', i: 'ok', c: 'confirmada' },
  ATENDIDA: { t: 'Atendida', i: 'ok', c: 'atendida' }, NO_ASISTIO: { t: 'No asistió', i: 'x', c: 'no-asistio' }, CANCELADA: { t: 'Cancelada', i: 'x', c: 'cancelada' },
};
const DIAS = ['dom', 'lun', 'mar', 'mie', 'jue', 'vie', 'sab'];
const PALETA = ['#2f6fdf', '#b4469b', '#1f8a70', '#c4651a', '#6b4fd8', '#a33a3a', '#2b8aa8', '#7a7a1f'];
const PX_MIN = 1.4; // píxeles por minuto en Día y Semana
const PASO = 15;

// ---------------------------------------------------------------- fechas en la zona del negocio
const partes = (d: Date, tz: string) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
/** Fecha local (AAAA-MM-DD) y minuto del día de un instante. */
export function aLocal(iso: string | Date, tz = zona()) {
  const p = partes(new Date(iso), tz);
  return { fecha: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}
/** Instante UTC (ISO) de una fecha local y minuto del día en la zona del negocio. */
export function aUtc(fecha: string, min: number, tz = zona()) {
  const base = Date.UTC(Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)) - 1, Number(fecha.slice(8, 10)), Math.floor(min / 60), min % 60);
  const l = aLocal(new Date(base), tz);
  const delta = (Date.UTC(Number(l.fecha.slice(0, 4)), Number(l.fecha.slice(5, 7)) - 1, Number(l.fecha.slice(8, 10))) + l.min * 60000) - base;
  return new Date(base - delta).toISOString();
}
const sumar = (fecha: string, n: number) => { const d = new Date(`${fecha}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (fecha: string) => new Date(`${fecha}T12:00:00Z`).getUTCDay();
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const aMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
const corta = (fecha: string) => new Date(`${fecha}T12:00:00Z`).toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });

function rangoDe(vista: Vista, f: string) {
  if (vista === 'dia') return { desde: f, hasta: f };
  if (vista === 'semana' || vista === 'lista') { const lunes = sumar(f, -((dow(f) + 6) % 7)); return { desde: lunes, hasta: sumar(lunes, 6) }; }
  const primero = `${f.slice(0, 7)}-01`;
  const desde = sumar(primero, -((dow(primero) + 6) % 7));
  return { desde, hasta: sumar(desde, 41) };
}

const enMovil = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;

export function Agenda() {
  const { s, puede } = useSesion();
  const toast = useToast();
  const [vista, setVista] = useState<Vista>(() => (enMovil() ? 'lista' : 'dia'));
  const [fecha, setFecha] = useState(hoyLocal());
  const [colorPor, setColorPor] = useState<'servicio' | 'recurso'>('recurso');
  const [fRecurso, setFRecurso] = useState('');
  const [fServicio, setFServicio] = useState('');
  const [q, setQ] = useState('');
  const qr = useRetardo(q, 250);
  const [detalle, setDetalle] = useState<string | null>(null);
  const [crear, setCrear] = useState<{ fecha: string; min: number; recurso?: string } | null>(null);
  const [bloquear, setBloquear] = useState(false);
  const [ajustes, setAjustes] = useState(false);
  const [mover, setMover] = useState<{ cita: any; inicio: string; recurso: string; duracion: number } | null>(null);
  const [recursoMovil, setRecursoMovil] = useState('');
  const r = rangoDe(vista, fecha);
  const { data, error, recargar } = useApi<any>(() => api.get(`/api/t/agenda/rango?desde=${r.desde}&hasta=${r.hasta}`), [r.desde, r.hasta], { cada: 30000 });
  const tz = data?.zona ?? zona();

  const colores = useMemo(() => {
    const m = new Map<string, string>();
    (data?.recursos ?? []).forEach((x: any, i: number) => m.set(`r:${x.id}`, x.color ?? PALETA[i % PALETA.length]));
    (data?.servicios ?? []).forEach((x: any, i: number) => m.set(`s:${x.id}`, PALETA[(i + 3) % PALETA.length]));
    return m;
  }, [data]);
  const citas: any[] = useMemo(() => (data?.citas ?? []).filter((c: any) =>
    (!fRecurso || c.resource_id === fRecurso) && (!fServicio || c.product_id === fServicio) && (!qr || String(c.cliente).toLowerCase().includes(qr.toLowerCase()))), [data, fRecurso, fServicio, qr]);
  const colorDe = (c: any) => colores.get(colorPor === 'recurso' ? `r:${c.resource_id}` : `s:${c.product_id}`) ?? PALETA[0];

  const paso = vista === 'dia' ? 1 : vista === 'mes' ? 30 : 7;
  const titulo = vista === 'dia' ? fechaLarga(fecha) : vista === 'mes' ? new Date(`${fecha}T12:00:00Z`).toLocaleDateString('es-CO', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : `${corta(r.desde)} – ${corta(r.hasta)}`;

  const soltar = (cita: any, nuevoInicio: string, recurso: string, duracion: number) => {
    const misma = nuevoInicio === new Date(cita.inicio).toISOString() && recurso === cita.resource_id && duracion === Math.round((new Date(cita.fin).getTime() - new Date(cita.inicio).getTime()) / 60000);
    if (!misma) setMover({ cita, inicio: nuevoInicio, recurso, duracion });
  };

  return (
    <>
      <Cabecera titulo="Agenda" sub={titulo}>
        <div className="fila envolver ag-nav" style={{ gap: 6 }}>
          <button className="btn" onClick={() => setFecha(hoyLocal())}>Hoy</button>
          <button className="btn sutil" aria-label="Anterior" onClick={() => setFecha(sumar(fecha, -paso))}><Icon n="atras" className="" size={16} /></button>
          <button className="btn sutil" aria-label="Siguiente" onClick={() => setFecha(sumar(fecha, paso))}><Icon n="derecha" className="" size={16} /></button>
          <input className="input" type="date" value={fecha} onChange={(e) => e.target.value && setFecha(e.target.value)} aria-label="Ir a la fecha" />
        </div>
        <Escritura permiso="appointment:create" modulo="agenda"><button className="btn primario" onClick={() => setCrear({ fecha, min: 9 * 60 })}><Icon n="mas" className="" size={16} />Nueva cita</button></Escritura>
      </Cabecera>
      <div className="contenido agenda-nueva">
        <div className="ag-barra fila entre envolver">
          <div className="tabs" role="group" aria-label="Vista del calendario">{VISTAS.map(([k, t]) => <button key={k} className={vista === k ? 'on' : ''} aria-pressed={vista === k} onClick={() => setVista(k)}>{t}</button>)}</div>
          <div className="fila envolver" style={{ gap: 6 }}>
            <label className="buscar"><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar cliente" /></label>
            <select className="input" value={fRecurso} onChange={(e) => setFRecurso(e.target.value)} aria-label="Filtrar por recurso"><option value="">Todos los recursos</option>{(data?.recursos ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>
            <select className="input" value={fServicio} onChange={(e) => setFServicio(e.target.value)} aria-label="Filtrar por servicio"><option value="">Todos los servicios</option>{(data?.servicios ?? []).map((x: any) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>
            <select className="input" value={colorPor} onChange={(e) => setColorPor(e.target.value as any)} aria-label="Color por"><option value="recurso">Color por recurso</option><option value="servicio">Color por servicio</option></select>
            <Escritura permiso="tenant:configure"><button className="btn" onClick={() => setBloquear(true)}><Icon n="candado" className="" size={16} />Bloquear horas</button></Escritura>
            <Escritura permiso="tenant:configure"><button className="btn sutil" onClick={() => setAjustes(true)}><Icon n="configuracion" className="" size={16} />Reglas de la agenda</button></Escritura>
          </div>
        </div>
        {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <div className="tarjeta"><Cargando filas={8} /></div> : <>
          {(vista === 'dia') && <Resumen data={data} fecha={fecha} citas={citas} />}
          {vista === 'dia' && (
            <>
              {enMovil() && data.recursos.length > 1 && <select className="input" value={recursoMovil || data.recursos[0].id} onChange={(e) => setRecursoMovil(e.target.value)} aria-label="Recurso a mostrar">{data.recursos.map((x: any) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select>}
              <Rejilla dias={[fecha]} columnas={(fRecurso ? data.recursos.filter((x: any) => x.id === fRecurso) : enMovil() && data.recursos.length > 1 ? data.recursos.filter((x: any) => x.id === (recursoMovil || data.recursos[0].id)) : data.recursos).map((x: any) => ({ fecha, recurso: x }))}
                data={data} citas={citas} tz={tz} colorDe={colorDe} editable={puede('appointment:create') && !s.solo_lectura} onSoltar={soltar} onAbrir={setDetalle} onCrear={(f, m, rec) => setCrear({ fecha: f, min: m, recurso: rec })} />
            </>
          )}
          {vista === 'semana' && (
            <Rejilla dias={Array.from({ length: 7 }, (_, i) => sumar(r.desde, i))} columnas={Array.from({ length: 7 }, (_, i) => ({ fecha: sumar(r.desde, i), recurso: null }))}
              data={data} citas={citas} tz={tz} colorDe={colorDe} editable={puede('appointment:create') && !s.solo_lectura} onSoltar={soltar} onAbrir={setDetalle} onCrear={(f, m) => setCrear({ fecha: f, min: m })} />
          )}
          {vista === 'mes' && <Mes desde={r.desde} mes={fecha.slice(0, 7)} data={data} citas={citas} colorDe={colorDe} onAbrir={setDetalle} onDia={(f) => { setFecha(f); setVista('dia'); }} />}
          {vista === 'lista' && <Lista desde={r.desde} citas={citas} festivos={data.festivos} colorDe={colorDe} onAbrir={setDetalle} />}
          <p className="nota-pie"><Icon n="info" className="" size={14} />Arrastra una cita para moverla o estira su borde inferior para cambiar la duración. Con el teclado, abre la cita y usa «Reprogramar».</p>
        </>}
      </div>
      {detalle && <DetalleCita id={detalle} onCerrar={() => setDetalle(null)} onCambio={recargar} />}
      {crear && data && <CrearCita inicial={crear} data={data} tz={tz} onCerrar={() => setCrear(null)} onHecho={() => { setCrear(null); recargar(); }} />}
      {bloquear && data && <Bloquear data={data} fecha={fecha} tz={tz} onCerrar={() => setBloquear(false)} onHecho={() => { setBloquear(false); recargar(); }} />}
      {ajustes && <AjustesAgenda onCerrar={() => setAjustes(false)} onHecho={() => { setAjustes(false); recargar(); }} />}
      {mover && <MoverCita m={mover} data={data} tz={tz} onCerrar={() => { setMover(null); recargar(); }} onError={(msg) => { setMover(null); toast(msg, true); recargar(); }} />}
    </>
  );
}

// ---------------------------------------------------------------- resumen del día
function Resumen({ data, fecha, citas }: { data: any; fecha: string; citas: any[] }) {
  const dia = DIAS[dow(fecha)];
  const vivas = citas.filter((c) => c.fecha === fecha && !['CANCELADA'].includes(c.estado));
  const filas = data.recursos.map((rc: any) => {
    const h = rc.horario?.[dia];
    const total = h ? aMin(h[1]) - aMin(h[0]) - (rc.descanso ? aMin(rc.descanso.fin) - aMin(rc.descanso.inicio) : 0) : 0;
    const ocupado = vivas.filter((c) => c.resource_id === rc.id).reduce((s, c) => s + (new Date(c.fin).getTime() - new Date(c.inicio).getTime()) / 60000, 0);
    return { id: rc.id, nombre: rc.nombre, pct: total ? Math.min(100, Math.round((ocupado / total) * 100)) : null, libres: total ? Math.max(0, Math.floor((total - ocupado) / 30)) : 0 };
  });
  const festivo = data.festivos.find((f: any) => f.fecha === fecha);
  return (
    <div className="ag-resumen" aria-label="Resumen del día">
      <span><b>{vivas.length}</b> {vivas.length === 1 ? 'cita' : 'citas'}</span>
      <span><b>{filas.reduce((s: number, f: any) => s + f.libres, 0)}</b> huecos de 30 min libres</span>
      {festivo && <span className="estado neutro">Festivo: {festivo.nombre}</span>}
      {filas.map((f: any) => f.pct !== null && <span key={f.id} className="ag-ocupacion" title={`Ocupación de ${f.nombre}`}>{f.nombre}<i style={{ '--pct': `${f.pct}%` } as CSSProperties} aria-hidden="true" />{f.pct}%</span>)}
    </div>
  );
}

// ---------------------------------------------------------------- rejilla Día / Semana
interface Columna { fecha: string; recurso: any | null }

function Rejilla({ columnas, data, citas, tz, colorDe, editable, onSoltar, onAbrir, onCrear }: {
  dias: string[]; columnas: Columna[]; data: any; citas: any[]; tz: string; colorDe: (c: any) => string; editable: boolean;
  onSoltar: (c: any, inicio: string, recurso: string, dur: number) => void; onAbrir: (id: string) => void; onCrear: (fecha: string, min: number, recurso?: string) => void;
}) {
  const fechas = [...new Set(columnas.map((c) => c.fecha))];
  const rangos = data.recursos.flatMap((rc: any) => fechas.map((f) => rc.horario?.[DIAS[dow(f)]]).filter(Boolean)) as [string, string][];
  const abre = Math.floor((rangos.length ? Math.min(...rangos.map((x) => aMin(x[0]))) : 8 * 60) / 60) * 60;
  const cierra = Math.ceil((rangos.length ? Math.max(...rangos.map((x) => aMin(x[1]))) : 19 * 60) / 60) * 60;
  const alto = (cierra - abre) * PX_MIN;
  const cuerpo = useRef<HTMLDivElement>(null);
  const [ahora, setAhora] = useState(() => aLocal(new Date(), tz));
  useEffect(() => { const t = setInterval(() => setAhora(aLocal(new Date(), tz)), 60_000); return () => clearInterval(t); }, [tz]);
  const [arrastre, setArrastre] = useState<{ id: string; dMin: number; col: number; dDur: number } | null>(null);

  const enColumna = (c: any, col: Columna) => c.fecha === col.fecha && (!col.recurso || c.resource_id === col.recurso.id);
  const colorFondo = (col: Columna) => {
    if (!col.recurso) return null;
    const h = col.recurso.horario?.[DIAS[dow(col.fecha)]];
    return h ? { a: aMin(h[0]), b: aMin(h[1]), d: col.recurso.descanso } : null;
  };

  const iniciarArrastre = (e: RPointerEvent, c: any, colIdx: number, modo: 'mover' | 'estirar') => {
    if (!editable || !['RESERVADA', 'CONFIRMADA'].includes(c.estado)) return;
    e.preventDefault(); e.stopPropagation();
    const y0 = e.clientY;
    let movido = false;
    const ancho = (cuerpo.current?.querySelector('.ag-col') as HTMLElement | null)?.offsetWidth ?? 120;
    const x0 = e.clientX;
    const mover = (ev: PointerEvent) => {
      const dMin = Math.round((ev.clientY - y0) / PX_MIN / PASO) * PASO;
      const dCol = modo === 'mover' ? Math.round((ev.clientX - x0) / ancho) : 0;
      if (Math.abs(ev.clientY - y0) > 4 || Math.abs(ev.clientX - x0) > 4) movido = true;
      setArrastre({ id: c.id, dMin: modo === 'mover' ? dMin : 0, dDur: modo === 'estirar' ? dMin : 0, col: Math.max(0, Math.min(columnas.length - 1, colIdx + dCol)) });
    };
    const fin = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', mover);
      window.removeEventListener('pointerup', fin);
      setArrastre(null);
      if (!movido) { onAbrir(c.id); return; }
      const dMin = Math.round((ev.clientY - y0) / PX_MIN / PASO) * PASO;
      const dur0 = Math.round((new Date(c.fin).getTime() - new Date(c.inicio).getTime()) / 60000);
      const destino = columnas[Math.max(0, Math.min(columnas.length - 1, colIdx + (modo === 'mover' ? Math.round((ev.clientX - x0) / ancho) : 0)))];
      const l = aLocal(c.inicio, tz);
      const nuevoMin = modo === 'mover' ? l.min + dMin : l.min;
      const dur = modo === 'estirar' ? Math.max(PASO, dur0 + dMin) : dur0;
      onSoltar(c, aUtc(destino.fecha, nuevoMin, tz), destino.recurso?.id ?? c.resource_id, dur);
    };
    window.addEventListener('pointermove', mover);
    window.addEventListener('pointerup', fin);
  };

  return (
    <div className="ag-rejilla tarjeta" role="grid" aria-label="Calendario">
      <div className="ag-cabeceras" style={{ gridTemplateColumns: `56px repeat(${columnas.length}, minmax(110px, 1fr))` }}>
        <span />
        {columnas.map((col, i) => {
          const fest = data.festivos.find((f: any) => f.fecha === col.fecha);
          return <span key={i} className="ag-cab" role="columnheader">{col.recurso ? <><i className="ag-punto" style={{ background: col.recurso.color ?? PALETA[i % PALETA.length] }} />{col.recurso.nombre}</> : <>{corta(col.fecha)}{fest && <small className="tenue"> · {fest.nombre}</small>}</>}</span>;
        })}
      </div>
      <div className="ag-cuerpo" ref={cuerpo} style={{ gridTemplateColumns: `56px repeat(${columnas.length}, minmax(110px, 1fr))`, height: alto }}>
        <div className="ag-horas">{Array.from({ length: (cierra - abre) / 60 }, (_, i) => <span key={i} style={{ top: i * 60 * PX_MIN }}>{hhmm(abre + i * 60)}</span>)}</div>
        {columnas.map((col, ci) => {
          const h = colorFondo(col);
          const fest = data.festivos.find((f: any) => f.fecha === col.fecha);
          const bloqueos = data.bloqueos.filter((b: any) => (!b.resource_id || !col.recurso || b.resource_id === col.recurso.id)).map((b: any) => {
            const a = aLocal(b.desde, tz), z = aLocal(b.hasta, tz);
            if (a.fecha > col.fecha || z.fecha < col.fecha) return null;
            const ini = a.fecha < col.fecha ? abre : Math.max(abre, a.min);
            const finM = z.fecha > col.fecha ? cierra : Math.min(cierra, z.min);
            return finM > ini ? { ...b, ini, fin: finM } : null;
          }).filter(Boolean);
          return (
            <div key={ci} className="ag-col" data-col={ci} onClick={(e) => {
              if (!editable || (e.target as HTMLElement).closest('.ag-cita, .ag-bloqueo')) return;
              const y = e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top;
              onCrear(col.fecha, abre + Math.floor(y / PX_MIN / PASO) * PASO, col.recurso?.id);
            }}>
              {Array.from({ length: (cierra - abre) / 30 }, (_, i) => <i key={i} className={`ag-linea ${i % 2 ? 'media' : ''}`} style={{ top: i * 30 * PX_MIN }} />)}
              {h && <>
                {h.a > abre && <div className="ag-fuera" style={{ top: 0, height: (h.a - abre) * PX_MIN }} aria-hidden="true" />}
                {h.b < cierra && <div className="ag-fuera" style={{ top: (h.b - abre) * PX_MIN, height: (cierra - h.b) * PX_MIN }} aria-hidden="true" />}
                {h.d && <div className="ag-bloqueo descanso" style={{ top: (aMin(h.d.inicio) - abre) * PX_MIN, height: (aMin(h.d.fin) - aMin(h.d.inicio)) * PX_MIN }}><span>Descanso</span></div>}
              </>}
              {col.recurso && !h && <div className="ag-fuera" style={{ top: 0, height: alto }}><span className="ag-fuera-txt">No atiende</span></div>}
              {fest && data.ajustes?.usar_festivos && <div className="ag-bloqueo" style={{ top: 0, height: alto }}><span>Festivo: {fest.nombre}</span></div>}
              {bloqueos.map((b: any) => <div key={b.id} className="ag-bloqueo" style={{ top: (b.ini - abre) * PX_MIN, height: (b.fin - b.ini) * PX_MIN }} title={b.motivo}><span>{b.motivo}</span></div>)}
              {col.fecha === ahora.fecha && ahora.min >= abre && ahora.min <= cierra && <div className="ag-ahora" style={{ top: (ahora.min - abre) * PX_MIN }} aria-label={`Ahora ${hhmm(ahora.min)}`} />}
              {citas.filter((c) => enColumna(c, col)).map((c) => {
                const l = aLocal(c.inicio, tz);
                const dur = Math.round((new Date(c.fin).getTime() - new Date(c.inicio).getTime()) / 60000);
                const a = arrastre?.id === c.id ? arrastre : null;
                if (a && a.col !== ci) return null;
                const est = ESTADO[c.estado] ?? ESTADO.RESERVADA;
                return (
                  <button key={c.id} type="button" className={`ag-cita ${est.c} ${a ? 'arrastrando' : ''}`}
                    style={{ top: (l.min + (a?.dMin ?? 0) - abre) * PX_MIN, height: Math.max(22, (dur + (a?.dDur ?? 0)) * PX_MIN - 2), '--c': colorDe(c) } as CSSProperties}
                    onPointerDown={(e) => iniciarArrastre(e, c, ci, 'mover')} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAbrir(c.id); } }}
                    aria-label={`${c.hora} ${c.cliente}, ${c.servicio}, ${est.t}`}>
                    <span className="ag-cita-hora">{c.hora}–{c.hora_fin} <Icon n={est.i} className="" size={11} /> <span className="sr">{est.t}</span></span>
                    <b>{c.cliente}</b>
                    <span className="ag-cita-sub">{c.servicio}{!col.recurso && ` · ${c.recurso}`}</span>
                    {(c.origen === 'AGENTE' || c.origen === 'AUTOMATIZACION') && <span className="ag-insignia">{c.origen === 'AGENTE' ? 'Agendada por la IA' : 'Automatización'}</span>}
                    {['RESERVADA', 'CONFIRMADA'].includes(c.estado) && editable && <span className="ag-estirar" aria-hidden="true" onPointerDown={(e) => iniciarArrastre(e, c, ci, 'estirar')} />}
                  </button>
                );
              })}
              {arrastre && arrastre.col === ci && !citas.some((c) => c.id === arrastre.id && enColumna(c, col)) && (() => {
                const c = citas.find((x) => x.id === arrastre.id);
                if (!c) return null;
                const l = aLocal(c.inicio, tz);
                const dur = Math.round((new Date(c.fin).getTime() - new Date(c.inicio).getTime()) / 60000);
                return <div className="ag-cita fantasma" style={{ top: (l.min + arrastre.dMin - abre) * PX_MIN, height: dur * PX_MIN, '--c': colorDe(c) } as CSSProperties}><b>{c.cliente}</b></div>;
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Mes y Lista
function Mes({ desde, mes, citas, colorDe, onAbrir, onDia, data }: { desde: string; mes: string; data: any; citas: any[]; colorDe: (c: any) => string; onAbrir: (id: string) => void; onDia: (f: string) => void }) {
  const hoy = hoyLocal();
  return (
    <div className="ag-mes tarjeta" role="grid" aria-label="Mes">
      {['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map((d) => <span key={d} className="ag-mes-cab" role="columnheader">{d}</span>)}
      {Array.from({ length: 42 }, (_, i) => {
        const f = sumar(desde, i);
        const del = citas.filter((c) => c.fecha === f && c.estado !== 'CANCELADA');
        const fest = data.festivos.find((x: any) => x.fecha === f);
        return (
          <div key={f} className={`ag-mes-dia ${f.slice(0, 7) !== mes ? 'otro' : ''} ${f === hoy ? 'hoy' : ''} ${fest ? 'festivo' : ''}`} role="gridcell">
            <button className="ag-mes-num" onClick={() => onDia(f)} aria-label={`Ver el ${fechaLarga(f)}`}>{Number(f.slice(8))}</button>
            {fest && <small className="tenue">{fest.nombre}</small>}
            {del.slice(0, 3).map((c) => <button key={c.id} className="ag-chip" style={{ '--c': colorDe(c) } as CSSProperties} onClick={() => onAbrir(c.id)}>{c.hora} {c.cliente}</button>)}
            {del.length > 3 && <button className="enlace peq-txt" onClick={() => onDia(f)}>+{del.length - 3} más</button>}
          </div>
        );
      })}
    </div>
  );
}

function Lista({ desde, citas, festivos, colorDe, onAbrir }: { desde: string; citas: any[]; festivos: any[]; colorDe: (c: any) => string; onAbrir: (id: string) => void }) {
  return (
    <div className="col" style={{ gap: 12 }}>
      {Array.from({ length: 7 }, (_, i) => sumar(desde, i)).map((f) => {
        const del = citas.filter((c) => c.fecha === f);
        const fest = festivos.find((x) => x.fecha === f);
        return (
          <section key={f} className="tarjeta ag-lista-dia" aria-label={fechaLarga(f)}>
            <h3 className="cuerpo">{fechaLarga(f)}{fest && <span className="estado neutro" style={{ marginLeft: 8 }}>Festivo: {fest.nombre}</span>}</h3>
            {!del.length ? <p className="cuerpo tenue peq-txt">Sin citas.</p> : (
              <ul className="lista">{del.map((c) => {
                const est = ESTADO[c.estado] ?? ESTADO.RESERVADA;
                return <li key={c.id}><button className={`ag-lista-cita ${est.c}`} style={{ '--c': colorDe(c) } as CSSProperties} onClick={() => onAbrir(c.id)}>
                  <span className="mono">{c.hora}</span><span className="col" style={{ gap: 2, minWidth: 0 }}><b>{c.cliente}</b><span className="tenue peq-txt">{c.servicio} · {c.recurso}</span></span>
                  <span className="ag-estado"><Icon n={est.i} className="" size={12} />{est.t}</span>
                </button></li>;
              })}</ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- mover (confirmación con «Avisar al cliente»)
function MoverCita({ m, data, tz, onCerrar, onError }: { m: { cita: any; inicio: string; recurso: string; duracion: number }; data: any; tz: string; onCerrar: () => void; onError: (msg: string) => void }) {
  const [avisar, setAvisar] = useState(true);
  const { run, ocupado } = useAccion();
  const l = aLocal(m.inicio, tz);
  const rec = data?.recursos.find((x: any) => x.id === m.recurso)?.nombre ?? '';
  const confirmar = async () => {
    try {
      await api.post(`/api/t/agenda/citas/${m.cita.id}/mover`, { inicio: m.inicio, resource_id: m.recurso, duracion_min: m.duracion, avisar });
      onCerrar();
    } catch (e: any) {
      const alt = e?.details?.alternativas as any[] | undefined;
      onError(`${e?.message ?? 'No se pudo mover la cita.'}${alt?.length ? ` Libres: ${alt.slice(0, 3).map((s) => `${fechaLarga(s.fecha)} ${s.hora}`).join('; ')}.` : ''}`);
    }
  };
  return (
    <Modal titulo="Mover la cita" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado} onClick={() => run(confirmar)}>Mover</button></>}>
      <p>La cita de <b>{m.cita.cliente}</b> ({m.cita.servicio}) quedará el <b>{fechaLarga(l.fecha)}</b> a las <b>{hhmm(l.min)}</b>, {m.duracion} min{rec ? ` con ${rec}` : ''}.</p>
      <label className="fila" style={{ gap: 8 }}><input type="checkbox" checked={avisar} onChange={(e) => setAvisar(e.target.checked)} />Avisar al cliente</label>
      <p className="tenue peq-txt">El aviso sale por WhatsApp si el cliente escribió en las últimas 24 horas; si no, por plantilla aprobada o correo, o queda anotado como no enviado.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- crear con un clic
function CrearCita({ inicial, data, tz, onCerrar, onHecho }: { inicial: { fecha: string; min: number; recurso?: string }; data: any; tz: string; onCerrar: () => void; onHecho: () => void }) {
  const [q, setQ] = useState('');
  const qr = useRetardo(q, 250);
  const { data: clientes } = useApi<any>(() => api.get(`/api/t/clientes?q=${encodeURIComponent(qr)}&por_pagina=10`), [qr]);
  const [cliente, setCliente] = useState<any>(null);
  const [nuevo, setNuevo] = useState<{ nombre: string; telefono: string } | null>(null);
  const [servicio, setServicio] = useState(data.servicios[0]?.id ?? '');
  const [recurso, setRecurso] = useState(inicial.recurso ?? '');
  const [fecha, setFecha] = useState(inicial.fecha);
  const [hora, setHora] = useState(hhmm(inicial.min));
  const [notas, setNotas] = useState('');
  const { run, ocupado, error } = useAccion();
  const sv = data.servicios.find((x: any) => x.id === servicio);
  const fin = sv ? hhmm(aMin(hora) + Number(sv.duracion_min)) : '';
  const guardar = async () => {
    let cid = cliente?.id;
    if (!cid && nuevo) cid = (await api.post('/api/t/clientes', { nombre: nuevo.nombre.trim(), telefono: nuevo.telefono.trim() || null })).id;
    return api.post('/api/t/agenda/citas', { customer_id: cid, product_id: servicio, resource_id: recurso || null, inicio: aUtc(fecha, aMin(hora), tz), notas: notas.trim() || null });
  };
  return (
    <Modal titulo="Nueva cita" className="panel-lateral" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || (!cliente && !(nuevo && nuevo.nombre.trim().length >= 2)) || !servicio} onClick={async () => { const r = await run(guardar, 'Cita creada', { silencioso: true }); if (r) onHecho(); }}>Crear cita</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}{(error as any).details?.alternativas?.length ? ` Libres: ${(error as any).details.alternativas.map((s: any) => `${fechaLarga(s.fecha)} ${s.hora}`).join('; ')}.` : ''}</div>}
      {cliente ? <div className="fila entre"><span>Cliente: <b>{cliente.nombre}</b></span><button className="btn peq sutil" onClick={() => setCliente(null)}>Cambiar</button></div> : nuevo ? (
        <div className="grid g2"><Campo etiqueta="Nombre del cliente"><input className="input" value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></Campo>
          <Campo etiqueta="Teléfono" ayuda="opcional"><input className="input" value={nuevo.telefono} onChange={(e) => setNuevo({ ...nuevo, telefono: e.target.value })} /></Campo></div>
      ) : (
        <>
          <Campo etiqueta="Cliente"><input className="input" autoFocus placeholder="Busca por nombre o teléfono" value={q} onChange={(e) => setQ(e.target.value)} /></Campo>
          <ul className="lista seleccion">{(clientes?.clientes ?? []).slice(0, 6).map((c: any) => <li key={c.id}><button className="enlace" onClick={() => setCliente(c)}>{c.nombre}{c.telefono ? ` · ${c.telefono}` : ''}</button></li>)}
            <li><button className="enlace" onClick={() => setNuevo({ nombre: q, telefono: '' })}><Icon n="mas" className="" size={12} /> Cliente nuevo{q ? `: «${q}»` : ''}</button></li></ul>
        </>
      )}
      <Campo etiqueta="Servicio"><select className="input" value={servicio} onChange={(e) => setServicio(e.target.value)}>{data.servicios.map((x: any) => <option key={x.id} value={x.id}>{x.nombre} · {x.duracion_min} min · {cop(x.precio)}</option>)}</select></Campo>
      <Campo etiqueta="Recurso" ayuda="si lo dejas en automático, se asigna según tu regla"><select className="input" value={recurso} onChange={(e) => setRecurso(e.target.value)}><option value="">Automático</option>{data.recursos.map((x: any) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select></Campo>
      <div className="grid g2"><Campo etiqueta="Fecha"><input className="input" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} /></Campo>
        <Campo etiqueta="Hora" ayuda={fin ? `termina a las ${fin}` : undefined}><input className="input" type="time" step={900} value={hora} onChange={(e) => setHora(e.target.value)} /></Campo></div>
      <Campo etiqueta="Nota" ayuda="por ejemplo, nombre de la mascota"><input className="input" maxLength={500} value={notas} onChange={(e) => setNotas(e.target.value)} /></Campo>
    </Modal>
  );
}

// ---------------------------------------------------------------- detalle (panel lateral)
const AVISO: Record<string, string> = { RECORDATORIO: 'Recordatorio', SEGUIMIENTO: 'Seguimiento', INASISTENCIA: 'Invitación a reprogramar', CAMBIO_CITA: 'Aviso de cambio', LISTA_ESPERA: 'Oferta de cupo', PAGO_PENDIENTE: 'Pago pendiente' };
const CANAL: Record<string, string> = { WHATSAPP: 'WhatsApp', PLANTILLA: 'plantilla de WhatsApp', CORREO: 'correo', NINGUNO: 'no enviado' };

function DetalleCita({ id, onCerrar, onCambio }: { id: string; onCerrar: () => void; onCambio: () => void }) {
  const { data: c, error, recargar } = useApi<any>(() => api.get(`/api/t/agenda/citas/${id}`), [id]);
  const { run, ocupado } = useAccion();
  const [cancelar, setCancelar] = useState(false);
  const [reprog, setReprog] = useState<{ fecha: string; hora: string } | null>(null);
  const cambiar = async (estado: string, motivo?: string) => { const r = await run(() => api.patch(`/api/t/agenda/citas/${id}`, { estado, motivo }), 'Cita actualizada'); if (r) { recargar(); onCambio(); } };
  const viva = c && ['RESERVADA', 'CONFIRMADA'].includes(c.estado);
  return (
    <Modal titulo={c ? `${c.servicio} · ${c.hora}` : 'Cita'} className="panel-lateral" onCerrar={onCerrar}>
      {error ? <ErrorCarga error={error} /> : !c ? <Cargando filas={5} /> : (
        <div className="col" style={{ gap: 14 }}>
          <div className="fila envolver" style={{ gap: 6 }}>
            <span className={`ag-estado ${ESTADO[c.estado]?.c}`}><Icon n={ESTADO[c.estado]?.i ?? 'info'} className="" size={12} />{ESTADO[c.estado]?.t}</span>
            {c.origen === 'AGENTE' && <span className="ag-insignia">Agendada por la IA</span>}
            {c.origen === 'AUTOMATIZACION' && <span className="ag-insignia">Automatización</span>}
          </div>
          <dl className="datos-def">
            <dt>Cliente</dt><dd>{c.cliente}{c.telefono ? ` · ${c.telefono}` : ''}</dd>
            <dt>Cuándo</dt><dd>{fechaLarga(c.fecha)}, {c.hora}–{c.hora_fin}</dd>
            <dt>Con</dt><dd>{c.recurso}{c.recurso_secundario ? ` y ${c.recurso_secundario}` : ''}</dd>
            {c.notas && <><dt>Notas</dt><dd>{c.notas}</dd></>}
            {c.reprogramada_desde && <><dt>Antes</dt><dd className="tenue">Reprogramada</dd></>}
          </dl>
          {c.conversacion_id && <Link className="btn peq" to={`/conversaciones/${c.conversacion_id}`} onClick={onCerrar}><Icon n="conversaciones" className="" size={14} />Ver la conversación de WhatsApp</Link>}
          <section><h4 className="peq-txt tenue">Avisos al cliente</h4>
            {!c.avisos.length ? <p className="tenue peq-txt">Todavía no se le ha enviado ningún aviso.</p> : <ul className="lista">{c.avisos.map((a: any, i: number) => <li key={i} className="peq-txt">
              {AVISO[a.tipo] ?? a.tipo}: <b>{a.estado === 'ENVIADO' ? `enviado por ${CANAL[a.canal] ?? a.canal}` : 'no enviado'}</b>{a.motivo && a.estado !== 'ENVIADO' ? <span className="tenue"> — {a.motivo}</span> : null}</li>)}</ul>}
          </section>
          {c.historial.length > 0 && <section><h4 className="peq-txt tenue">Historial del cliente</h4><ul className="lista">{c.historial.slice(0, 5).map((h: any) => <li key={h.id} className="peq-txt fila entre"><span>{h.servicio}</span><span className="tenue">{new Date(h.inicio).toLocaleDateString('es-CO')} · {ESTADO[h.estado]?.t}</span></li>)}</ul></section>}
          {reprog && (
            <div className="grid g2">
              <Campo etiqueta="Nueva fecha"><input className="input" type="date" value={reprog.fecha} onChange={(e) => setReprog({ ...reprog, fecha: e.target.value })} /></Campo>
              <Campo etiqueta="Nueva hora"><input className="input" type="time" step={900} value={reprog.hora} onChange={(e) => setReprog({ ...reprog, hora: e.target.value })} /></Campo>
              <button className="btn primario" disabled={ocupado} onClick={async () => { const r = await run(() => api.post(`/api/t/agenda/citas/${id}/mover`, { inicio: aUtc(reprog.fecha, aMin(reprog.hora)), resource_id: c.resource_id, avisar: true }), 'Cita reprogramada'); if (r) { setReprog(null); recargar(); onCambio(); } }}>Guardar</button>
            </div>
          )}
          <Escritura permiso="appointment:create"><div className="fila envolver" style={{ gap: 6 }}>
            {c.estado === 'RESERVADA' && <button className="btn peq" disabled={ocupado} onClick={() => cambiar('CONFIRMADA')}>Confirmar</button>}
            {viva && <button className="btn peq" disabled={ocupado} onClick={() => cambiar('ATENDIDA')}>Atendida</button>}
            {viva && <button className="btn peq" disabled={ocupado} onClick={() => cambiar('NO_ASISTIO')}>No asistió</button>}
            {viva && <button className="btn peq" onClick={() => setReprog({ fecha: c.fecha, hora: c.hora })}>Reprogramar</button>}
            {viva && <button className="btn peq peligro" onClick={() => setCancelar(true)}>Cancelar</button>}
          </div></Escritura>
        </div>
      )}
      {cancelar && <Confirmar titulo="Cancelar la cita" pedirMotivo textoBoton="Cancelar cita" efecto="El cupo queda libre y se ofrece a la lista de espera." onCerrar={() => setCancelar(false)} onConfirmar={(m) => { setCancelar(false); cambiar('CANCELADA', m); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- bloqueos y reglas
function Bloquear({ data, fecha, tz, onCerrar, onHecho }: { data: any; fecha: string; tz: string; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState({ recurso: '', fecha, desde: '14:00', hasta: '19:00', motivo: '' });
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo="Bloquear horas" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || f.motivo.trim().length < 2 || f.hasta <= f.desde} onClick={async () => { const r = await run(() => api.post('/api/t/agenda/bloqueos', { resource_id: f.recurso || null, desde: aUtc(f.fecha, aMin(f.desde), tz), hasta: aUtc(f.fecha, aMin(f.hasta), tz), motivo: f.motivo.trim() }), undefined, { silencioso: true }); if (r) onHecho(); }}>Bloquear</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <p className="sec peq-txt">Por ejemplo, «Bloquear la tarde del viernes». En ese tiempo nadie puede agendar, ni la IA ni el panel.</p>
      <Campo etiqueta="Quién"><select className="input" value={f.recurso} onChange={(e) => setF({ ...f, recurso: e.target.value })}><option value="">Todo el negocio</option>{data.recursos.map((x: any) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select></Campo>
      <div className="grid g2"><Campo etiqueta="Fecha"><input className="input" type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
        <Campo etiqueta="Motivo"><input className="input" value={f.motivo} placeholder="Vacaciones, capacitación…" onChange={(e) => setF({ ...f, motivo: e.target.value })} /></Campo></div>
      <div className="grid g2"><Campo etiqueta="Desde"><input className="input" type="time" value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })} /></Campo>
        <Campo etiqueta="Hasta"><input className="input" type="time" value={f.hasta} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></Campo></div>
      {data.bloqueos.length > 0 && <section><h4 className="peq-txt tenue">Bloqueos en estas fechas</h4><ul className="lista">{data.bloqueos.map((b: any) => <li key={b.id} className="fila entre peq-txt"><span>{b.motivo} · {b.recurso ?? 'todo el negocio'} · {new Date(b.desde).toLocaleString('es-CO', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' })}</span>
        <button className="btn peq sutil" onClick={async () => { const r = await run(() => api.del(`/api/t/agenda/bloqueos/${b.id}`), 'Bloqueo quitado'); if (r) onHecho(); }}>Quitar</button></li>)}</ul></section>}
    </Modal>
  );
}

function AjustesAgenda({ onCerrar, onHecho }: { onCerrar: () => void; onHecho: () => void }) {
  const { data } = useApi<any>(() => api.get('/api/t/agenda/ajustes'), []);
  const [f, setF] = useState<any>(null);
  const { run, ocupado } = useAccion();
  useEffect(() => { if (data) { const { defecto: _d, ...resto } = data; setF(resto); } }, [data]);
  const n = (k: string) => (e: any) => setF({ ...f, [k]: Number(e.target.value) });
  return (
    <Modal titulo="Reglas de la agenda" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !f} onClick={async () => { const r = await run(() => api.patch('/api/t/agenda/ajustes', f), 'Reglas guardadas'); if (r) onHecho(); }}>Guardar</button></>}>
      {!f ? <Cargando filas={4} /> : <>
        <div className="grid g2">
          <Campo etiqueta="Anticipación mínima" ayuda="minutos"><input className="input" type="number" min={0} value={f.anticipacion_min} onChange={n('anticipacion_min')} /></Campo>
          <Campo etiqueta="Agendar hasta" ayuda="días hacia adelante"><input className="input" type="number" min={1} value={f.horizonte_dias} onChange={n('horizonte_dias')} /></Campo>
          <Campo etiqueta="Cancelar o cambiar por el chat" ayuda="hasta cuántas horas antes"><input className="input" type="number" min={0} value={f.horas_cancelacion} onChange={n('horas_cancelacion')} /></Campo>
          <Campo etiqueta="Oferta de la lista de espera" ayuda="minutos para responder"><input className="input" type="number" min={5} value={f.espera_oferta_min} onChange={n('espera_oferta_min')} /></Campo>
        </div>
        <Campo etiqueta="Las citas nuevas quedan"><select className="input" value={f.confirmacion} onChange={(e) => setF({ ...f, confirmacion: e.target.value })}><option value="CLIENTE">Reservadas hasta que el cliente confirme</option><option value="AL_CREAR">Confirmadas al crearlas</option></select></Campo>
        <Campo etiqueta="Si el cliente no pide a alguien"><select className="input" value={f.asignacion} onChange={(e) => setF({ ...f, asignacion: e.target.value })}><option value="PRIMERO_LIBRE">El primero libre</option><option value="REPARTIR">Repartir la carga del día</option><option value="PREFERIDO">El preferido del cliente</option></select></Campo>
        <Campo etiqueta="Si una cita pasa sin marcar"><select className="input" value={f.inasistencia_accion} onChange={(e) => setF({ ...f, inasistencia_accion: e.target.value })}><option value="MARCAR">Marcar «No asistió» y escribirle al cliente</option><option value="PREGUNTAR">Dejarla para que el equipo la marque</option></select></Campo>
        <label className="fila" style={{ gap: 8 }}><input type="checkbox" checked={f.usar_festivos} onChange={(e) => setF({ ...f, usar_festivos: e.target.checked })} />No agendar en festivos de Colombia</label>
      </>}
    </Modal>
  );
}
