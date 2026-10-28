import { loadProjectSettings, applyProjectSettings } from './projects.mjs';
import { detectQuota } from './quota.mjs';
import { accountsFor, agentQuotaUntil, availableAgents, pickAccount } from './accounts.mjs';
import { logTail, verificationTail } from './log-tail.mjs';
import { cleanup } from './cleanup.mjs';
import {
  ACTIVE_STATUSES, SLOT_STATUSES, agentChoices, areasFor, completionStatus, dependenciesFor, explainWaiting, dependencyCycles, labelNames, needsRevision,
  retryDelayMs, selectCandidates, taskAreas, issueWarnings
} from './domain.mjs';
import { verifyGroups } from './config.mjs';
import { redact } from './redact.mjs';

// Mensagens públicas por categoria. Detalhes técnicos (stderr, logs) ficam apenas no estado/log local.
const FAILURES = {
  interrupted: { message: 'o controlador foi interrompido durante a preparação da sala' },
  timeout: { message: 'a execução excedeu o tempo limite configurado' },
  lost: { message: 'o processo supervisor terminou sem registrar o resultado' },
  agent_exit: { message: 'o agente terminou com código de erro' },
  no_commits: { message: 'o agente terminou sem commits novos na branch' },
  history_rewritten: { message: 'a branch não preserva o commit de partida (histórico reescrito)' },
  revision_incomplete: { message: 'a branch revisada não incorpora a base atual' },
  base_conflict: { message: 'a branch conflita com a versão mais recente da base; o PR não foi aberto e a próxima tentativa pede ao agente para incorporar a base e resolver os conflitos' },
  incomplete: { message: 'o agente não resolveu a issue por inteiro, e solução parcial não vira PR', permanent: true, hint: 'O trabalho feito ficou guardado. Ajuste a issue se precisar e retire a etiqueta `bloqueado`: a próxima tentativa continua de onde parou.' },
  verify_failed: { message: 'a verificação independente em sala limpa falhou' },
  branch_exists: { message: 'a branch de destino já existe no GitHub', permanent: true, hint: 'Apague a branch antiga ou feche o PR correspondente e então retire a etiqueta.' },
  branch_missing: { message: 'a branch do PR não existe mais', permanent: true },
  invalid_branch: { message: 'o nome de branch calculado é inválido', permanent: true },
  delivery_conflict: { message: 'a branch remota diverge do resultado verificado', permanent: true },
  workflow_change: { message: 'a branch altera .github/workflows, que o token do laboratório não pode publicar', permanent: true, hint: 'Alterações em workflows precisam ser feitas por uma pessoa.' },
  delivery_failed: { message: 'não foi possível entregar a branch verificada', permanent: true },
  infra: { message: 'falha de infraestrutura local da sala' },
  quota: { message: 'a cota de uso do agente esgotou; esta tentativa não foi contada' },
  network: { message: 'o PC perdeu a conexão com o provedor do agente; esta tentativa não foi contada' },
  unfinished: { message: 'o agente parou antes de concluir (limite de passos, tempo ou travamento); os commits ficaram guardados e a próxima execução continua deles' }
};

// Falhas que costumam vir do ambiente (rede, Docker, PC), e não da issue. Várias seguidas e rápidas
// abrem o disjuntor: nenhuma sala nova até o ambiente se recuperar.
const ENVIRONMENT_FAILURES = new Set(['agent_exit', 'lost', 'network', 'infra', 'interrupted']);
const BREAKER_DEFAULTS = { quickMinutes: 5, windowMinutes: 30, threshold: 3, pauseMinutes: 15, maxPauseMinutes: 240 };

// Arquivos cuja alteração merece atenção redobrada na revisão humana: podem mudar o que os testes provam.
const SENSITIVE = [
  /^\.laboratorio\.json$/,
  /^(backend\/)?package(-lock)?\.json$/, /^scripts\//, /^tests?\//, /^backend\/test\//, /(^|\/)[^/]*\.spec\.ts$/,
  /^\.github\//, /^AGENTS\.md$/, /^docs\/TESTES\.md$/, /(^|\/)(playwright|vite|eslint)\.config\./, /^tsconfig/,
  /(^|\/)\.env/, /(^|\/)Dockerfile/, /docker-compose/, /^nginx\//
];

// Resultado da promessa se sair em até `ms`; senão null (ela continua rodando).
async function within(promise, ms) {
  let timer;
  const result = await Promise.race([promise, new Promise((resolve) => { timer = setTimeout(resolve, ms, null); })]);
  clearTimeout(timer);
  return result;
}

export class Orchestrator {
  constructor({ config, github, runner, git, store, log, images = null, health = null, notify = null, requests = null, retries = null, now = () => Date.now() }) {
    Object.assign(this, { config, github, runner, git, store, log, images, health, requests, retries, now });
    this.notify = notify;
    this.rawLog = log;
    this.log = (event, fields = {}) => { const tagged = { ...fields, project: this.config.project ?? 'principal' }; this.rawLog(event, tagged); this.mobileNotice(event, tagged); };
    this.breakerConfig = { ...BREAKER_DEFAULTS, ...config.breaker };
    this.state = store.load();
    this.state.outbox ??= [];
    this.state.notices ??= {};
    this.state.pendingDestroy ??= [];
    this.state.seq ??= 0;
    this.state.breaker ??= { recent: [], trips: 0, openUntil: null };
    this.state.pause ??= null;
    this.state.quota ??= {};
    this.state.mobileNotices ??= {};
    // Uma pausa sobrevive a reinícios sem impedir a verificação das salas já abertas.
    if (config.project && this.state.projectSettings) {
      try {
        applyProjectSettings(config, this.state.projectSettings, { allowBootstrap: this.state.configurationSource === 'partida' });
        this.configurationReady = true;
        config.configurationSource = this.state.configurationSource;
      } catch { this.configurationReady = false; }
    }
  }

  mobileNotice(event, fields) {
    if (event === 'task_started') delete this.state.mobileNotices[String(fields.issue)];
    if (!this.notify || !['task_blocked', 'task_ready', 'breaker_open', 'starts_paused', 'agent_stopping', 'quota'].includes(event)) return;
    const key = String(fields.issue ?? 'ambiente');
    if (event === 'starts_paused' && this.state.pause) return;
    if (this.state.mobileNotices[key] === event) return;
    this.state.mobileNotices[key] = event;
    Promise.resolve().then(() => this.notify.send(event, fields)).catch(() => {
      this.rawLog('notify_failed', { message: 'não foi possível enviar aviso ao celular' });
    });
  }

  breakerOpen() {
    const until = this.state.breaker.openUntil;
    return Boolean(until) && Date.parse(until) > this.now();
  }

