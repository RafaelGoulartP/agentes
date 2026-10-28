import test from 'node:test';
import assert from 'node:assert/strict';
import { Orchestrator } from '../src/orchestrator.mjs';
import { buildPrompt } from '../src/room-runner.mjs';
import { completionStatus, dependenciesFor } from '../src/domain.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHA_BASE = 'a'.repeat(40);
const SHA_PR = 'b'.repeat(40);
const SHA_NEW = 'c'.repeat(40);
const SHA_MERGE = 'd'.repeat(40);
const SHA_MAIN = 'e'.repeat(40);

function fixture({ issues, maxAttempts = 3, health = null } = {}) {
  const config = {
    github: { owner: 'o', repo: 'r' },
    labels: { agents: ['codex', 'claude'], inProgress: 'em-andamento', blocked: 'bloqueado', readyForReview: 'pronto-para-revisao', areaPrefix: 'area:' },
    scheduler: { maxConcurrency: 2, hardMaxConcurrency: 3, defaultArea: 'geral' },
    retry: { baseSeconds: 300, maxSeconds: 3600, maxAttempts },
    rooms: { branchPrefix: 'agente', agentTimeoutMinutes: 240, verifyTimeoutMinutes: 60 },
    verify: { commands: ['npm run lint', 'npm test'] }
  };
  let clock = Date.parse('2026-10-16T12:00:00Z');
  const issue = (number, labels, body = '') => ({ number, title: `T${number}`, body, state: 'open', labels: labels.map((name) => ({ name })) });
  const calls = [];
  const github = {
    issues: issues ?? [issue(1, ['codex', 'area:agenda']), issue(2, ['claude', 'area:financeiro'])],
    pulls: [], others: new Map(), created: [], offline: false, comparison: { status: 'ahead', behind_by: 0 },
    check() { if (this.offline) throw new Error('rede indisponivel'); },
    async listOpenIssues() { this.check(); return this.issues; },
    async listOpenPulls() { this.check(); return this.pulls; },
    async repository() { this.check(); return { default_branch: 'main' }; },
    async getIssue(number) {
      this.check();
      if (!this.others.has(number)) throw Object.assign(new Error('HTTP 404'), { status: 404 });
      return this.others.get(number);
    },
    async getPull(number) { this.check(); return this.pulls.find((pull) => pull.number === number); },
    async compare() { this.check(); return this.comparison; },
    async findOpenPull(branch) { this.check(); return this.pulls.find((pull) => pull.head.ref === branch) ?? null; },
    async createPull(body) {
      this.check();
      const pull = { number: 100 + this.created.length, head: { ref: body.head, sha: SHA_NEW }, base: { ref: body.base }, mergeable: true };
      this.created.push(body);
      this.pulls.push(pull);
      return pull;
    },
    async addLabel(...args) { this.check(); calls.push(['add', ...args]); },
    async removeLabel(...args) { this.check(); calls.push(['remove', ...args]); },
    async comment(...args) { this.check(); calls.push(['comment', ...args]); }
  };
  const runner = {
    launched: [], verified: [], destroyed: [], stopped: [], states: new Map(),
    // Agente que sai com erro, por padrão, não deixou commits nem resumo.
    collected(task) {
      if (this.states.get(task.run?.id)?.exitCode) return { head: null, commits: 0, dirty: 0, bundle: null, summary: '', dir: '/tmp/coleta' };
      return { head: SHA_NEW, commits: 1, dirty: 0, bundle: '/tmp/out.bundle', summary: 'STATUS: COMPLETO\nResumo do agente', dir: '/tmp/coleta' };
    },
    agentBundlePath() { return '/tmp/in.bundle'; },
    verifyBundlePath() { return '/tmp/verify.bundle'; },
    launchAgent(task) {
      if (this.launchError) throw this.launchError;
      this.launched.push(structuredClone(task));
      const id = `agente-${task.issueNumber}-${task.runSeq}`;
      this.states.set(id, { status: 'running' });
      return { id, startedAt: new Date(clock).toISOString() };
    },
    launchVerify(task) {
      this.verified.push(structuredClone(task));
      const id = `verificacao-${task.issueNumber}-${task.runSeq}`;
      this.states.set(id, { status: 'running' });
      return { id, startedAt: new Date(clock).toISOString() };
    },
    finish(id, exitCode = 0) { this.states.set(id, { status: 'completed', exitCode }); },
    inspectRun(run) { return this.states.get(run?.id) ?? { status: 'lost', detail: 'sem registro' }; },
    stopRun(run) { if (run) this.stopped.push(run.id); },
    sanitizeLog() { return null; },
    collect(task) { return this.collected(task); },
    destroy(task, kind) { this.destroyed.push([task.issueNumber, kind]); }
  };
  const git = {
    pushed: [], remote: new Map(), imported: [],
    prepareInput(task) {
      if (this.prepareError) throw this.prepareError;
      return { baseSha: SHA_BASE, startSha: task.revision ? SHA_PR : SHA_BASE };
    },
    importBundle(file, branch, ref) { this.imported.push(ref); return SHA_NEW; },
    isAncestor() { return true; },
    refs: new Map(), merges: [],
    fetchBranch() { return SHA_BASE; },
    setRef(ref, sha) { this.refs.set(ref, sha); },
    mergeBase(head, base) { this.merges.push([head, base]); return { sha: SHA_MERGE }; },
    bundleRef(file) { return file; },
    remoteSha(branch) { return this.remote.get(branch) ?? null; },
    push(sha, branch) { if (this.pushError) throw this.pushError; this.pushed.push([sha, branch]); this.remote.set(branch, sha); },
    commitSubjects() { return ['c0ffee1 feat: ajuste de teste']; },
    changedFiles() { return ['src/app.ts', 'package.json']; }
  };
  const store = {
    state: { version: 1, tasks: {} },
    load() { return structuredClone(this.state); },
    save(value) { this.state = structuredClone(value); }
  };
  const logs = [];
  const orchestrator = new Orchestrator({ config, github, runner, git, store, health, log: (event, fields) => logs.push([event, fields]), now: () => clock });
  return { orchestrator, github, runner, git, store, calls, logs, issue, advance(ms) { clock += ms; } };
}

const comments = (calls, issue) => calls.filter((x) => x[0] === 'comment' && x[1] === issue).map((x) => x[2]);

test('tick inicia no máximo duas salas de áreas diferentes', async () => {
  const { orchestrator, runner, github, issue } = fixture();
  github.issues.push(issue(3, ['codex', 'area:alunos']));
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((x) => [x.issueNumber, x.agent]), [[1, 'codex'], [2, 'claude']]);
  assert.equal(Object.values(orchestrator.state.tasks).every((x) => x.status === 'running'), true);
});

test('tick local avança salas sem listar issues nem PRs', async () => {
  const { orchestrator, runner, github } = fixture();
  await orchestrator.tick();
  runner.finish('agente-1-1');
  let listed = 0;
  github.listOpenIssues = async () => { listed += 1; return []; };
  github.listOpenPulls = async () => { listed += 1; return []; };
  await orchestrator.tickLocal();
  assert.equal(listed, 0);
  assert.equal(orchestrator.state.tasks[1].status, 'verifying');
  assert.equal(orchestrator.hasActiveWork(), true);
});

test('modo piloto só considera a issue escolhida', async () => {
  const { orchestrator, runner } = fixture();
  orchestrator.config.scheduler.onlyIssues = [2];
  orchestrator.config.scheduler.maxConcurrency = 1;
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((x) => x.issueNumber), [2]);
});

