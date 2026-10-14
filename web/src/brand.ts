/**
 * Marca de la plataforma. Único lugar del cliente web con el nombre, el lema y las
 * rutas de los logotipos (los archivos viven en public/marca). El servidor tiene su
 * par en server/src/brand.ts para correos y documentos.
 */
export const MARCA = {
  nombre: 'Omnegia',
  lema: 'Todo tu negocio. Un solo lugar.',
  logo: '/marca/logo.svg',
  logoNegativo: '/marca/logo-negativo.svg',
  icono: '/marca/icono.svg',
  isologo: '/marca/isologo.svg',
  cargando: '/marca/cargando.svg',
  hojaCoral: '/marca/hoja-coral.svg',
  lineaConexion: '/marca/linea-conexion.svg',
} as const;
