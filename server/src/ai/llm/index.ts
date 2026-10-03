import { config } from '../../config.js';
import { todayLocal } from '../../lib/time.js';
import { AnthropicLlm } from './anthropic.js';
import { MockLlm } from './mock.js';
import type { LlmClient } from './types.js';

let client: LlmClient | null = null;

export function llm(): LlmClient {
  if (!client) client = config.llm.provider === 'anthropic' ? new AnthropicLlm(config.llm.model) : new MockLlm(() => todayLocal());
  return client;
}

/** Sustituir el modelo (pruebas: modelo «convencido» por una inyección). */
export function setLlm(c: LlmClient | null) {
  client = c;
}