test('fluxo completo: agente sem token, verificação em sala limpa, push pelo controlador e PR', async () => {
  const { orchestrator, runner, git, github, calls } = fixture();
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'verifying');
  assert.equal(orchestrator.state.tasks[1].candidateSha, SHA_NEW);
  assert.deepEqual(runner.destroyed.filter((x) => x[0] === 1), [[1, 'issue']]);
  assert.equal(git.pushed.length, 0, 'nada vai ao GitHub antes da verificação');

  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  const task = orchestrator.state.tasks[1];
  assert.equal(task.status, 'ready');
  assert.deepEqual(git.pushed, [[SHA_NEW, 'agente/codex/issue-1']]);
  assert.equal(github.created.length, 1);
  assert.match(github.created[0].body, /Closes #1/);
  assert.match(github.created[0].body, /`package\.json`/);
  assert.match(github.created[0].body, /não verificado/);
  assert.ok(calls.some((x) => x[0] === 'add' && x[1] === 1 && x[2] === 'pronto-para-revisao'));
  assert.ok(comments(calls, 1).some((body) => body.includes(`PR #${task.prNumber} pronto`)));
  assert.equal(orchestrator.state.outbox.length, 0);
});

test('agente sem commits vira retry e o comentário não expõe detalhes técnicos', async () => {
  const { orchestrator, runner, calls } = fixture();
  runner.collected = () => ({ head: null, commits: 0, dirty: 2, bundle: null, summary: 'STATUS: COMPLETO', dir: '/tmp/coleta' });
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'retry');
  assert.equal(orchestrator.state.tasks[1].lastError.category, 'no_commits');
  const [body] = comments(calls, 1);
  assert.match(body, /sem commits novos/);
  assert.doesNotMatch(body, /pendentes=2/);
});

test('.laboratorio.json alterado aparece em Atenção na revisão', async () => {
  const { orchestrator, runner, git, github } = fixture();
  git.changedFiles = () => ['.laboratorio.json'];
  await orchestrator.tick(); runner.finish('agente-1-1');
  await orchestrator.tick(); runner.finish('verificacao-1-1');
  await orchestrator.tick();
  assert.match(github.created[0].body, /Atenção na revisão/);
  assert.match(github.created[0].body, /`\.laboratorio\.json`/);
});

test('detalhe com token é mascarado no estado local', async () => {
  const { orchestrator, git } = fixture();
  git.prepareError = new Error('falhou com ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  await orchestrator.tick();
  assert.doesNotMatch(JSON.stringify(orchestrator.state), /ghp_abcdef/);
});

test('falha na verificação não entrega e guarda nova tentativa', async () => {
  const { orchestrator, runner, git } = fixture();
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1', 1);
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'retry');
  assert.equal(orchestrator.state.tasks[1].lastError.category, 'verify_failed');
  assert.equal(git.pushed.length, 0);
});

test('queda do controlador durante starting é recuperada como retry', async () => {
  const { orchestrator, runner, github } = fixture();
  github.issues = [];
  orchestrator.state.tasks[8] = { issueNumber: 8, agent: 'codex', areas: ['agenda'], status: 'starting', attempts: 0, runSeq: 1 };
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[8].status, 'retry');
  assert.equal(orchestrator.state.tasks[8].lastError.category, 'interrupted');
  assert.deepEqual(runner.destroyed, [[8, 'issue'], [8, 'verify']]);
});

test('supervisor perdido e tempo limite viram retry com o trabalho preservado', async () => {
  const { orchestrator, runner, git, advance } = fixture();
  await orchestrator.tick();
  runner.states.set('agente-1-1', { status: 'lost', detail: 'supervisor terminou sem registrar resultado' });
  advance(241 * 60_000);
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].lastError.category, 'lost');
  assert.equal(orchestrator.state.tasks[2].lastError.category, 'timeout');
  assert.ok(runner.stopped.includes('agente-2-1'));
  assert.ok(git.imported.includes('refs/lab/issue-1/falha-1'));
});

test('GitHub fora do ar: atualizações ficam no outbox persistido e saem depois, em ordem', async () => {
  const { orchestrator, runner, github, store, calls } = fixture();
  await orchestrator.tick();
  github.offline = true;
  runner.finish('agente-1-1', 1);
  await assert.rejects(orchestrator.tick(), /rede indisponivel/);
  assert.equal(orchestrator.state.tasks[1].status, 'retry');
  assert.deepEqual(store.state.outbox.filter((op) => op.issue === 1).map((op) => op.type), ['removeLabel', 'comment']);
  github.offline = false;
  await orchestrator.tick();
  assert.equal(orchestrator.state.outbox.length, 0);
  const forIssue = calls.filter((x) => x[1] === 1).map((x) => x[0]);
  assert.deepEqual(forIssue, ['add', 'remove', 'comment']);
});

test('GitHub fora do ar na entrega: mantém delivering e conclui depois sem refazer o agente', async () => {
  const { orchestrator, runner, git, github } = fixture();
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1');
  github.offline = true;
  await assert.rejects(orchestrator.tick(), /rede indisponivel/);
  assert.equal(orchestrator.state.tasks[1].status, 'delivering');
  github.offline = false;
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'ready');
  assert.equal(git.pushed.length, 1, 'push idempotente: não repete');
  assert.equal(runner.launched.filter((x) => x.issueNumber === 1).length, 1);
});

test('PR atrasado (ahead com behind_by) dispara revisão, mas não no mesmo tick da conclusão', async () => {
  const { orchestrator, runner, github, advance } = fixture();
  github.issues = github.issues.slice(0, 1);
  github.comparison = { status: 'ahead', ahead_by: 2, behind_by: 3 };
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'ready');
  assert.equal(runner.launched.length, 1, 'sem revisão no mesmo tick');
  github.issues[0].labels.push({ name: 'pronto-para-revisao' });
  advance(60_000);
  await orchestrator.tick();
  const revision = runner.launched.at(-1);
  assert.deepEqual([revision.revision, revision.prNumber, revision.agent, revision.branch], [true, 100, 'codex', 'agente/codex/issue-1']);
});

test('retorno de revisão respeita a etiqueta bloqueado', async () => {
  const { orchestrator, runner, github, issue } = fixture();
  github.issues = [issue(1, ['codex', 'pronto-para-revisao', 'bloqueado'])];
  github.pulls = [{ number: 44, head: { ref: 'agente/codex/issue-1', sha: SHA_PR }, base: { ref: 'main' }, mergeable: false }];
  orchestrator.state.tasks[1] = { issueNumber: 1, agent: 'codex', areas: ['geral'], status: 'ready', prNumber: 44, branch: 'agente/codex/issue-1', readyAt: '2026-01-01T00:00:00Z' };
  await orchestrator.tick();
  assert.equal(runner.launched.length, 0);
});

test('retry de revisão preserva intenção, agente e base do PR', async () => {
  const { orchestrator, runner, github, issue } = fixture();
  github.issues = [issue(5, ['codex', 'pronto-para-revisao'])];
  orchestrator.state.tasks[5] = {
    issueNumber: 5, agent: 'claude', areas: ['geral'], status: 'retry', revision: true, prNumber: 44, attempts: 1, runSeq: 2,
    branch: 'agente/claude/issue-5', baseBranch: 'release', nextAttemptAt: '2026-01-01T00:00:00Z'
  };
  await orchestrator.tick();
  const [launched] = runner.launched;
  assert.deepEqual([launched.agent, launched.revision, launched.prNumber, launched.baseBranch, launched.runSeq], ['claude', true, 44, 'release', 3]);
});

test('esgotar tentativas bloqueia; retirar a etiqueta libera nova tentativa', async () => {
  const { orchestrator, runner, github, calls, issue } = fixture({ maxAttempts: 1 });
  github.issues = [issue(1, ['codex'])];
  await orchestrator.tick();
  runner.finish('agente-1-1', 2);
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'blocked');
  assert.ok(calls.some((x) => x[0] === 'add' && x[2] === 'bloqueado'));
  github.issues = [issue(1, ['codex', 'bloqueado'])];
  await orchestrator.tick();
  assert.equal(runner.launched.length, 1, 'continua bloqueada enquanto a etiqueta existir');
  github.issues = [issue(1, ['codex'])];
  await orchestrator.tick();
  assert.equal(runner.launched.length, 2);
  assert.equal(orchestrator.state.tasks[1].attempts, 0);
});

