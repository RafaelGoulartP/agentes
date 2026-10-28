import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encrypt, validSubscription, vapidAuthorization, loadVapid, vapidPublicKey } from '../src/webpush.mjs';
import { notificationFor, PushHub } from '../src/push.mjs';
import { parseSession } from '../src/live.mjs';

// Lado do navegador (RFC 8291), para conferir que o aparelho consegue abrir o que o painel cifra.
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, -1).toString('utf8');
}

function device() {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, sub: { endpoint: 'https://web.push.apple.com/QGuQyavXutnMH', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}

test('web push: o aparelho decifra a mensagem', () => {
  const { ua, auth, sub } = device();
  const body = encrypt(JSON.stringify({ title: 'Olá ção' }), sub.keys);
  assert.deepEqual(JSON.parse(decrypt(body, ua, auth)), { title: 'Olá ção' });
});

test('web push: assinatura VAPID ES256 confere com a chave pública', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vapid-'));
  const jwk = loadVapid(path.join(dir, 'vapid.json'));
  assert.deepEqual(loadVapid(path.join(dir, 'vapid.json')), jwk);
  assert.equal((fs.statSync(path.join(dir, 'vapid.json')).mode & 0o777), 0o600);
  const header = vapidAuthorization(jwk, 'https://web.push.apple.com/abc', 'https://github.com/x/y', 1_700_000_000_000);
  const [, token, key] = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, vapidPublicKey(jwk));
  const [h, c, s] = token.split('.');
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).aud, 'https://web.push.apple.com');
  const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('web push: só aceita serviços de push conhecidos', () => {
  const { sub } = device();
  assert.ok(validSubscription(sub));
  assert.ok(validSubscription({ ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/x' }));
  for (const endpoint of ['http://web.push.apple.com/x', 'https://127.0.0.1/x', 'https://push.apple.com.evil.io/x', 'https://web.push.apple.com:8443/x']) {
    assert.equal(validSubscription({ ...sub, endpoint }), false, endpoint);
  }
  assert.equal(validSubscription({ ...sub, keys: { ...sub.keys, auth: 'curto' } }), false);
});

test('avisos: aprovação, conclusão e problemas; repetições automáticas ficam quietas', () => {
  const tasks = { 7: { title: 'Corrigir foto' } };
  const ready = notificationFor({ event: 'task_ready', issue: 7, pull: 30, agent: 'claude' }, tasks, 'd/r');
  assert.match(ready.title, /aprovação no GitHub/);
  assert.equal(ready.url, 'https://github.com/d/r/pull/30');
  assert.match(ready.body, /#7 Corrigir foto/);
  assert.match(notificationFor({ event: 'task_done', issue: 7, pull: 30 }, tasks, 'd/r').title, /concluída/);
  assert.match(notificationFor({ event: 'task_retry', issue: 7, category: 'verify_failed', detail: 'password=abcdef123456' }, tasks, 'd/r').body, /verificação falhou: password=\[SEGREDO-REMOVIDO\]/);
  assert.match(notificationFor({ event: 'task_blocked', issue: 7, category: 'timeout' }, tasks, 'd/r').title, /bloqueada/);
  for (const category of ['network', 'quota', 'unfinished']) assert.equal(notificationFor({ event: 'task_retry', issue: 7, category }, tasks, 'd/r'), null);
  assert.equal(notificationFor({ event: 'tick_complete' }, tasks, 'd/r'), null);
  const staged = notificationFor({ event: 'task_staged', issue: 7, next: [8], stage: 1 }, tasks, 'd/r');
  assert.equal(staged.title, 'Etapa 1 pronta, seguindo para a próxima');
  assert.match(staged.body, /próxima: #8/);
  assert.match(notificationFor({ event: 'task_ready', issue: 7, pull: 30, feedback: true, stack: [5, 6] }, tasks, 'd/r').title, /Ajuste pronto/);
  assert.match(notificationFor({ event: 'task_ready', issue: 7, pull: 30, stack: [5, 6] }, tasks, 'd/r').body, /etapas #5, #6/);
  assert.equal(notificationFor({ event: 'stage_done', issue: 7 }, tasks, 'd/r'), null);
});

test('avisos: lê só eventos novos do log e descarta inscrição morta', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  const logFile = path.join(dir, 'log.jsonl');
  const stateFile = path.join(dir, 'state.json');
  fs.writeFileSync(logFile, `${JSON.stringify({ event: 'task_ready', issue: 1, pull: 2 })}\n`);
  fs.writeFileSync(stateFile, JSON.stringify({ tasks: {} }));
  const sent = [];
  let status = 201;
  const fetch = async (url, init) => { sent.push({ url, init }); return { status, body: null }; };
  const hub = new PushHub({ dir: path.join(dir, 'push'), logFile, stateFile, repo: 'd/r', subject: 'https://github.com/d/r', fetch, log: () => {} });
  fs.mkdirSync(path.join(dir, 'push'), { recursive: true });
  assert.ok(hub.subscribe(device().sub));
  await hub.poll();
  assert.equal(sent.length, 0, 'evento anterior ao painel não gera aviso');
  fs.appendFileSync(logFile, `${JSON.stringify({ event: 'task_done', issue: 1, pull: 2 })}\n{"event":"task_bloc`);
  await hub.poll();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.headers['content-encoding'], 'aes128gcm');
  fs.appendFileSync(logFile, `ked","issue":1,"category":"timeout"}\n`);
  status = 410;
  await hub.poll();
  assert.equal(sent.length, 2, 'linha partida é lida inteira na volta seguinte');
  assert.equal(hub.subs.length, 0, '410 remove a inscrição');
  const again = new PushHub({ dir: path.join(dir, 'push'), logFile, stateFile, repo: 'd/r', subject: 's', fetch, log: () => {} });
  assert.equal(again.offset, fs.statSync(logFile).size, 'retoma do ponto salvo');
});

test('atividade ao vivo: sessões do Claude e do Codex viram passos legíveis', () => {
  const claude = [
    '{"cortada',
    JSON.stringify({ type: 'user', timestamp: '2026-10-17T10:00:00Z', message: { content: 'prompt inicial' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-17T10:00:01Z', message: { content: [{ type: 'thinking', thinking: 'Preciso ver os testes' }, { type: 'text', text: 'Vou rodar os testes.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-17T10:00:05Z', message: { content: [{ type: 'tool_result', is_error: true, content: 'falhou ghp_abcdefghijklmnopqrstuvwxyz123' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-17T10:00:06Z', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/workspace/a.ts' } }] } })
  ].join('\n');
  const c = parseSession(claude);
  assert.equal(c.steps, 2);
  assert.equal(c.saying.text, 'Vou rodar os testes.');
  assert.equal(c.thinking.text, 'Preciso ver os testes');
  assert.equal(c.doing.text, 'Edit: /workspace/a.ts');
  assert.match(c.items.find((i) => i.kind === 'error').text, /SEGREDO-REMOVIDO/);
  assert.doesNotMatch(JSON.stringify(c), /prompt inicial/);

  const codex = [
    JSON.stringify({ timestamp: '2026-10-17T10:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'prompt' }] } }),
    JSON.stringify({ timestamp: '2026-10-17T10:00:01Z', type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Analisando' }] } }),
    JSON.stringify({ timestamp: '2026-10-17T10:00:02Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"npm run lint"}))' } }),
    JSON.stringify({ timestamp: '2026-10-17T10:00:03Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["git","status"]}' } }),
    JSON.stringify({ timestamp: '2026-10-17T10:00:04Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Pronto.' }] } })
  ].join('\n');
  const x = parseSession(codex);
  assert.deepEqual(x.items.map((i) => i.text), ['Analisando', '$ npm run lint', '$ git status', 'Pronto.']);
  assert.equal(x.lastAt, Date.parse('2026-10-17T10:00:04Z'));
});
