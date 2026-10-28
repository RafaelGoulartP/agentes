#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "uso: $0 <codex|claude> <identificador>" >&2
  exit 2
}

AGENT="${1:-}"
TASK_ID="${2:-}"
CONTROL_DIR="${3:-}"
[[ "$AGENT" == "codex" || "$AGENT" == "claude" ]] || usage
[[ "$TASK_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$ ]] || usage

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$LAB_ROOT/config.env.example"
if [[ -f "$LAB_ROOT/config.env" ]]; then
  source "$LAB_ROOT/config.env"
fi
if [[ -f "$LAB_ROOT/local.env" ]]; then
  source "$LAB_ROOT/local.env"
fi

PROJECT="${LAB_PROJECT_ID:-principal}"
[[ "$PROJECT" =~ ^[a-z][a-z0-9]{1,11}$ ]] || usage
LAB_CODEX_IMAGE="sala-codex-$PROJECT:local"
LAB_CLAUDE_IMAGE="sala-claude-$PROJECT:local"

if [[ "${LAB_ROOM_PROFILE:-agent}" == "verify" ]]; then
  LAB_MEMORY_AGENT="$LAB_VERIFY_MEMORY_AGENT"
  LAB_MEMORY_DIND="$LAB_VERIFY_MEMORY_DIND"
  LAB_CPUS_AGENT="$LAB_VERIFY_CPUS_AGENT"
  LAB_CPUS_DIND="$LAB_VERIFY_CPUS_DIND"
fi

ROOM="lab-${AGENT}-${TASK_ID,,}"
INTERNAL_NETWORK="${ROOM}-internal"
EGRESS_NETWORK="${ROOM}-egress"
PROXY_CONTAINER="${ROOM}-proxy"
DIND_CONTAINER="${ROOM}-dind"
AGENT_CONTAINER="${ROOM}-agent"
DIND_VOLUME="${ROOM}-dind-data"
ROOM_LABEL="lab.room=${ROOM}"

if docker container inspect "$AGENT_CONTAINER" >/dev/null 2>&1; then
  echo "a sala $ROOM ja existe" >&2
  exit 1
fi

for image in "$LAB_PROXY_IMAGE" "$([[ "$AGENT" == "claude" ]] && echo "$LAB_CLAUDE_IMAGE" || echo "$LAB_CODEX_IMAGE")"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "imagem $image ausente: rode scripts/build-images.sh (ou adicione o projeto pelo painel)" >&2
    exit 1
  }
done

# Qualquer saída antes do fim (erro de comando ou `exit` de validação) desmonta o que já foi criado.
room_ready=0
cleanup_partial() {
  (( room_ready )) && return 0
  docker rm -f -v "$AGENT_CONTAINER" "$DIND_CONTAINER" "$PROXY_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$INTERNAL_NETWORK" "$EGRESS_NETWORK" >/dev/null 2>&1 || true
  docker volume rm "$DIND_VOLUME" >/dev/null 2>&1 || true
}
trap cleanup_partial EXIT

docker network create --label "$ROOM_LABEL" --internal "$INTERNAL_NETWORK" >/dev/null
docker network create --label "$ROOM_LABEL" "$EGRESS_NETWORK" >/dev/null
# Volume nomeado e rotulado para o /var/lib/docker do DinD, para a destruição achá-lo com certeza.
docker volume create --label "$ROOM_LABEL" "$DIND_VOLUME" >/dev/null

docker run -d \
  --name "$PROXY_CONTAINER" \
  --label "$ROOM_LABEL" \
  --hostname proxy \
  --network "$EGRESS_NETWORK" \
  --memory "$LAB_MEMORY_PROXY" \
  --memory-swap "$LAB_MEMORY_PROXY" \
  --cpus "$LAB_CPUS_PROXY" \
  --pids-limit "$LAB_PIDS_PROXY" \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --sysctl net.ipv6.conf.all.disable_ipv6=1 \
  --sysctl net.ipv6.conf.default.disable_ipv6=1 \
  --env "LAB_DENIED_DOMAINS=${LAB_DENIED_DOMAINS:-}" \
  --env "LAB_EXTRA_DOMAINS=${LAB_EXTRA_DOMAINS:-}" \
  "$LAB_PROXY_IMAGE" >/dev/null
# Sem IPv6 de saída no host: o Squid só tenta IPv4. Com IPv6 ligado ele escolhia o AAAA de chatgpt.com e
# api.openai.com, falhava (503 / conexão derrubada) e o Codex não conseguia conversar com a OpenAI (16/10/2026).

docker network connect --alias proxy "$INTERNAL_NETWORK" "$PROXY_CONTAINER"

# O proxy é a única saída da sala: se o Squid não subir (ex.: lista de domínios recusada), a sala falha aqui
# com o motivo, em vez de o agente rodar sem internet e cair por "conexão".
proxy_ready=0
for _ in $(seq 1 60); do
  if docker exec "$PROXY_CONTAINER" grep -q "Accepting HTTP Socket connections" /var/log/squid/cache.log 2>/dev/null; then proxy_ready=1; break; fi
  [[ "$(docker inspect -f '{{.State.Running}}' "$PROXY_CONTAINER" 2>/dev/null)" == true ]] || break
  sleep 0.25
done
if (( ! proxy_ready )); then
  echo "proxy da sala não iniciou: $(docker logs "$PROXY_CONTAINER" 2>&1 | grep -E 'FATAL|ERROR' | head -3 | tr '\n' ' ')" >&2
  false
fi

docker run -d \
  --name "$DIND_CONTAINER" \
  --label "$ROOM_LABEL" \
  --mount "type=volume,src=$DIND_VOLUME,dst=/var/lib/docker" \
  --hostname dind \
  --network "$INTERNAL_NETWORK" \
  --network-alias dind \
  --memory "$LAB_MEMORY_DIND" \
  --memory-swap "$LAB_MEMORY_DIND" \
  --cpus "$LAB_CPUS_DIND" \
  --pids-limit "$LAB_PIDS_DIND" \
  --privileged \
  --env DOCKER_TLS_CERTDIR= \
  --env HTTP_PROXY=http://proxy:3128 \
  --env HTTPS_PROXY=http://proxy:3128 \
  --env NO_PROXY=localhost,127.0.0.1,dind \
  "$LAB_DIND_IMAGE" \
  --host=tcp://0.0.0.0:2375 \
  --host=unix:///var/run/docker.sock \
  --tls=false >/dev/null

IMAGE="$LAB_CODEX_IMAGE"
SECRET_FILE="$LAB_ROOT/secrets/codex.env"
if [[ "$AGENT" == "claude" ]]; then
  IMAGE="$LAB_CLAUDE_IMAGE"
  SECRET_FILE="$LAB_ROOT/secrets/claude.env"
fi

SECRET_MOUNT=()
if [[ "${LAB_USE_SECRETS:-0}" == "1" && -f "$SECRET_FILE" ]]; then
  SECRET_MOUNT=(--mount "type=bind,src=$SECRET_FILE,dst=/run/secrets/agent.env,readonly")
fi

CONTROL_MOUNT=()
if [[ -n "$CONTROL_DIR" ]]; then
  mkdir -p "$CONTROL_DIR"
  CONTROL_DIR="$(realpath "$CONTROL_DIR")"
  WORKSPACES_ROOT="$(realpath "$LAB_ROOT/workspaces")"
  [[ "$CONTROL_DIR" == "$WORKSPACES_ROOT"/* ]] || {
    echo "diretorio de controle fora de $WORKSPACES_ROOT" >&2
    exit 1
  }
  CONTROL_MOUNT=(--mount "type=bind,src=$CONTROL_DIR,dst=/run/lab-control")
fi

# Sudo/apt usam capabilities padrão; descartamos as demais sem adicionar nenhuma.
docker run -d \
  --name "$AGENT_CONTAINER" \
  --label "$ROOM_LABEL" \
  --network "container:$DIND_CONTAINER" \
  --memory "$LAB_MEMORY_AGENT" \
  --memory-swap "$LAB_MEMORY_AGENT" \
  --cpus "$LAB_CPUS_AGENT" \
  --pids-limit "$LAB_PIDS_AGENT" \
  --cap-drop MKNOD \
  --cap-drop NET_BIND_SERVICE --cap-drop NET_RAW \
  --cap-drop SETFCAP --cap-drop SETPCAP \
  --tmpfs /tmp:rw,nosuid,nodev,size=768m \
  --env DOCKER_HOST=tcp://127.0.0.1:2375 \
  --env HTTP_PROXY=http://proxy:3128 \
  --env HTTPS_PROXY=http://proxy:3128 \
  --env NO_PROXY=localhost,127.0.0.1,dind \
  "${SECRET_MOUNT[@]}" \
  "${CONTROL_MOUNT[@]}" \
  "$IMAGE" >/dev/null

if [[ "${LAB_USE_CLI_AUTH:-0}" == "1" ]]; then
  # Conta extra do agente (claude-2 usa LAB_CLAUDE_CREDENTIALS_FILE_2 etc.); a padrão usa as variáveis sem sufixo.
  ACCOUNT="${LAB_AGENT_ACCOUNT:-$AGENT}"
  if [[ "$ACCOUNT" != "$AGENT" ]]; then
    [[ "$ACCOUNT" =~ ^${AGENT}-([2-9])$ ]] || {
      echo "conta invalida: $ACCOUNT" >&2
      exit 1
    }
    SUFFIX="_${BASH_REMATCH[1]}"
    for name in LAB_CODEX_AUTH_FILE LAB_CLAUDE_CREDENTIALS_FILE LAB_CLAUDE_STATE_FILE; do
      extra="$name$SUFFIX"
      printf -v "$name" '%s' "${!extra:-}"
    done
  fi
  if (( ${#SECRET_MOUNT[@]} )) && { [[ "$AGENT" == "codex" && ! -f "${LAB_CODEX_AUTH_FILE:-}" ]] ||
       [[ "$AGENT" == "claude" && ! -f "${LAB_CLAUDE_CREDENTIALS_FILE:-}" ]]; }; then
    : # Sem login da CLI, mas com chave de API em secrets/<agente>.env: a sala usa a chave.
  elif [[ "$AGENT" == "codex" ]]; then
    [[ -f "${LAB_CODEX_AUTH_FILE:-}" ]] || {
      echo "login do Codex CLI nao encontrado: preencha LAB_CODEX_AUTH_FILE no local.env ou crie secrets/codex.env" >&2
      exit 1
    }
    docker exec --user node "$AGENT_CONTAINER" mkdir -p /home/node/.codex
    docker exec --interactive --user node "$AGENT_CONTAINER" sh -c \
      'umask 077; cat > /home/node/.codex/auth.json' < "$LAB_CODEX_AUTH_FILE"
  else
    [[ -f "${LAB_CLAUDE_CREDENTIALS_FILE:-}" ]] || {
      echo "login do Claude Code nao encontrado: preencha LAB_CLAUDE_CREDENTIALS_FILE no local.env ou crie secrets/claude.env" >&2
      exit 1
    }
    docker exec --user node "$AGENT_CONTAINER" mkdir -p /home/node/.claude
    docker exec --interactive --user node "$AGENT_CONTAINER" sh -c \
      'umask 077; cat > /home/node/.claude/.credentials.json' < "$LAB_CLAUDE_CREDENTIALS_FILE"
    if [[ -f "${LAB_CLAUDE_STATE_FILE:-}" ]]; then
      docker exec --interactive --user node "$AGENT_CONTAINER" sh -c \
        'umask 077; cat > /home/node/.claude.json' < "$LAB_CLAUDE_STATE_FILE"
    fi
  fi
fi

for _ in $(seq 1 60); do
  if docker exec "$AGENT_CONTAINER" docker info >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$AGENT_CONTAINER" docker info >/dev/null

room_ready=1
printf 'sala=%s\nagente=%s\ncontainer=%s\nrede_interna=%s\nrede_egress=%s\n' \
  "$ROOM" "$AGENT" "$AGENT_CONTAINER" "$INTERNAL_NETWORK" "$EGRESS_NETWORK"

