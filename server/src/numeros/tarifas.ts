import { config } from '../config.js';
import type { NumeroDisponible } from './proveedor.js';

/**
 * Modelo comercial de los números. Todo se calcula en el servidor y se congela en la
 * contratación: el navegador nunca envía un precio.
 *
 *   costo del proveedor (USD, de su API) × tasa (TRM oficial o fija) × (1 + colchón cambiario)
 *   × (1 + margen de Omnegia)  → precio del número (pesos, redondeado a la centena hacia arriba)
 *   + cargo de gestión de la activación de Omnegia (pesos)
 *   + IVA si el emisor es responsable (EMISOR_RESPONSABLE_IVA=1)
 *
 * Los cargos de Meta por mensaje no forman parte de este precio: los cobra Meta según su tarifa.
 */
export interface Tasa { valor: number; fuente: 'TRM' | 'CONFIGURADA' | 'MISMA_MONEDA'; vigente_desde: string | null }

export interface Cotizacion {
  version: 1;
  proveedor: string;
  entorno: 'real' | 'simulado';
  costo_proveedor: { activacion: number; mensual: number; moneda: string };
  tasa: Tasa & { colchon_pct: number };
  margen_pct: number;
  /** Precio del número (costo convertido + margen), sin IVA. */
  numero: { activacion: number; mensual: number };
  /** Parte del precio del número que corresponde al margen de Omnegia (informativo, ya incluido). */
  margen: { activacion: number; mensual: number };
  gestion_activacion: number;
  iva: { regimen: 'RESPONSABLE' | 'NO_RESPONSABLE' | 'PENDIENTE'; pct: number | null; hoy: number; mensual: number };
  total_hoy: number;
  total_mensual: number;
  moneda: 'COP';
  creada_en: string;
}

const centenaArriba = (n: number) => Math.ceil(n / 100) * 100;

let trm: { tasa: Tasa; en: number } | null = null;
export const olvidarTasa = () => { trm = null; };

/**
 * TRM vigente según la Superintendencia Financiera, publicada en datos.gov.co (conjunto 32sa-8pi3).
 * Si la consulta falla y no hay una TRM reciente en memoria, no se cotiza: nunca se supone una tasa.
 */
export async function tasaUsdCop(fetcher: typeof fetch = fetch): Promise<Tasa | null> {
  const fija = config.numeros.comercial.tasaUsdCop;
  if (fija) return { valor: fija, fuente: 'CONFIGURADA', vigente_desde: null };
  if (trm && Date.now() - trm.en < 6 * 3600_000) return trm.tasa;
  try {
    const res = await fetcher('https://www.datos.gov.co/resource/32sa-8pi3.json?$order=vigenciadesde%20DESC&$limit=1', { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
    const fila = res.ok ? ((await res.json()) as any[])?.[0] : null;
    const valor = Number(fila?.valor);
    if (fila && fila.unidad === 'COP' && valor > 500 && valor < 20_000) {
      trm = { tasa: { valor, fuente: 'TRM', vigente_desde: String(fila.vigenciadesde ?? '').slice(0, 10) || null }, en: Date.now() };
      return trm.tasa;
    }
  } catch { /* sin tasa confirmada */ }
  return trm && Date.now() - trm.en < 72 * 3600_000 ? trm.tasa : null;
}

export function cotizar(n: Pick<NumeroDisponible, 'costo'>, proveedor: { nombre: string; entorno: 'real' | 'simulado' }, tasa: Tasa, c = config): Cotizacion {
  const k = c.numeros.comercial;
  const colchon = n.costo.moneda === 'COP' ? 0 : k.colchonCambioPct;
  const factor = (n.costo.moneda === 'COP' ? 1 : tasa.valor) * (1 + colchon / 100);
  const sinMargen = (usd: number) => usd * factor;
  const conMargen = (usd: number) => centenaArriba(sinMargen(usd) * (1 + k.margenPct / 100));
  const numero = { activacion: conMargen(n.costo.activacion), mensual: conMargen(n.costo.mensual) };
  const margen = {
    activacion: Math.max(0, numero.activacion - Math.round(sinMargen(n.costo.activacion))),
    mensual: Math.max(0, numero.mensual - Math.round(sinMargen(n.costo.mensual))),
  };
  const regimen = c.documentos.responsableIva === '1' ? 'RESPONSABLE' : c.documentos.responsableIva === '0' ? 'NO_RESPONSABLE' : 'PENDIENTE';
  const pct = regimen === 'RESPONSABLE' ? c.documentos.ivaPct : null;
  const baseHoy = numero.activacion + numero.mensual + k.cargoActivacionCop;
  const ivaDe = (b: number) => (pct ? Math.round(b * pct / 100) : 0);
  return {
    version: 1, proveedor: proveedor.nombre, entorno: proveedor.entorno,
    costo_proveedor: { ...n.costo },
    tasa: { ...(n.costo.moneda === 'COP' ? { valor: 1, fuente: 'MISMA_MONEDA' as const, vigente_desde: null } : tasa), colchon_pct: colchon },
    margen_pct: k.margenPct, numero, margen, gestion_activacion: k.cargoActivacionCop,
    iva: { regimen, pct, hoy: ivaDe(baseHoy), mensual: ivaDe(numero.mensual) },
    // Hoy se paga la activación, el primer mes del número y la gestión; luego, cada mes, solo el número.
    total_hoy: baseHoy + ivaDe(baseHoy),
    total_mensual: numero.mensual + ivaDe(numero.mensual),
    moneda: 'COP', creada_en: new Date().toISOString(),
  };
}

/** Lo que Meta cobra aparte, en lenguaje claro y sin cifras que no estén confirmadas. */
export function cargosMeta(c = config) {
  const t = c.numeros.tarifasMeta;
  return {
    fuente: 'https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing',
    gratis: 'Responder dentro de las 24 horas siguientes al último mensaje de tu cliente no tiene cargo de Meta.',
    variable: 'Las plantillas que inicias tú (recordatorios, avisos, promociones) las cobra Meta por mensaje entregado, según la categoría y el país del destinatario.',
    tarifas: t.marketing || t.utilidad || t.autenticacion
      ? [
        ...(t.marketing ? [{ categoria: 'Marketing', cop: t.marketing }] : []),
        ...(t.utilidad ? [{ categoria: 'Utilidad', cop: t.utilidad }] : []),
        ...(t.autenticacion ? [{ categoria: 'Autenticación', cop: t.autenticacion }] : []),
      ]
      : null,
    nota: 'Meta actualiza sus tarifas periódicamente: el valor vigente es el de su tabla oficial.',
  };
}
