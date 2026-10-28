// Pedidos de ajuste feitos no painel ("faltou isso", "isso está errado"). Um arquivo por pedido: o painel só
// cria arquivos e o controlador lê, aplica e apaga exatamente os que leu, então um pedido escrito durante a
// leitura nunca se perde.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FEEDBACK = 4000;
const NAME = /^(\d{1,7})-(\d{13})-[0-9a-f]{8}\.json$/;

export class FeedbackQueue {
  constructor(dir) { this.dir = dir; }

  add(issue, text, now = Date.now()) {
    const clean = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    if (!Number.isSafeInteger(issue) || issue < 1 || !clean || clean.length > MAX_FEEDBACK) return false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${issue}-${now}-${crypto.randomBytes(4).toString('hex')}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ issue, text: clean, at: new Date(now).toISOString() }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return true;
  }

  // [{ issue, items: [{ text, at, file }] }], pedidos mais antigos primeiro.
  list() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    const byIssue = new Map();
    for (const name of names.sort()) {
      const match = name.match(NAME);
      if (!match) continue;
      const file = path.join(this.dir, name);
      try {
        const item = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (item.issue !== Number(match[1]) || typeof item.text !== 'string' || !item.text.trim()) continue;
        const list = byIssue.get(item.issue) ?? [];
        list.push({ text: item.text.slice(0, MAX_FEEDBACK), at: item.at, file });
        byIssue.set(item.issue, list);
      } catch { /* arquivo parcial ou inválido: ignora */ }
    }
    return [...byIssue].map(([issue, items]) => ({ issue, items: items.sort((a, b) => String(a.at).localeCompare(String(b.at))) }));
  }

  remove(request) {
    for (const item of request.items ?? []) fs.rmSync(item.file, { force: true });
  }

  clear(issue) {
    for (const request of this.list()) if (request.issue === issue) this.remove(request);
  }
}

export class RetryQueue extends FeedbackQueue {
  add(issue, now = Date.now()) { return super.add(issue, 'tentar novamente', now); }
}
