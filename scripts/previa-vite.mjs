// Vite da prévia: a configuração do próprio projeto, aberta para a ponte da sala e com /api encaminhado ao
// back-end de teste. O navegador do celular fala só com um endereço, e o back-end continua em 127.0.0.1.
import { createServer, loadConfigFromFile, mergeConfig } from '/workspace/node_modules/vite/dist/node/index.js';

const env = { command: 'serve', mode: 'development' };
const loaded = await loadConfigFromFile(env, '/workspace/vite.config.ts', '/workspace');
const server = await createServer(mergeConfig(loaded?.config ?? {}, {
  configFile: false,
  root: '/workspace',
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true, allowedHosts: true, hmr: false,
    proxy: {
      // O back-end só aceita a origem do ambiente local; a prévia se apresenta como ela.
      '/api': { target: 'http://127.0.0.1:3401', changeOrigin: true, headers: { origin: 'http://localhost:5173' } }
    }
  }
}));
await server.listen();
console.log('previa: vite em 0.0.0.0:5173');
