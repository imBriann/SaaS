import { useEffect, useState } from 'react';
import { api } from '../api';
import { Escritura } from './Layout';
import { Campo, Cargando, ErrorCarga, Tarjeta, useAccion, useApi } from './ui';

/**
 * Configuración › «Cómo trabaja tu asistente». Tres tarjetas con una frase y un ejemplo, sin nada técnico.
 * La IA propone y el código decide: aquí se elige cuánto resuelve sola y cuándo llama a una persona.
 */
const NIVELES = [
  { k: 'AUTOMATICO', t: 'Atiende solo', f: 'Tu asistente resuelve de principio a fin: responde, agenda y vende. Tú solo apareces cuando de verdad hace falta.', e: 'Ejemplo: «Quiero corte el jueves a las 3» → la cita queda agendada y el cliente recibe la confirmación.' },
  { k: 'SUPERVISADO', t: 'Atiende y te consulta lo grande', f: 'Igual que «Atiende solo», pero las ventas desde el monto que elijas esperan tu aprobación con un clic.', e: 'Ejemplo: una compra de $500.000 queda en revisión hasta que la apruebes.' },
  { k: 'ASESOR', t: 'Te propone y el cliente confirma todo', f: 'Tu asistente prepara cada cita o compra y el cliente debe responder «SÍ» antes de que se haga.', e: 'Ejemplo: «Quiero corte el jueves a las 3» → «¿Confirmas tu cita del jueves a las 3? Responde SÍ».' },
];
const REGLAS: [string, string][] = [
  ['PIDE_PERSONA', 'El cliente pide hablar con una persona'], ['QUEJA', 'Queja, enojo fuerte o amenaza de reclamo'],
  ['PAGOS', 'Reembolsos, devoluciones o cobros dobles'], ['URGENCIA', 'Urgencias (por ejemplo, una mascota que no respira)'],
  ['SIN_SOLUCION', 'No logra resolverlo después de varios intentos'],
];

