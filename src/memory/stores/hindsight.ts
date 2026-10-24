import { randomUUID } from "node:crypto"
import { MemoryStore, MemoryEntry, NewMemoryEntry, MemoryType, SearchOptions, SearchResult } from "../types.js"
import { debug, info, warn } from "../../logger.js"

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

const CIRCUIT_OPEN_MS = 30_000
const DEFAULT_CONTEXT = "Memoria a largo plazo de Mara OS (conversación con Kike)"

export interface HindsightStoreOptions {
  apiUrl: string
  bankId: string
  apiKey?: string
  tenant?: string
  timeoutMs?: number
  retainTimeoutMs?: number
  healthTimeoutMs?: number
  /** Cuánto tiempo se evita llamar tras un fallo de red/5xx. */
  circuitOpenMs?: number
}

interface HindsightRetainItem {
  content: string
  timestamp?: string
  context?: string
  metadata?: Record<string, string>
  document_id?: string
  tags?: string[]
}

interface HindsightRecallResult {
  id: string
  text: string
  type?: string | null
  entities?: string[] | null
  context?: string | null
  occurred_start?: string | null
  occurred_end?: string | null
  mentioned_at?: string | null
  document_id?: string | null
  metadata?: Record<string, string> | null
  tags?: string[] | null
  scores?: { final?: number } | null
}

interface HindsightListItem {
  id: string
  text?: string
  context?: string
  date?: string
  fact_type?: string | null
  document_id?: string | null
  mentioned_at?: string | null
  occurred_start?: string | null
  occurred_end?: string | null
  updated_at?: string | null
  entities?: string
  proof_count?: number
  tags?: string[]
  metadata?: Record<string, unknown>
  state?: string
}

interface HindsightListResponse {
  items: HindsightListItem[]
  total: number
  limit: number
  offset: number
}

export class HindsightApiError extends Error {
  readonly status?: number
  readonly permanent: boolean

  constructor(message: string, status?: number, permanent = false) {
    super(message)
    this.name = "HindsightApiError"
    this.status = status
    this.permanent = permanent
  }
}

function isPermanentStatus(status: number): boolean {
  return [400, 401, 403, 404, 409, 422].includes(status)
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ")
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function parseDate(value?: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseMemoryType(metadata: Record<string, unknown> | null | undefined, tags?: string[] | null): MemoryType {
  const fromMetadata = metadata?.mara_type
  if (typeof fromMetadata === "string" && MEMORY_TYPES.includes(fromMetadata as MemoryType)) {
    return fromMetadata as MemoryType
  }
  const fromTag = tags?.find((tag) => tag.startsWith("mara:type:"))?.slice("mara:type:".length)
  if (fromTag && MEMORY_TYPES.includes(fromTag as MemoryType)) {
    return fromTag as MemoryType
  }
  return "other"
}

function parseImportance(metadata: Record<string, unknown> | null | undefined, tags?: string[] | null): number {
  const raw = metadata?.mara_importance
  const fromMetadata = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN
  if (Number.isFinite(fromMetadata)) return clamp(fromMetadata, 0, 1)

  const fromTag = tags?.find((tag) => tag.startsWith("mara:importance:"))?.slice("mara:importance:".length)
  const parsed = fromTag ? Number(fromTag) : NaN
  return Number.isFinite(parsed) ? clamp(parsed, 0, 1) : 0.5
}

function parseSource(metadata: Record<string, unknown> | null | undefined): MemoryEntry["source"] {
  const raw = metadata?.mara_source
  return raw === "manual" || raw === "migration" ? raw : "conversation"
}

function extractErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; error?: unknown; message?: unknown }
    const detail = parsed.detail ?? parsed.error ?? parsed.message
    if (typeof detail === "string") return detail
    if (detail !== undefined) return JSON.stringify(detail)
  } catch {
    // No era JSON; devolvemos el texto tal cual.
  }
  return body
}

