import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { agentDir, memoryPath, hindsightEnabled } from "../config.js"
import { getMemoryManager } from "./index.js"
import { info, warn, debug } from "../logger.js"

const MIGRATION_MARKER = join(agentDir, ".memory_migrated")

async function isMigrationNeeded(): Promise<boolean> {
  try {
    await readFile(MIGRATION_MARKER, "utf8")
    return false
  } catch {
    return true
  }
}

async function markMigrationDone(): Promise<void> {
  await import("node:fs/promises").then((fs) => fs.writeFile(MIGRATION_MARKER, Date.now().toString()))
}

function parseMemoryMd(content: string): Array<{ content: string; type: string }> {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))

  const memories: Array<{ content: string; type: string }> = []

  for (const line of lines) {
    if (line.startsWith("- ") || line.startsWith("* ")) {
      const content = line.slice(2).trim()
      if (content.length > 0) {
        memories.push({ content, type: "other" })
      }
    } else if (line.length > 0) {
      memories.push({ content: line, type: "other" })
    }
  }

  return memories
}

function guessType(content: string): string {
  const lower = content.toLowerCase()

  if (/(prefiero|me gusta|no me gusta|preferencia)/.test(lower)) return "preference"
  if (/(mi perro|mi gato|mascota|se llama|es mi)/.test(lower)) return "personal_fact"
  if (/(proyecto|project|estoy trabajando en)/.test(lower)) return "project"
  if (/(decidí|decisión|voy a|planeo)/.test(lower)) return "decision"
  if (/(cumpleaños|aniversario|cita|evento)/.test(lower)) return "important_event"
  if (/(rutina|suelo|costumbre|habitualmente)/.test(lower)) return "routine"
  if (/(vivo en|trabajo en|oficina|casa|lugar)/.test(lower)) return "place"
  if (/(conozco|sé|aprendí|habilidad|skill)/.test(lower)) return "skill_knowledge"

  return "other"
}

export async function runMemoryMigration(): Promise<void> {
  // Con Hindsight activo, MEMORY.md no se vuelca automáticamente: su contenido
  // podría acabar duplicado. No se marca como migrado, así que si algún día se
  // desactiva Hindsight, la migración a SQLite sigue disponible.
  if (hindsightEnabled) {
    debug("Migration", "Hindsight activo: se omite la migración de MEMORY.md (nunca automática)")
    return
  }

  if (!(await isMigrationNeeded())) {
    debug("Migration", "Memory migration already done, skipping")
    return
  }

  try {
    const content = await readFile(memoryPath, "utf8")
    const trimmed = content.trim()

    if (!trimmed || trimmed === "# MEMORY.md") {
      debug("Migration", "MEMORY.md is empty, nothing to migrate")
      await markMigrationDone()
      return
    }

    const memories = parseMemoryMd(trimmed)
    if (memories.length === 0) {
      debug("Migration", "No memories found in MEMORY.md")
      await markMigrationDone()
      return
    }

    const memoryManager = getMemoryManager()
    let migrated = 0

    for (const mem of memories) {
      const type = guessType(mem.content) as any
      try {
        await memoryManager.remember(mem.content, type, 0.5, "migration")
        migrated++
      } catch (err) {
        warn("Migration", `Failed to migrate memory: ${err}`)
      }
    }

    await markMigrationDone()
    info("Migration", `Migrated ${migrated} memories from MEMORY.md to ${memoryManager.getBackendType()} backend`)
  } catch (err) {
    warn("Migration", `Memory migration failed: ${err}`)
  }
}