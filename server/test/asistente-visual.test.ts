import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { setLlm } from '../src/ai/llm/index.js';
import { ScriptedLlm } from '../src/ai/llm/scripted.js';
import { sanearRespuesta } from '../src/ai/visual.js';

/**
 * El asistente del panel responde con datos, gráficas e informes, nunca con código; y cada
 * consulta deja su alcance (fechas, conteo) para que el panel la agrupe en una sola tarjeta.
 */
let E: Env;
let admin: ReturnType<typeof api>;

beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
});
afterAll(async () => { setLlm(null); await E.app.close(); await E.db.close(); });

const grafica = { tipo: 'barras', titulo: 'Citas por día', unidad: 'citas', etiquetas: ['lun', 'mar'], series: [{ nombre: 'Citas', valores: [1, 3] }] };

describe('Saneado de la respuesta', () => {
  it('retira bloques de código y HTML suelto con un solo aviso', () => {
    const r = sanearRespuesta('Aquí va:\n```html\n<!DOCTYPE html><html><body><script>alert(1)</script></body></html>\n```\nY el estilo:\n```css\nbody { color: red; }\n```');
    expect(r.texto).not.toMatch(/<html|<script|color: red/);
    expect(r.texto.match(/no genera código/g)).toHaveLength(1);
    expect(r.codigoRetirado).toBe(2);
    const suelto = sanearRespuesta('Copia esto:\n<!DOCTYPE html>\n<html>\n<body>\n<canvas id="juego"></canvas>\n</body>\n</html>');
    expect(suelto.texto).not.toMatch(/<canvas|<html/);
    expect(suelto.texto).toMatch(/no genera código/);
  });

  it('el código sin lenguaje declarado también se retira; el texto plano se conserva', () => {
    expect(sanearRespuesta('```\nconst x = 1;\nfunction f() {}\n```').codigoRetirado).toBe(1);
    expect(sanearRespuesta('```\nHola Mateo, tu cita es mañana a las 10.\n```').texto).toContain('Hola Mateo');
    expect(sanearRespuesta('```python\nprint(1)\n```').texto).toMatch(/no genera código/);
  });

  it('valida y normaliza los bloques de gráfica e informe; uno inválido no llega al panel', () => {
    const ok = sanearRespuesta('Mira:\n```grafica\n' + JSON.stringify(grafica, null, 2) + '\n```');
    expect(ok.texto).toContain('```grafica\n' + JSON.stringify(grafica) + '\n```');
    const malo = sanearRespuesta('```grafica\n{"tipo":"barras","titulo":"X","etiquetas":["a","b"],"series":[{"nombre":"S","valores":[1]}]}\n```');
    expect(malo.visualesInvalidos).toBe(1);
    expect(malo.texto).not.toContain('```grafica');
    const conCodigo = sanearRespuesta('```grafica\n{"tipo":"barras","titulo":"<script>","etiquetas":["a"],"series":[{"nombre":"S","valores":[1]}],"html":"<b>"}\n```');
    expect(conCodigo.visualesInvalidos).toBe(1);
    const informe = { titulo: 'Informe semanal', periodo: '19 – 24 oct', resumen: 'Una cita.', cifras: [{ etiqueta: 'Citas', valor: '1' }], secciones: [{ titulo: 'Agenda', tabla: { columnas: ['Día', 'Citas'], filas: [['jue', 1]] }, grafica }] };
    expect(sanearRespuesta('```informe\n' + JSON.stringify(informe) + '\n```').visualesInvalidos).toBe(0);
  });
});

describe('Asistente del panel', () => {
  it('lo que el modelo escriba como código nunca se guarda ni se entrega', async () => {
    setLlm(new ScriptedLlm([], 'Claro:\n```html\n<html><body><script>juego()</script></body></html>\n```'));
    const r = (await admin.post('/asistente', { pregunta: 'dame el código de un juego' })).body;
    expect(r.texto).not.toMatch(/<html|<script/);
    expect(r.texto).toMatch(/no genera código/);
    const hilo = (await admin.get(`/asistente/hilos/${r.hilo_id}`)).body;
    expect(JSON.stringify(hilo.mensajes)).not.toMatch(/<script/);
  });

  it('las instrucciones prohíben el código y piden gráficas e informes con datos de las herramientas', async () => {
    let sistema = '';
    setLlm(new (class extends ScriptedLlm { async runLoop(i: any, c: any) { sistema = i.system; return super.runLoop(i, c); } })([], 'ok'));
    await admin.post('/asistente', { pregunta: 'hola' });
    expect(sistema).toMatch(/No escribes código/);
    expect(sistema).toMatch(/```grafica/);
    expect(sistema).toMatch(/```informe/);
    expect(sistema).toMatch(/agenda_periodo en UNA consulta/);
  });

  it('una semana de agenda es una sola consulta y el recibo lleva su alcance', async () => {
    setLlm(null);
    const r = (await admin.post('/asistente', { pregunta: '¿Qué citas hay esta semana?' })).body;
    expect(r.ejecuciones).toHaveLength(1);
    expect(r.ejecuciones[0]).toMatchObject({ herramienta: 'agenda_periodo', decision: 'PERMITIDA' });
    expect(r.ejecuciones[0].alcance).toMatchObject({ desde: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), hasta: expect.any(String), encontrados: expect.any(Number) });
    expect(r.texto).toMatch(/```grafica\n\{"tipo":"barras"/);
  });

  it('un informe llega como bloque validado y la consulta diaria guarda su fecha', async () => {
    setLlm(null);
    const inf = (await admin.post('/asistente', { pregunta: 'Hazme un informe de ventas de la semana' })).body;
    expect(inf.texto).toMatch(/```informe\n\{"titulo":"Informe de ventas"/);
    setLlm(new ScriptedLlm([{ name: 'citas_del_dia', args: { fecha: '2026-10-22' } }], 'Una cita.'));
    const r = (await admin.post('/asistente', { pregunta: 'citas del jueves' })).body;
    expect(r.ejecuciones[0].alcance).toMatchObject({ fecha: '2026-10-22', encontrados: expect.any(Number) });
  });
});
