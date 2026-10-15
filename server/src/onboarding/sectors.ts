/** Catálogo de actividades; independiente de las plantillas de aprovisionamiento. */
export const SECTOR_CATALOG = [
  ['comercio', 'Comercio minorista y mayorista', ['Tienda de barrio', 'Supermercado', 'Ropa y accesorios', 'Ferretería', 'Distribuidora mayorista', 'Comercio electrónico', 'Papelería']],
  ['alimentos', 'Alimentos y bebidas', ['Panadería', 'Pastelería', 'Producción de alimentos', 'Bebidas', 'Carnicería', 'Frutas y verduras']],
  ['restaurante', 'Restaurantes y cafeterías', ['Restaurante', 'Cafetería', 'Comida rápida', 'Bar', 'Catering']],
  ['salud', 'Salud y bienestar', ['Consultorio médico', 'Odontología', 'Psicología', 'Fisioterapia', 'Nutrición', 'Farmacia']],
  ['barberia', 'Belleza y cuidado personal', ['Barbería', 'Peluquería', 'Salón de uñas', 'Estética', 'Spa']],
  ['gimnasio', 'Deporte y acondicionamiento físico', ['Gimnasio', 'Entrenamiento personal', 'Yoga y pilates', 'Escuela deportiva']],
  ['educacion', 'Educación y formación', ['Colegio', 'Academia', 'Cursos virtuales', 'Idiomas', 'Clases particulares']],
  ['servicios', 'Servicios profesionales', ['Consultoría', 'Contabilidad', 'Servicios jurídicos', 'Diseño', 'Marketing', 'Arquitectura']],
  ['tecnologia', 'Tecnología y software', ['Desarrollo de software', 'Soporte informático', 'Telecomunicaciones', 'Servicios digitales']],
  ['construccion', 'Construcción y mantenimiento', ['Construcción', 'Electricidad', 'Plomería', 'Limpieza', 'Mantenimiento de inmuebles']],
  ['taller', 'Automotores y reparación', ['Taller mecánico', 'Reparación de motos', 'Repuestos', 'Lavado de vehículos']],
  ['transporte', 'Transporte y logística', ['Transporte de pasajeros', 'Transporte de carga', 'Mensajería', 'Almacenamiento']],
  ['turismo', 'Turismo y alojamiento', ['Hotel', 'Hostal', 'Agencia de viajes', 'Guía turístico', 'Alquiler vacacional']],
  ['inmobiliario', 'Inmobiliario', ['Inmobiliaria', 'Administración de propiedades', 'Arrendamientos']],
  ['manufactura', 'Manufactura', ['Textiles', 'Muebles', 'Metalmecánica', 'Artesanías', 'Fabricación industrial']],
  ['agricultura', 'Agricultura y ganadería', ['Cultivos', 'Ganadería', 'Avicultura', 'Acuicultura', 'Insumos agropecuarios']],
  ['entretenimiento', 'Entretenimiento', ['Eventos', 'Artes y cultura', 'Recreación', 'Producción audiovisual']],
  ['mascotas', 'Servicios para mascotas', ['Veterinaria', 'Peluquería canina', 'Tienda para mascotas', 'Guardería de mascotas']],
  ['organizaciones', 'Organizaciones y servicios públicos', ['Fundación', 'Asociación', 'Entidad pública', 'Servicios públicos']],
  ['otro', 'Otros', ['Otra actividad']],
].map(([id, nombre, tipos]) => ({ id: id as string, nombre: nombre as string, tipos: tipos as string[] }));
export const sectorTypes = (id: string | null) => SECTOR_CATALOG.find(s => s.id === id)?.tipos ?? [];
