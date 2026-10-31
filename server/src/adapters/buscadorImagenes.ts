import { config } from '../config.js';

/**
 * Buscador de imágenes para el catálogo (la IA arma la consulta y elige las candidatas).
 *
 *  - openverse (por defecto): API abierta de WordPress/Openverse, gratis, con límites por cliente. Se pide solo
 *    licencia con uso comercial (license_type=commercial): las imágenes se asignan solas guardando autor,
 *    licencia, atribución y página de origen.
 *  - pexels: API gratis con clave (200 consultas/hora, 20.000/mes). Licencia de Pexels: uso comercial permitido,
 *    con enlace a Pexels y crédito al fotógrafo cuando sea posible. Útil para servicios (fotos genéricas).
 *  - brave: búsqueda web general de pago (≈ US$5 por 1.000 consultas, con US$5 de crédito mensual). Una foto de
 *    producto suele pertenecer al fabricante o a una tienda: sus resultados quedan PENDIENTE_APROBACION.
 *  - simulado: pruebas y desarrollo, sin red.
 * No se hace scraping de Google ni de otros buscadores: viola sus condiciones y se rompe.
 */
export interface CandidataImagen {
  url: string;
  miniatura: string | null;
  fuente: string | null;
  titulo: string;
  autor: string | null;
  licencia: string | null;
  atribucion: string | null;
  proveedor: string;
  /** Licencia abierta compatible con uso comercial: se puede asignar sin aprobación. */
  licenciaAbierta: boolean;
}

export interface BuscadorImagenes {
  nombre: string;
  buscar(consulta: string, cuantas?: number): Promise<CandidataImagen[]>;
}

/** Falla del proveedor con su código HTTP (si lo hubo): el proceso la muestra en lenguaje simple y la registra. */
export class ErrorBuscador extends Error {
  constructor(public proveedor: string, public status: number | null, mensaje: string) { super(mensaje); }
  /** Mensaje para la persona (sin tecnicismos). */
  get paraPersona() {
    if (this.status === 429) return `El buscador de imágenes (${this.proveedor}) recibió demasiadas consultas y nos pidió esperar. Intenta de nuevo en un minuto o sube una foto.`;
    if (this.status === 401 || this.status === 403) return `El buscador de imágenes (${this.proveedor}) rechazó nuestra llave de acceso. Avisa a soporte; mientras tanto puedes subir una foto.`;
    if (this.status === null) return `El buscador de imágenes (${this.proveedor}) no respondió a tiempo. Intenta de nuevo o sube una foto.`;
    return `El buscador de imágenes (${this.proveedor}) falló (código ${this.status}). Intenta de nuevo o sube una foto.`;
  }
}

type Http = typeof fetch;
let http: Http = (...a) => fetch(...a);
/** Solo pruebas: reemplaza el cliente HTTP de los proveedores. */
export const setHttpBuscador = (h: Http | null) => { http = h ?? ((...a) => fetch(...a)); };

const json = async (proveedor: string, url: string, headers: Record<string, string> = {}, init: RequestInit = {}) => {
  let ultimo: ErrorBuscador | null = null;
  // Un reintento solo ante error 5xx (un tiempo agotado ya esperó lo suficiente; el 429 o el 401 no mejoran reintentando).
  for (let intento = 0; intento < 2; intento++) {
    let r: Response;
    try {
      r = await http(url, { headers: { accept: 'application/json', 'user-agent': 'OmnegiaBot/1.0', ...headers }, signal: AbortSignal.timeout(config.imagenes.buscadorTimeoutMs), ...init });
    } catch { ultimo = new ErrorBuscador(proveedor, null, `${proveedor}: sin respuesta`); break; }
    if (r.ok) {
      // Una pasarela saturada a veces responde 200/5xx con HTML: no es JSON y cuenta como falla del proveedor.
      try { return await r.json(); } catch { ultimo = new ErrorBuscador(proveedor, 502, `${proveedor} respondió algo que no es JSON`); continue; }
    }
    ultimo = new ErrorBuscador(proveedor, r.status, `${proveedor} respondió ${r.status}`);
    if (r.status < 500) break;
  }
  throw ultimo!;
};
const https = (u: unknown) => (typeof u === 'string' && u.startsWith('https://') ? u : null);

