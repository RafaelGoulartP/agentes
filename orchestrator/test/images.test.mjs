import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HostGit } from '../src/host-git.mjs';
import { ImageKeeper } from '../src/images.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { exampleSettings } from './fixtures/projeto-exemplo.mjs';

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
}).trim();

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-images-'));
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', remote);
  const seed = path.join(root, 'seed');
  git(root, 'clone', '--quiet', remote, seed);
  fs.mkdirSync(path.join(seed, 'backend'));
  const commit = (front, back, message) => {
    fs.writeFileSync(path.join(seed, 'package-lock.json'), front);
    fs.writeFileSync(path.join(seed, 'backend/package-lock.json'), back);
    fs.writeFileSync(path.join(seed, 'src.txt'), message);
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', message);
    // Atualiza o bare só por caminho local, sem executar push.
    git(root, '--git-dir', remote, 'fetch', '--quiet', seed, 'HEAD:refs/heads/main');
  };
  commit('{"v":1}', '{"b":1}', 'inicial');
  const config = { git: { mirrorDir: path.join(root, 'mirror.git'), remoteUrl: remote }, github: { owner: 'o', repo: 'r' }, rooms: { labRoot: root },
    projectSettings: { ...exampleSettings(), imagensDeTeste: [] } };
  const host = new HostGit(config);
  // Docker falso: guarda o rótulo de cada imagem; o "build" grava o hash calculado do commit pedido.
  const labels = new Map();
  const builds = [];
  let clock = 0;
  const keeper = new ImageKeeper(config, host, () => {}, {
    now: () => clock,
    exec: (command, args, options = {}) => {
      if (command === 'docker') return labels.has(args.at(-1)) ? { status: 0, stdout: `${labels.get(args.at(-1))}\n` } : { status: 1, stdout: '' };
      builds.push(options.env.LAB_SOURCE_COMMIT);
      const hash = keeper.lockHash(options.env.LAB_SOURCE_COMMIT);
      for (const image of keeper.images) labels.set(image, hash);
      return { status: 0, stdout: '' };
    }
  });
  return { root, commit, keeper, builds, labels, advance: (ms) => { clock += ms; }, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('reconstrói só quando o lockfile da base muda', async () => {
  const { commit, keeper, builds, advance, cleanup } = setup();
  assert.equal((await keeper.ensure('main')).rebuilt, true, 'imagem sem rótulo é reconstruída');
  advance(11 * 60_000);
  commit('{"v":1}', '{"b":1}', 'só código');
  assert.equal((await keeper.ensure('main')).rebuilt, false, 'mudança de código não reconstrói');
  advance(11 * 60_000);
  commit('{"v":2}', '{"b":1}', 'nova dependência');
  assert.equal((await keeper.ensure('main')).rebuilt, true);
  advance(11 * 60_000);
  commit('{"v":2}', '{"b":2}', 'dependência do backend');
  assert.equal((await keeper.ensure('main')).rebuilt, true);
  assert.equal(builds.length, 3);
  cleanup();
});

test('respeita o intervalo entre checagens', async () => {
  const { commit, keeper, builds, advance, cleanup } = setup();
  await keeper.ensure('main');
  commit('{"v":3}', '{"b":1}', 'muda lock');
  assert.equal((await keeper.ensure('main')).checked, false);
  advance(11 * 60_000);
  assert.equal((await keeper.ensure('main')).rebuilt, true);
  assert.equal(builds.length, 2);
  cleanup();
});

test('falha de build impede tarefas novas nesse tick', async () => {
  const issue = { number: 1, title: 'T', body: '', state: 'open', labels: [{ name: 'codex' }] };
  const launched = [];
  const orchestrator = new Orchestrator({
    config: {
      labels: { agents: ['codex', 'claude'], inProgress: 'em-andamento', blocked: 'bloqueado', readyForReview: 'pronto-para-revisao', areaPrefix: 'area:' },
      scheduler: { maxConcurrency: 1, defaultArea: 'geral' }, retry: { baseSeconds: 1, maxSeconds: 1, maxAttempts: 1 }, rooms: { branchPrefix: 'agente' }
    },
    github: { listOpenIssues: async () => [issue], listOpenPulls: async () => [], repository: async () => ({ default_branch: 'main' }) },
    runner: { launchAgent: (task) => launched.push(task) },
    git: {},
    images: { ensure() { throw new Error('build quebrou'); } },
    store: { load: () => ({ version: 1, tasks: {} }), save() {} },
    log() {}
  });
  await orchestrator.tick();
  assert.equal(launched.length, 0);
  assert.deepEqual(orchestrator.state.tasks, {});
});

test('reconstrução em segundo plano: o ciclo termina, salas novas esperam e depois seguem', async () => {
  const issue = { number: 1, title: 'T', body: '', state: 'open', labels: [{ name: 'codex' }, { name: 'area:a' }] };
  const events = [];
  let finish, calls = 0;
  const orchestrator = new Orchestrator({
    config: {
      labels: { agents: ['codex', 'claude'], inProgress: 'em-andamento', blocked: 'bloqueado', readyForReview: 'pronto-para-revisao', areaPrefix: 'area:' },
      scheduler: { maxConcurrency: 1, defaultArea: 'geral' }, retry: { baseSeconds: 1, maxSeconds: 1, maxAttempts: 1 }, rooms: { branchPrefix: 'agente' }
    },
    github: { listOpenIssues: async () => [issue], listOpenPulls: async () => [], repository: async () => ({ default_branch: 'main' }) },
    runner: {}, git: {},
    images: { ensure() { calls++; return new Promise((resolve) => { finish = resolve; }); } },
    store: { load: () => ({ version: 1, tasks: {} }), save() {} },
    log: (event) => events.push(event)
  });
  orchestrator.imageWaitMs = 5;
  const started = [];
  orchestrator.start = async (item) => { started.push(item.issue.number); };
  await orchestrator.tick();
  await orchestrator.tick();
  assert.deepEqual(started, []);
  assert.equal(calls, 1, 'não começa outra reconstrução enquanto a primeira roda');
  assert.equal(events.filter((e) => e === 'tick_complete').length, 2);
  assert.match(orchestrator.state.pause.reasons.join(), /imagens/);
  finish({ checked: true, rebuilt: true });
  await orchestrator.tick();
  assert.deepEqual(started, [1]);
  assert.equal(orchestrator.state.pause, null);
});
