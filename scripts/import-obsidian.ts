/**
 * Importa un vault de Obsidian al banco de notas de Hindsight
 * (HINDSIGHT_NOTES_BANK_ID, por defecto "obsidian").
 *
 * El banco se configura en modo "chunks": Hindsight guarda el texto de cada nota
 * troceado tal cual y lo busca con embeddings + texto, SIN pasar por ningún LLM.
 * Importar el vault entero no gasta tokens y conserva el texto original.
 *
 * Cada nota es un documento con document_id "obsidian:<ruta>", así que
 * reimportar reemplaza la nota en vez de duplicarla. Las notas que no han
 * cambiado desde la última importación se saltan (data/obsidian-import.json).
 *
 * Las notas que ya no existen en el vault (borradas, movidas, o casi vacías) se
 * borran de Hindsight. Si eso afectara a más de la mitad del banco se aborta,
 * salvo con --allow-mass-delete (protege contra un vault mal montado).
 *
 * Uso:
 *   pnpm import:obsidian <vault> [--folder <carpeta>]... [--limit N] [--dry-run] [--force]
 *                       [--no-delete] [--allow-mass-delete]
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
import { isMassDeletion, listVaultNotes, noteDocumentId, notesToDelete, type VaultNote } from "../src/obsidian.js"

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
  noDelete: boolean
  allowMassDelete: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { vault: "", folders: [], dryRun: false, force: false, noDelete: false, allowMassDelete: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--folder") args.folders.push(argv[++i])
    else if (arg === "--limit") args.limit = Number(argv[++i])
    else if (arg === "--dry-run") args.dryRun = true
    else if (arg === "--force") args.force = true
    else if (arg === "--no-delete") args.noDelete = true
    else if (arg === "--allow-mass-delete") args.allowMassDelete = true
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

const bankUrl = `${hindsightApiUrl.replace(/\/+$/, "")}/v1/${encodeURIComponent(hindsightTenant)}/banks/${encodeURIComponent(hindsightNotesBankId)}`

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" }
  if (hindsightApiKey) h.Authorization = `Bearer ${hindsightApiKey}`
  return h
}

/**
 * Crea o actualiza el banco en modo "chunks" (sin LLM). Observaciones, grafo y
 * recuperación temporal dependen de hechos extraídos por el LLM, así que se
 * apagan. El reranker también: en CPU sube cada búsqueda de ~0,2 s a ~10 s, más
 * que el timeout de las tools de Mara.
 */
async function ensureChunksBank(): Promise<void> {
  const res = await fetch(bankUrl, {
    method: "PUT",
    headers: headers(),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      name: hindsightNotesBankId,
      retain_extraction_mode: "chunks",
      enable_observations: false,
      enable_text_search: true,
      enable_temporal_retrieval: false,
      enable_graph_retrieval: false,
      enable_reranking: false,
    }),
  })
  if (!res.ok) throw new Error(`No se pudo configurar el banco: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
}

/** Rutas de las notas que hay ahora en el banco (documentos "obsidian:<ruta>"). */
async function listRemoteNotes(): Promise<string[]> {
  const paths: string[] = []
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${bankUrl}/documents?limit=100&offset=${offset}`, {
      headers: headers(),
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 404) return paths // el banco aún no existe
    if (!res.ok) throw new Error(`No se pudo listar los documentos: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
    const page = (await res.json()) as { items?: Array<{ id: string }>; total?: number }
    const items = page.items ?? []
    for (const item of items) {
      if (item.id.startsWith("obsidian:")) paths.push(item.id.slice("obsidian:".length))
    }
    if (items.length < 100 || offset + items.length >= (page.total ?? 0)) return paths
  }
}

async function deleteNote(path: string): Promise<void> {
  const res = await fetch(`${bankUrl}/documents/${encodeURIComponent(noteDocumentId(path))}`, {
    method: "DELETE",
    headers: headers(),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
}

async function retain(note: VaultNote): Promise<void> {
  const url = `${bankUrl}/memories`
  const folder = note.path.includes("/") ? note.path.split("/")[0] : "raiz"

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: headers(),
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

  const remote = args.noDelete ? [] : await listRemoteNotes()
  const toDelete = args.noDelete ? [] : notesToDelete(remote, all.map((n) => n.path), args.folders)

  console.log(`Vault: ${args.vault}${args.folders.length ? ` (carpetas: ${args.folders.join(", ")})` : ""}`)
  console.log(`Hindsight: ${hindsightApiUrl} · banco "${hindsightNotesBankId}"`)
  console.log(
    `Notas: ${all.length} · sin cambios: ${all.length - all.filter((n) => state[n.path] !== n.hash).length}` +
    ` · a importar: ${pending.length} (${kb} KB) · a borrar: ${toDelete.length}\n`,
  )

  // Un vault vacío o casi vacío frente a un banco lleno casi siempre es un
  // error (ruta mal montada, rama equivocada): no se borra nada sin permiso.
  const massDeletion = isMassDeletion(toDelete.length, remote.length) && !args.allowMassDelete
  if (massDeletion) {
    console.log(
      `⚠️  Se borrarían ${toDelete.length} de ${remote.length} notas del banco. Parece un error del vault, ` +
      `así que no se borra nada. Si es intencionado, relanza con --allow-mass-delete.\n`,
    )
  }

  if (args.dryRun) {
    for (const n of pending) console.log(`  + ${n.path} (${Math.round(n.content.length / 1024)} KB)`)
    for (const path of toDelete) console.log(`  - ${path}`)
    console.log("\n--dry-run: no se ha enviado ni borrado nada.")
    if (massDeletion) process.exitCode = 1
    return
  }

  await ensureChunksBank()

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

  let deleted = 0
  if (massDeletion) {
    process.exitCode = 1
  } else {
    for (const path of toDelete) {
      process.stdout.write(`[borrar] ${path} … `)
      try {
        await deleteNote(path)
        delete state[path]
        saveState(state)
        deleted++
        console.log("ok")
      } catch (err) {
        failed.push(path)
        console.log(`ERROR: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  console.log(`\nImportadas: ${ok} · borradas: ${deleted} · fallidas: ${failed.length}`)
  if (failed.length > 0) {
    console.log("Vuelve a ejecutar el mismo comando para reintentar solo las fallidas.")
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