  // Registra uma falha rápida de ambiente. Retorna true se a tentativa não deve ser contada: o disjuntor
  // abriu agora ou já estava aberto. As tentativas das falhas que o abriram são devolvidas às tarefas.
  noteEnvironmentFailure(task, category) {
    const cfg = this.breakerConfig;
    if (!ENVIRONMENT_FAILURES.has(category)) return false;
    const started = Date.parse(task.run?.startedAt ?? task.startedAt);
    if (!(this.now() - started < cfg.quickMinutes * 60_000)) return false;
    const breaker = this.state.breaker;
    if (this.breakerOpen()) return true;
    breaker.recent = breaker.recent.filter((item) => this.now() - Date.parse(item.at) < cfg.windowMinutes * 60_000);
    breaker.recent.push({ project: this.config.project, issue: task.issueNumber, category, at: this.iso() });
    if (breaker.recent.length < cfg.threshold) return false;
    const minutes = Math.min(cfg.maxPauseMinutes, cfg.pauseMinutes * 2 ** breaker.trips);
    breaker.trips += 1;
    breaker.openUntil = this.iso(this.now() + minutes * 60_000);
    const issues = [...new Set(breaker.recent.map((item) => item.issue))];
    for (const item of breaker.recent) {
      const owner = this.coordinator?.instances.find((o) => o.config.project === item.project) ?? this;
      const other = owner.state.tasks[item.issue];
      if (other && other !== task && other.status === 'retry' && other.attempts > 0 && item.category !== 'network') other.attempts -= 1;
    }
    breaker.recent = [];
    this.log('breaker_open', { minutes, trips: breaker.trips, until: breaker.openUntil, issues });
    return true;
  }

  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  save() { this.coordinator?.save(); this.store.save(this.state); }

  // Atualizações para o GitHub ficam em fila persistente e saem em ordem quando houver conexão.
  enqueue(issue, type, payload = {}) {
    this.state.seq += 1;
    this.state.outbox.push({ id: `op-${this.state.seq}`, issue, type, ...payload });
  }

  notifyOnce(issue, key, body) {
    const id = `${issue}:${key}`;
    if (this.state.notices[id]) return;
    this.state.notices[id] = this.iso();
    this.enqueue(issue, 'comment', { body });
  }

  hasPendingOps(issue) { return this.state.outbox.some((op) => op.issue === issue); }

  async flushOutbox() {
    while (this.state.outbox.length > 0) {
      const op = this.state.outbox[0];
      try {
        if (op.type === 'comment') await this.github.comment(op.issue, `${op.body}\n\n<!-- laboratorio-agentes:${op.id} -->`);
        else if (op.type === 'addLabel') await this.github.addLabel(op.issue, op.label);
        else if (op.type === 'removeLabel') await this.github.removeLabel(op.issue, op.label);
      } catch (error) {
        if (![404, 410, 422].includes(error.status)) {
          this.log('github_update_deferred', { issue: op.issue, type: op.type, message: error.message, pending: this.state.outbox.length });
          this.save();
          return false;
        }
        this.log('github_update_dropped', { issue: op.issue, type: op.type, status: error.status });
      }
      this.state.outbox.shift();
      this.save();
    }
    return true;
  }

  destroyRoom(task, kind) {
    try {
      this.runner.destroy(task, kind);
    } catch (error) {
      this.log('room_destroy_failed', { issue: task.issueNumber, kind, message: error.message });
      if (!this.state.pendingDestroy.some((item) => item.issueNumber === task.issueNumber && item.kind === kind)) {
        this.state.pendingDestroy.push({ agent: task.agent, issueNumber: task.issueNumber, kind });
      }
    }
  }

  retryPendingDestroy() {
    this.state.pendingDestroy = this.state.pendingDestroy.filter((item) => {
      // Uma nova execução já recriou (e antes destruiu) a sala; não derrube a sala em uso.
      if (SLOT_STATUSES.has(this.state.tasks[item.issueNumber]?.status)) return false;
      try { this.runner.destroy(item, item.kind); return false; } catch { return true; }
    });
  }

  // Guarda commits e alterações não entregues antes de destruir a sala do agente.
  preserveWork(task) {
    if (!['running', 'collecting'].includes(task.status) || task.candidateSha || !task.startSha) return;
    try {
      const result = this.runner.collect(task);
      task.preservedDir = result.dir;
      if (result.bundle) {
        task.preservedRef = `refs/lab/issue-${task.issueNumber}/falha-${task.runSeq}`;
        this.git.importBundle(result.bundle, task.branch, task.preservedRef);
      }
    } catch (error) {
      this.log('preserve_failed', { issue: task.issueNumber, message: error.message });
    }
  }

