import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "node:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { createSqliteMemoryStore } from "../src/memory/stores/sqlite.js"
import { HindsightMemoryStore } from "../src/memory/stores/hindsight.js"
import { createResilientMemoryStore, ResilientMemoryStore } from "../src/memory/stores/resilient.js"
import { MemorySyncQueue } from "../src/memory/sync-queue.js"
import { startFakeHindsight, FakeHindsight } from "./helpers/fake-hindsight.js"

interface Harness {
  store: ResilientMemoryStore
  sqlite: ReturnType<typeof createSqliteMemoryStore>
  queue: MemorySyncQueue
}

function makeHarness(dbPath: string, url: string): Harness {
  const sqlite = createSqliteMemoryStore(dbPath)
  const queue = new MemorySyncQueue(dbPath)
  const hindsight = new HindsightMemoryStore({
    apiUrl: url,
    bankId: "mara-os",
    timeoutMs: 500,
    retainTimeoutMs: 1000,
    healthTimeoutMs: 500,
    // En pruebas no queremos esperar 30 s a que el circuito se cierre.
    circuitOpenMs: 30,
  })
  const store = createResilientMemoryStore({
    hindsight,
    sqlite,
    queue,
    syncBatchSize: 10,
    syncIntervalMs: 0,
  })
  return { store, sqlite, queue }
}

