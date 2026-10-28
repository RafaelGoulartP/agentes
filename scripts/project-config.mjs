export function bootstrapConfig() {
  return { dependencias: [], instalar: [], leia: [],
    verificar: [['node /tmp/lab/validar-config.mjs']],
    imagensDeTeste: [], dominiosExtras: [],
    proibido: { dominios: [], pastas: [], portas: [], texto: '' } };
}

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const line = (v) => typeof v === 'string' && Boolean(v.trim()) && !/[\r\n\0]/.test(v);
const relative = (v) => line(v) && !v.startsWith('-') && !/[\\:]/.test(v) && v.split('/').every((s) => s && s !== '.' && s !== '..');
const domain = (v) => typeof v === 'string' && /^\.?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(v) && !v.includes('..');

export function validateProjectConfig(value, { allowBootstrap = false } = {}) {
  const fail = (key, why) => { throw new Error(`.laboratorio.json: ${key} ${why}`); };
  if (!object(value)) fail('configuração', 'deve ser objeto');
  const list = (key, check, required = false, source = value) => {
    if (!Array.isArray(source[key]) || (required && !source[key].length) || !source[key].every(check)) fail(key, 'deve ser lista válida');
  };
  list('dependencias', relative); list('instalar', line); list('leia', relative);
  if (value.reinstalar !== undefined) list('reinstalar', line);
  list('verificar', (g) => Array.isArray(g) && g.length && g.every(line), true);
  list('imagensDeTeste', (v) => line(v) && /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(v)); list('dominiosExtras', domain);
  if (!object(value.proibido)) fail('proibido', 'deve ser objeto');
  list('dominios', domain, false, value.proibido); list('pastas', relative, false, value.proibido);
  list('portas', (v) => Number.isInteger(v) && v > 0 && v <= 65535, false, value.proibido);
  if (typeof value.proibido.texto !== 'string' || /[\r\n\0]/.test(value.proibido.texto)) fail('proibido.texto', 'deve ser texto em uma linha');
  if (value.previa === undefined && allowBootstrap && JSON.stringify(value) === JSON.stringify(bootstrapConfig())) return structuredClone(value);
  if (!object(value.previa)) fail('previa', 'deve ser objeto');
  if (!Number.isInteger(value.previa.porta) || value.previa.porta < 1 || value.previa.porta > 65535) fail('previa.porta', 'deve estar entre 1 e 65535');
  if (typeof value.previa.logins !== 'string') fail('previa.logins', 'deve ser texto');
  list('passos', (s) => {
    if (!object(s) || !line(s.rodar)) return false;
    if (s.esperar === undefined) return true;
    try { const u = new URL(s.esperar); return ['http:', 'https:'].includes(u.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && !u.username && !u.password; } catch { return false; }
  }, true, value.previa);
  return structuredClone(value);
}

