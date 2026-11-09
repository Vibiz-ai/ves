import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createApi, defaultDirs } from './server/api.mjs';

const uiDir = dirname(fileURLToPath(import.meta.url));

/** Mounts the same read-only API the standalone server uses, so `npm run dev` works against ../results. */
function vesApi(): Plugin {
  return {
    name: 'ves-api',
    configureServer(server) {
      const api = createApi(defaultDirs(uiDir));
      server.config.logger.info(`  ves-api results: ${api.resultsDir}`);
      server.middlewares.use((req, res, next) => api.middleware(req, res, next));
      server.httpServer?.on('close', () => api.close());
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), vesApi()],
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1' },
});
