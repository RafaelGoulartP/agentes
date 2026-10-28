// Cria as etiquetas do fluxo que ainda não existem. Não altera nem apaga etiquetas existentes.
// Uso manual: node src/setup-labels.mjs <dono>/<repositorio> [area:extra ...]
// (o painel já cria as etiquetas que faltam quando o projeto é adicionado).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, readEnvSecret } from './config.mjs';
import { GitHubClient } from './github.mjs';
import { redact, registerSecret } from './redact.mjs';

export function laboratoryLabels(config) {
  return [
    { name: 'codex', color: '1d76db', description: 'Executada pelo agente Codex no laboratório' },
    { name: 'claude', color: 'd97706', description: 'Executada pelo agente Claude no laboratório' },
    { name: config.labels.inProgress, color: 'fbca04', description: 'Agente trabalhando' },
    { name: config.labels.blocked, color: 'b60205', description: 'Parada; retire para liberar nova tentativa' },
    { name: config.labels.readyForReview, color: '0e8a16', description: 'PR aguardando revisão humana' }
  ];
}

export async function ensureLabels(github, config, extra = []) {
  for (const label of [...laboratoryLabels(config), ...extra]) {
    try { await github.request('GET', `/labels/${encodeURIComponent(label.name)}`); }
    catch (error) {
      if (error.status !== 404) throw error;
      try { await github.request('POST', '/labels', label); }
      catch (created) { if (created.status !== 422) throw created; }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = /^([a-zA-Z0-9_.-]{1,100})\/([a-zA-Z0-9_.-]{1,100})$/.exec(process.argv[2] ?? '');
  if (!target) {
    console.error('uso: node src/setup-labels.mjs <dono>/<repositorio> [area:extra ...]');
    process.exit(2);
  }
  const config = loadConfig();
  const token = readEnvSecret(config.github.controllerTokenFile, 'GH_TOKEN');
  registerSecret(token);
  const github = new GitHubClient({ ...config.github, owner: target[1], repo: target[2], token });
  try {
    await ensureLabels(github, config, process.argv.slice(3).map((name) => ({ name, color: 'c5def5', description: 'Área travada pelo laboratório' })));
    console.log('Etiquetas conferidas.');
  } catch (error) { console.error(redact(error.message)); process.exitCode = 1; }
}
