/**
 * Resolución del proveedor de inferencia con `LLM_PROVIDER=groq`.
 *
 * Archivo propio porque `src/config.ts` lee `process.env` al importarse y cada
 * archivo de `node --test` corre en su propio proceso. La barra final de
 * `GROQ_API_URL` se deja a propósito para comprobar que se normaliza.
 */
process.env.LLM_PROVIDER = "groq"
process.env.GROQ_API_URL = "https://api.groq.com/openai/"
process.env.GROQ_MODEL = "qwen/qwen3.8-27b"
process.env.GROQ_API_KEY = "gsk_prueba"
delete process.env.LLM_API_URL
delete process.env.LLM_MODEL
delete process.env.LLM_API_KEY
delete process.env.OLLAMA_URL
// Sin estado guardado por `/modelo`: el proveedor sale de `LLM_PROVIDER`.
process.env.LLM_STATE_FILE = "/nonexistent/mara-llm-state-groq.json"

import assert from "node:assert/strict"
import { describe, it } from "node:test"

const { defaultLlmProvider, resolveLlmProvider } = await import("../src/config.js")
const { getActiveLlm } = await import("../src/providers.js")
const { isOpenAiApi, llmChatBody, llmChatEndpoint, llmHeaders, llmModelsEndpoint } = await import(
  "../src/ollama-http.js"
)

describe("proveedor groq", () => {
  const llm = resolveLlmProvider("groq")

  it("resuelve url, modelo y dialecto sin tocar OLLAMA_*", () => {
    assert.equal(defaultLlmProvider, "groq")
    assert.equal(llm.provider, "groq")
    assert.equal(llm.dialect, "openai")
    assert.equal(llm.url, "https://api.groq.com/openai")
    assert.equal(llm.model, "qwen/qwen3.8-27b")
    assert.equal(llm.apiKey, "gsk_prueba")
  })

  it("el proveedor activo sale de LLM_PROVIDER cuando no hay estado guardado", () => {
    const active = getActiveLlm()
    assert.equal(active.provider, "groq")
    assert.equal(active.url, "https://api.groq.com/openai")
  })

  it("construye los endpoints de Groq", () => {
    assert.equal(isOpenAiApi(llm), true)
    assert.equal(llmChatEndpoint(llm), "https://api.groq.com/openai/v1/chat/completions")
    assert.equal(llmModelsEndpoint(llm), "https://api.groq.com/openai/v1/models")
  })

  it("manda la API key de Groq como Bearer", () => {
    assert.equal(llmHeaders(true, llm).Authorization, "Bearer gsk_prueba")
  })

  it("usa max_tokens de 4096 por defecto para qwen3.8-27b", () => {
    const body = llmChatBody({ messages: [{ role: "user", content: "hola" }] }, llm)
    assert.equal(body.model, "qwen/qwen3.8-27b")
    assert.equal(body.max_tokens, 4096)
    assert.equal(body.stream, false)
  })

  it("manda las tools en formato OpenAI con tool_choice auto", () => {
    const body = llmChatBody(
      {
        messages: [{ role: "user", content: "hola" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        requireTool: true,
      },
      llm,
    )
    assert.equal(body.tool_choice, "auto")
  })
})
