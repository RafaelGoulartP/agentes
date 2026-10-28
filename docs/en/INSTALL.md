# Step-by-step installation

This guide takes you from zero to the first PR made by an agent. It takes 30 to 60 minutes, most of it
waiting for downloads. Pick your system:

- [Windows 10/11 (with WSL2)](#windows-1011) — the most common path
- [Linux (Ubuntu/Debian)](#linux-ubuntudebian)
- [macOS (experimental)](#macos-experimental)

Then everyone follows the common part: [Agent login](#2-agent-login), [GitHub token](#3-github-token),
[Install the lab](#4-install-the-lab) and [First project](#5-first-project).

> **About the language:** the dashboard and the messages the lab writes on GitHub are in Brazilian
> Portuguese. This guide shows each button with its Portuguese label and a translation, for example
> **Projetos** (Projects).

---

## 1. Prepare the system

### Windows 10/11

The lab runs inside Windows' Linux (WSL2), with Docker Desktop.

1. **Install WSL2 with Ubuntu.** Open PowerShell **as administrator** and run:

   ```powershell
   wsl --install -d Ubuntu
   ```

   Restart the PC when asked. The first time Ubuntu opens, create a Linux user and password.

2. **Enable systemd in Ubuntu** (so the services start on their own). In the Ubuntu terminal:

   ```bash
   printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
   ```

   Then, in PowerShell: `wsl --shutdown`, and open Ubuntu again.

3. **Give WSL enough memory.** Create the file `C:\Users\<your-user>\.wslconfig` with:

   ```ini
   [wsl2]
   memory=12GB
   processors=6
   ```

   Plan for about 4 GB per room you want to run at the same time, plus 4 GB of headroom. Run `wsl --shutdown` to apply.

4. **Install Docker Desktop** (https://www.docker.com/products/docker-desktop/). In
   *Settings → Resources → WSL integration*, enable the **Ubuntu** distribution. Have Docker Desktop
   start with Windows (*Settings → General → Start Docker Desktop when you sign in*).

5. **Check it in Ubuntu:**

   ```bash
   docker run --rm hello-world
   ```

6. Go to [Node.js](#nodejs-all-systems).

> **Important:** always work **inside Ubuntu** (`~`), never in `/mnt/c/...`. Cloning the
> repository from Windows breaks the scripts (line endings) and the permissions of the secrets.

### Linux (Ubuntu/Debian)

1. **Docker Engine** (official guide: https://docs.docker.com/engine/install/):

   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker "$USER"
   ```

   Log out and back in (or restart) so the `docker` group takes effect. Check with `docker run --rm hello-world`.

2. **Git:** `sudo apt-get update && sudo apt-get install -y git`

3. Go to [Node.js](#nodejs-all-systems).

### macOS (experimental)

It works with Docker Desktop, but it is not tested often.

1. Install Docker Desktop and Homebrew (https://brew.sh).
2. `brew install bash git node` (macOS ships a bash that is too old; the scripts need bash 4.4+).
3. Claude Code on macOS keeps its login in the Keychain, not in a file. Use an
   [API key](#alternative-api-keys) for Claude, or log in from inside a Linux machine.
4. There is no systemd: run the dashboard and the orchestrator by hand (see step 4).

### Node.js (all systems)

The lab needs Node 22 or newer **inside Linux/WSL**. The simplest way is nvm:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24
node -v   # should print v24.x
```

---

## 2. Agent login

You need **at least one** of the two agents. The lab uses your subscription through the CLI login
(the same one you use in the terminal). Install and log in **once** in Linux/WSL:

```bash
npm install -g @anthropic-ai/claude-code @openai/codex

claude          # opens the Claude Code login in the browser; then type /exit
codex login     # Codex login with your ChatGPT account
```

This creates `~/.claude/.credentials.json` and `~/.codex/auth.json`. The installer finds these files
on its own. On Windows, if you already logged in to the CLIs **from Windows**, it also looks in
`/mnt/c/Users/<user>/`.

> Each room uses your subscription's normal quota. When the quota runs out, the lab pauses only that
> agent and resumes on its own when the quota resets.

### Alternative: API keys

If you prefer to pay per use, without a subscription:

```bash
cp secrets/claude.env.example secrets/claude.env   # ANTHROPIC_API_KEY=...
cp secrets/codex.env.example secrets/codex.env     # CODEX_API_KEY=...
chmod 600 secrets/*.env
```

A key is only used when no CLI login is configured for that agent. Use keys dedicated to the lab,
with a spending limit.

### Several accounts for the same agent (optional)

To split the work between two subscriptions, point the variables with suffixes `_2` to `_9` in
`local.env` to the other account's login files. Example: `LAB_CLAUDE_CREDENTIALS_FILE_2=/path/.credentials.json`.

---

## 3. GitHub token

The controller uses **one** token to read issues, push branches and open PRs. The agents never receive it.

1. Open https://github.com/settings/personal-access-tokens/new (*fine-grained* token).
2. **Token name:** `agentes`. **Expiration:** whatever you prefer (write it down so you can renew it).
3. **Resource owner:** you (or the organization that owns the repositories).
4. **Repository access:** *Only select repositories* → choose the repositories the lab will work on.
5. **Permissions → Repository permissions:**
   - **Contents:** Read and write
   - **Issues:** Read and write
   - **Pull requests:** Read and write
   - **Metadata:** Read-only (already selected)
6. Click **Generate token** and copy the value (`github_pat_...`).

You will paste this value in the next step. To add a new repository later, edit the token and include
the repository. You don't need to replace the token.

> The repository needs **at least one commit** (e.g. a README) and **Issues enabled**.

---

## 4. Install the lab

```bash
cd ~
git clone https://github.com/RafaelGoulartP/agentes.git
cd agentes
./scripts/instalar.sh
```

The installer:

- checks the system, bash, git, Node and Docker, and tells you exactly what is missing;
- creates `orchestrator/config.json`, `local.env` (with the logins it found) and `secrets/github-controller.env`;
- runs the lab's tests (about 10 seconds);
- builds the outbound proxy image.

It never deletes or overwrites files that already exist. You can run it again as many times as you want.

**Paste the token:**

```bash
nano secrets/github-controller.env    # make the line look like this: GH_TOKEN=github_pat_...
```

Check the token against a repository (read-only, changes nothing):

```bash
cd orchestrator && node src/check-access.mjs <owner>/<repository> && cd ..
```

**Start the dashboard and the orchestrator:**

```bash
./scripts/install-user-service.sh --ativar
```

This installs two user services (`laboratorio-painel` and `laboratorio-orquestrador`). They start
with the computer. Without systemd (macOS, or WSL without systemd), run them in two terminals:

```bash
./scripts/run-dashboard.sh
./scripts/run-orchestrator.sh
```

---

## 5. First project

1. Open **http://127.0.0.1:7788** (on Windows, use `127.0.0.1`, not `localhost`).
2. In the **Projetos** (Projects) tab, paste the repository URL (e.g. `https://github.com/you/my-app`)
   and click **Adicionar** (Add). The lab checks access and creates the labels (`claude`, `codex`,
   `em-andamento` = in progress, `bloqueado` = blocked, `pronto-para-revisao` = ready for review).
3. If the repository doesn't have a `.laboratorio.json` yet, click **Gerar configuração** (Generate
   configuration). The lab opens an issue and an agent writes the file for your project. Review the PR
   (check `instalar` and `verificar` especially) and merge it.
   If you prefer, write the file yourself (see [CONFIGURATION.md](CONFIGURATION.md)).
4. The lab builds the project image (the first time can take 5 to 20 minutes) and the card becomes
   **pronto** (ready).
5. Create a small test issue, for example: *"Add a 'How to run' section to the README"*, with the
   labels `claude` and `area:docs`.
6. Watch it in the **Agora** (Now) tab. In a few minutes the PR shows up with the `pronto-para-revisao` label.

To help the agents get it right more often, prepare the repository with an `AGENTS.md` and
well-written issues: see **[PREPARE-PROJECT.md](PREPARE-PROJECT.md)**.

---

## Dashboard on your phone (optional)

The dashboard has no password and listens only on `127.0.0.1`. To open it on your phone without
exposing it to the internet, use [Tailscale](https://tailscale.com) (a VPN that is free for personal use):

- **Linux:** install Tailscale and run `sudo tailscale serve --bg http://127.0.0.1:7788`. The dashboard
  is then at `https://<your-machine>.<tailnet>.ts.net`, visible only to your devices.
- **Windows + WSL:** install Tailscale on Windows. In PowerShell **as administrator**, forward the
  port to WSL and allow only the Tailscale network:

  ```powershell
  netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=7789 connectaddress=127.0.0.1 connectport=7788
  New-NetFirewallRule -DisplayName "Agentes dashboard (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 7789 -Action Allow -RemoteAddress 100.64.0.0/10
  tailscale serve --bg http://127.0.0.1:7789
  ```

  The **Abrir no celular** (Open on your phone) section of the **Sistema** (System) tab shows the addresses. Through the `https://` address the
  phone can install the dashboard as an app and receive notifications (Web Push).

---

## Update

```bash
cd ~/agentes
git pull
./scripts/instalar.sh              # checks everything and runs the tests again
systemctl --user restart laboratorio-painel laboratorio-orquestrador
```

Your local files (`config.json`, `local.env`, `secrets/`, state and runs) are not versioned and are
not touched by `git pull`.

## Uninstall

```bash
systemctl --user disable --now laboratorio-painel laboratorio-orquestrador
rm ~/.config/systemd/user/laboratorio-{painel,orquestrador}.service
docker ps -aq --filter label=lab.room | xargs -r docker rm -f -v
docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^(sala-|laboratorio-proxy)' | xargs -r docker rmi
rm -rf ~/agentes
```

Also revoke the token at https://github.com/settings/personal-access-tokens.

---

## Troubleshooting

**See what is going on:**

```bash
systemctl --user status laboratorio-orquestrador
journalctl --user -u laboratorio-orquestrador -n 100 --no-pager
tail -n 50 logs/orchestrator.jsonl          # controller events, one JSON per line
docker ps --filter label=lab.room           # rooms open right now
```

The messages below are shown in Portuguese by the lab; the English meaning is in parentheses.

| Symptom | Likely cause and fix |
|---|---|
| `$'\r': command not found` | Repository cloned from Windows. Delete it and clone inside WSL (`cd ~`). |
| `permission denied while trying to connect to the Docker daemon` | Linux: user not in the `docker` group (`sudo usermod -aG docker $USER`, then log out and in). WSL: Docker Desktop closed or without Ubuntu integration. |
| Orchestrator restarts in a loop with "token do controlador ausente" (controller token missing) | Create `secrets/github-controller.env` with `GH_TOKEN=...` (`./scripts/instalar.sh` creates the template). |
| Project "sem acesso" (no access) | The token doesn't include the repository, or lacks write access to Contents, Issues or Pull requests. Edit the token and click **Verificar de novo** (Check again). |
| Project "erro: crie o repositório com um README" (create the repository with a README) | The repository is empty. Make a first commit. |
| Issue never starts | Look at the **Tarefas** (Tasks) tab: the dashboard says why (area busy, dependency, quota, no free slot...). Check that the issue has the `claude` or `codex` label and that this agent has a login (`local.env`). |
| `login do Claude Code nao encontrado` (Claude Code login not found) | `LAB_CLAUDE_CREDENTIALS_FILE` in `local.env` doesn't point to an existing file. Run `claude` to log in, or use `secrets/claude.env`. |
| Red banner "salas novas em pausa" (new rooms paused) | The dashboard shows the reason: no internet, provider down, low disk (< 15 GB) or several failures in a row. It recovers on its own. |
| Verification always fails on the same command | The `verificar` command in `.laboratorio.json` doesn't pass even on `main`. Fix it on `main` first. |
| Dashboard doesn't open | `systemctl --user status laboratorio-painel`. On Windows use `http://127.0.0.1:7788`. Another port: `LAB_PAINEL_PORT=7790`. |
| A room was left behind after a crash | `./scripts/destroy-room.sh <codex\|claude> <id>`; the controller also cleans up on its own when it restarts. |

**Smoke test for a room** (network isolation, tools and login, without GitHub):

```bash
LAB_PROJECT_ID=<project-id> LAB_USE_CLI_AUTH=1 ./scripts/test-room.sh claude
```
