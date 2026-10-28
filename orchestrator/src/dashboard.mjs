#!/usr/bin/env node
import { readProjects, projectConfig, deniedDomains } from './projects.mjs';
import { ProjectRequestQueue, projectRequestsDir, validateProjectRequest } from './project-requests.mjs';
// Ações de projeto escrevem só pedidos; o controlador é o único escritor do registro.
// Escuta em 127.0.0.1 no WSL; o acesso remoto chega pelo portproxy do Windows (porta 7789), que o firewall
// libera só para a tailnet. Não usa token GitHub e só serve logs sanitizados.
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigPath, loadConfig } from './config.mjs';
import { accountStatus } from './accounts.mjs';
import { previewPlan, previewKey } from './preview-auto.mjs';
import { isSameProcess } from './proc.mjs';
import { redact } from './redact.mjs';
import { PushHub } from './push.mjs';
import { parseSession, SESSION_TAIL, tailLines } from './live.mjs';
import { FeedbackQueue, RetryQueue, MAX_FEEDBACK } from './requests.mjs';

function scopedProject(id) {
  const controller = loadConfig(configPath);
  const project = readProjects(controller).find((p) => p.id === id);
  if (!project) throw Object.assign(new Error('projeto inválido'), { status: 400 });
  const config = projectConfig(controller, project);
  config.projectSettings = readJson(config.stateFile, {}).projectSettings ?? null;
  return config;
}

const here = dirname(fileURLToPath(import.meta.url));
// LAB_ORCHESTRATOR_CONFIG permite um painel separado (ensaio) sem ler o estado da versão em uso.
const configPath = defaultConfigPath();
const PORT = Number(process.env.LAB_PAINEL_PORT ?? 7788);
const HOST = '127.0.0.1';
const SERVICE = 'laboratorio-orquestrador.service';
const PAGE = join(here, '../dashboard/index.html');
const PHASES = ['agente', 'coleta', 'verificacao'];
const LOG_FILES = { log: 'output.sanitized.log', prompt: 'prompt.txt', status: 'status.txt' };
const IMAGE_KEYS = ['LAB_CODEX_IMAGE', 'LAB_CLAUDE_IMAGE', 'LAB_PROXY_IMAGE', 'LAB_DIND_IMAGE'];
// Arquivos do app instalável (ícones e manifesto), servidos por lista fixa.
const STATIC = {
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/favicon.ico': ['icons/favicon-32.png', 'image/png'],
  '/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8', 'no-cache'],
  ...Object.fromEntries(['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'favicon-32.png']
    .map((name) => [`/icons/${name}`, [`icons/${name}`, 'image/png']]))
};

