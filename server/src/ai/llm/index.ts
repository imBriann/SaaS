import { config } from '../../config.js';
import { todayLocal } from '../../lib/time.js';
import { AnthropicLlm } from './anthropic.js';
import { MockLlm } from './mock.js';
import type { LlmClient } from './types.js';

/**
 * Producción sin clave del modelo: no se simula. Cada intento falla de forma
 * explícita y la runtime pasa la conversación a una persona.
 */
export class SinModelo implements LlmClient {
  nombre = 'sin_modelo';
  async runLoop(): Promise<never> { throw new Error('modelo_no_configurado'); }
  async structured<T>(): Promise<{ data: T | null; raw: unknown; tokens: number }> { return { data: null, raw: null, tokens: 0 }; }
}

let client: LlmClient | null = null;

export function llm(): LlmClient {
  if (!client) {
    client = config.llm.provider === 'anthropic'
      ? new AnthropicLlm(config.llm.model, { apiKey: config.llm.apiKey, timeoutMs: config.llm.timeoutMs, maxRetries: config.llm.maxRetries, maxIteraciones: config.llm.maxIteraciones })
      : config.llm.provider === 'mock' ? new MockLlm(() => todayLocal()) : new SinModelo();
  }
  return client;
}

/** Sustituir el modelo (pruebas: modelo «convencido» por una inyección). */
export function setLlm(c: LlmClient | null) {
  client = c;
}
