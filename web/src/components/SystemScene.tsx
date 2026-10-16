import { useState, type CSSProperties } from 'react';
import { Icon } from './icons';
import { MARCA } from '../brand';

const PIEZAS = [
  { id: 'conversaciones', nombre: 'Conversaciones', icono: 'conversaciones', grupo: 0, x: 0, y: 0, titulo: 'Retoma cada conversación con contexto.', texto: 'Reúne los mensajes de WhatsApp y el historial del cliente. Tu equipo puede continuar la atención cuando haga falta.' },
  { id: 'agenda', nombre: 'Agenda', icono: 'agenda', grupo: 1, x: 1, y: 0, titulo: 'Dale orden a tu próxima cita.', texto: 'Organiza citas, servicios y disponibilidad del equipo desde una misma agenda.' },
  { id: 'ventas', nombre: 'Ventas', icono: 'ventas', grupo: 1, x: 2, y: 1, titulo: 'Sigue cada venta, de principio a fin.', texto: 'Registra pedidos, consulta su estado y lleva el seguimiento de los pagos pendientes.' },
  { id: 'clientes', nombre: 'Clientes', icono: 'clientes', grupo: 0, x: 0, y: 1, titulo: 'Conoce el historial de cada cliente.', texto: 'Mantén sus datos organizados y consulta su relación con tu negocio desde el panel.' },
  { id: 'inventario', nombre: 'Inventario', icono: 'inventario', grupo: 1, x: 1, y: 2, titulo: 'Ten claro con qué cuentas.', texto: 'Consulta existencias y movimientos. Identifica los productos que están por debajo del mínimo.' },
  { id: 'ia', nombre: 'Asistente IA', icono: 'ia', grupo: 2, x: 2, y: 2, titulo: 'Pide ayuda sin perder el control.', texto: 'El asistente consulta información y usa las herramientas habilitadas según tus permisos. Puedes revisar sus acciones.' },
];
const VISTAS = [
  { nombre: 'Atención', titulo: 'Cada conversación, en su lugar.', texto: 'Consulta el historial de tus clientes y pasa la conversación a una persona cuando haga falta.' },
  { nombre: 'Operación', titulo: 'De la cita a la venta.', texto: 'Organiza tu agenda, registra ventas y consulta las existencias desde el mismo espacio de trabajo.' },
  { nombre: 'Control', titulo: 'La IA ayuda. Tú decides.', texto: 'Los permisos delimitan las acciones del asistente. Sus ejecuciones quedan registradas para revisarlas.' },
];

/** La elevación responde a la selección; no hay un bucle que sobrescriba la transición. */
export function SystemScene() {
  const [vista, setVista] = useState(0);
  const [pieza, setPieza] = useState<string | null>(null);
  const descripciones = [...VISTAS, ...PIEZAS];
  const descripcion = pieza ? VISTAS.length + PIEZAS.findIndex(p => p.id === pieza) : vista;
  return <figure className="system-scene">
    <div className="system-stage" role="group" aria-label="Selecciona un módulo para conocerlo">
      <div className="system-orbit" aria-hidden="true"><span /><span /><span /></div>
      <div className="system-platform">
        <div className="system-foundation" aria-hidden="true" />
        <div className="system-core" aria-hidden="true"><img src={MARCA.isologo} alt="" /><span>Tu negocio</span></div>
        {PIEZAS.map((p, i) => <button type="button" key={p.id} aria-pressed={pieza === p.id} aria-label={p.nombre} onClick={() => { setPieza(p.id); setVista(p.grupo); }} className={`system-piece ${p.grupo === vista ? 'is-lit' : ''} ${pieza === p.id ? 'is-selected' : ''}`} style={{ '--x': p.x, '--y': p.y, '--i': i } as CSSProperties}>
          <span className="piece-edge" aria-hidden="true" /><span className="piece-face"><Icon n={p.icono} size={30} className="" /><span>{p.nombre}</span><i aria-hidden="true" /></span>
        </button>)}
      </div>
    </div>
    <figcaption className="system-caption">
      <div className="system-module-picker" role="group" aria-label="Elegir un módulo">
        {PIEZAS.map(p => <button type="button" key={p.id} aria-label={`Explorar ${p.nombre}`} aria-pressed={pieza === p.id} onClick={() => { setPieza(p.id); setVista(p.grupo); }}><Icon n={p.icono} size={18} className="" />{p.nombre}</button>)}
      </div>
      <div className="system-controls" role="group" aria-label="Explorar cómo se conecta la plataforma">
        <span className="system-indicator" aria-hidden="true" style={{ transform: `translateX(${vista * 100}%)` }} />
        {VISTAS.map((v, i) => <button key={v.nombre} type="button" aria-pressed={vista === i} onClick={() => { setVista(i); setPieza(null); }}>{v.nombre}<Icon n="flecha" size={14} className="scene-arrow" /></button>)}
      </div>
      <div className="system-description">{descripciones.map((d, i) => <div key={d.nombre} className={`system-description-pane ${descripcion === i ? 'is-current' : ''}`} aria-hidden={descripcion !== i}><strong>{d.titulo}</strong><p>{d.texto}</p></div>)}</div>
      <span className="sr-only" aria-live="polite" aria-atomic="true">{descripciones[descripcion].titulo} {descripciones[descripcion].texto}</span>
    </figcaption>
  </figure>;
}

export function WorkspaceAssembly({ nombre, modulos, listo, error }: { nombre: string; modulos: string[]; listo: boolean; error: boolean }) {
  const nombres: Record<string, string> = { catalogo: 'Catálogo', facturacion: 'Facturación', comisiones: 'Comisiones', ...Object.fromEntries(PIEZAS.map(p => [p.id, p.nombre])) };
  return <div className={`workspace-assembly ${listo ? 'is-ready' : ''} ${error ? 'is-paused' : ''}`}>
    <div className="assembly-emblem" aria-hidden="true"><img src={MARCA.isologo} alt="" /></div>
    <div className="assembly-title"><strong>{nombre}</strong><span>{listo ? 'Tu espacio está preparado' : error ? 'Tu configuración se conserva' : 'Preparando tu espacio'}</span></div>
    <ul aria-label={listo ? 'Módulos habilitados' : 'Módulos de tu propuesta'}>{modulos.map((m, i) => <li key={m} style={{ '--i': i } as CSSProperties}><Icon n={m === 'catalogo' ? 'inventario' : m} size={16} className="" />{nombres[m] ?? m}{listo && <Icon n="ok" size={12} className="" />}</li>)}</ul>
    <p>{listo ? 'Espacio creado con la configuración registrada.' : 'Los estados de cada paso se confirman con el servidor.'}</p>
  </div>;
}
