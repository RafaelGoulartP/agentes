import fs from 'node:fs';
import crypto from 'node:crypto';
import { readProjects, projectsFile, projectConfig, loadProjectSettings } from './projects.mjs';
import { ProjectRequestQueue, projectRequestsDir, validateProjectRequest } from './project-requests.mjs';
import { SLOT_STATUSES } from './domain.mjs';
import { ensureLabels } from './setup-labels.mjs';
import { availableAgents } from './accounts.mjs';
import { redact } from './redact.mjs';

const TITLE = 'Configurar o laboratório de agentes';
const MARKER = '<!-- laboratorio-agentes:configuracao-v1 -->';
export const configurationIssueBody = `${MARKER}
Analise este projeto e entregue SOMENTE .laboratorio.json e, se faltar, um AGENTS.md curto. Não altere o código do projeto.
Escolha dependências, instalação, verificações e prévia adequadas ao projeto. Use caminhos relativos sem .., comandos em uma linha e grupos de verificação não vazios. Todos os grupos precisam passar.
Esquema completo (adapte o exemplo):
\`\`\`json
{
  "dependencias": ["package-lock.json"],
  "instalar": ["npm ci"],
  "verificar": [["npm test", "npm run build"]],
  "leia": ["AGENTS.md", "README.md"],
  "proibido": {"dominios": [], "portas": [], "pastas": [], "texto": "não usar produção"},
  "imagensDeTeste": [],
  "dominiosExtras": [],
  "previa": {"porta": 5173, "passos": [{"rodar": "npm run dev -- --host 0.0.0.0", "esperar": "http://127.0.0.1:5173/"}], "logins": ""}
}
\`\`\`
dependencias: arquivos usados no build da imagem; instalar: comandos em ordem (pode ser vazio); verificar: listas de comandos; leia: arquivos para orientar o agente; proibido: domínios, portas, pastas e orientação; imagensDeTeste: imagens Docker necessárias; dominiosExtras: domínios permitidos além dos globais. previa é obrigatória: porta de 1 a 65535, passos em ordem com rodar e esperar opcional (URL HTTP(S) local), logins somente fictícios. reinstalar é opcional: comandos para reinstalar quando as dependências mudarem; ausente usa instalar. Listas sem itens podem ser vazias, exceto verificar, seus grupos e previa.passos. Não inclua segredos. As proibições globais do laboratório continuam valendo.
Depois da aprovação humana deste PR, o laboratório usará essa configuração e construirá a imagem. Nesta tarefa, a verificação só valida o arquivo de configuração.`;

// A issue vai para os agentes com login nesta máquina (com os dois, o menos ocupado pega).
export async function generateConfiguration(github, agents = ['codex']) {
  const existing = (await github.listOpenIssues()).find((i) => !i.pull_request && i.title === TITLE && i.body?.includes(MARKER));
  return existing ?? github.request('POST', '/issues', { title: TITLE, labels: agents.length ? agents : ['codex'], body: configurationIssueBody });
}

export async function checkProjectAccess(github, config) {
  try {
    const repo = await github.repository();
    if (repo.permissions && (repo.permissions.push !== true || repo.permissions.issues === false || repo.permissions.pull_requests === false)) {
      return { status: 'sem-acesso', detail: 'confira as permissões de escrita de Contents, Issues e Pull requests no token' };
    }
    if (!repo.default_branch) return { status: 'erro', detail: 'crie o repositório com um README (precisa de pelo menos um commit)' };
    try { await github.request('GET', `/commits/${encodeURIComponent(repo.default_branch)}`); }
    catch (error) {
      if ([404, 409, 422].includes(error.status)) return { status: 'erro', detail: 'crie o repositório com um README (precisa de pelo menos um commit)' };
      throw error;
    }
    if (repo.has_issues === false) return { status: 'erro', detail: 'ative Issues nas configurações do repositório' };
    await ensureLabels(github, config);
    return { status: 'acessivel', detail: '' };
  } catch (error) {
    if ([403, 404].includes(error.status)) return { status: 'sem-acesso', detail: 'inclua o repositório no token e confira as permissões' };
    // Sem internet (comum logo depois de ligar o PC) ou GitHub instável não é problema do projeto.
    if (!error.status || error.status >= 500) return { status: 'verificando-acesso', detail: 'sem conexão com o GitHub; tentando de novo' };
    return { status: 'erro', detail: redact(error.message).slice(0, 240) };
  }
}

// Acesso negado ou erro é conferido de novo sozinho de tempos em tempos: um problema passageiro
// nunca deixa um projeto parado até alguém tocar em "Verificar de novo".
const RECHECK_MS = 5 * 60_000;

