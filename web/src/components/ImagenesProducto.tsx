import { useRef, useState } from 'react';
import { api, urlArchivo } from '../api';
import { Escritura } from './Layout';
import { Cargando, useAccion, useApi, useToast } from './ui';
import { Icon } from './icons';
import { ProcesoBusqueda } from './BusquedaImagenes';

/**
 * Fotos de un producto: subir (JPG, PNG o WebP; se guarda sin metadatos de ubicación), buscar con IA y aprobar las
 * encontradas en la web. Una imagen pendiente no se muestra ni se envía a clientes hasta que la apruebes.
 */
const MAX_MB = 5;
const leerBase64 = (f: File) => new Promise<string>((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => mal(new Error('No pudimos leer el archivo.')); r.readAsDataURL(f); });

export function ImagenesProducto({ productId }: { productId: string }) {
  const { data, recargar } = useApi<any>(() => api.get(`/api/t/catalogo/productos/${productId}/imagenes`), [productId]);
  const { run, ocupado } = useAccion();
  const toast = useToast();
  const [arrastrando, setArrastrando] = useState(false);
  const subir = async (f: File | undefined) => {
    if (!f) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) return toast('Sube una imagen JPG, PNG o WebP.', true);
    if (f.size > MAX_MB * 1024 * 1024) return toast(`La imagen pesa más de ${MAX_MB} MB.`, true);
    const r = await run(async () => api.post(`/api/t/catalogo/productos/${productId}/imagenes`, { base64: await leerBase64(f), nombre: f.name }), 'Imagen agregada');
    if (r) recargar();
  };
  const [buscando, setBuscando] = useState(0);
  const entrada = useRef<HTMLInputElement>(null);
  const imagenes: any[] = data?.imagenes ?? [];
  return (
    <section className="img-producto" aria-label="Fotos del producto">
      <div className="fila entre envolver" style={{ gap: 6 }}>
        <b className="peq-txt">Fotos</b>
        <Escritura permiso="catalog:write"><button type="button" className="btn peq" disabled={ocupado || buscando > 0} onClick={() => setBuscando(Date.now())}><Icon n="ia" className="" size={14} />Buscar imagen con IA</button></Escritura>
      </div>
      {buscando > 0 && <ProcesoBusqueda key={buscando} productId={productId} onCerrar={() => setBuscando(0)} onCambio={recargar} onSubir={() => entrada.current?.click()} />}
      {!data ? <Cargando filas={1} /> : (
        <div className="img-rejilla">
          {imagenes.map((i) => (
            <figure key={i.id} className={`img-item ${i.estado.toLowerCase()}`}>
              <img src={urlArchivo(i.miniatura)} alt="" loading="lazy" />
              <figcaption className="col" style={{ gap: 4 }}>
                {i.estado === 'PENDIENTE_APROBACION' && <span className="estado warn">Pendiente</span>}
                {i.estado === 'ROTA' && <span className="estado err">Enlace roto</span>}
                {i.atribucion && <span className="tenue peq-txt cortar" title={i.atribucion}>{i.atribucion}</span>}
                {i.fuente && <a className="peq-txt" href={i.fuente} target="_blank" rel="noreferrer noopener">Ver la fuente</a>}
                <Escritura permiso="catalog:write"><span className="fila" style={{ gap: 4 }}>
                  {i.estado === 'PENDIENTE_APROBACION' && <button type="button" className="btn peq primario" onClick={() => run(() => api.post(`/api/t/catalogo/imagenes/${i.id}/aprobar`), 'Imagen aprobada').then(recargar)}>Aprobar</button>}
                  <button type="button" className="btn peq sutil" aria-label="Quitar la imagen" onClick={() => run(() => api.del(`/api/t/catalogo/imagenes/${i.id}`), 'Imagen quitada').then(recargar)}><Icon n="x" className="" size={12} /></button>
                </span></Escritura>
              </figcaption>
            </figure>
          ))}
          <Escritura permiso="catalog:write">
            <label className={`img-subir ${arrastrando ? 'on' : ''}`} onDragOver={(e) => { e.preventDefault(); setArrastrando(true); }} onDragLeave={() => setArrastrando(false)}
              onDrop={(e) => { e.preventDefault(); setArrastrando(false); subir(e.dataTransfer.files?.[0]); }}>
              <Icon n="subir" className="" size={18} /><span className="peq-txt">Arrastra o elige una foto</span>
              <input ref={entrada} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { subir(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
          </Escritura>
        </div>
      )}
      {imagenes.some((i) => i.estado === 'PENDIENTE_APROBACION') && <p className="tenue peq-txt">Aprueba una imagen de internet solo si tienes derecho a usarla (por ejemplo, porque distribuyes el producto). Hasta entonces no se muestra ni se envía a clientes.</p>}
    </section>
  );
}
