import { useEffect, useState } from 'react';
import { api } from '../api';
import { Cargando, ErrorCarga, Modal, Tarjeta, useApi } from './ui';
import { Icon } from './icons';
import { PasoNumero, Propio, formatoPropio } from '../pages/app/NumeroPropio';

/**
 * Conexión de WhatsApp en línea («Usar mi propio número»): número → código → conectado, sin salir de la pantalla.
 * Se usa en Conversaciones (estado de bienvenida) y, con `cambio`, en el cambio guiado de número: el número actual
 * sigue funcionando hasta que el nuevo queda conectado. Todo estado viene del servidor y se retoma al volver.
 */
type C = any;
const EN_MARCHA = ['NUMERO_INGRESADO', 'CODIGO_ENVIADO', 'CODIGO_VERIFICADO', 'REGISTRADO'];

export function ConectarEnLinea({ cambio, onConectado }: { cambio?: boolean; onConectado?: () => void }) {
  const op = useApi<any>(() => api.get('/api/t/numeros/opciones'), []);
  const est = useApi<{ contratacion: C | null }>(() => api.get('/api/t/numeros/contratacion'), []);
  const [c, setC] = useState<C | null>(null);
  // Una vez conectado en esta pantalla, se queda en «Listo» aunque el servidor ya no lo marque como cambio.
  useEffect(() => {
    if (!est.data) return;
    const v = est.data.contratacion;
    const sirve = !!v && v.estado !== 'CANCELADO' && v.origen === 'PROPIO' && (!!cambio === !!v.es_cambio || v.estado !== 'CONECTADO');
    setC((actual: C | null) => (actual?.estado === 'CONECTADO' ? actual : sirve ? v : null));
  }, [est.data, cambio]);
  // Mientras el servidor termina de conectar, se consulta cada pocos segundos.
  useEffect(() => {
    if (!c || !EN_MARCHA.includes(c.estado) || c.estado === 'NUMERO_INGRESADO' || c.estado === 'CODIGO_ENVIADO') return;
    const t = setInterval(() => api.get('/api/t/numeros/contratacion').then((r: any) => r.contratacion && setC(r.contratacion)).catch(() => undefined), 3000);
    return () => clearInterval(t);
  }, [c?.estado]);
  useEffect(() => { if (c?.estado === 'CONECTADO') onConectado?.(); }, [c?.estado]); // eslint-disable-line react-hooks/exhaustive-deps

  if (op.error) return <ErrorCarga error={op.error} reintentar={op.recargar} />;
  if (!op.data || !est.data) return <Cargando filas={3} />;
  const p = op.data.propio;
  if (!c && !(cambio ? p?.puede_cambiar : p?.disponible)) {
    return <div className="bloqueado" role="note"><Icon n="info" className="" size={16} /><span>{p?.motivo ?? (cambio ? 'Ahora mismo no se puede cambiar de número. Escribe a soporte si necesitas ayuda.' : 'Conectar un número no está disponible en este momento.')}</span></div>;
  }
  return c
    ? <Propio c={c} onCambio={(r) => { setC(r && r.estado !== 'CANCELADO' ? r : null); est.recargar(); }} recargar={() => api.get('/api/t/numeros/contratacion').then((r: any) => setC(r.contratacion?.estado === 'CANCELADO' ? null : r.contratacion))} />
    : <PasoNumero paises={p.paises} nombre={p.nombre} cambio={cambio} onCreada={setC} />;
}

/** Cambio guiado: explica qué pasa, pide el número nuevo, lo verifica y solo entonces desconecta el anterior. */
export function CambiarNumero({ actual, onCerrar, onHecho }: { actual: string | null; onCerrar: () => void; onHecho: () => void }) {
  const [paso, setPaso] = useState<'explica' | 'flujo'>('explica');
  const [hecho, setHecho] = useState(false);
  // Si ya había un cambio en curso (cerraron la ventana a medias), se retoma sin volver a explicar.
  const est = useApi<{ contratacion: C | null }>(() => api.get('/api/t/numeros/contratacion'), []);
  useEffect(() => { const c = est.data?.contratacion; if (c?.es_cambio && c.estado !== 'CANCELADO') setPaso('flujo'); }, [est.data]);
  return (
    <Modal titulo="Cambiar de número de WhatsApp" className="modal-ancho" onCerrar={() => { if (hecho) onHecho(); onCerrar(); }}
      pie={<button className="btn" onClick={() => { if (hecho) onHecho(); onCerrar(); }}>{hecho ? 'Listo' : 'Cerrar'}</button>}>
      {paso === 'explica' ? (
        <div className="col" style={{ gap: 12 }}>
          <Tarjeta nivel={3} titulo="Qué va a pasar">
            <ol className="col" style={{ gap: 8, margin: 0, paddingLeft: 20 }}>
              <li>Tu número actual{actual ? ` (${actual})` : ''} <b>sigue funcionando</b> mientras conectas el nuevo.</li>
              <li>Escribes el número nuevo y lo verificas con un código que te llega por SMS.</li>
              <li>Solo cuando el número nuevo queda conectado, el actual se desconecta.</li>
              <li>Si algo falla con el nuevo, <b>no te quedas sin número</b>: el actual sigue atendiendo.</li>
            </ol>
          </Tarjeta>
          <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>Tus conversaciones quedan guardadas. Tus clientes deberán escribir al número nuevo: avísales antes de cambiar.</span></div>
          <button className="btn primario" style={{ alignSelf: 'flex-start' }} onClick={() => setPaso('flujo')}>Entiendo, continuar</button>
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          {actual && !hecho && <div className="aviso" role="status"><Icon n="ok" className="" size={16} /><span>Mientras tanto, tu número actual <b className="mono">{actual}</b> sigue atendiendo a tus clientes.</span></div>}
          <ConectarEnLinea cambio onConectado={() => setHecho(true)} />
        </div>
      )}
    </Modal>
  );
}

export { formatoPropio };
