import fs from 'node:fs';
import path from 'node:path';
import { isSameProcess, processIdentity } from './proc.mjs';

// Impede dois controladores sobre o mesmo estado. Trava de processo morto é substituída.
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const me = { pid: process.pid, start: processIdentity(process.pid) };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(me));
      fs.closeSync(fd);
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === me.pid) fs.rmSync(file, { force: true });
        } catch { /* trava já removida */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* trava incompleta */ }
      if (holder && isSameProcess(holder)) throw new Error(`outro controlador ativo (pid ${holder.pid})`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error('nao foi possivel obter a trava do controlador');
}