/**
 * Adaptador de Hindsight compatible con MemoryStore.
 *
 * Usa las operaciones oficiales:
 *  - POST /v1/{tenant}/banks/{bank}/memories          (retain)
 *  - POST /v1/{tenant}/banks/{bank}/memories/recall   (recall)
 *  - GET  /v1/{tenant}/banks/{bank}/memories/list     (consultar)
 *  - GET  /v1/{tenant}/banks/{bank}/memories/{id}     (consultar uno)
 *  - PATCH /v1/{tenant}/banks/{bank}/memories/{id}    (invalidar; no hay DELETE individual)
 *
 * No llama nunca al DELETE del banco: borraría todos los recuerdos.
 */
export class HindsightMemoryStore implements MemoryStore {
  private readonly apiUrl: string
  private readonly bankId: string
  private readonly apiKey?: string
  private readonly tenant: string
  private readonly timeoutMs: number
  private readonly retainTimeoutMs: number
  private readonly healthTimeoutMs: number
  private readonly circuitOpenMs: number
  private circuitOpenUntil = 0

  constructor(options: HindsightStoreOptions) {
    this.apiUrl = options.apiUrl.replace(/\/+$/, "")
    this.bankId = options.bankId
    this.apiKey = options.apiKey || undefined
    this.tenant = options.tenant || "default"
    this.timeoutMs = options.timeoutMs ?? 8000
    this.retainTimeoutMs = options.retainTimeoutMs ?? 25000
    this.healthTimeoutMs = options.healthTimeoutMs ?? 2500
    this.circuitOpenMs = options.circuitOpenMs ?? CIRCUIT_OPEN_MS
  }

  isAvailable(): boolean {
    return Date.now() >= this.circuitOpenUntil
  }

