import { redact } from './redact.mjs';

const TITLES = {
  task_blocked: 'Tarefa bloqueada', task_ready: 'PR pronto para revisão', breaker_open: 'Disjuntor aberto',
  starts_paused: 'Salas novas em pausa', agent_stopping: 'Encerrando agente', quota: 'Cota do agente esgotada'
};

export class Notifier {
  constructor(config, { fetch = globalThis.fetch, log = () => {} } = {}) {
    this.config = config.notify ?? {};
    this.fetch = fetch;
    this.log = (...args) => { try { log(...args); } catch { /* aviso não interrompe o controlador */ } };
  }

  async send(event, fields = {}) {
    if (!this.config.enabled || !this.config.url || !TITLES[event]) return;
    try {
      const title = TITLES[event];
      const text = [title, fields.project ?? '', fields.issue ? `Issue #${fields.issue}` : '', fields.agent ?? '',
        fields.until ? `até ${fields.until}` : '', fields.reason ?? fields.reasons?.join('; ') ?? ''].filter(Boolean).join(' · ').slice(0, 800);
      const response = await this.fetch(this.config.url, {
        method: 'POST', headers: { Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=` },
        body: redact(text), signal: AbortSignal.timeout(10_000), redirect: 'error'
      });
      await response.body?.cancel();
      if (!response.ok) this.log('notify_failed', { status: response.status });
    } catch { this.log('notify_failed', { message: 'não foi possível enviar aviso ao celular' }); }
  }
}
