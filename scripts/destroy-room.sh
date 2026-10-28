#!/usr/bin/env bash
set -Euo pipefail

AGENT="${1:-}"
TASK_ID="${2:-}"
if [[ "$AGENT" != "codex" && "$AGENT" != "claude" ]]; then
  echo "uso: $0 <codex|claude> <identificador>" >&2
  exit 2
fi
if [[ ! "$TASK_ID" =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,47}$ ]]; then
  echo "identificador invalido" >&2
  exit 2
fi

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOM="lab-${AGENT}-${TASK_ID,,}"
failed=0

for container in "${ROOM}-agent" "${ROOM}-dind" "${ROOM}-proxy"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    # -v também remove volumes anônimos ligados ao contêiner.
    docker rm -f -v "$container" >/dev/null || { echo "falha ao remover $container" >&2; failed=1; }
  fi
done

for network in "${ROOM}-internal" "${ROOM}-egress"; do
  if docker network inspect "$network" >/dev/null 2>&1; then
    docker network rm "$network" >/dev/null || { echo "falha ao remover a rede $network" >&2; failed=1; }
  fi
done

# Somente volumes rotulados para esta sala (dados do DinD, incluindo os Mongo aninhados).
while IFS= read -r volume; do
  [[ -n "$volume" ]] || continue
  docker volume rm "$volume" >/dev/null || { echo "falha ao remover o volume $volume" >&2; failed=1; }
done < <(docker volume ls -q --filter "label=lab.room=${ROOM}")

# Versões anteriores do controlador deixavam o token GitHub no diretório de controle da sala.
rm -f "$LAB_ROOT/workspaces/${AGENT}-${TASK_ID,,}/github.env"
if [[ "$TASK_ID" =~ ^([a-z][a-z0-9]{1,11})-issue-([0-9]+)$ ]]; then
  rm -f "$LAB_ROOT/workspaces/${BASH_REMATCH[1]}/${AGENT}-issue-${BASH_REMATCH[2]}/github.env"
fi

if (( failed )); then
  echo "sala destruida parcialmente: $ROOM" >&2
  exit 1
fi
echo "sala destruida: $ROOM"