export function ComoTrabaja() {
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/ia/ajustes'), []);
  const [f, setF] = useState<any>(null);
  const { run, ocupado } = useAccion();
  useEffect(() => { if (data) setF({ ...data, palabras: (data.palabras_urgencia ?? []).join(', '), recordatorios: (data.recordatorios_horas ?? []).join(', ') }); }, [data]);
  if (error) return <ErrorCarga error={error} reintentar={recargar} />;
  if (!f) return <div className="tarjeta"><Cargando filas={6} /></div>;
  const guardar = async () => {
    const cuerpo = {
      autonomia: f.autonomia, aprobacion_monto_min: f.aprobacion_monto_min ? Number(f.aprobacion_monto_min) : null, aprobacion_espera_min: Number(f.aprobacion_espera_min),
      aprobacion_sin_respuesta: f.aprobacion_sin_respuesta, reglas_escalamiento: f.reglas_escalamiento, contacto_urgencias: f.contacto_urgencias?.trim() || null,
      palabras_urgencia: String(f.palabras).split(',').map((x: string) => x.trim()).filter((x: string) => x.length >= 3).slice(0, 30),
      recordatorios_horas: String(f.recordatorios).split(',').map((x: string) => Number(x.trim())).filter((x: number) => x >= 1 && x <= 168).slice(0, 3),
      seguimiento_horas: Number(f.seguimiento_horas), recordar_pago: !!f.recordar_pago,
    };
    const r = await run(() => api.patch('/api/t/ia/ajustes', cuerpo), 'Listo: tu asistente ya trabaja así');
    if (r) recargar();
  };
  const regla = (k: string) => f.reglas_escalamiento.includes(k);
  const obligatoria = (k: string) => (f.obligatorias ?? []).includes(k);
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid g3 niveles-ia" role="radiogroup" aria-label="Cómo trabaja tu asistente">
        {NIVELES.map((n) => (
          <label key={n.k} className={`tarjeta nivel-ia ${f.autonomia === n.k ? 'on' : ''}`}>
            <span className="cuerpo col" style={{ gap: 6 }}>
              <span className="fila" style={{ gap: 8 }}><input type="radio" name="autonomia" checked={f.autonomia === n.k} onChange={() => setF({ ...f, autonomia: n.k })} /><b>{n.t}</b>{n.k === 'AUTOMATICO' && <span className="estado ok">Recomendado</span>}</span>
              <span className="sec">{n.f}</span>
              <span className="tenue peq-txt">{n.e}</span>
            </span>
          </label>
        ))}
      </div>
      {f.autonomia === 'SUPERVISADO' && (
        <Tarjeta titulo="Lo que esperará tu aprobación">
          <div className="grid g3">
            <Campo etiqueta="Ventas desde" ayuda="en pesos"><input className="input" type="number" min={1} value={f.aprobacion_monto_min ?? ''} onChange={(e) => setF({ ...f, aprobacion_monto_min: e.target.value })} /></Campo>
            <Campo etiqueta="Si nadie responde en" ayuda="minutos"><input className="input" type="number" min={5} value={f.aprobacion_espera_min} onChange={(e) => setF({ ...f, aprobacion_espera_min: e.target.value })} /></Campo>
            <Campo etiqueta="Entonces"><select className="input" value={f.aprobacion_sin_respuesta} onChange={(e) => setF({ ...f, aprobacion_sin_respuesta: e.target.value })}><option value="AVISAR">Avisar al cliente que sigue en revisión</option><option value="APROBAR">Aprobarla sola</option></select></Campo>
          </div>
        </Tarjeta>
      )}
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <Tarjeta titulo="Cuándo te llama a ti">
          <div className="col" style={{ gap: 8 }}>
            <span className="sec peq-txt">Fuera de estos casos tu asistente no te pasa la conversación: si no sabe algo, lo dice y te deja el pendiente anotado.</span>
            {REGLAS.map(([k, t]) => <label key={k} className="fila" style={{ gap: 8 }}><input type="checkbox" checked={regla(k)} disabled={obligatoria(k)}
              onChange={(e) => setF({ ...f, reglas_escalamiento: e.target.checked ? [...f.reglas_escalamiento, k] : f.reglas_escalamiento.filter((x: string) => x !== k) })} />{t}{obligatoria(k) && <span className="tenue peq-txt"> (siempre)</span>}</label>)}
            <Campo etiqueta="Contacto de urgencias" ayuda="lo recibe el cliente al instante"><input className="input" maxLength={300} placeholder="Ej.: Urgencias 24 h: 300 123 4567" value={f.contacto_urgencias ?? ''} onChange={(e) => setF({ ...f, contacto_urgencias: e.target.value })} /></Campo>
            <Campo etiqueta="Palabras de urgencia de tu negocio" ayuda="separadas por coma"><input className="input" value={f.palabras} onChange={(e) => setF({ ...f, palabras: e.target.value })} /></Campo>
          </div>
        </Tarjeta>
        <Tarjeta titulo="Lo que hace por su cuenta">
          <div className="col" style={{ gap: 8 }}>
            <Campo etiqueta="Recordar las citas" ayuda="horas antes, separadas por coma (máximo 3)"><input className="input" value={f.recordatorios} onChange={(e) => setF({ ...f, recordatorios: e.target.value })} /></Campo>
            <Campo etiqueta="Escribir después de la cita" ayuda="horas después (0 = no)"><input className="input" type="number" min={0} max={168} value={f.seguimiento_horas} onChange={(e) => setF({ ...f, seguimiento_horas: e.target.value })} /></Campo>
            <label className="fila" style={{ gap: 8 }}><input type="checkbox" checked={!!f.recordar_pago} onChange={(e) => setF({ ...f, recordar_pago: e.target.checked })} />Recordar los pagos pendientes antes de que venza el enlace</label>
            <p className="tenue peq-txt">WhatsApp solo deja escribirle a un cliente durante las 24 horas siguientes a su último mensaje. Fuera de ese tiempo el aviso sale por correo (si lo tienes) y, si no, queda anotado como «no enviado».</p>
          </div>
        </Tarjeta>
      </div>
      <Escritura permiso="ai:configure"><button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={guardar}>Guardar</button></Escritura>
    </div>
  );
}
