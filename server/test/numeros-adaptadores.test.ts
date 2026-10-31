import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TelnyxNumeros, texmlLlamada, verificarFirmaTelnyx } from '../src/numeros/telnyx.js';
import { ErrorProveedor, NumeroNoDisponible, elegibleWhatsApp } from '../src/numeros/proveedor.js';
import { codigoDeTranscripcion, ErrorMeta, MetaGraph, motivoRegistro } from '../src/numeros/meta.js';
import { cotizar, tasaUsdCop, olvidarTasa } from '../src/numeros/tarifas.js';
import { config, erroresNumeroPropio, erroresNumeros } from '../src/config.js';

/**
 * Forma de las llamadas a las APIs reales (Telnyx v2 y Graph de Meta) con un fetch de prueba.
 * Confirma rutas, filtros, cuerpos y manejo de errores según su documentación oficial; no
 * reemplaza una prueba con credenciales reales.
 */
type Llamada = { url: string; method: string; body: any; headers: Record<string, string> };
function fetchFalso(respuestas: ((l: Llamada) => { status?: number; json: unknown } | undefined)[]) {
  const llamadas: Llamada[] = [];
  const f = (async (url: string, init: any = {}) => {
    const l = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers ?? {} };
    llamadas.push(l);
    for (const r of respuestas) {
      const x = r(l);
      if (x) return new Response(JSON.stringify(x.json), { status: x.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, llamadas };
}

describe('Telnyx (API v2)', () => {
  const disponible = { record_type: 'available_phone_number', phone_number: '+576015550199', reservable: true, region_information: [{ region_type: 'location', region_name: 'Bogota' }, { region_type: 'country_code', region_name: 'CO' }], cost_information: { upfront_cost: '1.00', monthly_cost: '13.50', currency: 'USD' }, features: [{ name: 'voice' }, { name: 'emergency' }] };

  it('busca con los filtros documentados y usa el costo que informa la API', async () => {
    const { f, llamadas } = fetchFalso([(l) => (l.url.includes('/available_phone_numbers') ? { json: { data: [disponible, { ...disponible, phone_number: '+576015550198', cost_information: {} }] } } : undefined)]);
    const t = new TelnyxNumeros('KEY_secreta', f);
    const r = await t.buscar({ pais: 'CO', tipo: 'local', localidad: 'Bogota' });
    const u = new URL(llamadas[0].url);
    expect(u.origin + u.pathname).toBe('https://api.telnyx.com/v2/available_phone_numbers');
    expect(u.searchParams.get('filter[country_code]')).toBe('CO');
    expect(u.searchParams.get('filter[phone_number_type]')).toBe('local');
    expect(u.searchParams.get('filter[locality]')).toBe('Bogota');
    expect(llamadas[0].headers.authorization).toBe('Bearer KEY_secreta');
    // Un número sin costo informado se descarta: nunca se inventa un precio.
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ numero: '+576015550199', localidad: 'Bogota', caracteristicas: ['voice', 'emergency'], costo: { activacion: 1, mensual: 13.5, moneda: 'USD' } });
  });

  it('reserva, ordena con el grupo de requisitos y la referencia, y detecta un número tomado', async () => {
    const { f, llamadas } = fetchFalso([
      (l) => (l.url.endsWith('/number_reservations') ? { json: { data: { id: 'res-1', status: 'success', phone_numbers: [{ phone_number: '+576015550199', status: 'success', expired_at: '2026-10-19T20:00:00Z' }] } } } : undefined),
      (l) => (l.url.endsWith('/number_orders') && l.body.customer_reference === 'tomado' ? { status: 422, json: { errors: [{ code: '10015', title: 'Phone number not available' }] } } : undefined),
      (l) => (l.url.endsWith('/number_orders') ? { json: { data: { id: 'ord-1', status: 'pending', requirements_met: false, phone_numbers: [{ id: 'x', phone_number: '+576015550199', requirements_status: 'requirement-info-under-review' }] } } } : undefined),
    ]);
    const t = new TelnyxNumeros('k', f);
    expect(await t.reservar('+576015550199')).toMatchObject({ id: 'res-1' });
    const o = await t.ordenar('+576015550199', { grupoId: 'grp-1', referencia: 'contratacion-1' });
    expect(o).toMatchObject({ id: 'ord-1', estado: 'pendiente', requisitos: 'en_revision' });
    const cuerpo = llamadas.find((l) => l.url.endsWith('/number_orders'))!.body;
    expect(cuerpo).toMatchObject({ phone_numbers: [{ phone_number: '+576015550199', requirement_group_id: 'grp-1' }], customer_reference: 'contratacion-1' });
    await expect(t.ordenar('+576015550199', { grupoId: null, referencia: 'tomado' })).rejects.toBeInstanceOf(NumeroNoDisponible);
  });

  it('lee requisitos regulatorios y los envía como documento, dirección y texto en un grupo', async () => {
    const { f, llamadas } = fetchFalso([
      (l) => (l.url.includes('/regulatory_requirements') ? { json: { data: [{ country_code: 'CO', regulatory_requirements: [
        { id: 'r1', name: 'Business name', field_type: 'textual', description: 'Nombre', acceptance_criteria: { max_length: '100' } },
        { id: 'r2', name: 'Address', field_type: 'address_id', description: 'Dirección', example: 'Calle 1' },
        { id: 'r3', name: 'Registration', field_type: 'document', description: 'Cámara de comercio' }] }] } } : undefined),
      (l) => (l.url.endsWith('/documents') ? { json: { data: { id: 'doc-1' } } } : undefined),
      (l) => (l.url.endsWith('/addresses') ? { json: { data: { id: 'adr-1' } } } : undefined),
      (l) => (l.url.endsWith('/requirement_groups') ? { json: { data: { id: 'grp-9', status: 'pending-approval' } } } : undefined),
    ]);
    const t = new TelnyxNumeros('k', f);
    const req = await t.requisitos('CO', 'local');
    expect(new URL(llamadas[0].url).searchParams.get('filter[action]')).toBe('ordering');
    expect(req.map((r) => r.campo)).toEqual(['textual', 'address', 'document']);
    const g = await t.enviarRequisitos('CO', 'local', [
      { id: 'r1', campo: 'textual', valor: 'Barbería' },
      { id: 'r2', campo: 'address', direccion: { nombre: 'A', apellido: 'J', empresa: 'B', direccion: 'Calle 5', ciudad: 'Bogotá' } },
      { id: 'r3', campo: 'document', archivo: { nombre: 'c.pdf', base64: 'JVBERi0=' } },
    ], 'ref-1');
    expect(g.grupoId).toBe('grp-9');
    expect(llamadas.find((l) => l.url.endsWith('/addresses'))!.body).toMatchObject({ country_code: 'CO', locality: 'Bogotá', business_name: 'B' });
    expect(llamadas.find((l) => l.url.endsWith('/requirement_groups'))!.body).toEqual({ country_code: 'CO', phone_number_type: 'local', action: 'ordering', customer_reference: 'ref-1',
      regulatory_requirements: [{ requirement_id: 'r1', field_value: 'Barbería' }, { requirement_id: 'r2', field_value: 'adr-1' }, { requirement_id: 'r3', field_value: 'doc-1' }] });
  });

  it('los errores no revelan la llave y distinguen credencial, reintento y definitivo', async () => {
    const t401 = new TelnyxNumeros('KEY_super_secreta', fetchFalso([() => ({ status: 401, json: { errors: [{ code: '10009', title: 'Authentication failed' }] } })]).f);
    const e = await t401.buscar({ pais: 'CO', tipo: 'local' }).catch((x) => x);
    expect(e).toBeInstanceOf(ErrorProveedor);
    expect(e.codigo).toBe('CREDENCIAL');
    expect(String(e.message)).not.toContain('KEY_super_secreta');
    const t503 = new TelnyxNumeros('k', fetchFalso([() => ({ status: 503, json: {} })]).f);
    expect((await t503.consultarOrden('ord-123456').catch((x) => x)).reintentable).toBe(true);
    const sinLlave = new TelnyxNumeros(undefined, fetchFalso([]).f);
    expect((await sinLlave.buscar({ pais: 'CO', tipo: 'local' }).catch((x) => x)).codigo).toBe('CREDENCIAL');
  });

  it('la liberación borra el número de la cuenta y tolera que ya no exista', async () => {
    const { f, llamadas } = fetchFalso([(l) => (l.method === 'DELETE' ? { status: 404, json: {} } : undefined)]);
    await new TelnyxNumeros('k', f).liberar('1293384261075731499');
    expect(llamadas[0]).toMatchObject({ method: 'DELETE', url: 'https://api.telnyx.com/v2/phone_numbers/1293384261075731499' });
  });

  it('verifica la firma Ed25519 sobre «timestamp|cuerpo» y rechaza repeticiones viejas', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const llave = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
    const cuerpo = '{"data":{"id":"1"}}';
    const ts = String(Math.floor(Date.now() / 1000));
    const firma = sign(null, Buffer.from(`${ts}|${cuerpo}`), privateKey).toString('base64');
    expect(verificarFirmaTelnyx(cuerpo, firma, ts, llave)).toBe(true);
    expect(verificarFirmaTelnyx(cuerpo + ' ', firma, ts, llave)).toBe(false);
    expect(verificarFirmaTelnyx(cuerpo, firma, String(Number(ts) - 3600), llave)).toBe(false);
    expect(verificarFirmaTelnyx(cuerpo, firma, ts, undefined)).toBe(false);
  });

  it('TeXML: transcribe en español, reenvía al celular o rechaza', () => {
    expect(texmlLlamada({ transcripcion: 'https://api/x?c=1&k=2' })).toContain('transcriptionCallback="https://api/x?c=1&amp;k=2"');
    expect(texmlLlamada({ transcripcion: 'u', reenviarA: '+573001112233' })).toContain('<Dial timeout="40"><Number>+573001112233</Number></Dial>');
    expect(texmlLlamada({})).toContain('<Reject/>');
  });
});

