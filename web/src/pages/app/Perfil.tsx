import { useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, descargar, fechaCompleta, fechaHora, hace, irAEmpresa, urlPrincipal } from '../../api';
import { Cabecera, CambiarContrasena, VerificarCorreo, useSesion } from '../../components/Layout';
import { Campo, Cargando, CodigoOtp, ErrorCarga, Interruptor, Modal, Tarjeta, useAccion, useApi, useToast } from '../../components/ui';
import { Icon } from '../../components/icons';
import { Avatar, dispositivoDe, prepararFoto } from '../../components/Perfil';
import { useSonido } from '../../lib/sonido';
import { useVoz, vozDisponible } from '../../lib/voz';

interface Sesion { id: string; agente: string | null; creado_en: string; ultimo_uso: string; segundo_factor: boolean; actual: boolean }
interface Empresa { slug: string; nombre: string; tema?: { acento?: string; monograma?: string }; rol: string; propietario: boolean; nombre_visible: string | null; disponible: boolean; desde: string }
interface Perfil {
  nombre: string; email: string; telefono: string | null; foto: string | null;
  correo_verificado: boolean; correo_pendiente: string | null; tiene_contrasena: boolean; contrasena_cambiada_en: string | null;
  creado_en: string; actualizado_en: string | null; segundo_factor: boolean;
  sesiones: Sesion[]; actividad: { accion: string; resultado: string; creado_en: string }[]; empresas: Empresa[];
}

const ACTIVIDAD: Record<string, string> = {
  'perfil.actualizado': 'Actualizaste tus datos personales', 'perfil.correo_solicitado': 'Pediste cambiar tu correo', 'perfil.correo_cambiado': 'Cambiaste el correo de tu cuenta',
  'usuario.correo_verificado': 'Confirmaste tu correo', 'sesion.contrasena_cambiada': 'Cambiaste tu contraseña', 'sesion.contrasena_restablecida': 'Restableciste tu contraseña',
  'sesion.recuperacion_solicitada': 'Se pidió recuperar tu contraseña', 'sesion.bloqueada': 'Bloqueamos intentos fallidos de entrar', 'sesion.segundo_factor_completado': 'Entraste con código de verificación',
  'sesion.segundo_factor_fallido': 'Código de verificación incorrecto', 'sesion.cerrada': 'Cerraste una sesión en otro dispositivo', 'sesion.cerradas_otras': 'Cerraste las sesiones de otros dispositivos',
};
const ALERTA = new Set(['sesion.bloqueada', 'sesion.segundo_factor_fallido', 'sesion.recuperacion_solicitada']);

/**
 * Mi perfil: todo lo de la persona en un solo lugar. Lo que no se puede cambiar aquí (el rol, la empresa)
 * se muestra con candado y quién lo cambia; el correo cambia con la contraseña y un código.
 */
