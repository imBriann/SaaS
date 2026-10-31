import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { drain } from '../src/worker/jobs.js';
import { addDays, localToUtc, todayLocal } from '../src/lib/time.js';
import { digitoVerificacionNit, setFiscalProvider, SandboxFiscalProvider, SinProveedorFiscal } from '../src/adapters/fiscal.js';

/** Agenda con concurrencia, ventas con descuentos e inventario, importación, exportación y facturación. */
let E: Env;
let admin: ReturnType<typeof api>;
let cookieAdmin: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  // Estas pruebas recorren la facturación electrónica: el interruptor (apagado por defecto) se enciende aquí.
  config.fiscal.dianHabilitada = true;
  E = await setup();
  cookieAdmin = await login(E.app, ...CRED.admin);
  admin = api(E.app, cookieAdmin, 'elparche');
  const prods = (await admin.get('/productos')).body;
  ids.corte = prods.find((p: any) => p.nombre === 'Corte clásico').id;
  ids.cera = prods.find((p: any) => p.nombre === 'Cera para peinar').id;
  ids.aceite = prods.find((p: any) => p.nombre === 'Aceite para barba').id;
  ids.cliente = (await admin.get('/clientes?q=Mateo')).body.clientes[0].id;
  ids.recurso = (await admin.get('/agenda/recursos')).body.find((r: any) => r.nombre === 'Andrés').id;
});
afterAll(async () => { setFiscalProvider(new SandboxFiscalProvider()); await E.app.close(); await E.db.close(); });

/** Un martes futuro a las 10:00 (todos los barberos trabajan los martes). */
function proximoMartes(hora = '10:00') {
  let f = addDays(todayLocal(), 2);
  while (new Date(`${f}T12:00:00Z`).getUTCDay() !== 2) f = addDays(f, 1);
  return localToUtc(f, hora, 'America/Bogota').toISOString();
}

