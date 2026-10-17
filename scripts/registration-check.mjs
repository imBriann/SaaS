import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || `${process.env.LOCALAPPDATA ? `${process.env.USERPROFILE}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/` : ''}playwright`);
const outputDir = process.env.REGISTRATION_OUTPUT_DIR || '.impeccable/review/registration';
const origin = 'http://localhost:5175';
const apiOrigin = 'http://127.0.0.1:3003';
const report = { assertions: [], captures: [], viewports: [], errors: [], fixture: 'In-memory PGlite; explicitly simulated model with real application requests and durable jobs; signed simulated payments; fake email. No external AI, charges, or email.' };
let browser;
let page;
let server;
let frontend;
let apiFault = '';
const waitReady = (child, marker) => new Promise((resolve, reject) => {
  let logs = '';
  const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${marker}. ${logs.slice(-2000)}`)), 45000);
  child.stdout.on('data', chunk => { logs += chunk.toString(); if (logs.includes(marker)) { clearTimeout(timeout); resolve(); } });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });
  child.on('exit', code => { clearTimeout(timeout); reject(new Error(`Process exited (${code}): ${logs.slice(-3000)}`)); });
});
const check = (condition, message) => { assert(condition, message); report.assertions.push(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const api = async (path, method = 'GET', data) => {
  const response = await fetch(`${apiOrigin}${path}`, { method, headers: data ? { 'content-type': 'application/json' } : undefined, body: data ? JSON.stringify(data) : undefined });
  const value = await response.json();
  assert(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
};
const inspect = token => api(`/api/__test/inspect?token=${token}`);
const capture = async name => {
  if (process.env.VISUAL_SKIP_CAPTURE === '1') return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage: true });
  report.captures.push(name);
};
const overflow = async label => {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
  report.viewports.push({ label, ...dimensions });
  check(dimensions.page <= dimensions.viewport + 1, `No horizontal overflow: ${label} (${dimensions.viewport}px)`);
};
try {
  await mkdir(outputDir, { recursive: true });
  server = spawn(process.execPath, ['--import', './server/node_modules/tsx/dist/loader.mjs', 'server/scripts/registration-test-server.ts'], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL_PRUEBAS: '', DATABASE_URL: '', EMAIL_PROVIDER: 'fake', LLM_PROVIDER: 'mock', PAGOS_PROVEEDOR: 'simulada', FISCAL_PROVIDER: 'sandbox', APP_PUBLIC_URL: origin, API_PUBLIC_URL: origin, BASE_DOMAIN: 'localhost', WHATSAPP_ACCESS_TOKEN: '', ANTHROPIC_API_KEY: '', RESEND_API_KEY: '', WOMPI_LLAVE_PRIVADA: '', FACTURACION_ELECTRONICA_PLATAFORMA: '0' },
  });
  const serverReady = waitReady(server, 'REGISTRATION_TEST_READY');
  frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5175', '--strictPort'], { cwd: 'web', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
  await Promise.all([serverReady, waitReady(frontend, 'Local:')]);
  browser = await chromium.launch({ headless: true, ...(process.env.TEST_BROWSER ? { executablePath: process.env.TEST_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference', acceptDownloads: true });
  const calls = [];
  await context.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    calls.push({ path: url.pathname, method: request.method() });
    if (apiFault === 'analysis' && request.method() === 'POST' && (url.pathname.endsWith('/analizar') || url.pathname === '/api/onboarding/borradores')) {
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Fallo de red de prueba: vuelve a intentar el análisis.' } } });
    }
    if (apiFault === 'status' && url.pathname.endsWith('/estado') && url.pathname.includes('/borradores/')) {
      return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Fallo de consulta de prueba.' } } });
    }
    const response = await route.fetch({ url: `${apiOrigin}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${origin}/empezar`);
  await page.locator('.registration-start').waitFor();
  await page.getByText(/Modo de demostración/).waitFor();
  check(true, 'The simulated model is labelled honestly in the UI');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await overflow('registration idle');
    await capture(`start-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const description = page.getByRole('textbox', { name: '¿Qué vendes o qué servicio ofreces?' });
  const initial = 'Tengo una barbería en Cúcuta con dos barberos. Trabajamos con citas por WhatsApp y vendo productos para el cabello.';
  await api('/api/__test/model', 'POST', { analysisDelay: 3500 });
  await description.fill(initial);
  await page.locator('.registration-ai[aria-busy="true"]').waitFor();
  check(await page.locator('.registration-ai button:not(.registration-ai-toggle), .registration-ai [role="button"]').count() === 0, 'The assistant panel only reports status; its only control is the fold toggle');
  check(await page.locator('.registration-ai-toggle').isHidden(), 'The fold toggle only exists on small screens');
  await page.locator('.ai-voice').filter({ hasText: 'Estoy leyendo tu descripción' }).waitFor();
  check(true, 'The assistant writes what it is doing live while the request is in flight');
  check(await page.locator('.extraction-status').count() === 0, 'The bulky field list under the description is gone');
  await api('/api/__test/model', 'POST', { analysisDelay: 950 });
  const canvas = page.locator('.registration-orb-stage .ai-orb-layer.is-current canvas');
  const firstFrame = await canvas.evaluate(el => el.toDataURL());
  await sleep(180);
  check(firstFrame !== await canvas.evaluate(el => el.toDataURL()), 'The AI orb is visibly animated during the actual in-flight request');
  await capture('analysis-desktop');
  await page.locator('.registration-ai[aria-busy="false"]').waitFor(); await page.locator('.registration-proposal:not(.is-stale) .ia-propuesta[aria-busy="false"]').waitFor();
  check(calls.filter(x => x.path === '/api/onboarding/borradores' && x.method === 'POST').length === 1, 'Writing pause sends one automatic analysis request and creates one draft');
  check(await page.getByRole('button', { name: /Es correcto|Confirmar las/ }).count() === 0, 'Inferred data does not require repetitive confirmation buttons');
  await page.locator('.ai-voice:not(.is-typing)').filter({ hasText: 'Entendí:' }).waitFor({ timeout: 20000 });
  check(await page.locator('.ai-voice').innerText().then(t => /¿[^?]+\?/.test(t)), 'The assistant asks live about a fact it could not determine');
  check(await page.locator('.ia-fila.sugerido:not(.is-editing)').count() >= 2, 'Known facts arrive preselected and collapsed');
  check(await page.getByRole('radiogroup', { name: 'Factura electrónica', exact: true }).isVisible(), 'An unknown fact is expanded for an optional answer');
  const token = await page.evaluate(() => localStorage.getItem('borrador'));
  check(!!token, 'The actual draft key is saved');
  await page.getByRole('button', { name: 'Ajustar equipo que atenderá', exact: true }).click();
  await page.getByRole('radio', { name: '6 a 15 personas', exact: true }).click();
  await page.locator('.ia-propuesta[aria-busy="false"]').waitFor();
  check((await api(`/api/onboarding/borradores/${token}`)).clasificacion.tamano === '6_15', 'Manual changes persist to the server');
  await description.fill(`${initial} Recibimos 20 conversaciones al día.`);
  await page.locator('.registration-ai[aria-busy="true"]').waitFor();
  await page.locator('.registration-ai[aria-busy="false"]').waitFor(); await page.locator('.registration-proposal:not(.is-stale) .ia-propuesta[aria-busy="false"]').waitFor();
  check((await api(`/api/onboarding/borradores/${token}`)).clasificacion.tamano === '6_15', 'Reanalysis preserves the person’s explicit choice');
  check(await page.getByText('Tu respuesta y la nueva lectura no coinciden', { exact: true }).isVisible(), 'A conflicting inference is disclosed rather than overwriting a choice');
  await page.getByRole('button', { name: 'Mantener mi respuesta', exact: true }).click();
  await page.locator('.ia-propuesta[aria-busy="false"]').waitFor();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await overflow('preselected result');
    await capture(`result-${width}`);
  }
  // Teléfono: la IA queda fija arriba al bajar por la propuesta, y se puede plegar y volver a abrir.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo({ top: 1400, behavior: 'instant' }));
  await sleep(200);
  const barra = await page.locator('.registration-ai').boundingBox();
  check(barra && barra.y >= -1 && barra.y < 20, 'On phones the assistant stays pinned at the top while scrolling the proposal');
  await capture('assistant-pinned-390');
  await page.locator('.registration-ai-toggle').click();
  check(await page.locator('.registration-ai.is-folded').count() === 1 && (await page.locator('.registration-ai').boundingBox()).height <= 64, 'The pinned assistant folds to a single line');
  await capture('assistant-folded-390');
  await page.locator('.registration-ai-toggle').click();
  check(await page.locator('.registration-ai-toggle').getAttribute('aria-expanded') === 'true', 'The pinned assistant can be reopened');
  await page.setViewportSize({ width: 1440, height: 1000 });
  apiFault = 'analysis';
  await description.fill(`${initial} Recibimos 25 conversaciones al día.`);
  await page.getByRole('alert').filter({ hasText: 'Fallo de red de prueba' }).waitFor();
  check(true, 'Failed analysis stops with a visible recovery action');
  apiFault = '';
  await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await page.locator('.registration-ai[aria-busy="false"]').waitFor(); await page.locator('.registration-proposal:not(.is-stale) .ia-propuesta[aria-busy="false"]').waitFor();
  check((await api(`/api/onboarding/borradores/${token}`)).token === token, 'Retry reuses the existing draft');
  await page.getByRole('button', { name: 'Continuar con esta configuración' }).click();
  await page.getByRole('textbox', { name: 'Nombre comercial', exact: true }).fill('Barbería Horizonte');
  await page.getByRole('textbox', { name: /^Dirección de tu panel/ }).fill('horizonte-registro');
  await page.getByRole('textbox', { name: /^Tu nombre/ }).fill('Samuel Horizonte');
  await page.getByRole('textbox', { name: 'Correo del administrador', exact: true }).fill('dueno@registro-qa.test');
  await page.getByRole('button', { name: 'Enviar código de verificación', exact: true }).click();
  // El correo sale por la cola del trabajador: se espera a que llegue en lugar de leerlo en el mismo instante.
  let code = null;
  for (let intento = 0; intento < 20 && !code; intento++) {
    const r = await fetch(`${apiOrigin}/api/__test/codigo?email=dueno@registro-qa.test`);
    if (r.ok) code = await r.json(); else await sleep(500);
  }
  assert(code?.codigo, 'Verification code was delivered to the fake inbox');
  await page.getByLabel('Código de 6 dígitos').fill(code.codigo);
  await page.getByRole('button', { name: 'Confirmar código', exact: true }).click();
  await page.getByText(/Correo verificado/).waitFor();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await overflow('business data');
    await capture(`data-${width}`);
  }
  await page.getByRole('button', { name: 'Guardar y continuar', exact: true }).click();
  await page.getByRole('button', { name: /Escribirlo a mano/ }).click();
  await page.getByRole('textbox', { name: 'Nombre del ítem 1', exact: true }).fill('Corte Horizonte');
  await page.getByRole('textbox', { name: 'Precio del ítem 1 en pesos', exact: true }).fill('28000');
  await page.getByRole('button', { name: 'Guardar en el borrador', exact: true }).click();
  await page.getByRole('button', { name: /Continuar a la revisión del pago/ }).click();
  // Simulated checkout omits mandatory billing. Seed it through the real draft endpoint to verify real encrypted documents.
  await api(`/api/onboarding/borradores/${token}`, 'PATCH', { facturacion: { nombre: 'Samuel Horizonte', tipo_documento: 'CC', numero_documento: '1012345678', email: 'dueno@registro-qa.test', telefono: '+573001234567', direccion: 'Calle 10 # 5-20', ciudad: 'Cúcuta', departamento: 'Norte de Santander' } });
  await page.getByRole('button', { name: 'Ir al pago de prueba', exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/empezar/pago'));
  const checkout = page.url();
  await page.goto(`${origin}/empezar/listo`);
  await page.getByRole('heading', { name: 'Esperando la confirmación del pago', exact: true }).waitFor();
  check((await inspect(token)).owned === 0, 'A pending payment creates no company');
  await page.goto(checkout);
  await page.getByRole('button', { name: 'Simular rechazo', exact: true }).click();
  await page.getByRole('link', { name: 'Ver el estado de mi alta', exact: true }).click();
  await page.getByRole('heading', { name: 'El pago no fue aprobado', exact: true }).waitFor();
  check((await inspect(token)).owned === 0, 'A rejected payment preserves the draft and creates no company');
  await capture('payment-rejected-mobile');
  await page.getByRole('button', { name: 'Intentar el pago de nuevo', exact: true }).click();
  await page.getByRole('button', { name: 'Aprobar con webhook ×3', exact: true }).click();
  await page.getByRole('button', { name: 'Crear mi espacio con IA', exact: true }).waitFor();
  await page.locator('.impresion-listo').waitFor({ timeout: 30000 });
  let state = await inspect(token);
  check(state.owned === 0 && !state.jobs.length, 'Verified payment and duplicate webhooks show the receipt before any creation job or tenant exists');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await overflow('receipt before creation');
    await capture(`receipt-${width}`);
  }
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Descargar documentos/ }).click()]);
  check(download.suggestedFilename().endsWith('.zip') && !(await download.failure()), 'Payment documents can actually be downloaded before workspace creation');
  apiFault = 'status';
  await page.reload();
  await page.getByRole('heading', { name: 'No pudimos consultar tu alta', exact: true }).waitFor();
  apiFault = '';
  await page.getByRole('button', { name: 'Reintentar la consulta', exact: true }).click();
  await page.getByRole('button', { name: 'Crear mi espacio con IA', exact: true }).waitFor();
  check((await inspect(token)).owned === 0, 'Status recovery returns to the paid receipt without creating a company');
  await api('/api/__test/model', 'POST', { failGeneration: true });
  await page.locator('input[type="password"]').fill('registro-horizonte-2026');
  await page.getByRole('button', { name: 'Crear mi espacio con IA', exact: true }).click();
  await page.locator('.finish-creation-live').waitFor();
  await capture('creation-working-mobile');
  await page.getByRole('button', { name: /Reintentar.*creación|Volver a crear|Reintentar con IA/ }).waitFor({ timeout: 30000 });
  state = await inspect(token);
  check(state.draft.creacion.estado === 'error' && state.owned === 0, 'A real worker/model failure displays recovery and does not invent a completed workspace');
  await capture('creation-error-mobile');
  await api('/api/__test/model', 'POST', { failGeneration: false, generationDelay: 5000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /Reintentar.*creación|Volver a crear|Reintentar con IA/ }).click();
  await page.locator('.finish-creation-live').waitFor();
  // Duplicate the explicit request against the actual endpoint while its worker is running.
  await api(`/api/onboarding/borradores/${token}/crear`, 'POST', { password: 'registro-horizonte-2026' });
  await capture('creation-working-desktop');
  check(await page.locator('.theater .blueprint').isVisible(), 'Creating shows the live preview of the business workspace next to the grown orb');
  check(await page.locator('.bp-brand b').innerText() === 'Barbería Horizonte', 'The live preview uses the real business name');
  await page.locator('.bp-head h3').waitFor({ timeout: 30000 });
  await capture('creation-personalized-desktop');
  check(true, 'The AI-written start appears in the preview as soon as the server stores it');
  await page.locator('.theater.is-ready').waitFor({ timeout: 45000 });
  await capture('creation-ready-desktop');
  check(true, 'The preview marks the workspace as created before entering it');
  await page.locator('.app').waitFor({ timeout: 45000 });
  await page.locator('.pagina h1').waitFor();
  check(await page.locator('.workspace-birth.is-born').count() === 1, 'The first-run animation reveals the real mounted application');
  await page.evaluate(() => { window.__registrationPanelNode = document.querySelector('.app'); });
  await capture('workspace-birth-desktop');
  await page.locator('.workspace-birth:not(.is-born)').waitFor();
  check(await page.evaluate(() => window.__registrationPanelNode === document.querySelector('.app')), 'The mounted application remains in place when its creation animation finishes');
  check(new URL(page.url()).pathname === '/', 'Creation enters the actual authenticated workspace automatically');
  check(await page.getByRole('button', { name: 'Entrar a mi panel', exact: true }).count() === 0, 'Completion has no extra enter-panel button');
  state = await inspect(token);
  check(state.owned === 1 && state.tenants === 3, 'Retry and duplicate creation requests result in exactly one new tenant');
  check(state.jobs.length === 2, 'There is one durable creation job per attempt, not per duplicate click');
  check(state.draft.personalizacion?.motor === 'simulador', 'The persisted personalization keeps the model provenance');
  check(await page.getByText(state.draft.personalizacion.titulo, { exact: true }).isVisible(), 'The actual panel renders the persisted business-specific personalization');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await overflow('created workspace');
    await capture(`workspace-${width}`);
  }
  await page.goto(`${origin}/inventario`);
  await page.getByText('Corte Horizonte', { exact: true }).waitFor();
  check(true, 'The imported business catalogue is available in a functional authenticated module');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${origin}/empezar`);
  await page.locator('.registration-start canvas').first().waitFor();
  const staticOrb = page.locator('.registration-start canvas').first();
  await staticOrb.scrollIntoViewIfNeeded();
  await sleep(200);
  const staticFrame = await staticOrb.evaluate(el => el.toDataURL());
  await sleep(220);
  check(staticFrame === await staticOrb.evaluate(el => el.toDataURL()), 'Reduced-motion preference renders a static representative thinking-orbs frame');
  check(report.errors.length === 0, 'No browser JavaScript exceptions in the registration journey');
  console.log(JSON.stringify({ checks: report.assertions.length, screenshots: report.captures.length, errors: report.errors, fixture: report.fixture }, null, 2));
} catch (error) {
  report.failure = error.stack;
  if (page) { report.lastUrl = page.url(); report.lastBody = (await page.locator('body').innerText().catch(() => '')).slice(0, 16000); await capture('failure').catch(() => {}); }
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}/verification.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  server?.kill();
  frontend?.kill();
}
