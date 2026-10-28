// Cria um laboratório de demonstração com dados fictícios, para ver o painel sem GitHub nem Docker
// (e gerar as imagens da documentação). Nada aqui toca o laboratório real.
// Uso: node scripts/demo-painel.mjs /tmp/lab-demo
//      LAB_ORCHESTRATOR_CONFIG=/tmp/lab-demo/config.json LAB_PAINEL_PORT=7799 node orchestrator/src/dashboard.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processIdentity } from '../orchestrator/src/proc.mjs';

const root = path.resolve(process.argv[2] ?? '/tmp/lab-demo');
const here = path.dirname(fileURLToPath(import.meta.url));
fs.rmSync(root, { recursive: true, force: true });
const state = path.join(root, 'state');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
};
const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

const config = JSON.parse(fs.readFileSync(path.join(here, '../orchestrator/config.example.json'), 'utf8'));
Object.assign(config, {
  enabled: true, projectsFile: path.join(state, 'projetos.json'), stateFile: path.join(state, 'state.json'),
  lockFile: path.join(state, 'orchestrator.lock'), logFile: path.join(root, 'logs', 'orchestrator.jsonl')
});
config.scheduler.maxConcurrency = 3;
config.rooms = { ...config.rooms, labRoot: root, controlRoot: path.join(root, 'workspaces') };
config.git = { mirrorDir: path.join(state, 'git', 'repo.git') };
write(path.join(root, 'config.json'), config);

const settings = {
  dependencias: ['package-lock.json'], instalar: ['npm ci'], verificar: [['npm run lint', 'npm run build', 'npm test'], ['npm run test:e2e']],
  leia: ['AGENTS.md'], proibido: { dominios: ['acme.example'], portas: [], pastas: [], texto: '' }, imagensDeTeste: ['postgres:16'],
  dominiosExtras: [], previa: { porta: 5173, passos: [{ rodar: 'npm run dev', esperar: 'http://127.0.0.1:5173/' }], logins: 'admin@teste.local / senha-de-teste' }
};
const projects = [
  { id: 'loja', owner: 'acme', repo: 'loja-online', enabled: true, addedAt: ago(9000), status: 'pronto', detail: '' },
  { id: 'agenda', owner: 'acme', repo: 'agenda-clinica', enabled: true, addedAt: ago(6000), status: 'pronto', detail: '' }
];
write(config.projectsFile, projects);

