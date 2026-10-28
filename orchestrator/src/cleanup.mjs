import fs from 'node:fs';
import path from 'node:path';
import { ACTIVE_STATUSES } from './domain.mjs';

const inside = (root, target) => target !== root && !path.relative(root, target).startsWith('..') && !path.isAbsolute(path.relative(root, target));

export function cleanup(config, state, git, now = Date.now()) {
  const cutoff = now - (config.cleanup?.days ?? 7) * 86_400_000;
  let directories = 0;
  let refs = 0;
  if (config.rooms.controlRoot && fs.existsSync(config.rooms.controlRoot)) {
    const root = fs.realpathSync(config.rooms.controlRoot);
    const protectedPaths = Object.values(state.tasks).flatMap((task) => [task.preservedDir, task.collectDir,
      ...Object.values(task.resumeFrom ?? {}).filter((value) => typeof value === 'string' && path.isAbsolute(value))])
      .filter(Boolean).map((value) => path.resolve(value));
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const match = entry.name.match(/^(codex|claude)-issue-(\d+)$/);
      if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const task = state.tasks[Number(match[2])];
      if (task && ACTIVE_STATUSES.has(task.status)) continue;
      const parent = path.resolve(root, entry.name);
      if (!inside(root, fs.realpathSync(parent))) continue;
      for (const run of fs.readdirSync(parent, { withFileTypes: true })) {
        const seq = run.name.match(/^execucao-(\d+)$/);
        if (!seq || !run.isDirectory() || run.isSymbolicLink()) continue;
        if (task?.agent === match[1] && task.runSeq === Number(seq[1])) continue;
        const dir = path.resolve(parent, run.name);
        if (!inside(root, fs.realpathSync(dir))) continue;
        if (protectedPaths.some((saved) => saved === dir || inside(dir, saved))) continue;
        if (fs.statSync(dir).mtimeMs >= cutoff) continue;
        fs.rmSync(dir, { recursive: true });
        directories += 1;
      }
    }
  }
  for (const task of Object.values(state.tasks)) {
    if (task.status === 'done' && Date.parse(task.doneAt) < cutoff && !task.resumeFrom?.ref) refs += git.deleteRefs?.(task.issueNumber) ?? 0;
  }
  return { directories, refs };
}
