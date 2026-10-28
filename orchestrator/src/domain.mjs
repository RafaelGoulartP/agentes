import { accountsFor, agentQuotaUntil } from './accounts.mjs';
// Estados que ocupam uma sala (e, portanto, uma vaga de concorrência).
export const SLOT_STATUSES = new Set(['starting', 'running', 'collecting', 'verifying']);
// Estados que o controlador ainda precisa avançar.
export const ACTIVE_STATUSES = new Set([...SLOT_STATUSES, 'delivering']);

export function labelNames(issue) {
  return (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name);
}

// Etiquetas de agente da issue. Com as duas (codex e claude), qualquer um pode pegar: vai para o menos ocupado.
export function agentChoices(issue, config) {
  return config.labels.agents.filter((name) => labelNames(issue).includes(name));
}

export function agentFor(issue, config) {
  const found = agentChoices(issue, config);
  return found.length === 1 ? found[0] : null;
}

function labelAreas(issue, config) {
  const prefix = config.labels.areaPrefix;
  return labelNames(issue)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length).trim().toLowerCase())
    .filter(Boolean);
}

// Todas as áreas da issue são travadas; sem etiqueta de área usa-se a área padrão.
export function areasFor(issue, config) {
  const areas = labelAreas(issue, config);
  return areas.length ? [...new Set(areas)].sort() : [config.scheduler.defaultArea];
}

export function taskAreas(task) {
  return task.areas ?? (task.area ? [task.area] : []);
}

export function dependenciesFor(issue) {
  // Trechos de código (`...` e blocos ```) são citação, não declaração: "não exigir `depende de #18`" não conta.
  const text = `${issue.title ?? ''}\n${issue.body ?? ''}`.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = new Set();
  const expression = /\bdepende\s+de\s+#(\d+)\b/giu;
  for (const match of text.matchAll(expression)) found.add(Number(match[1]));
  return [...found];
}

// Issues abertas que dependem, direta ou indiretamente, de si mesmas.
export function dependencyCycles(issues) {
  const graph = new Map(issues.map((issue) => [issue.number, dependenciesFor(issue)]));
  const inCycle = new Set();
  for (const start of graph.keys()) {
    const seen = new Set();
    const stack = [...graph.get(start)];
    while (stack.length) {
      const number = stack.pop();
      if (number === start) { inCycle.add(start); break; }
      if (seen.has(number) || !graph.has(number)) continue;
      seen.add(number);
      stack.push(...graph.get(number));
    }
  }
  return inCycle;
}

// Dependências diretas e indiretas de uma issue, seguindo as issues abertas.
export function dependencyClosure(issue, issues) {
  const graph = new Map(issues.map((item) => [item.number, dependenciesFor(item)]));
  const seen = new Set();
  const stack = [...dependenciesFor(issue)];
  while (stack.length) {
    const number = stack.pop();
    if (seen.has(number) || number === issue.number) continue;
    seen.add(number);
    stack.push(...(graph.get(number) ?? []));
  }
  return seen;
}

// Tarefa com PR aberto aguardando revisão humana (ou revisão automática pendente).
export function hasOpenPull(task) {
  return Boolean(task.prNumber) && (task.status === 'ready' || (task.revision && ['retry', 'blocked'].includes(task.status)));
}

// Trabalho entregue que ainda não está na main: PR aberto ou etapa pronta (branch verificada sem PR próprio,
// que entra no PR da última etapa). Segura a área para issues que não fazem parte da mesma cadeia.
export function holdsArea(task) {
  if (hasOpenPull(task)) return true;
  return task.status === 'staged' || (Boolean(task.revision) && Boolean(task.stagedAt) && ['retry', 'blocked'].includes(task.status));
}

