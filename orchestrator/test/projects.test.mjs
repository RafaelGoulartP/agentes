import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { deniedDomains, validateProjectConfig, loadProjectSettings, projectConfig, readProjects, bootstrapConfig } from '../src/projects.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { RoomRunner, buildPrompt } from '../src/room-runner.mjs';
import { verifyGroups } from '../src/config.mjs';
import { ImageKeeper } from '../src/images.mjs';
import { prepareBuild } from '../../scripts/prepare-build.mjs';
import { notificationFor } from '../src/push.mjs';
import { base, exampleSettings, exampleProject } from './fixtures/projeto-exemplo.mjs';

const settings = () => exampleSettings();
const compatibilityProject = exampleProject;
const lab = fileURLToPath(new URL('../../', import.meta.url));
function temporary(t) {
  const parent = path.join(lab, '.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'projects-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  return dir;
}
function localConfig(root) {
  const config = structuredClone(base);
  config.stateFile = path.join(root, 'state', 'state.json');
  config.projectsFile = path.join(root, 'state', 'projetos.json');
  config.lockFile = path.join(root, 'state', 'lock');
  config.git.mirrorDir = path.join(root, 'state', 'git', 'repo.git');
  config.rooms = { ...config.rooms, labRoot: root, controlRoot: path.join(root, 'workspaces') };
  return config;
}

test('prompt inteiro do projeto de exemplo, com grupos de verificação da configuração', () => {
  const config = { ...base, projectSettings: settings() };
  const task = { agent: 'codex', issueNumber: 5, title: 'Exemplo', body: 'Descrição', branch: 'agente/codex/issue-5', baseBranch: 'main' };
  assert.equal(buildPrompt(task, config), fs.readFileSync(new URL('./fixtures/prompt-exemplo.txt', import.meta.url), 'utf8'));
  assert.deepEqual(config.projectSettings.verificar, verifyGroups(base));
  const plain = buildPrompt(task, { ...base, projectSettings: { ...settings(), instalar: ['npm ci'] } });
  assert.doesNotMatch(plain, /Playwright/, 'só menciona os navegadores quando a instalação os inclui');
});

test('esquema recusa caminhos, domínios, comandos, grupos e portas inválidos', () => {
  assert.deepEqual(validateProjectConfig(settings()), settings());
  const invalid = [
    ['dependencias', ['../segredo']], ['dependencias', ['C:/arquivo']], ['leia', ['/etc/passwd']],
    ['instalar', ['npm ci\necho surpresa']], ['verificar', [[]]], ['verificar', ['npm test']],
    ['dominiosExtras', ['dominio\nhttp_access allow all']], ['imagensDeTeste', ['--privileged']],
    ['previa', { ...settings().previa, porta: 70000 }], ['previa', { ...settings().previa, passos: [{ rodar: 'npm start', esperar: 'http://producao.local/' }] }],
    ['proibido', { ...settings().proibido, portas: ['3333'] }]
  ];
  for (const [key, value] of invalid) assert.throws(() => validateProjectConfig({ ...settings(), [key]: value }), /\.laboratorio.json:/);
});

test('registro começa vazio uma vez e valida ids duplicados e inválidos', (t) => {
  const config = localConfig(temporary(t));
  assert.deepEqual(readProjects(config, { create: true }), []);
  assert.ok(fs.existsSync(config.projectsFile));
  const first = [exampleProject(base)];
  fs.writeFileSync(config.projectsFile, JSON.stringify(first));
  assert.deepEqual(first, readProjects(config, { create: true }));
  for (const projects of [[{ ...first[0], id: '../x' }], [first[0], first[0]]]) {
    fs.writeFileSync(config.projectsFile, JSON.stringify(projects));
    assert.throws(() => readProjects(config), /id de projeto/);
  }
});

function fakeGit(main = settings()) {
  const calls = [];
  return { calls, ensure() {}, fetchBranch(branch) { calls.push(['fetch', branch]); return 'a'.repeat(40); },
    git(args) {
      calls.push(args);
      if (args[0] === 'ls-tree') return { stdout: main === null ? '' : '.laboratorio.json\n' };
      if (args[0] === 'show') return { stdout: typeof main === 'string' ? main : JSON.stringify(main) };
      throw new Error(`operação inesperada: ${args[0]}`);
    }
  };
}

test('configuração vem do SHA da main; candidato nunca fornece instalar/verificar', (t) => {
  const config = projectConfig(localConfig(temporary(t)), compatibilityProject(base));
  const main = { ...settings(), verificar: [['testes obrigatórios']], instalar: ['instalação da main'] };
  const git = fakeGit(main);
  loadProjectSettings(config, git, 'main');
  assert.deepEqual(verifyGroups(config), [['testes obrigatórios']]);
  assert.deepEqual(config.projectSettings.instalar, ['instalação da main']);
  assert.deepEqual(git.calls.find((a) => a[0] === 'show'), ['show', `${'a'.repeat(40)}:.laboratorio.json`]);
  loadProjectSettings(config, fakeGit(null), 'main');
  assert.deepEqual(config.projectSettings, settings());
  assert.throws(() => loadProjectSettings(config, fakeGit('{inválido'), 'main'), /JSON|property/i);
  delete config.projectRecord.config;
  loadProjectSettings(config, fakeGit(null), 'main');
  assert.equal(config.configurationSource, 'partida');
  assert.equal(config.projectSettings.previa, undefined);
});

test('workspaces do npm entram nas dependências mesmo sem estar no .laboratorio.json', (t) => {
  const config = projectConfig(localConfig(temporary(t)), compatibilityProject(base));
  const tree = ['.laboratorio.json', 'package.json', 'package-lock.json', 'frontend/package.json', 'backend/package.json',
    'packages/a/package.json', 'packages/a/node_modules/x/package.json', 'docs/package.json'];
  const files = {
    '.laboratorio.json': JSON.stringify({ ...settings(), dependencias: ['package.json', 'package-lock.json', 'frontend/package.json'] }),
    'package.json': JSON.stringify({ workspaces: ['frontend', './backend/', 'packages/*', '!docs'] })
  };
  const git = { ensure() {}, fetchBranch() { return 'a'.repeat(40); },
    git(args) {
      if (args[0] === 'ls-tree') return { stdout: args.includes('-r') ? tree.join('\n') : '.laboratorio.json\n' };
      return { stdout: files[args[1].split(':')[1]] };
    } };
  loadProjectSettings(config, git, 'main');
  assert.deepEqual(config.projectSettings.dependencias,
    ['package.json', 'package-lock.json', 'frontend/package.json', 'backend/package.json', 'packages/a/package.json']);
  files['package.json'] = JSON.stringify({ name: 'sem-workspaces' });
  loadProjectSettings(config, git, 'main');
  assert.deepEqual(config.projectSettings.dependencias, ['package.json', 'package-lock.json', 'frontend/package.json']);
});

test('sala de verificação recebe comandos da main por argumentos, mesmo com configuração enfraquecida no candidato', (t) => {
  const config = projectConfig(localConfig(temporary(t)), compatibilityProject(base));
  const git = fakeGit({ ...settings(), verificar: [['npm run obrigatório']], instalar: ['npm ci obrigatório'] });
  const read = git.git;
  git.git = (args) => args[0] === 'show' && args[1].startsWith('b'.repeat(40))
    ? { stdout: JSON.stringify({ ...settings(), verificar: [['true']], instalar: ['true'] }) } : read(args);
  loadProjectSettings(config, git, 'main');
  const runner = new RoomRunner(config, () => {});
  runner.createRoom = () => 'sala-falsa'; runner.copyIn = () => {};
  let argv;
  runner.supervise = (_dir, _input, args) => { argv = args; return {}; };
  runner.launchVerify({ agent: 'codex', issueNumber: 5, runSeq: 1, candidateSha: 'b'.repeat(40) }, 'input.bundle');
  assert.deepEqual(JSON.parse(argv.at(-2)).instalar, ['npm ci obrigatório']);
  assert.equal(argv.at(-1), 'npm run obrigatório');
  assert.equal(argv.at(-3), 'b'.repeat(40));
});

function instance(id) {
  const config = structuredClone(base);
  config.project = id; config.projectRecord = { config: settings() };
  const git = { ...fakeGit(), prepareInput: () => ({ baseSha: 'a'.repeat(40), startSha: 'a'.repeat(40) }) };
  const launched = [];
  const runner = { agentBundlePath: () => 'fake.bundle', launchAgent: (t) => { launched.push(t.issueNumber); return { startedAt: new Date().toISOString() }; }, inspectRun: () => ({ status: 'running' }) };
  const github = {
    listOpenIssues: async () => [5, 6, 7].map((n) => ({ number: n, title: `T${n}`, state: 'open', labels: ['codex', `area:${n}`] })),
    listOpenPulls: async () => [], repository: async () => ({ default_branch: 'main' }),
    addLabel: async () => {}, removeLabel: async () => {}, comment: async () => {}
  };
  const store = { load: () => ({ version: 1, tasks: {}, lastCleanupAt: new Date().toISOString() }), save() {} };
  const o = new Orchestrator({ config, git, runner, github, store, log() {} });
  return { o, launched };
}

test('vagas globais: dois projetos nunca abrem uma terceira sala; ordem reveza', async () => {
  const a = instance('alpha'), b = instance('beta');
  const c = new Coordinator(2); c.attach(a.o); c.attach(b.o);
  await c.cycle(true);
  assert.equal(c.active(), 2); assert.equal(a.launched.length, 2); assert.equal(b.launched.length, 0);
  for (const task of Object.values(a.o.state.tasks)) task.status = 'done';
  await c.cycle(true);
  assert.equal(c.active(), 2); assert.equal(b.launched.length, 2);
  await c.cycle(true); assert.equal(c.active(), 2);
});

test('cota e disjuntor são compartilhados; áreas iguais de projetos diferentes são independentes', async () => {
  const a = instance('alpha'), b = instance('beta');
  const c = new Coordinator(2); c.attach(a.o); c.attach(b.o);
  a.o.state.quota.codex = { until: new Date(Date.now() + 3600000).toISOString() };
  await c.cycle(true); assert.equal(c.active(), 0);
  assert.equal(a.o.state.quota, b.o.state.quota);
  delete a.o.state.quota.codex;
  a.o.state.breaker.openUntil = new Date(Date.now() + 3600000).toISOString();
  await c.cycle(true); assert.equal(c.active(), 0);
  a.o.state.breaker.openUntil = null;
  a.o.state.tasks[5] = { issueNumber: 5, status: 'running', areas: ['5'] };
  assert.equal(b.o.hasRoomFor({ areas: ['5'] }), true);
});

test('falha de um projeto não impede ciclo dos demais', async () => {
  const a = instance('alpha'), b = instance('beta');
  a.o.github.repository = async () => { throw new Error('falha isolada'); };
  const c = new Coordinator(2); c.attach(a.o); c.attach(b.o);
  const errors = []; await c.cycle(true, (o, e) => errors.push([o.config.project, e.message]));
  assert.deepEqual(errors, [['alpha', 'falha isolada']]); assert.equal(b.launched.length, 2);
});

test('configuração inválida bloqueia salas e deixa aviso na fila', async () => {
  const { o, launched } = instance('alpha'); o.git = fakeGit('{}');
  await o.tick(); await o.tickLocal();
  assert.equal(launched.length, 0); assert.match(o.state.configurationError, /precisa de configuração/);
  assert.ok(o.state.queue.every((q) => q.kind === 'config'));
});

test('issue 5 de dois projetos: salas, imagens, espelhos e pastas distintos', (t) => {
  const controller = localConfig(temporary(t));
  const configs = ['alpha', 'beta'].map((id) => projectConfig(controller, { ...compatibilityProject(base), id }));
  const task = { agent: 'codex', issueNumber: 5, runSeq: 1 };
  const runners = configs.map((c) => new RoomRunner(c, () => {}));
  assert.equal(runners[0].container(task, 'issue'), 'lab-codex-alpha-issue-5-agent');
  assert.equal(runners[1].container(task, 'verify'), 'lab-codex-beta-verify-5-agent');
  assert.notEqual(runners[0].runDir(task, 'agente'), runners[1].runDir(task, 'agente'));
  assert.notEqual(configs[0].images.codex, configs[1].images.codex);
  assert.notEqual(configs[0].git.mirrorDir, configs[1].git.mirrorDir);
});

test('build genérico preserva caminhos de dependências, gera instalação e hash por projeto', (t) => {
  const root = temporary(t), source = path.join(root, 'source'), context = path.join(root, 'context');
  fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(source, 'lib', 'trava.txt'), 'v1');
  const cfg = { ...settings(), dependencias: ['lib/trava.txt'], instalar: ['echo instalar'] };
  const hash = prepareBuild(source, context, cfg);
  assert.equal(fs.readFileSync(path.join(context, 'dependencias/lib/trava.txt'), 'utf8'), 'v1');
  assert.match(fs.readFileSync(path.join(context, 'instalar.sh'), 'utf8'), /echo instalar/);
  const keeper = new ImageKeeper({ ...base, projectSettings: cfg }, { git: () => ({ stdout: 'v1' }) }, () => {});
  assert.equal(keeper.lockHash('main'), hash);
  keeper.config.projectSettings.instalar.push('echo outro');
  assert.notEqual(keeper.lockHash('main'), hash);
});

