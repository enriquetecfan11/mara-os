// Tools nativas de memoria: el LLM las ve igual que las de MCP, pero se
// resuelven aquí contra MemoryManager (Hindsight + espejo SQLite), sin
// pasar por ningún servidor MCP.

import { getMemoryManager, createHindsightMemoryStore, type MemoryType } from "./memory/index.js"
import type { HindsightMemoryStore } from "./memory/index.js"
import {
  hindsightEnabled,
  hindsightApiUrl,
  hindsightApiKey,
  hindsightTenant,
  hindsightTimeoutMs,
  hindsightNotesBankId,
} from "./config.js"
import { debug } from "./logger.js"

const MEMORY_TYPES: MemoryType[] = [
  "preference",
  "personal_fact",
  "project",
  "decision",
  "person",
  "place",
  "routine",
  "important_event",
  "skill_knowledge",
  "other",
]

const SEARCH_LIMIT_MAX = 10

export const memoryToolSchemas = [
  {
    type: "function",
    function: {
      name: "guardar_recuerdo",
      description:
        "Guarda un dato en la memoria a largo plazo (Hindsight). Úsala cuando Kike pida recordar algo. El contenido debe ser una frase breve y autocontenida.",
      parameters: {
        type: "object",
        properties: {
          contenido: { type: "string", description: "El dato a recordar, en una frase." },
          tipo: { type: "string", enum: MEMORY_TYPES, description: "Categoría del recuerdo." },
          importancia: { type: "number", description: "De 0 a 1. Por defecto 0.8." },
        },
        required: ["contenido"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_recuerdos",
      description:
        "Busca en la memoria a largo plazo (Hindsight) lo que se sabe sobre un tema. Úsala cuando Kike pregunte por algo que pudo contarte antes.",
      parameters: {
        type: "object",
        properties: {
          consulta: { type: "string", description: "Qué buscar, en lenguaje natural." },
          limite: { type: "number", description: `Máximo de resultados (1-${SEARCH_LIMIT_MAX}). Por defecto 5.` },
        },
        required: ["consulta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_en_notas",
      description:
        "Busca en las notas de Obsidian de Kike (su vault: IA, programación, proyectos, redes sociales, notas personales). Úsala cuando pregunte por algo que pueda estar en sus notas o apuntes.",
      parameters: {
        type: "object",
        properties: {
          consulta: { type: "string", description: "Qué buscar, en lenguaje natural." },
          limite: { type: "number", description: `Máximo de notas distintas (1-${SEARCH_LIMIT_MAX}). Por defecto 5.` },
        },
        required: ["consulta"],
      },
    },
  },
]

const NOTES_RECALL_TOKENS = 8000
const NOTE_SNIPPET_CHARS = 700

// Las notas viven en un banco aparte y solo se leen: no pasan por el
// MemoryManager (ni SQLite ni outbox), se consulta Hindsight directamente.
let notesStore: HindsightMemoryStore | undefined

function getNotesStore(): HindsightMemoryStore {
  notesStore ??= createHindsightMemoryStore({
    apiUrl: hindsightApiUrl,
    bankId: hindsightNotesBankId,
    apiKey: hindsightApiKey,
    tenant: hindsightTenant,
    timeoutMs: hindsightTimeoutMs,
  })
  return notesStore
}

/** Guarda un recuerdo manual (Hindsight + espejo SQLite) y describe el resultado. */
export async function saveMemory(content: string, type: MemoryType = "other", importance = 0.8): Promise<string> {
  const manager = getMemoryManager()
  const entry = await manager.remember(content, type, importance, "manual")
  const pending = manager.getPendingSyncCount()
  debug("MemoryTools", `Recuerdo guardado ${entry.id} (pendientes: ${pending})`)
  return pending > 0
    ? `Guardado (id ${entry.id}). Hindsight lo recibirá en el próximo reintento.`
    : `Guardado en Hindsight (id ${entry.id}).`
}

// "recuerda que…", "apunta…", "no olvides que…". No incluye "recuérdame",
// que suele ser un recordatorio (una tarea), no un dato que memorizar.
const REMEMBER_REQUEST =
  /^(?:(?:oye|mara|por favor)[,\s]+)*(?:recuerda|acuérdate de|acuerdate de|apunta|anota|memoriza|guarda en (?:la |tu )?memoria|no (?:te )?olvides(?: de)?)(?:\s+(?:que|esto|lo siguiente))?\s*[:,]?\s+(.+)$/i

/**
 * Si el mensaje es una petición explícita de recordar algo, devuelve el dato.
 * El bot lo guarda directamente, sin depender de que el modelo llame a
 * guardar_recuerdo (los modelos pequeños no lo hacen de forma fiable).
 */
export function detectRememberRequest(message: string): string | null {
  const text = message.trim()
  if (text.endsWith("?")) return null
  const match = REMEMBER_REQUEST.exec(text)
  const fact = match?.[1]?.trim().replace(/[.!]+$/, "")
  return fact && fact.length >= 3 ? fact : null
}

const handlers: Record<string, (args: any) => Promise<string>> = {
  async guardar_recuerdo(args) {
    const content = String(args?.contenido ?? "").trim()
    if (!content) throw new Error("Falta 'contenido'")
    const type = MEMORY_TYPES.includes(args?.tipo) ? (args.tipo as MemoryType) : "other"
    const raw = Number(args?.importancia)
    const importance = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.8
    return saveMemory(content, type, importance)
  },

  async buscar_recuerdos(args) {
    const query = String(args?.consulta ?? "").trim()
    if (!query) throw new Error("Falta 'consulta'")
    const raw = Number(args?.limite)
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(raw))) : 5

    const result = await getMemoryManager().search({ query, limit })
    if (result.entries.length === 0) return "No hay recuerdos sobre eso."
    return result.entries.map((e) => `- [${e.type}] ${e.content}`).join("\n")
  },

  async buscar_en_notas(args) {
    if (!hindsightEnabled) return "Las notas de Obsidian no están disponibles: Hindsight está desactivado."
    const query = String(args?.consulta ?? "").trim()
    if (!query) throw new Error("Falta 'consulta'")
    const raw = Number(args?.limite)
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(raw))) : 5

    // El banco está en modo "chunks": cada resultado es un trozo de nota de
    // varios KB. Se piden de sobra, se deja uno por nota (el más relevante) y se
    // recorta, para que el modelo vea varias notas distintas sin llenar el contexto.
    const result = await getNotesStore().search({ query, limit: 20, maxTokens: NOTES_RECALL_TOKENS })
    const byNote = new Map<string, string>()
    for (const e of result.entries) {
      const docId = String(e.metadata?.documentId ?? "")
      const note = docId.startsWith("obsidian:") ? docId.slice("obsidian:".length) : docId || e.id
      if (!byNote.has(note)) byNote.set(note, e.content)
      if (byNote.size >= limit) break
    }
    if (byNote.size === 0) return "No hay nada sobre eso en las notas de Obsidian."
    return [...byNote]
      .map(([note, text]) => {
        const snippet = text.replace(/\s+/g, " ").trim()
        const cut = snippet.length > NOTE_SNIPPET_CHARS ? `${snippet.slice(0, NOTE_SNIPPET_CHARS)}…` : snippet
        return `Nota "${note}":\n${cut}`
      })
      .join("\n\n")
  },
}

export function isMemoryTool(name: string): boolean {
  return name in handlers
}

export function callMemoryTool(name: string, args: unknown): Promise<string> {
  return handlers[name](args)
}
