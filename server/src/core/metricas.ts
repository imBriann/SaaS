import type { Database } from '../db/index.js';

/**
 * Métricas HTTP agregadas en memoria y volcadas por minuto a metrica_http.
 * Solo se guarda la plantilla de ruta (/api/t/clientes/:id), nunca la URL real,
 * parámetros, cuerpos ni identidades. Histograma de latencia en cubetas fijas.
 */
export const CUBETAS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000];

interface Acumulado { n: number; suma: number; max: number; hist: number[] }
let acumulado = new Map<string, Acumulado>();
export const inicioProceso = new Date();

const minuto = (d = new Date()) => { const m = new Date(d); m.setSeconds(0, 0); return m.toISOString(); };

export function registrarPeticion(metodo: string, ruta: string, estado: number, ms: number) {
  const clase = Math.min(5, Math.max(1, Math.floor(estado / 100)));
  const clave = `${minuto()}|${metodo}|${ruta}|${clase}`;
  const a = acumulado.get(clave) ?? { n: 0, suma: 0, max: 0, hist: Array(CUBETAS_MS.length + 1).fill(0) };
  a.n += 1;
  a.suma += ms;
  a.max = Math.max(a.max, ms);
  const i = CUBETAS_MS.findIndex((b) => ms <= b);
  a.hist[i === -1 ? CUBETAS_MS.length : i] += 1;
  acumulado.set(clave, a);
}

/** Escribe lo acumulado. Si la base falla, los datos vuelven a la memoria para el siguiente intento. */
export async function volcarMetricas(db: Database) {
  if (!acumulado.size) return 0;
  const lote = acumulado;
  acumulado = new Map();
  try {
    await db.withPlatform(async (tx) => {
      for (const [clave, a] of lote) {
        const [min, metodo, ruta, clase] = clave.split('|');
        await tx.query(
          `INSERT INTO metrica_http (minuto, metodo, ruta, clase, n, suma_ms, max_ms, hist) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (minuto, metodo, ruta, clase) DO UPDATE SET n=metrica_http.n+EXCLUDED.n, suma_ms=metrica_http.suma_ms+EXCLUDED.suma_ms,
             max_ms=greatest(metrica_http.max_ms, EXCLUDED.max_ms),
             hist=(SELECT array_agg(a+b ORDER BY i) FROM unnest(metrica_http.hist, EXCLUDED.hist) WITH ORDINALITY AS x(a,b,i))`,
          [min, metodo, ruta.slice(0, 120), Number(clase), a.n, Math.round(a.suma), Math.round(a.max), a.hist]);
      }
    });
    return lote.size;
  } catch {
    for (const [k, v] of lote) if (!acumulado.has(k)) acumulado.set(k, v);
    return 0;
  }
}

/** Percentil aproximado a partir del histograma (límite superior de la cubeta). */
export function percentil(hist: number[], p: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let acum = 0;
  for (let i = 0; i < hist.length; i++) {
    acum += hist[i];
    if (acum / total >= p) return i < CUBETAS_MS.length ? CUBETAS_MS[i] : CUBETAS_MS[CUBETAS_MS.length - 1] * 2;
  }
  return null;
}

export function iniciarVolcadoMetricas(db: Database, cadaMs = 30_000) {
  const t = setInterval(() => { void volcarMetricas(db); }, cadaMs);
  t.unref();
  return async () => { clearInterval(t); await volcarMetricas(db); };
}
