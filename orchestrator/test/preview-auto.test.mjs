import test from 'node:test';
import assert from 'node:assert/strict';
import { previewPlan } from '../src/preview-auto.mjs';

const sha = (n) => String(n).repeat(40).slice(0, 40);
const ready = (issueNumber, n, readyAt, status = 'ready') => ({ issueNumber, status, candidateRef: `refs/lab/${issueNumber}`, candidateSha: sha(n), readyAt });
const projects = (tasks, preview = true) => [{ id: 'eq', preview, tasks: Object.fromEntries(tasks.map((t) => [t.issueNumber, t])) }];

test('prévia automática sobe para o PR pronto mais recente', () => {
  const list = projects([ready(1, 1, '2026-10-21T10:00:00Z'), ready(2, 2, '2026-10-21T11:00:00Z'), ready(3, 3, '2026-10-21T12:00:00Z', 'staged')]);
  assert.deepEqual(previewPlan(null, list), { start: { project: 'eq', issue: 2, sha: sha(2) } });
  assert.equal(previewPlan(null, projects([ready(1, 1)], false)), null, 'projeto sem prévia configurada');
});

test('prévia automática derruba quando o PR é mergeado, bloqueado ou recebe commit novo, e respeita a válida', () => {
  const saved = { project: 'eq', issue: 1, sha: sha(1), state: 'pronta' };
  assert.equal(previewPlan(saved, projects([ready(1, 1), ready(2, 2, '2026-10-21T12:00:00Z')])), null, 'não troca prévia válida');
  for (const status of ['done', 'blocked', 'retry', 'running']) assert.deepEqual(previewPlan(saved, projects([ready(1, 1, null, status)])), { stop: true });
  assert.deepEqual(previewPlan(saved, projects([ready(1, 5)])), { stop: true }, 'commit novo no PR');
  assert.deepEqual(previewPlan(saved, projects([])), { stop: true }, 'tarefa sumiu');
  assert.equal(previewPlan({ ...saved, state: 'preparando' }, projects([])), null, 'não interrompe a que está subindo');
});

test('prévia automática não insiste no que falhou nem no que a pessoa parou', () => {
  const declined = new Set();
  const list = projects([ready(1, 1, '2026-10-21T12:00:00Z'), ready(2, 2, '2026-10-21T10:00:00Z')]);
  assert.deepEqual(previewPlan({ project: 'eq', issue: 1, sha: sha(1), state: 'erro' }, list, declined).start.issue, 2);
  declined.add(`eq:2:${sha(2)}`);
  assert.equal(previewPlan(null, list, declined), null);
});