test('branch já existente bloqueia antes de gastar tokens do agente', async () => {
  const { orchestrator, runner, git, github, issue } = fixture();
  github.issues = [issue(1, ['codex'])];
  git.prepareError = Object.assign(new Error('branch agente/codex/issue-1 ja existe no GitHub'), { category: 'branch_exists', permanent: true });
  await orchestrator.tick();
  assert.equal(runner.launched.length, 0);
  assert.equal(orchestrator.state.tasks[1].status, 'blocked');
});

test('push recusado por divergência bloqueia sem force', async () => {
  const { orchestrator, runner, git } = fixture();
  git.pushError = Object.assign(new Error('push recusado'), { category: 'delivery_conflict', permanent: true });
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'blocked');
  assert.equal(orchestrator.state.tasks[1].lastError.category, 'delivery_conflict');
});

test('dependências: concluída libera; não planejada, ausente e ciclo avisam uma única vez', async () => {
  const { orchestrator, runner, github, calls, issue } = fixture();
  github.issues = [
    issue(5, ['codex', 'area:a'], 'depende de #3'),
    issue(6, ['codex', 'area:b'], 'depende de #4'),
    issue(7, ['codex', 'area:c'], 'depende de #99'),
    issue(8, ['codex', 'area:d'], 'depende de #9'),
    issue(9, ['codex', 'area:e'], 'depende de #8')
  ];
  github.others.set(3, { number: 3, state: 'closed', state_reason: 'completed' });
  github.others.set(4, { number: 4, state: 'closed', state_reason: 'not_planned' });
  await orchestrator.tick();
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((x) => x.issueNumber), [5]);
  for (const number of [6, 7, 8, 9]) assert.equal(comments(calls, number).length, 1, `issue ${number}`);
  assert.match(comments(calls, 8)[0], /ciclo/);
});

// A main andou enquanto o agente trabalhava: o candidato (SHA_NEW) não contém a base atual (SHA_MAIN).
function mainMoved(git) {
  git.fetchBranch = () => SHA_MAIN;
  git.isAncestor = (ancestor, descendant) => !(ancestor === SHA_MAIN && descendant === SHA_NEW);
}

test('base atualizada sem conflito: verifica e entrega o merge com a main mais recente', async () => {
  const { orchestrator, runner, git, github } = fixture();
  mainMoved(git);
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  const task = orchestrator.state.tasks[1];
  assert.deepEqual(git.merges, [[SHA_NEW, SHA_MAIN]]);
  assert.equal(task.status, 'verifying');
  assert.equal(task.candidateSha, SHA_MERGE);
  assert.equal(git.refs.get('refs/lab/issue-1/candidato'), SHA_MERGE);
  assert.equal(runner.verified.find((x) => x.issueNumber === 1).candidateSha, SHA_MERGE, 'a verificação roda sobre o merge');

  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'ready');
  assert.deepEqual(git.pushed.find((x) => x[1] === 'agente/codex/issue-1'), [SHA_MERGE, 'agente/codex/issue-1']);
  assert.equal(github.created.length, 1);
});

test('base já incorporada: nenhum merge extra', async () => {
  const { orchestrator, runner, git } = fixture();
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  assert.deepEqual(git.merges, []);
  assert.equal(orchestrator.state.tasks[1].candidateSha, SHA_NEW);
});

test('conflito com a main: sem PR, retry, e a próxima tentativa retoma o trabalho e pede para resolver', async () => {
  const { orchestrator, runner, git, github, calls, advance } = fixture();
  mainMoved(git);
  git.mergeBase = () => ({ conflicts: ['docs/MAPA-DO-CODIGO.md', 'src/app.ts'] });
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();

  const task = orchestrator.state.tasks[1];
  assert.equal(task.status, 'retry');
  assert.equal(task.lastError.category, 'base_conflict');
  assert.equal(runner.verified.filter((x) => x.issueNumber === 1).length, 0, 'não verifica nem entrega');
  assert.equal(git.pushed.length, 0);
  assert.equal(github.created.length, 0);
  assert.deepEqual(task.resumeFrom, { ref: 'refs/lab/issue-1/conflito-1', sha: SHA_NEW, files: ['docs/MAPA-DO-CODIGO.md', 'src/app.ts'], baseSha: SHA_MAIN });
  assert.equal(git.refs.get('refs/lab/issue-1/conflito-1'), SHA_NEW, 'trabalho do agente preservado');
  const [body] = comments(calls, 1);
  assert.match(body, /conflita com a versão mais recente/);
  assert.match(body, /`docs\/MAPA-DO-CODIGO\.md`, `src\/app\.ts`/);

  // Próxima tentativa: o controlador entrega o trabalho guardado e o agente recebe a instrução de merge.
  const inputs = [];
  git.prepareInput = (t) => { inputs.push(structuredClone(t)); return { baseSha: SHA_MAIN, startSha: t.resumeFrom.sha, resumed: true }; };
  advance(10 * 60_000);
  await orchestrator.tick();
  const retry = runner.launched.filter((x) => x.issueNumber === 1).at(-1);
  assert.equal(retry.runSeq, 2);
  assert.equal(inputs[0].resumeFrom.ref, 'refs/lab/issue-1/conflito-1');
  assert.equal(retry.resumed, true);
  assert.equal(retry.startSha, SHA_NEW);
  const prompt = buildPrompt(retry, { github: { owner: 'o', repo: 'r' } });
  assert.match(prompt, /git merge origin\/main/);
  assert.match(prompt, /docs\/MAPA-DO-CODIGO\.md, src\/app\.ts/);
  assert.match(prompt, /preservando as mudanças dos dois lados/);

  // O agente resolve: a base passa a estar contida e a entrega segue normal, limpando a retomada.
  git.isAncestor = () => true;
  runner.finish('agente-1-2');
  await orchestrator.tick();
  runner.finish('verificacao-1-2');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'ready');
  assert.equal(orchestrator.state.tasks[1].resumeFrom, null);
});

test('troca de agente após conflito recomeça do zero', async () => {
  const { orchestrator, runner, git, github, issue, advance } = fixture();
  mainMoved(git);
  git.mergeBase = () => ({ conflicts: ['a.txt'] });
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  github.issues[0] = issue(1, ['claude', 'area:agenda']);
  advance(10 * 60_000);
  await orchestrator.tick();
  const retry = runner.launched.filter((x) => x.issueNumber === 1).at(-1);
  assert.equal(retry.agent, 'claude');
  assert.equal(retry.resumeFrom, null);
});

function fakeHealth() {
  return {
    up: { codex: true, claude: true }, timeWait: 100,
    async provider(agent) { return this.up[agent]; },
    async check(agents) {
      const providers = Object.fromEntries(agents.map((agent) => [agent, this.up[agent]]));
      const ports = this.timeWait < 10_000;
      const reasons = [...(ports ? [] : ['portas']), ...agents.filter((agent) => !providers[agent]).map((agent) => 'sem ' + agent)];
      return { ports, timeWait: this.timeWait, providers, reasons };
    }
  };
}

test('agente cai com o provedor fora do ar: falha de rede, tentativa não contada e nada novo começa', async () => {
  const health = fakeHealth();
  const { orchestrator, runner, calls, logs } = fixture({ maxAttempts: 1, health });
  await orchestrator.tick();
  health.up.codex = false;
  runner.finish('agente-1-1', 1);
  await orchestrator.tick();
  const task = orchestrator.state.tasks[1];
  assert.equal(task.lastError.category, 'network');
  assert.equal(task.status, 'retry', 'não bloqueia mesmo com maxAttempts=1');
  assert.equal(task.attempts, 0);
  assert.equal(Date.parse(task.nextAttemptAt) - Date.parse('2026-10-16T12:00:00Z'), 600_000);
  assert.match(comments(calls, 1).at(-1), /não foi contada/);
  assert.deepEqual(orchestrator.state.pause.agents, ['claude']);
  assert.equal(logs.filter(([event]) => event === 'starts_paused').length, 1);
});

