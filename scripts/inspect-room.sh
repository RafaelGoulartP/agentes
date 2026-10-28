#!/usr/bin/env bash
set -Eeuo pipefail

AGENT="${1:-}"
TASK_ID="${2:-}"
ROOM="lab-${AGENT}-${TASK_ID,,}"

docker inspect \
  "${ROOM}-agent" "${ROOM}-dind" "${ROOM}-proxy" \
  --format '{{.Name}} memory={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}} pids={{.HostConfig.PidsLimit}} privileged={{.HostConfig.Privileged}} networks={{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}'

