// Tools nativas de memoria: el LLM las ve igual que las de MCP, pero se
// resuelven aquí contra MemoryManager (Hindsight + espejo SQLite), sin
// pasar por ningún servidor MCP.

import { getMemoryManager, type MemoryType } from "./memory/index.js"
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
]

const handlers: Record<string, (args: any) => Promise<string>> = {
  async guardar_recuerdo(args) {
    const content = String(args?.contenido ?? "").trim()
    if (!content) throw new Error("Falta 'contenido'")
    const type = MEMORY_TYPES.includes(args?.tipo) ? (args.tipo as MemoryType) : "other"
    const raw = Number(args?.importancia)
    const importance = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.8

    const manager = getMemoryManager()
    const entry = await manager.remember(content, type, importance, "manual")
    const pending = manager.getPendingSyncCount()
    debug("MemoryTools", `Recuerdo guardado ${entry.id} (pendientes: ${pending})`)
    return pending > 0
      ? `Guardado (id ${entry.id}). Hindsight lo recibirá en el próximo reintento.`
      : `Guardado en Hindsight (id ${entry.id}).`
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
}

export function isMemoryTool(name: string): boolean {
  return name in handlers
}

export function callMemoryTool(name: string, args: unknown): Promise<string> {
  return handlers[name](args)
}
