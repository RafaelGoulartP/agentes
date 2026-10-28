import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readProjects, validateProjectConfig, bootstrapConfig } from '../orchestrator/src/projects.mjs';
import { loadConfig } from '../orchestrator/src/config.mjs';

export function prepareBuild(source, context, settings) {
  const config = validateProjectConfig(settings, { allowBootstrap: true });
  fs.mkdirSync(path.join(context, 'dependencias'), { recursive: true });
  const root = fs.realpathSync(source);
  const sourceFile = (file) => {
    const resolved = fs.realpathSync(path.join(root, file));
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`dependência fora do código: ${file}`);
    return resolved;
  };
  const hash = createHash('sha256');
  for (const file of config.dependencias) {
    const data = fs.readFileSync(sourceFile(file));
    hash.update(file).update('\0').update(data).update('\0');
    const target = path.join(context, 'dependencias', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    // npm ci precisa também do manifesto ao lado do lockfile.
    const manifest = path.join(path.dirname(file), 'package.json');
    if (fs.existsSync(path.join(source, manifest))) fs.copyFileSync(sourceFile(manifest), path.join(context, 'dependencias', manifest));
  }
  hash.update(JSON.stringify(config.instalar));
  if (!config.previa) hash.update('\0partida');
  fs.writeFileSync(path.join(context, 'instalar.sh'), `#!/bin/bash\nset -Eeuo pipefail\n${config.instalar.join('\n')}\n`);
  return hash.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, context] = process.argv.slice(2);
  let settings;
  if (process.env.LAB_PROJECT_CONFIG) settings = JSON.parse(process.env.LAB_PROJECT_CONFIG);
  else if (fs.existsSync(path.join(source, '.laboratorio.json'))) settings = JSON.parse(fs.readFileSync(path.join(source, '.laboratorio.json'), 'utf8'));
  else {
    const controller = loadConfig();
    settings = readProjects(controller).find((p) => p.id === (process.env.LAB_PROJECT_ID ?? 'principal'))?.config;
    // Sem configuração própria, a imagem de partida (sem dependências) ainda serve para salas de teste.
    settings ??= bootstrapConfig();
  }
  console.log(prepareBuild(source, context, settings));
}
