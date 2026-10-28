import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
// Só as funções de desenho (sem DOM, avisos ou temporizadores).
const views = script.slice(script.indexOf('const TABS ='), script.indexOf('// ---------- Avisos no celular'));

// O script declara `let data`; o teste carrega as funções e depois injeta os dados.
function context(data) {
  const ctx = vm.createContext({ __data: data });
  vm.runInContext(views, ctx);
  vm.runInContext('data = __data', ctx);
  return ctx;
}

test('painel: JavaScript válido e rótulos das novas falhas e eventos', () => {
  new vm.Script(script);
  new vm.Script(fs.readFileSync(new URL('../dashboard/sw.js', import.meta.url), 'utf8'));
  const constants = html.slice(html.indexOf('const FAIL ='), html.indexOf('const ACTIVE ='));
  const { FAIL, EVENT } = vm.runInNewContext(`${constants}; ({ FAIL, EVENT })`);
  assert.match(FAIL.quota, /Cota/);
  assert.match(EVENT.quota, /Cota/);
  assert.match(EVENT.cleanup_done, /Faxina/);
});

const base = {
  repo: 'dono/repo', preview: null, push: { subscribers: 0 }, runs: [], ticks: [],
  controller: { maxConcurrency: 2, agents: ['codex', 'claude'], issueWarnings: { 1: ['sem área <teste>'] }, queue: [
    { issue: 2, title: 'Fila <b>', agent: 'codex', kind: 'dependency', reason: 'aguardando #1', warnings: ['dependência inexistente'] }
  ] },
  tasks: [
    { issue: 1, title: 'Ativa <script>', agent: 'claude', status: 'running', startedAt: '2026-10-17T10:00:00Z', runSeq: 1 },
    { issue: 3, title: 'Pronta', agent: 'codex', status: 'ready', prNumber: 9, startedAt: '2026-10-17T09:00:00Z', readyAt: '2026-10-17T09:30:00Z', previewable: true }
  ],
  events: [{ time: '2026-10-17T10:00:00Z', event: 'task_started', issue: 1, agent: 'claude' }]
};