  async fail(task, category, detail = '', { permanent = false, note = '', preserve = true, counted = true, nextAttemptAt = null } = {}) {
    for (const supervised of [task.run, task.verifyRun]) this.runner.stopRun(supervised);
    if (preserve) this.preserveWork(task);
    this.destroyRoom(task, 'issue');
    this.destroyRoom(task, 'verify');
    const info = FAILURES[category] ?? FAILURES.infra;
    const max = this.config.retry.maxAttempts;
    const tripped = this.noteEnvironmentFailure(task, category);
    const uncounted = !counted || category === 'network' || tripped;
    task.attempts = (task.attempts ?? 0) + (uncounted ? 0 : 1);
    task.lastError = { category, detail: redact(detail).slice(0, 800), at: this.iso() };
    task.run = null;
    task.verifyRun = null;
    const blocked = permanent || info.permanent || (!uncounted && task.attempts >= max);
    const where = `execução ${task.runSeq ?? 0}, tentativa ${task.attempts}/${max}`;
    const pauseNote = tripped && category !== 'network'
      ? 'Várias falhas rápidas seguidas no laboratório: parece problema do ambiente, não desta issue. Esta tentativa não foi contada e nenhuma sala nova abre até a pausa acabar.\n\n'
      : '';
    const extra = `${pauseNote}${note ? `${note}\n\n` : ''}`;
    this.enqueue(task.issueNumber, 'removeLabel', { label: this.config.labels.inProgress });
    if (blocked) {
      task.status = 'blocked';
      task.nextAttemptAt = null;
      this.enqueue(task.issueNumber, 'addLabel', { label: this.config.labels.blocked });
      this.enqueue(task.issueNumber, 'comment', {
        body: `Agente ${task.agent} parou: ${info.message} (${where}).\n\n${extra}` +
          `${info.hint ?? `Corrija a causa e retire a etiqueta \`${this.config.labels.blocked}\` para liberar nova tentativa.`} ` +
          'Detalhes técnicos ficam apenas no log local do laboratório.'
      });
    } else {
      task.status = 'retry';
      // Continuação de trabalho interrompido sai logo; falha de rede espera o ambiente; o resto usa o recuo exponencial.
      const delay = !counted ? (this.config.retry.continueSeconds ?? 60) * 1000
        : uncounted ? (this.config.retry.networkSeconds ?? 600) * 1000 : retryDelayMs(task.attempts, this.config);
      const breakerUntil = this.breakerOpen() ? Date.parse(this.state.breaker.openUntil) : 0;
      task.nextAttemptAt = nextAttemptAt ?? this.iso(Math.max(this.now() + delay, breakerUntil));
      this.enqueue(task.issueNumber, 'comment', {
        body: `Falha temporária do agente ${task.agent}: ${info.message} (${where}).\n\n${extra}` +
          `Nova tentativa após ${task.nextAttemptAt}. Detalhes técnicos ficam apenas no log local do laboratório.`
      });
    }
    this.log(blocked ? 'task_blocked' : 'task_retry', { issue: task.issueNumber, category, detail: task.lastError.detail, next: task.nextAttemptAt });
    this.save();
  }

  // O agente caiu: se o próprio PC não alcança o provedor agora, a culpa é da rede, não da issue.
  async providerDown(task) {
    if (!this.health) return false;
    try { return !(await this.health.provider(task.agent)); } catch { return false; }
  }

  // Antes de abrir salas: disjuntor, portas do Windows e provedores. Retorna os agentes que podem começar.
  async startableAgents({ building = false } = {}) {
    const reasons = [];
    // Agente sem login nesta máquina nunca abre sala (a issue espera; o painel mostra o motivo).
    let agents = this.config.checkLogins ? availableAgents(this.config) : [...this.config.labels.agents];
    if (building) {
      reasons.push('reconstruindo as imagens das salas com as dependências novas');
      agents = [];
    } else if (this.breakerOpen()) {
      reasons.push(`disjuntor aberto até ${this.state.breaker.openUntil} depois de várias falhas rápidas seguidas`);
      agents = [];
    } else if (this.health) {
      const health = await this.health.check(agents);
      reasons.push(...health.reasons);
      agents = health.ports && health.disk !== false ? agents.filter((agent) => health.providers[agent]) : [];
    }
    // A cota é por conta; o agente só para quando todas as contas dele esgotaram.
    for (const [account, quota] of Object.entries(this.state.quota)) {
      if (!(Date.parse(quota.until) > this.now())) delete this.state.quota[account];
    }
    for (const agent of this.config.labels.agents) {
      const until = agentQuotaUntil(this.config, this.state, agent, this.now());
      if (until) {
        reasons.push(`cota do ${agent} esgotada até ${until}`);
        agents = agents.filter((name) => name !== agent);
      }
    }
    const pause = reasons.length ? { reasons, agents, since: this.state.pause?.since ?? this.iso() } : null;
    if (JSON.stringify(pause?.reasons ?? null) !== JSON.stringify(this.state.pause?.reasons ?? null)) {
      if (!pause) delete this.state.mobileNotices.ambiente;
      this.log(pause ? 'starts_paused' : 'starts_resumed', pause ? { reasons, agents } : {});
    }
    this.state.pause = pause;
    return new Set(agents);
  }

  timedOut(supervised, minutes) {
    return Date.parse(supervised.startedAt) + minutes * 60_000 < this.now();
  }

  async advance(task) {
    if (task.status === 'starting') return this.fail(task, 'interrupted', 'tarefa encontrada em starting ao retomar');
    if (task.status === 'running') return this.advanceAgent(task);
    if (task.status === 'collecting') return this.collectAndVerify(task);
    if (task.status === 'verifying') return this.advanceVerify(task);
    if (task.status === 'delivering') return this.deliver(task);
  }

  async advanceAgent(task) {
    const result = this.runner.inspectRun(task.run);
    if (result.status === 'running') return this.watchAgent(task);
    task.agentLog = this.runner.sanitizeLog(task.run);
    if (result.status !== 'completed') return this.fail(task, (await this.providerDown(task)) ? 'network' : 'lost', result.detail);
    task.agentExitCode = result.exitCode;
    if (result.exitCode !== 0) {
      const quota = detectQuota(logTail(task.agentLog), this.now(), { ...this.config.quota, timeZone: this.config.timeZone });
      if (quota) {
        const account = task.account ?? task.agent;
        this.state.quota[account] = { ...quota, since: this.state.quota[account]?.since ?? this.iso() };
        try {
          const work = this.runner.collect(task);
          this.keepIncomplete(task, work, 'a cota de uso esgotou; continue o trabalho preservado');
        } catch (error) { this.log('preserve_failed', { issue: task.issueNumber, message: error.message }); }
        // Outra conta do mesmo agente com cota continua o trabalho preservado já no próximo ciclo.
        const until = agentQuotaUntil(this.config, this.state, task.agent, this.now());
        this.log('quota', { issue: task.issueNumber, agent: task.agent, account, until: quota.until });
        await this.fail(task, 'quota', '', { counted: false, preserve: false, nextAttemptAt: until ?? this.iso() });
        this.save();
        return;
      }
    }
    // Código de erro sem parada nossa e com o provedor fora do ar é rede. Nos demais casos a coleta decide:
    // havendo commits, o trabalho continua na próxima execução em vez de se perder.
    if (result.exitCode !== 0 && !task.stopRequested && (await this.providerDown(task))) {
      return this.fail(task, 'network', `codigo ${result.exitCode}`);
    }
    if (result.exitCode === 0) this.state.breaker.trips = 0;
    task.status = 'collecting';
    this.save();
    return this.collectAndVerify(task);
  }

  // Agente ainda rodando: vigia o tempo total e o silêncio. Primeiro pede a parada (o supervisor registra o
  // término e a coleta guarda os commits); se a sala não parar em 5 min, a tarefa falha por tempo.
  async watchAgent(task) {
    const rooms = this.config.rooms;
    if (task.stopRequested) {
      if (Date.parse(task.stopRequested.at) + 5 * 60_000 < this.now()) return this.fail(task, 'timeout', `agente não parou: ${task.stopRequested.reason}`);
      return;
    }
    let reason = null;
    if (this.timedOut(task.run, rooms.agentTimeoutMinutes)) reason = `excedeu ${rooms.agentTimeoutMinutes} min`;
    else if (rooms.agentIdleMinutes && this.runner.agentActivity && this.timedOut(task.run, rooms.agentIdleMinutes)) {
      const last = this.runner.agentActivity(task);
      if (last && last + rooms.agentIdleMinutes * 60_000 < this.now()) reason = `ficou ${rooms.agentIdleMinutes} min sem atividade`;
    }
    if (!reason) return;
    task.stopRequested = { reason, at: this.iso() };
    this.log('agent_stopping', { issue: task.issueNumber, reason });
    this.save();
    if (!this.runner.stopAgent?.(task)) return this.fail(task, 'timeout', `agente ${reason}`);
  }

  async collectAndVerify(task) {
    try {
      if (!task.candidateSha) {
        const result = this.runner.collect(task);
        task.collectDir = result.dir;
        const status = completionStatus(result.summary);
        const commits = Boolean(result.bundle && result.head);
        const stopped = task.stopRequested?.reason ?? (task.agentExitCode ? `terminou com código ${task.agentExitCode}` : null);
        // Só COMPLETO vira PR. INCOMPLETO declarado bloqueia (o agente pediu ajuda); parada sem declaração com
        // commits continua na próxima execução; sem commits é falha comum.
        if (!status.complete) {
          if (status.declared) return this.failIncomplete(task, result, status.reason);
          if (commits) return this.continueUnfinished(task, result, stopped ?? 'terminou sem declarar STATUS no resumo');
          if (stopped) return this.fail(task, task.stopRequested ? 'timeout' : 'agent_exit', stopped);
        }
        if (!commits) return this.fail(task, 'no_commits', `commits=${result.commits} pendentes=${result.dirty}`);
        const ref = `refs/lab/issue-${task.issueNumber}/candidato`;
        const sha = this.git.importBundle(result.bundle, task.branch, ref);
        if (sha !== result.head) return this.fail(task, 'infra', 'bundle nao corresponde ao HEAD informado pela sala');
        if (!this.git.isAncestor(task.startSha, sha)) return this.fail(task, 'history_rewritten', `${task.startSha} nao e ancestral de ${sha}`);
        Object.assign(task, { candidateSha: sha, candidateRef: ref, agentSummary: result.summary.slice(0, 20_000), uncommittedFiles: result.dirty });
        this.save();
      }
      if (this.config.project && !this.configurationReady) return;
      if (!(await this.integrateBase(task))) return;
      this.destroyRoom(task, 'issue');
      if (this.health) {
        const health = await this.health.check([]);
        if (!health.ports || health.disk === false) return;
      }
      const bundle = this.git.bundleRef(this.runner.verifyBundlePath(task), task.candidateRef);
      task.verifyRun = this.runner.launchVerify(task, bundle);
      task.status = 'verifying';
      this.save();
      this.log('verify_started', { issue: task.issueNumber, sha: task.candidateSha });
    } catch (error) {
      return this.fail(task, error.category ?? 'infra', error.message, { permanent: error.permanent });
    }
  }

  // Solução parcial não vira PR. Os commits ficam guardados e, ao retirar `bloqueado`, a próxima tentativa
  // continua deles com o motivo declarado pelo agente.
  async failIncomplete(task, result, reason) {
    const clean = this.keepIncomplete(task, result, reason);
    this.log('task_incomplete', { issue: task.issueNumber, reason: clean, commits: result.commits });
    return this.fail(task, 'incomplete', clean, {
      permanent: true,
      preserve: false,
      note: `Motivo declarado pelo agente: ${redact(clean)}`
    });
  }

  // Guarda os commits da sala como ponto de partida da próxima execução. Retorna o motivo já limpo.
  keepIncomplete(task, result, reason) {
    const clean = String(reason).replace(/[`\r\n]+/g, ' ').trim();
    if (result.bundle && result.head) {
      const ref = `refs/lab/issue-${task.issueNumber}/incompleto-${task.runSeq}`;
      const sha = this.git.importBundle(result.bundle, task.branch, ref);
      if (sha === result.head && this.git.isAncestor(task.startSha, sha)) {
        task.resumeFrom = { ref, sha, files: [], baseSha: task.baseSha, incomplete: clean };
      }
    }
    task.agentSummary = result.summary.slice(0, 20_000);
    task.preservedDir = result.dir;
    return clean;
  }

