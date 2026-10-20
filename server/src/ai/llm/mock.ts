import type { ChatTurn, LlmClient, LoopInput, LoopOutput, StructuredInput, ToolCallOutcome } from './types.js';
import { normalizeText } from '../../lib/util.js';
import { addDays, DIAS } from '../../lib/time.js';

/**
 * Simulador determinista del modelo de lenguaje.
 *
 * Permite operar y probar la plataforma completa sin credenciales ni costo de
 * inferencia, y hace reproducibles las pruebas. Propone llamadas a herramientas
 * exactamente igual que un modelo real: por el mismo onToolCall que pasa por el
 * Gateway. No tiene ningún privilegio adicional.
 */

const NUM_PAL: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100,
};

function numberIn(s: string): number | null {
  const m = s.match(/\b(\d{1,4})\b/);
  if (m) return Number(m[1]);
  for (const [w, n] of Object.entries(NUM_PAL)) if (new RegExp(`\\b${w}\\b`).test(s)) return n;
  return null;
}

export function parseFecha(texto: string, hoy: string): string | null {
  const t = normalizeText(texto);
  if (/pasado manana/.test(t)) return addDays(hoy, 2);
  if (/\bmanana\b/.test(t)) return addDays(hoy, 1);
  if (/\bhoy\b/.test(t)) return hoy;
  const nombres: Record<string, string> = { domingo: 'dom', lunes: 'lun', martes: 'mar', miercoles: 'mie', jueves: 'jue', viernes: 'vie', sabado: 'sab' };
  for (const [n, d] of Object.entries(nombres)) {
    if (new RegExp(`\\b${n}\\b`).test(t)) {
      const hoyIdx = new Date(`${hoy}T12:00:00Z`).getUTCDay();
      const target = DIAS.indexOf(d as any);
      const delta = (target - hoyIdx + 7) % 7 || 7;
      return addDays(hoy, delta);
    }
  }
  const m = t.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (m) return `${hoy.slice(0, 4)}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export function parseHora(texto: string): string | null {
  const t = normalizeText(texto);
  let m = t.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?/);
  let h: number, min = 0, suf: string | undefined;
  if (m) { h = Number(m[1]); min = Number(m[2]); suf = m[3]; }
  else {
    m = t.match(/\b(?:a las|las|a la)\s+(\d{1,2})(?:\s*(?:y media))?\s*(am|pm|de la manana|de la tarde|de la noche)?/) ?? t.match(/\b(\d{1,2})\s*(am|pm)\b/);
    if (!m) return null;
    h = Number(m[1]); suf = m[2];
    if (/y media/.test(t)) min = 30;
  }
  if (suf && /pm|tarde|noche/.test(suf) && h < 12) h += 12;
  if (!suf && h >= 1 && h <= 7) h += 12; // «a las 3» en un negocio de barrio es de la tarde
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const STOP = new Set(['cuanto', 'cuesta', 'vale', 'valen', 'precio', 'precios', 'el', 'la', 'los', 'las', 'de', 'del', 'un', 'una', 'que', 'por', 'favor', 'hola', 'quiero', 'me', 'y', 'con', 'para', 'es', 'tienen', 'tiene', 'hay', 'comprar', 'llevar', 'valor', 'cual', 'buenas', 'buenos', 'dias', 'tardes', 'noches']);

function words(s: string) {
  return normalizeText(s).replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

function lastUser(h: ChatTurn[]) { return [...h].reverse().find((x) => x.role === 'user')?.text ?? ''; }
function recentUser(h: ChatTurn[], n = 4) { return h.filter((x) => x.role === 'user').slice(-n).map((x) => x.text).join(' \n '); }

type Item = { id: string; nombre: string; tipo: string; precio_texto: string; duracion_min?: number | null };

function matchItem(items: Item[], texto: string): Item | null {
  const t = normalizeText(texto);
  let best: { it: Item; s: number } | null = null;
  for (const it of items) {
    const n = normalizeText(it.nombre);
    let s = t.includes(n) ? 100 : 0;
    for (const w of n.split(/\s+/).filter((w) => w.length > 2)) if (t.includes(w)) s += 10;
    if (s > 0 && (!best || s > best.s)) best = { it, s };
  }
  return best?.it ?? null;
}

const has = (t: string, re: RegExp) => re.test(normalizeText(t));

export class MockLlm implements LlmClient {
  nombre = 'simulador';
  constructor(private hoy: () => string) {}

  async runLoop(input: LoopInput, call: (name: string, args: unknown) => Promise<ToolCallOutcome>): Promise<LoopOutput> {
    let toolCalls = 0;
    const tools = new Set(input.tools.map((t) => t.name));
    const tc = async (name: string, args: unknown) => {
      toolCalls++;
      return call(name, args);
    };
    const texto = lastUser(input.history);
    const tokens = Math.ceil((input.system.length + input.history.reduce((a, h) => a + h.text.length, 0)) / 4) + 120;
    const done = (text: string, stopReason = 'end_turn'): LoopOutput => ({ text, tokens, toolCalls, stopReason });

    if (input.configuracion === 'asistente') return done(await this.asistente(texto, tools, tc));
    if (input.configuracion === 'copiloto') return done('Revisé el historial del cliente. Sugiero confirmar el motivo y ofrecer una solución concreta.');

    const ctxTexto = recentUser(input.history);
    const confirmTxt = (o: ToolCallOutcome) =>
      o.content.estado === 'requiere_confirmacion'
        ? `${o.content.resumen}.\n¿Lo confirmo? Responde *SÍ* para confirmar o *NO* para cancelar.`
        : null;

    // --- Cancelar una cita
    if (has(texto, /cancel|anular (la|mi) cita|no (voy a poder|puedo) ir/) && tools.has('mis_citas')) {
      const r = await tc('mis_citas', {});
      const citas = (r.content.citas as any[]) ?? [];
      if (!citas.length) return done('No encuentro citas próximas a tu nombre. ¿Te ayudo con algo más?');
      const c = await tc('cancelar_cita', { cita_id: citas[0].id });
      return done(confirmTxt(c) ?? (c.content.error ? 'No pude cancelar esa cita. Te comunico con una persona si lo necesitas.' : 'Listo, cancelé tu cita.'));
    }
    // --- Mis citas
    if (has(texto, /mis citas|mi cita|tengo cita|a que hora (es|era)/) && tools.has('mis_citas')) {
      const r = await tc('mis_citas', {});
      const citas = (r.content.citas as any[]) ?? [];
      if (!citas.length) return done('No tienes citas próximas. ¿Quieres agendar una?');
      return done('Tus próximas citas:\n' + citas.map((c) => `• ${c.servicio} — ${c.fecha} a las ${c.hora} con ${c.recurso}`).join('\n'));
    }
    // --- Factura
    if (has(texto, /factura/) && tools.has('estado_factura')) {
      const r = await tc('estado_factura', {});
      const f = (r.content.facturas as any[]) ?? [];
      if (!f.length) return done('No encuentro facturas de compras recientes a tu nombre.');
      const est: Record<string, string> = { VALIDADO: 'validada por la DIAN', ENTREGADO: 'validada y enviada', PENDIENTE: 'en trámite', ENVIADO: 'en trámite', RECHAZADO: 'en revisión por un dato a corregir' };
      return done(f.map((x) => `• ${x.numero} (${x.total_texto}): ${est[x.estado] ?? x.estado}`).join('\n'));
    }
    // --- Catálogo (necesario para varias intenciones)
    let catalogo: Item[] | null = null;
    const cargarCatalogo = async () => {
      if (catalogo) return catalogo;
      const r = await tc('consultar_catalogo', {});
      catalogo = ((r.content.items as Item[]) ?? []);
      return catalogo;
    };
    // --- Comprar
    if (has(texto, /\b(comprar|compro|llevar|llevo|pedir|me vende|quiero (el|la|un|una|dos|tres))\b/) && tools.has('registrar_venta') && !has(texto, /cita|turno/)) {
      const items = (await cargarCatalogo()).filter((i) => i.tipo === 'PRODUCTO');
      const it = matchItem(items, texto);
      if (!it) return done('¿Qué producto te gustaría? Tenemos: ' + items.map((i) => `${i.nombre} (${i.precio_texto})`).join(', ') + '.');
      const cant = Math.max(1, Math.min(20, numberIn(normalizeText(texto).replace(normalizeText(it.nombre), '')) ?? 1));
      const r = await tc('registrar_venta', { items: [{ producto_id: it.id, cantidad: cant }] });
      return done(confirmTxt(r) ?? (r.content.error ? 'No pude registrar esa compra. ¿Te comunico con una persona?' : `Listo, compra registrada.`));
    }
    // --- Agendar
    const quiereCita = has(texto, /cita|turno|agenda|reserv|cupo|disponib|espacio|me atienden|puedo ir|a las \d/);
    if (quiereCita && tools.has('consultar_disponibilidad')) {
      const servicios = (await cargarCatalogo()).filter((i) => i.tipo === 'SERVICIO' && i.duracion_min);
      const s = matchItem(servicios, ctxTexto);
      if (!s) {
        return done('¡Claro! ¿Para qué servicio? Tenemos:\n' + servicios.map((i) => `• ${i.nombre} — ${i.precio_texto}`).join('\n'));
      }
      const fecha = parseFecha(ctxTexto, this.hoy()) ?? this.hoy();
      const hora = parseHora(texto);
      const r = await tc('consultar_disponibilidad', hora ? { servicio_id: s.id, fecha, desde: hora } : { servicio_id: s.id, fecha });
      const franjas = (r.content.franjas as any[]) ?? [];
      if (r.content.error) return done('No pude consultar la agenda en este momento.');
      if (!franjas.length) return done(`No me quedan espacios para ${s.nombre} el ${r.content.fecha_texto}${hora ? ` desde las ${hora}` : ''}. ¿Te sirve otro día u otra hora?`);
      if (hora) {
        const f = franjas.find((x) => x.hora === hora);
        if (!f) return done(`A las ${hora} no tengo espacio para ${s.nombre} el ${r.content.fecha_texto}. Más tarde me quedan: ${[...new Set(franjas.map((x) => x.hora))].slice(0, 6).join(', ')}.`);
        const c = await tc('crear_cita', { servicio_id: s.id, inicio: f.inicio, recurso_id: f.recurso_id });
        return done(confirmTxt(c) ?? (c.content.error ? 'Esa franja se acaba de ocupar. ¿Probamos otra hora?' : 'Cita creada.'));
      }
      const horas = [...new Set(franjas.map((x) => x.hora))].slice(0, 6);
      return done(`Para ${s.nombre} (${s.precio_texto}) el ${r.content.fecha_texto} tengo: ${horas.join(', ')}. ¿Cuál te sirve?`);
    }
    // --- Precio
    if (has(texto, /cuanto|precio|vale|cuesta|valor|cobran/) && tools.has('consultar_precio')) {
      const w = words(texto).join(' ');
      if (w) {
        const r = await tc('consultar_precio', { nombre: w.slice(0, 80) });
        const c = (r.content.coincidencias as any[]) ?? [];
        const exacto = c.filter((x) => normalizeText(texto).includes(normalizeText(x.nombre)));
        const mostrar = exacto.length ? exacto : c.slice(0, 3);
        if (mostrar.length) return done(mostrar.map((x) => `• ${x.nombre}: ${x.precio_texto}`).join('\n') + '\n¿Quieres que te agende?');
      }
      const items = await cargarCatalogo();
      return done('Estos son nuestros precios:\n' + items.map((i) => `• ${i.nombre}: ${i.precio_texto}`).join('\n'));
    }
    // --- Existencias
    if (has(texto, /tienen|hay|queda|stock|disponible/) && tools.has('consultar_inventario')) {
      const w = words(texto).join(' ');
      if (w) {
        const r = await tc('consultar_inventario', { nombre: w.slice(0, 80) });
        const p = (r.content.productos as any[]) ?? [];
        if (p.length) return done(p.map((x) => `• ${x.nombre} (${x.precio_texto}): ${x.disponible ? 'disponible' : 'agotado'}`).join('\n'));
      }
    }
    // --- Catálogo
    if (has(texto, /servicio|catalogo|que (hacen|ofrecen|tienen|manejan)|menu|lista/) && tools.has('consultar_catalogo')) {
      const items = await cargarCatalogo();
      return done('Esto es lo que ofrecemos:\n' + items.map((i) => `• ${i.nombre} — ${i.precio_texto}`).join('\n') + '\n¿Te agendo algo?');
    }
    if (has(texto, /^(hola|buenas|buenos|hey|ola|saludos)/)) {
      return done(`¡Hola! Te atiende el asistente de ${input.negocio.nombre}. Puedo darte precios, agendar o cancelar citas y ayudarte con tus compras. ¿Qué necesitas?`);
    }
    if (has(texto, /gracias|listo|perfecto|dale$|ok$/)) return done('¡Con gusto! Aquí estamos para lo que necesites.');
    return done('Puedo ayudarte con precios, citas (agendar, consultar o cancelar), compras y facturas. Si prefieres hablar con una persona, escríbeme «asesor».');
  }

  private async asistente(texto: string, tools: Set<string>, tc: (n: string, a: unknown) => Promise<ToolCallOutcome>): Promise<string> {
    const t = normalizeText(texto);
    const pesos = (s: string) => Number(/^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s.replace(/\./g, '').replace(',', '.'));
    const propuesta = (o: ToolCallOutcome, accion: string) => o.content.estado === 'requiere_confirmacion'
      ? `Dejé listo el cambio para que lo confirmes: ${o.content.resumen}. Usa «Confirmar» debajo de este mensaje (vence en 15 minutos); si no, nada cambia.`
      : o.isError ? `No puedo ${accion}: ${o.content.error === 'accion_no_disponible' ? 'tu rol o la configuración del asistente no lo permiten' : 'faltan datos o no son válidos'}.` : 'Listo.';
    // --- Crear un ítem: «crea el servicio Corte premium a 35.000 de 45 minutos»
    const alta = texto.match(/(?:crea|crear|agrega|agregar|añade|añadir|registra|registrar)\s+(?:el|un|una|la)?\s*(servicio|producto)\s+(?:llamado\s+)?[«"]?(.+?)[»"]?\s+(?:a|por|en|con precio de)\s+\$?\s*([\d.,]+)(?:\s*(?:pesos|cop))?(?:.*?(\d{1,3})\s*min)?/i);
    if (alta && tools.has('crear_item_catalogo')) {
      const tipo = normalizeText(alta[1]) === 'servicio' ? 'SERVICIO' : 'PRODUCTO';
      if (tipo === 'SERVICIO' && !alta[4]) return `¿Cuánto dura «${alta[2].trim()}»? Necesito la duración en minutos para poder agendarlo.`;
      const r = await tc('crear_item_catalogo', { tipo, nombre: alta[2].trim(), precio: pesos(alta[3]), ...(alta[4] ? { duracion_min: Number(alta[4]) } : {}) });
      return propuesta(r, 'crear ese ítem');
    }
    // --- Cambiar un precio: «cambia el precio del corte clásico a 30.000»
    const precio = texto.match(/(?:cambia|cambiar|sube|subir|baja|bajar|actualiza|actualizar|pon|poner)\s+(?:el\s+)?precio\s+(?:de|del|de la)\s+(.+?)\s+(?:a|en)\s+\$?\s*([\d.,]+)/i);
    const quitar = texto.match(/(?:desactiva|desactivar|oculta|ocultar|deja de ofrecer)\s+(?:el|la)?\s*(?:servicio|producto)?\s*[«"]?(.+?)[»"]?\s*$/i);
    if ((precio || quitar) && tools.has('editar_item_catalogo') && tools.has('consultar_catalogo')) {
      const items = ((await tc('consultar_catalogo', {})).content.items as Item[]) ?? [];
      const it = matchItem(items, (precio ?? quitar)![1]);
      if (!it) return 'No encontré ese ítem en tu catálogo. ¿Me dices el nombre exacto?';
      const r = await tc('editar_item_catalogo', precio ? { producto_id: it.id, precio: pesos(precio[2]) } : { producto_id: it.id, activo: false });
      return propuesta(r, 'editar ese ítem');
    }
    if (!/informe|reporte/.test(t) && /venta|vend|ingreso|\bentr(o|aron)\b|cobrad[oa]s?|\bcobre\b|cobramos|recaud|factur(a|e) (hoy|esta)|ticket/.test(t) && tools.has('resumen_ventas')) {
      const dias = /hoy/.test(t) ? 1 : /mes/.test(t) ? 30 : 7;
      const r = (await tc('resumen_ventas', { dias })).content as any;
      const top = (r.mas_vendidos ?? []).slice(0, 3).map((x: any) => `${x.descripcion} (${x.unidades})`).join(', ');
      const cobrado = (r.cobrado_por_metodo ?? []).map((x: any) => `${x.metodo} ${x.total_texto} (${x.pagos})`).join(', ');
      return `${r.dias === 1 ? 'Hoy' : `En los últimos ${r.dias} días`}: ${r.ventas} ${r.ventas === 1 ? 'venta' : 'ventas'} por ${r.total_texto}, ticket promedio ${r.ticket_promedio}.${top ? ` Lo más vendido: ${top}.` : ''}${cobrado ? `\nCobrado por método: ${cobrado}.` : '\nNo hay pagos registrados en ese periodo.'}\nFuente: ventas confirmadas y pagos registrados.`;
    }
    // --- Código: el asistente del panel no lo escribe (regla del sistema).
    if (/\b(codigo|html|css|javascript|script|programa|juego|pagina web)\b/.test(t)) {
      return 'Aquí no escribo código, páginas ni juegos. Puedo responderte con los datos de tu negocio, prepararte una gráfica o armarte un informe para descargar.';
    }
    // --- Informe de ventas con la plantilla de Omnegia.
    if (/informe|reporte/.test(t) && tools.has('resumen_ventas')) {
      const dias = /hoy/.test(t) ? 1 : /mes/.test(t) ? 30 : 7;
      const r = (await tc('resumen_ventas', { dias })).content as any;
      const top = (r.mas_vendidos ?? []).slice(0, 5);
      const informe = {
        titulo: 'Informe de ventas', periodo: r.dias === 1 ? 'Hoy' : `Últimos ${r.dias} días`,
        resumen: `${r.ventas} ${r.ventas === 1 ? 'venta' : 'ventas'} por ${r.total_texto}, con un ticket promedio de ${r.ticket_promedio}.`,
        cifras: [{ etiqueta: 'Ventas', valor: String(r.ventas) }, { etiqueta: 'Total vendido', valor: r.total_texto }, { etiqueta: 'Ticket promedio', valor: r.ticket_promedio }],
        secciones: [
          ...(top.length ? [{ titulo: 'Lo más vendido', tabla: { columnas: ['Producto o servicio', 'Unidades'], filas: top.map((x: any) => [x.descripcion, Number(x.unidades)]) },
            grafica: { tipo: 'barras', titulo: 'Unidades vendidas', unidad: 'unidades', etiquetas: top.map((x: any) => String(x.descripcion).slice(0, 24)), series: [{ nombre: 'Unidades', valores: top.map((x: any) => Number(x.unidades)) }] } }] : []),
          { titulo: 'Cobros por método', texto: (r.cobrado_por_metodo ?? []).length ? (r.cobrado_por_metodo as any[]).map((x) => `${x.metodo}: ${x.total_texto} (${x.pagos} pagos)`).join(' · ') : 'No hay pagos registrados en el periodo.' },
        ],
      };
      return 'Este es tu informe con las ventas confirmadas del periodo.\n\n```informe\n' + JSON.stringify(informe) + '\n```';
    }
    // --- Agenda de varios días en una sola consulta.
    if (/cita|agenda|turno/.test(t) && /semana|proximos dias|este mes/.test(t) && tools.has('agenda_periodo')) {
      const hoy = this.hoy();
      const d = new Date(`${hoy}T12:00:00Z`);
      const lunes = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);
      const iso = (x: Date) => x.toISOString().slice(0, 10);
      const r = (await tc('agenda_periodo', { desde: iso(lunes), hasta: iso(new Date(lunes.getTime() + 6 * 86_400_000)) })).content as any;
      const grafica = { tipo: 'barras', titulo: 'Citas por día', unidad: 'citas', etiquetas: (r.por_dia ?? []).map((x: any) => x.fecha.slice(5)), series: [{ nombre: 'Citas', valores: (r.por_dia ?? []).map((x: any) => x.citas) }] };
      const lista = (r.citas ?? []).map((c: any) => `• ${c.fecha} ${c.hora} ${c.cliente} — ${c.servicio} con ${c.recurso}`).join('\n');
      return `Del ${r.desde} al ${r.hasta} hay ${r.total} ${r.total === 1 ? 'cita' : 'citas'}.${lista ? `\n${lista}` : ''}\n\n\`\`\`grafica\n${JSON.stringify(grafica)}\n\`\`\``;
    }
    if (/cita|agenda|turno/.test(t) && tools.has('citas_del_dia')) {
      const fecha = parseFecha(texto, this.hoy()) ?? undefined;
      const r = (await tc('citas_del_dia', fecha ? { fecha } : {})).content as any;
      if (!r.citas?.length) return `No hay citas para ${r.fecha}.`;
      return `Citas del ${r.fecha} (${r.citas.length}):\n` + r.citas.map((c: any) => `• ${c.hora} ${c.cliente} — ${c.servicio} con ${c.recurso}${c.origen === 'AGENTE' ? ' [IA]' : ''}`).join('\n');
    }
    if (/stock|inventario|minimo|agot|reponer/.test(t) && tools.has('stock_bajo_minimo')) {
      const r = (await tc('stock_bajo_minimo', {})).content as any;
      if (!r.productos?.length) return 'Ningún producto está por debajo del mínimo.';
      return 'Productos en o por debajo del mínimo:\n' + r.productos.map((p: any) => `• ${p.nombre}: ${p.stock} (mínimo ${p.stock_minimo})`).join('\n');
    }
    if (/consumo|cuota|plan|tokens|limite/.test(t) && tools.has('consumo_del_plan')) {
      const r = (await tc('consumo_del_plan', {})).content as any;
      const c = r.consumo;
      return `Consumo del mes: IA ${c.tokens_ia.porcentaje}% (proyección ${c.tokens_ia.proyeccionPorcentaje}%), mensajes ${c.mensajes.porcentaje}%, documentos ${c.documentos.porcentaje}%.`;
    }
    const cli = t.match(/cliente\s+([a-zñ ]{3,40})/);
    if (cli && tools.has('buscar_cliente')) {
      const r = (await tc('buscar_cliente', { texto: cli[1].trim() })).content as any;
      if (!r.clientes?.length) return 'No encontré clientes con ese nombre.';
      return r.clientes.map((c: any) => `• ${c.nombre} ${c.telefono ?? ''}`).join('\n');
    }
    const temas: [RegExp, string][] = [[/factur|dian|nota credito/, 'facturacion'], [/agenda|cita/, 'agenda'], [/efectivo|caja|cobr|registrar (un |el )?pago|metodo de pago|datafono|transferencia/, 'cobros'], [/catalogo|producto|precio|import/, 'catalogo'], [/conversacion|chat|radicado/, 'conversaciones'], [/usuario|persona|rol|equipo/, 'usuarios'], [/\bia\b|agente|herramienta/, 'ia'], [/suscrip|pago|plan/, 'suscripcion'], [/whatsapp/, 'whatsapp']];
    for (const [re, tema] of temas) {
      if (re.test(t) && tools.has('ayuda_plataforma')) {
        const r = (await tc('ayuda_plataforma', { tema })).content as any;
        return r.guia;
      }
    }
    return 'Puedo responder sobre ventas, citas del día, inventario bajo mínimo, consumo del plan, clientes y cómo usar la plataforma. ¿Qué quieres saber?';
  }

  async structured<T>(input: StructuredInput<T>): Promise<{ data: T | null; raw: unknown; tokens: number }> {
    let raw: unknown = null;
    if (input.tarea === 'clasificar_negocio') raw = classifyHeuristic(String(input.datos ?? ''));
    if (input.tarea === 'mapear_columnas') raw = mapColumnsHeuristic(input.datos as any);
    if (input.tarea === 'resumir_caso') raw = summarizeHeuristic(input.datos as any);
    if (input.tarea === 'sugerir_respuesta') raw = suggestHeuristic(input.datos as any);
    if (input.tarea === 'mejorar_redaccion') raw = mejorarHeuristic(input.datos as any);
    if (input.tarea === 'atender_soporte') raw = soporteHeuristic(input.datos as any);
    if (input.tarea === 'resumir_hilo') {
      const d = input.datos as { previo: string | null; mensajes: { rol: string; contenido: string }[] };
      const preguntas = d.mensajes.filter((m) => m.rol === 'user').map((m) => m.contenido.replace(/\s+/g, ' ').slice(0, 80));
      raw = { resumen: [d.previo, preguntas.length ? `Se preguntó: ${preguntas.join(' | ')}` : null].filter(Boolean).join('\n').slice(0, 2500) };
    }
    if (input.tarea === 'personalizar_espacio') {
      const d = input.datos as { nombre: string; modulos: string[] };
      raw = { titulo: `El día a día de ${d.nombre}`.slice(0, 90), descripcion: 'Este espacio de demostración reúne las herramientas que elegiste para organizar tu negocio.',
        prioridades: d.modulos.slice(0, 3).map(modulo => ({ modulo, titulo: `Organiza ${modulo}`, descripcion: `Empieza a preparar ${modulo} con la información de tu negocio.` })) };
    }
    const parsed = input.schema.safeParse(raw);
    return { data: parsed.success ? parsed.data : null, raw, tokens: Math.ceil(input.user.length / 4) + 80 };
  }
}

