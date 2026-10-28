// O que o agente está fazendo agora: lê o fim da sessão do CLI dentro da sala (Claude grava em
// ~/.claude/projects, Codex em ~/.codex/sessions) e transforma em passos curtos: pensou, disse, executou.
import { redact } from './redact.mjs';

export const SESSION_TAIL = [
  'f=$(find "$HOME/.claude/projects" "$HOME/.codex/sessions" -name "*.jsonl" -type f -printf "%T@ %p\\n" 2>/dev/null',
  '| sort -n | tail -1 | cut -d" " -f2-); [ -n "$f" ] && tail -c 400000 "$f"; exit 0'
].join(' ');

const clip = (text, max) => {
  const clean = redact(String(text ?? '')).trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

function describeTool(name, input) {
  let args = input;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* texto livre */ } }
  if (typeof args === 'string') {
    // Codex "custom_tool_call": tools.exec_command({cmd:"..."}) dentro de um script.
    const cmd = args.match(/cmd\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return cmd ? `$ ${cmd[1].replace(/\\"/g, '"').replace(/\\n/g, ' ')}` : `${name}: ${args}`;
  }
  if (!args || typeof args !== 'object') return name;
  const command = args.command ?? args.cmd;
  if (command) return `$ ${Array.isArray(command) ? command.join(' ') : command}`;
  const target = args.file_path ?? args.path ?? args.pattern ?? args.url ?? args.query ?? args.description;
  return target ? `${name}: ${target}` : `${name} ${JSON.stringify(args)}`;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c?.text ?? (typeof c === 'string' ? c : '')).join('\n');
  return '';
}

export function parseSession(raw, limit = 40) {
  const items = [];
  const lines = String(raw ?? '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; } // primeira linha cortada pelo tail
    const at = o.timestamp ? Date.parse(o.timestamp) : null;
    // Claude Code
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === 'thinking' && c.thinking?.trim()) items.push({ at, kind: 'thinking', text: clip(c.thinking, 1500) });
        else if (c.type === 'text' && c.text?.trim()) items.push({ at, kind: 'text', text: clip(c.text, 2000) });
        else if (c.type === 'tool_use') items.push({ at, kind: 'tool', text: clip(describeTool(c.name, c.input), 400) });
      }
      continue;
    }
    if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c.type === 'tool_result' && c.is_error) items.push({ at, kind: 'error', text: clip(textOf(c.content), 400) });
      }
      continue;
    }
    // Codex CLI
    if (o.type === 'response_item' && o.payload) {
      const p = o.payload;
      if (p.type === 'message' && p.role === 'assistant') {
        const text = textOf(p.content);
        if (text.trim()) items.push({ at, kind: 'text', text: clip(text, 2000) });
      } else if (p.type === 'reasoning') {
        const text = (p.summary ?? []).map((s) => s.text ?? '').join('\n');
        if (text.trim()) items.push({ at, kind: 'thinking', text: clip(text, 1500) });
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        items.push({ at, kind: 'tool', text: clip(describeTool(p.name, p.arguments ?? p.input), 400) });
      } else if (p.type === 'local_shell_call') {
        items.push({ at, kind: 'tool', text: clip(describeTool('shell', p.action), 400) });
      }
    }
  }
  const last = (kind) => [...items].reverse().find((i) => i.kind === kind) ?? null;
  return {
    steps: items.filter((i) => i.kind === 'tool').length,
    lastAt: items.length ? items[items.length - 1].at : null,
    saying: last('text'), thinking: last('thinking'), doing: last('tool'),
    items: items.slice(-limit)
  };
}

// Saída de texto (verificação ou Codex sem sessão legível): últimas linhas úteis.
export function tailLines(raw, count = 30) {
  return redact(String(raw ?? '')).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trimEnd()).filter(Boolean).slice(-count);
}
