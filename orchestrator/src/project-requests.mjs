import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PROJECT_ID, projectsFile } from './projects.mjs';

const PART = /^[A-Za-z0-9_.-]{1,100}$/;
const TYPES = new Set(['adicionar', 'pausar', 'retomar', 'remover', 'gerar-configuracao', 'verificar-acesso']);
export const projectRequestsDir = (config) => path.join(path.dirname(projectsFile(config)), 'pedidos-projetos');

export function parseRepository(value) {
  const text = String(value ?? '').trim();
  const match = /^(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+?)\/?$/.exec(text);
  if (!match) throw new Error('cole o endereço https://github.com/dono/repositorio');
  const owner = match[1], repo = match[2].replace(/\.git$/, '');
  if (![owner, repo].every((v) => PART.test(v) && !['.', '..'].includes(v))) throw new Error('dono ou repositório inválido');
  return { owner, repo };
}

export function suggestProjectId(repo, projects = []) {
  let base = String(repo).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!/^[a-z]/.test(base)) base = `p${base}`;
  base = base.padEnd(2, 'p').slice(0, 12);
  const used = new Set(projects.map((p) => p.id));
  for (let n = 0; ; n++) {
    const suffix = n ? String(n) : '';
    const id = base.slice(0, 12 - suffix.length) + suffix;
    if (!used.has(id)) return id;
  }
}

export function validateProjectRequest(value, projects) {
  if (!value || !TYPES.has(value.type)) throw new Error('pedido de projeto inválido');
  const type = value.type;
  if (type === 'adicionar') {
    if (value.url !== undefined ? typeof value.url !== 'string' : typeof value.owner !== 'string' || typeof value.repo !== 'string') throw new Error('dono e repositório devem ser textos');
    const { owner, repo } = parseRepository(value.url ?? `${value.owner}/${value.repo}`);
    if (projects.filter((p) => !p.removedAt).length >= 10) throw new Error('o limite é de 10 projetos');
    if (projects.some((p) => !p.removedAt && `${p.owner}/${p.repo}`.toLowerCase() === `${owner}/${repo}`.toLowerCase())) throw new Error('projeto já adicionado');
    const id = value.id === undefined ? suggestProjectId(repo, projects) : value.id;
    if (!PROJECT_ID.test(id) || projects.some((p) => p.id === id)) throw new Error('id inválido ou já usado (2 a 12 letras/números, começando por letra minúscula)');
    return { type, owner, repo, id };
  }
  if (!PROJECT_ID.test(value.id) || !projects.some((p) => p.id === value.id && !p.removedAt)) throw new Error('projeto inválido');
  return { type, id: value.id };
}

export class ProjectRequestQueue {
  constructor(dir) { this.dir = dir; }
  add(value) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.json`;
    const file = path.join(this.dir, name);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    fs.renameSync(`${file}.tmp`, file);
  }
  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir).sort().filter((n) => /^\d{13}-[a-f0-9]{16}\.json$/.test(n)).map((name) => {
      const file = path.join(this.dir, name);
      try {
        if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4096) return { file, value: null };
        return { file, value: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch { return { file, value: null }; }
    });
  }
  remove(item) { fs.rmSync(item.file, { force: true }); }
}