test('painel Agora: cards ao vivo, avisos, fila e aprovação, sempre escapando HTML', () => {
  const ctx = context(base);
  vm.runInContext(`live = { 1: { phase: 'agente', steps: 3, lastAt: Date.now(), saying: { at: Date.now(), text: 'rodando <testes>' },
    thinking: null, doing: { at: Date.now(), text: '$ npm test' }, items: [] } }`, ctx);
  const view = vm.runInContext('viewAgora()', ctx);
  assert.match(view, /Avisos das issues/);
  assert.match(view, /sem área &lt;teste&gt;/);
  assert.match(view, /dependência inexistente/);
  assert.match(view, /Ativa &lt;script&gt;/);
  assert.match(view, /rodando &lt;testes&gt;/);
  assert.match(view, /\$ npm test/);
  assert.match(view, /Revisar PR #9/);
  assert.match(view, /data-preview="abrir" data-issue="3"/);
  assert.doesNotMatch(view, /<teste>|<script>|<testes>|Fila <b>/);
});

test("painel Agora: avisos das issues e da fila ficam em listas que abrem e fecham", () => {
  const view = vm.runInContext("viewAgora()", context(base));
  assert.match(view, /<details class="fold" data-key="avisos" data-remember><summary class="section-head"><h2>Avisos das issues<\/h2><span class="n">1<\/span>/);
  assert.match(view, /<details class="warns" data-key="av-2" data-remember><summary class="s-warn">⚠ 1 aviso\(s\)<\/summary>/);
  assert.doesNotMatch(view, /<details class="fold"[^>]* open/);
});

test('painel: o HTML não muda entre dois desenhos sem dados novos (a tela não pisca nem perde a rolagem)', () => {
  const ctx = context(base);
  for (const view of ['viewAgora', 'viewTarefas', 'viewExecucoes', 'viewEventos']) {
    const first = vm.runInContext(`${view}()`, ctx);
    const second = vm.runInContext(`${view}()`, ctx);
    assert.equal(first, second, view);
  }
});

test('painel Execuções: a mais recente primeiro, pela hora de início', () => {
  const run = (issue, seq, started) => ({ id: `codex-issue-${issue}/execucao-${seq}`, agent: 'codex', issue, seq,
    phases: { agente: { started, ended: started + 1000, exitCode: 0, files: [] } } });
  const ctx = context({ ...base, runs: [run(30, 1, 1000), run(5, 2, 9000), run(12, 1, 5000)] });
  const view = vm.runInContext('viewExecucoes()', ctx);
  const order = [...view.matchAll(/#(\d+) · execução/g)].map((m) => Number(m[1]));
  assert.deepEqual(order, [5, 12, 30]);
});

test('painel Salas: nomes e estados em português', () => {
  const ctx = context({ ...base, preview: { issue: 3, state: 'pronta' } });
  vm.runInContext(`roomsData = { containers: [
    { name: 'lab-codex-previa-agent', room: 'lab-codex-previa', state: 'exited', status: 'Exited (255) About an hour ago' },
    { name: 'lab-claude-issue-1-agent', room: 'lab-claude-issue-1', state: 'running', status: 'Up 5 minutes', cpu: '12%', memPerc: '10%' }
  ] }`, ctx);
  const view = vm.runInContext('viewSalas()', ctx);
  assert.match(view, /Prévia de PR · #3/);
  assert.match(view, /desligado há cerca de 1 hora/);
  assert.match(view, /A prévia caiu/);
  assert.match(view, /Sala de trabalho · #1/);
  assert.match(view, /ligado há 5 min/);
});

test("painel: etapa pronta e pedido de ajuste aparecem nos cartões, com o texto escapado", () => {
  const tasks = [
    { issue: 4, title: "Etapa 1", agent: "codex", status: "staged", stack: [], nextStages: [5], stagedAt: "2026-10-17T09:40:00Z", previewable: true, pendingFeedback: [] },
    { issue: 5, title: "Etapa 2", agent: "claude", status: "ready", prNumber: 12, stack: [4], readyAt: "2026-10-17T10:00:00Z", startedAt: "2026-10-17T09:41:00Z", previewable: true,
      pendingFeedback: [{ text: "faltou o <filtro>", at: "2026-10-17T10:05:00Z" }] },
    { issue: 6, title: "Ajustando", agent: "codex", status: "running", revision: true, feedback: { text: "botão <errado>", at: "2026-10-17T10:06:00Z" }, startedAt: "2026-10-17T10:06:00Z", stack: [] }
  ];
  const ctx = context({ ...base, tasks });
  const view = vm.runInContext("viewAgora()", ctx);
  assert.match(view, /Etapas prontas \(seguem sozinhas\)/);
  assert.match(view, /segue para <a[^>]*>#5/);
  assert.match(view, /etapa 2/);
  assert.match(view, /Inclui as etapas <a[^>]*>#4<\/a>: aprovar este PR conclui todas/);
  assert.match(view, /data-ajuste="enviar" data-issue="4"/);
  assert.match(view, /Ajuste enviado/);
  assert.match(view, /faltou o &lt;filtro&gt;/);
  assert.match(view, /data-ajuste="cancelar" data-issue="5"/);
  assert.match(view, /Aplicando seu ajuste/);
  assert.match(view, /botão &lt;errado&gt;/);
  assert.doesNotMatch(view, /<filtro>|<errado>/);
});

test('painel multiprojeto: mesma issue usa links, detalhes, prévia e rascunhos separados', () => {
  const projects = [{ id: 'alpha', owner: 'dono1', repo: 'repo1' }, { id: 'beta', owner: 'dono2', repo: 'repo2' }];
  const tasks = projects.map((p) => ({ ...base.tasks[1], project: p.id, issue: 5, title: `Tarefa ${p.id}`, previewLogins: `Login ${p.id} <teste>` }));
  const ctx = context({ ...base, projects, tasks, preview: { project: 'beta', issue: 5, state: 'pronta', url: 'http://127.0.0.1/' } });
  const view = vm.runInContext('viewAgora()', ctx);
  assert.match(view, /github.com\/dono1\/repo1\/issues\/5/);
  assert.match(view, /github.com\/dono2\/repo2\/pull\/9/);
  assert.match(view, /data-task="alpha:5"/); assert.match(view, /data-task="beta:5"/);
  assert.match(view, /data-draft="alpha:5"/); assert.match(view, /data-draft="beta:5"/);
  assert.match(view, /Login beta &lt;teste&gt;/); assert.doesNotMatch(view, /Login alpha/);
  const detail = vm.runInContext("taskDetail('beta:5')", ctx);
  assert.match(detail, /beta/); assert.match(detail, /github.com\/dono2\/repo2\/issues\/5/);
  assert.doesNotMatch(detail, /dono1\/repo1/);
});

test('painel multiprojeto: salas reconhecem projeto, agente e número', () => {
  const ctx = context(base);
  const info = vm.runInContext("roomInfo('lab-codex-alpha-verify-5')", ctx);
  assert.equal(info.project, 'alpha'); assert.equal(info.issue, 5); assert.equal(info.kind, 'verificacao');
});

test('Projetos: estados, ações, instruções, origem e HTML escapado, sem redesenho desnecessário', () => {
  const statuses = ['verificando-acesso', 'sem-acesso', 'precisa-configuracao', 'configurando', 'construindo-imagem', 'pronto', 'pausado', 'erro'];
  const projects = statuses.map((status, i) => ({ id: `p${i}`, owner: 'dono', repo: `repo${i}`, status, detail: '<script>segredo</script>', enabled: status !== 'pausado', configurationSource: ['repositorio', 'laboratorio', 'partida'][i % 3] }));
  const ctx = context({ ...base, projects });
  const view = vm.runInContext('viewProjetos()', ctx);
  assert.equal(view, vm.runInContext('viewProjetos()', ctx));
  for (const label of ['Verificando acesso', 'Sem acesso', 'Precisa de configuração', 'Configuração em andamento', 'Construindo a imagem', 'Pronto', 'Pausado', 'Precisa de você', 'Retomar', 'Gerar configuração', 'Verificar de novo']) assert.ok(view.includes(label), label);
  for (const label of ['do repositório', 'do laboratório', 'de partida', 'Repository access', 'Contents', 'Pull requests', 'Metadata', 'Add a README']) assert.ok(view.includes(label), label);
  assert.match(view, /&lt;script&gt;segredo&lt;\/script&gt;/); assert.doesNotMatch(view, /<script>/);
  assert.match(view, /settings\/personal-access-tokens/);
});

test('filtro por projeto atua em Agora, Tarefas e Eventos', () => {
  const projects = [{ id: 'alpha', repo: 'a' }, { id: 'beta', repo: 'b' }];
  const tasks = projects.map((p) => ({ ...base.tasks[0], project: p.id, title: `EXCLUSIVO_${p.id}` }));
  const events = projects.map((p) => ({ time: '2026-10-17T10:00:00Z', event: 'task_started', project: p.id, issue: 1 }));
  const ctx = context({ ...base, projects, tasks, events });
  vm.runInContext("filterProject = 'beta'", ctx);
  for (const fn of ['viewAgora', 'viewTarefas', 'viewEventos']) {
    const view = vm.runInContext(`${fn}()`, ctx);
    assert.match(view, /EXCLUSIVO_beta/); assert.doesNotMatch(view, /EXCLUSIVO_alpha/);
  }
  assert.match(vm.runInContext('projectFilters()', ctx), /Todos/);
  vm.runInContext("filterProject = ''", ctx);
  assert.match(vm.runInContext('viewTarefas()', ctx), /EXCLUSIVO_alpha/);
});

test('cadastro sugere ID livre inclusive entre removidos e normaliza URL colada', () => {
  const ctx = context({ ...base, projects: [], projectIds: ['meurepo', 'meurepo1'] });
  assert.equal(vm.runInContext("suggestId('Meu-Repo')", ctx), 'meurepo2');
  const parsed = vm.runInContext("repositoryInput('https://github.com/dono/Meu-Repo.git/')", ctx);
  assert.equal(parsed.owner, 'dono'); assert.equal(parsed.repo, 'Meu-Repo');
  assert.throws(() => vm.runInContext("repositoryInput('https://github.com/../repo')", ctx));
});

test('painel: botão de nova tentativa nos cards em espera, com estado pendente', () => {
  const task = { issue: 16, project: 'casal', title: 'Agenda', status: 'retry', agent: 'codex' };
  const ctx = context({ ...base, tasks: [task] });
  for (const fn of ['problemCard', 'taskCard']) {
    const view = vm.runInContext(`${fn}(data.tasks[0])`, ctx);
    assert.match(view, /data-retry data-issue="16" data-project="casal"/);
    assert.match(view, /Tentar novamente/);
  }
  vm.runInContext('data.tasks[0].retryPending = true', ctx);
  assert.match(vm.runInContext('problemCard(data.tasks[0])', ctx), /disabled>Nova tentativa solicitada/);
  vm.runInContext("data.tasks[0].status = 'running'", ctx);
  assert.doesNotMatch(vm.runInContext('taskCard(data.tasks[0])', ctx), /data-retry/);
  vm.runInContext("data.tasks[0].status = 'blocked'", ctx);
  assert.doesNotMatch(vm.runInContext('problemCard(data.tasks[0])', ctx), /data-retry/);
});

test('linha do tempo da execução nunca sai da barra', () => {
  const ctx = context(base);
  const now = Date.now();
  const html = vm.runInContext(`runTimeline(${JSON.stringify({ phases: { agente: { started: now - 3600000, ended: now - 3000000 }, verificacao: { started: now - 2900000, ended: now + 99999999 } } })})`, ctx);
  for (const [, left, width] of html.matchAll(/left:([\d.]+)%;width:([\d.]+)%/g)) assert.ok(Number(left) + Number(width) <= 100.0001, html);
});

test('painel Agora: estado de cada conta (livre, salas, cota esgotada)', () => {
  const view = vm.runInContext('viewAgora()', context({ ...base, controller: { ...base.controller, accounts: [
    { agent: 'claude', account: 'claude', rooms: 1, quotaUntil: null },
    { agent: 'claude', account: 'claude-2', rooms: 0, quotaUntil: '2026-10-20T15:00:00Z' },
    { agent: 'codex', account: 'codex', rooms: 0, quotaUntil: null }
  ] } }));
  assert.match(view, />Claude 1<\/span><span class="s-info">1 sala\(s\)</);
  assert.match(view, />Claude 2<\/span><span class="s-bad">cota esgotada até /);
  assert.match(view, />Codex<\/span><span class="s-ok">livre</);
});

test('painel: só o body corta a rolagem lateral (no html também, a barra de abas solta no iPhone)', () => {
  const css = html.slice(html.indexOf('<style'), html.indexOf('</style>'));
  assert.doesNotMatch(css, /(^|\n)html \{[^}]*overflow/);
  assert.match(css, /(^|\n)body \{[^}]*overflow-x: hidden/);
});

test('painel abre com o último retrato guardado sem alarme falso de controlador parado', () => {
  const ctx = context(base);
  vm.runInContext("lastOk = Date.now() - 600000; data.controller = { ...data.controller, enabled: true, service: 'inactive' }; stale = true", ctx);
  const views = vm.runInContext('(stale ? "" : stoppedAlert())', ctx);
  assert.equal(views, '');
  vm.runInContext('stale = false', ctx);
  assert.match(vm.runInContext('stoppedAlert()', ctx), /controlador está parado/);
});
