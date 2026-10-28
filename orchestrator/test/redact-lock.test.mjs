import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../src/lock.mjs';
import { createLogger } from '../src/logger.mjs';
import { redact, redactDeep, registerSecret } from '../src/redact.mjs';

// Valores sintéticos montados em tempo de execução, apenas com o formato dos tokens reais.
const fake = (prefix, size = 36) => prefix + 'x9'.repeat(size).slice(0, size);

test('remove formatos conhecidos de credencial', () => {
  const samples = [
    fake('ghp_'), fake('gho_'), fake('ghs_'), fake('github_pat_', 60), fake('sk-ant-api03-', 40), fake('sk-proj-', 40),
    `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`
  ];
  for (const sample of samples) assert.doesNotMatch(redact(`valor ${sample} fim`), new RegExp(sample.slice(0, 12)), sample.slice(0, 8));
  assert.equal(redact('Authorization: Bearer abcdefgh12345678').includes('abcdefgh'), false);
  assert.equal(redact('https://usuario:senha123@github.com/x').includes('senha123'), false);
  assert.equal(redact('{"refresh_token":"r-123456789"}').includes('r-123456789'), false);
  assert.equal(redact('GH_TOKEN=valor-sem-prefixo-123').includes('valor-sem-prefixo'), false);
  assert.equal(redact('npm run lint passou'), 'npm run lint passou');
});

test('remove literalmente segredos registrados e preserva JSON válido', () => {
  registerSecret('segredo-local-sem-formato-123');
  const value = redactDeep({ message: 'falhou com segredo-local-sem-formato-123', nested: ['password="a\\"b"'] });
  assert.doesNotMatch(JSON.stringify(value), /segredo-local/);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(value)));
});

test('logger sanitiza e rotaciona', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-log-'));
  const file = path.join(dir, 'log.jsonl');
  const log = createLogger(file, { maxBytes: 300, keep: 2, stdout: false });
  for (let i = 0; i < 20; i += 1) log('evento', { message: `linha ${i} ${fake('ghp_')}` });
  const all = fs.readdirSync(dir).sort();
  assert.deepEqual(all, ['log.jsonl', 'log.jsonl.1', 'log.jsonl.2']);
  for (const name of all) assert.doesNotMatch(fs.readFileSync(path.join(dir, name), 'utf8'), /ghp_/);
  fs.rmSync(dir, { recursive: true });
});

test('trava impede segundo controlador e substitui trava órfã', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-lock-'));
  const file = path.join(dir, 'orchestrator.lock');
  const release = acquireLock(file);
  assert.throws(() => acquireLock(file), /outro controlador ativo/);
  release();
  fs.writeFileSync(file, JSON.stringify({ pid: 999_999_999, start: '1' }));
  const again = acquireLock(file);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
  again();
  assert.equal(fs.existsSync(file), false);
  fs.rmSync(dir, { recursive: true });
});