const sha = (n) => String(n).repeat(40).slice(0, 40);
const task = (issue, agent, title, areas, status, extra = {}) => ({
  issueNumber: issue, agent, title, areas, status, branch: `agente/${agent}/issue-${issue}`, attempts: 0, runSeq: 1,
  startedAt: ago(extra.minutes ?? 30), ...extra
});
const tasks = {
  loja: [
    task(42, 'claude', 'Corrigir cálculo de frete no checkout', ['checkout'], 'running', { minutes: 14, run: { startedAt: ago(13) } }),
    task(45, 'codex', 'Filtro por faixa de preço no catálogo', ['catalogo'], 'verifying', { minutes: 26, verifyRun: { startedAt: ago(3) }, candidateSha: sha(4) }),
    task(38, 'claude', 'Login com link mágico por e-mail', ['auth'], 'ready', { minutes: 95, prNumber: 51, readyAt: ago(40), verifiedAt: ago(42),
      candidateRef: 'refs/lab/issue-38/candidato', candidateSha: sha(3),
      agentSummary: 'STATUS: COMPLETO\nLogin por link de uso único (15 min), e-mail com o link e testes e2e do fluxo completo.' }),
    task(36, 'codex', 'Seção "Como rodar" no README', ['docs'], 'done', { minutes: 300, prNumber: 49, readyAt: ago(250), doneAt: ago(200) }),
    task(47, 'codex', 'Cupom de desconto na sacola', ['sacola'], 'retry', { minutes: 60, attempts: 1, nextAttemptAt: new Date(now + 17 * 60_000).toISOString(),
      lastError: { category: 'verify_failed', message: 'npm test: 2 testes falharam em cupom.test.js', at: ago(8) } })
  ],
  agenda: [
    task(12, 'codex', 'Remarcar consulta arrastando na agenda', ['agenda'], 'running', { minutes: 7, run: { startedAt: ago(6) } }),
    task(9, 'claude', 'Lembrete por WhatsApp 24 h antes da consulta', ['notificacoes'], 'ready', { minutes: 180, prNumber: 15, readyAt: ago(120),
      candidateRef: 'refs/lab/issue-9/candidato', candidateSha: sha(9) }),
    task(7, 'claude', 'Cadastro de convênios', ['cadastros'], 'done', { minutes: 900, prNumber: 11, doneAt: ago(600) })
  ]
};
const queue = {
  loja: [{ issue: 48, title: 'Frete grátis acima de R$ 200', agent: 'claude', areas: ['checkout'], warnings: [], kind: 'area', reason: 'área checkout ocupada pela #42, que está rodando' },
    { issue: 50, title: 'Página de rastreio do pedido', agent: 'codex+claude', areas: ['pedidos'], warnings: [], kind: 'dependency', reason: 'depende de #38, que ainda não foi concluída' }],
  agenda: [{ issue: 14, title: 'Relatório mensal em PDF', agent: 'codex', areas: ['relatorios'], warnings: [], kind: 'slots', reason: 'sem vaga: 3 de 3 salas ocupadas' }]
};
for (const p of projects) {
  write(path.join(state, 'projetos', p.id, 'state.json'), {
    version: 1, projectSettings: settings, configurationSource: 'repositorio', outbox: [], pendingDestroy: [], quota: {},
    breaker: { failures: [] }, queue: queue[p.id], queueAt: ago(0.2), tasks: Object.fromEntries(tasks[p.id].map((t) => [t.issueNumber, t]))
  });
  for (const t of tasks[p.id]) {
    const run = path.join(config.rooms.controlRoot, p.id, `${t.agent}-issue-${t.issueNumber}`, 'execucao-1');
    write(path.join(run, 'agente', 'prompt.txt'), `Você é o agente ${t.agent} trabalhando na issue #${t.issueNumber} de ${p.owner}/${p.repo}.\n`);
    write(path.join(run, 'agente', 'output.sanitized.log'), 'Lendo AGENTS.md...\nImplementando...\nTestes do que mudou: ok\n');
    if (['ready', 'done', 'retry'].includes(t.status)) {
      write(path.join(run, 'agente', 'exit-code'), '0\n');
      const failed = t.status === 'retry';
      write(path.join(run, 'verificacao', 'verify.sh'), '');
      write(path.join(run, 'verificacao', 'output.sanitized.log'), ['===== grupo 0 =====', '--- ok (21s): npm run lint', '--- ok (48s): npm run build',
        failed ? '--- FALHOU (35s): npm test' : '--- ok (35s): npm test', '===== grupo 1 =====', '--- ok (94s): npm run test:e2e',
        failed ? 'VERIFICACAO_FALHOU' : 'VERIFICACAO_OK'].join('\n'));
      write(path.join(run, 'verificacao', 'exit-code'), failed ? '1\n' : '0\n');
    }
  }
}

const events = [];
const event = (minutes, name, fields = {}) => events.push({ time: ago(minutes), event: name, ...fields });
event(300, 'started', { concurrency: 3 });
event(250, 'task_ready', { project: 'loja', issue: 36, pull: 49, agent: 'codex' });
event(200, 'task_done', { project: 'loja', issue: 36, pull: 49 });
event(120, 'task_ready', { project: 'agenda', issue: 9, pull: 15, agent: 'claude' });
event(95, 'task_started', { project: 'loja', issue: 38, agent: 'claude' });
event(42, 'base_merged', { project: 'loja', issue: 38 });
event(40, 'task_ready', { project: 'loja', issue: 38, pull: 51, agent: 'claude' });
event(26, 'task_started', { project: 'loja', issue: 45, agent: 'codex' });
event(14, 'task_started', { project: 'loja', issue: 42, agent: 'claude' });
event(8, 'task_retry', { project: 'loja', issue: 47, category: 'verify_failed', attempt: 1 });
event(7, 'task_started', { project: 'agenda', issue: 12, agent: 'codex' });
event(3, 'verify_room_started', { project: 'loja', issue: 45 });
for (let m = 240; m >= 0; m -= 2) events.push({ time: ago(m), event: 'tick_complete', active: m < 14 ? 3 : m < 30 ? 2 : 1, openIssues: 9, pendingGitHub: 0 });
events.sort((a, b) => a.time.localeCompare(b.time));
write(config.logFile, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

// "Controlador vivo": um processo qualquer que dura enquanto a demonstração estiver aberta.
const keeper = spawn('sleep', ['3600'], { detached: true, stdio: 'ignore' });
keeper.unref();
write(config.lockFile, { pid: keeper.pid, start: processIdentity(keeper.pid) });
console.log(path.join(root, 'config.json'));
