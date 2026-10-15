/** Servidor exclusivamente de pruebas visuales. Base efímera en memoria. */
import { setup, codigoDelCorreo } from '../test/helpers.js';
if(process.env.NODE_ENV!=='test')throw new Error('Este servidor exige NODE_ENV=test');
const env = await setup();
// Exclusivo de esta base efímera: lee el correo del proveedor falso para el recorrido del navegador.
env.app.get('/api/__test/codigo', async (req:any)=>({codigo:await codigoDelCorreo(env.db,String(req.query.email))}));
await env.app.listen({ host: '127.0.0.1', port: 3002 });
console.log('VISUAL_TEST_READY');
const close = async () => { await env.app.close(); await env.db.close(); process.exit(0); };
process.on('SIGINT', close);
process.on('SIGTERM', close);