export class Openverse implements BuscadorImagenes {
  nombre = 'openverse';
  private token: { valor: string; vence: number } | null = null;
  /** Con OPENVERSE_CLIENT_ID/SECRET pide un token (client_credentials): los límites son mucho más altos que el anónimo. */
  private async autorizacion(): Promise<Record<string, string>> {
    const { openverseClientId: id, openverseClientSecret: secreto } = config.imagenes;
    if (!id || !secreto) return {};
    if (!this.token || this.token.vence < Date.now() + 60_000) {
      const d = await json('openverse', 'https://api.openverse.org/v1/auth_tokens/token/', { 'content-type': 'application/x-www-form-urlencoded' },
        { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secreto }).toString() });
      this.token = { valor: String(d?.access_token ?? ''), vence: Date.now() + Number(d?.expires_in ?? 3600) * 1000 };
    }
    return this.token.valor ? { authorization: `Bearer ${this.token.valor}` } : {};
  }
  async buscar(consulta: string, cuantas = 12) {
    const q = new URLSearchParams({ q: consulta, license_type: 'commercial', page_size: String(Math.min(cuantas, 20)), mature: 'false' });
    const d = await json('openverse', `https://api.openverse.org/v1/images/?${q}`, await this.autorizacion());
    return (d?.results ?? []).filter((x: any) => https(x?.url)).map((x: any): CandidataImagen => ({
      url: x.url, miniatura: https(x.thumbnail), fuente: https(x.foreign_landing_url), titulo: String(x.title ?? consulta).slice(0, 200),
      autor: x.creator ?? null, licencia: x.license ? `CC ${String(x.license).toUpperCase()} ${x.license_version ?? ''}`.trim() : null,
      atribucion: x.attribution ?? null, proveedor: 'openverse', licenciaAbierta: true,
    }));
  }
}

/**
 * Wikimedia Commons: sin llave, rápido (~1 s) y solo aloja archivos con licencia libre (apta para uso comercial,
 * con atribución). Busca por el texto del nombre del archivo, así que la pertinencia es baja: sus candidatas se
 * marcan como no seguras (nunca se agregan solas). Es el respaldo cuando Openverse (lento sin credenciales) falla.
 */
export class Wikimedia implements BuscadorImagenes {
  nombre = 'wikimedia';
  async buscar(consulta: string, cuantas = 12) {
    const q = new URLSearchParams({ action: 'query', generator: 'search', gsrsearch: consulta, gsrnamespace: '6', gsrlimit: String(Math.min(cuantas * 2, 30)), prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '1000', format: 'json', formatversion: '2', origin: '*' });
    const d = await json('wikimedia', `https://commons.wikimedia.org/w/api.php?${q}`);
    const limpio = (t: unknown) => String(t ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    return (d?.query?.pages ?? []).filter((x: any) => ['image/jpeg', 'image/png', 'image/webp'].includes(x?.imageinfo?.[0]?.mime) && https(x.imageinfo[0].thumburl ?? x.imageinfo[0].url))
      .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0)).slice(0, cuantas).map((x: any): CandidataImagen => {
        const i = x.imageinfo[0], m = i.extmetadata ?? {};
        const autor = limpio(m.Artist?.value) || null, licencia = limpio(m.LicenseShortName?.value) || null;
        return {
          url: i.thumburl ?? i.url, miniatura: https(i.thumburl), fuente: https(i.descriptionurl), titulo: String(x.title ?? consulta).replace(/^File:/, '').replace(/\.[a-z]+$/i, '').slice(0, 200),
          autor, licencia, atribucion: [limpio(x.title).replace(/^File:/, ''), autor && `por ${autor}`, licencia && `(${licencia})`, 'vía Wikimedia Commons'].filter(Boolean).join(' '), proveedor: 'wikimedia', licenciaAbierta: true,
        };
      });
  }
}

