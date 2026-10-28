import { statfs as defaultStatfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';

// Qualquer resposta HTTP (inclusive 401/403) prova que há rota até o provedor; só falha de conexão conta.
export const PROVIDERS = {
  codex: 'https://chatgpt.com/',
  claude: 'https://api.anthropic.com/v1/models'
};

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
// API .NET em vez de netstat: o nome do estado não depende do idioma do Windows.
const COUNT_TIME_WAIT = "([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpConnections() | Where-Object State -eq 'TimeWait').Count";

export async function reachable(url, timeoutMs = 10_000) {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

// Conexões TCP em TIME_WAIT no Windows. Acima da faixa de portas dinâmicas nenhuma conexão nova sai do PC
// (incidente de 16/10/2026). Retorna null fora do WSL ou se a consulta falhar.
export function windowsTimeWait(timeoutMs = 20_000) {
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', COUNT_TIME_WAIT], { timeout: timeoutMs }, (error, stdout) => {
      const count = Number.parseInt(String(stdout).trim(), 10);
      resolve(error || !Number.isFinite(count) ? null : count);
    });
  });
}

export class HealthCheck {
  constructor(config, { probe = reachable, timeWait = windowsTimeWait, statfs = defaultStatfs } = {}) {
    this.config = config.health ?? {};
    this.probe = probe;
    this.timeWait = timeWait;
    this.statfs = statfs;
    this.paths = [config.rooms?.labRoot, '/var/lib/docker'].filter(Boolean);
  }

  provider(agent) { return this.probe(PROVIDERS[agent]); }

  async check(agents) {
    const [timeWait, ...results] = await Promise.all([this.timeWait(), ...agents.map((agent) => this.provider(agent))]);
    const providers = Object.fromEntries(agents.map((agent, index) => [agent, results[index]]));
    const max = this.config.timeWaitMax ?? 10_000;
    const ports = timeWait === null || timeWait < max;
    const reasons = [];
    if (!ports) reasons.push(`Windows com ${timeWait} conexões em TIME_WAIT (limite ${max}): portas de saída quase esgotadas`);
    for (const [agent, ok] of Object.entries(providers)) if (!ok) reasons.push(`sem conexão com o provedor do ${agent}`);
    let disk = true;
    for (const location of this.paths) {
      try {
        const stats = await this.statfs(location);
        const freeGb = Number(stats.bavail) * Number(stats.bsize) / 1024 ** 3;
        if (freeGb < (this.config.minFreeGb ?? 15)) {
          disk = false;
          reasons.push(`pouco disco: ${freeGb.toFixed(1)} GB livres (${location})`);
        }
      } catch { /* caminho ausente ou sem leitura */ }
    }
    return { ports, disk, timeWait, providers, reasons };
  }
}
