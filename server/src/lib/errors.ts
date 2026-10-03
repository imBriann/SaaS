/**
 * Errores de dominio. El mapeo a HTTP es uniforme:
 * NOT_FOUND cubre tanto "no existe" como "existe en otro tenant" o "no autorizado
 * sobre ese recurso" (PRO-SW-002 DD-03, estado «Bloqueado» de PRO-SW-003 §11).
 */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'UNAUTHENTICATED'
  | 'SUSPENDED'
  | 'QUOTA'
  | 'BAD_SIGNATURE';

const STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  VALIDATION: 400,
  CONFLICT: 409,
  UNAUTHENTICATED: 401,
  SUSPENDED: 423,
  QUOTA: 429,
  BAD_SIGNATURE: 401,
};

export const MSG_NO_ENCONTRADO = 'No encontramos eso.';

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
  }
  get status() { return STATUS[this.code]; }
}

export const notFound = () => new AppError('NOT_FOUND', MSG_NO_ENCONTRADO);
export const invalid = (msg: string, details?: unknown) => new AppError('VALIDATION', msg, details);
