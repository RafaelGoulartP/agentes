// Mensagens das CLIs; horários sem data usam o próximo dia no fuso do laboratório (config.timeZone).
// Só o final do log e só frases das próprias CLIs: o código do projeto fala de "rate limit" e os testes
// imprimem isso; uma falha comum não pode pausar o agente.
const QUOTA = /usage[ _]limit[ _](?:reached|exceeded)|hit your (?:usage |session |weekly |5-hour )?limit|usage limit\b.*\breset/i;

// Diferença (ms) entre o horário de parede no fuso e o UTC no instante dado.
function zoneOffset(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at).map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
}

// Instante UTC de "data + hora:minuto" no fuso (data no formato AAAA-MM-DD).
function zonedTime(date, hour, minute, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  const guess = wall - zoneOffset(wall, timeZone);
  return wall - zoneOffset(guess, timeZone);
}

export function detectQuota(fullText, now = Date.now(), config = {}) {
  const timeZone = config.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const text = String(fullText ?? '').slice(-4000);
  if (!QUOTA.test(text)) return null;
  const fallback = now + (config.defaultMinutes ?? 60) * 60_000;
  let until = NaN;
  const epoch = text.match(/(?:\||resets?\s+(?:at\s+)?|try again at\s+)(\d{10})(?!\d)/i);
  const iso = text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/i);
  if (epoch) until = Number(epoch[1]) * 1000;
  else if (iso) {
    if (/Z|[+-]\d{2}:?\d{2}$/i.test(iso[0])) until = Date.parse(iso[0]);
    else {
      const [, date, hour, minute] = iso[0].match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
      until = zonedTime(date, Number(hour), Number(minute), timeZone);
    }
  }
  else {
    const clock = text.match(/(?:resets?\s+(?:at\s+)?|try again at\s+)(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\b/i);
    if (clock) {
      let hour = Number(clock[1]);
      const minute = Number(clock[2] ?? 0);
      const period = clock[3]?.toUpperCase();
      if (minute < 60 && hour < (period ? 13 : 24) && (!period || hour > 0)) {
        if (period) hour = hour % 12 + (period === 'PM' ? 12 : 0);
        const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
        until = zonedTime(date, hour, minute, timeZone);
        if (until <= now) until += 86_400_000;
      }
    }
  }
  if (!Number.isFinite(until) || until <= now) until = fallback;
  return { until: new Date(Math.min(until, now + Math.min(config.maxDays ?? 7, 7) * 86_400_000)).toISOString() };
}
