import { z } from 'zod';

/**
 * Salida visual del asistente del panel. El asistente NO entrega código: solo texto, tablas y dos
 * bloques de datos que el panel dibuja con la plantilla de Omnegia:
 *   ```grafica  {tipo, titulo, unidad, etiquetas, series}
 *   ```informe  {titulo, periodo, resumen, cifras, secciones[{titulo, texto, tabla, grafica}]}
 * Este módulo valida esos bloques (un JSON inválido no llega al panel) y retira cualquier bloque de
 * código o HTML que el modelo escriba aunque se le haya indicado no hacerlo.
 */
const Serie = z.object({ nombre: z.string().trim().min(1).max(40), valores: z.array(z.number().finite()).min(1).max(31) }).strict();

export const Grafica = z.object({
  tipo: z.enum(['barras', 'lineas', 'dona']),
  titulo: z.string().trim().min(1).max(90),
  subtitulo: z.string().trim().max(140).optional(),
  unidad: z.string().trim().max(20).optional(),
  etiquetas: z.array(z.string().trim().min(1).max(24)).min(1).max(31),
  series: z.array(Serie).min(1).max(3),
}).strict().superRefine((g, c) => {
  if (g.series.some((s) => s.valores.length !== g.etiquetas.length)) c.addIssue({ code: 'custom', message: 'Cada serie debe tener un valor por etiqueta.' });
  if (g.tipo === 'dona' && (g.series.length !== 1 || g.etiquetas.length > 8 || g.series[0].valores.some((v) => v < 0))) {
    c.addIssue({ code: 'custom', message: 'Una dona lleva una sola serie, hasta 8 partes y sin valores negativos.' });
  }
});

const Celda = z.union([z.string().max(80), z.number().finite()]);
export const Informe = z.object({
  titulo: z.string().trim().min(1).max(90),
  periodo: z.string().trim().max(60).optional(),
  resumen: z.string().trim().max(700).optional(),
  cifras: z.array(z.object({ etiqueta: z.string().trim().min(1).max(40), valor: z.string().trim().min(1).max(30), detalle: z.string().trim().max(60).optional() }).strict()).max(4).optional(),
  secciones: z.array(z.object({
    titulo: z.string().trim().min(1).max(70),
    texto: z.string().trim().max(900).optional(),
    tabla: z.object({ columnas: z.array(z.string().trim().min(1).max(30)).min(1).max(6), filas: z.array(z.array(Celda)).max(40) }).strict()
      .refine((t) => t.filas.every((f) => f.length === t.columnas.length), 'Cada fila debe tener una celda por columna.').optional(),
    grafica: Grafica.optional(),
  }).strict()).min(1).max(6),
  notas: z.string().trim().max(300).optional(),
}).strict();

export const BLOQUES_VISUALES = { grafica: Grafica, informe: Informe } as const;

const AVISO_CODIGO = '> El asistente de Omnegia no genera código, páginas ni juegos. Puedo responderte con los datos de tu negocio, prepararte una gráfica o armarte un informe para descargar.';
const AVISO_VISUAL = '_No pude preparar ese gráfico con datos válidos. Pídemelo de nuevo indicando el periodo._';

/** Contenido que es código aunque venga sin lenguaje declarado. */
const PARECE_CODIGO = /<\/?(?:html|head|body|script|style|div|span|canvas|svg|iframe|form|input|button|table)\b|<!doctype|\bfunction\s*\w*\s*\(|=>\s*[{(]|\b(?:const|let|var)\s+\w+\s*=|\bimport\s+[\w{*].*\bfrom\b|\bdocument\.\w+|\bconsole\.log\b|\bdef\s+\w+\s*\(|^\s*(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\b(?:FROM|INTO|SET)\b|^\s*[.#]?[\w-]+\s*\{[^}]*:[^}]*;/im;
const TEXTO_PLANO = new Set(['', 'text', 'texto', 'txt', 'plain', 'markdown', 'md']);

export interface Saneado { texto: string; codigoRetirado: number; visualesInvalidos: number }

/** Retira el código y valida los bloques visuales de una respuesta del asistente del panel. */
export function sanearRespuesta(texto: string): Saneado {
  let codigoRetirado = 0;
  let visualesInvalidos = 0;
  // Bloques cerrados y, al final, uno sin cerrar (respuesta cortada).
  let out = texto.replace(/```([\w-]*)[^\n]*\n([\s\S]*?)(?:```|$(?![\s\S]))/g, (_m, lang: string, cuerpo: string) => {
    const l = lang.toLowerCase();
    if (l in BLOQUES_VISUALES) {
      try {
        const datos = BLOQUES_VISUALES[l as keyof typeof BLOQUES_VISUALES].parse(JSON.parse(cuerpo));
        return '```' + l + '\n' + JSON.stringify(datos) + '\n```';
      } catch {
        visualesInvalidos++;
        return AVISO_VISUAL;
      }
    }
    if (TEXTO_PLANO.has(l) && !PARECE_CODIGO.test(cuerpo)) return '```\n' + cuerpo.replace(/\n$/, '') + '\n```';
    codigoRetirado++;
    return '\u0000AVISO\u0000';
  });
  // HTML suelto fuera de bloques (una página pegada sin cercas).
  if (/<!doctype|<\/?(?:html|script|style|body)\b/i.test(out)) {
    const lineas = out.split('\n');
    const limpias = lineas.filter((ln) => !/^\s*<\/?[a-z!][^>]*>/i.test(ln) && !/^\s*[\w.-]+\s*\{.*\}\s*$/.test(ln));
    if (limpias.length !== lineas.length) { codigoRetirado++; out = limpias.join('\n') + '\n\n\u0000AVISO\u0000'; }
  }
  // Un solo aviso aunque se retiren varios bloques.
  if (codigoRetirado) {
    let primero = true;
    out = out.replace(/\u0000AVISO\u0000/g, () => (primero ? ((primero = false), AVISO_CODIGO) : ''));
  }
  return { texto: out.replace(/\n{3,}/g, '\n\n').trim(), codigoRetirado, visualesInvalidos };
}
