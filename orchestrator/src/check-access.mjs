// Conferência somente leitura do token do controlador. Nunca imprime o token nem escreve no GitHub.
// Uso: node src/check-access.mjs <dono>/<repositorio>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readEnvSecret } from './config.mjs';
import { GitHubClient } from './github.mjs';
import { HostGit } from './host-git.mjs';
import { redact, registerSecret } from './redact.mjs';

const target = /^([a-zA-Z0-9_.-]{1,100})\/([a-zA-Z0-9_.-]{1,100})$/.exec(process.argv[2] ?? '');
if (!target) {
  console.error('uso: node src/check-access.mjs <dono>/<repositorio>');
  process.exit(2);
}
const config = loadConfig();
config.github = { ...config.github, owner: target[1], repo: target[2] };
// Espelho temporário: a conferência não mexe no estado do laboratório.
config.git = { mirrorDir: fs.mkdtempSync(path.join(os.tmpdir(), 'lab-check-')) + '/repo.git' };
process.on('exit', () => fs.rmSync(path.dirname(config.git.mirrorDir), { recursive: true, force: true }));
const file = config.github.controllerTokenFile;
let failures = 0;
const report = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ` — ${redact(detail)}` : ''}`);
};

if (!fs.existsSync(file)) {
  report(false, 'arquivo do token', `${file} não existe`);
  process.exit(1);
}
const mode = fs.statSync(file).mode & 0o777;
report(mode === 0o600, 'permissão do arquivo', `modo ${mode.toString(8)} (esperado 600)`);
const token = readEnvSecret(file, 'GH_TOKEN');
registerSecret(token);
report(token.startsWith('github_pat_'), 'formato fine-grained', token.startsWith('github_pat_') ? '' : 'não parece um token fine-grained');

const github = new GitHubClient({ ...config.github, token });
const check = async (label, fn) => {
  try { const detail = await fn(); report(true, label, detail ?? ''); }
  catch (error) { report(false, label, error.message); }
};

let defaultBranch = 'main';
await check('Metadata (ler repositório)', async () => {
  const repo = await github.repository();
  defaultBranch = repo.default_branch;
  return `${repo.full_name}, privado=${repo.private}, base=${repo.default_branch}`;
});
await check('Issues (ler)', async () => { await github.request('GET', '/issues?state=open&per_page=1'); return 'acesso concedido'; });
await check('Pull requests (ler)', async () => { await github.request('GET', '/pulls?state=open&per_page=1'); return 'acesso concedido'; });
await check('Contents (ler, compare)', async () => { await github.compare(defaultBranch, defaultBranch); return 'acesso concedido'; });
await check('Git via HTTPS (ls-remote)', async () => {
  const host = new HostGit(config);
  host.ensure();
  const sha = host.remoteSha(defaultBranch);
  if (!sha) throw new Error(`branch ${defaultBranch} não encontrada`);
  return `${defaultBranch} em ${sha.slice(0, 12)}`;
});

const wanted = [...config.labels.agents, config.labels.inProgress, config.labels.blocked, config.labels.readyForReview];
const missing = [];
for (const label of wanted) {
  try { await github.request('GET', `/labels/${encodeURIComponent(label)}`); }
  catch (error) { if (error.status === 404) missing.push(label); else report(false, `etiqueta ${label}`, error.message); }
}
report(missing.length === 0, 'etiquetas do fluxo', missing.length ? `faltando: ${missing.join(', ')}` : wanted.join(', '));

console.log('\nPermissões de escrita (Contents, Issues, Pull requests) não são testadas aqui. As etiquetas que faltam são');
console.log('criadas quando o projeto é adicionado pelo painel (ou com node src/setup-labels.mjs <dono>/<repositorio>).');
process.exit(failures ? 1 : 0);
