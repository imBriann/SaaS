import { z } from 'zod';
import type { Tx } from '../db/index.js';
import { type Ctx, requirePerm } from '../core/context.js';
import type { Permiso } from '../core/permissions.js';
import { zonaDe } from '../core/tenant.js';
import { invalid } from '../lib/errors.js';
import { addDays, rangoDia, todayLocal } from '../lib/time.js';
import { cop } from '../lib/util.js';
import { Informe } from '../ai/visual.js';

/**
 * Informes de la empresa con datos reales, en la plantilla de Omnegia (la misma que usa el asistente).
 * Aquí no interviene el modelo: cada cifra sale de una consulta y el resultado se valida con el esquema
 * Informe antes de salir. Si el periodo no tiene movimiento, el informe lo dice (no rellena).
 */
export const TIPOS_INFORME = ['ventas', 'cobros', 'agenda', 'clientes', 'inventario'] as const;
export type TipoInforme = (typeof TIPOS_INFORME)[number];
const PERMISO: Record<TipoInforme, Permiso> = { ventas: 'order:read', cobros: 'order:read', agenda: 'appointment:read', clientes: 'customer:read', inventario: 'inventory:read' };
const MODULO: Partial<Record<TipoInforme, string>> = { ventas: 'ventas', cobros: 'ventas', agenda: 'agenda', inventario: 'inventario' };
const METODO: Record<string, string> = { EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', DATAFONO: 'Datáfono', PASARELA: 'Pasarela' };
const ESTADO_CITA: Record<string, string> = { RESERVADA: 'Reservada', CONFIRMADA: 'Confirmada', ATENDIDA: 'Atendida', NO_ASISTIO: 'No asistió', CANCELADA: 'Cancelada' };

const Consulta = z.object({
  periodo: z.enum(['semana', 'mes', 'mes_anterior', 'rango']).default('mes'),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** Qué informes puede abrir esta persona (rol y módulos activos). */
export async function informesDisponibles(tx: Tx, ctx: Ctx) {
  const activos = new Set((await tx.query(`SELECT modulo FROM tenant_module WHERE activo`)).rows.map((r) => r.modulo));
  return { tipos: TIPOS_INFORME.filter((t) => (ctx.permisos.has('*') || ctx.permisos.has(PERMISO[t])) && (!MODULO[t] || activos.has(MODULO[t]!))) };
}

const dias = (a: string, b: string) => Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000) + 1;
const fechaCorta = (f: string) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', timeZone: 'UTC' }).replace('.', '');
const fechaLarga = (f: string) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)} %` : '—');
const corta = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function rangoDe(q: z.infer<typeof Consulta>, hoy: string) {
  if (q.periodo === 'semana') return { desde: addDays(hoy, -6), hasta: hoy, nombre: 'Últimos 7 días' };
  if (q.periodo === 'mes') return { desde: `${hoy.slice(0, 8)}01`, hasta: hoy, nombre: 'Este mes' };
  if (q.periodo === 'mes_anterior') {
    const [a, m] = [Number(hoy.slice(0, 4)), Number(hoy.slice(5, 7))];
    const desde = m === 1 ? `${a - 1}-12-01` : `${a}-${String(m - 1).padStart(2, '0')}-01`;
    return { desde, hasta: addDays(`${hoy.slice(0, 8)}01`, -1), nombre: 'Mes anterior' };
  }
  if (!q.desde || !q.hasta) throw invalid('Elige las dos fechas del periodo.');
  if (q.desde > q.hasta) throw invalid('La fecha inicial va antes que la final.');
  if (dias(q.desde, q.hasta) > 92) throw invalid('El periodo puede tener hasta 92 días.');
  return { desde: q.desde, hasta: q.hasta, nombre: 'Periodo elegido' };
}

/** Serie por día (hasta 31 días) o por semana (periodos más largos), sin omitir los días en cero. */
function serie(desde: string, hasta: string, porDia: Map<string, number>) {
  const n = dias(desde, hasta);
  if (n <= 31) {
    const fechas = Array.from({ length: n }, (_, i) => addDays(desde, i));
    return { etiquetas: fechas.map(fechaCorta), valores: fechas.map((f) => porDia.get(f) ?? 0), unidad: 'día' };
  }
  const semanas = Math.ceil(n / 7);
  const etiquetas: string[] = [];
  const valores: number[] = [];
  for (let s = 0; s < semanas; s++) {
    const ini = addDays(desde, s * 7);
    let total = 0;
    for (let d = 0; d < 7 && s * 7 + d < n; d++) total += porDia.get(addDays(ini, d)) ?? 0;
    etiquetas.push(`Sem. ${fechaCorta(ini)}`); valores.push(total);
  }
  return { etiquetas, valores, unidad: 'semana' };
}

export async function generarInforme(tx: Tx, ctx: Ctx, tipo: string, query: unknown) {
  if (!(TIPOS_INFORME as readonly string[]).includes(tipo)) throw invalid('Ese informe no existe.');
  const t = tipo as TipoInforme;
  requirePerm(ctx, PERMISO[t]);
  if (!(await informesDisponibles(tx, ctx)).tipos.includes(t)) throw invalid('Ese módulo está desactivado para tu empresa.');
  const q = Consulta.parse(query ?? {});
  const zona = await zonaDe(tx);
  const hoy = todayLocal(zona);
  const r = rangoDe(q, hoy);
  const desde = rangoDia(r.desde, zona).desde.toISOString();
  const hasta = rangoDia(r.hasta, zona).hasta.toISOString();
  const periodo = `${r.nombre} · ${fechaCorta(r.desde)}${r.desde.slice(0, 4) !== r.hasta.slice(0, 4) ? ` ${r.desde.slice(0, 4)}` : ''} – ${fechaCorta(r.hasta)} ${r.hasta.slice(0, 4)}`;
  const constructores: Record<TipoInforme, () => Promise<z.input<typeof Informe>>> = {
    ventas: () => informeVentas(tx, desde, hasta, zona, r),
    cobros: () => informeCobros(tx, desde, hasta, zona, r),
    agenda: () => informeAgenda(tx, desde, hasta, zona, r),
    clientes: () => informeClientes(tx, desde, hasta, zona, r),
    inventario: () => informeInventario(tx),
  };
  const inf = await constructores[t]();
  return { tipo: t, desde: r.desde, hasta: r.hasta, generado_en: new Date().toISOString(), informe: Informe.parse({ ...inf, periodo: t === 'inventario' ? `Existencias al ${fechaLarga(hoy)}` : periodo }) };
}

type Rango = { desde: string; hasta: string };

async function porDiaDe(tx: Tx, sql: string, params: unknown[]) {
  return new Map((await tx.query(sql, params)).rows.map((x) => [x.dia as string, Number(x.v)]));
}

async function informeVentas(tx: Tx, desde: string, hasta: string, zona: string, r: Rango) {
  const tot = (await tx.query(
    `SELECT coalesce(sum(total) FILTER (WHERE estado='CONFIRMADA'), 0)::float AS total, count(*) FILTER (WHERE estado='CONFIRMADA')::int AS n,
            coalesce(sum(impuestos) FILTER (WHERE estado='CONFIRMADA'), 0)::float AS iva, count(*) FILTER (WHERE estado='ANULADA')::int AS anuladas,
            count(*) FILTER (WHERE estado='CONFIRMADA' AND origen='AGENTE')::int AS ia
     FROM "order" WHERE creado_en >= $1 AND creado_en < $2`, [desde, hasta])).rows[0];
  const s = serie(r.desde, r.hasta, await porDiaDe(tx,
    `SELECT to_char(creado_en AT TIME ZONE $3, 'YYYY-MM-DD') AS dia, sum(total) AS v FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2 GROUP BY 1`, [desde, hasta, zona]));
  const top = (await tx.query(
    `SELECT i.descripcion AS nombre, sum(i.cantidad)::float AS cantidad, sum(i.total)::float AS total FROM order_item i JOIN "order" o ON o.id=i.order_id
     WHERE o.estado='CONFIRMADA' AND o.creado_en >= $1 AND o.creado_en < $2 GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [desde, hasta])).rows;
  const sinVentas = tot.n === 0;
  const mejor = s.valores.indexOf(Math.max(...s.valores));
  return {
    titulo: 'Informe de ventas',
    resumen: sinVentas ? 'No hubo ventas confirmadas en este periodo.'
      : `Se confirmaron ${tot.n} ${tot.n === 1 ? 'venta' : 'ventas'} por ${cop(tot.total)} (IVA incluido). El mejor ${s.unidad} fue ${s.etiquetas[mejor]} con ${cop(s.valores[mejor])}.${tot.ia ? ` La IA registró ${tot.ia} por WhatsApp.` : ''}`,
    cifras: [
      { etiqueta: 'Vendido', valor: cop(tot.total), detalle: 'IVA incluido' },
      { etiqueta: 'Ventas', valor: String(tot.n), detalle: tot.anuladas ? `${tot.anuladas} anuladas aparte` : undefined },
      { etiqueta: 'Ticket promedio', valor: cop(tot.n ? tot.total / tot.n : 0) },
      { etiqueta: 'Hechas por la IA', valor: pct(tot.ia, tot.n) },
    ],
    secciones: [
      { titulo: `Ventas por ${s.unidad}`, grafica: { tipo: 'barras' as const, titulo: `Vendido por ${s.unidad}`, unidad: 'COP', etiquetas: s.etiquetas, series: [{ nombre: 'Vendido', valores: s.valores }] } },
      ...(top.length ? [{ titulo: 'Lo más vendido', tabla: { columnas: ['Producto o servicio', 'Cantidad', 'Total'], filas: top.map((x) => [corta(x.nombre, 60), x.cantidad, cop(x.total)]) } }] : []),
    ],
    notas: `IVA del periodo: ${cop(tot.iva)}. Solo cuentan ventas confirmadas; las anuladas no suman.`,
  };
}

