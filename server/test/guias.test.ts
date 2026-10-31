import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, login, api, CRED, type Env } from './helpers.js';
import { IDS_GUIA, detectarGuia } from '../src/ai/guias.js';
import { setLlm } from '../src/ai/llm/index.js';
import { MockLlm } from '../src/ai/llm/mock.js';

/**
 * Guías en pantalla: el asistente elige una guía del catálogo y el panel mueve a la IA por los
 * botones reales. Lo que se verifica aquí es lo que impide señalar al vacío: que ambos catálogos
 * tengan las mismas guías, que cada elemento señalado exista en la interfaz y que no se ofrezca
 * una guía que el rol de la persona no puede seguir.
 */
const WEB = join(import.meta.dirname, '../../web/src');
const fuentes = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? fuentes(p) : /\.tsx?$/.test(f) ? [p] : [];
});
const catalogoWeb = readFileSync(join(WEB, 'components/ia/guias.ts'), 'utf8');
const codigo = fuentes(WEB).map((p) => readFileSync(p, 'utf8')).join('\n');

describe('Catálogo de guías (web ↔ servidor)', () => {
  it('las dos listas tienen exactamente las mismas guías', () => {
    const web = [...catalogoWeb.matchAll(/^ {2}([a-z_]+): \{\r?\n {4}titulo:/gm)].map((m) => m[1]).sort();
    expect(web).toEqual([...IDS_GUIA].sort());
  });

  it('cada elemento que señala una guía existe en la interfaz', () => {
    const anclas = [...new Set([...catalogoWeb.matchAll(/ancla: '([^']+)'/g)].map((m) => m[1]))];
    expect(anclas.length).toBeGreaterThan(20);
    const layout = readFileSync(join(WEB, 'components/Layout.tsx'), 'utf8');
    expect(layout).toContain('data-guia={`menu${i.to}`}');
    const faltan = anclas.filter((a) => {
      // Accesos del menú: «menu/ventas» es el enlace a /ventas.
      if (a.startsWith('menu/')) return !layout.includes(`to: '${a.slice(4)}'`);
      return ![`data-guia="${a}"`, `guia="${a}"`, `? '${a}'`].some((patron) => codigo.includes(patron));
    });
    expect(faltan).toEqual([]);
  });
});

let E: Env;
let admin: ReturnType<typeof api>;
let laura: ReturnType<typeof api>;
beforeAll(async () => {
  E = await setup();
  admin = api(E.app, await login(E.app, ...CRED.admin), 'elparche');
  laura = api(E.app, await login(E.app, ...CRED.laura), 'elparche');
});
afterAll(async () => { await E.app.close(); await E.db.close(); });

describe('Asistente: «¿cómo hago…?» con guía en pantalla', () => {
  it('prepara la guía y la deja en el recibo (también al releer la conversación)', async () => {
    const r = await admin.post('/asistente', { pregunta: '¿Cómo registro una venta?' });
    expect(r.status).toBe(200);
    const recibo = r.body.ejecuciones.find((e: any) => e.herramienta === 'mostrar_guia');
    expect(recibo).toMatchObject({ decision: 'PERMITIDA', guia: 'registrar_venta' });
    expect(r.body.texto).toMatch(/en pantalla/);
    const hilo = (await admin.get(`/asistente/hilos/${r.body.hilo_id}`)).body;
    expect(hilo.mensajes.at(-1).ejecuciones.find((e: any) => e.herramienta === 'mostrar_guia').guia).toBe('registrar_venta');
  });

  it('aunque el modelo solo responda en el chat, una pregunta «¿cómo…?» con guía la muestra en pantalla', async () => {
    // Un modelo que contesta con texto y no usa herramientas.
    setLlm({ nombre: 'solo-texto', structured: async () => ({ data: null, raw: null, tokens: 0 }),
      runLoop: async () => ({ text: 'Ve a Ventas y pulsa «Registrar venta».', tokens: 10, toolCalls: 0, stopReason: 'end_turn' }) } as any);
    try {
      const r = await admin.post('/asistente', { pregunta: 'como hago para registrar una venta' });
      expect(r.status).toBe(200);
      expect(r.body.texto).toMatch(/Registrar venta/);
      expect(r.body.ejecuciones.find((e: any) => e.herramienta === 'mostrar_guia')).toMatchObject({ decision: 'PERMITIDA', guia: 'registrar_venta' });
      // Una pregunta que no es «cómo» no lanza guías.
      const otra = await admin.post('/asistente', { pregunta: 'cuánto vendimos hoy' });
      expect(otra.body.ejecuciones.some((e: any) => e.herramienta === 'mostrar_guia')).toBe(false);
    } finally { setLlm(new MockLlm(() => '2026-10-21')); }
    expect(detectarGuia('¿Cómo agendo una cita?')).toBe('agendar_cita');
    expect(detectarGuia('Enséñame a registrar el pago de una venta')).toBe('registrar_pago');
    expect(detectarGuia('registrar una venta')).toBeNull();
  });

  it('una duda que también cubre la guía del panel trae el texto y la guía', async () => {
    const r = await admin.post('/asistente', { pregunta: '¿Cómo registro un pago en efectivo?' });
    const herramientas = r.body.ejecuciones.map((e: any) => e.herramienta);
    expect(herramientas).toEqual(expect.arrayContaining(['ayuda_plataforma', 'mostrar_guia']));
    expect(r.body.ejecuciones.find((e: any) => e.guia)?.guia).toBe('registrar_pago');
  });

  it('no ofrece una guía que el rol de la persona no puede seguir', async () => {
    const r = await laura.post('/asistente', { pregunta: '¿Cómo invito a alguien del equipo?' });
    const recibo = r.body.ejecuciones.find((e: any) => e.herramienta === 'mostrar_guia');
    expect(recibo).toBeTruthy();
    expect(recibo.guia).toBeUndefined();
    expect(r.body.texto).toMatch(/No puedo mostrarte esa guía/);
  });

  it('el recorrido del panel está disponible para cualquiera con el asistente', async () => {
    const r = await laura.post('/asistente', { pregunta: '¿Me das un recorrido por el panel?' });
    expect(r.body.ejecuciones.find((e: any) => e.guia)?.guia).toBe('recorrido_panel');
  });

  it('el inicio trae las cifras del tablero vivo calculadas con datos reales', async () => {
    const r = await admin.get('/inicio');
    expect(r.status).toBe(200);
    expect(r.body.serie_mes).toHaveLength(30);
    expect(r.body.clientes_serie).toHaveLength(7);
    expect(r.body.actividad.serie).toHaveLength(12);
    expect(r.body.mes.cobrado).toBeLessThanOrEqual(r.body.mes.ventas + 0.01);
    expect(r.body.serie_mes.reduce((a: number, d: any) => a + d.total, 0)).toBeGreaterThanOrEqual(r.body.cifras.ventas_semana - 0.01);
    expect(r.body.empresa.clientes).toBeGreaterThan(0);
  });
});
