import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverAccounts } from './accounts.mjs';

const BRANCH_PREFIX = /^[a-z0-9][a-z0-9._-]{0,30}$/;

function isArgumentList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

// verify.groups (listas executadas em paralelo, comandos de cada uma em ordem) ou verify.commands (um grupo).
export function verifyGroups(config) {
  return config.verify.groups ?? [config.verify.commands];
}

// Raiz do laboratório: a pasta acima de orchestrator/, onde ficam scripts/, secrets/ e workspaces/.
export const LAB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// orchestrator/config.json é da máquina (fora do Git); sem ele vale o modelo versionado.
export function defaultConfigPath() {
  const own = path.join(LAB_ROOT, 'orchestrator', 'config.json');
  return process.env.LAB_ORCHESTRATOR_CONFIG ?? (fs.existsSync(own) ? own : path.join(LAB_ROOT, 'orchestrator', 'config.example.json'));
}

// Fuso usado para horários sem data (ex.: "resets at 5pm") e nos avisos. Padrão: o fuso do sistema.
export function timeZone(config) {
  const zone = config?.timeZone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return 'UTC'; }
}

// Caminhos relativos do config.json valem a partir da raiz do laboratório; ausentes recebem o padrão.
function resolvePaths(config, file) {
  const root = path.resolve(config.rooms?.labRoot ?? path.resolve(path.dirname(file), '..'));
  const at = (value, fallback) => path.resolve(root, value ?? fallback);
  config.rooms = { ...config.rooms, labRoot: root };
  config.rooms.controlRoot = at(config.rooms.controlRoot, 'workspaces');
  config.github = { ...config.github, controllerTokenFile: at(config.github?.controllerTokenFile, 'secrets/github-controller.env') };
  config.git = { ...config.git, mirrorDir: at(config.git?.mirrorDir, 'orchestrator/state/git/repo.git') };
  config.projectsFile = at(config.projectsFile, 'orchestrator/state/projetos.json');
  config.stateFile = at(config.stateFile, 'orchestrator/state/state.json');
  config.lockFile = at(config.lockFile, 'orchestrator/state/orchestrator.lock');
  config.logFile = at(config.logFile, 'logs/orchestrator.jsonl');
}

export function loadConfig(file = defaultConfigPath()) {
  if (file instanceof URL) file = fileURLToPath(file);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const max = Number(config.scheduler?.maxConcurrency);
  const hardMax = Number(config.scheduler?.hardMaxConcurrency ?? 3);
  if (!Number.isInteger(max) || max < 1 || max > 3 || hardMax !== 3 || max > hardMax) {
    throw new Error('scheduler.maxConcurrency deve ser inteiro entre 1 e 3');
  }
  // owner/repo do controlador só identificam a instalação (avisos, registro); os projetos vêm do painel.
  config.github = { owner: 'laboratorio', repo: 'agentes', apiBase: 'https://api.github.com', ...config.github };
  if (!['codex', 'claude'].every((name) => config.labels?.agents?.includes(name))) {
    throw new Error('labels de codex e claude sao obrigatorias');
  }
  resolvePaths(config, file);
  config.timeZone = timeZone(config);
  config.quota = { defaultMinutes: 60, maxDays: 7, ...config.quota };
  config.accounts ??= discoverAccounts(config.rooms?.labRoot);
  config.notify = { enabled: false, ...config.notify };
  config.health = { minFreeGb: 15, ...config.health };
  config.cleanup = { days: 7, ...config.cleanup };
  config.retry = { baseSeconds: 300, maxSeconds: 3600, maxAttempts: 4, maxContinuations: 2, ...config.retry };
  config.rooms = { agentTimeoutMinutes: 240, agentIdleMinutes: 25, verifyTimeoutMinutes: 60, agentCliAuth: true, ...config.rooms };
  if (!BRANCH_PREFIX.test(config.rooms.branchPrefix ?? '')) throw new Error('rooms.branchPrefix invalido');
  if (!Number.isInteger(config.retry.maxAttempts) || config.retry.maxAttempts < 1) {
    throw new Error('retry.maxAttempts deve ser inteiro positivo');
  }
  for (const key of ['agentTimeoutMinutes', 'agentIdleMinutes', 'verifyTimeoutMinutes']) {
    if (!(Number(config.rooms[key]) > 0)) throw new Error(`rooms.${key} deve ser positivo`);
  }
  for (const agent of ['codex', 'claude']) {
    if (!isArgumentList(config.agents?.[agent]?.command)) throw new Error(`agents.${agent}.command deve ser lista de argumentos`);
  }
  // Os comandos de verificação vêm do .laboratorio.json de cada projeto; verify aqui é opcional.
  if (config.verify) {
    const groups = verifyGroups(config);
    if (!Array.isArray(groups) || !groups.length || !groups.every((group) => isArgumentList(group) && group.every((cmd) => !cmd.includes('\n')))) {
      throw new Error('verify.groups deve ser lista de listas de comandos (um por linha)');
    }
  }
  return config;
}

// Lê o arquivo de credencial como dado (KEY=valor); nunca é executado pelo shell.
export function readEnvSecret(path, name) {
  const text = fs.readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at > 0 && line.slice(0, at).trim() === name) {
      const value = line.slice(at + 1).trim();
      if (!value || /\s/.test(value)) throw new Error(`${name} invalido no arquivo de credencial`);
      return value;
    }
  }
  throw new Error(`${name} ausente no arquivo de credencial`);
}
