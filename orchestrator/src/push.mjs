// Avisos no celular pelo app do painel: acompanha o log de eventos do controlador e manda um push quando
// uma tarefa fica pronta para aprovação, termina ou encontra problema. Roda no processo do painel, então
// o controlador não muda e um push que falha nunca atrapalha uma tarefa.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';
import { loadVapid, vapidPublicKey, sendPush, validSubscription } from './webpush.mjs';

// Repetições que não são problema do trabalho (rede, cota, continuação automática) não geram aviso.
const QUIET_RETRY = new Set(['network', 'quota', 'unfinished']);
const FAIL = {
  timeout: 'tempo limite excedido', agent_exit: 'agente saiu com erro', no_commits: 'agente não fez commits',
  verify_failed: 'verificação falhou', delivery_failed: 'falha ao abrir o PR', delivery_conflict: 'conflito na entrega',
  base_conflict: 'conflito com a main', workflow_change: 'altera .github/workflows', infra: 'falha de infraestrutura',
  incomplete: 'solução incompleta', history_rewritten: 'histórico reescrito', branch_missing: 'branch do PR sumiu'
};

export function notificationFor(event, tasks, repo, timeZone = undefined) {
  const task = tasks[String(event.issue)] ?? {};
  const name = event.issue ? `${event.project ? `${event.project} · ` : ''}#${event.issue}${task.title ? ` ${task.title}` : ''}` : '';
  const issueUrl = event.issue ? `https://github.com/${repo}/issues/${event.issue}` : '/';
  const why = (category, detail) => [FAIL[category] ?? category, detail].filter(Boolean).join(': ');
  const short = (text) => redact(String(text ?? '')).replace(/\s+/g, ' ').slice(0, 240);
  switch (event.event) {
    case 'project_status':
      if (!['pronto', 'sem-acesso', 'erro'].includes(event.status)) return null;
      return { title: event.status === 'pronto' ? `Projeto pronto: ${short(event.repo ?? repo)}` : `Projeto precisa de você: ${short(event.repo ?? repo)}`, body: short(event.detail || event.status), url: '/#projetos', tag: `project-${event.project}` };
    case 'task_ready':
      return {
        title: event.feedback ? 'Ajuste pronto: aguardando sua aprovação' : 'Aguardando sua aprovação no GitHub',
        body: `${name} · PR #${event.pull} (${event.agent ?? task.agent ?? 'agente'})${event.stack?.length ? ` · inclui as etapas ${event.stack.map((n) => `#${n}`).join(', ')}` : ''}`,
        url: `https://github.com/${repo}/pull/${event.pull}`, tag: `issue-${event.project ?? 'principal'}-${event.issue}`
      };
    case 'task_staged':
      return {
        title: event.feedback ? 'Ajuste aplicado na etapa' : `Etapa${event.stage ? ` ${event.stage}` : ''} pronta, seguindo para a próxima`,
        body: `${name} · próxima: ${(event.next ?? []).map((n) => `#${n}`).join(', ')}`, url: '/', tag: `issue-${event.project ?? 'principal'}-${event.issue}`
      };
    case 'task_done':
      return { title: 'Tarefa concluída', body: `${name} · PR #${event.pull} incorporado`, url: issueUrl, tag: `issue-${event.project ?? 'principal'}-${event.issue}` };
    case 'task_blocked':
      return { title: 'Tarefa bloqueada: precisa de você', body: `${name} · ${short(why(event.category, event.detail))}`, url: issueUrl, tag: `issue-${event.project ?? 'principal'}-${event.issue}` };
    case 'task_retry':
      if (QUIET_RETRY.has(event.category)) return null;
      return { title: 'Tarefa encontrou problemas', body: `${name} · ${short(why(event.category, event.detail))} · vai tentar de novo`, url: '/', tag: `issue-${event.project ?? 'principal'}-${event.issue}` };
    case 'task_incomplete':
      return { title: 'Agente não conseguiu concluir', body: `${name} · ${short(event.reason)}`, url: issueUrl, tag: `issue-${event.project ?? 'principal'}-${event.issue}` };
    case 'quota':
      return { title: `Cota do ${event.agent ?? 'agente'} esgotada`, body: `Novas tarefas dele esperam${event.until ? ` até ${new Date(event.until).toLocaleString('pt-BR', { timeZone })}` : ''}.`, url: '/', tag: `quota-${event.agent}` };
    case 'breaker_open':
      return { title: 'Laboratório pausou salas novas', body: 'Várias falhas rápidas seguidas. Veja o painel.', url: '/', tag: 'breaker' };
    default:
      return null;
  }
}

