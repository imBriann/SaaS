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

const json = async (url: string, headers: Record<string, string> = {}) => {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'OmnegiaBot/1.0', ...headers }, signal: AbortSignal.timeout(config.imagenes.descargaTimeoutMs) });
  if (!r.ok) throw new Error(`El buscador de imágenes respondió ${r.status}`);
  return r.json() as Promise<any>;
};
const https = (u: unknown) => (typeof u === 'string' && u.startsWith('https://') ? u : null);

export class Openverse implements BuscadorImagenes {
  nombre = 'openverse';
  async buscar(consulta: string, cuantas = 12) {
    const q = new URLSearchParams({ q: consulta, license_type: 'commercial', page_size: String(Math.min(cuantas, 20)), mature: 'false' });
    const d = await json(`https://api.openverse.org/v1/images/?${q}`);
    return (d?.results ?? []).filter((x: any) => https(x?.url)).map((x: any): CandidataImagen => ({
      url: x.url, miniatura: https(x.thumbnail), fuente: https(x.foreign_landing_url), titulo: String(x.title ?? consulta).slice(0, 200),
      autor: x.creator ?? null, licencia: x.license ? `CC ${String(x.license).toUpperCase()} ${x.license_version ?? ''}`.trim() : null,
      atribucion: x.attribution ?? null, proveedor: 'openverse', licenciaAbierta: true,
    }));
  }
}

export class Pexels implements BuscadorImagenes {
  nombre = 'pexels';
  constructor(private clave = config.imagenes.pexelsKey) {}
  async buscar(consulta: string, cuantas = 12) {
    if (!this.clave) throw new Error('Falta PEXELS_API_KEY');
    const d = await json(`https://api.pexels.com/v1/search?${new URLSearchParams({ query: consulta, per_page: String(Math.min(cuantas, 30)) })}`, { authorization: this.clave });
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
    const d = await json(`https://api.search.brave.com/res/v1/images/search?${new URLSearchParams({ q: consulta, count: String(Math.min(cuantas, 20)), safesearch: 'strict', country: 'CO' })}`, { 'x-subscription-token': this.clave });
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