export function Perfil() {
  const { s, puede, recargar: recargarSesion } = useSesion();
  const p = useApi<Perfil>(() => api.get('/api/auth/perfil'), []);
  const [contrasena, setContrasena] = useState(false);
  const [verificar, setVerificar] = useState(false);
  const [cambiarCorreo, setCambiarCorreo] = useState(false);
  const recargar = () => { p.recargar(); recargarSesion(); };

  if (p.error) return <><Cabecera titulo="Mi perfil" /><ErrorCarga error={p.error} reintentar={p.recargar} /></>;
  if (!p.data) return <><Cabecera titulo="Mi perfil" /><Cargando filas={6} /></>;
  const d = p.data;
  const pasos: [string, boolean][] = [
    ['Foto de perfil', !!d.foto], ['Teléfono', !!d.telefono], ['Correo confirmado', d.correo_verificado], ['Contraseña propia', d.tiene_contrasena],
  ];
  const hechos = pasos.filter(([, ok]) => ok).length;
  const empresa = d.empresas.find((e) => e.slug === s.tenant.slug);

  return (
    <>
      <Cabecera titulo="Mi perfil" sub="Tus datos, tu acceso y tus preferencias. Lo que cambies aquí vale en todas tus empresas." />
      <div className="perfil-pagina">
        <aside className="perfil-resumen">
          <Tarjeta>
            <div className="perfil-resumen-cab">
              <FotoPerfil nombre={d.nombre} foto={d.foto} onCambio={recargar} />
              <b className="perfil-resumen-nombre">{d.nombre}</b>
              <span className="perfil-resumen-correo">{d.email}</span>
              <span className={`perfil-rol ${s.usuario.propietario ? 'dueno' : ''}`}>{s.usuario.propietario && <Icon n="corona" className="" size={12} />}{s.usuario.rol_nombre} · {s.tenant.nombre}</span>
            </div>
            <div className="perfil-avance" role="group" aria-label="Qué tan completo está tu perfil">
              <div className="perfil-avance-cab"><span>Tu perfil</span><b>{Math.round((hechos / pasos.length) * 100)}%</b></div>
              <div className="perfil-barra"><i style={{ width: `${(hechos / pasos.length) * 100}%` }} /></div>
              <ul>{pasos.map(([t, ok]) => <li key={t} className={ok ? 'ok' : ''}><Icon n={ok ? 'ok' : 'mas'} className="" size={13} />{t}</li>)}</ul>
            </div>
            <dl className="perfil-datos">
              <div><dt>En la plataforma desde</dt><dd>{fechaCompleta(d.creado_en)}</dd></div>
              {d.actualizado_en && <div><dt>Última actualización</dt><dd>{hace(d.actualizado_en)}</dd></div>}
              <div><dt>Empresas</dt><dd>{d.empresas.length}</dd></div>
            </dl>
          </Tarjeta>
          <nav className="perfil-indice" aria-label="Secciones del perfil">
            {[['datos', 'Datos personales'], ['empresa', `En ${s.tenant.nombre}`], ['acceso', 'Correo y acceso'], ['sesiones', 'Sesiones'], ['preferencias', 'Preferencias'], ['empresas', 'Tus empresas'], ['actividad', 'Actividad'], ['privacidad', 'Tus datos']]
              .map(([id, t]) => <a key={id} href={`#perfil-${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`perfil-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{t}</a>)}
          </nav>
        </aside>

        <div className="perfil-secciones">
          <DatosPersonales d={d} onGuardado={recargar} />
          {empresa && <EnEmpresa e={empresa} general={d.nombre} empresaNombre={s.tenant.nombre} atiende={puede('case:manage')} onGuardado={recargar} />}

          <Seccion id="acceso" titulo="Correo y acceso" icono="candado">
            <Fila titulo="Correo de acceso" detalle={<>{d.email} {d.correo_verificado ? <span className="perfil-ok"><Icon n="ok" className="" size={11} />Confirmado</span> : <span className="perfil-pend">Sin confirmar</span>}</>}>
              {!d.correo_verificado && <button className="btn peq primario" onClick={() => setVerificar(true)}>Confirmar</button>}
              <button className="btn peq" onClick={() => setCambiarCorreo(true)} disabled={!d.tiene_contrasena}>Cambiar correo</button>
            </Fila>
            {d.correo_pendiente && <CorreoPendiente correo={d.correo_pendiente} onHecho={recargar} />}
            <Fila titulo="Contraseña" detalle={!d.tiene_contrasena ? 'Aún no tienes contraseña propia' : d.contrasena_cambiada_en ? `Cambiada ${hace(d.contrasena_cambiada_en)}` : 'Es la que creaste al entrar por primera vez'}>
              <button className="btn peq" onClick={() => setContrasena(true)} disabled={!d.tiene_contrasena}><Icon n="candado" className="" size={14} />Cambiar contraseña</button>
            </Fila>
            <Fila titulo="Verificación en dos pasos" detalle={d.segundo_factor ? 'Esta sesión entró con un código enviado a tu correo.' : 'Se pide un código por correo a quienes administran la plataforma. Para tu cuenta, tu correo confirmado protege la recuperación.'} />
          </Seccion>

          <Sesiones sesiones={d.sesiones} onCambio={p.recargar} />
          <Preferencias />

          <Seccion id="empresas" titulo="Tus empresas" icono="plataforma" acciones={<a className="btn peq" href={urlPrincipal('/empezar')}><Icon n="mas" className="" size={14} />Crear otra</a>}>
            <div className="perfil-empresas">
              {d.empresas.map((e) => {
                const aqui = e.slug === s.tenant.slug;
                return (
                  <button key={e.slug} type="button" className={`perfil-empresa ${aqui ? 'actual' : ''}`} disabled={aqui}
                    style={{ '--acento-op': e.tema?.acento ?? 'var(--tinta-3)' } as any} onClick={() => irAEmpresa(e.slug)}>
                    <span className="empresa-mono" aria-hidden="true">{e.tema?.monograma ?? e.nombre.slice(0, 2)}</span>
                    <span className="empresa-txt"><b>{e.nombre}</b><small>{e.propietario ? <><Icon n="corona" className="" size={11} />Propietario</> : e.rol} · desde {fechaCompleta(e.desde)}</small></span>
                    {aqui ? <span className="perfil-aqui">Estás aquí</span> : <span className="perfil-ir">Abrir<Icon n="derecha" className="" size={13} /></span>}
                  </button>
                );
              })}
            </div>
            {d.empresas.length === 1 && <p className="tenue peq-txt">Si creas otra empresa o te invitan a una, aparecerá aquí y podrás cambiar entre ellas desde el menú de arriba.</p>}
          </Seccion>

          <Seccion id="actividad" titulo="Actividad de tu cuenta" icono="reloj">
            {!d.actividad.length ? <p className="tenue">Todavía no hay movimientos de seguridad en tu cuenta.</p> : (
              <ol className="perfil-actividad">
                {d.actividad.map((a, i) => (
                  <li key={i} className={ALERTA.has(a.accion) || a.resultado !== 'EXITO' ? 'alerta' : ''}>
                    <span className="punto" aria-hidden="true" /><span>{ACTIVIDAD[a.accion] ?? a.accion}</span><time dateTime={a.creado_en} title={fechaHora(a.creado_en)}>{hace(a.creado_en)}</time>
                  </li>
                ))}
              </ol>
            )}
            <p className="tenue peq-txt">¿Ves algo que no hiciste? Cambia tu contraseña y cierra las demás sesiones.</p>
          </Seccion>

          <Privacidad />
        </div>
      </div>
      {contrasena && <CambiarContrasena onCerrar={() => { setContrasena(false); p.recargar(); }} />}
      {verificar && <VerificarCorreo email={d.email} onCerrar={() => setVerificar(false)} onVerificado={() => { setVerificar(false); recargar(); }} />}
      {cambiarCorreo && <CambiarCorreo actual={d.email} onCerrar={() => setCambiarCorreo(false)} onHecho={() => { setCambiarCorreo(false); recargar(); }} />}
    </>
  );
}

function Seccion({ id, titulo, icono, acciones, children }: { id: string; titulo: string; icono: string; acciones?: ReactNode; children: ReactNode }) {
  return (
    <section id={`perfil-${id}`} className="tarjeta perfil-seccion-p" aria-labelledby={`perfil-${id}-t`}>
      <div className="cab"><h2 className="titulo-tarjeta" id={`perfil-${id}-t`}><span className="perfil-ico" aria-hidden="true"><Icon n={icono} className="" size={15} /></span>{titulo}</h2>{acciones && <div className="fila" style={{ marginLeft: 'auto' }}>{acciones}</div>}</div>
      <div className="cuerpo">{children}</div>
    </section>
  );
}

function Fila({ titulo, detalle, children }: { titulo: string; detalle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="perfil-fila">
      <span><b>{titulo}</b>{detalle && <small>{detalle}</small>}</span>
      {children && <span className="perfil-fila-acc">{children}</span>}
    </div>
  );
}

/** Dato que no se edita aquí: se explica quién lo cambia. */
function Fijo({ etiqueta, valor, quien }: { etiqueta: string; valor: ReactNode; quien: string }) {
  return (
    <div className="perfil-fijo">
      <span className="perfil-fijo-et">{etiqueta}</span>
      <span className="perfil-fijo-val"><Icon n="candado" className="" size={13} />{valor}</span>
      <small>{quien}</small>
    </div>
  );
}

function FotoPerfil({ nombre, foto, onCambio }: { nombre: string; foto: string | null; onCambio: () => void }) {
  const archivo = useRef<HTMLInputElement>(null);
  const { run, ocupado } = useAccion();
  const toast = useToast();
  const subir = async (f: File | undefined) => {
    if (!f) return;
    try {
      const dato = await prepararFoto(f);
      if (await run(() => api.patch('/api/auth/perfil', { foto: dato }), 'Foto actualizada.')) onCambio();
    } catch (e) { toast((e as Error).message, true); }
    if (archivo.current) archivo.current.value = '';
  };
  return (
    <div className="perfil-foto">
      <Avatar nombre={nombre} foto={foto} className="perfil-avatar grande" />
      <button type="button" className="perfil-foto-btn" onClick={() => archivo.current?.click()} disabled={ocupado} aria-label={foto ? 'Cambiar tu foto' : 'Subir una foto'}>
        <Icon n="subir" className="" size={14} />
      </button>
      <input ref={archivo} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => subir(e.target.files?.[0])} />
      {foto && <button type="button" className="btn sutil peq perfil-foto-quitar" disabled={ocupado} onClick={async () => { if (await run(() => api.patch('/api/auth/perfil', { foto: null }), 'Quitamos tu foto.')) onCambio(); }}>Quitar foto</button>}
    </div>
  );
}

