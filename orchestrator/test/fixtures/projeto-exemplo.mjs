// Projeto fictício usado pelos testes: um app Node com frontend e backend, Mongo descartável e prévia.
import { loadConfig } from '../../src/config.mjs';

export function exampleSettings() {
  return {
    dependencias: ['package-lock.json', 'backend/package-lock.json'],
    instalar: ['npm ci', 'npm --prefix backend ci', 'npx playwright install --with-deps chromium webkit firefox'],
    // Na sala, com lockfile diferente do da imagem: só as dependências (os navegadores já estão na imagem).
    reinstalar: ['npm ci --no-audit --no-fund', 'npm --prefix backend ci --no-audit --no-fund'],
    verificar: [
      ['npm run lint', 'npm run build', 'npm test'],
      ['cd backend && node --test test/*.test.mjs']
    ],
    leia: ['AGENTS.md', 'docs/TESTES.md'],
    proibido: { dominios: ['.producao.example'], portas: [3333, 8080], pastas: ['scripts/producao'], texto: 'credenciais ou bancos de produção' },
    imagensDeTeste: ['mongo:7'], dominiosExtras: [],
    previa: { passos: [
      { rodar: 'node scripts/dev-env/up.mjs --no-frontend', esperar: 'http://127.0.0.1:3401/api/health' },
      { rodar: 'VITE_API_URL=/api node /tmp/lab/previa-vite.mjs' }
    ], porta: 5173, logins: 'Equipe: admin@teste.local / Senha-De-Teste' }
  };
}

// Configuração do controlador a partir do modelo versionado, com um domínio de produção proibido.
export const base = (() => {
  const config = loadConfig(new URL('../../config.example.json', import.meta.url));
  config.github = { ...config.github, owner: 'dono', repo: 'projeto-exemplo' };
  config.rooms.deniedDomains = ['.producao.example'];
  config.scheduler.maxConcurrency = 3;
  config.verify = { groups: exampleSettings().verificar };
  config.images.preload = ['mongo:7'];
  return config;
})();

export function exampleProject(config, id = 'exemplo') {
  return { id, owner: config.github.owner, repo: config.github.repo, enabled: true,
    addedAt: new Date().toISOString(), config: exampleSettings() };
}
