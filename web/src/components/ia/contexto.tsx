import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/** Estado compartido de Omnegia IA en el panel: el chat lateral y la guía que recorre la pantalla. */
interface IA {
  panelAbierto: boolean;
  /** Pregunta con que se abrió el panel (p. ej. desde «Preguntar a Omnegia IA sobre esto»). */
  pregunta: { texto: string; n: number } | null;
  abrirPanel: (pregunta?: string) => void;
  cerrarPanel: () => void;
  guia: { id: string; n: number } | null;
  iniciarGuia: (id: string) => void;
  terminarGuia: () => void;
}
const Ctx = createContext<IA>({
  panelAbierto: false, pregunta: null, abrirPanel: () => {}, cerrarPanel: () => {}, guia: null, iniciarGuia: () => {}, terminarGuia: () => {},
});
export const useIA = () => useContext(Ctx);

export function IAProvider({ children }: { children: ReactNode }) {
  const [panelAbierto, setPanel] = useState(false);
  const [pregunta, setPregunta] = useState<IA['pregunta']>(null);
  const [guia, setGuia] = useState<IA['guia']>(null);
  const abrirPanel = useCallback((texto?: string) => {
    setGuia(null);
    setPanel(true);
    if (texto?.trim()) setPregunta((p) => ({ texto: texto.trim(), n: (p?.n ?? 0) + 1 }));
  }, []);
  const cerrarPanel = useCallback(() => setPanel(false), []);
  // Una guía necesita la pantalla entera: el chat se cierra mientras la IA recorre los botones.
  const iniciarGuia = useCallback((id: string) => { setPanel(false); setGuia((g) => ({ id, n: (g?.n ?? 0) + 1 })); }, []);
  const terminarGuia = useCallback(() => setGuia(null), []);
  const valor = useMemo(() => ({ panelAbierto, pregunta, abrirPanel, cerrarPanel, guia, iniciarGuia, terminarGuia }), [panelAbierto, pregunta, abrirPanel, cerrarPanel, guia, iniciarGuia, terminarGuia]);
  return <Ctx.Provider value={valor}><div className={`ia-raiz ${panelAbierto ? 'con-panel-ia' : ''}`}>{children}</div></Ctx.Provider>;
}