test('arquivos ESM alterados têm sintaxe válida sem executar entrypoints', () => {
  for (const name of ['main.mjs', 'dashboard.mjs', 'refresh-images.mjs']) {
    const source = fs.readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
      .replace(/^#![^\n]*\n/, '').replace(/^import [\s\S]*?;\n/gm, '').replaceAll('import.meta.url', '"arquivo"');
    assert.doesNotThrow(() => new vm.Script(`(async () => {\n${source}\n})`), name);
  }
});

test('notificação inclui projeto e aponta ao repositório certo', () => {
  const message = notificationFor({ event: 'task_ready', project: 'beta', issue: 5, pull: 9 }, { 5: { title: 'Teste' } }, 'dono2/repo2');
  assert.match(message.body, /beta/); assert.equal(message.url, 'https://github.com/dono2/repo2/pull/9');
  assert.match(message.tag, /beta/);
});

test('API de arquivos recusa projeto desconhecido e travessia entre projetos', (t) => {
  const root = temporary(t);
  const source = fs.readFileSync(new URL('../src/dashboard.mjs', import.meta.url), 'utf8');
  const readFile = source.slice(source.indexOf('function readRunFile('), source.indexOf('// Atividade ao vivo'));
  const ctx = vm.createContext({
    scopedProject: (id) => { if (id !== 'alpha') throw new Error('projeto inválido'); return { rooms: { controlRoot: root } }; },
    LOG_FILES: { log: 'output.sanitized.log' }, join: path.join, existsSync: () => false
  });
  vm.runInContext(readFile, ctx);
  assert.throws(() => vm.runInContext("readRunFile('beta/codex-issue-5/execucao-1/agente', 'log', 'beta')", ctx), /projeto inválido/);
  for (const run of ['beta/codex-issue-5/execucao-1/agente', 'alpha/../beta/codex-issue-5/execucao-1/agente']) {
    ctx.run = run; assert.equal(vm.runInContext("readRunFile(run, 'log', 'alpha')", ctx), null);
  }
});

test('produção bloqueada para todo projeto e reinstalação na sala igual à de antes', () => {
  const other = { ...settings(), proibido: { dominios: ['.outro.example'], portas: [], pastas: [], texto: '' } };
  assert.deepEqual(deniedDomains(base, other), ['.producao.example', '.outro.example']);
  assert.deepEqual(deniedDomains(base, settings()), ['.producao.example'], 'sem repetir o domínio de produção');
  const prompt = buildPrompt({ agent: 'codex', issueNumber: 1, title: 'x', body: '', branch: 'agente/codex/issue-1', baseBranch: 'main' }, { ...base, projectSettings: other });
  assert.match(prompt, /producao\.example/, 'o agente de outro projeto também é avisado');
  assert.deepEqual(settings().reinstalar, ['npm ci --no-audit --no-fund', 'npm --prefix backend ci --no-audit --no-fund']);
  assert.throws(() => validateProjectConfig({ ...settings(), reinstalar: ['ok', 'duas\nlinhas'] }), /reinstalar/);
});

test('partida processa só a configuração; main aprovada troca comandos, imagem e estado sem reinício', async () => {
  const { o, launched } = instance('alpha');
  delete o.config.projectRecord.config;
  o.git = { ...o.git, ...fakeGit(null) };
  o.github.listOpenIssues = async () => [
    { number: 5, title: 'Configurar o laboratório de agentes', body: '<!-- laboratorio-agentes:configuracao-v1 -->', state: 'open', labels: ['codex', 'area:config'] },
    { number: 6, title: 'Primeira tarefa', state: 'open', labels: ['codex', 'area:app'] }
  ];
  const statuses = [], builds = [];
  o.onProjectStatus = (status) => statuses.push(status);
  o.images = { ensure(_branch, { onBuild }) { onBuild(); builds.push(structuredClone(o.config.projectSettings)); } };
  await o.tick();
  assert.deepEqual(launched, [5]);
  assert.equal(o.config.configurationSource, 'partida');
  assert.deepEqual(o.config.projectSettings.verificar, [['node /tmp/lab/validar-config.mjs']]);
  assert.equal(o.config.projectSettings.previa, undefined);
  assert.deepEqual(statuses, ['construindo-imagem', 'configurando']);
  o.state.tasks[5].status = 'done';
  o.github.listOpenIssues = async () => [{ number: 6, title: 'Primeira tarefa', state: 'open', labels: ['codex', 'area:app'] }];
  o.git = { ...o.git, ...fakeGit(settings()) };
  await o.tick();
  assert.deepEqual(launched, [5, 6]);
  assert.equal(o.config.configurationSource, 'repositorio');
  assert.deepEqual(builds[1], settings());
  assert.deepEqual(statuses.slice(-2), ['construindo-imagem', 'pronto']);
});

test('pausa após reinício restaura configuração confiável e continua verificando trabalho ativo', async () => {
  const { o } = instance('alpha');
  const saved = { ...o.state, projectSettings: settings(), configurationSource: 'repositorio', tasks: { 5: { status: 'running' } } };
  const resumed = new Orchestrator({ config: o.config, github: o.github, git: o.git, runner: o.runner, store: { load: () => saved, save() {} }, log() {} });
  resumed.admissionEnabled = false;
  assert.equal(resumed.configurationReady, true);
  let advanced = 0;
  resumed.advance = async (task) => { assert.equal(task.status, 'running'); advanced++; };
  await resumed.tick();
  assert.equal(advanced, 1);
});

test('imagem de partida tem hash distinto mesmo se a configuração aprovada não instalar dependências', (t) => {
  const dir = temporary(t), source = path.join(dir, 'source'); fs.mkdirSync(source);
  const bootstrap = bootstrapConfig();
  const ready = { ...bootstrap, previa: settings().previa };
  const initialHash = prepareBuild(source, path.join(dir, 'initial'), bootstrap);
  const finalHash = prepareBuild(source, path.join(dir, 'final'), ready);
  assert.notEqual(initialHash, finalHash);
  const config = { ...base, projectSettings: bootstrap };
  const keeper = new ImageKeeper(config, { git: () => ({ stdout: '' }) }, () => {});
  assert.equal(keeper.lockHash('main'), initialHash);
  config.projectSettings = ready;
  assert.equal(keeper.lockHash('main'), finalHash);
});

test("domínios proibidos: mesma forma do proxy, sem repetir nem duplicar subdomínio (o Squid recusaria)", () => {
  const withSettings = (dominios) => ({ ...settings(), proibido: { ...settings().proibido, dominios } });
  assert.deepEqual(deniedDomains(base, withSettings(["producao.example"])), [".producao.example"]);
  assert.deepEqual(deniedDomains(base, withSettings(["API.producao.example", ".outro.example", "outro.example"])), [".producao.example", ".outro.example"]);
  assert.deepEqual(deniedDomains(base, withSettings(["ab.com", "b.com"])), [".producao.example", ".ab.com", ".b.com"], "ab.com não é subdomínio de b.com");
});
