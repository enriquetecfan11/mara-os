/**
 * Dialecto OpenAI-compatible (`OLLAMA_API=openai`): Unsloth Studio, vLLM,
 * llama.cpp server, LM Studio…
 *
 * Vive en su propio archivo porque `src/config.ts` lee `process.env` al
 * importarse: cada archivo de `node --test` corre en un proceso distinto, así
 * que aquí se puede fijar el entorno antes de cargar el módulo. El import tiene
 * que ser dinámico: los `import` estáticos se evalúan antes de este código.
 */
process.env.OLLAMA_API = "openai"
process.env.OLLAMA_URL = "http://192.168.1.79:8888/"
process.env.OLLAMA_MODEL = "unsloth/Qwen3.5-4B-MTP-GGUF"
process.env.OLLAMA_API_KEY = "sk-test"
process.env.OLLAMA_MAX_TOKENS = "1234"
delete process.env.LLM_PROVIDER
delete process.env.LLM_MAX_TOKENS
// Sin estado guardado por `/modelo`: el proveedor sale de OLLAMA_API.
process.env.LLM_STATE_FILE = "/nonexistent/mara-llm-state-openai.json"

import assert from "node:assert/strict"
import { describe, it } from "node:test"

const { defaultLlmProvider, resolveLlmProvider } = await import("../src/config.js")
const { getActiveLlm } = await import("../src/providers.js")
const {
  assistantToolCallMessage,
  isOpenAiApi,
  llmChatBody,
  llmChatEndpoint,
  llmHeaders,
  llmModelsEndpoint,
  parseLlmChat,
  toolResultMessage,
} = await import("../src/ollama-http.js")

describe("dialecto openai", () => {
  const llm = resolveLlmProvider("unsloth")

  it("detecta el dialecto openai desde OLLAMA_API", () => {
    assert.equal(defaultLlmProvider, "unsloth")
    assert.equal(isOpenAiApi(llm), true)
    assert.equal(getActiveLlm().provider, "unsloth")
  })

  it("normaliza la barra final de la URL", () => {
    assert.equal(llmChatEndpoint(llm), "http://192.168.1.79:8888/v1/chat/completions")
    assert.equal(llmModelsEndpoint(llm), "http://192.168.1.79:8888/v1/models")
  })

  it("manda la API key como Bearer y el Content-Type solo con cuerpo", () => {
    const noBody = llmHeaders(false, llm)
    assert.equal(noBody.Authorization, "Bearer sk-test")
    assert.equal(noBody.Accept, "application/json")
    assert.equal(noBody["Content-Type"], undefined)
    assert.equal(llmHeaders(true, llm)["Content-Type"], "application/json")
  })

  it("construye el cuerpo OpenAI con max_tokens y tool_choice auto", () => {
    const body = llmChatBody(
      {
        messages: [{ role: "user", content: "hola" }],
        tools: [{ type: "function", function: { name: "t", parameters: {} } }],
        requireTool: true,
      },
      llm,
    )

    assert.equal(body.model, "unsloth/Qwen3.5-4B-MTP-GGUF")
    assert.equal(body.max_tokens, 1234)
    assert.equal(body.stream, false)
    // "required" rompería la charla normal en este dialecto.
    assert.equal(body.tool_choice, "auto")
    assert.equal(body.options, undefined)
    assert.equal(body.format, undefined)
  })

  it("no envía tools ni tool_choice si no hay herramientas", () => {
    const body = llmChatBody({ messages: [{ role: "user", content: "hola" }] }, llm)
    assert.equal(body.tools, undefined)
    assert.equal(body.tool_choice, undefined)
  })

  it("pide JSON con response_format", () => {
    const body = llmChatBody({ messages: [{ role: "user", content: "x" }], json: true }, llm)
    assert.deepEqual(body.response_format, { type: "json_object" })
  })

  it("parsea choices[0].message y los tool_calls con argumentos JSON", () => {
    const parsed = parseLlmChat(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_abc", type: "function", function: { name: "get_time", arguments: '{"tz":"Europe/Madrid"}' } },
              ],
            },
          },
        ],
      },
      llm,
    )

    assert.equal(parsed.content, "")
    assert.equal(parsed.toolCalls.length, 1)
    assert.equal(parsed.toolCalls[0].id, "call_abc")
    assert.equal(parsed.toolCalls[0].name, "get_time")
    assert.deepEqual(parsed.toolCalls[0].arguments, { tz: "Europe/Madrid" })
  })

  it("devuelve el texto de una respuesta normal", () => {
    const parsed = parseLlmChat({ choices: [{ message: { role: "assistant", content: "listo" } }] }, llm)
    assert.equal(parsed.content, "listo")
    assert.deepEqual(parsed.toolCalls, [])
  })

  it("empareja el resultado de la tool con su tool_call_id", () => {
    const [call] = parseLlmChat(
      {
        choices: [
          {
            message: {
              tool_calls: [{ id: "call_1", function: { name: "get_time", arguments: "{}" } }],
            },
          },
        ],
      },
      llm,
    ).toolCalls

    const assistant = assistantToolCallMessage([call])
    assert.equal(assistant.role, "assistant")
    assert.equal(assistant.tool_calls?.[0].id, "call_1")
    assert.equal(assistant.tool_calls?.[0].function.arguments, "{}")

    const result = toolResultMessage(call, "Son las 12:00")
    assert.deepEqual(result, { role: "tool", content: "Son las 12:00", tool_call_id: "call_1" })
  })
})
