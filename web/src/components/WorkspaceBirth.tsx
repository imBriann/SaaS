import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ThinkingOrb } from 'thinking-orbs';

const BirthContext = createContext<(() => void) | null>(null);

/** Only the actual loaded dashboard can release its first-run presentation. */
export function useWorkspaceBirthReady(ready: boolean) {
  const release = useContext(BirthContext);
  useEffect(() => { if (ready) release?.(); }, [ready, release]);
}

/** The query flag changes presentation only; tenant/session authorization stays in PanelLayout. */
export function WorkspaceBirth({ nombre, children }: { nombre: string; children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [active, setActive] = useState(() => new URLSearchParams(location.search).get('estreno') === '1');
  const [ready, setReady] = useState(false);
  const [stage, setStage] = useState(0);
  const firstPath = useRef(location.pathname);
  const release = useCallback(() => setReady(true), []);

  useEffect(() => {
    if (!active) return;
    const query = new URLSearchParams(location.search);
    if (query.has('estreno')) {
      query.delete('estreno');
      navigate({ pathname: location.pathname, search: query.toString() ? `?${query}` : '', hash: location.hash }, { replace: true });
    }
    if (location.pathname !== firstPath.current) setActive(false);
  }, [active, location.pathname, location.search, location.hash, navigate]);

  useEffect(() => {
    if (!active || !ready) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => { setStage(5); setActive(false); };
    if (motion.matches) { finish(); return; }
    // Reveal already loaded, real elements. This is presentation, not server progress.
    // Ritmo pausado: cada parte del panel real se ve nacer antes de soltarlo.
    const timers = [600, 1700, 2900, 4100, 5800].map((ms, i) => window.setTimeout(() => setStage(i + 1), ms));
    timers.push(window.setTimeout(finish, 6400));
    const change = () => { if (motion.matches) finish(); };
    motion.addEventListener('change', change);
    return () => { timers.forEach(clearTimeout); motion.removeEventListener('change', change); };
  }, [active, ready]);

  return <BirthContext.Provider value={release}>
    <div className={`workspace-birth ${active ? 'is-born' : ''}`} data-birth-stage={active ? stage : 5} aria-busy={active || undefined}>
      {children}
      {active && <div className="birth-presentation" aria-live="polite" role="status">
        <div className="birth-veil" aria-hidden="true" />
        <div className="birth-guide">
          <div className="birth-guide-orb"><ThinkingOrb state={ready ? 'weaving' : 'connecting'} size={64} theme="dark" aria-label={ready ? 'Presentando tu espacio' : 'Cargando tu espacio'} /></div>
          <div><b>{ready ? nombre : 'Abriendo tu espacio'}</b><span>{!ready ? 'Cargando tus datos…' : stage < 2 ? 'Tu marca y tus herramientas, en su lugar.' : stage < 4 ? 'Así se ve tu negocio en Omnegia.' : 'Todo listo. Este espacio ya es tuyo.'}</span></div>
        </div>
      </div>}
    </div>
  </BirthContext.Provider>;
}
