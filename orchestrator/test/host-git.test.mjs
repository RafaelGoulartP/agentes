import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HostGit } from '../src/host-git.mjs';

// Git real com um "GitHub" local (repositório bare). Simula a sala com um clone feito a partir do bundle.
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
}).trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-hostgit-'));
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', remote);
  const seed = path.join(root, 'seed');
  git(root, 'clone', '--quiet', remote, seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'base\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '--quiet', '-m', 'base');
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  const host = new HostGit({
    git: { mirrorDir: path.join(root, 'mirror.git'), remoteUrl: remote },
    github: { owner: 'o', repo: 'r' },
    rooms: { labRoot: root }
  });
  return { root, remote, seed, host, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// Sala simulada: recebe o bundle de entrada, cria a branch e devolve um bundle incremental.
function room(root, input, start, branch, change) {
  const dir = path.join(root, `sala-${Math.random().toString(36).slice(2)}`);
  git(root, 'init', '--quiet', dir);
  git(dir, 'fetch', '--quiet', input, '+refs/remotes/origin/*:refs/remotes/origin/*', '+refs/lab/*:refs/lab/*');
  git(dir, 'checkout', '--quiet', '-B', branch, start);
  change(dir);
  const out = path.join(dir, 'out.bundle');
  git(dir, 'bundle', 'create', '--quiet', out, `refs/heads/${branch}`, '--not', start);
  return { dir, out, head: git(dir, 'rev-parse', 'HEAD') };
}

const commitFile = (name, content) => (dir) => {
  fs.writeFileSync(path.join(dir, name), content);
  git(dir, 'add', '.');
  git(dir, 'commit', '--quiet', '-m', `altera ${name}`);
};

test('ciclo completo: base -> sala -> bundle -> verificação -> push sem force', () => {
  const { root, remote, host, cleanup } = setup();
  const task = { issueNumber: 1, branch: 'agente/codex/issue-1', baseBranch: 'main', revision: false };
  const input = path.join(root, 'in.bundle');
  const { baseSha, startSha } = host.prepareInput(task, input);
  assert.equal(baseSha, startSha);
  const sala = room(root, input, startSha, task.branch, commitFile('b.txt', 'novo\n'));
  const sha = host.importBundle(sala.out, task.branch, 'refs/lab/issue-1/candidato');
  assert.equal(sha, sala.head);
  assert.equal(host.isAncestor(startSha, sha), true);
  assert.deepEqual(host.changedFiles(startSha, sha), ['b.txt']);
  assert.match(host.commitSubjects(startSha, sha)[0], /altera b\.txt/);
  host.bundleRef(path.join(root, 'verify.bundle'), 'refs/lab/issue-1/candidato');
  host.push(sha, task.branch);
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', `refs/heads/${task.branch}`), sha);
  assert.equal(host.remoteSha(task.branch), sha);
  cleanup();
});

test('branch remota já existente bloqueia tarefa nova antes de criar sala', () => {
  const { root, seed, host, cleanup } = setup();
  git(seed, 'push', '--quiet', 'origin', 'HEAD:refs/heads/agente/codex/issue-2');
  const task = { issueNumber: 2, branch: 'agente/codex/issue-2', baseBranch: 'main', revision: false };
  assert.throws(() => host.prepareInput(task, path.join(root, 'in.bundle')), (error) => error.category === 'branch_exists' && error.permanent);
  cleanup();
});

test('revisão parte do PR, recebe a base nova e o push é fast-forward', () => {
  const { root, seed, remote, host, cleanup } = setup();
  const branch = 'agente/claude/issue-3';
  git(seed, 'checkout', '--quiet', '-b', 'pr');
  commitFile('pr.txt', 'pr\n')(seed);
  git(seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`);
  git(seed, 'checkout', '--quiet', 'main');
  commitFile('base.txt', 'base nova\n')(seed);
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main');

  const task = { issueNumber: 3, branch, baseBranch: 'main', revision: true };
  const input = path.join(root, 'in.bundle');
  const { baseSha, startSha } = host.prepareInput(task, input);
  assert.notEqual(baseSha, startSha);
  const sala = room(root, input, startSha, branch, (dir) => git(dir, 'merge', '--quiet', '--no-edit', 'origin/main'));
  const sha = host.importBundle(sala.out, branch, 'refs/lab/issue-3/candidato');
  assert.equal(host.isAncestor(startSha, sha), true);
  assert.equal(host.isAncestor(baseSha, sha), true);
  host.push(sha, branch);
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', `refs/heads/${branch}`), sha);
  cleanup();
});

test('push divergente é recusado como conflito permanente', () => {
  const { root, seed, host, cleanup } = setup();
  const task = { issueNumber: 4, branch: 'agente/codex/issue-4', baseBranch: 'main', revision: false };
  const input = path.join(root, 'in.bundle');
  const { startSha } = host.prepareInput(task, input);
  const sala = room(root, input, startSha, task.branch, commitFile('x.txt', 'x\n'));
  const sha = host.importBundle(sala.out, task.branch, 'refs/lab/issue-4/candidato');
  commitFile('outro.txt', 'humano\n')(seed);
  git(seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${task.branch}`);
  assert.throws(() => host.push(sha, task.branch), (error) => error.category === 'delivery_conflict' && error.permanent);
  cleanup();
});

test('nomes de branch inválidos são recusados', () => {
  const { host, cleanup } = setup();
  for (const name of ['a..b', '-x', 'a b', 'x.lock', 'a/', 'a;rm -rf']) {
    assert.throws(() => host.validateBranch(name), (error) => error.category === 'invalid_branch', name);
  }
  host.validateBranch('agente/codex/issue-10');
  cleanup();
});

// O agente trabalha a partir da base; enquanto isso a main recebe outro commit.
function agentWhileMainMoves(mainChange, agentChange) {
  const ctx = setup();
  const { root, seed, host } = ctx;
  const task = { issueNumber: 7, branch: 'agente/codex/issue-7', baseBranch: 'main', revision: false };
  const input = path.join(root, 'in.bundle');
  const { startSha } = host.prepareInput(task, input);
  const sala = room(root, input, startSha, task.branch, agentChange);
  const candidate = host.importBundle(sala.out, task.branch, 'refs/lab/issue-7/candidato');
  mainChange(seed);
  git(seed, 'push', '--quiet', 'origin', 'HEAD:main');
  const baseSha = host.fetchBranch('main');
  return { ...ctx, task, candidate, baseSha };
}

test('merge com a main sem conflito: commit de merge com os dois pais, entregue por push sem force', () => {
  const ctx = agentWhileMainMoves(commitFile('main.txt', 'main nova\n'), commitFile('agente.txt', 'agente\n'));
  const { root, remote, host, task, candidate, baseSha, cleanup } = ctx;
  assert.equal(host.isAncestor(baseSha, candidate), false);
  const merge = host.mergeBase(candidate, baseSha, 'Incorpora main antes da verificação');
  assert.equal(merge.conflicts, undefined);
  assert.equal(git(root, '--git-dir', host.dir, 'rev-parse', `${merge.sha}^1`), candidate, 'primeiro pai = trabalho do agente');
  assert.equal(git(root, '--git-dir', host.dir, 'rev-parse', `${merge.sha}^2`), baseSha);
  assert.equal(git(root, '--git-dir', host.dir, 'show', `${merge.sha}:main.txt`), 'main nova');
  assert.equal(git(root, '--git-dir', host.dir, 'show', `${merge.sha}:agente.txt`), 'agente');
  assert.match(git(root, '--git-dir', host.dir, 'log', '-1', '--format=%an', merge.sha), /Laboratório de agentes/);
  host.setRef('refs/lab/issue-7/candidato', merge.sha);
  assert.equal(host.revParse('refs/lab/issue-7/candidato'), merge.sha);
  host.push(merge.sha, task.branch);
  assert.equal(git(root, '--git-dir', remote, 'rev-parse', `refs/heads/${task.branch}`), merge.sha);
  cleanup();
});

test('conflito com a main: nada é gravado e voltam os arquivos; a retomada parte do trabalho guardado', () => {
  const ctx = agentWhileMainMoves(commitFile('a.txt', 'main mudou\n'), commitFile('a.txt', 'agente mudou\n'));
  const { root, host, task, candidate, baseSha, cleanup } = ctx;
  const before = git(root, '--git-dir', host.dir, 'for-each-ref', '--format=%(refname) %(objectname)');
  const merge = host.mergeBase(candidate, baseSha, 'Incorpora main');
  assert.deepEqual(merge, { conflicts: ['a.txt'] });
  assert.equal(git(root, '--git-dir', host.dir, 'for-each-ref', '--format=%(refname) %(objectname)'), before, 'nenhuma ref alterada');

  host.setRef('refs/lab/issue-7/conflito-1', candidate);
  const resumeTask = { ...task, resumeFrom: { ref: 'refs/lab/issue-7/conflito-1', sha: candidate, files: ['a.txt'] } };
  const input = path.join(root, 'retomada.bundle');
  const prepared = host.prepareInput(resumeTask, input);
  assert.equal(prepared.resumed, true);
  assert.equal(prepared.startSha, candidate);
  assert.equal(prepared.baseSha, baseSha);
  // Na sala, o agente encontra o próprio trabalho e a main nova, e resolve com git merge.
  const sala = room(root, input, prepared.startSha, task.branch, (dir) => {
    assert.equal(git(dir, 'rev-parse', 'HEAD'), candidate);
    try { git(dir, 'merge', '--quiet', '--no-edit', 'origin/main'); } catch { /* conflito esperado */ }
    fs.writeFileSync(path.join(dir, 'a.txt'), 'agente mudou\nmain mudou\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '--quiet', '--no-edit');
  });
  const resolved = host.importBundle(sala.out, task.branch, 'refs/lab/issue-7/candidato');
  assert.equal(host.isAncestor(candidate, resolved), true);
  assert.equal(host.isAncestor(baseSha, resolved), true, 'base incorporada: o controlador não precisa de outro merge');
  cleanup();
});

test('retomada com ref divergente do sha guardado é ignorada', () => {
  const { root, host, cleanup } = setup();
  const task = { issueNumber: 8, branch: 'agente/codex/issue-8', baseBranch: 'main', revision: false,
    resumeFrom: { ref: 'refs/lab/issue-8/conflito-1', sha: 'f'.repeat(40) } };
  const prepared = host.prepareInput(task, path.join(root, 'in.bundle'));
  assert.equal(prepared.resumed, false);
  assert.equal(prepared.startSha, prepared.baseSha);
  cleanup();
});
