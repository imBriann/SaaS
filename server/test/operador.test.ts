import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setup, login, api, op, CRED, loginOperador, type Env } from './helpers.js';
import { channel, setChannelAdapter, type ChannelAdapter } from '../src/adapters/channel.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { drain } from '../src/worker/jobs.js';
import { volcarMetricas } from '../src/core/metricas.js';
import { registrarIncidente } from '../src/core/incidentes.js';
import { encolarCorreo } from '../src/email/servicio.js';
import { ProveedorFalso, usarProveedorCorreo } from '../src/email/proveedores.js';
import * as plantillas from '../src/email/plantillas.js';
import { depurar } from '../src/lib/depurar.js';
import { config } from '../src/config.js';
import { uuidv7 } from '../src/lib/util.js';

/**
 * Panel interno del operador de Omnegia: separación de permisos, mínimo privilegio en
 * la base, respuestas con campos permitidos, privacidad de los negocios en pantallas,
 * exportaciones, incidentes y registros, reintentos sin efectos duplicados y auditoría.
 */
let E: Env;
let admin: ReturnType<typeof op>;
let soporte: ReturnType<typeof op>;
let privados: string[] = [];
const falso = new ProveedorFalso();

beforeAll(async () => {
  E = await setup();
  usarProveedorCorreo(falso);
  admin = op(E.app, await loginOperador(E.app, E.db));
  soporte = op(E.app, await loginOperador(E.app, E.db, 'soporte@saas.test', 'demo-soporte-2026'));
  // Datos privados de los negocios que NUNCA deben aparecer en el panel del operador.
  privados = await E.db.raw(async (tx) => {
    const c = (await tx.query(`SELECT nombre, telefono, email FROM customer`)).rows.flatMap((r: any) => [r.nombre, r.telefono, r.email]);
    const m = (await tx.query(`SELECT contenido FROM message WHERE length(contenido) >= 16`)).rows.map((r: any) => String(r.contenido).slice(0, 40));
    const p = (await tx.query(`SELECT nombre FROM product WHERE length(nombre) >= 12`)).rows.map((r: any) => r.nombre);
    return [...c, ...m, ...p].filter((x) => typeof x === 'string' && x.length >= 6);
  });
  expect(privados.length).toBeGreaterThan(10);
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

const sinPrivados = (texto: string) => {
  for (const p of privados) expect(texto, `el panel del operador expuso un dato privado: «${p}»`).not.toContain(p);
};

/** Claves que el panel puede devolver. Las claves en MAYÚSCULAS son valores de enumeración (estados, gravedades). */
const PERMITIDAS = new Set(`
id nombre email rol permisos periodo desde hasta empresas total por_estado altas_periodo bajas_periodo serie_altas dia altas ingresos moneda aprobados
pendientes rechazados n monto mrr_estimado modulos codigo ia llamadas errores tokens_entrada tokens_salida tokens_mes_actual costo_estimado_usd
precios_configurados solicitudes errores_5xx errores_4xx latencia_media_ms p95_ms disponibilidad cola en_curso fallidos reintentando espera_mas_antigua_s
incidentes_abiertos soporte_abiertos slug sector contacto_email plan plan_nombre estado periodo_fin creado_en whatsapp_estado modulos_activos usuarios_activos pagina
por_pagina empresa periodo_inicio gracia_hasta limites precio_mensual uso_mes tokens_ia mensajes documentos cuotas usuarios activo incluido_en_plan pagos
referencia concepto fecha tecnico correos_30_dias tickets_abiertos planes empresas_vigentes empresas_total por_renovar empresa_id evolucion mes bajas
proveedor proceso version inicio activo_s node entorno base disponible migraciones rutas metodo ruta media_ms max_ms serie hora por_tipo tipo
trabajos_fallidos intentos reintentable razon incidentes servicio gravedad descripcion accion_sugerida trabajo_id correlacion detalle ocurrencias
primera_vez ultima_vez resuelto_en nota servicios plataforma clave variables whatsapp con_problemas verificado_en correo por_estado_7_dias fallos_7_dias
modelos_7_dias modelo tickets numero categoria categoria_nombre prioridad asunto solicitante actualizado_en ticket solicitante_email autor_tipo autor cuerpo
eventos actor accion recurso recurso_id motivo resultado tipo_trabajo http_estado codigo_proveedor tipo_correo clase_error anterior nuevo filas ok
empresa_sin_verificar canal conversacion_id totales abiertas con_ia con_persona sin_respuesta vencidos en_cola fallidos_48h ultima_actividad radicados tenant_id
radicado conversation_id asignado sla_vence_en vencido acceso_hasta accesos otorgado_por_nombre ticket_numero expira_en solicitante_telefono
`.split(/\s+/).filter(Boolean));
const PROHIBIDAS = ['password_hash', 'payload', 'ultimo_error', 'contenido', 'telefono', 'cuerpo_html', 'contenido_cifrado', 'para', 'whatsapp_diagnostico', 'nit', 'token', 'secreto', 'llave', 'argumentos', 'prompt', 'texto'];

function clavesDe(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => clavesDe(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (!/^[A-Z_0-9]+$/.test(k)) out.add(k); clavesDe(x, out); }
  return out;
}

// ---------------------------------------------------------------- 1. separación de accesos
describe('1. Un usuario de empresa no accede a la administración de Omnegia', () => {
  const RUTAS: [string, string][] = [['GET', '/yo'], ['GET', '/resumen'], ['GET', '/empresas'], ['GET', '/empresas.csv'], ['GET', `/empresas/{A}`], ['POST', '/empresas/{A}/estado'],
    ['POST', '/empresas/{A}/plan'], ['POST', '/empresas/{A}/modulos'], ['GET', '/suscripciones'], ['PATCH', '/planes/negocio'], ['GET', '/salud'], ['POST', `/trabajos/${uuidv7()}/reintentar`],
    ['GET', '/incidentes'], ['GET', '/integraciones'], ['GET', '/soporte'], ['GET', '/auditoria']];

  it('ni el administrador de una empresa ni un asesor ven ninguna ruta (404), y el intento queda auditado', async () => {
    for (const cred of [CRED.admin, CRED.laura]) {
      const cookie = await login(E.app, cred[0], cred[1]);
      for (const [m, u] of RUTAS) {
        const r = await E.app.inject({ method: m as any, url: `/api/operador${u.replace('{A}', E.A)}`, headers: { cookie }, payload: m === 'GET' ? undefined : {} });
        expect(r.statusCode, `${m} ${u} con ${cred[0]}`).toBe(404);
      }
    }
    const sinSesion = await E.app.inject({ method: 'GET', url: '/api/operador/resumen' });
    expect(sinSesion.statusCode).toBe(404);
    const denegados = await E.db.withOperador(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM auditoria_plataforma WHERE accion='operador.acceso_denegado' AND actor_email=$1`, [CRED.laura[0]])).rows[0].n);
    expect(denegados).toBe(RUTAS.length);
  });

  it('el rol SOPORTE ve el panel y atiende tickets, pero no gestiona empresas, planes ni trabajos', async () => {
    expect((await soporte.get('/resumen')).status).toBe(200);
    expect((await soporte.post(`/empresas/${E.B}/estado`, { estado: 'SUSPENDIDA', motivo: 'Prueba de permisos del rol', confirmacion: 'fuerzanorte' })).status).toBe(403);
    expect((await soporte.patch('/planes/negocio', { cuota_tokens_ia: 1, cuota_mensajes: 1, cuota_documentos: 1, max_usuarios: 1, motivo: 'Prueba de permisos del rol' })).status).toBe(403);
    expect((await soporte.post(`/trabajos/${uuidv7()}/reintentar`)).status).toBe(403);
  });
});

// ---------------------------------------------------------------- 2. sin acceso a datos operativos
describe('2. El operador no lee datos operativos privados de las empresas', () => {
  it('por la API de empresas (aunque fije el subdominio) recibe 404 en todo', async () => {
    const cookie = await loginOperador(E.app, E.db);
    const empresa = api(E.app, cookie, 'elparche');
    for (const ruta of ['/clientes', '/conversaciones', '/ventas', '/agenda', '/inventario/productos', '/facturacion', '/configuracion', '/clientes.csv', '/ventas.csv', '/inicio', '/soporte']) {
      expect((await empresa.get(ruta)).status, ruta).toBe(404);
    }
  });

  it('el rol de base de datos del operador tiene prohibidas esas tablas y columnas (no es solo la pantalla)', async () => {
    const prohibidas = [
      'SELECT * FROM customer', 'SELECT * FROM conversation', 'SELECT contenido FROM message', 'SELECT * FROM appointment', 'SELECT * FROM "order"',
      'SELECT * FROM order_item', 'SELECT * FROM product', 'SELECT * FROM fiscal_document', 'SELECT * FROM merchant_gateway_account', 'SELECT * FROM payment_link',
      'SELECT * FROM provider_transaction', 'SELECT * FROM session', 'SELECT password_hash FROM users', 'SELECT * FROM users', 'SELECT * FROM otp_code',
      'SELECT * FROM password_reset', 'SELECT * FROM ai_execution', 'SELECT * FROM pending_action', 'SELECT payload FROM job', 'SELECT ultimo_error FROM job',
      'SELECT para, asunto FROM email_outbox', 'SELECT cuerpo_html FROM email_outbox', 'SELECT whatsapp_diagnostico FROM tenant', 'SELECT nit, telefono FROM tenant',
      'SELECT * FROM audit_event', 'SELECT * FROM onboarding_draft', 'SELECT * FROM support_case', 'SELECT draft_token FROM payment',
    ];
    for (const sql of prohibidas) {
      await expect(E.db.withOperador((tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/i);
    }
    // Tampoco puede escribir donde no debe ni borrar empresas.
    for (const sql of [`DELETE FROM tenant WHERE id='${E.B}'`, `UPDATE tenant SET nombre='x' WHERE id='${E.B}'`, `INSERT INTO customer (id, tenant_id, nombre) VALUES ('${uuidv7()}', '${E.B}', 'x')`]) {
      await expect(E.db.withOperador((tx) => tx.query(sql)), sql).rejects.toThrow(/permission denied/i);
    }
  });
});

// ---------------------------------------------------------------- 3. solo campos permitidos
describe('3. Los endpoints del operador devuelven únicamente campos permitidos', () => {
  it('ninguna respuesta trae claves fuera de la lista ni datos privados de clientes o conversaciones', async () => {
    const gym = api(E.app, await login(E.app, ...CRED.gym), 'fuerzanorte');
    const t = (await gym.post('/soporte', { categoria: 'TECNICO', asunto: 'Consulta técnica', descripcion: 'El panel tarda en cargar la agenda en las mañanas.' })).body;
    await drain(E.db);
    await volcarMetricas(E.db);
    const inc = (await admin.get('/incidentes')).body;
    const rutas = ['/yo', '/resumen', '/empresas', `/empresas/${E.A}`, `/empresas/${E.B}`, '/suscripciones', '/salud', '/incidentes', '/integraciones', '/soporte', `/soporte/${t.id}`, '/auditoria', '/atencion-empresas'];
    if (inc.incidentes?.[0]) rutas.push(`/incidentes?estado=${inc.incidentes[0].estado}`);
    for (const ruta of rutas) {
      const r = await admin.get(ruta);
      expect(r.status, ruta).toBe(200);
      const claves = clavesDe(r.body);
      const extra = [...claves].filter((k) => !PERMITIDAS.has(k));
      expect(extra, `${ruta} devolvió claves no permitidas`).toEqual([]);
      for (const p of PROHIBIDAS) expect(claves.has(p), `${ruta} devolvió «${p}»`).toBe(false);
      sinPrivados(r.raw);
    }
  });

  it('el listado de empresas solo trae datos comerciales mínimos', async () => {
    const r = await admin.get('/empresas');
    expect(Object.keys(r.body.empresas[0]).sort()).toEqual(['contacto_email', 'creado_en', 'estado', 'id', 'modulos_activos', 'nombre', 'periodo_fin', 'plan', 'plan_nombre', 'sector', 'slug', 'usuarios_activos', 'whatsapp_estado']);
  });
});

// ---------------------------------------------------------------- 4. registros e incidentes sin datos
describe('4. Logs, errores e incidentes no filtran datos aunque el proveedor los incluya', () => {
  const telefono = '573154440011';
  const textoPrivado = 'Hola Mateo, tu cita de corte es mañana a las 3';
  let original: ChannelAdapter;
  beforeAll(() => { original = channel('WHATSAPP') as ChannelAdapter; });
  afterAll(() => setChannelAdapter('WHATSAPP', original));

  it('el depurador quita correos, teléfonos, tokens y secretos', () => {
    const s = depurar(`Fallo para ana.perez@cliente.co al +57 315 444 0011 con Bearer EAAGm0PX4ZCpsBAKZB token=abc123secretisimo re_AbCdEf123456 tenant 0190aaaa-0000-7000-8000-000000000001`);
    expect(s).not.toMatch(/ana\.perez|315 444|EAAGm0|abc123secret|re_AbCdEf/);
    expect(s).toContain('0190aaaa-0000-7000-8000-000000000001');
  });

  it('el incidente guarda solo claves y valores técnicos permitidos', async () => {
    const id = await E.db.withPlatform((tx) => registrarIncidente(tx, { codigo: 'TRABAJO_FALLIDO', servicio: 'prueba', tenantId: E.A, detalle: {
      tipo_trabajo: 'prueba', telefono, mensaje: textoPrivado, proveedor: 'correo de ana@x.co', codigo_proveedor: '131026', intentos: 3 } }));
    const fila = await E.db.withOperador(async (tx) => (await tx.query(`SELECT detalle FROM incidente WHERE id=$1`, [id])).rows[0]);
    expect(fila.detalle).toEqual({ tipo_trabajo: 'prueba', codigo_proveedor: '131026', intentos: 3 });
  });

  it('un fallo de WhatsApp con datos en el error llega al operador solo como código; consola y cola depuradas', async () => {
    const lineas: string[] = [];
    const espias = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { lineas.push(a.map(String).join(' ')); }));
    const antes = (config as any).test;
    (config as any).test = false;
    try {
      // 1) El proveedor rechaza con un mensaje que trae el teléfono y el texto.
      setChannelAdapter('WHATSAPP', { canal: 'WHATSAPP', sendText: async () => ({ ok: false, reintentable: false, error: `(#131026) Undeliverable to +${telefono}: "${textoPrivado}"` }), sendTemplate: async () => ({ ok: false, reintentable: false, error: 'x' }) } as any);
      await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from: telefono, nombre: 'Mateo Contreras', id: `t.${uuidv7()}`, texto: 'hola, quiero una cita' }], 'WHATSAPP', 't');
      await drain(E.db);
      // 2) El adaptador lanza una excepción con datos: se reintenta hasta agotar y queda FALLIDO.
      setChannelAdapter('WHATSAPP', { canal: 'WHATSAPP', sendText: async () => { throw new Error(`timeout hablando con graph para +${telefono} token=EAAGm0PX4ZCpsBAKZBsecreto "${textoPrivado}"`); }, sendTemplate: async () => ({ ok: true }) } as any);
      await receiveChannelMessages(E.db, [{ phoneNumberId: 'sim-elparche', from: '573209990000', nombre: 'Otro Cliente', id: `t.${uuidv7()}`, texto: 'precio del corte' }], 'WHATSAPP', 't');
      for (let i = 0; i < 6; i++) {
        await E.db.withPlatform((tx) => tx.query(`UPDATE job SET ejecutar_en=now() WHERE estado='PENDIENTE' AND tipo='enviar_mensaje'`));
        await drain(E.db);
      }
    } finally { (config as any).test = antes; espias.forEach((s) => s.mockRestore()); }

    const errores = await E.db.raw(async (tx) => (await tx.query(`SELECT ultimo_error FROM job WHERE tipo='enviar_mensaje' AND estado='FALLIDO'`)).rows);
    expect(errores.length).toBeGreaterThan(0);
    for (const e of errores) { expect(e.ultimo_error).not.toContain(telefono); expect(e.ultimo_error).not.toContain('EAAGm0'); }
    const consola = lineas.join('\n');
    expect(consola).not.toContain(telefono);
    expect(consola).not.toContain('EAAGm0');
    expect(consola).not.toContain(textoPrivado);

    const r = await admin.get('/incidentes?servicio=whatsapp');
    const r2 = await admin.get('/incidentes?servicio=enviar_mensaje');
    const todos = [...r.body.incidentes, ...r2.body.incidentes];
    expect(todos.map((i: any) => i.codigo)).toEqual(expect.arrayContaining(['WHATSAPP_ENVIO_FALLIDO']));
    for (const raw of [r.raw, r2.raw]) { expect(raw).not.toContain(telefono); expect(raw).not.toContain(textoPrivado); expect(raw).not.toContain('EAAGm0'); }
  });

  it('un error 500 se registra como incidente con la plantilla de ruta y la correlación, sin el mensaje de la excepción', async () => {
    const appErr = E.app;
    const antes = (await admin.get('/incidentes?servicio=t/clientes')).body.total;
    // Se fuerza un error no controlado en una ruta de empresa (consulta inválida a nivel de motor).
    await E.db.raw((tx) => tx.query(`ALTER TABLE customer RENAME COLUMN nombre TO nombre_tmp`));
    try {
      const r = await api(appErr, await login(appErr, ...CRED.admin), 'elparche').get('/clientes');
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.body)).not.toMatch(/nombre_tmp|column/i);
    } finally { await E.db.raw((tx) => tx.query(`ALTER TABLE customer RENAME COLUMN nombre_tmp TO nombre`)); }
    const despues = (await admin.get('/incidentes?servicio=t/clientes')).body;
    expect(despues.total).toBe(antes + 1);
    const i = despues.incidentes[0];
    expect(i).toMatchObject({ codigo: 'HTTP_ERROR_INTERNO', servicio: 't/clientes', empresa_id: E.A, detalle: { ruta: '/api/t/clientes', metodo: 'GET', http_estado: 500 } });
    expect(i.correlacion).toMatch(/^[\w-]{8,}$/);
    expect(JSON.stringify(i)).not.toMatch(/nombre_tmp|column/);
  });
});

