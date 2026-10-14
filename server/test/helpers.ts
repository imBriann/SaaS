import type { FastifyInstance } from 'fastify';
import { Database } from '../src/db/index.js';
import { buildApp } from '../src/http/app.js';
import { seedDemo } from '../src/seed/demo.js';
import { setLlm } from '../src/ai/llm/index.js';

export interface Env {
  db: Database;
  app: FastifyInstance;
  A: string; // barbería El Parche
  B: string; // gimnasio Fuerza Norte
}

/**
 * Base de pruebas: PGlite en memoria por defecto; con DATABASE_URL_PRUEBAS, un
 * PostgreSQL real cuyo esquema se recrea desde cero (npm run test:postgres).
 */
export async function abrirBase(): Promise<Database> {
  const url = process.env.DATABASE_URL_PRUEBAS;
  if (!url) return Database.open({ dataDir: 'memory://' });
  const db = await Database.open({ url });
  await db.execScript('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  return db;
}

export const motor = () => (process.env.DATABASE_URL_PRUEBAS ? 'postgresql' : 'pglite');

export async function setup(): Promise<Env> {
  setLlm(null);
  const db = await abrirBase();
  await db.migrate();
  const r = await seedDemo(db);
  const app = await buildApp(db, { webDir: '__none__' });
  return { db, app, A: r.tenantId, B: r.otroTenantId };
}

export async function login(app: FastifyInstance, email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`login ${email}: ${res.statusCode} ${res.body}`);
  const c = res.cookies.find((x) => x.name === 'sid')!;
  return `sid=${c.value}`;
}

/**
 * Inicio de sesión del operador con segundo factor: contraseña → código por correo
 * (leído del proveedor falso) → sesión. Se reutiliza por base para no chocar con el
 * límite de un código por minuto.
 */
const sesionesOperador = new WeakMap<object, Map<string, string>>();
export async function loginOperador(app: FastifyInstance, db: Database, email = 'plataforma@saas.test', password = 'demo-plataforma-2026'): Promise<string> {
  const cache = sesionesOperador.get(db) ?? new Map<string, string>();
  sesionesOperador.set(db, cache);
  if (cache.has(email)) return cache.get(email)!;
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
  if (r.statusCode !== 200 || !r.json().segundo_factor) throw new Error(`login operador ${email}: ${r.statusCode} ${r.body}`);
  const codigo = await codigoDelCorreo(db, email, 'codigo_acceso');
  const s = await app.inject({ method: 'POST', url: '/api/auth/login/codigo', payload: { desafio: r.json().desafio, codigo } });
  if (s.statusCode !== 200) throw new Error(`segundo factor ${email}: ${s.statusCode} ${s.body}`);
  const cookie = `sid=${s.cookies.find((x) => x.name === 'sid')!.value}`;
  cache.set(email, cookie);
  return cookie;
}

export function op(app: FastifyInstance, cookie: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url: `/api/operador${url}`, payload: payload as any, headers: { cookie } });
    let body: any = null;
    try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, body, raw: r.body };
  };
  return { get: (u: string) => call('GET', u), post: (u: string, p?: unknown) => call('POST', u, p), patch: (u: string, p?: unknown) => call('PATCH', u, p) };
}

export function api(app: FastifyInstance, cookie: string, slug: string) {
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as any, url: `/api/t${url}`, payload: payload as any, headers: { cookie, 'x-tenant-slug': slug } });
    return { status: res.statusCode, body: res.body ? (() => { try { return res.json(); } catch { return res.body; } })() : null };
  };
  return {
    get: (u: string) => call('GET', u),
    post: (u: string, p?: unknown) => call('POST', u, p ?? {}),
    patch: (u: string, p?: unknown) => call('PATCH', u, p ?? {}),
  };
}

export const CRED = {
  admin: ['admin@elparche.test', 'demo-parche-2026'] as const,
  laura: ['laura@elparche.test', 'demo-equipo-2026'] as const,
  andres: ['andres@elparche.test', 'demo-equipo-2026'] as const,
  gym: ['admin@fuerzanorte.test', 'demo-fuerza-2026'] as const,
};

import { proveedorCorreo, ProveedorFalso } from '../src/email/proveedores.js';
import { drain } from '../src/worker/jobs.js';

/** Correos «enviados» por el proveedor falso (pruebas). */
export async function correosA(db: Database, para: string) {
  await drain(db);
  const p = proveedorCorreo();
  if (!(p instanceof ProveedorFalso)) throw new Error('Las pruebas esperan el proveedor de correo falso');
  return p.enviados.filter((m) => m.para === para);
}

/** Código de seis dígitos del último correo de un tipo (solo pruebas: el código nunca sale por la API). */
export async function codigoDelCorreo(db: Database, para: string, tipo = 'verificacion_correo'): Promise<string> {
  const m = (await correosA(db, para)).filter((c) => c.tipo === tipo).at(-1);
  const c = m?.texto.match(/Tu código: (\d{6})/);
  if (!c) throw new Error(`No llegó un código «${tipo}» a ${para}`);
  return c[1];
}

export function tokenDelEnlace(html: string, param = 'token'): string {
  const m = html.match(new RegExp(`[?&]${param}=([A-Za-z0-9_-]+)`));
  if (!m) throw new Error('El correo no trae enlace con token');
  return m[1];
}

export function cliente(app: FastifyInstance) {
  let cookie = '';
  const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: method as any, url, payload: payload as any, headers: { ...(cookie ? { cookie } : {}), ...headers } });
    const sid = res.cookies.find((c) => c.name === 'sid');
    if (sid) cookie = sid.value ? `sid=${sid.value}` : '';
    return { status: res.statusCode, body: res.body ? (() => { try { return res.json(); } catch { return res.body; } })() : null };
  };
  return { call, get cookie() { return cookie; }, set cookie(v: string) { cookie = v; } };
}
