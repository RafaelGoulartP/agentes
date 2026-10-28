#!/usr/bin/env bash
set -Eeuo pipefail

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # O systemd não carrega .bashrc; com NVM, vale o Node dele (o do sistema pode ser antigo).
  source "$NVM_DIR/nvm.sh"
fi

command -v node >/dev/null || {
  echo "Node.js nao encontrado (instale o Node 22+; veja docs/INSTALACAO.md)" >&2
  exit 1
}
exec node "$LAB_ROOT/orchestrator/src/dashboard.mjs"
