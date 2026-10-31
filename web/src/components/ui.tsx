import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './icons';
import { ApiError, fechaHora, num } from '../api';
import { sonar } from '../lib/sonido';
export type { ApiError };

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
    sonar(err ? 'error' : 'ok');
    setTimeout(() => setT(null), err ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && <Aviso t={t} />}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** El aviso entra en la capa superior (popover) para verse también sobre un diálogo modal abierto. */
function Aviso({ t }: { t: { m: string; err?: boolean } }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { try { (ref.current as any)?.showPopover?.(); } catch { /* sin Popover API: queda como capa fija */ } }, [t]);
  return <div ref={ref} popover="manual" className={`toast ${t.err ? 'err' : ''}`} role={t.err ? 'alert' : 'status'}><Icon n={t.err ? 'alerta' : 'ok'} className="" size={16} />{t.m}</div>;
}

/** Ejecuta una acción mostrando el resultado; el error sale en lenguaje llano. */
export function useAccion() {
  const toast = useToast();
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async <T,>(fn: () => Promise<T>, exito?: string, opts: { silencioso?: boolean } = {}): Promise<T | undefined> => {
    setOcupado(true);
    setError(null);
    try {
      const r = await fn();
      if (exito) toast(exito);
      return r;
    } catch (e) {
      setError(e as ApiError);
      if (!opts.silencioso) toast((e as Error).message, true);
      return undefined;
    } finally { setOcupado(false); }
  };
  return { run, ocupado, error, limpiarError: () => setError(null) };
}

/** Paginación de listas servidas por páginas. */
export function Paginador({ pagina, total, porPagina, onPagina }: { pagina: number; total: number; porPagina: number; onPagina: (p: number) => void }) {
  const paginas = Math.max(1, Math.ceil(total / porPagina));
  if (total <= porPagina) return null;
  const desde = (pagina - 1) * porPagina + 1;
  const hasta = Math.min(total, pagina * porPagina);
  return (
    <nav className="paginador" aria-label="Paginación">
      <span className="tenue peq-txt">{desde}–{hasta} de {num(total)}</span>
      <span className="fila" style={{ gap: 4 }}>
        <button type="button" className="btn peq" disabled={pagina <= 1} onClick={() => onPagina(pagina - 1)} aria-label="Página anterior"><Icon n="atras" className="" size={14} />Anterior</button>
        <span className="peq-txt" aria-live="polite">Página {pagina} de {paginas}</span>
        <button type="button" className="btn peq" disabled={pagina >= paginas} onClick={() => onPagina(pagina + 1)} aria-label="Página siguiente">Siguiente<Icon n="derecha" className="" size={14} /></button>
      </span>
    </nav>
  );
}

/** Valor con retardo: evita una petición por cada tecla en los buscadores. */
export function useRetardo<T>(valor: T, ms = 300): T {
  const [v, setV] = useState(valor);
  useEffect(() => { const t = setTimeout(() => setV(valor), ms); return () => clearTimeout(t); }, [valor, ms]);
  return v;
}