test('checagem de saúde: provedor fora segura só aquele agente; portas esgotadas seguram tudo', async () => {
  const health = fakeHealth();
  health.up.codex = false;
  const first = fixture({ health });
  await first.orchestrator.tick();
  assert.deepEqual(first.runner.launched.map((x) => x.issueNumber), [2]);

  const busy = fakeHealth();
  busy.timeWait = 16_700;
  const second = fixture({ health: busy });
  await second.orchestrator.tick();
  await second.orchestrator.tick();
  assert.equal(second.runner.launched.length, 0);
  assert.equal(second.logs.filter(([event]) => event === 'starts_paused').length, 1, 'avisa uma vez, não a cada ciclo');
  busy.timeWait = 200;
  await second.orchestrator.tick();
  assert.equal(second.runner.launched.length, 2);
  assert.ok(second.logs.some(([event]) => event === 'starts_resumed'));
});

test('disjuntor: três falhas rápidas seguidas pausam novas salas e devolvem as tentativas', async () => {
  const { orchestrator, runner, github, issue, logs, calls, advance } = fixture();
  github.issues.push(issue(3, ['codex', 'area:alunos']));
  await orchestrator.tick();
  runner.finish('agente-1-1', 1);
  runner.finish('agente-2-1', 1);
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((x) => x.issueNumber), [1, 2, 3]);
  assert.equal(orchestrator.state.tasks[1].attempts, 1);
  runner.finish('agente-3-1', 1);
  await orchestrator.tick();
  assert.ok(orchestrator.breakerOpen());
  assert.ok(logs.some(([event]) => event === 'breaker_open'));
  assert.deepEqual([1, 2, 3].map((n) => orchestrator.state.tasks[n].attempts), [0, 0, 0]);
  assert.match(comments(calls, 3).at(-1), /problema do ambiente/);
  advance(10 * 60_000);
  await orchestrator.tick();
  assert.equal(runner.launched.length, 3, 'nenhuma sala durante a pausa');
  advance(6 * 60_000);
  await orchestrator.tick();
  assert.equal(runner.launched.length, 5);
});

test('falha demorada não conta para o disjuntor', async () => {
  const { orchestrator, runner, advance } = fixture();
  await orchestrator.tick();
  advance(20 * 60_000);
  runner.finish('agente-1-1', 1);
  runner.finish('agente-2-1', 1);
  await orchestrator.tick();
  assert.deepEqual(orchestrator.state.breaker.recent, []);
  assert.equal(orchestrator.breakerOpen(), false);
});

test('área com PR aberto não recebe tarefa nova até o merge', async () => {
  const { orchestrator, runner, github, issue, advance } = fixture();
  orchestrator.config.scheduler.holdAreaWhilePrOpen = true;
  github.issues = [issue(1, ['codex', 'area:agenda'])];
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'ready');
  github.issues.push(issue(3, ['claude', 'area:agenda']), issue(4, ['codex', 'area:alunos']));
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((x) => x.issueNumber), [1, 4], 'outra área segue normalmente');
  github.pulls = [];
  github.issues = github.issues.filter((item) => item.number !== 1); // o merge fecha a issue (Closes #1)
  advance(60_000);
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'done');
  assert.deepEqual(runner.launched.map((x) => x.issueNumber), [1, 4, 3]);
});

test('sem holdAreaWhilePrOpen a área fica livre assim que o PR é aberto', async () => {
  const { orchestrator, runner, github, issue } = fixture();
  github.issues = [issue(1, ['codex', 'area:agenda'])];
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  github.issues.push(issue(3, ['claude', 'area:agenda']));
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((x) => x.issueNumber), [1, 3]);
});

test('declaração do agente: COMPLETO, INCOMPLETO com motivo e ausência de declaração', () => {
  assert.deepEqual(completionStatus('STATUS: COMPLETO\n# Resumo'), { complete: true, declared: true, reason: '' });
  assert.deepEqual(completionStatus('\n**STATUS: COMPLETO**'), { complete: true, declared: true, reason: '' });
  assert.deepEqual(completionStatus('STATUS: INCOMPLETO - falta validar no WebKit'), { complete: false, declared: true, reason: 'falta validar no WebKit' });
  assert.equal(completionStatus('Resumo').declared, false);
  assert.equal(completionStatus('# Resumo\nSTATUS: COMPLETO').complete, false, 'precisa ser a primeira linha');
  assert.equal(completionStatus('').complete, false);
  assert.match(completionStatus('').reason, /não declarou/);
});

test('solução incompleta: sem verificação nem PR, bloqueia com o motivo e guarda o trabalho', async () => {
  const { orchestrator, runner, git, github, calls } = fixture();
  runner.collected = (task) => task.issueNumber === 1
    ? { head: SHA_NEW, commits: 2, dirty: 0, bundle: '/tmp/out.bundle', summary: 'STATUS: INCOMPLETO - falta testar no Safari\nResumo', dir: '/tmp/coleta' }
    : { head: SHA_NEW, commits: 1, dirty: 0, bundle: '/tmp/out.bundle', summary: 'STATUS: COMPLETO', dir: '/tmp/coleta' };
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  const task = orchestrator.state.tasks[1];
  assert.equal(task.status, 'blocked');
  assert.equal(task.lastError.category, 'incomplete');
  assert.equal(runner.verified.filter((x) => x.issueNumber === 1).length, 0);
  assert.equal(github.created.length, 0);
  assert.ok(calls.some((x) => x[0] === 'add' && x[1] === 1 && x[2] === 'bloqueado'));
  assert.match(comments(calls, 1).at(-1), /falta testar no Safari/);
  assert.deepEqual(task.resumeFrom, { ref: 'refs/lab/issue-1/incompleto-1', sha: SHA_NEW, files: [], baseSha: SHA_BASE, incomplete: 'falta testar no Safari' });
  assert.ok(git.imported.includes('refs/lab/issue-1/incompleto-1'));
  assert.ok(!git.imported.includes('refs/lab/issue-1/falha-1'), 'não coleta duas vezes');
});

test('retirar bloqueado depois de incompleto: a próxima tentativa continua do trabalho e recebe o motivo', async () => {
  const { orchestrator, runner, git, github, issue } = fixture();
  github.issues = [issue(1, ['codex', 'area:agenda'])];
  runner.collected = () => ({ head: SHA_NEW, commits: 1, dirty: 0, bundle: '/tmp/out.bundle', summary: 'STATUS: INCOMPLETO - falta o WebKit', dir: '/tmp/coleta' });
  git.prepareInput = (task) => ({ baseSha: SHA_BASE, startSha: task.resumeFrom ? task.resumeFrom.sha : SHA_BASE, resumed: Boolean(task.resumeFrom) });
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  github.issues = [issue(1, ['codex', 'area:agenda'])];
  await orchestrator.tick();
  const retry = runner.launched.at(-1);
  assert.equal(retry.runSeq, 2);
  assert.equal(retry.resumed, true);
  const prompt = buildPrompt(retry, orchestrator.config);
  assert.match(prompt, /ficou incompleta: "falta o WebKit"/);
  assert.match(prompt, /Não crie nem altere arquivos em \.github\/workflows/);
  assert.match(prompt, /STATUS: COMPLETO/);
});

test('sem a linha STATUS o resultado não vira PR e o trabalho continua', async () => {
  const { orchestrator, runner, github } = fixture();
  runner.collected = () => ({ head: SHA_NEW, commits: 1, dirty: 0, bundle: '/tmp/out.bundle', summary: 'Resumo sem declaração', dir: '/tmp/coleta' });
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].lastError.category, 'unfinished');
  assert.match(orchestrator.state.tasks[1].resumeFrom.incomplete, /sem declarar STATUS/);
  assert.equal(github.created.length, 0);
});

