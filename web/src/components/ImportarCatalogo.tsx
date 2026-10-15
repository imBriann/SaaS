import { useState } from 'react';
import { api, cop, type ApiError } from '../api';
import { Icon } from './icons';
import { Estado } from './ui';

/**
 * Importación del catálogo en el alta: archivo → lectura real → correspondencia de columnas →
 * vista previa con validación por fila → decisión sobre duplicados (solo si los hay) →
 * confirmación → resumen con motivo por fila. Nada se guarda hasta confirmar, y lo que se
 * muestra corresponde a lo que el servidor leyó y guardó.
 */
const CAMPOS: [string, string][] = [['nombre', 'Nombre'], ['precio', 'Precio'], ['categoria', 'Categoría'], ['tipo', 'Tipo'], ['duracion_min', 'Duración (min)'], ['stock', 'Existencias'], ['iva_pct', 'IVA (%)'], ['sku', 'Código'], ['ignorar', 'No importar']];
const tamano = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const clave = (f: any) => String(f.sku || f.nombre || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

export function ImportarCatalogo({ d, onGuardado }: { d: any; onGuardado: (borrador: any, resumen: any) => void }) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [prev, setPrev] = useState<any>(null);
  const [filas, setFilas] = useState<any[]>([]);
  const [duplicados, setDuplicados] = useState<'' | 'omitir' | 'actualizar'>('');
  const [fase, setFase] = useState<'elegir' | 'leyendo' | 'revisar' | 'guardando'>('elegir');
  const [error, setError] = useState('');
  const [sobre, setSobre] = useState(false);

  const leer = async (f: File, hoja?: string) => {
    setError('');
    if (!/\.(xlsx|csv)$/i.test(f.name)) { setError('Usa un archivo .xlsx (Excel) o .csv. Si tienes un .xls antiguo, ábrelo y guárdalo como .xlsx.'); return; }
    if (f.size > 5 * 1024 * 1024) { setError(`El archivo pesa ${tamano(f.size)}; el máximo es 5 MB.`); return; }
    if (f.size === 0) { setError('El archivo está vacío.'); return; }
    setArchivo(f); setFase('leyendo');
    try {
      const r = await api.upload(`/api/onboarding/borradores/${d.token}/catalogo/archivo${hoja ? `?hoja=${encodeURIComponent(hoja)}` : ''}`, f);
      setPrev(r); setFilas(r.filas.map((x: any) => ({ ...x, incluir: x.estado === 'OK' }))); setFase('revisar');
    } catch (e) { setError((e as ApiError).message); setFase('elegir'); }
  };
  const remapear = async (columna: string, campo: string) => {
    const mapeo = prev.mapeo.map((m: any) => (m.columna === columna ? { ...m, campo, confianza: 1 } : m.campo === campo && campo !== 'ignorar' ? { ...m, campo: 'ignorar' } : m));
    try {
      const r = await api.post(`/api/onboarding/borradores/${d.token}/catalogo/vista-previa`, { mapeo });
      setPrev({ ...prev, mapeo, filas: r.filas, error: null }); setFilas(r.filas.map((x: any) => ({ ...x, incluir: x.estado === 'OK' })));
    } catch (e) { setPrev({ ...prev, mapeo, error: (e as ApiError).message }); setFilas([]); }
  };
  const elegidas = filas.filter((f) => f.incluir);
  const existentes = new Set((d.catalogo ?? []).map(clave));
  const repetidas = elegidas.filter((f) => existentes.has(clave(f))).length;
  const confirmar = async () => {
    setError(''); setFase('guardando');
    try {
      const payload = filas.map((f) => ({ ...f, precio: f.precio_corregido ? Number(String(f.precio_corregido).replace(/[^\d.,]/g, '').replace(',', '.')) : f.precio, sku: f.sku || null }));
      const r = await api.post(`/api/onboarding/borradores/${d.token}/catalogo/confirmar`, { filas: payload, mapeo: prev?.mapeo, origen: 'archivo', duplicados: duplicados || 'omitir' });
      onGuardado(r, r.resumen);
    } catch (e) { setError((e as ApiError).message); setFase('revisar'); }
  };
  const reiniciar = () => { setPrev(null); setFilas([]); setArchivo(null); setDuplicados(''); setFase('elegir'); setError(''); };

  if (fase === 'elegir' || fase === 'leyendo') return (
    <div className="importar">
      <label className={`importar-zona ${sobre ? 'sobre' : ''} ${fase === 'leyendo' ? 'leyendo' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setSobre(true); }} onDragLeave={() => setSobre(false)}
        onDrop={(e) => { e.preventDefault(); setSobre(false); const f = e.dataTransfer.files[0]; if (f && fase !== 'leyendo') leer(f); }}>
        <span className="importar-icono"><Icon n={fase === 'leyendo' ? 'reloj' : 'subir'} className="" size={22} /></span>
        {fase === 'leyendo' && archivo ? <>
          <b>Leyendo «{archivo.name}»</b><span className="tenue">{tamano(archivo.size)} · detectando hojas, encabezados y columnas…</span>
          <span className="importar-barra" aria-hidden="true"><span /></span>
        </> : <>
          <b>Arrastra aquí tu hoja de cálculo</b>
          <span className="tenue">o <u>elígela desde tu equipo</u> · .xlsx o .csv, hasta 5 MB</span>
          <span className="tenue peq-txt">Detectamos las columnas aunque vengan con otros nombres. Tú revisas todo antes de guardar.</span>
        </>}
        <input type="file" accept=".xlsx,.csv" className="sr" disabled={fase === 'leyendo'} onChange={(e) => { const f = e.target.files?.[0]; if (f) leer(f); e.target.value = ''; }} />
      </label>
      {error && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error}</p>}
    </div>
  );

  const revisar = filas.filter((f) => f.estado !== 'OK').length;
  return (
    <div className="importar col" style={{ gap: 18 }}>
      <section className="tarjeta">
        <div className="cab">
          <h2 className="titulo-tarjeta">1 · ¿Qué hay en cada columna?</h2>
          <span className="tenue peq-txt" style={{ marginLeft: 'auto' }}>«{prev.archivo}» · hoja «{prev.hoja}» · encabezados en la fila {prev.fila_encabezado} · {prev.total} filas</span>
          {prev.hojas?.length > 1 && <select aria-label="Hoja a importar" className="input" style={{ maxWidth: 200 }} value={prev.hoja} onChange={(e) => archivo && leer(archivo, e.target.value)}>{prev.hojas.map((h: string) => <option key={h}>{h}</option>)}</select>}
        </div>
        <div className="cuerpo mapeo">
          {prev.mapeo.map((m: any, i: number) => {
            const idx = prev.encabezados.indexOf(m.columna);
            const muestra = (prev.muestra ?? []).map((fila: string[]) => fila[idx]).filter((v: string) => v !== undefined && v !== '').slice(0, 2);
            return (
              <div key={m.columna} className={`mapeo-col ${m.campo === 'ignorar' ? 'ignorada' : m.confianza < 0.8 ? 'dudosa' : ''}`}>
                <span className="mapeo-origen"><b>{m.columna}</b><small>{muestra.length ? muestra.join(' · ') : 'sin datos de ejemplo'}</small></span>
                <span className="mapeo-flecha" aria-hidden="true"><Icon n="flecha" className="" size={14} /></span>
                <label className="mapeo-destino"><span className="sr">Campo para «{m.columna}»</span>
                  <select className="input" value={m.campo} onChange={(e) => remapear(m.columna, e.target.value)}>{CAMPOS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
                  {m.campo !== 'ignorar' && m.confianza < 0.8 && <small className="mapeo-duda">Revísalo: no estamos seguros</small>}
                </label>
                <span className="sr">{i + 1} de {prev.mapeo.length}</span>
              </div>
            );
          })}
        </div>
        {prev.error && <div className="cuerpo"><p className="bloqueado" role="alert">{prev.error}</p></div>}
      </section>

      <section className="tarjeta">
        <div className="cab"><h2 className="titulo-tarjeta">2 · Revisa lo que se va a importar</h2><span className="tenue peq-txt" style={{ marginLeft: 'auto' }}>{filas.length} filas · {elegidas.length} seleccionadas{revisar ? ` · ${revisar} con algo por revisar` : ''}</span></div>
        {filas.length === 0 ? <div className="cuerpo"><p className="tenue">No hay filas para mostrar. Revisa la correspondencia de columnas.</p></div> : (
          <div className="tabla-wrap" style={{ maxHeight: 420 }}>
            <table className="tabla">
              <thead><tr><th><span className="sr">Incluir</span></th><th>Fila</th><th>Nombre</th><th>Tipo</th><th className="num">Precio</th><th>Estado</th></tr></thead>
              <tbody>{filas.map((f, i) => (
                <tr key={i} className={f.incluir ? '' : 'excluida'}>
                  <td><input type="checkbox" checked={f.incluir} onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, incluir: e.target.checked } : x)))} aria-label={`Incluir fila ${f.fila}`} /></td>
                  <td className="mono tenue">{f.fila}</td>
                  <td>{f.nombre}{existentes.has(clave(f)) && <small className="tenue"> · ya está en tu catálogo</small>}</td>
                  <td><select className="input" aria-label={`Tipo de la fila ${f.fila}`} value={f.tipo} onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, tipo: e.target.value } : x)))}><option value="SERVICIO">Servicio</option><option value="PRODUCTO">Producto</option></select></td>
                  <td className="num">{f.precio === null ? <input className="input falta" style={{ width: 110 }} placeholder="Precio" aria-label={`Precio de la fila ${f.fila}`} inputMode="decimal" onChange={(e) => setFilas(filas.map((x, j) => (j === i ? { ...x, precio_corregido: e.target.value, incluir: !!e.target.value || x.incluir } : x)))} /> : cop(f.precio)}</td>
                  <td>{f.estado === 'OK' ? <Estado v="EXITO" texto="Lista" /> : <span className="estado warn" title={f.problemas.join(' · ')}><Icon n="alerta" className="" />{f.problemas[0]}</span>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        {repetidas > 0 && (
          <fieldset className="cuerpo opciones-dup">
            <legend>{repetidas === 1 ? 'Una fila ya existe' : `${repetidas} filas ya existen`} en tu catálogo (mismo nombre o código). ¿Qué hacemos?</legend>
            <label className="fila"><input type="radio" name="dup" checked={duplicados === 'omitir'} onChange={() => setDuplicados('omitir')} />Conservar lo que ya tengo y omitirlas</label>
            <label className="fila"><input type="radio" name="dup" checked={duplicados === 'actualizar'} onChange={() => setDuplicados('actualizar')} />Actualizarlas con los datos del archivo</label>
          </fieldset>
        )}
        {error && <div className="cuerpo"><p className="bloqueado" role="alert">{error}</p></div>}
        <div className="cuerpo fila entre envolver" style={{ gap: 8 }}>
          <button className="btn sutil" onClick={reiniciar}>Usar otro archivo</button>
          <button className="btn primario" disabled={fase === 'guardando' || !elegidas.length || (repetidas > 0 && !duplicados)} onClick={confirmar}>
            {fase === 'guardando' ? 'Guardando…' : `Guardar ${elegidas.length} ${elegidas.length === 1 ? 'ítem' : 'ítems'} en el borrador`}
          </button>
        </div>
      </section>
      <p className="tenue peq-txt">Tu archivo no se modifica. Nada se guarda hasta que confirmes, y el mapeo usado queda en la auditoría de tu empresa.</p>
    </div>
  );
}
