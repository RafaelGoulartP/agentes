import fs from 'node:fs';

// Identifica um processo por PID + instante de início, para não confundir PIDs reutilizados.
export function processIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    return fields[19];
  } catch {
    return null;
  }
}

export function isSameProcess(ref) {
  return Boolean(ref?.pid && ref.start) && processIdentity(ref.pid) === ref.start;
}
