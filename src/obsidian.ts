// Lectura de un vault de Obsidian para importarlo a Hindsight (banco de notas).
// Funciones puras sobre el sistema de ficheros; el envío está en
// scripts/import-obsidian.ts.

import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, sep } from "node:path"

/** Carpetas que nunca se importan (además de las que empiezan por "."). */
const SKIPPED_DIRS = new Set(["templates", "plantillas", "node_modules"])

/** Notas con menos texto útil que esto no aportan nada a la memoria. */
const MIN_CONTENT_CHARS = 40

export interface VaultNote {
  /** Ruta relativa al vault con "/" (estable entre máquinas): identifica la nota. */
  path: string
  /** Texto que se envía a Hindsight: título + cuerpo sin frontmatter. */
  content: string
  /** Hash del contenido: permite saltarse las notas que no han cambiado. */
  hash: string
  modifiedAt: Date
}

/** Quita el bloque YAML inicial (`---` … `---`) de una nota. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw
  const end = raw.indexOf("\n---", 3)
  if (end === -1) return raw
  return raw.slice(raw.indexOf("\n", end + 4) + 1 || raw.length)
}

/** Título + cuerpo; null si la nota está prácticamente vacía. */
export function noteContent(raw: string, path: string): string | null {
  const body = stripFrontmatter(raw).trim()
  if (body.length < MIN_CONTENT_CHARS) return null
  const title = basename(path, ".md")
  return `# ${title}\n\n${body}`
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name.toLowerCase())) walk(full, out)
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full)
    }
  }
}

/**
 * Notas del vault, opcionalmente limitadas a unas carpetas (relativas al vault).
 * Ordenadas por ruta para que las importaciones sean reproducibles.
 */
export function listVaultNotes(vault: string, folders: string[] = []): VaultNote[] {
  const roots = folders.length > 0 ? folders.map((f) => join(vault, f)) : [vault]
  const files: string[] = []
  for (const root of roots) walk(root, files)

  const notes: VaultNote[] = []
  for (const file of [...new Set(files)].sort()) {
    const path = relative(vault, file).split(sep).join("/")
    const content = noteContent(readFileSync(file, "utf8"), path)
    if (!content) continue
    notes.push({
      path,
      content,
      hash: createHash("sha1").update(content).digest("hex"),
      modifiedAt: statSync(file).mtime,
    })
  }
  return notes
}

/** document_id en Hindsight: reimportar la misma nota la reemplaza, no la duplica. */
export function noteDocumentId(path: string): string {
  return `obsidian:${path}`
}
