import { createPublicKey, verify } from 'node:crypto';
import { config } from '../config.js';
import {
  ErrorProveedor, NumeroNoDisponible,
  type Caracteristica, type Cobertura, type NumeroDisponible, type Orden, type ProveedorNumeros, type Requisito, type TipoNumero, type ValorRequisito,
} from './proveedor.js';

/**
 * Adaptador de Telnyx (API v2, https://developers.telnyx.com). Lo que usa, todo documentado:
 *  - GET  /country_coverage/countries/{pais}            tipos de número y funciones por país
 *  - GET  /available_phone_numbers                      inventario con cost_information (upfront/monthly)
 *  - POST /number_reservations                          reserva exclusiva de 30 minutos (si el número es reservable)
 *  - GET  /regulatory_requirements                      requisitos por país, tipo y acción «ordering»
 *  - POST /documents, /addresses, /requirement_groups   valores de los requisitos
 *  - POST /number_orders · GET /number_orders[/{id}]    compra (customer_reference = id de la contratación)
 *  - GET  /phone_numbers · DELETE /phone_numbers/{id}   número en la cuenta y su liberación
 * Los webhooks llevan firma Ed25519 (telnyx-signature-ed25519 sobre «timestamp|cuerpo»).
 * La llave de API nunca sale del servidor ni aparece en errores.
 */
const BASE = 'https://api.telnyx.com/v2';
const TIPOS: TipoNumero[] = ['local', 'mobile', 'national', 'toll_free'];
const FUNCIONES = new Set<Caracteristica>(['voice', 'sms', 'mms', 'fax', 'emergency']);

const ESTADO_ORDEN: Record<string, Orden['estado']> = { pending: 'pendiente', success: 'exito', failure: 'fallo', cancelled: 'cancelada', deleted: 'cancelada' };
const ESTADO_REQ: Record<string, Orden['requisitos']> = {
  'requirement-info-pending': 'pendiente', 'requirement-info-under-review': 'en_revision', 'requirement-info-exception': 'rechazado',
  approved: 'aprobado', pending: 'en_revision', cancelled: null, deleted: null,
};

const numeroSeguro = (n: string) => /^\+[1-9]\d{6,14}$/.test(n);
const funciones = (f: unknown): Caracteristica[] =>
  Array.isArray(f) ? [...new Set(f.map((x: any) => String(typeof x === 'string' ? x : x?.name ?? '')).filter((x): x is Caracteristica => FUNCIONES.has(x as Caracteristica)))] : [];