// ---------------------------------------------------------------- 5. exportaciones
describe('5. Las exportaciones respetan las mismas restricciones', () => {
  it('el CSV de empresas tiene exactamente las columnas permitidas, ningún dato privado y queda auditado', async () => {
    const r = await admin.get('/empresas.csv');
    expect(r.status).toBe(200);
    const [cabecera, ...filas] = r.raw.replace(/^﻿/, '').split('\n');
    expect(cabecera).toBe('id,slug,nombre,sector,contacto_email,plan,plan_nombre,estado,periodo_fin,creado_en,whatsapp_estado,modulos_activos,usuarios_activos');
    expect(filas.length).toBeGreaterThanOrEqual(2);
    sinPrivados(r.raw);
    const aud = await E.db.withOperador(async (tx) => (await tx.query(`SELECT resultado FROM auditoria_plataforma WHERE accion='empresas.exportar' ORDER BY creado_en DESC LIMIT 1`)).rows[0]);
    expect(aud.resultado).toBe('EXITO');
  });
});

// ---------------------------------------------------------------- 6. reintentos sin duplicar efectos
describe('6. Las acciones de recuperación no duplican efectos', () => {
  it('reintentar un correo fallido dos veces lo envía una sola vez', async () => {
    falso.fallarCon = { codigo: 'PROVEEDOR_NO_DISPONIBLE', reintentable: false };
    const correoId = await E.db.withPlatform((tx) => encolarCorreo(tx, { tenantId: null, para: 'reintento@empresa.test', correo: plantillas.pruebaConfiguracion({ proveedor: 'fake' }) }));
    await drain(E.db);
    const inc = (await admin.get('/incidentes?servicio=correo')).body.incidentes.find((i: any) => i.codigo === 'CORREO_NO_ENVIADO');
    expect(inc?.reintentable).toBe(true);
    falso.fallarCon = null;
    const [a, b] = await Promise.all([admin.post(`/incidentes/${inc.id}/reintentar`, { motivo: 'Proveedor recuperado' }), admin.post(`/incidentes/${inc.id}/reintentar`, { motivo: 'Doble clic' })]);
    const resultados = [a.body.reintentado, b.body.reintentado].sort();
    expect(resultados).toEqual([false, true]);
    await drain(E.db);
    await admin.post(`/incidentes/${inc.id}/reintentar`, { motivo: 'Tercer intento' });
    await drain(E.db);
    expect(falso.enviados.filter((m) => m.claveIdempotencia === correoId)).toHaveLength(1);
    const estado = await E.db.withOperador(async (tx) => (await tx.query(`SELECT estado FROM email_outbox WHERE id=$1`, [correoId])).rows[0].estado);
    expect(estado).toBe('ENVIADO');
  });

  it('un trabajo que podría duplicar mensajes, facturas o cobros no se reintenta', async () => {
    const fallido = await E.db.withOperador(async (tx) => (await tx.query(`SELECT id FROM job WHERE tipo='enviar_mensaje' AND estado='FALLIDO' LIMIT 1`)).rows[0]);
    expect(fallido).toBeTruthy();
    const r = await admin.post(`/trabajos/${fallido.id}/reintentar`, { motivo: 'Intento' });
    expect(r.body).toMatchObject({ reintentado: false });
    expect(r.body.razon).toMatch(/duplicar el mensaje/);
    const sigue = await E.db.withOperador(async (tx) => (await tx.query(`SELECT estado FROM job WHERE id=$1`, [fallido.id])).rows[0].estado);
    expect(sigue).toBe('FALLIDO');
  });

  it('un trabajo idempotente fallido vuelve a la cola una sola vez aunque se pulse dos veces', async () => {
    const id = uuidv7();
    await E.db.withPlatform((tx) => tx.query(`INSERT INTO job (id, tenant_id, tipo, payload, estado, intentos, max_intentos) VALUES ($1,$2,'verificar_whatsapp','{}','FALLIDO',5,5)`, [id, E.A]));
    const r = await Promise.all([admin.post(`/trabajos/${id}/reintentar`), admin.post(`/trabajos/${id}/reintentar`)]);
    expect(r.map((x) => x.body.reintentado).sort()).toEqual([false, true]);
    const j = await E.db.withOperador(async (tx) => (await tx.query(`SELECT estado, intentos FROM job WHERE id=$1`, [id])).rows[0]);
    expect(j).toEqual({ estado: 'PENDIENTE', intentos: 4 });
  });
});

