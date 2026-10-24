/**
 * Estado runtime del proveedor de inferencia (`src/providers.ts`).
 *
 * `/modelo` cambia el proveedor sin reiniciar, así que el estado vive en un
 * JSON. Aquí se comprueba la precedencia (guardado > `LLM_PROVIDER`), que el
 * cambio se persiste y que no se puede activar un proveedor sin configurar.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const stateDir = mkdtempSync(join(tmpdir(), "mara-llm-state-"))
const stateFile = join(stateDir, "llm-provider.json")

process.env.LLM_STATE_FILE = stateFile
process.env.LLM_PROVIDER = "unsloth"
process.env.OLLAMA_API = "openai"
process.env.OLLAMA_URL = "http://10.0.0.5:8888"
process.env.OLLAMA_MODEL = "modelo-local"
process.env.GROQ_API_KEY = "gsk_prueba"
delete process.env.LLM_API_URL
delete process.env.LLM_MODEL
delete process.env.LLM_API_KEY
delete process.env.LLM_MAX_TOKENS

import assert from "node:assert/strict"
import { describe, it } from "node:test"

const { getActiveLlm, getActiveProviderName, setActiveProvider, listProviderStatus } = await import(
  "../src/providers.js"
)

describe("estado del proveedor", () => {
  it("arranca con LLM_PROVIDER si no hay estado guardado", () => {
    const active = getActiveLlm()
    assert.equal(active.provider, "unsloth")
    assert.equal(getActiveProviderName(), "unsloth")
    assert.equal(active.model, "modelo-local")
  })

  it("lista todos los proveedores marcando el activo", () => {
    const statuses = listProviderStatus()
    assert.deepEqual(
      statuses.map((s) => s.provider),
      ["unsloth", "groq", "ollama", "openai"],
    )
    assert.equal(statuses.filter((s) => s.active).length, 1)
    assert.equal(statuses.find((s) => s.active)?.provider, "unsloth")
  })

  it("cambia de proveedor y lo persiste en disco", () => {
    const active = setActiveProvider("groq")
    assert.equal(active.provider, "groq")
    assert.equal(active.model, "qwen/qwen3.8-27b")

    const stored = JSON.parse(readFileSync(stateFile, "utf8"))
    assert.equal(stored.provider, "groq")
    assert.match(stored.updatedAt, /^\d{4}-\d{2}-\d{2}T/)

    assert.equal(getActiveLlm().provider, "groq")
    assert.equal(listProviderStatus().find((s) => s.active)?.provider, "groq")
  })

  it("vuelve al proveedor local y actualiza la URL", () => {
    const active = setActiveProvider("unsloth")
    assert.equal(active.provider, "unsloth")
    assert.equal(active.url, "http://10.0.0.5:8888")
    assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).provider, "unsloth")
  })

  it("rechaza proveedores desconocidos", () => {
    assert.throws(() => setActiveProvider("gemini" as any), /proveedor desconocido/)
  })

  it("rechaza el proveedor genérico si falta LLM_API_URL", () => {
    const openai = listProviderStatus().find((s) => s.provider === "openai")
    assert.equal(openai?.configured, false)
    assert.match(openai?.reason ?? "", /LLM_API_URL/)
    assert.throws(() => setActiveProvider("openai"), /LLM_API_URL/)
  })
})
