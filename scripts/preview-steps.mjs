import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const config = JSON.parse(process.argv[2]);
const snapshot = process.argv[3];
let changed = false;
if (config.dependencias.length) {
  try { execFileSync('git', ['diff', '--quiet', snapshot, 'HEAD', '--', ...config.dependencias]); }
  catch (error) { if (error.status !== 1) throw error; changed = true; }
}
// Mesma regra da sala: com dependências diferentes das da imagem, só reinstala (os navegadores já estão nela).
if (changed) for (const cmd of config.reinstalar ?? config.instalar) execFileSync('bash', ['-c', cmd], { stdio: 'inherit' });
for (const [index, step] of config.previa.passos.entries()) {
  const out = fs.openSync(`/tmp/lab/previa-${index}.log`, 'w');
  const child = spawn('bash', ['-c', step.rodar], { cwd: '/workspace', detached: true, stdio: ['ignore', out, out] });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.unref(); fs.closeSync(out);
  if (!step.esperar) continue;
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch(step.esperar, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.ok) { ready = true; break; }
    } catch { /* serviço ainda iniciando */ }
    await sleep(2000);
  }
  if (!ready) throw new Error(`prévia: passo ${index + 1} não respondeu`);
}
