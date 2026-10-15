import type { Database } from '../db/index.js';
import { config } from '../config.js';

/**
 * Qué se sirve según el host. El DNS comodín (*.BASE_DOMAIN) hace que cualquier subdominio llegue
 * aquí, así que:
 *   - el dominio principal sirve todo (sitio público, alta, panel del operador);
 *   - <slug>.BASE_DOMAIN solo sirve el panel de una empresa que EXISTE; las páginas públicas, el
 *     alta y el operador redirigen al dominio principal;
 *   - un subdominio sin empresa responde «esta dirección no existe» (404);
 *   - www/app/api y cualquier host ajeno (p. ej. la URL de onrender.com) redirigen al principal,
 *     para que el alta no quede repartida entre orígenes distintos.
 * En local (BASE_DOMAIN=localhost) no se aplica: cada subdominio .localhost sirve el panel.
 */
export type DestinoHost =
  | { tipo: 'principal' }
  | { tipo: 'empresa'; slug: string }
  | { tipo: 'redirigir' }
  | { tipo: 'inexistente' };

const RESERVADOS = new Set(['www', 'app', 'api']);
/** Rutas que solo existen en el dominio principal. */
const SOLO_PRINCIPAL = /^\/(operador|plataforma|empezar|pasarela|bienvenida|producto|nosotros|planes|ayuda|empresas)(\/|$)/;

export const dominiosActivos = (c = config) => c.baseDomain !== 'localhost';

export function clasificarHost(hostCrudo: string | undefined, c = config): DestinoHost {
  if (!dominiosActivos(c)) return { tipo: 'principal' };
  const host = String(hostCrudo ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
  const principal = new URL(c.publicUrl).hostname;
  if (host === principal || host === c.baseDomain) return { tipo: 'principal' };
  if (host.endsWith('.' + c.baseDomain)) {
    const sub = host.slice(0, -(c.baseDomain.length + 1));
    if (RESERVADOS.has(sub)) return { tipo: 'redirigir' };
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub)) return { tipo: 'empresa', slug: sub };
    return { tipo: 'inexistente' };
  }
  return { tipo: 'redirigir' };
}

export const soloPrincipal = (ruta: string) => SOLO_PRINCIPAL.test(ruta.split('?')[0]);
export const urlPrincipal = (ruta: string, c = config) => `${c.publicUrl}${ruta.startsWith('/') ? ruta : '/'}`;

/** ¿Existe la empresa? Con caché breve para no consultar la base en cada página. */
const cache = new Map<string, { existe: boolean; hasta: number }>();
export async function empresaExiste(db: Database, slug: string): Promise<boolean> {
  const c = cache.get(slug);
  if (c && c.hasta > Date.now()) return c.existe;
  const existe = await db.withPlatform(async (tx) => (await tx.query(`SELECT 1 FROM tenant WHERE slug=$1`, [slug])).rows.length > 0);
  // Una empresa recién creada aparece pronto; una que existe se recuerda un minuto.
  cache.set(slug, { existe, hasta: Date.now() + (existe ? 60_000 : 10_000) });
  if (cache.size > 5000) cache.clear();
  return existe;
}
export const olvidarEmpresas = () => cache.clear();

const esc = (s: string) => s.replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]!));

/** Página para un subdominio que no corresponde a ninguna empresa. */
export function paginaInexistente(host: string, c = config): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Esta dirección no existe · Omnegia</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f1;color:#242e31;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{max-width:460px;background:#fff;border:1px solid #ddded7;border-radius:6px;padding:32px}h1{font-size:22px;font-weight:500;margin:0 0 10px}p{line-height:1.6;color:#465451;margin:0 0 16px}
code{font-family:ui-monospace,monospace;background:#f2f1ed;padding:2px 6px;border-radius:4px;word-break:break-all}a{display:inline-block;background:#242e31;color:#fff;text-decoration:none;padding:10px 16px;border-radius:5px}</style></head>
<body><main><h1>Esta dirección no existe</h1><p>No hay ninguna empresa en <code>${esc(host)}</code>. Revisa que la dirección esté bien escrita o entra desde el sitio principal.</p>
<a href="${esc(c.publicUrl)}/entrar">Ir a Omnegia</a></main></body></html>`;
}
