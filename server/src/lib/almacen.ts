import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { config } from '../config.js';

/**
 * Almacenamiento de archivos de la app (imágenes del catálogo). Hoy en disco (`IMAGENES_DIR`); la interfaz
 * admite cambiar a un almacenamiento de objetos sin tocar quien la usa. Las rutas son relativas y solo admiten
 * [a-z0-9/_.-]: nunca salen de la carpeta base.
 */
export interface Almacen {
  guardar(ruta: string, datos: Buffer): Promise<void>;
  leer(ruta: string): Promise<Buffer | null>;
  borrar(ruta: string): Promise<void>;
  /** URL pública https con la que WhatsApp descarga la imagen. */
  urlPublica(ruta: string): string;
}

const RUTA_VALIDA = /^[a-z0-9][a-z0-9/_.-]{0,199}$/;

export class AlmacenDisco implements Almacen {
  constructor(private base = resolve(config.imagenes.dir)) {}
  private absoluta(ruta: string) {
    if (!RUTA_VALIDA.test(ruta) || ruta.includes('..')) throw new Error('Ruta de archivo no válida');
    const p = normalize(join(this.base, ruta));
    if (!p.startsWith(this.base + sep)) throw new Error('Ruta de archivo fuera del almacenamiento');
    return p;
  }
  async guardar(ruta: string, datos: Buffer) {
    const p = this.absoluta(ruta);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, datos);
  }
  async leer(ruta: string) { const p = this.absoluta(ruta); return existsSync(p) ? readFileSync(p) : null; }
  async borrar(ruta: string) { rmSync(this.absoluta(ruta), { force: true }); }
  urlPublica(ruta: string) { return `${config.apiPublicUrl}/api/publico/imagenes/${ruta}`; }
}

let actual: Almacen | null = null;
export const almacen = (): Almacen => (actual ??= new AlmacenDisco());
export const setAlmacen = (a: Almacen | null) => { actual = a; };