// ---------------------------------------------------------------- estados (§11)
type Tono = 'ok' | 'warn' | 'err' | 'info' | 'neutro' | 'ia';
const ESTADOS: Record<string, [Tono, string, string]> = {
  // fiscal
  EN_REVISION: ['warn', 'reloj', 'En revisión'], REEMBOLSADO: ['ok', 'ok', 'Dinero devuelto'], APROBADO: ['warn', 'reloj', 'Aprobado: falta devolver'],
  PENDIENTE: ['warn', 'reloj', 'Pendiente'], ENVIADO: ['warn', 'reloj', 'Enviado a la DIAN'], VALIDADO: ['ok', 'ok', 'Validado DIAN'],
  ENTREGADO: ['ok', 'ok', 'Entregado'], RECHAZADO: ['err', 'x', 'Rechazado'],
  // ventas y citas
  CONFIRMADA: ['ok', 'ok', 'Confirmada'], ANULADA: ['neutro', 'x', 'Anulada'], BORRADOR: ['neutro', 'reloj', 'Borrador'],
  RESERVADA: ['neutro', 'reloj', 'Reservada'], CANCELADA: ['neutro', 'x', 'Cancelada'], ATENDIDA: ['ok', 'ok', 'Atendida'], NO_ASISTIO: ['warn', 'alerta', 'No asistió'],
  PAGADA: ['ok', 'ok', 'Pagada'], PAGADO: ['ok', 'ok', 'Pagado'], ABIERTO: ['warn', 'reloj', 'Esperando pago'], EXPIRADO: ['neutro', 'reloj', 'Vencido'],
  // entrega de mensajes
  LEIDO: ['ok', 'ok', 'Leído'], SIMULADO: ['neutro', 'info', 'Simulado'], FALLIDO: ['err', 'alerta', 'No entregado'],
  // invitaciones e integraciones
  ACEPTADA: ['ok', 'ok', 'Aceptada'], REVOCADA: ['neutro', 'x', 'Retirada'], EXPIRADA: ['neutro', 'reloj', 'Vencida'],
  EMITIDO: ['ok', 'ok', 'Emitido'], PENDIENTE_REGISTRO: ['warn', 'alerta', 'Necesita atención'], DESCONECTADO: ['neutro', 'info', 'Desconectado'],
  CONECTADO: ['ok', 'ok', 'Conectado'], SIN_CONFIGURAR: ['neutro', 'info', 'Sin configurar'], PENDIENTE_VERIFICAR: ['warn', 'reloj', 'Por verificar'],
  conectado: ['ok', 'ok', 'Conectado'], simulado: ['warn', 'info', 'Simulado'], pendiente: ['err', 'alerta', 'Pendiente de conectar'],
  APROBADA: ['ok', 'ok', 'Aprobada en Meta'], NO_REGISTRADA: ['neutro', 'info', 'Sin registrar'], PAUSADA: ['warn', 'alerta', 'Pausada'],
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
  // riesgo (en lenguaje del negocio)
  lectura: ['neutro', 'info', 'Solo consulta'], reversible: ['neutro', 'info', 'Cambio reversible'], confirmable: ['warn', 'alerta', 'Pide confirmación'], critica: ['err', 'candado', 'Solo una persona'],
  AGENTE: ['ia', 'ia', 'Agente IA'], PANEL: ['neutro', 'persona', 'Panel'], PERSONA: ['info', 'persona', 'Persona'],
  // soporte, incidentes y operador
  EN_PROCESO: ['info', 'persona', 'En proceso'], ESPERANDO_CLIENTE: ['warn', 'reloj', 'Esperando respuesta'], RESUELTO: ['ok', 'ok', 'Resuelto'],
  RECONOCIDO: ['info', 'persona', 'Reconocido'], CRITICA: ['err', 'alerta', 'Crítica'], ALTA: ['err', 'alerta', 'Alta'], MEDIA: ['warn', 'info', 'Media'], BAJA: ['neutro', 'info', 'Baja'],
  URGENTE: ['err', 'alerta', 'Urgente'], NORMAL: ['neutro', 'info', 'Normal'], SIN_SUSCRIPCION: ['neutro', 'info', 'Sin suscripción'],
  REBOTADO: ['err', 'x', 'Rebotó'], QUEJA: ['err', 'alerta', 'Marcado como spam'], SIN_CAMBIOS: ['neutro', 'info', 'Sin cambios'],
  ADMIN: ['info', 'candado', 'Administración'], SOPORTE: ['neutro', 'persona', 'Soporte'],
  // pagos de ventas
  REGISTRADO: ['ok', 'ok', 'Registrado'], ANULADO: ['neutro', 'x', 'Anulado'], EXCEDENTE: ['err', 'alerta', 'Pagado de más: devolver'],
  // atención por WhatsApp
  HUMANO: ['info', 'persona', 'Persona al frente'], AI: ['ia', 'ia', 'IA al frente'], WHATSAPP: ['neutro', 'conversaciones', 'WhatsApp'],
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

/** Dato clave. Va dentro de una franja `.kpis`, no como tarjeta suelta. */
export function Cifra({ etiqueta, valor, detalle }: { etiqueta: string; valor: ReactNode; detalle?: ReactNode }) {
  return (
    <div className="kpi">
      <span className="etiqueta">{etiqueta}</span>
      <span className="cifra">{valor}</span>
      {detalle && <span className="detalle">{detalle}</span>}
    </div>
  );
}

export function Vacio({ titulo, children, accion }: { titulo: string; children?: ReactNode; accion?: ReactNode }) {
  return <div className="vacio"><b>{titulo}</b>{children && <span>{children}</span>}{accion}</div>;
}

/** Mensaje del hilo único (P5): el remitente se nombra con texto e icono, no solo con color. */
export type TipoMensaje = 'cliente' | 'ia' | 'humano' | 'sistema' | 'nota';
const ROL: Record<TipoMensaje, [string, string]> = {
  cliente: ['Cliente', 'persona'], ia: ['Agente IA', 'ia'], humano: ['Asesor', 'persona'], sistema: ['Sistema', 'info'], nota: ['Nota interna', 'nota'],
};
export function Mensaje({ tipo, quien, rol, hora, meta, a, children }: { tipo: TipoMensaje; quien?: ReactNode; rol?: string; hora?: string; meta?: ReactNode; a?: string; children: ReactNode }) {
  const [etiqueta, ico] = ROL[tipo];
  const contenido = <>
      <div className="msg-quien">
        <span className="rol"><Icon n={ico} className="" />{rol ?? etiqueta}</span>
        {quien && <span className="cortar">· {quien}</span>}
        {hora && <span className="hora">· {hora}</span>}
      </div>
      <div className="msg-texto">{children}</div>
      {meta && <div className="msg-meta">{meta}</div>}
  </>;
  if (a) return <Link to={a} className={`msg ${tipo}`}>{contenido}</Link>;
  return <div className={`msg ${tipo}`}>{contenido}</div>;
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
  if (error.status === 404) return <div className="bloqueado"><Icon n="candado" className="" size={16} /> No encontramos eso. Puede que no exista o que pertenezca a otra empresa.</div>;
  if (error.status === 403) return <div className="bloqueado"><Icon n="candado" className="" size={16} /> Tu rol no tiene acceso a esta sección. Pide acceso a quien administra la empresa.</div>;
  return (
    <div className="aviso" role="alert" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <span className="fila" style={{ alignItems: 'flex-start' }}><Icon n="alerta" className="" size={16} /><span><b>No pudimos cargar esta información.</b> <span style={{ fontWeight: 400 }}>{error.message}{reintentar ? ' Vuelve a intentarlo; si persiste, revisa tu conexión.' : ''}</span></span></span>
      {reintentar && <button className="btn peq" onClick={reintentar}>Reintentar</button>}
    </div>
  );
}

const ENFOCABLES = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Diálogo modal sobre <dialog> nativo: showModal() deja el resto del documento
 * inerte y en la capa superior. Foco inicial en el primer campo o, si no hay
 * campos, en el propio diálogo (nombrado por su título). Tab y Mayús+Tab giran
 * dentro; Escape, la ✕ y el clic fuera llaman a onCerrar; al cerrar, el foco
 * vuelve al disparador si sigue en la página.
 */
export function Modal({ titulo, children, onCerrar, pie, className = '' }: { titulo: string; children: ReactNode; onCerrar: () => void; pie?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cerrar = useRef(onCerrar);
  cerrar.current = onCerrar;
  const idTitulo = useId();
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    const previo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dlg.open) dlg.showModal();
    const campo = dlg.querySelector<HTMLElement>('.cuerpo :is(input:not([type="hidden"]):not([type="range"]):not([disabled]), select:not([disabled]), textarea:not([disabled]))');
    (campo ?? dlg).focus();
    const tecla = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // showModal contiene el foco; el navegador recorre los controles internos del medio.
      if (dlg.querySelector('video[controls], audio[controls]')) return;
      const els = [...dlg.querySelectorAll<HTMLElement>(ENFOCABLES)].filter((el) => el.getClientRects().length > 0);
      if (!els.length) { e.preventDefault(); return; }
      const primero = els[0], ultimo = els[els.length - 1], act = document.activeElement;
      if (e.shiftKey && (act === primero || act === dlg || !dlg.contains(act))) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && (act === ultimo || !dlg.contains(act))) { e.preventDefault(); primero.focus(); }
    };
    // Escape: el diálogo no se cierra solo; lo desmonta quien lo abrió.
    const cancelar = (e: Event) => { e.preventDefault(); cerrar.current(); };
    dlg.addEventListener('keydown', tecla);
    dlg.addEventListener('cancel', cancelar);
    return () => {
      dlg.removeEventListener('keydown', tecla);
      dlg.removeEventListener('cancel', cancelar);
      if (dlg.open) dlg.close();
      if (previo?.isConnected) previo.focus();
    };
  }, []);
  const fuera = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onCerrar();
  };
  return (
    <dialog ref={ref} className={`modal ${className}`} aria-labelledby={idTitulo} tabIndex={-1} onClick={fuera}>
      <div className="cab"><h2 id={idTitulo} className="titulo-tarjeta" style={{ fontSize: 17 }}>{titulo}</h2><button type="button" className="btn sutil peq icono" style={{ marginLeft: 'auto' }} onClick={onCerrar} aria-label="Cerrar"><Icon n="x" className="" size={16} /></button></div>
      <div className="cuerpo col" style={{ gap: 16 }}>{children}</div>
      {pie && <div className="pie">{pie}</div>}
    </dialog>
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

// ---------------------------------------------------------------- componentes firma
/** Nombre de cada acción de la IA en lenguaje del negocio (los nombres internos no se muestran). */
export const ACCION_IA: Record<string, string> = {
  consultar_catalogo: 'Consultó el catálogo', consultar_precio: 'Consultó un precio', consultar_disponibilidad: 'Consultó la agenda',
  crear_cita: 'Agendar una cita', mis_citas: 'Consultó las citas del cliente', cancelar_cita: 'Cancelar una cita', consultar_inventario: 'Consultó existencias',
  registrar_venta: 'Registrar una venta', generar_enlace_pago: 'Generó un enlace de pago', estado_factura: 'Consultó facturas', escalar_a_humano: 'Pasó la conversación a una persona',
  resumen_ventas: 'Resumió las ventas', citas_del_dia: 'Consultó las citas del día', agenda_periodo: 'Consultó la agenda de varios días', mostrar_guia: 'Preparó una guía en pantalla', stock_bajo_minimo: 'Revisó productos bajo mínimo', buscar_cliente: 'Buscó un cliente',
  historial_cliente: 'Revisó el historial del cliente', consumo_del_plan: 'Consultó el consumo del plan', ayuda_plataforma: 'Explicó cómo usar el panel', emitir_nota_credito: 'Anular una factura (nota crédito)',
  crear_item_catalogo: 'Crear un ítem del catálogo', editar_item_catalogo: 'Editar un ítem del catálogo',
};
export const accionIA = (h: string) => ACCION_IA[h] ?? 'Acción del asistente';
const MOTIVOS: Record<string, string> = {
  herramienta_no_registrada_para_el_agente: 'Esa acción no está permitida para este asistente.',
  herramienta_deshabilitada: 'La apagaste en el Centro de IA.', modulo_inactivo: 'El módulo está desactivado.',
  argumentos_invalidos: 'La solicitud venía incompleta o con datos no válidos.', sin_cliente_en_contexto: 'No había un cliente identificado.',
  accion_critica_reservada_a_personas: 'Solo una persona del equipo puede hacerlo.', permiso_prohibido_a_agentes: 'Ningún asistente de IA puede hacerlo.',
  permiso_ausente: 'El asistente no tiene permiso para eso.', limite_por_conversacion: 'Se alcanzó el máximo de veces por conversación.',
  recurso_no_encontrado: 'No encontró lo que se pidió (no existe o es de otra empresa).',
};
export const motivoIA = (m?: string | null) => (m ? MOTIVOS[m] ?? (/^[a-z_]+$/.test(m) ? 'No se pudo completar.' : m) : '');

/** Recibo de acción de IA (P9). Idéntico en hilo, detalle de venta, Centro de IA y auditoría. */
export function Recibo({ e, compacto }: { e: any; compacto?: boolean }) {
  const denegada = e.decision === 'DENEGADA' || e.decision === 'ERROR';
  const pendiente = e.decision === 'PENDIENTE_CONFIRMACION';
  return (
    <div className={`recibo ${denegada ? 'denegada' : pendiente ? 'pendiente' : ''}`}>
      <span className="ic" aria-hidden="true"><Icon n={denegada ? 'candado' : pendiente ? 'reloj' : 'ia'} className="" size={14} /></span>
      <span className="que"><span className="sr">Acción de IA: </span><b>{accionIA(e.herramienta)}</b></span>
      <Estado v={e.decision} />
      <span className="meta">
        {e.nivel_riesgo && e.nivel_riesgo !== 'lectura' && <span>{ESTADOS[e.nivel_riesgo]?.[2] ?? e.nivel_riesgo}</span>}
        {e.confirmado_por && <span>Confirmó {e.confirmado_por.replace('CLIENTE:', 'el cliente ')}</span>}
        {!compacto && e.creado_en && <span>{fechaHora(e.creado_en)}</span>}
        {!compacto && e.id && <Link to={`/auditoria?q=${e.id}`}>Ver en auditoría</Link>}
      </span>
      {denegada && (e.motivo_denegacion || e.motivo) && <span className="motivo">{motivoIA(e.motivo_denegacion ?? e.motivo)}</span>}
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
      <div className="fila entre"><span className={oscuro ? 'peq-txt' : 'etiqueta'}>{etiqueta}</span><span className="valor">{c.cuota ? `${Math.round(c.porcentaje)}%` : num(c.usado)}</span></div>
      {c.cuota ? <div className={`barra ${tono}`} title={`Proyección al cierre: ${proy}%`}><div className="proy" style={{ width: `${proy}%` }} /><div className="uso" style={{ width: `${pct}%` }} /></div> : <span className="tenue">Sin cuota en tu plan</span>}
      {!oscuro && c.cuota && <span className="tenue">{num(c.usado)} de {num(c.cuota)} · proyección al cierre {Math.round(c.proyeccionPorcentaje)}%{c.agotada ? ' · cuota agotada: se limita' : ''}</span>}
    </div>
  );
}

export function Campo({ etiqueta, ayuda, error, children, guia }: { etiqueta: string; ayuda?: ReactNode; error?: string; children: ReactNode; guia?: string }) {
  return <label className="campo" data-guia={guia}><span>{etiqueta}{ayuda && <span className="ayuda"> · {ayuda}</span>}</span>{children}{error && <span className="error" role="alert">{error}</span>}</label>;
}

/**
 * Campo para un código de seis dígitos: teclado numérico en móvil, autocompletado
 * desde el correo o SMS (one-time-code) y pegado tolerante a espacios y guiones.
 */
export function CodigoOtp({ valor, onCambio, etiqueta = 'Código de 6 dígitos', autoFocus }: { valor: string; onCambio: (v: string) => void; etiqueta?: string; autoFocus?: boolean }) {
  return (
    <Campo etiqueta={etiqueta}>
      <input className="input codigo-otp" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} autoFocus={autoFocus}
        value={valor} onChange={(e) => onCambio(e.target.value.replace(/\D/g, '').slice(0, 6))} aria-describedby={undefined} placeholder="••••••" />
    </Campo>
  );
}

/** Cuenta atrás para reenviar un código (el servidor aplica el mismo límite). */
export function useCuentaAtras(segundosIniciales = 0) {
  const [s, setS] = useState(segundosIniciales);
  useEffect(() => {
    if (s <= 0) return;
    const t = setTimeout(() => setS((x) => x - 1), 1000);
    return () => clearTimeout(t);
  }, [s]);
  return { restante: s, iniciar: (n = 60) => setS(n) };
}