// ---------------------------------------------------------------------------
// Heurísticas del simulador para salidas estructuradas
// ---------------------------------------------------------------------------
const SECTORES: Record<string, RegExp[]> = {
  barberia: [/barber/, /\bcorte(s)?\b/, /\bbarba\b/, /peluquer/, /\bcejas\b/],
  gimnasio: [/gimnasio/, /\bgym\b/, /entrenamiento/, /\bpesas\b/, /spinning/, /crossfit/, /membresia/, /mensualidad/],
  restaurante: [/restaurante/, /comida/, /almuerzo/, /domicilio/, /\bmenu\b/, /cocina/, /pizza/, /hamburguesa/, /corrientazo/],
  taller: [/taller/, /mecanic/, /\bmoto(s)?\b/, /\bcarro(s)?\b/, /reparacion/, /llanta/, /latoneria/],
  servicios: [/consultorio/, /estetica/, /\bspa\b/, /\bunas\b/, /manicure/, /veterinari/, /odontolog/, /asesori/, /peluqueria canina/],
};

const ROLES = 'barberos?|emplead[oa]s?|personas?|trabajador(?:a|es|as)?|entrenador(?:a|es|as)?|meser[oa]s?|mecanicos?|estilistas?|colaborador(?:a|es|as)?|asesor(?:a|es|as)?|medic[oa]s?|doctor(?:a|es|as)?|auxiliar(?:es)?|odontolog[oa]s?|enfermer[oa]s?|terapeutas?|psicolog[oa]s?|profesor(?:a|es|as)?|docentes?|vendedor(?:a|es|as)?|cociner[oa]s?|ayudantes?|cajer[oa]s?|domiciliari[oa]s?|asistentes?|recepcionistas?|manicuristas?|socios?|instructor(?:a|es|as)?|tecnicos?|operari[oa]s?';
const NUM = '\\d{1,3}|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta|cuarenta|cincuenta|cien';

