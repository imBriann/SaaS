// Se ejecuta en un proceso aparte con un entorno controlado (y en un directorio sin .env):
// imprime el resultado de validarConfiguracion() tal como lo vería el servidor al arrancar.
const { validarConfiguracion, config } = await import(process.env.__RUTA_CONFIG__!);
process.stdout.write(JSON.stringify({ ...validarConfiguracion(), almacen: config.imagenes.almacen, dev: config.dev }));
