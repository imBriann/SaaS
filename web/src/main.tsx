import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import './studio.css';
import { ToastProvider } from './components/ui';
import { PanelLayout } from './components/Layout';
import { slugDelHost, tenantSlug } from './api';
import { Aprovisionamiento, Catalogo, Datos, Describir, Empresas, Entrar, Landing, Pago, Pasarela, Plataforma } from './pages/public/Publico';
import { Inicio } from './pages/app/Inicio';
import { Conversaciones } from './pages/app/Conversaciones';
import { Agenda, Clientes, Facturacion, Inventario, Ventas, VentaDetalle } from './pages/app/Negocio';
import { Auditoria, CentroIA, Configuracion, Simulador, Suscripcion } from './pages/app/Gobierno';

/** En el dominio raíz sin empresa elegida se muestra la landing; con subdominio o empresa, el panel. */
function Raiz() {
  if (!slugDelHost() && !tenantSlug()) return <Landing />;
  return <Navigate to="/panel" replace />;
}

function App() {
  const location = useLocation();
  useEffect(() => { if (!location.hash) window.scrollTo({ top: 0, behavior: 'instant' }); }, [location.pathname]);
  const sinEmpresa = !slugDelHost() && !tenantSlug();
  return (
        <Routes>
          <Route path="/bienvenida" element={<Landing />} />
          <Route path="/empezar" element={<Describir />} />
          <Route path="/empezar/datos" element={<Datos />} />
          <Route path="/empezar/catalogo" element={<Catalogo />} />
          <Route path="/empezar/pago" element={<Pago />} />
          <Route path="/empezar/listo" element={<Aprovisionamiento />} />
          <Route path="/pasarela/checkout" element={<Pasarela />} />
          <Route path="/entrar" element={<Entrar />} />
          <Route path="/empresas" element={<Empresas />} />
          <Route path="/plataforma" element={<Plataforma />} />
          {sinEmpresa && <Route path="/" element={<Raiz />} />}
          <Route element={<PanelLayout />}>
            <Route path="/" element={<Inicio />} />
            <Route path="/panel" element={<Navigate to="/" replace />} />
            <Route path="/conversaciones" element={<Conversaciones />} />
            <Route path="/conversaciones/:id" element={<Conversaciones />} />
            <Route path="/clientes" element={<Clientes />} />
            <Route path="/ventas" element={<Ventas />} />
            <Route path="/ventas/:id" element={<VentaDetalle />} />
            <Route path="/inventario" element={<Inventario />} />
            <Route path="/agenda" element={<Agenda />} />
            <Route path="/facturacion" element={<Facturacion />} />
            <Route path="/ia" element={<CentroIA />} />
            <Route path="/configuracion" element={<Configuracion />} />
            <Route path="/suscripcion" element={<Suscripcion />} />
            <Route path="/auditoria" element={<Auditoria />} />
            <Route path="/simulador" element={<Simulador />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ToastProvider>
  </StrictMode>,
);
