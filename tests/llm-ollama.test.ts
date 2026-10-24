/**
 * Dialecto Ollama nativo (`/api/chat`). Es el comportamiento por defecto cuando
 * `OLLAMA_API` no está definido, así que aquí NO se toca esa variable.
 *
 * Archivo separado del de OpenAI porque `src/config.ts` lee `process.env` al
 * importarse y cada archivo de `node --test` corre en su propio proceso.
 */
delete process.env.OLLAMA_API
delete process.env.OLLAMA_API_KEY
delete process.env.OLLAMA_MAX_TOKENS
delete process.env.LLM_MAX_TOKENS
delete process.env.LLM_PROVIDER
process.env.OLLAMA_URL = "http://192.168.1.182:11434"
process.env.OLLAMA_MODEL = "ornith-1.5:9b"
process.env.OLLAMA_NUM_CTX = "8192"
process.env.LLM_STATE_FILE = "/nonexistent/mara-llm-state-ollama.json"

import assert from "node:assert/strict"
import { describe, it } from "node:test"

const { defaultLlmProvider, resolveLlmProvider } = await import("../src/config.js")
const {
  assistantToolCallMessage,
  isOpenAiApi,
  llmChatBody,
  llmChatEndpoint,
  llmHeaders,
  llmModelsEndpoint,
  parseLlmChat,
} = await import("../src/ollama-http.js")

describe("dialecto ollama", () => {
  const llm = resolveLlmProvider("ollama")

  it("detecta el dialecto nativo cuando OLLAMA_API no está definido", () => {
    assert.equal(defaultLlmProvider, "ollama")
    assert.equal(llm.dialect, "ollama")
  })

  it("usa los endpoints nativos y no manda Authorization sin API key", () => {
    assert.equal(isOpenAiApi(llm), false)
    assert.equal(llmChatEndpoint(llm), "http://192.168.1.182:11434/api/chat")
    assert.equal(llmModelsEndpoint(llm), "http://192.168.1.182:11434/api/tags")
    assert.equal(llmHeaders(false, llm).Authorization, undefined)
  })

  it("mantiene options.num_ctx y tool_choice required", () => {
    const body = llmChatBody(
      {
        messages: [{ role: "user", content: "hola" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        requireTool: true,
      },
      llm,
    )

    assert.equal(body.model, "ornith-1.5:9b")
    assert.deepEqual(body.options, { num_ctx: 8192, num_predict: 2048 })
    assert.equal(body.tool_choice, "required")
    assert.equal(body.max_tokens, undefined)
    assert.equal(body.response_format, undefined)
  })

  it("usa tool_choice auto si no se exige tool", () => {
    const body = llmChatBody(
      {
        messages: [{ role: "user", content: "hola" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
      },
      llm,
    )
    assert.equal(body.tool_choice, "auto")
  })

  it("pide JSON con format", () => {
    const body = llmChatBody({ messages: [{ role: "user", content: "x" }], json: true }, llm)
    assert.equal(body.format, "json")
  })

  it("parsea message.content y message.tool_calls", () => {
    const parsed = parseLlmChat(
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "get_time", arguments: { tz: "Europe/Madrid" } } }],
        },
      },
      llm,
    )

    assert.equal(parsed.content, "")
    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0].name, "get_time")
    assert.deepEqual(parsed.toolCalls[0].arguments, { tz: "Europe/Madrid" })
    // Ollama no devuelve id: se sintetiza para poder emparejar el resultado.
    assert.equal(parsed.toolCalls[0].id, "call_0")
  })

  it("devuelve el texto de una respuesta normal", () => {
    const parsed = parseLlmChat({ message: { role: "assistant", content: "listo" } }, llm)
    assert.equal(parsed.content, "listo")
    assert.deepEqual(parsed.toolCalls, [])
  })

  it("serializa los argumentos de vuelta al historial como string", () => {
    const assistant = assistantToolCallMessage([{ id: "call_0", name: "get_time", arguments: { tz: "Europe/Madrid" } }])
    assert.equal(assistant.tool_calls?.[0].function.arguments, '{"tz":"Europe/Madrid"}')
  })
})
