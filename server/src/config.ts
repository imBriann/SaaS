import { existsSync } from 'node:fs';
import { join } from 'node:path';

if (existsSync(join(process.cwd(), '.env'))) process.loadEnvFile(join(process.cwd(), '.env'));

const env = process.env;
const dev = env.NODE_ENV !== 'production';

function secret(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (!dev) throw new Error(`Falta la variable de entorno ${name} (obligatoria en producción)`);
  return devDefault;
}

export const config = {
  dev,
  port: Number(env.PORT ?? 3000),
  /** Dominio base para subdominios de tenant: <slug>.<baseDomain> */
  baseDomain: env.BASE_DOMAIN ?? 'localhost',
  publicUrl: env.PUBLIC_URL ?? 'http://localhost:5173',
  databaseUrl: env.DATABASE_URL,
  dataDir: env.PGLITE_DIR ?? './data/pglite',
  /** Clave para cifrar secretos de terceros en reposo. */
  appKey: secret('APP_KEY', 'dev-app-key-no-usar-en-produccion'),
  payments: {
    webhookSecret: secret('PAYMENT_WEBHOOK_SECRET', 'dev-pasarela-secreto'),
  },
  whatsapp: {
    appSecret: secret('WHATSAPP_APP_SECRET', 'dev-whatsapp-app-secret'),
    verifyToken: env.WHATSAPP_VERIFY_TOKEN ?? 'dev-verify-token',
    accessToken: env.WHATSAPP_ACCESS_TOKEN, // sin token: el adaptador simula el envío
    graphVersion: env.WHATSAPP_GRAPH_VERSION ?? 'v23.0',
  },
  llm: {
    /** 'anthropic' si hay credenciales; 'mock' para desarrollo y pruebas deterministas. */
    provider: (env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock')) as 'anthropic' | 'mock',
    model: env.LLM_MODEL ?? 'claude-opus-5',
  },
  fiscal: {
    provider: env.FISCAL_PROVIDER ?? 'sandbox',
  },
  email: {
    from: env.EMAIL_FROM ?? 'facturas@plataforma.local',
  },
  workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 700),
  sessionDays: 7,
};