export class PushHub {
  constructor({ dir, logFile, stateFile, repo, subject, timeZone, projects = null, fetch = globalThis.fetch, log = console.log }) {
    Object.assign(this, { dir, logFile, stateFile, repo, subject, timeZone, projects, fetch, log });
    this.subsFile = path.join(dir, 'subscriptions.json');
    this.offsetFile = path.join(dir, 'offset.json');
    this.vapid = loadVapid(path.join(dir, 'vapid.json'));
    this.publicKey = vapidPublicKey(this.vapid);
    this.subs = this.read(this.subsFile, []);
    // Começa do fim do log na primeira vez: não manda avisos de coisas antigas.
    this.offset = this.read(this.offsetFile, null)?.offset ?? this.size();
    this.partial = '';
  }

  read(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
  write(file, value) {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  size() { try { return fs.statSync(this.logFile).size; } catch { return 0; } }

  subscribe(sub, label = '') {
    if (!validSubscription(sub)) return false;
    this.subs = this.subs.filter((s) => s.endpoint !== sub.endpoint);
    this.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: String(label).slice(0, 80), at: new Date().toISOString() });
    this.write(this.subsFile, this.subs);
    return true;
  }

  unsubscribe(endpoint) {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.write(this.subsFile, this.subs);
  }

  has(endpoint) { return this.subs.some((s) => s.endpoint === endpoint); }

  async broadcast(message, only = null) {
    const targets = only ? this.subs.filter((s) => s.endpoint === only) : this.subs;
    let delivered = 0;
    for (const sub of targets) {
      try {
        const status = await sendPush(sub, message, { vapid: this.vapid, subject: this.subject, fetch: this.fetch });
        if (status === 404 || status === 410) this.unsubscribe(sub.endpoint);
        else if (status >= 200 && status < 300) delivered++;
        else this.log(`push recusado: ${status} ${new URL(sub.endpoint).hostname}`);
      } catch (error) { this.log(`push falhou: ${error.message}`); }
    }
    return delivered;
  }

  // Lê só as linhas novas do log desde a última vez.
  async poll() {
    const size = this.size();
    if (size < this.offset) { this.offset = size; this.partial = ''; }
    if (size === this.offset) return;
    const fd = fs.openSync(this.logFile, 'r');
    const length = Math.min(size - this.offset, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    try { fs.readSync(fd, buffer, 0, length, this.offset); } finally { fs.closeSync(fd); }
    this.offset += length;
    const lines = (this.partial + buffer.toString('utf8')).split('\n');
    this.partial = lines.pop();
    this.write(this.offsetFile, { offset: this.offset - Buffer.byteLength(this.partial) });
    if (!this.subs.length) return;
    const tasks = this.read(this.stateFile, {})?.tasks ?? {};
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const project = this.projects?.().find((p) => p.id === event.project);
      if (this.projects && !project) continue;
      const scopedTasks = project ? this.read(project.stateFile, {})?.tasks ?? {} : tasks;
      const message = notificationFor(event, scopedTasks, project ? `${project.owner}/${project.repo}` : this.repo, this.timeZone);
      if (message && event.project && !message.body.includes(`${event.project} ·`)) message.body = `${event.project} · ${message.body}`;
      if (message) await this.broadcast(message);
    }
  }

  start(intervalMs = 5000) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try { await this.poll(); } catch (error) { this.log(`push: ${error.message}`); } finally { busy = false; }
    }, intervalMs);
    timer.unref?.();
    return timer;
  }
}