/**
 * Clasificación por reglas cuando no hay modelo de lenguaje. Devuelve, por campo, la frase
 * LITERAL del texto en la que se apoya (evidencia), para que la persona vea de dónde salió.
 */
export function classifyHeuristic(descripcion: string) {
  const original = descripcion.normalize('NFC');
  // Misma longitud que el original (cada letra con tilde queda en una sola letra): los índices coinciden.
  const t = original.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const literal = (m: RegExpMatchArray | null) => (m && m.index !== undefined ? original.slice(m.index, m.index + m[0].length).trim() : undefined);
  const evidencia: Record<string, string> = {};
  let sector = 'otro', mejor = 0;
  for (const [s, res] of Object.entries(SECTORES)) {
    const n = res.filter((r) => r.test(t)).length;
    if (n > mejor) { mejor = n; sector = s; }
  }
  // Personas: se suman todas las menciones («dos médicos y una auxiliar» = 3).
  let personas: number | null = null;
  const solo = t.match(/\b(solo yo|yo solo|yo sola|sola yo|unipersonal|atiendo yo)\b/);
  if (solo) { personas = 1; evidencia.tamano = literal(solo)!; }
  const menciones = [...t.matchAll(new RegExp(`\\b(${NUM})\\s+(?:${ROLES})\\b`, 'g'))];
  if (menciones.length) {
    personas = menciones.reduce((n, m) => n + (/^\d+$/.test(m[1]) ? Number(m[1]) : NUM_PAL[m[1]] ?? 0), 0) + (/\b(y yo|conmigo|mas yo)\b/.test(t) ? 1 : 0);
    evidencia.tamano = menciones.map((m) => literal(m)).join(' · ');
  }
  const tamano = personas == null || personas < 1 ? null : personas <= 1 ? 'unipersonal' : personas <= 5 ? '2_5' : personas <= 15 ? '6_15' : 'mas_15';
  let porMes: number | null = null;
  const v = t.match(/(\d{1,5})\s+(mensajes|chats|conversaciones|clientes)\s+(?:al|por|a la|cada)?\s*(dia|diarios|semana|semanales|mes|mensuales)/);
  if (v) { porMes = Number(v[1]) * (/semana/.test(v[3]) ? 4 : /mes/.test(v[3]) ? 1 : 30); evidencia.volumen_conv_mes = literal(v)!; }
  const volumen = porMes == null ? null : porMes < 300 ? 'bajo' : porMes < 1500 ? 'medio' : 'alto';
  const noFactura = t.match(/no (?:necesito|quiero|requiero|uso|emito)[^.]{0,40}factur\w*/);
  const siFactura = t.match(/(?:necesit\w*|quier\w*|requier\w*|emitir|empezar a|tengo que)[^.]{0,40}factur\w*(?:\s+electronic\w*)?|factur\w*\s+electronic\w*|\bdian\b/);
  const factura = noFactura ? false : siFactura ? true : null;
  if (factura !== null) evidencia.factura_electronica = literal(noFactura ?? siFactura)!;
  const modulos = new Set(['clientes', 'catalogo', 'ventas', 'conversaciones', 'ia']);
  if (/cita|turno|reserva|agenda/.test(t) || ['barberia', 'gimnasio', 'servicios', 'salud', 'mascotas'].includes(sector)) modulos.add('agenda');
  if (/inventario|vendo|productos|stock|bodega/.test(t) || ['restaurante', 'taller', 'comercio', 'alimentos'].includes(sector)) modulos.add('inventario');
  if (factura) modulos.add('facturacion');
  if (sector === 'gimnasio') modulos.add('membresias');
  if (/comision/.test(t)) modulos.add('comisiones');
  const confianza = sector === 'otro' ? 0.35 : mejor >= 2 ? 0.9 : 0.72;
  return {
    sector, tamano, volumen_conv_mes: volumen, modulos_sugeridos: [...modulos], factura_electronica: factura, confianza, evidencia,
    justificacion: `Detecté ${sector === 'otro' ? 'un negocio que no encaja en los sectores disponibles' : `un negocio del sector ${sector}`}` +
      `${personas ? ` con ${personas} persona(s)` : ''}${porMes ? ` y cerca de ${porMes} conversaciones al mes` : ''}${factura ? ', que necesita factura electrónica' : ''}.`,
  };
}