  // O agente parou sem concluir (passos, tempo ou travamento) mas deixou commits: até retry.maxContinuations
  // execuções seguidas continuam desse trabalho sem gastar tentativa; depois a issue bloqueia como incompleta.
  async continueUnfinished(task, result, reason) {
    const used = task.continuations ?? 0;
    if (used >= (this.config.retry.maxContinuations ?? 2)) {
      return this.failIncomplete(task, result, `parou ${used + 1} vezes seguidas antes de concluir; a última: ${reason}`);
    }
    const clean = this.keepIncomplete(task, result, `a execução anterior parou antes de concluir (${reason})`);
    if (task.resumeFrom?.sha !== result.head) return this.fail(task, 'history_rewritten', `${task.startSha} nao e ancestral de ${result.head}`, { preserve: false });
    task.continuations = used + 1;
    this.log('task_unfinished', { issue: task.issueNumber, reason: clean, commits: result.commits, continuation: task.continuations });
    return this.fail(task, 'unfinished', clean, { preserve: false, counted: false });
  }

  // Antes da verificação a branch recebe a base mais recente: o PR já nasce sem conflito e a verificação
  // prova exatamente o que será mergeado. Conflito vira retry, e a próxima tentativa parte deste trabalho.
  // Numa etapa empilhada, além da base também entra a versão mais recente da etapa anterior (que pode ter
  // recebido ajuste depois que esta começou). Em conflito, a base da próxima tentativa passa a ser a branch
  // que conflitou, para o agente recebê-la e resolver.
  async integrateBase(task) {
    if (task.integratedBaseSha) return true;
    this.unstack(task);
    const bases = [task.baseBranch];
    const previous = task.stackOn ? this.state.tasks[task.stackOn] : null;
    if (previous?.branch && !bases.includes(previous.branch)) bases.push(previous.branch);
    let integrated = null;
    for (const branch of bases) {
      const baseSha = this.git.fetchBranch(branch);
      if (!baseSha) throw Object.assign(new Error(`branch base ${branch} ausente`), { category: 'infra' });
      if (!this.git.isAncestor(baseSha, task.candidateSha)) {
        const merge = this.git.mergeBase(task.candidateSha, baseSha, `Incorpora ${branch} (${baseSha.slice(0, 7)}) antes da verificação`);
        if (merge.conflicts) {
          const ref = `refs/lab/issue-${task.issueNumber}/conflito-${task.runSeq}`;
          this.git.setRef(ref, task.candidateSha);
          const files = merge.conflicts.slice(0, 20).map((file) => file.replace(/[`\r\n]/g, ''));
          task.resumeFrom = { ref, sha: task.candidateSha, files, baseSha };
          task.baseBranch = branch;
          this.log('base_conflict', { issue: task.issueNumber, base: baseSha, files });
          await this.fail(task, 'base_conflict', `conflito com ${branch} em ${files.join(', ')}`, {
            note: `Arquivos em conflito: ${files.map((file) => `\`${file}\``).join(', ')}${merge.conflicts.length > files.length ? ' e outros' : ''}.`
          });
          return false;
        }
        this.git.setRef(task.candidateRef, merge.sha);
        this.log('base_merged', { issue: task.issueNumber, base: baseSha, from: task.candidateSha, sha: merge.sha });
        task.candidateSha = merge.sha;
      }
      integrated ??= baseSha;
    }
    task.integratedBaseSha = integrated;
    this.save();
    return true;
  }

  // A etapa anterior já foi incorporada à main (ou saiu do laboratório): daqui em diante a base é a main.
  unstack(task) {
    if (!task.stackOn) return;
    const previous = this.state.tasks[task.stackOn];
    if (previous && previous.status !== 'done') return;
    if (!previous || task.baseBranch === previous.branch) task.baseBranch = task.prBase ?? task.baseBranch;
    task.stackOn = null;
  }

  async advanceVerify(task) {
    const result = this.runner.inspectRun(task.verifyRun);
    if (result.status === 'running') {
      if (this.timedOut(task.verifyRun, this.config.rooms.verifyTimeoutMinutes)) {
        return this.fail(task, 'timeout', `verificacao excedeu ${this.config.rooms.verifyTimeoutMinutes} min`);
      }
      return;
    }
    task.verifyLog = this.runner.sanitizeLog(task.verifyRun);
    if (result.status !== 'completed') return this.fail(task, 'lost', `verificacao: ${result.detail}`);
    if (result.exitCode !== 0) {
      task.resumeFrom = { ref: task.candidateRef, sha: task.candidateSha, verifyFailure: verificationTail(task.verifyLog) };
      return this.fail(task, 'verify_failed', `codigo ${result.exitCode}`);
    }
    this.destroyRoom(task, 'verify');
    Object.assign(task, { status: 'delivering', verifiedAt: this.iso(), verifyRun: null, deliveryAttempts: 0 });
    this.save();
    return this.deliver(task);
  }

  pullTitle(task) {
    const stages = task.stack?.length ? ` (com as etapas ${task.stack.map((number) => `#${number}`).join(', ')})` : '';
    return `[${task.agent}] #${task.issueNumber}: ${task.title}${stages}`.slice(0, 250);
  }

  pullBody(task) {
    // Com a base incorporada, o diff contra ela é exatamente o que o PR muda; uma retomada lista desde a base.
    // PR da última etapa: tudo o que ainda não está na base do PR, desde a primeira etapa.
    let from = task.revision ? task.startSha : task.baseSha ?? task.startSha;
    let diffFrom = task.integratedBaseSha ?? task.startSha;
    if (task.stack?.length) {
      const prBaseSha = this.git.fetchBranch(task.prBase ?? task.baseBranch);
      if (prBaseSha) {
        from = prBaseSha;
        diffFrom = this.git.mergeBaseOf?.(prBaseSha, task.candidateSha) ?? prBaseSha;
      }
    }
    const commits = this.git.commitSubjects(from, task.candidateSha);
    const sensitive = this.git.changedFiles(diffFrom, task.candidateSha).filter((file) => SENSITIVE.some((rule) => rule.test(file)));
    const lines = [
      ...[...(task.stack ?? []), task.issueNumber].map((number) => `Closes #${number}`),
      '',
      `Entrega automática do laboratório de agentes (agente \`${task.agent}\`, execução ${task.runSeq}).`,
      ''
    ];
    if (task.stack?.length) {
      lines.push('## Etapas', 'Tarefa dividida em etapas; cada uma passou pela verificação em sala limpa antes da seguinte começar em cima dela:',
        ...[...task.stack, task.issueNumber].map((number, index) => `${index + 1}. #${number}${this.state.tasks[number]?.title ? ` ${this.state.tasks[number].title}` : ''}`), '');
    }
    lines.push(
      '## Verificação independente',
      `O commit \`${task.candidateSha}\` foi verificado pelo controlador em uma sala limpa, sem credenciais:`,
      ...verifyGroups(this.config).flat().map((command) => `- \`${command}\``),
      '',
      '## Commits',
      ...(commits.length ? commits.map((line) => `- ${line}`) : ['- (somente merge)'])
    );
    if (sensitive.length) {
      lines.push('', '## Atenção na revisão', 'Arquivos que podem alterar o que os testes provam:', ...sensitive.map((file) => `- \`${file}\``));
    }
    if (task.uncommittedFiles) lines.push('', `Obs.: o agente deixou ${task.uncommittedFiles} arquivo(s) sem commit; eles não fazem parte deste PR.`);
    if (task.agentSummary?.trim()) {
      lines.push('', '## Resumo escrito pelo agente (não verificado)', '', task.agentSummary.trim().replace(/^/gm, '> '));
    }
    return lines.join('\n').slice(0, 60_000);
  }

  async deliver(task) {
    let pull;
    this.unstack(task);
    // Há issue aberta esperando por esta ("depende de #N"): vira etapa pronta, sem PR próprio. A branch vai
    // ao GitHub para a etapa seguinte partir dela; tudo chega à main pelo PR da última etapa.
    const next = task.prNumber ? [] : (this.state.dependents?.[task.issueNumber] ?? []).filter((number) => number !== task.issueNumber);
    try {
      if (this.git.remoteSha(task.branch) !== task.candidateSha) this.git.push(task.candidateSha, task.branch);
      if (next.length) return this.stage(task, next);
      pull = task.prNumber ? { number: task.prNumber } : await this.github.findOpenPull(task.branch);
      if (!pull) {
        pull = await this.github.createPull({
          title: this.pullTitle(task), head: task.branch, base: task.prBase ?? task.baseBranch, body: this.pullBody(task)
        });
      }
    } catch (error) {
      if (error.permanent) return this.fail(task, error.category, error.message, { permanent: true });
      task.deliveryAttempts = (task.deliveryAttempts ?? 0) + 1;
      this.log('delivery_deferred', { issue: task.issueNumber, attempt: task.deliveryAttempts, message: error.message });
      if (task.deliveryAttempts >= 20) return this.fail(task, 'delivery_failed', error.message, { permanent: true });
      this.save();
      return;
    }
    const feedback = Boolean(task.feedback);
    if (task.revision && task.prNumber) {
      this.enqueue(pull.number, 'comment', {
        body: `${feedback ? 'Ajuste pedido aplicado. ' : ''}Branch atualizada pelo agente ${task.agent}; commit \`${task.candidateSha}\` verificado em sala limpa.`
      });
    }
    this.state.breaker.trips = 0;
    task.continuations = 0;
    Object.assign(task, { status: 'ready', prNumber: pull.number, readyAt: this.iso(), attempts: 0, revision: false, resumeFrom: null, feedback: null });
    this.enqueue(task.issueNumber, 'removeLabel', { label: this.config.labels.inProgress });
    this.enqueue(task.issueNumber, 'addLabel', { label: this.config.labels.readyForReview });
    this.enqueue(task.issueNumber, 'comment', {
      body: `Agente ${task.agent} concluiu a execução. PR #${pull.number} pronto para revisão humana ` +
        `(commit \`${task.candidateSha}\` verificado em sala limpa).` +
        (task.stack?.length ? ` O PR inclui as etapas ${task.stack.map((number) => `#${number}`).join(', ')}: aprovar este PR conclui todas.` : '')
    });
    this.log('task_ready', { issue: task.issueNumber, pull: pull.number, agent: task.agent, sha: task.candidateSha, feedback, stack: task.stack ?? [] });
    this.save();
  }

  stage(task, next) {
    const feedback = Boolean(task.feedback);
    this.state.breaker.trips = 0;
    Object.assign(task, {
      status: 'staged', stagedAt: this.iso(), readyAt: this.iso(), nextStages: next,
      attempts: 0, continuations: 0, revision: false, resumeFrom: null, feedback: null
    });
    this.enqueue(task.issueNumber, 'removeLabel', { label: this.config.labels.inProgress });
    this.enqueue(task.issueNumber, 'comment', {
      body: `${feedback ? 'Ajuste pedido aplicado. ' : ''}Etapa pronta: o agente ${task.agent} concluiu e o commit \`${task.candidateSha}\` passou na ` +
        `verificação em sala limpa (branch \`${task.branch}\`). Esta etapa não abre PR próprio: ` +
        `${next.map((number) => `#${number}`).join(', ')} continua em cima dela, e tudo entra no PR da última etapa.`
    });
    this.log('task_staged', { issue: task.issueNumber, next, agent: task.agent, sha: task.candidateSha, stage: (task.stack?.length ?? 0) + 1, feedback });
    this.save();
  }

  // Etapa pronta cujo trabalho já chegou à main (o PR final foi aprovado e fechou as issues).
  finishStages(openByNumber, mainSha) {
    const only = this.config.scheduler.onlyIssues;
    for (const task of Object.values(this.state.tasks)) {
      if (task.status !== 'staged' || (only && !only.includes(task.issueNumber))) continue;
      const merged = mainSha && task.candidateSha && this.git.isAncestor(task.candidateSha, mainSha);
      if (openByNumber.has(task.issueNumber) && !merged) continue;
      Object.assign(task, { status: 'done', doneAt: this.iso() });
      this.log('stage_done', { issue: task.issueNumber });
    }
  }

  // A etapa anterior recebeu um ajuste depois desta ficar pronta: o controlador incorpora a nova versão
  // (merge sem agente) e verifica de novo. Conflito ou teste quebrado volta ao agente como numa revisão.
  needsRestack(task) {
    if (!['staged', 'ready'].includes(task.status) || !task.stackOn || !task.candidateSha) return false;
    const previous = this.state.tasks[task.stackOn];
    return Boolean(previous && ['staged', 'ready'].includes(previous.status) && previous.candidateSha &&
      !this.git.isAncestor(previous.candidateSha, task.candidateSha));
  }

  async restack(task) {
    const previous = this.state.tasks[task.stackOn];
    if (task.status === 'ready') this.enqueue(task.issueNumber, 'removeLabel', { label: this.config.labels.readyForReview });
    this.enqueue(task.issueNumber, 'addLabel', { label: this.config.labels.inProgress });
    Object.assign(task, {
      status: 'collecting', revision: true, baseBranch: previous.branch, runSeq: (task.runSeq ?? 0) + 1, startedAt: this.iso(),
      startSha: task.candidateSha, integratedBaseSha: null, run: null, verifyRun: null, stopRequested: null, agentExitCode: null
    });
    this.log('stack_refresh', { issue: task.issueNumber, from: task.stackOn, sha: previous.candidateSha });
    this.save();
    return this.collectAndVerify(task);
  }

  hasRoomFor(task) {
    const active = Object.values(this.state.tasks).filter((item) => SLOT_STATUSES.has(item.status));
    const occupied = new Set(active.flatMap(taskAreas));
    return (!this.coordinator || this.coordinator.available()) && active.length < this.config.scheduler.maxConcurrency && !taskAreas(task).some((area) => occupied.has(area));
  }

  // Ajustes pedidos pelo painel ("faltou isso", "isso está errado"): o mesmo agente volta na mesma branch,
  // partindo do que já fez, e o resultado passa de novo pela verificação. Pedido feito enquanto a tarefa
  // ainda roda espera ela ficar pronta.
  async applyFeedback(openByNumber, startable) {
    if (!this.requests) return;
    for (const request of this.requests.list()) {
      const task = this.state.tasks[request.issue];
      const issue = openByNumber.get(request.issue);
      if (!task || !issue || task.status === 'done') {
        this.requests.remove(request);
        this.log('feedback_dropped', { issue: request.issue });
        continue;
      }
      if (!['ready', 'staged'].includes(task.status) || labelNames(issue).includes(this.config.labels.blocked)) continue;
      if (!startable.has(task.agent) || !this.hasRoomFor(task)) continue;
      const text = request.items.map((item) => item.text.trim()).join('\n\n---\n\n').slice(0, 8000);
      this.enqueue(task.prNumber ?? task.issueNumber, 'comment', {
        body: `Ajuste pedido pelo painel do laboratório:\n\n${redact(text).replace(/^/gm, '> ')}\n\n` +
          `O agente ${task.agent} vai aplicar na mesma branch, partindo do que já foi feito; o resultado passa de novo pela verificação em sala limpa.`
      });
      this.requests.remove(request);
      this.log('feedback_started', { issue: task.issueNumber, agent: task.agent, chars: text.length });
      await this.start({
        issue, agent: task.agent, areas: taskAreas(task), revision: true, prNumber: task.prNumber ?? null,
        feedback: { text, at: request.items.at(-1).at }
      }, task.baseBranch);
    }
  }

  applyRetries(openByNumber) {
    if (!this.retries) return;
    for (const request of this.retries.list()) {
      const task = this.state.tasks[request.issue];
      const issue = openByNumber.get(request.issue);
      if (task?.status === 'retry' && issue && !labelNames(issue).includes(this.config.labels.blocked)) {
        task.nextAttemptAt = this.iso();
        // O objeto é compartilhado entre projetos: preserve a referência.
        Object.assign(this.state.breaker, { recent: [], trips: 0, openUntil: null });
        for (const account of accountsFor(this.config, task.agent)) delete this.state.quota[account];
        this.log('task_retry_requested', { issue: task.issueNumber, agent: task.agent });
        this.save();
        for (const instance of this.coordinator?.instances ?? []) instance.save();
        this.coordinator?.save();
      }
      // Estado pode ter mudado desde o clique. Nunca reinicie uma tarefa ativa.
      this.retries.remove(request);
    }
  }

  releaseBlocked(openByNumber) {
    for (const task of Object.values(this.state.tasks)) {
      if (task.status !== 'blocked') continue;
      const issue = openByNumber.get(task.issueNumber);
      if (!issue || labelNames(issue).includes(this.config.labels.blocked) || this.hasPendingOps(task.issueNumber)) continue;
      Object.assign(task, { status: 'retry', attempts: 0, continuations: 0, nextAttemptAt: this.iso() });
      this.log('task_unblocked', { issue: task.issueNumber });
    }
  }

  // Issue fechada ou apagada no GitHub: a tarefa parada (bloqueada ou esperando nova tentativa) é encerrada.
  // Confere uma a uma, porque a lista de abertas pode vir filtrada (onlyIssues, issue de configuração).
  async dropVanished(openByNumber) {
    for (const task of Object.values(this.state.tasks)) {
      if (!['blocked', 'retry'].includes(task.status) || openByNumber.has(task.issueNumber) || this.hasPendingOps(task.issueNumber)) continue;
      let gone;
      try { gone = (await this.github.getIssue(task.issueNumber)).state === 'closed'; }
      catch (error) { if (![404, 410].includes(error.status)) continue; gone = true; }
      if (!gone) continue;
      Object.assign(task, { status: 'done', doneAt: this.iso(), closedWithoutDelivery: true });
      this.log('task_dropped', { issue: task.issueNumber });
    }
  }

  async revisionCandidates(pulls, openByNumber, tickStart) {
    const result = [];
    for (const task of Object.values(this.state.tasks)) {
      if (task.status !== 'ready' || !task.prNumber) continue;
      // Não reavalia no mesmo tick em que a tarefa ficou pronta (etiquetas lidas antes da entrega).
      if (task.readyAt && Date.parse(task.readyAt) >= tickStart) continue;
      if (!pulls.some((item) => item.number === task.prNumber)) {
        Object.assign(task, { status: 'done', doneAt: this.iso() });
        this.log('task_done', { issue: task.issueNumber, pull: task.prNumber });
        continue;
      }
      const issue = openByNumber.get(task.issueNumber);
      if (!issue || labelNames(issue).includes(this.config.labels.blocked)) continue;
      const pull = await this.github.getPull(task.prNumber);
      if (pull.mergeable === null || pull.mergeable === undefined) continue;
      const comparison = await this.github.compare(pull.base.ref, pull.head.sha);
      if (needsRevision(pull, comparison)) result.push({ task, issue, pull });
    }
    return result;
  }

  async dependencyResolver(openIssues) {
    const open = new Set(openIssues.map((issue) => issue.number));
    for (const number of dependencyCycles(openIssues)) {
      this.notifyOnce(number, 'ciclo', 'O laboratório não iniciará esta issue: as referências "depende de #N" formam um ciclo. Ajuste a descrição para quebrar o ciclo.');
    }
    const dependents = new Map();
    const waitingOn = {};
    for (const issue of openIssues) {
      if (!agentChoices(issue, this.config).length && this.state.tasks[issue.number]?.status !== 'retry') continue;
      for (const number of dependenciesFor(issue)) {
        (waitingOn[number] ??= []).push(issue.number);
        if (open.has(number)) continue;
        dependents.set(number, [...(dependents.get(number) ?? []), issue.number]);
      }
    }
    // Quem espera por cada issue: na entrega, uma issue com dependentes vira etapa pronta em vez de PR.
    this.state.dependents = waitingOn;
    const satisfied = new Set();
    const warnings = {};
    const warn = (issue, text) => { (warnings[issue] ??= []).push(text); };
    for (const [number, waiting] of dependents) {
      try {
        const dependency = await this.github.getIssue(number);
        const merged = Boolean(dependency.pull_request?.merged_at);
        if (dependency.state === 'closed' && (dependency.pull_request ? merged : dependency.state_reason !== 'not_planned')) {
          satisfied.add(number);
        } else if (dependency.state === 'closed') {
          for (const issue of waiting) {
            warn(issue, `dependência #${number} fechada sem PR mergeado ou conclusão`);
            this.notifyOnce(issue, `dependencia-${number}`, `A dependência #${number} foi fechada sem conclusão; esta issue continua aguardando. Remova a referência se ela não for mais necessária.`);
          }
        }
      } catch (error) {
        if (![404, 410].includes(error.status)) { this.log('dependency_check_failed', { dependency: number, message: error.message }); continue; }
        for (const issue of waiting) {
          warn(issue, `dependência #${number} não existe neste repositório`);
          this.notifyOnce(issue, `dependencia-${number}`, `A dependência #${number} não foi encontrada neste repositório; esta issue continua aguardando.`);
        }
      }
    }
    // Etapa pronta (ou PR aberto) de uma issue ainda aberta: a seguinte começa em cima dela, sem esperar o
    // merge. A base escolhida precisa já conter todas as etapas pendentes de que a issue depende.
    const stackable = (number) => open.has(number) && ['staged', 'ready'].includes(this.state.tasks[number]?.status) &&
      Boolean(this.state.tasks[number]?.candidateSha && this.state.tasks[number]?.branch);
    const chainOf = (number) => new Set([...(this.state.tasks[number]?.stack ?? []), number]);
    const covers = (base, needed) => { const chain = chainOf(base); return needed.every((number) => chain.has(number)); };
    const longest = (numbers) => numbers.sort((a, b) => chainOf(b).size - chainOf(a).size || b - a)[0] ?? null;
    // Issues ligadas por "depende de" (em qualquer sentido) formam uma família; cada família vira um PR só.
    const family = new Map(openIssues.map((issue) => [issue.number, issue.number]));
    const root = (number) => { while (family.get(number) !== number) number = family.get(number); return number; };
    for (const issue of openIssues) {
      for (const number of dependenciesFor(issue)) if (open.has(number)) family.set(root(number), root(issue.number));
    }
    const stackFor = (issue) => {
      const found = dependenciesFor(issue).filter(stackable);
      // Área segurada por uma etapa pronta da mesma família: a issue entra na fila em cima dela. Sem isso a
      // etapa espera o PR final, que depende desta issue, e nada anda.
      const areas = areasFor(issue, this.config);
      const holders = Object.values(this.state.tasks).filter((task) => task.status === 'staged' && stackable(task.issueNumber) &&
        task.issueNumber !== issue.number && root(task.issueNumber) === root(issue.number) &&
        taskAreas(task).some((area) => areas.includes(area)) && covers(task.issueNumber, found));
      const holder = longest(holders.map((task) => task.issueNumber));
      if (holder !== null) return holder;
      return longest(found.filter((number) => covers(number, found)));
    };
    for (const issue of openIssues) {
      const found = dependenciesFor(issue).filter(stackable);
      if (found.length > 1 && stackFor(issue) === null) {
        warn(issue.number, `depende de mais de uma etapa ainda não incorporada (${found.map((number) => `#${number}`).join(', ')}): só dá para continuar em cima de uma; aprove as outras primeiro`);
      }
    }
    // Etapas que a issue vai levar junto (a base e as anteriores a ela).
    const stackChain = (issue) => { const base = stackFor(issue); return base === null ? new Set() : chainOf(base); };
    const resolver = (number, issue) => satisfied.has(number) || (stackable(number) && (!issue || stackChain(issue).has(number)));
    return Object.assign(resolver, { warnings, stackFor, stackChain });
  }

  async start(item, baseBranch, { defaultBranch = baseBranch, stackOn = null } = {}) {
    if (this.coordinator && !this.coordinator.available()) return;
    const number = item.issue.number;
    const old = this.state.tasks[number] ?? {};
    const branch = !item.resetBranch && old.branch ? old.branch : `${this.config.rooms.branchPrefix}/${item.agent}/issue-${number}`;
    const previous = stackOn ? this.state.tasks[stackOn] : null;
    const task = {
      ...old,
      issueNumber: number,
      project: this.config.project,
      title: item.issue.title,
      body: item.issue.body ?? '',
      agent: item.agent,
      account: pickAccount(this.config, this.state, item.agent, this.allTasks(), this.now()) ?? item.agent,
      areas: item.areas,
      branch,
      baseBranch: previous ? previous.branch : baseBranch,
      // Base do PR (a main), etapa de onde esta parte e as etapas anteriores que o PR final fecha junto.
      prBase: item.revision ? old.prBase ?? baseBranch : defaultBranch,
      stackOn: previous ? stackOn : item.revision ? old.stackOn ?? null : null,
      stack: previous ? [...(previous.stack ?? []), stackOn] : item.revision ? old.stack ?? [] : [],
      feedback: item.feedback ?? (item.revision ? old.feedback ?? null : null),
      stagedAt: item.revision ? old.stagedAt ?? null : null,
      revision: Boolean(item.revision),
      prNumber: item.revision ? item.prNumber : null,
      status: 'starting',
      runSeq: (old.runSeq ?? 0) + 1,
      attempts: old.attempts ?? 0,
      startedAt: this.iso(),
      startSha: null, baseSha: null, candidateSha: null, candidateRef: null, integratedBaseSha: null, resumed: false,
      run: null, verifyRun: null, stopRequested: null, agentExitCode: null,
      // Trocar de agente recomeça do zero; senão a tentativa parte do trabalho que conflitou.
      resumeFrom: item.resetBranch ? null : old.resumeFrom ?? null
    };
    delete task.area;
    this.unstack(task);
    this.state.tasks[number] = task;
    if (item.revision) this.enqueue(number, 'removeLabel', { label: this.config.labels.readyForReview });
    this.enqueue(number, 'addLabel', { label: this.config.labels.inProgress });
    this.save();
    try {
      const bundle = this.runner.agentBundlePath(task);
      const input = this.git.prepareInput(task, bundle);
      Object.assign(task, { baseSha: input.baseSha, startSha: input.startSha, resumed: Boolean(input.resumed) });
      this.save();
      task.run = this.runner.launchAgent(task, bundle);
      task.status = 'running';
      this.save();
      this.log('task_started', { issue: number, agent: task.agent, account: task.account, revision: task.revision, run: task.runSeq });
    } catch (error) {
      await this.fail(task, error.category ?? 'infra', error.message, { permanent: error.permanent });
    }
  }

  // Tarefas de todos os projetos: as contas são compartilhadas entre eles.
  allTasks() {
    return (this.coordinator?.instances ?? [this]).flatMap((instance) => Object.values(instance.state.tasks));
  }

  hasActiveWork() {
    return Object.values(this.state.tasks).some((task) => ACTIVE_STATUSES.has(task.status));
  }

  // Avança só o trabalho local (salas, entrega, fila do GitHub), sem listar issues nem PRs.
  // Roda com intervalo curto enquanto há sala ativa, para reagir logo ao fim de cada fase.
  async tickLocal() {
    if (!this.state.lastCleanupAt || this.now() - Date.parse(this.state.lastCleanupAt) >= 86_400_000) {
      this.state.lastCleanupAt = this.iso();
      try { this.log('cleanup_done', cleanup(this.config, this.state, this.git, this.now())); }
      catch (error) { this.log('cleanup_failed', { message: error.message }); }
      this.save();
    }
    this.retryPendingDestroy();
    await this.flushOutbox();
    for (const task of Object.values(this.state.tasks)) {
      if (ACTIVE_STATUSES.has(task.status)) await this.advance(task);
    }
  }

  async tick() {
    if (this.admissionEnabled === false) return this.tickLocal();
    const tickStart = this.now();
    let repository;
    if (this.config.project) {
      repository = await this.github.repository();
      this.configurationReady = false;
      try {
        loadProjectSettings(this.config, this.git, repository.default_branch);
        this.configurationReady = true;
        this.state.configurationError = null;
        this.state.projectSettings = this.config.projectSettings;
        this.state.configurationSource = this.config.configurationSource;
      } catch (error) {
        this.onProjectStatus?.('erro', error.message);
        this.state.configurationError = `precisa de configuração: ${error.message}`;
        this.state.queue = [{ kind: 'config', reason: this.state.configurationError }];
        this.log('project_configuration_failed', { message: this.state.configurationError });
        await this.tickLocal();
        this.save();
        return;
      }
    }
    await this.tickLocal();
    const [issues, pulls, repo] = await Promise.all([
      this.github.listOpenIssues(), this.github.listOpenPulls(), repository ?? this.github.repository()
    ]);
    repository = repo;
    const only = this.config.scheduler.onlyIssues;
    const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === 'open' && (!only || only.includes(issue.number)) && (this.config.configurationSource !== 'partida' || (issue.title === 'Configurar o laboratório de agentes' && issue.body?.includes('<!-- laboratorio-agentes:configuracao-v1 -->'))));
    const openByNumber = new Map(openIssues.map((issue) => [issue.number, issue]));
    this.applyRetries(openByNumber);
    this.releaseBlocked(openByNumber);
    await this.dropVanished(openByNumber);

    // Imagens com as dependências da base atual antes de abrir salas novas. A reconstrução roda em segundo
    // plano: enquanto não termina, este projeto só não abre salas; o resto do ciclo e os outros projetos seguem.
    let building = false;
    if (this.images) {
      this.imageJob ??= Promise.resolve()
        .then(() => this.images.ensure(repository.default_branch, { onBuild: () => this.onProjectStatus?.('construindo-imagem') }))
        .then((result) => ({ result }), (error) => ({ error }));
      const done = await within(this.imageJob, this.imageWaitMs ?? 2000);
      if (!done) building = true;
      else {
        this.imageJob = null;
        if (done.error) {
          this.onProjectStatus?.('erro', done.error.message);
          this.log('image_refresh_failed', { message: done.error.message });
          this.save();
          await this.flushOutbox();
          return;
        }
      }
    }

    const bootstrap = this.config.configurationSource === 'partida';
    this.onProjectStatus?.(building ? 'construindo-imagem' : bootstrap ? (openIssues.length ? 'configurando' : 'precisa-configuracao') : 'pronto');

    if (Object.values(this.state.tasks).some((task) => task.status === 'staged')) {
      let mainSha = null;
      try { mainSha = this.git.fetchBranch(repository.default_branch); } catch (error) { this.log('stage_check_failed', { message: error.message }); }
      this.finishStages(openByNumber, mainSha);
    }

    const startable = await this.startableAgents({ building });
    await this.applyFeedback(openByNumber, startable);
    for (const { task, issue, pull } of await this.revisionCandidates(pulls, openByNumber, tickStart)) {
      if (!startable.has(task.agent) || !this.hasRoomFor(task)) continue;
      await this.start({ issue, agent: task.agent, areas: taskAreas(task), revision: true, prNumber: pull.number }, pull.base.ref);
    }
    for (const task of Object.values(this.state.tasks)) {
      const issue = openByNumber.get(task.issueNumber);
      if (building || !issue || labelNames(issue).includes(this.config.labels.blocked) || !this.needsRestack(task) || !this.hasRoomFor(task)) continue;
      await this.restack(task);
    }

    const satisfied = await this.dependencyResolver(openIssues);
    this.state.issueWarnings = Object.fromEntries(openIssues.filter((issue) => agentChoices(issue, this.config).length)
      .map((issue) => [issue.number, issueWarnings(issue, this.config, satisfied)]));
    for (const item of selectCandidates(openIssues, this.config, this.state, satisfied, this.now(), (agent) => startable.has(agent))) {
      const previous = this.state.tasks[item.issue.number];
      const stackOn = item.revision ? null : satisfied.stackFor(item.issue);
      await this.start(item, item.revision ? previous.baseBranch : repository.default_branch, { defaultBranch: repository.default_branch, stackOn });
    }
    this.state.queue = explainWaiting(openIssues, this.config, this.state, satisfied, this.now(), (agent) => startable.has(agent));
    if (this.coordinator && !this.coordinator.available()) {
      this.state.queue = this.state.queue.map((q) => q.kind === 'next' ? { ...q, kind: 'slots', reason: `sem vaga global: ${this.coordinator.active()} de ${this.coordinator.maxConcurrency} salas ocupadas` } : q);
    }
    this.state.queueAt = this.iso();
    this.save();
    await this.flushOutbox();
    this.log('tick_complete', {
      openIssues: openIssues.length,
      active: Object.values(this.state.tasks).filter((task) => SLOT_STATUSES.has(task.status)).length,
      pendingGitHub: this.state.outbox.length
    });
  }
}