async function informeCobros(tx: Tx, desde: string, hasta: string, zona: string, r: Rango) {
  const metodos = (await tx.query(
    `SELECT metodo, count(*)::int AS n, coalesce(sum(monto), 0)::float AS total FROM order_payment WHERE estado='REGISTRADO' AND creado_en >= $1 AND creado_en < $2 GROUP BY 1 ORDER BY 3 DESC`, [desde, hasta])).rows;
  const anulados = (await tx.query(`SELECT count(*)::int AS n, coalesce(sum(monto), 0)::float AS total FROM order_payment WHERE estado='ANULADO' AND creado_en >= $1 AND creado_en < $2`, [desde, hasta])).rows[0];
  const pendiente = (await tx.query(`SELECT count(*)::int AS n, coalesce(sum(total), 0)::float AS total FROM "order" WHERE estado='CONFIRMADA' AND estado_pago='PENDIENTE'`)).rows[0];
  const s = serie(r.desde, r.hasta, await porDiaDe(tx,
    `SELECT to_char(creado_en AT TIME ZONE $3, 'YYYY-MM-DD') AS dia, sum(monto) AS v FROM order_payment WHERE estado='REGISTRADO' AND creado_en >= $1 AND creado_en < $2 GROUP BY 1`, [desde, hasta, zona]));
  const total = metodos.reduce((a, m) => a + m.total, 0);
  const pagos = metodos.reduce((a, m) => a + m.n, 0);
  return {
    titulo: 'Informe de cobros',
    resumen: pagos ? `Entraron ${cop(total)} en ${pagos} ${pagos === 1 ? 'pago' : 'pagos'}. ${METODO[metodos[0].metodo] ?? metodos[0].metodo} fue el medio más usado (${pct(metodos[0].total, total)}).` : 'No se registraron pagos en este periodo.',
    cifras: [
      { etiqueta: 'Cobrado', valor: cop(total) },
      { etiqueta: 'Pagos', valor: String(pagos) },
      { etiqueta: 'Por cobrar hoy', valor: cop(pendiente.total), detalle: `${pendiente.n} ${pendiente.n === 1 ? 'venta' : 'ventas'}` },
      { etiqueta: 'Anulados', valor: String(anulados.n), detalle: anulados.n ? cop(anulados.total) : undefined },
    ],
    secciones: [
      ...(metodos.length ? [{ titulo: 'Por medio de pago', grafica: { tipo: 'dona' as const, titulo: 'Cobrado por medio de pago', unidad: 'COP', etiquetas: metodos.map((m) => METODO[m.metodo] ?? m.metodo), series: [{ nombre: 'Cobrado', valores: metodos.map((m) => m.total) }] },
        tabla: { columnas: ['Medio', 'Pagos', 'Total', 'Parte'], filas: metodos.map((m) => [METODO[m.metodo] ?? m.metodo, m.n, cop(m.total), pct(m.total, total)]) } }] : []),
      { titulo: `Cobrado por ${s.unidad}`, grafica: { tipo: 'lineas' as const, titulo: `Cobrado por ${s.unidad}`, unidad: 'COP', etiquetas: s.etiquetas, series: [{ nombre: 'Cobrado', valores: s.valores }] } },
    ],
    notas: 'Se cuenta la fecha en que se registró cada pago. «Por cobrar» es el saldo pendiente de hoy, sin importar el periodo.',
  };
}