function DatosPersonales({ d, onGuardado }: { d: Perfil; onGuardado: () => void }) {
  const [nombre, setNombre] = useState(d.nombre);
  const [telefono, setTelefono] = useState(d.telefono ?? '');
  const { run, ocupado } = useAccion();
  const limpio = (v: string) => v.replace(/\s+/g, ' ').trim();
  const cambios: Record<string, string> = {};
  if (limpio(nombre) !== d.nombre) cambios.nombre = nombre;
  if (telefono.replace(/[\s().-]/g, '') !== (d.telefono ?? '')) cambios.telefono = telefono;
  const hay = Object.keys(cambios).length > 0;
  const guardar = async () => { if (await run(() => api.patch('/api/auth/perfil', cambios), 'Guardamos tus datos.')) onGuardado(); };
  return (
    <Seccion id="datos" titulo="Datos personales" icono="persona">
      <div className="perfil-form">
        <Campo etiqueta="Nombre completo" ayuda="Así apareces en tus empresas, salvo que definas otro nombre en una de ellas.">
          <input className="input" value={nombre} maxLength={80} autoComplete="name" onChange={(e) => setNombre(e.target.value)} />
        </Campo>
        <Campo etiqueta="Teléfono" ayuda="Opcional. Con indicativo si es de otro país (+57…).">
          <input className="input" value={telefono} maxLength={22} inputMode="tel" autoComplete="tel" placeholder="+57 300 123 4567" onChange={(e) => setTelefono(e.target.value)} />
        </Campo>
        <Fijo etiqueta="Correo" valor={d.email} quien="Se cambia en «Correo y acceso», con tu contraseña y un código." />
      </div>
      <div className="perfil-pie">
        {hay && <button className="btn" disabled={ocupado} onClick={() => { setNombre(d.nombre); setTelefono(d.telefono ?? ''); }}>Descartar</button>}
        <button className="btn primario" disabled={!hay || ocupado || limpio(nombre).length < 2} onClick={guardar}>{ocupado ? 'Guardando…' : 'Guardar cambios'}</button>
      </div>
    </Seccion>
  );
}

