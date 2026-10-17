import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Campo, useAccion } from './ui';
import { Icon } from './icons';
import { cifrarJwe } from '../lib/jwe';
import { cvcValido, datosNavegador, formatearNumero, formatearVence, luhn, marcaDe, soloDigitos, venceValido } from '../lib/tarjeta';

/**
 * Pago con formulario propio: tarjeta, Nequi, PSE, botón Bancolombia y QR. La tarjeta se cifra en el navegador y va
 * directo a Wompi (el servidor de Omnegia solo recibe el token de un solo uso). El monto y la referencia los fija el
 * servidor. Que el pago quedó aprobado lo confirma el servidor con Wompi, nunca esta pantalla.
 */
interface Config {
  disponible: boolean; simulado?: boolean; api?: string; llave_publica?: string;
  metodos?: { codigo: string; nombre: string }[]; aceptacion?: { terminos: string; datos: string }; bancos?: { codigo: string; nombre: string }[];
}
type Accion =
  | { tipo: 'esperar'; mensaje: string } | { tipo: 'nequi'; mensaje: string } | { tipo: 'redirigir'; url: string }
  | { tipo: 'qr'; imagen: string } | { tipo: 'desafio_3ds'; html: string } | { tipo: 'simulado' } | { tipo: 'final' };
interface Seguimiento { referencia: string; tx: string | null; simulado: boolean; accion: Accion }

const ICONO: Record<string, string> = { CARD: 'suscripcion', NEQUI: 'persona', PSE: 'plataforma', BANCOLOMBIA_TRANSFER: 'plataforma', BANCOLOMBIA_QR: 'inicio' };
const INTERVALO_MS = 2500;
const MAX_INTENTOS = 120; // 5 minutos, como recomienda Wompi

