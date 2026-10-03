import { config } from '../config.js';
import { token } from '../lib/util.js';

/**
 * Puerto del correo transaccional (PRO-SW-001 §16.3). El adaptador de desarrollo
 * registra el envío y simula la evidencia de entrega; un proveedor real
 * (con SPF/DKIM del dominio remitente) implementa la misma interfaz.
 */
export interface EmailMessage { para: string; asunto: string; html: string; }
export interface EmailProvider {
  nombre: string;
  send(m: EmailMessage): Promise<{ ok: boolean; id?: string; error?: string }>;
}

export class LogEmailProvider implements EmailProvider {
  nombre = 'registro';
  enviados: (EmailMessage & { id: string })[] = [];
  async send(m: EmailMessage) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m.para)) return { ok: false, error: 'Dirección de correo inválida' };
    const id = `mail.${token(10)}`;
    this.enviados.push({ ...m, id });
    if (config.dev && process.env.NODE_ENV !== 'test') console.log(`[correo] → ${m.para}: ${m.asunto}`);
    return { ok: true, id };
  }
}

let provider: EmailProvider = new LogEmailProvider();
export const emailProvider = () => provider;
export const setEmailProvider = (p: EmailProvider) => (provider = p);
