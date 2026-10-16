import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || `${process.env.USERPROFILE}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
const out = '.impeccable/review/landing';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.TEST_BROWSER ? { executablePath: process.env.TEST_BROWSER } : {}) });
const report = { checks: [], errors: [], viewports: [] };
const check = (condition, label) => { assert(condition, label); report.checks.push(label); };
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', e => report.errors.push(e.message));
  let videoRequested = false;
  page.on('request', r => { if (r.url().endsWith('.webm')) videoRequested = true; });
  for (const width of process.argv.includes('--media-only') ? [] : [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('http://127.0.0.1:5173/bienvenida');
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.system-piece').first().waitFor();
    check(await page.locator('.system-piece').count() === 6, `${width}: seis módulos accesibles`);
    const respira = () => page.locator('.system-piece').nth(1).evaluate(e => ({ nombre: getComputedStyle(e).animationName, z: getComputedStyle(e).translate }));
    await page.waitForTimeout(1600);
    const r1 = await respira(); await page.waitForTimeout(1200); const r2 = await respira();
    check(r1.nombre.includes('piece-breathe') && r1.z !== r2.z, `${width}: las tarjetas respiran sin pisar la transición de selección`);
    const menores = await page.evaluate(() => {
      const raices = ['.om-hero', '.om-how', '.om-modules', '.om-trust', '.om-support', '.om-closing'];
      const pequenos = [];
      for (const raiz of raices) for (const el of document.querySelectorAll(`${raiz} *`)) {
        if (el.closest('[aria-hidden=true], .system-platform, .module-art, .sr-only, svg')) continue;
        const directo = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        if (!directo) continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < 14) pequenos.push(`${el.className || el.tagName}: ${size}px`);
      }
      return pequenos;
    });
    check(menores.length === 0, `${width}: ningún texto de la landing baja de 14 px (${menores.slice(0, 4).join(' | ')})`);
    await page.locator('.om-support').scrollIntoViewIfNeeded();
    check(await page.getByRole('tab').count() === 2, `${width}: ayuda con dos pestañas reales`);
    check(await page.getByRole('tab', { name: /Asistente de tu empresa/ }).getAttribute('aria-selected') === 'true', `${width}: la ayuda abre con un ejemplo visible`);
    await page.getByRole('tab', { name: /Equipo de Omnegia/ }).click();
    check(await page.getByRole('tabpanel').innerText().then(t => t.includes('No logro conectar WhatsApp')), `${width}: la pestaña del equipo abre su ejemplo`);
    check(await page.getByRole('tab', { name: /Equipo de Omnegia/ }).evaluate(e => e.getBoundingClientRect().height >= 44), `${width}: pestañas con objetivo táctil suficiente`);
    await page.keyboard.press('ArrowLeft');
    check(await page.getByRole('tab', { name: /Asistente de tu empresa/ }).getAttribute('aria-selected') === 'true', `${width}: pestañas navegables con flechas`);
    if (width <= 900) {
      const selector = page.getByRole('button', { name: 'Explorar Agenda', exact: true });
      await selector.click();
      check(await page.getByRole('button', { name: 'Agenda', exact: true }).getAttribute('aria-pressed') === 'true', `${width}: selector legible sincroniza la tarjeta`);
      check(await selector.evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 14 && e.getBoundingClientRect().height >= 44), `${width}: selector con texto legible y objetivo táctil`);
    }
    for (const name of ['Conversaciones', 'Agenda', 'Ventas', 'Clientes', 'Inventario', 'Asistente IA']) {
      const button = page.getByRole('button', { name, exact: true });
      await button.click({ force: true }); // las tarjetas respiran: nunca están «estables» para Playwright
      check(await button.getAttribute('aria-pressed') === 'true', `${width}: seleccionar ${name}`);
      check(await page.locator('.system-piece[aria-pressed=true]').count() === 1, `${width}: selección individual coherente`);
    }
    await page.getByRole('button', { name: 'Operación', exact: true }).click();
    await page.waitForTimeout(550);
    check(await page.locator('.system-description-pane.is-current').innerText().then(s => s.includes('De la cita a la venta.')), `${width}: categoría cambia explicación`);
    check(await page.locator('.system-piece.is-lit').count() === 3, `${width}: categoría eleva sus módulos`);
    const pos = await page.locator('.system-piece.is-lit').first().evaluate(e => new DOMMatrix(getComputedStyle(e).transform).m43);
    check(pos >= 37, `${width}: elevación tridimensional aplicada`);
    await page.getByRole('button', { name: 'Control', exact: true }).click();
    await page.getByRole('button', { name: 'Atención', exact: true }).click();
    await page.getByRole('button', { name: 'Ventas', exact: true }).click({ force: true });
    await page.waitForTimeout(550);
    check(await page.getByRole('button', { name: 'Operación', exact: true }).getAttribute('aria-pressed') === 'true', `${width}: cambios rápidos conservan categoría y módulo`);
    const lift = await page.getByRole('button', { name: 'Ventas', exact: true }).evaluate(e => new DOMMatrix(getComputedStyle(e).transform).m43);
    check(lift >= 71, `${width}: tarjeta elegida se eleva sobre el grupo`);
    const overflow = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    check(overflow.scroll <= width + 1, `${width}: sin desbordamiento horizontal`);
    report.viewports.push(overflow);
    await page.getByRole('button', { name: 'Atención', exact: true }).click();
    await page.waitForTimeout(550);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${out}/${width}.png`, fullPage: true });
    await page.screenshot({ path: `${out}/${width}-hero.png` });
    await page.locator('#confianza').screenshot({ path: `${out}/${width}-trust.png`, style: '.site-header { visibility: hidden; }' });
  }
  check(!videoRequested, 'El video no se descarga antes de abrirlo');
  check(await page.getByRole('button', { name: /Vista simple|Pausar movimiento|Reanudar movimiento/ }).count() === 0, 'Controles de pausa y vista simple retirados');
  await page.setViewportSize({ width: 1440, height: 1000 });
  if (process.argv.includes('--media-only')) await page.goto('http://127.0.0.1:5173/bienvenida');
  const trigger = page.getByRole('button', { name: /Ver cómo funciona Omnegia/ });
  await trigger.click();
  await page.getByRole('dialog').waitFor();
  const video = page.locator('video');
  await video.evaluate(v => new Promise((resolve, reject) => {
    if (v.error) return reject(new Error('No se pudo cargar el video.'));
    if (v.readyState >= 2) return resolve();
    setTimeout(() => reject(new Error('El video no cargó en 15 segundos.')), 15000);
    v.addEventListener('loadeddata', resolve, { once: true });
    v.addEventListener('error', () => reject(new Error('No se pudo cargar el video.')), { once: true });
  }));
  check(await video.evaluate(v => !v.error && v.videoWidth === 1280), 'Video real reproducible de 1280 × 720');
  check(await video.evaluate(v => Math.abs(v.duration - 120) < 1), 'Video de dos minutos con duración y navegación disponibles');
  await page.waitForTimeout(1200);
  check(await video.evaluate(v => v.currentTime > 0 && !v.paused), 'El video se reproduce al abrirlo');
  check(await video.evaluate(v => v.webkitAudioDecodedByteCount > 0 && v.volume < 1), 'El video trae su banda sonora, con volumen inicial moderado');
  await page.getByRole('button', { name: /1:30.*Permisos y auditoría/ }).click();
  await page.waitForFunction(() => { const v = document.querySelector('video'); return v.currentTime >= 90 && !v.seeking && v.readyState >= 2; });
  await page.waitForTimeout(1250);
  check(true, 'Los capítulos permiten saltar a permisos y auditoría');
  check(await page.locator('.tour-current h3').innerText().then(t => t.includes('quién puede hacer qué')), 'La explicación legible sigue el capítulo elegido');
  await video.evaluate(v => v.pause());
  await page.getByRole('dialog').evaluate(e => e.scrollTo({ top: 0, behavior: 'instant' }));
  await video.hover();
  await page.screenshot({ path: `${out}/video-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('dialog').evaluate(e => e.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${out}/video-mobile.png` });
  check(await page.locator('dialog').evaluate(e => e.scrollWidth <= e.clientWidth + 1), 'Reproductor sin desbordamiento en móvil');
  check(await page.locator('.tour-current p').evaluate(e => parseFloat(getComputedStyle(e).fontSize) >= 16), 'Video acompañado por explicación legible en móvil');
  await page.keyboard.press('Escape');
  check(await trigger.evaluate(e => e === document.activeElement), 'Escape cierra el video y devuelve el foco');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Agenda', exact: true }).focus();
  await page.keyboard.press('Enter');
  check(await page.getByRole('button', { name: 'Agenda', exact: true }).getAttribute('aria-pressed') === 'true', 'Tarjetas utilizables con teclado');
  check(await page.locator('.system-piece.is-selected').evaluate(e => getComputedStyle(e).transform === 'none' && getComputedStyle(e).animationName === 'none'), 'Movimiento reducido conserva selección sin elevación ni bucle');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/reduced-motion.png` });
  check(report.errors.length === 0, 'Sin excepciones JavaScript');
  console.log(JSON.stringify({ checks: report.checks.length, errors: report.errors }, null, 2));
} catch (e) { report.failure = e.stack; console.error(e); process.exitCode = 1; }
finally { await writeFile(`${out}/${process.argv.includes('--media-only') ? 'media-verification' : 'verification'}.json`, JSON.stringify(report, null, 2)); await browser.close(); }
