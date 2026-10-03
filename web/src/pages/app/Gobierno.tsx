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
  if (error) return <><Cabecera titulo="Centro de IA" /><div className="contenido"><ErrorCarga error={error} /></div></>;
  if (!data) return <Cargando filas={8} />;
  const m = data.metricas;
  const toggle = async (t: any, v: boolean) => { await run(() => api.patch(`/api/t/ia/herramientas/${t.nombre}`, { habilitada: v }), `${t.nombre} ${v ? 'habilitada' : 'deshabilitada'}`); recargar(); };
  return (
    <>
      <Cabecera titulo="Centro de IA" sub="Qué puede y qué no puede hacer la IA sobre los datos de tu negocio" />
      <div className="contenido">
        <div className="grid g4">
          <Cifra etiqueta="Acciones ejecutadas (30 días)" valor={m.ejecutadas} detalle={`${m.pendientes} esperando confirmación`} />
          <Cifra etiqueta="Acciones bloqueadas" valor={m.denegadas} detalle="por el Gateway, con motivo" />
          <Cifra etiqueta="Rechazadas por el cliente" valor={m.rechazadas} detalle="respondió NO a la confirmación" />
          <div className="tarjeta pad col"><Medidor c={data.consumo.tokens_ia} etiqueta="Consumo de IA" /></div>
        </div>
          <Tarjeta titulo="Registro de herramientas" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla">
              <thead><tr><th>Herramienta</th><th>Riesgo</th><th>Permiso</th><th>Agentes</th><th className="num">30 días</th><th>Activa</th></tr></thead>
              <tbody>{data.herramientas.map((t: any) => (
                <tr key={t.nombre}>
                  <td style={{ maxWidth: 460 }}><span className="mono">{t.nombre}</span><div className="tenue" style={{ fontSize: 13, marginTop: 2 }}>{t.descripcion}{t.limite && ` · máx. ${t.limite} por conversación`}</div></td>
                  <td><Estado v={t.riesgo_efectivo} />{t.riesgo_efectivo !== t.riesgo_declarado && <div className="tenue" style={{ fontSize: 12 }}>endurecido por la plantilla</div>}</td>
                  <td className="mono">{t.permiso}</td>
                  <td>{t.prohibida_a_agentes ? <span className="estado err"><Icon n="candado" className="" />Solo personas</span> : t.agentes.length ? t.agentes.join(', ') : <span className="tenue">—</span>}</td>
                  <td className="num"><span className="estado ok">{t.uso.ejecutadas}</span> {t.uso.denegadas > 0 && <span className="estado err">{t.uso.denegadas}</span>}</td>
                  <td>{t.prohibida_a_agentes ? <span className="tenue">—</span> : <Interruptor on={t.habilitada} disabled={!puede('ai:configure')} etiqueta={`Activar ${t.nombre}`} onChange={(v) => (v ? toggle(t, v) : setApagar(t))} />}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Tarjeta>
        <div className="grid g-main" style={{ alignItems: 'start' }}>
            <Tarjeta titulo="Ejecuciones recientes" acciones={<select className="input" style={{ padding: '2px 6px', width: 'auto' }} value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Filtrar"><option value="">Todas</option><option value="DENEGADA">Denegadas</option><option value="CONFIRMADA">Confirmadas</option><option value="PENDIENTE_CONFIRMACION">Pendientes</option><option value="PERMITIDA">Permitidas</option></select>}>
              {!ejec.data ? <Cargando /> : ejec.data.length === 0 ? <Vacio titulo="Sin ejecuciones" /> : (
                <div className="col" style={{ maxHeight: 560, overflowY: 'auto' }}>{ejec.data.slice(0, 60).map((e) => <div key={e.id} className="col" style={{ gap: 2 }}><span className="tenue" style={{ fontSize: 12.5 }}>{e.configuracion} · {e.cliente ?? 'panel'}</span><Recibo e={e} /></div>)}</div>
              )}
            </Tarjeta>
            <Tarjeta titulo="¿Dónde se detuvieron los bloqueos?">
              {data.por_comprobacion.length === 0 ? <Vacio titulo="Sin bloqueos">Ninguna llamada ha sido denegada.</Vacio> : <div className="col">{data.por_comprobacion.map((c: any, i: number) => <div key={i} className="fila entre" style={{ padding: '8px 0', borderTop: i ? '1px solid var(--linea)' : 0 }}><span>Comprobación {c.c}<br /><span className="mono tenue">{c.motivo}</span></span><span className="cifra" style={{ fontSize: 24 }}>{c.n}</span></div>)}</div>}
              <p className="tenue" style={{ marginTop: 12, fontSize: 13 }}>1 registro · 2 esquema · 3 permiso · 4 contexto y política.</p>
            </Tarjeta>
        </div>
        <Tarjeta titulo="Agentes (una runtime, tres configuraciones)">
          <div className="grid g3">{data.agentes.map((a: any) => (
            <div key={a.id} className="contenedor pad col">
              <div className="fila entre"><b className="titulo-tarjeta">{{ atencion: 'Atención (WhatsApp)', asistente: 'Asistente del panel', copiloto: 'Copiloto del asesor' }[a.configuracion as string]}</b>
                <Interruptor on={a.activo} disabled={!puede('ai:configure')} etiqueta={`Activar agente ${a.configuracion}`} onChange={(v) => run(() => api.patch(`/api/t/ia/agentes/${a.configuracion}`, { activo: v }), v ? 'Agente activado' : 'Agente desactivado').then(recargar)} /></div>
              <span className="tenue">Rol <span className="mono">{a.rol}</span> · {a.herramientas.length} herramientas</span>
              <div className="fila envolver">{a.permisos.map((p: string) => <span key={p} className="chip mono">{p}</span>)}</div>
              <p className="sec" style={{ fontSize: 13 }}>{a.prompt_base}</p>
            </div>
          ))}</div>
        </Tarjeta>
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
  if (error) return <><Cabecera titulo="Configuración" /><div className="contenido"><ErrorCarga error={error} /></div></>;
  if (!data || !empresa) return <Cargando filas={8} />;
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
        <div className="tabs">{[['personas', 'Personas y roles'], ['modulos', 'Módulos'], ['empresa', 'Empresa e identidad'], ['canal', 'WhatsApp y cobros']].map(([k, v]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{v}</button>)}</div>

        {tab === 'personas' && <>
          <Tarjeta titulo="Personas con acceso" acciones={<button className="btn primario peq" onClick={() => setInvitar(true)}>Invitar</button>} sinCuerpo>
            <table className="tabla"><thead><tr><th>Nombre</th><th>Correo</th><th>Rol</th><th>Recibe casos</th><th>Acceso</th></tr></thead>
              <tbody>{data.personas.map((p: any) => (
                <tr key={p.id}>
                  <td><b>{p.nombre}</b>{p.id === s.usuario.id && <span className="tenue"> (tú)</span>}</td><td className="mono">{p.email}</td>
                  <td><select className="input" style={{ padding: '2px 6px', width: 'auto' }} value={p.rol} disabled={p.id === s.usuario.id} onChange={(e) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { rol: e.target.value }), 'Rol actualizado').then(recargar)}>{rolesPersonas.map((r: any) => <option key={r.clave} value={r.clave}>{r.nombre}</option>)}</select></td>
                  <td><Interruptor on={p.disponible} etiqueta={`Disponible ${p.nombre}`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { disponible: v })).then(recargar)} /></td>
                  <td><Interruptor on={p.activo} disabled={p.id === s.usuario.id} etiqueta={`Acceso ${p.nombre}`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/personas/${p.id}`, { activo: v }), v ? 'Acceso restituido' : 'Acceso retirado').then(recargar)} /></td>
                </tr>
              ))}</tbody></table>
          </Tarjeta>
          <Tarjeta titulo="Qué puede hacer cada rol" sinCuerpo>
            <div className="tabla-wrap"><table className="tabla">
              <thead><tr><th>Permiso</th>{data.roles.map((r: any) => <th key={r.clave} style={{ textAlign: 'center' }}>{r.nombre}{r.es_agente && <><br /><span style={{ textTransform: 'none', letterSpacing: 0 }}>IA</span></>}</th>)}</tr></thead>
              <tbody>{permisos.map((p) => (
                <tr key={p}><td><span className="mono">{p}</span><br /><span className="tenue">{data.catalogo_permisos[p]}</span></td>
                  {data.roles.map((r: any) => <td key={r.clave} style={{ textAlign: 'center' }}>{r.permisos.includes(p) ? <span className="estado ok" aria-label="sí"><Icon n="ok" className="" /></span> : <span className="tenue" aria-label="no">·</span>}</td>)}</tr>
              ))}</tbody>
            </table></div>
          </Tarjeta>
        </>}

        {tab === 'modulos' && (
          <Tarjeta titulo="Módulos" sinCuerpo>
            <table className="tabla"><tbody>{data.modulos.map((m: any) => (
              <tr key={m.modulo}><td><b>{m.nombre}</b><br /><span className="tenue">{m.descripcion}</span></td><td>{m.incluido_en_plan ? <span className="tenue">Incluido en tu plan</span> : <Estado v="PENDIENTE" texto="Requiere otro plan" />}</td>
                <td><Interruptor on={m.activo} disabled={!m.incluido_en_plan && !m.activo} etiqueta={`Módulo ${m.nombre}`} onChange={(v) => run(() => api.patch(`/api/t/configuracion/modulos/${m.modulo}`, { activo: v }), `Módulo ${v ? 'activado' : 'desactivado'}`).then(() => { recargar(); recargarSesion(); })} /></td></tr>
            ))}</tbody></table>
          </Tarjeta>
        )}

        {tab === 'empresa' && (
          <div className="grid g2">
            <Tarjeta titulo="Datos de la empresa">
              <div className="col">
                {[['nombre', 'Nombre'], ['nit', 'NIT con dígito de verificación'], ['ciudad', 'Ciudad'], ['email_contacto', 'Correo de avisos'], ['telefono', 'Teléfono']].map(([k, l]) => (
                  <Campo key={k} etiqueta={l}><input className="input" value={empresa[k] ?? ''} onChange={(e) => setEmpresa({ ...empresa, [k]: e.target.value })} /></Campo>
                ))}
                <button className="btn primario" style={{ alignSelf: 'flex-start' }} disabled={ocupado} onClick={() => run(() => api.patch('/api/t/configuracion/empresa', { nombre: empresa.nombre, nit: empresa.nit || null, ciudad: empresa.ciudad || null, email_contacto: empresa.email_contacto, telefono: empresa.telefono || null }), 'Datos guardados').then(() => { recargar(); recargarSesion(); })}>Guardar</button>
              </div>
            </Tarjeta>
            <Tarjeta titulo="Identidad visual">
              <div className="col" style={{ gap: 12 }}>
                <div className="fila" style={{ gap: 12 }}>
                  <div style={{ width: 64, height: 64, borderRadius: 16, background: tema.acento, color: '#fff', display: 'grid', placeItems: 'center', fontWeight: 500, fontSize: 20, overflow: 'hidden' }}>{data.tenant.logo_data_url ? <img src={data.tenant.logo_data_url} alt="Logotipo" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : tema.monograma}</div>
                  <div className="col" style={{ gap: 2 }}><span className="mono">{tema.acento}</span><span className="tenue">Contraste del botón {tema.contraste.acento_blanco}:1 · del texto sobre oscuro {tema.contraste.oscuro_superficie ?? tema.contraste.oscuro_rail}:1</span>{tema.ajustado && <span className="tenue">Luminosidad ajustada automáticamente para ser legible.</span>}</div>
                </div>
                <div className="fila" style={{ gap: 6 }}>{[['Acción', tema.acento], ['Texto', tema.acento_sobre_oscuro], ['Tarjeta', '#1e1e2a'], ['Lienzo', '#171721']].map(([n, c]) => <span key={n} className="col" style={{ alignItems: 'center', gap: 2 }}><span style={{ width: 36, height: 36, borderRadius: 8, background: c, border: '1px solid var(--linea-2)' }} /><span className="tenue" style={{ fontSize: 12 }}>{n}</span></span>)}</div>
                <label className="btn" style={{ alignSelf: 'flex-start' }}><Icon n="subir" className="" size={14} /> Cambiar logotipo<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden onChange={(e) => e.target.files?.[0] && subirLogo(e.target.files[0])} /></label>
                <span className="tenue">La marca de la plataforma solo aparece en las páginas públicas; dentro del panel, tu equipo ve tu negocio.</span>
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
                {data.pasarela ? <span><Estado v="EXITO" texto="Cuenta vinculada" /> <span className="mono">{data.pasarela.cuenta_id}</span> · {fecha(data.pasarela.vinculado_en)}</span> : <span className="tenue">Sin cuenta vinculada.</span>}
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
  if (!data) return <Cargando filas={8} />;
  const s = data.suscripcion;
  const ciclo = ['ACTIVA', 'PAGO_PENDIENTE', 'EN_GRACIA', 'SUSPENDIDA', 'CANCELADA'];
  const efecto: Record<string, string> = { ACTIVA: 'Acceso completo según el plan', PAGO_PENDIENTE: 'Acceso completo; te avisamos', EN_GRACIA: 'Acceso completo; avisos crecientes', SUSPENDIDA: 'Solo lectura y exportación; el canal deja de atender', CANCELADA: 'Acceso cerrado; inicia el plazo de retención' };
  return (
    <>
      <Cabecera titulo="Suscripción" sub="Funciones y consumo de tu negocio">
        <span className="chip">Configuración a medida</span>
      </Cabecera>
      <div className="contenido">
        <Tarjeta titulo="Estado" nivel={['SUSPENDIDA', 'EN_GRACIA'].includes(s.estado) ? 3 : 2}>
          <div className="fila" style={{ gap: 0, alignItems: 'stretch' }}>
            {ciclo.map((c) => (
              <div key={c} className="col" style={{ flex: 1, padding: 10, borderRadius: 8, gap: 4, background: c === s.estado ? 'var(--acento-tinte)' : 'transparent', border: c === s.estado ? '1px solid var(--acento)' : '1px solid transparent' }}>
                <Estado v={c} /><span className="tenue" style={{ fontSize: 12.5 }}>{efecto[c]}</span>
              </div>
            ))}
          </div>
          <p className="sec" style={{ marginTop: 10 }}>Periodo actual: {fecha(s.periodo_inicio)} – {fecha(s.periodo_fin)}. Suspender no borra tus datos: conservas lectura y exportación.</p>
        </Tarjeta>
        <div className="grid g3">
          <div className="tarjeta pad"><Medidor c={data.consumo.tokens_ia} etiqueta="IA (tokens)" /></div>
          <div className="tarjeta pad"><Medidor c={data.consumo.mensajes} etiqueta="Mensajes" /></div>
          <div className="tarjeta pad"><Medidor c={data.consumo.documentos} etiqueta="Documentos fiscales" /></div>
        </div>
        <Tarjeta titulo="Tu plan">
          <div className="grid g4">
            <Cifra etiqueta="Personas" valor={`${data.usuarios}/${s.max_usuarios}`} />
            <Cifra etiqueta="Tokens de IA / mes" valor={num(s.cuota_tokens_ia)} />
            <Cifra etiqueta="Mensajes / mes" valor={num(s.cuota_mensajes)} />
            <Cifra etiqueta="Documentos / mes" valor={num(s.cuota_documentos)} />
          </div>
          <p className="sec" style={{ marginTop: 10 }}>{s.politica_excedente === 'LIMITAR' ? 'Al llegar al tope de IA, el agente pasa las conversaciones a tu equipo en lugar de generar cobros adicionales.' : `Excedente de IA facturado a ${cop(s.precio_excedente_1k_tokens)} por cada 1.000 tokens.`} Los mensajes dentro de la ventana de 24 horas no tienen costo de canal.</p>
        </Tarjeta>
        {data.historico.length > 0 && (
          <Tarjeta titulo="Histórico de consumo" sinCuerpo>
            <table className="tabla"><thead><tr><th>Periodo</th><th>Métrica</th><th className="num">Cantidad</th></tr></thead><tbody>{data.historico.map((h: any, i: number) => <tr key={i}><td className="mono">{h.periodo}</td><td>{h.metrica}</td><td className="num">{num(h.cantidad)}</td></tr>)}</tbody></table>
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
      <Cabecera titulo="Auditoría" sub="Registro de solo inserción: no se puede editar ni borrar">
        <button className="btn" onClick={exportar}>Exportar CSV</button>
      </Cabecera>
      <div className="contenido">
        <div className="fila envolver">
          <div className="tabs" style={{ border: 0 }}>{[['', 'Todo'], ['ia', 'IA'], ['seguridad', 'Seguridad'], ['fiscal', 'Fiscal'], ['configuracion', 'Configuración']].map(([k, v]) => <button key={k} className={tipo === k ? 'on' : ''} onClick={() => setTipo(k)}>{v}</button>)}</div>
          <select className="input" style={{ width: 'auto' }} value={resultado} onChange={(e) => setResultado(e.target.value)} aria-label="Resultado"><option value="">Cualquier resultado</option>{['EXITO', 'PERMITIDO', 'DENEGADO', 'NO_ENCONTRADO', 'ERROR'].map((r) => <option key={r}>{r}</option>)}</select>
          <input className="input" style={{ width: 260 }} placeholder="Buscar acción, actor o recurso" value={q} onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}); }} />
        </div>
        {error && <ErrorCarga error={error} />}
        <section className="tarjeta">
          {!data ? <Cargando /> : data.length === 0 ? <Vacio titulo="Sin eventos para este filtro" /> : (
            <div className="tabla-wrap" style={{ maxHeight: 'calc(100vh - 230px)' }}><table className="tabla">
              <thead><tr><th>Momento</th><th>Actor</th><th>Acción</th><th>Recurso</th><th>Resultado</th><th>Origen</th><th>Evento</th></tr></thead>
              <tbody>{data.map((e) => (
                <tr key={e.id} className="clic" onClick={() => setSel(e)}>
                  <td className="mono">{fecha(e.creado_en)} {hora(e.creado_en)}</td>
                  <td><Estado v={e.actor_tipo === 'AGENTE' ? 'AGENTE' : e.actor_tipo === 'USUARIO' ? 'PANEL' : undefined} texto={e.actor_tipo.toLowerCase()} /> {e.actor_nombre}</td>
                  <td className="mono">{e.accion}</td>
                  <td className="mono tenue">{e.recurso ? `${e.recurso}${e.recurso_id ? ' · ' + String(e.recurso_id).slice(-8) : ''}` : '—'}</td>
                  <td><Estado v={e.resultado} /></td><td>{e.origen}</td><td className="mono tenue">{String(e.id).slice(-8)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
        <p className="tenue"><Icon n="candado" className="" size={12} /> Los intentos de acceso a datos de otra empresa se registran aquí y se responden al solicitante con «no encontramos eso», sin confirmar que el recurso existe.</p>
      </div>
      {sel && (
        <Modal titulo={sel.accion} onCerrar={() => setSel(null)}>
          <div className="col" style={{ gap: 6 }}>
            <span><b>Momento:</b> {fechaHora(sel.creado_en)}</span>
            <span><b>Actor:</b> {sel.actor_tipo} · {sel.actor_nombre}</span>
            <span><b>Resultado:</b> <Estado v={sel.resultado} /></span>
            <span><b>Correlación:</b> <span className="mono">{sel.correlacion}</span></span>
            <span><b>Evento:</b> <span className="mono">{sel.id}</span></span>
            {sel.recurso === 'ai_execution' && sel.detalle?.decision && <Recibo e={{ id: sel.recurso_id, herramienta: sel.accion.replace('ia.herramienta.', ''), decision: sel.detalle.decision, nivel_riesgo: sel.detalle.riesgo, permiso_requerido: sel.detalle.permiso, motivo_denegacion: sel.detalle.motivo, comprobacion_fallida: sel.detalle.comprobacion, creado_en: sel.creado_en }} />}
            <pre className="mono" style={{ background: 'var(--obsidiana)', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(sel.detalle, null, 2)}</pre>
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
        {!s.tenant.whatsapp_phone_number_id && <div className="bloqueado">Vincula primero un número en Configuración › WhatsApp y cobros (en el piloto: sim-{s.tenant.slug}).</div>}
        <div className="grid g-main" style={{ alignItems: 'start' }}>
          <section className="tarjeta" style={{ maxWidth: 440, width: '100%', justifySelf: 'center', borderRadius: 28, padding: 10, background: 'var(--obsidiana)' }}>
            <div className="fila" style={{ padding: '14px 16px', gap: 12 }}><span className="marca-negocio" style={{ borderRadius: '50%' }}>{s.tenant.logo_data_url ? <img src={s.tenant.logo_data_url} alt="" /> : s.tenant.tema?.monograma}</span><span><b>{s.tenant.nombre}</b><br /><span className="tenue" style={{ fontSize: 12.5 }}>WhatsApp Business · {s.tenant.whatsapp_phone_number_id}</span></span></div>
            <div className="cuerpo hilo" style={{ height: 480, overflowY: 'auto', background: 'var(--onyx)', borderRadius: 20, padding: 16 }}>
              {(data?.mensajes ?? []).map((m: any) => (
                <div key={m.id} className="burbuja" style={{ alignSelf: m.remitente === 'CUSTOMER' ? 'flex-end' : 'flex-start', background: m.remitente === 'CUSTOMER' ? 'var(--acento)' : 'var(--grafito)', color: m.remitente === 'CUSTOMER' ? 'var(--sobre-acento)' : 'var(--texto)', maxWidth: '85%', borderBottomRightRadius: m.remitente === 'CUSTOMER' ? 6 : 18, borderBottomLeftRadius: m.remitente === 'CUSTOMER' ? 18 : 6 }}>
                  {m.contenido}<div className="hora">{hora(m.creado_en)}</div>
                </div>
              ))}
              {!data?.mensajes?.length && <Vacio titulo="Escribe el primer mensaje" />}
              <div ref={fin} />
            </div>
            <form className="fila" style={{ padding: '12px 6px 6px' }} onSubmit={enviar}><input className="input" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Mensaje" aria-label="Mensaje del cliente" /><button className="btn primario" disabled={ocupado}><Icon n="enviar" className="" size={14} /></button></form>
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
              <div className="fila envolver">{sugerencias.map((t, i) => <button key={i} className="chip" onClick={() => enviar(undefined, t)} disabled={ocupado}>{t}</button>)}</div>
              <p className="tenue" style={{ marginTop: 10 }}>Abre Conversaciones en otra pestaña para ver los recibos de cada acción y tomar el caso cuando se escale.</p>
            </Tarjeta>
          </div>
        </div>
      </div>
    </>
  );
}
