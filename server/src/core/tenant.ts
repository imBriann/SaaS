import type { Tx } from '../db/index.js';
import { zonaValida } from '../lib/time.js';

/** Zona horaria IANA del tenant del contexto (la RLS limita la lectura al propio). */
export async function zonaDe(tx: Tx): Promise<string> {
  return zonaValida((await tx.query(`SELECT zona_horaria FROM tenant LIMIT 1`)).rows[0]?.zona_horaria);
}
