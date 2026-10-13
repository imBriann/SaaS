import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, cop, fecha, fechaHora, hora, num, tenantSlug } from '../../api';
import { Cabecera, useSesion } from '../../components/Layout';
import { Campo, Cargando, Cifra, Confirmar, ErrorCarga, Estado, Interruptor, Medidor, Modal, Recibo, Tarjeta, useAccion, useApi, Vacio } from '../../components/ui';
import { Icon } from '../../components/icons';

// =================================================================== SCR-016 Centro de IA
export function CentroIA() {
  const { puede } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/ia'), []);
  const [filtro, setFiltro] = useState('');
  const ejec = useApi<any[]>(() => api.get(`/api/t/ia/ejecuciones${filtro ? `?decision=${filtro}` : ''}`), [filtro], { cada: 10000 });
  const [apagar, setApagar] = useState<any>(null);
  const { run } = useAccion();
  if (error) return <><Cabecera titulo="Centro de IA" /><div className="contenido"><ErrorCarga error={error} reintentar={recargar} /></div></>;
  if (!data) return <><Cabecera titulo="Centro de IA" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  const m = data.metricas;
  const toggle = async (t: any, v: boolean) => { await run(() => api.patch(`/api/t/ia/herramientas/${t.nombre}`, { habilitada: v }), `${t.nombre} ${v ? 'habilitada' : 'deshabilitada'}`); recargar(); };
  const NOMBRE_AGENTE: Record<string, string> = { atencion: 'Atención (WhatsApp)', asistente: 'Asistente del panel', copiloto: 'Copiloto del asesor' };
  return (
    <>
      <Cabecera titulo="Centro de IA" sub="Qué puede y qué no puede hacer la IA sobre los datos de tu negocio" />
      <div className="contenido">
        <div className="kpis">
          <Cifra etiqueta="Acciones ejecutadas (30 días)" valor={m.ejecutadas} detalle={`${m.pendientes} esperando confirmación`} />
          <Cifra etiqueta="Acciones bloqueadas" valor={m.denegadas} detalle="por el Gateway, con motivo" />
          <Cifra etiqueta="Rechazadas por el cliente" valor={m.rechazadas} detalle="respondió NO a la confirmación" />
          <div className="kpi"><Medidor c={data.consumo.tokens_ia} etiqueta="Consumo de IA" /></div>
        </div>
        <Tarjeta titulo="Agentes" acciones={<span className="tenue peq-txt">Una sola runtime, tres configuraciones</span>} sinCuerpo>
          <div className="lista">{data.agentes.map((a: any) => (
            <div key={a.id} className="agente-fila">
              <div className="col" style={{ gap: 6 }}>
                <span className="fila envolver" style={{ gap: 8 }}><b className="titulo-tarjeta">{NOMBRE_AGENTE[a.configuracion as string] ?? a.configuracion}</b>{a.activo ? <Estado v="ACTIVA" texto="Activo" /> : <Estado v="CANCELADA" texto="Inactivo" />}</span>
                <span className="tenue peq-txt">Rol <span className="mono">{a.rol}</span> · {a.herramientas.length} herramientas</span>
                <p className="sec peq-txt" style={{ maxWidth: '80ch' }}>{a.prompt_base}</p>
                <div className="fila envolver" style={{ gap: 4 }} aria-label="Permisos del agente">{a.permisos.map((p: string) => <span key={p} className="estado neutro mono">{p}</span>)}</div>
              </div>
              <Interruptor on={a.activo} disabled={!puede('ai:configure')} etiqueta={`Activar agente ${NOMBRE_AGENTE[a.configuracion as string] ?? a.configuracion}`} onChange={(v) => run(() => api.patch(`/api/t/ia/agentes/${a.configuracion}`, { activo: v }), v ? 'Agente activado' : 'Agente desactivado').then(recargar)} />
            </div>
          ))}</div>
        </Tarjeta>
        <Tarjeta titulo="Registro de herramientas" acciones={!puede('ai:configure') && <span className="tenue peq-txt fila"><Icon n="candado" className="" size={14} />Solo lectura para tu rol</span>} sinCuerpo>
          <div className="tabla-wrap"><table className="tabla">
            <thead><tr><th>Herramienta</th><th>Riesgo</th><th>Permiso</th><th>Agentes</th><th className="num">Uso 30 días</th><th>Activa</th></tr></thead>
            <tbody>{data.herramientas.map((t: any) => (
              <tr key={t.nombre}>
                <td className="envuelve" style={{ minWidth: 260, maxWidth: 460 }}><span className="mono">{t.nombre}</span><div className="tenue peq-txt" style={{ marginTop: 2 }}>{t.descripcion}{t.limite && ` · máx. ${t.limite} por conversación`}</div></td>
                <td><Estado v={t.riesgo_efectivo} />{t.riesgo_efectivo !== t.riesgo_declarado && <div className="tenue" style={{ fontSize: 12, marginTop: 2 }}>endurecido por la plantilla</div>}</td>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{t.permiso}</td>
                <td>{t.prohibida_a_agentes ? <span className="estado err"><Icon n="candado" className="" />Solo personas</span> : t.agentes.length ? t.agentes.join(', ') : <span className="tenue">—</span>}</td>
                <td className="num"><span className="fila" style={{ gap: 4, justifyContent: 'flex-end' }}><span className="estado ok" title="Ejecutadas"><Icon n="ok" className="" />{t.uso.ejecutadas}<span className="sr"> ejecutadas</span></span>{t.uso.denegadas > 0 && <span className="estado err" title="Denegadas"><Icon n="candado" className="" />{t.uso.denegadas}<span className="sr"> denegadas</span></span>}</span></td>
                <td>{t.prohibida_a_agentes ? <span className="tenue">—</span> : <Interruptor on={t.habilitada} disabled={!puede('ai:configure')} etiqueta={`Activar ${t.nombre}`} onChange={(v) => (v ? toggle(t, v) : setApagar(t))} />}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </Tarjeta>
        <div className="grid g-main" style={{ alignItems: 'start' }}>
            <Tarjeta titulo="Ejecuciones recientes" acciones={<select className="input" style={{ width: 'auto' }} value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar ejecuciones por decisión"><option value="">Todas</option><option value="DENEGADA">Denegadas</option><option value="CONFIRMADA">Confirmadas</option><option value="PENDIENTE_CONFIRMACION">Pendientes</option><option value="PERMITIDA">Permitidas</option></select>}>
              {ejec.error ? <ErrorCarga error={ejec.error} reintentar={ejec.recargar} /> : !ejec.data ? <Cargando /> : ejec.data.length === 0 ? <Vacio titulo="Sin ejecuciones">{filtro ? 'Ninguna ejecución con esa decisión.' : 'Cuando un agente use una herramienta, verás aquí su recibo.'}</Vacio> : (
                <div className="col" style={{ maxHeight: 560, overflowY: 'auto', gap: 12, paddingRight: 4 }}>{ejec.data.slice(0, 60).map((e) => <div key={e.id} className="col" style={{ gap: 4 }}><span className="tenue" style={{ fontSize: 12 }}>{NOMBRE_AGENTE[e.configuracion] ?? e.configuracion} · {e.cliente ?? 'panel'}</span><Recibo e={e} /></div>)}</div>
              )}
            </Tarjeta>
            <Tarjeta titulo="¿Dónde se detuvieron los bloqueos?">
              {data.por_comprobacion.length === 0 ? <Vacio titulo="Sin bloqueos">Ninguna llamada ha sido denegada.</Vacio> : <div className="lista">{data.por_comprobacion.map((c: any, i: number) => <div key={i} className="lista-fila" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}><span>Comprobación {c.c}<br /><span className="mono tenue">{c.motivo}</span></span><span className="cifra" style={{ fontSize: 22 }}>{c.n}</span></div>)}</div>}
              <p className="tenue peq-txt" style={{ marginTop: 12 }}>Comprobaciones del Gateway: 1 registro · 2 esquema · 3 permiso · 4 contexto y política.</p>
            </Tarjeta>
        </div>
      </div>
      {apagar && <Confirmar titulo={`Deshabilitar ${apagar.nombre}`} efecto={<>Ningún agente podrá usar <span className="mono">{apagar.nombre}</span>. Si lo intenta, la llamada se bloquea y queda registrada.</>} textoBoton="Deshabilitar" onCerrar={() => setApagar(null)} onConfirmar={() => { toggle(apagar, false); setApagar(null); }} />}
    </>
  );
}

// =================================================================== SCR-018 Configuración
export function Configuracion() {
  const { s, recargar: recargarSesion } = useSesion();
  const { data, error, recargar } = useApi<any>(() => api.get('/api/t/configuracion'), []);
  const [tab, setTab] = useState('personas');
  const [invitar, setInvitar] = useState(false);
  const [empresa, setEmpresa] = useState<any>(null);
  const [pasarela, setPasarela] = useState({ proveedor: 'pasarela-simulada', cuenta_id: '', llave_privada: '' });
  const { run, ocupado } = useAccion();
  useEffect(() => { if (data) setEmpresa({ ...data.tenant }); }, [data]);
  if (error) return <><Cabecera titulo="Configuración" /><div className="contenido"><ErrorCarga error={error} reintentar={recargar} /></div></>;
  if (!data || !empresa) return <><Cabecera titulo="Configuración" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  const rolesPersonas = data.roles.filter((r: any) => !r.es_agente);
  const permisos = Object.keys(data.catalogo_permisos);
  const tema = data.tenant.tema;
  const subirLogo = async (file: File) => {
    const url = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(file); });
    const img = new Image(); img.src = url; await img.decode();
    const cv = document.createElement('canvas'); cv.width = cv.height = 48; const cx = cv.getContext('2d')!; cx.drawImage(img, 0, 0, 48, 48);
    const px = cx.getImageData(0, 0, 48, 48).data; const m = new Map<string, number>();
    for (let i = 0; i < px.length; i += 4) { if (px[i + 3] < 128) continue; const k = '#' + [0, 1, 2].map((j) => Math.min(255, Math.round(px[i + j] / 24) * 24).toString(16).padStart(2, '0')).join(''); m.set(k, (m.get(k) ?? 0) + 1); }
    const colores = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k]) => k);
    const r = await run(() => api.post('/api/t/configuracion/tema', { colores, logo_data_url: url }), 'Identidad actualizada');
    if (r) { recargar(); recargarSesion(); }
  };
  return (
    <>
      <Cabecera titulo="Configuración" sub={`${data.tenant.nombre} · ${data.tenant.slug}`} />
      <div className="contenido">
        <div className="tabs" role="group" aria-label="Secciones de configuración">{[['personas', 'Personas y roles'], ['modulos', 'Módulos'], ['empresa', 'Empresa e identidad'], ['canal', 'WhatsApp y cobros']].map(([k, v]) => <button key={k} aria-pressed={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{v}</button>)}</div>

        {tab === 'personas' && <>
          <Tarjeta titulo="Personas con acceso" acciones={<button className="btn primario peq" onClick={() => setInvitar(true)}><Icon n="mas" className="" size={14} />Invitar</button>} sinCuerpo>
            <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Recibe casos</th><th>Acceso</th></tr></thead>
              <tbody>{data.personas.map((p: any) => (
                <tr key={p.id}>
                  <td style={{ whiteSpace: 'nowrap' }}><b style={{ fontWeight: 600 }}>{p.nombre}</b>{p.id === s.usuario.id && <span className="tenue"> (tú)</span>}</td><td className="mono">{p.email}</td>
                  <td><select className="input" style={{ width: 'auto', minWidth: 160 }} value={p.rol} disabled={p.id === s.usuario.id} aria-label={`Rol de ${p.nombre}`} onChange={(e) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { rol: e.target.value }), 'Rol actualizado').then(recargar)}>{rolesPersonas.map((r: any) => <option key={r.clave} value={r.clave}>{r.nombre}</option>)}</select></td>
                  <td><Interruptor on={p.disponible} etiqueta={`${p.nombre} recibe casos`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { disponible: v })).then(recargar)} /></td>
                  <td><Interruptor on={p.activo} disabled={p.id === s.usuario.id} etiqueta={`Acceso de ${p.nombre}`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { activo: v }), v ? 'Acceso restituido' : 'Acceso retirado').then(recargar)} /></td>
                </tr>
              ))}</tbody></table></div>
          </Tarjeta>
          <Tarjeta titulo="Qué puede hacer cada rol" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla">
              <thead><tr><th>Permiso</th>{data.roles.map((r: any) => <th key={r.clave} style={{ textAlign: 'center' }}>{r.nombre}{r.es_agente && <><br /><span className="estado ia" style={{ height: 18, marginTop: 2 }}>IA</span></>}</th>)}</tr></thead>
              <tbody>{permisos.map((p) => (
                <tr key={p}><td className="envuelve" style={{ minWidth: 220 }}><span className="mono">{p}</span><br /><span className="tenue peq-txt">{data.catalogo_permisos[p]}</span></td>
                  {data.roles.map((r: any) => <td key={r.clave} style={{ textAlign: 'center' }}>{r.permisos.includes(p) ? <span className="estado ok" title="Tiene el permiso"><Icon n="ok" className="" /><span className="sr">Sí</span></span> : <span className="tenue" title="No tiene el permiso">—<span className="sr">No</span></span>}</td>)}</tr>
              ))}</tbody>
            </table></div>
          </Tarjeta>
        </>}

        {tab === 'modulos' && (
          <Tarjeta titulo="Módulos" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Módulo</th><th>Plan</th><th>Activo</th></tr></thead><tbody>{data.modulos.map((m: any) => (
              <tr key={m.modulo}><td className="envuelve" style={{ minWidth: 220 }}><b style={{ fontWeight: 600 }}>{m.nombre}</b><br /><span className="tenue peq-txt">{m.descripcion}</span></td><td style={{ whiteSpace: 'nowrap' }}>{m.incluido_en_plan ? <span className="tenue">Incluido en tu plan</span> : <Estado v="PENDIENTE" texto="Requiere otro plan" />}</td>
                <td><Interruptor on={m.activo} disabled={!m.incluido_en_plan && !m.activo} etiqueta={`Módulo ${m.nombre}`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/modulos/${m.modulo}`, { activo: v }), `Módulo ${v ? 'activado' : 'desactivado'}`).then(() => { recargar(); recargarSesion(); })} /></td></tr>
            ))}</tbody></table></div>
          </Tarjeta>
        )}

        {tab === 'empresa' && (
          <div className="grid g2">
            <Tarjeta titulo="Datos de la empresa">
              <div className="col">
                {[['nombre', 'Nombre'], ['nit', 'NIT con dígito de verificación'], ['ciudad', 'Ciudad'], ['email_contacto', 'Correo de avisos'], ['telefono', 'Teléfono']].map(([k, l]) => (
                  <Campo key={k} etiqueta={l}><input className="input" value={empresa[k] ?? ''} onChange={(e) => setEmpresa({ ...empresa, [k]: e.target.value })} /></Campo>
                ))}
                <button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado || !empresa.nombre?.trim()} onClick={() => run(() => api.patch('/api/t/configuracion/empresa', { nombre: empresa.nombre, nit: empresa.nit || null, ciudad: empresa.ciudad || null, email_contacto: empresa.email_contacto, telefono: empresa.telefono || null }), 'Datos guardados').then(() => { recargar(); recargarSesion(); })}>Guardar cambios</button>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Identidad visual">
              <div className="col" style={{ gap: 14 }}>
                <div className="fila" style={{ gap: 12 }}>
                  <div style={{ width: 56, height: 56, borderRadius: 12, background: tema.acento, color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 18, overflow: 'hidden', flex: 'none' }}>{data.tenant.logo_data_url ? <img src={data.tenant.logo_data_url} alt="Logotipo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : tema.monograma}</div>
                  <div className="col" style={{ gap: 2 }}><span className="mono">{tema.acento}</span><span className="tenue peq-txt">Contraste del botón con texto blanco: {tema.contraste.acento_blanco}:1 (mínimo AA 4,5:1)</span>{tema.ajustado && <span className="tenue peq-txt">Luminosidad ajustada automáticamente para ser legible.</span>}</div>
                </div>
                {/* Muestras con los colores que el panel usa de verdad (tema claro + acento del tenant) */}
                <div className="fila envolver" style={{ gap: 10 }}>{[['Acción', tema.acento], ['Selección', `color-mix(in srgb, ${tema.acento} 9%, #fff)`], ['Tarjeta', 'var(--superficie)'], ['Lienzo', 'var(--lienzo)']].map(([n, c]) => <span key={n} className="col" style={{ alignItems: 'center', gap: 4 }}><span style={{ width: 40, height: 40, borderRadius: 8, background: c, border: '1px solid var(--borde-2)' }} /><span className="tenue" style={{ fontSize: 12 }}>{n}</span></span>)}</div>
                <label className="btn" style={{ alignSelf: 'flex-start' }}><Icon n="subir" className="" size={16} /> Cambiar logotipo<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && subirLogo(e.target.files[0])} /></label>
                <span className="tenue peq-txt">La marca de la plataforma solo aparece en las páginas públicas; dentro del panel, tu equipo ve tu negocio.</span>
              </div>
            </Tarjeta>
          </div>
        )}

        {tab === 'canal' && (
          <div className="grid g2">
            <Tarjeta titulo="Número de WhatsApp">
              <div className="col">
                <Campo etiqueta="Phone number ID de la cuenta de negocio" ayuda="lo entrega Meta al registrar el número; en el piloto puede ser sim-<nombre>"><input className="input mono" value={empresa.whatsapp_phone_number_id ?? ''} onChange={(e) => setEmpresa({ ...empresa, whatsapp_phone_number_id: e.target.value })} /></Campo>
                <button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={() => run(() => api.patch('/api/t/configuracion/empresa', { whatsapp_phone_number_id: empresa.whatsapp_phone_number_id || null }), 'Número vinculado').then(recargar)}>Vincular</button>
                <span className="tenue">El webhook del canal resuelve tu empresa por este identificador y verifica la firma de Meta antes de aceptar cualquier mensaje.</span>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Cobros a tus clientes">
              <div className="col">
                {data.pasarela ? <span className="fila envolver"><Estado v="EXITO" texto="Cuenta vinculada" /> <span className="mono">{data.pasarela.cuenta_id}</span> · {fecha(data.pasarela.vinculado_en)}</span> : <span className="fila"><Estado v="PENDIENTE" texto="Sin cuenta vinculada" /></span>}
                <Campo etiqueta="ID de tu cuenta en la pasarela"><input className="input mono" value={pasarela.cuenta_id} onChange={(e) => setPasarela({ ...pasarela, cuenta_id: e.target.value })} /></Campo>
                <Campo etiqueta="Llave privada" ayuda="se guarda cifrada"><input className="input mono" type="password" value={pasarela.llave_privada} onChange={(e) => setPasarela({ ...pasarela, llave_privada: e.target.value })} autoComplete="off" /></Campo>
                <button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado || !pasarela.cuenta_id || !pasarela.llave_privada} onClick={() => run(() => api.post('/api/t/configuracion/pasarela', pasarela), 'Cuenta vinculada').then(() => { setPasarela({ ...pasarela, llave_privada: '' }); recargar(); })}>Vincular cuenta</button>
                <span className="tenue">El dinero de tus ventas va directo a tu cuenta: la plataforma solo genera el enlace de cobro y concilia el resultado.</span>
              </div>
            </Tarjeta>
          </div>
        )}
      </div>
      {invitar && <Invitar roles={rolesPersonas} onCerrar={() => setInvitar(false)} onHecho={recargar} />}
    </>
  );
}

function Invitar({ roles, onCerrar, onHecho }: { roles: any[]; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState({ email: '', nombre: '', rol: roles.find((r) => r.clave !== 'administrador')?.clave ?? roles[0].clave });
  const [temporal, setTemporal] = useState<string | null | undefined>(undefined);
  const { run, ocupado } = useAccion();
  return (
    <Modal titulo="Invitar a una persona" onCerrar={onCerrar} pie={temporal === undefined ? <><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || !f.email || !f.nombre} onClick={async () => { const r = await run(() => api.post('/api/t/configuracion/personas', f), 'Persona invitada'); if (r) { setTemporal(r.contrasena_temporal); onHecho(); } }}>Invitar</button></> : <button className="btn primario" onClick={onCerrar}>Listo</button>}>
      {temporal === undefined ? <>
        <Campo etiqueta="Nombre"><input className="input" value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} /></Campo>
        <Campo etiqueta="Correo"><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
        <Campo etiqueta="Rol"><select className="input" value={f.rol} onChange={(e) => setF({ ...f, rol: e.target.value })}>{roles.map((r) => <option key={r.clave} value={r.clave}>{r.nombre}</option>)}</select></Campo>
      </> : temporal ? <><span>Comparte esta contraseña temporal con {f.nombre} por un canal seguro:</span><code style={{ fontSize: 16 }}>{temporal}</code><span className="tenue">No se volverá a mostrar.</span></> : <span>{f.nombre} ya tenía cuenta en la plataforma: puede entrar con su contraseña actual y elegir esta empresa.</span>}
    </Modal>
  );
}