const CAMPOS: Record<string, RegExp> = {
  nombre: /^(nombre|producto|servicio|descripcion|item|articulo|detalle|referencia)/,
  precio: /(precio|valor|costo|tarifa|pvp|\$)/,
  categoria: /(categoria|tipo de|linea|grupo|familia)/,
  tipo: /^(tipo|clase)$/,
  duracion_min: /(duracion|minutos|tiempo)/,
  stock: /(stock|existencia|cantidad|inventario|unidades)/,
  iva_pct: /(iva|impuesto)/,
  sku: /(sku|codigo|cod\b|ref\b)/,
};

export function mapColumnsHeuristic(d: { encabezados: string[] }) {
  const usados = new Set<string>();
  const mapeo = (d?.encabezados ?? []).map((h) => {
    const n = normalizeText(String(h ?? ''));
    for (const [campo, re] of Object.entries(CAMPOS)) {
      if (!usados.has(campo) && re.test(n)) {
        usados.add(campo);
        return { columna: String(h), campo, confianza: n.match(re)?.index === 0 ? 0.95 : 0.75 };
      }
    }
    return { columna: String(h), campo: 'ignorar', confianza: 0.5 };
  });
  return { mapeo };
}

function summarizeHeuristic(d: { mensajes: { remitente: string; contenido: string }[]; motivo: string }) {
  const cliente = (d?.mensajes ?? []).filter((m) => m.remitente === 'CUSTOMER').slice(-3).map((m) => `«${m.contenido.slice(0, 120)}»`);
  return {
    resumen: `Motivo del escalamiento: ${d?.motivo ?? 'sin motivo'}. Últimos mensajes del cliente: ${cliente.join(' · ') || '—'}.`,
    siguiente_paso: 'Saluda por el nombre, confirma el motivo y ofrece una solución concreta.',
  };
}

