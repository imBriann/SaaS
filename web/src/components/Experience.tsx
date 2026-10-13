import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, cop, leer } from '../api';
import { Icon } from './icons';
import { Quote } from './Quote';

// ---------------------------------------------------------------- escena «Del caos a tu negocio conectado»
/**
 * Demostración con datos de ejemplo. Las mismas siete piezas (mensajes, cita,
 * producto, venta y factura) pasan de estar dispersas a conectarse y a ocupar su
 * lugar en el panel. Solo se muestran capacidades existentes: la IA consulta
 * disponibilidad, precios y el estado de una factura; la venta descuenta
 * inventario y abre su factura electrónica. No hay llamadas de IA aquí.
 */
type Fase = 'caos' | 'conexion' | 'orden';
type Sector = 'barberia' | 'gimnasio';
type Id = 'm1' | 'm2' | 'm3' | 'cita' | 'prod' | 'venta' | 'fact';

const FASES: { k: Fase; nombre: string; texto: string }[] = [
  { k: 'caos', nombre: 'Disperso', texto: 'Así llega hoy: mensajes sin responder, citas en una libreta, ventas en un cuaderno y facturas por hacer.' },
  { k: 'conexion', nombre: 'Conectado', texto: 'Cada pieza se une a su cliente: el mensaje se vuelve cita o venta, la venta descuenta inventario y abre su factura.' },
  { k: 'orden', nombre: 'En orden', texto: 'Todo queda en tu panel: conversaciones, agenda, inventario, ventas y facturación, con cada acción registrada.' },
];

const EJEMPLOS: Record<Sector, { negocio: string; inicial: string; cliente: string; m1: string; m2: string; m3: string; cita: [string, string]; prod: [string, number]; venta: [string, string, number]; fact: string }> = {
  barberia: {
    negocio: 'Barbería de ejemplo', inicial: 'B', cliente: 'Camilo',
    m1: '¿Tienen turno mañana a las 10?', m2: '¿Cuánto vale corte + barba?', m3: '¿Me envían la factura del corte?',
    cita: ['Mañana 10:00', 'Corte + barba · con Andrés'], prod: ['Cera para peinar', 12],
    venta: ['#1042', 'Corte + barba y cera', 70000], fact: 'FE-1042',
  },
  gimnasio: {
    negocio: 'Gimnasio de ejemplo', inicial: 'G', cliente: 'Valentina',
    m1: '¿Hay cupo en spinning a las 6 p. m.?', m2: '¿Cuánto vale la mensualidad?', m3: '¿Me pasan la factura de la mensualidad?',
    cita: ['Hoy 18:00', 'Spinning · Salón principal'], prod: ['Proteína 2 lb', 10],
    venta: ['#2087', 'Mensualidad y proteína', 210000], fact: 'FE-2087',
  },
};

/** Posición dispersa: fracción del área libre (x, y) y giro en grados. */
const CAOS_ANCHO: Record<Id, [number, number, number]> = {
  m1: [0.02, 0.06, -6], cita: [0.94, 0.02, 5], m2: [0.55, 0.24, 3], prod: [0.04, 0.42, 4], venta: [0.96, 0.52, -4], m3: [0.3, 0.7, -3], fact: [0.82, 0.97, 6],
};
const CAOS_ESTRECHO: Record<Id, [number, number, number]> = {
  m1: [0, 0, -4], cita: [1, 0.14, 4], m2: [0.08, 0.29, 3], prod: [0.96, 0.43, -4], venta: [0.02, 0.58, 4], m3: [1, 0.73, -3], fact: [0.1, 1, 4],
};
const ORDEN: Id[] = ['m1', 'cita', 'm2', 'prod', 'venta', 'm3', 'fact'];
const UNIONES: [Id, Id][] = [['m1', 'cita'], ['m2', 'venta'], ['cita', 'venta'], ['prod', 'venta'], ['venta', 'fact'], ['m3', 'fact']];

