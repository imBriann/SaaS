// Prueba de carga sencilla contra un servidor en marcha (sin dependencias).
// Uso: node scripts/carga.mjs [url_base] [segundos] [concurrencia]
// Mide latencias y errores de: salud, panel de inicio, bandeja, listado de ventas y
// recepción de webhooks firmados de WhatsApp (el camino crítico de entrada).
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const SEG = Number(process.argv[3] ?? 20);
const CONC = Number(process.argv[4] ?? 20);
const SECRETO = process.env.WHATSAPP_APP_SECRET ?? 'dev-whatsapp-app-secret';

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@elparche.test', password: 'demo-parche-2026' }) });
if (!login.ok) { console.error('No se pudo iniciar sesión con la cuenta de demostración'); process.exit(1); }
const cookie = login.headers.get('set-cookie').split(';')[0];
const panel = { cookie, 'x-tenant-slug': 'elparche' };

let n = 0;
const casos = {
  'GET /api/salud': () => fetch(`${BASE}/api/salud`),
  'GET /api/t/inicio': () => fetch(`${BASE}/api/t/inicio`, { headers: panel }),
  'GET /api/t/conversaciones': () => fetch(`${BASE}/api/t/conversaciones`, { headers: panel }),
  'GET /api/t/ventas': () => fetch(`${BASE}/api/t/ventas?por_pagina=50`, { headers: panel }),
  'POST /api/webhooks/whatsapp': () => {
    const from = `57399${String(++n % 5000).padStart(7, '0')}`;
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'carga', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'sim-elparche' }, contacts: [{ wa_id: from, profile: { name: 'Carga' } }], messages: [{ id: `wamid.carga.${Date.now()}.${n}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hola' } }] } }] }] });
    return fetch(`${BASE}/api/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRETO).update(body).digest('hex')}` }, body });
  },
};

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
console.log(`Carga: ${SEG} s por caso, ${CONC} clientes concurrentes, contra ${BASE}\n`);
console.log('Caso'.padEnd(32), 'Pet.', ' Pet/s', '  p50', '  p95', '  p99', 'Errores');
for (const [nombre, fn] of Object.entries(casos)) {
  const lat = [];
  let errores = 0;
  const fin = Date.now() + SEG * 1000;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (Date.now() < fin) {
      const t = performance.now();
      try { const r = await fn(); await r.arrayBuffer(); if (r.status >= 400) errores++; } catch { errores++; }
      lat.push(performance.now() - t);
    }
  }));
  lat.sort((a, b) => a - b);
  console.log(nombre.padEnd(32), String(lat.length).padStart(5), (lat.length / SEG).toFixed(1).padStart(6), ...[50, 95, 99].map((p) => `${pct(lat, p).toFixed(0)}ms`.padStart(6)), String(errores).padStart(6));
}
