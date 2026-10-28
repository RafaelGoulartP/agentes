import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { currentSettings } from './projects.mjs';
import { redact } from './redact.mjs';

const LABEL = 'lab.lockfile.sha256';

export function preloadDirFor(config) {
  return config.images?.preloadDir ?? path.join(path.dirname(config.stateFile ?? config.git.mirrorDir), 'images');
}

export function readPreloadManifest(config) {
  try { return JSON.parse(fs.readFileSync(path.join(preloadDirFor(config), 'preload.json'), 'utf8')); } catch { return []; }
}

// Assíncrono: a reconstrução leva até uma hora e não pode travar o controlador nem os outros projetos.
function defaultExec(command, args, { timeout, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = { stdout: '', stderr: '' };
    const keep = (key) => (chunk) => { out[key] = (out[key] + chunk).slice(-4 * 1024 * 1024); };
    child.stdout.setEncoding('utf8').on('data', keep('stdout'));
    child.stderr.setEncoding('utf8').on('data', keep('stderr'));
    const timer = timeout ? setTimeout(() => child.kill('SIGTERM'), timeout) : null;
    child.on('error', (error) => { clearTimeout(timer); resolve({ status: null, ...out, error }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, ...out }); });
  });
}

// Mantém as dependências pré-instaladas nas imagens das salas. Reconstrói somente quando os lockfiles
// da branch base mudam; assim a sala quase nunca precisa de `npm ci`.
export class ImageKeeper {
  constructor(config, git, log, { exec = defaultExec, now = () => Date.now() } = {}) {
    Object.assign(this, { config, git, log, exec, now });
    this.images = [config.images?.codex ?? `sala-codex-${config.project ?? 'principal'}:local`, config.images?.claude ?? `sala-claude-${config.project ?? 'principal'}:local`];
    this.checkMs = (config.images?.checkMinutes ?? 10) * 60_000;
    this.lastCheck = -Infinity;
    this.preload = config.images?.preload ?? [];
    this.preloadMaxAgeMs = (config.images?.preloadMaxAgeDays ?? 7) * 86_400_000;
    this.preloadDir = preloadDirFor(config);
  }

  manifestPath() { return path.join(this.preloadDir, 'preload.json'); }
  readManifest() { return readPreloadManifest(this.config); }

  // Cópias locais (docker save) das imagens que os testes usam dentro do DinD, como o mongo:7.
  // Cada sala carrega o arquivo sem rede; o ID registrado é conferido depois do carregamento.
  async ensurePreload() {
    this.preload = this.config.projectSettings?.imagensDeTeste ?? this.preload;
    if (!this.preload.length) return [];
    fs.mkdirSync(this.preloadDir, { recursive: true, mode: 0o700 });
    const manifest = this.readManifest();
    const result = [];
    for (const ref of this.preload) {
      const current = manifest.find((item) => item.ref === ref);
      const fresh = current && fs.existsSync(current.file) && this.now() - current.savedAt < this.preloadMaxAgeMs;
      if (fresh) { result.push(current); continue; }
      const pull = await this.exec('docker', ['pull', '--quiet', ref], { timeout: 30 * 60_000 });
      if (pull.status !== 0) throw new Error(`docker pull ${ref} falhou: ${redact(pull.stderr).slice(-300)}`);
      const id = (await this.exec('docker', ['image', 'inspect', '--format', '{{.Id}}', ref])).stdout.trim();
      const file = path.join(this.preloadDir, `${ref.replace(/[^a-zA-Z0-9._-]/g, '_')}.tar`);
      const save = await this.exec('docker', ['save', '--output', `${file}.tmp`, ref], { timeout: 30 * 60_000 });
      if (save.status !== 0) throw new Error(`docker save ${ref} falhou: ${redact(save.stderr).slice(-300)}`);
      fs.renameSync(`${file}.tmp`, file);
      const entry = { ref, id, file, savedAt: this.now() };
      result.push(entry);
      this.log('preload_saved', { ref, id });
    }
    fs.writeFileSync(this.manifestPath(), JSON.stringify(result, null, 2), { mode: 0o600 });
    return result;
  }

  lockHash(sha) {
    const hash = createHash('sha256');
    const settings = currentSettings(this.config);
    for (const file of settings.dependencias) hash.update(file).update('\0').update(this.git.git(['show', `${sha}:${file}`]).stdout).update('\0');
    hash.update(JSON.stringify(settings.instalar));
    // A primeira configuração aprovada precisa substituir a imagem de partida.
    if (!settings.previa) hash.update('\0partida');
    return hash.digest('hex');
  }

  async imageHash(image) {
    const result = await this.exec('docker', ['image', 'inspect', '--format', `{{ index .Config.Labels "${LABEL}" }}`, image]);
    return result.status === 0 ? result.stdout.trim() : null;
  }

  async staleImages(wanted) {
    const stale = [];
    for (const image of this.images) if (await this.imageHash(image) !== wanted) stale.push(image);
    return stale;
  }

  // Lança erro se a reconstrução falhar; o controlador então não inicia tarefas novas nesse tick.
  async ensure(baseBranch, { force = false, onBuild = () => {} } = {}) {
    const signature = JSON.stringify([this.config.projectSettings?.dependencias, this.config.projectSettings?.instalar, this.config.projectSettings?.imagensDeTeste, Boolean(this.config.projectSettings?.previa)]);
    if (signature !== this.settingsSignature) { this.lastCheck = -Infinity; this.settingsSignature = signature; }
    if (!force && this.now() - this.lastCheck < this.checkMs) return { checked: false };
    await this.ensurePreload();
    this.git.ensure();
    const sha = this.git.fetchBranch(baseBranch);
    if (!sha) throw new Error(`branch base ${baseBranch} ausente`);
    const wanted = this.lockHash(sha);
    const stale = await this.staleImages(wanted);
    this.lastCheck = this.now();
    if (!stale.length) return { checked: true, rebuilt: false, lockHash: wanted };

    onBuild();
    this.log('image_rebuild_started', { sha, lockHash: wanted, stale });
    const started = this.now();
    const result = await this.exec(path.join(this.config.rooms.labRoot, 'scripts/build-images.sh'), [], {
      timeout: 60 * 60_000,
      env: { ...process.env, LAB_SOURCE_COMMIT: sha, LAB_MIRROR: this.config.git.mirrorDir, LAB_BUILD_PROXY: '0',
        LAB_PROJECT_ID: this.config.project ?? 'principal', LAB_LOCK_HASH: wanted,
        LAB_PROJECT_CONFIG: JSON.stringify(currentSettings(this.config)) }
    });
    if (result.error || result.status !== 0) {
      this.lastCheck = -Infinity;
      throw new Error(`reconstrucao das imagens falhou: ${redact(result.error?.message || result.stderr || '').slice(-600)}`);
    }
    const still = await this.staleImages(wanted);
    if (still.length) throw new Error(`imagens sem o lockfile esperado apos build: ${still.join(', ')}`);
    this.log('image_rebuild_done', { sha, lockHash: wanted, seconds: Math.round((this.now() - started) / 1000) });
    return { checked: true, rebuilt: true, lockHash: wanted };
  }
}