function useMovimientoReducido() {
  const q = '(prefers-reduced-motion: reduce)';
  const [r, setR] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const f = () => setR(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return r;
}

function Pieza({ id, icono, cab, texto, antes, despues, refs }: { id: Id; icono: string; cab: string; texto: string; antes: string; despues: string; refs: MutableRefObject<Partial<Record<Id, HTMLDivElement | null>>> }) {
  return (
    <div className={`pieza pieza-${id.startsWith('m') ? 'msg' : id}`} ref={(el) => { refs.current[id] = el; }}>
      <span className="pieza-cab"><Icon n={icono} className="" size={13} />{cab}</span>
      <span className="pieza-txt">{texto}</span>
      <span className="pieza-estado"><span className="antes">{antes}</span><span className="despues"><Icon n="ok" className="" size={12} />{despues}</span></span>
    </div>
  );
}

function Escena() {
  const reducido = useMovimientoReducido();
  const [fase, setFase] = useState<Fase>(reducido ? 'orden' : 'caos');
  // Ciclo de reproducción: -1 = detenido; 0 = espera a que la escena entre en pantalla; >0 = «Repetir».
  // Cambiar el ciclo desmonta el anterior y su limpieza cancela TODOS sus temporizadores.
  const [ciclo, setCiclo] = useState(reducido ? -1 : 0);
  const [sector, setSector] = useState<Sector>('barberia');
  const [deBorrador, setDeBorrador] = useState(false);
  const [ancho, setAncho] = useState(0);
  const [lineas, setLineas] = useState<string[]>([]);
  const escena = useRef<HTMLDivElement>(null);
  const piezas = useRef<Partial<Record<Id, HTMLDivElement | null>>>({});
  const huecos = useRef<Partial<Record<Id, HTMLDivElement | null>>>({});
  const medida = useRef(false);
  const e = EJEMPLOS[sector];

  // Si hay un borrador con su sector ya clasificado, el ejemplo se adapta a él (sin pedir nada a la IA).
  useEffect(() => {
    const tk = leer('borrador');
    if (!tk) return;
    let vivo = true;
    api.get(`/api/onboarding/borradores/${tk}`).then((d) => {
      const s = d?.clasificacion?.sector;
      if (vivo && (s === 'barberia' || s === 'gimnasio')) { setSector(s); setDeBorrador(true); }
    }).catch(() => { /* la demostración no depende del borrador */ });
    return () => { vivo = false; };
  }, []);

  useEffect(() => { if (reducido) { setCiclo(-1); setFase('orden'); } }, [reducido]);

  useEffect(() => {
    const st = escena.current;
    if (!st) return;
    const ro = new ResizeObserver(() => setAncho(st.clientWidth));
    ro.observe(st);
    return () => ro.disconnect();
  }, []);

  // Recorrido automático: la primera vez cuando la escena entra en pantalla; después, con «Repetir».
  // Siempre termina en «En orden» y nunca se repite solo.
  useEffect(() => {
    if (ciclo < 0 || !escena.current) return;
    const t: number[] = [];
    const correr = () => {
      setFase('caos');
      t.push(window.setTimeout(() => setFase('conexion'), 1600));
      t.push(window.setTimeout(() => setFase('orden'), 4300));
    };
    let io: IntersectionObserver | null = null;
    if (ciclo === 0) {
      io = new IntersectionObserver(([x]) => { if (x.isIntersecting) { io?.disconnect(); correr(); } }, { threshold: 0.35 });
      io.observe(escena.current);
    } else correr();
    return () => { io?.disconnect(); t.forEach(clearTimeout); };
  }, [ciclo]);

  // Coloca cada pieza (FLIP manual): el destino «En orden» es el hueco real del panel, medido en el DOM.
  useLayoutEffect(() => {
    const st = escena.current;
    if (!st || !ancho) return;
    const W = st.clientWidth, H = st.clientHeight;
    const estrecho = W < 560;
    const pad = estrecho ? 12 : 16, arriba = 48, abajo = 14;
    const caos = estrecho ? CAOS_ESTRECHO : CAOS_ANCHO;
    const offset = (el: HTMLElement) => {
      let x = 0, y = 0, n: HTMLElement | null = el;
      while (n && n !== st) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent as HTMLElement | null; }
      return { x, y };
    };
    // 1) Los huecos toman la altura de su pieza a la escala de su columna.
    const escala: Partial<Record<Id, number>> = {};
    for (const id of ORDEN) {
      const p = piezas.current[id], h = huecos.current[id];
      if (!p || !h) return;
      escala[id] = Math.min(1, h.clientWidth / p.offsetWidth);
      h.style.height = `${p.offsetHeight * escala[id]!}px`;
    }
    // 2) Destinos por fase.
    const pos: Partial<Record<Id, { x: number; y: number; r: number; s: number; w: number; h: number }>> = {};
    ORDEN.forEach((id, i) => {
      const p = piezas.current[id]!, w = p.offsetWidth, h = p.offsetHeight;
      const [fx, fy, rot] = caos[id];
      const c = { x: pad + fx * (W - 2 * pad - w), y: arriba + fy * (H - arriba - abajo - h), r: rot, s: 1 };
      const o = { ...offset(huecos.current[id]!), r: 0, s: escala[id]! };
      // «Conectado»: ya a la escala de su columna, con la disposición del panel algo abierta desde su centro
      // (no se tapan entre sí); en «En orden» se asientan en el hueco y aparece el panel.
      const k = 1.07, cx = W / 2, cy = (arriba + H) / 2;
      const d = fase === 'caos' ? c : fase === 'orden' ? o : { x: cx + (o.x - cx) * k, y: cy + (o.y - cy) * k, r: rot * 0.08, s: o.s };
      pos[id] = { ...d, w, h };
      p.style.transitionDelay = medida.current && !reducido ? `${i * 45}ms` : '0ms';
      p.style.transform = `translate(${d.x}px, ${d.y}px) rotate(${d.r}deg) scale(${d.s})`;
    });
    if (!medida.current) {
      // Primera colocación: sin vuelo desde la esquina.
      st.classList.add('sin-transicion');
      void st.offsetWidth;
      st.classList.remove('sin-transicion');
      medida.current = true;
    }
    if (fase === 'caos') return setLineas([]);
    const centro = (id: Id) => { const q = pos[id]!; return { x: q.x + (q.w * q.s) / 2, y: q.y + (q.h * q.s) / 2 }; };
    setLineas(UNIONES.map(([a, b]) => {
      const A = centro(a), B = centro(b), dx = (B.x - A.x) / 2;
      return `M${A.x.toFixed(1)} ${A.y.toFixed(1)} C${(A.x + dx).toFixed(1)} ${A.y.toFixed(1)} ${(B.x - dx).toFixed(1)} ${B.y.toFixed(1)} ${B.x.toFixed(1)} ${B.y.toFixed(1)}`;
    }));
  }, [fase, ancho, sector, reducido]);

  // La intervención manual detiene el ciclo: sus temporizadores ya no pueden cambiar la fase.
  const elegir = (k: Fase) => { setCiclo(-1); setFase(k); };
  const repetir = () => setCiclo((c) => Math.max(c, 0) + 1);
  const actual = FASES.find((f) => f.k === fase)!;

  return (
    <figure className="escena-marco" aria-labelledby="escena-titulo">
      <figcaption className="sr" id="escena-titulo">Demostración con datos de ejemplo de una {sector === 'barberia' ? 'barbería' : 'gimnasio'}: mensajes, cita, producto, venta y factura pasan de estar dispersos a quedar conectados en el panel.</figcaption>
      <div className="escena" ref={escena} data-fase={fase} aria-hidden="true">
        <span className="escena-sello"><Icon n="info" className="" size={13} />Demostración · datos de ejemplo</span>
        <div className="escena-panel">
          <div className="ep-barra"><span className="ep-logo">{e.inicial}</span><b>{e.negocio}</b><span className="ep-demo">Datos de ejemplo</span></div>
          <div className="ep-cuerpo">
            <div className="ep-lateral">{['inicio', 'conversaciones', 'agenda', 'ventas', 'inventario', 'facturacion'].map((n) => <Icon key={n} n={n} className="" size={15} />)}</div>
            <div className="ep-grid">
              <div className="ep-col ep-conv"><span className="ep-tit"><Icon n="conversaciones" className="" size={12} />Conversaciones</span>{(['m1', 'm2', 'm3'] as Id[]).map((id) => <div key={id} className="hueco" ref={(el) => { huecos.current[id] = el; }} />)}</div>
              <div className="ep-col ep-agenda"><span className="ep-tit"><Icon n="agenda" className="" size={12} />Agenda</span><div className="hueco" ref={(el) => { huecos.current.cita = el; }} /><span className="ep-tit"><Icon n="inventario" className="" size={12} />Inventario</span><div className="hueco" ref={(el) => { huecos.current.prod = el; }} /></div>
              <div className="ep-col ep-ventas"><span className="ep-tit"><Icon n="ventas" className="" size={12} />Ventas</span><div className="hueco" ref={(el) => { huecos.current.venta = el; }} /><span className="ep-tit"><Icon n="facturacion" className="" size={12} />Facturación</span><div className="hueco" ref={(el) => { huecos.current.fact = el; }} /></div>
            </div>
          </div>
        </div>
        <svg className="escena-lineas" key={`${fase}-${sector}-${ancho}`} width="100%" height="100%">
          {lineas.map((d, i) => <path key={i} d={d} pathLength={1} style={{ animationDelay: `${520 + i * 70}ms` }} />)}
        </svg>
        <Pieza refs={piezas} id="m1" icono="conversaciones" cab={`WhatsApp · ${e.cliente}`} texto={e.m1} antes="Sin responder · hace 2 h" despues="IA: consultó disponibilidad" />
        <Pieza refs={piezas} id="m2" icono="conversaciones" cab="WhatsApp · cliente nuevo" texto={e.m2} antes="Sin responder" despues="IA: consultó el precio" />
        <Pieza refs={piezas} id="m3" icono="conversaciones" cab={`WhatsApp · ${e.cliente}`} texto={e.m3} antes="Sin responder" despues="IA: consultó la factura" />
        <Pieza refs={piezas} id="cita" icono="agenda" cab="Cita" texto={`${e.cita[0]} · ${e.cita[1]}`} antes="Anotada en una libreta" despues="Creada · confirmó el cliente" />
        <Pieza refs={piezas} id="prod" icono="inventario" cab="Producto" texto={e.prod[0]} antes="Conteo a mano" despues={`Existencias ${e.prod[1]} → ${e.prod[1] - 1}`} />
        <Pieza refs={piezas} id="venta" icono="ventas" cab={`Venta ${e.venta[0]}`} texto={`${e.venta[1]} · ${cop(e.venta[2])}`} antes="En el cuaderno" despues="Registrada" />
        <Pieza refs={piezas} id="fact" icono="facturacion" cab={`Factura ${e.fact}`} texto={`De la venta ${e.venta[0]}`} antes="Por hacer" despues="Validada por la DIAN" />
      </div>
      <div className="escena-mandos">
        <div className="escena-fases" role="group" aria-label="Fases de la demostración">
          {FASES.map((f, i) => <button key={f.k} type="button" aria-pressed={fase === f.k} onClick={() => elegir(f.k)}><span className="n" aria-hidden="true">{i + 1}</span>{f.nombre}</button>)}
          <button type="button" className="repetir" onClick={repetir} aria-label="Repetir la demostración desde el principio">Repetir</button>
        </div>
        <div className="escena-sector" role="group" aria-label="Sector del ejemplo">
          <span>{deBorrador ? 'Ejemplo según tu borrador' : 'Ejemplo'}</span>
          {(['barberia', 'gimnasio'] as Sector[]).map((s) => <button key={s} type="button" aria-pressed={sector === s} onClick={() => setSector(s)}>{s === 'barberia' ? 'Barbería' : 'Gimnasio'}</button>)}
        </div>
      </div>
      <p className="escena-texto" aria-live="polite">{actual.texto}</p>
    </figure>
  );
}

