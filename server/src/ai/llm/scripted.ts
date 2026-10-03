import type { LlmClient, LoopInput, LoopOutput, StructuredInput, ToolCallOutcome } from './types.js';

/**
 * Modelo guionizado: propone exactamente las llamadas indicadas, sin importar
 * qué herramientas se le mostraron. Representa a un modelo «completamente
 * convencido» por una inyección (PRO-SW-002 fig. 12b): sirve para demostrar que
 * la defensa está en el registro y el Gateway, no en el prompt.
 */
export class ScriptedLlm implements LlmClient {
  nombre = 'guion';
  resultados: { name: string; args: unknown; outcome: ToolCallOutcome }[] = [];
  vistas: string[][] = [];
  constructor(private calls: { name: string; args: unknown }[], private texto = 'Hecho.', private raw: unknown = null) {}

  async runLoop(input: LoopInput, call: (n: string, a: unknown) => Promise<ToolCallOutcome>): Promise<LoopOutput> {
    this.vistas.push(input.tools.map((t) => t.name));
    for (const c of this.calls) this.resultados.push({ ...c, outcome: await call(c.name, c.args) });
    return { text: this.texto, tokens: 50, toolCalls: this.calls.length, stopReason: 'end_turn' };
  }

  async structured<T>(input: StructuredInput<T>) {
    const parsed = input.schema.safeParse(this.raw);
    return { data: parsed.success ? parsed.data : null, raw: this.raw, tokens: 20 };
  }
}
