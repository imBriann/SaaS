import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { setup, verificarAlta, type Env } from './helpers.js';
import { config } from '../src/config.js';
import { LEGAL, sumarDiasHabiles } from '../src/legal/index.js';
import { decidir, reconocerTelefono } from '../src/modules/plataformaBot.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';

let E: Env;
beforeAll(async () => { E = await setup(); });
afterAll(async () => { await E.app.close(); await E.db.close(); });

const post = (url: string, payload: any = {}, ip?: string) => E.app.inject({ method: 'POST', url, payload, ...(ip ? { remoteAddress: ip } : {}) });
const patch = (tk: string, payload: any) => E.app.inject({ method: 'PATCH', url: `/api/onboarding/borradores/${tk}`, payload });
const get = (tk: string) => E.app.inject({ method: 'GET', url: `/api/onboarding/borradores/${tk}` });

async function borrador(slug: string, descripcion = 'Tengo una tienda de ropa y vendo accesorios.') {
  const d = (await post('/api/onboarding/borradores', { descripcion })).json();
  const r = await patch(d.token, { negocio: { nombre: `Negocio ${slug}`, slug, email: `${slug}@legal.test` } });
  expect(r.statusCode, r.body).toBe(200);
  return d.token as string;
}

describe('Teléfono, ubicación y aceptación legal obligatorios antes de pagar', () => {
  it('el pago exige teléfono, ubicación del comercio y aceptación vigente, aunque no facture', async () => {
    const tk = await borrador('obligatorios');
    // Solo el correo se verifica a mano para no completar lo demás.
    await post(`/api/onboarding/borradores/${tk}/correo/enviar`);
    const { codigoDelCorreo } = await import('./helpers.js');
    await post(`/api/onboarding/borradores/${tk}/correo/verificar`, { codigo: await codigoDelCorreo(E.db, 'obligatorios@legal.test') });
    const sin = await post(`/api/onboarding/borradores/${tk}/pago`);
    expect(sin.statusCode).toBe(400);
    expect(sin.json().error.details.faltan).toEqual(expect.arrayContaining(['telefono', 'direccion', 'aceptacion_legal']));
    expect(sin.json().error.details.faltan).not.toContain('nit');
    // El mensaje dice qué falta (no solo «faltan datos») y el borrador lo informa para que la pantalla de pago lo muestre.
    expect(sin.json().error.message).toMatch(/el teléfono de contacto.*el país, departamento, municipio y dirección del negocio/);
    expect((await get(tk)).json().faltantes_pago).toEqual(expect.arrayContaining(['telefono', 'direccion', 'aceptacion_legal']));

    const parcial = await patch(tk, { negocio: { telefono_pais: 'CO', telefono_nacional: '300 123 4567' } });
    expect(parcial.json().negocio.telefono).toBe('+573001234567');
    expect((await post(`/api/onboarding/borradores/${tk}/pago`)).json().error.details.faltan).not.toContain('telefono');
    expect((await get(tk)).json().faltantes_pago).not.toContain('telefono');
  });

  it('la aceptación guarda versión, fecha y huella del origen; sin marcar las dos casillas se rechaza', async () => {
    const tk = await borrador('aceptacion');
    expect((await post(`/api/onboarding/borradores/${tk}/aceptacion-legal`, { terminos: true })).statusCode).toBe(400);
    expect((await post(`/api/onboarding/borradores/${tk}/aceptacion-legal`, { terminos: true, privacidad: true })).statusCode).toBe(400);
    const ok = await post(`/api/onboarding/borradores/${tk}/aceptacion-legal`, { terminos: true, privacidad: true, inicio_servicio: true });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().version).toBe(LEGAL.version);
    const d = (await get(tk)).json();
    expect(d.aceptacion_legal).toMatchObject({ version: LEGAL.version, vigente: true });
    const fila = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT aceptacion_legal FROM onboarding_draft WHERE token=$1`, [tk])).rows[0]);
    expect(fila.aceptacion_legal.ip_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(JSON.stringify(fila.aceptacion_legal)).not.toMatch(/127\.0\.0\.1/);
    // Una aceptación de una versión anterior ya no sirve.
    await E.db.withPlatform((tx) => tx.query(`UPDATE onboarding_draft SET aceptacion_legal = aceptacion_legal || '{"version":"2000-01-01"}'::jsonb WHERE token=$1`, [tk]));
    expect((await get(tk)).json().aceptacion_legal.vigente).toBe(false);
  });

  it('con todo completo el pago avanza', async () => {
    const tk = await borrador('completo');
    await verificarAlta(E, tk);
    const p = await post(`/api/onboarding/borradores/${tk}/pago`);
    expect(p.statusCode, p.body).toBe(200);
  });
});

describe('Un comercio con más de una actividad', () => {
  it('guarda las actividades adicionales, valida el catálogo y las lleva a la empresa creada', async () => {
    const tk = await borrador('cafespa', 'Tengo un café spa en Cúcuta con tres empleados.');
    const c = (await get(tk)).json().clasificacion;
    expect(c).toMatchObject({ sector: 'restaurante', tipo_negocio: 'Cafetería' });
    expect(c.actividades_adicionales.map((a: any) => a.tipo_negocio)).toEqual(['Spa']);

    const mal = await patch(tk, { clasificacion: { actividades_adicionales: [{ sector: 'barberia', tipo_negocio: 'Veterinaria' }] } });
    expect(mal.statusCode).toBe(400);
    expect((await patch(tk, { clasificacion: { actividades_adicionales: [1, 2, 3, 4].map(() => ({ sector: 'barberia', tipo_negocio: 'Spa' })) } })).statusCode).toBe(400);

    const ok = await patch(tk, { clasificacion: { actividades_adicionales: [{ sector: 'barberia', tipo_negocio: 'Spa' }, { sector: 'comercio', tipo_negocio: 'Papelería' }] } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().clasificacion.actividades_adicionales).toEqual([{ sector: 'barberia', tipo_negocio: 'Spa' }, { sector: 'comercio', tipo_negocio: 'Papelería' }]);
    // La actividad principal no se duplica como adicional.
    const dup = await patch(tk, { clasificacion: { actividades_adicionales: [{ sector: 'restaurante', tipo_negocio: 'Cafetería' }, { sector: 'barberia', tipo_negocio: 'Spa' }] } });
    expect(dup.json().clasificacion.actividades_adicionales).toEqual([{ sector: 'barberia', tipo_negocio: 'Spa' }]);
    // Quitarlas todas es válido.
    expect((await patch(tk, { clasificacion: { actividades_adicionales: [] } })).json().clasificacion.actividades_adicionales).toEqual([]);
  });
});

describe('Solicitudes de los titulares sobre sus datos', () => {
  const cuerpo = { tipo: 'SUPRESION', calidad: 'CLIENTE_DE_COMERCIO', nombre: 'Marta Rojas', email: 'marta@correo.test', comercio: 'Café Aurora', detalle: 'Quiero que eliminen mis datos de contacto.' };

  it('registra la solicitud, da radicado y fecha, y avisa al titular y al buzón de datos', async () => {
    const r = await post('/api/publico/solicitudes-datos', cuerpo, '10.0.0.1');
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    expect(s.radicado).toMatch(/^SD-\d{4}-\d{6}$/);
    expect(s.dias_habiles).toBe(15);
    expect(new Date(`${s.vence_en}T00:00:00Z`).getUTCDay()).not.toBe(0);
    const correos = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT para, tipo FROM email_outbox WHERE tipo LIKE 'datos_solicitud%' ORDER BY creado_en`)).rows);
    expect(correos.map((c: any) => c.tipo).sort()).toEqual(['datos_solicitud_interna', 'datos_solicitud_recibida']);
    expect(correos.find((c: any) => c.tipo === 'datos_solicitud_recibida').para).toBe('marta@correo.test');
  });

  it('las consultas tienen 10 días hábiles, los datos se validan y el estado solo lo ve quien tiene radicado y correo', async () => {
    const c = await post('/api/publico/solicitudes-datos', { ...cuerpo, tipo: 'CONSULTA', email: 'luis@correo.test' }, '10.0.0.2');
    expect(c.json().dias_habiles).toBe(10);
    expect((await post('/api/publico/solicitudes-datos', { ...cuerpo, email: 'no-es-correo' }, '10.0.0.3')).statusCode).toBe(400);
    expect((await post('/api/publico/solicitudes-datos', { ...cuerpo, detalle: 'corto' }, '10.0.0.3')).statusCode).toBe(400);
    expect((await post('/api/publico/solicitudes-datos', { ...cuerpo, tipo: 'BORRAR_TODO' }, '10.0.0.3')).statusCode).toBe(400);

    const ok = await post('/api/publico/solicitudes-datos/consulta', { radicado: c.json().radicado, email: 'LUIS@correo.test' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ radicado: c.json().radicado, estado: 'RECIBIDA' });
    expect(ok.body).not.toContain('detalle');
    expect((await post('/api/publico/solicitudes-datos/consulta', { radicado: c.json().radicado, email: 'otra@correo.test' })).statusCode).toBe(404);
    expect((await post('/api/publico/solicitudes-datos/consulta', { radicado: 'SD-2026-999999', email: 'luis@correo.test' })).statusCode).toBe(404);
  });

  it('limita las solicitudes repetidas desde un mismo origen', async () => {
    let ultimo = 200;
    for (let i = 0; i < 6; i++) ultimo = (await post('/api/publico/solicitudes-datos', { ...cuerpo, email: `rep${i}@correo.test` }, '10.0.0.9')).statusCode;
    expect(ultimo).toBe(429);
  });

  it('una petición, queja o reclamo de consumo recibe radicado propio', async () => {
    const r = await post('/api/publico/solicitudes-datos', { ...cuerpo, tipo: 'PQR', calidad: 'OTRA', email: 'pqr@correo.test', detalle: 'No me llegó el comprobante de mi pago.' }, '10.0.0.4');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().radicado).toMatch(/^PQ-\d{4}-\d{6}$/);
  });

  it('el plazo cuenta días hábiles sin sábados ni domingos', () => {
    // Viernes 2026-10-16 + 1 día hábil = lunes 2026-10-19.
    expect(sumarDiasHabiles(new Date('2026-10-16T12:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-10-19');
    expect(sumarDiasHabiles(new Date('2026-10-16T12:00:00Z'), 10).toISOString().slice(0, 10)).toBe('2026-10-30');
  });

  it('la información legal pública identifica al responsable sin inventar datos faltantes', async () => {
    const r = (await E.app.inject({ method: 'GET', url: '/api/publico/legal' })).json();
    expect(r.version).toBe(LEGAL.version);
    expect(r.responsable.correo).toBeTruthy();
    // Sin configuración del emisor, lo que falta se informa como falta: no se rellena.
    expect(r.responsable.completo).toBe(r.responsable.faltan.length === 0);
    if (!config.documentos.emisor.razonSocial) expect(r.responsable.razon_social).toBeNull();
  });
});