async function informeAgenda(tx: Tx, desde: string, hasta: string, zona: string, r: Rango) {
  const estados = (await tx.query(`SELECT estado, count(*)::int AS n FROM appointment WHERE inicio >= $1 AND inicio < $2 GROUP BY 1`, [desde, hasta])).rows;
  const n = (e: string) => estados.find((x) => x.estado === e)?.n ?? 0;
  const total = estados.reduce((a, x) => a + x.n, 0);
  const activas = total - n('CANCELADA');
  const ia = (await tx.query(`SELECT count(*)::int AS n FROM appointment WHERE inicio >= $1 AND inicio < $2 AND estado <> 'CANCELADA' AND origen='AGENTE'`, [desde, hasta])).rows[0].n;
  const personas = (await tx.query(
    `SELECT r.nombre, count(a.id) FILTER (WHERE a.estado <> 'CANCELADA')::int AS citas, count(a.id) FILTER (WHERE a.estado='ATENDIDA')::int AS atendidas, count(a.id) FILTER (WHERE a.estado='NO_ASISTIO')::int AS faltas
     FROM resource r LEFT JOIN appointment a ON a.resource_id=r.id AND a.inicio >= $1 AND a.inicio < $2 WHERE r.activo GROUP BY r.nombre ORDER BY 2 DESC LIMIT 12`, [desde, hasta])).rows;
  const servicios = (await tx.query(
    `SELECT p.nombre, count(*)::int AS citas FROM appointment a JOIN product p ON p.id=a.product_id WHERE a.inicio >= $1 AND a.inicio < $2 AND a.estado <> 'CANCELADA' GROUP BY 1 ORDER BY 2 DESC LIMIT 8`, [desde, hasta])).rows;
  const s = serie(r.desde, r.hasta, await porDiaDe(tx,
    `SELECT to_char(inicio AT TIME ZONE $3, 'YYYY-MM-DD') AS dia, count(*) AS v FROM appointment WHERE estado <> 'CANCELADA' AND inicio >= $1 AND inicio < $2 GROUP BY 1`, [desde, hasta, zona]));
  return {
    titulo: 'Informe de agenda',
    resumen: activas ? `Hubo ${activas} ${activas === 1 ? 'cita' : 'citas'} (sin contar ${n('CANCELADA')} canceladas). Se atendieron ${n('ATENDIDA')} y ${n('NO_ASISTIO')} no asistieron.${ia ? ` La IA agendó ${ia} por WhatsApp.` : ''}` : 'No hubo citas en este periodo.',
    cifras: [
      { etiqueta: 'Citas', valor: String(activas) },
      { etiqueta: 'Atendidas', valor: String(n('ATENDIDA')), detalle: pct(n('ATENDIDA'), activas) },
      { etiqueta: 'No asistieron', valor: String(n('NO_ASISTIO')), detalle: pct(n('NO_ASISTIO'), activas) },
      { etiqueta: 'Agendadas por la IA', valor: String(ia), detalle: pct(ia, activas) },
    ],
    secciones: [
      { titulo: `Citas por ${s.unidad}`, grafica: { tipo: 'barras' as const, titulo: `Citas por ${s.unidad}`, unidad: 'citas', etiquetas: s.etiquetas, series: [{ nombre: 'Citas', valores: s.valores }] } },
      ...(personas.length ? [{ titulo: 'Por persona', tabla: { columnas: ['Persona', 'Citas', 'Atendidas', 'No asistieron'], filas: personas.map((p) => [corta(p.nombre, 40), p.citas, p.atendidas, p.faltas]) } }] : []),
      ...(servicios.length ? [{ titulo: 'Servicios más pedidos', grafica: { tipo: 'dona' as const, titulo: 'Citas por servicio', unidad: 'citas', etiquetas: servicios.map((x) => corta(x.nombre, 24)), series: [{ nombre: 'Citas', valores: servicios.map((x) => x.citas) }] } }] : []),
    ],
    notas: `Estados contados: ${Object.entries(ESTADO_CITA).map(([k, v]) => `${v} ${n(k)}`).join(' · ')}.`,
  };
}

