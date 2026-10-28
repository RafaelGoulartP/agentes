#!/usr/bin/env bash
set -Eeuo pipefail

# Uso manual: PROJECT_ROOT=~/meu-projeto ./scripts/build-images.sh (usa o clone local em PROJECT_ROOT).
# Só o proxy (sem projeto): LAB_ONLY_PROXY=1 ./scripts/build-images.sh
# Uso pelo controlador: LAB_SOURCE_COMMIT=<sha> LAB_MIRROR=<repo.git> LAB_BUILD_PROXY=0 ./scripts/build-images.sh
# exporta somente os arquivos versionados desse commit do espelho Git (nada fora do Git entra na imagem).

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$LAB_ROOT/config.env.example"
if [[ -f "$LAB_ROOT/config.env" ]]; then source "$LAB_ROOT/config.env"; fi
PROJECT="${LAB_PROJECT_ID:-principal}"
[[ "$PROJECT" =~ ^[a-z][a-z0-9]{1,11}$ ]] || { echo 'projeto inválido' >&2; exit 2; }
if [[ "${LAB_ONLY_PROXY:-0}" == "1" ]]; then
  exec docker build --tag "$LAB_PROXY_IMAGE" --file "$LAB_ROOT/proxy/Dockerfile" "$LAB_ROOT"
fi
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if ! command -v node >/dev/null && [[ -s "$NVM_DIR/nvm.sh" ]]; then source "$NVM_DIR/nvm.sh"; fi
command -v node >/dev/null || { echo 'Node.js não encontrado (rode scripts/instalar.sh)' >&2; exit 1; }
CONTEXT="$(mktemp -d)"
trap 'rm -rf "$CONTEXT"' EXIT
mkdir -p "$CONTEXT/codigo"
SOURCE_COMMIT="local"
if [[ -n "${LAB_SOURCE_COMMIT:-}" ]]; then
  [[ "$LAB_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { echo "LAB_SOURCE_COMMIT invalido" >&2; exit 2; }
  git --git-dir "${LAB_MIRROR:?LAB_MIRROR ausente}" archive "$LAB_SOURCE_COMMIT" | tar -x -C "$CONTEXT/codigo"
  SOURCE_COMMIT="$LAB_SOURCE_COMMIT"
else
  git -C "${PROJECT_ROOT:?PROJECT_ROOT ausente}" archive HEAD | tar -x -C "$CONTEXT/codigo"
fi
LOCK_HASH="$(node "$LAB_ROOT/scripts/prepare-build.mjs" "$CONTEXT/codigo" "$CONTEXT")"
[[ -z "${LAB_LOCK_HASH:-}" || "$LOCK_HASH" == "$LAB_LOCK_HASH" ]] || { echo 'hash de dependências divergente' >&2; exit 1; }
BASE="sala-base-$PROJECT:local"
LAB_CODEX_IMAGE="sala-codex-$PROJECT:local"
LAB_CLAUDE_IMAGE="sala-claude-$PROJECT:local"

if [[ "${LAB_BUILD_PROXY:-1}" == "1" ]]; then
  docker build \
    --tag "$LAB_PROXY_IMAGE" \
    --file "$LAB_ROOT/proxy/Dockerfile" \
    "$LAB_ROOT"
fi

docker build \
  --tag "$BASE" \
  --label "lab.lockfile.sha256=$LOCK_HASH" \
  --label "lab.source.commit=$SOURCE_COMMIT" \
  --file "$LAB_ROOT/images/Dockerfile.base" \
  "$CONTEXT"

docker build \
  --tag "$LAB_CODEX_IMAGE" \
  --build-arg "BASE_IMAGE=$BASE" \
  --file "$LAB_ROOT/images/Dockerfile.codex" \
  "$LAB_ROOT/images"

docker build \
  --tag "$LAB_CLAUDE_IMAGE" \
  --build-arg "BASE_IMAGE=$BASE" \
  --file "$LAB_ROOT/images/Dockerfile.claude" \
  "$LAB_ROOT/images"

docker image inspect "$LAB_CODEX_IMAGE" "$LAB_CLAUDE_IMAGE" \
  --format '{{.RepoTags}} {{.Id}} {{index .Config.Labels "lab.lockfile.sha256"}}'
