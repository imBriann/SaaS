import { readFileSync } from 'node:fs';
import { Country, State, City } from 'country-state-city';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { invalid } from '../lib/errors.js';

const colombia: { cod_dpto: string; dpto: string; cod_mpio: string; nom_mpio: string }[] = JSON.parse(readFileSync(new URL('./data/colombia.json', import.meta.url), 'utf8'));
const names = new Intl.DisplayNames(['es'], { type: 'region' });
export const countries = Country.getAllCountries().map(c => ({ codigo: c.isoCode, nombre: names.of(c.isoCode) ?? c.name,
  bandera: c.flag, indicativo: getCountries().includes(c.isoCode as CountryCode) ? '+' + getCountryCallingCode(c.isoCode as CountryCode) : null })).sort((a,b) => a.nombre.localeCompare(b.nombre, 'es'));
export function divisions(pais: string) {
  if (pais === 'CO') return [...new Map(colombia.map(c => [c.cod_dpto, { codigo: c.cod_dpto, nombre: c.dpto }])).values()].sort((a,b) => a.nombre.localeCompare(b.nombre));
  return State.getStatesOfCountry(pais).map(s => ({ codigo: s.isoCode, nombre: s.name }));
}
export function cities(pais: string, division: string) {
  if (pais === 'CO') return colombia.filter(c => c.cod_dpto === division).map(c => ({ codigo: c.cod_mpio, nombre: c.nom_mpio })).sort((a,b) => a.nombre.localeCompare(b.nombre));
  return (City.getCitiesOfState(pais, division) ?? []).map(c => ({ codigo: c.name, nombre: c.name }));
}
export function validateLocation(n: any) {
  if (!n.pais) return;
  if (!countries.some(c => c.codigo === n.pais)) throw invalid('Selecciona un país del catálogo.');
  if (n.departamento && !divisions(n.pais).some(d => d.codigo === n.departamento)) throw invalid('La división territorial no pertenece al país seleccionado.');
  if (n.municipio) {
    const city = cities(n.pais, n.departamento).find(c => c.codigo === n.municipio);
    if (!city) throw invalid('El municipio no pertenece a la división territorial seleccionada.');
    n.ciudad = city.nombre;
  }
  n.direccion_estado = 'PENDIENTE_CONFIRMAR';
}
export function normalizePhone(n: any) {
  if (!n.telefono_nacional) { if (n.telefono_nacional === '') n.telefono = null; return; }
  const p = parsePhoneNumberFromString(n.telefono_nacional, n.telefono_pais as CountryCode);
  if (!p?.isValid() || p.country !== n.telefono_pais || n.telefono_nacional.startsWith('+')) throw invalid('Revisa el número nacional y el país del teléfono. No escribas el indicativo internacional.');
  n.telefono = p.number;
  n.telefono_nacional = p.formatNational();
}
