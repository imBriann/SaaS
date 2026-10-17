import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { Icon } from './icons';

const timeLabel = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function ProductTour() {
  const [state, setState] = useState<'closed' | 'opening' | 'open' | 'closing'>('closed');
  const [error, setError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(.6);
  const [muted, setMuted] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = state !== 'closed';

  useEffect(() => {
    if (state === 'opening') {
      const timer = setTimeout(() => setState('open'), 160);
      return () => clearTimeout(timer);
    }
    if (state === 'open') void video.current?.play().catch(() => {});
  }, [state]);

  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [open]);

  const close = () => {
    if (state === 'closed' || state === 'closing') return;
    video.current?.pause();
    setState('closing');
    closeTimer.current = setTimeout(() => setState('closed'), 240);
  };

  const togglePlayback = () => {
    const media = video.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => setError(true));
    else media.pause();
  };

  const toggleSound = () => {
    const media = video.current;
    if (!media) return;
    if (media.volume === 0) { media.volume = .6; media.muted = false; }
    else media.muted = !media.muted;
  };

  return <>
    <button type="button" className="tour-trigger" aria-haspopup="dialog" onClick={() => { setError(false); setPosition(0); setDuration(0); setPlaying(false); setState('opening'); }}>
      <span className="tour-play"><Icon n="play" size={14} className="" /></span>
      <span>Ver video</span>
    </button>
    {open && <Modal titulo="Así funciona Omnegia" className={`cinema-modal ${state === 'opening' ? 'is-opening' : state === 'closing' ? 'is-closing' : ''}`} onCerrar={close}>
      <div className="product-tour">
        <video ref={video} playsInline disablePictureInPicture preload="metadata" poster="/videos/omnegia-recorrido.jpg" aria-label="Recorrido ilustrado por el funcionamiento de Omnegia" onError={() => setError(true)} onLoadedMetadata={e => { e.currentTarget.volume = .6; setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0); }} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onTimeUpdate={e => setPosition(e.currentTarget.currentTime)} onVolumeChange={e => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}>
          <source src="/videos/omnegia-recorrido.webm" type="video/webm" />
          <track kind="captions" src="/videos/omnegia-recorrido.vtt" srcLang="es" label="Español" />
          Tu navegador no puede reproducir este video.
        </video>
        {!error && <div className="tour-media-controls" role="group" aria-label="Controles del video">
          <button type="button" className="tour-media-button tour-media-play" aria-label={playing ? 'Pausar video' : 'Reproducir video'} onClick={togglePlayback}><Icon n={playing ? 'pause' : 'play'} size={20} className="" /></button>
          <input className="tour-media-seek" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(position, duration)} disabled={!duration} aria-label="Avance del video" aria-valuetext={`${timeLabel(position)} de ${timeLabel(duration)}`} onChange={e => { const next = Number(e.currentTarget.value); if (video.current) video.current.currentTime = next; setPosition(next); }} style={{ backgroundImage: `linear-gradient(to right, #c5bfff ${duration ? position / duration * 100 : 0}%, #ffffff40 ${duration ? position / duration * 100 : 0}%)` }} />
          <span className="tour-media-time" aria-hidden="true">{timeLabel(position)} / {timeLabel(duration)}</span>
          <div className="tour-media-volume"><button type="button" className="tour-media-button" aria-label={muted || volume === 0 ? 'Activar sonido' : 'Silenciar'} onClick={toggleSound}><Icon n={muted || volume === 0 ? 'volume-mute' : 'volume'} size={20} className="" /></button><input type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} aria-label="Volumen" aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)} %`} onChange={e => { if (video.current) { video.current.volume = Number(e.currentTarget.value); video.current.muted = false; } }} /></div>
        </div>}
        {error && <div className="cinema-error" role="alert"><p>No pudimos reproducir el video.</p><button type="button" onClick={() => { setError(false); video.current?.load(); void video.current?.play().catch(() => setError(true)); }}>Volver a intentar <Icon n="flecha" size={17} className="" /></button></div>}
      </div>
    </Modal>}
  </>;
}
