import { z } from 'zod';
import type { Database, Tx } from '../db/index.js';
import { auditPlatform } from '../core/audit.js';
import { AppError, invalid, notFound } from '../lib/errors.js';
import { decrypt, encrypt, isUuid } from '../lib/util.js';
import { config } from '../config.js';
import { auditar, exigir, type Operador } from '../modules/operador.js';
import { metaPlataforma, motivoRegistro, type MetaDePlataforma, type NumeroWaba } from './meta.js';
import { mensaje, validarNumero } from './propio.js';
import { cacheTokens, pinNuevo } from './servicio.js';

/**
 * «Números de WhatsApp» en el panel del operador de Omnegia.
 *
 * El único camino activo para WhatsApp es que el número quede en la WABA de Omnegia
 * (WHATSAPP_PLATFORM_WABA_ID) y se vincule a una empresa desde el panel, sin tocar código, .env ni
 * Meta Developers. Aquí el operador:
 *   - ve los números de la WABA consultando a Meta EN VIVO, cruzados con la base: a qué empresa están
 *     asignados, cuál está libre y cuál es el del asistente de la plataforma (reservado);
 *   - asigna un número a una empresa eligiéndolo de una lista (un número, una empresa: tenant.whatsapp_phone_number_id
 *     es UNIQUE) y lo desasigna sin desregistrarlo;
 *   - registra en la Cloud API un número verificado pero no registrado (POST /{id}/register con un PIN aleatorio
 *     cifrado con APP_KEY) y vuelve a consultar hasta verlo CONNECTED;
 *   - verifica con código (SMS o llamada) un número sin verificar, agrega números nuevos respetando el límite
 *     de la WABA y desregistra un número (deregister) con confirmación.
 *
 * Ningún token ni PIN sale en respuestas, registros ni auditoría (el PIN solo con «Ver PIN», auditado).
 * channelInbound resuelve la empresa por tenant.whatsapp_phone_number_id en cada mensaje: una asignación vale
 * desde el siguiente mensaje, sin reiniciar nada.
 */
const PERMISO = 'numeros:gestionar' as const;
/** Consultas a Meta después de registrar, hasta ver CONNECTED (la Cloud API puede tardar unos segundos). */
export const ESPERA_REGISTRO = { intentos: 5, ms: 1500 };

const operativo = (n: NumeroWaba) => n.estado === 'CONNECTED' && n.plataforma === 'CLOUD_API';
const verificado = (n: NumeroWaba) => n.verificacion === 'VERIFIED' || operativo(n);
const esReservado = (id: string) => !!config.whatsapp.plataformaPhoneNumberId && id === config.whatsapp.plataformaPhoneNumberId;
const sinPlataforma = () => new AppError('CONFLICT', 'La conexión de Omnegia con WhatsApp está pendiente de configurar (WHATSAPP_ACCESS_TOKEN y WHATSAPP_PLATFORM_WABA_ID).', { motivo: 'SIN_CONFIGURAR' });
const deMeta = (e: unknown) => { const m = motivoRegistro(e); return new AppError('CONFLICT', mensaje(m), { motivo: m }); };

function plataforma(): MetaDePlataforma {
  const mp = metaPlataforma();
  if (!mp) throw sinPlataforma();
  return mp;
}

async function numerosWaba(mp: MetaDePlataforma): Promise<NumeroWaba[]> {
  try { return await mp.meta.listarNumeros(mp.waba, mp.token); } catch (e) { throw deMeta(e); }
}

async function numeroDe(mp: MetaDePlataforma, id: string): Promise<NumeroWaba> {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound();
  const n = (await numerosWaba(mp)).find((x) => x.id === id);
  if (!n) throw new AppError('NOT_FOUND', 'Ese número no está en la cuenta de WhatsApp Business de Omnegia.');
  return n;
}

