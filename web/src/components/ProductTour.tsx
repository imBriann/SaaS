import { useRef, useState } from 'react';
import { Modal } from './ui';
import { Icon } from './icons';
import chapters from '../content/product-tour.json';

export function ProductTour() {
  const [open, setOpen] = useState(false);
  const [chapter, setChapter] = useState(0);
  const [error, setError] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  return <>
    <button type="button" className="tour-trigger" aria-haspopup="dialog" onClick={() => { setChapter(0); setError(false); setOpen(true); }}>
      <span className="tour-play"><Icon n="play" size={15} className="" /></span><span>Ver cómo funciona Omnegia</span><span className="tour-duration">2 min</span>
    </button>
    {open && <Modal titulo="Así funciona Omnegia" onCerrar={() => setOpen(false)}>
      <div className="product-tour">
        <video ref={video} controls autoPlay playsInline preload="metadata" poster="/videos/omnegia-recorrido.jpg" aria-label="Recorrido ilustrado por el funcionamiento de Omnegia" onError={() => setError(true)} onLoadedMetadata={e => { e.currentTarget.volume = .6; }} onTimeUpdate={e => setChapter(Math.min(chapters.length - 1, Math.floor(e.currentTarget.currentTime / 10)))}>
          <source src="/videos/omnegia-recorrido.webm" type="video/webm" />
          <track kind="captions" src="/videos/omnegia-recorrido.vtt" srcLang="es" label="Español" />
          Tu navegador no puede reproducir este video. Puedes leer el recorrido completo a continuación.
        </video>
        <div className="tour-current">
          <h3>{chapters[chapter].title}</h3>
          <p>{chapters[chapter].text}</p>
          <small>{chapters[chapter].note}</small>
        </div>
        <p className="tour-context">Recorrido ilustrado con datos de ejemplo, texto en pantalla y música original. Puedes silenciarla desde los controles del video o ir directamente a cualquier capítulo.</p>
        {error && <p role="status">No se pudo reproducir el video. El recorrido completo está disponible en texto debajo.</p>}
        <nav className="tour-chapters" aria-label="Capítulos del video">{chapters.map((c, i) => <button type="button" key={c.short} aria-current={chapter === i ? 'true' : undefined} onClick={() => { if (video.current) { video.current.currentTime = i * 10 + 0.25; void video.current.play().catch(() => {}); } setChapter(i); }}><span>{Math.floor(i / 6)}:{String((i * 10) % 60).padStart(2, '0')}</span>{c.short}</button>)}</nav>
        <details className="tour-transcript"><summary>Leer el recorrido completo</summary><ol>{chapters.map(c => <li key={c.short}><h3>{c.short}</h3><p>{c.text}</p><small>{c.note}</small></li>)}</ol></details>
      </div>
    </Modal>}
  </>;
}
