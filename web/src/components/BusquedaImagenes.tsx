import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from './icons';
import { Modal, useAccion } from './ui';

/**
 * Búsqueda de fotos con IA como un proceso que se ve avanzar: entender el producto → buscar → elegir → (tú
 * confirmas) → descargar. El servidor hace el trabajo en segundo plano; aquí se consulta su estado cada segundo.
 * Nada falla en silencio: cada paso muestra lo que pasó y, si no hubo resultados, se ofrece subir una foto o
 * probar otra búsqueda.
 */
interface Paso { id: string; titulo: string; estado: 'pendiente' | 'en_curso' | 'hecho' | 'fallo'; detalle: string | null }
interface Candidata { indice: number; miniatura: string; titulo: string; autor: string | null; licencia: string | null; fuente: string | null; proveedor: string; licencia_abierta: boolean; generica: boolean; elegida: boolean }
export interface Busqueda { id: string; estado: 'EN_CURSO' | 'ESPERA_ELECCION' | 'LISTO' | 'SIN_RESULTADOS' | 'ERROR'; terminada: boolean; consulta: string | null; pasos: Paso[]; mensaje: string | null; candidatas: Candidata[]; resultado: { agregadas: number; pendientes: number } | null }

const ICONO_PASO: Record<Paso['estado'], string> = { pendiente: 'reloj', en_curso: 'refrescar', hecho: 'ok', fallo: 'alerta' };