describe('Agenda', () => {
  it('dos reservas simultáneas de la misma franja: una se crea y la otra recibe alternativas cercanas', async () => {
    const inicio = proximoMartes('10:00');
    const cuerpo = { customer_id: ids.cliente, product_id: ids.corte, resource_id: ids.recurso, inicio };
    const [a, b] = await Promise.all([admin.post('/agenda/citas', cuerpo), admin.post('/agenda/citas', cuerpo)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const rechazo = a.status === 409 ? a : b;
    expect(rechazo.body.error.message).toMatch(/ya no está disponible/);
    const alt = rechazo.body.error.details.alternativas;
    expect(alt.length).toBeGreaterThan(0);
    expect(alt.every((s: any) => s.inicio !== inicio)).toBe(true);
    // Las alternativas son las más cercanas a la hora pedida.
    expect(Math.abs(new Date(alt[0].inicio).getTime() - new Date(inicio).getTime())).toBeLessThanOrEqual(60 * 60_000);
    const n = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT count(*)::int n FROM appointment WHERE resource_id=$1 AND inicio=$2 AND estado<>'CANCELADA'`, [ids.recurso, inicio])).rows[0].n);
    expect(n).toBe(1);
  });

  it('reprogramar: a una franja ocupada se rechaza con alternativas; a una libre mueve la misma cita', async () => {
    const ocupada = proximoMartes('15:00');
    await admin.post('/agenda/citas', { customer_id: ids.cliente, product_id: ids.corte, resource_id: ids.recurso, inicio: ocupada });
    const cita = (await admin.post('/agenda/citas', { customer_id: ids.cliente, product_id: ids.corte, resource_id: ids.recurso, inicio: proximoMartes('16:00') })).body;
    const choque = await admin.post(`/agenda/citas/${cita.id}/reprogramar`, { inicio: ocupada, resource_id: ids.recurso });
    expect(choque.status).toBe(409);
    expect(choque.body.error.details.alternativas.length).toBeGreaterThan(0);
    const ok = await admin.post(`/agenda/citas/${cita.id}/reprogramar`, { inicio: proximoMartes('17:00'), resource_id: ids.recurso });
    expect(ok.status).toBe(200);
    // Moverla a su propia franja actual es válido (no choca consigo misma).
    expect((await admin.post(`/agenda/citas/${cita.id}/reprogramar`, { inicio: proximoMartes('17:00'), resource_id: ids.recurso })).status).toBe(200);
    // Los recordatorios los calcula el ciclo proactivo sobre la hora vigente: al mover la cita se reinician.
    const movida = (await E.db.withPlatform(async (tx) => (await tx.query(`SELECT inicio, recordatorios, reprogramada_desde FROM appointment WHERE id=$1`, [cita.id])).rows[0]));
    expect(new Date(movida.inicio).toISOString()).toBe(new Date(proximoMartes('17:00')).toISOString());
    expect(movida.recordatorios).toEqual({});
    expect(new Date(movida.reprogramada_desde).toISOString()).toBe(new Date(proximoMartes('16:00')).toISOString());
  });

  it('transiciones de la cita: no se marca atendida antes de tiempo ni se cancela una atendida', async () => {
    const cita = (await admin.post('/agenda/citas', { customer_id: ids.cliente, product_id: ids.corte, resource_id: ids.recurso, inicio: proximoMartes('11:00') })).body;
    expect((await admin.patch(`/agenda/citas/${cita.id}`, { estado: 'ATENDIDA' })).status).toBe(409);
    expect((await admin.patch(`/agenda/citas/${cita.id}`, { estado: 'CONFIRMADA' })).status).toBe(200);
    expect((await admin.patch(`/agenda/citas/${cita.id}`, { estado: 'CANCELADA' })).status).toBe(200);
    expect((await admin.patch(`/agenda/citas/${cita.id}`, { estado: 'CONFIRMADA' })).status).toBe(409);
  });

  it('sin espacio en el día pedido, la disponibilidad ofrece los próximos días', async () => {
    let domingo = addDays(todayLocal(), 1);
    while (new Date(`${domingo}T12:00:00Z`).getUTCDay() !== 0) domingo = addDays(domingo, 1);
    const r = await admin.get(`/agenda/disponibilidad?servicio_id=${ids.corte}&fecha=${domingo}`);
    expect(r.body.franjas).toEqual([]);
    expect(r.body.alternativas.length).toBeGreaterThan(0);
    expect(r.body.alternativas[0].fecha > domingo).toBe(true);
  });

  it('horarios por recurso: se validan y un recurso con citas próximas no se desactiva', async () => {
    expect((await admin.patch(`/agenda/recursos/${ids.recurso}`, { horario: { lun: ['19:00', '09:00'] } })).status).toBe(400);
    const r = await admin.patch(`/agenda/recursos/${ids.recurso}`, { activo: false });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/cita\(s\) próximas/);
  });
});

describe('Ventas e inventario', () => {
  it('totales calculados por el servidor con descuento e IVA incluido; el navegador no fija precios', async () => {
    const r = await admin.post('/ventas', { customer_id: ids.cliente, items: [{ product_id: ids.cera, cantidad: 3, descuento_pct: 10, precio: 1 }] });
    expect(r.status).toBe(200);
    const d = (await admin.get(`/ventas/${r.body.id}`)).body;
    expect(d.total).toBe(86_400);
    expect(d.descuento).toBe(9_600);
    expect(d.subtotal).toBe(72_605.04);
    expect(Number((d.subtotal + d.impuestos).toFixed(2))).toBe(d.total);
    expect(d.items[0]).toMatchObject({ precio_unit: 32_000, descuento_pct: 10, total: 86_400 });
  });

  it('existencias insuficientes: la venta se rechaza completa (sin venta a medias ni inventario descontado)', async () => {
    const antes = (await admin.get('/productos')).body.find((p: any) => p.id === ids.aceite).stock;
    const ventasAntes = (await admin.get('/ventas')).body.total;
    const r = await admin.post('/ventas', { customer_id: ids.cliente, items: [{ product_id: ids.cera, cantidad: 1 }, { product_id: ids.aceite, cantidad: antes + 5 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/No hay existencias suficientes de Aceite para barba/);
    expect((await admin.get('/ventas')).body.total).toBe(ventasAntes);
    const ceraDespues = (await admin.get('/productos')).body.find((p: any) => p.id === ids.cera).stock;
    const ceraAntes = (await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT stock FROM product WHERE id=$1`, [ids.cera])).rows[0].stock));
    expect(ceraDespues).toBe(Number(ceraAntes));
  });

  it('anular devuelve las existencias y vence los enlaces de cobro abiertos', async () => {
    const stock0 = (await admin.get('/productos')).body.find((p: any) => p.id === ids.cera).stock;
    const v = await admin.post('/ventas', { customer_id: ids.cliente, items: [{ product_id: ids.cera, cantidad: 2 }] });
    expect((await admin.get('/productos')).body.find((p: any) => p.id === ids.cera).stock).toBe(stock0 - 2);
    await admin.post('/configuracion/pasarela', { proveedor: 'simulada', cuenta_id: 'cuenta-demo' });
    expect((await admin.post(`/ventas/${v.body.id}/enlace-pago`)).body.enlace).toBeTruthy();
    // La factura se emite en segundo plano; con la venta aún sin facturar se puede anular sin nota crédito.
    expect((await admin.post(`/ventas/${v.body.id}/anular`, { motivo: 'Error al registrar' })).status).toBe(200);
    expect((await admin.get('/productos')).body.find((p: any) => p.id === ids.cera).stock).toBe(stock0);
    expect((await admin.get(`/ventas/${v.body.id}`)).body.enlaces[0].estado).toBe('EXPIRADO');
  });

  it('búsqueda y paginación de ventas en el servidor', async () => {
    const p1 = (await admin.get('/ventas?por_pagina=10&pagina=1')).body;
    const p2 = (await admin.get('/ventas?por_pagina=10&pagina=2')).body;
    expect(p1.ventas).toHaveLength(10);
    expect(p1.total).toBeGreaterThan(20);
    expect(p1.ventas[0].id).not.toBe(p2.ventas[0].id);
    const una = (await admin.get('/ventas?q=1042')).body;
    expect(una.ventas.map((v: any) => v.numero)).toEqual([1042]);
  });

  it('el enlace de cobro es idempotente: repetir la acción devuelve el mismo enlace vigente', async () => {
    const v = await admin.post('/ventas', { customer_id: ids.cliente, items: [{ product_id: ids.corte, cantidad: 1 }] });
    const a = (await admin.post(`/ventas/${v.body.id}/enlace-pago`)).body;
    const b = (await admin.post(`/ventas/${v.body.id}/enlace-pago`)).body;
    expect(b.referencia).toBe(a.referencia);
    expect(b.reutilizado).toBe(true);
  });
});

