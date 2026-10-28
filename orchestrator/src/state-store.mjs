import fs from 'node:fs';
import path from 'node:path';

export class StateStore {
  constructor(file) { this.file = file; }

  load() {
    if (!fs.existsSync(this.file)) return { version: 1, tasks: {} };
    const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (value.version !== 1 || typeof value.tasks !== 'object') throw new Error('estado invalido');
    return value;
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}
