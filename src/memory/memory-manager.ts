import { join } from "node:path"
import { existsSync, mkdirSync } from "node:fs"
import { MemoryStore, MemoryEntry, MemoryType, SearchOptions, SearchResult, ConversationStore } from "./types.js"
import { createSqliteMemoryStore } from "./stores/sqlite.js"
import { createEngramMemoryStore } from "./stores/engram.js"
import { createConversationStore } from "./conversation-store.js"
import { hasMemoryServer } from "../mcp.js"
import { info, debug, error as logError, warn } from "../logger.js"
import { agentDir } from "../config.js"

const DEFAULT_DB_PATH = join(agentDir, "..", "data", "mara.db")
const PROD_DB_PATH = "/var/lib/mara/memory/mara.db"

function getDbPath(): string {
  if (existsSync("/var/lib/mara/memory") || process.env.NODE_ENV === "production") {
    const dir = "/var/lib/mara/memory"
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        // fallback to local
      }
    }
    return PROD_DB_PATH
  }
  const dir = join(agentDir, "..", "data")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return DEFAULT_DB_PATH
}

export class MemoryManager {
  private store: MemoryStore
  private conversationStore: ConversationStore
  private useEngram: boolean
  private initialized = false

  constructor() {
    this.useEngram = hasMemoryServer
    this.store = this.useEngram ? createEngramMemoryStore() : createSqliteMemoryStore(getDbPath())
    this.conversationStore = createConversationStore(getDbPath())
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.store.initialize()
    this.initialized = true
    info("MemoryManager", `Initialized with ${this.useEngram ? "Engram" : "SQLite"} backend`)
  }

  async remember(
    content: string,
    type: MemoryType,
    importance: number,
    source: "conversation" | "manual" | "migration" = "conversation",
    metadata?: Record<string, unknown>
  ): Promise<MemoryEntry> {
    await this.ensureInitialized()
    return this.store.remember({ content, type, importance, source, metadata })
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    await this.ensureInitialized()
    return this.store.search(options)
  }

  async forget(id: string): Promise<boolean> {
    await this.ensureInitialized()
    return this.store.forget(id)
  }

  async list(limit?: number, offset?: number): Promise<MemoryEntry[]> {
    await this.ensureInitialized()
    return this.store.list(limit, offset)
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensureInitialized()
    return this.store.get(id)
  }

  // Conversation store delegation
  async addConversationMessage(chatId: number, message: { role: string; content: string; timestamp: number }): Promise<void> {
    await this.ensureInitialized()
    return this.conversationStore.addMessage(chatId, {
      role: message.role as any,
      content: message.content,
      timestamp: message.timestamp,
    })
  }

  async getRecentConversation(chatId: number, maxTokens: number) {
    await this.ensureInitialized()
    return this.conversationStore.getRecent(chatId, maxTokens)
  }

  async clearConversation(chatId: number): Promise<void> {
    await this.ensureInitialized()
    return this.conversationStore.clear(chatId)
  }

  async getConversationTokenCount(chatId: number): Promise<number> {
    await this.ensureInitialized()
    return this.conversationStore.getTokenCount(chatId)
  }

  getBackendType(): "engram" | "sqlite" {
    return this.useEngram ? "engram" : "sqlite"
  }

  isUsingEngram(): boolean {
    return this.useEngram
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize()
    }
  }

  async close(): Promise<void> {
    await this.store.close()
    await this.conversationStore.close()
    this.initialized = false
  }
}

let memoryManagerInstance: MemoryManager | null = null

export function getMemoryManager(): MemoryManager {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MemoryManager()
  }
  return memoryManagerInstance
}

export async function initializeMemory(): Promise<MemoryManager> {
  const manager = getMemoryManager()
  await manager.initialize()
  return manager
}