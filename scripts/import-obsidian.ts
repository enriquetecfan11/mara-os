/**
 * Importa un vault de Obsidian al banco de notas de Hindsight
 * (HINDSIGHT_NOTES_BANK_ID, por defecto "obsidian").
 *
 * Cada nota es un documento con document_id "obsidian:<ruta>", así que
 * reimportar reemplaza la nota en vez de duplicarla. Las notas que no han
 * cambiado desde la última importación se saltan (data/obsidian-import.json).
 *
 * Uso:
 *   pnpm import:obsidian <vault> [--folder <carpeta>]... [--limit N] [--dry-run] [--force]
 *
 * Ejemplos:
 *   pnpm import:obsidian ~/Documents/obisidian-vault --folder MaraOs --dry-run
 *   pnpm import:obsidian ~/Documents/obisidian-vault --folder MaraOs
 *   pnpm import:obsidian ~/Documents/obisidian-vault
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { agentDir, hindsightApiUrl, hindsightApiKey, hindsightTenant, hindsightNotesBankId } from "../src/config.js"
import { listVaultNotes, noteDocumentId, type VaultNote } from "../src/obsidian.js"

const statePath = process.env.OBSIDIAN_IMPORT_STATE_FILE || join(agentDir, "..", "data", "obsidian-import.json")
// La extracción de hechos de una nota larga puede tardar minutos con un LLM local.
const RETAIN_TIMEOUT_MS = Number(process.env.OBSIDIAN_RETAIN_TIMEOUT_MS) || 600_000
const MAX_RETRIES = 3

interface Args {
  vault: string
  folders: string[]
  limit?: number
  dryRun: boolean
  force: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { vault: "", folders: [], dryRun: false, force: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--folder") args.folders.push(argv[++i])
    else if (arg === "--limit") args.limit = Number(argv[++i])
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--force") args.force = true
    else if (!args.vault) args.vault = arg
    else throw new Error(`Argumento desconocido: ${arg}`)
  }
  if (!args.vault) throw new Error("Falta la ruta del vault")
  args.vault = resolve(args.vault.replace(/^~(?=$|\/)/, homedir()))
  return args
}

function loadState(): Record<string, string> {
  try {
    return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {}
  } catch {
    return {}
  }
}

function saveState(state: Record<string, string>): void {
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

async function retain(note: VaultNote): Promise<void> {
  const url = `${hindsightApiUrl.replace(/\/+$/, "")}/v1/${encodeURIComponent(hindsightTenant)}/banks/${encodeURIComponent(hindsightNotesBankId)}/memories`
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" }
  if (hindsightApiKey) headers.Authorization = `Bearer ${hindsightApiKey}`
  const folder = note.path.includes("/") ? note.path.split("/")[0] : "raiz"

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(RETAIN_TIMEOUT_MS),
      body: JSON.stringify({
        async: false,
        items: [{
          content: note.content,
          context: `Nota de Obsidian de Kike: ${note.path}`,
          document_id: noteDocumentId(note.path),
          timestamp: note.modifiedAt.toISOString(),
          tags: ["obsidian", `carpeta:${folder}`],
          metadata: { path: note.path },
        }],
      }),
    })
    if (res.ok) return
    const body = (await res.text()).slice(0, 300)
    // 429 (límite del proveedor) y 5xx pueden ser transitorios; el resto no.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const wait = 20_000 * attempt
      console.log(`   ↻ HTTP ${res.status}, reintento en ${wait / 1000}s: ${body}`)
      await new Promise((r) => setTimeout(r, wait))
      continue
    }
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const all = listVaultNotes(args.vault, args.folders)
  const state = args.force ? {} : loadState()
  const pending = all.filter((n) => state[n.path] !== n.hash).slice(0, args.limit)
  const kb = Math.round(pending.reduce((sum, n) => sum + n.content.length, 0) / 1024)

  console.log(`Vault: ${args.vault}${args.folders.length ? ` (carpetas: ${args.folders.join(", ")})` : ""}`)
  console.log(`Hindsight: ${hindsightApiUrl} · banco "${hindsightNotesBankId}"`)
  console.log(`Notas: ${all.length} · sin cambios: ${all.length - all.filter((n) => state[n.path] !== n.hash).length} · a importar: ${pending.length} (${kb} KB)\n`)

  if (args.dryRun) {
    for (const n of pending) console.log(`  ${n.path} (${Math.round(n.content.length / 1024)} KB)`)
    console.log("\n--dry-run: no se ha enviado nada.")
    return
  }

  let ok = 0
  const failed: string[] = []
  for (const [i, note] of pending.entries()) {
    const t0 = Date.now()
    process.stdout.write(`[${i + 1}/${pending.length}] ${note.path} … `)
    try {
      await retain(note)
      state[note.path] = note.hash
      saveState(state)
      ok++
      console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    } catch (err) {
      failed.push(note.path)
      console.log(`ERROR: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`\nImportadas: ${ok} · fallidas: ${failed.length}`)
  if (failed.length > 0) {
    console.log("Vuelve a ejecutar el mismo comando para reintentar solo las fallidas.")
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
