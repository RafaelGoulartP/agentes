import test from 'node:test';
import { accountStatus } from '../src/accounts.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { ProjectRequestQueue, parseRepository, suggestProjectId, validateProjectRequest } from '../src/project-requests.mjs';
import { ProjectManager, checkProjectAccess, generateConfiguration } from '../src/project-manager.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { bootstrapConfig, validateProjectConfig, deniedDomains } from '../src/projects.mjs';
import { base, exampleSettings as compatibilityConfig } from './fixtures/projeto-exemplo.mjs';
import { validateCandidateConfig } from '../../scripts/validar-config.mjs';
import { notificationFor } from '../src/push.mjs';

function temp(t) {
  const root = new URL('../../.test-tmp/', import.meta.url);
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(fileURLToPath(root), 'phase2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const p = { id: 'alpha', owner: 'dono', repo: 'repo', enabled: true, addedAt: '2026-10-17T00:00:00Z' };
const missing = () => Object.assign(new Error('não encontrado'), { status: 404 });
function github() {
  const labels = new Set(['codex']), issues = [], calls = [];
  return { labels, issues, calls, repository: async () => ({ default_branch: 'main', permissions: { push: true } }),
    listOpenIssues: async () => issues,
    async request(method, route, body) {
      calls.push({ method, route, body });
      if (method === 'GET' && route.startsWith('/commits/')) return { sha: 'a'.repeat(40) };
      if (method === 'GET' && route.startsWith('/labels/')) { if (!labels.has(decodeURIComponent(route.slice(8)))) throw missing(); return {}; }
      if (method === 'POST' && route === '/labels') { labels.add(body.name); return body; }
      if (method === 'POST' && route === '/issues') { const issue = { ...body, number: issues.length + 1 }; issues.push(issue); return issue; }
      throw new Error(`inesperado ${method} ${route}`);
    }
  };
}

test('pedidos: URL, nomes, sugestão única, id e limite de dez', () => {
  for (const url of ['https://github.com/Dono/Repo', 'https://github.com/Dono/Repo.git/', 'Dono/Repo/']) assert.deepEqual(parseRepository(url), { owner: 'Dono', repo: 'Repo' });
  for (const url of ['http://github.com/a/b', 'https://outro/a/b', 'a/..', './b', 'a/b?x=1', 'a/b/c', `a/${'b'.repeat(101)}`, 'a/<img>']) assert.throws(() => parseRepository(url));
  assert.equal(suggestProjectId('Meu-Repo'), 'meurepo');
  assert.equal(suggestProjectId('Meu-Repo', [{ id: 'meurepo' }]), 'meurepo1');
  assert.match(suggestProjectId('123'), /^[a-z][a-z0-9]{1,11}$/);
  assert.equal(validateProjectRequest({ type: 'adicionar', url: 'https://github.com/a/b.git' }, []).id, 'bp');
  for (const value of [{}, { owner: null, repo: 'a' }, { owner: 12, repo: 'a' }, { url: ['a/b'] }, { owner: 'a', repo: 'b', id: '' }]) assert.throws(() => validateProjectRequest({ type: 'adicionar', ...value }, []));
  for (const id of ['a', 'A1', '../x', 'abcdefghijklmnop', 'alpha']) assert.throws(() => validateProjectRequest({ type: 'adicionar', owner: 'x', repo: 'y', id }, [p]));
  assert.throws(() => validateProjectRequest({ type: 'adicionar', owner: 'x', repo: 'y' }, Array.from({ length: 10 }, (_, n) => ({ ...p, id: `p${n}` }))), /10/);
  assert.throws(() => validateProjectRequest({ type: 'remover', id: 'ausente' }, [p]));
  assert.throws(() => validateProjectRequest({ type: 'adicionar', owner: 'Dono', repo: 'Repo' }, [p]), /já adicionado/);
});

test('fila atômica apaga só o lote lido e ignora temporários', (t) => {
  const queue = new ProjectRequestQueue(path.join(temp(t), 'pedidos'));
  queue.add({ type: 'pausar', id: 'alpha' });
  const read = queue.list();
  queue.add({ type: 'retomar', id: 'alpha' });
  fs.writeFileSync(path.join(queue.dir, 'incompleto.tmp'), '{');
  read.forEach((item) => queue.remove(item));
  assert.equal(queue.list().length, 1); assert.equal(queue.list()[0].value.type, 'retomar');
});

test('acesso: 404/403, vazio, permissões, etiquetas faltantes', async () => {
  for (const status of [404, 403]) {
    const g = github(); g.repository = async () => { throw Object.assign(new Error('token ghp_fakefakefakefakefakefakefakefakefakefake'), { status }); };
    assert.equal((await checkProjectAccess(g, base)).status, 'sem-acesso');
  }
  const g = github();
  g.repository = async () => ({ default_branch: 'main', permissions: { push: false } });
  assert.equal((await checkProjectAccess(g, base)).status, 'sem-acesso');
  g.repository = async () => ({});
  assert.match((await checkProjectAccess(g, base)).detail, /README/);
  g.repository = async () => ({ default_branch: 'main' });
  const request = g.request; g.request = async () => { throw Object.assign(new Error('vazio'), { status: 409 }); };
  assert.equal((await checkProjectAccess(g, base)).status, 'erro');
  g.request = request;
  assert.equal((await checkProjectAccess(g, base)).status, 'acessivel');
  assert.equal(g.calls.filter((c) => c.method === 'POST').length, 4);
  assert.deepEqual([...g.labels].sort(), ['codex', 'claude', 'em-andamento', 'bloqueado', 'pronto-para-revisao'].sort());
  await checkProjectAccess(g, base);
  assert.equal(g.calls.filter((c) => c.method === 'POST').length, 4);
});

test('gerar configuração cria uma única issue e não confunde título de outra pessoa', async () => {
  const g = github(); g.issues.push({ title: 'Configurar o laboratório de agentes', body: 'outra pessoa' });
  await generateConfiguration(g); await generateConfiguration(g);
  assert.equal(g.calls.filter((c) => c.route === '/issues').length, 1);
  assert.match(g.issues[1].body, /SOMENTE .laboratorio.json/);
  assert.deepEqual(g.issues[1].labels, ['codex']);
  g.issues.length = 1;
  await generateConfiguration(g, ['claude']);
  assert.deepEqual(g.issues[1].labels, ['claude'], 'só com Claude logado, a configuração vai para o Claude');
});

test('partida só aceita o modelo interno; validador exige arquivo válido e sem link', (t) => {
  const dir = temp(t), config = bootstrapConfig();
  assert.equal(validateProjectConfig(config, { allowBootstrap: true }).previa, undefined);
  assert.throws(() => validateProjectConfig(config), /previa/);
  assert.throws(() => validateProjectConfig({ ...config, instalar: ['true'] }, { allowBootstrap: true }), /previa/);
  assert.deepEqual(deniedDomains(base, config), base.rooms.deniedDomains);
  assert.throws(() => validateCandidateConfig(dir), /ausente/);
  const file = path.join(dir, '.laboratorio.json');
  fs.writeFileSync(file, '{}'); assert.throws(() => validateCandidateConfig(dir), /laboratorio/);
  fs.writeFileSync(file, '{'); assert.throws(() => validateCandidateConfig(dir));
  fs.writeFileSync(file, JSON.stringify(compatibilityConfig(base)));
  assert.deepEqual(validateCandidateConfig(dir), compatibilityConfig(base));
});

function manager(t) {
  const dir = temp(t), config = structuredClone(base);
  Object.assign(config, { projectsFile: path.join(dir, 'projetos.json'), stateFile: path.join(dir, 'legado.json') });
  config.rooms.controlRoot = path.join(dir, 'salas');
  fs.writeFileSync(config.projectsFile, '[]');
  const coordinator = new Coordinator(2), events = [];
  const m = new ProjectManager({ config, coordinator, log: (event, fields) => events.push({ event, ...fields }), createInstance(scoped) {
    return { config: scoped, github: github(), git: { ensure() {}, fetchBranch: () => 'a'.repeat(40), git: () => ({ stdout: '' }) }, state: { tasks: {}, quota: {}, breaker: {} },
      async tick() { this.full = (this.full ?? 0) + 1; }, async tickLocal() { this.local = (this.local ?? 0) + 1; } };
  } });
  return { dir, m, coordinator, events };
}
test('recarga no mesmo processo; pausa supervisiona; remoção recusa ativo e preserva dados', async (t) => {
  const { m, coordinator, events } = manager(t);
  m.queue.add({ type: 'adicionar', owner: 'dono', repo: 'repo', id: 'alpha' });
  await m.refresh(); assert.equal(coordinator.instances.length, 1);
  const o = coordinator.instances[0]; await coordinator.cycle(true); assert.equal(o.full, 1);
  o.state.tasks[1] = { status: 'running' };
  await m.apply({ type: 'pausar', id: 'alpha' }); await coordinator.cycle(true);
  assert.equal(o.local, 1); assert.equal(o.state.tasks[1].status, 'running');
  for (const status of ['starting', 'running', 'collecting', 'verifying', 'delivering']) {
    o.state.tasks[1].status = status; await assert.rejects(m.apply({ type: 'remover', id: 'alpha' }), /andamento/);
  }
  const file = o.config.stateFile;
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'histórico');
  o.state.tasks[1].status = 'done';
  await m.apply({ type: 'retomar', id: 'alpha' }); await coordinator.cycle(true); assert.equal(o.full, 2);
  await m.apply({ type: 'remover', id: 'alpha' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'histórico'); assert.ok(m.projects[0].removedAt);
  assert.equal(coordinator.instances.length, 0);
  assert.equal(m.projects[0].enabled, false); assert.ok(events.some((e) => e.event === 'project_removed'));
  assert.equal(m.queue.list().length, 0);
});
test('controlador revalida fila e mantém configuração em andamento após pedido repetido', async (t) => {
  const { m, coordinator } = manager(t);
  await m.apply({ type: 'adicionar', owner: 'a', repo: 'b', id: 'alpha' });
  await m.apply({ type: 'gerar-configuracao', id: 'alpha' }); await m.apply({ type: 'gerar-configuracao', id: 'alpha' });
  assert.equal(m.projects[0].status, 'configurando');
  assert.equal(coordinator.instances[0].github.issues.length, 1);
  m.queue.add({ type: 'adicionar', owner: '..', repo: 'bad' }); await m.refresh();
  assert.equal(m.projects.length, 1); assert.equal(m.queue.list().length, 0);
});

test('POST de projetos passa pelas proteções antes de gravar', async () => {
  const source = fs.readFileSync(new URL('../src/dashboard.mjs', import.meta.url), 'utf8');
  const actions = source.slice(source.indexOf('function sameOrigin('), source.indexOf('function send('));
  let writes = 0;
  const ctx = vm.createContext({ URL, readBody: async () => ({ owner: 'dono', repo: 'repo', id: 'alpha' }), loadConfig: () => ({}), configPath: 'local', readProjects: () => [], validateProjectRequest,
    projectRequestsDir: () => 'local', ProjectRequestQueue: class { add() { writes++; } } });
  vm.runInContext(actions, ctx);
  for (const type of ['adicionar', 'pausar', 'retomar', 'remover', 'gerar-configuracao', 'verificar-acesso']) {
    for (const headers of [{ host: 'localhost:7788' }, { host: 'localhost:7788', 'x-painel': '1', 'content-type': 'application/json', origin: 'https://intruso.test' }]) {
      ctx.req = { headers }; ctx.url = new URL(`http://localhost/api/projetos/${type}`);
      assert.equal((await vm.runInContext('action(req, url)', ctx)).status, 403);
    }
  }
  assert.equal(writes, 0);
  ctx.req = { headers: { host: 'localhost:7788', 'x-painel': '1', 'content-type': 'application/json', origin: 'http://localhost:7788' } };
  ctx.url = new URL('http://localhost/api/projetos/adicionar');
  assert.equal((await vm.runInContext('action(req, url)', ctx)).status, 202); assert.equal(writes, 1);
  assert.match(source, /hostAllowed\(req.headers.host\)/); assert.match(source, /startsWith\('\/api\/projetos\/'\) \? 4096/);
});

test('HTTP: JSON inválido, corpo grande e host estranho são recusados sem I/O externo', async () => {
  const source = fs.readFileSync(new URL('../src/dashboard.mjs', import.meta.url), 'utf8');
  const ctx = vm.createContext({ Buffer, URL, PORT: 7788, LAN_PORT: 7789, HTTPS_PORT: null, lanCache: { at: Date.now(), value: [] }, lanAddresses: async () => [] });
  vm.runInContext(source.slice(source.indexOf('function readBody('), source.indexOf('// Ações (POST)')), ctx);
  vm.runInContext(source.slice(source.indexOf('async function hostAllowed('), source.indexOf('const server =')), ctx);
  ctx.req = new EventEmitter(); ctx.req.destroy = () => {};
  const invalid = vm.runInContext('readBody(req, 20)', ctx);
  ctx.req.emit('data', Buffer.from('{')); ctx.req.emit('end');
  await assert.rejects(invalid, /JSON inválido/);
  ctx.req = new EventEmitter(); let destroyed = false; ctx.req.destroy = () => { destroyed = true; };
  const large = vm.runInContext('readBody(req, 4096)', ctx);
  ctx.req.emit('data', Buffer.alloc(4097));
  await assert.rejects(large, /grande demais/); assert.equal(destroyed, true);
  assert.equal(await vm.runInContext("hostAllowed('intruso.test:7788')", ctx), false);
  assert.equal(await vm.runInContext("hostAllowed('intruso.test:7789')", ctx), false);
  assert.equal(await vm.runInContext("hostAllowed('localhost:7788')", ctx), true);
});

test('painel continua utilizável depois de remover o último projeto', async () => {
  const source = fs.readFileSync(new URL('../src/dashboard.mjs', import.meta.url), 'utf8');
  const ctx = vm.createContext({ loadConfig: () => base, configPath: 'local', readProjects: () => [], accountStatus });
  vm.runInContext(source.slice(source.indexOf('async function overview('), source.indexOf('function readRunFile(')), ctx);
  const value = await vm.runInContext('overview()', ctx);
  assert.deepEqual(value.controller.agents, base.labels.agents);
  assert.equal(value.tasks.length, 0); assert.equal(value.projects.length, 0);
  const html = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  vm.runInContext(html.slice(html.indexOf('const TABS ='), html.indexOf('// ---------- Avisos no celular')), ctx);
  ctx.__data = value; vm.runInContext('data = __data', ctx);
  for (const fn of ['viewAgora', 'viewTarefas', 'viewEventos', 'viewSistema', 'viewProjetos']) assert.equal(typeof vm.runInContext(`${fn}()`, ctx), 'string');
  assert.equal(vm.runInContext('stoppedAlert()', ctx), '');
});

test('push avisa pronto, sem acesso e erro; outros estados silenciosos', () => {
  for (const status of ['pronto', 'sem-acesso', 'erro']) assert.ok(notificationFor({ event: 'project_status', status, project: 'alpha', repo: 'repo' }, {}, 'dono/repo'));
  assert.match(notificationFor({ event: 'project_status', status: 'pronto', repo: 'repo' }, {}, 'dono/repo').title, /Projeto pronto: repo/);
  assert.equal(notificationFor({ event: 'project_status', status: 'configurando' }, {}, 'dono/repo'), null);
});

test("PC ligado sem internet: o projeto não fica parado, tenta de novo e volta a abrir salas", async (t) => {
  const { m, coordinator } = manager(t);
  m.queue.add({ type: "adicionar", owner: "dono", repo: "repo", id: "alpha" });
  let online = false;
  const realCreate = m.createInstance;
  m.createInstance = (scoped) => {
    const o = realCreate(scoped);
    const repository = o.github.repository;
    o.github.repository = async () => { if (!online) throw new Error("fetch failed"); return repository(); };
    return o;
  };
  await m.refresh();
  const project = m.projects.find((p) => p.id === "alpha");
  const o = coordinator.instances[0];
  assert.equal(project.status, "verificando-acesso", "rede fora não é erro do projeto");
  assert.equal(o.admissionEnabled, false);
  online = true;
  await m.refresh();
  assert.equal(o.admissionEnabled, true, "volta sozinho no ciclo seguinte");

  // Acesso negado também é conferido de novo, mas só depois de alguns minutos.
  m.checked.delete("alpha"); project.status = "sem-acesso"; project.checkedAt = new Date().toISOString();
  await m.refresh();
  assert.equal(m.checked.has("alpha"), false, "não martela o GitHub a cada ciclo");
  project.checkedAt = new Date(Date.now() - 6 * 60_000).toISOString();
  await m.refresh();
  assert.equal(m.checked.has("alpha"), true);
});
