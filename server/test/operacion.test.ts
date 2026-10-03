import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, simularWhatsApp, type Env } from './helpers.js';
import { drain } from '../src/worker/jobs.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { digitoVerificacionNit } from '../src/adapters/fiscal.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Operación diaria: hilo conversación → venta → factura → entrega (PRO-SW-002 fig. 09),
 * escalamiento con continuidad (fig. 08) y ciclo de suscripción.
 */
let E: Env;
let admin: ReturnType<typeof api>;
beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

const wa = (from: string, texto: string, nombre = 'Cliente') => simularWhatsApp(E.db, from, texto, nombre, 'op');

describe('Hilo completo por WhatsApp', () => {
  it('conversación → venta confirmada → factura validada → entregada por WhatsApp, todo auditado', async () => {
    const from = '573207770001';
    await wa(from, 'hola', 'Nicolás Parada');
    await wa(from, 'sí');
    await wa(from, 'quiero comprar 2 cera para peinar');
    await wa(from, 'sí');
    const orden = await E.db.withTenant(E.A, async (tx) => (await tx.query(
      `SELECT o.id, o.origen, o.total, f.estado, f.cufe, f.entrega_whatsapp FROM "order" o JOIN customer c ON c.id=o.customer_id
       LEFT JOIN fiscal_document f ON f.order_id=o.id WHERE c.telefono=$1`, [`+${from}`])).rows[0]);
    expect(orden.origen).toBe('AGENTE');
    expect(Number(orden.total)).toBe(64000);
    expect(orden.estado).toBe('ENTREGADO');
    expect(orden.cufe).toMatch(/^[0-9a-f]{96}$/);
    expect(orden.entrega_whatsapp).toBe('ENVIADO');
    const hilo = await E.db.withTenant(E.A, async (tx) => (await tx.query(
      `SELECT m.remitente, m.contenido FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1 ORDER BY m.creado_en`, [`+${from}`])).rows);
    expect(hilo.at(-1).contenido).toMatch(/factura electrónica FE-\d+/);
    const detalle = await admin.get(`/ventas/${orden.id}`);
    const acciones = detalle.body.traza.map((t: any) => t.accion);
    expect(acciones).toEqual(expect.arrayContaining(['factura.solicitar', 'factura.validada', 'documento.entregar']));
    expect(detalle.body.recibos.some((r: any) => r.herramienta === 'registrar_venta' && r.decision === 'CONFIRMADA')).toBe(true);
  });

  it('factura rechazada (#1042) → corregir NIT → reintentar → validada', async () => {
    const v = await admin.get('/ventas?estado_fiscal=RECHAZADO');
    const o = v.body.find((x: any) => x.numero === 1042);
    expect(o).toBeTruthy();
    const d = await admin.get(`/ventas/${o.id}`);
    const doc = d.body.documentos[0];
    expect(doc.motivo_rechazo).toMatch(/FAK24/);
    await admin.patch(`/clientes/${d.body.customer_id}`, { numero_documento: `900555666-${digitoVerificacionNit('900555666')}` });
    expect((await admin.post(`/facturacion/${doc.id}/reintentar`)).status).toBe(200);
    await drain(E.db);
    const d2 = await admin.get(`/ventas/${o.id}`);
    expect(['VALIDADO', 'ENTREGADO']).toContain(d2.body.documentos[0].estado);
  });

  it('anular una venta facturada emite nota crédito (nunca se borra un documento validado)', async () => {
    const v = (await admin.get('/ventas')).body.find((x: any) => x.estado_fiscal === 'ENTREGADO' && x.estado === 'CONFIRMADA');
    expect((await admin.post(`/ventas/${v.id}/anular`, { motivo: 'x' })).status).toBe(400);
    const r = await admin.post(`/ventas/${v.id}/anular`, { motivo: 'Cliente devolvió el producto' });
    expect(r.status).toBe(200);
    expect(r.body.nota_credito).toBeTruthy();
    await drain(E.db);
    const d = await admin.get(`/ventas/${v.id}`);
    expect(d.body.documentos.map((x: any) => x.tipo)).toEqual(['FACTURA', 'NOTA_CREDITO']);
    expect(['VALIDADO', 'ENTREGADO']).toContain(d.body.documentos[1].estado);
  });

  it('recepción (sin invoice:void) no puede anular ventas facturadas', async () => {
    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    const v = (await admin.get('/ventas')).body.find((x: any) => x.estado === 'CONFIRMADA');
    expect((await laura.post(`/ventas/${v.id}/anular`, { motivo: 'intento de anulación' })).status).toBe(403);
  });
});