function EnEmpresa({ e, general, empresaNombre, atiende, onGuardado }: { e: Empresa; general: string; empresaNombre: string; atiende: boolean; onGuardado: () => void }) {
  const [visible, setVisible] = useState(e.nombre_visible ?? '');
  const { run, ocupado } = useAccion();
  const cambio = visible.replace(/\s+/g, ' ').trim() !== (e.nombre_visible ?? '');
  const guardar = async (body: Record<string, unknown>, msj: string) => { if (await run(() => api.patch('/api/t/yo/perfil', body), msj)) onGuardado(); };
  return (
    <Seccion id="empresa" titulo={`En ${empresaNombre}`} icono="plataforma">
      <div className="perfil-form">
        <Campo etiqueta="Cómo te ven en esta empresa" ayuda={`Vacío: se usa tu nombre (${general}). Útil si te conocen por un apodo, p. ej. «Andrea · caja».`}>
          <input className="input" value={visible} maxLength={80} placeholder={general} onChange={(ev) => setVisible(ev.target.value)} />
        </Campo>
        <Fijo etiqueta="Rol" valor={<>{e.propietario && <Icon n="corona" className="" size={12} />}{e.propietario ? 'Propietario' : e.rol}</>}
          quien={e.propietario ? 'Eres la persona dueña: el rol se cede desde Configuración › Equipo.' : 'Lo asigna quien administra la empresa, en Configuración › Equipo.'} />
        <Fijo etiqueta="Empresa" valor={empresaNombre} quien="El nombre y los datos de la empresa se cambian en Configuración." />
      </div>
      {atiende && (
        <div className="perfil-fila">
          <span><b>Disponible para atender</b><small>Si lo apagas, no te asignamos casos nuevos de clientes.</small></span>
          <Interruptor on={e.disponible} etiqueta="Disponible para atender" disabled={ocupado}
            onChange={(v) => guardar({ disponible: v }, v ? 'Vuelves a recibir casos.' : 'Pausamos la asignación de casos.')} />
        </div>
      )}
      <div className="perfil-pie">
        {cambio && <button className="btn" disabled={ocupado} onClick={() => setVisible(e.nombre_visible ?? '')}>Descartar</button>}
        <button className="btn primario" disabled={!cambio || ocupado} onClick={() => guardar({ nombre_visible: visible.trim() || null }, 'Guardamos tu nombre en la empresa.')}>Guardar</button>
      </div>
    </Seccion>
  );
}

