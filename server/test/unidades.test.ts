import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aCentavos, calcularLinea, sumarLineas } from '../src/lib/money.js';
import { localToUtc, rangoDia, utcToLocal, zonaValida } from '../src/lib/time.js';
import { transicionValida, ventanaAbierta } from '../src/modules/conversations.js';
import { crearLimitador } from '../src/http/limits.js';
import { validarConfiguracion, config } from '../src/config.js';
import { checkoutUrl, firmaIntegridadWompi, verificarEventoWompi } from '../src/adapters/payments.js';
import { parseWhatsAppWebhook, WhatsAppCloudAdapter } from '../src/adapters/channel.js';
import { csv } from '../src/modules/exports.js';
import { normalizarTelefono } from '../src/modules/customers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('Dinero en centavos', () => {
  it('precio con IVA incluido, cantidad y descuento: base + IVA = total exacto', () => {
    const l = calcularLinea({ precioUnitario: 32000, cantidad: 3, ivaPct: 19, descuentoPct: 10 });
    expect(l.bruto).toBe(9_600_000);
    expect(l.descuento).toBe(960_000);
    expect(l.total).toBe(8_640_000);
    expect(l.base).toBe(7_260_504);
    expect(l.base + l.impuesto).toBe(l.total);
  });
  it('sumar muchas líneas no acumula error de coma flotante', () => {
    const lineas = Array.from({ length: 1000 }, () => calcularLinea({ precioUnitario: 0.1, cantidad: 3, ivaPct: 0 }));
    expect(sumarLineas(lineas).total).toBe(30_000);
    expect(aCentavos('25000.50')).toBe(2_500_050);
  });
  it('rechaza cantidades no positivas y limita el descuento a 0–100 %', () => {
    expect(() => calcularLinea({ precioUnitario: 1000, cantidad: 0, ivaPct: 0 })).toThrow();
    expect(calcularLinea({ precioUnitario: 1000, cantidad: 1, ivaPct: 0, descuentoPct: 150 }).total).toBe(0);
  });
});

