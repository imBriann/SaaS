import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { guardar } from '../../../api';
import { CLAVE_PESTANA_VENTAS, RUTA_PESTANA, type PestanaVentas } from '../../../lib/ventasRutas';
import { useSesion } from '../../../components/Layout';

export function PestanasVentas({ activa }: { activa: PestanaVentas }) {
  const { puede } = useSesion();
  useEffect(() => { guardar(CLAVE_PESTANA_VENTAS, activa); }, [activa]);
  const todas: [PestanaVentas, string, boolean][] = [
    ['vender', 'Vender', puede('order:create')],
    ['historial', 'Historial', puede('order:read')],
    ['comprobantes', 'Comprobantes', puede('comprobante:read')],
  ];
  return (
    <nav className="pestanas-ventas" aria-label="Secciones de ventas">
      {todas.filter(([, , ok]) => ok).map(([id, nombre]) => (
        <NavLink key={id} to={RUTA_PESTANA[id]} end className={() => `pestana ${activa === id ? 'on' : ''}`} aria-current={activa === id ? 'page' : undefined} data-guia={`ventas/pestana-${id}`}>{nombre}</NavLink>
      ))}
    </nav>
  );
}
