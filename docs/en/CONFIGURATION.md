# Configuration

The lab has four places for configuration. Only `.laboratorio.json` lives in **your project's**
repository. The others live in the lab's folder, and only the templates (`*.example`) go into Git.

| File | Where | What for |
|---|---|---|
| `.laboratorio.json` | root of your project | how to install, test and preview the project |
| `orchestrator/config.json` | lab (outside Git) | orchestrator behavior: slots, retries, timeouts, agents |
| `config.env` | lab (outside Git, optional) | CPU/memory limits of the rooms and base images |
| `local.env` | lab (outside Git) | paths to the CLI logins |
| `secrets/*.env` | lab (outside Git, mode 600) | GitHub token and optional API keys |

> The field names in `.laboratorio.json` are in Portuguese (`instalar` = install, `verificar` =
> verify, and so on). The table below translates each one.

---

## `.laboratorio.json` (in your project)

The commands always come from the project's **main branch**. An agent's PR that changes this file
only takes effect after the merge, so the agent can't weaken its own verification.

```json
{
  "dependencias": ["package-lock.json"],
  "instalar": ["npm ci", "npx playwright install --with-deps chromium"],
  "reinstalar": ["npm ci --no-audit --no-fund"],
  "verificar": [
    ["npm run lint", "npm run build", "npm test"],
    ["npm run test:e2e"]
  ],
  "leia": ["AGENTS.md", "docs/TESTING.md"],
  "proibido": {
    "dominios": ["mysite.com"],
    "portas": [5432],
    "pastas": ["scripts/production"],
    "texto": "never use production credentials or databases"
  },
  "imagensDeTeste": ["postgres:16"],
  "dominiosExtras": ["registry.mycompany.com"],
  "previa": {
    "porta": 5173,
    "passos": [
      { "rodar": "docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:16" },
      { "rodar": "npm run dev:api", "esperar": "http://127.0.0.1:3000/health" },
      { "rodar": "npm run dev -- --host 0.0.0.0", "esperar": "http://127.0.0.1:5173/" }
    ],
    "logins": "admin@test.local / test-password"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `dependencias` (dependencies) | yes (can be `[]`) | Files that define the dependencies (lockfiles). They go into the room image; when they change on `main`, the image is rebuilt. npm workspaces are included automatically. |
| `instalar` (install) | yes (can be `[]`) | Commands that install dependencies, run **while building the image**, with direct internet access. |
| `reinstalar` (reinstall) | no | Commands run **inside the room** when the agent's branch changes the dependencies. Without this field, `instalar` is used. |
| `verificar` (verify) | yes | A list of **groups**. Groups run in parallel; the commands in each group run in order. All of them must pass before a PR is opened. |
| `leia` (read) | yes (can be `[]`) | Files the agent must read before working (e.g. `AGENTS.md`). |
| `proibido.dominios` (forbidden domains) | yes (can be `[]`) | Domains (and subdomains) **blocked** in the rooms' proxy and mentioned in the agent's instructions. |
| `proibido.portas` / `pastas` / `texto` (ports / folders / text) | yes | Warnings to the agent about what it must never touch. |
| `imagensDeTeste` (test images) | yes (can be `[]`) | Docker images the tests use (e.g. `postgres:16`). They are pulled once on the host and loaded into the verification room, without depending on the network. |
| `dominiosExtras` (extra domains) | yes (can be `[]`) | Domains allowed in the proxy on top of the default list. |
| `previa` (preview) | yes | How to start the app so you can try a PR before merging (the **Abrir prévia** button in the dashboard). `porta`: the app's port inside the room. `passos` (steps): commands in order; `rodar` = run, and `esperar` (wait for) is a local URL that must respond before the next step. `logins`: test users only. |

Rules: relative paths without `..`; one command per line; no secrets in this file.

**Inside the room** there is Node 24 (Debian bookworm), git, gh, jq, ripgrep, tmux, Docker (the room's
private daemon) and `sudo apt-get`. For other languages (Python, Go, Java...), install them in
`instalar` (e.g. `sudo apt-get update && sudo apt-get install -y python3-venv`) or adapt
`images/Dockerfile.base`.

---

## `orchestrator/config.json`

Created by the installer from `orchestrator/config.example.json`. Relative paths start at the lab's
folder. The main fields:

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` (in the generated config.json) | `false` makes the orchestrator exit without doing anything. |
| `scheduler.maxConcurrency` | `1` | Rooms at the same time, across all projects (maximum 3). Each room uses up to 4 GiB and 2 CPUs. |
| `scheduler.pollSeconds` | `60` | Interval between full reads from GitHub. |
| `scheduler.defaultArea` | `geral` | Area for issues without an `area:` label. |
| `scheduler.holdAreaWhilePrOpen` | `true` | Don't start another task in the same area while one of its PRs is open (avoids conflicts). |
| `retry.maxAttempts` | `4` | Real failures before marking the issue `bloqueado` (blocked). Network and quota failures don't count. |
| `retry.baseSeconds` / `maxSeconds` | `300` / `3600` | Wait between attempts (doubles after each failure, up to the ceiling). |
| `rooms.agentTimeoutMinutes` | `240` | Maximum time an agent can spend on a task. |
| `rooms.agentIdleMinutes` | `25` | An agent with no activity for this long is stopped. |
| `rooms.verifyTimeoutMinutes` | `60` | Maximum time for verification. |
| `rooms.branchPrefix` | `agente` | Branches created: `agente/<agent>/issue-<n>`. |
| `rooms.deniedDomains` | `[]` | Domains blocked in **every** project (e.g. your production domain). |
| `agents.claude.command` / `agents.codex.command` | see the file | Command line of each agent inside the room. The prompt arrives as the last argument. |
| `health.minFreeGb` | `15` | Below this much free disk, new rooms wait. |
| `cleanup.days` | `7` | Old runs (logs, bundles) are deleted after this many days. |
| `timeZone` | system time zone | Time zone used for quota reset times and in notifications (e.g. `America/New_York`). |
| `labels.*` | see the file | Names of the workflow labels. |