// O registro só tem um escritor: o controlador. O painel escreve apenas a fila.
export class ProjectManager {
  constructor({ config, coordinator, createInstance, log = () => {}, queue = new ProjectRequestQueue(projectRequestsDir(config)) }) {
    Object.assign(this, { config, coordinator, createInstance, log, queue });
    this.projects = readProjects(config, { create: true });
    this.checked = new Set();
  }
  save() {
    const file = projectsFile(this.config), temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.projects, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  }
  status(project, status, detail = '') {
    detail = redact(String(detail)).slice(0, 240);
    if (project.status === status && project.detail === detail) return;
    Object.assign(project, { status, detail });
    this.save();
    this.log('project_status', { project: project.id, repo: project.repo, status, detail });
  }
  instance(project) {
    let instance = this.coordinator.instances.find((o) => o.config.project === project.id);
    if (!instance) {
      instance = this.createInstance(projectConfig(this.config, project));
      this.coordinator.attach(instance);
    }
    instance.config.projectRecord = project;
    instance.onProjectStatus = (status, detail) => this.status(project, status, detail);
    instance.admissionEnabled = project.enabled && !project.removedAt && this.checked.has(project.id);
    return instance;
  }
  active(project) {
    const instance = this.coordinator.instances.find((o) => o.config.project === project.id);
    // Inclui projetos pausados que ainda não foram anexados neste início.
    const state = instance?.state ?? (() => { try { return JSON.parse(fs.readFileSync(projectConfig(this.config, project).stateFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } })();
    return Object.values(state.tasks ?? {}).some((t) => SLOT_STATUSES.has(t.status) || t.status === 'delivering');
  }
  async verify(project) {
    const o = this.instance(project);
    const previous = project.status;
    project.checkedAt = new Date().toISOString();
    this.status(project, 'verificando-acesso');
    const result = await checkProjectAccess(o.github, this.config);
    if (result.status === 'acessivel') {
      this.checked.add(project.id);
      this.status(project, project.enabled ? (previous === 'configurando' ? 'configurando' : 'verificando-acesso') : 'pausado');
    } else { this.checked.delete(project.id); this.status(project, result.status, result.detail); }
    o.admissionEnabled = project.enabled && this.checked.has(project.id);
    return result.status === 'acessivel';
  }
  async apply(value) {
    const request = validateProjectRequest(value, this.projects);
    let p = this.projects.find((p) => p.id === request.id);
    if (request.type === 'adicionar') {
      p = { id: request.id, owner: request.owner, repo: request.repo, enabled: true, addedAt: new Date().toISOString() };
      this.projects.push(p); this.save(); await this.verify(p);
    } else if (request.type === 'pausar') {
      p.enabled = false; this.instance(p).admissionEnabled = false; this.status(p, 'pausado');
    } else if (request.type === 'remover') {
      if (this.active(p)) throw new Error('aguarde as tarefas em andamento terminarem antes de remover');
      p.enabled = false; p.removedAt = new Date().toISOString();
      this.status(p, 'pausado', 'removido da lista; histórico preservado');
      // Sem trabalho ativo, sai também da faxina periódica; os dados ficam guardados.
      this.coordinator.instances = this.coordinator.instances.filter((o) => o.config.project !== p.id);
      this.log('project_removed', { project: p.id });
    } else if (request.type === 'retomar') {
      p.enabled = true; this.save(); await this.verify(p);
    } else if (request.type === 'verificar-acesso') await this.verify(p);
    else if (request.type === 'gerar-configuracao') {
      if (!p.enabled) throw new Error('retome o projeto antes de gerar configuração');
      if (!await this.verify(p)) return;
      const o = this.instance(p);
      const repository = await o.github.repository();
      loadProjectSettings(o.config, o.git, repository.default_branch);
      if (o.config.configurationSource !== 'partida') throw new Error('o projeto já tem configuração');
      await generateConfiguration(o.github, availableAgents(this.config)); this.status(p, 'configurando');
    }
    this.save();
  }
  async refresh() {
    for (const item of this.queue.list()) {
      try { await this.apply(item.value); }
      catch (error) {
        const detail = redact(error.message).slice(0, 240);
        const p = this.projects.find((p) => p.id === item.value?.id);
        if (p) { p.detail = detail; this.save(); }
        this.log('project_request_rejected', { project: p?.id ?? null, detail });
      } finally { this.queue.remove(item); }
    }
    for (const p of this.projects.filter((p) => !p.removedAt)) {
      try {
        this.instance(p);
        const due = !['sem-acesso', 'erro'].includes(p.status) || !(Date.now() - Date.parse(p.checkedAt ?? 0) < RECHECK_MS);
        if (p.enabled && !this.checked.has(p.id) && due) await this.verify(p);
        if (!p.enabled) this.status(p, 'pausado', p.detail);
      } catch (error) { this.checked.delete(p.id); this.status(p, 'erro', error.message); }
    }
  }
}
