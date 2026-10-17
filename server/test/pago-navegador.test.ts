import { describe, expect, it } from 'vitest';
import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { cifrarJwe, pemASpki } from '../../web/src/lib/jwe.js';
import { cvcValido, formatearNumero, formatearVence, luhn, marcaDe, venceValido } from '../../web/src/lib/tarjeta.js';

/** El cifrado de la tarjeta corre en el navegador: aquí se descifra con la llave privada para probar que es un JWE válido. */
const descifrar = (jwe: string, privada: string) => {
  const [cab, llave, iv, texto, etiqueta] = jwe.split('.');
  const de = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const cek = privateDecrypt({ key: privada, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, de(llave));
  const d = createDecipheriv('aes-256-gcm', cek, de(iv));
  d.setAAD(Buffer.from(cab)); d.setAuthTag(de(etiqueta));
  return { cabecera: JSON.parse(de(cab).toString()), datos: JSON.parse(Buffer.concat([d.update(de(texto)), d.final()]).toString()) };
};

describe('JWE de la tarjeta (RSA-OAEP-256 + A256GCM)', () => {
  const tarjeta = { number: '4242424242424242', cvc: '123', exp_month: '06', exp_year: '29', card_holder: 'MARTA ROJAS' };

  it('con una llave en formato SPKI («PUBLIC KEY») Wompi puede descifrarlo', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwe = await cifrarJwe(publicKey.export({ type: 'spki', format: 'pem' }) as string, tarjeta);
    expect(jwe.split('.')).toHaveLength(5);
    const r = descifrar(jwe, privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    expect(r.cabecera).toEqual({ alg: 'RSA-OAEP-256', enc: 'A256GCM' });
    expect(r.datos).toEqual(tarjeta);
    expect(jwe).not.toContain('4242');
  });

  it('con una llave en formato PKCS#1 («RSA PUBLIC KEY») también', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;
    expect(pem).toContain('RSA PUBLIC KEY');
    // El PKCS#1 se envuelve en un SPKI: queda más largo que el original y empieza como una secuencia DER.
    expect(pemASpki(pem)[0]).toBe(0x30);
    expect(descifrar(await cifrarJwe(pem, tarjeta), privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).datos).toEqual(tarjeta);
  });

  it('cada cifrado usa clave e IV nuevos y una llave inválida falla', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
    expect(await cifrarJwe(pem, tarjeta)).not.toBe(await cifrarJwe(pem, tarjeta));
    await expect(cifrarJwe('no es una llave', tarjeta)).rejects.toThrow();
  });
});

describe('Validaciones de tarjeta', () => {
  it('Luhn y marca (Wompi acepta Visa y Mastercard)', () => {
    expect(luhn('4242 4242 4242 4242')).toBe(true);
    expect(luhn('4242 4242 4242 4243')).toBe(false);
    expect(luhn('1234')).toBe(false);
    expect(marcaDe('4242424242424242')).toBe('VISA');
    expect(marcaDe('5100 0000 0000 0002')).toBe('MASTERCARD');
    expect(marcaDe('2223 0000 0000 0000')).toBe('MASTERCARD');
    expect(marcaDe('3782 822463 10005')).toBeNull();
  });

  it('vencimiento y CVC', () => {
    const ahora = new Date(2026, 9, 17);
    expect(venceValido('1026', ahora)).toEqual({ mes: '10', anio: '26' });
    expect(venceValido('0926', ahora)).toBeNull();
    expect(venceValido('1329', ahora)).toBeNull();
    expect(venceValido('0699', ahora)).toBeNull();
    expect(venceValido('06/29', ahora)).toEqual({ mes: '06', anio: '29' });
    expect(cvcValido('123')).toBe(true);
    expect(cvcValido('12')).toBe(false);
    expect(formatearNumero('4242424242424242')).toBe('4242 4242 4242 4242');
    expect(formatearVence('0629')).toBe('06/29');
  });
});
