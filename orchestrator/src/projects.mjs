import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_ID = /^[a-z][a-z0-9]{1,11}$/;
export const projectsFile = (config) => config.projectsFile ?? path.join(path.dirname(config.stateFile), 'projetos.json');
export const projectRoot = (config, id) => path.join(path.dirname(projectsFile(config)), 'projetos', id);

export { validateProjectConfig, bootstrapConfig } from '../../scripts/project-config.mjs';
import { validateProjectConfig, bootstrapConfig } from '../../scripts/project-config.mjs';

// Configuração em uso quando o projeto ainda não carregou a sua: a de partida, que não instala nada.
export const currentSettings = (config) => config.projectSettings ?? bootstrapConfig();

// Domínios negados pelo proxy: os do projeto mais os do laboratório (rooms.deniedDomains), que valem para
// todo projeto; um projeto novo sem a regra nunca alcança a produção de outro.
// Mesma forma que o proxy usa: ".dominio" (inclui subdomínios), sem repetição nem entradas já cobertas.
export function deniedDomains(controller, settings) {
  const all = [...new Set([...(controller.rooms?.deniedDomains ?? []), ...(settings?.proibido?.dominios ?? [])]
    .map((d) => `.${String(d).trim().toLowerCase().replace(/^\.+/, '')}`))];
  return all.filter((d) => !all.some((other) => other !== d && d.endsWith(other)));
}

// Sem registro, a instalação começa sem projetos: eles são adicionados pela aba Projetos do painel.
export function readProjects(config, { create = false } = {}) {
  const file = projectsFile(config);
  let projects;
  if (!fs.existsSync(file)) {
    projects = [];
    if (create) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(projects, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  } else projects = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(projects)) throw new Error('registro de projetos deve ser lista');
  const ids = new Set();
  for (const p of projects) {
    if (!PROJECT_ID.test(p.id) || ids.has(p.id)) throw new Error(`id de projeto inválido ou repetido: ${p.id}`);
    if (![p.owner, p.repo].every((v) => typeof v === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(v) && !['.', '..'].includes(v))) throw new Error(`repositório inválido: ${p.id}`);
    if (typeof p.enabled !== 'boolean' || !Number.isFinite(Date.parse(p.addedAt))) throw new Error(`registro inválido: ${p.id}`);
    ids.add(p.id);
  }
  return projects;
}

export function projectConfig(controller, project) {
  const config = structuredClone(controller);
  const root = projectRoot(controller, project.id);
  config.project = project.id; config.projectRecord = project;
  config.github = { ...config.github, owner: project.owner, repo: project.repo };
  config.git = { mirrorDir: path.join(root, 'git', 'repo.git') };
  config.stateFile = path.join(root, 'state.json');
  config.rooms.controlRoot = path.join(controller.rooms.controlRoot, project.id);
  config.images = { ...config.images, preloadDir: path.join(root, 'images'),
    codex: `sala-codex-${project.id}:local`, claude: `sala-claude-${project.id}:local` };
  // Até a main ser lida, nenhuma configuração de outro projeto pode ser herdada.
  delete config.projectSettings;
  return config;
}

export function applyProjectSettings(config, settings, { allowBootstrap = false } = {}) {
  config.projectSettings = validateProjectConfig(settings, { allowBootstrap });
  config.verify = { groups: config.projectSettings.verificar };
  config.images.preload = config.projectSettings.imagensDeTeste;
}

// O npm ci só instala um workspace cujo package.json está na imagem. Os declarados em "workspaces" do
// package.json da raiz entram nas dependências sozinhos, mesmo que o .laboratorio.json esqueça algum.
export function withWorkspaceManifests(settings, git, sha) {
  if (!settings?.dependencias?.some((file) => file === 'package.json' || file === 'package-lock.json')) return settings;
  const files = git.git(['ls-tree', '-r', '--name-only', sha]).stdout.split('\n').filter(Boolean);
  if (!files.includes('package.json')) return settings;
  let workspaces;
  try { workspaces = JSON.parse(git.git(['show', `${sha}:package.json`]).stdout).workspaces; } catch { return settings; }
  const patterns = (Array.isArray(workspaces) ? workspaces : workspaces?.packages ?? [])
    .filter((p) => typeof p === 'string' && p && !p.startsWith('!'));
  const matchers = patterns.map((p) => new RegExp(`^${p.replace(/^\.\//, '').replace(/\/+$/, '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*')}$`));
  const extra = files.filter((file) => file.endsWith('/package.json') && !file.split('/').includes('node_modules') &&
    !settings.dependencias.includes(file) && matchers.some((m) => m.test(file.slice(0, -'/package.json'.length))));
  return extra.length ? { ...settings, dependencias: [...settings.dependencias, ...extra] } : settings;
}

export function loadProjectSettings(config, git, branch) {
  git.ensure();
  const sha = git.fetchBranch(branch);
  if (!sha) throw new Error(`branch padrão ${branch} ausente`);
  // Só ausência permite fallback; erro de leitura ou JSON inválido nunca enfraquece a verificação.
  const exists = git.git(['ls-tree', '--name-only', sha, '--', '.laboratorio.json']).stdout.trim();
  const settings = exists ? JSON.parse(git.git(['show', `${sha}:.laboratorio.json`]).stdout) : config.projectRecord.config;
  config.configurationSource = exists ? 'repositorio' : settings ? 'laboratorio' : 'partida';
  applyProjectSettings(config, settings ? withWorkspaceManifests(settings, git, sha) : bootstrapConfig(), { allowBootstrap: !settings });
  config.projectSettingsSha = sha;
  return sha;
}
