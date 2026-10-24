#!/usr/bin/env bash
# Importa el vault de Obsidian al banco de notas de Hindsight (modo chunks, sin LLM).
# Solo envía las notas nuevas o modificadas desde la última vez.
#
# Uso:
#   scripts/import_vault.sh                      # vault por defecto, todo
#   scripts/import_vault.sh --dry-run            # muestra qué enviaría, sin enviar
#   scripts/import_vault.sh --folder MaraOs      # solo una carpeta
#   scripts/import_vault.sh --force              # reenvía todas las notas
#   OBSIDIAN_VAULT=/otra/ruta scripts/import_vault.sh
#
# Variables opcionales: OBSIDIAN_VAULT (~/Documents/obisidian-vault)
set -euo pipefail

cd "$(dirname "$0")/.."

VAULT="${OBSIDIAN_VAULT:-$HOME/Documents/obisidian-vault}"

if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "No encuentro un vault de Obsidian en $VAULT (falta .obsidian)." >&2
  echo "Indica la ruta con OBSIDIAN_VAULT=/ruta/al/vault $0" >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "Falta .env en $(pwd): hace falta HINDSIGHT_API_URL." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "No encuentro pnpm. Instálalo o ejecuta: node --env-file=.env --import tsx scripts/import-obsidian.ts \"$VAULT\" $*" >&2
  exit 1
fi

[[ -d node_modules ]] || pnpm install

exec pnpm -s import:obsidian "$VAULT" "$@"
