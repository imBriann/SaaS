import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { LlmClient, LoopInput, LoopOutput, StructuredInput, ToolCallOutcome } from './types.js';

/**
 * Adaptador de Claude (API de Mensajes, bucle manual de herramientas).
 * El bucle es manual a propósito: cada tool_use propuesto por el modelo se
 * entrega al Gateway antes de ejecutarse; el modelo nunca ejecuta nada.
 *
 * - Se habilitan los fallbacks del lado del servidor ante rechazos (refusal) solo en los modelos que
 *   los admiten: Claude Haiku 5.5 no tiene respaldo y responde 400 si se envía el parámetro.
 * - Se devuelve response.content completo al historial (bloques de thinking incluidos).
 */
/**
 * La salida estructurada no admite límites de longitud, de cantidad de elementos ni rangos numéricos
 * (p. ej. 400 «For 'array' type, property 'maxItems' is not supported»). Se quitan del esquema que viaja
 * a la API; la respuesta se revalida después contra el esquema Zod completo, así que nada se relaja.
 */
const RESTRICCIONES_NO_ADMITIDAS = ['maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
export function esquemaCompatible(nodo: unknown): unknown {
  if (Array.isArray(nodo)) return nodo.map(esquemaCompatible);
  if (!nodo || typeof nodo !== 'object') return nodo;
  const salida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(nodo)) {
    if (RESTRICCIONES_NO_ADMITIDAS.includes(k)) continue;
    if (k === 'minItems' && typeof v === 'number' && v > 1) continue;
    salida[k] = esquemaCompatible(v);
  }
  return salida;
}

const MODELOS_CON_RESPALDO = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export class AnthropicLlm implements LlmClient {
  nombre = 'anthropic';
  private client: Anthropic;
  constructor(private model: string, opts: { apiKey?: string; timeoutMs?: number; maxRetries?: number; maxIteraciones?: number } = {}) {
    // Tiempo de espera por intento (ms) y reintentos automáticos ante 408/409/429/5xx y errores de red.
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 45_000, maxRetries: opts.maxRetries ?? 2 });
    this.maxIteraciones = opts.maxIteraciones ?? 6;
  }
  private maxIteraciones: number;
  private respaldo() {
    return MODELOS_CON_RESPALDO.has(this.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {};
  }

  async runLoop(input: LoopInput, onToolCall: (name: string, args: unknown) => Promise<ToolCallOutcome>): Promise<LoopOutput> {
    const messages: Anthropic.Beta.BetaMessageParam[] = [];
    for (const h of input.history) {
      const last = messages[messages.length - 1];
      if (last && last.role === h.role) last.content = `${last.content as string}\n${h.text}`;
      else messages.push({ role: h.role, content: h.text });
    }
    if (!messages.length || messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(inicio de la conversación)' });

    const tools: Anthropic.Beta.BetaTool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Beta.BetaTool.InputSchema,
    }));

    let tokens = 0;
    let entrada = 0;
    let salida = 0;
    let toolCalls = 0;
    const maxIt = input.maxIterations ?? this.maxIteraciones;
    for (let i = 0; i < maxIt; i++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
        messages,
        tools,
        output_config: { effort: 'low' },
        ...this.respaldo(),
      } as Anthropic.Beta.MessageCreateParamsNonStreaming);
      tokens += (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
      entrada += (response.usage.input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0);
      salida += response.usage.output_tokens ?? 0;

      if (response.stop_reason === 'refusal') {
        return { text: 'Disculpa, no puedo ayudarte con eso por aquí. Si quieres, te comunico con una persona del equipo.', tokens, toolCalls, stopReason: 'refusal', tokensEntrada: entrada, tokensSalida: salida };
      }
      messages.push({ role: 'assistant', content: response.content });
      const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (response.stop_reason !== 'tool_use' || !uses.length) {
        return { text, tokens, toolCalls, stopReason: response.stop_reason ?? 'end_turn', tokensEntrada: entrada, tokensSalida: salida };
      }
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      let stop = false;
      for (const u of uses) {
        toolCalls++;
        const out = await onToolCall(u.name, u.input);
        stop = stop || !!out.stop;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out.content), is_error: out.isError });
      }
      messages.push({ role: 'user', content: results });
      if (stop) {
        // Una persona toma el control: el agente se despide y no sigue actuando.
        return { text, tokens, toolCalls, stopReason: 'handoff', tokensEntrada: entrada, tokensSalida: salida };
      }
    }
    return { text: 'Estoy teniendo problemas para resolver esto. Te comunico con una persona del equipo.', tokens, toolCalls, stopReason: 'max_iterations', tokensEntrada: entrada, tokensSalida: salida };
  }

  async structured<T>(input: StructuredInput<T>): Promise<{ data: T | null; raw: unknown; tokens: number }> {
    const schema = esquemaCompatible(z.toJSONSchema(input.schema, { target: 'draft-7' })) as Record<string, unknown>;
    delete schema.$schema;
    const response = await this.client.beta.messages.create({
      model: this.model,
      // El pensamiento adaptativo también consume max_tokens: margen para que el JSON no quede truncado.
      max_tokens: 4096,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      ...this.respaldo(),
    } as Anthropic.Beta.MessageCreateParamsNonStreaming);
    const tokens = (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0);
    if (response.stop_reason === 'refusal') return { data: null, raw: null, tokens };
    const text = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
    try {
      // La salida SIEMPRE se revalida contra el esquema cerrado en código (D-02).
      const raw = JSON.parse(text);
      const parsed = input.schema.safeParse(raw);
      return { data: parsed.success ? parsed.data : null, raw, tokens };
    } catch {
      return { data: null, raw: null, tokens };
    }
  }
}
