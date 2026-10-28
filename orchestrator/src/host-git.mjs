import { deleteRefs } from './git.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readEnvSecret } from './config.mjs';
import { redact, registerSecret } from './redact.mjs';

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const MERGE_IDENTITY = { name: 'Laboratório de agentes', email: 'laboratorio-agentes@localhost' };

function failure(message, category = 'infra', permanent = false) {
  return Object.assign(new Error(message), { category, permanent });
}

// Espelho Git local do controlador. As salas nunca recebem token: o controlador busca a base,
// importa o resultado do agente como bundle e só faz push (sem force) depois da verificação.
export class HostGit {
  constructor(config) {
    this.dir = config.git.mirrorDir;
    this.url = config.git.remoteUrl ?? `https://github.com/${config.github.owner}/${config.github.repo}.git`;
    this.tokenFile = config.github.controllerTokenFile;
    this.askpass = path.join(config.rooms.labRoot, 'scripts/git-askpass.sh');
  }

  env(remote) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
    if (remote && this.url.startsWith('https://')) {
      const token = readEnvSecret(this.tokenFile, 'GH_TOKEN');
      registerSecret(token);
      Object.assign(env, { GIT_ASKPASS: this.askpass, LAB_GIT_TOKEN: token });
    }
    return env;
  }

  git(args, { remote = false, allowFail = false, env = {} } = {}) {
    const result = spawnSync('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '--git-dir', this.dir, ...args], {
      encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024, env: { ...this.env(remote), ...env }
    });
    if (!allowFail && (result.error || result.status !== 0)) {
      throw failure(`git ${args[0]} falhou: ${redact(result.error?.message ?? result.stderr).slice(-600)}`);
    }
    return result;
  }

  ensure() {
    if (fs.existsSync(path.join(this.dir, 'HEAD'))) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.git(['init', '--quiet', '--bare']);
  }

  validateBranch(name) {
    const ok = BRANCH.test(name ?? '') && !name.includes('..') && !name.endsWith('/') && !name.endsWith('.lock') &&
      spawnSync('git', ['check-ref-format', '--branch', name], { encoding: 'utf8' }).status === 0;
    if (!ok) throw failure(`nome de branch invalido: ${String(name).slice(0, 80)}`, 'invalid_branch', true);
  }

  revParse(ref) {
    const result = this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    const sha = result.stdout.trim();
    return result.status === 0 && SHA.test(sha) ? sha : null;
  }

  remoteSha(branch) {
    const out = this.git(['ls-remote', '--heads', this.url, `refs/heads/${branch}`], { remote: true }).stdout;
    const line = out.split('\n').find((item) => item.endsWith(`\trefs/heads/${branch}`));
    return line ? line.split('\t')[0] : null;
  }

  fetchBranch(branch) {
    const tracking = `refs/remotes/origin/${branch}`;
    if (!this.remoteSha(branch)) {
      this.git(['update-ref', '-d', tracking], { allowFail: true });
      return null;
    }
    this.git(['fetch', '--quiet', '--no-tags', this.url, `+refs/heads/${branch}:${tracking}`], { remote: true });
    return this.revParse(tracking);
  }

  prepareInput(task, bundlePath) {
    this.ensure();
    this.validateBranch(task.baseBranch);
    this.validateBranch(task.branch);
    const baseSha = this.fetchBranch(task.baseBranch);
    if (!baseSha) throw failure(`branch base ${task.baseBranch} ausente`);
    const branchSha = this.fetchBranch(task.branch);
    const refs = [`refs/remotes/origin/${task.baseBranch}`];
    // Trabalho de uma tentativa que conflitou com a base: a próxima parte dele, não do zero.
    const resume = task.resumeFrom?.ref && this.revParse(task.resumeFrom.ref) === task.resumeFrom.sha ? task.resumeFrom : null;
    let startSha;
    if (task.revision) {
      if (!branchSha) throw failure(`branch ${task.branch} do PR nao existe mais`, 'branch_missing', true);
      startSha = branchSha;
      refs.push(`refs/remotes/origin/${task.branch}`);
    } else {
      // Bloqueia antes de gastar tokens: o push sem force seria recusado no final.
      if (branchSha) throw failure(`branch ${task.branch} ja existe no GitHub`, 'branch_exists', true);
      startSha = baseSha;
    }
    // Numa revisão, só retoma se o trabalho guardado ainda contém o PR atual.
    const resumed = Boolean(resume) && (!task.revision || this.isAncestor(startSha, resume.sha));
    if (resumed) {
      startSha = resume.sha;
      refs.push(resume.ref);
    }
    fs.rmSync(bundlePath, { force: true });
    this.git(['bundle', 'create', '--quiet', bundlePath, ...refs]);
    return { baseSha, startSha, resumed };
  }

  deleteRefs(issue) { return deleteRefs((args) => this.git(args), issue); }

  setRef(ref, sha) {
    if (!SHA.test(sha) || !/^refs\/lab\//.test(ref)) throw failure('ref invalida');
    this.git(['update-ref', ref, sha]);
  }

  // Incorpora a base ao resultado do agente sem worktree: merge-tree calcula a árvore e commit-tree
  // grava o merge (primeiro pai = branch do agente). Em conflito nada é gravado e voltam os arquivos.
  mergeBase(headSha, baseSha, message, identity = MERGE_IDENTITY) {
    if (!SHA.test(headSha) || !SHA.test(baseSha)) throw failure('sha invalido para merge');
    const result = this.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', headSha, baseSha], { allowFail: true });
    const [tree, ...files] = result.stdout.split('\n');
    if (result.status === 1 && SHA.test(tree)) return { conflicts: [...new Set(files.filter(Boolean))] };
    if (result.status !== 0 || !SHA.test(tree)) throw failure(`merge-tree falhou: ${redact(result.error?.message ?? result.stderr).slice(-600)}`);
    const env = {
      GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email
    };
    const sha = this.git(['commit-tree', tree, '-p', headSha, '-p', baseSha, '-m', message], { env }).stdout.trim();
    if (!SHA.test(sha)) throw failure('commit-tree sem sha valido');
    return { sha };
  }

  importBundle(file, branch, targetRef) {
    this.git(['bundle', 'verify', '--quiet', file]);
    this.git(['fetch', '--quiet', '--no-tags', file, `+refs/heads/${branch}:${targetRef}`]);
    const sha = this.revParse(targetRef);
    if (!sha) throw failure('bundle importado sem commit valido');
    return sha;
  }

  bundleRef(file, ref) {
    fs.rmSync(file, { force: true });
    this.git(['bundle', 'create', '--quiet', file, ref]);
    return file;
  }

  mergeBaseOf(a, b) {
    const result = this.git(['merge-base', a, b], { allowFail: true });
    const sha = result.stdout.trim();
    return result.status === 0 && SHA.test(sha) ? sha : null;
  }

  isAncestor(ancestor, descendant) {
    return this.git(['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true }).status === 0;
  }

  commitSubjects(from, to, limit = 50) {
    return this.git(['log', '--no-merges', `--max-count=${limit}`, '--format=%h %s', `${from}..${to}`]).stdout
      .split('\n').filter(Boolean);
  }

  changedFiles(from, to) {
    return this.git(['diff', '--name-only', from, to]).stdout.split('\n').filter(Boolean);
  }

  push(sha, branch) {
    if (!SHA.test(sha)) throw failure('sha invalido para push');
    this.validateBranch(branch);
    const result = this.git(['push', '--quiet', '--porcelain', this.url, `${sha}:refs/heads/${branch}`], { remote: true, allowFail: true });
    if (result.status === 0) return;
    const output = `${result.stdout}\n${result.stderr}`;
    // O token do controlador não tem permissão Workflows: o GitHub recusa mudanças em .github/workflows.
    if (/workflow/i.test(output) && /refusing|rejected/i.test(output)) {
      throw failure(`push recusado para ${branch}: altera .github/workflows`, 'workflow_change', true);
    }
    if (/rejected|non-fast-forward|fetch first|stale info/i.test(output)) {
      throw failure(`push recusado para ${branch}: a branch remota diverge`, 'delivery_conflict', true);
    }
    throw failure(`push falhou: ${redact(output).slice(-600)}`);
  }
}
