/**
 * Cliente HTTP del panel. El tenant se RESUELVE por subdominio (elparche.localhost)
 * o, en desarrollo sin subdominio, por la empresa elegida al iniciar sesión.
 * La interfaz nunca es autoridad: el servidor valida la pertenencia (P1, RF-002).
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

const BASE = (import.meta.env.VITE_BASE_DOMAIN as string | undefined) ?? 'localhost';

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
  const res = await fetch(url, { method, headers, body: payload, credentials: 'include', ...extra });
  const texto = await res.text();
  const data = texto ? (() => { try { return JSON.parse(texto); } catch { return texto; } })() : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'ERROR', e.message ?? `Error ${res.status}`, e.details);
  }
  return data as T;
}

export const api = {
  get: <T = any>(u: string) => request<T>('GET', u),
  post: <T = any>(u: string, b?: unknown) => request<T>('POST', u, b ?? {}),
  patch: <T = any>(u: string, b?: unknown) => request<T>('PATCH', u, b ?? {}),
  upload: <T = any>(u: string, f: File) => { const fd = new FormData(); fd.append('file', f); return request<T>('POST', u, fd); },
};

// ------------------------------------------------------------ formato
export const cop = (n: number | string | null | undefined) =>
  n === null || n === undefined ? '—' : '$' + Math.round(Number(n)).toLocaleString('es-CO').replace(/,/g, '.');
export const num = (n: number) => Number(n).toLocaleString('es-CO');
const TZ = 'America/Bogota';
export const hora = (d: string | Date) => new Date(d).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
export const fecha = (d: string | Date) => new Date(d).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: TZ });
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
