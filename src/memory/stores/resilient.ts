import { MemoryStore, MemoryEntry, NewMemoryEntry, SearchOptions, SearchResult } from "../types.js"
import { HindsightMemoryStore } from "./hindsight.js"
import { SqliteMemoryStore } from "./sqlite.js"
import { MemorySyncQueue } from "../sync-queue.js"
import { debug, error as logError, info, warn } from "../../logger.js"

/** Cada cuánto se intenta vaciar la outbox si nadie llama a remember/search. */
const SYNC_TICK_MS = 60_000

export interface ResilientStoreOptions {
  hindsight: HindsightMemoryStore
  sqlite: SqliteMemoryStore
  queue: MemorySyncQueue
  syncBatchSize?: number
  syncIntervalMs?: number
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ")
}

/**
 * Backend compuesto: Hindsight como fuente principal y SQLite como espejo
 * local + respaldo.
 *
 * Reglas de escritura:
 *  1. Se guarda en SQLite primero, para tener un id local estable y una copia.
 *  2. Solo las memorias NUEVAS entran en la outbox. Las filas que ya existían
 *     antes de activar Hindsight nunca se envían solas.
 *  3. Se intenta `retain` con `document_id = mara-<id local>`, así un reintento
 *     reemplaza el mismo documento en vez de duplicarlo.
 *  4. Si Hindsight falla, la outbox reintenta con backoff.
 *
 * Reglas de lectura:
 *  - Con Hindsight disponible, `recall` manda. Solo se añaden las memorias
 *    locales que aún están pendientes de sincronizar (no duplicamos las ya
 *    sincronizadas).
 *  - Sin Hindsight, todo se resuelve contra SQLite sin perder nada.
 */
export class ResilientMemoryStore implements MemoryStore {
  private readonly hindsight: HindsightMemoryStore
  private readonly sqlite: SqliteMemoryStore
  private readonly queue: MemorySyncQueue
  private readonly syncBatchSize: number
  private readonly syncIntervalMs: number
  private syncTimer?: ReturnType<typeof setInterval>
  private syncing = false

  constructor(options: ResilientStoreOptions) {
    this.hindsight = options.hindsight
    this.sqlite = options.sqlite
    this.queue = options.queue
    this.syncBatchSize = options.syncBatchSize ?? 10
    this.syncIntervalMs = options.syncIntervalMs ?? SYNC_TICK_MS
  }

  async initialize(): Promise<void> {
    await this.sqlite.initialize()
    await this.hindsight.initialize()

    if (this.hindsight.isAvailable()) {
      info("MemoryManager", `Memoria: Hindsight (${this.queue.countPending()} cambios pendientes de sincronizar)`)
      void this.syncPending()
    } else {
      warn("MemoryManager", "Hindsight no disponible: memoria en SQLite hasta que se recupere")
    }

    if (this.syncIntervalMs > 0) {
      this.syncTimer = setInterval(() => {
        void this.syncPending()
      }, this.syncIntervalMs)
      // No mantiene el proceso vivo por sí solo.
      this.syncTimer.unref?.()
    }
  }

  isHindsightAvailable(): boolean {
    return this.hindsight.isAvailable()
  }

  pendingChanges(): number {
    return this.queue.countPending()
  }

  async remember(entry: NewMemoryEntry): Promise<MemoryEntry> {
    const { entry: local, created } = await this.sqlite.rememberDetailed(entry)

    if (!created) {
      debug("MemoryManager", `Memoria duplicada; no se reenvía a Hindsight (${local.id})`)
      return local
    }

    const documentId = this.documentIdFor(local.id)
    this.queue.enqueueRetain(local.id, documentId)

    if (this.hindsight.isAvailable()) {
      try {
        await this.hindsight.rememberWithDocument(entry, documentId, local.createdAt)
        this.queue.markCompleted(local.id)
      } catch (err) {
        this.recordFailure(local.id, err, "retain")
      }
    }

    return local
  }

  async rememberMany(entries: NewMemoryEntry[]): Promise<MemoryEntry[]> {
    if (entries.length === 0) return []

    const created: Array<{ entry: NewMemoryEntry; local: MemoryEntry; documentId: string }> = []
    const results: MemoryEntry[] = []

    for (const entry of entries) {
      const { entry: local, created: isNew } = await this.sqlite.rememberDetailed(entry)
      results.push(local)
      if (!isNew) continue
      const documentId = this.documentIdFor(local.id)
      this.queue.enqueueRetain(local.id, documentId)
      created.push({ entry, local, documentId })
    }

    if (created.length > 0 && this.hindsight.isAvailable()) {
      try {
        await this.hindsight.rememberManyWithDocuments(
          created.map(({ entry, local, documentId }) => ({
            entry,
            documentId,
            createdAt: local.createdAt,
          })),
        )
        for (const item of created) this.queue.markCompleted(item.local.id)
      } catch (err) {
        for (const item of created) this.recordFailure(item.local.id, err, "retain")
      }
    }

    return results
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    const local = await this.sqlite.search(options)

    if (!this.hindsight.isAvailable()) {
      return local
    }

    try {
      const remote = await this.hindsight.search(options)
      const synced = this.queue.syncedIds()
      // Todo lo que no está confirmado en Hindsight sigue siendo la única copia:
      // memorias pendientes y filas anteriores a activar Hindsight.
      const localOnly = local.entries.filter((entry) => !synced.has(entry.id))

      const seen = new Set(remote.entries.map((entry) => normalizeContent(entry.content)))
      const extras = localOnly.filter((entry) => !seen.has(normalizeContent(entry.content)))
      if (extras.length > 0) {
        debug("MemoryManager", `Recall + ${extras.length} memorias locales sin sincronizar`)
      }

      const limit = options.limit ?? 5
      return {
        entries: [...remote.entries, ...extras].slice(0, limit),
        query: options.query,
      }
    } catch (err) {
      warn("MemoryManager", `Recall falló (${this.describe(err)}); usando SQLite como respaldo`)
      return local
    }
  }