export class TelnyxNumeros implements ProveedorNumeros {
  nombre = 'telnyx';
  entorno = 'real' as const;
  constructor(private apiKey = config.numeros.telnyx.apiKey, private fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async pedir(metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE', ruta: string, cuerpo?: unknown): Promise<any> {
    if (!this.apiKey) throw new ErrorProveedor('Falta TELNYX_API_KEY.', false, 'CREDENCIAL');
    let res: Response;
    try {
      res = await this.fetcher(`${BASE}${ruta}`, {
        method: metodo,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', ...(cuerpo ? { 'content-type': 'application/json' } : {}) },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new ErrorProveedor(`Sin respuesta del proveedor de números (${(e as Error).name === 'TimeoutError' ? 'tiempo agotado' : 'red'}).`, true, 'RED');
    }
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) return data;
    // Solo el código y el título documentados del error; nunca cabeceras ni cuerpo completo.
    const err = data?.errors?.[0];
    const codigo = String(err?.code ?? res.status);
    const reintentable = res.status >= 500 || res.status === 429;
    const texto = res.status === 401 || res.status === 403 ? 'El proveedor de números rechazó la credencial.' : `El proveedor de números respondió ${res.status}${err?.title ? ` (${String(err.title).slice(0, 80)})` : ''}.`;
    throw new ErrorProveedor(texto, reintentable, res.status === 401 || res.status === 403 ? 'CREDENCIAL' : codigo, res.status);
  }

  async cobertura(pais: string): Promise<Cobertura | null> {
    if (!/^[A-Z]{2}$/.test(pais)) return null;
    const d = (await this.pedir('GET', `/country_coverage/countries/${pais}`))?.data;
    if (!d) return null;
    const lista: string[] = Array.isArray(d.phone_number_type) ? d.phone_number_type.map(String) : [];
    const tipos = TIPOS.filter((t) => lista.includes(t)).map((t) => {
      const det = d[t] && typeof d[t] === 'object' ? d[t] : {};
      return { tipo: t, caracteristicas: funciones(det.features ?? d.features), reservable: !!(det.reservable ?? d.reservable) };
    });
    return { pais, tipos };
  }

  private mapear(x: any, pais: string, tipo: TipoNumero): NumeroDisponible | null {
    const numero = String(x?.phone_number ?? '');
    if (!numeroSeguro(numero)) return null;
    const regiones: any[] = Array.isArray(x.region_information) ? x.region_information : [];
    const region = (t: string) => regiones.find((r) => r?.region_type === t)?.region_name ?? null;
    const c = x.cost_information ?? {};
    const activacion = Number(c.upfront_cost);
    const mensual = Number(c.monthly_cost);
    // Sin costo informado no se ofrece: nunca se inventa un precio.
    if (!Number.isFinite(activacion) || !Number.isFinite(mensual) || !c.currency) return null;
    return {
      numero, pais, tipo, localidad: region('location') ?? region('rate_center'), region: region('state'),
      caracteristicas: funciones(x.features), reservable: !!x.reservable,
      costo: { activacion, mensual, moneda: String(c.currency).toUpperCase() },
    };
  }

  async buscar(f: { pais: string; tipo: TipoNumero; localidad?: string; contiene?: string; limite?: number }): Promise<NumeroDisponible[]> {
    const q = new URLSearchParams({ 'filter[country_code]': f.pais, 'filter[phone_number_type]': f.tipo, 'filter[limit]': String(Math.min(f.limite ?? 12, 50)), 'filter[exclude_held_numbers]': 'true' });
    if (f.localidad) q.set('filter[locality]', f.localidad);
    if (f.contiene && /^\d{1,10}$/.test(f.contiene)) q.set('filter[phone_number][contains]', f.contiene);
    const d = await this.pedir('GET', `/available_phone_numbers?${q.toString()}`);
    return (Array.isArray(d?.data) ? d.data : []).map((x: any) => this.mapear(x, f.pais, f.tipo)).filter((x: NumeroDisponible | null): x is NumeroDisponible => !!x);
  }

  async consultar(numero: string, pais: string, tipo: TipoNumero): Promise<NumeroDisponible | null> {
    if (!numeroSeguro(numero)) return null;
    const q = new URLSearchParams({ 'filter[country_code]': pais, 'filter[phone_number_type]': tipo, 'filter[phone_number][contains]': numero.slice(-10).replace(/\D/g, ''), 'filter[limit]': '50' });
    const d = await this.pedir('GET', `/available_phone_numbers?${q.toString()}`);
    const x = (Array.isArray(d?.data) ? d.data : []).find((r: any) => r?.phone_number === numero);
    return x ? this.mapear(x, pais, tipo) : null;
  }

  async reservar(numero: string) {
    const d = (await this.pedir('POST', '/number_reservations', { phone_numbers: [{ phone_number: numero }] }))?.data;
    const pn = (d?.phone_numbers ?? []).find((p: any) => p?.phone_number === numero);
    if (!d?.id || !pn) return null;
    if (pn.status === 'failed') throw new NumeroNoDisponible();
    const expira = new Date(pn.expired_at ?? Date.now() + 30 * 60_000);
    return { id: String(d.id), expiraEn: Number.isNaN(expira.getTime()) ? new Date(Date.now() + 30 * 60_000) : expira };
  }

  async requisitos(pais: string, tipo: TipoNumero): Promise<Requisito[]> {
    const q = new URLSearchParams({ 'filter[country_code]': pais, 'filter[phone_number_type]': tipo, 'filter[action]': 'ordering' });
    const d = await this.pedir('GET', `/regulatory_requirements?${q.toString()}`);
    const grupo = (Array.isArray(d?.data) ? d.data : [])[0];
    return (grupo?.regulatory_requirements ?? []).filter((r: any) => r?.id).map((r: any) => ({
      id: String(r.id), nombre: String(r.name ?? 'Requisito'), descripcion: String(r.description ?? ''), ejemplo: r.example ? String(r.example) : null,
      campo: r.field_type === 'address_id' || r.field_type === 'address' ? 'address' : r.field_type === 'document' ? 'document' : 'textual',
      criterios: r.acceptance_criteria && typeof r.acceptance_criteria === 'object' ? r.acceptance_criteria : {},
    }));
  }

  async enviarRequisitos(pais: string, tipo: TipoNumero, valores: ValorRequisito[], referencia: string) {
    const regulatory_requirements: { requirement_id: string; field_value: string }[] = [];
    for (const v of valores) {
      if (v.campo === 'textual') { regulatory_requirements.push({ requirement_id: v.id, field_value: v.valor }); continue; }
      if (v.campo === 'document') {
        const doc = (await this.pedir('POST', '/documents', { file: v.archivo.base64, filename: v.archivo.nombre, customer_reference: referencia }))?.data;
        if (!doc?.id) throw new ErrorProveedor('El proveedor no devolvió el documento cargado.', true);
        regulatory_requirements.push({ requirement_id: v.id, field_value: String(doc.id) });
        continue;
      }
      const a = v.direccion;
      const dir = (await this.pedir('POST', '/addresses', {
        first_name: a.nombre, last_name: a.apellido, business_name: a.empresa, street_address: a.direccion, extended_address: a.complemento,
        locality: a.ciudad, administrative_area: a.departamento, postal_code: a.codigoPostal, phone_number: a.telefono, country_code: pais, customer_reference: referencia,
      }))?.data;
      if (!dir?.id) throw new ErrorProveedor('El proveedor no devolvió la dirección registrada.', true);
      regulatory_requirements.push({ requirement_id: v.id, field_value: String(dir.id) });
    }
    const g = (await this.pedir('POST', '/requirement_groups', { country_code: pais, phone_number_type: tipo, action: 'ordering', customer_reference: referencia, regulatory_requirements }))?.data;
    if (!g?.id) throw new ErrorProveedor('El proveedor no devolvió el grupo de requisitos.', true);
    return { grupoId: String(g.id) };
  }

  private orden(d: any): Orden {
    const pn = Array.isArray(d?.phone_numbers) ? d.phone_numbers[0] : null;
    return {
      id: String(d?.id ?? ''),
      estado: ESTADO_ORDEN[String(d?.status)] ?? 'pendiente',
      requisitos: pn?.requirements_status ? ESTADO_REQ[String(pn.requirements_status)] ?? 'en_revision' : d?.requirements_met ? 'aprobado' : null,
      vence: typeof d?.deadline === 'string' ? d.deadline : null,
    };
  }

  async ordenar(numero: string, o: { grupoId: string | null; referencia: string }) {
    const d = (await this.pedir('POST', '/number_orders', {
      phone_numbers: [{ phone_number: numero, ...(o.grupoId ? { requirement_group_id: o.grupoId } : {}) }],
      ...(config.numeros.telnyx.conexionVozId ? { connection_id: config.numeros.telnyx.conexionVozId } : {}),
      customer_reference: o.referencia,
    }).catch((e) => { if (e instanceof ErrorProveedor && e.http === 422) throw new NumeroNoDisponible(); throw e; }))?.data;
    if (!d?.id) throw new ErrorProveedor('El proveedor no devolvió la orden de compra.', true);
    return this.orden(d);
  }

  async ordenPorReferencia(referencia: string) {
    const d = await this.pedir('GET', `/number_orders?${new URLSearchParams({ 'filter[customer_reference]': referencia }).toString()}`);
    const x = (Array.isArray(d?.data) ? d.data : []).find((r: any) => r?.customer_reference === referencia);
    return x ? this.orden(x) : null;
  }

  async consultarOrden(id: string) {
    if (!/^[\w-]{6,80}$/.test(id)) throw new ErrorProveedor('Identificador de orden inválido.', false);
    return this.orden((await this.pedir('GET', `/number_orders/${encodeURIComponent(id)}`))?.data);
  }

  async idDelNumero(numero: string) {
    if (!numeroSeguro(numero)) return null;
    const d = await this.pedir('GET', `/phone_numbers?${new URLSearchParams({ 'filter[phone_number]': numero }).toString()}`);
    const x = (Array.isArray(d?.data) ? d.data : []).find((r: any) => r?.phone_number === numero);
    return x?.id ? String(x.id) : null;
  }

  async liberar(numeroId: string) {
    if (!/^[\w-]{3,80}$/.test(numeroId)) throw new ErrorProveedor('Identificador de número inválido.', false);
    await this.pedir('DELETE', `/phone_numbers/${encodeURIComponent(numeroId)}`).catch((e) => { if (e instanceof ErrorProveedor && e.http === 404) return; throw e; });
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------
const PREFIJO_SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const TOLERANCIA_S = 300;

/** Firma Ed25519 de Telnyx: base64(sign(«telnyx-timestamp|cuerpo crudo»)) con la llave pública de la cuenta. */
export function verificarFirmaTelnyx(cuerpo: string, firma: string | undefined, marca: string | undefined, llavePublica = config.numeros.telnyx.llavePublica, ahora = Date.now()): boolean {
  if (!llavePublica || !firma || !marca || !/^\d{9,11}$/.test(marca)) return false;
  if (Math.abs(ahora / 1000 - Number(marca)) > TOLERANCIA_S) return false;
  try {
    const crudo = Buffer.from(llavePublica, 'base64');
    if (crudo.length !== 32) return false;
    const llave = createPublicKey({ key: Buffer.concat([PREFIJO_SPKI_ED25519, crudo]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`${marca}|${cuerpo}`), llave, Buffer.from(firma, 'base64'));
  } catch {
    return false;
  }
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));

/**
 * Respuesta TeXML a la llamada entrante: transcribe en español (la llamada de Meta dicta el código)
 * y, si el cliente lo pidió, la reenvía a su celular para que escuche el código él mismo.
 */
export function texmlLlamada(o: { transcripcion?: string; reenviarA?: string | null }): string {
  if (o.reenviarA && /^\+[1-9]\d{6,14}$/.test(o.reenviarA)) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="40"><Number>${xml(o.reenviarA)}</Number></Dial></Response>`;
  }
  if (!o.transcripcion) return '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Start><Transcription language="es" transcriptionEngine="Telnyx" transcriptionCallback="${xml(o.transcripcion)}"/></Start><Pause length="75"/></Response>`;
}