describe('Asistente de Omnegia: reconoce los teléfonos de los comercios', () => {
  it('reconoce el número por el teléfono de contacto del comercio y no por coincidencias parciales', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE tenant SET telefono='+573105550101' WHERE id=$1`, [E.A]));
    const ok = await reconocerTelefono(E.db, '+57 310 555 0101');
    expect(ok.map((c) => c.slug)).toEqual(['elparche']);
    expect(await reconocerTelefono(E.db, '+573105550102')).toEqual([]);
    expect(await reconocerTelefono(E.db, '12')).toEqual([]);
  });

  it('un comercio con el teléfono sin indicativo también se reconoce', async () => {
    await E.db.withPlatform((tx) => tx.query(`UPDATE tenant SET telefono='3105550101' WHERE id=$1`, [E.A]));
    expect((await reconocerTelefono(E.db, '573105550101')).map((c) => c.slug)).toEqual(['elparche']);
    await E.db.withPlatform((tx) => tx.query(`UPDATE tenant SET telefono='+573105550101' WHERE id=$1`, [E.A]));
  });

  it('responde sin revelar a qué comercios está vinculado el número ni su suscripción, y avisa del tratamiento de datos', () => {
    // Conocer el teléfono no es autenticar: el asistente nunca nombra comercios ni estados de cuenta.
    const primera = decidir({ texto: 'hola', tipo: 'TEXTO', nombre: 'Laura Gómez', estado: {}, conocido: true });
    expect(primera.texto).toContain('Hola, Laura.');
    expect(primera.texto).toContain('/privacidad');
    expect(primera.texto).not.toMatch(/comercio|suscripción activa|Café Spa/i);
    const pago = decidir({ texto: 'quiero pagar mi suscripción', tipo: 'TEXTO', nombre: 'Laura', estado: primera.estado, conocido: true });
    expect(pago.texto).toContain('Suscripción');
    expect(pago.texto).not.toMatch(/tu (suscripción|plan) (está|es) |suscripción activa/i);
    expect(pago.texto).toContain('no consulto datos de tu cuenta');
    expect(decidir({ texto: 'cuánto cuesta el plan', tipo: 'TEXTO', nombre: 'Laura', estado: primera.estado, conocido: true }).texto).toContain('/planes');
    const desconocido = decidir({ texto: 'quiero crear una cuenta', tipo: 'TEXTO', nombre: 'Pedro', estado: {}, conocido: false });
    expect(desconocido.texto).toContain('/empezar');
  });

  it('un mensaje al número de Omnegia queda en su propia conversación y no crea clientes ni conversaciones de un comercio', async () => {
    config.whatsapp.plataformaPhoneNumberId = 'plat-omnegia';
    try {
      const antes = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT (SELECT count(*) FROM customer)::int AS c, (SELECT count(*) FROM conversation)::int AS v`)).rows[0]);
      const r = await receiveChannelMessages(E.db, [{ phoneNumberId: 'plat-omnegia', from: '573105550101', nombre: 'Laura Gómez', id: 'wamid.plat.1', texto: 'hola' }], 'WHATSAPP', 'corr-1');
      expect(r).toEqual([{ id: 'wamid.plat.1', estado: 'plataforma_aceptado' }]);
      // Repetir el mismo mensaje no lo duplica ni encola otra respuesta.
      const otra = await receiveChannelMessages(E.db, [{ phoneNumberId: 'plat-omnegia', from: '573105550101', nombre: 'Laura Gómez', id: 'wamid.plat.1', texto: 'hola' }], 'WHATSAPP', 'corr-2');
      expect(otra[0].estado).toBe('duplicado');
      const jobs = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT payload FROM job WHERE tipo='procesar_plataforma'`)).rows);
      expect(jobs).toHaveLength(1);
      const conv = await E.db.withPlatform(async (tx) => (await tx.query(`SELECT telefono FROM plataforma_conversacion`)).rows);
      expect(conv.map((c: any) => c.telefono)).toEqual(['+573105550101']);
      const despues = await E.db.withTenant(E.A, async (tx) => (await tx.query(`SELECT (SELECT count(*) FROM customer)::int AS c, (SELECT count(*) FROM conversation)::int AS v`)).rows[0]);
      expect(despues).toEqual(antes);
    } finally { config.whatsapp.plataformaPhoneNumberId = undefined; }
  });
});