function CambiarCorreo({ actual, onCerrar, onHecho }: { actual: string; onCerrar: () => void; onHecho: () => void }) {
  const [f, setF] = useState({ nuevo: '', contrasena: '' });
  const { run, ocupado } = useAccion();
  const valido = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.nuevo.trim()) && f.nuevo.trim().toLowerCase() !== actual;
  const enviar = async () => { if (await run(() => api.post('/api/auth/perfil/correo', f), 'Te enviamos un código al correo nuevo.')) onHecho(); };
  return (
    <Modal titulo="Cambiar correo" onCerrar={onCerrar} pie={<>
      <button className="btn" onClick={onCerrar}>Cancelar</button>
      <button className="btn primario" disabled={!valido || !f.contrasena || ocupado} onClick={enviar}>{ocupado ? 'Enviando…' : 'Enviar código'}</button>
    </>}>
      <p className="sec">Te enviaremos un código al correo nuevo. Hasta que lo confirmes, sigues entrando con <b>{actual}</b>; después, avisaremos a ese correo del cambio.</p>
      <Campo etiqueta="Correo nuevo"><input className="input" type="email" autoComplete="email" value={f.nuevo} onChange={(e) => setF({ ...f, nuevo: e.target.value })} /></Campo>
      <Campo etiqueta="Tu contraseña actual" ayuda="Para confirmar que eres tú."><input className="input" type="password" autoComplete="current-password" value={f.contrasena} onChange={(e) => setF({ ...f, contrasena: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter' && valido && f.contrasena) enviar(); }} /></Campo>
    </Modal>
  );
}

function CorreoPendiente({ correo, onHecho }: { correo: string; onHecho: () => void }) {
  const [codigo, setCodigo] = useState('');
  const { run, ocupado } = useAccion();
  const confirmar = async () => { if (await run(() => api.post('/api/auth/perfil/correo/confirmar', { codigo }), 'Listo: ese es ahora tu correo de acceso.')) onHecho(); };
  return (
    <div className="perfil-pendiente" role="status">
      <p><Icon n="correo" className="" size={15} />Cambio en curso a <b>{correo}</b>. Escribe el código que enviamos a ese correo.</p>
      <div className="perfil-pendiente-acc">
        <CodigoOtp valor={codigo} onCambio={setCodigo} />
        <button className="btn primario" disabled={codigo.length !== 6 || ocupado} onClick={confirmar}>Confirmar</button>
        <button className="btn sutil" disabled={ocupado} onClick={async () => { if (await run(() => api.del('/api/auth/perfil/correo'), 'Cancelamos el cambio de correo.')) onHecho(); }}>Cancelar cambio</button>
      </div>
    </div>
  );
}

function Sesiones({ sesiones, onCambio }: { sesiones: Sesion[]; onCambio: () => void }) {
  const { run, ocupado } = useAccion();
  const [todas, setTodas] = useState(false);
  const otras = sesiones.filter((x) => !x.actual).length;
  const visibles = todas ? sesiones : sesiones.slice(0, 4);
  const salirTodas = async () => { await api.post('/api/auth/logout-todas').catch(() => {}); window.location.href = '/entrar'; };
  return (
    <Seccion id="sesiones" titulo={`Sesiones abiertas (${sesiones.length})`} icono="telefono"
      acciones={otras > 0 && <button className="btn peq" disabled={ocupado} onClick={async () => { if (await run(() => api.post('/api/auth/perfil/sesiones/cerrar-otras'), 'Cerramos las demás sesiones.')) onCambio(); }}>Cerrar las demás</button>}>
      <ul className="perfil-sesiones">
        {visibles.map((x) => {
          const disp = dispositivoDe(x.agente);
          return (
            <li key={x.id} className={x.actual ? 'actual' : ''}>
              <span className="perfil-disp" aria-hidden="true"><Icon n={disp.movil ? 'telefono' : 'plataforma'} className="" size={16} /></span>
              <span className="perfil-sesion-txt"><b>{disp.nombre}{x.actual && <span className="perfil-aqui">Este dispositivo</span>}</b>
                <small>Entró {hace(x.creado_en)} · activo {hace(x.ultimo_uso)}{x.segundo_factor ? ' · con código' : ''}</small></span>
              {!x.actual && <button className="btn peq sutil" disabled={ocupado} onClick={async () => { if (await run(() => api.del(`/api/auth/perfil/sesiones/${x.id}`), 'Sesión cerrada.')) onCambio(); }}>Cerrar</button>}
            </li>
          );
        })}
      </ul>
      {sesiones.length > 4 && <button type="button" className="btn sutil peq perfil-mas" onClick={() => setTodas(!todas)}>{todas ? 'Ver menos' : `Ver las ${sesiones.length} sesiones`}<Icon n={todas ? 'arriba' : 'abajo'} className="" size={14} /></button>}
      <p className="tenue peq-txt">Las sesiones se cierran solas tras unas horas sin uso. <button type="button" className="enlace" onClick={salirTodas}>Cerrar en todos los dispositivos, incluido este</button>.</p>
    </Seccion>
  );
}

function Preferencias() {
  const [sonido, setSonido] = useSonido();
  const [voz, setVoz] = useVoz();
  return (
    <Seccion id="preferencias" titulo="Preferencias de este dispositivo" icono="configuracion">
      <div className="perfil-fila">
        <span><b>Sonidos del panel</b><small>Avisos de mensajes nuevos, confirmaciones y la IA.</small></span>
        <Interruptor on={sonido} onChange={setSonido} etiqueta="Sonidos del panel" />
      </div>
      <div className="perfil-fila">
        <span><b>Voz de Omnegia IA</b><small>{vozDisponible() ? 'La IA lee en voz alta las guías y su bienvenida (necesita los sonidos activos).' : 'Este navegador no tiene voz disponible; la IA solo escribe.'}</small></span>
        <Interruptor on={voz && vozDisponible()} onChange={setVoz} disabled={!vozDisponible()} etiqueta="Voz de Omnegia IA" />
      </div>
      <p className="tenue peq-txt">Se guardan solo en este navegador. Las animaciones se reducen solas si tu sistema tiene activado «reducir movimiento».</p>
    </Seccion>
  );
}

function Privacidad() {
  const { run, ocupado } = useAccion();
  return (
    <Seccion id="privacidad" titulo="Tus datos" icono="documento">
      <div className="perfil-fila">
        <span><b>Descargar una copia</b><small>Tus datos de cuenta, empresas, sesiones y actividad reciente, en un archivo JSON.</small></span>
        <button className="btn peq" disabled={ocupado} onClick={() => run(() => descargar('/api/auth/perfil/exportar', 'mis-datos.json'), 'Descargamos tu copia.')}><Icon n="descargar" className="" size={14} />Descargar</button>
      </div>
      <div className="perfil-fila">
        <span><b>Corregir o eliminar tus datos</b><small>Para borrar tu cuenta o pedir otra corrección, lo tramitamos según la ley de protección de datos.</small></span>
        <a className="btn peq" href={urlPrincipal('/eliminacion-de-datos')}>Hacer una solicitud</a>
      </div>
      <p className="tenue peq-txt">Lee cómo cuidamos tu información en la <a href={urlPrincipal('/privacidad')}>política de privacidad</a>.</p>
    </Seccion>
  );
}
