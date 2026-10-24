#!/usr/bin/env bash
# Muestra el estado del contenedor de Mara OS y sus últimas líneas de log.
#
# Uso:
#   scripts/status.sh        # estado + últimas 20 líneas de log
#   scripts/status.sh 100    # estado + últimas 100 líneas de log
#
# Variables opcionales: MARA_CONTAINER (mara-os)
set -euo pipefail

CONTAINER="${MARA_CONTAINER:-mara-os}"
LINES="${1:-20}"

if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "$CONTAINER: no existe (arráncalo con scripts/start.sh)"
  exit 1
fi

docker container inspect "$CONTAINER" --format \
'Contenedor: {{.Name}}
Imagen:     {{.Config.Image}}
Estado:     {{.State.Status}}{{if .State.Running}} (desde {{.State.StartedAt}}){{end}}
Reinicios:  {{.RestartCount}}
Salida:     {{.State.ExitCode}}'

echo
docker stats --no-stream --format 'CPU: {{.CPUPerc}}   Memoria: {{.MemUsage}}' "$CONTAINER" 2>/dev/null || true

echo
echo "--- Últimas $LINES líneas de log ---"
docker logs --tail "$LINES" "$CONTAINER" 2>&1