  async forget(id: string): Promise<boolean> {
    const local = await this.sqlite.get(id)

    if (local) {
      await this.sqlite.softForget(local.id)
      const documentId = this.documentIdFor(local.id)
      this.queue.enqueueForget(local.id, documentId)

      if (this.hindsight.isAvailable()) {
        try {
          await this.hindsight.invalidateDocument(documentId)
          this.queue.markCompleted(local.id)
        } catch (err) {
          this.recordFailure(local.id, err, "forget")
        }
      }
      return true
    }

    // Id remoto (por ejemplo el devuelto por un recall): se invalida el hecho.
    if (!this.hindsight.isAvailable()) {
      warn("MemoryManager", `No se puede olvidar ${id}: Hindsight no disponible y no existe en local`)
      return false
    }

    try {
      return await this.hindsight.forget(id)
    } catch (err) {
      warn("MemoryManager", `No se pudo invalidar ${id} en Hindsight: ${this.describe(err)}`)
      return false
    }
  }

  async list(limit = 50, offset = 0): Promise<MemoryEntry[]> {
    const local = await this.sqlite.list(limit + offset, 0)

    if (!this.hindsight.isAvailable()) {
      return local.slice(offset, offset + limit)
    }

    try {
      const remote = await this.hindsight.list(limit, offset)
      const synced = this.queue.syncedIds()
      const seen = new Set(remote.map((entry) => normalizeContent(entry.content)))
      const extras = local.filter(
        (entry) => !synced.has(entry.id) && !seen.has(normalizeContent(entry.content)),
      )
      return [...remote, ...extras].slice(0, limit)
    } catch (err) {
      warn("MemoryManager", `Listado remoto falló (${this.describe(err)}); usando SQLite`)
      return local.slice(offset, offset + limit)
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const local = await this.sqlite.get(id)
    if (local) return local

    if (!this.hindsight.isAvailable()) return null

    try {
      return await this.hindsight.get(id)
    } catch (err) {
      debug("MemoryManager", `Get ${id} falló: ${this.describe(err)}`)
      return null
    }
  }

  async updateAccess(id: string): Promise<void> {
    try {
      await this.sqlite.updateAccess(id)
    } catch (err) {
      debug("MemoryManager", `updateAccess ${id} falló: ${this.describe(err)}`)
    }
  }

  /**
   * Vacía la outbox: reintenta retains/forgets pendientes. Es idempotente y
   * seguro de llamar en paralelo (solo una pasada a la vez).
   */
  async syncPending(): Promise<void> {
    if (this.syncing || !this.hindsight.isAvailable()) return
    this.syncing = true

    try {
      const due = this.queue.listDue(this.syncBatchSize)
      if (due.length === 0) return

      debug("MemorySync", `Sincronizando ${due.length} cambios con Hindsight`)
      for (const item of due) {
        if (item.action === "forget") {
          await this.runForget(item.memoryId, item.documentId)
        } else {
          await this.runRetain(item.memoryId, item.documentId)
        }
      }
    } catch (err) {
      logError("MemorySync", `Error inesperado sincronizando: ${this.describe(err)}`)
    } finally {
      this.syncing = false
    }
  }

  async close(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = undefined
    await this.hindsight.close()
    await this.sqlite.close()
    this.queue.close()
  }

  private async runRetain(memoryId: string, documentId: string): Promise<void> {
    const local = await this.sqlite.get(memoryId)
    if (!local) {
      // La memoria ya no existe en local (olvidada): no hay nada que enviar.
      this.queue.markCompleted(memoryId)
      return
    }

    try {
      await this.hindsight.rememberWithDocument(
        {
          content: local.content,
          type: local.type,
          importance: local.importance,
          source: local.source,
          metadata: local.metadata,
        },
        documentId,
        local.createdAt,
      )
      this.queue.markCompleted(memoryId)
    } catch (err) {
      this.recordFailure(memoryId, err, "retain")
    }
  }

  private async runForget(memoryId: string, documentId: string): Promise<void> {
    try {
      await this.hindsight.invalidateDocument(documentId)
      this.queue.markCompleted(memoryId)
    } catch (err) {
      this.recordFailure(memoryId, err, "forget")
    }
  }

  private recordFailure(memoryId: string, err: unknown, action: "retain" | "forget"): void {
    const permanent = Boolean((err as { permanent?: boolean } | null)?.permanent)
    const message = this.describe(err)
    this.queue.markFailed(memoryId, message, permanent)
    if (permanent) {
      warn("MemorySync", `${action} definitivo fallido para ${memoryId}: ${message}`)
    } else {
      debug("MemorySync", `${action} fallido para ${memoryId}; se reintentará: ${message}`)
    }
  }

  private documentIdFor(localId: string): string {
    return `mara-${localId}`
  }

  private describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }
}

export function createResilientMemoryStore(options: ResilientStoreOptions): ResilientMemoryStore {
  return new ResilientMemoryStore(options)
}
