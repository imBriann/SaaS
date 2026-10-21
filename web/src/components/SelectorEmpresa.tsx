import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, direccionEmpresa, irAEmpresa, urlPrincipal } from '../api';
import { useApi } from './ui';
import { Icon } from './icons';
import { Menu } from './Layout';

interface Empresa { id: string; slug: string; nombre: string; rol: string; propietario: boolean; tema?: { acento?: string; monograma?: string }; suscripcion?: string | null }

const reducido = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Empresa activa y cambio entre las empresas de la cuenta. La lista sale de la sesión (pertenencias
 * activas); elegir una solo cambia el contexto: el servidor valida el acceso en cada petición.
 * En producción cada empresa vive en su subdominio y la cookie de sesión vale para todos.
 */
export interface CuentaMenu { nombre: string; email: string | null; iniciales: string; onPerfil: () => void; onContrasena: () => void; onSalir: () => void }

export function SelectorEmpresa({ slug, nombre, rol, marca, cuenta }: { slug: string; nombre: string; rol: string; marca: ReactNode; cuenta: CuentaMenu }) {
  const { data } = useApi<{ empresas: Empresa[] }>(() => api.get('/api/auth/sesion'), []);
  const [destino, setDestino] = useState<Empresa | null>(null);
  const empresas = data?.empresas ?? [];
  const otras = empresas.filter((e) => e.slug !== slug).length;

  const cambiar = (e: Empresa, cerrar: () => void) => {
    cerrar();
    if (e.slug === slug) return;
    setDestino(e);
    // La cortina cubre la pantalla antes de recargar con la otra empresa.
    window.setTimeout(() => irAEmpresa(e.slug), reducido() ? 0 : 520);
  };

  return (
    <>
      <Menu boton={(abrir, abierto) => (
        <button type="button" className="contexto contexto-btn" onClick={abrir} aria-expanded={abierto} aria-haspopup="menu"
          aria-label={`${nombre}. Tu perfil y ${otras ? `cambiar de empresa (${otras} más)` : 'tus empresas'}`}>
          {marca}
          <span className="contexto-txt"><b>{nombre}</b><span className="contexto-rol">{rol === 'Propietario' && <Icon n="corona" className="" size={12} />}{rol}</span></span>
          <span className="contexto-cambiar" aria-hidden="true"><Icon n="arriba_abajo" className="" size={15} />{otras > 0 && <i>{otras + 1}</i>}</span>
        </button>
      )}>
        {(cerrar) => <div className="selector-empresa">
          <button type="button" role="menuitem" className="opcion cuenta-cabeza" onClick={() => { cerrar(); cuenta.onPerfil(); }}>
            <span className="avatar" aria-hidden="true">{cuenta.iniciales}</span>
            <span className="empresa-txt"><b>{cuenta.nombre}</b><small>{cuenta.email ?? 'Tu cuenta'}</small></span>
            <span className="ver-perfil">Mi perfil<Icon n="derecha" className="" size={13} /></span>
          </button>
          <div className="sep" />
          <div className="grupo">{empresas.length > 1 ? 'Tus empresas' : 'Tu empresa'}</div>
          {empresas.map((e, i) => {
            const actual = e.slug === slug;
            return (
              <button key={e.id} type="button" role="menuitemradio" aria-checked={actual} className={`opcion empresa-op ${actual ? 'actual' : ''}`}
                title={direccionEmpresa(e.slug)} style={{ '--i': i, '--acento-op': e.tema?.acento ?? 'var(--tinta-3)' } as any} onClick={() => cambiar(e, cerrar)}>
                <span className="empresa-mono" aria-hidden="true">{e.tema?.monograma ?? e.nombre.slice(0, 2)}</span>
                <span className="empresa-txt"><b>{e.nombre}</b><small>{e.propietario ? <><Icon n="corona" className="" size={11} />Propietario</> : e.rol}</small></span>
                {actual ? <Icon n="ok" className="" size={16} /> : <Icon n="derecha" className="" size={14} />}
              </button>
            );
          })}
          <div className="sep" />
          {empresas.length === 1 && <p className="selector-nota">Si creas otra empresa o te invitan a una, aquí podrás cambiar entre ellas.</p>}
          <a href={urlPrincipal('/empezar')} role="menuitem"><Icon n="mas" className="" size={16} />Crear otra empresa</a>
          <div className="sep" />
          <button type="button" role="menuitem" className="opcion" onClick={() => { cerrar(); cuenta.onContrasena(); }}><Icon n="candado" className="" size={16} />Cambiar contraseña</button>
          <button type="button" role="menuitem" className="opcion" onClick={() => { cerrar(); cuenta.onSalir(); }}><Icon n="salir" className="" size={16} />Cerrar sesión</button>
        </div>}
      </Menu>
      {destino && createPortal(
        <div className="cambio-empresa" role="status" aria-live="assertive" style={{ '--acento-op': destino.tema?.acento ?? 'var(--acento)' } as any}>
          <div className="cambio-empresa-centro">
            <span className="empresa-mono grande" aria-hidden="true">{destino.tema?.monograma ?? destino.nombre.slice(0, 2)}</span>
            <b>{destino.nombre}</b>
            <span>Abriendo como {destino.propietario ? 'propietario' : destino.rol.toLowerCase()}…</span>
          </div>
        </div>, document.body,
      )}
    </>
  );
}
