import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Cabecera } from '../../components/Layout';
import { Campo, Cargando, Confirmar, ErrorCarga, Modal, Tarjeta, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';
import { useYo } from './Operador';

/**
 * Números de WhatsApp de la cuenta de Omnegia (WABA), consultados en vivo a Meta y cruzados con las empresas.
 * Desde aquí se asigna un número a una empresa eligiéndolo de una lista, se registra en la API un número
 * verificado, se verifica con código, se agregan números y se desregistran. Nunca se escriben identificadores
 * ni se muestran tokens; el PIN solo con «Ver PIN», que pide motivo y queda en la auditoría.
 */
type Numero = {
  id: string; numero: string | null; nombre: string | null; estado_meta: string | null; verificacion: string | null; calidad: string | null; plataforma: string | null;
  asignado: { id: string; nombre: string; slug: string } | null; en_proceso: { nombre: string } | null;
  reservado: boolean; operativo: boolean; verificado: boolean; texto: string; nivel: 'ok' | 'aviso' | 'error' | 'neutro'; acciones: string[];
};
const TONO: Record<Numero['nivel'], string> = { ok: 'ok', aviso: 'warn', error: 'err', neutro: 'neutro' };
const CALIDAD: Record<string, string> = { GREEN: 'Alta', YELLOW: 'Media', RED: 'Baja', UNKNOWN: 'Sin datos' };

export function OpNumeros() {
  const { puede } = useYo();
  const { data, error, cargando, recargar } = useApi<any>(() => api.get('/api/operador/numeros'), []);
  const [asignar, setAsignar] = useState<Numero | null>(null);
  const [codigo, setCodigo] = useState<Numero | null>(null);
  const [agregar, setAgregar] = useState(false);
  const [desasignar, setDesasignar] = useState<Numero | null>(null);
  const [desregistrar, setDesregistrar] = useState<Numero | null>(null);
  const [verPin, setVerPin] = useState<Numero | null>(null);
  const [pin, setPin] = useState<{ numero: string | null; pin: string } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const { run, ocupado } = useAccion();
  const hecho = (r: any) => { if (r) { setAviso(r.mensaje ?? null); recargar(); } return r; };

  if (!puede('numeros:gestionar')) return <><Cabecera titulo="Números de WhatsApp" /><Vacio titulo="Sin acceso">Esta sección es solo para administración de Omnegia.</Vacio></>;
  return (
    <>
      <Cabecera titulo="Números de WhatsApp" sub="Números de la cuenta de WhatsApp Business de Omnegia, consultados en vivo a Meta y cruzados con las empresas.">
        <button className="btn sutil" disabled={cargando} onClick={() => { setAviso(null); recargar(); }}><Icon n="refrescar" className="" size={16} />Consultar de nuevo</button>
        {data?.configurada && <button className="btn primario" disabled={!data.puede_agregar} title={data.motivo_limite ?? undefined} onClick={() => setAgregar(true)}><Icon n="mas" className="" size={16} />Agregar número</button>}
      </Cabecera>
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={5} /> : !data.configurada ? (
        <div className="aviso" role="note"><Icon n="alerta" className="" size={16} /><span>{data.motivo}</span></div>
      ) : (
        <div className="col" style={{ gap: 16 }}>
          {aviso && <div className="aviso exito" role="status"><Icon n="ok" className="" size={16} /><span>{aviso}</span></div>}
          <div className="fila envolver" style={{ gap: 12 }}>
            <span className="estado neutro">Cuenta {data.waba}{data.simulado ? ' · simulación' : ''}</span>
            <span className={`estado ${data.puede_agregar ? 'neutro' : 'warn'}`}>{data.usados} de {data.limite} números usados</span>
          </div>
          {data.motivo_limite && <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>{data.motivo_limite}</span></div>}
          <Tarjeta titulo="Números de la cuenta" sinCuerpo>
            {data.numeros.length === 0 ? <Vacio titulo="La cuenta no tiene números">Agrega el primero con «Agregar número».</Vacio> : (
              <div className="tabla-wrap"><table className="tabla tabla-movil">
                <thead><tr><th>Número</th><th>Estado</th><th>Empresa</th><th>Calidad</th><th><span className="sr">Acciones</span></th></tr></thead>
                <tbody>{(data.numeros as Numero[]).map((n) => (
                  <tr key={n.id}>
                    <td data-etiqueta="Número" className="principal"><b className="mono">{n.numero ?? 'Sin número'}</b><br /><span className="tenue peq-txt">{n.nombre ?? 'Sin nombre visible'}</span></td>
                    <td data-etiqueta="Estado"><span className={`estado ${TONO[n.nivel]}`}>{n.texto}</span>{n.en_proceso && <><br /><span className="tenue peq-txt">Conectándose por «Usar mi propio número» ({n.en_proceso.nombre})</span></>}</td>
                    <td data-etiqueta="Empresa">{n.reservado ? <span className="tenue">Reservado</span> : n.asignado ? <Link to={`/operador/empresas/${n.asignado.id}`}>{n.asignado.nombre}</Link> : <span className="tenue">Sin asignar</span>}</td>
                    <td data-etiqueta="Calidad">{n.calidad ? CALIDAD[n.calidad] ?? n.calidad : '—'}</td>
                    <td data-etiqueta="Acciones"><div className="acciones-fila">
                      {n.acciones.includes('asignar') && <button className="btn peq primario" onClick={() => setAsignar(n)}>Asignar</button>}
                      {n.acciones.includes('registrar') && <button className="btn peq primario" disabled={ocupado} onClick={() => run(() => api.post(`/api/operador/numeros/${n.id}/registrar`)).then(hecho)}>Registrar en la API</button>}
                      {n.acciones.includes('enviar_codigo') && <button className="btn peq" onClick={() => setCodigo(n)}>Verificar con código</button>}
                      {n.acciones.includes('desasignar') && <button className="btn peq" onClick={() => setDesasignar(n)}>Desasignar</button>}
                      {n.acciones.includes('ver_pin') && <button className="btn peq sutil" onClick={() => setVerPin(n)}>Ver PIN</button>}
                      {n.acciones.includes('desregistrar') && <button className="btn peq peligro" onClick={() => setDesregistrar(n)}>Desregistrar</button>}
                    </div></td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </Tarjeta>
          <p className="nota-pie"><Icon n="info" className="" size={14} />Un número verificado pero no registrado en la API no recibe ni envía mensajes: usa «Registrar en la API». Desasignar deja el número libre sin desregistrarlo.</p>
        </div>
      )}
      {asignar && <Asignar n={asignar} onCerrar={() => setAsignar(null)} onHecho={(r) => { setAsignar(null); hecho(r); }} />}
      {codigo && <Codigo n={codigo} onCerrar={() => setCodigo(null)} onHecho={(r) => { setCodigo(null); hecho(r); }} />}
      {agregar && <Agregar onCerrar={() => setAgregar(false)} onHecho={(r) => { setAgregar(false); hecho(r); }} />}
      {desasignar && <Confirmar titulo={`Desasignar ${desasignar.numero}`} textoBoton="Desasignar"
        efecto={<>«{desasignar.asignado?.nombre}» deja de recibir mensajes por este número. El número queda <b>libre y registrado</b> en la cuenta de Omnegia para asignarlo a otra empresa.</>}
        onCerrar={() => setDesasignar(null)} onConfirmar={() => { const n = desasignar; setDesasignar(null); run(() => api.post(`/api/operador/numeros/${n.id}/desasignar`)).then(hecho); }} />}
      {verPin && <Confirmar titulo={`Ver el PIN de ${verPin.numero}`} textoBoton="Ver PIN" pedirMotivo
        efecto={<>El PIN de verificación en dos pasos solo se necesita para mover el número a otra cuenta o proveedor. Verlo queda en la auditoría con tu motivo.</>}
        onCerrar={() => setVerPin(null)} onConfirmar={async (motivo) => { const n = verPin; setVerPin(null); const r = await run(() => api.post(`/api/operador/numeros/${n.id}/pin`, { motivo })); if (r?.pin) setPin({ numero: n.numero, pin: r.pin }); }} />}
      {pin && <Modal titulo={`PIN de ${pin.numero}`} onCerrar={() => setPin(null)} pie={<button className="btn primario" onClick={() => setPin(null)}>Listo</button>}>
        <p className="sec">No lo copies en chats ni correos. Ciérralo cuando termines.</p>
        <p className="mono" style={{ fontSize: 28, letterSpacing: 6, textAlign: 'center' }}>{pin.pin}</p>
      </Modal>}
      {desregistrar && <Desregistrar n={desregistrar} onCerrar={() => setDesregistrar(null)} onHecho={(r) => { setDesregistrar(null); hecho(r); }} />}
    </>
  );
}

function Asignar({ n, onCerrar, onHecho }: { n: Numero; onCerrar: () => void; onHecho: (r: any) => void }) {
  const [q, setQ] = useState('');
  const [elegida, setElegida] = useState<string>('');
  const { data } = useApi<any>(() => api.get(`/api/operador/numeros/empresas?q=${encodeURIComponent(q)}`), [q]);
  const { run, ocupado, error } = useAccion();
  const empresas: any[] = data?.empresas ?? [];
  return (
    <Modal titulo={`Asignar ${n.numero}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || !elegida} onClick={async () => { const r = await run(() => api.post(`/api/operador/numeros/${n.id}/asignar`, { tenant_id: elegida }), undefined, { silencioso: true }); if (r) onHecho(r); }}>{ocupado ? 'Asignando…' : 'Asignar'}</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      {!n.operativo && <div className="aviso" role="note"><Icon n="info" className="" size={16} /><span>Este número todavía no está registrado en la API: después de asignarlo, usa «Registrar en la API».</span></div>}
      <Campo etiqueta="Busca la empresa" ayuda="por nombre o subdominio"><input className="input" autoFocus value={q} onChange={(e) => { setQ(e.target.value); setElegida(''); }} placeholder="Patitas del Zulia" /></Campo>
      <ul className="lista seleccion" role="listbox" aria-label="Empresas">
        {empresas.length === 0 ? <li className="tenue">No hay empresas con ese nombre.</li> : empresas.map((e) => (
          <li key={e.id}><label className="fila" style={{ gap: 8 }}>
            <input type="radio" name="empresa" checked={elegida === e.id} disabled={e.tiene_numero} onChange={() => setElegida(e.id)} />
            <span><b>{e.nombre}</b> <span className="tenue peq-txt mono">{e.slug}</span>{e.tiene_numero && <span className="tenue peq-txt"> · ya tiene número ({e.whatsapp_numero_visible ?? 'conectado'})</span>}</span>
          </label></li>
        ))}
      </ul>
    </Modal>
  );
}

function Codigo({ n, onCerrar, onHecho }: { n: Numero; onCerrar: () => void; onHecho: (r: any) => void }) {
  const [enviado, setEnviado] = useState<string | null>(null);
  const [c, setC] = useState('');
  const { run, ocupado, error } = useAccion();
  const pedir = async (metodo: 'SMS' | 'VOICE') => { const r = await run(() => api.post(`/api/operador/numeros/${n.id}/codigo`, { metodo }), undefined, { silencioso: true }); if (r?.ya_verificado) onHecho(r); else if (r) setEnviado(r.mensaje); };
  return (
    <Modal titulo={`Verificar ${n.numero}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cerrar</button>
      <button className="btn primario" disabled={ocupado || !/^\d{6}$/.test(c)} onClick={async () => { const r = await run(() => api.post(`/api/operador/numeros/${n.id}/verificar`, { codigo: c }), undefined, { silencioso: true }); if (r) onHecho(r); }}>Verificar</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <p className="sec">Meta envía un código de 6 dígitos al número. Quien tenga el celular te lo dicta.</p>
      <div className="fila envolver" style={{ gap: 8 }}>
        <button className="btn" disabled={ocupado} onClick={() => pedir('SMS')}>Enviar por SMS</button>
        <button className="btn" disabled={ocupado} onClick={() => pedir('VOICE')}>Recibir llamada</button>
      </div>
      {enviado && <p className="tenue peq-txt">{enviado}</p>}
      <Campo etiqueta="Código"><input className="input mono" inputMode="numeric" maxLength={6} value={c} onChange={(e) => setC(e.target.value.replace(/\D/g, ''))} placeholder="123456" /></Campo>
    </Modal>
  );
}

function Agregar({ onCerrar, onHecho }: { onCerrar: () => void; onHecho: (r: any) => void }) {
  const [f, setF] = useState({ nombre_visible: '', numero: '', pais: 'CO' });
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo="Agregar un número a la cuenta de Omnegia" onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={ocupado || f.nombre_visible.trim().length < 3 || f.numero.trim().length < 7} onClick={async () => { const r = await run(() => api.post('/api/operador/numeros', f), undefined, { silencioso: true }); if (r) onHecho(r); }}>{ocupado ? 'Agregando…' : 'Agregar'}</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <p className="sec">El número no debe estar activo en la app de WhatsApp. Después lo verificas con un código y lo registras en la API.</p>
      <Campo etiqueta="Nombre visible" ayuda="el nombre real del negocio"><input className="input" value={f.nombre_visible} maxLength={80} onChange={(e) => setF({ ...f, nombre_visible: e.target.value })} /></Campo>
      <Campo etiqueta="Número" ayuda="celular de Colombia, 10 dígitos"><input className="input mono" inputMode="tel" value={f.numero} onChange={(e) => setF({ ...f, numero: e.target.value })} placeholder="322 750 0767" /></Campo>
    </Modal>
  );
}

function Desregistrar({ n, onCerrar, onHecho }: { n: Numero; onCerrar: () => void; onHecho: (r: any) => void }) {
  const [t, setT] = useState('');
  const { run, ocupado, error } = useAccion();
  return (
    <Modal titulo={`Desregistrar ${n.numero}`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn peligro" disabled={ocupado || t.trim().toUpperCase() !== 'DESREGISTRAR'} onClick={async () => { const r = await run(() => api.post(`/api/operador/numeros/${n.id}/desregistrar`, { confirmacion: t }), undefined, { silencioso: true }); if (r) onHecho(r); }}>Desregistrar</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <p className="sec">El número deja de funcionar en la API de WhatsApp{n.asignado ? <> y «{n.asignado.nombre}» deja de usarlo</> : null}. Para volver a usarlo habrá que registrarlo de nuevo.</p>
      <Campo etiqueta="Escribe DESREGISTRAR para confirmar"><input className="input mono" value={t} onChange={(e) => setT(e.target.value)} /></Campo>
    </Modal>
  );
}