Useful environment variables: `LAB_PAINEL_PORT` (dashboard port, default 7788), `LAB_PREVIEW_PORT`
(preview port, default 8601), `LAB_ORCHESTRATOR_CONFIG` (another config.json), `LAB_NTFY_URL`
(notifications via ntfy when `notify.enabled` is `true`).

---

## `config.env`

Optional. The defaults are in `config.env.example`; create `config.env` with only the lines you want to change.

| Variable | Default | Description |
|---|---|---|
| `LAB_MEMORY_AGENT` / `LAB_CPUS_AGENT` | `3g` / `1.5` | Limits of the agent container. |
| `LAB_MEMORY_DIND` / `LAB_CPUS_DIND` | `768m` / `0.4` | Limits of the room's private Docker. |
| `LAB_VERIFY_*` | — | The same limits for the verification room (with more headroom for test databases). |
| `LAB_PROXY_IMAGE` | `laboratorio-proxy:local` | Name of the proxy image. |
| `LAB_DIND_IMAGE` | `docker:29-dind` | Image of the private Docker. |

---

## `local.env`

Only paths, never the content of the logins. The installer fills it in when it finds the files.

| Variable | Description |
|---|---|
| `LAB_CLAUDE_CREDENTIALS_FILE` | Claude Code login (`~/.claude/.credentials.json`). |
| `LAB_CLAUDE_STATE_FILE` | Optional: `~/.claude.json`, avoids the first-run questions. |
| `LAB_CODEX_AUTH_FILE` | Codex login (`~/.codex/auth.json`). |
| `..._2` to `..._9` | Extra accounts for the same agent. The lab rotates between them and only pauses the agent when all of them are out of quota. |

---

## Domains allowed in the rooms

[proxy/allowed-domains.txt](../../proxy/allowed-domains.txt) lists what the rooms can reach: the
agents' providers, GitHub, npm, Docker Hub, PyPI, apt repositories and the Playwright CDNs. One
domain per line; with a leading `.`, subdomains are included. For a single project, prefer
`dominiosExtras` in `.laboratorio.json`. After changing the list, rebuild the proxy:

```bash
LAB_ONLY_PROXY=1 ./scripts/build-images.sh
```
