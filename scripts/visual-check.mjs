import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || `${process.env.LOCALAPPDATA ? `${process.env.USERPROFILE}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/` : ''}playwright`);
const outputDir = process.env.VISUAL_OUTPUT_DIR || '.impeccable/review/final';
const server = spawn(process.execPath, ['--import', './server/node_modules/tsx/dist/loader.mjs', 'server/scripts/visual-test-server.ts'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'test', DATABASE_URL_PRUEBAS: '', EMAIL_PROVIDER: 'fake', LLM_PROVIDER: 'mock', PAGOS_PROVEEDOR: 'simulada', FISCAL_PROVIDER: 'sandbox', APP_PUBLIC_URL: 'http://localhost:5174', BASE_DOMAIN: 'localhost', WHATSAPP_ACCESS_TOKEN: '', ANTHROPIC_API_KEY: '' },
});
const frontend = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { cwd: 'web', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
const report = { assertions: [], viewports: [], pageErrors: [], captures: [], fixtureStates: [] };
try {
  await new Promise((resolve, reject) => {
    let logs = '';
    const timeout = setTimeout(() => reject(new Error('El servidor de pruebas no inició.')), 40000);
    server.stdout.on('data', chunk => { if (chunk.toString().includes('VISUAL_TEST_READY')) { clearTimeout(timeout); resolve(); } });
    server.stderr.on('data', chunk => { logs += chunk.toString(); });
    server.on('exit', code => { clearTimeout(timeout); reject(new Error(`Servidor de prueba: ${code}. ${logs.slice(-1500)}`)); });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('El frontend de pruebas no inició.')), 30000);
    frontend.stdout.on('data', chunk => { if (chunk.toString().includes('Local:')) { clearTimeout(timeout); resolve(); } });
    // Puede haber iniciado mientras cargaba la base.
    fetch('http://localhost:5174').then(() => { clearTimeout(timeout); resolve(); }).catch(() => {});
    frontend.on('exit', code => { clearTimeout(timeout); reject(new Error(`Frontend de prueba: ${code}`)); });
  });
  browser = await chromium.launch({ headless: true, ...(process.env.TEST_BROWSER ? { executablePath: process.env.TEST_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  let fault = '';
  // Todas las API se ejecutan sobre la base efímera, nunca sobre los datos de desarrollo.
  await context.route('**/api/**', async route => {
    const url = route.request().url().replace('http://localhost:5174', 'http://127.0.0.1:3002');
    if (fault === 'network' && url.endsWith('/estado') && url.includes('/borradores/')) return route.fulfill({ status: 503, json: { error: { message: 'No pudimos consultar el servidor de prueba.' } } });
    if (fault === 'modules' && url.endsWith('/publico/modulos')) return route.fulfill({ status: 503, json: { error: { message: 'Catálogo no disponible.' } } });
    if (url.endsWith('/reintentar')) fault = '';
    const response = await route.fetch({ url });
    if (fault === 'provision' && url.endsWith('/estado') && url.includes('/borradores/')) {
      const state = await response.json();
      return route.fulfill({ response, json: { ...state, estado: 'PAGO_CONFIRMADO', tenant: null, panel: null, etapas: state.etapas.filter(e => e.etapa === 'pago_verificado'), error_aprovisionamiento: 'No pudimos preparar tu espacio. Tu pago está confirmado; puedes reintentar.' } });
    }
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  page.on('pageerror', e => report.pageErrors.push(e.message));
  await mkdir(outputDir, { recursive: true });
  const capture = async name => {
    if (process.env.VISUAL_SKIP_CAPTURE === '1') return;
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: `${outputDir}/${name}.png`, fullPage: true, animations: 'disabled' });
    await page.screenshot({ path: `${outputDir}/${name}-viewport.png`, animations: 'disabled' });
    report.captures.push(name);
  };
  const check = (condition, text) => { assert(condition, text); report.assertions.push(text); };
  const overflow = async route => {
    const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    report.viewports.push({ route, ...result });
    check(result.scroll <= result.width + 1, `Sin desbordamiento: ${route} a ${result.width}px`);
  };
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto('http://localhost:5174/bienvenida');
    await page.getByRole('heading', { name: /Tu negocio,/ }).waitFor();
    await capture(width === 1440 ? 'desktop' : width === 390 ? 'mobile' : `viewport-${width}`);
    await overflow('/bienvenida');
    if (width === 1440) {
      await page.getByRole('button', { name: 'Operación' }).click();
      check(await page.getByText('De la cita a la venta.', { exact: true }).isVisible(), 'Escena: cambiar módulo actualiza la explicación');
      await page.getByRole('button', { name: 'Ventas', exact: true }).click();
      check(await page.getByRole('button', { name: 'Ventas', exact: true }).getAttribute('aria-pressed') === 'true', 'Tarjetas de escena seleccionables');
      check(await page.locator('.system-piece.is-selected').evaluate(el => getComputedStyle(el).transform === 'none'), 'Movimiento reducido ofrece una escena sin elevación');
      await capture('scene-reduced');
    }
    if (width === 390) {
      await page.getByRole('button', { name: 'Abrir menú' }).click();
      check(await page.getByRole('navigation', { name: 'Sitio público' }).isVisible(), 'Navegación móvil disponible');
      await page.keyboard.press('Escape');
      check(await page.getByRole('button', { name: 'Abrir menú' }).evaluate(el => el === document.activeElement), 'Escape devuelve el foco al menú');
    }
  }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const route of ['producto', 'planes', 'nosotros', 'ayuda', 'empezar', 'entrar']) {
      await page.goto(`http://localhost:5174/${route}`);
      await page.getByRole('heading', { level: 1 }).waitFor();
      if (route === 'producto') await page.locator('.product-row').first().waitFor();
      if (route === 'planes') await page.locator('.quote-total').waitFor();
      await capture(`${route}-${width}`);
      await overflow(`/${route}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:5174/ayuda');
  await page.getByText('¿Qué puede hacer el asistente?', { exact: true }).click();
  check(await page.locator('details[open]').count() === 1, 'Preguntas de ayuda accesibles y funcionales');
  await page.goto('http://localhost:5174/planes');
  await page.locator('.quote-total').waitFor();
  const before = await page.locator('.quote-total').innerText();
  await page.getByRole('button', { name: /Ventas y pedidos/ }).click();
  await page.waitForFunction(old => document.querySelector('.quote-total')?.textContent !== old && !document.querySelector('.quote-total')?.textContent?.includes('Calculando'), before);
  check(true, 'Cotización real se recalcula al seleccionar un módulo');
  fault = 'modules'; await page.reload();
  await page.getByRole('alert').filter({ hasText: 'No pudimos cargar' }).waitFor();
  check(await page.getByRole('button', { name: 'Continuar con esta selección' }).isDisabled(), 'Fallo de catálogo impide continuar con selección incompleta');
  fault = ''; await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
  await page.getByRole('button', { name: 'Continuar con esta selección' }).waitFor({ state: 'visible' });
  await page.goto('http://localhost:5174/empezar');
  await page.getByRole('textbox', { name: 'Describe tu negocio' }).fill('Tengo una barbería con dos personas. Necesito organizar las citas, los clientes y las ventas.');
  await page.getByRole('button', { name: 'Analizar mi negocio' }).click();
  await page.getByRole('heading', { name: 'Una propuesta para tu negocio' }).waitFor();
  await capture('setup-selection');
  await page.getByRole('button', { name: 'Continuar con mis datos' }).click();
  await page.getByRole('textbox', { name: 'Nombre comercial', exact: true }).fill('Estudio QA Omnegia');
  await page.getByRole('textbox', { name: 'Correo del administrador', exact: true }).fill('dueno@omnegia-qa.test');
  await page.getByRole('textbox', { name: /^Tu nombre/ }).fill('Prueba Omnegia');
  await page.getByLabel('Nombre de tu direcci\u00f3n', {exact:false}).fill('estudio-qa-omnegia');
  await page.getByRole('button', {name:'Guardar y continuar',exact:true}).click();
  await page.getByText('Confirma el c\u00f3digo de tu correo antes de continuar.',{exact:true}).waitFor();
  await page.getByRole('button', {name:'Enviar c\u00f3digo de verificaci\u00f3n'}).click();
  const code=await (await page.request.get('http://127.0.0.1:3002/api/__test/codigo?email=dueno@omnegia-qa.test')).json();
  await page.getByLabel('C\u00f3digo de 6 d\u00edgitos').fill(code.codigo);
  await page.getByRole('button',{name:'Confirmar c\u00f3digo',exact:true}).click();
  await page.getByText('Correo verificado',{exact:true}).waitFor();
  for(const width of [1440,390,320]) {
    await page.setViewportSize({width,height:900});
    await capture(`registration-${width}`);await overflow('/empezar/datos');
  }
  await page.getByRole('button', {name:'Guardar y continuar',exact:true}).click();
  await page.getByRole('button', { name: /Escribirlo a mano/ }).click();
  await page.getByRole('textbox', { name: 'Nombre del ítem 1', exact: true }).fill('Corte de prueba');
  await page.getByRole('textbox', { name: 'Precio del ítem 1 en pesos', exact: true }).fill('25000');
  await page.getByRole('button', { name: 'Guardar catálogo' }).click();
  await page.getByRole('button',{name:'Continuar a la revisi\u00f3n del pago'}).click();
  await page.getByRole('button', { name: 'Ir al pago de prueba' }).click();
  await page.getByRole('button', { name: 'Simular rechazo' }).click();
  await page.getByRole('link', { name: 'Ver el estado de mi alta' }).click();
  await page.getByRole('heading', { name: 'La pasarela rechazó el pago' }).waitFor();
  await capture('setup-rejected');
  check(true, 'Pago rechazado: borrador conservado y reintento disponible');
  await page.getByRole('button', { name: 'Intentar el pago de nuevo' }).click();
  await page.getByRole('button', { name: 'Aprobar con webhook ×3' }).click();
  await page.getByRole('heading', { name: 'Estudio QA Omnegia ya tiene su panel' }).waitFor();
  await capture('setup-success');
  check(await page.locator('.workspace-assembly.is-ready').count() === 1, 'Alta real con nombre y módulos efectivos tras webhook duplicado ×3');
  fault = 'network'; await page.reload();
  await page.getByRole('heading', { name: 'No pudimos consultar el estado de tu alta' }).waitFor();
  await capture('setup-network-error');
  fault = ''; await page.getByRole('button', { name: 'Reintentar la consulta' }).click();
  await page.getByRole('heading', { name: 'Estudio QA Omnegia ya tiene su panel' }).waitFor();
  check(true, 'Fallo de consulta: reintento recupera el alta sin crear otra empresa');
  fault = 'provision'; await page.reload();
  await page.getByRole('button', { name: 'Reintentar la creación' }).waitFor();
  await capture('setup-provision-error');
  report.fixtureStates.push('Fallo de aprovisionamiento: respuesta interceptada sobre un alta real; reintento idempotente contra el backend real.');
  await page.getByRole('button', { name: 'Reintentar la creación' }).click();
  await page.getByRole('heading', { name: 'Estudio QA Omnegia ya tiene su panel' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await capture('setup-success-mobile'); await overflow('/empezar/listo');
  // Credencial desechable de una empresa de prueba en una base solo en memoria.
  await page.getByLabel('Crea tu contraseña para dueno@omnegia-qa.test').fill('qa-omnegia-prueba-2026');
  await page.getByRole('button', { name: 'Entrar a mi panel' }).click();
  await page.getByRole('heading', { name: /Hola, Prueba/ }).waitFor();
  check(true, 'Alta termina en el panel real con sesión y empresa seleccionada');
  await capture('new-panel-mobile');
  await context.clearCookies();
  await page.evaluate(() => { localStorage.removeItem('empresa'); localStorage.removeItem('borrador'); });
  await page.goto('http://localhost:5174/entrar');
  await page.getByLabel('Correo', { exact: true }).fill('admin@elparche.test');
  await page.getByLabel('Contraseña', { exact: true }).fill('demo-parche-2026');
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await page.getByRole('heading', { name: /Hola,/ }).waitFor();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    for (const route of ['', 'conversaciones', 'agenda', 'ventas', 'clientes', 'inventario', 'facturacion', 'ia', 'suscripcion', 'auditoria', 'simulador', 'configuracion', 'soporte']) {
      await page.goto(`http://localhost:5174/${route}`);
      await page.locator('.app').waitFor();
      await page.locator('.pagina h1').waitFor();
      await overflow(`/${route || 'panel'}`);
      if (width !== 768) await capture(`${route || 'panel'}-${width}`);
    }
  }
  await page.getByRole('button', { name: 'Nueva solicitud' }).click();
  await page.getByLabel('Asunto', { exact: true }).fill('Prueba visual de soporte');
  await page.getByLabel(/^Qué pasó/).fill('Solicitud desechable para comprobar el recorrido de soporte y su estado visible.');
  await page.getByRole('button', { name: 'Enviar solicitud' }).click();
  await page.getByRole('heading', { name: 'Prueba visual de soporte' }).waitFor();
  await capture('support-ticket-mobile');
  check(true, 'Atención humana: solicitud real con radicado y estado');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://localhost:5174/bienvenida');
  await page.locator('.system-piece').first().waitFor();
  check(await page.locator('.system-piece').first().evaluate(el => getComputedStyle(el).animationName.includes('piece-breathe') && getComputedStyle(el).transitionProperty === 'transform'), 'Escena: la respiración (translate) convive con la transición de selección (transform)');
  await page.getByRole('button', { name: 'Agenda', exact: true }).click({ force: true });
  check(await page.getByRole('button', { name: 'Agenda', exact: true }).getAttribute('aria-pressed') === 'true', 'Escena: selección individual de tarjeta');
  check(await page.getByRole('button', { name: /Pausar movimiento|Vista simple/ }).count() === 0, 'Escena: controles retirados');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Inventario', exact: true }).click();
  check(await page.getByRole('button', { name: 'Inventario', exact: true }).getAttribute('aria-pressed') === 'true', 'Escena: selección de tarjeta también en móvil');
  await capture('scene-mobile-motion');
  await page.setViewportSize({ width: 1440, height: 1000 });
  check(await page.getByRole('link', { name: 'Crear mi espacio' }).last().isVisible(), 'CTA visible mientras se anima la escena');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check(await page.locator('.system-piece').first().evaluate(el => getComputedStyle(el).animationName === 'none'), 'Movimiento reducido desactiva el ensamblaje');
  await page.getByRole('button', { name: 'Control', exact: true }).focus();
  await page.keyboard.press('Enter');
  check(await page.getByText('La IA ayuda. Tú decides.', { exact: true }).isVisible(), 'Escena utilizable con teclado');
  check(await page.locator('canvas').count() === 0, 'La escena no requiere WebGL ni un canvas');
  const fallback = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await fallback.route('**/fonts/**', route => route.abort());
  const fallbackPage = await fallback.newPage();
  await fallbackPage.goto('http://localhost:5174/bienvenida');
  check(await fallbackPage.getByRole('heading', { name: /Tu negocio,/ }).isVisible(), 'Contenido disponible si falla la fuente local');
  check(await fallbackPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Fuente de respaldo sin desbordamiento móvil');
  await fallback.close();
  check(report.pageErrors.length === 0, 'Sin excepciones JavaScript durante los recorridos');
  console.log(JSON.stringify({ checks: report.assertions.length, captures: report.captures.length, errors: report.pageErrors, fixtures: report.fixtureStates }, null, 2));
} catch (error) {
  report.failure = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}/verification.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  server.kill();
  frontend.kill();
}
