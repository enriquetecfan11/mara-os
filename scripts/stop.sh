#!/usr/bin/env bash
# Para y elimina el contenedor de Mara OS. Los datos en data/ y config/ se conservan.
#
# Variables opcionales: MARA_CONTAINER (mara-os)
set -euo pipefail

CONTAINER="${MARA_CONTAINER:-mara-os}"

if ! docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "$CONTAINER no existe; nada que parar."
  exit 0
fi

echo "Parando $CONTAINER..."
docker stop "$CONTAINER" >/dev/null
docker rm "$CONTAINER" >/dev/null
echo "$CONTAINER parado."
