import fs from 'node:fs';
import { ProjectManager } from './project-manager.mjs';
import { projectsFile } from './projects.mjs';
import { Coordinator } from './coordinator.mjs';
import { Notifier } from './notify.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultConfigPath, loadConfig, readEnvSecret } from './config.mjs';
import { GitHubClient } from './github.mjs';
import { HealthCheck } from './health.mjs';
import { HostGit } from './host-git.mjs';
import { ImageKeeper } from './images.mjs';
import { acquireLock } from './lock.mjs';
import { createLogger } from './logger.mjs';
import { Orchestrator } from './orchestrator.mjs';
import { registerSecret } from './redact.mjs';
import { RoomRunner } from './room-runner.mjs';
import { StateStore } from './state-store.mjs';
import { FeedbackQueue, RetryQueue } from './requests.mjs';

const configPath = defaultConfigPath();
const config = loadConfig(configPath);
const log = createLogger(config.logFile);
config.notify = { ...config.notify, url: process.env.LAB_NTFY_URL };
config.checkLogins = true;
registerSecret(config.notify.url);

// Piloto manual: `node src/main.mjs --piloto 123` trata só essa issue, uma sala por vez, mesmo com
// enabled=false. O serviço systemd nunca passa esse argumento.
const pilotAt = process.argv.indexOf('--piloto');
if (pilotAt !== -1) {
  const issue = Number(process.argv[pilotAt + 1]);
  if (!Number.isInteger(issue) || issue < 1) throw new Error('uso: --piloto <numero-da-issue>');
  config.scheduler.onlyIssues = [issue];
  config.scheduler.maxConcurrency = 1;
  log('pilot_mode', { issue });
} else if (!config.enabled) {
  // Sai com código 0: o serviço (Restart=on-failure) não reinicia em laço enquanto desligado.
  log('disabled', { config: configPath });
  process.exit(0);
}

if (!fs.existsSync(config.github.controllerTokenFile)) {
  throw new Error(`token do controlador ausente: crie ${config.github.controllerTokenFile} (veja docs/INSTALACAO.md)`);
}

const release = acquireLock(config.lockFile);
process.on('exit', release);

let stopping = false;
let wake = () => {};
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; wake(); });
const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  wake = () => { clearTimeout(timer); resolve(); };
});

// O Docker Desktop roda fora desta distribuição; não há dependência systemd confiável para ele.
let warned = false;
while (!stopping && spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 }).status !== 0) {
  if (!warned) { log('waiting_docker'); warned = true; }
  await sleep(10_000);
}

const token = readEnvSecret(config.github.controllerTokenFile, 'GH_TOKEN');
registerSecret(token);
const coordinator = new Coordinator(config.scheduler.maxConcurrency,
  new StateStore(path.join(path.dirname(projectsFile(config)), 'controller.json')));
const health = new HealthCheck(config);
const manager = new ProjectManager({ config, coordinator, log, createInstance(scoped) {
  const projectLog = (event, fields = {}) => log(event, { ...fields, project: scoped.project });
  const git = new HostGit(scoped);
  return new Orchestrator({
    config: scoped, github: new GitHubClient({ ...scoped.github, token }), git, log: projectLog,
    runner: new RoomRunner(scoped, projectLog), images: new ImageKeeper(scoped, git, projectLog), health,
    notify: new Notifier(scoped, { log: projectLog }), store: new StateStore(scoped.stateFile),
    requests: new FeedbackQueue(path.join(path.dirname(scoped.stateFile), 'pedidos')),
    retries: new RetryQueue(path.join(path.dirname(scoped.stateFile), 'tentativas'))
  });
} });
await manager.refresh();

log('started', { projects: manager.projects.filter((p) => !p.removedAt).map((p) => `${p.owner}/${p.repo}`), concurrency: config.scheduler.maxConcurrency });
const pollMs = config.scheduler.pollSeconds * 1000;
const activePollMs = (config.scheduler.activePollSeconds ?? 10) * 1000;
let lastFull = -Infinity;
while (!stopping) {
  const full = Date.now() - lastFull >= pollMs;
  if (full) { lastFull = Date.now(); await manager.refresh(); }
  await coordinator.cycle(full, (instance, error) => {
    if (full && instance.config.projectRecord.enabled) {
      if ([403, 404].includes(error.status)) {
        manager.checked.delete(instance.config.project);
        instance.admissionEnabled = false;
      }
      manager.status(instance.config.projectRecord, [403, 404].includes(error.status) ? 'sem-acesso' : 'erro', error.message);
    }
    log(full ? 'tick_failed' : 'local_tick_failed', { project: instance.config.project, message: error.message });
  });
  if (!stopping) await sleep(coordinator.instances.some((o) => o.hasActiveWork()) ? activePollMs : pollMs);
}
log('stopped');