/** Estado en lenguaje simple y acciones disponibles para un número. */
function describir(n: NumeroWaba, x: { asignado: { id: string; nombre: string; slug: string } | null; enProceso: { nombre: string } | null; conPin: boolean }) {
  const reservado = esReservado(n.id);
  const acciones: string[] = [];
  let texto: string;
  let nivel: 'ok' | 'aviso' | 'error' | 'neutro';
  if (reservado) { texto = 'Número del asistente de Omnegia (reservado)'; nivel = 'neutro'; }
  else if (operativo(n)) { texto = x.asignado ? `Conectado · ${x.asignado.nombre}` : 'Conectado · sin asignar'; nivel = x.asignado ? 'ok' : 'aviso'; }
  else if (n.estado === 'DISCONNECTED' || (verificado(n) && n.plataforma === 'NOT_APPLICABLE' && n.estado !== 'PENDING')) { texto = 'Desregistrado: regístralo para volver a usarlo'; nivel = 'aviso'; }
  else if (verificado(n)) { texto = 'Verificado, falta registrarlo en la API: no recibe ni envía mensajes'; nivel = 'error'; }
  else { texto = 'Falta verificarlo con el código (SMS o llamada)'; nivel = 'aviso'; }
  if (!reservado) {
    if (!x.asignado && !x.enProceso) acciones.push('asignar');
    if (x.asignado && !x.enProceso) acciones.push('desasignar');
    if (verificado(n) && !operativo(n)) acciones.push('registrar');
    if (!verificado(n)) acciones.push('enviar_codigo', 'verificar_codigo');
    if (operativo(n) && !x.enProceso) acciones.push('desregistrar');
  }
  if (x.conPin) acciones.push('ver_pin');
  return { reservado, operativo: operativo(n), verificado: verificado(n), texto, nivel, acciones };
}

async function cruce(db: Database, ids: string[]) {
  const asignados = await db.withOperador(async (tx) =>
    (await tx.query(`SELECT id, slug, nombre, whatsapp_phone_number_id AS pid, whatsapp_estado FROM tenant WHERE whatsapp_phone_number_id = ANY($1::text[])`, [ids])).rows);
  // Procesos «Usar mi propio número» en curso y PIN guardados: datos técnicos que lee el servidor tras comprobar el permiso.
  const { procesos, pines } = await db.withPlatform(async (tx) => ({
    procesos: (await tx.query(`SELECT n.phone_number_id AS pid, t.nombre FROM numero_contratacion n JOIN tenant t ON t.id=n.tenant_id
                               WHERE n.phone_number_id = ANY($1::text[]) AND n.estado NOT IN ('CANCELADO','CONECTADO')`, [ids])).rows,
    pines: (await tx.query(`SELECT phone_number_id AS pid FROM numero_credencial_plataforma WHERE phone_number_id = ANY($1::text[])`, [ids])).rows,
  }));
  return {
    asignado: new Map(asignados.map((t: any) => [t.pid, { id: t.id, nombre: t.nombre, slug: t.slug }])),
    enProceso: new Map(procesos.map((p: any) => [p.pid, { nombre: p.nombre }])),
    conPin: new Set(pines.map((p: any) => p.pid)),
  };
}

function vista(n: NumeroWaba, c: Awaited<ReturnType<typeof cruce>>) {
  const x = { asignado: c.asignado.get(n.id) ?? null, enProceso: c.enProceso.get(n.id) ?? null, conPin: c.conPin.has(n.id) };
  return {
    id: n.id, numero: n.numero, nombre: n.nombre, estado_meta: n.estado, verificacion: n.verificacion, estado_nombre: n.estadoNombre,
    calidad: n.calidad, plataforma: n.plataforma, asignado: x.asignado, en_proceso: x.enProceso, ...describir(n, x),
  };
}