test('painel: cada issue parada recebe o motivo de não estar rodando', async () => {
  const { orchestrator, github, issue } = fixture();
  orchestrator.config.scheduler.holdAreaWhilePrOpen = true;
  orchestrator.state.tasks[9] = { issueNumber: 9, agent: 'codex', areas: ['geral'], status: 'ready', prNumber: 23 };
  github.pulls = [{ number: 23, head: { ref: 'agente/codex/issue-9', sha: SHA_NEW }, base: { ref: 'main' }, mergeable: true }];
  github.issues = [
    issue(1, ['codex', 'area:agenda']), issue(2, ['claude', 'area:financeiro']),
    issue(3, ['codex', 'area:agenda']), issue(4, ['claude', 'bloqueado']),
    issue(5, ['codex', 'area:alunos'], 'depende de #4'), issue(6, ['claude']),
    issue(7, ['codex', 'area:fotos']), issue(8, []),
    issue(9, ['codex', 'pronto-para-revisao'])
  ];
  await orchestrator.tick();
  const reasons = Object.fromEntries(orchestrator.state.queue.map((q) => [q.issue, q.reason]));
  assert.equal(reasons[1], undefined, 'rodando não aparece na fila');
  assert.match(reasons[3], /área agenda ocupada pela #1/);
  assert.match(reasons[4], /bloqueada/);
  assert.match(reasons[5], /depende de #4/);
  assert.match(reasons[6], /área geral segurada pelo PR #23 \(#9\)/);
  assert.match(reasons[7], /sem vaga: 2 de 2/);
  assert.equal(reasons[8], undefined, 'sem etiqueta de agente não é do laboratório');
  assert.match(reasons[9], /PR #23 aguardando sua revisão/);
  assert.ok(orchestrator.state.queueAt);
});

test('dependência citada entre crases ou em bloco de código não conta', () => {
  const body = 'Esta é a substituição; não exigir `depende de #18`.\n```\ndepende de #7\n```\nDe verdade: depende de #3';
  assert.deepEqual(dependenciesFor({ title: 'T', body }), [3]);
});

test('agente para sem concluir mas com commits: continua sozinho, sem gastar tentativa, até o limite', async () => {
  const { orchestrator, runner, github, issue, logs, advance } = fixture({ maxAttempts: 1 });
  orchestrator.config.retry.maxContinuations = 2;
  github.issues = [issue(1, ['claude'])];
  runner.collected = () => ({ head: SHA_NEW, commits: 2, dirty: 0, bundle: '/tmp/out.bundle', summary: '', dir: '/tmp/coleta' });
  await orchestrator.tick();
  runner.finish('agente-1-1', 1);
  await orchestrator.tick();
  let task = orchestrator.state.tasks[1];
  assert.equal(task.status, 'retry');
  assert.equal(task.lastError.category, 'unfinished');
  assert.equal(task.attempts, 0);
  assert.equal(task.continuations, 1);
  assert.match(task.resumeFrom.incomplete, /parou antes de concluir \(terminou com código 1\)/);
  assert.equal(Date.parse(task.nextAttemptAt) - Date.parse('2026-10-16T12:00:00Z'), 60_000);
  assert.equal(github.created.length, 0, 'nada parcial vira PR');
  advance(61_000);
  await orchestrator.tick();
  assert.equal(runner.launched.length, 2);
  assert.equal(runner.launched[1].resumeFrom.sha, SHA_NEW);
  runner.finish('agente-1-2', 1);
  await orchestrator.tick();
  advance(61_000);
  await orchestrator.tick();
  runner.finish('agente-1-3', 1);
  await orchestrator.tick();
  task = orchestrator.state.tasks[1];
  assert.equal(task.status, 'blocked');
  assert.equal(task.lastError.category, 'incomplete');
  assert.match(task.resumeFrom.incomplete, /parou 3 vezes seguidas/);
  assert.equal(logs.filter(([event]) => event === 'task_unfinished').length, 2);
});

test('sala sem atividade é encerrada e o trabalho continua dos commits', async () => {
  const { orchestrator, runner, github, issue, logs, advance } = fixture();
  orchestrator.config.rooms.agentIdleMinutes = 25;
  github.issues = [issue(1, ['claude'])];
  let lastWrite = Date.parse('2026-10-16T12:00:00Z');
  const stops = [];
  runner.agentActivity = () => lastWrite;
  runner.stopAgent = (task) => { stops.push(task.issueNumber); return true; };
  await orchestrator.tick();
  advance(20 * 60_000);
  lastWrite += 20 * 60_000;
  await orchestrator.tick();
  advance(20 * 60_000);
  await orchestrator.tick();
  assert.deepEqual(stops, [], 'escreveu há 20 min: ainda não');
  advance(6 * 60_000);
  await orchestrator.tick();
  assert.deepEqual(stops, [1]);
  assert.ok(logs.some(([event, fields]) => event === 'agent_stopping' && /sem atividade/.test(fields.reason)));
  await orchestrator.tick();
  assert.deepEqual(stops, [1], 'pede a parada uma vez só');
  runner.collected = () => ({ head: SHA_NEW, commits: 1, dirty: 0, bundle: '/tmp/out.bundle', summary: '', dir: '/tmp/coleta' });
  runner.finish('agente-1-1', 137);
  await orchestrator.tick();
  const task = orchestrator.state.tasks[1];
  assert.equal(task.lastError.category, 'unfinished');
  assert.match(task.resumeFrom.incomplete, /25 min sem atividade/);
});

test('sala que não obedece à parada falha por tempo depois de 5 min', async () => {
  const { orchestrator, runner, advance } = fixture();
  runner.stopAgent = () => true;
  await orchestrator.tick();
  advance(121 * 60_000);
  await orchestrator.tick();
  assert.ok(!orchestrator.state.tasks[1].stopRequested);
  advance(120 * 60_000);
  await orchestrator.tick();
  assert.match(orchestrator.state.tasks[1].stopRequested.reason, /excedeu 240 min/);
  assert.equal(orchestrator.state.tasks[1].status, 'running');
  advance(6 * 60_000);
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].lastError.category, 'timeout');
});

test('instruções do agente pedem processos encerrados e commits frequentes', () => {
  const prompt = buildPrompt({ agent: 'claude', issueNumber: 1, title: 'T', body: '', branch: 'agente/claude/issue-1', baseBranch: 'main' }, { github: { owner: 'o', repo: 'r' } });
  assert.match(prompt, /nohup/);
  assert.match(prompt, /Faça commit a cada avanço/);
  assert.match(prompt, /sudo apt-get/);
  assert.doesNotMatch(prompt, /Playwright/, 'sem Playwright na instalação, sem promessa de navegadores');
  assert.doesNotMatch(prompt, /integralmente \./, 'sem arquivos para ler, sem frase vazia');
});

test('cota com e sem commits: pausa só o agente, sem tentativa, disjuntor ou continuação', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-quota-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'output.sanitized.log');
  fs.writeFileSync(file, "You've hit your usage limit. try again at 3:15 PM");
  for (const commits of [false, true]) {
    const { orchestrator, runner, git, github, issue, advance, calls } = fixture({ maxAttempts: 1 });
    github.issues = [issue(1, ['codex', 'area:a'])];
    runner.sanitizeLog = () => file;
    if (commits) runner.collected = () => ({ head: SHA_NEW, commits: 1, bundle: '/tmp/out.bundle', summary: '', dir });
    git.prepareInput = (task) => ({ baseSha: SHA_BASE, startSha: task.resumeFrom?.sha ?? SHA_BASE, resumed: Boolean(task.resumeFrom) });
    await orchestrator.tick();
    runner.finish('agente-1-1', 1);
    github.issues.push(issue(2, ['codex', 'area:b']), issue(3, ['claude', 'area:c']));
    orchestrator.state.tasks[1].continuations = 2;
    await orchestrator.tick();
    const task = orchestrator.state.tasks[1];
    assert.equal(task.status, 'retry');
    assert.equal(task.lastError.category, 'quota');
    assert.equal(task.attempts, 0);
    assert.equal(task.continuations, 2);
    assert.deepEqual(orchestrator.state.breaker.recent, []);
    assert.equal(task.nextAttemptAt, '2026-10-16T18:15:00.000Z');
    assert.equal(orchestrator.state.quota.codex.until, task.nextAttemptAt);
    assert.match(comments(calls, 1).at(-1), /18:15:00/);
    assert.deepEqual(runner.launched.map((run) => run.issueNumber), [1, 3]);
    assert.match(orchestrator.state.pause.reasons.join(), /cota do codex/);
    assert.match(orchestrator.state.queue.find((item) => item.issue === 2).reason, /cota do codex esgotada até/);
    assert.equal(Boolean(task.resumeFrom?.sha), commits);
    advance(7 * 3600_000);
    runner.finish('agente-3-1');
    await orchestrator.tick();
    assert.equal(runner.launched.filter((run) => run.issueNumber === 1).length, 2);
    assert.equal(runner.launched.find((run) => run.issueNumber === 1 && run.runSeq === 2).resumed, commits);
    assert.equal(orchestrator.state.quota.codex, undefined);
  }
});