// ---------------------------------------------------------------- 7. auditoría
describe('7. Las operaciones administrativas sensibles quedan auditadas', () => {
  it('suspender exige motivo y confirmar el subdominio; no borra datos; se audita quién, qué, por qué y resultado', async () => {
    const clientesAntes = await E.db.raw(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM customer WHERE tenant_id=$1`, [E.B])).rows[0].n);
    const mal = await admin.post(`/empresas/${E.B}/estado`, { estado: 'SUSPENDIDA', motivo: 'Mora de dos meses sin respuesta', confirmacion: 'otra-cosa' });
    expect(mal.status).toBe(409);
    const ok = await admin.post(`/empresas/${E.B}/estado`, { estado: 'SUSPENDIDA', motivo: 'Mora de dos meses sin respuesta', confirmacion: 'fuerzanorte' });
    expect(ok.body).toMatchObject({ ok: true, estado: 'SUSPENDIDA' });
    const de = await admin.post(`/empresas/${E.B}/estado`, { estado: 'SUSPENDIDA', motivo: 'Mora de dos meses sin respuesta', confirmacion: 'fuerzanorte' });
    expect(de.body.sin_cambios).toBe(true);
    expect((await admin.post(`/empresas/${E.B}/estado`, { estado: 'ACTIVA', motivo: 'Pago recibido por transferencia', confirmacion: 'fuerzanorte' })).status).toBe(200);
    const clientesDespues = await E.db.raw(async (tx) => (await tx.query(`SELECT count(*)::int AS n FROM customer WHERE tenant_id=$1`, [E.B])).rows[0].n);
    expect(clientesDespues).toBe(clientesAntes);

    const eventos = (await admin.get('/auditoria')).body.eventos.filter((e: any) => e.accion === 'empresa.estado' && e.empresa_id === E.B);
    expect(eventos.map((e: any) => e.resultado)).toEqual(['EXITO', 'SIN_CAMBIOS', 'EXITO', 'DENEGADO']);
    for (const e of eventos) expect(e).toMatchObject({ actor: 'plataforma@saas.test', recurso: 'tenant', recurso_id: E.B });
    expect(eventos[2].motivo).toBe('Mora de dos meses sin respuesta');
    expect(eventos[2].detalle).toEqual({ anterior: 'ACTIVA', nuevo: 'SUSPENDIDA' });
    // La empresa recibe el aviso administrativo por correo.
    await drain(E.db);
    expect(falso.enviados.some((m) => m.tipo === 'aviso_admin_suspendida' && m.para === CRED.gym[0])).toBe(true);
  });

  it('cambios de plan, módulos, límites, incidentes y tickets también quedan auditados', async () => {
    expect((await admin.post(`/empresas/${E.B}/plan`, { plan: 'negocio', motivo: 'Cambio solicitado por la empresa', confirmacion: 'fuerzanorte' })).status).toBe(200);
    expect((await admin.post(`/empresas/${E.B}/modulos`, { modulo: 'facturacion', activo: false, motivo: 'Módulo sin proveedor fiscal habilitado' })).status).toBe(200);
    expect((await admin.patch('/planes/esencial', { cuota_tokens_ia: 600000, cuota_mensajes: 1500, cuota_documentos: 60, max_usuarios: 3, motivo: 'Ajuste de límites del plan' })).status).toBe(200);
    const inc = (await admin.get('/incidentes')).body.incidentes.find((i: any) => i.estado === 'ABIERTO');
    expect((await admin.patch(`/incidentes/${inc.id}`, { estado: 'RESUELTO', nota: 'Corregido en el despliegue' })).status).toBe(200);
    const acciones = (await admin.get('/auditoria')).body.eventos.map((e: any) => e.accion);
    expect(acciones).toEqual(expect.arrayContaining(['empresa.plan', 'empresa.modulo', 'plan.limites', 'incidente.estado']));
  });

  it('la auditoría no se puede modificar desde el panel ni con el rol de la base', async () => {
    expect((await E.app.inject({ method: 'PATCH', url: '/api/operador/auditoria', headers: { cookie: await loginOperador(E.app, E.db) }, payload: {} })).statusCode).toBe(403);
    await expect(E.db.withOperador((tx) => tx.query(`UPDATE auditoria_plataforma SET motivo='x'`))).rejects.toThrow(/permission denied/i);
    await expect(E.db.withOperador((tx) => tx.query(`DELETE FROM auditoria_plataforma`))).rejects.toThrow(/permission denied/i);
    await expect(E.db.withPlatform((tx) => tx.query(`DELETE FROM auditoria_plataforma`))).rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------- estadísticas reales
describe('Estadísticas de la plataforma', () => {
  it('el resumen cuenta empresas, ingresos de Omnegia y solicitudes con su latencia', async () => {
    await volcarMetricas(E.db);
    const r = (await admin.get('/resumen')).body;
    expect(r.empresas.total).toBeGreaterThanOrEqual(2);
    expect(r.empresas.por_estado.ACTIVA).toBeGreaterThanOrEqual(1);
    expect(r.solicitudes.total).toBeGreaterThan(0);
    expect(r.solicitudes.disponibilidad).toBeGreaterThan(0);
    expect(r.ingresos.moneda).toBe('COP');
    expect(r.ia.tokens_entrada + r.ia.tokens_salida).toBeGreaterThan(0);
    expect(r.ia.costo_estimado_usd).toBeNull(); // sin precios configurados no se inventa un costo
    const s = (await admin.get('/salud')).body;
    expect(s.rutas.every((x: any) => !/[0-9a-f]{8}-[0-9a-f]{4}/.test(x.ruta))).toBe(true); // plantilla de ruta, nunca ids
    expect(s.base.disponible).toBe(true);
  });

  it('el periodo se valida', async () => {
    expect((await admin.get('/resumen?desde=2026-12-01&hasta=2026-01-01')).status).toBe(400);
    expect((await admin.get('/resumen?desde=2020-01-01&hasta=2026-01-01')).status).toBe(400);
  });
});
