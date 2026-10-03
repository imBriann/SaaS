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
    if (/venta|vend|ingreso|factur(a|e) (hoy|esta)|ticket/.test(t) && tools.has('resumen_ventas')) {
      const dias = /hoy/.test(t) ? 1 : /mes/.test(t) ? 30 : 7;
      const r = (await tc('resumen_ventas', { dias })).content as any;
      const top = (r.mas_vendidos ?? []).slice(0, 3).map((x: any) => `${x.descripcion} (${x.unidades})`).join(', ');
      return `En los últimos ${r.dias} día(s): ${r.ventas} ventas por ${r.total_texto}, ticket promedio ${r.ticket_promedio}.${top ? ` Lo más vendido: ${top}.` : ''}\nFuente: ventas confirmadas del registro.`;
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
    const temas: [RegExp, string][] = [[/factur|dian|nota credito/, 'facturacion'], [/agenda|cita/, 'agenda'], [/catalogo|producto|precio/, 'catalogo'], [/usuario|persona|rol|equipo/, 'usuarios'], [/ia|agente|herramienta/, 'ia'], [/suscrip|pago|plan/, 'suscripcion'], [/whatsapp/, 'whatsapp']];
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

export function classifyHeuristic(descripcion: string) {
  const t = normalizeText(descripcion);
  let sector = 'otro', mejor = 0;
  for (const [s, res] of Object.entries(SECTORES)) {
    const n = res.filter((r) => r.test(t)).length;
    if (n > mejor) { mejor = n; sector = s; }
  }
  let personas: number | null = null;
  if (/\b(solo yo|yo solo|yo sola|sola yo|unipersonal|atiendo yo)\b/.test(t)) personas = 1;
  const m = t.match(/\b(\d{1,3}|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|veinte|treinta)\s+(barberos|empleados|personas|trabajadores|entrenadores|meseros|mecanicos|estilistas|colaboradores|asesores)/);
  if (m) personas = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_PAL[m[1]];
  const tamano = personas == null ? '2_5' : personas <= 1 ? 'unipersonal' : personas <= 5 ? '2_5' : personas <= 15 ? '6_15' : 'mas_15';
  let porMes: number | null = null;
  const v = t.match(/(\d{1,5})\s+(mensajes|chats|clientes|conversaciones|pedidos|citas)\s+(al|por|a la|cada)?\s*(dia|diarios|semana|mes)/);
  if (v) porMes = Number(v[1]) * (/semana/.test(v[4]) ? 4 : /mes/.test(v[4]) ? 1 : 30);
  const volumen = porMes == null ? (/muchos mensajes|no doy abasto|mucho movimiento/.test(t) ? 'medio' : 'bajo') : porMes < 300 ? 'bajo' : porMes < 1500 ? 'medio' : 'alto';
  const factura = /factur|dian|\biva\b|responsable/.test(t);
  const modulos = new Set(['clientes', 'catalogo', 'ventas', 'conversaciones', 'ia']);
  if (/cita|turno|reserva|agenda/.test(t) || ['barberia', 'gimnasio', 'servicios'].includes(sector)) modulos.add('agenda');
  if (/inventario|vendo|productos|stock|bodega/.test(t) || ['restaurante', 'taller'].includes(sector)) modulos.add('inventario');
  if (factura) modulos.add('facturacion');
  if (sector === 'gimnasio') modulos.add('membresias');
  if (sector === 'barberia' && /comision/.test(t)) modulos.add('comisiones');
  const confianza = sector === 'otro' ? 0.35 : mejor >= 2 ? 0.9 : 0.72;
  return {
    sector, tamano, volumen_conv_mes: volumen, modulos_sugeridos: [...modulos], factura_electronica: factura, confianza,
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

function suggestHeuristic(d: { mensajes: { remitente: string; contenido: string }[]; cliente: string }) {
  const ultimo = [...(d?.mensajes ?? [])].reverse().find((m) => m.remitente === 'CUSTOMER')?.contenido ?? '';
  const t = normalizeText(ultimo);
  const nombre = (d?.cliente ?? '').split(' ')[0];
  let sugerencia = `Hola ${nombre}, soy del equipo. Ya revisé tu caso y te ayudo con gusto.`;
  if (/reembolso|devolu|cobr/.test(t)) sugerencia = `Hola ${nombre}, lamento lo ocurrido. Revisé tu compra y vamos a gestionar la devolución. ¿Me confirmas el medio de pago que usaste?`;
  else if (/reclamo|queja|mal/.test(t)) sugerencia = `Hola ${nombre}, gracias por avisarnos y disculpa la experiencia. ¿Me cuentas qué pasó para solucionarlo hoy mismo?`;
  return { sugerencia };
}
