import test from 'node:test';
import assert from 'node:assert/strict';
import { areasFor, dependenciesFor, explainWaiting, dependencyCycles, needsRevision, retryDelayMs, selectCandidates } from '../src/domain.mjs';

const config = {
  labels: { agents: ['codex', 'claude'], inProgress: 'em-andamento', blocked: 'bloqueado', readyForReview: 'pronto-para-revisao', areaPrefix: 'area:' },
  scheduler: { maxConcurrency: 2, hardMaxConcurrency: 3, defaultArea: 'geral' },
  retry: { baseSeconds: 300, maxSeconds: 3600 }
};
const issue = (number, labels, body = '') => ({ number, title: `Issue ${number}`, body, state: 'open', labels: labels.map((name) => ({ name })) });
const all = () => true;

test('extrai dependencias sem duplicar', () => {
  assert.deepEqual(dependenciesFor(issue(3, ['codex'], 'Depende de #1 e depende de #2; DEPENDE DE #1')), [1, 2]);
});

test('respeita dependencias, concorrencia e trava de area', () => {
  const issues = [
    issue(1, ['codex', 'area:agenda']),
    issue(2, ['claude', 'area:agenda']),
    issue(3, ['claude', 'area:financeiro'], 'depende de #9'),
    issue(4, ['claude', 'area:alunos'])
  ];
  const selected = selectCandidates(issues, config, { tasks: {} }, (n) => n === 9);
  assert.deepEqual(selected.map((x) => x.issue.number), [1, 3]);
});

test('trava todas as areas da issue, nao so a primeira', () => {
  assert.deepEqual(areasFor(issue(1, ['codex', 'area:Agenda', 'area:financeiro']), config), ['agenda', 'financeiro']);
  const state = { tasks: { 1: { issueNumber: 1, status: 'running', areas: ['agenda', 'financeiro'] } } };
  const selected = selectCandidates([issue(2, ['claude', 'area:financeiro']), issue(3, ['codex', 'area:alunos'])], config, state, all);
  assert.deepEqual(selected.map((x) => x.issue.number), [3]);
});

test('ignora bloqueada, em andamento e pronta', () => {
  const issues = [
    issue(1, ['codex', 'bloqueado']), issue(2, ['claude', 'em-andamento']),
    issue(3, ['codex', 'pronto-para-revisao'])
  ];
  assert.equal(selectCandidates(issues, config, { tasks: {} }, all).length, 0);
});

test('com as duas etiquetas vai para o agente menos ocupado por conta', () => {
  const both = (number, area) => issue(number, ['codex', 'claude', `area:${area}`]);
  const three = { ...config, scheduler: { ...config.scheduler, maxConcurrency: 3 }, accounts: { claude: ['claude', 'claude-2'], codex: ['codex'] } };
  const pick = (tasks, issues, allow = all) => selectCandidates(issues, three, { tasks }, all, Date.now(), allow).map((x) => `${x.issue.number}:${x.agent}`);
  assert.deepEqual(pick({}, [both(1, 'a'), both(2, 'b'), both(3, 'c')]), ['1:codex', '2:claude', '3:claude']);
  const running = { 9: { issueNumber: 9, agent: 'codex', status: 'running', areas: ['z'] } };
  assert.deepEqual(pick(running, [both(1, 'a'), both(2, 'b')]), ['1:claude', '2:claude']);
  assert.deepEqual(pick({}, [both(1, 'a')], (agent) => agent === 'claude'), ['1:claude']);
  // Nova tentativa fica com o agente de antes (a branch dele), se ainda puder.
  const retry = { 1: { issueNumber: 1, agent: 'claude', status: 'retry', areas: ['a'] } };
  assert.deepEqual(selectCandidates([both(1, 'a')], three, { tasks: retry }, all).map((x) => [x.agent, x.resetBranch]), [['claude', false]]);
});

test('fila explica issue com as duas etiquetas sem chamar de erro', () => {
  const state = { tasks: {}, quota: { codex: { until: '2999-01-01T00:00:00Z' } } };
  const [item] = explainWaiting([issue(1, ['codex', 'claude', 'area:a'])], config, state, all);
  assert.equal(item.kind, 'next');
  state.quota.claude = { until: '2998-01-01T00:00:00Z' };
  assert.match(explainWaiting([issue(1, ['codex', 'claude', 'area:a'])], config, state, all)[0].reason, /cota do codex e do claude esgotada até 2998/);
});

test('tarefa local pronta ou ativa nao reinicia mesmo sem as etiquetas remotas', () => {
  const state = { tasks: { 1: { issueNumber: 1, status: 'ready' }, 2: { issueNumber: 2, status: 'delivering' } } };
  assert.equal(selectCandidates([issue(1, ['codex']), issue(2, ['claude'])], config, state, all).length, 0);
});

test('limita retry exponencial e detecta PR para revisao', () => {
  assert.equal(retryDelayMs(1, config), 300_000);
  assert.equal(retryDelayMs(9, config), 3_600_000);
  assert.equal(needsRevision({ mergeable: false }, { status: 'ahead', behind_by: 0 }), true);
  assert.equal(needsRevision({ mergeable: true }, { status: 'behind' }), true);
  assert.equal(needsRevision({ mergeable: true }, { status: 'ahead', behind_by: 0 }), false);
});

test('PR com commits proprios e base mais nova volta como ahead com behind_by', () => {
  assert.equal(needsRevision({ mergeable: true, mergeable_state: 'behind' }, { status: 'ahead', ahead_by: 3, behind_by: 2 }), true);
  assert.equal(needsRevision({ mergeable: true, mergeable_state: 'dirty' }, { status: 'ahead', behind_by: 0 }), true);
});

test('retry vencido volta mesmo se a limpeza remota da etiqueta ficou pendente', () => {
  const pending = issue(7, ['codex', 'em-andamento', 'area:agenda']);
  const state = { tasks: { 7: { issueNumber: 7, agent: 'codex', status: 'retry', nextAttemptAt: '2026-01-01T00:00:00.000Z' } } };
  assert.deepEqual(selectCandidates([pending], config, state, all, Date.parse('2026-01-02T00:00:00Z')).map((x) => x.issue.number), [7]);
});

test('retry de revisao preserva agente e PR mesmo com etiquetas alteradas', () => {
  const changed = issue(5, ['codex', 'pronto-para-revisao']);
  const state = { tasks: { 5: { issueNumber: 5, agent: 'claude', status: 'retry', revision: true, prNumber: 44, nextAttemptAt: '2026-01-01T00:00:00.000Z' } } };
  const [item] = selectCandidates([changed], config, state, all, Date.parse('2026-01-02T00:00:00Z'));
  assert.deepEqual([item.agent, item.revision, item.prNumber], ['claude', true, 44]);
});

test('retry comum com troca de etiqueta de agente usa o novo agente em branch nova', () => {
  const state = { tasks: { 6: { issueNumber: 6, agent: 'claude', status: 'retry', nextAttemptAt: '2026-01-01T00:00:00.000Z' } } };
  const [item] = selectCandidates([issue(6, ['codex'])], config, state, all, Date.parse('2026-01-02T00:00:00Z'));
  assert.deepEqual([item.agent, item.resetBranch], ['codex', true]);
});

test('detecta ciclos de dependencia', () => {
  const cycles = dependencyCycles([issue(1, [], 'depende de #2'), issue(2, [], 'depende de #3'), issue(3, [], 'depende de #1'), issue(4, [], 'depende de #1')]);
  assert.deepEqual([...cycles].sort(), [1, 2, 3]);
});
