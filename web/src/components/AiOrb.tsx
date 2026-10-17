import { useEffect, useRef, useState } from 'react';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';

/**
 * Orbe de la IA. Al cambiar de estado no salta: el estado nuevo aparece sobre el anterior con un fundido
 * y el anterior se retira. La librería gestiona su reloj, la visibilidad y el movimiento reducido.
 */
export function AiOrb({ state = 'breathing', size = 64, large = false, theme = 'light', label = 'Asistente de Omnegia' }: {
  state?: OrbState; size?: 20 | 64; large?: boolean; theme?: 'light' | 'dark'; label?: string;
}) {
  const [capas, setCapas] = useState<{ id: number; state: OrbState }[]>([{ id: 0, state }]);
  const siguiente = useRef(1);
  useEffect(() => {
    setCapas(actuales => actuales[actuales.length - 1]?.state === state ? actuales : [...actuales.slice(-1), { id: siguiente.current++, state }]);
  }, [state]);
  useEffect(() => {
    if (capas.length < 2) return;
    const t = window.setTimeout(() => setCapas(actuales => actuales.slice(-1)), 700);
    return () => window.clearTimeout(t);
  }, [capas]);
  return <span className={`ai-orb ${large ? 'ai-orb-large' : ''}`} role="img" aria-label={label}>
    {capas.map((c, i) => <span key={c.id} className={`ai-orb-layer ${i === capas.length - 1 ? 'is-current' : 'is-leaving'}`} aria-hidden="true">
      <ThinkingOrb state={c.state} size={size} theme={theme} aria-hidden="true" />
    </span>)}
  </span>;
}