describe('Escalamiento y continuidad', () => {
  it('reclamo → radicado asignado a recepción → la IA calla → responde la asesora → cierre', async () => {
    const from = '573207770002';
    await wa(from, 'hola', 'Paula Méndez');
    await wa(from, 'sí');
    await wa(from, 'quiero una devolución, el aceite llegó abierto');
    const bandeja = await admin.get('/conversaciones?filtro=escaladas');
    const c = bandeja.body.conversaciones.find((x: any) => x.telefono === `+${from}`);
    expect(c.radicado).toMatch(/^RAD-\d{4}-\d{5}$/);
    expect(c.asignado).toBe('Laura Pabón');
    const detalle = await admin.get(`/conversaciones/${c.id}`);
    expect(detalle.body.caso.resumen_ia).toMatch(/Motivo del escalamiento/);

    // Mientras hay una persona al frente, la IA no responde.
    const antes = detalle.body.mensajes.length;
    await wa(from, '¿hola? sigo esperando');
    const d2 = await admin.get(`/conversaciones/${c.id}`);
    expect(d2.body.mensajes.length).toBe(antes + 1);
    expect(d2.body.mensajes.at(-1).remitente).toBe('CUSTOMER');

    // El barbero no ve casos ni conversaciones (sin permiso).
    const andres = api(E.app, await login(E.app, ...CRED.andres), 'elparche');
    expect((await andres.get(`/conversaciones/${c.id}`)).status).toBe(403);

    const laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
    const sug = await laura.post(`/conversaciones/${c.id}/sugerencia`);
    expect(sug.body.sugerencia).toMatch(/Paula/);
    expect((await laura.post(`/conversaciones/${c.id}/responder`, { texto: 'Hola Paula, ya gestionamos tu devolución.' })).status).toBe(200);
    const d3 = await laura.get(`/conversaciones/${c.id}`);
    expect(d3.body.caso.estado).toBe('EN_ATENCION');
    expect(d3.body.caso.primera_respuesta_en).toBeTruthy();
    expect((await laura.post(`/conversaciones/${c.id}/cerrar`, { motivo: 'Devolución aprobada' })).status).toBe(200);
    const d4 = await admin.get(`/conversaciones/${c.id}`);
    expect(d4.body.estado).toBe('CERRADA');
    expect(d4.body.resuelta_por).toBe('PERSONA');
  });
});

describe('Cierre por inactividad', () => {
  it('una conversación atendida solo por la IA y quieta 12 h cuenta como resuelta por el agente; una escalada no', async () => {
    const { HANDLERS } = await import('../src/worker/jobs.js');
    await E.db.withPlatform((tx) => tx.query(`UPDATE conversation SET ultimo_mensaje_cliente_en = now() - interval '13 hours' WHERE tenant_id=$1`, [E.A]));
    await HANDLERS.cerrar_inactivas(E.db, null, {}, {});
    const r = await E.db.withTenant(E.A, async (tx) => (await tx.query(
      `SELECT v.estado, v.resuelta_por, EXISTS (SELECT 1 FROM support_case k WHERE k.conversation_id=v.id AND k.estado <> 'CERRADO') AS caso_abierto FROM conversation v`)).rows);
    expect(r.filter((x: any) => x.caso_abierto).every((x: any) => x.estado !== 'CERRADA')).toBe(true);
    expect(r.some((x: any) => x.resuelta_por === 'AGENTE')).toBe(true);
  });
});

describe('Suscripción', () => {
  it('suspendida: lectura sí, escritura no, y el canal deja de atender', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET estado='SUSPENDIDA' WHERE tenant_id=$1`, [E.A]));
    expect((await admin.get('/clientes')).status).toBe(200);
    const w = await admin.post('/clientes', { nombre: 'Nuevo' });
    expect(w.status).toBe(423);
    const from = '573207770003';
    await wa(from, 'hola');
    const resp = await E.db.withTenant(E.A, async (tx) => (await tx.query(
      `SELECT count(*)::int n FROM message m JOIN conversation v ON v.id=m.conversation_id JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1 AND m.remitente <> 'CUSTOMER'`, [`+${from}`])).rows[0].n);
    expect(resp).toBe(0);
    await E.db.withPlatform((tx) => tx.query(`UPDATE subscription SET estado='ACTIVA' WHERE tenant_id=$1`, [E.A]));
  });

  it('medidor de consumo con proyección visible para el administrador', async () => {
    const yo = await admin.get('/yo');
    expect(yo.body.consumo.tokens_ia.usado).toBeGreaterThan(0);
    expect(yo.body.consumo.tokens_ia.cuota).toBe(1_500_000);
    expect(yo.body.consumo.documentos.usado).toBeGreaterThan(40);
  });

  it('cuota de IA agotada con política LIMITAR: se escala a una persona en vez de gastar', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE usage_record SET cantidad = 2000000 WHERE tenant_id=$1 AND metrica='tokens_ia'`, [E.A]));
    const from = '573207770004';
    await wa(from, 'hola'); await wa(from, 'sí'); await wa(from, 'cuánto vale el corte clásico');
    const k = await E.db.withTenant(E.A, async (tx) => (await tx.query(
      `SELECT k.motivo FROM support_case k JOIN conversation v ON v.id=k.conversation_id JOIN customer c ON c.id=v.customer_id WHERE c.telefono=$1`, [`+${from}`])).rows[0]);
    expect(k.motivo).toMatch(/Cuota de IA/);
  });
});

describe('Auditoría', () => {
  it('se consulta y exporta, y la exportación también queda registrada', async () => {
    const a = await admin.get('/auditoria?tipo=ia');
    expect(a.body.length).toBeGreaterThan(0);
    const csv = await E.app.inject({ method: 'GET', url: '/api/t/auditoria.csv', headers: { cookie: await login(E.app, ...CRED.admin), 'x-tenant-slug': 'elparche' } });
    expect(csv.body.split('\n')[0]).toMatch(/creado_en,actor_tipo/);
    const ev = await admin.get('/auditoria?q=auditoria.exportar');
    expect(ev.body.length).toBe(1);
  });
});
