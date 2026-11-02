import { useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import { guardar } from '../../../api';
import { CLAVE_PESTANA_VENTAS, RUTA_PESTANA, type PestanaVentas } from '../../../lib/ventasRutas';
import { useSesion } from '../../../components/Layout';

function Pestana({ id, activa, guia, children }: { id: PestanaVentas; activa: PestanaVentas; guia: string; children: string }) {
  return <NavLink to={RUTA_PESTANA[id]} end className={() => `pestana ${activa === id ? 'on' : ''}`} aria-current={activa === id ? 'page' : undefined} data-guia={guia}>{children}</NavLink>;
}

export function PestanasVentas({ activa }: { activa: PestanaVentas }) {
  const { puede } = useSesion();
  useEffect(() => { guardar(CLAVE_PESTANA_VENTAS, activa); }, [activa]);
  return (
    <nav className="pestanas-ventas" aria-label="Secciones de ventas">
      {puede('order:create') && <Pestana id="vender" activa={activa} guia="ventas/pestana-vender">Vender</Pestana>}
      {puede('order:read') && <Pestana id="historial" activa={activa} guia="ventas/pestana-historial">Historial</Pestana>}
      {puede('comprobante:read') && <Pestana id="comprobantes" activa={activa} guia="ventas/pestana-comprobantes">Comprobantes</Pestana>}
    </nav>
  );
}
