import type { z } from 'zod';

/**
 * Capa de abstracción de modelos (riesgo R-05). El dominio no conoce al proveedor:
 * solo esta interfaz. El adaptador conduce el bucle de herramientas, pero cada
 * llamada pasa por onToolCall, que es el AI Action Gateway.
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LoopInput {
  configuracion: 'atencion' | 'asistente' | 'copiloto';
  system: string;
  history: ChatTurn[];
  tools: ToolSpec[];
  /** Nombre del negocio y datos no sensibles para respuestas del simulador. */
  negocio: { nombre: string };
  maxIterations?: number;
}

export interface ToolCallOutcome {
  /** Lo que se devuelve al modelo como tool_result. */
  content: Record<string, unknown>;
  isError?: boolean;
  /** Si true, el bucle termina (p. ej. se escaló a una persona). */
  stop?: boolean;
}

export interface LoopOutput {
  text: string;
  tokens: number;
  toolCalls: number;
  stopReason: string;
}

export interface StructuredInput<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Tarea declarada para el simulador determinista. */
  tarea: 'clasificar_negocio' | 'mapear_columnas' | 'resumir_caso' | 'sugerir_respuesta';
  datos?: unknown;
}

export interface LlmClient {
  nombre: string;
  runLoop(input: LoopInput, onToolCall: (name: string, args: unknown) => Promise<ToolCallOutcome>): Promise<LoopOutput>;
  /** data: validado contra el esquema; raw: salida sin validar, para descartar campo a campo (D-02). */
  structured<T>(input: StructuredInput<T>): Promise<{ data: T | null; raw: unknown; tokens: number }>;
}
