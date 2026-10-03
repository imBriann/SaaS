import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SectorTemplateSchema, type SectorTemplate } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Carga y valida todas las plantillas del directorio. Una plantilla inválida detiene el arranque. */
export function loadTemplates(): SectorTemplate[] {
  return readdirSync(here)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const parsed = SectorTemplateSchema.safeParse(JSON.parse(readFileSync(join(here, f), 'utf8')));
      if (!parsed.success) throw new Error(`Plantilla ${f} inválida: ${parsed.error.message}`);
      return parsed.data;
    });
}

export const MODULOS: Record<string, { nombre: string; descripcion: string }> = {
  clientes: { nombre: 'Clientes', descripcion: 'Contactos, historial y consentimiento' },
  catalogo: { nombre: 'Catálogo', descripcion: 'Productos y servicios con precio e impuesto' },
  ventas: { nombre: 'Ventas', descripcion: 'Órdenes y cobros' },
  agenda: { nombre: 'Agenda', descripcion: 'Citas y recursos' },
  inventario: { nombre: 'Inventario', descripcion: 'Existencias, movimientos y mínimos' },
  facturacion: { nombre: 'Facturación electrónica', descripcion: 'Documentos válidos ante la DIAN' },
  conversaciones: { nombre: 'Conversaciones', descripcion: 'WhatsApp, radicados y bandeja de asesor' },
  ia: { nombre: 'Agentes de IA', descripcion: 'Atención, asistente y copiloto con herramientas autorizadas' },
  comisiones: { nombre: 'Comisiones', descripcion: 'Participación por recurso' },
  membresias: { nombre: 'Membresías', descripcion: 'Planes recurrentes y vencimientos' },
};
