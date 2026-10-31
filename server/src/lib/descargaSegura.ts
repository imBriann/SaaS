import { lookup } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * Descarga desde el servidor protegida contra SSRF: solo https, sin IP privadas, locales, de enlace local ni de
 * metadatos (169.254.169.254), con límite de tiempo y de tamaño, y validando cada redirección. La IP se valida en
 * el momento de conectar (función lookup), así un cambio de DNS entre la comprobación y la conexión no la salta.
 */
export class DescargaBloqueada extends Error {}

/** ¿IP no pública? IPv4 privada, loopback, enlace local, CGNAT, multicast, reservada; IPv6 equivalentes. */
export function ipPrivada(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x === '::' || x === '::1') return true;
  if (x.startsWith('::ffff:')) return ipPrivada(x.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
}

const lookupSeguro: LookupFunction = (host, opts, cb) => {
  lookup(host, { ...opts, all: true }, (err, dirs) => {
    if (err) return cb(err, '', 0);
    const lista = (Array.isArray(dirs) ? dirs : [dirs]) as { address: string; family: number }[];
    const mala = lista.find((d) => ipPrivada(d.address));
    if (!lista.length || mala) return cb(new DescargaBloqueada(`Dirección no permitida (${host})`) as NodeJS.ErrnoException, '', 0);
    if ((opts as any)?.all) return (cb as any)(null, lista);
    cb(null, lista[0].address, lista[0].family);
  });
};

export function validarUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new DescargaBloqueada('URL no válida'); }
  if (u.protocol !== 'https:') throw new DescargaBloqueada('Solo se descargan enlaces https');
  if (u.username || u.password) throw new DescargaBloqueada('URL con credenciales');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new DescargaBloqueada('Host local no permitido');
  if (isIP(host) && ipPrivada(host)) throw new DescargaBloqueada('IP no pública');
  if (u.port && !['443', ''].includes(u.port)) throw new DescargaBloqueada('Puerto no permitido');
  return u;
}

export async function descargarSeguro(url: string, o: { maxBytes: number; timeoutMs: number; redirecciones?: number }): Promise<{ datos: Buffer; tipo: string | null; urlFinal: string }> {
  const u = validarUrl(url);
  return new Promise((ok, mal) => {
    const req = request(u, { method: 'GET', lookup: lookupSeguro, timeout: o.timeoutMs, headers: { 'user-agent': 'OmnegiaBot/1.0 (+imagenes de catalogo)', accept: 'image/*' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if ((o.redirecciones ?? 0) >= 3) return mal(new DescargaBloqueada('Demasiadas redirecciones'));
        const siguiente = new URL(res.headers.location, u).toString();
        return descargarSeguro(siguiente, { ...o, redirecciones: (o.redirecciones ?? 0) + 1 }).then(ok, mal);
      }
      if (code !== 200) { res.resume(); return mal(new DescargaBloqueada(`La imagen respondió ${code}`)); }
      const largo = Number(res.headers['content-length'] ?? 0);
      if (largo > o.maxBytes) { res.destroy(); return mal(new DescargaBloqueada('La imagen supera el tamaño máximo')); }
      const partes: Buffer[] = [];
      let total = 0;
      res.on('data', (b: Buffer) => {
        total += b.length;
        if (total > o.maxBytes) { res.destroy(); mal(new DescargaBloqueada('La imagen supera el tamaño máximo')); return; }
        partes.push(b);
      });
      res.on('end', () => ok({ datos: Buffer.concat(partes), tipo: (res.headers['content-type'] as string) ?? null, urlFinal: u.toString() }));
      res.on('error', mal);
    });
    req.on('timeout', () => req.destroy(new DescargaBloqueada('Tiempo de descarga agotado')));
    req.on('error', (e) => mal(e instanceof DescargaBloqueada ? e : new DescargaBloqueada(e.message)));
    req.end();
  });
}