export function selectCandidates(issues, config, state, isDependencySatisfied, now = Date.now(), allowAgent = () => true) {
  const tasks = state.tasks ?? {};
  const active = Object.values(tasks).filter((task) => SLOT_STATUSES.has(task.status));
  const occupiedAreas = new Set(active.flatMap(taskAreas));
  // Com holdAreaWhilePrOpen, uma área com PR aberto não recebe tarefa nova: dois PRs da mesma área quase
  // sempre conflitam, e o segundo só nasce depois do merge do primeiro. A própria issue do PR não se bloqueia.
  const heldAreas = new Map();
  if (config.scheduler.holdAreaWhilePrOpen) {
    for (const task of Object.values(tasks).filter(holdsArea)) {
      for (const area of taskAreas(task)) heldAreas.set(area, [...(heldAreas.get(area) ?? []), task.issueNumber]);
    }
  }
  // Etapas da mesma cadeia ("depende de") não se seguram: a seguinte é construída em cima da anterior.
  // Nem as etapas que a issue vai levar junto ao empilhar.
  const held = (area, issue) => {
    const chain = dependencyClosure(issue, issues);
    const stack = isDependencySatisfied.stackChain?.(issue) ?? new Set();
    return (heldAreas.get(area) ?? []).some((holder) => holder !== issue.number && !chain.has(holder) && !stack.has(holder));
  };
  let slots = config.scheduler.maxConcurrency - active.length;
  const selected = [];
  // Issue com as duas etiquetas: o agente com menos salas por conta. Numa nova tentativa, o mesmo de antes
  // (continua a branch dele), se ainda puder começar.
  const load = new Map();
  for (const task of active) load.set(task.agent, (load.get(task.agent) ?? 0) + 1);
  const busy = (agent) => (load.get(agent) ?? 0) / accountsFor(config, agent).length;
  const choose = (choices, previous) => {
    const allowed = choices.filter((agent) => allowAgent(agent));
    if (previous && allowed.includes(previous)) return previous;
    return allowed.reduce((best, agent) => best === null || busy(agent) < busy(best) ? agent : best, null) ?? choices[0];
  };

  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    if (slots <= 0) break;
    if (issue.pull_request || issue.state !== 'open') continue;
    const labels = labelNames(issue);
    if (labels.includes(config.labels.blocked)) continue;
    const task = tasks[issue.number];
    if (task && (ACTIVE_STATUSES.has(task.status) || ['ready', 'blocked', 'staged'].includes(task.status))) continue;

    let agent;
    let revision = false;
    let resetBranch = false;
    if (task?.status === 'retry') {
      // A intenção persistida (agente, revisão, PR) vale mais que um retrato antigo das etiquetas.
      if (task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now) continue;
      revision = Boolean(task.revision);
      if (!revision && labels.includes(config.labels.readyForReview)) continue;
      const choices = agentChoices(issue, config);
      agent = revision ? task.agent : choices.length ? choose(choices, task.agent) : null;
      if (!agent) continue;
      resetBranch = !revision && agent !== task.agent;
    } else {
      if (labels.includes(config.labels.inProgress) || labels.includes(config.labels.readyForReview)) continue;
      const choices = agentChoices(issue, config);
      if (!choices.length) continue;
      agent = choose(choices);
    }

    if (!allowAgent(agent)) continue;
    if (!dependenciesFor(issue).every((number) => isDependencySatisfied(number, issue))) continue;
    const areas = areasFor(issue, config);
    if (areas.some((area) => occupiedAreas.has(area) || held(area, issue))) continue;
    selected.push({ issue, agent, areas, revision, resetBranch, prNumber: revision ? task.prNumber : null });
    load.set(agent, (load.get(agent) ?? 0) + 1);
    for (const area of areas) occupiedAreas.add(area);
    slots -= 1;
  }
  return selected;
}

export function issueWarnings(issue, config, resolver) {
  const warnings = [...(resolver.warnings?.[issue.number] ?? [])];
  if (!labelAreas(issue, config).length) warnings.unshift(`sem etiqueta de área: usa ${config.scheduler.defaultArea} e trava outras issues sem área`);
  return warnings;
}

