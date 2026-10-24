#!/usr/bin/env bash
# Sincroniza el vault de Obsidian del homelab con Hindsight:
#   1. Actualiza el vault (git pull).
#   2. Sube las notas nuevas o modificadas al banco de notas (modo chunks, sin LLM).
#   3. Comprueba que Hindsight responde, que no queda nada pendiente y que la
#      búsqueda devuelve notas.
#
# La importación corre dentro de la imagen de mara-os (no hace falta Node en el
# host). El estado de lo ya importado vive en mara-os/data/obsidian-import.json.
#
# Uso:
#   ~/mara/scripts/sync_vault.sh             # sincroniza
#   ~/mara/scripts/sync_vault.sh --dry-run   # solo enseña qué subiría
#   ~/mara/scripts/sync_vault.sh --force     # reenvía todas las notas
#
# Variables opcionales: VAULT_DIR, MARA_DIR, MARA_IMAGE, NOTES_BANK
set -euo pipefail

VAULT_DIR="${VAULT_DIR:-$HOME/mara/obisidian-vault}"
MARA_DIR="${MARA_DIR:-$HOME/mara/mara-os}"
MARA_IMAGE="${MARA_IMAGE:-mara-os}"
NOTES_BANK="${NOTES_BANK:-obsidian}"
IMPORT_ARGS=("$@")

step() { printf '\n== %s\n' "$1"; }
fail() { printf '❌ %s\n' "$1" >&2; exit 1; }
ok() { printf '✅ %s\n' "$1"; }

# Evita dos sincronizaciones a la vez (p. ej. si se lanza desde cron).
exec 9>"/tmp/sync_vault.lock"
flock -n 9 || fail "Ya hay una sincronización en marcha"

[[ -d "$VAULT_DIR/.git" ]] || fail "No hay un repo git en $VAULT_DIR (clónalo ahí o usa VAULT_DIR=...)"
[[ -f "$MARA_DIR/.env" ]] || fail "Falta $MARA_DIR/.env"
docker image inspect "$MARA_IMAGE" >/dev/null 2>&1 || fail "No existe la imagen $MARA_IMAGE (cd $MARA_DIR && scripts/start.sh --build)"
docker run --rm --entrypoint test "$MARA_IMAGE" -f scripts/import-obsidian.ts \
  || fail "La imagen $MARA_IMAGE no tiene el importador: cd $MARA_DIR && git pull && scripts/start.sh --build"

HINDSIGHT_URL="$(grep -E '^HINDSIGHT_API_URL=' "$MARA_DIR/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
HINDSIGHT_URL="${HINDSIGHT_URL:-http://192.168.1.196:8888}"
BANK_URL="$HINDSIGHT_URL/v1/default/banks/$NOTES_BANK"

# ---------- 1. Actualizar el vault ----------
step "1/3 Actualizando el vault ($VAULT_DIR)"
before="$(git -C "$VAULT_DIR" rev-parse HEAD)"
git -C "$VAULT_DIR" pull --ff-only || fail "git pull falló (¿cambios locales en el vault?)"
after="$(git -C "$VAULT_DIR" rev-parse HEAD)"
if [[ "$before" == "$after" ]]; then
  ok "Sin cambios en git (se comprueba igualmente si falta algo por subir)"
else
  changed="$(git -C "$VAULT_DIR" diff --name-only "$before" "$after" -- '*.md' | wc -l)"
  ok "Actualizado ${before:0:7} → ${after:0:7} ($changed notas cambiadas)"
fi

# ---------- 2. Subir novedades ----------
step "2/3 Subiendo novedades a Hindsight (banco $NOTES_BANK)"
mkdir -p "$MARA_DIR/data"
run_importer() {
  docker run --rm \
    --env-file "$MARA_DIR/.env" \
    -e HINDSIGHT_NOTES_BANK_ID="$NOTES_BANK" \
    -v "$VAULT_DIR:/vault:ro" \
    -v "$MARA_DIR/data:/app/data" \
    "$MARA_IMAGE" node --import tsx scripts/import-obsidian.ts /vault "$@"
}
run_importer "${IMPORT_ARGS[@]}" || fail "La importación terminó con errores (relanza el script: solo reintenta las fallidas)"

for arg in "${IMPORT_ARGS[@]}"; do
  [[ "$arg" == "--dry-run" ]] && { printf '\n--dry-run: no se comprueba nada más.\n'; exit 0; }
done

# ---------- 3. Comprobar ----------
step "3/3 Comprobando"
curl -sf -m 10 "$HINDSIGHT_URL/health" | grep -q '"healthy"' \
  && ok "Hindsight responde ($HINDSIGHT_URL)" \
  || fail "Hindsight no responde en $HINDSIGHT_URL"

pending="$(run_importer --dry-run 2>/dev/null | grep -oE 'a importar: [0-9]+' | grep -oE '[0-9]+' || echo '?')"
[[ "$pending" == "0" ]] \
  && ok "No queda ninguna nota pendiente" \
  || fail "Quedan $pending notas sin subir (relanza el script)"

docs="$(curl -sf -m 10 "$BANK_URL/stats" | grep -oE '"total_documents":[0-9]+' | grep -oE '[0-9]+' || echo 0)"
notes="$(find "$VAULT_DIR" -name '*.md' -not -path '*/.*' -not -path '*/templates/*' | wc -l)"
ok "Banco $NOTES_BANK: $docs documentos (el vault tiene $notes .md; las notas casi vacías no se suben)"

hits="$(curl -sf -m 20 -X POST "$BANK_URL/memories/recall" -H 'Content-Type: application/json' \
  -d '{"query":"notas","budget":"low","max_tokens":1000}' | grep -oE '"document_id":"obsidian:[^"]*"' | head -3 || true)"
[[ -n "$hits" ]] \
  && ok "La búsqueda devuelve notas: $(echo "$hits" | sed -E 's/.*obsidian:([^"]*)"/\1/' | paste -sd ',' - | sed 's/,/, /g')" \
  || fail "La búsqueda no devuelve ninguna nota"

printf '\nTodo correcto.\n'
