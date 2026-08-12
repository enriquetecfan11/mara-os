import { join } from "node:path"
import Database from "better-sqlite3"
import type { Database as DatabaseType } from "better-sqlite3"
import { MemoryStore, MemoryEntry, MemoryType, SearchOptions, SearchResult } from "../types.js"
import { info, debug, error as logError, warn } from "../../logger.js"

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ")
}

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

export class SqliteMemoryStore implements MemoryStore {
  private db: DatabaseType
  private memoryCache = new Map<string, MemoryEntry>()
  private readonly maxCacheSize = 500

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.setupDatabase()
  }

  private setupDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT NOT NULL,
        importance REAL NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        content=memories,
        content_rowid=rowid
      );
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `)
    info("MemoryStore", `SQLite memory store initialized at ${this.db.name}`)
  }

  async initialize(): Promise<void> {
    this.setupDatabase()
    await this.rebuildFts()
  }

  private async rebuildFts(): Promise<void> {
    try {
      this.db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`)
      debug("MemoryStore", "FTS index rebuilt")
    } catch (err) {
      warn("MemoryStore", `FTS rebuild failed: ${err}`)
    }
  }

  async remember(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt" | "lastAccessed" | "accessCount">): Promise<MemoryEntry> {
    const now = Date.now()
    const id = generateId()

    const duplicate = await this.findDuplicate(entry.content, entry.type)
    if (duplicate) {
      await this.updateAccess(duplicate.id)
      const updated = await this.get(duplicate.id)
      if (updated) {
        debug("MemoryStore", `Duplicate detected, updated access for: ${duplicate.id}`)
        return updated
      }
    }

    const newEntry: MemoryEntry = {
      ...entry,
      id,
      createdAt: now,
      updatedAt: now,
      lastAccessed: now,
      accessCount: 0,
    }

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, content, type, importance, created_at, updated_at, last_accessed, access_count, source, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      newEntry.id,
      newEntry.content,
      newEntry.type,
      newEntry.importance,
      newEntry.createdAt,
      newEntry.updatedAt,
      newEntry.lastAccessed,
      newEntry.accessCount,
      newEntry.source,
      newEntry.metadata ? JSON.stringify(newEntry.metadata) : null
    )

    this.addToCache(newEntry)
    debug("MemoryStore", `Remembered: ${id} (${newEntry.type}, importance: ${newEntry.importance})`)
    return newEntry
  }

  private async findDuplicate(content: string, type: MemoryType): Promise<MemoryEntry | null> {
    const normalized = normalizeContent(content)
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      WHERE type = ? AND LOWER(REPLACE(content, ' ', '')) = ?
      ORDER BY importance DESC, created_at DESC
      LIMIT 1
    `)
    const row = stmt.get(type, normalized.replace(/\s+/g, "")) as any
    if (row) return this.rowToEntry(row)
    return null
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    const { query, limit = 5, types, minImportance = 0 } = options

    let sql = `
      SELECT m.* FROM memories m
      JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND m.importance >= ?
    `
    const params: unknown[] = [query, minImportance]

    if (types && types.length > 0) {
      sql += ` AND m.type IN (${types.map(() => "?").join(",")})`
      params.push(...types)
    }

    sql += ` ORDER BY m.importance DESC, m.last_accessed DESC LIMIT ?`
    params.push(limit)

    const stmt = this.db.prepare(sql)
    const rows = stmt.all(...params) as any[]

    const entries = rows.map((row) => this.rowToEntry(row))
    for (const entry of entries) {
      await this.updateAccess(entry.id)
    }

    debug("MemoryStore", `Search "${query}" returned ${entries.length} results`)
    return { entries, query }
  }

  async forget(id: string): Promise<boolean> {
    const stmt = this.db.prepare(`DELETE FROM memories WHERE id = ?`)
    const result = stmt.run(id)
    this.memoryCache.delete(id)
    debug("MemoryStore", `Forgot: ${id} (deleted: ${result.changes > 0})`)
    return result.changes > 0
  }

  async list(limit = 50, offset = 0): Promise<MemoryEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM memories
      ORDER BY importance DESC, created_at DESC
      LIMIT ? OFFSET ?
    `)
    const rows = stmt.all(limit, offset) as any[]
    return rows.map((row) => this.rowToEntry(row))
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const cached = this.memoryCache.get(id)
    if (cached) return cached

    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`)
    const row = stmt.get(id) as any
    if (!row) return null

    const entry = this.rowToEntry(row)
    this.addToCache(entry)
    return entry
  }

  async updateAccess(id: string): Promise<void> {
    const now = Date.now()
    const stmt = this.db.prepare(`
      UPDATE memories
      SET last_accessed = ?, access_count = access_count + 1
      WHERE id = ?
    `)
    stmt.run(now, id)

    const cached = this.memoryCache.get(id)
    if (cached) {
      cached.lastAccessed = now
      cached.accessCount += 1
    }
  }

  async close(): Promise<void> {
    this.db.close()
    this.memoryCache.clear()
    debug("MemoryStore", "Database closed")
  }

  private rowToEntry(row: any): MemoryEntry {
    return {
      id: row.id,
      content: row.content,
      type: row.type,
      importance: row.importance,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
      source: row.source,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    }
  }

  private addToCache(entry: MemoryEntry): void {
    if (this.memoryCache.size >= this.maxCacheSize) {
      const firstKey = this.memoryCache.keys().next().value
      if (firstKey) this.memoryCache.delete(firstKey)
    }
    this.memoryCache.set(entry.id, entry)
  }
}

export function createSqliteMemoryStore(dbPath: string): MemoryStore {
  return new SqliteMemoryStore(dbPath)
}