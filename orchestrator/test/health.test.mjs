import test from 'node:test';
import assert from 'node:assert/strict';
import { HealthCheck } from '../src/health.mjs';

test('saúde: portas acima do limite e provedor fora aparecem como motivos', async () => {
  const health = new HealthCheck({ health: { timeWaitMax: 1000 } }, {
    probe: async (url) => !url.includes('anthropic'),
    timeWait: async () => 5000
  });
  const result = await health.check(['codex', 'claude']);
  assert.equal(result.ports, false);
  assert.deepEqual(result.providers, { codex: true, claude: false });
  assert.equal(result.reasons.length, 2);
});

test('saúde: sem leitura do Windows (fora do WSL) não bloqueia', async () => {
  const health = new HealthCheck({}, { probe: async () => true, timeWait: async () => null });
  const result = await health.check(['codex']);
  assert.equal(result.ports, true);
  assert.deepEqual(result.reasons, []);
});

test('saúde: pouco disco nas duas raízes pausa salas; caminho ausente é ignorado', async () => {
  const paths = [];
  const health = new HealthCheck({ rooms: { labRoot: '/laboratorio' } }, {
    probe: async () => true, timeWait: async () => 0,
    statfs: async (location) => { paths.push(location); return { bavail: 10 * 1024 ** 3, bsize: 1 }; }
  });
  const result = await health.check(['codex']);
  assert.deepEqual(paths, ['/laboratorio', '/var/lib/docker']);
  assert.equal(result.disk, false);
  assert.equal(result.ports, true);
  assert.equal(result.reasons.length, 2);
  assert.match(result.reasons[0], /pouco disco: 10.0 GB livres/);
  health.statfs = async () => { throw Object.assign(new Error('ausente'), { code: 'ENOENT' }); };
  assert.equal((await health.check(['codex'])).disk, true);
  health.statfs = async () => ({ bavail: 15, bsize: 1024 ** 3 });
  assert.equal((await health.check(['codex'])).disk, true);
});
