import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HostGit } from '../src/host-git.mjs';
import { ImageKeeper } from '../src/images.mjs';
import { Orchestrator } from '../src/orchestrator.mjs';
import { RoomRunner } from '../src/room-runner.mjs';
import { StateStore } from '../src/state-store.mjs';

// Teste integrado com salas Docker reais, agente falso (shell) e "GitHub" local (repositório bare).
// Não usa tokens, não acessa o GitHub e não gasta assinatura dos agentes. Execute com LAB_DOCKER_TEST=1
// depois de construir as imagens do projeto padrão: LAB_PROJECT_ID=principal PROJECT_ROOT=<repo> scripts/build-images.sh
// PROJECT_ROOT (opcional) é o repositório usado como "GitHub"; sem ele, o teste cria um projeto mínimo.
const enabled = process.env.LAB_DOCKER_TEST === '1';
const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
const fakeToken = `ghp_${'Z9'.repeat(18)}`;

const FAKE_AGENT = [
  "printf 'Arquivo criado pelo teste integrado do laboratório.\\n' > LAB-TESTE.md",
  'git add LAB-TESTE.md',
  "git commit -q -m 'teste: arquivo do laboratório'",
  // Processo esquecido com a saída herdada: a execução tem de terminar mesmo assim.
  '(sleep 3000 &)',
  `printf 'STATUS: COMPLETO\\nResumo falso. Token de mentira: ${fakeToken}\\n' > /tmp/lab/pr-summary.md`,
  `echo "saida com ${fakeToken}"`
].join(' && ');

// Projeto mínimo: um package.json com o script usado pela verificação.
function minimalProject(root) {
  const dir = path.join(root, 'projeto');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'projeto-minimo', private: true, scripts: { 'test:smoke': 'node -e "console.log(1)"' } }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  for (const args of [['init', '--quiet', '-b', 'main'], ['add', '.'], ['commit', '--quiet', '-m', 'inicial']]) execFileSync('git', args, { cwd: dir, env });
  return dir;
}