describe("ResilientMemoryStore (Hindsight + SQLite)", () => {
  let fake: FakeHindsight
  let dir: string
  let dbPath: string
  let harness: Harness

  beforeEach(async () => {
    fake = await startFakeHindsight()
    dir = mkdtempSync(join(tmpdir(), "mara-memory-"))
    dbPath = join(dir, "mara.db")
    harness = makeHarness(dbPath, fake.url)
  })

  afterEach(async () => {
    await harness.store.close()
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it("escribe en SQLite y sincroniza con Hindsight", async () => {
    await harness.store.initialize()

    const entry = await harness.store.remember({
      content: "Kike prefiere el café solo",
      type: "preference",
      importance: 0.8,
      source: "conversation",
    })

    assert.equal(fake.facts.size, 1)
    const fact = Array.from(fake.facts.values())[0]
    assert.equal(fact.document_id, `mara-${entry.id}`)
    assert.equal(harness.queue.countPending(), 0)

    // El espejo local conserva la fila.
    const local = await harness.sqlite.get(entry.id)
    assert.equal(local?.content, "Kike prefiere el café solo")
  })

  it("si retain falla, guarda en local y reintenta después", async () => {
    await harness.store.initialize()
    fake.failRetain = true

    const entry = await harness.store.remember({
      content: "Su hermana se llama Ana",
      type: "person",
      importance: 0.9,
      source: "conversation",
    })

    assert.equal(fake.facts.size, 0)
    assert.equal(harness.queue.countPending(), 1)
    assert.equal(harness.queue.get(entry.id)?.action, "retain")

    // Mientras está pendiente, la búsqueda la devuelve desde SQLite.
    const partial = await harness.store.search({ query: "hermana" })
    assert.equal(partial.entries.length, 1)
    assert.equal(partial.entries[0].content, "Su hermana se llama Ana")

    // Con backoff, la pasada inmediata no la toca todavía.
    await harness.store.syncPending()
    assert.equal(harness.queue.countPending(), 1)

    // Simulamos que ya toca reintentar.
    fake.failRetain = false
    const queued = harness.queue.get(entry.id)!
    assert.ok(queued.nextAttemptAt > 0)
    harness.queue.retryNow(entry.id)
    // Dejar que el circuito (30 ms en pruebas) se cierre.
    await new Promise((resolve) => setTimeout(resolve, 60))

    await harness.store.syncPending()

    assert.equal(harness.queue.countPending(), 0)
    assert.equal(fake.facts.size, 1)
    assert.equal(Array.from(fake.facts.values())[0].document_id, `mara-${entry.id}`)

    // Ya sincronizada: no se duplica en la búsqueda.
    const after = await harness.store.search({ query: "hermana" })
    assert.equal(after.entries.length, 1)
  })

  it("no migra automáticamente recuerdos anteriores a Hindsight", async () => {
    await harness.store.close()

    const legacy = new Database(dbPath)
    legacy
      .prepare(`
        INSERT INTO memories (id, content, type, importance, created_at, updated_at, last_accessed, access_count, source, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("legacy-1", "Recuerdo antiguo en SQLite", "other", 0.4, 1, 1, 1, 0, "migration", null)
    legacy.close()

    harness = makeHarness(dbPath, fake.url)
    await harness.store.initialize()
    fake.requests.length = 0
    await harness.store.syncPending()

    assert.equal(fake.requests.filter((r) => r.method === "POST").length, 0)
    assert.equal(fake.facts.size, 0)

    // No se pierde: sigue visible como copia local.
    const listed = await harness.store.list(10, 0)
    assert.ok(listed.some((e) => e.id === "legacy-1"))

    const found = await harness.store.search({ query: "antiguo" })
    assert.ok(found.entries.some((e) => e.id === "legacy-1"))
  })

  it("no reenvía duplicados ni los cuenta dos veces", async () => {
    await harness.store.initialize()

    const first = await harness.store.remember({
      content: "Trabaja en soporte técnico",
      type: "project",
      importance: 0.7,
      source: "conversation",
    })
    const second = await harness.store.remember({
      content: "Trabaja en soporte técnico",
      type: "project",
      importance: 0.7,
      source: "conversation",
    })

    assert.equal(second.id, first.id)
    assert.equal(fake.facts.size, 1)
    assert.equal(harness.queue.countPending(), 0)

    const results = await harness.store.search({ query: "soporte" })
    assert.equal(results.entries.length, 1)
  })

  it("olvidar invalida en Hindsight y oculta en local, sin borrar el banco", async () => {
    await harness.store.initialize()
    const entry = await harness.store.remember({
      content: "Dato que hay que olvidar",
      type: "other",
      importance: 0.5,
      source: "conversation",
    })

    fake.requests.length = 0
    const ok = await harness.store.forget(entry.id)
    assert.equal(ok, true)

    assert.equal(fake.requests.some((r) => r.method === "DELETE"), false)
    assert.equal(fake.requests.some((r) => r.method === "PATCH"), true)
    assert.equal(Array.from(fake.facts.values()).every((f) => f.state === "invalidated"), true)

    assert.equal(await harness.sqlite.get(entry.id), null)
    assert.equal((await harness.store.search({ query: "olvidar" })).entries.length, 0)
    assert.equal((await harness.store.list(10, 0)).length, 0)
    assert.equal(harness.queue.countPending(), 0)
  })

  it("si Hindsight está caído, todo se resuelve en SQLite", async () => {
    await harness.store.initialize()
    await harness.store.remember({
      content: "Prefiere trabajar por la mañana",
      type: "routine",
      importance: 0.6,
      source: "conversation",
    })

    fake.failEverything = 503
    // Una escritura nueva con el servidor caído no se pierde.
    const offline = await harness.store.remember({
      content: "Usa Linux en el portátil",
      type: "skill_knowledge",
      importance: 0.7,
      source: "conversation",
    })
    assert.equal(harness.queue.get(offline.id)?.action, "retain")

    const found = await harness.store.search({ query: "Linux" })
    assert.ok(found.entries.some((e) => e.content === "Usa Linux en el portátil"))

    const listed = await harness.store.list(20, 0)
    assert.ok(listed.length >= 1)

    // Y el olvido local también funciona sin red.
    assert.equal(await harness.store.forget(offline.id), true)
    assert.equal(await harness.sqlite.get(offline.id), null)
    assert.equal(harness.queue.get(offline.id)?.action, "forget")
  })

  it("un olvido pendiente gana a un retain pendiente", async () => {
    await harness.store.initialize()
    fake.failRetain = true

    const entry = await harness.store.remember({
      content: "Algo que se guarda y se olvida",
      type: "other",
      importance: 0.5,
      source: "conversation",
    })
    assert.equal(harness.queue.get(entry.id)?.action, "retain")

    await harness.store.forget(entry.id)
    assert.equal(harness.queue.get(entry.id)?.action, "forget")
    assert.equal(await harness.sqlite.get(entry.id), null)
  })
})
