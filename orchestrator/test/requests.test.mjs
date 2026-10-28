import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FeedbackQueue, RetryQueue, MAX_FEEDBACK } from "../src/requests.mjs";

test("pedidos de ajuste: um arquivo por pedido, agrupados por issue e apagados só os lidos", () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pedidos-")), "pedidos");
  const queue = new FeedbackQueue(dir);
  assert.deepEqual(queue.list(), [], "sem pasta ainda");
  assert.ok(queue.add(7, "  faltou o filtro\r\n", 1_000_000_000_000));
  assert.ok(queue.add(7, "e o botão", 1_000_000_000_500));
  assert.ok(queue.add(9, "outra", 1_000_000_000_100));
  assert.equal(queue.add(7, "   "), false);
  assert.equal(queue.add(7, "x".repeat(MAX_FEEDBACK + 1)), false);
  assert.equal(queue.add(0, "x"), false);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const listed = queue.list();
  assert.deepEqual(listed.map((r) => [r.issue, r.items.map((i) => i.text)]), [[7, ["faltou o filtro", "e o botão"]], [9, ["outra"]]]);
  fs.writeFileSync(path.join(dir, "7-1000000000999-abcdef12.json"), "{quebrado");
  queue.add(7, "chegou depois", 1_000_000_001_000);
  queue.remove(listed[0]);
  assert.deepEqual(queue.list().map((r) => [r.issue, r.items.map((i) => i.text)]), [[7, ["chegou depois"]], [9, ["outra"]]]);
  queue.clear(9);
  assert.deepEqual(queue.list().map((r) => r.issue), [7]);
});

test('nova tentativa: pedido persistente isolado por diretório de projeto', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = new RetryQueue(path.join(dir, 'projeto-a'));
  assert.equal(queue.add(0), false);
  assert.ok(queue.add(16));
  const reloaded = new RetryQueue(queue.dir);
  assert.equal(reloaded.list()[0].issue, 16);
  assert.deepEqual(new RetryQueue(path.join(dir, 'projeto-b')).list(), []);
  reloaded.remove(reloaded.list()[0]);
  assert.deepEqual(queue.list(), []);
});
