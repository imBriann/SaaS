import { token } from '../lib/util.js';
import { ErrorProveedor, NumeroNoDisponible, type NumeroDisponible, type Orden, type ProveedorNumeros, type Requisito, type TipoNumero } from './proveedor.js';

/**
 * Inventario de DEMOSTRACIÓN (desarrollo, pruebas y SIMULADORES=1). No compra nada: el panel lo
 * marca como simulación y sus valores no son precios de ningún proveedor. Usa el bloque
 * +57 601 555 01xx, que no corresponde a un inventario a la venta.
 *
 * Los mandos (`fallos`, `revision`, `agotados`) permiten probar los caminos difíciles.
 */
export class SimuladorNumeros implements ProveedorNumeros {
  nombre = 'simulado';
  entorno = 'simulado' as const;
  vendidos = new Set<string>();
  agotados = new Set<string>();
  ordenes = new Map<string, Orden & { numero: string; referencia: string }>();
  /** Errores que lanzará `ordenar` antes de aceptar (temporales o definitivos). */
  fallos: ErrorProveedor[] = [];
  /** Con requisitos documentales: la orden queda en revisión hasta `aprobar` o `rechazar`. */
  revision = false;
  liberados: string[] = [];
  llamadas: string[] = [];

  async cobertura(pais: string) {
    if (pais !== 'CO') return { pais, tipos: [] };
    return { pais, tipos: [{ tipo: 'local' as TipoNumero, caracteristicas: ['voice' as const], reservable: true }, { tipo: 'toll_free' as TipoNumero, caracteristicas: ['voice' as const], reservable: false }] };
  }

  private inventario(pais: string, tipo: TipoNumero): NumeroDisponible[] {
    if (pais !== 'CO') return [];
    // 601 es el indicativo de Bogotá: la localidad corresponde al indicativo, como en el inventario real.
    return Array.from({ length: 6 }, (_, i) => ({
      numero: tipo === 'toll_free' ? `+5718005550${10 + i}` : `+576015550${110 + i}`, pais, tipo, localidad: tipo === 'toll_free' ? null : 'Bogotá', region: tipo === 'toll_free' ? null : 'Bogotá D.C.',
      caracteristicas: ['voice' as const], reservable: tipo !== 'toll_free', costo: { activacion: 1, mensual: 1, moneda: 'USD' },
    })).filter((n) => !this.vendidos.has(n.numero) && !this.agotados.has(n.numero));
  }

  async buscar(f: { pais: string; tipo: TipoNumero; localidad?: string; contiene?: string; limite?: number }) {
    this.llamadas.push('buscar');
    return this.inventario(f.pais, f.tipo).filter((n) => !f.contiene || n.numero.includes(f.contiene)).slice(0, f.limite ?? 12);
  }
  async consultar(numero: string, pais: string, tipo: TipoNumero) { return this.inventario(pais, tipo).find((n) => n.numero === numero) ?? null; }
  async reservar(numero: string) {
    if (this.agotados.has(numero) || this.vendidos.has(numero)) throw new NumeroNoDisponible();
    return { id: `res-${token(6)}`, expiraEn: new Date(Date.now() + 30 * 60_000) };
  }
  async requisitos(pais: string, tipo: TipoNumero): Promise<Requisito[]> {
    if (pais !== 'CO' || tipo === 'toll_free') return [];
    return [
      { id: 'sim-req-razon', nombre: 'Razón social o nombre del titular', descripcion: 'Como aparece en el registro mercantil o en el documento de identidad.', ejemplo: 'Barbería El Parche S.A.S.', campo: 'textual', criterios: { max_length: '120' } },
      { id: 'sim-req-direccion', nombre: 'Dirección en la zona del indicativo', descripcion: 'Dirección del negocio dentro del área que cubre el indicativo del número.', ejemplo: 'Calle 5 # 2-10, Bogotá', campo: 'address', criterios: { locality_limit: 'Misma localidad que el número' } },
      { id: 'sim-req-documento', nombre: 'Certificado de existencia o documento de identidad', descripcion: 'PDF o imagen legible, de menos de 3 meses si es un certificado.', ejemplo: null, campo: 'document', criterios: { time_limit: 'Menos de 3 meses' } },
    ];
  }
  async enviarRequisitos() { return { grupoId: `grp-${token(6)}` }; }
  async ordenar(numero: string, o: { grupoId: string | null; referencia: string }) {
    this.llamadas.push('ordenar');
    const f = this.fallos.shift();
    if (f) throw f;
    if (this.agotados.has(numero) || this.vendidos.has(numero)) throw new NumeroNoDisponible();
    this.vendidos.add(numero);
    const ord = { id: `ord-${token(8)}`, estado: this.revision ? 'pendiente' as const : 'exito' as const, requisitos: this.revision ? 'en_revision' as const : 'aprobado' as const, vence: null, numero, referencia: o.referencia };
    this.ordenes.set(ord.id, ord);
    return ord;
  }
  async ordenPorReferencia(referencia: string) { return [...this.ordenes.values()].find((x) => x.referencia === referencia) ?? null; }
  async consultarOrden(id: string) {
    const o = this.ordenes.get(id);
    if (!o) throw new ErrorProveedor('Orden desconocida.', false, '404', 404);
    return o;
  }
  aprobar(id: string) { const o = this.ordenes.get(id); if (o) Object.assign(o, { estado: 'exito', requisitos: 'aprobado' }); }
  rechazar(id: string) { const o = this.ordenes.get(id); if (o) Object.assign(o, { requisitos: 'rechazado' }); }
  async idDelNumero(numero: string) { return this.vendidos.has(numero) ? `pn-${numero.slice(1)}` : null; }
  async liberar(numeroId: string) {
    this.liberados.push(numeroId);
    this.vendidos.delete(`+${numeroId.replace(/^pn-/, '')}`);
  }
}
