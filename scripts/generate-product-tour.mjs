// Video explicativo original de Omnegia. Sin cuentas reales ni recursos externos.
// Requiere el frontend local y Playwright. TEST_BROWSER permite usar un Chromium instalado.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || `${process.env.USERPROFILE}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright`);
const chapters = JSON.parse(await readFile('web/src/content/product-tour.json', 'utf8'));
const dir = 'web/public/videos';
await mkdir(dir, { recursive: true });
// MediaRecorder no escribe Duration. Añadirla permite mostrar la duración y buscar capítulos.
function withDuration(buffer, milliseconds) {
  function vint(pos, id = false) {
    let width = 1; while (width <= 8 && !(buffer[pos] & (1 << (8 - width)))) width++;
    let value = id ? buffer[pos] : buffer[pos] & ((1 << (8 - width)) - 1);
    for (let j = 1; j < width; j++) value = value * 256 + buffer[pos + j];
    return { width, value };
  }
  function elements(start, end) {
    const result = [];
    for (let p = start; p < end;) {
      const id = vint(p, true), size = vint(p + id.width), data = p + id.width + size.width;
      result.push({ id: id.value, pos: p, sizePos: p + id.width, size, data });
      if (!Number.isSafeInteger(size.value) || size.value > end - data) break;
      p = data + size.value;
    }
    return result;
  }
  const segment = elements(0, buffer.length).find(e => e.id === 0x18538067);
  if (!segment) throw new Error('Video WebM sin segmento.');
  const info = elements(segment.data, buffer.length).find(e => e.id === 0x1549a966);
  if (!info) throw new Error('Video WebM sin información.');
  if (elements(info.data, info.data + info.size.value).some(e => e.id === 0x4489)) return buffer;
  const duration = Buffer.alloc(11); duration[0] = 0x44; duration[1] = 0x89; duration[2] = 0x88; duration.writeDoubleBE(milliseconds, 3);
  const sizeBytes = Buffer.alloc(info.size.width);
  let size = info.size.value + duration.length;
  for (let j = sizeBytes.length - 1; j >= 0; j--) { sizeBytes[j] = size & 255; size = Math.floor(size / 256); }
  sizeBytes[0] |= 1 << (8 - sizeBytes.length);
  return Buffer.concat([buffer.subarray(0, info.sizePos), sizeBytes, buffer.subarray(info.data, info.data + info.size.value), duration, buffer.subarray(info.data + info.size.value)]);
}
if (process.argv.includes('--finalize-existing')) {
  const target = `${dir}/omnegia-recorrido.webm`;
  await writeFile(target, withDuration(await readFile(target), 120000));
  console.log('Duración del video preparada para navegación por capítulos.');
  process.exit(0);
}
const browser = await chromium.launch({ headless: true, ...(process.env.TEST_BROWSER ? { executablePath: process.env.TEST_BROWSER } : {}), args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(process.env.TOUR_URL || 'http://127.0.0.1:5173/bienvenida');
  await page.exposeFunction('tourProgress', value => console.log(value));
  const result = await page.evaluate(async chapters => {
    await document.fonts.ready;
    const font = new FontFace('TourOutfit', 'url(/fonts/outfit-variable.ttf)');
    await font.load(); document.fonts.add(font);
    const logo = new Image(); logo.src = '/marca/logo-negativo.svg'; await logo.decode();
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
    const ctx = canvas.getContext('2d');
    const ink = '#111827', lavender = '#c5bfff';
    function rect(x, y, w, h, fill, r = 0, stroke) {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
    }
    function text(str, x, y, size = 22, color = '#fff', weight = 400) {
      ctx.font = `${weight} ${size}px TourOutfit`; ctx.fillStyle = color; ctx.fillText(str, x, y);
    }
    function wrap(str, x, y, max, size, line, color, weight = 400) {
      ctx.font = `${weight} ${size}px TourOutfit`;
      let row = '', count = 0;
      for (const word of str.split(' ')) {
        const next = row ? `${row} ${word}` : word;
        if (ctx.measureText(next).width > max && row) { text(row, x, y + count++ * line, size, color, weight); row = word; }
        else row = next;
      }
      if (row) text(row, x, y + count++ * line, size, color, weight);
      return y + count * line;
    }
    function check(x, y, color = '#5847df') {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 5, y + 5); ctx.lineTo(x + 14, y - 6); ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
    }
    function draw(seconds) {
      const index = Math.min(chapters.length - 1, Math.floor(seconds / 10));
      const c = chapters[index], local = seconds - index * 10;
      const enter = 1 - Math.pow(1 - Math.min(1, local / .65), 4);
      rect(0, 0, 1280, 720, ink);
      ctx.strokeStyle = '#283047'; ctx.lineWidth = 1;
      for (let x = 690; x < 1280; x += 90) { ctx.beginPath(); ctx.moveTo(x, 100); ctx.lineTo(x, 650); ctx.stroke(); }
      ctx.drawImage(logo, 64, 40, 181, 50);
      text('Todo tu negocio. Un solo lugar.', 879, 72, 20, '#bdc5d7');
      rect(64, 113, 1152, 1, '#354057');
      let y = wrap(c.title, 64, 226, 492, 48, 53, '#f7f5ff', 500);
      wrap(c.text, 64, y + 25, 485, 23, 33, '#c4cbdc');
      ctx.save(); ctx.translate(0, 16 * (1 - enter)); ctx.globalAlpha = .35 + enter * .65;
      ctx.shadowColor = '#00000066'; ctx.shadowBlur = 35; ctx.shadowOffsetY = 20;
      rect(620, 170, 596, 392, '#f6f5f1', 12); ctx.shadowColor = 'transparent';
      rect(620, 170, 596, 64, '#e8e5f6', 12);
      rect(620, 214, 596, 20, '#e8e5f6');
      text(c.panel, 650, 211, 23, '#302952', 500);
      text('Ejemplo', 1111, 210, 16, '#625579');
      rect(644, 251, 45, 285, '#eeece6', 5);
      for (let i = 0; i < 6; i++) rect(658, 269 + i * 41, 17, 17, i === index % 6 ? '#8b7ae1' : '#c5c8c4', 4);
      for (let i = 0; i < c.rows.length; i++) {
        const arrive = Math.max(0, Math.min(1, (local - .3 - i * .25) / .4));
        ctx.save(); ctx.globalAlpha = .3 + .7 * arrive; ctx.translate(8 * (1 - arrive), 0);
        const ry = 255 + i * 91;
        rect(709, ry, 480, 77, i === 0 ? '#eeebfc' : '#fff', 6, i === 0 ? '#d4caef' : '#ddded7');
        rect(726, ry + 22, 32, 32, '#e7e1f8', 7);
        check(735, ry + 38);
        wrap(c.rows[i], 773, ry + 33, 398, 20, 25, '#3c3c50', 400);
        ctx.restore();
      }
      ctx.restore();
      wrap(c.note, 64, 603, 1152, 18, 25, '#c5bfff');
      rect(64, 646, 1152, 1, '#354057');
      text(`${String(index + 1).padStart(2, '0')} / ${chapters.length}   ${c.short}`, 64, 685, 18, '#c4cbdc');
      text('Recorrido ilustrado · datos de ejemplo', 891, 685, 16, '#bdc5d7');
      for (let i = 0; i < chapters.length; i++) {
        const x = 64 + i * 97;
        rect(x, 635, 85, 3, '#3a4259');
        const progress = i < index ? 1 : i === index ? Math.min(1, local / 10) : 0;
        if (progress) rect(x, 635, 85 * progress, 3, lavender);
      }
    }
    draw(1);
    const poster = canvas.toDataURL('image/jpeg', .92).split(',')[1];
    const stream = canvas.captureStream(24);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm;codecs=vp8';
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1600000 });
    const chunks = [];
    const done = new Promise(resolve => { recorder.onstop = async () => {
      const data = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer());
      let binary = ''; for (let i = 0; i < data.length; i += 32768) binary += String.fromCharCode(...data.subarray(i, i + 32768));
      resolve(btoa(binary));
    }; });
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    draw(0); recorder.start(1000);
    const started = performance.now(); let lastChapter = -1;
    await new Promise(resolve => {
      function frame() {
        const elapsed = (performance.now() - started) / 1000;
        draw(Math.min(elapsed, 119.999));
        const chapter = Math.floor(elapsed / 10);
        if (chapter !== lastChapter) { lastChapter = chapter; void window.tourProgress(`Grabando capítulo ${Math.min(12, chapter + 1)}/12`); }
        if (elapsed >= 120) { recorder.stop(); stream.getTracks().forEach(t => t.stop()); resolve(); }
        else requestAnimationFrame(frame);
      }
      frame();
    });
    return { poster, video: await done, mime };
  }, chapters);
  await writeFile(`${dir}/omnegia-recorrido.webm`, withDuration(Buffer.from(result.video, 'base64'), 120000));
  const poster = Buffer.from(result.poster, 'base64');
  const origin = Buffer.from('Origin: Original canvas artwork rendered by scripts/generate-product-tour.mjs from web/src/content/product-tour.json, using the existing Omnegia logo and local Outfit font. Poster of the two-minute illustrated product tour.', 'utf8');
  const comment = Buffer.alloc(origin.length + 4);
  comment[0] = 0xff; comment[1] = 0xfe; comment.writeUInt16BE(origin.length + 2, 2); origin.copy(comment, 4);
  await writeFile(`${dir}/omnegia-recorrido.jpg`, Buffer.concat([poster.subarray(0, 2), comment, poster.subarray(2)]));
  const timestamp = sec => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.000`;
  await writeFile(`${dir}/omnegia-recorrido.vtt`, 'WEBVTT\n\n' + chapters.map((c, i) => `${timestamp(i * 10)} --> ${timestamp(i * 10 + 10)}\n${c.title}\n${c.text}\n`).join('\n'), 'utf8');
  await writeFile(`${dir}/omnegia-recorrido.jpg.json`, JSON.stringify({ origin: 'Original canvas artwork rendered by scripts/generate-product-tour.mjs, using the existing Omnegia logo and local Outfit font.', source: 'web/src/content/product-tour.json', generated: new Date().toISOString() }, null, 2));
  console.log(`Video creado: ${dir}/omnegia-recorrido.webm (120 s, ${result.mime})`);
} finally { await browser.close(); }
