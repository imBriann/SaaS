import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './icons';
import { ApiError, fechaHora, num } from '../api';

// ---------------------------------------------------------------- datos
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: { cada?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [cargando, setCargando] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cargar = useCallback(async (silencioso = false) => {
    if (!silencioso) setCargando(true);
    try { setData(await fnRef.current()); setError(null); }
    catch (e) { setError(e as ApiError); }
    finally { setCargando(false); }
  }, []);
  useEffect(() => { cargar(); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!opts.cada) return;
    const t = setInterval(() => cargar(true), opts.cada);
    return () => clearInterval(t);
  }, [opts.cada, cargar]);
  return { data, error, cargando, recargar: () => cargar(true), setData };
}

// ---------------------------------------------------------------- avisos
const ToastCtx = createContext<(m: string, err?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ m: string; err?: boolean } | null>(null);
  const show = useCallback((m: string, err?: boolean) => {
    setT({ m, err });
    setTimeout(() => setT(null), err ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <div className={`toast ${t.err ? 'err' : ''}`} role="status">{t.m}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Ejecuta una acción mostrando el resultado; el error sale en lenguaje llano. */
export function useAccion() {
  const toast = useToast();
  const [ocupado, setOcupado] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, exito?: string): Promise<T | undefined> => {
    setOcupado(true);
    try {
      const r = await fn();
      if (exito) toast(exito);
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return undefined;
    } finally { setOcupado(false); }
  };
  return { run, ocupado };
}

// ---------------------------------------------------------------- estados (§11)
type Tono = 'ok' | 'warn' | 'err' | 'info' | 'neutro' | 'ia';
const ESTADOS: Record<string, [Tono, string, string]> = {
  // fiscal
  PENDIENTE: ['warn', 'reloj', 'Pendiente'], ENVIADO: ['warn', 'reloj', 'Enviado a la DIAN'], VALIDADO: ['ok', 'ok', 'Validado DIAN'],
  ENTREGADO: ['ok', 'ok', 'Entregado'], RECHAZADO: ['err', 'x', 'Rechazado'],
  // ventas y citas
  CONFIRMADA: ['ok', 'ok', 'Confirmada'], ANULADA: ['neutro', 'x', 'Anulada'], BORRADOR: ['neutro', 'reloj', 'Borrador'],
  RESERVADA: ['neutro', 'reloj', 'Reservada'], CANCELADA: ['neutro', 'x', 'Cancelada'], ATENDIDA: ['ok', 'ok', 'Atendida'], NO_ASISTIO: ['warn', 'alerta', 'No asistió'],
  PAGADA: ['ok', 'ok', 'Pagada'],
  // conversaciones y casos
  ABIERTA: ['neutro', 'conversaciones', 'Abierta'], ESCALADA: ['info', 'persona', 'Escalada'], CERRADA: ['neutro', 'ok', 'Cerrada'],
  EN_COLA: ['warn', 'reloj', 'En cola'], ASIGNADO: ['info', 'persona', 'Asignado'], EN_ATENCION: ['info', 'persona', 'En atención'], CERRADO: ['neutro', 'ok', 'Cerrado'],
  // IA
  PERMITIDA: ['ok', 'ok', 'Permitida'], DENEGADA: ['err', 'candado', 'Denegada'], PENDIENTE_CONFIRMACION: ['warn', 'reloj', 'Espera confirmación'],
  RECHAZADA_POR_CLIENTE: ['neutro', 'x', 'Rechazada por el cliente'], ERROR: ['err', 'alerta', 'Error'],
  // suscripción
  ACTIVA: ['ok', 'ok', 'Activa'], PAGO_PENDIENTE: ['warn', 'reloj', 'Pago pendiente'], EN_GRACIA: ['warn', 'alerta', 'En periodo de gracia'],
  SUSPENDIDA: ['err', 'candado', 'Suspendida'],
  // auditoría
  EXITO: ['ok', 'ok', 'Éxito'], PERMITIDO: ['ok', 'ok', 'Permitido'], DENEGADO: ['err', 'candado', 'Denegado'], NO_ENCONTRADO: ['err', 'candado', 'No encontrado'],
  // riesgo
  lectura: ['neutro', 'info', 'Lectura'], reversible: ['neutro', 'info', 'Reversible'], confirmable: ['warn', 'alerta', 'Confirmable'], critica: ['err', 'candado', 'Crítica'],
  AGENTE: ['ia', 'ia', 'Agente IA'], PANEL: ['neutro', 'persona', 'Panel'], PERSONA: ['info', 'persona', 'Persona'],
};
export function Estado({ v, texto }: { v: string | null | undefined; texto?: string }) {
  if (!v) return <span className="tenue">—</span>;
  const [tono, ico, label] = ESTADOS[v] ?? ['neutro', 'info', v];
  return <span className={`estado ${tono}`}><Icon n={ico} className="" />{texto ?? label}</span>;
}

// ---------------------------------------------------------------- bloques
export function Tarjeta({ titulo, acciones, children, nivel = 2, className = '', sinCuerpo }: { titulo?: ReactNode; acciones?: ReactNode; children: ReactNode; nivel?: 1 | 2 | 3; className?: string; sinCuerpo?: boolean }) {
  const cls = nivel === 1 ? 'contenedor' : nivel === 3 ? 'decision' : 'tarjeta';
  return (
    <section className={`${cls} ${className}`}>
      {titulo && <div className="cab"><h2 className="titulo-tarjeta">{titulo}</h2><div className="fila" style={{ marginLeft: 'auto' }}>{acciones}</div></div>}
      {sinCuerpo ? children : <div className="cuerpo">{children}</div>}
    </section>
  );
}

export function Cifra({ etiqueta, valor, detalle }: { etiqueta: string; valor: ReactNode; detalle?: ReactNode }) {
  return (
    <div className="tarjeta col" style={{ gap: 10, padding: '24px 28px' }}>
      <span className="etiqueta">{etiqueta}</span>
      <span className="cifra">{valor}</span>
      {detalle && <span className="tenue">{detalle}</span>}
    </div>
  );
}

export function Vacio({ titulo, children, accion }: { titulo: string; children?: ReactNode; accion?: ReactNode }) {
  return <div className="vacio"><b>{titulo}</b>{children && <span>{children}</span>}{accion}</div>;
}

export function Cargando({ filas = 4 }: { filas?: number }) {
  return (
    <div className="col" style={{ padding: 16, gap: 12 }} aria-busy="true" aria-label="Cargando">
      {Array.from({ length: filas }).map((_, i) => <div key={i} className="esqueleto" style={{ width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

/** Estado «Bloqueado»: el texto lo fija la arquitectura (DD-03), no el diseño. */
export function ErrorCarga({ error, reintentar }: { error: ApiError; reintentar?: () => void }) {
  if (error.status === 404) return <div className="bloqueado"><Icon n="candado" className="" size={16} /> No encontramos eso.</div>;
  if (error.status === 403) return <div className="bloqueado"><Icon n="candado" className="" size={16} /> Tu rol no tiene acceso a esta sección.</div>;
  return (
    <div className="tarjeta fila entre" style={{ padding: '20px 28px' }}>
      <span><b>No pudimos cargar esta información.</b> <span className="tenue">{error.message}</span></span>
      {reintentar && <button className="btn" onClick={reintentar}>Reintentar</button>}
    </div>
  );
}

export function Modal({ titulo, children, onCerrar, pie }: { titulo: string; children: ReactNode; onCerrar: () => void; pie?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCerrar]);
  return (
    <div className="capa" onClick={onCerrar}>
      <div className="decision modal" role="dialog" aria-modal="true" aria-label={titulo} onClick={(e) => e.stopPropagation()}>
        <div className="cab"><h2 className="titulo-tarjeta" style={{ fontSize: 21 }}>{titulo}</h2><button className="btn sutil peq" style={{ marginLeft: 'auto', width: 32, padding: 0 }} onClick={onCerrar} aria-label="Cerrar"><Icon n="x" className="" size={16} /></button></div>
        <div className="cuerpo col" style={{ gap: 16 }}>{children}</div>
        {pie && <div className="pie">{pie}</div>}
      </div>
    </div>
  );
}

/** Confirmación con resumen del efecto: obligatoria en acciones críticas (§15). */
export function Confirmar({ titulo, efecto, riesgo = 'confirmable', textoBoton, onConfirmar, onCerrar, pedirMotivo }: {
  titulo: string; efecto: ReactNode; riesgo?: 'confirmable' | 'critica'; textoBoton: string; onConfirmar: (motivo: string) => void; onCerrar: () => void; pedirMotivo?: boolean;
}) {
  const [motivo, setMotivo] = useState('');
  return (
    <Modal titulo={titulo} onCerrar={onCerrar} pie={<>
      <button className="btn" onClick={onCerrar}>Volver</button>
      <button className={`btn ${riesgo === 'critica' ? 'peligro' : 'primario'}`} disabled={pedirMotivo && motivo.trim().length < 5} onClick={() => onConfirmar(motivo)}>{textoBoton}</button>
    </>}>
      <div className="fila"><Estado v={riesgo} /> <span className="tenue">{riesgo === 'critica' ? 'Acción irreversible: queda en auditoría reforzada.' : 'Requiere confirmación explícita.'}</span></div>
      <div>{efecto}</div>
      {pedirMotivo && <label className="campo"><span>Motivo</span><textarea className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Explica por qué (mínimo 5 caracteres)" /></label>}
    </Modal>
  );
}

export function Interruptor({ on, onChange, disabled, etiqueta }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; etiqueta: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={etiqueta} className={`interruptor ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} />;
}

// ---------------------------------------------------------------- componentes firma (§7.5)
const HERR_LEGIBLE: Record<string, string> = {
  consultar_catalogo: 'Consultó el catálogo', consultar_precio: 'Consultó un precio', consultar_disponibilidad: 'Consultó disponibilidad',
  crear_cita: 'Crear cita', mis_citas: 'Consultó citas del cliente', cancelar_cita: 'Cancelar cita', consultar_inventario: 'Consultó existencias',
  registrar_venta: 'Registrar venta', generar_enlace_pago: 'Generó enlace de pago', estado_factura: 'Consultó facturas', escalar_a_humano: 'Escaló a una persona',
  resumen_ventas: 'Resumen de ventas', citas_del_dia: 'Citas del día', stock_bajo_minimo: 'Stock bajo mínimo', buscar_cliente: 'Buscó cliente',
  historial_cliente: 'Historial del cliente', consumo_del_plan: 'Consumo del plan', ayuda_plataforma: 'Ayuda de la plataforma', emitir_nota_credito: 'Emitir nota crédito',
};
const MOTIVOS: Record<string, string> = {
  herramienta_no_registrada_para_el_agente: 'La herramienta no existe para este agente',
  herramienta_deshabilitada: 'Herramienta apagada en el Centro de IA', modulo_inactivo: 'Módulo inactivo',
  argumentos_invalidos: 'Argumentos fuera del contrato', sin_cliente_en_contexto: 'Sin cliente en contexto',
  accion_critica_reservada_a_personas: 'Acción crítica: solo una persona', permiso_prohibido_a_agentes: 'Permiso prohibido a agentes',
  permiso_ausente: 'El rol del agente no tiene el permiso', limite_por_conversacion: 'Límite por conversación superado',
  recurso_no_encontrado: 'Recurso inexistente o de otra empresa',
};

/** Recibo de acción de IA (P9). Idéntico en hilo, detalle de venta, Centro de IA y auditoría. */
export function Recibo({ e, compacto }: { e: any; compacto?: boolean }) {
  const denegada = e.decision === 'DENEGADA' || e.decision === 'ERROR';
  const pendiente = e.decision === 'PENDIENTE_CONFIRMACION';
  return (
    <div className={`recibo ${denegada ? 'denegada' : pendiente ? 'pendiente' : ''}`}>
      <span className="ic"><Icon n={denegada ? 'candado' : 'ia'} className="" size={13} /></span>
      <span><b>{HERR_LEGIBLE[e.herramienta] ?? e.herramienta}</b> <span className="herr tenue">{e.herramienta}</span></span>
      <Estado v={e.decision} />
      <span className="meta">
        {e.nivel_riesgo && <span>riesgo <b>{e.nivel_riesgo}</b></span>}
        {e.permiso_requerido && <span className="mono">{e.permiso_requerido}</span>}
        {e.confirmado_por && <span>confirmó {e.confirmado_por.replace('CLIENTE:', 'cliente ')}</span>}
        {!compacto && e.creado_en && <span>{fechaHora(e.creado_en)}</span>}
        {!compacto && <Link to={`/auditoria?q=${e.id}`} className="mono">evento {String(e.id).slice(-8)}</Link>}
      </span>
      {denegada && e.motivo_denegacion && <span className="motivo">{e.comprobacion_fallida ? `Comprobación ${e.comprobacion_fallida} · ` : ''}{MOTIVOS[e.motivo_denegacion] ?? e.motivo_denegacion}</span>}
    </div>
  );
}

/** Ciclo del documento fiscal: venta → emitido → validado DIAN → entregado, con rama de rechazo. */
export function CicloFiscal({ estado, conteos }: { estado?: string; conteos?: { ventas: number; emitidas: number; validadas: number; entregadas: number; rechazadas: number } }) {
  const orden = ['VENTA', 'ENVIADO', 'VALIDADO', 'ENTREGADO'];
  const idx = estado === 'RECHAZADO' ? 1 : estado === 'PENDIENTE' ? 0 : orden.indexOf(estado ?? 'VENTA');
  const pasos = [
    { k: 'Venta', n: conteos?.ventas }, { k: 'Emitida', n: conteos?.emitidas }, { k: 'Validada DIAN', n: conteos?.validadas }, { k: 'Entregada', n: conteos?.entregadas },
  ];
  return (
    <div className="col">
      <div className="ciclo">
        {pasos.map((p, i) => {
          const fallo = estado === 'RECHAZADO' && i === 2;
          const hecho = conteos ? (p.n ?? 0) > 0 : i <= idx && !fallo;
          return (
            <div key={p.k} className={`paso ${fallo ? 'fallo' : hecho ? 'hecho' : ''}`}>
              <span className="punto">{fallo ? <Icon n="x" className="" size={12} /> : hecho ? <Icon n="ok" className="" size={12} /> : null}</span>
              {conteos && <span className="n">{p.n ?? 0}</span>}
              <span>{fallo ? 'Rechazada' : p.k}</span>
            </div>
          );
        })}
      </div>
      {conteos && conteos.rechazadas > 0 && <span className="estado err" style={{ alignSelf: 'center' }}><Icon n="x" className="" />{conteos.rechazadas} rechazada(s) por la DIAN</span>}
    </div>
  );
}

/** Medidor de cuota con proyección al cierre del mes. */
export function Medidor({ c, etiqueta, oscuro }: { c: any; etiqueta: string; oscuro?: boolean }) {
  if (!c) return null;
  const pct = Math.min(100, c.porcentaje ?? 0);
  const proy = Math.min(100, c.proyeccionPorcentaje ?? 0);
  const tono = c.porcentaje >= 100 ? 'err' : c.proyeccionPorcentaje >= 90 ? 'warn' : '';
  return (
    <div className="medidor">
      <div className="fila entre"><span className={oscuro ? '' : 'etiqueta'}>{etiqueta}</span><span className="num">{c.cuota ? `${Math.round(c.porcentaje)}%` : num(c.usado)}</span></div>
      {c.cuota ? <div className={`barra ${tono}`} title={`Proyección al cierre: ${proy}%`}><div className="proy" style={{ width: `${proy}%` }} /><div className="uso" style={{ width: `${pct}%` }} /></div> : <span className="tenue">Sin cuota en tu plan</span>}
      {!oscuro && c.cuota && <span className="tenue">{num(c.usado)} de {num(c.cuota)} · proyección al cierre {Math.round(c.proyeccionPorcentaje)}%{c.agotada ? ' · cuota agotada: se limita' : ''}</span>}
    </div>
  );
}

export function Campo({ etiqueta, ayuda, error, children }: { etiqueta: string; ayuda?: ReactNode; error?: string; children: ReactNode }) {
  return <label className="campo"><span>{etiqueta}{ayuda && <span className="ayuda"> · {ayuda}</span>}</span>{children}{error && <span className="error" role="alert">{error}</span>}</label>;
}