// =================================================================== SCR-019 Suscripción
export function Suscripcion() {
  const { data, error } = useApi<any>(() => api.get('/api/t/suscripcion'), []);
  const { run, ocupado } = useAccion();
  if (error) return <><Cabecera titulo="Suscripción" /><div className="contenido"><ErrorCarga error={error} /></div></>;
  if (!data) return <><Cabecera titulo="Suscripción" /><div className="tarjeta"><Cargando filas={8} /></div></>;
  const s = data.suscripcion;
  const ciclo = ['ACTIVA', 'PAGO_PENDIENTE', 'EN_GRACIA', 'SUSPENDIDA', 'CANCELADA'];
  const efecto: Record<string, string> = { ACTIVA: 'Acceso completo según el plan', PAGO_PENDIENTE: 'Acceso completo; te avisamos', EN_GRACIA: 'Acceso completo; avisos crecientes', SUSPENDIDA: 'Solo lectura y exportación; el canal deja de atender', CANCELADA: 'Acceso cerrado; inicia el plazo de retención' };
  return (
    <>
      <Cabecera titulo="Suscripción" sub="Funciones y consumo de tu negocio">
        <span className="estado neutro">Configuración a medida</span>
      </Cabecera>
      <div className="contenido">
        <Tarjeta titulo={<span className="fila">Estado <Estado v={s.estado} /></span>} nivel={['SUSPENDIDA', 'EN_GRACIA'].includes(s.estado) ? 3 : 2}>
          <ol className="ciclo-sus" aria-label="Ciclo de la suscripción">
            {ciclo.map((c) => (
              <li key={c} className={c === s.estado ? 'actual' : ''} aria-current={c === s.estado ? 'step' : undefined}>
                <Estado v={c} /><span className="tenue peq-txt">{efecto[c]}</span>{c === s.estado && <span className="sr"> (estado actual)</span>}
              </li>
            ))}
          </ol>
          <p className="sec" style={{ marginTop: 12 }}>Periodo actual: {fecha(s.periodo_inicio)} – {fecha(s.periodo_fin)}. Suspender no borra tus datos: conservas lectura y exportación.</p>
        </Tarjeta>
        <div className="kpis k3" aria-label="Consumo del mes">
          <div className="kpi"><Medidor c={data.consumo.tokens_ia} etiqueta="IA (tokens)" /></div>
          <div className="kpi"><Medidor c={data.consumo.mensajes} etiqueta="Mensajes" /></div>
          <div className="kpi"><Medidor c={data.consumo.documentos} etiqueta="Documentos fiscales" /></div>
        </div>
        <Tarjeta titulo="Tu plan">
          <dl className="plan-def">
            <div><dt>Personas</dt><dd>{data.usuarios} de {s.max_usuarios}</dd></div>
            <div><dt>Tokens de IA / mes</dt><dd>{num(s.cuota_tokens_ia)}</dd></div>
            <div><dt>Mensajes / mes</dt><dd>{num(s.cuota_mensajes)}</dd></div>
            <div><dt>Documentos / mes</dt><dd>{num(s.cuota_documentos)}</dd></div>
          </dl>
          <p className="sec" style={{ marginTop: 12 }}>{s.politica_excedente === 'LIMITAR' ? 'Al llegar al tope de IA, el agente pasa las conversaciones a tu equipo en lugar de generar cobros adicionales.' : `Excedente de IA facturado a ${cop(s.precio_excedente_1k_tokens)} por cada 1.000 tokens.`} Los mensajes dentro de la ventana de 24 horas no tienen costo de canal.</p>
        </Tarjeta>
        {data.historico.length > 0 && (
          <Tarjeta titulo="Histórico de consumo" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla"><thead><tr><th>Periodo</th><th>Métrica</th><th className="num">Cantidad</th></tr></thead><tbody>{data.historico.map((h: any, i: number) => <tr key={i}><td className="mono">{h.periodo}</td><td>{h.metrica}</td><td className="num">{num(h.cantidad)}</td></tr>)}</tbody></table></div>
          </Tarjeta>
        )}
      </div>
    </>
  );
}

