import { TeamCommissions } from '../../components/TeamCommissions';
import { LogoError, pesoLegible, prepararLogo } from '../../lib/logo';
import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, cop, descargar, descargarDocumentos, fecha, fechaHora, hora, num } from '../../api';
import { Cabecera, Escritura, useSesion } from '../../components/Layout';
import { accionIA, Campo, Cargando, Cifra, Confirmar, ErrorCarga, Estado, Interruptor, Medidor, Modal, motivoIA, Recibo, Tarjeta, useAccion, useApi, useToast, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

const NOMBRE_AGENTE: Record<string, string> = { atencion: 'Atención por WhatsApp', asistente: 'Asistente del panel', copiloto: 'Copiloto del asesor' };
const DESCRIPCION_AGENTE: Record<string, string> = {
  atencion: 'Responde a tus clientes, consulta precios y agenda, y propone citas y compras que el cliente confirma.',
  asistente: 'Responde preguntas sobre tu negocio en el panel con tus propios datos.',
  copiloto: 'Resume los casos y sugiere respuestas a tu equipo. Nunca le escribe al cliente.',
};

// =================================================================== Centro de IA
export function CentroIA() {
  const { puede } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/ia'), []);
  const [filtro, setFiltro] = useState('');
  const ejec = useApi<any[]>(() => api.get(`/api/t/ia/ejecuciones${filtro ? `?decision=${filtro}` : ''}`), [filtro], { cada: 15000 });
  const [apagar, setApagar] = useState<any>(null);
  const [tope, setTope] = useState<string>('');
  const { run, ocupado } = useAccion();
  useEffect(() => { if (data) setTope(data.tope_mensual ? String(data.tope_mensual) : ''); }, [data?.tope_mensual]);
  if (error) return <><Cabecera titulo="Centro de IA" /><div className="contenido"><ErrorCarga error={error} reintentar={recargar} /></div></>;
  if (!data) return <><Cabecera titulo="Centro de IA" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  const m = data.metricas;
  const toggle = async (t: any, v: boolean) => { await run(() => api.patch(`/api/t/ia/herramientas/${t.nombre}`, { habilitada: v }), `${accionIA(t.nombre)}: ${v ? 'activada' : 'desactivada'}`); recargar(); };
  return (
    <>
      <Cabecera titulo="Centro de IA" sub="Elige qué puede hacer tu asistente y revisa sus acciones y su consumo." />
      <div className="contenido">
        {data.modelo === 'mock' && <div className="aviso peq-txt"><Icon n="info" className="" size={16} /><span>La IA funciona con un simulador de demostración: responde con reglas fijas, no con un modelo de lenguaje.</span></div>}
        {data.modelo === 'ninguno' && <div className="bloqueado"><Icon n="alerta" className="" size={16} /><span>La IA está pendiente de conectar: las conversaciones pasan directamente a tu equipo.</span></div>}
        <div className="kpis">
          <Cifra etiqueta="Acciones hechas (30 días)" valor={m.ejecutadas} detalle={`${m.pendientes} esperando que el cliente confirme`} />
          <Cifra etiqueta="Acciones bloqueadas" valor={m.denegadas} detalle="por las reglas de permisos" />
          <Cifra etiqueta="El cliente dijo que no" valor={m.rechazadas} detalle="no se hizo ningún cambio" />
          <div className="kpi"><Medidor c={data.consumo.tokens_ia} etiqueta="Consumo de IA del mes" /></div>
        </div>
        <Tarjeta titulo="Asistentes" sinCuerpo>
          <div className="lista">{data.agentes.map((a: any) => (
            <div key={a.id} className="agente-fila">
              <div className="col" style={{ gap: 6 }}>
                <span className="fila envolver" style={{ gap: 8 }}><b className="titulo-tarjeta">{NOMBRE_AGENTE[a.configuracion] ?? a.configuracion}</b>{a.activo ? <Estado v="ACTIVA" texto="Activo" /> : <Estado v="CANCELADA" texto="Apagado" />}</span>
                <p className="sec peq-txt" style={{ maxWidth: '80ch' }}>{DESCRIPCION_AGENTE[a.configuracion]}</p>
                <details className="peq-txt"><summary>Qué puede hacer ({a.permisos_legibles.length})</summary><ul className="lista-permisos">{a.permisos_legibles.map((p: string) => <li key={p}>{p}</li>)}</ul></details>
              </div>
              <Interruptor on={a.activo} disabled={!puede('ai:configure')} etiqueta={`Activar ${NOMBRE_AGENTE[a.configuracion] ?? a.configuracion}`} onChange={(v) => run(() => api.patch(`/api/t/ia/agentes/${a.configuracion}`, { activo: v }), v ? 'Asistente activado' : 'Asistente apagado').then(recargar)} />
            </div>
          ))}</div>
        </Tarjeta>
        <Tarjeta titulo="Acciones permitidas" acciones={!puede('ai:configure') && <span className="tenue peq-txt fila"><Icon n="candado" className="" size={14} />Solo lectura para tu rol</span>} sinCuerpo>
          <div className="tabla-wrap"><table className="tabla tabla-movil">
            <thead><tr><th>Acción</th><th>Control</th><th>Quién la usa</th><th className="num">Uso (30 días)</th><th>Activa</th></tr></thead>
            <tbody>{data.herramientas.map((t: any) => (
              <tr key={t.nombre}>
                <td data-etiqueta="Acción" className="principal envuelve"><b style={{ fontWeight: 600 }}>{accionIA(t.nombre)}</b><div className="tenue peq-txt" style={{ marginTop: 2 }}>{t.descripcion}{t.limite && ` · máximo ${t.limite} por conversación`}</div></td>
                <td data-etiqueta="Control"><Estado v={t.riesgo_efectivo} />{t.riesgo_efectivo !== t.riesgo_declarado && <div className="tenue" style={{ fontSize: 12, marginTop: 2 }}>más estricto por tu sector</div>}</td>
                <td data-etiqueta="Quién">{t.prohibida_a_agentes ? <span className="estado err"><Icon n="candado" className="" />Solo personas</span> : t.agentes.length ? t.agentes.map((a: string) => NOMBRE_AGENTE[a] ?? a).join(', ') : <span className="tenue">—</span>}</td>
                <td data-etiqueta="Uso" className="num"><span className="fila" style={{ gap: 4, justifyContent: 'flex-end' }}><span className="estado ok" title="Hechas"><Icon n="ok" className="" />{t.uso.ejecutadas}<span className="sr"> hechas</span></span>{t.uso.denegadas > 0 && <span className="estado err" title="Bloqueadas"><Icon n="candado" className="" />{t.uso.denegadas}<span className="sr"> bloqueadas</span></span>}</span></td>
                <td data-etiqueta="Activa">{t.prohibida_a_agentes ? <span className="tenue">—</span> : <Interruptor on={t.habilitada} disabled={!puede('ai:configure')} etiqueta={`Activar «${accionIA(t.nombre)}»`} onChange={(v) => (v ? toggle(t, v) : setApagar(t))} />}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Tarjeta>
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <Tarjeta titulo="Actividad reciente" acciones={<select className="input" style={{ width: 'auto' }} value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar actividad"><option value="">Todo</option><option value="DENEGADA">Bloqueadas</option><option value="CONFIRMADA">Confirmadas por el cliente</option><option value="PENDIENTE_CONFIRMACION">Esperando confirmación</option><option value="PERMITIDA">Hechas</option><option value="ERROR">Con error</option></select>}>
            {ejec.error ? <ErrorCarga error={ejec.error} reintentar={ejec.recargar} /> : !ejec.data ? <Cargando /> : ejec.data.length === 0 ? <Vacio titulo="Sin actividad">{filtro ? 'Nada con ese filtro.' : 'Cuando la IA haga algo, verás aquí su recibo.'}</Vacio> : (
              <div className="col lista-recibos">{ejec.data.slice(0, 60).map((e) => <div key={e.id} className="col" style={{ gap: 4 }}><span className="tenue" style={{ fontSize: 12 }}>{NOMBRE_AGENTE[e.configuracion] ?? e.configuracion} · {e.cliente ?? 'panel'}</span><Recibo e={e} /></div>)}</div>
            )}
          </Tarjeta>
          <div className="col" style={{ gap: 16 }}>
            <Tarjeta titulo="Límite de gasto de IA">
              <form className="col" onSubmit={async (ev: FormEvent) => { ev.preventDefault(); await run(() => api.patch('/api/t/configuracion/empresa', { ia_tope_mensual: tope ? Number(tope) : null }), 'Límite guardado'); recargar(); }}>
                <span className="sec peq-txt">Tu plan incluye {num(data.consumo.tokens_ia.cuota ?? 0)} unidades de IA al mes. Puedes fijar un tope menor: al alcanzarlo, las conversaciones pasan a tu equipo en lugar de gastar más.</span>
                <Campo etiqueta="Tope mensual" ayuda="déjalo vacío para usar la cuota del plan"><input className="input" inputMode="numeric" value={tope} onChange={(e) => setTope(e.target.value.replace(/\D/g, ''))} placeholder="Sin tope propio" disabled={!puede('tenant:configure')} /></Campo>
                {puede('tenant:configure') && <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={ocupado}>Guardar límite</button>}
              </form>
            </Tarjeta>
            <Tarjeta titulo="Por qué se bloquearon">
              {data.por_comprobacion.length === 0 ? <Vacio titulo="Sin bloqueos">Ninguna acción ha sido bloqueada.</Vacio> : <div className="lista">{data.por_comprobacion.map((c: any, i: number) => <div key={i} className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span className="peq-txt">{motivoIA(c.motivo)}</span><span className="cifra" style={{ fontSize: 20 }}>{c.n}</span></div>)}</div>}
            </Tarjeta>
          </div>
        </div>
      </div>
      {apagar && <Confirmar titulo={`Desactivar «${accionIA(apagar.nombre)}»`} efecto={<>Ningún asistente podrá hacerlo. Si lo intenta, se bloquea y queda registrado.</>} textoBoton="Desactivar" onCerrar={() => setApagar(null)} onConfirmar={() => { toggle(apagar, false); setApagar(null); }} />}
    </>
  );
}

// =================================================================== Configuración
const DIAS: [string, string][] = [['lun', 'Lunes'], ['mar', 'Martes'], ['mie', 'Miércoles'], ['jue', 'Jueves'], ['vie', 'Viernes'], ['sab', 'Sábado'], ['dom', 'Domingo']];
const ZONAS = ['America/Bogota', 'America/Mexico_City', 'America/Lima', 'America/Guayaquil', 'America/Caracas', 'America/Santiago', 'America/Argentina/Buenos_Aires', 'America/Panama', 'America/New_York', 'Europe/Madrid'];
const TABS: [string, string][] = [['personas', 'Equipo y comisiones'], ['equipo', 'Horarios'], ['empresa', 'Empresa'], ['canal', 'WhatsApp'], ['cobros', 'Cobros'], ['modulos', 'Módulos'], ['integraciones', 'Integraciones']];

export function Configuracion() {
  const { s, recargar: recargarSesion } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/configuracion'), []);
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab')! : 'personas';
  const [invitar, setInvitar] = useState(false);
  const [empresa, setEmpresa] = useState<any>(null);
  const { run, ocupado } = useAccion();
  useEffect(() => { if (data) setEmpresa({ ...data.tenant }); }, [data]);
  if (error) return <><Cabecera titulo="Configuración" /><div className="contenido"><ErrorCarga error={error} reintentar={recargar} /></div></>;
  if (!data || !empresa) return <><Cabecera titulo="Configuración" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  const rolesPersonas = data.roles.filter((r: any) => !r.es_agente);
  const tema = data.tenant.tema;
  const guardarEmpresa = (campos: Record<string, unknown>, ok = 'Datos guardados') => run(() => api.patch('/api/t/configuracion/empresa', campos), ok).then((r) => { if (r) { recargar(); recargarSesion(); } return r; });
  const subirLogo = async (file: File) => {
    // La imagen se reduce y se comprime aquí: no se le pide a nadie que baje el peso del archivo.
    let l;
    try { l = await prepararLogo(file); } catch (e) { return run(() => Promise.reject(e instanceof LogoError ? e : new Error('No pudimos leer esta imagen. Prueba con otra.'))); }
    const r = await run(() => api.post('/api/t/configuracion/tema', { colores: l.colores, logo_data_url: l.dataUrl }), l.optimizado && l.bytes < l.bytesOriginal ? `Identidad actualizada. Ajustamos el logotipo: de ${pesoLegible(l.bytesOriginal)} a ${pesoLegible(l.bytes)}.` : 'Identidad actualizada');
    if (r) { recargar(); recargarSesion(); }
  };
  const campo = (k: string, l: string, extra: any = {}) => <Campo key={k} etiqueta={l} ayuda={extra.ayuda}><input className="input" value={empresa[k] ?? ''} onChange={(e) => setEmpresa({ ...empresa, [k]: e.target.value })} {...extra.input} /></Campo>;
  return (
    <>
      <Cabecera titulo="Configuración" sub={`Ajusta los datos, el equipo y las conexiones de ${data.tenant.nombre}.`} />
      <div className="contenido">
        <div className="tabs tabs-config" role="tablist" aria-label="Secciones de configuración">{TABS.map(([k, v]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setParams({ tab: k })}>{v}</button>)}</div>

        {tab === 'personas' && <>
          {s.permisos.includes('user:manage') && <TeamCommissions people={data.personas} />}
          <Tarjeta titulo="Personas con acceso" acciones={<Escritura permiso="user:manage"><button className="btn primario peq" onClick={() => setInvitar(true)}><Icon n="mas" className="" size={14} />Invitar</button></Escritura>} sinCuerpo>
            <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Recibe radicados</th><th>Acceso</th></tr></thead>
              <tbody>{data.personas.map((p: any) => (
                <tr key={p.id} className={p.activo ? '' : 'inactiva'}>
                  <td data-etiqueta="Nombre" className="principal"><input className="input" aria-label={`Nombre de ${p.nombre}`} defaultValue={p.nombre} disabled={s.solo_lectura || !s.permisos.includes('user:manage')} onBlur={e=>{if(e.target.value!==p.nombre)run(()=>api.patch(`/api/t/configuracion/personas/${p.id}`,{nombre:e.target.value}),'Nombre actualizado').then(recargar);}} />{p.id === s.usuario.id && <span className="tenue"> (tú)</span>}</td><td data-etiqueta="Correo" className="mono">{p.email}</td>
                  <td data-etiqueta="Rol"><select className="input" style={{ width: 'auto', minWidth: 150 }} value={p.rol} disabled={p.id === s.usuario.id || s.solo_lectura} aria-label={`Rol de ${p.nombre}`} onChange={(e) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { rol: e.target.value }), 'Rol actualizado').then(recargar)}>{rolesPersonas.map((r: any) => <option key={r.clave} value={r.clave}>{r.nombre}</option>)}</select></td>
                  <td data-etiqueta="Radicados">{p.atiende_casos ? <Interruptor on={p.disponible} disabled={s.solo_lectura || !p.activo} etiqueta={`${p.nombre} recibe radicados`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { disponible: v }), v ? 'Recibirá radicados' : 'No recibirá radicados nuevos').then(recargar)} /> : <span className="tenue peq-txt">Su rol no atiende</span>}</td>
                  <td data-etiqueta="Acceso"><Interruptor on={p.activo} disabled={p.id === s.usuario.id || s.solo_lectura} etiqueta={`Acceso de ${p.nombre}`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { activo: v }), v ? 'Acceso restituido' : 'Acceso retirado. Sus radicados volvieron a la cola.').then(recargar)} /></td>
                </tr>
              ))}</tbody></table></div>
          </Tarjeta>
          {data.invitaciones.length > 0 && (
            <Tarjeta titulo="Invitaciones" sinCuerpo>
              <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Vence</th><th><span className="sr">Acciones</span></th></tr></thead>
                <tbody>{data.invitaciones.map((i: any) => (
                  <tr key={i.id}>
                    <td data-etiqueta="Persona" className="principal"><b style={{ fontWeight: 600 }}>{i.nombre}</b><br /><span className="tenue peq-txt mono">{i.email}</span></td>
                    <td data-etiqueta="Rol">{i.rol}</td><td data-etiqueta="Estado"><Estado v={i.estado} /></td>
                    <td data-etiqueta="Vence">{i.estado === 'ACEPTADA' ? fecha(i.aceptada_en) : fecha(i.expira_en)}</td>
                    <td data-etiqueta="Acciones"><div className="acciones-fila">{['PENDIENTE', 'EXPIRADA'].includes(i.estado) && <Escritura permiso="user:manage"><button className="btn peq" onClick={async () => { const r = await run(() => api.post(`/api/t/configuracion/invitaciones/${i.id}/reenviar`), 'Invitación reenviada'); if (r?.enlace) { navigator.clipboard?.writeText(r.enlace); } recargar(); }}>Reenviar</button></Escritura>}{i.estado === 'PENDIENTE' && <Escritura permiso="user:manage"><button className="btn peq peligro" onClick={() => run(() => api.post(`/api/t/configuracion/invitaciones/${i.id}/revocar`), 'Invitación retirada').then(recargar)}>Retirar</button></Escritura>}</div></td>
                  </tr>
                ))}</tbody></table></div>
            </Tarjeta>
          )}
          <Tarjeta titulo="Qué puede hacer cada rol" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla matriz">
              <thead><tr><th>Permiso</th>{rolesPersonas.map((r: any) => <th key={r.clave} style={{ textAlign: 'center' }}>{r.nombre}</th>)}</tr></thead>
              <tbody>{Object.entries(data.catalogo_permisos).filter(([p]) => p !== 'platform:govern').map(([p, desc]) => (
                <tr key={p}><td className="envuelve" style={{ minWidth: 200 }}>{desc as string}</td>
                  {rolesPersonas.map((r: any) => <td key={r.clave} style={{ textAlign: 'center' }}>{r.permisos.includes(p) ? <span className="estado ok" title="Sí"><Icon n="ok" className="" /><span className="sr">Sí</span></span> : <span className="tenue" title="No">—<span className="sr">No</span></span>}</td>)}</tr>
              ))}</tbody>
            </table></div>
          </Tarjeta>
        </>}

        {tab === 'equipo' && <Horarios recursos={data.recursos} etiqueta={s.tenant.etiqueta_recurso ?? 'Recurso'} onCambio={recargar} />}

        {tab === 'modulos' && (
          <Tarjeta titulo="Módulos" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla tabla-movil"><thead><tr><th>Módulo</th><th>Plan</th><th>Activo</th></tr></thead><tbody>{data.modulos.map((m: any) => (
              <tr key={m.modulo}><td data-etiqueta="Módulo" className="principal envuelve"><b style={{ fontWeight: 600 }}>{m.nombre}</b><br /><span className="tenue peq-txt">{m.descripcion}</span></td><td data-etiqueta="Plan">{m.incluido_en_plan ? <span className="tenue">Incluido en tu plan</span> : <Estado v="PENDIENTE" texto="Requiere otro plan" />}</td>
                <td data-etiqueta="Activo"><Interruptor on={m.activo} disabled={(!m.incluido_en_plan && !m.activo) || s.solo_lectura} etiqueta={`Módulo ${m.nombre}`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/modulos/${m.modulo}`, { activo: v }), `Módulo ${v ? 'activado' : 'desactivado'}`).then(() => { recargar(); recargarSesion(); })} /></td></tr>
            ))}</tbody></table></div>
          </Tarjeta>
        )}

        {tab === 'empresa' && (
          <div className="grid g2">
            <Tarjeta titulo="Datos de la empresa">
              <form className="col" onSubmit={(e) => { e.preventDefault(); guardarEmpresa({ nombre: empresa.nombre, nit: empresa.nit || null, ciudad: empresa.ciudad || null, email_contacto: empresa.email_contacto, telefono: empresa.telefono || null, zona_horaria: empresa.zona_horaria }); }}>
                {campo('nombre', 'Nombre comercial')}
                {campo('nit', 'NIT con dígito de verificación', { ayuda: 'se usa en tus facturas', input: { placeholder: '901456789-3' } })}
                {campo('ciudad', 'Ciudad')}
                {campo('email_contacto', 'Correo de avisos', { ayuda: 'recibe alertas de facturas, inventario y suscripción', input: { type: 'email' } })}
                {campo('telefono', 'Teléfono')}
                <Campo etiqueta="Zona horaria" ayuda="la agenda y los reportes usan esta hora"><select className="input" value={empresa.zona_horaria} onChange={(e) => setEmpresa({ ...empresa, zona_horaria: e.target.value })}>{[...new Set([empresa.zona_horaria, ...ZONAS])].map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</select></Campo>
                <Escritura permiso="tenant:configure"><button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado || !empresa.nombre?.trim()}>Guardar cambios</button></Escritura>
              </form>
            </Tarjeta>
            <Tarjeta titulo="Identidad visual">
              <div className="col" style={{ gap: 14 }}>
                <div className="fila" style={{ gap: 12 }}>
                  <div className="muestra-logo" style={{ background: tema.acento }}>{data.tenant.logo_data_url ? <img src={data.tenant.logo_data_url} alt="Logotipo" /> : tema.monograma}</div>
                  <div className="col" style={{ gap: 2 }}><span className="mono">{tema.acento}</span><span className="tenue peq-txt">Contraste del botón con texto blanco: {tema.contraste.acento_blanco}:1 (mínimo recomendado 4,5:1)</span>{tema.ajustado && <span className="tenue peq-txt">Ajustamos el tono para que se lea bien.</span>}</div>
                </div>
                <Escritura permiso="tenant:configure"><label className="btn" style={{ alignSelf: 'flex-start' }}><Icon n="subir" className="" size={16} /> Cambiar logotipo<input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) subirLogo(f); e.target.value = ''; }} /></label></Escritura>
                <span className="tenue peq-txt">Tu panel toma su color de tu logotipo. Tu equipo ve tu negocio, no nuestra marca.</span>
              </div>
            </Tarjeta>
          </div>
        )}

        {tab === 'canal' && <CanalWhatsApp data={data} onCambio={() => { recargar(); recargarSesion(); }} guardarEmpresa={guardarEmpresa} />}
        {tab === 'cobros' && <Cobros data={data} onCambio={recargar} />}

        {tab === 'integraciones' && (
          <Tarjeta titulo="Estado de las integraciones" sinCuerpo>
            <div className="lista">{data.integraciones.map((i: any) => (
              <div key={i.clave} className="agente-fila"><div className="col" style={{ gap: 4 }}><b>{i.nombre}</b><span className="tenue peq-txt">{i.detalle}</span></div><Estado v={i.estado} /></div>
            ))}</div>
            <p className="cuerpo tenue peq-txt">Las conexiones con proveedores las configura quien administra el servidor (ver la guía de instalación). «Simulado» significa que esa parte funciona en modo de demostración y no se comunica con el proveedor real.</p>
          </Tarjeta>
        )}
      </div>
      {invitar && <Invitar roles={rolesPersonas} onCerrar={() => setInvitar(false)} onHecho={recargar} />}
    </>
  );
}

function Horarios({ recursos, etiqueta, onCambio }: { recursos: any[]; etiqueta: string; onCambio: () => void }) {
  const [editar, setEditar] = useState<any>(null);
  const resumen = (h: any) => DIAS.filter(([k]) => h?.[k]).map(([k, n]) => `${n.slice(0, 3)} ${h[k][0]}–${h[k][1]}`).join(' · ') || 'Sin horario';
  return (
    <Tarjeta titulo={`Agendas (${etiqueta.toLowerCase()}s)`} acciones={<Escritura permiso="tenant:configure"><button className="btn primario peq" onClick={() => setEditar({ nombre: '', horario: { lun: ['09:00', '18:00'], mar: ['09:00', '18:00'], mie: ['09:00', '18:00'], jue: ['09:00', '18:00'], vie: ['09:00', '18:00'] }, activo: true })}><Icon n="mas" className="" size={14} />Agregar</button></Escritura>} sinCuerpo>
      {recursos.length === 0 ? <Vacio titulo="Sin agendas">Agrega a cada persona o espacio que atiende con su horario.</Vacio> : (
        <div className="lista">{recursos.map((r) => (
          <div key={r.id} className="agente-fila"><div className="col" style={{ gap: 4 }}><span className="fila" style={{ gap: 8 }}><b>{r.nombre}</b>{!r.activo && <Estado v="CANCELADA" texto="Inactivo" />}</span><span className="tenue peq-txt">{resumen(r.horario)}</span></div>
            <Escritura permiso="tenant:configure"><button className="btn peq" onClick={() => setEditar(r)}>Editar</button></Escritura></div>
        ))}</div>
      )}
      {editar && <EditarHorario r={editar} etiqueta={etiqueta} onCerrar={() => setEditar(null)} onHecho={() => { setEditar(null); onCambio(); }} />}
    </Tarjeta>
  );
}

function EditarHorario({ r, etiqueta, onCerrar, onHecho }: { r: any; etiqueta: string; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState<any>({ nombre: r.nombre, horario: { ...r.horario }, activo: r.activo });
  const { run, ocupado, error } = useAccion();
  const set = (dia: string, i: number, v: string) => setF({ ...f, horario: { ...f.horario, [dia]: i === 0 ? [v, f.horario[dia][1]] : [f.horario[dia][0], v] } });
  const invalido = DIAS.some(([d]) => f.horario[d] && f.horario[d][0] >= f.horario[d][1]);
  return (
    <Modal titulo={r.id ? `Editar ${r.nombre}` : `Nueva agenda`} onCerrar={onCerrar} pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2 || invalido} onClick={async () => { const x = await run(() => (r.id ? api.patch(`/api/t/agenda/recursos/${r.id}`, f) : api.post('/api/t/agenda/recursos', f)), 'Horario guardado', { silencioso: true }); if (x) onHecho(); }}>Guardar</button></>}>
      {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
      <Campo etiqueta={`Nombre (${etiqueta.toLowerCase()})`}><input className="input" value={f.nombre} maxLength={40} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></Campo>
      <div className="col horario-edicion">{DIAS.map(([d, n]) => (
        <div key={d} className="horario-dia">
          <label className="fila"><input type="checkbox" checked={!!f.horario[d]} onChange={(e) => { const h = { ...f.horario }; if (e.target.checked) h[d] = ['09:00', '18:00']; else delete h[d]; setF({ ...f, horario: h }); }} />{n}</label>
          {f.horario[d] ? <span className="fila" style={{ gap: 6 }}><input className="input" type="time" value={f.horario[d][0]} onChange={(e) => set(d, 0, e.target.value)} aria-label={`${n}: abre`} /><span className="tenue">a</span><input className="input" type="time" value={f.horario[d][1]} onChange={(e) => set(d, 1, e.target.value)} aria-label={`${n}: cierra`} /></span> : <span className="tenue peq-txt">No atiende</span>}
        </div>
      ))}</div>
      {invalido && <span className="error peq-txt" role="alert">En cada día, la hora de cierre debe ser posterior a la de apertura.</span>}
      {r.id && <label className="fila"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} />Activa (se puede agendar)</label>}
    </Modal>
  );
}

function CanalWhatsApp({ data, onCambio, guardarEmpresa }: { data: any; onCambio: () => void; guardarEmpresa: (c: Record<string, unknown>, ok?: string) => Promise<any> }) {
  const t = data.tenant;
  const [pid, setPid] = useState(t.whatsapp_phone_number_id ?? '');
  const [diag, setDiag] = useState<any>(null);
  const { run, ocupado } = useAccion();
  const toast = useToast();
  const verificar = async () => { const r = await run(() => api.post('/api/t/configuracion/whatsapp/verificar')); if (r) { setDiag(r); onCambio(); } };
  const d = diag ?? t.whatsapp_diagnostico;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid g2">
        <Tarjeta titulo="Número de WhatsApp" acciones={<Estado v={t.whatsapp_estado} texto={{ CONECTADO: 'Conectado', SIMULADO: 'Simulador', PENDIENTE_VERIFICAR: 'Por verificar', ERROR: 'Con error', SIN_CONFIGURAR: 'Sin configurar' }[t.whatsapp_estado as string]} />}>
          <form className="col" onSubmit={async (e) => { e.preventDefault(); const r = await guardarEmpresa({ whatsapp_phone_number_id: pid.trim() || null }, 'Número guardado. Lo estamos verificando con Meta.'); if (r) setDiag(null); }}>
            {t.whatsapp_numero_visible && <span>Número de tus clientes: <b>{t.whatsapp_numero_visible}</b></span>}
            <Campo etiqueta="Identificador del número (Phone number ID)" ayuda="NO es el número de teléfono: es el código que Meta muestra junto a él"><input className="input mono" inputMode="numeric" value={pid} onChange={(e) => setPid(e.target.value.trim())} placeholder="Ej.: 106540352242922" /></Campo>
            <div className="fila envolver" style={{ gap: 8 }}>
              <Escritura permiso="tenant:configure"><button className="btn primario" disabled={ocupado || pid === (t.whatsapp_phone_number_id ?? '')}>Guardar</button></Escritura>
              {t.whatsapp_phone_number_id && <Escritura permiso="tenant:configure"><button type="button" className="btn" disabled={ocupado} onClick={verificar}>Probar conexión</button></Escritura>}
            </div>
            {d && <div className={d.ok ? 'aviso exito' : 'bloqueado'} role="status"><Icon n={d.ok ? 'ok' : 'alerta'} className="" size={16} /><span>{d.ok ? `Meta respondió: ${d.numero ?? ''} ${d.nombre ? `(${d.nombre})` : ''}${d.calidad ? ` · calidad ${String(d.calidad).toLowerCase()}` : ''}` : d.error ?? d.mensaje}{d.comprobado && <span className="tenue peq-txt"> · {fechaHora(d.comprobado)}</span>}</span></div>}
          </form>
        </Tarjeta>
        <Tarjeta titulo="Datos para configurar en Meta">
          <div className="col" style={{ gap: 10 }}>
            <span className="sec peq-txt">En el panel de desarrolladores de Meta (WhatsApp › Configuración), registra este webhook y suscríbete al campo <b>messages</b>.</span>
            <Campo etiqueta="URL del webhook"><span className="fila"><input className="input mono" readOnly value={data.webhook_whatsapp} onFocus={(e) => e.target.select()} /><button type="button" className="btn peq" onClick={() => navigator.clipboard?.writeText(data.webhook_whatsapp).then(() => toast('URL copiada'))}>Copiar</button></span></Campo>
            <span className="tenue peq-txt">El token de verificación lo define quien administra el servidor (variable WHATSAPP_VERIFY_TOKEN). Cada mensaje entrante se acepta solo si trae la firma válida de Meta.</span>
          </div>
        </Tarjeta>
      </div>
      {t.whatsapp_estado !== 'CONECTADO' && (
        <Link to="/whatsapp/numero" className="aviso enlace-bloque" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Icon n="telefono" className="" size={16} />
          <span><b>¿No tienes un número para WhatsApp Business?</b> Contrata uno desde Omnegia: eliges el número, ves el precio antes de pagar y lo dejamos conectado a tu asistente.</span>
        </Link>
      )}
      <Tarjeta titulo="Plantillas de mensajes" sinCuerpo>
        <p className="cuerpo sec peq-txt">Fuera de las 24 horas siguientes al último mensaje del cliente, WhatsApp solo entrega plantillas aprobadas. Crea cada una en el administrador de WhatsApp de Meta con el mismo texto y marca aquí su nombre cuando Meta la apruebe.</p>
        <div className="lista">{data.plantillas.map((p: any) => <Plantilla key={p.clave} p={p} onCambio={onCambio} />)}</div>
      </Tarjeta>
    </div>
  );
}

function Plantilla({ p, onCambio }: { p: any; onCambio: () => void }) {
  const [abierta, setAbierta] = useState(false);
  const [f, setF] = useState({ nombre_proveedor: p.nombre_proveedor ?? '', idioma: p.idioma ?? 'es', estado_aprobacion: p.estado_aprobacion });
  const { run, ocupado } = useAccion();
  const meta = String(p.cuerpo).replace(/\{\{(\w+)\}\}/g, (_: string, k: string) => `{{${(p.variables as string[]).indexOf(k) + 1}}}`);
  return (
    <div className="plantilla-fila">
      <div className="fila entre envolver" style={{ gap: 8 }}>
        <span className="col" style={{ gap: 2, minWidth: 0 }}><b>{p.clave.replace(/_/g, ' ')}</b><span className="tenue peq-txt">{p.categoria === 'UTILIDAD' ? 'Utilidad' : p.categoria === 'MARKETING' ? 'Marketing' : 'Autenticación'}{p.nombre_proveedor ? ` · en Meta: ${p.nombre_proveedor}` : ''}</span></span>
        <span className="fila" style={{ gap: 6 }}><Estado v={p.estado_aprobacion} /><button type="button" className="btn peq" onClick={() => setAbierta(!abierta)} aria-expanded={abierta}>{abierta ? 'Cerrar' : 'Registrar'}</button></span>
      </div>
      {abierta && (
        <div className="col" style={{ gap: 10, marginTop: 10 }}>
          <Campo etiqueta="Texto para copiar en Meta" ayuda="las variables van numeradas"><textarea className="input mono" readOnly value={meta} rows={3} /></Campo>
          <div className="grid g2">
            <Campo etiqueta="Nombre aprobado en Meta"><input className="input mono" value={f.nombre_proveedor} placeholder="recordatorio_cita" onChange={(e) => setF({ ...f, nombre_proveedor: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} /></Campo>
            <Campo etiqueta="Idioma"><input className="input mono" value={f.idioma} placeholder="es o es_CO" onChange={(e) => setF({ ...f, idioma: e.target.value })} /></Campo>
            <Campo etiqueta="Estado en Meta"><select className="input" value={f.estado_aprobacion} onChange={(e) => setF({ ...f, estado_aprobacion: e.target.value })}><option value="NO_REGISTRADA">Sin registrar</option><option value="APROBADA">Aprobada</option><option value="RECHAZADA">Rechazada</option><option value="PAUSADA">Pausada</option></select></Campo>
          </div>
          <Escritura permiso="tenant:configure"><button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={() => run(() => api.patch(`/api/t/configuracion/plantillas/${p.clave}`, { ...f, nombre_proveedor: f.nombre_proveedor || null }), 'Plantilla actualizada').then((r) => { if (r) { setAbierta(false); onCambio(); } })}>Guardar</button></Escritura>
        </div>
      )}
    </div>
  );
}

function Cobros({ data, onCambio }: { data: any; onCambio: () => void }) {
  const { s } = useSesion();
  const [f, setF] = useState({ entorno: 'sandbox', llave_publica: '', secreto_integridad: '', secreto_eventos: '' });
  const { run, ocupado, error } = useAccion();
  const toast = useToast();
  const cuenta = data.pasarela;
  const completo = f.llave_publica && f.secreto_integridad && f.secreto_eventos;
  return (
    <div className="grid g2">
      <MetodosCobro pasarela={!!cuenta} />
      <Tarjeta titulo="Cuenta de cobros (Wompi)" acciones={cuenta ? <Estado v="CONECTADO" texto={cuenta.proveedor === 'wompi' ? `Wompi · ${cuenta.entorno === 'produccion' ? 'producción' : 'pruebas'}` : 'Simulada'} /> : <Estado v="SIN_CONFIGURAR" />}>
        <form className="col" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/api/t/configuracion/pasarela', { proveedor: 'wompi', ...f }), 'Cuenta vinculada', { silencioso: true }); if (r) { setF({ ...f, secreto_integridad: '', secreto_eventos: '' }); onCambio(); } }}>
          <span className="sec peq-txt">El dinero de tus ventas va directo a tu cuenta de Wompi. Encuentra estos datos en el panel de Wompi › Desarrolladores.</span>
          {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
          <Campo etiqueta="Entorno"><select className="input" value={f.entorno} onChange={(e) => setF({ ...f, entorno: e.target.value })}><option value="sandbox">Pruebas (llaves pub_test_…)</option><option value="produccion">Producción (llaves pub_prod_…)</option></select></Campo>
          <Campo etiqueta="Llave pública"><input className="input mono" value={f.llave_publica} onChange={(e) => setF({ ...f, llave_publica: e.target.value.trim() })} placeholder="pub_test_…" autoComplete="off" /></Campo>
          <Campo etiqueta="Secreto de integridad" ayuda="se guarda cifrado"><input className="input mono" type="password" value={f.secreto_integridad} onChange={(e) => setF({ ...f, secreto_integridad: e.target.value.trim() })} autoComplete="off" /></Campo>
          <Campo etiqueta="Secreto de eventos" ayuda="se guarda cifrado"><input className="input mono" type="password" value={f.secreto_eventos} onChange={(e) => setF({ ...f, secreto_eventos: e.target.value.trim() })} autoComplete="off" /></Campo>
          <Escritura permiso="subscription:manage"><button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado || !completo}>{cuenta ? 'Actualizar cuenta' : 'Vincular cuenta'}</button></Escritura>
          {s.simuladores && !cuenta && <button type="button" className="btn sutil peq" style={{ alignSelf: 'flex-start' }} onClick={() => run(() => api.post('/api/t/configuracion/pasarela', { proveedor: 'simulada', cuenta_id: 'cuenta-demo' }), 'Pasarela simulada vinculada').then(onCambio)}>Usar la pasarela simulada (demostración)</button>}
        </form>
      </Tarjeta>
      {cuenta?.webhook_url && (
        <Tarjeta titulo="Confirmación automática de pagos">
          <div className="col" style={{ gap: 10 }}>
            <span className="sec peq-txt">Copia esta URL en Wompi › Desarrolladores › «URL de eventos» del mismo entorno. Así cada pago se confirma solo, aunque el cliente cierre la página.</span>
            <span className="fila"><input className="input mono" readOnly value={cuenta.webhook_url} onFocus={(e) => e.target.select()} /><button type="button" className="btn peq" onClick={() => navigator.clipboard?.writeText(cuenta.webhook_url).then(() => toast('URL copiada'))}>Copiar</button></span>
            <span className="tenue peq-txt">Vinculada el {fecha(cuenta.vinculado_en)}. Un pago solo se marca como recibido cuando Wompi lo confirma con su firma.</span>
          </div>
        </Tarjeta>
      )}
    </div>
  );
}

const METODOS_MANUALES: [string, string, string][] = [
  ['EFECTIVO', 'Efectivo', 'Se registra lo recibido y la plataforma calcula el cambio.'],
  ['TRANSFERENCIA', 'Transferencia', 'Nequi, Daviplata o cuenta bancaria. Confirma que el dinero llegó antes de registrarla.'],
  ['DATAFONO', 'Tarjeta (datáfono)', 'Si tienes datáfono propio. Se guarda el número de aprobación como referencia.'],
];

/** Métodos que el equipo puede registrar en el mostrador. La pasarela se activa sola al vincular Wompi. */
function MetodosCobro({ pasarela }: { pasarela: boolean }) {
  const { puede } = useSesion();
  const { data, error, recargar, setData } = useApi<any>(() => api.get('/api/t/cobros/metodos'), []);
  const { run, ocupado } = useAccion();
  const editable = puede('tenant:configure');
  const cambiar = async (k: string, v: boolean) => {
    const nuevo = { EFECTIVO: !!data.EFECTIVO, TRANSFERENCIA: !!data.TRANSFERENCIA, DATAFONO: !!data.DATAFONO, [k]: v };
    const r = await run(() => api.patch('/api/t/configuracion/cobros/metodos', nuevo), v ? 'Método activado' : 'Método desactivado');
    if (r) setData(r);
  };
  return (
    <Tarjeta titulo="Métodos de pago en el mostrador">
      {error ? <ErrorCarga error={error} reintentar={recargar} /> : !data ? <Cargando filas={3} /> : (
        <div className="col" style={{ gap: 12 }}>
          <span className="sec peq-txt">Lo que tu equipo puede registrar al vender o al cobrar una venta pendiente. Son registros internos: no mueven dinero ni pasan por la pasarela.</span>
          <div className="lista">
            {METODOS_MANUALES.map(([k, nombre, ayuda]) => (
              <div key={k} className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <span className="col" style={{ gap: 2 }}><b>{nombre}</b><span className="tenue peq-txt">{ayuda}</span></span>
                <Interruptor on={!!data[k]} etiqueta={`Aceptar ${nombre.toLowerCase()}`} disabled={!editable || ocupado} onChange={(v) => cambiar(k, v)} />
              </div>
            ))}
            <div className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
              <span className="col" style={{ gap: 2 }}><b>Pasarela de pagos (enlace)</b><span className="tenue peq-txt">Se marca pagada sola cuando Wompi confirma el pago con su firma.</span></span>
              <Estado v={pasarela ? 'CONECTADO' : 'SIN_CONFIGURAR'} texto={pasarela ? 'Activa' : 'Vincula Wompi'} />
            </div>
          </div>
          {!editable && <span className="tenue peq-txt">Solo quien administra la empresa cambia estos métodos.</span>}
          {data.actualizado_en && <span className="tenue peq-txt">Último cambio: {fechaHora(data.actualizado_en)}{data.actualizado_por ? ` · ${data.actualizado_por}` : ''}</span>}
        </div>
      )}
    </Tarjeta>
  );
}

function Invitar({ roles, onCerrar, onHecho }: { roles: any[]; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState({ email: '', nombre: '', rol: roles.find((r) => r.clave !== 'administrador')?.clave ?? roles[0].clave });
  const [hecho, setHecho] = useState<any>(null);
  const { run, ocupado, error } = useAccion();
  const toast = useToast();
  return (
    <Modal titulo="Invitar a una persona" onCerrar={onCerrar} pie={!hecho ? <><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !f.email || f.nombre.trim().length < 2} onClick={async () => { const r = await run(() => api.post('/api/t/configuracion/invitaciones', f), undefined, { silencioso: true }); if (r) { setHecho(r); onHecho(); } }}>Enviar invitación</button></> : <button className="btn primario" onClick={onCerrar}>Listo</button>}>
      {!hecho ? <>
        {error && <div className="bloqueado" role="alert"><Icon n="alerta" className="" size={16} />{error.message}</div>}
        <Campo etiqueta="Nombre"><input className="input" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></Campo>
        <Campo etiqueta="Correo"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
        <Campo etiqueta="Rol"><select className="input" value={f.rol} onChange={(e) => setF({ ...f, rol: e.target.value })}>{roles.map((r) => <option key={r.clave} value={r.clave}>{r.nombre}</option>)}</select></Campo>
        <span className="tenue peq-txt">Recibirá un enlace para crear su contraseña (o entrar con la suya si ya tiene cuenta). Vence en 7 días.</span>
      </> : hecho.correo_enviado ? <span>Enviamos la invitación a <b>{f.email}</b>.</span> : <>
        <span>Invitación creada. El correo está pendiente de conectar, así que comparte este enlace con {f.nombre} por un canal seguro:</span>
        <span className="fila"><input className="input mono" readOnly value={hecho.enlace} onFocus={(e) => e.target.select()} /><button type="button" className="btn peq" onClick={() => navigator.clipboard?.writeText(hecho.enlace).then(() => toast('Enlace copiado'))}>Copiar</button></span>
      </>}
    </Modal>
  );
}

// =================================================================== Suscripción
/** Comprobantes (y facturas, cuando existan) de los pagos de la empresa a Omnegia. */
function DocumentosPagos() {
  const { data, error, recargar } = useApi<any[]>(() => api.get('/api/t/suscripcion/documentos'), []);
  const [bajando, setBajando] = useState<string | null>(null);
  const [err, setErr] = useState('');
  if (error) return <Tarjeta titulo="Documentos de tus pagos"><ErrorCarga error={error} reintentar={recargar} /></Tarjeta>;
  if (!data?.length) return null;
  const bajar = async (id: string) => {
    setErr(''); setBajando(id);
    try { await descargarDocumentos(() => api.post(`/api/t/suscripcion/documentos/${id}/enlace`)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBajando(null); }
  };
  return (
    <Tarjeta titulo="Documentos de tus pagos" sinCuerpo>
      <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Documento</th><th>Estado fiscal</th><th>Fecha</th><th className="num">Archivo</th></tr></thead>
        <tbody>{data.map((d) => <tr key={d.id}>
          <td className="mono">{d.factura_numero ?? d.numero}</td>
          <td>{d.estado_fiscal_texto}</td>
          <td>{fecha(d.generado_en ?? d.creado_en)}</td>
          <td className="num">{d.estado === 'LISTO'
            ? <button className="btn peq" disabled={bajando === d.id} onClick={() => bajar(d.id)}><Icon n="descargar" className="" size={14} />{bajando === d.id ? 'Preparando…' : '.zip'}</button>
            : <span className="tenue peq-txt">{d.estado === 'SIN_DATOS' ? 'Sin datos de facturación' : 'En preparación'}</span>}</td>
        </tr>)}</tbody></table></div>
      <p className="sec peq-txt" style={{ padding: '10px 16px' }}>Cada .zip se abre sin contraseña; sus documentos piden el número de documento de facturación, sin puntos, espacios ni guiones.{err ? ` ${err}` : ''}</p>
    </Tarjeta>
  );
}

export function Suscripcion() {
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/suscripcion'), []);
  const { run, ocupado } = useAccion();
  const [confirmar, setConfirmar] = useState(false);
  if (error) return <><Cabecera titulo="Suscripción" /><div className="contenido"><ErrorCarga error={error} reintentar={recargar} /></div></>;
  if (!data) return <><Cabecera titulo="Suscripción" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  const s = data.suscripcion;
  const ciclo = ['ACTIVA', 'PAGO_PENDIENTE', 'EN_GRACIA', 'SUSPENDIDA'];
  const efecto: Record<string, string> = { ACTIVA: 'Todo funciona según tu plan', PAGO_PENDIENTE: 'Sigue funcionando; renueva pronto', EN_GRACIA: 'Sigue funcionando por pocos días', SUSPENDIDA: 'Solo lectura y exportación; WhatsApp pausado' };
  const ren = data.renovacion;
  const institucional = s.modalidad === 'INSTITUCIONAL';
  // Lo que se envía es lo que se mostró: el servidor lo compara con su oferta vigente y decide el monto.
  const pagar = async () => {
    setConfirmar(false);
    const cuerpo = ren?.requiere_confirmacion ? { modalidad: ren.modalidad, monto: ren.monto, acepto: ren.requiere_aceptacion || undefined } : {};
    const r = await run(() => api.post('/api/t/suscripcion/pagar', cuerpo));
    if (r?.url) window.location.assign(r.url.startsWith(window.location.origin) ? r.url.replace(window.location.origin, '') : r.url);
    else recargar();
  };
  const textoPagar = ren?.requiere_aceptacion ? 'Ver el plan comercial' : institucional ? `Renovar ${ren?.acceso_dias ?? ''} días` : s.estado === 'ACTIVA' ? 'Pagar el próximo mes' : s.estado === 'SUSPENDIDA' ? 'Pagar y reactivar' : 'Renovar ahora';
  const etiquetaMetrica: Record<string, string> = { tokens_ia: 'IA', mensajes: 'Mensajes', documentos: 'Documentos fiscales', plantillas_marketing: 'Plantillas de marketing' };
  return (
    <>
      <Cabecera titulo="Suscripción" sub={institucional ? `Modalidad institucional · pagaste ${cop(s.precio_pagado ?? 0)} · acceso hasta el ${fecha(s.periodo_fin)}` : `Plan ${s.plan_nombre} · ${cop(s.precio_mensual)} al mes`}>
        {data.pagos_en_linea && ren?.disponible && <button className="btn primario" disabled={ocupado} onClick={() => (ren.requiere_confirmacion ? setConfirmar(true) : pagar())}>{ocupado ? 'Preparando…' : textoPagar}</button>}
      </Cabecera>
      {confirmar && ren && <Confirmar titulo={ren.requiere_aceptacion ? 'Cambiar al plan comercial' : 'Renovar el acceso institucional'} textoBoton={ren.requiere_aceptacion ? `Acepto y pagar ${cop(ren.monto)}` : `Pagar ${cop(ren.monto)} con Wompi`}
        efecto={<div className="col" style={{ gap: 10 }}>
          <p>{ren.mensaje}</p>
          <dl className="resumen-pago">
            <div><dt>Modalidad</dt><dd>{ren.modalidad === 'INSTITUCIONAL' ? 'Institucional' : 'Comercial'}</dd></div>
            <div><dt>Valor</dt><dd>{cop(ren.monto)} COP{ren.acceso_dias ? '' : ' / mes'}</dd></div>
            <div><dt>Vigencia</dt><dd>{ren.acceso_dias ? `${ren.acceso_dias} días` : '1 mes'} desde el fin del periodo actual</dd></div>
            <div><dt>Cobro</dt><dd>Real, único, con Wompi · sin cobros automáticos</dd></div>
          </dl>
        </div>}
        onCerrar={() => setConfirmar(false)} onConfirmar={pagar} />}
      <div className="contenido">
        <Tarjeta titulo={<span className="fila">Estado <Estado v={s.estado} /></span>} nivel={['SUSPENDIDA', 'EN_GRACIA'].includes(s.estado) ? 3 : 2}>
          <ol className="ciclo-sus" aria-label="Ciclo de la suscripción">
            {ciclo.map((c) => (
              <li key={c} className={c === s.estado ? 'actual' : ''} aria-current={c === s.estado ? 'step' : undefined}>
                <Estado v={c} /><span className="tenue peq-txt">{efecto[c]}</span>{c === s.estado && <span className="sr"> (estado actual)</span>}
              </li>
            ))}
          </ol>
          <p className="sec" style={{ marginTop: 12 }}>Periodo actual: {fecha(s.periodo_inicio)} – {fecha(s.periodo_fin)}{s.gracia_hasta ? ` · gracia hasta el ${fecha(s.gracia_hasta)}` : ''}. Suspender no borra tus datos: conservas lectura y exportación.</p>
          {!data.pagos_en_linea && <p className="aviso peq-txt" style={{ marginTop: 12 }}><Icon n="info" className="" size={14} />El pago en línea está pendiente de conectar. Escríbenos para renovar.</p>}
          {institucional && ren && <p className="aviso peq-txt" style={{ marginTop: 12 }}><Icon n="info" className="" size={14} /><span>{ren.disponible ? ren.mensaje : 'La renovación en línea no está disponible por ahora. Escríbenos y te ayudamos.'} No hay cobros automáticos.</span></p>}
        </Tarjeta>
        <DocumentosPagos />
        <NumeroContratado />
        {data.periodos?.length > 0 && (
          <Tarjeta titulo="Pagos de tu suscripción" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Periodo</th><th>Modalidad</th><th className="num">Pagado</th><th className="num">Referencia comercial</th></tr></thead>
              <tbody>{data.periodos.map((p: any, i: number) => <tr key={i}><td>{fecha(p.periodo_inicio)} – {fecha(p.periodo_fin)}</td><td>{p.modalidad === 'INSTITUCIONAL' ? 'Institucional' : 'Comercial'}</td><td className="num">{cop(p.monto_pagado)}</td><td className="num">{p.monto_referencia != null ? `${cop(p.monto_referencia)} / mes` : '—'}</td></tr>)}</tbody></table></div>
          </Tarjeta>
        )}
        <div className="kpis k3" aria-label="Consumo del mes">
          <div className="kpi"><Medidor c={data.consumo.tokens_ia} etiqueta="IA" /></div>
          <div className="kpi"><Medidor c={data.consumo.mensajes} etiqueta="Mensajes" /></div>
          <div className="kpi"><Medidor c={data.consumo.documentos} etiqueta="Documentos fiscales" /></div>
        </div>
        <Tarjeta titulo="Tu plan">
          <dl className="plan-def">
            <div><dt>Personas</dt><dd>{data.usuarios} de {s.max_usuarios}</dd></div>
            <div><dt>IA al mes</dt><dd>{num(s.cuota_tokens_ia)}</dd></div>
            <div><dt>Mensajes al mes</dt><dd>{num(s.cuota_mensajes)}</dd></div>
            <div><dt>Documentos al mes</dt><dd>{num(s.cuota_documentos)}</dd></div>
          </dl>
          <p className="sec" style={{ marginTop: 12 }}>{s.politica_excedente === 'LIMITAR' ? 'Al llegar al tope de IA, el agente pasa las conversaciones a tu equipo en lugar de generar cobros adicionales.' : `El excedente de IA se cobra a ${cop(s.precio_excedente_1k_tokens)} por cada 1.000 unidades.`} Estos pagos son de tu plan con nosotros; los cobros a tus clientes van a tu propia cuenta.</p>
        </Tarjeta>
        {data.historico.length > 0 && (
          <Tarjeta titulo="Consumo de meses anteriores" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Mes</th><th>Concepto</th><th className="num">Cantidad</th></tr></thead><tbody>{data.historico.map((h: any, i: number) => <tr key={i}><td className="mono">{h.periodo}</td><td>{etiquetaMetrica[h.metrica] ?? h.metrica}</td><td className="num">{num(h.cantidad)}</td></tr>)}</tbody></table></div>
          </Tarjeta>
        )}
      </div>
    </>
  );
}

/** Número de WhatsApp contratado: cargo separado del plan y de lo que cobra Meta. */
function NumeroContratado() {
  const { data } = useApi<any>(() => api.get('/api/t/numeros/contratacion'), []);
  const c = data?.contratacion && data.contratacion.estado !== 'CANCELADO' ? data.contratacion : null;
  return (
    <Tarjeta titulo="Número de WhatsApp" acciones={<Link className="btn peq" to="/whatsapp/numero">{c ? 'Gestionar' : 'Contratar un número'}</Link>}>
      {c ? (
        <>
          <dl className="plan-def">
            <div><dt>Número</dt><dd className="mono">{c.numero}</dd></div>
            <div><dt>Mensualidad del número</dt><dd>{cop(c.cotizacion.total_mensual)}</dd></div>
            <div><dt>{c.estado === 'CANCELACION_PENDIENTE' ? 'Activo hasta' : 'Próxima renovación'}</dt><dd>{c.periodo_fin ? fecha(c.periodo_fin) : 'Al entregarse el número'}</dd></div>
            <div><dt>Proveedor</dt><dd>{c.proveedor}</dd></div>
          </dl>
          <p className="sec" style={{ marginTop: 12 }}>Se paga aparte de tu plan de Omnegia y no incluye lo que Meta cobra por las plantillas que envías.</p>
        </>
      ) : <p className="sec">No tienes un número contratado con Omnegia. Si usas tu propio número de WhatsApp Business no pagas mensualidad de número.</p>}
    </Tarjeta>
  );
}

// =================================================================== Auditoría
const ACTOR: Record<string, string> = { USUARIO: 'Persona', AGENTE: 'IA', SISTEMA: 'Sistema', CLIENTE: 'Cliente', PLATAFORMA: 'Plataforma', ANONIMO: 'Externo' };
const CLAVES_DETALLE: Record<string, string> = { motivo: 'Motivo', campos: 'Campos', numero: 'Número', referencia: 'Referencia', radicado: 'Radicado', prioridad: 'Prioridad', estado: 'Estado', filas: 'Filas', total: 'Total', decision: 'Decisión', ruta: 'Ruta', metodo: 'Método', de: 'Antes', a: 'Después', activo: 'Activo', habilitada: 'Habilitada', plan: 'Plan', error: 'Error' };

function valorLegible(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.map(valorLegible).join(', ');
  if (typeof v === 'boolean') return v ? 'sí' : 'no';
  if (typeof v === 'object') return Object.entries(v as object).map(([k, x]) => `${CLAVES_DETALLE[k] ?? k}: ${valorLegible(x)}`).join(' · ');
  return String(v);
}

export function Auditoria() {
  const [params, setParams] = useSearchParams();
  const [tipo, setTipo] = useState('');
  const [resultado, setResultado] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [pagina, setPagina] = useState(1);
  const [filas, setFilas] = useState<any[]>([]);
  const { data, error, recargar, cargando } = useApi<any[]>(() => api.get(`/api/t/auditoria?${new URLSearchParams({ tipo, resultado, q, pagina: String(pagina) }).toString()}`), [tipo, resultado, q, pagina]);
  useEffect(() => { setPagina(1); }, [tipo, resultado, q]);
  useEffect(() => { if (data) setFilas((prev) => (pagina === 1 ? data : [...prev, ...data])); }, [data]);
  const [sel, setSel] = useState<any>(null);
  const { run } = useAccion();
  return (
    <>
      <Cabecera titulo="Auditoría" sub={<span className="fila"><Icon n="candado" className="" size={14} />Registro inalterable: no se puede editar ni borrar</span>}>
        {!error && <button className="btn" onClick={() => run(() => descargar(`/api/t/auditoria.csv?${new URLSearchParams({ tipo, resultado, q })}`, 'auditoria.csv'), 'Exportación lista').then(recargar)}>Exportar</button>}
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <section className="tarjeta" hidden={!!error}>
          <div className="filtros">
            <div className="tabs" role="group" aria-label="Tipo de evento">{[['', 'Todo'], ['ia', 'IA'], ['seguridad', 'Seguridad'], ['fiscal', 'Facturación'], ['cobros', 'Cobros'], ['configuracion', 'Configuración']].map(([k, v]) => <button key={k} className={tipo === k ? 'on' : ''} aria-pressed={tipo === k} onClick={() => setTipo(k)}>{v}</button>)}</div>
            <select className="input" style={{ width: 'auto' }} value={resultado} onChange={(e) => setResultado(e.target.value)} aria-label="Resultado"><option value="">Cualquier resultado</option>{['EXITO', 'PERMITIDO', 'DENEGADO', 'NO_ENCONTRADO', 'ERROR'].map((r) => <option key={r} value={r}>{{ EXITO: 'Éxito', PERMITIDO: 'Permitido', DENEGADO: 'Denegado', NO_ENCONTRADO: 'No encontrado', ERROR: 'Error' }[r]}</option>)}</select>
            <label className="buscar" style={{ minWidth: 0, flex: '1 1 240px', maxWidth: 360 }}><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Acción, persona o código" aria-label="Buscar en auditoría" value={q} onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}); }} /></label>
          </div>
          {!data && pagina === 1 ? <Cargando /> : filas.length === 0 ? <Vacio titulo="Sin eventos para este filtro">Cambia el tipo, el resultado o la búsqueda.</Vacio> : (
            <>
              <div className="tabla-wrap" style={{ maxHeight: 'calc(100vh - 260px)' }}><table className="tabla tabla-movil">
                <thead><tr><th>Momento</th><th>Quién</th><th>Acción</th><th>Resultado</th><th>Desde</th></tr></thead>
                <tbody>{filas.map((e) => (
                  <tr key={e.id} className="clic" onClick={() => setSel(e)}>
                    <td data-etiqueta="Momento" className="mono">{fecha(e.creado_en)} {hora(e.creado_en)}</td>
                    <td data-etiqueta="Quién"><span className="tenue peq-txt">{ACTOR[e.actor_tipo] ?? e.actor_tipo}</span> {e.actor_nombre}</td>
                    <td data-etiqueta="Acción" className="principal">{e.accion.startsWith('ia.herramienta.') ? accionIA(e.accion.replace('ia.herramienta.', '')) : e.accion.replace(/[._]/g, ' ')}</td>
                    <td data-etiqueta="Resultado"><Estado v={e.resultado} /></td><td data-etiqueta="Desde">{e.origen.toLowerCase()}</td>
                  </tr>
                ))}</tbody>
              </table></div>
              {data && data.length === 100 && <div className="cuerpo"><button className="btn" disabled={cargando} onClick={() => setPagina(pagina + 1)}>{cargando ? 'Cargando…' : 'Ver más antiguos'}</button></div>}
            </>
          )}
        </section>
        <p className="nota-pie"><Icon n="candado" className="" size={14} />Los intentos de acceder a datos de otra empresa se registran aquí y se responden con «no encontramos eso», sin confirmar si el dato existe.</p>
      </div>
      {sel && (
        <Modal titulo={sel.accion.startsWith('ia.herramienta.') ? accionIA(sel.accion.replace('ia.herramienta.', '')) : sel.accion.replace(/[._]/g, ' ')} onCerrar={() => setSel(null)}>
          <div className="col" style={{ gap: 12 }}>
            <dl className="datos-def">
              <dt>Momento</dt><dd>{fechaHora(sel.creado_en)}</dd>
              <dt>Quién</dt><dd>{ACTOR[sel.actor_tipo] ?? sel.actor_tipo} · {sel.actor_nombre}</dd>
              <dt>Resultado</dt><dd><Estado v={sel.resultado} /></dd>
              <dt>Desde</dt><dd>{sel.origen.toLowerCase()}</dd>
              {Object.entries(sel.detalle ?? {}).filter(([k]) => !['agente', 'comprobacion', 'conversacion', 'permiso', 'riesgo'].includes(k)).map(([k, v]) => <Fragment key={k}><dt>{CLAVES_DETALLE[k] ?? k.replace(/_/g, ' ')}</dt><dd>{k === 'motivo' && sel.accion.startsWith('ia.') ? motivoIA(String(v)) : valorLegible(v)}</dd></Fragment>)}
              <dt>Código de seguimiento</dt><dd className="mono">{sel.correlacion}</dd>
            </dl>
            <span className="tenue peq-txt fila"><Icon n="candado" className="" size={14} />Este registro no se puede editar ni borrar. Si soporte te lo pide, comparte el código de seguimiento.</span>
          </div>
        </Modal>
      )}
    </>
  );
}

// =================================================================== Simulador del canal (solo demostración)
export function Simulador() {
  const { s } = useSesion();
  const [tel, setTel] = useState('+573001234567');
  const [nombre, setNombre] = useState('Cliente de prueba');
  const [texto, setTexto] = useState('');
  const { data, recargar } = useApi<any>(() => api.get(`/api/t/simulador/whatsapp?telefono=${encodeURIComponent(tel)}`), [tel], { cada: 1500 });
  const { run, ocupado } = useAccion();
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [data?.mensajes?.length]);
  const enviar = async (e?: FormEvent, t?: string, tipo = 'text') => {
    e?.preventDefault();
    const msg = (t ?? texto).trim() || (tipo !== 'text' ? '-' : '');
    if (!msg) return;
    if (tipo === 'text') setTexto('');
    await run(() => api.post('/api/t/simulador/whatsapp', { telefono: tel, nombre, texto: msg, tipo }));
    recargar();
  };
  const sugerencias = ['Hola', 'Sí', '¿Cuánto vale el corte + barba?', 'Quiero una cita de corte clásico mañana a las 10', 'Sí', '¿A qué hora es mi cita?', 'Quiero comprar una cera para peinar', '¿Me llegó la factura?', 'Quiero poner un reclamo'];
  if (!s.simuladores) return <><Cabecera titulo="Simulador de WhatsApp" /><div className="contenido"><Vacio titulo="No disponible">El simulador solo existe en el entorno de demostración.</Vacio></div></>;
  return (
    <>
      <Cabecera titulo="Simulador de WhatsApp" sub="Prueba cómo responde tu negocio a un cliente. Estos mensajes no se envían a WhatsApp." />
      <div className="contenido">
        {!s.tenant.whatsapp_phone_number_id && <div className="bloqueado"><Icon n="candado" className="" size={16} /><span>Vincula primero un número en <Link to="/configuracion?tab=canal">Configuración › WhatsApp</Link> (en demostración: sim-{s.tenant.slug}).</span></div>}
        <div className="aviso peq-txt"><Icon n="info" className="" size={16} />Herramienta de pruebas: lo que escribas aquí entra como si fuera de un cliente real y queda en Conversaciones y Auditoría. Las respuestas no salen a WhatsApp.</div>
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <section className="tarjeta telefono" aria-label="Vista del cliente en WhatsApp (simulada)">
            <div className="fila" style={{ padding: '12px 14px', gap: 10, borderBottom: '1px solid var(--borde)' }}><span className="marca-negocio" style={{ borderRadius: '50%' }}>{s.tenant.logo_data_url ? <img src={s.tenant.logo_data_url} alt="" /> : s.tenant.tema?.monograma}</span><span style={{ minWidth: 0 }}><b className="cortar" style={{ display: 'block' }}>{s.tenant.nombre}</b><span className="tenue cortar" style={{ fontSize: 12, display: 'block' }}>WhatsApp Business · simulado</span></span></div>
            <div className="hilo telefono-hilo" aria-live="polite">
              {(data?.mensajes ?? []).map((m: any) => (
                <div key={m.id} className={`wa ${m.remitente === 'CUSTOMER' ? 'propio' : ''}`}>
                  <span className="sr">{m.remitente === 'CUSTOMER' ? 'Tú (cliente): ' : `${s.tenant.nombre}: `}</span>{m.contenido}<span className="hora">{hora(m.creado_en)}</span>
                </div>
              ))}
              {!data?.mensajes?.length && <Vacio titulo="Escribe el primer mensaje">O usa el guion sugerido.</Vacio>}
              <div ref={fin} />
            </div>
            <form className="fila" style={{ padding: 10, borderTop: '1px solid var(--borde)' }} onSubmit={enviar}><input className="input" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Mensaje" aria-label="Mensaje del cliente" /><button className="btn primario icono" disabled={ocupado || !texto.trim()} aria-label="Enviar mensaje"><Icon n="enviar" className="" size={16} /></button></form>
          </section>
          <div className="col" style={{ gap: 16 }}>
            <Tarjeta titulo="Cliente simulado">
              <div className="col">
                <Campo etiqueta="Teléfono"><input className="input mono" value={tel} onChange={(e) => setTel(e.target.value)} /></Campo>
                <Campo etiqueta="Nombre de perfil"><input className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} /></Campo>
                <span className="tenue peq-txt">Cambia el teléfono para empezar como un cliente nuevo (verás el aviso de privacidad).</span>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Guion sugerido">
              <div className="fila envolver" style={{ gap: 6 }}>{sugerencias.map((t, i) => <button key={i} type="button" className="chip" onClick={() => enviar(undefined, t)} disabled={ocupado}>{t}</button>)}</div>
              <div className="fila envolver" style={{ gap: 6, marginTop: 10 }}>
                <button type="button" className="chip" disabled={ocupado} onClick={() => enviar(undefined, '-', 'image')}>Enviar una foto</button>
                <button type="button" className="chip" disabled={ocupado} onClick={() => enviar(undefined, '-', 'audio')}>Enviar un audio</button>
                <button type="button" className="chip" disabled={ocupado} onClick={() => enviar(undefined, '-', 'unsupported')}>Tipo no admitido</button>
              </div>
              <p className="tenue peq-txt" style={{ marginTop: 12 }}>Abre Conversaciones en otra pestaña para ver los recibos de cada acción y tomar el radicado cuando se escale.</p>
            </Tarjeta>
          </div>
        </div>
      </div>
    </>
  );
}
