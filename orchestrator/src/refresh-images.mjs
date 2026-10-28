import { readProjects, projectConfig, loadProjectSettings } from './projects.mjs';
// Confere (e, se preciso, reconstrói) as imagens das salas para a branch base atual.
// Uso: node src/refresh-images.mjs
import { loadConfig } from './config.mjs';
import { HostGit } from './host-git.mjs';
import { ImageKeeper } from './images.mjs';
import { createLogger } from './logger.mjs';

const config = loadConfig();
const log = createLogger(config.logFile);
const base = process.env.LAB_BASE_BRANCH ?? 'main';
for (const project of readProjects(config, { create: true }).filter((p) => p.enabled)) {
  const scoped = projectConfig(config, project);
  const projectLog = (event, fields = {}) => log(event, { ...fields, project: project.id });
  try {
    const git = new HostGit(scoped);
    loadProjectSettings(scoped, git, base);
    const result = await new ImageKeeper(scoped, git, projectLog).ensure(base, { force: true });
    console.log(`${project.id}: ${result.rebuilt ? 'imagens reconstruídas' : 'imagens atualizadas'}`);
  } catch (error) { projectLog('image_refresh_failed', { message: error.message }); process.exitCode = 1; }
}
