import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El proxy conserva la cabecera Host (changeOrigin: false) para que el servidor
// resuelva el tenant por subdominio: http://elparche.localhost:5173
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    allowedHosts: ['.localhost'],
    proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: false } },
  },
});
