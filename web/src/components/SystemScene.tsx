import { useState, type CSSProperties } from 'react';
import { Icon } from './icons';
import { MARCA } from '../brand';

const PIEZAS = [
  { id: 'conversaciones', nombre: 'Conversaciones', icono: 'conversaciones', grupo: 0, x: 0, y: 0 },
  { id: 'agenda', nombre: 'Agenda', icono: 'agenda', grupo: 1, x: 1, y: 0 },
  { id: 'ventas', nombre: 'Ventas', icono: 'ventas', grupo: 1, x: 2, y: 1 },
  { id: 'clientes', nombre: 'Clientes', icono: 'clientes', grupo: 0, x: 0, y: 1 },
  { id: 'inventario', nombre: 'Inventario', icono: 'inventario', grupo: 1, x: 1, y: 2 },
  { id: 'ia', nombre: 'Asistente IA', icono: 'ia', grupo: 2, x: 2, y: 2 },
];
const VISTAS = [
  { nombre: 'Atención', titulo: 'Cada conversación, en su lugar.', texto: 'Consulta el historial de tus clientes y pasa la conversación a una persona cuando haga falta.' },
  { nombre: 'Operación', titulo: 'De la cita a la venta.', texto: 'Organiza tu agenda, registra ventas y consulta las existencias desde el mismo espacio de trabajo.' },
  { nombre: 'Control', titulo: 'La IA ayuda. Tú decides.', texto: 'Los permisos delimitan las acciones del asistente. Sus ejecuciones quedan registradas para revisarlas.' },
];

/** Relieve CSS: sin motor WebGL, descargas de modelos ni bucle de renderizado.
 * Los controles y su explicación siguen disponibles en la alternativa plana. */
export function SystemScene() {
  const [vista, setVista] = useState(0);
  const [plana, setPlana] = useState(false);
  return <figure className={`system-scene ${plana ? 'is-flat' : ''}`}>
    <div className="system-stage" aria-hidden="true">
      <div className="system-orbit"><span /><span /><span /></div>
      <div className="system-platform">
        <div className="system-foundation" />
        <div className="system-core"><img src={MARCA.isologo} alt="" /><span>Tu negocio</span></div>
        {PIEZAS.map((p, i) => <div key={p.id} className={`system-piece ${p.grupo === vista ? 'is-lit' : ''}`} style={{ '--x': p.x, '--y': p.y, '--i': i } as CSSProperties}>
          <span className="piece-edge" /><div className="piece-face"><Icon n={p.icono} size={30} className="" /><span>{p.nombre}</span><i /></div>
        </div>)}
      </div>
    </div>
    <figcaption className="system-caption">
      <div className="system-controls" role="group" aria-label="Explorar cómo se conecta la plataforma">
        {VISTAS.map((v, i) => <button key={v.nombre} type="button" aria-pressed={vista === i} onClick={() => setVista(i)}>{v.nombre}<Icon n="flecha" size={14} className="scene-arrow" /></button>)}
      </div>
      <div className="system-description" aria-live="polite"><strong>{VISTAS[vista].titulo}</strong><p>{VISTAS[vista].texto}</p></div>
      <div className="system-foot"><span>Representación de los módulos</span><button type="button" aria-pressed={plana} onClick={() => setPlana(!plana)}>{plana ? 'Vista con profundidad' : 'Vista simple'}</button></div>
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
