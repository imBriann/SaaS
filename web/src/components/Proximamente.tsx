/**
 * Tarjetas de funciones que llegarán más adelante. Se muestran deshabilitadas, con una línea que explica
 * por qué todavía no están, y nunca ofrecen nada que las simule.
 */
export function TarjetaProximamente({ titulo, motivo, children }: { titulo: string; motivo: string; children?: React.ReactNode }) {
  return (
    <section className="tarjeta proximamente" aria-label={`${titulo}, próximamente`} aria-disabled="true">
      <div className="cuerpo col" style={{ gap: 6 }}>
        <span className="fila entre envolver" style={{ gap: 8 }}><b>{titulo}</b><span className="estado neutro">Próximamente</span></span>
        <span className="tenue peq-txt">{motivo}</span>
        {children}
      </div>
    </section>
  );
}

export const MOTIVO_FACTURA_DIAN = 'La factura electrónica ante la DIAN llegará más adelante: exige conectar un proveedor tecnológico autorizado. Mientras tanto, genera comprobantes de venta (sin validez fiscal).';

export function TarjetaFacturaDian({ motivo }: { motivo?: string | null }) {
  return <TarjetaProximamente titulo="Factura electrónica DIAN" motivo={motivo ?? MOTIVO_FACTURA_DIAN} />;
}
