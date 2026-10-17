/** Prueba manual: dos llamadas con datos sintéticos; jamás imprime credenciales. */
import { config } from '../src/config.js';
import { AnthropicLlm } from '../src/ai/llm/anthropic.js';
import { setLlm } from '../src/ai/llm/index.js';
import { classifyBusiness } from '../src/onboarding/classifier.js';
import { estadoIaRegistro, personalizarEspacio } from '../src/onboarding/personalization.js';

if (config.llm.provider !== 'anthropic' || !config.llm.apiKey) {
  console.log(JSON.stringify({ disponible: false, motivo: 'proveedor_real_no_configurado' }));
  process.exitCode = 1;
} else {
  // Esta comprobación no reintenta llamadas para no multiplicar el consumo.
  setLlm(new AnthropicLlm(config.llm.model, { apiKey: config.llm.apiKey, maxRetries: 0, timeoutMs: 45_000 }));
  const descripcion = 'Tengo una veterinaria llamada Huellas de Prueba. Somos dos veterinarios, recibimos 20 conversaciones al día para agendar consultas y no necesito factura electrónica.';
  console.log(JSON.stringify({ estado: estadoIaRegistro() }));
  const c = await classifyBusiness(descripcion);
  console.log(JSON.stringify({ clasificacion: { motor: c.motor, analisis: c.analisis, campos_detectados: ['sector', 'tipo_negocio', 'tamano', 'volumen_conv_mes', 'factura_electronica'].filter(k => (c as any)[k] != null), evidencias: Object.keys(c.evidencia ?? {}), tokens: c.tokens } }));
  try {
    const p = await personalizarEspacio({ descripcion, negocio: { nombre: 'Huellas de Prueba' }, clasificacion: c }, ['clientes', 'catalogo', 'agenda', 'conversaciones', 'ia']);
    console.log(JSON.stringify({ personalizacion: { motor: p.motor, titulo_valido: !!p.titulo, prioridades: p.prioridades.map(x => x.modulo), generado_en: p.generado_en } }));
    if (c.motor !== 'ia') process.exitCode = 1;
  } catch (e: any) {
    console.log(JSON.stringify({ personalizacion: { estado: 'error', clase: e?.name ?? 'Error', status: e?.status ?? null, tipo: e?.error?.type ?? null } }));
    process.exitCode = 1;
  }
}
