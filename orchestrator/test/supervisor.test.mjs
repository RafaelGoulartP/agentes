import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomRunner } from '../src/room-runner.mjs';

// Executa o supervisor real (scripts/run-supervised.sh) com processos falsos, sem Docker e sem agentes.
const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-supervisor-'));
  const runner = new RoomRunner({ rooms: { labRoot, controlRoot: root } }, () => {});
  const dir = path.join(root, 'run');
  fs.mkdirSync(dir);
  const stdin = path.join(dir, 'stdin.txt');
  fs.writeFileSync(stdin, 'prompt de teste\n');
  return { runner, dir, stdin, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function until(check, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('tempo esgotado');
}

const finished = (runner, run) => until(() => {
  const result = runner.inspectRun(run);
  return result.status === 'running' ? null : result;
});

test('sucesso: grava saída, recebe stdin e código 0', async () => {
  const { runner, dir, stdin, cleanup } = setup();
  const run = runner.supervise(dir, stdin, ['bash', '-c', 'read -r line; echo "recebido: $line"; exit 0']);
  assert.deepEqual(await finished(runner, run), { status: 'completed', exitCode: 0 });
  assert.equal(fs.readFileSync(path.join(dir, 'exit-code'), 'utf8'), '0\n', 'quebra de linha real, sem barra literal');
  assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /recebido: prompt de teste/);
  cleanup();
});

test('erro: preserva o código de saída do comando', async () => {
  const { runner, dir, stdin, cleanup } = setup();
  const run = runner.supervise(dir, stdin, ['bash', '-c', 'echo falhou >&2; exit 3']);
  assert.deepEqual(await finished(runner, run), { status: 'completed', exitCode: 3 });
  cleanup();
});

test('sinal: stopRun encerra o grupo e registra 143', async () => {
  const { runner, dir, stdin, cleanup } = setup();
  const run = runner.supervise(dir, stdin, ['sleep', '30']);
  assert.equal(runner.inspectRun(run).status, 'running');
  await new Promise((resolve) => setTimeout(resolve, 300));
  runner.stopRun(run);
  assert.deepEqual(await finished(runner, run), { status: 'completed', exitCode: 143 });
  cleanup();
});

test('queda do supervisor sem exit-code é detectada como perdida', async () => {
  const { runner, dir, stdin, cleanup } = setup();
  const run = runner.supervise(dir, stdin, ['sleep', '2']);
  process.kill(run.pid, 'SIGKILL');
  const result = await finished(runner, run);
  assert.equal(result.status, 'lost');
  assert.equal(fs.existsSync(path.join(dir, 'exit-code')), false);
  cleanup();
});

test('PID reutilizado não é confundido com o supervisor original', () => {
  const { runner, dir, cleanup } = setup();
  const result = runner.inspectRun({ pid: process.pid, start: '1', dir, startedAt: new Date().toISOString() });
  assert.equal(result.status, 'lost');
  cleanup();
});

test('exit-code adulterado é rejeitado', () => {
  const { runner, dir, cleanup } = setup();
  fs.writeFileSync(path.join(dir, 'exit-code'), '0\\n');
  assert.equal(runner.inspectRun({ pid: 1, start: 'x', dir }).status, 'lost');
  cleanup();
});

test('log sanitizado mantém o final e remove segredos e a saída bruta', async () => {
  const { runner, dir, stdin, cleanup } = setup();
  const run = runner.supervise(dir, stdin, ['bash', '-c', 'echo "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"; echo fim']);
  await finished(runner, run);
  const file = runner.sanitizeLog(run);
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /ghp_/);
  assert.match(text, /fim/);
  assert.equal(fs.existsSync(path.join(dir, 'output.log')), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  cleanup();
});