/**
 * Simulador del copiloto: responde al último mensaje del cliente con los datos que recibe (catálogo,
 * horarios, radicado). Nunca inventa precios: si no reconoce el servicio, ofrece confirmarlo.
 */
function suggestHeuristic(d: any) {
  const mensajes: { remitente: string; contenido: string }[] = d?.mensajes ?? [];
  const ultimo: string = d?.ultimo_cliente ?? [...mensajes].reverse().find((m) => m.remitente === 'CUSTOMER' || m.remitente === 'Cliente')?.contenido ?? '';
  const t = normalizeText(ultimo);
  const nombre = String(d?.cliente ?? '').split(' ')[0];
  const usted = /\busted\b|\bud\b|\bsenor|\bsenora/.test(t);
  const te = usted ? 'le' : 'te';
  const catalogo: { nombre: string; precio: number; duracion_min: number | null; disponible: boolean }[] = d?.catalogo ?? [];
  // El ítem del catálogo que más palabras comparte con el mensaje del cliente.
  const palabras = (x: string) => normalizeText(x).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const enMensaje = new Set(palabras(ultimo));
  const item = catalogo.map((p) => ({ p, n: palabras(p.nombre).filter((w) => enMensaje.has(w)).length })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n)[0]?.p;
  const precio = (n: number) => `$${Math.round(n).toLocaleString('es-CO')}`;
  const horario: string | undefined = d?.horarios?.[0]?.split(': ')[1];
  const datos: string[] = [];
  let intencion = 'Conversar con el equipo';
  let sugerencia = `Hola ${nombre}, ${usted ? 'gracias por escribirnos' : '¡gracias por escribirnos!'}. Ya leí tu mensaje y ${te} ayudo con gusto. ¿Me ${usted ? 'cuenta' : 'cuentas'} un poco más de lo que necesitas?`;
  if (/reembolso|devolu|cobr|reclamo|queja|mal servicio|molest/.test(t)) {
    intencion = 'Presentar un reclamo y que le solucionen';
    sugerencia = `Hola ${nombre}, lamento mucho lo que pasó y gracias por avisarnos. Ya estoy revisando tu caso${d?.caso?.radicado ? ` (${d.caso.radicado})` : ''} para darte una solución hoy mismo. ¿Me ${usted ? 'confirma' : 'confirmas'} la fecha de la compra y el medio de pago que usaste?`;
    if (d?.caso?.radicado) datos.push(`Radicado ${d.caso.radicado}`);
  } else if (item && /precio|cuanto|vale|cuesta|valor|costo/.test(t)) {
    intencion = `Saber el precio de ${item.nombre}`;
    sugerencia = `Hola ${nombre}, ${item.nombre.toLowerCase()} ${item.disponible ? `cuesta ${precio(item.precio)}` : `cuesta ${precio(item.precio)}, aunque en este momento está agotado`}${item.duracion_min ? ` y dura unos ${item.duracion_min} minutos` : ''}. ¿${usted ? 'Quiere' : 'Quieres'} que ${te} reserve un espacio?`;
    datos.push(`${item.nombre} ${precio(item.precio)}`);
  } else if (/cita|agend|turno|reserv|disponib|espacio/.test(t)) {
    intencion = 'Agendar una cita';
    sugerencia = `Hola ${nombre}, ¡claro que sí! ${horario ? `Atendemos ${horario}. ` : ''}¿Qué día y a qué hora ${usted ? 'le' : 'te'} queda mejor${item ? ` para ${item.nombre.toLowerCase()}` : ''}?`;
    if (horario) datos.push(`Horario: ${horario}`);
    if (item) datos.push(item.nombre);
  } else if (/horario|abren|cierran|hasta que hora|atienden/.test(t)) {
    intencion = 'Conocer el horario de atención';
    sugerencia = horario ? `Hola ${nombre}, atendemos ${horario}. ¿${usted ? 'Le' : 'Te'} ayudo a agendar?` : `Hola ${nombre}, ya ${te} confirmo el horario de hoy.`;
    if (horario) datos.push(`Horario: ${horario}`);
  } else if (/gracias|listo|perfecto|ok\b|vale\b/.test(t)) {
    intencion = 'Agradecer o confirmar';
    sugerencia = `Con gusto, ${nombre}. Aquí ${usted ? 'estamos' : 'estamos'} para lo que ${usted ? 'necesite' : 'necesites'}. ¡Que ${usted ? 'tenga' : 'tengas'} un excelente día!`;
  }
  return { sugerencia, intencion, datos_usados: datos };
}