// ---------------------------------------------------------------------------
// Lista y búsqueda de empresas
// ---------------------------------------------------------------------------
export async function listar(db: Database, op: Operador) {
  exigir(op, PERMISO);
  const mp = metaPlataforma();
  const limite = config.whatsapp.limiteNumerosWaba;
  if (!mp) return { configurada: false, motivo: sinPlataforma().message, numeros: [], limite, usados: 0, simulado: false };
  const numeros = await numerosWaba(mp);
  const c = await cruce(db, numeros.map((n) => n.id));
  return {
    configurada: true, simulado: mp.meta.simulado, waba: mp.meta.simulado ? 'Simulación' : `···${mp.waba.slice(-4)}`,
    limite, usados: numeros.length, puede_agregar: numeros.length < limite,
    motivo_limite: numeros.length >= limite ? `La cuenta de WhatsApp de Omnegia ya tiene ${numeros.length} de ${limite} números permitidos. Con el portafolio de Meta sin verificar el límite es 2: verifica el negocio en Meta (o libera un número) antes de agregar otro.` : null,
    numeros: numeros.map((n) => vista(n, c)).sort((a, b) => Number(b.reservado) - Number(a.reservado) || String(a.numero).localeCompare(String(b.numero))),
  };
}

export async function buscarEmpresas(db: Database, op: Operador, q: unknown) {
  exigir(op, PERMISO);
  const texto = String(q ?? '').trim().slice(0, 60);
  return db.withOperador(async (tx) => ({
    empresas: (await tx.query(
      `SELECT id, slug, nombre, whatsapp_estado, whatsapp_numero_visible, (whatsapp_phone_number_id IS NOT NULL AND whatsapp_phone_number_id NOT LIKE 'sim-%') AS tiene_numero
       FROM tenant ${texto ? `WHERE nombre ILIKE $1 OR slug ILIKE $1` : ''} ORDER BY nombre LIMIT 20`, texto ? [`%${texto}%`] : [])).rows,
  }));
}

// ---------------------------------------------------------------------------
// Asignar y desasignar (sin tocar Meta)
// ---------------------------------------------------------------------------
async function auditarTodo(db: Database, op: Operador, tenantId: string | null, accion: string, numero: NumeroWaba, resultado: 'EXITO' | 'ERROR', detalle: Record<string, string | number | boolean | null> = {}) {
  await db.withPlatform(async (tx) => {
    await auditar(tx, op, { accion: `numero_waba.${accion}`, recurso: 'numero_waba', recursoId: numero.id, tenantId, resultado, detalle: { numero: numero.numero, ...detalle } });
    if (tenantId) await auditPlatform(tx, tenantId, { tipo: 'PLATAFORMA', id: op.user.id, nombre: 'Equipo de Omnegia' }, 'PLATAFORMA', op.correlacion, { accion: `canal.${accion}`, recurso: 'tenant', recursoId: tenantId, resultado, detalle: { numero: numero.numero, ...detalle } });
  });
}

const datosTenant = (n: NumeroWaba, simulado: boolean) => ({
  estado: operativo(n) ? (simulado ? 'SIMULADO' : 'CONECTADO') : 'PENDIENTE_REGISTRO',
  diagnostico: { ok: operativo(n), numero: n.numero, nombre: n.nombre, calidad: n.calidad, estado_meta: n.estado, plataforma: n.plataforma, comprobado: new Date().toISOString() },
});

