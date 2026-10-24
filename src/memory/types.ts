export interface ConversationMessage {
  role: "user" | "assistant" | "system" | "tool"
  content: string
  timestamp: number
  tokens?: number
}

export interface ConversationSession {
  chatId: number
  messages: ConversationMessage[]
  totalTokens: number
  updatedAt: number
}

export interface MemoryEntry {
  id: string
  content: string
  type: MemoryType
  importance: number
  createdAt: number
  updatedAt: number
  lastAccessed: number
  accessCount: number
  source: "conversation" | "manual" | "migration"
  metadata?: Record<string, unknown>
}

export type MemoryType =
  | "preference"
  | "personal_fact"
  | "project"
  | "decision"
  | "person"
  | "place"
  | "routine"
  | "important_event"
  | "skill_knowledge"
  | "other"

export interface ExtractedMemory {
  content: string
  type: MemoryType
  importance: number
}

export interface ExtractionResult {
  memories: ExtractedMemory[]
}

export interface SearchOptions {
  query: string
  limit?: number
  types?: MemoryType[]
  minImportance?: number
  /**
   * Presupuesto de tokens para el backend remoto (Hindsight). SQLite lo ignora.
   * Permite no traer más contexto del que luego se va a inyectar en el prompt.
   */
  maxTokens?: number
}

/** Entrada que aceptan los almacenes antes de asignar id y fechas. */
export type NewMemoryEntry = Omit<
  MemoryEntry,
  "id" | "createdAt" | "updatedAt" | "lastAccessed" | "accessCount"
>

export interface SearchResult {
  entries: MemoryEntry[]
  query: string
}

export interface MemoryStore {
  initialize(): Promise<void>
  close(): Promise<void>
  remember(entry: NewMemoryEntry): Promise<MemoryEntry>
  /**
   * Opcional: los backends remotos pueden guardar varios recuerdos en una sola
   * petición. Si no existe, MemoryManager los guarda uno a uno.
   */
  rememberMany?(entries: NewMemoryEntry[]): Promise<MemoryEntry[]>
  search(options: SearchOptions): Promise<SearchResult>
  forget(id: string): Promise<boolean>
  list(limit?: number, offset?: number): Promise<MemoryEntry[]>
  get(id: string): Promise<MemoryEntry | null>
  updateAccess(id: string): Promise<void>
}

export interface ConversationStore {
  addMessage(chatId: number, message: ConversationMessage): Promise<void>
  getRecent(chatId: number, maxTokens: number): Promise<ConversationMessage[]>
  getAll(chatId: number): Promise<ConversationMessage[]>
  clear(chatId: number): Promise<void>
  getTokenCount(chatId: number): Promise<number>
  summarizeOldMessages(chatId: number, keepTokens: number): Promise<void>
  close(): Promise<void>
}