describe('Meta (Graph API)', () => {
  it('sigue la secuencia oficial: número, código por voz, verificación y registro con PIN', async () => {
    const { f, llamadas } = fetchFalso([
      (l) => (l.url.includes('/phone_numbers') && l.method === 'POST' ? { json: { id: '110200345501442' } } : undefined),
      (l) => (l.url.includes('/request_code') ? { json: { success: true } } : undefined),
      (l) => (l.url.includes('/verify_code?code=000000') ? { status: 400, json: { error: { code: 136025, message: 'invalid' } } } : undefined),
      (l) => (l.url.includes('/verify_code') ? { json: { success: true } } : undefined),
      (l) => (l.url.endsWith('/register') ? { json: { success: true } } : undefined),
      (l) => (l.url.includes('fields=display_phone_number') ? { json: { display_phone_number: '+57 601 5550199', verified_name: 'Barbería', name_status: 'PENDING_REVIEW', code_verification_status: 'VERIFIED', status: 'CONNECTED', quality_rating: 'GREEN' } } : undefined),
    ]);
    const m = new MetaGraph(f, 'v23.0');
    expect(await m.agregarNumero('102290129340398', 'TK', { cc: '57', numero: '6015550199', nombre: 'Barbería' })).toBe('110200345501442');
    expect(llamadas[0].body).toEqual({ cc: '57', phone_number: '6015550199', verified_name: 'Barbería' });
    await m.solicitarCodigo('110200345501442', 'TK');
    expect(llamadas[1].url).toBe('https://graph.facebook.com/v23.0/110200345501442/request_code?code_method=VOICE&language=es');
    expect(await m.verificarCodigo('110200345501442', 'TK', '000000')).toBe(false);
    expect(await m.verificarCodigo('110200345501442', 'TK', '123456')).toBe(true);
    await m.registrar('110200345501442', 'TK', '581063');
    expect(llamadas.at(-1)!.body).toEqual({ messaging_product: 'whatsapp', pin: '581063' });
    expect(await m.consultar('110200345501442', 'TK')).toMatchObject({ estado: 'CONNECTED', estadoNombre: 'PENDING_REVIEW' });
  });

  it('token vencido (190) es un error no reintentable; un límite (130429) sí se reintenta', async () => {
    const vencido = new MetaGraph(fetchFalso([() => ({ status: 401, json: { error: { code: 190 } } })]).f);
    const e1 = await vencido.registrar('1', 'TK', '123456').catch((x) => x);
    expect(e1).toBeInstanceOf(ErrorMeta);
    expect(e1.reintentable).toBe(false);
    const limite = new MetaGraph(fetchFalso([() => ({ status: 400, json: { error: { code: 130429 } } })]).f);
    expect((await limite.solicitarCodigo('1', 'TK').catch((x) => x)).reintentable).toBe(true);
  });

  it('número propio: código por SMS o llamada en la WABA de la plataforma y deregister al desconectar', async () => {
    const { f, llamadas } = fetchFalso([() => ({ json: { success: true } })]);
    const m = new MetaGraph(f, 'v23.0');
    await m.solicitarCodigo('110200345501442', 'TK-PLATAFORMA', 'SMS');
    expect(llamadas[0].url).toBe('https://graph.facebook.com/v23.0/110200345501442/request_code?code_method=SMS&language=es');
    expect(llamadas[0].headers.authorization).toBe('Bearer TK-PLATAFORMA');
    await m.solicitarCodigo('110200345501442', 'TK-PLATAFORMA', 'VOICE');
    expect(llamadas[1].url).toContain('code_method=VOICE');
    await m.desregistrar('110200345501442', 'TK-PLATAFORMA');
    expect(llamadas[2]).toMatchObject({ method: 'POST', url: 'https://graph.facebook.com/v23.0/110200345501442/deregister' });
  });

  it('clasifica los errores del registro sin exponer el texto de Meta', async () => {
    const error = async (json: unknown, status = 400) => new MetaGraph(fetchFalso([() => ({ status, json })]).f).agregarNumero('1', 'TK', { cc: '57', numero: '3001234567', nombre: 'X' }).catch((x) => x);
    const enUso = await error({ error: { code: 100, message: 'Invalid parameter', error_user_msg: 'This phone number is already registered to a WhatsApp account.' } });
    expect(motivoRegistro(enUso)).toBe('NUMERO_EN_USO');
    // El mensaje que puede llegar a la interfaz nunca trae el texto de Meta.
    expect(enUso.message).not.toMatch(/already registered/);
    expect(motivoRegistro(await error({ error: { code: 100, error_subcode: 2388012, message: 'exists' } }))).toBe('NUMERO_YA_EN_LA_CUENTA');
    expect(motivoRegistro(await error({ error: { code: 136024 } }))).toBe('YA_VERIFICADO');
    expect(motivoRegistro(await error({ error: { code: 133016 } }))).toBe('DEMASIADOS_INTENTOS');
    expect(motivoRegistro(await error({ error: { code: 133005 } }))).toBe('PIN_EXISTENTE');
    expect(motivoRegistro(await error({ error: { code: 100, error_user_msg: 'The WhatsApp Business Account has reached the maximum number of phone numbers.' } }))).toBe('LIMITE_NUMEROS');
    expect(motivoRegistro(await error({ error: { code: 100, error_user_msg: 'The verified_name is not acceptable.' } }))).toBe('NOMBRE_RECHAZADO');
    expect(motivoRegistro(await error({ error: { code: 100, error_user_msg: 'Invalid phone number.' } }))).toBe('NUMERO_INVALIDO');
    expect(motivoRegistro(await error({ error: { code: 190 } }, 401))).toBe('ACCESO');
    expect(motivoRegistro(await error({ error: { code: 1 } }, 500))).toBe('TEMPORAL');
    // Código equivocado: false; código vencido: se informa como tal.
    const v = new MetaGraph(fetchFalso([() => ({ status: 400, json: { error: { code: 136025, message: 'Verify code error' } } })]).f);
    expect(await v.verificarCodigo('1', 'TK', '000000')).toBe(false);
    const vencido = new MetaGraph(fetchFalso([() => ({ status: 400, json: { error: { code: 100, error_user_msg: 'The verification code has expired.' } } })]).f);
    expect(motivoRegistro(await vencido.verificarCodigo('1', 'TK', '000000').catch((x) => x))).toBe('CODIGO_VENCIDO');
  });

  it('en producción, con token de WhatsApp, la WABA de la plataforma es obligatoria y numérica', () => {
    const base = { ...config, dev: false, whatsapp: { ...config.whatsapp, accessToken: 'EAAG', plataformaWabaId: undefined } };
    expect(erroresNumeroPropio(base as typeof config)[0]).toMatch(/WHATSAPP_PLATFORM_WABA_ID/);
    expect(erroresNumeroPropio({ ...base, whatsapp: { ...base.whatsapp, plataformaWabaId: 'abc' } } as typeof config)[0]).toMatch(/numérico/);
    expect(erroresNumeroPropio({ ...base, whatsapp: { ...base.whatsapp, plataformaWabaId: '102290129340398' } } as typeof config)).toEqual([]);
    expect(erroresNumeroPropio({ ...base, whatsapp: { ...base.whatsapp, accessToken: undefined } } as typeof config)).toEqual([]);
  });

  it('extrae el código dictado en cifras o en palabras, sin adivinar', () => {
    expect(codigoDeTranscripcion('Su código de WhatsApp es 1 2 3 4 5 6')).toBe('123456');
    expect(codigoDeTranscripcion('tu código es uno, dos, tres, cuatro, cinco, seis. Repito')).toBe('123456');
    expect(codigoDeTranscripcion('código 482-913')).toBe('482913');
    expect(codigoDeTranscripcion('Siete ocho cero nueve 1 2')).toBe('780912');
    expect(codigoDeTranscripcion('hola, este es un mensaje de WhatsApp')).toBeNull();
    expect(codigoDeTranscripcion('1 2 3 y luego 4 5')).toBeNull();
  });
});

