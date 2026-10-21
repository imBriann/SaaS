import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Insignia } from '../Layout';
import { Icon } from '../icons';
import { OrbeCara } from './OrbeCara';
import { useIA } from './contexto';
import { usePuedeIA } from './PanelIA';

/**
 * Barra superior del panel (escritorio): la empresa a la izquierda y, a la derecha, la pregunta rápida
 * a Omnegia IA (⌘K), el chat y la campana con lo que espera en Conversaciones. En el teléfono la
 * reemplaza la cabecera móvil.
 */
export function BarraSuperior({ marca, empresa, rol, pendientes, urgente, textoAviso, veConversaciones }: {
  marca: ReactNode; empresa: string; rol: string; pendientes: number; urgente: boolean; textoAviso: string; veConversaciones: boolean;
}) {
  const { abrirPanel, panelAbierto } = useIA();
  const puedeIA = usePuedeIA();
  const [q, setQ] = useState('');
  const [foco, setFoco] = useState(false);
  const enviar = (e: FormEvent) => { e.preventDefault(); abrirPanel(q); setQ(''); };
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header className="barra-superior">
      <Link to="/" className="bs-empresa" aria-label={`${empresa}, inicio`}>{marca}<span><b>{empresa}</b><small>{rol}</small></span></Link>
      <div className="bs-acciones">
        {puedeIA && (
          <form className={`bs-pregunta ${foco ? 'foco' : ''}`} onSubmit={enviar} role="search">
            <OrbeCara tamano={22} cara={q.trim() ? 'escuchando' : 'normal'} />
            <input value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => setFoco(true)} onBlur={() => setFoco(false)} placeholder="Pregúntale a Omnegia IA…" aria-label="Pregunta a Omnegia IA" maxLength={1000} />
            {!q && <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>}
            <button type="submit" className="bs-enviar" aria-label="Preguntar"><Icon n={q.trim() ? 'enviar' : 'buscar'} className="" size={15} /></button>
          </form>
        )}
        {puedeIA && (
          <button type="button" className={`bs-circulo ${panelAbierto ? 'on' : ''}`} onClick={() => abrirPanel()} aria-label="Abrir el chat de Omnegia IA" title="Chat con Omnegia IA">
            <Icon n="ia" className="" size={18} />
          </button>
        )}
        {veConversaciones && (
          <Link to="/conversaciones" className="bs-circulo" aria-label={pendientes ? `Avisos: ${textoAviso}` : 'Sin avisos nuevos'} title={pendientes ? textoAviso : 'Sin avisos nuevos'}>
            <Icon n="campana" className={pendientes ? 'bs-campana-suena' : ''} size={18} />
            {pendientes > 0 && <Insignia n={pendientes} urgente={urgente} flotante />}
          </Link>
        )}
      </div>
    </header>
  );
}
