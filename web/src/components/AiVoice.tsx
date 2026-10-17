import { useEffect, useState } from 'react';

const sinMovimiento = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Mensaje de la IA escrito en vivo: al cambiar, borra lo que sobra (como al corregir en un chat) y escribe
 * lo nuevo. Conserva el prefijo común para que una frase que solo crece no se reescriba entera.
 */
export function useEscrituraEnVivo(objetivo: string, { escribir = 16, borrar = 5 } = {}) {
  const [visible, setVisible] = useState(() => (sinMovimiento() ? objetivo : ''));
  useEffect(() => {
    if (sinMovimiento()) { setVisible(objetivo); return; }
    if (visible === objetivo) return;
    const borrando = !objetivo.startsWith(visible);
    const t = window.setTimeout(() => setVisible(v => (objetivo.startsWith(v) ? objetivo.slice(0, v.length + 1) : v.slice(0, -1))), borrando ? borrar : escribir);
    return () => window.clearTimeout(t);
  }, [objetivo, visible, escribir, borrar]);
  return { visible, escribiendo: visible !== objetivo };
}

export function AiVoice({ texto, className = '' }: { texto: string; className?: string }) {
  const { visible, escribiendo } = useEscrituraEnVivo(texto);
  return <>
    <p className={`ai-voice ${escribiendo ? 'is-typing' : ''} ${className}`} aria-hidden="true">{visible}<span className="ai-voice-caret" /></p>
    <p className="sr" role="status" aria-live="polite">{texto}</p>
  </>;
}
