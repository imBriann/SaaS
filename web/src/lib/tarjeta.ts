/** Validaciones de tarjeta en el navegador, para avisar antes de enviar. Wompi acepta Visa y Mastercard. */
export type Marca = 'VISA' | 'MASTERCARD' | null;

export const soloDigitos = (s: string) => s.replace(/\D/g, '');

export function marcaDe(numero: string): Marca {
  const n = soloDigitos(numero);
  if (/^4/.test(n)) return 'VISA';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d{2}|7[01]\d|720))/.test(n)) return 'MASTERCARD';
  return null;
}

/** Algoritmo de Luhn. */
export function luhn(numero: string): boolean {
  const n = soloDigitos(numero);
  if (n.length < 13) return false;
  let suma = 0, doble = false;
  for (let i = n.length - 1; i >= 0; i--) { let d = Number(n[i]); if (doble) { d *= 2; if (d > 9) d -= 9; } suma += d; doble = !doble; }
  return suma % 10 === 0;
}

/** «1234567812345678» → «1234 5678 1234 5678». */
export const formatearNumero = (s: string) => soloDigitos(s).slice(0, 19).replace(/(.{4})/g, '$1 ').trim();

/** «0629» → «06/29». */
export function formatearVence(s: string) {
  const d = soloDigitos(s).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

/** Mes y año de dos dígitos, o null si el vencimiento no es válido o ya pasó. */
export function venceValido(texto: string, ahora = new Date()): { mes: string; anio: string } | null {
  const m = soloDigitos(texto);
  if (m.length !== 4) return null;
  const mes = Number(m.slice(0, 2)), anio = 2000 + Number(m.slice(2));
  if (mes < 1 || mes > 12) return null;
  const finMes = new Date(anio, mes, 0, 23, 59, 59);
  if (finMes < ahora || anio > ahora.getFullYear() + 20) return null;
  return { mes: m.slice(0, 2), anio: m.slice(2) };
}

export const cvcValido = (cvc: string) => /^\d{3,4}$/.test(cvc);

/** Los seis datos del navegador que Wompi exige para el 3D Secure. */
export function datosNavegador() {
  return {
    browser_color_depth: String(window.screen.colorDepth), browser_screen_height: String(window.screen.height), browser_screen_width: String(window.screen.width),
    browser_language: String(window.navigator.language), browser_user_agent: String(window.navigator.userAgent).slice(0, 500), browser_tz: String(new Date().getTimezoneOffset()),
  };
}
