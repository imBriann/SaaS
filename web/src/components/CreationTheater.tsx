import { useEffect, useState, type CSSProperties } from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { Icon } from './icons';
import { AiOrb } from './AiOrb';
import { AiVoice } from './AiVoice';

/**
 * El momento «Crear con IA»: el orbe crece y, a su lado, el espacio del negocio se arma pieza por pieza.
 * Cada pieza sale de datos reales del alta (nombre, dirección, marca, funciones, catálogo) o de lo que la IA
 * ya redactó en el servidor. Lo que todavía no existe se muestra como carga en bucle, nunca como hecho.
 */
const MODULOS: Record<string, [string, string]> = {
  conversaciones: ['conversaciones', 'Conversaciones'], agenda: ['agenda', 'Agenda'], ventas: ['ventas', 'Ventas'],
  clientes: ['clientes', 'Clientes'], catalogo: ['inventario', 'Catálogo'], inventario: ['inventario', 'Inventario'],
  facturacion: ['facturacion', 'Facturación'], ia: ['ia', 'Asistente IA'], comisiones: ['persona', 'Comisiones'], membresias: ['suscripcion', 'Membresías'],
};
const ORDEN = ['conversaciones', 'agenda', 'ventas', 'clientes', 'catalogo', 'inventario', 'facturacion', 'membresias', 'comisiones', 'ia'];
const METRICAS: [string, string][] = [['ventas', 'Ventas de hoy'], ['agenda', 'Citas de hoy'], ['conversaciones', 'Conversaciones'], ['clientes', 'Clientes']];

const sinMovimiento = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Escritura progresiva de un texto que ya existe (presentación, no generación). */
function useEscrito(texto: string | null | undefined, cps = 42) {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!texto) { setN(0); return; }
    if (sinMovimiento()) { setN(texto.length); return; }
    setN(0);
    const t = window.setInterval(() => setN(v => { if (v >= texto.length) { window.clearInterval(t); return v; } return v + 1; }), 1000 / cps);
    return () => window.clearInterval(t);
  }, [texto, cps]);
  return texto ? texto.slice(0, n) : '';
}

/** Ritmo mínimo de aparición del armazón: marco, marca, navegación. No representa progreso del servidor. */
function useEscena(pasos: number, ms = 650) {
  const [n, setN] = useState(() => (sinMovimiento() ? pasos : 0));
  useEffect(() => {
    if (sinMovimiento()) return;
    const timers = Array.from({ length: pasos }, (_, i) => window.setTimeout(() => setN(i + 1), 250 + i * ms));
    return () => timers.forEach(clearTimeout);
  }, [pasos, ms]);
  return n;
}

const iniciales = (nombre: string) => nombre.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || 'TU';

/** Pausa con el espacio completo a la vista antes de entrar al panel. */
const PAUSA_FINAL_MS = 3200;

