import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Arranque en producción con EXACTAMENTE las variables que hoy tiene Render (valores ficticios). Se valida en un
 * proceso aparte, en un directorio sin .env, para que nada del equipo local se cuele en el resultado.
 */
export const VARIABLES_RENDER: Record<string, string> = {
  API_PUBLIC_URL: 'https://api.omnegia.test', APP_KEY: 'k'.repeat(48), APP_PUBLIC_URL: 'https://omnegia.test', BASE_DOMAIN: 'omnegia.test',
  DATABASE_POOL_MAX: '5', DATABASE_URL: 'postgres://usuario:clave@db.invalido.test:5432/omnegia',
  EMAIL_FROM_ADDRESS: 'hola@omnegia.test', EMAIL_FROM_NAME: 'Omnegia', EMAIL_OTP_EXPIRY_MINUTES: '10', EMAIL_PROVIDER: 'resend', EMAIL_REPLY_TO: 'soporte@omnegia.test',
  EMAIL_SUPPORT_INBOX: 'soporte@omnegia.test', EMAIL_TIMEOUT_MS: '10000', LOG_NIVEL: 'info', NODE_ENV: 'production', NODE_VERSION: '22', PORT: '10000',
  RESEND_API_KEY: 're_ficticia_para_pruebas', RESEND_WEBHOOK_SECRET: 'whsec_ficticio', SIN_DEMO: '1',
  ACCESO_INSTITUCIONAL_DIAS: '30', MODO_INSTITUCIONAL: '1', PAGOS_PROVEEDOR: 'wompi', PRECIO_INSTITUCIONAL_COP: '1500', TARIFAS_CONFIRMADAS: '1',
  WOMPI_ENTORNO: 'produccion', WOMPI_LLAVE_PRIVADA: 'prv_prod_ficticia', WOMPI_LLAVE_PUBLICA: 'pub_prod_ficticia', WOMPI_SECRETO_EVENTOS: 'prod_events_ficticio', WOMPI_SECRETO_INTEGRIDAD: 'prod_integrity_ficticio',
  ANTHROPIC_API_KEY: 'sk-ant-ficticia', APP_VERSION: '1.0.0', IA_PRECIO_ENTRADA_USD_MTOK: '3', IA_PRECIO_SALIDA_USD_MTOK: '15', LLM_MAX_ITERACIONES: '6', LLM_MAX_RETRIES: '2',
  LLM_MODEL: 'claude-sonnet-5-5', LLM_PROVIDER: 'anthropic', LLM_TIMEOUT_MS: '30000',
  EMISOR_CIUDAD: 'Cúcuta', EMISOR_CORREO: 'facturas@omnegia.test', EMISOR_DIRECCION: 'Calle 1 # 2-3', EMISOR_NUMERO_DOCUMENTO: '1090000000', EMISOR_RAZON_SOCIAL: 'Omnegia', EMISOR_RESPONSABLE_IVA: '0',
  FACTURACION_ELECTRONICA_PLATAFORMA: '0', WHATSAPP_ACCESS_TOKEN: 'EAAficticio', WHATSAPP_APP_SECRET: 'secreto_app_ficticio', WHATSAPP_GRAPH_VERSION: 'v23.0',
  WHATSAPP_PLATFORM_PHONE_NUMBER_ID: '100000000000001', WHATSAPP_VERIFY_TOKEN: 'verificar_ficticio', WHATSAPP_PLATFORM_WABA_ID: '200000000000002',
};

const vacio = mkdtempSync(join(tmpdir(), 'omnegia-arranque-'));
afterAll(() => rmSync(vacio, { recursive: true, force: true }));

/** Resultado de validarConfiguracion() con solo estas variables (más PATH/SYSTEMROOT para que Node arranque). */
export function validarCon(vars: Record<string, string>) {
  const base: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[k]) base[k] = process.env[k]!;
  const salida = execFileSync(process.execPath, ['--import', pathToFileURL(join(import.meta.dirname, '../node_modules/tsx/dist/esm/index.mjs')).href, join(import.meta.dirname, 'fixtures/validar-config.mts')], {
    cwd: vacio, encoding: 'utf8', timeout: 60_000,
    env: { ...base, ...vars, __RUTA_CONFIG__: pathToFileURL(join(import.meta.dirname, '../src/config.ts')).href, NODE_PATH: join(import.meta.dirname, '../node_modules') },
  });
  return JSON.parse(salida) as { errores: string[]; avisos: string[]; almacen: string; dev: boolean };
}

describe('Arranque en Render con la configuración actual', () => {
  it('arranca sin las variables de Supabase: almacén en disco con un aviso, no un error', () => {
    const r = validarCon(VARIABLES_RENDER);
    expect(r.dev).toBe(false);
    expect(r.errores).toEqual([]);
    expect(r.almacen).toBe('disco');
    expect(r.avisos.join(' ')).toMatch(/ALMACEN_PROVEEDOR=disco.*se borra en cada despliegue/);
  });

  it('con ALMACEN_PROVEEDOR=supabase exige URL, llave y bucket', () => {
    const r = validarCon({ ...VARIABLES_RENDER, ALMACEN_PROVEEDOR: 'supabase' });
    const t = r.errores.join(' ');
    expect(t).toMatch(/SUPABASE_URL/);
    expect(t).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(t).toMatch(/SUPABASE_BUCKET_IMAGENES/);
    const ok = validarCon({ ...VARIABLES_RENDER, ALMACEN_PROVEEDOR: 'supabase', SUPABASE_URL: 'https://abcd.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'llave', SUPABASE_BUCKET_IMAGENES: 'imagenes' });
    expect(ok.errores).toEqual([]);
  });
});
