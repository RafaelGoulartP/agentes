#!/usr/bin/env bash
set -Eeuo pipefail

# Teste de fumaça de uma sala: isolamento de rede, ferramentas, Docker privado e login do agente.
# Uso: [LAB_PROJECT_ID=<id>] [LAB_USE_CLI_AUTH=1] ./scripts/test-room.sh <codex|claude>
# Comandos extras do projeto dentro da sala (opcional): LAB_TEST_COMMANDS=$'npm test\nnpm run build'

AGENT="${1:-}"
[[ "$AGENT" == "codex" || "$AGENT" == "claude" ]] || { echo "uso: $0 <codex|claude>" >&2; exit 2; }
TASK_ID="smoke-$(date +%Y%m%d%H%M%S)"
LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$LAB_ROOT/logs"
LOG_FILE="$LAB_ROOT/logs/${AGENT}-${TASK_ID}.log"

exec > >(tee "$LOG_FILE") 2>&1

"$LAB_ROOT/scripts/create-room.sh" "$AGENT" "$TASK_ID"
trap '"$LAB_ROOT/scripts/destroy-room.sh" "$AGENT" "$TASK_ID"' EXIT

ROOM="lab-${AGENT}-${TASK_ID}"
CONTAINER="${ROOM}-agent"

"$LAB_ROOT/scripts/inspect-room.sh" "$AGENT" "$TASK_ID"

echo '--- sem egress direto ---'
if docker exec "$CONTAINER" curl --noproxy '*' --connect-timeout 3 --max-time 5 https://example.com >/dev/null 2>&1; then
  echo 'falha: a sala possui egress direto' >&2
  exit 1
fi

echo '--- domínio fora da lista é recusado pelo proxy ---'
if docker exec "$CONTAINER" curl -fsS --connect-timeout 5 --max-time 10 https://example.com >/dev/null 2>&1; then
  echo 'falha: o proxy liberou um domínio fora da lista' >&2
  exit 1
fi

echo '--- egress permitido somente pelo proxy ---'
docker exec "$CONTAINER" curl -fsS --connect-timeout 10 --max-time 20 https://api.github.com/zen >/dev/null

echo '--- ferramentas ---'
docker exec "$CONTAINER" bash -lc 'node --version; npm --version; git --version; gh --version | head -n1; tmux -V; docker version --format "client={{.Client.Version}} server={{.Server.Version}}"'
if [[ "$AGENT" == "codex" ]]; then
  docker exec "$CONTAINER" codex --version
else
  docker exec "$CONTAINER" claude --version
fi

echo '--- Docker privado da sala (baixa pelo proxy) ---'
docker exec "$CONTAINER" docker run --rm hello-world >/dev/null
echo 'ok'

if [[ -n "${LAB_TEST_COMMANDS:-}" ]]; then
  echo '--- comandos do projeto ---'
  while IFS= read -r command; do
    [[ -n "$command" ]] || continue
    echo "--- $command"
    docker exec "$CONTAINER" bash -lc "cd /workspace && $command"
  done <<< "$LAB_TEST_COMMANDS"
fi

echo '--- agente nao interativo ---'
if [[ "$AGENT" == "codex" ]]; then
  if docker exec "$CONTAINER" test -f /home/node/.codex/auth.json; then
    docker exec "$CONTAINER" codex exec --ephemeral --sandbox read-only "Responda exatamente: CODEX_OK"
  elif docker exec "$CONTAINER" test -f /run/secrets/agent.env; then
    docker exec "$CONTAINER" bash -lc 'set -a; . /run/secrets/agent.env; set +a; codex exec --ephemeral --sandbox read-only "Responda exatamente: CODEX_OK"'
  else
    echo 'SKIP: login do Codex nao montado (use LAB_USE_CLI_AUTH=1); binario validado.'
  fi
else
  if docker exec "$CONTAINER" test -f /home/node/.claude/.credentials.json; then
    docker exec "$CONTAINER" claude -p --max-turns 1 "Responda exatamente: CLAUDE_OK"
  elif docker exec "$CONTAINER" test -f /run/secrets/agent.env; then
    docker exec "$CONTAINER" bash -lc 'set -a; . /run/secrets/agent.env; set +a; claude -p --max-turns 1 "Responda exatamente: CLAUDE_OK"'
  else
    echo 'SKIP: login do Claude nao montado (use LAB_USE_CLI_AUTH=1); binario validado.'
  fi
fi

echo "SUCESSO: $AGENT"
