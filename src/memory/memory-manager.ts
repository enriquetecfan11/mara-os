import { join } from "node:path"
import { existsSync, mkdirSync } from "node:fs"
import {
  MemoryStore,
  MemoryEntry,
  MemoryType,
  NewMemoryEntry,
  SearchOptions,
  SearchResult,
  ConversationStore,
} from "./types.js"
import { createSqliteMemoryStore } from "./stores/sqlite.js"
import { createHindsightMemoryStore } from "./stores/hindsight.js"
import { createResilientMemoryStore, ResilientMemoryStore } from "./stores/resilient.js"
import { MemorySyncQueue } from "./sync-queue.js"
import { createConversationStore } from "./conversation-store.js"
import { info, debug, error as logError, warn } from "../logger.js"
import {
  agentDir,
  hindsightEnabled,
  hindsightApiUrl,
  hindsightBankId,
  hindsightApiKey,
  hindsightTenant,
  hindsightTimeoutMs,
  hindsightRetainTimeoutMs,
  hindsightHealthTimeoutMs,
  hindsightSyncBatchSize,
  hindsightSyncIntervalMs,
} from "../config.js"

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

// Punto de extensión del backend de memoria. Por defecto se usa SQLite sobre
// data/mara.db. Para enchufar otro almacén (servicio propio, MCP, API…), llama a
// registerMemoryStoreFactory con una fábrica que cumpla la interfaz MemoryStore
// de ./types.ts, ANTES de que se cree el MemoryManager por primera vez.
let storeFactory: (() => MemoryStore) | null = null

export function registerMemoryStoreFactory(factory: () => MemoryStore): void {
  storeFactory = factory
}

export class MemoryManager {
  private store: MemoryStore
  private conversationStore: ConversationStore
  private initialized = false
  private backend: "sqlite" | "hindsight" | "custom"

  constructor() {
    const dbPath = getDbPath()
    if (storeFactory) {
      this.store = storeFactory()
      this.backend = "custom"
    } else if (hindsightEnabled) {
      // Hindsight primario + SQLite como espejo local y respaldo. Compartimos
      // el mismo fichero (data/mara.db) para historial y memoria.
      this.store = createResilientMemoryStore({
        hindsight: createHindsightMemoryStore({
          apiUrl: hindsightApiUrl,
          bankId: hindsightBankId,
          apiKey: hindsightApiKey,
          tenant: hindsightTenant,
          timeoutMs: hindsightTimeoutMs,
          retainTimeoutMs: hindsightRetainTimeoutMs,
          healthTimeoutMs: hindsightHealthTimeoutMs,
        }),
        sqlite: createSqliteMemoryStore(dbPath),
        queue: new MemorySyncQueue(dbPath),
        syncBatchSize: hindsightSyncBatchSize,
        syncIntervalMs: hindsightSyncIntervalMs,
      })
      this.backend = "hindsight"
    } else {
      this.store = createSqliteMemoryStore(dbPath)
      this.backend = "sqlite"
    }
    this.conversationStore = createConversationStore(dbPath)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await this.store.initialize()
    this.initialized = true
    info("MemoryManager", `Initialized with ${this.getBackendType()} backend`)
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

  /**
   * Guarda varios recuerdos de una vez. En Hindsight se traducen a un único
   * `retain` con varios items, no a una petición por recuerdo. Si el backend no
   * soporta lotes, se cae a llamadas individuales.
   */
  async rememberMany(entries: NewMemoryEntry[]): Promise<MemoryEntry[]> {
    await this.ensureInitialized()
    if (entries.length === 0) return []
    if (this.store.rememberMany) {
      return this.store.rememberMany(entries)
    }
    const saved: MemoryEntry[] = []
    for (const entry of entries) {
      saved.push(await this.store.remember(entry))
    }
    return saved
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

  getBackendType(): "sqlite" | "hindsight" | "custom" {
    return this.backend
  }

  /** True solo si el backend es Hindsight y ahora mismo responde. */
  isHindsightAvailable(): boolean {
    return this.store instanceof ResilientMemoryStore && this.store.isHindsightAvailable()
  }

  /** Cambios locales pendientes de enviar a Hindsight (outbox). */
  getPendingSyncCount(): number {
    return this.store instanceof ResilientMemoryStore ? this.store.pendingChanges() : 0
  }

  /** Fuerza una pasada de sincronización con Hindsight. */
  async syncMemory(): Promise<void> {
    if (this.store instanceof ResilientMemoryStore) {
      await this.store.syncPending()
    }
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