export async function asignar(db: Database, op: Operador, id: string, body: unknown) {
  exigir(op, PERMISO);
  const tenantId = (body as any)?.tenant_id;
  if (!isUuid(tenantId)) throw invalid('Elige la empresa de la lista.');
  const mp = plataforma();
  const n = await numeroDe(mp, id);
  if (esReservado(n.id)) throw new AppError('CONFLICT', 'Ese es el número del asistente de Omnegia: no se asigna a una empresa.');
  const r = await db.withPlatform(async (tx) => {
    const t = (await tx.query(`SELECT id, nombre, whatsapp_phone_number_id, whatsapp_estado FROM tenant WHERE id=$1 FOR UPDATE`, [tenantId])).rows[0];
    if (!t) throw notFound();
    const otra = (await tx.query(`SELECT nombre FROM tenant WHERE whatsapp_phone_number_id=$1 AND id<>$2`, [n.id, tenantId])).rows[0];
    if (otra) throw new AppError('CONFLICT', `Ese número ya está asignado a «${otra.nombre}». Desasígnalo primero si quieres pasarlo a otra empresa.`, { motivo: 'YA_ASIGNADO' });
    if (t.whatsapp_phone_number_id === n.id) return { t, igual: true };
    if (t.whatsapp_phone_number_id && !String(t.whatsapp_phone_number_id).startsWith('sim-')) {
      throw new AppError('CONFLICT', `«${t.nombre}» ya tiene otro número de WhatsApp. Desasígnalo o desconéctalo antes de asignarle este.`, { motivo: 'EMPRESA_CON_NUMERO' });
    }
    const viva = (await tx.query(`SELECT phone_number_id, numero_e164 FROM numero_contratacion WHERE (tenant_id=$1 OR phone_number_id=$2) AND estado NOT IN ('CANCELADO') LIMIT 1`, [tenantId, n.id])).rows[0];
    if (viva) throw new AppError('CONFLICT', 'Hay una conexión de número en curso para esta empresa o este número («Usar mi propio número»). Espera a que termine o pide a la empresa que la cancele.', { motivo: 'EN_PROCESO' });
    const d = datosTenant(n, mp.meta.simulado);
    try {
      await tx.query(
        `UPDATE tenant SET whatsapp_phone_number_id=$2, whatsapp_estado=$3, whatsapp_numero_visible=$4, whatsapp_diagnostico=$5, whatsapp_verificado_en=CASE WHEN $6 THEN now() ELSE NULL END WHERE id=$1`,
        [tenantId, n.id, d.estado, n.numero, JSON.stringify(d.diagnostico), operativo(n)]);
    } catch (e) {
      if (/whatsapp_phone_number_id|unique/i.test(String((e as Error).message))) throw new AppError('CONFLICT', 'Ese número ya está asignado a otra empresa.', { motivo: 'YA_ASIGNADO' });
      throw e;
    }
    return { t, igual: false, estado: d.estado };
  });
  cacheTokens.delete(n.id);
  if (!r.igual) await auditarTodo(db, op, tenantId, 'asignar', n, 'EXITO', { empresa: r.t.nombre, operativo: operativo(n) });
  return {
    ok: true, empresa: r.t.nombre, numero: n.numero, operativo: operativo(n),
    mensaje: operativo(n) ? `Listo: ${n.numero} atiende ahora a «${r.t.nombre}». Los mensajes que lleguen desde ya los responde su IA.`
      : `Asignado a «${r.t.nombre}», pero el número todavía no está registrado en la API: usa «Registrar en la API» para que reciba y envíe mensajes.`,
    acciones: operativo(n) ? [] : ['registrar'],
  };
}

/** Quita el número a su empresa sin desregistrarlo: queda libre en la WABA para asignarlo de nuevo. */
export async function desasignar(db: Database, op: Operador, id: string) {
  exigir(op, PERMISO);
  const mp = plataforma();
  const n = await numeroDe(mp, id);
  const t = await liberarDeEmpresa(db, n.id, 'SIN_CONFIGURAR');
  if (!t) throw new AppError('CONFLICT', 'Ese número no está asignado a ninguna empresa.');
  await auditarTodo(db, op, t.id, 'desasignar', n, 'EXITO', { empresa: t.nombre });
  return { ok: true, empresa: t.nombre, mensaje: `${n.numero} quedó libre. «${t.nombre}» ya no recibe mensajes por ese número.` };
}

async function liberarDeEmpresa(db: Database, pid: string, estado: string) {
  return db.withPlatform(async (tx) => {
    const proceso = (await tx.query(`SELECT 1 FROM numero_contratacion WHERE phone_number_id=$1 AND estado NOT IN ('CANCELADO')`, [pid])).rows[0];
    if (proceso) throw new AppError('CONFLICT', 'La empresa conectó este número con «Usar mi propio número»: debe desconectarlo desde su panel (Número de WhatsApp › Desconectar).', { motivo: 'PROPIO' });
    const t = (await tx.query(
      `UPDATE tenant SET whatsapp_phone_number_id=NULL, whatsapp_estado=$2, whatsapp_numero_visible=NULL, whatsapp_diagnostico=NULL, whatsapp_verificado_en=NULL
       WHERE whatsapp_phone_number_id=$1 RETURNING id, nombre`, [pid, estado])).rows[0] as { id: string; nombre: string } | undefined;
    cacheTokens.delete(pid);
    return t ?? null;
  });
}

