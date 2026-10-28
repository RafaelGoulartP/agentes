#!/usr/bin/env bash
# Supervisor do controlador: executa um comando fora do alcance do agente e grava a saída e o código
# de término em um diretório do host que não é montado em nenhuma sala.
set -uo pipefail

RUN_DIR="${1:?uso: run-supervised.sh <diretorio> <stdin> -- comando...}"
INPUT="${2:?uso: run-supervised.sh <diretorio> <stdin> -- comando...}"
shift 2
[[ "${1:-}" == "--" ]] && shift
(( $# > 0 )) || { echo "comando ausente" >&2; exit 2; }

umask 077
stop=0
child=
trap 'stop=1; [[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null' TERM INT HUP
"$@" <"$INPUT" >>"$RUN_DIR/output.log" 2>&1 &
child=$!
(( stop )) && kill -TERM "$child" 2>/dev/null
wait "$child"
code=$?
# Um sinal interrompe o wait antes do fim do filho; espere o término real.
while kill -0 "$child" 2>/dev/null; do
  wait "$child"
  code=$?
done
printf '%s\n' "$code" >"$RUN_DIR/exit-code.tmp"
mv -f "$RUN_DIR/exit-code.tmp" "$RUN_DIR/exit-code"
