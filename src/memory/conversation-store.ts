import { join } from "node:path"
import Database from "better-sqlite3"
import type { Database as DatabaseType } from "better-sqlite3"
import {
  ConversationStore,
  ConversationMessage,
  ConversationSession,
} from "./types.js"
import { info, debug, error as logError } from "../logger.js"

const DEFAULT_MAX_TOKENS = 6000
const SUMMARY_TRIGGER_RATIO = 0.8
const SUMMARY_KEEP_RATIO = 0.5

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export class SqliteConversationStore implements ConversationStore {
  private db: DatabaseType
  private maxTokens: number

  constructor(dbPath: string, maxTokens = DEFAULT_MAX_TOKENS) {
    this.maxTokens = maxTokens
    this.db = new Database(dbPath)
    this.initialize()
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        chat_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tokens INTEGER NOT NULL,
        PRIMARY KEY (chat_id, timestamp)
      );
      CREATE INDEX IF NOT EXISTS idx_conversations_chat_id ON conversations(chat_id);
      CREATE INDEX IF NOT EXISTS idx_conversations_timestamp ON conversations(timestamp);
    `)
    debug("ConversationStore", `Initialized at ${this.db.name}`)
  }

  async addMessage(chatId: number, message: ConversationMessage): Promise<void> {
    const tokens = message.tokens ?? estimateTokens(message.content)
    const stmt = this.db.prepare(`
      INSERT INTO conversations (chat_id, role, content, timestamp, tokens)
      VALUES (?, ?, ?, ?, ?)
    `)
    stmt.run(chatId, message.role, message.content, message.timestamp, tokens)

    await this.maybeSummarize(chatId)
    debug("ConversationStore", `Added ${message.role} message for chat ${chatId} (${tokens} tokens)`)
  }

  async getRecent(chatId: number, maxTokens: number): Promise<ConversationMessage[]> {
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp, tokens
      FROM conversations
      WHERE chat_id = ?
      ORDER BY timestamp DESC
    `)
    const rows = stmt.all(chatId) as Array<{
      role: "user" | "assistant" | "system" | "tool"
      content: string
      timestamp: number
      tokens: number
    }>

    const result: ConversationMessage[] = []
    let totalTokens = 0

    for (const row of rows) {
      if (totalTokens + row.tokens > maxTokens) break
      result.unshift({
        role: row.role,
        content: row.content,
        timestamp: row.timestamp,
        tokens: row.tokens,
      })
      totalTokens += row.tokens
    }

    debug("ConversationStore", `Retrieved ${result.length} messages (${totalTokens} tokens) for chat ${chatId}`)
    return result
  }

  async getAll(chatId: number): Promise<ConversationMessage[]> {
    const stmt = this.db.prepare(`
      SELECT role, content, timestamp, tokens
      FROM conversations
      WHERE chat_id = ?
      ORDER BY timestamp ASC
    `)
    const rows = stmt.all(chatId) as Array<{
      role: "user" | "assistant" | "system" | "tool"
      content: string
      timestamp: number
      tokens: number
    }>

    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      tokens: row.tokens,
    }))
  }

  async clear(chatId: number): Promise<void> {
    const stmt = this.db.prepare(`DELETE FROM conversations WHERE chat_id = ?`)
    stmt.run(chatId)
    debug("ConversationStore", `Cleared conversation for chat ${chatId}`)
  }

  async getTokenCount(chatId: number): Promise<number> {
    const stmt = this.db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) as total FROM conversations WHERE chat_id = ?
    `)
    const row = stmt.get(chatId) as { total: number } | undefined
    return row?.total ?? 0
  }

  async summarizeOldMessages(chatId: number, keepTokens: number): Promise<void> {
    const allMessages = await this.getAll(chatId)
    if (allMessages.length === 0) return

    let currentTokens = 0
    let keepIndex = allMessages.length

    for (let i = allMessages.length - 1; i >= 0; i--) {
      currentTokens += allMessages[i].tokens ?? estimateTokens(allMessages[i].content)
      if (currentTokens > keepTokens) {
        keepIndex = i + 1
        break
      }
    }

    if (keepIndex >= allMessages.length) return

    const toSummarize = allMessages.slice(0, keepIndex)
    const toKeep = allMessages.slice(keepIndex)

    const summaryContent = this.createSummary(toSummarize)
    const summaryTokens = estimateTokens(summaryContent)
    const summaryTimestamp = toSummarize[toSummarize.length - 1].timestamp

    const deleteStmt = this.db.prepare(`DELETE FROM conversations WHERE chat_id = ? AND timestamp <= ?`)
    deleteStmt.run(chatId, summaryTimestamp)

    const insertStmt = this.db.prepare(`
      INSERT INTO conversations (chat_id, role, content, timestamp, tokens)
      VALUES (?, ?, ?, ?, ?)
    `)
    insertStmt.run(chatId, "system", summaryContent, summaryTimestamp, summaryTokens)

    info("ConversationStore", `Summarized ${toSummarize.length} messages into 1 summary (${summaryTokens} tokens) for chat ${chatId}`)
  }

  private createSummary(messages: ConversationMessage[]): string {
    const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content)
    const assistantMessages = messages.filter((m) => m.role === "assistant").map((m) => m.content)

    const topics = new Set<string>()
    for (const msg of userMessages) {
      const words = msg.toLowerCase().split(/\s+/).filter((w) => w.length > 4)
      for (const word of words.slice(0, 5)) topics.add(word)
    }

    return `[Resumen de conversación anterior: ${userMessages.length} mensajes de usuario, ${assistantMessages.length} respuestas. Temas: ${Array.from(topics).slice(0, 10).join(", ")}]`
  }

  private async maybeSummarize(chatId: number): Promise<void> {
    const totalTokens = await this.getTokenCount(chatId)
    if (totalTokens > this.maxTokens * SUMMARY_TRIGGER_RATIO) {
      await this.summarizeOldMessages(chatId, this.maxTokens * SUMMARY_KEEP_RATIO)
    }
  }

  async close(): Promise<void> {
    this.db.close()
    debug("ConversationStore", "Database closed")
  }
}

export function createConversationStore(dbPath: string, maxTokens?: number): ConversationStore {
  return new SqliteConversationStore(dbPath, maxTokens)
}