export function CreationTheater({ d, status, titulo, detalle, orbe, pasos, listo, aviso, onDescargar, descargando, reciboListo, enCurso, onCompleto }: {
  d: any; status: any; titulo: string; detalle: string; orbe: OrbState; pasos: { clave: string; nombre: string; hecho: boolean }[]; listo: boolean;
  aviso?: string | null; onDescargar: () => void; descargando: boolean; reciboListo: boolean;
  /** Textos mientras la vista previa termina de armarse aunque el servidor ya haya acabado. */
  enCurso: { title: string; detail: string }; onCompleto: () => void;
}) {
  // Ritmo mínimo: cada pieza se ve aparecer aunque el servidor responda rápido.
  const escena = useEscena(4, 900);
  const nombre = status?.tenant?.nombre ?? status?.negocio?.nombre ?? d?.negocio?.nombre ?? 'Tu negocio';
  const slug = status?.tenant?.slug ?? status?.negocio?.slug ?? d?.negocio?.slug ?? '';
  const acento = d?.tema?.acento ?? '#5847df';
  const sobreAcento = d?.tema?.texto_sobre_acento ?? '#fff';
  const modulos = ORDEN.filter(m => (d?.clasificacion?.modulos_sugeridos ?? ['clientes', 'catalogo']).includes(m));
  const catalogo = Array.isArray(d?.catalogo) ? d.catalogo.length : 0;
  const ia = status?.personalizacion ?? null;
  const direccion = useEscrito(slug ? `${slug}.omnegia` : '', 24);
  const tituloEscrito = useEscrito(escena >= 4 ? ia?.titulo : null, 26);
  const tituloCompleto = !!ia && escena >= 4 && tituloEscrito.length === ia.titulo.length;
  const metricas = METRICAS.filter(([m]) => modulos.includes(m)).slice(0, 3);
  const [conDescripcion, setConDescripcion] = useState(false);
  const [conTarjetas, setConTarjetas] = useState(false);
  const [revelado, setRevelado] = useState(false);
  useEffect(() => { if (!tituloCompleto) return; const t = window.setTimeout(() => setConDescripcion(true), sinMovimiento() ? 0 : 600); return () => window.clearTimeout(t); }, [tituloCompleto]);
  useEffect(() => { if (!conDescripcion) return; const t = window.setTimeout(() => setConTarjetas(true), sinMovimiento() ? 0 : 1100); return () => window.clearTimeout(t); }, [conDescripcion]);
  useEffect(() => {
    if (!conTarjetas) return;
    const t = window.setTimeout(() => setRevelado(true), sinMovimiento() ? 0 : (ia?.prioridades?.length ?? 3) * 450 + 900);
    return () => window.clearTimeout(t);
  }, [conTarjetas, ia?.prioridades?.length]);
  // «Listo» solo cuando el servidor terminó Y la vista previa terminó de armarse.
  const completo = listo && revelado;
  useEffect(() => {
    if (!completo) return;
    const t = window.setTimeout(onCompleto, sinMovimiento() ? 0 : PAUSA_FINAL_MS);
    return () => window.clearTimeout(t);
  }, [completo]); // eslint-disable-line react-hooks/exhaustive-deps
  const tituloVisible = listo && !completo ? enCurso.title : titulo;
  const detalleVisible = listo && !completo ? enCurso.detail : detalle;

  return <section className={`theater ${completo ? 'is-ready' : ''}`} aria-labelledby="creation-title" aria-busy={!completo}>
    <div className="theater-top">
      <span className="theater-paid"><Icon n="ok" size={15} className="" />Pago confirmado</span>
      <button type="button" className="theater-receipt" disabled={!reciboListo || descargando} onClick={onDescargar}><Icon n="descargar" size={15} className="" />{descargando ? 'Preparando…' : reciboListo ? 'Descargar recibo y documentos' : 'Recibo en preparación'}</button>
    </div>
    <div className="theater-grid">
      <div className="theater-mind finish-creation-live">
        <div className="theater-orb" aria-hidden="true"><span className="theater-halo" /><span className="theater-halo" /><span className="theater-halo" />
          <div className="theater-orb-canvas"><AiOrb state={completo ? 'shaping' : listo ? 'weaving' : orbe} size={64} theme="dark" label={tituloVisible} /></div>
        </div>
        <h2 id="creation-title" key={tituloVisible} className="theater-title">{tituloVisible}</h2>
        <div className="theater-voice"><AiVoice texto={detalleVisible} /></div>
        {ia?.motor === 'simulador' && <p className="finish-mode">Entorno de demostración · análisis simulado</p>}
        <ul className="theater-steps" aria-label="Configuración guardada en el servidor">
          {pasos.map(p => <li key={p.clave} className={p.hecho ? 'is-complete' : ''}><span aria-hidden="true">{p.hecho ? <Icon n="ok" size={12} className="" /> : <i />}</span>{p.nombre}<span className="sr">{p.hecho ? ': guardado' : ': pendiente'}</span></li>)}
        </ul>
        {aviso && <p className="finish-return-note">{aviso}</p>}
      </div>

      <figure className="blueprint" aria-label={`Vista previa en vivo del espacio de ${nombre}`} style={{ '--bp-acento': acento, '--bp-sobre': sobreAcento } as CSSProperties}>
        <div className="bp-bar"><i /><i /><i /><span className="bp-url"><Icon n="candado" size={12} className="" />{direccion || <span className="bp-skel bp-skel-url" />}{direccion && direccion.length < slug.length + 8 && <b className="bp-caret" />}</span></div>
        <div className="bp-body">
          <aside className={`bp-side ${escena >= 1 ? 'in' : ''}`}>
            <div className="bp-brand">{d?.logo_data_url ? <img src={d.logo_data_url} alt="" /> : <span className="bp-mark">{iniciales(nombre)}</span>}<b>{nombre}</b></div>
            <ul>{modulos.map((m, i) => <li key={m} className={escena >= 2 ? 'in' : ''} style={{ '--i': i } as CSSProperties}><Icon n={MODULOS[m][0]} size={15} className="" />{MODULOS[m][1]}</li>)}</ul>
          </aside>
          <div className="bp-main">
            <div className="bp-head">
              {ia ? <h3>{tituloEscrito}{!tituloCompleto && <b className="bp-caret" />}</h3>
                : <div className="bp-writing"><ThinkingOrb state="composing" size={20} theme="light" aria-hidden="true" /><span>La IA está escribiendo el inicio de {nombre}…</span></div>}
              {ia && conDescripcion ? <p className="bp-desc">{ia.descripcion}</p> : <div className="bp-lines" aria-hidden="true"><span className="bp-skel" /><span className="bp-skel short" /></div>}
            </div>
            <div className="bp-prios">
              {(ia && conTarjetas ? ia.prioridades : [0, 1, 2]).map((p: any, i: number) => typeof p === 'number'
                ? <div key={`s${i}`} className="bp-card is-skeleton" aria-hidden="true"><span className="bp-skel tiny" /><span className="bp-skel" /><span className="bp-skel short" /></div>
                : <div key={p.modulo} className="bp-card in" style={{ '--i': i } as CSSProperties}><span className="bp-card-ico"><Icon n={MODULOS[p.modulo]?.[0] ?? 'ia'} size={16} className="" /></span><strong>{p.titulo}</strong><span>{p.descripcion}</span></div>)}
            </div>
            <div className={`bp-metrics ${escena >= 3 ? 'in' : ''}`}>
              {metricas.map(([m, label], i) => <div key={m} className={`bp-metric ${completo ? 'is-ready' : ''}`} style={{ '--i': i } as CSSProperties}><span>{label}</span>{completo ? <b>0</b> : <span className="bp-skel tiny" />}</div>)}
              <div className={`bp-metric ${completo ? 'is-ready' : ''}`} style={{ '--i': metricas.length } as CSSProperties}><span>Catálogo</span>{completo ? <b>{catalogo}</b> : <span className="bp-skel tiny" />}</div>
            </div>
          </div>
        </div>
        <figcaption>{completo ? <><Icon n="ok" size={14} className="" />Tu espacio está creado. Entrando…</> : 'Vista previa en vivo · se completa con lo que la IA y el servidor confirman'}</figcaption>
      </figure>
    </div>
  </section>;
}