test('sala real: agente falso -> coleta -> verificação limpa -> push local -> PR falso -> limpeza', { skip: !enabled, timeout: 1_800_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-docker-it-'));
  const remote = path.join(root, 'remote.git');
  sh('git', ['clone', '--quiet', '--bare', '--no-local', process.env.PROJECT_ROOT ?? minimalProject(root), remote]);
  const volumesBefore = sh('docker', ['volume', 'ls', '-q']).split('\n').filter(Boolean).sort();

  const config = {
    github: { owner: 'o', repo: 'r' },
    git: { mirrorDir: path.join(root, 'mirror.git'), remoteUrl: remote },
    labels: { agents: ['codex', 'claude'], inProgress: 'em-andamento', blocked: 'bloqueado', readyForReview: 'pronto-para-revisao', areaPrefix: 'area:' },
    scheduler: { maxConcurrency: 2, hardMaxConcurrency: 3, defaultArea: 'geral' },
    retry: { baseSeconds: 3600, maxSeconds: 3600, maxAttempts: 3 },
    rooms: { labRoot, controlRoot: path.join(root, 'workspaces'), branchPrefix: 'teste-lab', agentCliAuth: false, agentTimeoutMinutes: 20, verifyTimeoutMinutes: 20 },
    agents: {
      codex: { command: ['bash', '-c', FAKE_AGENT, 'agente-falso'] },
      claude: { command: ['bash', '-c', 'echo "agente sem alteracoes"', 'agente-falso'] }
    },
    verify: {
      groups: [
        ['test -f LAB-TESTE.md', 'npm run test:smoke'],
        [
          "docker info --format 'dind {{.ServerVersion}}' && docker volume create volume-aninhado-teste >/dev/null",
          // Sem rede para o Docker Hub não faria diferença: a imagem precisa já estar carregada.
          "docker image inspect mongo:7 --format 'mongo pre-carregado {{.Id}}'",
          'cat /sys/fs/cgroup/cpu.max'
        ]
      ]
    },
    images: { preload: ['mongo:7'], preloadDir: path.join(root, 'images') }
  };
  const preloaded = await new ImageKeeper(config, null, () => {}).ensurePreload();
  const issue = (number, agent) => ({ number, title: `Teste integrado ${number}`, body: 'Issue falsa.', state: 'open', labels: [{ name: agent }, { name: `area:it-${number}` }] });
  const created = [];
  const github = {
    async listOpenIssues() { return [issue(9001, 'codex'), issue(9002, 'claude')]; },
    async listOpenPulls() { return created.map((pull) => ({ ...pull })); },
    async repository() { return { default_branch: 'main' }; },
    async getIssue() { throw Object.assign(new Error('404'), { status: 404 }); },
    async getPull(number) { return { ...created.find((pull) => pull.number === number), mergeable: true }; },
    async compare() { return { status: 'ahead', behind_by: 0 }; },
    async findOpenPull() { return null; },
    async createPull(body) { const pull = { number: 500 + created.length, head: { ref: body.head }, base: { ref: body.base }, body: body.body }; created.push(pull); return pull; },
    async addLabel() {}, async removeLabel() {}, async comment() {}
  };
  const events = [];
  const log = (event, fields) => events.push({ event, ...fields });
  const orchestrator = new Orchestrator({
    config, github, log, runner: new RoomRunner(config, log), git: new HostGit(config), store: new StateStore(path.join(root, 'state.json'))
  });

  const deadline = Date.now() + 25 * 60_000;
  const tasks = () => orchestrator.state.tasks;
  while (Date.now() < deadline && !(tasks()[9001]?.status === 'ready' && tasks()[9002]?.status === 'retry')) {
    await orchestrator.tick();
    if (['blocked'].includes(tasks()[9001]?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const ok = tasks()[9001];
  assert.equal(ok.status, 'ready', JSON.stringify(ok.lastError ?? events.slice(-5)));
  const branch = 'teste-lab/codex/issue-9001';
  assert.equal(sh('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${branch}`]), ok.candidateSha);
  assert.equal(sh('git', ['--git-dir', remote, 'show', `${ok.candidateSha}:LAB-TESTE.md`]), 'Arquivo criado pelo teste integrado do laboratório.');
  assert.equal(created.length, 1);
  assert.match(created[0].body, /Closes #9001/);
  assert.doesNotMatch(created[0].body, /ghp_/);

  assert.equal(tasks()[9002].lastError.category, 'no_commits');

  for (const file of [ok.agentLog, ok.verifyLog]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /ghp_/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.match(fs.readFileSync(ok.verifyLog, 'utf8'), /VERIFICACAO_OK/);
  const verifyLog = fs.readFileSync(ok.verifyLog, 'utf8');
  assert.match(verifyLog, /dind \d+/);
  assert.ok(verifyLog.includes(`mongo pre-carregado ${preloaded[0].id}`), 'mongo:7 carregado do host com o mesmo ID');
  assert.match(verifyLog, /===== grupo 0 =====[\s\S]*===== grupo 1 =====/);
  assert.match(verifyLog, /--- ok \(\d+s\): npm run test:smoke/);
  assert.match(verifyLog, /^110000 100000$/m, 'sala de verificação usa o perfil verify (1,1 CPU no contêiner principal)');

  assert.equal(sh('docker', ['ps', '-aq', '--filter', 'name=lab-.*-90']), '');
  assert.equal(sh('docker', ['network', 'ls', '-q', '--filter', 'name=lab-.*-90']), '');
  const volumesAfter = sh('docker', ['volume', 'ls', '-q']).split('\n').filter(Boolean).sort();
  assert.deepEqual(volumesAfter, volumesBefore, 'nenhum volume da sala ou aninhado ficou para trás');
  assert.equal(sh('bash', ['-c', `find ${root}/workspaces -name github.env | wc -l`]), '0');
  fs.rmSync(root, { recursive: true, force: true });
});