describe('Clientes: duplicados, importación y exportación', () => {
  it('teléfono o documento repetidos se rechazan con un mensaje útil', async () => {
    const r = await admin.post('/clientes', { nombre: 'Otro Mateo', telefono: '315 444 0011' });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/Ya existe un cliente con ese teléfono: Mateo Contreras/);
    const d = await admin.post('/clientes', { nombre: 'Doc repetido', tipo_documento: 'CC', numero_documento: '1090456123' });
    expect(d.status).toBe(409);
  });

  it('exportación CSV de clientes y ventas, registrada en auditoría', async () => {
    const c = await E.app.inject({ method: 'GET', url: '/api/t/clientes.csv', headers: { cookie: cookieAdmin, 'x-tenant-slug': 'elparche' } });
    expect(c.headers['content-disposition']).toMatch(/clientes\.csv/);
    expect(c.body.split('\r\n')[0]).toBe('﻿Nombre;Teléfono;Correo;Tipo de documento;Documento;Compras;Autorizó datos;Creado');
    const v = await E.app.inject({ method: 'GET', url: `/api/t/ventas.csv?desde=${addDays(todayLocal(), -7)}`, headers: { cookie: cookieAdmin, 'x-tenant-slug': 'elparche' } });
    expect(v.body.split('\r\n').length).toBeGreaterThan(10);
    const ev = (await admin.get('/auditoria?q=exportar')).body.map((e: any) => e.accion);
    expect(ev).toEqual(expect.arrayContaining(['clientes.exportar', 'ventas.exportar']));
  });

  it('importación del catálogo: vista previa marca duplicados; confirmar es todo o nada', async () => {
    const csv = 'Producto;Precio;Tipo\nCera para peinar;$35.000;Producto\nMascarilla;20 mil;Producto\n';
    const boundary = '----b';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cat.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const prev = await E.app.inject({ method: 'POST', url: '/api/t/productos/importar/archivo', payload: body, headers: { cookie: cookieAdmin, 'x-tenant-slug': 'elparche', 'content-type': `multipart/form-data; boundary=${boundary}` } });
    expect(prev.statusCode).toBe(200);
    const filas = prev.json().filas;
    expect(filas.map((f: any) => [f.nombre, f.precio, f.existente])).toEqual([['Cera para peinar', 35000, 'Cera para peinar'], ['Mascarilla', 20000, null]]);
    const enviar = (f: any[], duplicados: string) => admin.post('/productos/importar/confirmar', { filas: f.map((x) => ({ tipo: x.tipo, nombre: x.nombre, precio: x.precio, iva_pct: 0 })), duplicados });
    const repetido = await enviar([...filas, filas[1]], 'omitir');
    expect(repetido.status).toBe(200);
    expect((await admin.get('/productos')).body.filter((p: any) => p.nombre === 'Mascarilla')).toHaveLength(1);
    expect((await enviar(filas, 'omitir')).body).toMatchObject({ creados: 0, actualizados: 0, omitidos: 2 });
    expect((await admin.get('/productos')).body.find((p: any) => p.nombre === 'Cera para peinar').precio).toBe(32000);
    expect((await enviar(filas, 'actualizar')).body).toMatchObject({ creados: 0, actualizados: 2, omitidos: 0 });
    expect((await admin.get('/productos')).body.find((p: any) => p.nombre === 'Cera para peinar').precio).toBe(35000);
  });
});

