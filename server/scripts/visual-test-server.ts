/** Servidor exclusivamente de pruebas visuales. Base efímera en memoria. */
import { setup } from '../test/helpers.js';
const env = await setup();
await env.app.listen({ host: '127.0.0.1', port: 3002 });
console.log('VISUAL_TEST_READY');
const close = async () => { await env.app.close(); await env.db.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
