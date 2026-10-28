#!/usr/bin/env bash
set -Eeuo pipefail

# Prévia de um PR pronto, para testar no celular antes do merge.
# Uso: preview.sh start <issue> <sha> <bundle>   |   preview.sh stop
# Sala descartável SEM credenciais (perfil de verificação), banco descartável com dados falsos e a app
# exposta só em 127.0.0.1:$LAB_PREVIEW_PORT do PC; o `tailscale serve` do Windows a publica na tailnet.
# Uma prévia por vez: começar outra derruba a anterior.

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${LAB_PREVIEW_PORT:-8601}"
AGENT=codex
PROJECT="${5:-principal}"
[[ "$PROJECT" =~ ^[a-z][a-z0-9]{1,11}$ ]] || { echo "projeto inválido" >&2; exit 2; }
ROOM="$PROJECT-previa"
CONTAINER="lab-$AGENT-$ROOM-agent"
FORWARD="${LAB_PREVIEW_FORWARD:-lab-previa-porta}"  # outro nome num laboratório de ensaio, para não derrubar a prévia do principal
STATE="$LAB_ROOT/workspaces/previa.json"

status() { printf '{"issue":%s,"sha":"%s","state":"%s","at":"%s","detail":"%s","project":"%s"}\n' "$1" "$2" "$3" "$(date -u +%FT%TZ)" "${4:-}" "$PROJECT" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"; }

stop() {
  docker rm -f "$FORWARD" >/dev/null 2>&1 || true
  if [[ -f "$LAB_ROOT/workspaces/previa-room" ]]; then
    OLD_PROJECT="$(cat "$LAB_ROOT/workspaces/previa-room")"
    [[ "$OLD_PROJECT" =~ ^[a-z][a-z0-9]{1,11}$ ]] || return 1
    "$LAB_ROOT/scripts/destroy-room.sh" "$AGENT" "$OLD_PROJECT-previa" >/dev/null 2>&1 || true
  fi
  "$LAB_ROOT/scripts/destroy-room.sh" "$AGENT" "$ROOM" >/dev/null 2>&1 || true
}

case "${1:-}" in
  stop) stop; rm -f "$STATE"; exit 0 ;;
  start) ;;
  *) echo "uso: $0 start <issue> <sha> <bundle> | stop" >&2; exit 2 ;;
esac

ISSUE="$2"; SHA="$3"; BUNDLE="$4"
[[ "$ISSUE" =~ ^[0-9]+$ && "$SHA" =~ ^[0-9a-f]{40}$ && -f "$BUNDLE" ]] || { echo "argumentos invalidos" >&2; exit 2; }
trap 'status "$ISSUE" "$SHA" erro "falhou na linha $LINENO"; stop' ERR

stop
printf '%s\n' "$PROJECT" > "$LAB_ROOT/workspaces/previa-room"
status "$ISSUE" "$SHA" preparando
LAB_PROJECT_ID="$PROJECT" LAB_USE_CLI_AUTH=0 LAB_USE_SECRETS=0 LAB_ROOM_PROFILE=verify "$LAB_ROOT/scripts/create-room.sh" "$AGENT" "$ROOM" >/dev/null

docker exec -i "$CONTAINER" sh -c 'mkdir -p /tmp/lab && cat > /tmp/lab/input.bundle' < "$BUNDLE"
docker exec -i "$CONTAINER" sh -c 'cat > /tmp/lab/previa-vite.mjs' < "$LAB_ROOT/scripts/previa-vite.mjs"
docker exec -i "$CONTAINER" sh -c 'cat > /tmp/lab/preview-steps.mjs' < "$LAB_ROOT/scripts/preview-steps.mjs"
docker exec "$CONTAINER" bash -c '
set -Eeuo pipefail
cd /workspace
snapshot="$(git rev-parse HEAD)"
git fetch --quiet --no-tags /tmp/lab/input.bundle "+refs/lab/*:refs/lab/*"
git checkout --quiet --detach "$1"
node /tmp/lab/preview-steps.mjs "$2" "$snapshot"
' preparo "$SHA" "${LAB_PROJECT_CONFIG:?configuração da prévia ausente}"
APP_PORT="$(node -e 'console.log(JSON.parse(process.argv[1]).previa.porta)' "$LAB_PROJECT_CONFIG")"

# Ponte da rede interna da sala para 127.0.0.1 do PC, sem imagem nova (Node da própria imagem da sala).
IMAGE="$(docker inspect --format '{{.Config.Image}}' "$CONTAINER")"
docker run -d --name "$FORWARD" --label lab.previa=1 --memory 128m -p "127.0.0.1:$PORT:8000" --entrypoint node "$IMAGE" -e '
const net = require("net");
net.createServer((c) => {
  const u = net.connect(Number(process.argv[2]), process.argv[1]);
  c.pipe(u).pipe(c);
  u.on("error", () => c.destroy()); c.on("error", () => u.destroy());
}).listen(8000);' "lab-$AGENT-$ROOM-dind" "$APP_PORT" >/dev/null  # o agente usa a rede do DinD, que é quem tem nome na rede
docker network connect "lab-$AGENT-$ROOM-internal" "$FORWARD"

for i in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && { status "$ISSUE" "$SHA" pronta; exit 0; }; sleep 2; done
status "$ISSUE" "$SHA" erro "o app não respondeu"; [ -n "${LAB_PREVIEW_KEEP:-}" ] || stop; exit 1
