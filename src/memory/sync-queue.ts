import Database from "better-sqlite3"
import type { Database as DatabaseType } from "better-sqlite3"
import { debug, warn } from "../logger.js"

export type SyncAction = "retain" | "forget"

export interface SyncQueueItem {
  memoryId: string
  documentId: string
  action: SyncAction
  attempts: number
  nextAttemptAt: number
  lastError: string | null
  createdAt: number
  completedAt: number | null
  failedPermanentlyAt: number | null
}

interface SyncRow {
  memory_id: string
  document_id: string
  action: string
  attempts: number
  next_attempt_at: number
  last_error: string | null
  created_at: number
  completed_at: number | null
  failed_permanently_at: number | null
}

function rowToItem(row: SyncRow): SyncQueueItem {
  return {
    memoryId: row.memory_id,
    documentId: row.document_id,
    action: row.action === "forget" ? "forget" : "retain",
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    failedPermanentlyAt: row.failed_permanently_at,
  }
}

/**
 * Outbox de sincronización con Hindsight.
 *
 * Solo contiene filas creadas por las escrituras nuevas. Los recuerdos que ya
 * estaban en SQLite antes de activar Hindsight no tienen fila aquí, así que
 * nunca se migran automáticamente.
 */
export class MemorySyncQueue {
  private db: DatabaseType

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.pragma("busy_timeout = 5000")
    this.setupDatabase()
  }

  private setupDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_sync (
        memory_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'retain',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        failed_permanently_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memory_sync_due
        ON memory_sync(completed_at, failed_permanently_at, next_attempt_at);
    `)
  }

  /**
   * Encola una escritura nueva. Si el recuerdo ya estaba sincronizado no se
   * vuelve a encolar (evita reenviar lo mismo en cada deduplicación local).
   */
  enqueueRetain(memoryId: string, documentId: string): void {
    this.db.prepare(`
      INSERT INTO memory_sync
        (memory_id, document_id, action, attempts, next_attempt_at, created_at)
      VALUES (?, ?, 'retain', 0, 0, ?)
      ON CONFLICT(memory_id) DO NOTHING
    `).run(memoryId, documentId, Date.now())
  }

  /** El olvido siempre gana sobre un retain pendiente. */
  enqueueForget(memoryId: string, documentId: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO memory_sync
        (memory_id, document_id, action, attempts, next_attempt_at, created_at)
      VALUES (?, ?, 'forget', 0, 0, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        document_id = excluded.document_id,
        action = 'forget',
        attempts = 0,
        next_attempt_at = 0,
        last_error = NULL,
        completed_at = NULL,
        failed_permanently_at = NULL
    `).run(memoryId, documentId, now)
  }

  get(memoryId: string): SyncQueueItem | null {
    const row = this.db.prepare(`SELECT * FROM memory_sync WHERE memory_id = ?`).get(memoryId) as SyncRow | undefined
    return row ? rowToItem(row) : null
  }

  isPending(memoryId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM memory_sync WHERE memory_id = ? AND completed_at IS NULL
    `).get(memoryId)
    return Boolean(row)
  }

  pendingIds(limit = 500): Set<string> {
    const rows = this.db.prepare(`
      SELECT memory_id FROM memory_sync
      WHERE completed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as Array<{ memory_id: string }>
    return new Set(rows.map((row) => row.memory_id))
  }

  /**
   * IDs cuya copia remota ya está confirmada. Sirve para decidir qué filas
   * locales siguen siendo la única copia (pendientes o anteriores a Hindsight)
   * y deben seguir apareciendo en búsquedas y listados.
   */
  syncedIds(limit = 5000): Set<string> {
    const rows = this.db.prepare(`
      SELECT memory_id FROM memory_sync
      WHERE completed_at IS NOT NULL
      ORDER BY created_at ASC
      LIMIT ?
    `).all(limit) as Array<{ memory_id: string }>
    return new Set(rows.map((row) => row.memory_id))
  }

  listDue(limit: number, now = Date.now()): SyncQueueItem[] {
    const rows = this.db.prepare(`
      SELECT * FROM memory_sync
      WHERE completed_at IS NULL
        AND failed_permanently_at IS NULL
        AND next_attempt_at <= ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(now, limit) as SyncRow[]
    return rows.map(rowToItem)
  }

  countPending(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS total FROM memory_sync WHERE completed_at IS NULL
    `).get() as { total: number }
    return row.total
  }

  /** Fuerza el siguiente intento para ya (diagnóstico y pruebas). */
  retryNow(memoryId: string): void {
    this.db.prepare(`
      UPDATE memory_sync
      SET next_attempt_at = 0, failed_permanently_at = NULL
      WHERE memory_id = ?
    `).run(memoryId)
  }

  markCompleted(memoryId: string): void {
    this.db.prepare(`
      UPDATE memory_sync
      SET completed_at = ?, failed_permanently_at = NULL, last_error = NULL
      WHERE memory_id = ?
    `).run(Date.now(), memoryId)
    debug("MemorySync", `Synced: ${memoryId}`)
  }

  markFailed(memoryId: string, error: string, permanent: boolean): void {
    const attempts = (this.db.prepare(`
      SELECT attempts FROM memory_sync WHERE memory_id = ?
    `).get(memoryId) as { attempts: number } | undefined)?.attempts ?? 0
    const nextAttempts = attempts + 1
    const backoffMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.min(attempts, 5))
    const now = Date.now()

    this.db.prepare(`
      UPDATE memory_sync
      SET attempts = ?,
          last_error = ?,
          next_attempt_at = ?,
          failed_permanently_at = ?
      WHERE memory_id = ?
    `).run(
      nextAttempts,
      error.slice(0, 500),
      permanent ? now : now + backoffMs,
      permanent ? now : null,
      memoryId,
    )

    if (permanent) {
      warn("MemorySync", `Permanent sync failure for ${memoryId}: ${error.slice(0, 200)}`)
    } else {
      debug("MemorySync", `Retry scheduled for ${memoryId} in ${backoffMs}ms: ${error.slice(0, 120)}`)
    }
  }

  close(): void {
    this.db.close()
  }
}