test('duas contas do Claude: salas em paralelo e cota de uma passa o trabalho para a outra', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'output.sanitized.log');
  fs.writeFileSync(file, "You've hit your usage limit. try again at 3:15 PM");
  const { orchestrator, runner, git, github, issue, logs } = fixture({ issues: [] });
  git.prepareInput = (task) => ({ baseSha: SHA_BASE, startSha: task.resumeFrom?.sha ?? SHA_BASE, resumed: Boolean(task.resumeFrom) });
  orchestrator.config.accounts = { claude: ['claude', 'claude-2'], codex: ['codex'] };
  github.issues = [issue(1, ['claude', 'area:a']), issue(2, ['claude', 'area:b'])];
  runner.collected = () => ({ head: SHA_NEW, commits: 1, bundle: '/tmp/out.bundle', summary: '', dir });
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((run) => run.account), ['claude', 'claude-2']);
  assert.equal(logs.find(([event]) => event === 'task_started')[1].account, 'claude');

  runner.sanitizeLog = (run) => run.id === 'agente-1-1' || run.id === 'agente-2-1' ? file : null;
  runner.finish('agente-1-1', 1);
  await orchestrator.tick();
  assert.equal(orchestrator.state.quota.claude.until, '2026-10-16T18:15:00.000Z');
  assert.equal(orchestrator.state.pause, null);
  await orchestrator.tick();
  const resumed = runner.launched.find((run) => run.issueNumber === 1 && run.runSeq === 2);
  assert.equal(resumed.account, 'claude-2');
  assert.equal(resumed.resumed, true);

  runner.finish('agente-2-1', 1);
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[2].nextAttemptAt, '2026-10-16T18:15:00.000Z');
  assert.match(orchestrator.state.pause.reasons.join(), /cota do claude esgotada até 2026-10-16T18:15:00.000Z/);
});

test('verificação devolve candidato e últimas linhas sanitizadas ao agente para corrigir', async (t) => {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.test-verify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'output.sanitized.log');
  fs.writeFileSync(file, 'ok\n'.repeat(3000) + 'npm run lint falhou\n');
  const { orchestrator, runner, git, advance } = fixture();
  git.prepareInput = (task) => ({ baseSha: SHA_BASE, startSha: task.resumeFrom?.sha ?? SHA_BASE, resumed: Boolean(task.resumeFrom) });
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.sanitizeLog = () => file;
  runner.finish('verificacao-1-1', 1);
  await orchestrator.tick();
  const task = orchestrator.state.tasks[1];
  assert.equal(task.attempts, 1);
  assert.equal(task.resumeFrom.ref, task.candidateRef);
  assert.equal(task.resumeFrom.sha, SHA_NEW);
  assert.ok(task.resumeFrom.verifyFailure.length <= 6000);
  advance(301_000);
  await orchestrator.tick();
  const run = runner.launched.find((run) => run.issueNumber === 1 && run.runSeq === 2);
  assert.equal(run.startSha, SHA_NEW);
  assert.equal(run.resumed, true);
  const prompt = buildPrompt(run, orchestrator.config);
  assert.match(prompt, /verificação independente falhou/);
  assert.match(prompt, /npm run lint falhou/);
  assert.match(prompt, /todas as verificações do projeto passarem/);
  assert.equal(git.pushed.length, 0);
});