  async initialize(): Promise<void> {
    const healthy = await this.healthCheck()
    if (!healthy) {
      warn("Hindsight", `No disponible en ${this.apiUrl}; se usará SQLite como respaldo`)
      return
    }

    const bankOk = await this.verifyBank()
    if (!bankOk) {
      warn("Hindsight", `El banco "${this.bankId}" no está accesible; se usará SQLite como respaldo`)
      return
    }

    try {
      const version = await this.getVersion()
      info("Hindsight", `Conectado a ${this.apiUrl} (API ${version.api_version ?? "desconocida"}), banco "${this.bankId}"`)
    } catch {
      info("Hindsight", `Conectado a ${this.apiUrl}, banco "${this.bankId}"`)
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const headers: Record<string, string> = { Accept: "application/json" }
      if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`
      const res = await fetch(`${this.apiUrl}/health`, {
        headers,
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.resetCircuit()
      return true
    } catch (err) {
      this.markFailure()
      debug("Hindsight", `Health check failed: ${err}`)
      return false
    }
  }

  async verifyBank(): Promise<boolean> {
    try {
      await this.request(`/v1/${encodeURIComponent(this.tenant)}/banks/${encodeURIComponent(this.bankId)}/config`, {
        method: "GET",
      }, this.healthTimeoutMs, true)
      return true
    } catch (err) {
      debug("Hindsight", `Bank verification failed: ${err}`)
      return false
    }
  }

  async getVersion(): Promise<{ api_version?: string; features?: Record<string, unknown> }> {
    return this.request(`/version`, { method: "GET" }, this.healthTimeoutMs)
  }

  async getStats(): Promise<Record<string, unknown>> {
    return this.request(this.bankPath("/stats"), { method: "GET" }, this.timeoutMs)
  }

  async close(): Promise<void> {
    // fetch no mantiene conexiones que cerrar explícitamente.
  }

  remember(entry: NewMemoryEntry): Promise<MemoryEntry> {
    return this.rememberWithDocument(entry, `mara-${randomUUID()}`)
  }

  async rememberWithDocument(entry: NewMemoryEntry, documentId: string, createdAt?: number): Promise<MemoryEntry> {
    const items = [this.toRetainItem(entry, documentId, createdAt)]
    await this.retain(items)
    return this.toSyntheticEntry(entry, documentId, createdAt)
  }

  async rememberMany(entries: NewMemoryEntry[]): Promise<MemoryEntry[]> {
    const prepared = entries.map((entry) => ({
      entry,
      documentId: `mara-${randomUUID()}`,
    }))
    await this.rememberManyWithDocuments(prepared)
    return prepared.map(({ entry, documentId }) => this.toSyntheticEntry(entry, documentId))
  }

  async rememberManyWithDocuments(
    entries: Array<{ entry: NewMemoryEntry; documentId: string; createdAt?: number }>,
  ): Promise<MemoryEntry[]> {
    if (entries.length === 0) return []
    await this.retain(entries.map(({ entry, documentId, createdAt }) =>
      this.toRetainItem(entry, documentId, createdAt)
    ))
    return entries.map(({ entry, documentId, createdAt }) => this.toSyntheticEntry(entry, documentId, createdAt))
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    const query = options.query.trim()
    if (!query) return { entries: [], query: options.query }

    const limit = options.limit ?? 5
    const maxTokens = options.maxTokens ?? clamp(limit * 400, 1024, 4096)
    const response = await this.request<{ results: HindsightRecallResult[] }>(
      this.bankPath("/memories/recall"),
      {
        method: "POST",
        body: JSON.stringify({
          query,
          budget: "low",
          max_tokens: maxTokens,
          prefer_observations: true,
        }),
      },
      this.timeoutMs,
    )

    let entries = (response.results ?? []).map((result) => this.mapRecallResult(result))

    if (options.types && options.types.length > 0) {
      const allowed = new Set(options.types)
      entries = entries.filter((entry) => allowed.has(entry.type))
    }
    if (options.minImportance !== undefined) {
      entries = entries.filter((entry) => entry.importance >= options.minImportance!)
    }

    entries = entries.slice(0, limit)
    debug("Hindsight", `Recall "${query}" returned ${entries.length} results`)
    return { entries, query: options.query }
  }

  async forget(id: string): Promise<boolean> {
    try {
      await this.request(
        this.bankPath(`/memories/${encodeURIComponent(id)}`),
        {
          method: "PATCH",
          body: JSON.stringify({
            state: "invalidated",
            reason: "Olvidado desde Mara OS",
          }),
        },
        this.timeoutMs,
      )
      return true
    } catch (err) {
      if (err instanceof HindsightApiError && err.status === 404) return false
      throw err
    }
  }

  /**
   * Invalida todos los hechos generados a partir de un documento local.
   * Se usa para que /memory forget funcione con IDs locales de Mara OS.
   */
  async invalidateDocument(documentId: string): Promise<number> {
    let offset = 0
    let invalidated = 0
    const pageSize = 100

    while (true) {
      const params = new URLSearchParams({
        document_id: documentId,
        limit: String(pageSize),
        offset: String(offset),
      })
      const page = await this.request<HindsightListResponse>(
        this.bankPath(`/memories/list?${params.toString()}`),
        { method: "GET" },
        this.timeoutMs,
      )
      if (page.items.length === 0) break

      for (const item of page.items) {
        try {
          await this.request(
            this.bankPath(`/memories/${encodeURIComponent(item.id)}`),
            {
              method: "PATCH",
              body: JSON.stringify({ state: "invalidated", reason: "Olvidado desde Mara OS" }),
            },
            this.timeoutMs,
          )
          invalidated++
        } catch (err) {
          if (!(err instanceof HindsightApiError && err.status === 404)) throw err
        }
      }

      offset += page.items.length
      if (page.items.length < pageSize) break
    }

    return invalidated
  }

  async list(limit = 50, offset = 0): Promise<MemoryEntry[]> {
    const safeLimit = clamp(Math.trunc(limit), 1, 1000)
    const safeOffset = Math.max(0, Math.trunc(offset))
    const params = new URLSearchParams({
      limit: String(safeLimit),
      offset: String(safeOffset),
      // Los recuerdos olvidados (invalidated) no deben reaparecer en /memory list.
      state: "valid",
    })
    const response = await this.request<HindsightListResponse>(
      this.bankPath(`/memories/list?${params.toString()}`),
      { method: "GET" },
      this.timeoutMs,
    )
    return (response.items ?? []).map((item) => this.mapListItem(item))
  }

  async get(id: string): Promise<MemoryEntry | null> {
    try {
      const raw = await this.request<unknown>(
        this.bankPath(`/memories/${encodeURIComponent(id)}`),
        { method: "GET" },
        this.timeoutMs,
      )
      const mapped = this.mapSingleMemory(raw)
      if (mapped) {
        const state = (raw as { state?: string; memory?: { state?: string } }).state
          ?? (raw as { memory?: { state?: string } }).memory?.state
        if (state === "invalidated") return null
        return mapped
      }
    } catch (err) {
      if (err instanceof HindsightApiError && err.status === 404) return null
      throw err
    }

    // Algunas versiones devuelven una forma distinta en GET /memories/{id}.
    // Como último recurso, buscamos por id en el listado.
    try {
      const items = await this.list(1000, 0)
      return items.find((entry) => entry.id === id) ?? null
    } catch {
      return null
    }
  }

  async updateAccess(_id: string): Promise<void> {
    // Hindsight no expone contador de accesos. El espejo SQLite sí lo mantiene.
  }

  private async retain(items: HindsightRetainItem[]): Promise<void> {
    if (items.length === 0) return
    const response = await this.request<{ success: boolean; items_count: number }>(
      this.bankPath("/memories"),
      {
        method: "POST",
        body: JSON.stringify({ items, async: false }),
      },
      this.retainTimeoutMs,
    )
    if (!response.success) {
      throw new HindsightApiError("Hindsight rechazó el retain", 200, false)
    }
  }

  private bankPath(path: string): string {
    return `/v1/${encodeURIComponent(this.tenant)}/banks/${encodeURIComponent(this.bankId)}${path}`
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    markGlobalOn404 = false,
  ): Promise<T> {
    if (!this.isAvailable()) {
      throw new HindsightApiError("Hindsight en circuito abierto por fallo reciente", 0, false)
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
    }
    if (init.body !== undefined) headers["Content-Type"] = "application/json"
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`

    let response: Response
    try {
      response = await fetch(`${this.apiUrl}${path}`, {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      this.markFailure()
      const reason = err instanceof Error ? err.message : String(err)
      throw new HindsightApiError(`No se pudo conectar con Hindsight: ${reason}`, 0, false)
    }

    const body = await response.text()

    if (!response.ok) {
      const status = response.status
      const permanent = isPermanentStatus(status) && status !== 429
      if (status === 401 || status === 403 || status >= 500 || (markGlobalOn404 && status === 404)) {
        this.markFailure()
      }
      const detail = extractErrorDetail(body)
      throw new HindsightApiError(
        `Hindsight HTTP ${status}: ${detail.slice(0, 500)}`,
        status,
        permanent,
      )
    }

    this.resetCircuit()
    if (!body) return undefined as T

    try {
      return JSON.parse(body) as T
    } catch {
      throw new HindsightApiError("Respuesta de Hindsight no es JSON válido", response.status, false)
    }
  }

  private markFailure(): void {
    this.circuitOpenUntil = Date.now() + this.circuitOpenMs
  }

  private resetCircuit(): void {
    this.circuitOpenUntil = 0
  }

  private toRetainItem(entry: NewMemoryEntry, documentId: string, createdAt?: number): HindsightRetainItem {
    const metadata: Record<string, string> = {
      mara_id: documentId,
      mara_type: entry.type,
      mara_importance: String(clamp(entry.importance, 0, 1)),
      mara_source: entry.source,
      mara_created_at: String(createdAt ?? Date.now()),
    }
    if (entry.metadata) {
      try {
        metadata.mara_metadata = JSON.stringify(entry.metadata).slice(0, 4000)
      } catch {
        // Si el metadata no es serializable, se omite; nunca bloquea el retain.
      }
    }

    return {
      content: entry.content,
      context: DEFAULT_CONTEXT,
      timestamp: new Date(createdAt ?? Date.now()).toISOString(),
      document_id: documentId,
      metadata,
      tags: [
        "mara-os",
        `mara:type:${entry.type}`,
        `mara:source:${entry.source}`,
        `mara:importance:${clamp(entry.importance, 0, 1).toFixed(2)}`,
      ],
    }
  }

  private toSyntheticEntry(entry: NewMemoryEntry, documentId: string, createdAt?: number): MemoryEntry {
    const now = createdAt ?? Date.now()
    return {
      ...entry,
      id: documentId,
      createdAt: now,
      updatedAt: now,
      lastAccessed: now,
      accessCount: 0,
      metadata: {
        ...entry.metadata,
        hindsightDocumentId: documentId,
      },
    }
  }

  private mapRecallResult(result: HindsightRecallResult): MemoryEntry {
    const createdAt =
      parseDate(result.mentioned_at) ??
      parseDate(result.occurred_start) ??
      parseDate(result.occurred_end) ??
      Date.now()
    const metadata: Record<string, unknown> = {
      ...(result.metadata ?? {}),
      factType: result.type ?? undefined,
      documentId: result.document_id ?? undefined,
      hindsightId: result.id,
    }
    if (result.context) metadata.context = result.context
    if (result.entities && result.entities.length > 0) metadata.entities = result.entities
    if (result.scores?.final !== undefined) metadata.relevance = result.scores.final

    return {
      id: result.id,
      content: result.text,
      type: parseMemoryType(result.metadata, result.tags),
      importance: parseImportance(result.metadata, result.tags),
      createdAt,
      updatedAt: createdAt,
      lastAccessed: Date.now(),
      accessCount: 0,
      source: parseSource(result.metadata),
      metadata,
    }
  }

  private mapListItem(item: HindsightListItem): MemoryEntry {
    const createdAt =
      parseDate(item.mentioned_at) ??
      parseDate(item.occurred_start) ??
      parseDate(item.occurred_end) ??
      parseDate(item.date) ??
      parseDate(item.updated_at) ??
      Date.now()
    const metadata: Record<string, unknown> = {
      ...(item.metadata ?? {}),
      factType: item.fact_type ?? undefined,
      documentId: item.document_id ?? undefined,
      hindsightId: item.id,
    }
    if (item.context) metadata.context = item.context
    if (item.entities) metadata.entities = item.entities
    if (item.proof_count !== undefined) metadata.proofCount = item.proof_count

    return {
      id: item.id,
      content: item.text ?? "",
      type: parseMemoryType(item.metadata, item.tags),
      importance: parseImportance(item.metadata, item.tags),
      createdAt,
      updatedAt: parseDate(item.updated_at) ?? createdAt,
      lastAccessed: Date.now(),
      accessCount: 0,
      source: parseSource(item.metadata),
      metadata,
    }
  }

  private mapSingleMemory(raw: unknown): MemoryEntry | null {
    if (!raw || typeof raw !== "object") return null
    const envelope = raw as Record<string, unknown>
    const candidate = (envelope.memory ?? envelope.item ?? envelope.result ?? envelope) as Record<string, unknown>
    if (!candidate || typeof candidate !== "object") return null

    const text = typeof candidate.text === "string"
      ? candidate.text
      : typeof candidate.content === "string"
        ? candidate.content
        : null
    if (!text) return null

    const metadata = candidate.metadata && typeof candidate.metadata === "object"
      ? candidate.metadata as Record<string, unknown>
      : undefined
    const tags = Array.isArray(candidate.tags) ? candidate.tags as string[] : undefined
    const createdAt =
      parseDate(candidate.mentioned_at as string | undefined) ??
      parseDate(candidate.occurred_start as string | undefined) ??
      parseDate(candidate.occurred_end as string | undefined) ??
      Date.now()

    return {
      id: String(candidate.id ?? ""),
      content: text,
      type: parseMemoryType(metadata, tags),
      importance: parseImportance(metadata, tags),
      createdAt,
      updatedAt: createdAt,
      lastAccessed: Date.now(),
      accessCount: 0,
      source: parseSource(metadata),
      metadata: {
        ...(metadata ?? {}),
        factType: candidate.type ?? candidate.fact_type ?? undefined,
        documentId: candidate.document_id ?? undefined,
        hindsightId: candidate.id,
      },
    }
  }
}

export function createHindsightMemoryStore(options: HindsightStoreOptions): HindsightMemoryStore {
  return new HindsightMemoryStore(options)
}

export { normalizeContent as normalizeHindsightContent }
