#!/bin/sh
# Entrega ao git o token do controlador pela variável de ambiente do processo, sem expô-lo em argumentos.
case "${1:-}" in
  Username*) echo x-access-token ;;
  *) printf '%s\n' "${LAB_GIT_TOKEN:?token ausente}" ;;
esac
