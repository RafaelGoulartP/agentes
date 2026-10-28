import test from 'node:test';
import assert from 'node:assert/strict';
import { Notifier } from '../src/notify.mjs';

test('ntfy: desligado por padrão, sem URL ou evento desconhecido não envia', async () => {
  const fetch = async () => { assert.fail('envio inesperado'); };
  await new Notifier({}, { fetch }).send('quota');
  await new Notifier({ notify: { enabled: true } }, { fetch }).send('quota');
  await new Notifier({ notify: { enabled: true, url: 'https://exemplo.invalid/topico-falso' } }, { fetch }).send('tick_complete');
});

test('ntfy: POST curto em português, título, sinal de timeout e erros sem URL no log', async () => {
  const config = { notify: { enabled: true, url: 'https://exemplo.invalid/topico-falso' } };
  const calls = [];
  const logs = [];
  const notifier = new Notifier(config, { fetch: async (...args) => {
    calls.push(args);
    return { ok: false, status: 503 };
  }, log: (...args) => logs.push(args) });
  await notifier.send('quota', { issue: 3, agent: 'claude', until: 'amanhã' });
  const [url, options] = calls[0];
  assert.equal(url, config.notify.url);
  assert.equal(options.method, 'POST');
  assert.ok(options.signal instanceof AbortSignal);
  assert.match(options.headers.Title, /UTF-8/);
  assert.match(options.body, /Cota.*Issue #3.*claude.*amanhã/);
  assert.equal(options.redirect, 'error');
  notifier.fetch = async () => { throw new Error(config.notify.url); };
  await assert.doesNotReject(notifier.send('task_ready', { issue: 3 }));
  assert.equal(logs.length, 2);
  assert.doesNotMatch(JSON.stringify(logs), /topico-falso/);
});

test('ntfy: timeout de dez segundos e logger com erro nunca escapam para o controlador', async (t) => {
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    assert.equal(ms, 10_000);
    return AbortSignal.abort();
  });
  const notifier = new Notifier({ notify: { enabled: true, url: 'https://exemplo.invalid/teste' } }, {
    fetch: async (_url, { signal }) => { signal.throwIfAborted(); },
    log: () => { throw new Error('log indisponível'); }
  });
  await assert.doesNotReject(notifier.send('starts_paused'));
});
