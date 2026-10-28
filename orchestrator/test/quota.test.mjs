import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { detectQuota } from '../src/quota.mjs';
import { logTail, verificationTail } from '../src/log-tail.mjs';
import { loadConfig } from '../src/config.mjs';

const now = Date.parse('2026-10-16T12:00:00Z');
const SP = { timeZone: "America/Sao_Paulo" };
test('cota: mensagens de ambas as CLIs e horário padrão', () => {
  for (const message of ['Claude usage limit reached.', "You’ve hit your usage limit.", "You've hit your session limit", 'error: usage_limit_reached']) {
    assert.equal(detectQuota(message, now).until, '2026-10-16T13:00:00.000Z', message);
  }
  // Texto comum de testes e do próprio projeto não é cota.
  for (const message of ['erro no npm test', 'rate limit do login excedido', 'limit reached: 5 tentativas', 'rate_limit_exceeded', 'O token resets 3am']) {
    assert.equal(detectQuota(message, now), null, message);
  }
  assert.equal(detectQuota('Claude usage limit reached\n' + 'x'.repeat(5000), now), null, 'só o final do log');
});

test('cota: epoch, ISO e relógio em São Paulo, com virada de dia e teto', () => {
  const cases = [
    [`Claude AI usage limit reached|${(now + 7200_000) / 1000}`, '2026-10-16T14:00:00.000Z'],
    ['usage_limit_reached resets 2026-10-16T15:00:00Z', '2026-10-16T15:00:00.000Z'],
    ['usage limit resets 2026-10-16T15:00:00', '2026-10-16T18:00:00.000Z'],
    ["You've hit your session limit · resets 3am", '2026-10-17T06:00:00.000Z'],
    ["You've hit your usage limit. Try again at 3:15 PM", '2026-10-16T18:15:00.000Z'],
    ['usage limit resets 12am', '2026-10-17T03:00:00.000Z'],
    ['usage limit resets 12pm', '2026-10-16T15:00:00.000Z'],
    ['usage limit resets 99:99', '2026-10-16T13:00:00.000Z'],
    ['usage limit resets 2030-01-01T00:00:00Z', '2026-10-23T12:00:00.000Z'],
    ['usage limit resets 2020-01-01T00:00:00Z', '2026-10-16T13:00:00.000Z']
  ];
  for (const [text, until] of cases) assert.equal(detectQuota(text, now, SP).until, until, text);
});

test('logs: lê somente o final e limita o trecho da verificação já sanitizado', (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-logs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'output.sanitized.log');
  fs.writeFileSync(file, 'usage limit\n' + 'x'.repeat(70_000));
  assert.equal(logTail(file).length, 64 * 1024);
  assert.equal(detectQuota(logTail(file), now), null);
  fs.appendFileSync(file, '\n' + 'linha\n'.repeat(2000) + 'erro final\n');
  assert.ok(verificationTail(file).length <= 6000);
  assert.match(verificationTail(file), /erro final/);
  assert.equal(logTail(path.join(dir, 'ausente')), '');
  fs.writeFileSync(file, '===== grupo 0 =====\nfalha de teste\n--- FALHOU (1s): npm test\n===== grupo 1 =====\n' + 'ok\n'.repeat(100));
  assert.match(verificationTail(file), /falha de teste/);
  assert.doesNotMatch(verificationTail(file), /grupo 1/);
});

test('padrões versionados: cota, disco, faxina e avisos desligados sem URL', () => {
  const config = loadConfig(new URL("../config.example.json", import.meta.url));
  assert.deepEqual(config.quota, { defaultMinutes: 60, maxDays: 7 });
  assert.equal(config.health.minFreeGb, 15);
  assert.equal(config.cleanup.days, 7);
  assert.equal(config.notify.enabled, false);
  assert.equal(config.notify.url, undefined);
});
