// Video explicativo original de Omnegia: 12 capítulos de 10 s (2 min), 1280 × 720.
// La escena vive en scripts/tour/escena.html; aquí se renderiza fotograma a fotograma (determinista,
// sin depender de la velocidad de la máquina) y se codifica a VP9/WebM. La banda sonora es original: la compone
// scripts/tour/musica.html con Web Audio, se graba en Opus y se une al video sin recodificar. Sin recursos externos.
//
// Requiere Playwright (PLAYWRIGHT_MODULE) y un ffmpeg con libvpx-vp9 (FFMPEG_PATH; sirve el que instala
// `npx playwright install ffmpeg`). TEST_BROWSER permite usar un Chromium ya instalado.
//   node scripts/generate-product-tour.mjs                  video completo + póster + subtítulos
//   node scripts/generate-product-tour.mjs --stills 4,15,32  PNG de esos segundos en .impeccable/review/tour
//   node scripts/generate-product-tour.mjs --solo-metadatos   solo póster, subtítulos y origen (sin recodificar)
//   node scripts/generate-product-tour.mjs --solo-musica      recompone la música sobre el último video renderizado (tmp/tour)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || `${process.env.USERPROFILE}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
const chapters = JSON.parse(await readFile('web/src/content/product-tour.json', 'utf8'));
const dir = 'web/public/videos';
const FPS = Number(process.env.TOUR_FPS || 30), SECONDS = chapters.length * 10;
const soloMetadatos = process.argv.includes('--solo-metadatos'), soloMusica = process.argv.includes('--solo-musica');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg', build = 'tmp/tour';
const stills = process.argv.includes('--stills') ? process.argv[process.argv.indexOf('--stills') + 1].split(',').map(Number) : null;

// Servidor estático solo para esta ejecución: la escena carga la fuente y el logo reales del proyecto.
const root = resolve('.');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const path = resolve(join(root, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname))));
    if (!path.startsWith(root)) throw new Error('fuera de la raíz');
    res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }).end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'], ...(process.env.TEST_BROWSER ? { executablePath: process.env.TEST_BROWSER } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { throw e; });
  await page.addInitScript(c => { window.CHAPTERS = c; }, chapters);
  await page.goto(`${origin}/scripts/tour/escena.html`);
  await page.evaluate(() => window.ready);
  const frame = async (t, type = 'jpeg') => { await page.evaluate(s => window.seek(s), t); return page.screenshot(type === 'png' ? { type } : { type, quality: 94 }); };

  if (stills) {
    await mkdir('.impeccable/review/tour', { recursive: true });
    for (const t of stills) await writeFile(`.impeccable/review/tour/t${String(t).replace('.', '_')}.png`, await frame(t, 'png'));
    console.log(`Fotogramas guardados en .impeccable/review/tour (${stills.join(', ')} s)`);
  } else {
    await mkdir(dir, { recursive: true });
    await mkdir(build, { recursive: true });
    const silencioso = `${build}/video.webm`;
    if (!soloMetadatos && !soloMusica) {
      // Calidad constante (CRF): el movimiento es de interfaz, no de cámara, y comprime muy bien.
      const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', 'pipe:0',
        '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '0', '-crf', process.env.TOUR_CRF || '36', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-g', String(FPS), '-an', silencioso], { stdio: ['pipe', 'inherit', 'inherit'] });
      const closed = new Promise((ok, fail) => { ff.on('close', code => code === 0 ? ok() : fail(new Error(`ffmpeg terminó con código ${code}`))); ff.on('error', fail); });
      ff.stdin.on('error', () => {});
      for (let f = 0; f < FPS * SECONDS; f++) {
        const jpeg = await frame(Math.min(f / FPS, SECONDS - .001));
        if (!ff.stdin.write(jpeg)) await new Promise(r => ff.stdin.once('drain', r));
        if (f % (FPS * 10) === 0) console.log(`Capítulo ${Math.floor(f / FPS / 10) + 1}/${chapters.length}`);
      }
      ff.stdin.end(); await closed;
    }
    if (!soloMetadatos) {
      // Música: los efectos (clics, sello, avisos) salen de los data-sfx de la escena, así quedan sincronizados.
      const efectos = await page.evaluate(() => window.efectos());
      const estudio = await browser.newPage();
      await estudio.goto(`${origin}/scripts/tour/musica.html`);
      console.log('Grabando la banda sonora (tiempo real, 2 min)…');
      const { audio, pico, rms } = await estudio.evaluate(sfx => window.grabar(sfx), efectos);
      console.log(`Mezcla: pico ${pico}, RMS por capítulo ${rms.join(' / ')} dB`);
      await writeFile(`${build}/musica.webm`, Buffer.from(audio, 'base64'));
      const target = `${dir}/omnegia-recorrido.webm`, temporal = `${build}/final.webm`;
      await new Promise((ok, fail) => {
        const mux = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-i', silencioso, '-i', `${build}/musica.webm`, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-shortest', temporal], { stdio: 'inherit' });
        mux.on('close', code => code === 0 ? ok() : fail(new Error(`ffmpeg (unión) terminó con código ${code}`))); mux.on('error', fail);
      });
      // Windows puede tener el video anterior abierto (servidor de desarrollo, navegador): se copia si no se puede renombrar.
      try { await rename(temporal, target); } catch { await copyFile(temporal, target); await rm(temporal); }
    }
    // Póster: el momento en que la plataforma ya está armada.
    const poster = await frame(9.2);
    const origin_ = Buffer.from('Origin: Original artwork rendered by scripts/generate-product-tour.mjs from scripts/tour/escena.html and web/src/content/product-tour.json, using the existing Omnegia logo and local Outfit font. Poster of the two-minute illustrated product tour.', 'utf8');
    const comment = Buffer.alloc(origin_.length + 4);
    comment[0] = 0xff; comment[1] = 0xfe; comment.writeUInt16BE(origin_.length + 2, 2); origin_.copy(comment, 4);
    await writeFile(`${dir}/omnegia-recorrido.jpg`, Buffer.concat([poster.subarray(0, 2), comment, poster.subarray(2)]));
    const timestamp = sec => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.000`;
    await writeFile(`${dir}/omnegia-recorrido.vtt`, 'WEBVTT\n\n' + chapters.map((c, i) => `${timestamp(i * 10)} --> ${timestamp(i * 10 + 10)}\n${c.title}\n${c.text}\n`).join('\n'), 'utf8');
    await writeFile(`${dir}/omnegia-recorrido.jpg.json`, JSON.stringify({ origin: 'Original artwork rendered by scripts/generate-product-tour.mjs, using the existing Omnegia logo and local Outfit font.', source: ['scripts/tour/escena.html', 'web/src/content/product-tour.json'], generated: new Date().toISOString() }, null, 2));
    console.log(soloMetadatos ? 'Póster y subtítulos actualizados.' : `Video creado: ${dir}/omnegia-recorrido.webm (${SECONDS} s, ${FPS} fps, VP9 + Opus)`);
  }
} finally { await browser.close(); server.close(); }
