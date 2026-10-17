/**
 * Cifrado de los datos de la tarjeta antes de entregarlos a Wompi: JWE compacto con RSA-OAEP-256 y A256GCM, como
 * documenta Wompi (POST /v1/tokens/cards con `payload`). Usa solo WebCrypto, sin dependencias. El resultado va
 * directo del navegador a Wompi; ningún dato de tarjeta pasa por el servidor de Omnegia.
 */
const utf8 = (s: string) => Uint8Array.from(new TextEncoder().encode(s));
const b64url = (b: ArrayBuffer | Uint8Array) => {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = ''; for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Longitud DER (ASN.1). */
function longitud(n: number): number[] {
  if (n < 128) return [n];
  const bytes: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 255);
  return [0x80 | bytes.length, ...bytes];
}
const tlv = (tag: number, contenido: number[] | Uint8Array) => [tag, ...longitud(contenido.length), ...contenido];

/** PEM → SPKI. Acepta «PUBLIC KEY» (SPKI) y «RSA PUBLIC KEY» (PKCS#1, que se envuelve en SPKI). */
export function pemASpki(pem: string): Uint8Array<ArrayBuffer> {
  const m = pem.match(/-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/);
  if (!m) throw new Error('Llave pública inválida');
  const der = Uint8Array.from(atob(m[2].replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  if (m[1] !== 'RSA PUBLIC KEY') return Uint8Array.from(der);
  // AlgorithmIdentifier rsaEncryption (1.2.840.113549.1.1.1) con parámetros NULL.
  const alg = tlv(0x30, [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  return Uint8Array.from(tlv(0x30, [...alg, ...tlv(0x03, [0x00, ...der])]));
}

/** Cifra `datos` con la llave pública RSA (PEM) y devuelve el JWE compacto de cinco partes. */
export async function cifrarJwe(pem: string, datos: unknown): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const llave = await subtle.importKey('spki', pemASpki(pem), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const cek = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cabecera = b64url(utf8(JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })));
  const aes = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const cifrado = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(cabecera), tagLength: 128 }, aes, utf8(JSON.stringify(datos))));
  const texto = cifrado.slice(0, cifrado.length - 16), etiqueta = cifrado.slice(cifrado.length - 16);
  const llaveCifrada = await subtle.encrypt({ name: 'RSA-OAEP' }, llave, cek);
  return [cabecera, b64url(llaveCifrada), b64url(iv), b64url(texto), b64url(etiqueta)].join('.');
}