describe('Zona horaria del negocio', () => {
  it('Bogotá: medianoche local es 05:00 UTC y la conversión es reversible', () => {
    expect(localToUtc('2026-03-10', '00:00', 'America/Bogota').toISOString()).toBe('2026-03-10T05:00:00.000Z');
    expect(utcToLocal(new Date('2026-03-10T05:30:00Z'), 'America/Bogota')).toEqual({ fecha: '2026-03-10', hora: '00:30', dia: 'mar' });
  });
  it('zonas con horario de verano usan el desfase vigente en la fecha (Nueva York)', () => {
    expect(localToUtc('2026-01-15', '09:00', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(localToUtc('2026-07-15', '09:00', 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z');
  });
  it('el día local cubre 24 h y una zona inválida cae a la de por defecto', () => {
    const r = rangoDia('2026-05-01', 'America/Bogota');
    expect(r.hasta.getTime() - r.desde.getTime()).toBe(86_400_000);
    expect(zonaValida('Marte/Olympus')).toBe('America/Bogota');
  });
});

describe('Máquina de estados del radicado', () => {
  it.each([
    ['EN_COLA', 'ASIGNADO', true], ['EN_COLA', 'CERRADO', true], ['ASIGNADO', 'EN_ATENCION', true], ['EN_ATENCION', 'CERRADO', true], ['CERRADO', 'ASIGNADO', true],
    ['CERRADO', 'EN_ATENCION', false], ['CERRADO', 'CERRADO', false], ['EN_ATENCION', 'EN_COLA', false], ['EN_ATENCION', 'ASIGNADO', false],
  ] as const)('%s → %s: %s', (de, a, ok) => expect(transicionValida(de, a)).toBe(ok));

  it('ventana de servicio de WhatsApp: 24 horas desde el último mensaje del cliente', () => {
    const ahora = Date.parse('2026-05-02T12:00:00Z');
    expect(ventanaAbierta('2026-05-01T12:00:01Z', ahora)).toBe(true);
    expect(ventanaAbierta('2026-05-01T11:59:59Z', ahora)).toBe(false);
    expect(ventanaAbierta(null, ahora)).toBe(false);
  });
});

describe('Límite de tasa', () => {
  it('bloquea al superar el máximo en la ventana y libera después', () => {
    let t = 0;
    const permitir = crearLimitador([{ prefijo: '/api/auth/', metodo: 'POST', max: 3, ventanaS: 60 }], () => t);
    expect([1, 2, 3].map(() => permitir('1.1.1.1', 'POST', '/api/auth/login'))).toEqual([true, true, true]);
    expect(permitir('1.1.1.1', 'POST', '/api/auth/login')).toBe(false);
    expect(permitir('2.2.2.2', 'POST', '/api/auth/login')).toBe(true); // otra IP, otro cupo
    expect(permitir('1.1.1.1', 'GET', '/api/auth/sesion')).toBe(true); // sin regla
    t = 61_000;
    expect(permitir('1.1.1.1', 'POST', '/api/auth/login')).toBe(true);
  });
});

describe('Validación de configuración', () => {
  it('producción sin secretos ni base no arranca; los simuladores no se cuelan', () => {
    const prod = { ...config, dev: false, simuladores: false, appKey: '', databaseUrl: undefined, publicUrl: 'http://x', llm: { ...config.llm, provider: 'mock' as const }, pagos: { ...config.pagos, proveedor: 'simulada' as const } };
    const { errores } = validarConfiguracion(prod);
    expect(errores.join('\n')).toMatch(/APP_KEY/);
    expect(errores.join('\n')).toMatch(/DATABASE_URL/);
    expect(errores.join('\n')).toMatch(/https/);
    expect(errores.join('\n')).toMatch(/LLM_PROVIDER=mock/);
    expect(errores.join('\n')).toMatch(/PAGOS_PROVEEDOR=simulada/);
  });
  it('Wompi en producción exige llaves de producción completas', () => {
    const c = { ...config, pagos: { ...config.pagos, proveedor: 'wompi' as const, wompi: { entorno: 'produccion' as const, llavePublica: 'pub_test_abc', secretoIntegridad: 'x', secretoEventos: undefined } } };
    const e = validarConfiguracion(c).errores.join('\n');
    expect(e).toMatch(/WOMPI_SECRETO_EVENTOS/);
    expect(e).toMatch(/pub_prod_/);
  });
});

describe('Wompi: firmas', () => {
  it('firma de integridad = SHA-256(referencia + centavos + moneda [+ expiración] + secreto)', () => {
    expect(firmaIntegridadWompi('sk8-438k4-xmxm392-sn2m', 2490000, 'COP', 'prod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6')).toBe(sha('sk8-438k4-xmxm392-sn2m2490000COPprod_integrity_Z5mMke9x0k8gpErbDqwrJXMqsI6SFli6'));
    expect(firmaIntegridadWompi('r', 100, 'COP', 's', '2026-01-01T00:00:00.000Z')).toBe(sha('r100COP2026-01-01T00:00:00.000Zs'));
  });
  it('el checkout lleva llave pública, monto en centavos, referencia y firma', () => {
    const url = new URL(checkoutUrl({ proveedor: 'wompi', entorno: 'sandbox', llavePublica: 'pub_test_x', secretoIntegridad: 'sec' }, { referencia: 'PL-1', montoCentavos: 5_000_000, redirectUrl: 'https://a.co/pago/resultado' }));
    expect(url.origin + url.pathname).toBe('https://checkout.wompi.co/p/');
    expect(url.searchParams.get('amount-in-cents')).toBe('5000000');
    expect(url.searchParams.get('signature:integrity')).toBe(firmaIntegridadWompi('PL-1', 5_000_000, 'COP', 'sec'));
  });
  it('evento: checksum válido se acepta; cualquier alteración se rechaza', () => {
    const cuenta = { proveedor: 'wompi' as const, entorno: 'sandbox' as const, secretoEventos: 'prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z' };
    const ev = {
      event: 'transaction.updated', data: { transaction: { id: '1234-1610641025-49201', amount_in_cents: 4490000, reference: 'MZQ3X2DE2SMX', currency: 'COP', status: 'APPROVED' } },
      signature: { properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'], checksum: '' }, timestamp: 1530291411,
    };
    ev.signature.checksum = sha('1234-1610641025-49201APPROVED44900001530291411prod_events_OcHnIzeBl5socpwByQ4hA52Em3USQ93Z').toUpperCase();
    expect(verificarEventoWompi(cuenta, ev)).toMatchObject({ referencia: 'MZQ3X2DE2SMX', estado: 'APROBADO', montoCentavos: 4490000 });
    const alterado = structuredClone(ev);
    alterado.data.transaction.amount_in_cents = 100;
    expect(verificarEventoWompi(cuenta, alterado)).toBeNull();
    expect(verificarEventoWompi({ ...cuenta, secretoEventos: 'otro' }, ev)).toBeNull();
  });
});

describe('WhatsApp: webhook y errores del proveedor', () => {
  it('separa mensajes por tipo y estados de entrega', () => {
    const r = parseWhatsAppWebhook({ entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '111' }, contacts: [{ wa_id: '57300', profile: { name: 'Ana' } }],
      messages: [
        { id: 'a', from: '57300', timestamp: '1700000000', type: 'text', text: { body: 'hola' } },
        { id: 'b', from: '57300', type: 'image', image: { id: 'm1', mime_type: 'image/jpeg', caption: 'mi comprobante' } },
        { id: 'c', from: '57300', type: 'audio', audio: { id: 'm2' } },
        { id: 'd', from: '57300', type: 'reaction', reaction: { emoji: '👍' } },
        { id: 'e', from: '57300', type: 'unsupported' },
      ],
      statuses: [{ id: 'wamid.x', status: 'failed', timestamp: '1700000001', errors: [{ code: 131047, title: 'Re-engagement message' }] }, { id: 'wamid.y', status: 'deleted' }],
    } }] }] });
    expect(r.mensajes.map((m) => [m.id, m.tipo])).toEqual([['a', 'TEXTO'], ['b', 'MEDIA'], ['c', 'MEDIA'], ['e', 'NO_SOPORTADO']]);
    expect(r.mensajes[0].nombre).toBe('Ana');
    expect(r.mensajes[0].ocurridoEn?.toISOString()).toBe('2023-11-14T22:13:20.000Z');
    expect(r.mensajes[1].texto).toBe('[una imagen] mi comprobante');
    expect(r.estados).toEqual([expect.objectContaining({ idExterno: 'wamid.x', estado: 'FALLIDO', error: expect.stringMatching(/24 horas/) })]);
  });

  it('clasifica errores de Meta: límite de tasa se reintenta; ventana cerrada no', async () => {
    const tokenPrevio = config.whatsapp.accessToken;
    config.whatsapp.accessToken = 'token-de-prueba';
    const respuesta = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
    try {
      const ok = await new WhatsAppCloudAdapter(respuesta(200, { messages: [{ id: 'wamid.OK' }] }) as any).sendText('123456', '57300', 'hola');
      expect(ok).toEqual({ ok: true, idExterno: 'wamid.OK' });
      const limite = await new WhatsAppCloudAdapter(respuesta(400, { error: { code: 130429 } }) as any).sendText('123456', '57300', 'hola');
      expect(limite).toMatchObject({ ok: false, reintentable: true });
      const ventana = await new WhatsAppCloudAdapter(respuesta(400, { error: { code: 131047 } }) as any).sendText('123456', '57300', 'hola');
      expect(ventana).toMatchObject({ ok: false, reintentable: false, error: expect.stringMatching(/24 horas/) });
      const caido = await new WhatsAppCloudAdapter((async () => { throw new TypeError('fetch failed'); }) as any).sendText('123456', '57300', 'hola');
      expect(caido).toMatchObject({ ok: false, reintentable: true });
    } finally {
      config.whatsapp.accessToken = tokenPrevio;
    }
  });

  it('en producción, sin token, no simula: el envío falla con un motivo claro', async () => {
    const previo = config.simuladores;
    config.simuladores = false;
    try {
      const r = await new WhatsAppCloudAdapter().sendText('123456', '57300', 'hola');
      expect(r).toMatchObject({ ok: false, reintentable: false, error: expect.stringMatching(/pendiente de conectar/) });
    } finally {
      config.simuladores = previo;
    }
  });
});

describe('Datos de entrada y salida', () => {
  it('normaliza teléfonos colombianos y conserva indicativos extranjeros', () => {
    expect(normalizarTelefono('300 123 4567')).toBe('+573001234567');
    expect(normalizarTelefono('(300) 123-4567')).toBe('+573001234567');
    expect(normalizarTelefono('573001234567')).toBe('+573001234567');
    expect(normalizarTelefono('+1 415 555 0100')).toBe('+14155550100');
  });
  it('CSV: separador «;», comillas y fórmulas neutralizadas', () => {
    const s = csv([['a', 'A'], ['b', 'B']], [{ a: '=HYPERLINK("x")', b: 'uno;dos' }]);
    expect(s.charCodeAt(0)).toBe(0xfeff);
    expect(s).toContain(`"'=HYPERLINK(""x"")";"uno;dos"`);
  });
});
