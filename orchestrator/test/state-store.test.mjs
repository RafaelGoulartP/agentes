import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/state-store.mjs';

test('estado persiste de forma recuperavel apos reinicio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-orchestrator-'));
  const file = path.join(dir, 'state.json');
  const first = new StateStore(file);
  first.save({ version: 1, tasks: { 12: { status: 'running', agent: 'codex' } } });
  assert.equal(new StateStore(file).load().tasks[12].status, 'running');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true });
});