// Para o painel: por que cada issue com etiqueta de agente não está rodando agora. Segue a mesma ordem
// de regras de selectCandidates; chamada depois das partidas do ciclo.
export function explainWaiting(issues, config, state, isDependencySatisfied, now = Date.now(), allowAgent = () => true) {
  const tasks = state.tasks ?? {};
  const active = Object.values(tasks).filter((task) => SLOT_STATUSES.has(task.status));
  const runningArea = new Map();
  for (const task of active) for (const area of taskAreas(task)) runningArea.set(area, task.issueNumber);
  const prArea = new Map();
  if (config.scheduler.holdAreaWhilePrOpen) {
    for (const task of Object.values(tasks).filter(holdsArea)) for (const area of taskAreas(task)) prArea.set(area, task);
  }
  const free = config.scheduler.maxConcurrency - active.length;
  const result = [];
  for (const issue of [...issues].sort((a, b) => a.number - b.number)) {
    if (issue.pull_request || issue.state !== 'open') continue;
    const labels = labelNames(issue);
    const named = config.labels.agents.filter((name) => labels.includes(name));
    if (!named.length) continue;
    const task = tasks[issue.number];
    if (task && ACTIVE_STATUSES.has(task.status)) continue;
    const areas = areasFor(issue, config);
    const item = { issue: issue.number, title: issue.title, agent: named.join('+'), areas, warnings: issueWarnings(issue, config, isDependencySatisfied) };
    const why = (kind, reason) => result.push({ ...item, kind, reason });
    if (task?.status === 'ready') { why('review', `PR #${task.prNumber} aguardando sua revisão`); continue; }
    if (task?.status === 'staged') { why('stage', 'etapa pronta: entra no PR da última etapa'); continue; }
    if (labels.includes(config.labels.blocked)) {
      why('blocked', `bloqueada${task?.lastError?.category ? ` (${task.lastError.category})` : ''}: tire a etiqueta ${config.labels.blocked} para tentar de novo`);
      continue;
    }
    const quotaUntil = named.map((name) => agentQuotaUntil(config, state, name, now));
    if (quotaUntil.every(Boolean)) { why('paused', `cota do ${named.join(' e do ')} esgotada até ${quotaUntil.sort()[0]}`); continue; }
    if (task?.status === 'retry' && task.nextAttemptAt && Date.parse(task.nextAttemptAt) > now) {
      result.push({ ...item, kind: 'retry', reason: 'nova tentativa agendada', at: task.nextAttemptAt });
      continue;
    }
    if (!task && labels.includes(config.labels.readyForReview)) { why('config', `tem a etiqueta ${config.labels.readyForReview} sem tarefa no laboratório`); continue; }
    const pending = dependenciesFor(issue).filter((number) => !isDependencySatisfied(number, issue));
    if (pending.length) { why('dependency', `depende de ${pending.map((number) => `#${number}`).join(', ')}, que ainda não foi concluída`); continue; }
    const busy = areas.find((area) => runningArea.has(area));
    if (busy) { why('area', `área ${busy} ocupada pela #${runningArea.get(busy)}, que está rodando`); continue; }
    const chain = new Set([...dependencyClosure(issue, issues), ...(isDependencySatisfied.stackChain?.(issue) ?? [])]);
    const held = areas.find((area) => prArea.has(area) && prArea.get(area).issueNumber !== issue.number && !chain.has(prArea.get(area).issueNumber));
    if (held) {
      const holder = prArea.get(held);
      why('area', holder.prNumber
        ? `área ${held} segurada pelo PR #${holder.prNumber} (#${holder.issueNumber}) até o merge`
        : `área ${held} segurada pela etapa pronta #${holder.issueNumber} até o PR final ser incorporado`);
      continue;
    }
    if (!named.some((name) => allowAgent(name))) { why('paused', `salas do ${named.join(' e do ')} em pausa (rede ou disjuntor)`); continue; }
    if (free <= 0) { why('slots', `sem vaga: ${active.length} de ${config.scheduler.maxConcurrency} salas ocupadas`); continue; }
    why('next', 'começa no próximo ciclo');
  }
  return result;
}

// Primeira linha do resumo do agente: "STATUS: COMPLETO" ou "STATUS: INCOMPLETO - motivo".
// Sem a linha conta como incompleto: só vira PR o que o agente declarou resolvido por inteiro.
export function completionStatus(summary) {
  const first = String(summary ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
  const match = first.replace(/[*_`#>]/g, '').trim().match(/^STATUS\s*:\s*(COMPLETO|INCOMPLETO)\b\s*[-–—:]?\s*(.*)$/i);
  if (!match) return { complete: false, declared: false, reason: 'o agente não declarou "STATUS: COMPLETO" no resumo' };
  const complete = match[1].toUpperCase() === 'COMPLETO';
  return { complete, declared: true, reason: complete ? '' : (match[2] || 'o agente declarou a solução incompleta').slice(0, 600) };
}

export function retryDelayMs(attempt, config) {
  const base = config.retry.baseSeconds * 1000;
  const limit = config.retry.maxSeconds * 1000;
  return Math.min(limit, base * (2 ** Math.max(0, attempt - 1)));
}

// compare(base...head): behind_by conta commits da base que o PR ainda não tem.
export function needsRevision(pull, comparison) {
  if (pull.mergeable === false || pull.mergeable_state === 'dirty') return true;
  return Number(comparison?.behind_by ?? 0) > 0 || ['behind', 'diverged'].includes(comparison?.status);
}
