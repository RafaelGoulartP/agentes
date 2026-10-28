const MARK = '[SEGREDO-REMOVIDO]';

const PATTERNS = [
  [/github_pat_[A-Za-z0-9_]{20,}/g, MARK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MARK],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, MARK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, MARK],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MARK}`],
  [/(\bhttps?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MARK}@`],
  [/\b((?:access|refresh|id|oauth)_token|client_secret|api[_-]?key|secret|password|passwd|authorization|gh_token|github_token)(["']?\s*[:=]\s*["']?)(?!\[SEGREDO)([^\s"',;}]+)/gi, `$1$2${MARK}`]
];

const known = new Set();

// Valores carregados de arquivos de credencial são removidos literalmente de qualquer texto.
export function registerSecret(value) {
  const secret = String(value ?? '').trim();
  if (secret.length >= 8) known.add(secret);
}

export function redact(value) {
  let text = String(value ?? '');
  for (const secret of known) text = text.split(secret).join(MARK);
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
  }
  return value;
}
