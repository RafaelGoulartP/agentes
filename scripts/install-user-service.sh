#!/usr/bin/env bash
set -Eeuo pipefail

# Instala o painel e o orquestrador como serviços systemd do usuário (Linux e WSL com systemd).
# Uso: ./scripts/install-user-service.sh [--ativar]
#   sem argumento: instala os dois serviços, desligados;
#   --ativar: também liga os dois agora e a cada login.

LAB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1 || {
  echo "systemd do usuário indisponível. No WSL, ative systemd em /etc/wsl.conf ([boot] systemd=true)" >&2
  echo "e rode 'wsl --shutdown' no Windows. Sem systemd, use scripts/run-dashboard.sh e scripts/run-orchestrator.sh." >&2
  exit 1
}
[[ "$LAB_ROOT" != *" "* ]] || { echo "a pasta do laboratório não pode ter espaços: $LAB_ROOT" >&2; exit 1; }

mkdir -p "$TARGET_DIR"
for unit in laboratorio-orquestrador laboratorio-painel; do
  sed "s|@LAB_ROOT@|$LAB_ROOT|g" "$LAB_ROOT/systemd/$unit.service" > "$TARGET_DIR/$unit.service.tmp"
  chmod 0644 "$TARGET_DIR/$unit.service.tmp"
  mv "$TARGET_DIR/$unit.service.tmp" "$TARGET_DIR/$unit.service"
done
systemctl --user daemon-reload

if [[ "${1:-}" == "--ativar" ]]; then
  systemctl --user enable --now laboratorio-painel.service laboratorio-orquestrador.service
  # Mantém os serviços rodando sem sessão aberta (quando permitido).
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
  echo "serviços ligados. Painel: http://127.0.0.1:${LAB_PAINEL_PORT:-7788}"
else
  echo "serviços instalados, mas desligados. Para ligar:"
  echo "  systemctl --user enable --now laboratorio-painel.service laboratorio-orquestrador.service"
fi
