// Gera as imagens de docs/imagens/ a partir do painel de demonstração (scripts/demo-painel.mjs).
// Roda dentro da imagem oficial do Playwright, sem instalar nada na máquina:
//   docker run --rm -v "$PWD:/lab" -w /lab mcr.microsoft.com/playwright:v1.56.1-noble \
//     bash -c 'npm i -g playwright@1.56.1 >/dev/null && NODE_PATH=$(npm root -g) node scripts/capturas.mjs'
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(path.join(process.env.NODE_PATH ?? '', 'x'))('playwright');
const out = path.resolve('docs/imagens');
const config = execFileSync('node', ['scripts/demo-painel.mjs', '/tmp/lab-demo'], { encoding: 'utf8' }).trim();
const port = '7799';
const panel = spawn('node', ['orchestrator/src/dashboard.mjs'], {
  env: { ...process.env, LAB_ORCHESTRATOR_CONFIG: config, LAB_PAINEL_PORT: port, TZ: 'America/Sao_Paulo' }, stdio: 'inherit'
});
await sleep(2500);

// Fora de uma máquina real não há systemd nem salas Docker: o navegador recebe o serviço como ativo e
// uma atividade de agente fictícia (só nas capturas; o painel em si não muda).
const at = (minutes) => Date.now() - minutes * 60_000;
const step = (minutes, kind, text) => ({ at: at(minutes), kind, text });
const LIVE = {
  42: [step(9, 'thinking', 'O frete grátis compara o subtotal antes do desconto; preciso usar o valor final da sacola.'),
    step(8, 'tool', 'Read: src/checkout/frete.ts'), step(6, 'tool', '$ npm test -- frete'),
    step(4, 'text', 'Corrigi a regra e adicionei 3 testes para o limite de R$ 200.'), step(1, 'tool', '$ git commit -m "Corrige frete grátis com cupom"')],
  12: [step(5, 'tool', 'Read: AGENTS.md'), step(4, 'thinking', 'A agenda já usa dnd-kit; dá para reaproveitar o mesmo sensor da lista de pacientes.'),
    step(2, 'tool', 'Edit: web/src/pages/agenda/Semana.tsx'), step(1, 'tool', '$ npx playwright test agenda.spec.ts')]
};
const live = (issue) => {
  if (Number(issue) === 45) return { issue: 45, active: true, phase: 'verificacao',
    lines: ['===== grupo 0 =====', '--- npm run lint', '--- ok (19s): npm run lint', '--- npm run build', '--- ok (52s): npm run build', '--- npm test', '  ✔ filtro por preço (31 testes)'] };
  const items = LIVE[issue] ?? [];
  const last = (kind) => [...items].reverse().find((i) => i.kind === kind) ?? null;
  return { issue: Number(issue), active: true, phase: 'agente', steps: items.filter((i) => i.kind === 'tool').length + 14,
    lastAt: items.at(-1)?.at ?? null, saying: last('text'), thinking: last('thinking'), doing: last('tool'), items };
};

const browser = await chromium.launch();
const shoot = async (name, { tab, width = 1360, height = 860, scheme = 'light', mobile = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, isMobile: mobile, hasTouch: mobile, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    Object.assign(body.controller, { service: 'active', since: new Date(at(300)).toString() });
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/live?*', (route) => route.fulfill({ json: live(new URL(route.request().url()).searchParams.get('issue')) }));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForLoadState('networkidle');
  await sleep(1200);
  if (tab) { await page.locator(`button[data-tab="${tab}"]`).first().click(); await sleep(900); }
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await page.close();
  console.log(`docs/imagens/${name}.png`);
};
await shoot('painel-agora', { tab: 'agora' });
await shoot('painel-tarefas', { tab: 'tarefas' });
await shoot('painel-projetos', { tab: 'projetos' });
await shoot('painel-escuro', { tab: 'agora', scheme: 'dark' });
await shoot('painel-celular', { tab: 'agora', width: 390, height: 844, mobile: true });
await browser.close();
panel.kill();
