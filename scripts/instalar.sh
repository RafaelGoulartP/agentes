#!/usr/bin/env bash
set -Eeuo pipefail

# Prepara o laboratório nesta máquina. Pode rodar quantas vezes quiser: nunca sobrescreve o que já existe.
# Uso: ./scripts/instalar.sh [--sem-imagens] [--servicos]
#   --sem-imagens  não constrói a imagem do proxy agora
#   --servicos     instala e liga os serviços systemd do painel e do orquestrador

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD=1
SERVICES=0
for arg in "$@"; do
  case "$arg" in
    --sem-imagens) BUILD=0 ;;
    --servicos) SERVICES=1 ;;
    -h|--help) sed -n '3,7p' "$0"; exit 0 ;;
    *) echo "opção desconhecida: $arg" >&2; exit 2 ;;
  esac
done

ok() { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33maviso\033[0m %s\n' "$*"; }
fail() { printf '  \033[31mfalta\033[0m %s\n' "$*"; MISSING=1; }
MISSING=0

echo "== Pré-requisitos"
case "$(uname -s)" in
  Linux)
    if grep -qi microsoft /proc/version 2>/dev/null; then ok "Windows + WSL2"; else ok "Linux"; fi ;;
  Darwin) warn "macOS: suporte experimental (precisa de bash >= 4.4 do Homebrew e do Docker Desktop)" ;;
  *) fail "sistema não suportado: $(uname -s). Use Linux ou Windows com WSL2." ;;
esac

if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then ok "bash $BASH_VERSION"
else fail "bash >= 4.4 (encontrado $BASH_VERSION)"; fi

[[ "$LAB_ROOT" != *" "* ]] || fail "a pasta do laboratório não pode ter espaços: $LAB_ROOT"
case "$LAB_ROOT" in
  /mnt/[a-z]/*) warn "o laboratório está no disco do Windows ($LAB_ROOT): fica lento e as permissões 600 não valem. Clone dentro do Linux (ex.: ~/laboratorio-agentes)." ;;
esac

command -v git >/dev/null && ok "git $(git --version | awk '{print $3}')" || fail "git (sudo apt-get install -y git)"

# O Node pode estar só no NVM (comum quando instalado pelo usuário).
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then source "$NVM_DIR/nvm.sh"; fi
if command -v node >/dev/null; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if (( NODE_MAJOR >= 22 )); then ok "Node.js $(node -v)"; else fail "Node.js >= 22 (encontrado $(node -v)); veja docs/INSTALACAO.md"; fi
else
  fail "Node.js >= 22 (veja docs/INSTALACAO.md: nvm install 24)"
fi

if command -v docker >/dev/null; then
  if docker info >/dev/null 2>&1; then ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  else fail "Docker instalado, mas sem acesso ao daemon (Docker Desktop aberto? usuário no grupo docker?)"; fi
else
  fail "Docker (Docker Desktop com integração WSL, ou Docker Engine no Linux)"
fi

command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 \
  && ok "systemd do usuário (serviços automáticos disponíveis)" \
  || warn "sem systemd do usuário: rode painel e orquestrador à mão (scripts/run-dashboard.sh, scripts/run-orchestrator.sh)"

if (( MISSING )); then
  echo
  echo "Resolva os itens marcados como 'falta' e rode de novo. Passo a passo: docs/INSTALACAO.md"
  exit 1
fi

echo
echo "== Arquivos locais (fora do Git)"
umask 077
mkdir -p "$LAB_ROOT/logs" "$LAB_ROOT/workspaces" "$LAB_ROOT/orchestrator/state"

if [[ -f "$LAB_ROOT/orchestrator/config.json" ]]; then ok "orchestrator/config.json já existe (mantido)"
else
  node -e '
    const fs = require("fs");
    const [src, dst] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(src, "utf8"));
    config.enabled = true;
    fs.writeFileSync(dst, JSON.stringify(config, null, 2) + "\n", { mode: 0o644 });
  ' "$LAB_ROOT/orchestrator/config.example.json" "$LAB_ROOT/orchestrator/config.json"
  ok "orchestrator/config.json criado (enabled=true, 1 sala por vez)"
fi

TOKEN_FILE="$LAB_ROOT/secrets/github-controller.env"
if [[ -f "$TOKEN_FILE" ]]; then ok "secrets/github-controller.env já existe (mantido)"
else
  cp "$LAB_ROOT/secrets/github-controller.env.example" "$TOKEN_FILE"
  warn "secrets/github-controller.env criado VAZIO: cole o token do GitHub em GH_TOKEN= (veja docs/INSTALACAO.md)"
fi
chmod 600 "$TOKEN_FILE"
for secret in "$LAB_ROOT"/secrets/*.env; do chmod 600 "$secret"; done

# Logins das CLIs: procura no Linux e, no WSL, nas pastas do Windows.
find_login() {
  local relative="$1" candidate
  for candidate in "$HOME/$relative" /mnt/c/Users/*/"$relative"; do
    [[ -f "$candidate" ]] && { printf '%s\n' "$candidate"; return 0; }
  done
  return 1
}
if [[ -f "$LAB_ROOT/local.env" ]]; then ok "local.env já existe (mantido)"
else
  cp "$LAB_ROOT/local.env.example" "$LAB_ROOT/local.env"
  set_var() { sed -i "s|^$1=.*|$1=$2|" "$LAB_ROOT/local.env"; }
  if claude_login="$(find_login .claude/.credentials.json)"; then set_var LAB_CLAUDE_CREDENTIALS_FILE "$claude_login"; ok "login do Claude Code: $claude_login"
  else warn "login do Claude Code não encontrado (rode 'claude' e faça login, ou use secrets/claude.env)"; fi
  if claude_state="$(find_login .claude.json)"; then set_var LAB_CLAUDE_STATE_FILE "$claude_state"; fi
  if codex_login="$(find_login .codex/auth.json)"; then set_var LAB_CODEX_AUTH_FILE "$codex_login"; ok "login do Codex: $codex_login"
  else warn "login do Codex não encontrado (rode 'codex login', ou use secrets/codex.env)"; fi
  ok "local.env criado"
