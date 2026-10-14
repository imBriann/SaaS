import type { FastifyInstance } from 'fastify';
import { AppError } from '../lib/errors.js';

/**
 * Límite de tasa por IP y regla, en memoria del proceso (ventana deslizante simple).
 * Protege endpoints públicos costosos (inicio de sesión, alta con IA). Con varias
 * instancias, cada una aplica su propio límite: el límite de intentos de inicio de
 * sesión, que sí es crítico, vive en la base (login_attempt).
 */
export interface Regla { prefijo: string; metodo: string; max: number; ventanaS: number }

export function crearLimitador(reglas: Regla[], ahora = () => Date.now()) {
  const marcas = new Map<string, number[]>();
  let ultimaLimpieza = ahora();
  return (ip: string, metodo: string, url: string): boolean => {
    const regla = reglas.find((r) => r.metodo === metodo && url.startsWith(r.prefijo));
    if (!regla) return true;
    const t = ahora();
    if (t - ultimaLimpieza > 60_000) {
      for (const [k, v] of marcas) if (!v.length || t - v[v.length - 1] > 3_600_000) marcas.delete(k);
      ultimaLimpieza = t;
    }
    const clave = `${regla.prefijo}|${ip}`;
    const lista = (marcas.get(clave) ?? []).filter((x) => t - x < regla.ventanaS * 1000);
    if (lista.length >= regla.max) { marcas.set(clave, lista); return false; }
    lista.push(t);
    marcas.set(clave, lista);
    return true;
  };
}

export function limitador(app: FastifyInstance, reglas: Regla[]) {
  if (process.env.NODE_ENV === 'test' && process.env.PROBAR_LIMITES !== '1') return;
  const permitir = crearLimitador(reglas);
  app.addHook('onRequest', async (req) => {
    if (!permitir(req.ip, req.method, req.url)) throw new AppError('QUOTA', 'Demasiadas solicitudes seguidas. Espera un minuto e intenta de nuevo.');
  });
}
