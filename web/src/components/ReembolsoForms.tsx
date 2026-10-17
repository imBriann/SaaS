import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Campo, useAccion } from './ui';
import { Icon } from './icons';
import { fechaLarga } from './LegalKit';

/** Reembolso y retracto de los pagos a la plataforma (Ley 1480 de 2011, arts. 47 y 50; Ley 2439 de 2024, arts. 3 a 5). */
const MOTIVOS: [string, string, string][] = [
  ['RETRACTO', 'Quiero retractarme', 'Me arrepentí de la compra. Aplica hasta 5 días hábiles después de pagar, mientras tu espacio no se haya creado.'],
  ['NO_ACTIVACION', 'El servicio no se activó', 'Pagué y mi espacio no se pudo crear, o no se creó en el plazo informado.'],
  ['COBRO_DUPLICADO', 'Me cobraron dos veces', 'Hay dos cobros por la misma compra.'],
  ['COBRO_NO_RECONOCIDO', 'No reconozco este cobro', 'No solicité esta compra o sospecho de un fraude.'],
  ['OTRO', 'Otro motivo', 'Lo revisa una persona del equipo.'],
];
const ESTADO: Record<string, string> = { EN_REVISION: 'En revisión', APROBADO: 'Aprobada: pendiente de devolver el dinero', REEMBOLSADO: 'Dinero devuelto', RECHAZADO: 'No aprobada' };
const cop = (n: number) => '$' + Math.round(n).toLocaleString('es-CO').replace(/,/g, '.');

export function FormularioReembolso() {
  const [f, setF] = useState({ referencia: '', email: '', nombre: '', motivo: 'RETRACTO', medio: 'MISMO_MEDIO', detalle: '' });
  const [recibida, setRecibida] = useState<any>(null);
  const { run, ocupado, error, limpiarError } = useAccion();
  const cambiar = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const enviar = async (e: FormEvent) => {
    e.preventDefault(); limpiarError();
    const r = await run(() => api.post('/api/publico/reembolsos', { ...f, referencia: f.referencia.trim() }), undefined, { silencioso: true });
    if (r) setRecibida(r);
  };
  if (recibida) return <div className="legal-recibida" role="status">
    <Icon n="ok" size={22} className="" />
    <div>
      <h3>{recibida.aprobado_automatico ? 'Aprobamos tu solicitud' : 'Recibimos tu solicitud'}</h3>
      <p>Tu radicado es <strong className="mono">{recibida.radicado}</strong>. Te enviamos un correo con este número.</p>
      <p>{recibida.explicacion}</p>
      <p>{recibida.aprobado_automatico
        ? <>Te devolveremos <b>{cop(recibida.monto)}</b>, sin descuentos ni retenciones, a más tardar el {fechaLarga(recibida.vence_en)} ({recibida.dias_calendario} días calendario). Tu espacio no se creará con este pago.</>
        : <>La ley fija un máximo de {recibida.dias_calendario} días calendario para devolver el dinero cuando procede. Nuestra meta es responderte antes del {fechaLarga(recibida.vence_en)}.</>}</p>
    </div>
  </div>;
  return <form className="legal-form" onSubmit={enviar} noValidate>
    <fieldset className="legal-tipos">
      <legend>¿Por qué lo pides?</legend>
      {MOTIVOS.map(([v, n, d]) => <label key={v} className={f.motivo === v ? 'on' : ''}><input type="radio" name="motivo" value={v} checked={f.motivo === v} onChange={() => cambiar('motivo', v)} /><span><b>{n}</b><small>{d}</small></span></label>)}
    </fieldset>
    <div className="grid g2">
      <Campo etiqueta="Referencia del pago" ayuda="empieza por SUB- y está en tu correo de confirmación"><input className="input mono" value={f.referencia} maxLength={60} autoCapitalize="none" spellCheck={false} placeholder="SUB-XXXXXXXXXXXX" onChange={(e) => cambiar('referencia', e.target.value)} /></Campo>
      <Campo etiqueta="Correo con el que contrataste"><input className="input" type="email" value={f.email} maxLength={254} autoComplete="email" onChange={(e) => cambiar('email', e.target.value.trim())} /></Campo>
      <Campo etiqueta="Tu nombre"><input className="input" value={f.nombre} maxLength={120} autoComplete="name" onChange={(e) => cambiar('nombre', e.target.value)} /></Campo>
      <Campo etiqueta="¿Cómo quieres que te devolvamos el dinero?">
        <select className="input" value={f.medio} onChange={(e) => cambiar('medio', e.target.value)}>
          <option value="MISMO_MEDIO">Por el mismo medio de pago que usé</option>
          <option value="TRANSFERENCIA">Por transferencia bancaria (coordinamos los datos por correo)</option>
        </select>
      </Campo>
    </div>
    <Campo etiqueta="Cuéntanos qué pasó" ayuda={`${f.detalle.length}/2000`}>
      <textarea className="input legal-detalle" rows={4} maxLength={2000} value={f.detalle} onChange={(e) => cambiar('detalle', e.target.value)} placeholder="Ej.: pagué hoy y me arrepentí; todavía no creé mi espacio." />
    </Campo>
    <p className="legal-aviso">Si la solicitud cumple las condiciones de la ley, la aprobamos al instante. Si no es automática, una persona la revisa y te responde por correo. No escribas números de tarjeta ni claves. Tus datos se tratan según la <Link to="/privacidad">Política de tratamiento de datos</Link>.</p>
    {error && <p className="bloqueado" role="alert">{error.message}</p>}
    <button className="btn primario grande" type="submit" disabled={ocupado}>{ocupado ? 'Enviando…' : 'Solicitar reembolso'}</button>
  </form>;
}

