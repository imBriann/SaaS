import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { config } from '../config.js';

/**
 * Almacenamiento de archivos de la app (imágenes del catálogo). En disco (`IMAGENES_DIR`, desarrollo) o en
 * Supabase Storage (`ALMACEN_PROVEEDOR=supabase`, producción). Las rutas son relativas y solo admiten
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

type Fetch = typeof fetch;

/**
 * Supabase Storage (API REST). Bucket PÚBLICO: la URL https que usa WhatsApp es la pública del propio bucket.
 * Escribir y borrar exige la llave de servicio, que solo vive en el servidor (nunca en el panel ni en los registros:
 * los errores no la incluyen). El cliente HTTP se inyecta para poder probarlo sin red.
 */
export class AlmacenSupabase implements Almacen {
  constructor(
    private url = config.imagenes.supabaseUrl,
    private llave = config.imagenes.supabaseServiceKey ?? '',
    private bucket = config.imagenes.supabaseBucket ?? 'imagenes',
    private http: Fetch = (...a) => fetch(...a),
  ) {}
  private ruta(ruta: string) {
    if (!RUTA_VALIDA.test(ruta) || ruta.includes('..')) throw new Error('Ruta de archivo no válida');
    return ruta.split('/').map(encodeURIComponent).join('/');
  }
  private cabeceras(extra: Record<string, string> = {}) { return { authorization: `Bearer ${this.llave}`, apikey: this.llave, ...extra }; }
  private async llamar(metodo: string, url: string, init: RequestInit = {}) {
    try { return await this.http(url, { method: metodo, signal: AbortSignal.timeout(15_000), ...init }); }
    catch (e) { throw new Error(`Supabase Storage no respondió (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : 'sin conexión'}).`); }
  }
  async guardar(ruta: string, datos: Buffer) {
    const r = await this.llamar('POST', `${this.url}/storage/v1/object/${this.bucket}/${this.ruta(ruta)}`, {
      headers: this.cabeceras({ 'content-type': 'image/webp', 'x-upsert': 'true', 'cache-control': 'max-age=31536000' }), body: new Uint8Array(datos),
    });
    if (!r.ok) throw new Error(`Supabase Storage rechazó la carga (${r.status}). Revisa SUPABASE_URL, la llave de servicio y que el bucket «${this.bucket}» exista.`);
  }
  async leer(ruta: string) {
    const r = await this.llamar('GET', `${this.url}/storage/v1/object/${this.bucket}/${this.ruta(ruta)}`, { headers: this.cabeceras() });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error(`Supabase Storage no pudo leer el archivo (${r.status}).`);
    return Buffer.from(await r.arrayBuffer());
  }
  async borrar(ruta: string) {
    const r = await this.llamar('DELETE', `${this.url}/storage/v1/object/${this.bucket}/${this.ruta(ruta)}`, { headers: this.cabeceras() });
    if (!r.ok && r.status !== 404 && r.status !== 400) throw new Error(`Supabase Storage no pudo borrar el archivo (${r.status}).`);
  }
  urlPublica(ruta: string) { return `${this.url}/storage/v1/object/public/${this.bucket}/${this.ruta(ruta)}`; }
}

let actual: Almacen | null = null;
export const almacen = (): Almacen => (actual ??= config.imagenes.almacen === 'supabase' ? new AlmacenSupabase() : new AlmacenDisco());
export const setAlmacen = (a: Almacen | null) => { actual = a; };
