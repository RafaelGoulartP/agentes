import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RetryQueue } from '../src/requests.mjs';
import { base } from './fixtures/projeto-exemplo.mjs';

test('API de nova tentativa: valida estado, origem e projeto; pedido persistente sem alterar estado', { timeout: 20000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-api-'));
  const config = structuredClone(base);
  config.stateFile = path.join(dir, 'state.json');
  config.projectsFile = path.join(dir, 'projetos.json');
  config.logFile = path.join(dir, 'events.jsonl');
  config.lockFile = path.join(dir, 'lock.json');
  config.git.mirrorDir = path.join(dir, 'git');
  const project = (id, enabled) => ({ id, enabled, owner: 'dono', repo: id, addedAt: new Date().toISOString() });
  fs.writeFileSync(config.projectsFile, JSON.stringify([project('alpha', true), project('beta', false)]));
  const state = { tasks: { 16: { issueNumber: 16, status: 'retry' }, 17: { issueNumber: 17, status: 'running' }, 18: { issueNumber: 18, status: 'blocked' } } };
  for (const id of ['alpha', 'beta']) {
    const root = path.join(dir, 'projetos', id); fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify(state));
  }
  const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
  const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [new URL('../src/dashboard.mjs', import.meta.url).pathname], {
    env: { ...process.env, LAB_ORCHESTRATOR_CONFIG: file, LAB_PAINEL_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => { const ended = once(child, 'exit'); child.kill(); await ended; fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('painel em')) resolve(); });
    child.once('exit', () => reject(new Error('painel encerrou antes de escutar')));
  });
  const url = `http://127.0.0.1:${port}`;
  const post = (body, extra = {}) => fetch(`${url}/api/tentar-novamente`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Painel': '1', Origin: url, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post({ project: 'alpha', issue: 16 }, { Origin: 'http://outro.local' })).status, 403);
  assert.equal((await post({ project: '../alpha', issue: 16 })).status, 400);
  assert.equal((await post({ project: 'alpha', issue: '16' })).status, 400);
  for (const issue of [17, 18, 99]) assert.equal((await post({ project: 'alpha', issue })).status, 409);
  assert.equal((await post({ project: 'beta', issue: 16 })).status, 409);
  for (let i = 0; i < 2; i++) assert.equal((await post({ project: 'alpha', issue: 16 })).status, 202);
  const queue = new RetryQueue(path.join(dir, 'projetos', 'alpha', 'tentativas'));
  assert.equal(queue.list().length, 1);
  assert.equal(queue.list()[0].issue, 16);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'projetos', 'alpha', 'state.json'))), state);
});