export function Experience() {
  return <>
    <section className="hero-caos" id="como">
      <div className="hero-copy">
        <h1>Del caos a tu negocio <em>conectado</em>.</h1>
        <p>Atiende WhatsApp, agenda, vende y factura desde un solo panel. La IA actúa solo con los permisos que tú le das.</p>
        <div className="hero-actions">
          <Link className="btn primario grande" to="/empezar">Crear mi plataforma <Icon n="flecha" className="" size={16} /></Link>
          <a className="btn grande" href="#funciones">Elegir funciones</a>
        </div>
      </div>
      <Escena />
    </section>
    <section className="business-types" aria-label="Sectores con plantilla">
      <span>Plantillas listas para</span>
      <b>Barberías y belleza</b><b>Gimnasios y bienestar</b><b>Servicios con cita</b>
    </section>
    <section className="statement-strip" id="confianza">
      <p>La IA propone. Tu negocio mantiene el control.</p>
      <ul>
        <li><Icon n="candado" className="" size={18} /><span><b>Permisos claros</b>Cada herramienta tiene un permiso y un nivel de riesgo.</span></li>
        <li><Icon n="persona" className="" size={18} /><span><b>Una persona cuando hace falta</b>Los reclamos pasan a tu equipo en el mismo chat.</span></li>
        <li><Icon n="auditoria" className="" size={18} /><span><b>Todo queda registrado</b>Cada acción tiene su recibo y su evento de auditoría.</span></li>
      </ul>
    </section>
  </>;
}

