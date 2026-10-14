/**
 * Depuración de textos técnicos antes de registrarlos. Un proveedor puede incluir
 * en su error direcciones, teléfonos, tokens o fragmentos del mensaje: aquí se
 * reemplazan por marcadores. Se usa en registros del servidor y del trabajador.
 * Lo que ve el operador NO sale de aquí: sale de códigos y de un catálogo fijo.
 */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

export function depurar(texto: unknown, max = 300): string {
  let s = String(texto ?? '');
  const uuids: string[] = [];
  s = s.replace(UUID, (m) => `\u0000${uuids.push(m) - 1}\u0000`);
  s = s
    // Texto libre entre comillas (fragmentos de mensajes que algunos proveedores citan).
    .replace(/"[^"]*"|“[^”]*”|«[^»]*»|'[^']{12,}'/g, '[texto]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[correo]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',]+/gi, '$1 [oculto]')
    .replace(/\b(re_|sk-|sk_|pk_|whsec_|EAA|xox[bp]-)[A-Za-z0-9_\-]{6,}/g, '[secreto]')
    .replace(/((?:token|clave|password|contrase(?:ñ|n)a|secret|secreto|api[_-]?key|authorization)["']?\s*[:=]\s*)["']?[^\s"',&]+/gi, '$1[oculto]')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '[dato]')
    .replace(/\+?\d[\d\s\-().]{6,}\d/g, '[número]');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => uuids[Number(i)]);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export type ClaseError = 'CREDENCIAL' | 'TIEMPO_AGOTADO' | 'LIMITE' | 'NO_ENCONTRADO' | 'INTERNO';

/** Clasifica un error técnico en una clase segura (lo único que sale hacia el operador). */
export function clasificarError(texto: unknown): ClaseError {
  const s = String(texto ?? '');
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]?(api[_ ]?)?(key|token)|OAuthException|\bcode\W{0,3}190\b|credencial|access token|token de acceso/i.test(s)) return 'CREDENCIAL';
  if (/timeout|timed out|ETIMEDOUT|tiempo agotado|no respondi|aborted|TimeoutError/i.test(s)) return 'TIEMPO_AGOTADO';
  if (/\b429\b|rate.?limit|too many|l[ií]mite|quota|cuota/i.test(s)) return 'LIMITE';
  if (/\b404\b|not found|no encontr/i.test(s)) return 'NO_ENCONTRADO';
  return 'INTERNO';
}