/** Estado de una solicitud de reembolso, con radicado y correo. */
export function ConsultaReembolso() {
  const [radicado, setRadicado] = useState('');
  const [email, setEmail] = useState('');
  const [estado, setEstado] = useState<any>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const consultar = async (e: FormEvent) => {
    e.preventDefault(); setError(''); setEstado(null); setOcupado(true);
    try { setEstado(await api.post('/api/publico/reembolsos/consulta', { radicado, email })); }
    catch { setError('No encontramos una solicitud con ese radicado y ese correo. Revisa que estén tal como los recibiste.'); }
    finally { setOcupado(false); }
  };
  return <form className="legal-form legal-consulta" onSubmit={consultar} noValidate>
    <div className="grid g2">
      <Campo etiqueta="Radicado del reembolso"><input className="input mono" value={radicado} maxLength={20} placeholder="RB-2026-000123" onChange={(e) => setRadicado(e.target.value.toUpperCase())} /></Campo>
      <Campo etiqueta="Correo con el que la enviaste"><input className="input" type="email" value={email} maxLength={254} autoComplete="email" onChange={(e) => setEmail(e.target.value.trim())} /></Campo>
    </div>
    <button className="btn" type="submit" disabled={ocupado || !radicado || !email}>{ocupado ? 'Consultando…' : 'Consultar estado'}</button>
    {error && <p className="bloqueado" role="alert">{error}</p>}
    {estado && <div className="estado ok legal-estado-reembolso" role="status"><Icon n="ok" size={14} className="" /><span>
      Solicitud <b className="mono">{estado.radicado}</b> por {cop(estado.monto)}: <b>{ESTADO[estado.estado] ?? estado.estado}</b>.
      {estado.estado === 'REEMBOLSADO' ? <> Referencia de la devolución: <b className="mono">{estado.referencia_devolucion}</b>.</> : estado.estado === 'RECHAZADO' ? <> Motivo: {estado.explicacion}</> : <> Fecha límite de devolución: {fechaLarga(estado.vence_en)}.</>}
    </span></div>}
  </form>;
}
