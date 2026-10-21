/**
 * Cliente HTTP del panel. El tenant se RESUELVE por subdominio (elparche.localhost)
 * o, en desarrollo sin subdominio, por la empresa elegida al iniciar sesión.
 * La interfaz nunca es autoridad: el servidor valida la pertenencia (P1, RF-002).
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

/** Dominio base de las empresas: lo publica el servidor en index.html (producción) o Vite (desarrollo). */
const BASE = (document.querySelector<HTMLMetaElement>('meta[name="omnegia-dominio"]')?.content || (import.meta.env.VITE_BASE_DOMAIN as string | undefined) || 'localhost').toLowerCase();

/** ¿Cada empresa vive en su propio subdominio? Solo con un dominio real (en local se usa la empresa guardada). */
export const subdominiosActivos = () => BASE !== 'localhost' && window.location.protocol === 'https:';

/**
 * Lleva al panel de una empresa. En producción va a <slug>.<dominio> (la cookie de sesión vale para
 * todos los subdominios); en local guarda la empresa elegida y navega dentro de la misma pestaña.
 * Devuelve true si salió de la página.
 */
export function irAEmpresa(slug: string, ruta = '/', navegar?: (r: string) => void): boolean {
  const destino = ruta.startsWith('/') && !ruta.startsWith('//') ? ruta : '/';
  if (subdominiosActivos() && /^[a-z0-9-]{1,63}$/.test(slug) && window.location.hostname !== `${slug}.${BASE}`) {
    window.location.assign(`https://${slug}.${BASE}${destino}`);
    return true;
  }
  guardar('empresa', slug);
  if (navegar) navegar(destino); else window.location.assign(destino);
  return false;
}

/** Una página del dominio principal (alta, lista de empresas): desde un subdominio sale a <dominio>. */
export const urlPrincipal = (ruta: string) => (subdominiosActivos() && slugDelHost() ? `https://${BASE}${ruta}` : ruta);

/** Dirección pública de una empresa para mostrarla (nunca «.localhost» en producción). */
export const direccionEmpresa = (slug: string) => (BASE === 'localhost' ? `${slug}.localhost` : `${slug}.${BASE}`);

export function slugDelHost(): string | null {
  const h = window.location.hostname.toLowerCase();
  if (h.endsWith('.' + BASE)) {
    const s = h.slice(0, -(BASE.length + 1));
    if (s && !['www', 'app'].includes(s)) return s;
  }
  return null;
}

export function tenantSlug(): string | null {
  return slugDelHost() ?? leer('empresa');
}

export function leer(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function guardar(k: string, v: string | null) {
  try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* sin almacenamiento */ }
}

