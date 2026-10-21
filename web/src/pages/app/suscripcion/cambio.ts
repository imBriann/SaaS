import { useRef, useState } from 'react';
import { api, ApiError, cop, fecha, fechaCompleta } from '../../../api';

export type Ciclo = 'MENSUAL' | 'ANUAL';

export interface PlanCat {
  codigo: string; nombre: string; descripcion: string; mensual: number; anual: number; anual_por_mes: number; ahorro_anual: number;
  pactado: boolean; caracteristicas: string[]; destacado: boolean; actual: boolean;
  cuotas: { tokens_ia: number; mensajes: number; documentos: number; usuarios: number };
}
export interface Catalogo { actual: string; ciclo: Ciclo; estado: string; modalidad: string; cambio_programado: any; planes: PlanCat[] }

export interface Cotizacion {
  tipo: 'SIN_CAMBIO' | 'INMEDIATO' | 'PROGRAMADO' | 'RENOVAR';
  de: { plan: string; nombre: string; ciclo: Ciclo; precio: number };
  a: { plan: string; nombre: string; ciclo: Ciclo; precio: number };
  dias_restantes: number; dias_periodo: number; credito: number; cargo: number;
  aplica_desde: string; proximo_cobro: { fecha: string; monto: number };
  modulos_que_se_apagan: string[]; bloqueo: string | null; explicacion: string;
}

export interface Aviso { id: number; texto: string; accion?: { texto: string; fn: () => void } }

/** Color de cada plan (esfera, barra y botón). */
export const TONOS: Record<string, { c1: string; c2: string; fondo: string; boton: string; tinta: string }> = {
  esencial: { c1: '#ffe3ec', c2: '#ef7fa6', fondo: 'linear-gradient(165deg, #ffe6ee 0%, #f9bcd1 100%)', boton: '#f3a0bf', tinta: '#5b1d36' },
  negocio: { c1: '#ece6ff', c2: '#9a82ef', fondo: 'linear-gradient(165deg, #efe9ff 0%, #c9bbf8 55%, #b9dcf7 100%)', boton: '#b7a5f6', tinta: '#2e1f6b' },
  pro: { c1: '#e2f2ff', c2: '#5eaee9', fondo: 'linear-gradient(165deg, #e4f3ff 0%, #a9d4f5 100%)', boton: '#8fc7f0', tinta: '#123a5c' },
};
export const tono = (codigo: string) => TONOS[codigo] ?? TONOS.negocio;

/** Precio corto para las barras colapsadas: $229k. */
export const corto = (n: number) => `$${Math.round(n / 1000)}k`;

/** El checkout puede ser la pasarela de prueba (misma web) o Wompi. */
export function irACheckout(url: string) {
  window.location.assign(url.startsWith(window.location.origin) ? url.replace(window.location.origin, '') : url);
}

/** Texto del botón que confirma un cambio, según lo que el servidor dijo que pasaría. */
export function textoConfirmar(c: Cotizacion | null) {
  if (!c || c.tipo === 'SIN_CAMBIO') return 'Sin cambios';
  if (c.tipo === 'RENOVAR') return `Renovar con ${c.a.nombre} · ${cop(c.cargo)}`;
  if (c.tipo === 'PROGRAMADO') return `Programar el cambio a ${c.a.nombre}`;
  return c.cargo ? `Pagar ${cop(c.cargo)} y cambiar` : `Cambiar a ${c.a.nombre}`;
}

export type Resultado = { tipo: 'PROGRAMADO' | 'APLICADO'; cotizacion: Cotizacion };

/**
 * Cotizar y confirmar un cambio de plan. El servidor calcula el cargo; aquí solo se envía el que se mostró
 * para que, si cambió entre tanto, el servidor no cobre y devuelva la cotización vigente.
 */
export function useCambioPlan(onHecho: (r: Resultado) => void) {
  const [cot, setCot] = useState<Cotizacion | null>(null);
  const [cargando, setCargando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState('');
  const turno = useRef(0);

  const cotizar = async (plan: string, ciclo: Ciclo) => {
    const n = ++turno.current;
    setCargando(true); setError('');
    try {
      const c = await api.get<Cotizacion>(`/api/t/suscripcion/cambio?${new URLSearchParams({ plan, ciclo })}`);
      if (n === turno.current) setCot(c);
      return c;
    } catch (e) {
      if (n === turno.current) { setCot(null); setError((e as Error).message); }
      return null;
    } finally { if (n === turno.current) setCargando(false); }
  };

  const confirmar = async () => {
    if (!cot || cot.tipo === 'SIN_CAMBIO' || cot.bloqueo) return;
    setEnviando(true); setError('');
    try {
      const r = await api.post<any>('/api/t/suscripcion/cambio', { plan: cot.a.plan, ciclo: cot.a.ciclo, cargo: cot.cargo });
      if (r.tipo === 'PAGO') { irACheckout(r.url); return; }
      if (r.tipo === 'RENOVAR') {
        const p = await api.post<any>('/api/t/suscripcion/pagar', { ciclo: cot.a.ciclo });
        if (p?.url) { irACheckout(p.url); return; }
      }
      if (r.tipo === 'PROGRAMADO' || r.tipo === 'APLICADO') onHecho({ tipo: r.tipo, cotizacion: r.cotizacion });
      setEnviando(false);
    } catch (e) {
      const nueva = e instanceof ApiError ? e.details?.cotizacion : null;
      if (nueva) setCot(nueva);
      setError((e as Error).message);
      setEnviando(false);
    }
  };

  const limpiar = () => { turno.current++; setCot(null); setError(''); setCargando(false); };
  return { cot, cargando, enviando, error, cotizar, confirmar, limpiar };
}

/** Fecha corta; con el año cuando no es el actual (un plan anual se renueva el año siguiente). */
export const fechaCobro = (d: string | Date) => (new Date(d).getFullYear() !== new Date().getFullYear() ? fechaCompleta(d) : fecha(d));

/** Texto del aviso tras un cambio. */
export function textoResultado(r: Resultado) {
  const c = r.cotizacion;
  if (r.tipo === 'PROGRAMADO') return `Cambiarás a ${c.a.nombre}${c.a.ciclo === 'ANUAL' ? ' anual' : c.a.ciclo !== c.de.ciclo ? ' mensual' : ''} el ${fechaCobro(c.aplica_desde)}`;
  return `Cambiaste a ${c.a.nombre}`;
}
