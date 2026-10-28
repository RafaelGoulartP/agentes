import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanup } from '../src/cleanup.mjs';
import { HostGit } from '../src/host-git.mjs';

test('faxina: remove só execuções antigas sem uso e refs de issues concluídas antigas', (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'controle');
  const now = Date.parse('2026-10-16T12:00:00Z');
  const make = (issue, seq, old = true) => {
    const target = path.join(root, `codex-issue-${issue}`, `execucao-${seq}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'registro.txt'), 'registro de teste');
    const at = new Date(now - (old ? 10 : 1) * 86_400_000);
    fs.utimesSync(target, at, at);
    return target;
  };
  const removed = make(1, 1);
  const current = make(1, 2);
  const active = make(2, 1);
  const preserved = make(3, 1);
  const collected = make(4, 1);
  const resumed = make(5, 1);
  const fresh = make(6, 1, false);
  const unknown = make(7, 1);
  const outside = path.join(dir, 'fora');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'manter'), 'teste');
  fs.symlinkSync(outside, path.join(root, 'codex-issue-8'), 'junction');
  const deletedRefs = [];
  const state = { tasks: {
    1: { issueNumber: 1, agent: 'codex', runSeq: 2, status: 'done', doneAt: '2026-10-01T00:00:00Z' },
    2: { issueNumber: 2, status: 'verifying' },
    3: { issueNumber: 3, status: 'retry', preservedDir: path.join(preserved, 'coleta') },
    4: { issueNumber: 4, status: 'blocked', collectDir: path.join(collected, 'coleta') },
    5: { issueNumber: 5, status: 'retry', resumeFrom: { dir: path.join(resumed, 'agente') } },
    6: { issueNumber: 6, status: 'done', doneAt: '2026-10-15T00:00:00Z' }
  } };
  assert.deepEqual(cleanup({ rooms: { controlRoot: root }, cleanup: { days: 7 } }, state,
    { deleteRefs: (issue) => { deletedRefs.push(issue); return 3; } }, now), { directories: 2, refs: 3 });
  for (const target of [removed, unknown]) assert.equal(fs.existsSync(target), false);
  for (const target of [current, active, preserved, collected, resumed, fresh, outside]) assert.equal(fs.existsSync(target), true);
  assert.deepEqual(deletedRefs, [1]);
});

test('git: deleteRefs usa update-ref -d somente no namespace exato da issue', () => {
  const git = new HostGit({ git: { mirrorDir: 'espelho' }, github: {}, rooms: { labRoot: '.' } });
  const calls = [];
  git.git = (args) => {
    calls.push(args);
    return { stdout: 'refs/lab/issue-2/candidato\nrefs/lab/issue-2/falha-1\nrefs/lab/issue-20/candidato\nrefs/heads/main\n' };
  };
  assert.equal(git.deleteRefs(2), 2);
  assert.deepEqual(calls.slice(1), [
    ['update-ref', '-d', 'refs/lab/issue-2/candidato'], ['update-ref', '-d', 'refs/lab/issue-2/falha-1']
  ]);
  assert.throws(() => git.deleteRefs('../'), /issue inválida/);
});

test('git local: faxina exclui refs reais sem tocar em outras issues', (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-refs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const init = spawnSync('git', ['init', '--bare', dir], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const object = spawnSync('git', ['--git-dir', dir, 'hash-object', '-w', '--stdin'], { input: 'conteúdo de teste', encoding: 'utf8' });
  assert.equal(object.status, 0, object.stderr);
  const git = new HostGit({ git: { mirrorDir: dir }, github: {}, rooms: { labRoot: '.' } });
  for (const ref of ['refs/lab/issue-1/candidato', 'refs/lab/issue-10/candidato']) git.setRef(ref, object.stdout.trim());
  assert.equal(git.deleteRefs(1), 1);
  assert.equal(git.deleteRefs(1), 0, 'repetir é seguro');
  const remaining = git.git(['for-each-ref', '--format=%(refname)']).stdout.trim();
  assert.equal(remaining, 'refs/lab/issue-10/candidato');
});
