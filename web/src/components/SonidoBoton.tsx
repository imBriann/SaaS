import { useSonido } from '../lib/sonido';
import { Icon } from './icons';

/** Interruptor de sonido (se recuerda en este navegador). */
export function SonidoBoton({ className = '', size = 18 }: { className?: string; size?: number }) {
  const [activo, cambiar] = useSonido();
  return (
    <button type="button" className={className} onClick={() => cambiar(!activo)} aria-pressed={activo} data-sin-tap
      aria-label={activo ? 'Silenciar los sonidos' : 'Activar los sonidos'} title={activo ? 'Sonidos activados' : 'Sonidos silenciados'}>
      <Icon n={activo ? 'volume' : 'volume-mute'} className="" size={size} />
    </button>
  );
}
