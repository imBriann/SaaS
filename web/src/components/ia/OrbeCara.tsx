import { useEffect, useState, type CSSProperties } from 'react';

export type Cara = 'normal' | 'feliz' | 'pensando' | 'hablando' | 'atenta' | 'escuchando' | 'confundida';

/**
 * La cara de Omnegia IA: esfera índigo con brillo, mejillas sonrojadas y una boquita.
 * Parpadea sola y de vez en cuando mira alrededor; cada estado tiene su gesto:
 *   escuchando → ladea la cabeza al ritmo y le salen ondas a los lados (la persona escribe).
 *   pensando   → mira hacia arriba, se balancea y una burbuja de puntos sube y baja.
 *   hablando   → la boca se abre y se cierra con pequeños saltitos.
 *   feliz      → ojos ^ ^, salta con un apretón y brillan chispitas alrededor.
 *   atenta     → ojos grandes y un leve acercamiento.
 *   confundida → ladea la cabeza, un ojo más pequeño y aparece un «?».
 * El color es exclusivo de la IA; el resto del panel usa el acento de cada empresa.
 * Con «reducir movimiento» la cara cambia de gesto pero no se mueve.
 */
export function OrbeCara({ tamano = 56, cara = 'normal', mirada, etiqueta, className = '' }: {
  tamano?: number; cara?: Cara; mirada?: { x: number; y: number }; etiqueta?: string; className?: string;
}) {
  // Parpadeo a intervalos irregulares (como una persona), nunca mientras está feliz.
  const [parpadeo, setParpadeo] = useState(false);
  useEffect(() => {
    if (cara === 'feliz') return;
    let t: number;
    const siguiente = () => {
      t = window.setTimeout(() => { setParpadeo(true); window.setTimeout(() => setParpadeo(false), 140); siguiente(); }, 2200 + Math.random() * 3200);
    };
    siguiente();
    return () => window.clearTimeout(t);
  }, [cara]);
  // En reposo mira alrededor de vez en cuando, como si curioseara la pantalla.
  const [curiosea, setCuriosea] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (cara !== 'normal' || mirada || tamano < 28) { setCuriosea(null); return; }
    let t: number;
    const otra = () => {
      t = window.setTimeout(() => {
        setCuriosea({ x: Math.random() * 1.6 - 0.8, y: Math.random() * 1.2 - 0.6 });
        window.setTimeout(() => setCuriosea(null), 1100);
        otra();
      }, 3800 + Math.random() * 4200);
    };
    otra();
    return () => window.clearTimeout(t);
  }, [cara, mirada, tamano]);
  const m = mirada ?? curiosea;
  const mini = tamano < 28;
  const estilo = { '--t': `${tamano}px`, '--mx': `${(m?.x ?? 0) * tamano * 0.07}px`, '--my': `${(m?.y ?? 0) * tamano * 0.06}px` } as CSSProperties;
  return (
    <span className={`orbe-cara ${mini ? 'mini' : ''} ${className}`} data-cara={cara} data-parpadeo={parpadeo || undefined} style={estilo}
      role={etiqueta ? 'img' : undefined} aria-label={etiqueta} aria-hidden={etiqueta ? undefined : true}>
      <span className="oc-halo" />
      {!mini && <span className="oc-ondas"><i /><i /><i /><i /></span>}
      <span className="oc-cuerpo">
        <span className="oc-esfera">
          <span className="oc-brillo" />
          <span className="oc-rostro">
            <span className="oc-ojos"><i /><i /></span>
            <span className="oc-mejillas"><i /><i /></span>
            {!mini && <span className="oc-boca" />}
          </span>
        </span>
      </span>
      {!mini && <span className="oc-piensa"><i /><i /><i /></span>}
      {!mini && <span className="oc-chispas"><i /><i /><i /></span>}
      {!mini && <span className="oc-signo">?</span>}
    </span>
  );
}

/**
 * Gesto de la IA en una conversación: escucha mientras la persona escribe, piensa mientras consulta,
 * al responder se alegra un instante y «habla» mientras el texto aparece; si algo falla, se confunde.
 * `respuesta` cambia (un número que sube) cada vez que llega una respuesta; `fallo` cada vez que falla.
 */
export function useCaraIA({ ocupado, escribiendo, respuesta, fallo, largo = 0 }: { ocupado: boolean; escribiendo: boolean; respuesta: number; fallo: number; largo?: number }): Cara {
  const [reaccion, setReaccion] = useState<Cara | null>(null);
  useEffect(() => {
    if (!respuesta) return;
    setReaccion('feliz');
    const a = window.setTimeout(() => setReaccion('hablando'), 1100);
    const b = window.setTimeout(() => setReaccion(null), 1100 + Math.min(4200, 900 + largo * 12));
    return () => { window.clearTimeout(a); window.clearTimeout(b); };
  }, [respuesta]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!fallo) return;
    setReaccion('confundida');
    const t = window.setTimeout(() => setReaccion(null), 2600);
    return () => window.clearTimeout(t);
  }, [fallo]);
  if (ocupado) return 'pensando';
  if (escribiendo) return 'escuchando';
  return reaccion ?? 'normal';
}