async function informeClientes(tx: Tx, desde: string, hasta: string, zona: string, r: Rango) {
  const c = (await tx.query(
    `SELECT (SELECT count(*)::int FROM customer WHERE eliminado_en IS NULL) AS total,
            (SELECT count(*)::int FROM customer WHERE eliminado_en IS NULL AND creado_en >= $1 AND creado_en < $2) AS nuevos,
            (SELECT count(DISTINCT customer_id)::int FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2) AS compraron,
            (SELECT count(*)::int FROM (SELECT customer_id FROM "order" WHERE estado='CONFIRMADA' AND creado_en >= $1 AND creado_en < $2 GROUP BY 1 HAVING count(*) > 1) x) AS recurrentes`, [desde, hasta])).rows[0];
  const top = (await tx.query(
    `SELECT c.nombre, count(*)::int AS compras, sum(o.total)::float AS total FROM "order" o JOIN customer c ON c.id=o.customer_id
     WHERE o.estado='CONFIRMADA' AND o.creado_en >= $1 AND o.creado_en < $2 GROUP BY c.id, c.nombre ORDER BY 3 DESC LIMIT 10`, [desde, hasta])).rows;
  const s = serie(r.desde, r.hasta, await porDiaDe(tx,
    `SELECT to_char(creado_en AT TIME ZONE $3, 'YYYY-MM-DD') AS dia, count(*) AS v FROM customer WHERE eliminado_en IS NULL AND creado_en >= $1 AND creado_en < $2 GROUP BY 1`, [desde, hasta, zona]));
  return {
    titulo: 'Informe de clientes',
    resumen: `Llegaron ${c.nuevos} ${c.nuevos === 1 ? 'cliente nuevo' : 'clientes nuevos'} y ${c.compraron} compraron en el periodo; ${c.recurrentes} volvieron a comprar más de una vez.`,
    cifras: [
      { etiqueta: 'Clientes nuevos', valor: String(c.nuevos) },
      { etiqueta: 'Compraron', valor: String(c.compraron) },
      { etiqueta: 'Recurrentes', valor: String(c.recurrentes), detalle: pct(c.recurrentes, c.compraron) },
      { etiqueta: 'Clientes en total', valor: String(c.total) },
    ],
    secciones: [
      { titulo: `Clientes nuevos por ${s.unidad}`, grafica: { tipo: 'lineas' as const, titulo: `Clientes nuevos por ${s.unidad}`, unidad: 'unidades', etiquetas: s.etiquetas, series: [{ nombre: 'Nuevos', valores: s.valores }] } },
      ...(top.length ? [{ titulo: 'Quienes más compraron', tabla: { columnas: ['Cliente', 'Compras', 'Total'], filas: top.map((x) => [corta(x.nombre, 50), x.compras, cop(x.total)]) } }] : []),
    ],
    notas: 'Un cliente nuevo es uno creado en el periodo (en el panel o al escribir por WhatsApp).',
  };
}

