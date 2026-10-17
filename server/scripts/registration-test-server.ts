/** Isolated registration verification: in-memory database and explicit simulated integrations only. */
import { setup, codigoDelCorreo } from '../test/helpers.js';
import { MockLlm } from '../src/ai/llm/mock.js';
import { setLlm } from '../src/ai/llm/index.js';
import type { StructuredInput } from '../src/ai/llm/types.js';
import { config } from '../src/config.js';
import { startWorker } from '../src/worker/jobs.js';

if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_URL_PRUEBAS) {
  throw new Error('Registration verification requires NODE_ENV=test and an in-memory database.');
}
const env = await setup();
let failGeneration = false;
let analysisDelay = 950;
let generationDelay = 3200;
const calls: { task: string; at: string; result: string }[] = [];
class RegistrationModel extends MockLlm {
  override async structured<T>(input: StructuredInput<T>) {
    const call = { task: input.tarea, at: new Date().toISOString(), result: 'pending' };
    calls.push(call);
    await new Promise(resolve => setTimeout(resolve, input.tarea === 'personalizar_espacio' ? generationDelay : analysisDelay));
    if (input.tarea === 'personalizar_espacio' && failGeneration) {
      failGeneration = false;
      call.result = 'simulated_failure';
      throw new Error('Intentional isolated test model failure');
    }
    const result = await super.structured(input);
    call.result = 'simulated_success';
    return result;
  }
}
setLlm(new RegistrationModel(() => '2026-10-16'));
config.workerIntervalMs = 250;
env.app.get('/api/__test/codigo', async (req: any) => ({ codigo: await codigoDelCorreo(env.db, String(req.query.email)) }));
env.app.post('/api/__test/model', async (req: any) => {
  failGeneration = req.body?.failGeneration === true;
  analysisDelay = Math.max(0, Math.min(5000, Number(req.body?.analysisDelay ?? analysisDelay)));
  generationDelay = Math.max(0, Math.min(10000, Number(req.body?.generationDelay ?? generationDelay)));
  return { simulated: true, failGeneration, analysisDelay, generationDelay };
});
env.app.get('/api/__test/inspect', async (req: any) => env.db.withPlatform(async tx => {
  const tk = String(req.query.token ?? '');
  const d = (await tx.query('SELECT estado, tenant_id, creacion, personalizacion FROM onboarding_draft WHERE token=$1', [tk])).rows[0];
  const jobs = (await tx.query("SELECT tipo, estado, intentos, payload FROM job WHERE tipo='crear_espacio_ia' AND payload->>'draft_token'=$1 ORDER BY creado_en", [tk])).rows;
  const tenants = (await tx.query('SELECT count(*)::int n FROM tenant')).rows[0].n;
  const owned = d?.tenant_id ? (await tx.query('SELECT count(*)::int n FROM tenant WHERE id=$1', [d.tenant_id])).rows[0].n : 0;
  return { simulated: true, draft: d ?? null, jobs, tenants, owned, calls };
}));
await env.app.listen({ host: '127.0.0.1', port: 3003 });
const stopWorker = startWorker(env.db);
console.log('REGISTRATION_TEST_READY');
const close = async () => { await stopWorker(); await env.app.close(); await env.db.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
