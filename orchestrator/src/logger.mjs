import fs from 'node:fs';
import path from 'node:path';
import { redactDeep } from './redact.mjs';

function rotate(file, maxBytes, keep) {
  let size;
  try { size = fs.statSync(file).size; } catch { return; }
  if (size < maxBytes) return;
  for (let index = keep - 1; index >= 1; index -= 1) {
    try { fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`); } catch { /* arquivo ausente */ }
  }
  fs.renameSync(file, `${file}.1`);
}

export function createLogger(file, { maxBytes = 5 * 1024 * 1024, keep = 5, stdout = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (event, fields = {}) => {
    const line = JSON.stringify({ time: new Date().toISOString(), event, project: null, ...redactDeep(fields) });
    rotate(file, maxBytes, keep);
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
    if (stdout) process.stdout.write(`${line}\n`);
  };
}
