import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentLoginAvailable, agentQuotaUntil, availableAgents, discoverAccounts, pickAccount } from '../src/accounts.mjs';

test('contas extras vêm do local.env só quando o arquivo de login existe', (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const login = path.join(dir, 'credentials.json');
  fs.writeFileSync(login, '{}');
  assert.deepEqual(discoverAccounts(dir), { claude: ['claude'], codex: ['codex'] });
  fs.writeFileSync(path.join(dir, 'local.env'), [
    `LAB_CLAUDE_CREDENTIALS_FILE=${login}`,
    `LAB_CLAUDE_CREDENTIALS_FILE_2="${login}"`,
    `LAB_CLAUDE_STATE_FILE_2=${login}`,
    `LAB_CODEX_AUTH_FILE_3=${path.join(dir, 'falta.json')}`,
    `LAB_CLAUDE_CREDENTIALS_FILE_10=${login}`
  ].join('\n'));
  assert.deepEqual(discoverAccounts(dir), { claude: ['claude', 'claude-2'], codex: ['codex'] });
});

test('agente disponível: login existente no local.env ou chave em secrets/<agente>.env', (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { labels: { agents: ['codex', 'claude'] }, rooms: { labRoot: dir } };
  assert.deepEqual(availableAgents(config), [], 'sem local.env nem segredo');
  const login = path.join(dir, 'credentials.json');
  fs.writeFileSync(path.join(dir, 'local.env'), `LAB_CLAUDE_CREDENTIALS_FILE=${login}\nLAB_CODEX_AUTH_FILE=\n`);
  assert.deepEqual(availableAgents(config), [], 'caminho para arquivo que não existe não conta');
  fs.writeFileSync(login, '{}');
  assert.deepEqual(availableAgents(config), ['claude']);
  fs.mkdirSync(path.join(dir, 'secrets'));
  fs.writeFileSync(path.join(dir, 'secrets', 'codex.env'), 'CODEX_API_KEY=x\n');
  assert.deepEqual(availableAgents(config), ['codex', 'claude']);
  assert.equal(agentLoginAvailable(dir, 'codex'), true);
});

test('escolhe a conta com cota e menos salas; o agente só esgota quando todas esgotam', () => {
  const config = { accounts: { claude: ['claude', 'claude-2'] } };
  const now = Date.parse('2026-10-16T12:00:00Z');
  const state = { quota: {} };
  const running = (account) => ({ agent: 'claude', account, status: 'running' });
  assert.equal(pickAccount(config, state, 'claude', [], now), 'claude');
  assert.equal(pickAccount(config, state, 'claude', [running('claude')], now), 'claude-2');
  assert.equal(pickAccount(config, state, 'claude', [running('claude'), { ...running('claude-2'), status: 'ready' }], now), 'claude-2');
  assert.equal(pickAccount(config, state, 'codex', [], now), 'codex');
  state.quota['claude-2'] = { until: '2026-10-16T15:00:00Z' };
  assert.equal(pickAccount(config, state, 'claude', [running('claude')], now), 'claude');
  assert.equal(agentQuotaUntil(config, state, 'claude', now), null);
  state.quota.claude = { until: '2026-10-16T14:00:00Z' };
  assert.equal(pickAccount(config, state, 'claude', [], now), null);
  assert.equal(agentQuotaUntil(config, state, 'claude', now), '2026-10-16T14:00:00Z');
  assert.equal(agentQuotaUntil(config, state, 'claude', Date.parse('2026-10-16T16:00:00Z')), null);
});

test('resumo das contas para o painel junta a cota dos projetos e conta as salas', async () => {
  const { accountStatus } = await import('../src/accounts.mjs');
  const config = { labels: { agents: ['codex', 'claude'] }, accounts: { codex: ['codex'], claude: ['claude', 'claude-2'] } };
  const now = Date.parse('2026-10-19T12:00:00Z');
  const quotas = [{ 'claude-2': { until: '2026-10-19T13:00:00Z' } }, { 'claude-2': { until: '2026-10-19T14:00:00Z' }, codex: { until: '2026-10-19T11:00:00Z' } }];
  const tasks = [{ agent: 'claude', account: 'claude', status: 'running' }, { agent: 'claude', status: 'done' }, { agent: 'codex', status: 'verifying' }];
  assert.deepEqual(accountStatus(config, quotas, tasks, now), [
    { agent: 'codex', account: 'codex', rooms: 1, quotaUntil: null },
    { agent: 'claude', account: 'claude', rooms: 1, quotaUntil: null },
    { agent: 'claude', account: 'claude-2', rooms: 0, quotaUntil: '2026-10-19T14:00:00Z' }
  ]);
});
