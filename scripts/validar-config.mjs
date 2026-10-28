import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProjectConfig } from './project-config.mjs';

// O validador vem do controlador; o candidato fornece somente o JSON.
export function validateCandidateConfig(root = process.cwd()) {
  const file = path.join(root, '.laboratorio.json');
  if (!fs.existsSync(file)) throw new Error('.laboratorio.json ausente');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('.laboratorio.json não pode ser link');
  return validateProjectConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { validateCandidateConfig(); console.log('Configuração válida.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