async function request<T>(method: string, url: string, body?: unknown, extra: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const slug = tenantSlug();
  if (slug && url.startsWith('/api/t/')) headers['x-tenant-slug'] = slug;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'include', ...extra });
  } catch {
    throw new ApiError(0, 'RED', 'No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.');
  }
  const texto = await res.text();
  const data = texto ? (() => { try { return JSON.parse(texto); } catch { return texto; } })() : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    // Sesión vencida en mitad del trabajo: se vuelve a iniciar sesión y se regresa aquí.
    if (res.status === 401 && url.startsWith('/api/t/') && !window.location.pathname.startsWith('/entrar')) {
      window.location.assign(`/entrar?vencida=1&volver=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    }
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? (res.status >= 500 ? 'Algo falló de nuestro lado. Intenta de nuevo en un momento.' : `Error ${res.status}`), e.details ?? (e.correlacion ? { correlacion: e.correlacion } : undefined));
  }
  return data as T;
}

/** Descarga un archivo generado por el servidor (CSV, exportaciones) respetando la empresa activa. */
/**
 * Descarga los documentos de un pago: primero se pide un enlace temporal autorizado y luego el
 * ZIP con ese enlace en el cuerpo (nunca en la URL, para que no quede en historiales ni registros).
 */
export async function descargarDocumentos(pedirEnlace: () => Promise<{ token: string; numero: string }>) {
  const { token, numero } = await pedirEnlace();
  const res = await fetch('/api/documentos/descarga', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'include' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new ApiError(res.status, d?.error?.code ?? 'ERROR', d?.error?.message ?? 'No se pudieron descargar los documentos.');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = `documentos-omnegia-${numero}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export async function descargar(url: string, nombre: string) {
  const headers: Record<string, string> = {};
  const slug = tenantSlug();
  if (slug) headers['x-tenant-slug'] = slug;
  const res = await fetch(url, { headers, credentials: 'include' });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new ApiError(res.status, d?.error?.code ?? 'ERROR', d?.error?.message ?? 'No se pudo descargar el archivo.');
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Pregunta al asistente con avance en vivo (SSE sobre POST). `onEvento` recibe lo que de verdad pasa en
 * el servidor (herramientas que consulta); la promesa se resuelve con la respuesta final. Si la conexión
 * no admite streaming, se usa la petición normal.
 */
export async function preguntarEnVivo<T = any>(cuerpo: Record<string, unknown>, onEvento: (e: any) => void): Promise<T> {
  const headers: Record<string, string> = { accept: 'text/event-stream', 'content-type': 'application/json' };
  const slug = tenantSlug();
  if (slug) headers['x-tenant-slug'] = slug;
  let res: Response;
  try {
    res = await fetch('/api/t/asistente/stream', { method: 'POST', headers, body: JSON.stringify(cuerpo), credentials: 'include' });
  } catch {
    throw new ApiError(0, 'RED', 'No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.');
  }
  if (!res.ok || !res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    if (res.status === 404 || res.status === 405) return api.post<T>('/api/t/asistente', cuerpo);
    const d = await res.json().catch(() => ({}));
    if (res.status === 401 && !window.location.pathname.startsWith('/entrar')) window.location.assign(`/entrar?vencida=1&volver=${encodeURIComponent(window.location.pathname)}`);
    throw new ApiError(res.status, d?.error?.code ?? 'ERROR', d?.error?.message ?? `Error ${res.status}`, d?.error?.details);
  }
  const lector = res.body.getReader();
  const dec = new TextDecoder();
  let resto = '';
  let final: T | null = null;
  let fallo: ApiError | null = null;
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    resto += dec.decode(value, { stream: true });
    let corte: number;
    while ((corte = resto.indexOf('\n\n')) >= 0) {
      const bloque = resto.slice(0, corte);
      resto = resto.slice(corte + 2);
      const evento = bloque.match(/^event: (.+)$/m)?.[1];
      const dato = bloque.match(/^data: (.*)$/m)?.[1];
      if (!evento || dato === undefined) continue;
      const data = JSON.parse(dato);
      if (evento === 'progreso') onEvento(data);
      else if (evento === 'respuesta') final = data;
      else if (evento === 'error') fallo = new ApiError(500, data.code ?? 'ERROR', data.message ?? 'Algo falló de nuestro lado.', data.correlacion ? { correlacion: data.correlacion } : undefined);
    }
  }
  if (fallo) throw fallo;
  if (!final) throw new ApiError(0, 'RED', 'La respuesta se interrumpió. Intenta de nuevo.');
  return final;
}

export const api = {
  get: <T = any>(u: string) => request<T>('GET', u),
  post: <T = any>(u: string, b?: unknown) => request<T>('POST', u, b ?? {}),
  patch: <T = any>(u: string, b?: unknown) => request<T>('PATCH', u, b ?? {}),
  del: <T = any>(u: string) => request<T>('DELETE', u),
  upload: <T = any>(u: string, f: File) => { const fd = new FormData(); fd.append('file', f); return request<T>('POST', u, fd); },
};

// ------------------------------------------------------------ formato
export const cop = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '—' : '$' + Math.round(Number(n)).toLocaleString('es-CO').replace(/,/g, '.');
export const num = (n: number) => Number(n).toLocaleString('es-CO');
/** Zona horaria del negocio activo: todas las fechas del panel se muestran en ella. */
let TZ = 'America/Bogota';
export const setZona = (tz: string | null | undefined) => { if (tz) TZ = tz; };
export const zona = () => TZ;
export const hora = (d: string | Date) => new Date(d).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
export const fecha = (d: string | Date) => new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: TZ });
export const fechaCompleta = (d: string | Date) => new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ });
export const fechaHora = (d: string | Date) => `${fecha(d)} · ${hora(d)}`;
export const fechaLarga = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
export const hoyLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export function hace(d: string | Date) {
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return fecha(d);
}
