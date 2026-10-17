/**
 * Preparación del logotipo en el navegador: la persona sube lo que tenga (foto del celular, PNG enorme, SVG) y aquí se
 * reduce y se comprime solo, sin pedirle que lo haga ella. El resultado es un WebP liviano que conserva la transparencia.
 * El servidor mantiene sus límites (200 KB, 32–4096 px) como defensa; esta función siempre queda muy por debajo.
 */
const MAX_ENTRADA = 50 * 1024 * 1024;       // lo que se acepta de entrada: más es casi seguro un archivo equivocado
const OBJETIVO = 120_000;                   // bytes del resultado (el límite del servidor es 200 KB)
const LADOS = [512, 384, 256, 192, 128];    // el logo se ve pequeño: 512 px alcanza para pantallas de alta densidad
const CALIDADES = [0.92, 0.85, 0.75, 0.65, 0.5];
const MINIMO = 32;

export interface LogoPreparado { dataUrl: string; ancho: number; alto: number; bytesOriginal: number; bytes: number; colores: string[]; optimizado: boolean }
export class LogoError extends Error {}

const aDataUrl = (b: Blob) => new Promise<string>((ok, mal) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => mal(new Error('lectura')); r.readAsDataURL(b); });
const aBlob = (c: HTMLCanvasElement, tipo: string, calidad?: number) => new Promise<Blob | null>((ok) => c.toBlob(ok, tipo, calidad));

async function cargar(archivo: File): Promise<{ img: HTMLImageElement; liberar: () => void }> {
  const url = URL.createObjectURL(archivo);
  const img = new Image();
  img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); throw new LogoError('No pudimos leer esta imagen. Prueba con otra o expórtala como PNG o JPG.'); }
  return { img, liberar: () => URL.revokeObjectURL(url) };
}

/** Dibuja reduciendo por pasos (mitades): una reducción brusca se ve dentada. */
function dibujar(img: HTMLImageElement, ancho: number, alto: number, lado: number, ampliar = false): HTMLCanvasElement {
  // Una imagen de puntos nunca se agranda (se vería borrosa); un SVG sí: es vectorial y se dibuja nítido al tamaño pedido.
  const k = ampliar ? lado / Math.max(ancho, alto) : Math.min(1, lado / Math.max(ancho, alto));
  const w = Math.max(1, Math.round(ancho * k)), h = Math.max(1, Math.round(alto * k));
  let origen: CanvasImageSource = img, ow = ancho, oh = alto;
  while (ow / 2 >= w && oh / 2 >= h) {
    const c = document.createElement('canvas'); c.width = Math.round(ow / 2); c.height = Math.round(oh / 2);
    const x = c.getContext('2d')!; x.imageSmoothingQuality = 'high'; x.drawImage(origen, 0, 0, c.width, c.height);
    origen = c; ow = c.width; oh = c.height;
  }
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const cx = out.getContext('2d')!; cx.imageSmoothingQuality = 'high'; cx.drawImage(origen, 0, 0, w, h);
  return out;
}

/** Colores dominantes (sin contar lo transparente), del más al menos frecuente. */
export function coloresDominantes(lienzo: HTMLCanvasElement, max = 8): string[] {
  const m = document.createElement('canvas'); m.width = m.height = 48;
  const x = m.getContext('2d', { willReadFrequently: true })!; x.drawImage(lienzo, 0, 0, 48, 48);
  const px = x.getImageData(0, 0, 48, 48).data; const cuenta = new Map<string, number>();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const k = '#' + [0, 1, 2].map((j) => Math.min(255, Math.round(px[i + j] / 24) * 24).toString(16).padStart(2, '0')).join('');
    cuenta.set(k, (cuenta.get(k) ?? 0) + 1);
  }
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

export async function prepararLogo(archivo: File): Promise<LogoPreparado> {
  if (!archivo.type.startsWith('image/')) throw new LogoError('Ese archivo no es una imagen. Sube tu logotipo en PNG, JPG, WEBP, GIF o SVG.');
  if (archivo.size > MAX_ENTRADA) throw new LogoError(`El archivo pesa ${Math.round(archivo.size / 1_048_576)} MB, demasiado para ser un logotipo. Revisa que sea el archivo correcto.`);
  const { img, liberar } = await cargar(archivo);
  try {
    const vectorial = archivo.type === 'image/svg+xml';
    // Un SVG sin tamaño propio se dibuja a 512 px.
    const ancho = img.naturalWidth || 512, alto = img.naturalHeight || 512;
    if (!vectorial && (ancho < MINIMO || alto < MINIMO)) throw new LogoError(`La imagen mide ${ancho}×${alto} px y se vería borrosa. Sube una de al menos ${MINIMO} px por lado.`);
    // Si ya es liviana, de buen tamaño y de un formato que el servidor admite, se conserva tal cual.
    if (!vectorial && archivo.size <= OBJETIVO && ancho <= LADOS[0] && alto <= LADOS[0] && ['image/png', 'image/jpeg', 'image/webp'].includes(archivo.type)) {
      const c = dibujar(img, ancho, alto, LADOS[0]);
      return { dataUrl: await aDataUrl(archivo), ancho, alto, bytesOriginal: archivo.size, bytes: archivo.size, colores: coloresDominantes(c), optimizado: false };
    }
    for (const lado of LADOS) {
      const lienzo = dibujar(img, ancho, alto, lado, vectorial);
      for (const calidad of CALIDADES) {
        let blob = await aBlob(lienzo, 'image/webp', calidad);
        // Un navegador sin WebP devuelve PNG: se reduce el lado hasta que quepa.
        if (blob && blob.type !== 'image/webp') blob = blob.type === 'image/png' ? blob : null;
        if (blob && blob.size <= OBJETIVO) return { dataUrl: await aDataUrl(blob), ancho: lienzo.width, alto: lienzo.height, bytesOriginal: archivo.size, bytes: blob.size, colores: coloresDominantes(lienzo), optimizado: true };
        if (blob?.type === 'image/png') break;
      }
    }
    throw new LogoError('No logramos reducir esta imagen lo suficiente. Prueba con otra versión del logotipo.');
  } finally { liberar(); }
}

/** «2,3 MB» o «48 KB». */
export const pesoLegible = (b: number) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);
