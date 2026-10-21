import { useState } from 'react';
import { api, fechaCompleta as fecha, irAEmpresa, urlPrincipal } from '../api';
import { useApi, Modal, Campo, useAccion, Cargando } from './ui';
import { Icon } from './icons';

interface Perfil { nombre: string; email: string; correo_verificado: boolean; contrasena_cambiada_en: string | null; creado_en: string; sesiones: number }
interface Empresa { id: string; slug: string; nombre: string; rol: string; propietario: boolean; tema?: { acento?: string; monograma?: string } }

export const inicialesDe = (nombre: string) => nombre.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

/**
 * Perfil de la persona: sus datos propios (no los de la empresa), sus empresas y la seguridad de la cuenta.
 * El correo no se edita aquí porque identifica la cuenta; el nombre sí, y el servidor lo valida.
 */
export function PerfilModal({ slug, onCerrar, onContrasena, onSalirTodas, onCambio }: {
  slug: string; onCerrar: () => void; onContrasena: () => void; onSalirTodas: () => void; onCambio: () => void;
}) {
  const p = useApi<Perfil>(() => api.get('/api/auth/perfil'), []);
  const s = useApi<{ empresas: Empresa[] }>(() => api.get('/api/auth/sesion'), []);
  const [nombre, setNombre] = useState<string | null>(null);
  const { run, ocupado } = useAccion();
  const actual = nombre ?? p.data?.nombre ?? '';
  const cambiado = !!p.data && actual.trim().replace(/\s+/g, ' ') !== p.data.nombre;

  const guardar = async () => {
    const r = await run(() => api.patch('/api/auth/perfil', { nombre: actual }), 'Guardamos tu nombre.');
    if (r) { setNombre(null); p.recargar(); onCambio(); }
  };

  return (
    <Modal titulo="Mi perfil" className="perfil-modal" onCerrar={onCerrar} pie={<>
      <button className="btn" onClick={onCerrar}>Cerrar</button>
      <button className="btn primario" disabled={!cambiado || ocupado || actual.trim().length < 2} onClick={guardar}>Guardar cambios</button>
    </>}>
      {!p.data ? <Cargando filas={3} /> : <>
        <div className="perfil-cabeza">
          <span className="perfil-avatar" aria-hidden="true">{inicialesDe(actual || p.data.nombre)}</span>
          <div className="perfil-id">
            <b>{actual || p.data.nombre}</b>
            <span>{p.data.email}{p.data.correo_verificado
              ? <span className="perfil-ok"><Icon n="ok" className="" size={12} />Verificado</span>
              : <span className="perfil-pend">Sin verificar</span>}</span>
            <small>En la plataforma desde {fecha(p.data.creado_en)}</small>
          </div>
        </div>

        <Campo etiqueta="Tu nombre" ayuda="Así te ven tu equipo y tus clientes cuando atiendes.">
          <input className="input" value={actual} maxLength={80} autoComplete="name" onChange={(e) => setNombre(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && cambiado) guardar(); }} />
        </Campo>
        <Campo etiqueta="Correo" ayuda="Es con el que entras; identifica tu cuenta.">
          <input className="input" value={p.data.email} readOnly aria-readonly="true" />
        </Campo>

        <section className="perfil-seccion" aria-label="Tus empresas">
          <h3>Tus empresas</h3>
          <div className="perfil-empresas">
            {(s.data?.empresas ?? []).map((e) => {
              const esta = e.slug === slug;
              return (
                <button key={e.id} type="button" className={`perfil-empresa ${esta ? 'actual' : ''}`} disabled={esta}
                  style={{ '--acento-op': e.tema?.acento ?? 'var(--tinta-3)' } as any} onClick={() => irAEmpresa(e.slug)}>
                  <span className="empresa-mono" aria-hidden="true">{e.tema?.monograma ?? e.nombre.slice(0, 2)}</span>
                  <span className="empresa-txt"><b>{e.nombre}</b><small>{e.propietario ? <><Icon n="corona" className="" size={11} />Propietario</> : e.rol}</small></span>
                  {esta ? <span className="perfil-aqui">Estás aquí</span> : <span className="perfil-ir">Abrir<Icon n="derecha" className="" size={13} /></span>}
                </button>
              );
            })}
          </div>
          <a className="btn sutil peq" href={urlPrincipal('/empezar')}><Icon n="mas" className="" size={15} />Crear otra empresa</a>
        </section>

        <section className="perfil-seccion" aria-label="Seguridad">
          <h3>Seguridad</h3>
          <div className="perfil-fila">
            <span><b>Contraseña</b><small>{p.data.contrasena_cambiada_en ? `Cambiada el ${fecha(p.data.contrasena_cambiada_en)}` : 'Nunca la has cambiado'}</small></span>
            <button className="btn peq" onClick={() => { onCerrar(); onContrasena(); }}><Icon n="candado" className="" size={14} />Cambiar</button>
          </div>
          <div className="perfil-fila">
            <span><b>Sesiones abiertas</b><small>{p.data.sesiones === 1 ? 'Solo este dispositivo' : `${p.data.sesiones} dispositivos o navegadores`}</small></span>
            <button className="btn peq" onClick={onSalirTodas}><Icon n="salir" className="" size={14} />Cerrar en todos</button>
          </div>
        </section>
      </>}
    </Modal>
  );
}
