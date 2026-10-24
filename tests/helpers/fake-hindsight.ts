import { createServer, IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { randomUUID } from "node:crypto"

export interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  body: any
  headers: Record<string, string | string[] | undefined>
}

export interface FakeFact {
  id: string
  text: string
  document_id: string | null
  metadata: Record<string, string> | null
  tags: string[] | null
  mentioned_at: string | null
  state: "valid" | "invalidated"
}

/**
 * Servidor HTTP que imita el contrato real de Hindsight (API 1.1) para los
 * endpoints que usa el adaptador. No depende del servidor de la LAN.
 */
export interface FakeHindsight {
  url: string
  requests: RecordedRequest[]
  facts: Map<string, FakeFact>
  failRetain: boolean
  failEverything: number | null
  close(): Promise<void>
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString("utf8")
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(body)
}

export async function startFakeHindsight(): Promise<FakeHindsight> {
  const state: FakeHindsight = {
    url: "",
    requests: [],
    facts: new Map(),
    failRetain: false,
    failEverything: null,
    close: async () => {},
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost")
    const body = await readBody(req)
    const query = Object.fromEntries(url.searchParams.entries())
    state.requests.push({
      method: req.method || "GET",
      path: url.pathname,
      query,
      body,
      headers: req.headers,
    })

    if (state.failEverything !== null) {
      send(res, state.failEverything, { detail: "forced failure" })
      return
    }

    if (url.pathname === "/health") {
      send(res, 200, { status: "healthy", database: "connected" })
      return
    }

    if (url.pathname === "/version") {
      send(res, 200, { api_version: "1.1.0", features: { observations: true } })
      return
    }

    const bankMatch = url.pathname.match(/^\/v1\/([^/]+)\/banks\/([^/]+)(\/.*)$/)
    if (!bankMatch) {
      send(res, 404, { detail: "not found" })
      return
    }

    const rest = bankMatch[3]

    if (req.method === "GET" && rest === "/config") {
      send(res, 200, { bank_id: bankMatch[2], config: {} })
      return
    }

    if (req.method === "GET" && rest === "/stats") {
      send(res, 200, { bank_id: bankMatch[2], facts: state.facts.size })
      return
    }

    if (req.method === "POST" && rest === "/memories") {
      if (state.failRetain) {
        send(res, 500, { detail: "retain unavailable" })
        return
      }
      const items = Array.isArray(body?.items) ? body.items : []
      for (const item of items) {
        const fact: FakeFact = {
          id: randomUUID(),
          text: String(item.content ?? ""),
          document_id: item.document_id ?? null,
          metadata: item.metadata ?? null,
          tags: item.tags ?? null,
          mentioned_at: item.timestamp ?? null,
          state: "valid",
        }
        state.facts.set(fact.id, fact)
      }
      send(res, 200, { success: true, items_count: items.length })
      return
    }

    if (req.method === "POST" && rest === "/memories/recall") {
      const queryText = String(body?.query ?? "").toLowerCase()
      const words = queryText.split(/\s+/).filter(Boolean)
      const results = Array.from(state.facts.values())
        .filter((fact) => fact.state === "valid")
        .filter((fact) => words.length === 0 || words.some((w) => fact.text.toLowerCase().includes(w)))
        .map((fact) => ({
          id: fact.id,
          text: fact.text,
          type: "world",
          context: "test",
          mentioned_at: fact.mentioned_at,
          document_id: fact.document_id,
          metadata: fact.metadata,
          tags: fact.tags,
          entities: null,
          occurred_start: null,
          occurred_end: null,
          scores: { final: 0.9 },
        }))
      send(res, 200, { results, trace: null, entities: null, chunks: null, source_facts: null, source_facts_truncated: null })
      return
    }

    if (req.method === "GET" && rest === "/memories/list") {
      const limit = Number(query.limit ?? 100)
      const offset = Number(query.offset ?? 0)
      const filtered = Array.from(state.facts.values())
        .filter((fact) => !query.document_id || fact.document_id === query.document_id)
        .filter((fact) => !query.state || fact.state === query.state)
      const items = filtered.slice(offset, offset + limit).map((fact) => ({
        id: fact.id,
        text: fact.text,
        context: "test",
        date: fact.mentioned_at ?? "",
        fact_type: "world",
        document_id: fact.document_id,
        mentioned_at: fact.mentioned_at,
        occurred_start: null,
        occurred_end: null,
        entities: "",
        proof_count: 1,
        tags: fact.tags,
        metadata: fact.metadata,
        state: fact.state,
        updated_at: fact.mentioned_at,
      }))
      send(res, 200, { items, total: filtered.length, limit, offset })
      return
    }

    const memoryMatch = rest.match(/^\/memories\/([^/]+)$/)
    if (memoryMatch) {
      const fact = state.facts.get(decodeURIComponent(memoryMatch[1]))
      if (!fact) {
        send(res, 404, { detail: "memory not found" })
        return
      }
      if (req.method === "GET") {
        send(res, 200, fact)
        return
      }
      if (req.method === "PATCH") {
        if (body?.state === "invalidated") {
          fact.state = "invalidated"
        } else if (body?.state === "valid") {
          fact.state = "valid"
        }
        send(res, 200, { ...fact, reason: body?.reason ?? null })
        return
      }
    }

    send(res, 404, { detail: "not found" })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  state.url = `http://127.0.0.1:${port}`
  state.close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })

  return state
}

export const validFactId = (): string => randomUUID()