function Pasos({ pasos, estado }: { pasos: Paso[]; estado: Busqueda['estado'] }) {
  return (
    <ol className="bi-pasos" aria-label="Avance de la búsqueda">
      {pasos.filter((p) => p.estado !== 'pendiente' || estado === 'EN_CURSO').map((p) => (
        <li key={p.id} className={`bi-paso ${p.estado}`} aria-current={p.estado === 'en_curso' ? 'step' : undefined}>
          <span className="bi-icono" aria-hidden="true"><Icon n={ICONO_PASO[p.estado]} className="" size={14} /></span>
          <span className="col" style={{ gap: 2, minWidth: 0 }}>
            <b className="peq-txt">{p.titulo}</b>
            {p.detalle && <span className="tenue peq-txt bi-detalle">{p.detalle}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Cuadrícula para elegir cuáles fotos agregar (marcadas por defecto las que eligió la IA). */
function Candidatas({ b, onAgregar, ocupado }: { b: Busqueda; onAgregar: (indices: number[]) => void; ocupado: boolean }) {
  const [sel, setSel] = useState<Set<number>>(() => new Set(b.candidatas.filter((c) => c.elegida).map((c) => c.indice)));
  const alternar = (i: number) => setSel((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <div className="col" style={{ gap: 8 }}>
      <ul className="bi-rejilla" aria-label="Fotos encontradas">
        {b.candidatas.map((c) => (
          <li key={c.indice} className={`bi-cand ${sel.has(c.indice) ? 'on' : ''}`} style={{ animationDelay: `${Math.min(c.indice, 8) * 40}ms` }}>
            <label>
              <input type="checkbox" checked={sel.has(c.indice)} onChange={() => alternar(c.indice)} aria-label={`Agregar «${c.titulo}»`} />
              <img src={c.miniatura} alt="" loading="lazy" referrerPolicy="no-referrer" />
              <span className="bi-marca" aria-hidden="true"><Icon n="ok" className="" size={12} /></span>
            </label>
            <span className="peq-txt cortar" title={c.titulo}>{c.titulo}</span>
            <span className="tenue peq-txt cortar" title={[c.licencia, c.autor].filter(Boolean).join(' · ')}>{[c.licencia, c.autor].filter(Boolean).join(' · ') || 'Sin datos de licencia'}</span>
            {c.generica && <span className="estado warn">Genérica</span>}
            {c.fuente && <a className="peq-txt" href={c.fuente} target="_blank" rel="noreferrer noopener">Ver la fuente</a>}
          </li>
        ))}
      </ul>
      <div className="fila envolver" style={{ gap: 8 }}>
        <button type="button" className="btn primario" disabled={ocupado || !sel.size} onClick={() => onAgregar([...sel].sort((a, b) => a - b))}>Agregar {sel.size || ''} {sel.size === 1 ? 'foto' : 'fotos'}</button>
        <span className="tenue peq-txt">Las que vienen de la web general quedan pendientes hasta que las apruebes.</span>
      </div>
    </div>
  );
}

/**
 * Proceso de una búsqueda. Con `productId` la inicia; con `busquedaId` retoma una existente (por ejemplo, una del
 * lote que quedó esperando elección). `onSubir` abre el selector de archivos del padre.
 */
export function ProcesoBusqueda({ productId, busquedaId, onCerrar, onCambio, onSubir }: { productId?: string; busquedaId?: string; onCerrar: () => void; onCambio: () => void; onSubir?: () => void }) {
  const [b, setB] = useState<Busqueda | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [otra, setOtra] = useState('');
  const { run, ocupado } = useAccion();
  const idRef = useRef<string | null>(busquedaId ?? null);
  const avisado = useRef(false);

  const iniciar = async (consulta?: string) => {
    if (!productId) return;
    setError(null); setB(null); avisado.current = false;
    try {
      const r = await api.post(`/api/t/catalogo/productos/${productId}/imagenes/buscar`, consulta ? { consulta } : {});
      idRef.current = r.id; setB(r);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => {
    if (productId) iniciar(); else if (busquedaId) api.get(`/api/t/catalogo/imagenes/busquedas/${busquedaId}`).then(setB).catch((e) => setError((e as Error).message));
  }, [productId, busquedaId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Consulta el estado cada segundo mientras el servidor trabaja.
  useEffect(() => {
    if (!b || b.terminada || b.estado === 'ESPERA_ELECCION') return;
    const t = setInterval(() => {
      if (!idRef.current) return;
      api.get(`/api/t/catalogo/imagenes/busquedas/${idRef.current}`).then(setB).catch((e) => setError((e as Error).message));
    }, 1000);
    return () => clearInterval(t);
  }, [b?.id, b?.estado, b?.terminada]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (b?.terminada && !avisado.current) { avisado.current = true; onCambio(); } }, [b?.terminada]); // eslint-disable-line react-hooks/exhaustive-deps

  const agregar = async (indices: number[]) => {
    const r = await run(() => api.post(`/api/t/catalogo/imagenes/busquedas/${idRef.current}/agregar`, { indices }));
    if (r) setB(r);
  };
  const sinExito = b && (b.estado === 'SIN_RESULTADOS' || b.estado === 'ERROR');
  return (
    <div className="bi-panel" role="region" aria-label="Búsqueda de fotos con IA" aria-live="polite">
      <div className="fila entre" style={{ gap: 8 }}>
        <b className="peq-txt"><Icon n="ia" className="" size={14} /> Buscando fotos con IA</b>
        <button type="button" className="btn peq sutil" onClick={onCerrar} aria-label="Cerrar la búsqueda"><Icon n="x" className="" size={12} /></button>
      </div>
      {error && <p className="error peq-txt" role="alert">{error}</p>}
      {!b && !error && <p className="tenue peq-txt">Empezando…</p>}
      {b && <Pasos pasos={b.pasos} estado={b.estado} />}
      {b?.mensaje && <p className={`bi-mensaje ${sinExito ? 'mal' : b.estado === 'LISTO' ? 'bien' : ''}`}>{b.mensaje}</p>}
      {b?.estado === 'ESPERA_ELECCION' && <Candidatas b={b} onAgregar={agregar} ocupado={ocupado} />}
      {(sinExito || b?.estado === 'ESPERA_ELECCION') && productId && (
        <form className="fila envolver" style={{ gap: 6 }} onSubmit={(e) => { e.preventDefault(); if (otra.trim().length >= 2) iniciar(otra.trim()); }}>
          <input className="input" style={{ flex: '1 1 200px' }} value={otra} maxLength={120} onChange={(e) => setOtra(e.target.value)} placeholder="Escribe qué buscar (por ejemplo, «bolsa de alimento para perro»)" aria-label="Probar otra búsqueda" />
          <button type="submit" className="btn" disabled={otra.trim().length < 2}><Icon n="buscar" className="" size={14} />Probar otra búsqueda</button>
          {sinExito && onSubir && <button type="button" className="btn" onClick={onSubir}><Icon n="subir" className="" size={14} />Subir foto</button>}
        </form>
      )}
      {b?.estado === 'LISTO' && <button type="button" className="btn peq" onClick={onCerrar}>Cerrar</button>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Completar imágenes que faltan (lote)
// ---------------------------------------------------------------------------
interface Lote { lote_id: string; total: number; terminadas: number; terminado: boolean; agregadas: number; pendientes: number; busquedas: { id: string; product_id: string; producto: string; estado: Busqueda['estado']; mensaje: string | null; pasos: Paso[]; agregadas: number; pendientes: number }[] }

export function ModalCompletarImagenes({ onCerrar, onCambio }: { onCerrar: () => void; onCambio: () => void }) {
  const [lote, setLote] = useState<Lote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  useEffect(() => {
    api.post('/api/t/catalogo/imagenes/completar').then((r) => { idRef.current = r.lote_id; setLote(r); }).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    if (!lote || lote.terminado) return;
    const t = setInterval(() => { if (idRef.current) api.get(`/api/t/catalogo/imagenes/lotes/${idRef.current}`).then(setLote).catch((e) => setError((e as Error).message)); }, 1000);
    return () => clearInterval(t);
  }, [lote?.lote_id, lote?.terminado]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (lote?.terminado) onCambio(); }, [lote?.terminado]); // eslint-disable-line react-hooks/exhaustive-deps
  const pct = lote?.total ? Math.round((lote.terminadas / lote.total) * 100) : 0;
  const recargar = () => idRef.current && api.get(`/api/t/catalogo/imagenes/lotes/${idRef.current}`).then(setLote).catch(() => undefined);
  return (
    <Modal titulo="Completar imágenes que faltan" onCerrar={onCerrar} pie={<button className="btn primario" onClick={onCerrar}>{lote && !lote.terminado ? 'Seguir en segundo plano' : 'Listo'}</button>}>
      {error && <p className="error peq-txt" role="alert">{error}</p>}
      {!lote && !error && <p className="tenue">Empezando…</p>}
      {lote && lote.total === 0 && <p>Todos tus productos ya tienen foto. No hay nada que completar.</p>}
      {lote && lote.total > 0 && (
        <div className="col" style={{ gap: 12 }}>
          <div>
            <div className="fila entre peq-txt"><b>{lote.terminado ? 'Terminamos' : 'Buscando fotos…'}</b><span className="tenue">{lote.terminadas} de {lote.total} productos</span></div>
            <div className="bi-barra" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><span style={{ width: `${pct}%` }} /></div>
            {lote.terminado && <p className="peq-txt" style={{ margin: '6px 0 0' }}>{lote.agregadas} foto{lote.agregadas === 1 ? '' : 's'} agregada{lote.agregadas === 1 ? '' : 's'}{lote.pendientes ? ` y ${lote.pendientes} por aprobar` : ''}.</p>}
          </div>
          <ul className="bi-lote">
            {lote.busquedas.map((x) => {
              const activo = x.pasos.find((p) => p.estado === 'en_curso');
              return (
                <li key={x.id} className={`bi-fila ${x.estado.toLowerCase()}`}>
                  <span className="bi-icono" aria-hidden="true"><Icon n={x.estado === 'EN_CURSO' ? 'refrescar' : x.estado === 'LISTO' ? 'ok' : x.estado === 'ESPERA_ELECCION' ? 'info' : 'alerta'} className="" size={14} /></span>
                  <span className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                    <b className="peq-txt cortar">{x.producto}</b>
                    <span className="tenue peq-txt">{x.estado === 'EN_CURSO' ? (activo ? `${activo.titulo}${activo.detalle ? ` · ${activo.detalle}` : ''}` : 'En cola…') : x.mensaje}</span>
                  </span>
                  {x.estado === 'ESPERA_ELECCION' && <button type="button" className="btn peq" onClick={() => setAbierta(abierta === x.id ? null : x.id)}>{abierta === x.id ? 'Ocultar' : 'Revisar'}</button>}
                  {abierta === x.id && <div style={{ flexBasis: '100%' }}><ProcesoBusqueda busquedaId={x.id} onCerrar={() => setAbierta(null)} onCambio={() => { recargar(); onCambio(); }} /></div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Modal>
  );
}