/** Simulador de «mejorar redacción»: corrige abreviaturas, mayúsculas y puntuación sin cambiar el contenido. */
function mejorarHeuristic(d: any) {
  const original = String(d?.borrador ?? '').trim();
  const nombre = String(d?.cliente ?? '').split(' ')[0];
  const cambios: string[] = [];
  let x = original.replace(/\s+/g, ' ');
  const abrev: [RegExp, string][] = [[/\bq\b/gi, 'que'], [/\b(xq|pq|porq)\b/gi, 'porque'], [/\bud\b/gi, 'usted'], [/\btmb\b/gi, 'también'], [/\b(xfa|pls|porfa)\b/gi, 'por favor'], [/\bmsj\b/gi, 'mensaje'], [/\bk\b/gi, 'que'], [/\bta\b/gi, 'está']];
  let abreviaturas = false;
  for (const [re, por] of abrev) if (re.test(x)) { x = x.replace(re, por); abreviaturas = true; }
  if (abreviaturas) cambios.push('Escribí completas las abreviaturas');
  const conMayus = x.replace(/(^|[.!?]\s+)([a-záéíóúñ])/g, (_m, a, l) => a + l.toUpperCase());
  if (conMayus !== x) { x = conMayus; cambios.push('Mayúsculas al inicio de cada frase'); }
  if (!/[.!?…]$/.test(x)) { x += '.'; cambios.push('Puntuación final'); }
  if (nombre && !/^(hola|buen[oa]s|saludos|hey)\b/i.test(x)) { x = `Hola ${nombre}, ${x.charAt(0).toLowerCase()}${x.slice(1)}`; cambios.push('Saludo con el nombre del cliente'); }
  if (!/gracias|quedo atent|con gusto|cualquier cosa/i.test(x) && !/\?$/.test(x)) { x += ' Quedo atento a cualquier cosa que necesites.'; cambios.push('Cierre amable'); }
  if (!cambios.length) cambios.push('El mensaje ya estaba claro: solo se revisó el tono');
  return { texto: x.slice(0, 4000), cambios };
}

