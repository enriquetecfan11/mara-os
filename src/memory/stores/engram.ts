import { callMcpTool } from "../../mcp.js"
import { MemoryStore, MemoryEntry, MemoryType, SearchOptions, SearchResult } from "../types.js"
import { info, debug, error as logError, warn } from "../../logger.js"

const TYPE_MAPPING: Record<string, MemoryType> = {
  preference: "preference",
  personal_fact: "personal_fact",
  fact: "personal_fact",
  project: "project",
  decision: "decision",
  person: "person",
  place: "place",
  routine: "routine",
  important_event: "important_event",
  event: "important_event",
  skill_knowledge: "skill_knowledge",
  other: "other",
}

function mapEngramType(type: string): MemoryType {
  return TYPE_MAPPING[type] || "other"
}

function mapToEngramType(type: MemoryType): string {
  const reverse: Record<MemoryType, string> = {
    preference: "preference",
    personal_fact: "personal_fact",
    project: "project",
    decision: "decision",
    person: "person",
    place: "place",
    routine: "routine",
    important_event: "important_event",
    skill_knowledge: "skill_knowledge",
    other: "other",
  }
  return reverse[type]
}

export class EngramMemoryStore implements MemoryStore {
  private initialized = false

  async initialize(): Promise<void> {
    this.initialized = true
    info("MemoryStore", "Engram memory store initialized")
  }

  async remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "lastAccessed" | "accessCount">): Promise<MemoryEntry> {
    try {
      const result = await callMcpTool("remember", {
        content: entry.content,
        type: mapToEngramType(entry.type),
        importance: entry.importance,
        metadata: entry.metadata,
      })

      const parsed = JSON.parse(result)
      debug("MemoryStore", `Engram remember: ${parsed.id}`)

      return {
        id: parsed.id,
        content: entry.content,
        type: entry.type,
        importance: entry.importance,
        createdAt: parsed.created_at || Date.now(),
        updatedAt: parsed.updated_at || Date.now(),
        lastAccessed: parsed.last_accessed || Date.now(),
        accessCount: parsed.access_count || 0,
        source: entry.source,
        metadata: entry.metadata,
      }
    } catch (err) {
      logError("MemoryStore", `Engram remember failed: ${err}`)
      throw err
    }
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    try {
      const result = await callMcpTool("recall", {
        query: options.query,
        limit: options.limit || 5,
        types: options.types?.map(mapToEngramType),
        min_importance: options.minImportance,
      })

      const parsed = JSON.parse(result)
      const entries: MemoryEntry[] = (parsed.memories || []).map((m: any) => ({
        id: m.id,
        content: m.content,
        type: mapEngramType(m.type),
        importance: m.importance,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        lastAccessed: m.last_accessed,
        accessCount: m.access_count,
        source: m.source || "conversation",
        metadata: m.metadata,
      }))

      debug("MemoryStore", `Engram search "${options.query}" returned ${entries.length} results`)
      return { entries, query: options.query }
    } catch (err) {
      logError("MemoryStore", `Engram search failed: ${err}`)
      throw err
    }
  }

  async forget(id: string): Promise<boolean> {
    try {
      const result = await callMcpTool("forget", { id })
      const parsed = JSON.parse(result)
      debug("MemoryStore", `Engram forget: ${id} (success: ${parsed.success})`)
      return parsed.success === true
    } catch (err) {
      logError("MemoryStore", `Engram forget failed: ${err}`)
      throw err
    }
  }

  async list(limit = 50, offset = 0): Promise<MemoryEntry[]> {
    try {
      const result = await callMcpTool("list_memories", { limit, offset })
      const parsed = JSON.parse(result)
      return (parsed.memories || []).map((m: any) => ({
        id: m.id,
        content: m.content,
        type: mapEngramType(m.type),
        importance: m.importance,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        lastAccessed: m.last_accessed,
        accessCount: m.access_count,
        source: m.source || "conversation",
        metadata: m.metadata,
      }))
    } catch (err) {
      logError("MemoryStore", `Engram list failed: ${err}`)
      throw err
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    try {
      const result = await callMcpTool("get_memory", { id })
      const parsed = JSON.parse(result)
      if (!parsed.memory) return null

      const m = parsed.memory
      return {
        id: m.id,
        content: m.content,
        type: mapEngramType(m.type),
        importance: m.importance,
        createdAt: m.created_at,
        updatedAt: m.updated_at,
        lastAccessed: m.last_accessed,
        accessCount: m.access_count,
        source: m.source || "conversation",
        metadata: m.metadata,
      }
    } catch (err) {
      logError("MemoryStore", `Engram get failed: ${err}`)
      throw err
    }
  }

  async updateAccess(id: string): Promise<void> {
    try {
      await callMcpTool("update_memory_access", { id })
      debug("MemoryStore", `Engram updateAccess: ${id}`)
    } catch (err) {
      warn("MemoryStore", `Engram updateAccess failed (non-critical): ${err}`)
    }
  }

  async close(): Promise<void> {
    this.initialized = false
    debug("MemoryStore", "Engram memory store closed")
  }
}

export function createEngramMemoryStore(): MemoryStore {
  return new EngramMemoryStore()
}