function run(cmd, args, timeout = 8000) {
  return new Promise((done) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      done({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function mtime(file) {
  try { return statSync(file).mtimeMs; } catch { return null; }
}

function readTail(file, bytes) {
  let fd;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

function labEnv(labRoot) {
  const env = {};
  for (const name of ['config.env.example', 'config.env', 'local.env']) {
    let text = '';
    try { text = readFileSync(join(labRoot, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
      if (m && IMAGE_KEYS.includes(m[1])) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return env;
}

// Tempos das fases a partir dos arquivos que o controlador escreve: o início é o arquivo de entrada,
// o fim é o exit-code gravado pelo supervisor.
function phaseInfo(dir, phase) {
  if (!existsSync(dir)) return null;
  const startFile = { agente: 'prompt.txt', verificacao: 'verify.sh', coleta: null }[phase];
  const files = readdirSync(dir);
  const started = startFile ? mtime(join(dir, startFile)) ?? mtime(join(dir, 'input.bundle')) : null;
  const ended = files.includes('exit-code') ? mtime(join(dir, 'exit-code')) : null;
  let exitCode = null;
  if (ended !== null) {
    const raw = readFileSync(join(dir, 'exit-code'), 'utf8').trim();
    exitCode = /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  const info = { phase, started, ended, exitCode, files: files.filter((f) => !f.endsWith('.bundle')) };
  if (phase === 'coleta') info.produced = files.includes('output.bundle');
  if (phase === 'verificacao' && files.includes(LOG_FILES.log)) {
    const text = readFileSync(join(dir, LOG_FILES.log), 'utf8');
    info.commands = [];
    let group = 0;
    for (const line of text.split('\n')) {
      const g = line.match(/^===== grupo (\d+) =====/);
      if (g) { group = Number(g[1]); continue; }
      const m = line.match(/^--- (ok|FALHOU) \((\d+)s\): (.*)$/);
      if (m) info.commands.push({ group, ok: m[1] === 'ok', seconds: Number(m[2]), command: m[3] });
    }
    info.result = text.includes('VERIFICACAO_OK') ? 'ok' : text.includes('VERIFICACAO_FALHOU') ? 'falhou' : null;
  }
  return info;
}

function scanRuns(controlRoot) {
  const runs = [];
  let dirs = [];
  try { dirs = readdirSync(controlRoot); } catch { return runs; }
  for (const name of dirs) {
    const m = name.match(/^([a-z0-9]+)-issue-(\d+)$/);
    if (!m) continue;
    for (const exec of readdirSync(join(controlRoot, name))) {
      const e = exec.match(/^execucao-(\d+)$/);
      if (!e) continue;
      const base = join(controlRoot, name, exec);
      const phases = {};
      for (const phase of PHASES) {
        const info = phaseInfo(join(base, phase), phase);
        if (info) phases[phase] = info;
      }
      runs.push({ id: `${name}/${exec}`, agent: m[1], issue: Number(m[2]), seq: Number(e[1]), phases });
    }
  }
  return runs.sort((a, b) => b.issue - a.issue || b.seq - a.seq);
}

function readEvents(logFile, limit) {
  const events = [];
  for (const line of readTail(logFile, 2 * 1024 * 1024).split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* linha parcial */ }
  }
  return events.slice(-limit);
}

let roomCache = { at: 0, value: null };
async function rooms() {
  if (Date.now() - roomCache.at < 4000 && roomCache.value) return roomCache.value;
  const ps = await run('docker', ['ps', '-a', '--filter', 'label=lab.room', '--format', '{{json .}}']);
  if (!ps.ok) return { error: 'Docker indisponível', containers: [] };
  const containers = ps.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => ({
    name: c.Names, image: c.Image, state: c.State, status: c.Status, created: c.CreatedAt,
    project: c.Names.match(/^lab-(?:codex|claude)-([a-z][a-z0-9]{1,11})-(?:issue|verify|previa)/)?.[1] ?? null,
    room: (c.Labels ?? '').match(/(?:^|,)lab\.room=([^,]+)/)?.[1] ?? null
  }));
  const running = containers.filter((c) => c.state === 'running').map((c) => c.name);
  if (running.length) {
    const st = await run('docker', ['stats', '--no-stream', '--format', '{{json .}}', ...running], 15000);
    const byName = new Map(st.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((s) => [s.Name, s]));
    for (const c of containers) {
      const s = byName.get(c.name);
      if (s) Object.assign(c, { cpu: s.CPUPerc, mem: s.MemUsage, memPerc: s.MemPerc, net: s.NetIO, block: s.BlockIO, pids: s.PIDs });
    }
  }
  roomCache = { at: Date.now(), value: { containers } };
  return roomCache.value;
}

let imageCache = { at: 0, value: null };
async function images(config) {
  if (Date.now() - imageCache.at < 60000 && imageCache.value) return imageCache.value;
  const env = labEnv(config.rooms.labRoot);
  const names = [...new Set([...IMAGE_KEYS.slice(2).map((k) => env[k]).filter(Boolean),
    ...readProjects(config).flatMap((p) => [`sala-base-${p.id}:local`, `sala-codex-${p.id}:local`, `sala-claude-${p.id}:local`])])];
  const list = [];
  for (const ref of names) {
    const r = await run('docker', ['image', 'inspect', ref, '--format', '{{json .}}']);
    if (!r.ok) { list.push({ ref, missing: true }); continue; }
    const img = JSON.parse(r.stdout);
    const labels = img.Config?.Labels ?? {};
    list.push({
      ref, id: img.Id, created: img.Created, size: img.Size,
      lockfile: labels['lab.lockfile.sha256'] ?? null, source: labels['lab.source.commit'] ?? null
    });
  }
  const preloadFile = join(config.images?.preloadDir ?? join(dirname(config.stateFile), 'images'), 'preload.json');
  const preload = readProjects(config).flatMap((p) => readJson(join(dirname(projectConfig(config, p).stateFile), 'images', 'preload.json'), []).map((i) => ({ ...i, project: p.id }))).map((p) => ({ ref: p.ref, id: p.id, savedAt: p.savedAt, size: mtime(p.file) ? statSync(p.file).size : null }));
  imageCache = { at: Date.now(), value: { list, preload } };
  return imageCache.value;
}

async function host() {
  const [docker, mem, load, disk] = await Promise.all([
    run('docker', ['version', '--format', '{{.Server.Version}}'], 5000),
    run('free', ['-b']),
    run('cat', ['/proc/loadavg']),
    run('df', ['-B1', '--output=size,used,avail', '/'])
  ]);
  const memLine = mem.stdout.split('\n').find((l) => l.startsWith('Mem:'))?.split(/\s+/) ?? [];
  const diskLine = disk.stdout.trim().split('\n')[1]?.trim().split(/\s+/) ?? [];
  return {
    docker: docker.ok ? docker.stdout.trim() : null,
    memTotal: Number(memLine[1]) || null, memUsed: Number(memLine[2]) || null,
    load: load.stdout.trim().split(' ').slice(0, 3).map(Number),
    diskTotal: Number(diskLine[0]) || null, diskUsed: Number(diskLine[1]) || null
  };
}

async function projectOverview(config) {
  const state = readJson(config.stateFile, { tasks: {}, outbox: [], pendingDestroy: [] });
  const lock = readJson(config.lockFile, null);
  const [svc, svcSince] = await Promise.all([
    run('systemctl', ['--user', 'is-active', SERVICE], 4000),
    run('systemctl', ['--user', 'show', SERVICE, '-p', 'ActiveEnterTimestamp', '--value'], 4000)
  ]);
  const events = readEvents(config.logFile, 3000);
  const lastTick = [...events].reverse().find((e) => e.event === 'tick_complete') ?? null;
  const pending = new Map(feedbackQueue(config).list().map((r) => [r.issue, r.items.map((i) => ({ text: redact(i.text), at: i.at }))]));
  const retryPending = new Set(retryQueue(config).list().map((r) => r.issue));
  const tasks = Object.values(state.tasks ?? {}).map((t) => ({
    project: config.project, repo: `${config.github.owner}/${config.github.repo}`, previewLogins: state.projectSettings?.previa?.logins ?? '',
    issue: t.issueNumber, title: t.title, agent: t.agent, areas: t.areas, branch: t.branch, status: t.status,
    account: t.account ?? t.agent, revision: t.revision, prNumber: t.prNumber, attempts: t.attempts, runSeq: t.runSeq,
    runStartedAt: t.run?.startedAt ?? null, verifyStartedAt: t.verifyRun?.startedAt ?? null,
    continuations: t.continuations ?? 0, previewable: Boolean(state.projectSettings?.previa) && PREVIEWABLE.has(t.status) && Boolean(t.candidateRef && t.candidateSha),
    stack: t.stack ?? [], stackOn: t.stackOn ?? null, nextStages: t.status === 'staged' ? t.nextStages ?? [] : [], stagedAt: t.stagedAt ?? null,
    feedback: t.feedback ? { text: redact(t.feedback.text), at: t.feedback.at } : null, pendingFeedback: pending.get(t.issueNumber) ?? [],
    startedAt: t.startedAt, verifiedAt: t.verifiedAt, readyAt: t.readyAt, doneAt: t.doneAt,
    retryPending: retryPending.has(t.issueNumber), nextAttemptAt: t.nextAttemptAt, lastError: t.lastError, agentSummary: t.agentSummary ? redact(t.agentSummary) : null,
    uncommittedFiles: t.uncommittedFiles
  })).sort((a, b) => b.issue - a.issue);
  return {
    now: Date.now(),
    project: config.project,
    repo: `${config.github.owner}/${config.github.repo}`,
    controller: {
      enabled: config.enabled,
      service: svc.stdout.trim() || 'desconhecido',
      since: svcSince.stdout.trim() || null,
      pid: lock?.pid ?? null,
      alive: lock ? isSameProcess(lock) : false,
      lastTick,
      pollSeconds: config.scheduler.pollSeconds,
      maxConcurrency: config.scheduler.maxConcurrency,
      agents: config.labels.agents,
      outbox: (state.outbox ?? []).length,
      pendingDestroy: (state.pendingDestroy ?? []).length,
      pause: state.pause ?? null,
      queue: (state.queue ?? []).map((q) => ({ ...q, project: config.project, repo: `${config.github.owner}/${config.github.repo}` })),
      configurationError: state.configurationError ?? null,
      issueWarnings: state.issueWarnings ?? {},
      queueAt: state.queueAt ?? null,
      breakerUntil: state.breaker?.openUntil ?? null,
      quota: state.quota ?? {}
    },
    tasks,
    preview: await previewState(config),
    push: { subscribers: push?.subs.length ?? 0 },
    runs: scanRuns(config.rooms.controlRoot).map((r) => ({ ...r, project: config.project, id: `${config.project}/${r.id}` })),
    events: events.filter((e) => e.event !== 'tick_complete').slice(-400),
    ticks: events.filter((e) => e.event === 'tick_complete').slice(-240).map((e) => ({ time: e.time, active: e.active, openIssues: e.openIssues, pendingGitHub: e.pendingGitHub }))
  };
}

async function overview() {
  const controller = loadConfig(configPath);
  const projects = readProjects(controller).filter((p) => !p.removedAt);
  const values = [];
  const warnings = [];
  for (const p of projects) {
    try { values.push(await projectOverview(scopedProject(p.id))); }
    catch (error) { warnings.push({ project: p.id, reason: redact(error.message), kind: 'config' }); }
  }
  const first = values[0] ?? { controller: {}, events: [], ticks: [], preview: null };
  return { ...first, now: Date.now(), repo: projects.map((p) => `${p.owner}/${p.repo}`).join(' · '),
    projectIds: readProjects(controller).map((p) => p.id),
    projects: projects.map((p) => ({ id: p.id, owner: p.owner, repo: p.repo, enabled: p.enabled,
      status: p.status ?? (p.enabled ? 'verificando-acesso' : 'pausado'), detail: redact(p.detail ?? ''),
      configurationSource: readJson(projectConfig(controller, p).stateFile, {}).configurationSource ?? (p.config ? 'laboratorio' : 'partida') })),
    tasks: values.flatMap((v) => v.tasks), runs: values.flatMap((v) => v.runs),
    controller: { enabled: controller.enabled, agents: controller.labels.agents, pollSeconds: controller.scheduler.pollSeconds,
      ...first.controller, maxConcurrency: controller.scheduler.maxConcurrency,
      accounts: accountStatus(controller, values.map((v) => v.controller.quota), values.flatMap((v) => v.tasks)),
      outbox: values.reduce((n, v) => n + v.controller.outbox, 0),
      pendingDestroy: values.reduce((n, v) => n + v.controller.pendingDestroy, 0),
      queue: [...warnings, ...values.flatMap((v) => v.controller.queue ?? []),
        ...values.filter((v) => v.controller.configurationError).map((v) => ({ project: v.project, kind: 'config', reason: v.controller.configurationError }))],
      issueWarnings: Object.fromEntries(values.flatMap((v) => Object.entries(v.controller.issueWarnings).map(([n, w]) => [`${v.project}:${n}`, w]))),
      pause: values.find((v) => v.controller.pause)?.controller.pause ?? null }
  };
}

function readRunFile(id, kind, project) {
  const config = scopedProject(project);
  if (!String(id).startsWith(`${project}/`)) return null;
  id = id.slice(project.length + 1);
  const m = String(id).match(/^([a-z0-9]+-issue-\d+)\/(execucao-\d+)\/(agente|coleta|verificacao)$/);
  const name = LOG_FILES[kind];
  if (!m || !name) return null;
  const file = join(config.rooms.controlRoot, m[1], m[2], m[3], name);
  if (!existsSync(file)) return null;
  return redact(readTail(file, 1024 * 1024));
}

// Atividade ao vivo de uma tarefa: na fase do agente, a sessão do CLI dentro da sala; na verificação,
// o fim do log dos comandos.
const LIVE_PHASES = new Set(['starting', 'running', 'collecting', 'verifying', 'delivering']);
const liveCache = new Map();
async function live(issue, project) {
  const config = scopedProject(project);
  const key = `${project}:${issue}`;
  const cached = liveCache.get(key);
  if (cached && Date.now() - cached.at < 4000) return cached.value;
  const task = readJson(config.stateFile, { tasks: {} }).tasks?.[String(issue)];
  if (!task || !LIVE_PHASES.has(task.status)) return { issue, active: false };
  let value;
  if (task.status === 'verifying' && task.verifyRun?.dir) {
    value = { issue, active: true, phase: 'verificacao', lines: tailLines(readTail(join(task.verifyRun.dir, 'output.log'), 64 * 1024), 25) };
  } else {
    const container = `lab-${task.agent}-${project}-issue-${task.issueNumber}-agent`;
    const r = await run('docker', ['exec', container, 'bash', '-c', SESSION_TAIL], 8000);
    const session = parseSession(r.stdout);
    value = { issue, active: true, phase: 'agente', container, ...session };
    // Sem sessão legível (ou ainda vazia): a saída do CLI que o controlador grava no PC.
    if (!session.items.length && task.run?.dir) value.lines = tailLines(readTail(join(task.run.dir, 'output.log'), 64 * 1024), 25);
    if (task.run?.dir) value.outputAt = mtime(join(task.run.dir, 'output.log'));
  }
  liveCache.set(key, { at: Date.now(), value });
  return value;
}

// Prévia de PR (ou de etapa pronta): uma por vez, numa sala sem credenciais (scripts/preview.sh).
const PREVIEWABLE = new Set(['ready', 'staged']);
const PREVIEW_PORT = Number(process.env.LAB_PREVIEW_PORT ?? 8601);
const PREVIEW_HTTPS_PORT = Number(process.env.LAB_PREVIEW_HTTPS_PORT ?? 8443);
const previewFile = (config) => join(config.rooms.labRoot, 'workspaces', 'previa.json');
async function previewState(config) {
  const saved = readJson(previewFile(config), null);
  if (!saved) return null;
  const tsName = lanCache.value.find((a) => a.kind === 'Tailscale (nome)')?.address;
  const url = tsName ? `https://${tsName}:${PREVIEW_HTTPS_PORT}/` : `http://127.0.0.1:${PREVIEW_PORT}/`;
  if (saved.state === 'pronta') {
    // O PC ou o Docker reiniciou: a prévia caiu mesmo com o arquivo dizendo "pronta".
    const r = await run('docker', ['inspect', '--format', '{{.State.Running}}', process.env.LAB_PREVIEW_FORWARD ?? 'lab-previa-porta', `lab-codex-${saved.project}-previa-agent`], 4000);
    if (!r.ok || r.stdout.includes('false')) return { ...saved, state: 'caiu', url };
  }
  if (saved.state === 'preparando' && Date.now() - Date.parse(saved.at) > 20 * 60_000) return { ...saved, state: 'erro', detail: 'demorou demais', url };
  return { ...saved, url };
}

let previewStarting = false;
async function startPreview(issue, project) {
  if (previewStarting) return { status: 409, body: { error: 'já preparando uma prévia' } };
  previewStarting = true;
  try {
    const config = scopedProject(project);
    if (!config.projectSettings?.previa) return { status: 409, body: { error: 'projeto precisa de configuração' } };
    const task = readJson(config.stateFile, { tasks: {} }).tasks?.[String(issue)];
    if (!task || !PREVIEWABLE.has(task.status) || !task.candidateRef || !/^[0-9a-f]{40}$/.test(task.candidateSha ?? '')) {
      return { status: 409, body: { error: 'só PRs prontos e etapas prontas têm prévia' } };
    }
    const current = await previewState(config);
    if (current?.state === 'preparando') return { status: 409, body: { error: `já preparando a prévia da #${current.issue}` } };
    const workspaces = join(config.rooms.labRoot, 'workspaces');
    const bundle = join(workspaces, 'previa.bundle');
    const made = await run('git', ['--git-dir', config.git.mirrorDir, 'bundle', 'create', '--quiet', bundle, task.candidateRef], 60000);
    if (!made.ok) return { status: 500, body: { error: 'não consegui empacotar o commit do PR' } };
    const file = previewFile(config);
    writeFileSync(`${file}.tmp`, JSON.stringify({ project, issue: Number(issue), sha: task.candidateSha, state: 'preparando', at: new Date().toISOString(), detail: '' }));
    renameSync(`${file}.tmp`, file);
    const out = openSync(join(workspaces, 'previa.log'), 'w');
    spawn('bash', [join(config.rooms.labRoot, 'scripts', 'preview.sh'), 'start', String(issue), task.candidateSha, bundle, project], {
      detached: true, stdio: ['ignore', out, out], env: { ...process.env, LAB_PREVIEW_PORT: String(PREVIEW_PORT), LAB_PROJECT_CONFIG: JSON.stringify(config.projectSettings),
        LAB_DENIED_DOMAINS: deniedDomains(config, config.projectSettings).join('\n'), LAB_EXTRA_DOMAINS: config.projectSettings.dominiosExtras.join('\n') }
    }).unref();
    closeSync(out);
    return { status: 202, body: { ok: true } };
  } finally { previewStarting = false; }
}

function stopPreview() {
  const config = loadConfig(configPath);
  spawn('bash', [join(config.rooms.labRoot, 'scripts', 'preview.sh'), 'stop'], { detached: true, stdio: 'ignore' }).unref();
  return { status: 202, body: { ok: true } };
}

const declinedPreviews = new Set();
let previewStoppedAt = 0;
// Quem para a prévia pelo botão desliga a automática para aquele commit (até o PR mudar).
function declinePreview() {
  const saved = readJson(previewFile(loadConfig(configPath)), null);
  if (saved) declinedPreviews.add(previewKey(saved.project, saved.issue, saved.sha));
}
async function autoPreview() {
  const controller = loadConfig(configPath);
  if (controller.preview?.auto === false || previewStarting || Date.now() - previewStoppedAt < 60_000) return;
  // Projeto pausado não ganha prévia automática.
  const projects = readProjects(controller).filter((p) => p.enabled && !p.removedAt).map((p) => {
    const config = scopedProject(p.id);
    return { id: p.id, preview: Boolean(config.projectSettings?.previa), tasks: readJson(config.stateFile, { tasks: {} }).tasks ?? {} };
  });
  const plan = previewPlan(await previewState(controller), projects, declinedPreviews);
  if (plan?.stop) {
    stopPreview(); previewStoppedAt = Date.now();
    console.log('prévia automática: derrubada (PR mergeado, fechado, bloqueado ou com commit novo)');
  } else if (plan?.start) {
    const result = await startPreview(plan.start.issue, plan.start.project);
    if (result.status >= 400) declinedPreviews.add(previewKey(plan.start.project, plan.start.issue, plan.start.sha));
    console.log(`prévia automática: #${plan.start.issue} (${plan.start.project}) ${result.status}`);
  }
}

const retryQueue = (config) => new RetryQueue(join(dirname(config.stateFile), 'tentativas'));
const feedbackQueue = (config) => new FeedbackQueue(join(dirname(config.stateFile), 'pedidos'));

// "Faltou isso" / "isso está errado": o pedido vai para a fila do controlador, que manda o mesmo agente
// ajustar a mesma branch. A prévia daquela tarefa é desligada, porque vai ficar desatualizada.
async function requestFeedback(body) {
  const config = scopedProject(body.project);
  const issue = body.issue;
  if (!Number.isInteger(issue)) return { status: 400, body: { error: 'issue inválida' } };
  const queue = feedbackQueue(config);
  if (body.acao === 'cancelar') { queue.clear(issue); return { status: 200, body: { ok: true } }; }
  if (body.acao !== 'enviar') return { status: 400, body: { error: 'ação desconhecida' } };
  const task = readJson(config.stateFile, { tasks: {} }).tasks?.[String(issue)];
  if (!task || !PREVIEWABLE.has(task.status)) return { status: 409, body: { error: 'só dá para pedir ajuste em PR pronto ou etapa pronta' } };
  const text = String(body.texto ?? '').trim();
  if (!text) return { status: 400, body: { error: 'escreva o que precisa mudar' } };
  if (text.length > MAX_FEEDBACK) return { status: 400, body: { error: `texto grande demais (máximo ${MAX_FEEDBACK} caracteres)` } };
  if (!queue.add(issue, text)) return { status: 500, body: { error: 'não consegui guardar o pedido' } };
  const preview = readJson(previewFile(config), null);
  if (preview?.issue === issue && preview.project === body.project) stopPreview();
  return { status: 202, body: { ok: true } };
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { fail(new Error('corpo grande demais')); req.destroy(); } else chunks.push(chunk);
    });
    req.on('end', () => { try { done(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { fail(new Error('JSON inválido')); } });
    req.on('error', fail);
  });
}

// Ações (POST) só pelo próprio painel: o cabeçalho próprio obriga o navegador a pedir permissão (CORS) a
// qualquer outro site, e o painel nunca concede; a Origin, quando vem, tem de ser o próprio endereço.
function sameOrigin(req) {
  if (req.headers['x-painel'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function action(req, url) {
  if (!sameOrigin(req)) return { status: 403, body: { error: 'ação recusada' } };
  const body = await readBody(req, url.pathname.startsWith('/api/projetos/') ? 4096 : 16 * 1024);
  if (url.pathname.startsWith('/api/projetos/')) {
    const config = loadConfig(configPath);
    const request = validateProjectRequest({ ...body, type: url.pathname.slice('/api/projetos/'.length) }, readProjects(config));
    new ProjectRequestQueue(projectRequestsDir(config)).add(request);
    return { status: 202, body: { ok: true, id: request.id } };
  }
  if (url.pathname === '/api/push/subscribe') {
    if (!push) return { status: 503, body: { error: 'avisos indisponíveis' } };
    if (!push.subscribe(body.subscription, String(req.headers['user-agent'] ?? ''))) return { status: 400, body: { error: 'inscrição inválida' } };
    await push.broadcast({ title: 'Avisos ligados', body: 'Você vai saber quando uma tarefa terminar, der problema ou esperar sua aprovação.', url: '/', tag: 'teste' }, body.subscription.endpoint);
    return { status: 200, body: { ok: true } };
  }
  if (url.pathname === '/api/push/unsubscribe') { push?.unsubscribe(String(body.endpoint ?? '')); return { status: 200, body: { ok: true } }; }
  if (url.pathname === '/api/push/test') {
    if (!push?.has(String(body.endpoint ?? ''))) return { status: 404, body: { error: 'este aparelho não está inscrito' } };
    const delivered = await push.broadcast({ title: 'Teste do painel', body: `Aviso de teste às ${new Date().toLocaleTimeString('pt-BR', { timeZone: loadConfig(configPath).timeZone })}.`, url: '/', tag: 'teste' }, body.endpoint);
    return delivered ? { status: 200, body: { ok: true } } : { status: 502, body: { error: 'o serviço de push recusou o aviso' } };
  }
  if (url.pathname === '/api/tentar-novamente') {
    const config = scopedProject(body.project);
    if (!Number.isSafeInteger(body.issue) || body.issue < 1) return { status: 400, body: { error: 'issue inválida' } };
    const task = readJson(config.stateFile, { tasks: {} }).tasks?.[body.issue];
    if (task?.status !== 'retry') return { status: 409, body: { error: 'esta tarefa não está em espera por nova tentativa' } };
    if (!config.projectRecord.enabled) return { status: 409, body: { error: 'retome o projeto na aba Projetos antes de tentar novamente' } };
    const queue = retryQueue(config);
    if (!queue.list().some((r) => r.issue === body.issue)) queue.add(body.issue);
    return { status: 202, body: { ok: true } };
  }
  if (url.pathname === '/api/ajuste') return requestFeedback(body);
  if (url.pathname === '/api/previa') {
    scopedProject(body.project);
    if (body.acao === 'abrir' && Number.isInteger(body.issue)) return startPreview(body.issue, body.project);
    if (body.acao === 'parar') { declinePreview(); previewStoppedAt = Date.now(); return stopPreview(); }
    return { status: 400, body: { error: 'ação desconhecida' } };
  }
  return { status: 404, body: { error: 'não encontrado' } };
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:"
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// Endereços do Windows para o link do celular (via interop do WSL): Tailscale (nome MagicDNS e IP 100.x)
// primeiro, depois a rede local.
let lanCache = { at: 0, value: [] };
async function lanAddresses() {
  if (Date.now() - lanCache.at < 300000) return lanCache.value;
  const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  const r = await run(ps, ['-NoProfile', '-Command', [
    "$ts = Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe'",
    "if (Test-Path $ts) { try { 'ts-name ' + ((& $ts status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')) } catch {} }",
    "Get-NetIPAddress -InterfaceAlias Tailscale -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { 'ts-ip ' + $_.IPAddress }",
    "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | ForEach-Object { 'lan ' + $_.IPv4Address.IPAddress }"
  ].join('; ')], 20000);
  const value = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const [kind, address] = line.trim().split(/\s+/);
    if (kind === 'ts-name' && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(address ?? '')) value.push({ kind: 'Tailscale (nome)', address });
    if (kind === 'ts-ip' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(address ?? '')) value.push({ kind: 'Tailscale (IP)', address });
    if (kind === 'lan' && /^(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/.test(address ?? '')) value.push({ kind: 'Rede local', address });
  }
  lanCache = { at: Date.now(), value };
  return value;
}
const LAN_PORT = Number(process.env.LAB_PAINEL_LAN_PORT ?? 7789);
// Porta HTTPS extra do `tailscale serve` (o painel de ensaio fica em :8444; o principal, na 443 sem porta).
const HTTPS_PORT = process.env.LAB_PAINEL_HTTPS_PORT ? Number(process.env.LAB_PAINEL_HTTPS_PORT) : null;

// Sem senha: quem alcança a porta (este PC e a tailnet, pelo firewall do Windows) vê o painel. O Host precisa
// ser um endereço deste computador, o que impede um site qualquer de ler o painel via DNS rebinding.
async function hostAllowed(host) {
  if ([`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(host)) return true;
  // Porta 7789 (portproxy) ou sem porta (HTTPS do `tailscale serve`, que entrega em 127.0.0.1:7788).
  const match = /^([a-z0-9.-]+)(?::(\d+))?$/i.exec(host ?? '');
  if (!match || (match[2] !== undefined && ![LAN_PORT, HTTPS_PORT].includes(Number(match[2])))) return false;
  const own = (list) => list.some(({ address }) => address.toLowerCase() === match[1].toLowerCase());
  if (own(lanCache.value)) return true;
  // Endereço desconhecido: talvez o IP tenha trocado. Reconsulta no máximo uma vez por minuto.
  if (Date.now() - lanCache.at > 60000) lanCache.at = 0;
  return own(await lanAddresses());
}

// A visão geral sai da memória: um laço em segundo plano a recalcula a cada 3 s enquanto alguém consultou nos
// últimos 2 minutos, e quem abre o painel recebe o resultado na hora. Uma ação (POST) descarta o guardado.
let overviewCache = null, overviewJob = null, overviewAsked = 0;
function refreshOverview() {
  overviewJob ??= overview().then((value) => { overviewCache = { value, at: Date.now() }; return value; }).finally(() => { overviewJob = null; });
  return overviewJob;
}
async function cachedOverview() {
  overviewAsked = Date.now();
  return overviewCache && Date.now() - overviewCache.at < 15_000 ? overviewCache.value : refreshOverview();
}

const server = createServer(async (req, res) => {
  // Registro dos acessos que não vêm do próprio PC (celular pela tailnet), para diagnóstico no journal.
  const origin = req.headers.host ?? '';
  if (!/^(localhost|127\.0\.0\.1):/.test(origin) && !/^\/(api|icons)\//.test(req.url)) {
    res.on('finish', () => console.log(`acesso ${res.statusCode} ${req.method} ${origin} ${req.url.split('?')[0]} ${String(req.headers['user-agent'] ?? '').slice(0, 80)}`));
  }
  if (!(await hostAllowed(req.headers.host))) return send(res, 403, { error: 'endereço não permitido' });
  const url = new URL(req.url, 'http://painel.local');
  if (req.method === 'POST') {
    try {
      const { status, body } = await action(req, url);
      overviewCache = null;
      return send(res, status, body);
    } catch (error) { return send(res, 400, { error: redact(error.message) }); }
  }
  if (req.method !== 'GET') return send(res, 405, { error: 'método não permitido' });
  // Links antigos com ?chave= continuam funcionando.
  if (url.searchParams.has('chave')) {
    res.writeHead(302, { location: '/', 'cache-control': 'no-store' });
    return res.end();
  }
  try {
    if (url.pathname === '/') return send(res, 200, readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    if (STATIC[url.pathname]) {
      const [file, type, cache = 'public, max-age=86400'] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': cache, 'x-content-type-options': 'nosniff' });
      return res.end(readFileSync(join(here, '../dashboard', file)));
    }
    if (url.pathname === '/api/acesso') {
      const ips = await lanAddresses();
      // HTTPS do `tailscale serve` primeiro: é o único que o celular instala como app.
      const https = ips.filter(({ kind }) => kind === 'Tailscale (nome)')
        .map(({ address }) => ({ kind: 'Tailscale HTTPS (instala como app)', url: `https://${address}/` }));
      const links = [...https, ...ips.map(({ kind, address }) => ({ kind, url: `http://${address}:${LAN_PORT}/` }))];
      return send(res, 200, { links, port: LAN_PORT });
    }
    if (url.pathname === '/api/overview') return send(res, 200, await cachedOverview());
    if (url.pathname === '/api/rooms') return send(res, 200, await rooms());
    if (url.pathname === '/api/host') return send(res, 200, await host());
    if (url.pathname === '/api/images') return send(res, 200, await images(loadConfig(configPath)));
    if (url.pathname === '/api/live') {
      const issue = Number(url.searchParams.get('issue'));
      return Number.isInteger(issue) && issue > 0 ? send(res, 200, await live(issue, url.searchParams.get('project'))) : send(res, 400, { error: 'issue inválida' });
    }
    if (url.pathname === '/api/push') return send(res, 200, { publicKey: push?.publicKey ?? null, subscribed: push?.has(url.searchParams.get('endpoint') ?? '') ?? false });
    if (url.pathname === '/api/file') {
      const text = readRunFile(url.searchParams.get('run'), url.searchParams.get('kind'), url.searchParams.get('project'));
      return text === null ? send(res, 404, { error: 'arquivo não encontrado' }) : send(res, 200, text, 'text/plain; charset=utf-8');
    }
    return send(res, 404, { error: 'não encontrado' });
  } catch (error) {
    return send(res, error.status ?? 500, { error: redact(error.message) });
  }
});

// Avisos no celular (Web Push). Uma falha aqui deixa o painel no ar, só sem avisos.
let push = null;
try {
  const config = loadConfig(configPath);
  push = new PushHub({
    dir: join(dirname(config.stateFile), 'push'), logFile: config.logFile, stateFile: config.stateFile,
    projects: () => readProjects(config).map((p) => ({ ...p, stateFile: projectConfig(config, p).stateFile })),
    repo: `${config.github.owner}/${config.github.repo}`, subject: config.notify.pushSubject ?? 'https://github.com',
    timeZone: config.timeZone
  });
  push.start();
} catch (error) { console.log(`avisos desligados: ${error.message}`); }
lanAddresses().catch(() => {});

setInterval(() => { if (Date.now() - overviewAsked < 120_000) refreshOverview().catch(() => {}); }, 3000);
refreshOverview().catch(() => {});
setInterval(() => autoPreview().catch((error) => console.log(`prévia automática: ${redact(error.message)}`)), 30_000);

server.listen(PORT, HOST, () => console.log(`painel em http://localhost:${PORT}`));
