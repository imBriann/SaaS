import type { FastifyInstance } from 'fastify';
import { Database } from '../src/db/index.js';
import { buildApp } from '../src/http/app.js';
import { seedDemo } from '../src/seed/demo.js';
import { setLlm } from '../src/ai/llm/index.js';
import { receiveChannelMessages } from '../src/modules/channelInbound.js';
import { drain } from '../src/worker/jobs.js';
import { uuidv7 } from '../src/lib/util.js';

export interface Env {
  db: Database;
  app: FastifyInstance;
  A: string; // barbería El Parche
  B: string; // gimnasio Fuerza Norte
}

export async function setup(): Promise<Env> {
  setLlm(null);
  const db = await Database.open({ dataDir: 'memory://' });
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

/** Simula un mensaje entrante de WhatsApp para el negocio de demostración y procesa la cola hasta vaciarla. */
export async function simularWhatsApp(db: Database, from: string, texto: string, nombre = 'Cliente', prefijo = 't') {
  await receiveChannelMessages(db, [{ phoneNumberId: 'sim-elparche', from, nombre, id: `${prefijo}.${uuidv7()}`, texto }], 'WHATSAPP', prefijo);
  await drain(db);
}