/** Simulador del asistente de soporte: redacta solo con las revisiones de la cuenta y las guías verificadas. */
function soporteHeuristic(d: { problemas?: { nivel: string; titulo: string; detalle: string; accion?: { etiqueta: string } }[]; guias?: { tema: string; guia: string }[] }) {
  const p = d.problemas ?? [];
  if (p.length) {
    const graves = p.filter((x) => x.nivel === 'error');
    const lista = (graves.length ? graves : p).slice(0, 3);
    return {
      puede_resolver: true, confianza: graves.length ? 'alta' : 'media',
      respuesta: lista.length === 1 ? 'Revisé tu cuenta y encontré lo que explica el problema:' : 'Revisé tu cuenta y encontré esto, que puede explicar el problema:',
      // El detalle va en las tarjetas de la revisión; aquí solo qué hacer.
      pasos: lista.map((x) => `${x.titulo}${x.accion ? `: entra a «${x.accion.etiqueta}» desde el botón de abajo.` : '.'}`.slice(0, 300)),
    };
  }
  if (d.guias?.length) return { puede_resolver: true, confianza: 'media', respuesta: `No encontré fallas en tu cuenta. Esto es lo que indica la guía verificada:
${d.guias[0].guia}`.slice(0, 1500), pasos: [] };
  return { puede_resolver: false, confianza: 'baja', respuesta: '', pasos: [] };
}