async function informeInventario(tx: Tx) {
  const p = (await tx.query(
    `SELECT nombre, stock::float AS stock, stock_minimo::float AS minimo, precio::float AS precio FROM product
     WHERE eliminado_en IS NULL AND activo AND controla_stock ORDER BY (stock <= stock_minimo) DESC, nombre LIMIT 40`)).rows;
  const bajo = p.filter((x) => x.stock <= x.minimo);
  const valor = p.reduce((a, x) => a + Math.max(0, x.stock) * x.precio, 0);
  const unidades = p.reduce((a, x) => a + Math.max(0, x.stock), 0);
  const mayores = [...p].sort((a, b) => b.stock * b.precio - a.stock * a.precio).slice(0, 8);
  return {
    titulo: 'Informe de inventario',
    resumen: p.length ? `${p.length} ${p.length === 1 ? 'producto controla' : 'productos controlan'} existencias${bajo.length ? `; ${bajo.length} ${bajo.length === 1 ? 'está' : 'están'} en el mínimo o por debajo y conviene reponer${bajo.length === 1 ? 'lo' : 'los'}` : ' y ninguno está bajo el mínimo'}.` : 'Ningún producto controla existencias todavía.',
    cifras: [
      { etiqueta: 'Productos con existencias', valor: String(p.length) },
      { etiqueta: 'Bajo el mínimo', valor: String(bajo.length) },
      { etiqueta: 'Unidades', valor: unidades.toLocaleString('es-CO', { maximumFractionDigits: 2 }) },
      { etiqueta: 'Valor a precio de venta', valor: cop(valor) },
    ],
    secciones: [
      ...(bajo.length ? [{ titulo: 'Por reponer', tabla: { columnas: ['Producto', 'Quedan', 'Mínimo'], filas: bajo.map((x) => [corta(x.nombre, 60), x.stock, x.minimo]) } }] : []),
      ...(mayores.length ? [{ titulo: 'Dónde está el valor', grafica: { tipo: 'barras' as const, titulo: 'Valor en existencias por producto', unidad: 'COP', etiquetas: mayores.map((x) => corta(x.nombre, 24)), series: [{ nombre: 'Valor', valores: mayores.map((x) => Math.round(Math.max(0, x.stock) * x.precio)) }] } }] : []),
      ...(p.length ? [] : [{ titulo: 'Sin datos de existencias', texto: 'Activa «Controla existencias» en los productos del catálogo para verlos aquí.' }]),
    ],
    notas: 'El valor se calcula con el precio de venta (IVA incluido), no con el costo.',
  };
}
