import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, LAB_ROOT, timeZone } from '../src/config.mjs';
import { detectQuota } from '../src/quota.mjs';

const example = new URL('../config.example.json', import.meta.url);

test('modelo versionado: desligado, sem projeto fixo e com caminhos dentro do laboratório', () => {
  const config = loadConfig(example);
  assert.equal(config.enabled, false);
  assert.equal(config.rooms.labRoot, LAB_ROOT);
  assert.equal(config.rooms.controlRoot, path.join(LAB_ROOT, 'workspaces'));
  assert.equal(config.github.controllerTokenFile, path.join(LAB_ROOT, 'secrets', 'github-controller.env'));
  assert.equal(config.git.mirrorDir, path.join(LAB_ROOT, 'orchestrator', 'state', 'git', 'repo.git'));
  assert.equal(config.projectsFile, path.join(LAB_ROOT, 'orchestrator', 'state', 'projetos.json'));
  assert.equal(config.logFile, path.join(LAB_ROOT, 'logs', 'orchestrator.jsonl'));
  assert.deepEqual(config.rooms.deniedDomains, []);
  assert.equal(config.verify, undefined);
});

test('caminhos relativos partem de rooms.labRoot; absolutos ficam como estão', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const raw = JSON.parse(fs.readFileSync(example, 'utf8'));
  raw.rooms.labRoot = dir;
  raw.logFile = '/var/log/lab.jsonl';
  raw.timeZone = 'Fuso/Inexistente';
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  const config = loadConfig(file);
  assert.equal(config.rooms.controlRoot, path.join(dir, 'workspaces'));
  assert.equal(config.logFile, '/var/log/lab.jsonl');
  assert.equal(config.timeZone, 'UTC', 'fuso inválido cai para UTC em vez de quebrar');
  assert.equal(timeZone({ timeZone: 'Europe/Lisbon' }), 'Europe/Lisbon');
});

test('cota: horário sem data usa o fuso configurado, inclusive com horário de verão', () => {
  const now = Date.parse('2026-07-01T12:00:00Z');
  assert.equal(detectQuota('usage limit resets 3pm', now, { timeZone: 'Europe/Lisbon' }).until, '2026-07-01T14:00:00.000Z');
  assert.equal(detectQuota('usage limit resets 3pm', now, { timeZone: 'America/New_York' }).until, '2026-07-01T19:00:00.000Z');
  assert.equal(detectQuota('usage limit resets 2026-07-01T23:00:00', now, { timeZone: 'Asia/Tokyo' }).until, '2026-07-01T14:00:00.000Z');
  assert.equal(detectQuota('usage limit resets 3pm', now, { timeZone: 'UTC' }).until, '2026-07-01T15:00:00.000Z');
});
