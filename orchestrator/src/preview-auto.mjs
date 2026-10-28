// Prévia automática: sobe para o PR pronto mais recente e derruba a que não serve mais (PR mergeado, fechado,
// bloqueado ou com commit novo). Não troca uma prévia válida por outra e não insiste no que falhou nem no que
// a pessoa parou pelo botão (declined guarda projeto:issue:sha).
export const previewKey = (project, issue, sha) => `${project}:${issue}:${sha}`;

export function previewPlan(saved, projects, declined = new Set()) {
  if (saved && saved.state === 'preparando') return null;
  if (saved && saved.state === 'erro') declined.add(previewKey(saved.project, saved.issue, saved.sha));
  else if (saved) {
    const task = projects.find((p) => p.id === saved.project)?.tasks?.[String(saved.issue)];
    const valid = task && ['ready', 'staged'].includes(task.status) && task.candidateSha === saved.sha;
    return valid ? null : { stop: true };
  }
  const next = projects.filter((p) => p.preview).flatMap((p) => Object.values(p.tasks ?? {})
    .filter((t) => t.status === 'ready' && t.candidateRef && /^[0-9a-f]{40}$/.test(t.candidateSha ?? '') &&
      !declined.has(previewKey(p.id, t.issueNumber, t.candidateSha)))
    .map((t) => ({ project: p.id, issue: t.issueNumber, sha: t.candidateSha, at: Date.parse(t.readyAt ?? '') || 0 })))
    .sort((a, b) => b.at - a.at)[0];
  return next ? { start: { project: next.project, issue: next.issue, sha: next.sha } } : null;
}