export function PagoDirecto({ d, monto, asegurar, bloqueado, onAprobado, alIniciar, alCargar }: {
  d: any; monto: string; asegurar: () => Promise<boolean>; bloqueado: boolean; onAprobado: () => void; alIniciar?: (activo: boolean) => void; alCargar?: (disponible: boolean) => void;
}) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [metodo, setMetodo] = useState('');
  const [acepta, setAcepta] = useState({ terminos: false, datos: false });
  const [nombre, setNombre] = useState<string>(d.negocio?.responsable || d.negocio?.nombre || '');
  const [telefono, setTelefono] = useState<string>(String(d.negocio?.telefono ?? '').replace(/^\+57/, '').replace(/\D/g, ''));
  const [tarjeta, setTarjeta] = useState({ numero: '', titular: '', vence: '', cvc: '', cuotas: 1 });
  const [nequi, setNequi] = useState('');
  const [pse, setPse] = useState({ persona: 0, tipoDoc: 'CC', doc: '', banco: '' });
  const [seg, setSeg] = useState<Seguimiento | null>(null);
  const [fallo, setFallo] = useState('');
  const { run, ocupado, error } = useAccion();
  const vivo = useRef(true);

  useEffect(() => { vivo.current = true; return () => { vivo.current = false; }; }, []);
  useEffect(() => {
    api.get(`/api/onboarding/borradores/${d.token}/pago/directo`).then((c: Config) => { if (!vivo.current) return; setCfg(c); setMetodo(c.metodos?.[0]?.codigo ?? ''); alCargar?.(!!c.disponible); }).catch(() => { setCfg({ disponible: false }); alCargar?.(false); });
  }, [d.token]);

  // Seguimiento: se consulta al servidor cada 2,5 s hasta un estado final (máximo 5 minutos).
  const intentos = useRef(0);
  const irAlBanco = useRef(false);
  const consultar = useCallback(async (s: Seguimiento) => {
    try {
      const r = await api.get(`/api/onboarding/borradores/${d.token}/pago/directo/estado${s.tx ? `?tx=${encodeURIComponent(s.tx)}` : ''}`);
      if (!vivo.current) return false;
      if (r.estado === 'APROBADO') { onAprobado(); return false; }
      if (r.estado !== 'PENDIENTE') { setSeg(null); alIniciar?.(false); setFallo(r.estado === 'RECHAZADO' ? `Tu banco no aprobó el pago${r.mensaje ? `: ${r.mensaje}` : ''}. No se hizo ningún cobro; puedes intentar con otro medio.` : 'El pago no se pudo completar. No se hizo ningún cobro; puedes intentar de nuevo.'); return false; }
      setSeg((a) => (a ? { ...a, accion: r.accion } : a));
      if (r.accion?.tipo === 'redirigir' && !irAlBanco.current) { irAlBanco.current = true; window.location.assign(r.accion.url); return false; }
      return true;
    } catch { return true; }
  }, [d.token, onAprobado, alIniciar]);
  useEffect(() => {
    if (!seg) return;
    intentos.current = 0;
    let t: number;
    const paso = async () => {
      if (!vivo.current) return;
      const seguir = await consultar(seg);
      if (!seguir || !vivo.current) return;
      if (++intentos.current >= MAX_INTENTOS) { setSeg(null); alIniciar?.(false); setFallo('Pasó mucho tiempo sin confirmación. Si ya pagaste, tu pago se confirmará solo y te avisaremos por correo; si no, puedes intentar de nuevo.'); return; }
      t = window.setTimeout(paso, INTERVALO_MS);
    };
    t = window.setTimeout(paso, 1500);
    return () => window.clearTimeout(t);
  }, [seg?.referencia, seg?.tx]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cfg?.disponible) return null;
  const simulado = !!cfg.simulado;
  const aceptado = simulado || (acepta.terminos && acepta.datos);

  const validar = (): string => {
    if (nombre.trim().length < 2) return 'Escribe tu nombre.';
    if (!/^\d{7,15}$/.test(telefono)) return 'Escribe tu teléfono, solo números.';
    if (metodo === 'CARD') {
      if (!luhn(tarjeta.numero)) return 'Revisa el número de la tarjeta.';
      if (!marcaDe(tarjeta.numero)) return 'Aceptamos tarjetas Visa y Mastercard.';
      if (!venceValido(tarjeta.vence)) return 'Revisa la fecha de vencimiento (MM/AA).';
      if (!cvcValido(tarjeta.cvc)) return 'Revisa el código de seguridad (3 o 4 dígitos).';
      if (tarjeta.titular.trim().length < 3) return 'Escribe el nombre como aparece en la tarjeta.';
    }
    if (metodo === 'NEQUI' && !/^3\d{9}$/.test(nequi)) return 'Escribe tu celular de Nequi: 10 dígitos, empezando por 3.';
    if (metodo === 'PSE') { if (!pse.banco) return 'Elige tu banco.'; if (!/^\d{5,15}$/.test(pse.doc)) return 'Escribe tu documento solo con números.'; }
    if (!aceptado) return 'Para pagar acepta los términos y la autorización de datos de Wompi.';
    return '';
  };

  /** Cifra la tarjeta aquí y la entrega a Wompi. Devuelve solo el token de un solo uso. */
  const tokenizar = async (): Promise<string> => {
    const cab = { authorization: `Bearer ${cfg.llave_publica}`, accept: 'application/json' };
    const k = await fetch(`${cfg.api}/tokens/keys/tokenization`, { headers: cab });
    const pem = (await k.json())?.data?.publicKey;
    if (!k.ok || typeof pem !== 'string') throw new Error('No pudimos preparar el pago seguro de la tarjeta. Intenta de nuevo.');
    const v = venceValido(tarjeta.vence)!;
    const payload = await cifrarJwe(pem, { number: soloDigitos(tarjeta.numero), cvc: tarjeta.cvc, exp_month: v.mes, exp_year: v.anio, card_holder: tarjeta.titular.trim().toUpperCase() });
    const r = await fetch(`${cfg.api}/tokens/cards`, { method: 'POST', headers: { ...cab, 'content-type': 'application/json' }, body: JSON.stringify({ payload }) });
    const token = (await r.json())?.data?.id;
    if (!r.ok || typeof token !== 'string') throw new Error('Wompi no pudo leer la tarjeta. Revisa los datos e intenta de nuevo.');
    return token;
  };

  const pagar = async (e: FormEvent) => {
    e.preventDefault(); setFallo('');
    const problema = validar();
    if (problema) return setFallo(problema);
    const r = await run(async () => {
      if (!(await asegurar())) throw new Error('Para continuar debes aceptar los textos legales de Omnegia.');
      let pago: Record<string, unknown>;
      if (metodo === 'CARD') pago = { metodo, token: await tokenizar(), cuotas: tarjeta.cuotas, navegador: datosNavegador() };
      else if (metodo === 'NEQUI') pago = { metodo, celular: nequi };
      else if (metodo === 'PSE') pago = { metodo, tipo_persona: pse.persona, tipo_documento: pse.tipoDoc, documento: pse.doc, banco: pse.banco };
      else pago = { metodo };
      return api.post(`/api/onboarding/borradores/${d.token}/pago/directo`, { retorno: window.location.origin, acepta_wompi: true, cliente: { nombre: nombre.trim(), telefono }, pago });
    }, undefined, { silencioso: true });
    // Los datos de la tarjeta no se quedan en pantalla ni en memoria de la página.
    setTarjeta((t) => ({ ...t, numero: '', cvc: '', vence: '', titular: '' }));
    if (!r) return;
    if (r.ya_pagado) return onAprobado();
    irAlBanco.current = false;
    alIniciar?.(true);
    setSeg({ referencia: r.referencia, tx: r.transaccion_id ?? null, simulado: !!r.simulado, accion: r.accion });
  };

  const errorServidor = (x: unknown) => setFallo((x as Error).message || 'No pudimos iniciar el pago.');
  const simular = async (resultado: 'aprobado' | 'rechazado') => {
    if (!seg) return;
    await api.post('/api/pasarela/simular', { ref: seg.referencia, resultado }).catch(errorServidor);
    await consultar(seg);
  };

  // ------------------------------------------------------------ seguimiento del pago
  if (seg) {
    const a = seg.accion;
    return (
      <section className="pago-directo pago-estado" aria-live="polite" aria-busy="true">
        <h2>Estamos confirmando tu pago</h2>
        {a.tipo === 'simulado' && <div className="aviso peq-txt"><Icon n="info" className="" size={16} /><span>Pasarela simulada: no hay cobro real. Elige el resultado para probar el flujo.</span>
          <span className="fila" style={{ gap: 8, marginTop: 8 }}><button className="btn primario peq" type="button" onClick={() => simular('aprobado')}>Aprobar el pago</button><button className="btn peq" type="button" onClick={() => simular('rechazado')}>Rechazar</button></span></div>}
        {a.tipo === 'nequi' && <p><Icon n="reloj" className="" size={18} /> {a.mensaje} Tienes unos minutos para aprobarla.</p>}
        {a.tipo === 'esperar' && <p><Icon n="reloj" className="" size={18} /> {a.mensaje}</p>}
        {a.tipo === 'redirigir' && <p><Icon n="reloj" className="" size={18} /> Te llevamos a tu banco para que apruebes el pago. Al terminar volverás aquí.</p>}
        {a.tipo === 'qr' && <div className="pago-qr"><img src={a.imagen} alt="Código QR de Bancolombia para pagar" width={220} height={220} /><p>Escanéalo con la app de Bancolombia y aprueba el pago. Esta pantalla se actualiza sola.</p></div>}
        {a.tipo === 'desafio_3ds' && <div className="pago-3ds">
          <p>Tu banco necesita verificar que eres tú. Completa la verificación aquí abajo.</p>
          {/* El desafío es HTML del banco: se aísla (sin acceso a Omnegia) y solo puede ejecutar su propio script y formularios. */}
          <iframe title="Verificación de tu banco" srcDoc={a.html} sandbox="allow-scripts allow-forms" referrerPolicy="no-referrer" style={{ width: '100%', minHeight: 520, border: '1px solid var(--borde)', borderRadius: 10, background: '#fff' }} />
        </div>}
        {(a.tipo === 'desafio_3ds' || a.tipo === 'esperar') && metodo === 'CARD' && <img className="pago-mc" src="/img/mc-id-check-logo.svg" alt="Mastercard ID Check" width={150} height={43} />}
        <p className="tenue peq-txt">No cierres esta página. Si ya aprobaste el pago, te llevamos a tu alta en cuanto Wompi lo confirme.</p>
      </section>
    );
  }

  const nombres: Record<string, string> = Object.fromEntries((cfg.metodos ?? []).map((m) => [m.codigo, m.nombre]));
  return (
    <section className="pago-directo" aria-labelledby="pago-directo-t">
      <h2 id="pago-directo-t">Paga aquí, sin salir de Omnegia</h2>
      <p className="tenue peq-txt" style={{ margin: 0 }}>{simulado ? 'Demostración: la pasarela es simulada y no hay cobros reales.' : 'El pago lo procesa Wompi. Los datos de tu tarjeta viajan cifrados desde tu navegador directo a Wompi: nuestro servidor nunca los recibe.'}</p>
      <form onSubmit={pagar} noValidate>
        <fieldset className="pago-metodos">
          <legend>Elige cómo pagar</legend>
          {(cfg.metodos ?? []).map((m) => <label key={m.codigo} className={metodo === m.codigo ? 'on' : ''}>
            <input type="radio" name="metodo" value={m.codigo} checked={metodo === m.codigo} onChange={() => { setMetodo(m.codigo); setFallo(''); }} />
            <Icon n={ICONO[m.codigo] ?? 'suscripcion'} className="" size={18} /><span>{nombres[m.codigo]}</span>
          </label>)}
        </fieldset>

        <div className="grid g2">
          <Campo etiqueta="Tu nombre"><input className="input" value={nombre} maxLength={80} autoComplete="name" onChange={(e) => setNombre(e.target.value)} /></Campo>
          <Campo etiqueta="Tu teléfono" ayuda="solo números"><input className="input" type="tel" inputMode="tel" value={telefono} maxLength={15} autoComplete="tel-national" onChange={(e) => setTelefono(soloDigitos(e.target.value))} /></Campo>
        </div>

        {metodo === 'CARD' && <div className="pago-tarjeta">
          <Campo etiqueta="Número de la tarjeta" ayuda="Visa o Mastercard"><input className="input mono" inputMode="numeric" autoComplete="cc-number" value={tarjeta.numero} maxLength={23} placeholder="0000 0000 0000 0000" onChange={(e) => setTarjeta({ ...tarjeta, numero: formatearNumero(e.target.value) })} /></Campo>
          <Campo etiqueta="Nombre como aparece en la tarjeta"><input className="input" autoComplete="cc-name" value={tarjeta.titular} maxLength={60} onChange={(e) => setTarjeta({ ...tarjeta, titular: e.target.value })} /></Campo>
          <div className="grid g3">
            <Campo etiqueta="Vence (MM/AA)"><input className="input mono" inputMode="numeric" autoComplete="cc-exp" value={tarjeta.vence} maxLength={5} placeholder="MM/AA" onChange={(e) => setTarjeta({ ...tarjeta, vence: formatearVence(e.target.value) })} /></Campo>
            <Campo etiqueta="Código de seguridad"><input className="input mono" inputMode="numeric" autoComplete="cc-csc" type="password" value={tarjeta.cvc} maxLength={4} placeholder="CVC" onChange={(e) => setTarjeta({ ...tarjeta, cvc: soloDigitos(e.target.value) })} /></Campo>
            <Campo etiqueta="Cuotas"><select className="input" value={tarjeta.cuotas} onChange={(e) => setTarjeta({ ...tarjeta, cuotas: Number(e.target.value) })}>{[1, 3, 6, 12, 24, 36].map((n) => <option key={n} value={n}>{n === 1 ? 'De contado' : `${n} cuotas`}</option>)}</select></Campo>
          </div>
        </div>}

        {metodo === 'NEQUI' && <Campo etiqueta="Celular registrado en Nequi" ayuda="te llegará una notificación para aprobar"><input className="input mono" type="tel" inputMode="numeric" value={nequi} maxLength={10} placeholder="3001234567" onChange={(e) => setNequi(soloDigitos(e.target.value))} /></Campo>}

        {metodo === 'PSE' && <div className="pago-pse">
          <div className="grid g2">
            <Campo etiqueta="Tipo de persona"><select className="input" value={pse.persona} onChange={(e) => setPse({ ...pse, persona: Number(e.target.value), tipoDoc: Number(e.target.value) === 1 ? 'NIT' : 'CC' })}><option value={0}>Natural</option><option value={1}>Jurídica</option></select></Campo>
            <Campo etiqueta="Tipo de documento"><select className="input" value={pse.tipoDoc} onChange={(e) => setPse({ ...pse, tipoDoc: e.target.value })}><option value="CC">Cédula de ciudadanía</option><option value="NIT">NIT</option></select></Campo>
            <Campo etiqueta="Número de documento"><input className="input mono" inputMode="numeric" value={pse.doc} maxLength={15} onChange={(e) => setPse({ ...pse, doc: soloDigitos(e.target.value) })} /></Campo>
            <Campo etiqueta="Tu banco"><select className="input" value={pse.banco} onChange={(e) => setPse({ ...pse, banco: e.target.value })}><option value="">Elige tu banco</option>{(cfg.bancos ?? []).map((b) => <option key={b.codigo} value={b.codigo}>{b.nombre}</option>)}</select></Campo>
          </div>
          <p className="tenue peq-txt">Al continuar te llevamos a la página de tu banco para aprobar el pago y volvemos aquí.</p>
        </div>}
        {metodo === 'BANCOLOMBIA_TRANSFER' && <p className="tenue peq-txt">Al continuar te llevamos a Bancolombia para aprobar la transferencia y volvemos aquí.</p>}
        {metodo === 'BANCOLOMBIA_QR' && <p className="tenue peq-txt">Al continuar verás un código QR para escanear con la app de Bancolombia.</p>}

        {!simulado && cfg.aceptacion && <div className="pago-wompi-acepta">
          <label><input type="checkbox" checked={acepta.terminos} onChange={(e) => setAcepta({ ...acepta, terminos: e.target.checked })} /><span>Acepto los <a href={cfg.aceptacion.terminos} target="_blank" rel="noopener noreferrer">términos y condiciones de Wompi</a>.</span></label>
          <label><input type="checkbox" checked={acepta.datos} onChange={(e) => setAcepta({ ...acepta, datos: e.target.checked })} /><span>Autorizo a Wompi el tratamiento de mis datos personales según su <a href={cfg.aceptacion.datos} target="_blank" rel="noopener noreferrer">autorización de datos</a>.</span></label>
        </div>}

        {(fallo || error) && <p className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{fallo || error?.message}</p>}
        <button className="btn primario grande" type="submit" disabled={ocupado || bloqueado || !metodo}>{ocupado ? 'Procesando…' : metodo === 'PSE' || metodo === 'BANCOLOMBIA_TRANSFER' ? `Ir a mi banco y pagar ${monto}` : `Pagar ${monto}`}</button>
        {bloqueado && <p className="tenue peq-txt">Completa lo que falta arriba (aceptaciones y datos de facturación) para poder pagar.</p>}
      </form>
    </section>
  );
}