export function FeatureBuilder() {
  const [selected, setSelected] = useState<string[]>(['conversaciones', 'agenda']);
  const [catalog, setCatalog] = useState<any[]>([]);
  const [quote, setQuote] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const nav = useNavigate();
  useEffect(() => {
    let alive = true;
    api.get('/api/publico/modulos').then(r => { if (alive) setCatalog(r.modulos); }).catch(() => { if (alive) setError('No pudimos cargar las funciones. Vuelve a intentarlo.'); });
    return () => { alive = false; };
  }, [attempt]);
  useEffect(() => {
    let alive = true; setLoading(true); setError('');
    api.post('/api/publico/cotizacion', { modulos: selected }).then(r => { if (alive) setQuote(r); }).catch(() => { if (alive) setError('No pudimos calcular tu selección. Reintenta en un momento.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [selected, attempt]);
  const proceed = () => {
    if (!quote || loading || error) return;
    sessionStorage.setItem('descripcion_inicial', `Quiero configurar mi negocio con estas funciones: ${catalog.filter(f => selected.includes(f.id)).map(f => f.nombre).join(', ')}.`);
    sessionStorage.setItem('funciones_elegidas', JSON.stringify(selected));
    nav('/empezar');
  };
  const opciones = catalog.filter(m => m.precio > 0);
  return <section className="feature-builder" id="funciones">
    <div className="feature-intro"><h2>Todo lo que necesitas. Solo lo que necesitas.</h2><p>Marca las funciones que te ayudan hoy. La estimación se actualiza al instante, con cada concepto a la vista.</p></div>
    <div className="builder-layout">
      <div>
        <div className="feature-grid" aria-busy={!catalog.length && !error}>
          {!catalog.length && !error && Array.from({ length: 4 }).map((_, i) => <div key={i} className="feature-option esqueleto-op" aria-hidden="true"><div className="esqueleto" style={{ width: '40%' }} /><div className="esqueleto" style={{ width: '80%' }} /></div>)}
          {opciones.map((m) => {
            const checked = selected.includes(m.id);
            const required = !checked && quote?.modulos.includes(m.id);
            return <button key={m.id} type="button" className={`feature-option ${checked || required ? 'chosen' : ''}`} aria-pressed={!!(checked || required)} onClick={() => setSelected(old => checked ? old.filter(x => x !== m.id) : [...old, m.id])}>
              <span className="feature-top"><span className="module-icon"><Icon n={m.icono} className="" size={20} /></span><span className="feature-check" aria-hidden="true"><Icon n={checked || required ? 'ok' : 'mas'} className="" size={14} /></span></span>
              <h3>{m.nombre}</h3><p>{m.descripcion}</p><span className="feature-status">{required ? 'Necesaria para otra función elegida' : checked ? 'En tu plataforma' : 'Añadir a mi plataforma'}</span>
            </button>;
          })}
        </div>
        <p className="included-note"><Icon n="ok" className="" size={14} />Clientes y catálogo vienen incluidos en tu espacio de trabajo.</p>
      </div>
      <div className="builder-summary">
        <Quote quote={quote} loading={loading} />
        {error && <div role="alert" className="bloqueado">{error}<button className="btn peq" onClick={() => setAttempt(n => n + 1)}>Reintentar</button></div>}
        <button className="btn primario grande" disabled={!selected.length || loading || !!error || !quote} onClick={proceed}>Continuar con esta selección</button>
        <Link className="ai-alternative" to="/empezar">Prefiero describir mi negocio</Link>
      </div>
    </div>
    <section className="closing-cta">
      <h2>Menos administrar. Más hacer crecer tu negocio.</h2>
      <p>Primero describes tu negocio y revisas la propuesta. Tu panel se crea solo después de verificar el pago.</p>
      <Link className="btn primario grande" to="/empezar">Crear mi plataforma</Link>
    </section>
  </section>;
}