fi

echo
echo "== Testes do laboratório"
(cd "$LAB_ROOT/orchestrator" && npm test >"$LAB_ROOT/logs/instalar-testes.log" 2>&1) \
  && ok "testes passaram (log em logs/instalar-testes.log)" \
  || { fail "testes falharam: veja logs/instalar-testes.log"; exit 1; }

if (( BUILD )); then
  echo
  echo "== Imagem do proxy de saída"
  LAB_ONLY_PROXY=1 "$LAB_ROOT/scripts/build-images.sh" >"$LAB_ROOT/logs/instalar-proxy.log" 2>&1 \
    && ok "imagem do proxy construída" \
    || { fail "build do proxy falhou: veja logs/instalar-proxy.log"; exit 1; }
fi

if (( SERVICES )); then
  echo
  echo "== Serviços"
  "$LAB_ROOT/scripts/install-user-service.sh" --ativar
fi

echo
echo "Pronto. Próximos passos:"
grep -q '^GH_TOKEN=.\+' "$TOKEN_FILE" || echo "  1. Cole o token do GitHub em secrets/github-controller.env (GH_TOKEN=...)"
if (( SERVICES )); then
  echo "  2. Abra o painel: http://127.0.0.1:${LAB_PAINEL_PORT:-7788} (aba Projetos -> adicionar repositório)"
else
  echo "  2. Ligue tudo: ./scripts/install-user-service.sh --ativar"
  echo "     (sem systemd: ./scripts/run-dashboard.sh & ./scripts/run-orchestrator.sh)"
  echo "  3. Abra o painel: http://127.0.0.1:${LAB_PAINEL_PORT:-7788} (aba Projetos -> adicionar repositório)"
fi