export class Pexels implements BuscadorImagenes {
  nombre = 'pexels';
  constructor(private clave = config.imagenes.pexelsKey) {}
  async buscar(consulta: string, cuantas = 12) {
    if (!this.clave) throw new Error('Falta PEXELS_API_KEY');
    const d = await json('pexels', `https://api.pexels.com/v1/search?${new URLSearchParams({ query: consulta, per_page: String(Math.min(cuantas, 30)) })}`, { authorization: this.clave });
    return (d?.photos ?? []).filter((x: any) => https(x?.src?.large)).map((x: any): CandidataImagen => ({
      url: x.src.large, miniatura: https(x.src.medium), fuente: https(x.url), titulo: String(x.alt || consulta).slice(0, 200),
      autor: x.photographer ?? null, licencia: 'Licencia de Pexels', atribucion: `Foto de ${x.photographer ?? 'autor desconocido'} en Pexels`, proveedor: 'pexels', licenciaAbierta: true,
    }));
  }
}

export class Brave implements BuscadorImagenes {
  nombre = 'brave';
  constructor(private clave = config.imagenes.braveKey) {}
  async buscar(consulta: string, cuantas = 12) {
    if (!this.clave) throw new Error('Falta BRAVE_SEARCH_API_KEY');
    const d = await json('brave', `https://api.search.brave.com/res/v1/images/search?${new URLSearchParams({ q: consulta, count: String(Math.min(cuantas, 20)), safesearch: 'strict', country: 'CO' })}`, { 'x-subscription-token': this.clave });
    return (d?.results ?? []).filter((x: any) => https(x?.properties?.url)).map((x: any): CandidataImagen => ({
      url: x.properties.url, miniatura: https(x.thumbnail?.src), fuente: https(x.url), titulo: String(x.title ?? consulta).slice(0, 200),
      autor: x.source ?? null, licencia: null, atribucion: null, proveedor: 'brave', licenciaAbierta: false,
    }));
  }
}

/** Simulado: candidatas con URL https ficticias (las pruebas sustituyen la descarga). */
export class BuscadorSimulado implements BuscadorImagenes {
  nombre = 'simulado';
  consultas: string[] = [];
  abiertas = true;
  async buscar(consulta: string, cuantas = 6) {
    this.consultas.push(consulta);
    return Array.from({ length: Math.min(cuantas, 6) }, (_, i): CandidataImagen => ({
      url: `https://imagenes.ejemplo.test/${encodeURIComponent(consulta)}/${i + 1}.jpg`, miniatura: null, fuente: `https://fuente.ejemplo.test/${i + 1}`,
      titulo: `${consulta} ${i + 1}`, autor: 'Autor de prueba', licencia: this.abiertas ? 'CC BY 4.0' : null, atribucion: this.abiertas ? `"${consulta}" por Autor de prueba (CC BY 4.0)` : null,
      proveedor: 'simulado', licenciaAbierta: this.abiertas,
    }));
  }
}

let reemplazo: BuscadorImagenes | null = null;
export const setBuscadorImagenes = (b: BuscadorImagenes | null) => { reemplazo = b; };
/** Proveedores en orden de intento: el configurado y, si hay llave de Pexels, Pexels como respaldo (fotos genéricas). */
export function buscadoresImagenes(): BuscadorImagenes[] {
  if (reemplazo) return [reemplazo];
  const principal = buscadorImagenes();
  const lista = principal ? [principal] : [];
  const real = config.imagenes.proveedor !== 'ninguno' && config.imagenes.proveedor !== 'simulado';
  if (config.imagenes.pexelsKey && principal?.nombre !== 'pexels' && real) lista.push(new Pexels());
  if (real) lista.push(new Wikimedia());
  return lista;
}
export function buscadorImagenes(): BuscadorImagenes | null {
  if (reemplazo) return reemplazo;
  switch (config.imagenes.proveedor) {
    case 'openverse': return new Openverse();
    case 'pexels': return config.imagenes.pexelsKey ? new Pexels() : null;
    case 'brave': return config.imagenes.braveKey ? new Brave() : null;
    case 'simulado': return new BuscadorSimulado();
    default: return null;
  }
}
