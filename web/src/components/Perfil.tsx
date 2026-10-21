export const inicialesDe = (nombre: string) => nombre.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/** Avatar de la persona: su foto si la subió, si no sus iniciales. */
export function Avatar({ nombre, foto, className = 'avatar' }: { nombre: string; foto?: string | null; className?: string }) {
  return <span className={`${className} ${foto ? 'con-foto' : ''}`} aria-hidden="true">{foto ? <img src={foto} alt="" /> : inicialesDe(nombre)}</span>;
}

/** «Chrome en Windows», «Safari en iPhone»… a partir del agente del navegador guardado con la sesión. */
export function dispositivoDe(agente: string | null | undefined): { nombre: string; movil: boolean } {
  const a = agente ?? '';
  if (!a) return { nombre: 'Dispositivo sin identificar', movil: false };
  const navegador = /Edg\//.test(a) ? 'Edge' : /OPR\/|Opera/.test(a) ? 'Opera' : /Firefox\//.test(a) ? 'Firefox' : /Chrome\//.test(a) ? 'Chrome' : /Safari\//.test(a) ? 'Safari' : 'Navegador';
  const sistema = /iPhone/.test(a) ? 'iPhone' : /iPad/.test(a) ? 'iPad' : /Android/.test(a) ? 'Android' : /Windows/.test(a) ? 'Windows' : /Mac OS X|Macintosh/.test(a) ? 'Mac' : /Linux/.test(a) ? 'Linux' : '';
  return { nombre: sistema ? `${navegador} en ${sistema}` : navegador, movil: /iPhone|Android|Mobile/.test(a) };
}

/** Reduce una imagen a un cuadrado de 256 px (JPEG): la foto viaja liviana y el servidor solo acepta imágenes. */
export function prepararFoto(archivo: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(archivo.type)) return reject(new Error('Elige una imagen PNG, JPG o WebP.'));
    if (archivo.size > 8 * 1024 * 1024) return reject(new Error('La imagen pesa más de 8 MB.'));
    const url = URL.createObjectURL(archivo);
    const img = new Image();
    img.onload = () => {
      const lado = 256;
      const c = document.createElement('canvas');
      c.width = lado; c.height = lado;
      const g = c.getContext('2d');
      if (!g) { URL.revokeObjectURL(url); return reject(new Error('Tu navegador no pudo procesar la imagen.')); }
      const m = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, lado, lado);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No pudimos leer esa imagen.')); };
    img.src = url;
  });
}