describe('Modelo comercial', () => {
  const n = { costo: { activacion: 1, mensual: 13.5, moneda: 'USD' } };
  const tasa = { valor: 3174.67, fuente: 'TRM' as const, vigente_desde: '2026-10-17' };

  it('convierte con la TRM y el colchón, aplica el margen y lo muestra incluido', () => {
    const c = structuredClone(config);
    c.numeros.comercial = { ...c.numeros.comercial, colchonCambioPct: 5, margenPct: 20, cargoActivacionCop: 15000 };
    c.documentos.responsableIva = '0';
    const q = cotizar(n, { nombre: 'telnyx', entorno: 'real' }, tasa, c);
    // 13,5 × 3174,67 × 1,05 = 45 000,95 → con 20 % = 54 001,1 → centena arriba 54 100.
    expect(q.numero.mensual).toBe(54100);
    expect(q.numero.activacion).toBe(4100);
    expect(q.margen.mensual).toBe(54100 - 45001);
    expect(q.total_hoy).toBe(4100 + 54100 + 15000);
    expect(q.total_mensual).toBe(54100);
    expect(q.iva).toMatchObject({ regimen: 'NO_RESPONSABLE', hoy: 0 });
  });

  it('suma el IVA solo si el emisor es responsable', () => {
    const c = structuredClone(config);
    c.numeros.comercial = { ...c.numeros.comercial, colchonCambioPct: 0, margenPct: 0, cargoActivacionCop: 0 };
    c.documentos.responsableIva = '1';
    c.documentos.ivaPct = 19;
    const q = cotizar({ costo: { activacion: 0, mensual: 10, moneda: 'USD' } }, { nombre: 'telnyx', entorno: 'real' }, { valor: 4000, fuente: 'CONFIGURADA', vigente_desde: null }, c);
    expect(q.total_mensual).toBe(40000 + 7600);
    expect(q.iva.pct).toBe(19);
  });

  it('usa la TRM oficial de datos.gov.co y no cotiza sin tasa confirmada', async () => {
    const fija = config.numeros.comercial.tasaUsdCop;
    config.numeros.comercial.tasaUsdCop = null;
    olvidarTasa();
    try {
      const ok = await tasaUsdCop((async (url: string) => {
        expect(String(url)).toContain('datos.gov.co/resource/32sa-8pi3.json');
        return new Response(JSON.stringify([{ valor: '3174.67', unidad: 'COP', vigenciadesde: '2026-10-17T00:00:00.000' }]));
      }) as any);
      expect(ok).toEqual({ valor: 3174.67, fuente: 'TRM', vigente_desde: '2026-10-17' });
      olvidarTasa();
      expect(await tasaUsdCop((async () => new Response('[]', { status: 500 })) as any)).toBeNull();
    } finally {
      config.numeros.comercial.tasaUsdCop = fija;
      olvidarTasa();
    }
  });

  it('elegibilidad: exige voz y excluye los gratuitos', () => {
    expect(elegibleWhatsApp({ tipo: 'local', caracteristicas: ['voice'] }).ok).toBe(true);
    expect(elegibleWhatsApp({ tipo: 'local', caracteristicas: ['sms'] }).ok).toBe(false);
    expect(elegibleWhatsApp({ tipo: 'toll_free', caracteristicas: ['voice', 'sms'] }).ok).toBe(false);
  });

  it('la configuración de Telnyx exige llave, llave pública y aplicación de voz', () => {
    const c = structuredClone(config);
    c.numeros.proveedor = 'telnyx';
    c.numeros.telnyx = { apiKey: undefined, llavePublica: undefined, conexionVozId: undefined };
    expect(erroresNumeros(c).join(' ')).toMatch(/TELNYX_API_KEY.*TELNYX_PUBLIC_KEY.*TELNYX_TEXML_APP_ID/);
  });
});
