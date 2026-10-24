import assert from "node:assert/strict"
import { after, before, describe, it } from "node:test"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { HindsightMemoryStore, HindsightApiError } from "../src/memory/stores/hindsight.js"
import { startFakeHindsight, FakeHindsight } from "./helpers/fake-hindsight.js"

function makeStore(url: string, overrides: Partial<ConstructorParameters<typeof HindsightMemoryStore>[0]> = {}) {
  return new HindsightMemoryStore({
    apiUrl: url,
    bankId: "mara-os",
    timeoutMs: 1000,
    retainTimeoutMs: 2000,
    healthTimeoutMs: 1000,
    ...overrides,
  })
}

describe("HindsightMemoryStore (contrato REST)", () => {
  let fake: FakeHindsight

  before(async () => {
    fake = await startFakeHindsight()
  })

  after(async () => {
    await fake.close()
  })

  it("initialize comprueba salud y banco sin escribir", async () => {
    fake.requests.length = 0
    const store = makeStore(fake.url)
    await store.initialize()

    assert.equal(store.isAvailable(), true)
    assert.deepEqual(
      fake.requests.map((r) => `${r.method} ${r.path}`),
      ["GET /health", "GET /v1/default/banks/mara-os/config", "GET /version"],
    )
    assert.equal(fake.requests.some((r) => r.method === "POST"), false)
  })

  it("retain envía items, document_id, metadata y tags", async () => {
    fake.requests.length = 0
    fake.facts.clear()
    const store = makeStore(fake.url)

    const entry = await store.rememberWithDocument(
      {
        content: "Kike prefiere café sin azúcar",
        type: "preference",
        importance: 0.8,
        source: "conversation",
        metadata: { extractedFrom: 42 },
      },
      "mara-local-1",
      1_700_000_000_000,
    )

    const retain = fake.requests.find((r) => r.method === "POST" && r.path.endsWith("/memories"))
    assert.ok(retain)
    assert.equal(retain.body.async, false)
    assert.equal(retain.body.items.length, 1)
    const item = retain.body.items[0]
    assert.equal(item.content, "Kike prefiere café sin azúcar")
    assert.equal(item.document_id, "mara-local-1")
    assert.equal(item.metadata.mara_type, "preference")
    assert.equal(item.metadata.mara_importance, "0.8")
    assert.equal(item.metadata.mara_source, "conversation")
    assert.match(item.timestamp, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(item.tags.includes("mara-os"))
    assert.ok(item.tags.includes("mara:type:preference"))

    assert.equal(entry.id, "mara-local-1")
    assert.equal(entry.content, "Kike prefiere café sin azúcar")
  })

  it("rememberMany agrupa varios recuerdos en un solo retain", async () => {
    fake.requests.length = 0
    const store = makeStore(fake.url)

    await store.rememberManyWithDocuments([
      {
        entry: { content: "Vive en Madrid", type: "place", importance: 0.7, source: "conversation" },
        documentId: "mara-a",
      },
      {
        entry: { content: "Trabaja en soporte", type: "project", importance: 0.6, source: "conversation" },
        documentId: "mara-b",
      },
    ])

    const retains = fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/memories"))
    assert.equal(retains.length, 1)
    assert.equal(retains[0].body.items.length, 2)
    assert.deepEqual(
      retains[0].body.items.map((i: any) => i.document_id),
      ["mara-a", "mara-b"],
    )
  })

  it("recall usa budget low, prefer_observations y max_tokens, y mapea metadata", async () => {
    fake.requests.length = 0
    fake.facts.clear()
    const store = makeStore(fake.url)

    await store.rememberWithDocument(
      {
        content: "Kike usa PostgreSQL en casa",
        type: "skill_knowledge",
        importance: 0.9,
        source: "manual",
      },
      "mara-pg",
    )

    const result = await store.search({ query: "PostgreSQL", limit: 5, maxTokens: 1024 })
    const recall = fake.requests.find((r) => r.path.endsWith("/memories/recall"))
    assert.ok(recall)
    assert.equal(recall.body.budget, "low")
    assert.equal(recall.body.prefer_observations, true)
    assert.equal(recall.body.max_tokens, 1024)

    assert.equal(result.entries.length, 1)
    const entry = result.entries[0]
    assert.equal(entry.content, "Kike usa PostgreSQL en casa")
    assert.equal(entry.type, "skill_knowledge")
    assert.equal(entry.importance, 0.9)
    assert.equal(entry.source, "manual")
    assert.equal(entry.metadata?.documentId, "mara-pg")
  })

  it("search respeta limit y filtros locales", async () => {
    fake.facts.clear()
    const store = makeStore(fake.url)
    await store.rememberMany([
      { content: "Le gusta el té verde", type: "preference", importance: 0.4, source: "conversation" },
      { content: "Le gusta el té rojo", type: "preference", importance: 0.9, source: "conversation" },
    ])

    const result = await store.search({ query: "té", limit: 1 })
    assert.equal(result.entries.length, 1)

    const filtered = await store.search({ query: "té", limit: 5, minImportance: 0.8 })
    assert.equal(filtered.entries.every((e) => e.importance >= 0.8), true)
  })

  it("list y get consultan el banco", async () => {
    fake.facts.clear()
    const store = makeStore(fake.url)
    await store.rememberWithDocument(
      { content: "Tiene dos gatos", type: "personal_fact", importance: 0.8, source: "conversation" },
      "mara-gatos",
    )

    const list = await store.list(10, 0)
    assert.equal(list.length, 1)
    assert.equal(list[0].content, "Tiene dos gatos")
    assert.equal(list[0].type, "personal_fact")

    const id = Array.from(fake.facts.keys())[0]
    const got = await store.get(id)
    assert.ok(got)
    assert.equal(got.content, "Tiene dos gatos")
    assert.equal(await store.get("no-existe"), null)
  })

  it("forget invalida el hecho sin borrar el banco", async () => {
    fake.requests.length = 0
    fake.facts.clear()
    const store = makeStore(fake.url)
    await store.rememberWithDocument(
      { content: "Dato temporal", type: "other", importance: 0.5, source: "conversation" },
      "mara-temporal",
    )
    const id = Array.from(fake.facts.keys())[0]

    const forgotten = await store.forget(id)
    assert.equal(forgotten, true)

    const patches = fake.requests.filter((r) => r.method === "PATCH")
    assert.equal(patches.length, 1)
    assert.equal(patches[0].body.state, "invalidated")
    assert.equal(fake.facts.get(id)?.state, "invalidated")

    const deletes = fake.requests.filter((r) => r.method === "DELETE")
    assert.equal(deletes.length, 0, "nunca se debe usar el DELETE del banco")
  })

  it("invalidateDocument pagina el listado por document_id", async () => {
    fake.requests.length = 0
    fake.facts.clear()
    const store = makeStore(fake.url)
    await store.rememberManyWithDocuments([
      {
        entry: { content: "Hecho A", type: "other", importance: 0.5, source: "conversation" },
        documentId: "mara-doc",
      },
      {
        entry: { content: "Hecho B", type: "other", importance: 0.5, source: "conversation" },
        documentId: "mara-doc",
      },
    ])

    const invalidated = await store.invalidateDocument("mara-doc")
    assert.equal(invalidated, 2)
    assert.equal(Array.from(fake.facts.values()).every((f) => f.state === "invalidated"), true)

    const listRequest = fake.requests.find((r) => r.path.endsWith("/memories/list"))
    assert.equal(listRequest?.query.document_id, "mara-doc")
  })

  it("envía Authorization: Bearer si hay API key", async () => {
    fake.requests.length = 0
    const store = makeStore(fake.url, { apiKey: "secreto" })
    await store.healthCheck()

    const health = fake.requests.find((r) => r.path === "/health")
    assert.equal(health?.headers.authorization, "Bearer secreto")
  })

  it("un estado 4xx de validación es un fallo permanente", async () => {
    fake.requests.length = 0
    fake.failEverything = 422
    try {
      const store = makeStore(fake.url)
      await assert.rejects(
        () => store.remember({ content: "x", type: "other", importance: 0.5, source: "conversation" }),
        (err: unknown) => err instanceof HindsightApiError && err.permanent === true,
      )
    } finally {
      fake.failEverything = null
    }
  })

  it("un timeout abre el circuito y deja de llamar", async () => {
    const hanging = createServer(() => {
      // Nunca responde.
    })
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve))
    const { port } = hanging.address() as AddressInfo

    try {
      const store = makeStore(`http://127.0.0.1:${port}`, { timeoutMs: 50, healthTimeoutMs: 50 })
      await assert.rejects(() => store.search({ query: "hola" }))
      assert.equal(store.isAvailable(), false)

      // En circuito abierto falla al instante, sin volver a tocar la red.
      await assert.rejects(
        () => store.search({ query: "hola" }),
        /circuito abierto/,
      )
    } finally {
      await new Promise<void>((resolve) => hanging.close(() => resolve()))
    }
  })
})