// =================================================================== SCR-020 Auditoría
export function Auditoria() {
  const [params, setParams] = useSearchParams();
  const [tipo, setTipo] = useState('');
  const [resultado, setResultado] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  const { data, error, recargar } = useApi<any[]>(() => api.get(`/api/t/auditoria?${new URLSearchParams({ tipo, resultado, q }).toString()}`), [tipo, resultado, q]);
  const [sel, setSel] = useState<any>(null);
  const exportar = async () => {
    const res = await fetch(`/api/t/auditoria.csv?${new URLSearchParams({ tipo, resultado, q })}`, { headers: { 'x-tenant-slug': tenantSlug() ?? '' }, credentials: 'include' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = 'auditoria.csv';
    a.click();
    recargar();
  };
  return (
    <>
      <Cabecera titulo="Auditoría" sub={<span className="fila"><Icon n="candado" className="" size={14} />Registro de solo inserción: no se puede editar ni borrar</span>}>
        {!error && <button className="btn" onClick={exportar}>Exportar CSV</button>}
      </Cabecera>
      <div className="contenido">
        {error && <ErrorCarga error={error} reintentar={recargar} />}
        <section className="tarjeta" hidden={!!error}>
          <div className="filtros">
            <div className="tabs" role="group" aria-label="Tipo de evento">{[['', 'Todo'], ['ia', 'IA'], ['seguridad', 'Seguridad'], ['fiscal', 'Fiscal'], ['configuracion', 'Configuración']].map(([k, v]) => <button key={k} className={tipo === k ? 'on' : ''} aria-pressed={tipo === k} onClick={() => setTipo(k)}>{v}</button>)}</div>
            <select className="input" style={{ width: 'auto' }} value={resultado} onChange={(e) => setResultado(e.target.value)} aria-label="Resultado"><option value="">Cualquier resultado</option>{['EXITO', 'PERMITIDO', 'DENEGADO', 'NO_ENCONTRADO', 'ERROR'].map((r) => <option key={r} value={r}>{{ EXITO: 'Éxito', PERMITIDO: 'Permitido', DENEGADO: 'Denegado', NO_ENCONTRADO: 'No encontrado', ERROR: 'Error' }[r]}</option>)}</select>
            <label className="buscar" style={{ minWidth: 0, flex: '1 1 240px', maxWidth: 360 }}><Icon n="buscar" className="" size={16} /><input type="search" placeholder="Buscar acción, actor o recurso" aria-label="Buscar en auditoría" value={q} onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}); }} /></label>
          </div>
          {!data ? <Cargando /> : data.length === 0 ? <Vacio titulo="Sin eventos para este filtro">Cambia el tipo, el resultado o la búsqueda.</Vacio> : (
            <div className="tabla-wrap" style={{ maxHeight: 'calc(100vh - 250px)' }}><table className="tabla">
              <thead><tr><th>Momento</th><th>Actor</th><th>Acción</th><th>Recurso</th><th>Resultado</th><th>Origen</th><th>Evento</th></tr></thead>
              <tbody>{data.map((e) => (
                <tr key={e.id} className="clic" onClick={() => setSel(e)}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fecha(e.creado_en)} {hora(e.creado_en)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}><Estado v={e.actor_tipo === 'AGENTE' ? 'AGENTE' : e.actor_tipo === 'USUARIO' ? 'PANEL' : undefined} texto={e.actor_tipo.toLowerCase()} /> {e.actor_nombre}</td>
                  <td className="mono">{e.accion}</td>
                  <td className="mono tenue">{e.recurso ? `${e.recurso}${e.recurso_id ? ' · ' + String(e.recurso_id).slice(-8) : ''}` : '—'}</td>
                  <td><Estado v={e.resultado} /></td><td>{e.origen}</td><td className="mono tenue">{String(e.id).slice(-8)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <p className="nota-pie"><Icon n="candado" className="" size={14} />Los intentos de acceso a datos de otra empresa se registran aquí y se responden al solicitante con «no encontramos eso», sin confirmar que el recurso existe.</p>
      </div>
      {sel && (
        <Modal titulo={sel.accion} onCerrar={() => setSel(null)}>
          <div className="col" style={{ gap: 12 }}>
            <dl className="datos-def">
              <dt>Momento</dt><dd>{fechaHora(sel.creado_en)}</dd>
              <dt>Actor</dt><dd>{sel.actor_tipo.toLowerCase()} · {sel.actor_nombre}</dd>
              <dt>Resultado</dt><dd><Estado v={sel.resultado} /></dd>
              <dt>Correlación</dt><dd className="mono">{sel.correlacion}</dd>
              <dt>Evento</dt><dd className="mono">{sel.id}</dd>
            </dl>
            {sel.recurso === 'ai_execution' && sel.detalle?.decision && <Recibo e={{ id: sel.recurso_id, herramienta: sel.accion.replace('ia.herramienta.', ''), decision: sel.detalle.decision, nivel_riesgo: sel.detalle.riesgo, permiso_requerido: sel.detalle.permiso, motivo_denegacion: sel.detalle.motivo, comprobacion_fallida: sel.detalle.comprobacion, creado_en: sel.creado_en }} />}
            <span className="etiqueta">Detalle registrado</span>
            <pre className="mono" style={{ background: 'var(--superficie-2)', border: '1px solid var(--borde)', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0, fontSize: 12 }}>{JSON.stringify(sel.detalle, null, 2)}</pre>
            <span className="tenue peq-txt fila"><Icon n="candado" className="" size={14} />Este evento no se puede editar ni borrar.</span>
          </div>
        </Modal>
      )}
    </>
  );
}

// =================================================================== Simulador del canal (piloto)
export function Simulador() {
  const { s } = useSesion();
  const [tel, setTel] = useState('+573001234567');
  const [nombre, setNombre] = useState('Cliente de prueba');
  const [texto, setTexto] = useState('');
  const { data, recargar } = useApi<any>(() => api.get(`/api/t/simulador/whatsapp?telefono=${encodeURIComponent(tel)}`), [tel], { cada: 1500 });
  const { run, ocupado } = useAccion();
  const fin = useRef<HTMLDivElement>(null);
  useEffect(() => { fin.current?.scrollIntoView({ block: 'end' }); }, [data?.mensajes?.length]);
  const enviar = async (e?: FormEvent, t?: string) => {
    e?.preventDefault();
    const msg = (t ?? texto).trim();
    if (!msg) return;
    setTexto('');
    await run(() => api.post('/api/t/simulador/whatsapp', { telefono: tel, nombre, texto: msg }));
    recargar();
  };
  const sugerencias = ['Hola', 'Sí', '¿Cuánto vale el corte + barba?', 'Quiero una cita de corte clásico mañana a las 10', 'Sí', '¿A qué hora es mi cita?', 'Quiero comprar una cera para peinar', '¿Me llegó la factura?', 'Quiero poner un reclamo'];
  return (
    <>
      <Cabecera titulo="Simulador de WhatsApp" sub="Escribe como un cliente: el mensaje entra por el mismo webhook firmado que usa Meta" />
      <div className="contenido">
        {!s.tenant.whatsapp_phone_number_id && <div className="bloqueado"><Icon n="candado" className="" size={16} />Vincula primero un número en Configuración › WhatsApp y cobros (en el piloto: sim-{s.tenant.slug}).</div>}
        <div className="aviso peq-txt"><Icon n="info" className="" size={16} />Herramienta de piloto: los mensajes que escribas aquí entran como si fueran de un cliente real y quedan en Conversaciones y Auditoría.</div>
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <section className="tarjeta telefono" aria-label="Vista del cliente en WhatsApp (simulada)">
            <div className="fila" style={{ padding: '12px 14px', gap: 10, borderBottom: '1px solid var(--borde)' }}><span className="marca-negocio" style={{ borderRadius: '50%' }}>{s.tenant.logo_data_url ? <img src={s.tenant.logo_data_url} alt="" /> : s.tenant.tema?.monograma}</span><span style={{ minWidth: 0 }}><b className="cortar" style={{ display: 'block' }}>{s.tenant.nombre}</b><span className="tenue cortar" style={{ fontSize: 12, display: 'block' }}>WhatsApp Business · {s.tenant.whatsapp_phone_number_id ?? 'sin número'}</span></span></div>
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
                <span className="tenue">Cambia el teléfono para empezar como un cliente nuevo (verás el aviso de privacidad).</span>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Guion sugerido">
              <div className="fila envolver" style={{ gap: 6 }}>{sugerencias.map((t, i) => <button key={i} type="button" className="chip" onClick={() => enviar(undefined, t)} disabled={ocupado}>{t}</button>)}</div>
              <p className="tenue peq-txt" style={{ marginTop: 12 }}>Abre Conversaciones en otra pestaña para ver los recibos de cada acción y tomar el caso cuando se escale.</p>
            </Tarjeta>
          </div>
        </div>
      </div>
    </>
  );
}