// ---------------------------------------------------------------------------
// Registro en la Cloud API (PIN aleatorio, cifrado)
// ---------------------------------------------------------------------------
async function pinGuardado(tx: Tx, pid: string): Promise<string | null> {
  const r = (await tx.query(`SELECT pin_cifrado FROM numero_credencial_plataforma WHERE phone_number_id=$1`, [pid])).rows[0];
  try { return r?.pin_cifrado ? decrypt(config.appKey, r.pin_cifrado) : null; } catch { return null; }
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export async function registrar(db: Database, op: Operador, id: string) {
  exigir(op, PERMISO);
  const mp = plataforma();
  const n = await numeroDe(mp, id);
  if (esReservado(n.id)) throw new AppError('CONFLICT', 'El número del asistente de Omnegia se administra aparte.');
  if (operativo(n)) return { ok: true, operativo: true, mensaje: 'Este número ya está registrado y conectado.' };
  if (!verificado(n)) throw new AppError('CONFLICT', 'Primero verifica el número con el código (SMS o llamada). Después podrás registrarlo.', { motivo: 'SIN_VERIFICAR' });
  // El PIN se guarda ANTES de llamar a Meta: si la respuesta se pierde, el siguiente intento usa el mismo.
  const pin = await db.withPlatform(async (tx) => {
    const previo = await pinGuardado(tx, n.id);
    if (previo) return previo;
    const nuevo = pinNuevo();
    await tx.query(`INSERT INTO numero_credencial_plataforma (phone_number_id, pin_cifrado) VALUES ($1,$2)
                    ON CONFLICT (phone_number_id) DO UPDATE SET pin_cifrado=EXCLUDED.pin_cifrado, actualizado_en=now()`, [n.id, encrypt(config.appKey, nuevo)]);
    return nuevo;
  });
  try { await mp.meta.registrar(n.id, mp.token, pin); } catch (e) {
    await auditarTodo(db, op, null, 'registrar', n, 'ERROR', { motivo: motivoRegistro(e) });
    throw deMeta(e);
  }
  let d = await mp.meta.consultar(n.id, mp.token).catch(() => null);
  for (let i = 1; i < ESPERA_REGISTRO.intentos && !(d?.estado === 'CONNECTED' && d?.plataforma === 'CLOUD_API'); i++) {
    await esperar(ESPERA_REGISTRO.ms);
    d = await mp.meta.consultar(n.id, mp.token).catch(() => null);
  }
  const conectado = d?.estado === 'CONNECTED' && (d?.plataforma ?? 'CLOUD_API') === 'CLOUD_API';
  const t = await db.withPlatform(async (tx) => {
    await tx.query(`UPDATE numero_credencial_plataforma SET registrado_en=now(), actualizado_en=now() WHERE phone_number_id=$1`, [n.id]);
    if (!conectado) return (await tx.query(`SELECT id, nombre FROM tenant WHERE whatsapp_phone_number_id=$1`, [n.id])).rows[0] ?? null;
    const x = { ...n, estado: d!.estado, plataforma: d!.plataforma ?? 'CLOUD_API' };
    const dt = datosTenant(x, mp.meta.simulado);
    return (await tx.query(`UPDATE tenant SET whatsapp_estado=$2, whatsapp_diagnostico=$3, whatsapp_verificado_en=now() WHERE whatsapp_phone_number_id=$1 RETURNING id, nombre`,
      [n.id, dt.estado, JSON.stringify(dt.diagnostico)])).rows[0] ?? null;
  });
  await auditarTodo(db, op, t?.id ?? null, 'registrar', n, 'EXITO', { conectado });
  return {
    ok: true, operativo: conectado,
    mensaje: conectado ? `${n.numero} quedó registrado y conectado.${t ? ` Atiende a «${t.nombre}».` : ' Ya puedes asignarlo a una empresa.'}`
      : 'Meta aceptó el registro, pero el número todavía no aparece conectado. Vuelve a consultar en unos minutos.',
  };
}

/** Muestra el PIN de dos pasos guardado. Acción explícita, con motivo, que queda en la auditoría (sin el PIN). */
export async function verPin(db: Database, op: Operador, id: string, body: unknown) {
  exigir(op, PERMISO);
  const motivo = String((body as any)?.motivo ?? '').trim();
  if (motivo.length < 5) throw invalid('Escribe para qué necesitas ver el PIN.');
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw notFound();
  const pin = await db.withPlatform((tx) => pinGuardado(tx, id));
  if (!pin) throw new AppError('NOT_FOUND', 'No hay un PIN guardado para ese número.');
  await db.withPlatform((tx) => auditar(tx, op, { accion: 'numero_waba.ver_pin', recurso: 'numero_waba', recursoId: id, motivo: motivo.slice(0, 200), resultado: 'EXITO' }));
  return { pin };
}

// ---------------------------------------------------------------------------
// Verificación con código y alta de números
// ---------------------------------------------------------------------------
export async function enviarCodigo(db: Database, op: Operador, id: string, body: unknown) {
  exigir(op, PERMISO);
  const metodo = (body as any)?.metodo === 'VOICE' ? 'VOICE' : 'SMS';
  const mp = plataforma();
  const n = await numeroDe(mp, id);
  if (verificado(n)) return { ok: true, ya_verificado: true, mensaje: 'Este número ya está verificado: regístralo en la API.' };
  try { await mp.meta.solicitarCodigo(n.id, mp.token, metodo); } catch (e) {
    if (motivoRegistro(e) === 'YA_VERIFICADO') return { ok: true, ya_verificado: true, mensaje: 'Meta dice que este número ya está verificado: regístralo en la API.' };
    await auditarTodo(db, op, null, 'codigo', n, 'ERROR', { metodo, motivo: motivoRegistro(e) });
    throw deMeta(e);
  }
  await auditarTodo(db, op, null, 'codigo', n, 'EXITO', { metodo });
  return { ok: true, mensaje: metodo === 'SMS' ? `Enviamos un SMS con el código a ${n.numero}.` : `Meta llamará a ${n.numero} para dictar el código.` };
}

export async function verificarCodigo(db: Database, op: Operador, id: string, body: unknown) {
  exigir(op, PERMISO);
  const b = z.object({ codigo: z.string().trim().regex(/^\d{3}[- ]?\d{3}$/, 'El código tiene 6 dígitos.') }).safeParse(body);
  if (!b.success) throw invalid(b.error.issues[0]?.message ?? 'El código tiene 6 dígitos.');
  const mp = plataforma();
  const n = await numeroDe(mp, id);
  let ok = false;
  try { ok = await mp.meta.verificarCodigo(n.id, mp.token, b.data.codigo.replace(/\D/g, '')); } catch (e) { throw deMeta(e); }
  await auditarTodo(db, op, null, 'verificar', n, ok ? 'EXITO' : 'ERROR');
  if (!ok) throw new AppError('CONFLICT', mensaje('CODIGO_INCORRECTO'), { motivo: 'CODIGO_INCORRECTO' });
  return { ok: true, mensaje: 'Número verificado. Ahora regístralo en la API.', acciones: ['registrar'] };
}

const NuevoNumero = z.object({
  nombre_visible: z.string().trim().min(3, 'El nombre visible debe tener al menos 3 caracteres.').max(80),
  pais: z.string().regex(/^[A-Z]{2}$/).default('CO'),
  numero: z.string().trim().min(4).max(24),
});

export async function agregar(db: Database, op: Operador, body: unknown) {
  exigir(op, PERMISO);
  const b = NuevoNumero.safeParse(body ?? {});
  if (!b.success) throw invalid(b.error.issues[0]?.message ?? 'Revisa los datos.');
  const v = validarNumero(b.data.pais, b.data.numero);
  const mp = plataforma();
  const numeros = await numerosWaba(mp);
  const limite = config.whatsapp.limiteNumerosWaba;
  // Con el límite alcanzado no se llama a Meta: se explica qué hacer.
  if (numeros.length >= limite) {
    throw new AppError('CONFLICT', `La cuenta de WhatsApp de Omnegia ya tiene ${numeros.length} de ${limite} números permitidos. Con el portafolio de Meta sin verificar el límite es 2: verifica el negocio en el Administrador comercial de Meta (o desregistra y elimina un número) antes de agregar otro.`, { motivo: 'LIMITE_NUMEROS' });
  }
  const limpio = v.e164.replace(/\D/g, '');
  const ya = numeros.find((x) => String(x.numero ?? '').replace(/\D/g, '') === limpio);
  if (ya) return { ok: true, id: ya.id, existente: true, mensaje: 'Ese número ya está en la cuenta de Omnegia.' };
  let nuevoId: string;
  try { nuevoId = await mp.meta.agregarNumero(mp.waba, mp.token, { cc: v.cc, numero: v.nacional, nombre: b.data.nombre_visible }); } catch (e) {
    const motivo = motivoRegistro(e);
    const recuperado = motivo === 'NUMERO_YA_EN_LA_CUENTA' ? await mp.meta.buscarNumero(mp.waba, mp.token, v.e164).catch(() => null) : null;
    if (!recuperado) {
      await db.withPlatform((tx) => auditar(tx, op, { accion: 'numero_waba.agregar', recurso: 'numero_waba', resultado: 'ERROR', detalle: { motivo } }));
      throw new AppError('CONFLICT', mensaje(motivo, { nombre: b.data.nombre_visible }), { motivo });
    }
    nuevoId = recuperado;
  }
  await db.withPlatform((tx) => auditar(tx, op, { accion: 'numero_waba.agregar', recurso: 'numero_waba', recursoId: nuevoId, resultado: 'EXITO', detalle: { pais: b.data.pais } }));
  return { ok: true, id: nuevoId, existente: false, mensaje: 'Número agregado a la cuenta de Omnegia. Ahora envía el código para verificarlo.', acciones: ['enviar_codigo'] };
}

/** deregister: el número deja de funcionar en la Cloud API y queda libre (sin empresa). */
export async function desregistrar(db: Database, op: Operador, id: string, body: unknown) {
  exigir(op, PERMISO);
  if (String((body as any)?.confirmacion ?? '').trim().toUpperCase() !== 'DESREGISTRAR') throw invalid('Escribe DESREGISTRAR para confirmar.');
  const mp = plataforma();
  const n = await numeroDe(mp, id);
  if (esReservado(n.id)) throw new AppError('CONFLICT', 'El número del asistente de Omnegia no se desregistra desde aquí.');
  // Antes de tocar Meta se comprueba que no lo esté usando un proceso de la empresa.
  const proceso = await db.withPlatform(async (tx) => (await tx.query(`SELECT 1 FROM numero_contratacion WHERE phone_number_id=$1 AND estado NOT IN ('CANCELADO')`, [n.id])).rows[0]);
  if (proceso) throw new AppError('CONFLICT', 'La empresa conectó este número con «Usar mi propio número»: debe desconectarlo desde su panel.', { motivo: 'PROPIO' });
  try { await mp.meta.desregistrar(n.id, mp.token); } catch (e) {
    await auditarTodo(db, op, null, 'desregistrar', n, 'ERROR', { motivo: motivoRegistro(e) });
    throw deMeta(e);
  }
  const t = await liberarDeEmpresa(db, n.id, 'DESCONECTADO');
  await auditarTodo(db, op, t?.id ?? null, 'desregistrar', n, 'EXITO', { empresa: t?.nombre ?? null });
  return { ok: true, mensaje: `${n.numero} quedó desregistrado${t ? ` y «${t.nombre}» dejó de usarlo` : ''}. Para volver a usarlo, regístralo de nuevo.` };
}
