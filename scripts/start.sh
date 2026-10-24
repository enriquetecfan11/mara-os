#!/usr/bin/env bash
# Arranca Mara OS en Docker (construye la imagen si hace falta).
#
# Uso:
#   scripts/start.sh            # arranca usando la imagen existente (o la construye)
#   scripts/start.sh --build    # fuerza reconstruir la imagen antes de arrancar
#
# Variables opcionales: MARA_CONTAINER (mara-os), MARA_IMAGE (mara-os), MARA_PORT (9001)
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="${MARA_CONTAINER:-mara-os}"
IMAGE="${MARA_IMAGE:-mara-os}"
PORT="${MARA_PORT:-9001}"

if [[ ! -f .env ]]; then
  echo "Falta .env en $(pwd). Créalo antes de arrancar." >&2
  exit 1
fi

if [[ "${1:-}" == "--build" ]] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Construyendo imagen $IMAGE..."
  docker build -t "$IMAGE" .
fi

if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "Eliminando contenedor previo $CONTAINER..."
  docker rm -f "$CONTAINER" >/dev/null
fi

mkdir -p data

echo "Arrancando $CONTAINER..."
docker run -d --name "$CONTAINER" \
  --restart unless-stopped \
  --env-file .env \
  -v "$PWD/config:/app/config" \
  -v "$PWD/data:/app/data" \
  -p "$PORT:9001" \
  "$IMAGE" >/dev/null

echo "Mara OS arrancada. Logs: docker logs -f $CONTAINER"