describe('Facturación electrónica', () => {
  it('el documento del entorno de pruebas se declara SIN validez fiscal en la vista pública', async () => {
    const doc = (await admin.get('/facturacion')).body;
    expect(doc.proveedor).toBe('sandbox');
    expect(doc.validez_fiscal).toBe(false);
    const d = doc.documentos.find((x: any) => x.estado === 'ENTREGADO');
    const html = (await E.app.inject({ method: 'GET', url: `/api/publico/documentos/${d.token_publico}` })).body;
    expect(html).toMatch(/SIN validez fiscal/);
    expect(html).not.toMatch(/Validado por la DIAN/);
  });

  it('sin proveedor fiscal conectado no se crea ni se simula una factura', async () => {
    setFiscalProvider(new SinProveedorFiscal());
    const v = await admin.post('/ventas', { customer_id: ids.cliente, items: [{ product_id: ids.corte, cantidad: 1 }] });
    await drain(E.db);
    const r = await admin.post(`/ventas/${v.body.id}/facturar`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/pendiente de conectar/);
    expect((await admin.get(`/ventas/${v.body.id}`)).body.documentos).toEqual([]);
    setFiscalProvider(new SandboxFiscalProvider());
  });

  it('rechazo por dato del cliente → corrección → reintento: la venta sigue válida y la traza registra todo', async () => {
    const dist = (await admin.get('/clientes?q=Distribuidora')).body.clientes[0];
    const v = await admin.post('/ventas', { customer_id: dist.id, items: [{ product_id: ids.corte, cantidad: 1 }] });
    await drain(E.db);
    let d = (await admin.get(`/ventas/${v.body.id}`)).body;
    expect(d.estado).toBe('CONFIRMADA');
    expect(d.documentos[0]).toMatchObject({ estado: 'RECHAZADO' });
    expect(d.documentos[0].motivo_rechazo).toMatch(/NIT del adquirente/);
    expect((await admin.patch(`/clientes/${dist.id}`, { numero_documento: `900555666-${digitoVerificacionNit('900555666')}` })).status).toBe(200);
    expect((await admin.post(`/facturacion/${d.documentos[0].id}/reintentar`)).status).toBe(200);
    expect((await admin.post(`/facturacion/${d.documentos[0].id}/reintentar`)).status).toBe(409);
    await drain(E.db);
    d = (await admin.get(`/ventas/${v.body.id}`)).body;
    expect(['VALIDADO', 'ENTREGADO']).toContain(d.documentos[0].estado);
    expect(d.traza.map((t: any) => t.accion)).toEqual(expect.arrayContaining(['factura.solicitar', 'factura.rechazada', 'factura.reintentar', 'factura.validada']));
  });
});
