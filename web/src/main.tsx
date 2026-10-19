import { lazy, StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import './studio.css';
import './omnegia.css';
import './japanese.css';
import './landing.css';
import './support.css';
import './registration.css';
import './markdown.css';
import './cobros.css';
import './atencion.css';
import './movimiento.css';
import './soporte.css';
import './dashboard.css';
import './asistente.css';
import './workspace-birth.css';
import './creation.css';
import './legal.css';
import { ToastProvider } from './components/ui';
import { PanelLayout } from './components/Layout';
import { slugDelHost, tenantSlug } from './api';
import { CierreAlta, Catalogo, Datos, Describir, Empresas, Entrar, Invitacion, Landing, Pago, Pasarela, Recuperar, Restablecer, ResultadoPago } from './pages/public/Publico';
import { Cargando } from './components/ui';

// El panel se carga aparte: quien visita la página pública no descarga el panel.
const Inicio = lazy(() => import('./pages/app/Inicio').then((m) => ({ default: m.Inicio })));
const publico = () => import('./pages/public/Marketing');
const Producto = lazy(() => publico().then(m => ({ default: m.Producto })));
const Nosotros = lazy(() => publico().then(m => ({ default: m.Nosotros })));
const Planes = lazy(() => publico().then(m => ({ default: m.Planes })));
const Ayuda = lazy(() => publico().then(m => ({ default: m.Ayuda })));
// Zona legal: paquete aparte, solo se descarga al leer un documento.
const legal = () => import('./pages/public/Legal');
const Legal = lazy(() => legal().then(m => ({ default: m.Legal })));
const Terminos = lazy(() => legal().then(m => ({ default: m.Terminos })));
const Privacidad = lazy(() => legal().then(m => ({ default: m.Privacidad })));
const EliminacionDatos = lazy(() => legal().then(m => ({ default: m.EliminacionDatos })));
const Cookies = lazy(() => legal().then(m => ({ default: m.Cookies })));
const Consumidor = lazy(() => legal().then(m => ({ default: m.Consumidor })));
const Asistente = lazy(() => import('./pages/app/Asistente').then((m) => ({ default: m.Asistente })));
const Conversaciones = lazy(() => import('./pages/app/Conversaciones').then((m) => ({ default: m.Conversaciones })));
const negocio = () => import('./pages/app/Negocio');
const Agenda = lazy(() => negocio().then((m) => ({ default: m.Agenda })));
const Clientes = lazy(() => negocio().then((m) => ({ default: m.Clientes })));
const Facturacion = lazy(() => negocio().then((m) => ({ default: m.Facturacion })));
const Inventario = lazy(() => negocio().then((m) => ({ default: m.Inventario })));
const Ventas = lazy(() => negocio().then((m) => ({ default: m.Ventas })));
const VentaDetalle = lazy(() => negocio().then((m) => ({ default: m.VentaDetalle })));
const gobierno = () => import('./pages/app/Gobierno');
const Auditoria = lazy(() => gobierno().then((m) => ({ default: m.Auditoria })));
const CentroIA = lazy(() => gobierno().then((m) => ({ default: m.CentroIA })));
const Configuracion = lazy(() => gobierno().then((m) => ({ default: m.Configuracion })));
const Simulador = lazy(() => gobierno().then((m) => ({ default: m.Simulador })));
const Suscripcion = lazy(() => gobierno().then((m) => ({ default: m.Suscripcion })));
const soporte = () => import('./pages/app/Soporte');
const Soporte = lazy(() => soporte().then((m) => ({ default: m.Soporte })));
const SoporteDetalle = lazy(() => soporte().then((m) => ({ default: m.SoporteDetalle })));
// Panel interno del operador de la plataforma: paquete aparte, no se descarga en el panel de las empresas.
const op = () => import('./pages/operador/Operador');
const OperadorLayout = lazy(() => op().then((m) => ({ default: m.OperadorLayout })));
const OpResumen = lazy(() => op().then((m) => ({ default: m.OpResumen })));
const OpEmpresas = lazy(() => op().then((m) => ({ default: m.OpEmpresas })));
const OpEmpresa = lazy(() => op().then((m) => ({ default: m.OpEmpresa })));
const OpSuscripciones = lazy(() => op().then((m) => ({ default: m.OpSuscripciones })));
const OpSalud = lazy(() => op().then((m) => ({ default: m.OpSalud })));
const OpIncidentes = lazy(() => op().then((m) => ({ default: m.OpIncidentes })));
const OpIntegraciones = lazy(() => op().then((m) => ({ default: m.OpIntegraciones })));
const OpSoporte = lazy(() => op().then((m) => ({ default: m.OpSoporte })));
const OpTicket = lazy(() => op().then((m) => ({ default: m.OpTicket })));
const OpAuditoria = lazy(() => op().then((m) => ({ default: m.OpAuditoria })));
const OpReembolsos = lazy(() => op().then((m) => ({ default: m.OpReembolsos })));
const atencionOp = () => import('./pages/operador/Atencion');
const OpConversaciones = lazy(() => atencionOp().then((m) => ({ default: m.OpConversaciones })));
const OpAtencionEmpresas = lazy(() => atencionOp().then((m) => ({ default: m.OpAtencionEmpresas })));
const OpConversacionCompartida = lazy(() => atencionOp().then((m) => ({ default: m.OpConversacionCompartida })));

/** En el dominio raíz sin empresa elegida se muestra la landing; con subdominio o empresa, el panel. */
function Raiz() {
  if (!slugDelHost() && !tenantSlug()) return <Landing />;
  return <Navigate to="/panel" replace />;
}

function App() {
  const location = useLocation();
  useEffect(() => {
    if (!location.hash) { window.scrollTo({ top: 0, behavior: 'instant' }); return; }
    const id = decodeURIComponent(location.hash.slice(1));
    const scroll = () => { const el = document.getElementById(id); if (el) { el.scrollIntoView({ behavior: 'instant' }); return true; } return false; };
    if (scroll()) return;
    const observer = new MutationObserver(() => { if (scroll()) observer.disconnect(); });
    observer.observe(document.getElementById('root')!, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), 6000);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [location.pathname, location.hash]);
  useEffect(() => {
    const titulos: Record<string, string> = { '/bienvenida': 'Todo tu negocio. Un solo lugar.', '/producto': 'Producto y módulos', '/nosotros': 'Nosotros', '/planes': 'Planes y configuración', '/ayuda': 'Centro de ayuda', '/legal': 'Zona legal', '/empezar': 'Configura tu negocio', '/entrar': 'Entrar' };
    if (titulos[location.pathname]) document.title = `${titulos[location.pathname]} · Omnegia`;
  }, [location.pathname]);
  const sinEmpresa = !slugDelHost() && !tenantSlug();
  return (
      <Suspense fallback={<div className="pagina"><Cargando filas={6} /></div>}>
        <Routes>
          <Route path="/bienvenida" element={<Landing />} />
          <Route path="/producto" element={<Producto />} />
          <Route path="/nosotros" element={<Nosotros />} />
          <Route path="/planes" element={<Planes />} />
          <Route path="/ayuda" element={<Ayuda />} />
          <Route path="/legal" element={<Legal />} />
          <Route path="/terminos" element={<Terminos />} />
          <Route path="/privacidad" element={<Privacidad />} />
          <Route path="/eliminacion-de-datos" element={<EliminacionDatos />} />
          <Route path="/cookies" element={<Cookies />} />
          <Route path="/consumidor" element={<Consumidor />} />
          <Route path="/empezar" element={<Describir />} />
          <Route path="/empezar/datos" element={<Datos />} />
          <Route path="/empezar/catalogo" element={<Catalogo />} />
          <Route path="/empezar/pago" element={<Pago />} />
          <Route path="/empezar/listo" element={<CierreAlta />} />
          <Route path="/pasarela/checkout" element={<Pasarela />} />
          <Route path="/entrar" element={<Entrar />} />
          <Route path="/recuperar" element={<Recuperar />} />
          <Route path="/restablecer" element={<Restablecer />} />
          <Route path="/invitacion" element={<Invitacion />} />
          <Route path="/pago/resultado" element={<ResultadoPago />} />
          <Route path="/empresas" element={<Empresas />} />
          <Route path="/plataforma" element={<Navigate to="/operador" replace />} />
          <Route path="/operador" element={<OperadorLayout />}>
            <Route index element={<OpResumen />} />
            <Route path="empresas" element={<OpEmpresas />} />
            <Route path="empresas/:id" element={<OpEmpresa />} />
            <Route path="suscripciones" element={<OpSuscripciones />} />
            <Route path="salud" element={<OpSalud />} />
            <Route path="incidentes" element={<OpIncidentes />} />
            <Route path="integraciones" element={<OpIntegraciones />} />
            <Route path="conversaciones" element={<OpConversaciones />} />
            <Route path="conversaciones/:id" element={<OpConversaciones />} />
            <Route path="atencion" element={<OpAtencionEmpresas />} />
            <Route path="atencion/conversaciones/:id" element={<OpConversacionCompartida />} />
            <Route path="soporte" element={<OpSoporte />} />
            <Route path="soporte/:id" element={<OpTicket />} />
            <Route path="reembolsos" element={<OpReembolsos />} />
            <Route path="auditoria" element={<OpAuditoria />} />
          </Route>
          {sinEmpresa && <Route path="/" element={<Raiz />} />}
          <Route element={<PanelLayout />}>
            <Route path="/" element={<Inicio />} />
            <Route path="/panel" element={<Navigate to="/" replace />} />
            <Route path="/asistente" element={<Asistente />} />
            <Route path="/asistente/:id" element={<Asistente />} />
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
            <Route path="/soporte" element={<Soporte />} />
            <Route path="/soporte/:id" element={<SoporteDetalle />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
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