test('avisos por issue: área ausente, dependência inexistente e PR fechado sem merge', async () => {
  const { orchestrator, github, issue, runner } = fixture();
  github.issues = [issue(1, ['codex']), issue(2, ['claude']),
    issue(3, ['codex', 'area:a'], 'depende de #99'), issue(4, ['codex', 'area:b'], 'depende de #98')];
  github.others.set(98, { number: 98, state: 'closed', pull_request: { merged_at: null } });
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((run) => run.issueNumber), [1], 'aviso de área não impede a partida');
  assert.match(orchestrator.state.issueWarnings[1][0], /sem etiqueta de área.*geral.*trava/);
  const queue = new Map(orchestrator.state.queue.map((item) => [item.issue, item]));
  assert.match(queue.get(2).warnings[0], /sem etiqueta de área/);
  assert.match(queue.get(3).warnings[0], /#99 não existe/);
  assert.match(queue.get(4).warnings[0], /#98 fechada sem PR mergeado/);
});

test('disco insuficiente não abre salas novas', async () => {
  const health = fakeHealth();
  health.check = async () => ({ ports: true, disk: false, providers: { codex: true, claude: true }, reasons: ['pouco disco: 2 GB livres'] });
  const { orchestrator, runner } = fixture({ health });
  await orchestrator.tick();
  assert.equal(runner.launched.length, 0);
  assert.match(orchestrator.state.pause.reasons[0], /pouco disco/);
});

test('disco esgota durante o agente: preserva candidato e aguarda para abrir a verificação', async () => {
  const health = fakeHealth();
  const { orchestrator, runner } = fixture({ health });
  await orchestrator.tick();
  const check = health.check.bind(health);
  health.check = async (agents) => ({ ...await check(agents), disk: false, reasons: ['pouco disco: 2 GB livres'] });
  runner.finish('agente-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'collecting');
  assert.equal(orchestrator.state.tasks[1].candidateSha, SHA_NEW);
  assert.equal(runner.verified.length, 0);
  health.check = check;
  await orchestrator.tickLocal();
  assert.equal(orchestrator.state.tasks[1].status, 'verifying');
  assert.equal(runner.verified.length, 1);
});

test('avisos móveis: eventos previstos, duplicação consecutiva e uma vez por pausa', async () => {
  const { orchestrator, advance } = fixture();
  const notices = [];
  orchestrator.notify = { send: async (event, fields) => notices.push([event, fields]) };
  for (const event of ['task_blocked', 'task_ready', 'agent_stopping', 'quota']) {
    orchestrator.log(event, { issue: 1 });
    orchestrator.log(event, { issue: 1 });
  }
  orchestrator.log('breaker_open', {});
  orchestrator.log('breaker_open', {});
  orchestrator.state.quota.codex = { until: '2026-10-16T13:00:00Z', since: orchestrator.iso() };
  await orchestrator.startableAgents();
  await orchestrator.startableAgents();
  orchestrator.state.quota.claude = { until: '2026-10-16T13:00:00Z', since: orchestrator.iso() };
  await orchestrator.startableAgents();
  await Promise.resolve();
  assert.deepEqual(notices.map(([event]) => event), ['task_blocked', 'task_ready', 'agent_stopping', 'quota', 'breaker_open', 'starts_paused']);
  advance(61 * 60_000);
  await orchestrator.startableAgents();
  orchestrator.state.quota.codex = { until: '2026-10-16T15:00:00Z' };
  await orchestrator.startableAgents();
  await Promise.resolve();
  assert.equal(notices.filter(([event]) => event === 'starts_paused').length, 2);
  orchestrator.notify.send = async () => { throw new Error('falhou'); };
  orchestrator.log('task_blocked', { issue: 2 });
  await new Promise((resolve) => setImmediate(resolve));
});

test('faxina diária: guarda instante no estado e roda novamente só após 24 horas', async () => {
  const { orchestrator, logs, advance, store } = fixture();
  await orchestrator.tickLocal();
  await orchestrator.tickLocal();
  assert.equal(logs.filter(([event]) => event === 'cleanup_done').length, 1);
  assert.equal(store.state.lastCleanupAt, orchestrator.iso());
  advance(23 * 3600_000);
  await orchestrator.tickLocal();
  assert.equal(logs.filter(([event]) => event === 'cleanup_done').length, 1);
  advance(3600_000);
  await orchestrator.tickLocal();
  assert.equal(logs.filter(([event]) => event === 'cleanup_done').length, 2);
});

// Fila de pedidos de ajuste do painel, em memória.
function feedbackQueue(orchestrator) {
  const queue = {
    pending: [], removed: [],
    add(issue, text) { this.pending.push({ issue, items: [{ text, at: '2026-10-16T12:00:00.000Z', file: `/tmp/${issue}-${this.pending.length}` }] }); },
    list() { return structuredClone(this.pending); },
    remove(request) { this.removed.push(request.issue); this.pending = this.pending.filter((item) => item.issue !== request.issue); }
  };
  orchestrator.requests = queue;
  return queue;
}

// O candidato entregue ainda não está na main (senão a etapa seria dada como incorporada).
function notInMain(git, ...pairs) {
  const blocked = new Set([`${SHA_NEW}>${SHA_BASE}`, ...pairs]);
  git.isAncestor = (ancestor, descendant) => !blocked.has(`${ancestor}>${descendant}`);
  return blocked;
}

test('etapas: cada uma começa em cima da anterior sem PR próprio; o PR final fecha todas', async () => {
  const { orchestrator, runner, git, github, calls, logs, issue, advance } = fixture();
  orchestrator.config.scheduler.holdAreaWhilePrOpen = true;
  notInMain(git);
  github.issues = [
    issue(1, ['codex', 'area:x']),
    issue(2, ['claude', 'area:x'], 'depende de #1'),
    issue(3, ['codex', 'area:x'], 'Etapa final. depende de #2'),
    issue(4, ['codex', 'area:x'])
  ];
  await orchestrator.tick();
  assert.deepEqual(runner.launched.map((x) => x.issueNumber), [1], 'a #2 espera a #1 e a #4 espera a área');
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'staged');
  assert.equal(github.created.length, 0, 'etapa do meio não abre PR');
  assert.deepEqual(git.pushed.at(-1), [SHA_NEW, 'agente/codex/issue-1'], 'a branch vai ao GitHub para a próxima etapa partir dela');
  assert.ok(comments(calls, 1).some((body) => /Etapa pronta/.test(body) && body.includes('#2')));
  assert.deepEqual(logs.find(([event]) => event === 'task_staged')[1].next, [2]);
  const second = runner.launched.at(-1);
  assert.deepEqual([second.issueNumber, second.baseBranch, second.prBase, second.stack], [2, 'agente/codex/issue-1', 'main', [1]]);
  assert.match(buildPrompt(second, orchestrator.config), /etapa de uma tarefa maior/);
  assert.equal(orchestrator.state.queue.find((item) => item.issue === 4).kind, 'area', 'quem não é da cadeia continua esperando a área');

  runner.finish('agente-2-1');
  await orchestrator.tick();
  runner.finish('verificacao-2-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[2].status, 'staged');
  const third = runner.launched.at(-1);
  assert.deepEqual([third.issueNumber, third.baseBranch, third.stack], [3, 'agente/claude/issue-2', [1, 2]]);

  runner.finish('agente-3-1');
  await orchestrator.tick();
  runner.finish('verificacao-3-1');
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[3].status, 'ready');
  assert.equal(github.created.length, 1, 'um PR só');
  const [pull] = github.created;
  assert.equal(pull.base, 'main');
  assert.match(pull.body, /Closes #1\nCloses #2\nCloses #3/);
  assert.match(pull.title, /etapas #1, #2/);

  // Aprovar o PR final fecha as três issues.
  github.pulls = [];
  github.issues = [issue(4, ['codex', 'area:x'])];
  advance(60_000);
  await orchestrator.tick();
  assert.deepEqual([1, 2, 3].map((n) => orchestrator.state.tasks[n].status), ['done', 'done', 'done']);
  assert.equal(runner.launched.at(-1).issueNumber, 4, 'a área fica livre');
});

test('etapas: dependência de duas etapas pendentes espera e avisa', async () => {
  const { orchestrator, runner, github, git, issue } = fixture();
  notInMain(git);
  github.issues = [issue(1, ['codex', 'area:a']), issue(2, ['codex', 'area:b']), issue(3, ['claude', 'area:c'], 'depende de #1 e depende de #2')];
  await orchestrator.tick();
  for (const n of [1, 2]) runner.finish(`agente-${n}-1`);
  await orchestrator.tick();
  for (const n of [1, 2]) runner.finish(`verificacao-${n}-1`);
  await orchestrator.tick();
  assert.deepEqual([orchestrator.state.tasks[1].status, orchestrator.state.tasks[2].status], ['staged', 'staged']);
  assert.equal(runner.launched.some((x) => x.issueNumber === 3), false);
  assert.match(orchestrator.state.issueWarnings[3].join(' '), /mais de uma etapa/);
});

test('etapas em diamante na mesma área: a issue entra em cima da etapa que segura a área e tudo vira um PR só', async () => {
  // Mesmo formato do travamento real: 1 -> 2 -> 3 e 1 -> 4 -> 5; a 5 também depende da 3.
  const { orchestrator, runner, git, github, issue } = fixture();
  orchestrator.config.scheduler.holdAreaWhilePrOpen = true;
  notInMain(git);
  github.issues = [
    issue(1, ['codex', 'area:docs']),
    issue(2, ['codex', 'area:x'], 'depende de #1'),
    issue(3, ['codex', 'area:x'], 'depende de #2'),
    issue(4, ['codex', 'area:x'], 'depende de #1'),
    issue(5, ['codex', 'area:x'], 'depende de #4 e depende de #3')
  ];
  const run = async (n) => {
    const room = runner.launched.at(-1);
    assert.equal(room.issueNumber, n);
    runner.finish(`agente-${n}-1`);
    await orchestrator.tick();
    runner.finish(`verificacao-${n}-1`);
    await orchestrator.tick();
    return room;
  };
  await orchestrator.tick();
  await run(1);
  await run(2);
  await run(3);
  const fourth = await run(4);
  assert.deepEqual([fourth.baseBranch, fourth.stack], ['agente/codex/issue-3', [1, 2, 3]], 'a #4 não fica esperando a área segurada pela #3');
  const fifth = await run(5);
  assert.deepEqual(fifth.stack, [1, 2, 3, 4]);
  assert.equal(orchestrator.state.tasks[5].status, 'ready');
  assert.equal(github.created.length, 1, 'um PR só');
  assert.match(github.created[0].body, /Closes #1\nCloses #2\nCloses #3\nCloses #4\nCloses #5/);
});

test('ajuste pelo painel: mesmo agente, mesma branch, parte do que já fez e volta a pedir aprovação', async () => {
  const { orchestrator, runner, github, calls, logs, advance } = fixture();
  github.issues = github.issues.slice(0, 1);
  const queue = feedbackQueue(orchestrator);
  await orchestrator.tick();
  queue.add(1, 'Faltou o filtro por mês');
  runner.finish('agente-1-1');
  await orchestrator.tick();
  assert.equal(runner.launched.length, 1, 'pedido feito com a tarefa rodando espera ela ficar pronta');
  assert.equal(queue.pending.length, 1);
  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  advance(60_000);
  await orchestrator.tick();
  const revision = runner.launched.at(-1);
  assert.deepEqual([revision.revision, revision.prNumber, revision.agent, revision.branch, revision.runSeq], [true, 100, 'codex', 'agente/codex/issue-1', 2]);
  assert.equal(revision.feedback.text, 'Faltou o filtro por mês');
  const prompt = buildPrompt(revision, orchestrator.config);
  assert.match(prompt, /não recomece do zero/);
  assert.match(prompt, /Faltou o filtro por mês/);
  assert.ok(comments(calls, 100).some((body) => body.includes('> Faltou o filtro por mês')));
  assert.deepEqual(queue.removed, [1]);
  runner.finish('agente-1-2');
  await orchestrator.tick();
  runner.finish('verificacao-1-2');
  await orchestrator.tick();
  const task = orchestrator.state.tasks[1];
  assert.deepEqual([task.status, task.prNumber, task.feedback], ['ready', 100, null]);
  assert.equal(logs.filter(([event]) => event === 'task_ready').at(-1)[1].feedback, true);
  assert.ok(comments(calls, 100).some((body) => /Ajuste pedido aplicado/.test(body)));
});

test('ajuste numa etapa do meio: a seguinte termina e depois recebe a nova versão sem agente', async () => {
  const { orchestrator, runner, git, github, issue, advance } = fixture();
  const SHA_FIX = 'f'.repeat(40);
  const blocked = notInMain(git);
  github.issues = [issue(1, ['codex', 'area:a']), issue(2, ['claude', 'area:b'], 'depende de #1')];
  const queue = feedbackQueue(orchestrator);
  let headA = SHA_NEW;
  git.fetchBranch = (branch) => branch === 'agente/codex/issue-1' ? headA : SHA_BASE;
  await orchestrator.tick();
  runner.finish('agente-1-1');
  await orchestrator.tick();
  runner.finish('verificacao-1-1');
  await orchestrator.tick();
  runner.finish('agente-2-1');
  await orchestrator.tick();
  runner.finish('verificacao-2-1');
  await orchestrator.tick();
  assert.deepEqual([orchestrator.state.tasks[1].status, orchestrator.state.tasks[2].status], ['staged', 'ready']);

  queue.add(1, 'O botão está no lugar errado');
  advance(60_000);
  await orchestrator.tick();
  assert.equal(runner.launched.at(-1).issueNumber, 1);
  git.importBundle = () => SHA_FIX;
  const collected = runner.collected.bind(runner);
  runner.collected = (task) => ({ ...collected(task), head: SHA_FIX });
  blocked.add(`${SHA_FIX}>${SHA_BASE}`).add(`${SHA_FIX}>${SHA_NEW}`);
  runner.finish('agente-1-2');
  await orchestrator.tick();
  runner.finish('verificacao-1-2');
  headA = SHA_FIX;
  await orchestrator.tick();
  assert.equal(orchestrator.state.tasks[1].status, 'staged');
  const second = orchestrator.state.tasks[2];
  assert.equal(second.status, 'verifying', 'a etapa seguinte é verificada de novo com a correção');
  assert.deepEqual(git.merges.at(-1), [SHA_NEW, SHA_FIX]);
  assert.equal(second.candidateSha, SHA_MERGE);
  assert.equal(runner.launched.filter((x) => x.issueNumber === 2).length, 1, 'sem rodar o agente de novo');
  runner.finish('verificacao-2-2');
  await orchestrator.tick();
  const after = orchestrator.state.tasks[2];
  assert.deepEqual([after.status, after.prNumber], ['ready', 100]);
  assert.deepEqual(git.pushed.at(-1), [SHA_MERGE, 'agente/claude/issue-2']);
});

function retryRequests(orchestrator, issue = 1) {
  const request = { issue, items: [] };
  const removed = [];
  orchestrator.retries = { list: () => [request], remove: (r) => removed.push(r) };
  return removed;
}

test('nova tentativa manual libera espera e pausa compartilhada, preservando commits e tentativas', async () => {
  const { orchestrator: o, runner } = fixture();
  o.state.tasks[1] = { issueNumber: 1, status: 'retry', agent: 'codex', areas: ['agenda'], attempts: 2,
    branch: 'agente/codex/issue-1', candidateSha: SHA_NEW, candidateRef: 'refs/keep/1', resumeFrom: { ref: 'refs/keep/1', sha: SHA_NEW }, nextAttemptAt: '2099-01-01T00:00:00Z' };
  const breaker = o.state.breaker;
  Object.assign(breaker, { trips: 5, openUntil: '2099-01-01T00:00:00Z' });
  o.state.quota.codex = { until: '2099-01-01T00:00:00Z' };
  o.state.quota.claude = { until: '2099-01-01T00:00:00Z' };
  const removed = retryRequests(o);
  await o.tick();
  assert.equal(o.state.breaker, breaker);
  assert.equal(breaker.openUntil, null);
  assert.equal(o.state.quota.codex, undefined);
  assert.ok(o.state.quota.claude);
  assert.equal(removed.length, 1);
  assert.equal(runner.launched.length, 1);
  assert.equal(runner.launched[0].resumeFrom.ref, 'refs/keep/1');
  assert.equal(runner.launched[0].attempts, 2);
});

test('nova tentativa manual mantém checagens de saúde e não duplica sala ativa', async () => {
  const health = { check: async () => ({ ports: false, providers: {}, reasons: ['sem rede'] }) };
  const { orchestrator: o, runner } = fixture({ health });
  o.state.tasks[1] = { issueNumber: 1, status: 'retry', agent: 'codex', areas: ['agenda'], nextAttemptAt: '2099-01-01T00:00:00Z' };
  retryRequests(o);
  await o.tick();
  assert.equal(runner.launched.length, 0);
  assert.deepEqual(o.state.pause.reasons, ['sem rede']);
  o.state.tasks[1].status = 'running';
  o.state.breaker.openUntil = '2099-01-01T00:00:00Z';
  o.applyRetries(new Map([[1, {}]]));
  assert.equal(o.state.breaker.openUntil, '2099-01-01T00:00:00Z');
  assert.equal(o.state.tasks[1].status, 'running');
});

test('issue bloqueada que foi apagada ou fechada no GitHub deixa de esperar', async () => {
  const events = [];
  const state = { version: 1, tasks: {
    6: { issueNumber: 6, agent: 'codex', status: 'blocked', areas: ['geral'] },
    9: { issueNumber: 9, agent: 'codex', status: 'blocked', areas: ['geral'] },
    12: { issueNumber: 12, agent: 'codex', status: 'retry', areas: ['geral'], nextAttemptAt: '2999-01-01T00:00:00Z' },
    14: { issueNumber: 14, agent: 'codex', status: 'blocked', areas: ['geral'] }
  } };
  const answers = { 6: { status: 410 }, 9: { state: 'closed' }, 12: { status: 404 }, 14: { status: 502 } };
  const orchestrator = new Orchestrator({
    config: {
      labels: { agents: ['codex', 'claude'], inProgress: 'em-andamento', blocked: 'bloqueado', readyForReview: 'pronto-para-revisao', areaPrefix: 'area:' },
      scheduler: { maxConcurrency: 1, defaultArea: 'geral' }, retry: { baseSeconds: 1, maxSeconds: 1, maxAttempts: 1 }, rooms: { branchPrefix: 'agente' }
    },
    github: {
      listOpenIssues: async () => [], listOpenPulls: async () => [], repository: async () => ({ default_branch: 'main' }),
      async getIssue(number) { const a = answers[number]; if (a.status) throw Object.assign(new Error('x'), { status: a.status }); return a; }
    },
    runner: {}, git: {},
    store: { load: () => state, save() {} },
    log: (event, fields) => events.push([event, fields?.issue])
  });
  await orchestrator.tick();
  const status = Object.fromEntries(Object.values(orchestrator.state.tasks).map((t) => [t.issueNumber, t.status]));
  assert.deepEqual(status, { 6: 'done', 9: 'done', 12: 'done', 14: 'blocked' }, 'erro passageiro do GitHub não encerra');
  assert.deepEqual(events.filter(([e]) => e === 'task_dropped').map(([, n]) => n), [6, 9, 12]);
});
