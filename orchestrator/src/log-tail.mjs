import fs from 'node:fs';
import { redact } from './redact.mjs';

// Leitura limitada mesmo quando o arquivo cresce muito.
export function logTail(file, limit = 64 * 1024) {
  if (!file) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit));
    const read = fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return redact(buffer.subarray(0, read).toString('utf8'));
  } catch { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function verificationTail(file) {
  const lines = logTail(file).split(/\r?\n/).filter((line) => line.trim());
  // Grupos posteriores bem-sucedidos não devem esconder o erro do grupo anterior.
  const failures = [];
  let start = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^===== grupo /.test(lines[index])) start = index;
    if (/^--- FALHOU/.test(lines[index])) failures.push(...lines.slice(Math.max(start, index - 60), index + 1));
  }
  return (failures.length ? failures : lines.slice(-80)).join('\n').slice(-6000);
}
