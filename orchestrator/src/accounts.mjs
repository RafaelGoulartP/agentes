import fs from 'node:fs';
import path from 'node:path';
import { SLOT_STATUSES } from './domain.mjs';

// Contas de cada agente (várias assinaturas do mesmo agente). A conta padrão tem o nome do agente e usa as
// variáveis de sempre do local.env; as extras usam o mesmo nome com _2 a _9 (LAB_CLAUDE_CREDENTIALS_FILE_2 vira
// a conta claude-2). Só entra a conta extra cujo arquivo de login existe. O local.env só tem caminhos.
const LOGIN_VARS = { claude: 'LAB_CLAUDE_CREDENTIALS_FILE', codex: 'LAB_CODEX_AUTH_FILE' };
export const ACCOUNT_NAME = /^(codex|claude)(?:-([2-9]))?$/;

export function discoverAccounts(labRoot, agents = Object.keys(LOGIN_VARS)) {
  const accounts = Object.fromEntries(agents.map((agent) => [agent, [agent]]));
  let text = '';
  try { text = fs.readFileSync(path.join(labRoot ?? '', 'local.env'), 'utf8'); } catch { return accounts; }
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^(?:export\s+)?(LAB_[A-Z_]+?)_([2-9])=(.*)$/);
    if (!match) continue;
    const agent = Object.keys(LOGIN_VARS).find((name) => LOGIN_VARS[name] === match[1]);
    const file = match[3].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!agent || !accounts[agent] || !file || !fs.existsSync(file)) continue;
    const name = `${agent}-${match[2]}`;
    if (!accounts[agent].includes(name)) accounts[agent].push(name);
  }
  for (const list of Object.values(accounts)) list.sort();
  return accounts;
}

// O agente pode trabalhar nesta máquina: login da CLI (local.env aponta para um arquivo existente) ou
// chave de API em secrets/<agente>.env.
export function agentLoginAvailable(labRoot, agent) {
  if (fs.existsSync(path.join(labRoot, 'secrets', `${agent}.env`))) return true;
  let text = '';
  try { text = fs.readFileSync(path.join(labRoot, 'local.env'), 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.trim().match(/^(?:export\s+)?([A-Z_]+)=(.*)$/);
    if (match?.[1] !== LOGIN_VARS[agent]) continue;
    const file = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (file && fs.existsSync(file)) return true;
  }
  return false;
}

export function availableAgents(config) {
  return config.labels.agents.filter((agent) => agentLoginAvailable(config.rooms.labRoot, agent));
}

export function accountsFor(config, agent) {
  return config.accounts?.[agent]?.length ? config.accounts[agent] : [agent];
}

const exhausted = (state, account, now) => {
  const quota = state.quota?.[account];
  return Boolean(quota && Date.parse(quota.until) > now);
};

// null quando alguma conta do agente ainda tem cota; senão, quando a primeira delas volta.
export function agentQuotaUntil(config, state, agent, now = Date.now()) {
  const accounts = accountsFor(config, agent);
  if (!accounts.every((account) => exhausted(state, account, now))) return null;
  return accounts.map((account) => state.quota[account].until).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

// Conta com cota e com menos salas abertas (contando todos os projetos); empate fica com a primeira.
export function pickAccount(config, state, agent, tasks, now = Date.now()) {
  const busy = new Map();
  for (const task of tasks) {
    if (SLOT_STATUSES.has(task.status) && task.agent === agent) busy.set(task.account ?? agent, (busy.get(task.account ?? agent) ?? 0) + 1);
  }
  const free = accountsFor(config, agent).filter((account) => !exhausted(state, account, now));
  if (!free.length) return null;
  return free.reduce((best, account) => (busy.get(account) ?? 0) < (busy.get(best) ?? 0) ? account : best);
}

// Resumo para o painel: salas abertas de cada conta e até quando a cota dela está esgotada (a maior entre os projetos).
export function accountStatus(config, quotas, tasks, now = Date.now()) {
  const quota = {};
  for (const list of quotas) {
    for (const [account, value] of Object.entries(list ?? {})) {
      if (!quota[account] || Date.parse(value.until) > Date.parse(quota[account].until)) quota[account] = value;
    }
  }
  return (config.labels?.agents ?? Object.keys(LOGIN_VARS)).flatMap((agent) => accountsFor(config, agent).map((account) => ({
    agent, account,
    rooms: tasks.filter((task) => task.agent === agent && (task.account ?? agent) === account && SLOT_STATUSES.has(task.status)).length,
    quotaUntil: Date.parse(quota[account]?.until) > now ? quota[account].until : null
  })));
}
