import { SLOT_STATUSES } from './domain.mjs';

// Todos os ticks são sequenciais: a reserva aparece no estado antes de abrir a sala.
export class Coordinator {
  constructor(maxConcurrency, store = null) {
    this.maxConcurrency = maxConcurrency; this.store = store;
    this.shared = store?.load() ?? { version: 1, tasks: {} };
    this.shared.quota ??= {};
    this.shared.breaker ??= { recent: [], trips: 0, openUntil: null };
    this.instances = []; this.cursor = 0;
  }
  attach(instance) {
    this.instances.push(instance); instance.coordinator = this;
    for (const [agent, quota] of Object.entries(instance.state.quota)) {
      if (!this.shared.quota[agent] || Date.parse(quota.until) > Date.parse(this.shared.quota[agent].until)) this.shared.quota[agent] = quota;
    }
    if (Date.parse(instance.state.breaker.openUntil) > (Date.parse(this.shared.breaker.openUntil) || 0)) this.shared.breaker = instance.state.breaker;
    for (const other of this.instances) {
      other.state.quota = this.shared.quota; other.state.breaker = this.shared.breaker;
    }
  }
  save() { this.store?.save(this.shared); }
  active() { return this.instances.flatMap((o) => Object.values(o.state.tasks)).filter((t) => SLOT_STATUSES.has(t.status)).length; }
  available() { return this.active() < this.maxConcurrency; }
  order() {
    if (!this.instances.length) return [];
    const result = [...this.instances.slice(this.cursor), ...this.instances.slice(0, this.cursor)];
    this.cursor = (this.cursor + 1) % this.instances.length;
    return result;
  }
  async cycle(full, onError = () => {}) {
    for (const instance of full ? this.order() : this.instances) {
      try { await (full && instance.admissionEnabled !== false ? instance.tick() : instance.tickLocal()); }
      catch (error) { onError(instance, error); }
      finally { this.save(); }
    }
  }
}
